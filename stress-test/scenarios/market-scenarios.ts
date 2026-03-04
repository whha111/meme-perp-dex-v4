/**
 * Market Scenarios — 6 extreme market conditions
 *
 * A: Flash Crash — instant -30%~-50%
 * B: Pump — gradual +60%~+100%
 * C: Dump — gradual -50%~-60%
 * D: Whipsaw — +25% → -40% → +20% (needle)
 * E: Slow Bleed — -2%~-3% every 5min for 1h
 * F: Near-Zero — crash to 5% of initial price
 *
 * Each scenario uses PriceFeed.updateTokenPrice (requires deployer key).
 */
import { type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getRpcPool } from "../utils/rpc-pool.js";
import { CONTRACTS, PRICE_FEED_ABI, TOKEN_FACTORY_ABI } from "../config.js";

// ── Types ──────────────────────────────────────────────────────

export type ScenarioType = "flash_crash" | "pump" | "dump" | "whipsaw" | "slow_bleed" | "near_zero";

export interface ScenarioResult {
  type: ScenarioType;
  startTime: number;
  endTime: number;
  pricesBefore: Map<Address, bigint>;
  pricesAfter: Map<Address, bigint>;
  success: boolean;
  error?: string;
}

// ── Scenario Executor ──────────────────────────────────────────

export class MarketScenarios {
  private deployerKey: `0x${string}`;

  constructor(deployerKey: `0x${string}`) {
    this.deployerKey = deployerKey;
  }

  /** Execute a scenario by type */
  async execute(type: ScenarioType): Promise<ScenarioResult> {
    const startTime = Date.now();
    const pricesBefore = await this.getAllPrices();
    console.log(`\n[Scenario] ═══ Starting: ${type.toUpperCase()} ═══`);

    try {
      switch (type) {
        case "flash_crash": await this.flashCrash(); break;
        case "pump": await this.pump(); break;
        case "dump": await this.dump(); break;
        case "whipsaw": await this.whipsaw(); break;
        case "slow_bleed": await this.slowBleed(); break;
        case "near_zero": await this.nearZero(); break;
      }

      const pricesAfter = await this.getAllPrices();
      console.log(`[Scenario] ═══ Completed: ${type.toUpperCase()} (${((Date.now() - startTime) / 1000).toFixed(0)}s) ═══\n`);

      return { type, startTime, endTime: Date.now(), pricesBefore, pricesAfter, success: true };
    } catch (err: any) {
      console.error(`[Scenario] ✗ ${type} failed: ${err.message}`);
      return {
        type, startTime, endTime: Date.now(),
        pricesBefore, pricesAfter: pricesBefore,
        success: false, error: err.message,
      };
    }
  }

  /** Recover prices to original values */
  async recoverPrices(pricesBefore: Map<Address, bigint>): Promise<void> {
    console.log(`[Scenario] Recovering ${pricesBefore.size} token prices...`);
    for (const [token, price] of pricesBefore) {
      await this.updatePrice(token, price);
    }
    console.log(`[Scenario] Prices recovered`);
  }

  // ── Scenario Implementations ─────────────────────────────────

  /** A: Flash Crash — instant -30%~-50% */
  private async flashCrash(): Promise<void> {
    const tokens = await this.getTokens();
    for (const token of tokens) {
      const currentPrice = await this.getPrice(token);
      if (currentPrice === 0n) continue;
      const dropPct = 30 + Math.floor(Math.random() * 20); // 30-50%
      const newPrice = currentPrice * BigInt(100 - dropPct) / 100n;
      await this.updatePrice(token, newPrice);
      console.log(`[FlashCrash] ${token.slice(0, 10)} -${dropPct}%`);
    }
  }

  /** B: Pump — gradual +60%~+100% via 5 steps */
  private async pump(): Promise<void> {
    const tokens = await this.getTokens();
    const steps = 5;
    for (let step = 0; step < steps; step++) {
      for (const token of tokens) {
        const currentPrice = await this.getPrice(token);
        if (currentPrice === 0n) continue;
        const bumpPct = 10 + Math.floor(Math.random() * 5); // +10%~+15%
        const newPrice = currentPrice * BigInt(100 + bumpPct) / 100n;
        await this.updatePrice(token, newPrice);
      }
      console.log(`[Pump] Step ${step + 1}/${steps} — prices raised`);
      await new Promise(r => setTimeout(r, 30_000)); // 30s between steps
    }
  }

  /** C: Dump — gradual -50%~-60% via 5 steps */
  private async dump(): Promise<void> {
    const tokens = await this.getTokens();
    const steps = 5;
    for (let step = 0; step < steps; step++) {
      for (const token of tokens) {
        const currentPrice = await this.getPrice(token);
        if (currentPrice === 0n) continue;
        const dropPct = 10 + Math.floor(Math.random() * 5); // -10%~-15%
        const newPrice = currentPrice * BigInt(100 - dropPct) / 100n;
        await this.updatePrice(token, newPrice);
      }
      console.log(`[Dump] Step ${step + 1}/${steps} — prices lowered`);
      await new Promise(r => setTimeout(r, 30_000));
    }
  }

  /** D: Whipsaw — +25% → -40% → +20% (needle manipulation) */
  private async whipsaw(): Promise<void> {
    const tokens = await this.getTokens();

    // Step 1: Pump +25%
    for (const token of tokens) {
      const price = await this.getPrice(token);
      if (price === 0n) continue;
      await this.updatePrice(token, price * 125n / 100n);
    }
    console.log(`[Whipsaw] Step 1: +25%`);
    await new Promise(r => setTimeout(r, 60_000));

    // Step 2: Crash -40% (net ~-25% from pump)
    for (const token of tokens) {
      const price = await this.getPrice(token);
      if (price === 0n) continue;
      await this.updatePrice(token, price * 60n / 100n);
    }
    console.log(`[Whipsaw] Step 2: -40%`);
    await new Promise(r => setTimeout(r, 60_000));

    // Step 3: Recovery +20%
    for (const token of tokens) {
      const price = await this.getPrice(token);
      if (price === 0n) continue;
      await this.updatePrice(token, price * 120n / 100n);
    }
    console.log(`[Whipsaw] Step 3: +20% (recovery)`);
  }

  /** E: Slow Bleed — -2%~-3% every 5min for 1h */
  private async slowBleed(): Promise<void> {
    const tokens = await this.getTokens();
    const iterations = 12; // 12 × 5min = 1h

    for (let i = 0; i < iterations; i++) {
      for (const token of tokens) {
        const price = await this.getPrice(token);
        if (price === 0n) continue;
        const dropPct = 2 + Math.floor(Math.random() * 2); // 2-3%
        await this.updatePrice(token, price * BigInt(100 - dropPct) / 100n);
      }
      console.log(`[SlowBleed] Iteration ${i + 1}/${iterations} — drip down`);
      await new Promise(r => setTimeout(r, 5 * 60_000)); // 5 minutes
    }
  }

  /** F: Near-Zero — crash to 5% of initial price */
  private async nearZero(): Promise<void> {
    const tokens = await this.getTokens();
    for (const token of tokens) {
      const price = await this.getPrice(token);
      if (price === 0n) continue;
      await this.updatePrice(token, price * 5n / 100n);
      console.log(`[NearZero] ${token.slice(0, 10)} → 5% of original`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  private async getTokens(): Promise<Address[]> {
    const pool = getRpcPool();
    try {
      const tokens = await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.tokenFactory,
          abi: TOKEN_FACTORY_ABI,
          functionName: "getAllTokens",
        })
      );
      return (tokens as Address[]).slice(0, 5); // Limit to 5 tokens
    } catch {
      return [];
    }
  }

  private async getPrice(token: Address): Promise<bigint> {
    const pool = getRpcPool();
    try {
      return await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.priceFeed,
          abi: PRICE_FEED_ABI,
          functionName: "getPrice",
          args: [token],
        })
      ) as bigint;
    } catch {
      return 0n;
    }
  }

  private async getAllPrices(): Promise<Map<Address, bigint>> {
    const tokens = await this.getTokens();
    const prices = new Map<Address, bigint>();
    for (const token of tokens) {
      const price = await this.getPrice(token);
      if (price > 0n) prices.set(token, price);
    }
    return prices;
  }

  private async updatePrice(token: Address, newPrice: bigint): Promise<void> {
    const pool = getRpcPool();
    const account = privateKeyToAccount(this.deployerKey);
    const walletClient = pool.createWallet(this.deployerKey);

    const hash = await pool.call(() =>
      walletClient.writeContract({
        chain: bscTestnet,
        address: CONTRACTS.priceFeed,
        abi: PRICE_FEED_ABI,
        functionName: "updateTokenPrice",
        args: [token, newPrice],
        account,
      })
    );

    await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash }));
  }
}
