/**
 * GMX Replay Executor — Drives browser automation to replay GMX trades
 *
 * Core loop:
 * 1. Pop next trade from priority queue (sorted by compressed timestamp)
 * 2. Wait until target time
 * 3. Acquire browser context for the trade's wallet
 * 4. Navigate to correct token page
 * 5. Fill order form via Page Objects
 * 6. Submit and record result
 * 7. Release browser context
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { type Page } from "@playwright/test";
import { parseGmxData, getTradeStats, type GmxTrade } from "./gmx-parser";
import { mapGmxToTestWallet } from "./wallet-mapper";
import { scaleToMarginBnb } from "./amount-scaler";
import { getBrowserPool, type BrowserPool } from "../automation/browser-pool";
import { type InjectedWallet } from "../automation/wallet-injector";
import { ConnectWalletPage } from "../automation/page-objects/connect-wallet.po";
import { DepositPage } from "../automation/page-objects/deposit.po";
import { OrderPanelPage } from "../automation/page-objects/order-panel.po";
import { ENV, TEST_PARAMS } from "../config/test-config";
import { log } from "../utils/logger";

interface WalletInfo {
  index: number;
  address: string;
  privateKey: string;
  role: string;
}

interface TokenInfo {
  address: string;
  gmxMarket: string;
}

interface ReplayStats {
  total: number;
  sent: number;
  accepted: number;
  rejected: number;
  failed: number;
  skipped: number;
  byToken: Record<string, { sent: number; accepted: number }>;
  latencies: number[];
  startTime: number;
  errors: Map<string, number>;
}

const connectedWallets = new Set<number>();

export async function runReplay(): Promise<ReplayStats> {
  log.replay.info("═══ GMX 48h Replay via Browser Automation ═══");

  // Load data
  const gmxTrades = parseGmxData(resolve(__dirname, "../data/gmx-trades.json"));
  const stats = getTradeStats(gmxTrades);
  log.replay.info(stats, "GMX data loaded");

  const wallets: WalletInfo[] = JSON.parse(
    readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8")
  );
  const tokenAddresses: Record<string, TokenInfo> = JSON.parse(
    readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8")
  );

  log.replay.info({
    wallets: wallets.length,
    tokens: Object.keys(tokenAddresses),
    trades: gmxTrades.length,
  }, "Resources loaded");

  // Initialize browser pool
  const pool = await getBrowserPool();

  // Time compression
  const gmxStart = gmxTrades[0].timestamp;
  const gmxEnd = gmxTrades[gmxTrades.length - 1].timestamp;
  const gmxDuration = gmxEnd - gmxStart;
  const replayDurationSec = TEST_PARAMS.REPLAY_DURATION_HOURS * 3600;
  const speedFactor = gmxDuration / replayDurationSec;

  log.replay.info({
    gmxHours: (gmxDuration / 3600).toFixed(1),
    replayHours: TEST_PARAMS.REPLAY_DURATION_HOURS,
    speedFactor: speedFactor.toFixed(0) + "x",
    tradeRate: (gmxTrades.length / replayDurationSec).toFixed(2) + " trades/sec",
  }, "Time compression");

  // Replay stats
  const replayStats: ReplayStats = {
    total: gmxTrades.length,
    sent: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
    byToken: {},
    latencies: [],
    startTime: Date.now(),
    errors: new Map(),
  };

  // Initialize per-token stats
  for (const sym of Object.keys(tokenAddresses)) {
    replayStats.byToken[sym] = { sent: 0, accepted: 0 };
  }

  // Per-wallet queue to serialize orders
  const walletQueues = new Map<number, Promise<void>>();
  function getWalletQueue(walletIdx: number): Promise<void> {
    return walletQueues.get(walletIdx) || Promise.resolve();
  }

  const replayStart = Date.now();

  // Process trades
  for (let i = 0; i < gmxTrades.length; i++) {
    const trade = gmxTrades[i];
    const walletIdx = mapGmxToTestWallet(trade.account);
    const wallet = wallets[walletIdx];
    const tokenInfo = tokenAddresses[trade.tokenSymbol];

    if (!wallet || !tokenInfo) {
      replayStats.skipped++;
      continue;
    }

    // Scale amounts
    const { marginBnb, leverage } = scaleToMarginBnb(trade.sizeDeltaUsd);
    if (marginBnb < 0.01) {
      replayStats.skipped++;
      continue;
    }

    // Time delay (compressed)
    if (i > 0) {
      const gmxTimeDiff = trade.timestamp - gmxTrades[i - 1].timestamp;
      const replayDelay = (gmxTimeDiff / speedFactor) * 1000;
      if (replayDelay > 50 && replayDelay < 10000) {
        await new Promise((r) => setTimeout(r, Math.min(replayDelay, 2000)));
      }
    }

    // Chain onto wallet queue
    const prevQueue = getWalletQueue(walletIdx);
    const tradePromise = prevQueue.then(async () => {
      const start = performance.now();
      try {
        const injectedWallet: InjectedWallet = {
          address: wallet.address as `0x${string}`,
          privateKey: wallet.privateKey as `0x${string}`,
          chainId: ENV.CHAIN_ID,
        };

        const { page, release } = await pool.acquire(injectedWallet);

        try {
          // Connect wallet if first time
          if (!connectedWallets.has(walletIdx)) {
            const connectPage = new ConnectWalletPage(page, wallet.privateKey as `0x${string}`);
            await page.goto(`${ENV.FRONTEND_URL}/perpetual?token=${tokenInfo.address}`);
            await connectPage.connect();
            connectedWallets.add(walletIdx);

            // First time: deposit
            const depositPage = new DepositPage(page, wallet.privateKey as `0x${string}`);
            await depositPage.deposit("0.5");
          } else {
            // Navigate to token page
            await page.goto(`${ENV.FRONTEND_URL}/perpetual?token=${tokenInfo.address}`);
          }

          await page.waitForTimeout(500);

          // Place order
          const orderPanel = new OrderPanelPage(page, wallet.privateKey as `0x${string}`);
          const success = await orderPanel.placeOrder({
            side: trade.type === "increase"
              ? (trade.isLong ? "long" : "short")
              : (trade.isLong ? "short" : "long"), // Reverse for close
            type: Math.random() > 0.3 ? "market" : "limit",
            margin: marginBnb.toString(),
            leverage,
            reduceOnly: trade.type === "decrease",
          });

          const latency = performance.now() - start;
          replayStats.latencies.push(latency);
          replayStats.sent++;
          replayStats.byToken[trade.tokenSymbol]!.sent++;

          if (success) {
            replayStats.accepted++;
            replayStats.byToken[trade.tokenSymbol]!.accepted++;
          } else {
            replayStats.rejected++;
          }
        } finally {
          release();
        }
      } catch (err: any) {
        replayStats.failed++;
        const errKey = (err.message || "unknown").slice(0, 50);
        replayStats.errors.set(errKey, (replayStats.errors.get(errKey) || 0) + 1);
      }
    });

    walletQueues.set(walletIdx, tradePromise);

    // Progress report every 10%
    if (i % Math.floor(gmxTrades.length / 10) === 0) {
      const elapsed = (Date.now() - replayStart) / 1000;
      const pct = ((i / gmxTrades.length) * 100).toFixed(0);
      const rate = replayStats.sent / Math.max(elapsed, 0.1);
      log.replay.info({
        progress: `${pct}%`,
        sent: replayStats.sent,
        accepted: replayStats.accepted,
        failed: replayStats.failed,
        rate: `${rate.toFixed(1)} trades/sec`,
        poolStats: pool.stats,
      }, "Progress");
    }
  }

  // Wait for all queues to drain
  await Promise.all([...walletQueues.values()]);

  // Final stats
  const totalTime = (Date.now() - replayStart) / 1000;
  log.replay.info({
    duration: `${totalTime.toFixed(1)}s`,
    throughput: `${(replayStats.sent / totalTime).toFixed(1)} trades/sec`,
    accepted: replayStats.accepted,
    rejected: replayStats.rejected,
    failed: replayStats.failed,
    skipped: replayStats.skipped,
    acceptanceRate: `${((replayStats.accepted / replayStats.sent) * 100).toFixed(1)}%`,
  }, "═══ Replay Complete ═══");

  // Cleanup
  await pool.destroy();

  return replayStats;
}

// Direct execution
if (import.meta.main) {
  runReplay()
    .then((stats) => {
      console.log("\nFinal stats:", JSON.stringify({
        sent: stats.sent,
        accepted: stats.accepted,
        rejected: stats.rejected,
        failed: stats.failed,
        acceptanceRate: `${((stats.accepted / stats.sent) * 100).toFixed(1)}%`,
      }, null, 2));
    })
    .catch(console.error);
}
