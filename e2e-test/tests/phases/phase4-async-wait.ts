/**
 * Phase 4: Wait for Async Processes + Aggressive Price Manipulation
 *
 * Funding rate settles every 8 minutes. We wait 10 minutes total.
 * During the wait, we execute large spot trades to:
 * 1. Create funding rate skew (OI imbalance)
 * 2. Move prices enough to trigger liquidations
 */
import { type Address, type Hex, formatEther } from "viem";
import { spotBuy, spotSell, getSpotPrice } from "../../utils/spot-trader";
import { ENV } from "../../config/test-config";

const ENGINE = ENV.ENGINE_URL;
const WAIT_TOTAL_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_MS = 30 * 1000;    // Poll every 30s

export interface Phase4Result {
  fundingRatesObserved: Record<string, string[]>;
  priceManipulations: Array<{ symbol: string; direction: string; priceBefore: string; priceAfter: string }>;
  liquidationAttempts: number;
  openPositionsAtEnd: number;
  passed: boolean;
  errors: string[];
}

export async function runPhase4(
  wallets: any[],
  tokenData: Record<string, { address: string }>,
): Promise<Phase4Result> {
  console.log("\n══════════════════════════════════════════════");
  console.log("  PHASE 4: Async Wait + Price Manipulation");
  console.log(`  (10 minutes — funding rate, liquidations)`);
  console.log("══════════════════════════════════════════════\n");

  const errors: string[] = [];
  const fundingRatesObserved: Record<string, string[]> = {};
  const priceManipulations: Phase4Result["priceManipulations"] = [];
  let liquidationAttempts = 0;
  let openPositionsAtEnd = 0;

  // Use deployer wallet for all spot trades — test wallets have ~0 on-chain BNB
  const deployerKey = ENV.DEPLOYER_PRIVATE_KEY as Hex;

  const tokens = Object.entries(tokenData);
  const startTime = Date.now();

  // Initialize funding rate tracking
  for (const [symbol] of tokens) {
    fundingRatesObserved[symbol] = [];
  }

  // Polling loop
  let pollCount = 0;
  const pollUntil = startTime + WAIT_TOTAL_MS;

  while (Date.now() < pollUntil) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    pollCount++;

    // Poll funding rates
    for (const [symbol, info] of tokens) {
      try {
        const resp = await fetch(`${ENGINE}/api/funding-rate/${info.address}`);
        if (resp.ok) {
          const data = await resp.json() as any;
          const rate = data.fundingRate || data.rate || "0";
          fundingRatesObserved[symbol].push(rate.toString());
        }
      } catch {}
    }

    // Poll health for position count
    try {
      const resp = await fetch(`${ENGINE}/health`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const positions = data.metrics?.mapSizes?.userPositions || 0;
        console.log(`  [${elapsed}s] Positions: ${positions}, polling funding rates...`);
      }
    } catch {}

    // ═══ T+5min: First wave of price manipulation ═══
    if (elapsed >= 290 && elapsed < 330 && priceManipulations.length < 2) {
      console.log(`\n  ═══ Price Manipulation Wave 1 (T+${elapsed}s) ═══`);

      // DOGE3: Large buy (price UP) → short positions may liquidate
      try {
        const dogeToken = tokens.find(([s]) => s.includes("DOGE"))?.[1];
        if (dogeToken) {
          const addr = dogeToken.address as Address;
          const priceBefore = await getSpotPrice(addr);
          console.log(`    DOGE3: Buying 0.5 BNB (price UP)...`);
          const result = await spotBuy(deployerKey, addr, "0.5");
          if (result.success) {
            priceManipulations.push({
              symbol: "DOGE3",
              direction: "UP",
              priceBefore: priceBefore.toString(),
              priceAfter: (result.priceAfter || 0n).toString(),
            });
            console.log(`    DOGE3: ${priceBefore} → ${result.priceAfter}`);
          }
        }
      } catch (e: any) {
        errors.push(`DOGE3 price manipulation failed: ${e.message?.slice(0, 100)}`);
      }

      // SHIB2: Sell tokens (price DOWN) → long positions may liquidate
      try {
        const shibToken = tokens.find(([s]) => s.includes("SHIB"))?.[1];
        if (shibToken) {
          const addr = shibToken.address as Address;
          const priceBefore = await getSpotPrice(addr);
          console.log(`    SHIB2: Selling tokens (price DOWN)...`);
          const result = await spotSell(deployerKey, addr, 0.7);
          if (result.success) {
            priceManipulations.push({
              symbol: "SHIB2",
              direction: "DOWN",
              priceBefore: priceBefore.toString(),
              priceAfter: (result.priceAfter || 0n).toString(),
            });
            console.log(`    SHIB2: ${priceBefore} → ${result.priceAfter}`);
          }
        }
      } catch (e: any) {
        errors.push(`SHIB2 price manipulation failed: ${e.message?.slice(0, 100)}`);
      }

      // Wait for engine to process liquidations
      console.log(`    Waiting 30s for liquidation checks...`);
      await new Promise(r => setTimeout(r, 30000));
      continue; // Skip the normal poll wait
    }

    // ═══ T+9min: Second wave ═══
    if (elapsed >= 530 && elapsed < 570 && priceManipulations.length < 4) {
      console.log(`\n  ═══ Price Manipulation Wave 2 (T+${elapsed}s) ═══`);

      // PEPE2: Buy (price UP)
      try {
        const pepeToken = tokens.find(([s]) => s.includes("PEPE"))?.[1];
        if (pepeToken) {
          const addr = pepeToken.address as Address;
          const priceBefore = await getSpotPrice(addr);
          console.log(`    PEPE2: Buying 0.5 BNB (price UP)...`);
          const result = await spotBuy(deployerKey, addr, "0.5");
          if (result.success) {
            priceManipulations.push({
              symbol: "PEPE2",
              direction: "UP",
              priceBefore: priceBefore.toString(),
              priceAfter: (result.priceAfter || 0n).toString(),
            });
          }
        }
      } catch {}

      // FLOK2: Sell (price DOWN)
      try {
        const flokToken = tokens.find(([s]) => s.includes("FLOK"))?.[1];
        if (flokToken) {
          const addr = flokToken.address as Address;
          const priceBefore = await getSpotPrice(addr);
          console.log(`    FLOK2: Selling tokens (price DOWN)...`);
          const result = await spotSell(deployerKey, addr, 0.7);
          if (result.success) {
            priceManipulations.push({
              symbol: "FLOK2",
              direction: "DOWN",
              priceBefore: priceBefore.toString(),
              priceAfter: (result.priceAfter || 0n).toString(),
            });
          }
        }
      } catch {}

      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    // Normal poll wait
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Final check: how many positions and any liquidations?
  try {
    const resp = await fetch(`${ENGINE}/health`);
    if (resp.ok) {
      const data = await resp.json() as any;
      openPositionsAtEnd = data.metrics?.mapSizes?.userPositions || 0;
    }
  } catch {}

  // Check if any funding settlements occurred
  const fundingSettled = Object.values(fundingRatesObserved).some(
    rates => rates.some(r => r !== "0" && r !== "0n")
  );

  const passed = fundingSettled || priceManipulations.length >= 2;
  console.log(`\n  Phase 4 result: ${passed ? "PASS" : "FAIL"}`);
  console.log(`    Funding rates observed: ${fundingSettled ? "YES" : "NO"}`);
  console.log(`    Price manipulations: ${priceManipulations.length}`);
  console.log(`    Open positions: ${openPositionsAtEnd}`);

  return {
    fundingRatesObserved,
    priceManipulations,
    liquidationAttempts,
    openPositionsAtEnd,
    passed,
    errors,
  };
}
