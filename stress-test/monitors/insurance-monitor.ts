/**
 * Insurance Fund + Funding Rate + Platform Income Monitor
 *
 * Every 2 minutes tracks:
 * - Insurance fund balance
 * - Accumulated funding rate per token
 * - Platform fee receiver balance
 */
import { formatEther, type Address } from "viem";
import { getRpcPool } from "../utils/rpc-pool.js";
import { CONTRACTS, FUNDING_RATE_ABI, TOKEN_FACTORY_ABI } from "../config.js";

// ── Types ──────────────────────────────────────────────────────

export interface InsuranceSample {
  timestamp: number;
  insuranceFundBalance: bigint;
  fundingRates: Array<{ token: Address; rate: bigint }>;
  vaultBalance: bigint;
  settlementBalance: bigint;
}

export interface InsuranceStats {
  totalSamples: number;
  peakInsuranceFund: bigint;
  minInsuranceFund: bigint;
  samples: InsuranceSample[];
}

// ── Insurance Monitor ──────────────────────────────────────────

export class InsuranceMonitor {
  private running = false;
  private tokens: Address[] = [];
  readonly stats: InsuranceStats = {
    totalSamples: 0, peakInsuranceFund: 0n,
    minInsuranceFund: BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFF"), samples: [],
  };

  async startPeriodic(intervalMs: number): Promise<void> {
    this.running = true;
    console.log(`[InsuranceMonitor] Started periodic tracking every ${intervalMs / 1000}s`);

    while (this.running) {
      try {
        await this.sample();
      } catch (err: any) {
        console.error(`[InsuranceMonitor] Sample error: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  stop(): void {
    this.running = false;
  }

  private async sample(): Promise<void> {
    const pool = getRpcPool();

    // Refresh tokens periodically
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

    // 1. Insurance Fund balance
    const insuranceFundBalance = await pool.call(() =>
      pool.httpClient.getBalance({ address: CONTRACTS.insuranceFund })
    );

    // 2. Funding rates for each token
    const fundingRates: InsuranceSample["fundingRates"] = [];
    for (const token of this.tokens.slice(0, 5)) { // Limit to first 5 tokens
      try {
        const rate = await pool.call(() =>
          pool.httpClient.readContract({
            address: CONTRACTS.fundingRate,
            abi: FUNDING_RATE_ABI,
            functionName: "accumulatedFundingRate",
            args: [token],
          })
        );
        fundingRates.push({ token, rate: rate as bigint });
      } catch {}
    }

    // 3. Vault + Settlement balances
    const vaultBalance = await pool.call(() =>
      pool.httpClient.getBalance({ address: CONTRACTS.vault })
    );
    const settlementBalance = await pool.call(() =>
      pool.httpClient.getBalance({ address: CONTRACTS.settlement })
    );

    const sample: InsuranceSample = {
      timestamp: Date.now(),
      insuranceFundBalance,
      fundingRates,
      vaultBalance,
      settlementBalance,
    };

    this.stats.totalSamples++;
    if (insuranceFundBalance > this.stats.peakInsuranceFund) {
      this.stats.peakInsuranceFund = insuranceFundBalance;
    }
    if (insuranceFundBalance < this.stats.minInsuranceFund) {
      this.stats.minInsuranceFund = insuranceFundBalance;
    }
    this.stats.samples.push(sample);

    // Keep only last 1000
    if (this.stats.samples.length > 1000) {
      this.stats.samples = this.stats.samples.slice(-500);
    }

    console.log(
      `[Insurance] #${this.stats.totalSamples} | ` +
      `fund=${formatEther(insuranceFundBalance)} ETH | ` +
      `vault=${formatEther(vaultBalance)} | ` +
      `settlement=${formatEther(settlementBalance)} | ` +
      `funding rates: ${fundingRates.length} tokens tracked`
    );
  }
}
