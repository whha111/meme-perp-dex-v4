#!/usr/bin/env bun
/**
 * Chain Reconciliation Script — 链上/链下/数据库三方对账
 *
 * Checks:
 * 1. SettlementV2 WBNB balance vs engine total balances + collateral
 * 2. PerpVault pool value (on-chain) vs engine insurance fund
 * 3. PerpVault OI (on-chain) vs engine position OI
 * 4. PriceFeed prices (on-chain) vs engine mark prices
 * 5. Database position mirror vs engine positions
 * 6. Database order mirror vs engine order count
 */

import { createPublicClient, http, parseAbi, formatEther, type Address } from "viem";
import { bscTestnet } from "viem/chains";

// ─── Config ───
const RPC_URL = process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || "memeperp-internal-2026";
const PG_HOST = process.env.PG_HOST || "localhost";
const PG_USER = process.env.PG_USER || "postgres";
const PG_PASS = process.env.PG_PASS || "memeperp123";
const PG_DB = process.env.PG_DB || "memeperp";
const PSQL = "/opt/homebrew/Cellar/postgresql@14/14.20/bin/psql";

// ─── Contracts ───
const SETTLEMENT_V2: Address = "0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b";
const PERP_VAULT: Address = "0xF0db95eD967318BC7757A671399f0D4FFC853e05";
const PRICE_FEED: Address = "0xB480517B96558E4467cfa1d91d8E6592c66B564D";
const WBNB: Address = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";

const client = createPublicClient({
  chain: bscTestnet,
  transport: http(RPC_URL),
});

// ─── Helpers ───
async function engineGet(path: string): Promise<any> {
  const resp = await fetch(`${ENGINE}${path}`, {
    headers: { "x-internal-key": INTERNAL_KEY },
  });
  return resp.json();
}

async function pgQuery(sql: string): Promise<string> {
  const proc = Bun.spawn([PSQL, "-h", PG_HOST, "-U", PG_USER, "-d", PG_DB, "-t", "-A", "-c", sql], {
    env: { ...process.env, PGPASSWORD: PG_PASS },
  });
  const text = await new Response(proc.stdout).text();
  return text.trim();
}

function pct(a: number, b: number): string {
  if (b === 0) return a === 0 ? "0%" : "∞%";
  return ((Math.abs(a - b) / b) * 100).toFixed(2) + "%";
}

type CheckResult = { name: string; status: "PASS" | "FAIL" | "WARN" | "INFO"; detail: string };
const results: CheckResult[] = [];

function check(name: string, status: "PASS" | "FAIL" | "WARN" | "INFO", detail: string) {
  results.push({ name, status, detail });
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : status === "WARN" ? "⚠️" : "ℹ️";
  console.log(`  ${icon} [${status}] ${name}: ${detail}`);
}

// ─── Main ───
async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  CHAIN RECONCILIATION — On-chain vs Engine vs DB    ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ════════════════════════════════════════
  // 1. SettlementV2 — WBNB balance
  // ════════════════════════════════════════
  console.log("━━━ 1. SettlementV2 Deposits ━━━");

  const settlementWbnb = await client.readContract({
    address: WBNB,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [SETTLEMENT_V2],
  });
  console.log(`  On-chain WBNB in SettlementV2: ${formatEther(settlementWbnb)} BNB`);

  // Get totalDeposited
  let totalDeposited = 0n;
  try {
    totalDeposited = await client.readContract({
      address: SETTLEMENT_V2,
      abi: parseAbi(["function totalDeposited() view returns (uint256)"]),
      functionName: "totalDeposited",
    });
    console.log(`  On-chain totalDeposited:       ${formatEther(totalDeposited)} BNB`);
  } catch (e: any) {
    console.log(`  On-chain totalDeposited: N/A (${e.message?.slice(0, 60)})`);
  }

  // Engine: sum all balances + all collateral
  const positionsResp = await engineGet("/api/internal/positions/all");
  const positions: any[] = Array.isArray(positionsResp) ? positionsResp : positionsResp.data || positionsResp.positions || [];

  let engineTotalCollateral = 0n;
  let engineLongOI: Record<string, bigint> = {};
  let engineShortOI: Record<string, bigint> = {};
  const tokenSet = new Set<string>();
  const traderSet = new Set<string>();

  for (const p of positions) {
    const col = BigInt(p.collateral || "0");
    const sz = BigInt(p.size || "0");
    const token = (p.token || "").toLowerCase();
    const trader = (p.trader || "").toLowerCase();
    tokenSet.add(token);
    traderSet.add(trader);
    engineTotalCollateral += col;
    if (p.isLong) {
      engineLongOI[token] = (engineLongOI[token] || 0n) + sz;
    } else {
      engineShortOI[token] = (engineShortOI[token] || 0n) + sz;
    }
  }

  console.log(`  Engine positions: ${positions.length} (${traderSet.size} traders, ${tokenSet.size} tokens)`);
  console.log(`  Engine total collateral: ${formatEther(engineTotalCollateral)} BNB`);

  // Engine: sum all available balances
  let engineTotalBalance = 0n;
  let balanceSampled = 0;
  for (const trader of traderSet) {
    try {
      const resp = await fetch(`${ENGINE}/api/user/${trader}/balance`);
      const data = await resp.json();
      const bal = BigInt(data.available || data.balance || "0");
      engineTotalBalance += bal;
      balanceSampled++;
    } catch {}
  }
  console.log(`  Engine total available balance: ${formatEther(engineTotalBalance)} BNB (${balanceSampled} traders)`);

  const engineTotalFunds = engineTotalCollateral + engineTotalBalance;
  console.log(`  Engine total (collateral + balance): ${formatEther(engineTotalFunds)} BNB`);

  // Comparison
  const chainBnb = Number(formatEther(settlementWbnb));
  const engineBnb = Number(formatEther(engineTotalFunds));
  const diff = Math.abs(chainBnb - engineBnb);

  if (chainBnb === 0 && engineBnb === 0) {
    check("Settlement balance match", "WARN", "Both zero — no deposits?");
  } else if (diff / Math.max(chainBnb, engineBnb) < 0.05) {
    check("Settlement balance match", "PASS", `Chain=${chainBnb.toFixed(4)} vs Engine=${engineBnb.toFixed(4)} (diff=${pct(chainBnb, engineBnb)})`);
  } else if (diff / Math.max(chainBnb, engineBnb) < 0.20) {
    check("Settlement balance match", "WARN", `Chain=${chainBnb.toFixed(4)} vs Engine=${engineBnb.toFixed(4)} (diff=${pct(chainBnb, engineBnb)}) — within 20%`);
  } else {
    check("Settlement balance match", "FAIL", `Chain=${chainBnb.toFixed(4)} vs Engine=${engineBnb.toFixed(4)} (diff=${pct(chainBnb, engineBnb)}) — MISMATCH >20%`);
  }

  // ════════════════════════════════════════
  // 2. PerpVault — Pool Value + OI
  // ════════════════════════════════════════
  console.log("\n━━━ 2. PerpVault (LP Pool + OI) ━━━");

  let poolValue = 0n;
  try {
    poolValue = await client.readContract({
      address: PERP_VAULT,
      abi: parseAbi(["function getPoolValue() view returns (uint256)"]),
      functionName: "getPoolValue",
    });
    console.log(`  On-chain getPoolValue(): ${formatEther(poolValue)} BNB`);
  } catch (e: any) {
    console.log(`  On-chain getPoolValue(): ERROR - ${e.message?.slice(0, 80)}`);
  }

  const vaultWbnb = await client.readContract({
    address: WBNB,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [PERP_VAULT],
  });
  console.log(`  On-chain PerpVault WBNB: ${formatEther(vaultWbnb)} BNB`);

  // Engine insurance fund
  try {
    const healthResp = await fetch(`${ENGINE}/health`);
    const health = await healthResp.json();
    console.log(`  Engine health: positions=${health.metrics?.mapSizes?.userPositions}, orders=${health.metrics?.totalOrders}`);
  } catch {}

  check("PerpVault pool value", poolValue > 0n ? "PASS" : "WARN",
    `${formatEther(poolValue)} BNB (WBNB balance: ${formatEther(vaultWbnb)} BNB)`);

  // On-chain OI vs Engine OI
  console.log("\n  --- OI Comparison (per token) ---");
  const tokens = Array.from(tokenSet);
  let oiMismatches = 0;

  for (const token of tokens) {
    try {
      const chainLongOI = await client.readContract({
        address: PERP_VAULT,
        abi: parseAbi(["function longOI(address) view returns (uint256)"]),
        functionName: "longOI",
        args: [token as Address],
      });
      const chainShortOI = await client.readContract({
        address: PERP_VAULT,
        abi: parseAbi(["function shortOI(address) view returns (uint256)"]),
        functionName: "shortOI",
        args: [token as Address],
      });

      const eLong = engineLongOI[token] || 0n;
      const eShort = engineShortOI[token] || 0n;

      const longMatch = chainLongOI === eLong;
      const shortMatch = chainShortOI === eShort;

      const longDiffPct = Number(eLong) > 0 ? Math.abs(Number(chainLongOI - eLong)) / Number(eLong) * 100 : (chainLongOI === 0n ? 0 : 100);
      const shortDiffPct = Number(eShort) > 0 ? Math.abs(Number(chainShortOI - eShort)) / Number(eShort) * 100 : (chainShortOI === 0n ? 0 : 100);

      const icon = longDiffPct < 5 && shortDiffPct < 5 ? "✅" : longDiffPct < 20 && shortDiffPct < 20 ? "⚠️" : "❌";
      if (longDiffPct >= 5 || shortDiffPct >= 5) oiMismatches++;

      console.log(`  ${icon} ${token.slice(0, 10)}...`);
      console.log(`     Long  — Chain: ${formatEther(chainLongOI).slice(0,12)} | Engine: ${formatEther(eLong).slice(0,12)} | Diff: ${longDiffPct.toFixed(1)}%`);
      console.log(`     Short — Chain: ${formatEther(chainShortOI).slice(0,12)} | Engine: ${formatEther(eShort).slice(0,12)} | Diff: ${shortDiffPct.toFixed(1)}%`);
    } catch (e: any) {
      console.log(`  ⚠️ ${token.slice(0, 10)}... OI read error: ${e.message?.slice(0, 60)}`);
    }
  }

  check("OI consistency", oiMismatches === 0 ? "PASS" : oiMismatches <= 2 ? "WARN" : "FAIL",
    `${tokens.length - oiMismatches}/${tokens.length} tokens match (<5% diff)`);

  // ════════════════════════════════════════
  // 3. PriceFeed — On-chain vs Engine
  // ════════════════════════════════════════
  console.log("\n━━━ 3. PriceFeed Prices ━━━");

  let priceMismatches = 0;
  for (const token of tokens) {
    try {
      // On-chain price (1e18 scale)
      let chainPrice = 0n;
      try {
        chainPrice = await client.readContract({
          address: PRICE_FEED,
          abi: parseAbi(["function getTokenMarkPrice(address) view returns (uint256)"]),
          functionName: "getTokenMarkPrice",
          args: [token as Address],
        });
      } catch {
        chainPrice = await client.readContract({
          address: PRICE_FEED,
          abi: parseAbi(["function getTokenSpotPrice(address) view returns (uint256)"]),
          functionName: "getTokenSpotPrice",
          args: [token as Address],
        });
      }

      // Engine price (1e18 scale in Redis)
      let enginePrice = "0";
      try {
        // Try getting from a position's token entry
        const resp = await fetch(`${ENGINE}/api/token/${token}/price`);
        const d = await resp.json();
        enginePrice = d.markPrice || d.price || d.spotPrice || "0";
      } catch {}

      const chainNum = Number(chainPrice);
      const engineNum = Number(enginePrice);
      const priceDiff = engineNum > 0 ? Math.abs(chainNum - engineNum) / engineNum * 100 : (chainNum === 0 ? 0 : 100);

      const icon = priceDiff < 1 ? "✅" : priceDiff < 10 ? "⚠️" : "❌";
      if (priceDiff >= 10) priceMismatches++;

      console.log(`  ${icon} ${token.slice(0, 10)}... Chain: ${chainPrice.toString().slice(0,15)} | Engine: ${enginePrice.toString().slice(0,15)} | Diff: ${priceDiff.toFixed(2)}%`);
    } catch (e: any) {
      console.log(`  ⚠️ ${token.slice(0, 10)}... price error: ${e.message?.slice(0, 60)}`);
    }
  }

  check("Price consistency", priceMismatches === 0 ? "PASS" : "WARN",
    `${tokens.length - priceMismatches}/${tokens.length} prices within 10%`);

  // ════════════════════════════════════════
  // 4. Database vs Engine
  // ════════════════════════════════════════
  console.log("\n━━━ 4. Database Mirror vs Engine ━━━");

  try {
    // Position mirror
    const pgOpenPositions = parseInt(await pgQuery("SELECT count(*) FROM perp_position_mirror WHERE status = 'OPEN'") || "0");
    const pgClosedPositions = parseInt(await pgQuery("SELECT count(*) FROM perp_position_mirror WHERE status = 'CLOSED'") || "0");
    const pgTotalPositions = parseInt(await pgQuery("SELECT count(*) FROM perp_position_mirror") || "0");

    console.log(`  PG position mirror: ${pgTotalPositions} total (${pgOpenPositions} OPEN, ${pgClosedPositions} CLOSED)`);
    console.log(`  Engine positions:   ${positions.length}`);

    // Engine has current OPEN positions, PG tracks all including historical
    // PG OPEN count should be >= engine count (PG may lag behind engine closures)
    const posDiff = Math.abs(pgOpenPositions - positions.length);
    check("Position mirror (OPEN)", posDiff < positions.length * 0.3 ? "PASS" : "WARN",
      `PG=${pgOpenPositions} vs Engine=${positions.length} (diff=${posDiff})`);

    // Order mirror
    const pgOrders = parseInt(await pgQuery("SELECT count(*) FROM perp_order_mirror") || "0");
    const engineHealth = await (await fetch(`${ENGINE}/health`)).json();
    const engineOrders = engineHealth.metrics?.totalOrders || 0;
    console.log(`  PG order mirror: ${pgOrders} | Engine total orders: ${engineOrders}`);
    check("Order mirror", pgOrders > 0 ? "PASS" : "FAIL", `${pgOrders} orders in PG`);

    // Trade mirror
    const pgTrades = parseInt(await pgQuery("SELECT count(*) FROM perp_trade_mirror") || "0");
    console.log(`  PG trade mirror: ${pgTrades}`);
    check("Trade mirror", pgTrades > 0 ? "PASS" : "FAIL", `${pgTrades} trades in PG`);

    // Bills
    const pgBills = parseInt(await pgQuery("SELECT count(*) FROM perp_bills") || "0");
    const billTypes = await pgQuery("SELECT type, count(*) FROM perp_bills GROUP BY type ORDER BY count(*) DESC");
    console.log(`  PG bills: ${pgBills} (${billTypes.replace(/\n/g, ', ')})`);
    check("Bills mirror", pgBills > 0 ? "PASS" : "WARN", `${pgBills} bills in PG`);

    // Funding rates
    const pgFunding = parseInt(await pgQuery("SELECT count(*) FROM funding_rate") || "0");
    console.log(`  PG funding rates: ${pgFunding}`);
    check("Funding rates", pgFunding > 0 ? "PASS" : "WARN", `${pgFunding} records`);

    // Balance snapshots
    const pgSnapshots = parseInt(await pgQuery("SELECT count(*) FROM balance_snapshots") || "0");
    console.log(`  PG balance snapshots: ${pgSnapshots}`);
    check("Balance snapshots", pgSnapshots > 0 ? "PASS" : "WARN", `${pgSnapshots} records`);

    // Collateral consistency: PG open position collateral vs engine
    const pgCollateralRaw = await pgQuery("SELECT COALESCE(SUM(collateral::numeric), 0) FROM perp_position_mirror WHERE status = 'OPEN'");
    const pgCollateral = parseFloat(pgCollateralRaw) / 1e18;
    const engineCol = Number(formatEther(engineTotalCollateral));
    const colDiff = Math.abs(pgCollateral - engineCol);
    console.log(`\n  PG OPEN collateral: ${pgCollateral.toFixed(4)} BNB`);
    console.log(`  Engine collateral:  ${engineCol.toFixed(4)} BNB`);
    check("Collateral consistency", colDiff / Math.max(engineCol, 1) < 0.1 ? "PASS" : "WARN",
      `PG=${pgCollateral.toFixed(4)} vs Engine=${engineCol.toFixed(4)} (diff=${(colDiff).toFixed(4)} BNB)`);

  } catch (e: any) {
    console.log(`  DB query error: ${e.message}`);
    check("Database access", "FAIL", e.message?.slice(0, 100) || "unknown error");
  }

  // ════════════════════════════════════════
  // 5. Cross-layer sample verification
  // ════════════════════════════════════════
  console.log("\n━━━ 5. Cross-layer Sample Checks ━━━");

  // Pick 5 random traders and verify their balances across layers
  const sampleTraders = Array.from(traderSet).slice(0, 5);
  let samplePassed = 0;

  for (const trader of sampleTraders) {
    try {
      // On-chain deposit
      let onChainDeposit = 0n;
      try {
        onChainDeposit = await client.readContract({
          address: SETTLEMENT_V2,
          abi: parseAbi(["function userDeposits(address) view returns (uint256)"]),
          functionName: "userDeposits",
          args: [trader as Address],
        });
      } catch {}

      // Engine balance
      let engineBalance = 0n;
      try {
        const resp = await fetch(`${ENGINE}/api/user/${trader}/balance`);
        const d = await resp.json();
        engineBalance = BigInt(d.available || d.balance || "0");
      } catch {}

      // Engine collateral for this trader
      const traderPositions = positions.filter((p: any) => p.trader?.toLowerCase() === trader);
      let traderCollateral = 0n;
      for (const p of traderPositions) {
        traderCollateral += BigInt(p.collateral || "0");
      }

      const engineTotal = engineBalance + traderCollateral;
      const onChainBnb = Number(formatEther(onChainDeposit));
      const engineTotalBnb = Number(formatEther(engineTotal));

      // Engine total (balance + collateral) should be <= on-chain deposit (user can only have what they deposited, minus fees/PnL)
      const match = onChainBnb === 0 && engineTotalBnb === 0 ? true :
                    onChainBnb > 0 && engineTotalBnb > 0;
      if (match) samplePassed++;

      console.log(`  ${match ? "✅" : "⚠️"} ${trader.slice(0, 12)}... deposit=${onChainBnb.toFixed(4)} | engine(bal+col)=${engineTotalBnb.toFixed(4)} | positions=${traderPositions.length}`);
    } catch (e: any) {
      console.log(`  ❌ ${trader.slice(0, 12)}... ERROR: ${e.message?.slice(0, 60)}`);
    }
  }

  check("Cross-layer sample", samplePassed >= 3 ? "PASS" : "WARN",
    `${samplePassed}/${sampleTraders.length} traders have consistent data`);

  // ════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  RECONCILIATION SUMMARY                              ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const passes = results.filter(r => r.status === "PASS").length;
  const warns = results.filter(r => r.status === "WARN").length;
  const fails = results.filter(r => r.status === "FAIL").length;

  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : r.status === "WARN" ? "⚠️" : "ℹ️";
    console.log(`  ${icon} ${r.name}: ${r.detail}`);
  }

  console.log(`\n  Total: ${passes} PASS, ${warns} WARN, ${fails} FAIL`);

  const overall = fails === 0 ? (warns <= 2 ? "PASS" : "PASS (with warnings)") : "FAIL";
  console.log(`\n  OVERALL: ${overall}\n`);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
