#!/usr/bin/env bun
/**
 * Full E2E Production Pipeline
 *
 * Orchestrates 7 phases sequentially:
 * 0. Health check + prerequisites
 * 1. Spot trading (create price volatility)
 * 2. Referral system setup
 * 3. GMX 48h replay (4,339 trades with rate limiting + closes)
 * 4. Async wait (funding rates + price manipulation for liquidations)
 * 5. Database full verification
 * 6. Report generation
 *
 * Run: bun run e2e-test/tests/full-e2e-pipeline.ts
 *
 * NO SHORTCUTS: Real EIP-712 signatures, real on-chain deposits,
 * real spot trading, real price movement.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { runPhase0 } from "./phases/phase0-health";
import { runPhase1 } from "./phases/phase1-spot-trading";
import { runPhase2 } from "./phases/phase2-referral";
import { runPhase3 } from "./phases/phase3-replay";
import { runPhase4 } from "./phases/phase4-async-wait";
import { runPhase5 } from "./phases/phase5-db-verify";
import { generateReport, type FullReport } from "./phases/phase6-report";

async function main() {
  const totalStart = Date.now();
  const phaseDurations: Record<string, number> = {};

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   MEME PERP DEX — E2E PRODUCTION TEST       ║");
  console.log("║   No shortcuts. No fake deposits.            ║");
  console.log("║   Real signatures. Real prices. Real data.   ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // Load data
  const dataDir = resolve(__dirname, "../data");
  const wallets = JSON.parse(readFileSync(resolve(dataDir, "wallets.json"), "utf8"));
  const tokenData = JSON.parse(readFileSync(resolve(dataDir, "token-addresses.json"), "utf8"));

  console.log(`Wallets: ${wallets.length}`);
  console.log(`Tokens: ${Object.keys(tokenData).join(", ")}\n`);

  // ═══════════════════════════════════════════════
  // PHASE 0: Health Check
  // ═══════════════════════════════════════════════
  let t = Date.now();
  const phase0 = await runPhase0(wallets, tokenData);
  phaseDurations.phase0 = Date.now() - t;

  if (!phase0.engineHealthy) {
    console.error("\n[ABORT] Engine is not healthy. Cannot proceed.");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════
  // PHASE 1: Spot Trading (Price Volatility)
  // ═══════════════════════════════════════════════
  t = Date.now();
  const phase1 = await runPhase1(wallets, tokenData);
  phaseDurations.phase1 = Date.now() - t;

  // ═══════════════════════════════════════════════
  // PHASE 2: Referral System Setup
  // ═══════════════════════════════════════════════
  t = Date.now();
  const phase2 = await runPhase2(wallets);
  phaseDurations.phase2 = Date.now() - t;

  // ═══════════════════════════════════════════════
  // PHASE 3: GMX Replay
  // ═══════════════════════════════════════════════
  t = Date.now();
  const phase3 = await runPhase3(wallets, tokenData);
  phaseDurations.phase3 = Date.now() - t;

  // ═══════════════════════════════════════════════
  // PHASE 4: Async Wait + Price Manipulation
  // ═══════════════════════════════════════════════
  t = Date.now();
  const phase4 = await runPhase4(wallets, tokenData);
  phaseDurations.phase4 = Date.now() - t;

  // ═══════════════════════════════════════════════
  // PHASE 5: Database Verification
  // ═══════════════════════════════════════════════
  t = Date.now();
  const referrer1Address = wallets[5]?.address;
  const phase5 = await runPhase5(wallets, referrer1Address);
  phaseDurations.phase5 = Date.now() - t;

  // ═══════════════════════════════════════════════
  // PHASE 6: Report
  // ═══════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════");
  console.log("  PHASE 6: Report Generation");
  console.log("══════════════════════════════════════════════\n");

  const report: FullReport = {
    timestamp: new Date().toISOString(),
    overallResult: "FAIL", // Will be set by generateReport
    duration: { totalMs: Date.now() - totalStart, perPhase: {} },
    phase0,
    phase1,
    phase2,
    phase3,
    phase4,
    phase5,
    failedChecks: [],
  };

  generateReport(report, phaseDurations);

  // Final summary
  const totalDuration = Date.now() - totalStart;
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log(`║   OVERALL RESULT: ${report.overallResult.padEnd(28)}║`);
  console.log(`║   Duration: ${(totalDuration / 1000 / 60).toFixed(1)} minutes${" ".repeat(22)}║`);
  console.log(`║   P0 Health:  ${phase0.passed ? "PASS" : "FAIL"}${" ".repeat(27)}║`);
  console.log(`║   P1 Spot:    ${phase1.passed ? "PASS" : "FAIL"}${" ".repeat(27)}║`);
  console.log(`║   P2 Referral:${phase2.passed ? "PASS" : "FAIL"}${" ".repeat(27)}║`);
  console.log(`║   P3 Replay:  ${phase3.passed ? "PASS" : "FAIL"} (${phase3.accepted}/${phase3.submitted} accepted)${" ".repeat(Math.max(0, 14 - `${phase3.accepted}/${phase3.submitted}`.length))}║`);
  console.log(`║   P4 Async:   ${phase4.passed ? "PASS" : "FAIL"}${" ".repeat(27)}║`);
  console.log(`║   P5 DB:      ${phase5.passed ? "PASS" : "FAIL"} (${phase5.passedChecks}/${phase5.totalChecks} checks)${" ".repeat(Math.max(0, 16 - `${phase5.passedChecks}/${phase5.totalChecks}`.length))}║`);
  console.log("╚══════════════════════════════════════════════╝");

  if (report.failedChecks.length > 0) {
    console.log(`\nFailed checks (${report.failedChecks.length}):`);
    for (const c of report.failedChecks.slice(0, 20)) {
      console.log(`  - ${c}`);
    }
  }

  // Exit with appropriate code
  process.exit(report.overallResult === "FAIL" ? 1 : 0);
}

main().catch(err => {
  console.error("Pipeline crashed:", err);
  process.exit(2);
});
