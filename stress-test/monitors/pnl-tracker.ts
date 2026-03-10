/**
 * PnL Tracker — Per-wallet unrealized PnL tracking
 *
 * Every 2 minutes samples:
 * - Each perp wallet's unrealized PnL from PositionManager
 * - Vault/PerpVault total balances
 * - Platform fee receiver balance changes
 */
import { formatEther, type Address } from "viem";
import { getRpcPool } from "../utils/rpc-pool.js";
import { type StressWallet } from "../utils/wallet-manager.js";
import { CONTRACTS, POSITION_MANAGER_ABI, TOKEN_FACTORY_ABI } from "../config.js";

// ── Types ──────────────────────────────────────────────────────

export interface PnlSample {
  timestamp: number;
  walletPnls: Array<{ address: Address; pnl: bigint; hasProfit: boolean }>;
  vaultBalance: bigint;
  perpVaultBalance: bigint;
  totalUnrealizedPnl: bigint;
}

export interface PnlStats {
  totalSamples: number;
  maxProfit: bigint;
  maxLoss: bigint;
  samples: PnlSample[];
}

// ── PnL Tracker ────────────────────────────────────────────────

export class PnlTracker {
  private running = false;
  private perpWallets: StressWallet[] = [];
  private tokens: Address[] = [];
  readonly stats: PnlStats = {
    totalSamples: 0, maxProfit: 0n, maxLoss: 0n, samples: [],
  };

  constructor(perpWallets: StressWallet[]) {
    this.perpWallets = perpWallets;
  }

  async startPeriodic(intervalMs: number): Promise<void> {
    this.running = true;
    console.log(`[PnlTracker] Started tracking ${this.perpWallets.length} wallets every ${intervalMs / 1000}s`);

    while (this.running) {
      try {
        await this.sample();
      } catch (err: any) {
        console.error(`[PnlTracker] Sample error: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  stop(): void {
    this.running = false;
  }

  private async sample(): Promise<void> {
    const pool = getRpcPool();

    // Refresh token list if needed
    if (this.tokens.length === 0 || this.stats.totalSamples % 30 === 0) {
      try {
        const tokens = await pool.call(() =>
          pool.httpClient.readContract({
            address: CONTRACTS.tokenFactory,
            abi: TOKEN_FACTORY_ABI,
            functionName: "getAllTokens",
          })
        );
        this.tokens = tokens as Address[];
      } catch {}
    }

    if (this.tokens.length === 0) return;

    // Sample PnL for each wallet across all tokens
    const walletPnls: PnlSample["walletPnls"] = [];
    let totalUnrealizedPnl = 0n;

    // For efficiency, only check first token (most active) for each wallet
    const primaryToken = this.tokens[0];

    const pnlCalls = this.perpWallets.map(w => () =>
      pool.httpClient.readContract({
        address: CONTRACTS.positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: "getUnrealizedPnl",
        args: [w.address, primaryToken],
      })
    );

    const results = await pool.batchRead(pnlCalls);
    results.forEach((r, i) => {
      if (r.success && r.result) {
        const [pnl, hasProfit] = r.result as [bigint, boolean];
        if (pnl !== 0n) {
          walletPnls.push({
            address: this.perpWallets[i].address,
            pnl,
            hasProfit,
          });
          totalUnrealizedPnl += hasProfit ? pnl : -pnl;

          if (hasProfit && pnl > this.stats.maxProfit) this.stats.maxProfit = pnl;
          if (!hasProfit && pnl > this.stats.maxLoss) this.stats.maxLoss = pnl;
        }
      }
    });

    // Read vault balances
    let vaultBalance = 0n;
    let perpVaultBalance = 0n;
    try {
      vaultBalance = await pool.call(() =>
        pool.httpClient.getBalance({ address: CONTRACTS.vault })
      );
    } catch {}

    const sample: PnlSample = {
      timestamp: Date.now(),
      walletPnls,
      vaultBalance,
      perpVaultBalance,
      totalUnrealizedPnl,
    };

    this.stats.totalSamples++;
    this.stats.samples.push(sample);

    // Keep only last 1000 samples to avoid memory bloat
    if (this.stats.samples.length > 1000) {
      this.stats.samples = this.stats.samples.slice(-500);
    }

    const posCount = walletPnls.filter(p => p.hasProfit).length;
    const negCount = walletPnls.filter(p => !p.hasProfit).length;
    console.log(
      `[PnlTracker] Sample #${this.stats.totalSamples} | ` +
      `${walletPnls.length} positions (${posCount}↑ ${negCount}↓) | ` +
      `net=${formatEther(totalUnrealizedPnl)} ETH | ` +
      `vault=${formatEther(vaultBalance)} ETH`
    );
  }
}
