/**
 * API-Based GMX Replay — Submit orders directly to matching engine
 *
 * Key design: Orders are serialized per-wallet (nonce + lock constraints)
 * but parallelized across wallets for throughput.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { type Address, type Hex } from "viem";
import { parseGmxData, getTradeStats, type GmxTrade } from "./gmx-parser";
import { mapGmxToTestWallet } from "./wallet-mapper";
import { scaleToMarginBnb } from "./amount-scaler";
import { signOrder, type OrderParams } from "../utils/eip712-signer";
import { log } from "../utils/logger";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";

interface ReplayResult {
  total: number;
  submitted: number;
  accepted: number;
  rejected: number;
  failed: number;
  skipped: number;
  errors: Record<string, number>;
  durationMs: number;
}

interface PreparedOrder {
  walletAddress: string;
  privateKey: string;
  token: string;
  isLong: boolean;
  isIncrease: boolean;
  size: string;
  leverage: number;
}

/**
 * Submit an order and return whether the engine consumed the nonce.
 * The engine increments nonce only when: nonce check passes + balance deduction succeeds.
 * Nonce is NOT consumed on: nonce mismatch, lock failure, insufficient balance pre-deduct.
 */
async function submitOrder(
  order: PreparedOrder,
  nonce: number,
  result: ReplayResult
): Promise<{ nonceConsumed: boolean }> {
  try {
    // Build EIP-712 order params for signing
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const orderParams: OrderParams = {
      trader: order.walletAddress as Address,
      token: order.token as Address,
      isLong: order.isLong,
      orderType: 0,  // 0 = MARKET (uint8, must match engine enum)
      size: BigInt(order.size),
      leverage: BigInt(order.leverage),
      price: 0n,     // market order = price 0
      deadline,
      nonce: BigInt(nonce),
    };

    // Sign with real EIP-712 signature (production-grade, no shortcuts)
    const signature = await signOrder(order.privateKey as Hex, orderParams);

    const resp = await fetch(`${ENGINE}/api/order/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader: order.walletAddress,
        token: order.token,
        isLong: order.isLong,
        orderType: 0,  // uint8: 0=market, 1=limit (must be number for EIP-712)
        size: order.size,
        leverage: order.leverage,
        price: "0",
        reduceOnly: !order.isIncrease,
        deadline: deadline.toString(),
        nonce,
        signature,
      }),
    });

    const data = await resp.json() as any;

    // Engine response patterns:
    // 1. Success: { success: true, orderId: "..." }
    // 2. Rejected by matching: { success: false, orderId: "...", rejected: true, rejectReason: "..." }
    //    → Nonce WAS consumed (passed lock + balance deduction)
    // 3. Rejected by validation/nonce/balance: { error: "..." }
    //    → Nonce NOT consumed

    if (data.success === true) {
      result.accepted++;
      return { nonceConsumed: true };
    } else if (data.orderId) {
      // Order was created but rejected by matching engine (post-nonce)
      result.rejected++;
      const errKey = (data.rejectReason || "matching_rejected").slice(0, 50);
      result.errors[errKey] = (result.errors[errKey] || 0) + 1;
      return { nonceConsumed: true }; // Nonce was consumed (inside lock)
    } else {
      // Pre-nonce validation error
      result.rejected++;
      const errKey = (data.error || "unknown").slice(0, 50);
      result.errors[errKey] = (result.errors[errKey] || 0) + 1;
      return { nonceConsumed: false }; // Nonce NOT consumed
    }
  } catch (err: any) {
    result.failed++;
    const errKey = (err.message || "fetch_error").slice(0, 50);
    result.errors[errKey] = (result.errors[errKey] || 0) + 1;
    return { nonceConsumed: false }; // Network error — nonce not consumed
  }
}

async function main() {
  console.log("═══ GMX 48h API Replay ═══\n");

  // Load data
  const wallets = JSON.parse(
    readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8")
  );
  const tokens = JSON.parse(
    readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8")
  );

  const trades = parseGmxData();
  const stats = getTradeStats(trades);

  console.log(`📊 GMX Data: ${trades.length} trades, ${stats.uniqueAccounts} wallets`);
  console.log(`🪙 Tokens: ${Object.keys(tokens).join(", ")}`);
  console.log(`👛 Test Wallets: ${wallets.length}\n`);

  // Build GMX market → our token address mapping
  const marketToToken: Record<string, string> = {};
  for (const [symbol, info] of Object.entries(tokens)) {
    const tokenInfo = info as any;
    marketToToken[tokenInfo.gmxMarket.toLowerCase()] = tokenInfo.address;
  }

  // Production mode: deposits are done on-chain via production-setup.ts
  // Verify wallets have balances in the engine
  console.log("🔍 Verifying wallet balances (on-chain deposits via SettlementV2)...");
  let walletsWithBalance = 0;
  for (let i = 0; i < Math.min(wallets.length, 50); i++) {
    try {
      const resp = await fetch(`${ENGINE}/api/user/${wallets[i].address}/balance`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const bal = BigInt(data.balance || data.available || "0");
        if (bal > 0n) walletsWithBalance++;
      }
    } catch {}
  }
  console.log(`   ✅ ${walletsWithBalance}/${Math.min(wallets.length, 50)} wallets have engine balance\n`);

  // Group trades by wallet (preserving order within each wallet)
  const walletQueues = new Map<string, PreparedOrder[]>();
  let skippedCount = 0;

  for (const trade of trades) {
    const walletIdx = mapGmxToTestWallet(trade.account);
    const wallet = wallets[walletIdx];
    if (!wallet) { skippedCount++; continue; }

    const tokenAddr = marketToToken[trade.market.toLowerCase()];
    if (!tokenAddr) { skippedCount++; continue; }

    const scaled = scaleToMarginBnb(trade.sizeDeltaUsd);
    if (scaled.marginBnb <= 0) { skippedCount++; continue; }

    const sizeWei = BigInt(Math.round(scaled.sizeBnb * 1e4)) * BigInt(1e14);
    const leverageInt = Math.round(scaled.leverage * 10000);

    const order: PreparedOrder = {
      walletAddress: wallet.address,
      privateKey: wallet.privateKey,
      token: tokenAddr,
      isLong: trade.isLong,
      isIncrease: trade.type === "increase",
      size: sizeWei.toString(),
      leverage: leverageInt,
    };

    if (!walletQueues.has(wallet.address)) {
      walletQueues.set(wallet.address, []);
    }
    walletQueues.get(wallet.address)!.push(order);
  }

  console.log(`📋 Prepared: ${trades.length - skippedCount} orders across ${walletQueues.size} wallets (${skippedCount} skipped)\n`);

  // Replay: Process each wallet's queue sequentially, but run wallets in parallel
  const result: ReplayResult = {
    total: trades.length,
    submitted: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
    skipped: skippedCount,
    errors: {},
    durationMs: 0,
  };

  const startTime = Date.now();
  const WALLET_CONCURRENCY = 20; // Process 20 wallets in parallel
  const INTER_ORDER_DELAY_MS = 50; // 50ms between orders per wallet (for lock release)

  const walletEntries = [...walletQueues.entries()];
  let completedWallets = 0;
  let lastProgressReport = 0;

  // Process wallets in chunks
  for (let i = 0; i < walletEntries.length; i += WALLET_CONCURRENCY) {
    const chunk = walletEntries.slice(i, i + WALLET_CONCURRENCY);

    await Promise.all(chunk.map(async ([walletAddr, orders]) => {
      // Query engine for current nonce (in case of stale state)
      let nonce = 0;
      try {
        const nonceResp = await fetch(`${ENGINE}/api/user/${walletAddr}/nonce`);
        const nonceData = await nonceResp.json() as any;
        nonce = parseInt(nonceData.nonce || "0", 10);
      } catch {}

      for (const order of orders) {
        result.submitted++;
        const { nonceConsumed } = await submitOrder(order, nonce, result);

        if (nonceConsumed) {
          nonce++;
        } else {
          // Re-sync nonce from engine after failure
          try {
            const nonceResp = await fetch(`${ENGINE}/api/user/${walletAddr}/nonce`);
            const nonceData = await nonceResp.json() as any;
            const engineNonce = parseInt(nonceData.nonce || "0", 10);
            if (engineNonce !== nonce) {
              nonce = engineNonce; // Re-sync
            }
          } catch {}
        }

        // Small delay between orders for same wallet (lock + nonce)
        if (INTER_ORDER_DELAY_MS > 0) {
          await new Promise(r => setTimeout(r, INTER_ORDER_DELAY_MS));
        }
      }

      completedWallets++;
    }));

    // Progress report
    const totalSubmitted = result.accepted + result.rejected + result.failed;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (totalSubmitted / ((Date.now() - startTime) / 1000)).toFixed(0);
    console.log(
      `   📈 ${completedWallets}/${walletQueues.size} wallets | ${totalSubmitted} orders ` +
      `| ${elapsed}s | ${rate}/s | ✅${result.accepted} ❌${result.rejected} 💥${result.failed}`
    );
  }

  result.durationMs = Date.now() - startTime;

  // Check engine health after replay
  const healthResp = await fetch(`${ENGINE}/health`);
  const health = await healthResp.json() as any;

  // Print results
  console.log("\n" + "═".repeat(60));
  console.log("  GMX 48h REPLAY RESULTS");
  console.log("═".repeat(60));
  console.log(`  Total trades:      ${result.total}`);
  console.log(`  Submitted:         ${result.submitted}`);
  console.log(`  Skipped:           ${result.skipped}`);
  console.log(`  ✅ Accepted:        ${result.accepted} (${((result.accepted / result.submitted) * 100).toFixed(1)}%)`);
  console.log(`  ❌ Rejected:        ${result.rejected}`);
  console.log(`  💥 Failed:          ${result.failed}`);
  console.log(`  ⏱️  Duration:        ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  📊 Throughput:      ${(result.submitted / (result.durationMs / 1000)).toFixed(0)} orders/s`);
  console.log(`  🧠 Engine Memory:   ${health.metrics?.memoryMB}MB`);
  console.log(`  🔌 Redis:           ${health.services?.redis}`);
  console.log("═".repeat(60));

  if (Object.keys(result.errors).length > 0) {
    console.log("\n  Top Errors:");
    const sorted = Object.entries(result.errors).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [err, count] of sorted) {
      console.log(`    ${count}x ${err}`);
    }
  }

  // Save results
  const reportPath = resolve(__dirname, "../reports/replay-results.json");
  writeFileSync(reportPath, JSON.stringify(result, null, 2));
  console.log(`\n📝 Results saved to ${reportPath}`);
}

main().catch(console.error);
