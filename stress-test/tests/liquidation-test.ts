/**
 * Liquidation & Profit Withdrawal — Directed Test
 *
 * Architecture: Mark price is NOT driven by perp trade execution.
 * It comes from the PriceFeed oracle / TokenFactory bonding curve,
 * synced to the engine every ~1s via syncSpotPrices().
 *
 * To force liquidations, we use the engine's direct price API:
 *   POST /api/price/update { token, price }
 * This sets the OrderBook's mark price and triggers globalPriceChangeCallback
 * → RiskEngine checks all positions → auto-liquidates if below maintenance margin.
 *
 * Test flow:
 *   Phase 1: Open LONG + SHORT positions at current price (30x leverage)
 *   Phase 2: PUMP — set mark price to 2x → SHORTs liquidated, LONGs profit
 *   Phase 3: Restore price, open new positions
 *   Phase 4: DUMP — set mark price to 0.5x → LONGs liquidated, SHORTs profit
 *   Phase 5: Restore price, verify PerpVault health
 *
 * Usage:
 *   bun run stress-test/tests/liquidation-test.ts
 */
import { parseEther, formatEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadWallets, getPerpWallets, type StressWallet } from "../utils/wallet-manager.js";
import {
  CONTRACTS, MATCHING_ENGINE, EIP712_DOMAIN, ORDER_TYPES,
  TOKEN_FACTORY_ABI, PERP_VAULT_ABI,
} from "../config.js";
import { getRpcPool } from "../utils/rpc-pool.js";

// ── Config ──────────────────────────────────────────────────
const LEVERAGE_MULTIPLIER = 30n;       // 30x leverage → ~3.3% move = liquidation
const LEVERAGE = LEVERAGE_MULTIPLIER * 10000n;  // 1e4 precision
const POSITION_SIZE = parseEther("0.002");      // 0.002 ETH per position
const PUMP_MULTIPLIER = 200n;          // Price × 2 (double)
const DUMP_MULTIPLIER = 50n;           // Price × 0.5 (halve)
const PRICE_STEPS = 5;                 // Gradual price movement in N steps

// ── Types ───────────────────────────────────────────────────
interface EnginePosition {
  pairId: string;
  token: string;
  trader: string;
  isLong: boolean;
  size: string;
  collateral: string;
  entryPrice: string;
  leverage: string;
  liquidationPrice: string;
  unrealizedPnL: string;
  unrealizedPnl?: string;
  marginRatio?: string;
  isLiquidatable?: boolean;
  riskLevel?: string;
  markPrice?: string;
}

interface TestResult {
  phase: string;
  token: Address;
  priceDirection: "pump" | "dump";
  startPrice: bigint;
  endPrice: bigint;
  positionsOpened: number;
  liquidationsDetected: number;
  profitClosesAttempted: number;
  profitClosesSucceeded: number;
  balanceIncreasedCount: number;
  errors: string[];
}

// ── Helpers ─────────────────────────────────────────────────

const localNonces = new Map<Address, bigint>();

async function syncNonce(wallet: StressWallet): Promise<void> {
  try {
    const resp = await fetch(`${MATCHING_ENGINE.url}/api/user/${wallet.address}/nonce`);
    const data = await resp.json() as { nonce?: string | number };
    if (data.nonce != null) {
      localNonces.set(wallet.address, BigInt(data.nonce));
    }
  } catch {
    localNonces.set(wallet.address, 0n);
  }
}

function getNonce(wallet: StressWallet): bigint {
  return localNonces.get(wallet.address) ?? 0n;
}

function incrementNonce(wallet: StressWallet): void {
  const current = getNonce(wallet);
  localNonces.set(wallet.address, current + 1n);
}

async function getAvailableBalance(wallet: StressWallet): Promise<bigint> {
  try {
    const resp = await fetch(`${MATCHING_ENGINE.url}/api/user/${wallet.address}/balance`);
    const data = await resp.json() as { availableBalance?: string };
    return BigInt(data.availableBalance ?? "0");
  } catch {
    return 0n;
  }
}

async function getPositions(wallet: StressWallet): Promise<EnginePosition[]> {
  try {
    const resp = await fetch(`${MATCHING_ENGINE.url}/api/user/${wallet.address}/positions`);
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function getTokenPrice(token: Address): Promise<bigint> {
  // Primary: matching engine stats
  try {
    const resp = await fetch(`${MATCHING_ENGINE.url}/api/stats/${token}`);
    const data = await resp.json() as { lastPrice?: string; price?: string; markPrice?: string };
    const p = BigInt(data.lastPrice || data.markPrice || data.price || "0");
    if (p > 0n) return p;
  } catch {}

  // Fallback: TokenFactory bonding curve
  try {
    const pool = getRpcPool();
    const price = await pool.call(() =>
      pool.httpClient.readContract({
        address: CONTRACTS.tokenFactory,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getCurrentPrice",
        args: [token],
      })
    ) as bigint;
    if (price > 0n) return price;
  } catch {}

  return 0n;
}

/**
 * Directly set the mark price in the matching engine.
 * This bypasses the oracle and triggers globalPriceChangeCallback
 * → RiskEngine checks all positions → auto-liquidates if below margin.
 *
 * Price precision: 1e18 (same as ETH wei — the engine converts internally)
 */
async function setMarkPrice(token: Address, price: bigint): Promise<boolean> {
  try {
    const resp = await fetch(`${MATCHING_ENGINE.url}/api/price/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, price: price.toString() }),
    });
    const data = await resp.json() as { success?: boolean; error?: string };
    return data.success === true;
  } catch {
    return false;
  }
}

async function submitOrder(
  wallet: StressWallet,
  token: Address,
  isLong: boolean,
  size: bigint,
  leverage: bigint,
  orderType: number,
  price: bigint,
): Promise<{ success: boolean; matched: boolean; error?: string }> {
  const account = privateKeyToAccount(wallet.privateKey);
  const nonce = getNonce(wallet);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const order = {
    trader: wallet.address,
    token,
    isLong,
    size,
    leverage,
    price,
    deadline,
    nonce,
    orderType,
  };

  const signature = await account.signTypedData({
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order" as const,
    message: order,
  });

  try {
    const response = await fetch(`${MATCHING_ENGINE.url}${MATCHING_ENGINE.submitEndpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader: order.trader,
        token: order.token,
        isLong: order.isLong,
        size: order.size.toString(),
        leverage: order.leverage.toString(),
        price: order.price.toString(),
        deadline: order.deadline.toString(),
        nonce: order.nonce.toString(),
        orderType: order.orderType,
        signature,
      }),
    });
    const result = await response.json() as { success: boolean; matches?: any[]; error?: string };

    if (result.success) {
      incrementNonce(wallet);
      return { success: true, matched: (result.matches?.length ?? 0) > 0 };
    }
    return { success: false, matched: false, error: result.error };
  } catch (err: any) {
    return { success: false, matched: false, error: err.message };
  }
}

async function closePosition(wallet: StressWallet, pairId: string): Promise<boolean> {
  const account = privateKeyToAccount(wallet.privateKey);
  const closeMessage = `Close pair ${pairId} for ${wallet.address.toLowerCase()}`;
  const signature = await account.signMessage({ message: closeMessage });

  try {
    const resp = await fetch(`${MATCHING_ENGINE.url}/api/position/${pairId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trader: wallet.address, closeRatio: 1, signature }),
    });
    const result = await resp.json() as { success?: boolean; error?: string };
    return result.success === true;
  } catch {
    return false;
  }
}

async function syncEngineBalance(wallet: StressWallet): Promise<void> {
  try {
    await fetch(`${MATCHING_ENGINE.url}/api/balance/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trader: wallet.address }),
    });
  } catch {}
}

// ── Main Test ───────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║   Liquidation & Profit Withdrawal — Directed Test ║");
  console.log("║   Method: POST /api/price/update (direct mark)    ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  // Load wallets (must match soak test: 200 spot + 200 perp)
  // Perp wallets are pool indices 200-399 — these have SettlementV2 deposits
  const allWallets = loadWallets(200, 200);
  const allPerpWallets = getPerpWallets(allWallets);
  console.log(`[Setup] Loaded ${allPerpWallets.length} perp wallets`);

  // Filter to wallets with actual engine balance
  console.log("[Setup] Checking wallet balances (may take ~30s for 200 wallets)...");
  const fundedWallets: StressWallet[] = [];
  // Check in parallel batches of 20
  for (let i = 0; i < allPerpWallets.length; i += 20) {
    const batch = allPerpWallets.slice(i, i + 20);
    const results = await Promise.all(batch.map(async w => ({
      wallet: w,
      balance: await getAvailableBalance(w),
    })));
    for (const { wallet, balance } of results) {
      if (balance > parseEther("0.001")) {
        fundedWallets.push(wallet);
      }
    }
  }
  console.log(`[Setup] Found ${fundedWallets.length} funded wallets (need ≥20)`);

  if (fundedWallets.length < 20) {
    console.error("❌ Not enough funded wallets. Run the soak test first to deposit funds.");
    process.exit(1);
  }

  // Split funded wallets: 20 for positions
  const positionWallets = fundedWallets.slice(0, 20);

  // Sync nonces + engine balances
  console.log("[Setup] Syncing nonces + balances...");
  await Promise.all(positionWallets.map(w => syncNonce(w)));
  await Promise.all(positionWallets.map(w => syncEngineBalance(w)));
  await new Promise(r => setTimeout(r, 2000));

  // Find a token with reasonable price
  console.log("[Setup] Finding tradable tokens...");
  let targetToken: Address | null = null;
  let currentPrice = 0n;

  const knownTokens: Address[] = [
    "0x1BC7c612e55b8CC8e24aA4041FAC3732d50C4C6F", // DOGE
    "0x0d0156063c5f805805d5324af69932FB790819D5", // PEPE
    "0x0724863BD88e1F4919c85294149ae87209E917Da", // SHIB
  ];

  for (const t of knownTokens) {
    const p = await getTokenPrice(t);
    if (p > 0n) {
      targetToken = t;
      currentPrice = p;
      break;
    }
  }

  if (!targetToken) {
    try {
      const resp = await fetch(`${MATCHING_ENGINE.url}/api/tokens`);
      const tokens = await resp.json() as string[];
      for (const t of tokens.slice(0, 10)) {
        const p = await getTokenPrice(t as Address);
        if (p > 0n) {
          targetToken = t as Address;
          currentPrice = p;
          break;
        }
      }
    } catch {}
  }

  if (!targetToken || currentPrice === 0n) {
    console.error("❌ Could not find any token with a non-zero price!");
    process.exit(1);
  }

  console.log(`[Setup] Token: ${targetToken}`);
  console.log(`[Setup] Current price: ${formatEther(currentPrice)} ETH`);
  console.log(`[Setup] With 30x leverage, liquidation at ~3.3% adverse move\n`);

  // Save original price to restore later
  const originalPrice = currentPrice;

  // ═══════════════════════════════════════════════════════════
  // Phase 1: Open positions in both directions
  // ═══════════════════════════════════════════════════════════
  console.log("═══ Phase 1: Opening positions (LONG + SHORT) ═══");

  // Close any existing positions first
  for (const w of positionWallets) {
    const positions = await getPositions(w);
    for (const pos of positions) {
      if (BigInt(pos.size || "0") > 0n && pos.pairId) {
        await closePosition(w, pos.pairId);
      }
    }
  }
  await new Promise(r => setTimeout(r, 2000));

  // Split: first half LONG, second half SHORT
  const halfCount = Math.min(10, Math.floor(positionWallets.length / 2));
  const longWallets = positionWallets.slice(0, halfCount);
  const shortWallets = positionWallets.slice(halfCount, halfCount * 2);
  let openedLongs = 0;
  let openedShorts = 0;
  const longTracking = new Set<string>();
  const shortTracking = new Set<string>();

  for (let i = 0; i < halfCount; i++) {
    const lw = longWallets[i];
    const sw = shortWallets[i];

    // Submit paired orders at current price (they cross and match)
    const longRes = await submitOrder(lw, targetToken, true, POSITION_SIZE, LEVERAGE, 1, currentPrice);
    if (longRes.success) { openedLongs++; longTracking.add(lw.address); }

    const shortRes = await submitOrder(sw, targetToken, false, POSITION_SIZE, LEVERAGE, 1, currentPrice);
    if (shortRes.success) { openedShorts++; shortTracking.add(sw.address); }

    if (longRes.success && shortRes.success) {
      console.log(`  ✓ Pair ${i+1}: W${lw.index} LONG + W${sw.index} SHORT @ ${formatEther(currentPrice)} (${LEVERAGE_MULTIPLIER}x)`);
    } else {
      console.log(`  ✗ Pair ${i+1}: L=${longRes.success}(${longRes.error?.slice(0,40) || "ok"}) S=${shortRes.success}(${shortRes.error?.slice(0,40) || "ok"})`);
    }
  }

  console.log(`\n  Opened: ${openedLongs} LONGs + ${openedShorts} SHORTs`);
  await new Promise(r => setTimeout(r, 3000));

  // Verify positions exist
  let verifiedLongs = 0, verifiedShorts = 0;
  for (const w of longWallets) {
    if (!longTracking.has(w.address)) continue;
    const pos = await getPositions(w);
    if (pos.some(p => p.token.toLowerCase() === targetToken!.toLowerCase() && p.isLong && BigInt(p.size || "0") > 0n)) {
      verifiedLongs++;
    }
  }
  for (const w of shortWallets) {
    if (!shortTracking.has(w.address)) continue;
    const pos = await getPositions(w);
    if (pos.some(p => p.token.toLowerCase() === targetToken!.toLowerCase() && !p.isLong && BigInt(p.size || "0") > 0n)) {
      verifiedShorts++;
    }
  }
  console.log(`  Verified: ${verifiedLongs} LONGs + ${verifiedShorts} SHORTs in engine\n`);

  if (verifiedLongs === 0 && verifiedShorts === 0) {
    console.error("❌ No positions opened! Cannot test liquidation.");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 2: PUMP — set mark price to 2x → SHORTs liquidated
  // ═══════════════════════════════════════════════════════════
  console.log("═══ Phase 2: 暴力拉升 (PUMP) — killing SHORTs ═══");
  const pumpResult = await executeDirectionalMove(
    targetToken, currentPrice, "pump",
    longWallets, shortWallets,
    shortTracking, longTracking,
  );
  printPhaseResult(pumpResult);

  // Wait for engine to fully process liquidations
  console.log("  Waiting 10s for engine to process...");
  await new Promise(r => setTimeout(r, 10_000));

  // ═══════════════════════════════════════════════════════════
  // Phase 3: Restore price, re-open positions, then DUMP
  // ═══════════════════════════════════════════════════════════
  console.log("\n═══ Phase 3: Restoring price + opening new positions ═══");

  // Restore to a price near original (so new positions aren't immediately liquidated)
  const restorePrice = originalPrice;
  console.log(`  Restoring mark price to ${formatEther(restorePrice)}...`);
  await setMarkPrice(targetToken, restorePrice);
  await new Promise(r => setTimeout(r, 3000));

  // Sync nonces again (some wallets may have had nonce changes from liquidation)
  await Promise.all(positionWallets.map(w => syncNonce(w)));

  // Re-open positions for Phase 4
  const newLongWallets = positionWallets.slice(0, 5);
  const newShortWallets = positionWallets.slice(5, 10);
  const newLongTracking = new Set<string>();
  const newShortTracking = new Set<string>();

  for (let i = 0; i < 5; i++) {
    const lw = newLongWallets[i];
    const sw = newShortWallets[i];

    const lRes = await submitOrder(lw, targetToken, true, POSITION_SIZE, LEVERAGE, 1, restorePrice);
    if (lRes.success) newLongTracking.add(lw.address);

    const sRes = await submitOrder(sw, targetToken, false, POSITION_SIZE, LEVERAGE, 1, restorePrice);
    if (sRes.success) newShortTracking.add(sw.address);

    if (lRes.success && sRes.success) {
      console.log(`  ✓ New pair ${i+1}: W${lw.index} LONG + W${sw.index} SHORT @ ${formatEther(restorePrice)} (${LEVERAGE_MULTIPLIER}x)`);
    } else {
      console.log(`  ✗ New pair ${i+1}: L=${lRes.success}(${lRes.error?.slice(0,30) || "ok"}) S=${sRes.success}(${sRes.error?.slice(0,30) || "ok"})`);
    }
  }
  console.log(`  Opened: ${newLongTracking.size} LONGs + ${newShortTracking.size} SHORTs`);
  await new Promise(r => setTimeout(r, 3000));

  // Verify Phase 3 positions exist
  let p3Longs = 0, p3Shorts = 0;
  for (const w of newLongWallets) {
    if (!newLongTracking.has(w.address)) continue;
    const pos = await getPositions(w);
    if (pos.some(p => p.token.toLowerCase() === targetToken!.toLowerCase() && BigInt(p.size || "0") > 0n)) p3Longs++;
  }
  for (const w of newShortWallets) {
    if (!newShortTracking.has(w.address)) continue;
    const pos = await getPositions(w);
    if (pos.some(p => p.token.toLowerCase() === targetToken!.toLowerCase() && BigInt(p.size || "0") > 0n)) p3Shorts++;
  }
  console.log(`  Verified: ${p3Longs} LONGs + ${p3Shorts} SHORTs in engine\n`);

  // ═══════════════════════════════════════════════════════════
  // Phase 4: DUMP — set mark price to 0.5x → LONGs liquidated
  // ═══════════════════════════════════════════════════════════
  console.log("\n═══ Phase 4: 暴力砸盘 (DUMP) — killing LONGs ═══");
  const dumpResult = await executeDirectionalMove(
    targetToken, restorePrice, "dump",
    newLongWallets, newShortWallets,
    newLongTracking, newShortTracking,
  );
  printPhaseResult(dumpResult);

  console.log("  Waiting 10s for engine to process...");
  await new Promise(r => setTimeout(r, 10_000));

  // ═══════════════════════════════════════════════════════════
  // Phase 5: Restore price + final verification
  // ═══════════════════════════════════════════════════════════
  console.log("\n═══ Phase 5: Final Verification ═══");

  // Restore price to original
  console.log(`  Restoring mark price to ${formatEther(originalPrice)}...`);
  await setMarkPrice(targetToken, originalPrice);

  // Check PerpVault health
  const pool = getRpcPool();
  try {
    const poolValue = await pool.call(() =>
      pool.httpClient.readContract({
        address: CONTRACTS.perpVault,
        abi: PERP_VAULT_ABI,
        functionName: "getPoolValue",
      })
    ) as bigint;
    console.log(`  PerpVault pool value: ${formatEther(poolValue)} ETH`);
    console.log(`  Status: ${poolValue > parseEther("0.5") ? "✅ HEALTHY" : "⚠️ LOW"}`);
  } catch (e: any) {
    console.log(`  ❌ PerpVault read failed: ${e.message?.slice(0, 60)}`);
  }

  // Summary
  console.log("\n╔═══════════════════════════════════════════════════╗");
  console.log("║                  TEST SUMMARY                     ║");
  console.log("╠═══════════════════════════════════════════════════╣");
  console.log(`║ PUMP (price 2x → kills SHORTs):                   ║`);
  console.log(`║   Price: ${formatEther(pumpResult.startPrice)} → ${formatEther(pumpResult.endPrice)}`);
  console.log(`║   Liquidations detected: ${pumpResult.liquidationsDetected}`);
  console.log(`║   Profit closes: ${pumpResult.profitClosesSucceeded}/${pumpResult.profitClosesAttempted}`);
  console.log(`║   Balance increased: ${pumpResult.balanceIncreasedCount}`);
  console.log(`║ DUMP (price 0.5x → kills LONGs):                  ║`);
  console.log(`║   Price: ${formatEther(dumpResult.startPrice)} → ${formatEther(dumpResult.endPrice)}`);
  console.log(`║   Liquidations detected: ${dumpResult.liquidationsDetected}`);
  console.log(`║   Profit closes: ${dumpResult.profitClosesSucceeded}/${dumpResult.profitClosesAttempted}`);
  console.log(`║   Balance increased: ${dumpResult.balanceIncreasedCount}`);
  console.log("╚═══════════════════════════════════════════════════╝");

  const totalLiq = pumpResult.liquidationsDetected + dumpResult.liquidationsDetected;
  const totalProfit = pumpResult.profitClosesSucceeded + dumpResult.profitClosesSucceeded;
  const totalBalance = pumpResult.balanceIncreasedCount + dumpResult.balanceIncreasedCount;

  if (totalLiq > 0 && totalProfit > 0 && totalBalance > 0) {
    console.log("\n🎉 SUCCESS — Liquidation + Profit Withdrawal both verified!");
  } else if (totalLiq > 0 || totalProfit > 0) {
    console.log("\n⚠️ PARTIAL — Some tests passed but not all:");
    if (totalLiq === 0) console.log("   - No liquidations detected");
    if (totalProfit === 0) console.log("   - No profit withdrawals succeeded");
    if (totalBalance === 0) console.log("   - Balance didn't increase after profit close");
  } else {
    console.log("\n❌ FAILED — Neither liquidation nor profit withdrawal verified");
  }

  process.exit(0);
}

// ── Price Movement + Verification ───────────────────────────

async function executeDirectionalMove(
  token: Address,
  startPrice: bigint,
  direction: "pump" | "dump",
  longWallets: StressWallet[],
  shortWallets: StressWallet[],
  losingSideTracking: Set<string>,
  winningSideTracking: Set<string>,
): Promise<TestResult> {
  const result: TestResult = {
    phase: direction,
    token,
    priceDirection: direction,
    startPrice,
    endPrice: startPrice,
    positionsOpened: 0,
    liquidationsDetected: 0,
    profitClosesAttempted: 0,
    profitClosesSucceeded: 0,
    balanceIncreasedCount: 0,
    errors: [],
  };

  // Calculate target price
  const targetMultiplier = direction === "pump" ? PUMP_MULTIPLIER : DUMP_MULTIPLIER;
  const targetPrice = startPrice * targetMultiplier / 100n;

  console.log(`  Start price: ${formatEther(startPrice)}`);
  console.log(`  Target price: ${formatEther(targetPrice)} (${direction === "pump" ? "2x" : "0.5x"})`);

  // Move price in steps via POST /api/price/update
  for (let step = 1; step <= PRICE_STEPS; step++) {
    const stepPrice = startPrice + (targetPrice - startPrice) * BigInt(step) / BigInt(PRICE_STEPS);

    const ok = await setMarkPrice(token, stepPrice);
    console.log(`  Step ${step}/${PRICE_STEPS}: mark→${formatEther(stepPrice)} [${ok ? "✓" : "FAILED"}]`);

    // Give the engine time to process liquidation callbacks
    await new Promise(r => setTimeout(r, 2000));
  }

  result.endPrice = targetPrice;
  console.log(`  Price after ${direction}: ${formatEther(result.endPrice)}`);

  // ── PRICE HOLD: syncSpotPrices() overrides our price every ~1s.
  // Keep re-setting it every 500ms while we check and close positions.
  let holdActive = true;
  const priceHold = setInterval(async () => {
    if (holdActive) await setMarkPrice(token, targetPrice);
  }, 500);
  console.log(`  [Price hold active — fighting syncSpotPrices at ${formatEther(targetPrice)}]`);

  // Wait a bit for liquidations to process
  await new Promise(r => setTimeout(r, 3000));

  // ── Check liquidations on the losing side ──
  const losingSide = direction === "pump" ? shortWallets : longWallets;
  const winningSide = direction === "pump" ? longWallets : shortWallets;
  const losingSideLabel = direction === "pump" ? "SHORT" : "LONG";
  const winningSideLabel = direction === "pump" ? "LONG" : "SHORT";

  console.log(`\n  Checking ${losingSideLabel} positions for liquidation...`);
  for (const w of losingSide) {
    if (!losingSideTracking.has(w.address)) {
      continue; // Never opened a position, skip
    }

    const positions = await getPositions(w);
    const tokenPositions = positions.filter(p =>
      p.token.toLowerCase() === token.toLowerCase() && BigInt(p.size || "0") > 0n
    );

    if (tokenPositions.length === 0) {
      // Had a position, now it's gone → liquidated by engine
      result.liquidationsDetected++;
      console.log(`  🔴 W${w.index}: ${losingSideLabel} position LIQUIDATED (gone from engine)`);
    } else {
      for (const pos of tokenPositions) {
        if (pos.isLiquidatable) {
          result.liquidationsDetected++;
          console.log(`  🔴 W${w.index} ${pos.isLong ? "LONG" : "SHORT"}: LIQUIDATABLE | marginRatio=${pos.marginRatio} risk=${pos.riskLevel}`);
        } else if (pos.riskLevel === "danger" || pos.riskLevel === "warning") {
          console.log(`  🟡 W${w.index} ${pos.isLong ? "LONG" : "SHORT"}: at risk (${pos.riskLevel}) marginRatio=${pos.marginRatio}`);
        } else {
          const pnl = BigInt(pos.unrealizedPnL || pos.unrealizedPnl || "0");
          console.log(`  ⚪ W${w.index} ${pos.isLong ? "LONG" : "SHORT"}: alive | PnL=${formatEther(pnl)}`);
        }
      }
    }
  }

  // ── Close profitable positions on winning side ──
  // Re-force the price before checking (syncSpotPrices may have sneaked in)
  await setMarkPrice(token, targetPrice);
  await new Promise(r => setTimeout(r, 500));

  console.log(`\n  Checking ${winningSideLabel} positions for profit...`);
  for (const w of winningSide) {
    if (!winningSideTracking.has(w.address)) continue;

    // Re-force price before each check to ensure PnL reflects moved price
    await setMarkPrice(token, targetPrice);

    const positions = await getPositions(w);
    if (positions.length === 0) {
      console.log(`  W${w.index}: no positions found (may have been liquidated earlier)`);
      continue;
    }
    for (const pos of positions) {
      if (BigInt(pos.size || "0") === 0n) continue;
      if (pos.token.toLowerCase() !== token.toLowerCase()) continue;

      const pnl = BigInt(pos.unrealizedPnL || pos.unrealizedPnl || "0");
      console.log(`  W${w.index} ${pos.isLong ? "LONG" : "SHORT"}: PnL=${formatEther(pnl)} | size=${formatEther(BigInt(pos.size))}`);

      // Close profitable OR any position (to verify the close mechanism works)
      if (pos.pairId && pnl > 0n) {
        // Record balance before close
        const balanceBefore = await getAvailableBalance(w);

        // Close position
        result.profitClosesAttempted++;
        const closed = await closePosition(w, pos.pairId);

        if (closed) {
          result.profitClosesSucceeded++;
          await new Promise(r => setTimeout(r, 2000)); // Wait for settlement

          // Verify balance increased
          const balanceAfter = await getAvailableBalance(w);
          const delta = balanceAfter - balanceBefore;
          if (delta > 0n) {
            result.balanceIncreasedCount++;
            console.log(`  ✅ W${w.index} profit close: ${formatEther(balanceBefore)} → ${formatEther(balanceAfter)} (+${formatEther(delta)})`);
          } else {
            console.log(`  ⚠️ W${w.index} closed but balance didn't increase: ${formatEther(balanceBefore)} → ${formatEther(balanceAfter)}`);
          }
        } else {
          console.log(`  ❌ W${w.index} close failed`);
        }
      }
    }
  }

  // Stop price hold — let syncSpotPrices restore natural price
  holdActive = false;
  clearInterval(priceHold);
  console.log(`  [Price hold released]`);

  return result;
}

function printPhaseResult(result: TestResult) {
  console.log(`\n  --- ${result.priceDirection.toUpperCase()} Phase Results ---`);
  console.log(`  Liquidations detected: ${result.liquidationsDetected}`);
  console.log(`  Profit closes: ${result.profitClosesSucceeded}/${result.profitClosesAttempted}`);
  console.log(`  Balance increases: ${result.balanceIncreasedCount}`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.join(", ")}`);
  }
}

// ── Run ─────────────────────────────────────────────────────
main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
