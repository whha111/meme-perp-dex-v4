/**
 * Phase 6: Report Generation
 *
 * Produces JSON + Markdown report with full test results.
 */
import { writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { Phase0Result } from "./phase0-health";
import type { Phase1Result } from "./phase1-spot-trading";
import type { Phase2Result } from "./phase2-referral";
import type { Phase3Result } from "./phase3-replay";
import type { Phase4Result } from "./phase4-async-wait";
import type { Phase5Result } from "./phase5-db-verify";

export interface FullReport {
  timestamp: string;
  overallResult: "PASS" | "PARTIAL" | "FAIL";
  duration: { totalMs: number; perPhase: Record<string, number> };
  phase0: Phase0Result;
  phase1: Phase1Result;
  phase2: Phase2Result;
  phase3: Phase3Result;
  phase4: Phase4Result;
  phase5: Phase5Result;
  failedChecks: string[];
}

export function generateReport(
  report: FullReport,
  phaseDurations: Record<string, number>,
): void {
  const reportsDir = resolve(__dirname, "../../reports");
  mkdirSync(reportsDir, { recursive: true });

  report.duration.perPhase = phaseDurations;

  // Determine overall result
  const criticalPasses = [
    report.phase0.passed,
    report.phase1.passed,
    report.phase3.passed,
    report.phase5.passed,
  ];
  const passCount = criticalPasses.filter(Boolean).length;

  if (passCount === criticalPasses.length) {
    report.overallResult = "PASS";
  } else if (passCount >= criticalPasses.length * 0.6) {
    report.overallResult = "PARTIAL";
  } else {
    report.overallResult = "FAIL";
  }

  // Collect all failures
  report.failedChecks = [
    ...report.phase0.errors.map(e => `[P0] ${e}`),
    ...report.phase1.errors.map(e => `[P1] ${e}`),
    ...report.phase2.errors.map(e => `[P2] ${e}`),
    ...report.phase3.errors.map(e => `[P3] ${e}`),
    ...report.phase4.errors.map(e => `[P4] ${e}`),
    ...report.phase5.errors.map(e => `[P5] ${e}`),
    ...report.phase5.checks.filter(c => !c.pass).map(c => `[P5:DB] ${c.table}: expected ${c.expected}, got ${c.count}`),
  ];

  // Write JSON
  const jsonPath = resolve(reportsDir, "full-e2e-results.json");
  writeFileSync(jsonPath, JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
  console.log(`  JSON report: ${jsonPath}`);

  // Write Markdown
  const md = generateMarkdown(report, phaseDurations);
  const mdPath = resolve(reportsDir, "E2E_FULL_REPORT.md");
  writeFileSync(mdPath, md);
  console.log(`  Markdown report: ${mdPath}`);
}

function generateMarkdown(report: FullReport, durations: Record<string, number>): string {
  const { phase0, phase1, phase2, phase3, phase4, phase5 } = report;

  return `# E2E Production Test Report

**Date**: ${report.timestamp}
**Result**: **${report.overallResult}**
**Duration**: ${(report.duration.totalMs / 1000 / 60).toFixed(1)} minutes

---

## Executive Summary

| Phase | Status | Duration |
|-------|--------|----------|
| P0: Health Check | ${phase0.passed ? "PASS" : "FAIL"} | ${fmt(durations.phase0)} |
| P1: Spot Trading | ${phase1.passed ? "PASS" : "FAIL"} | ${fmt(durations.phase1)} |
| P2: Referral Setup | ${phase2.passed ? "PASS" : "FAIL"} | ${fmt(durations.phase2)} |
| P3: GMX Replay | ${phase3.passed ? "PASS" : "FAIL"} | ${fmt(durations.phase3)} |
| P4: Async Wait | ${phase4.passed ? "PASS" : "FAIL"} | ${fmt(durations.phase4)} |
| P5: DB Verification | ${phase5.passed ? "PASS" : "FAIL"} | ${fmt(durations.phase5)} |

---

## Phase 0: Health Check

- Engine: ${phase0.engineHealthy ? "OK" : "DOWN"}
- Go Backend: ${phase0.goBackendHealthy ? "OK" : "DOWN"}
- LP Pool: ${phase0.lpPoolBnb} BNB
- Wallets with balance: ${phase0.walletsWithBalance}/${phase0.walletsTotalChecked}

## Phase 1: Spot Trading (Price Volatility)

${phase1.priceChanges.map(p =>
  `- **${p.symbol}**: ${p.initialPrice} → ${p.afterBuyPrice} (buy ${p.buySuccess ? "OK" : "FAIL"}) → ${p.afterSellPrice} (sell ${p.sellSuccess ? "OK" : "FAIL"})`
).join("\n")}

Engine prices synced: ${phase1.enginePricesSynced ? "YES" : "NO"}

## Phase 2: Referral System

- Referrer 1 code: \`${phase2.referrer1Code || "NONE"}\`
- Referrer 2 code: \`${phase2.referrer2Code || "NONE"}\`
- Referees bound: ${phase2.refereesbound}/12

## Phase 3: GMX Replay

| Metric | Value |
|--------|-------|
| Total trades | ${phase3.total} |
| Submitted | ${phase3.submitted} |
| Accepted | ${phase3.accepted} |
| Rejected | ${phase3.rejected} |
| Failed | ${phase3.failed} |
| Skipped | ${phase3.skipped} |
| Close orders submitted | ${phase3.closeOrdersSubmitted} |
| Close orders accepted | ${phase3.closeOrdersAccepted} |
| Rate limit rejects | ${phase3.rateLimitRejects} |
| Acceptance rate | ${(phase3.acceptanceRate * 100).toFixed(1)}% |
| Spot interludes | ${phase3.spotInterludes} |
| Duration | ${(phase3.durationMs / 1000).toFixed(0)}s |

### Top Errors
${Object.entries(phase3.topErrors).sort(([, a], [, b]) => b - a).slice(0, 10).map(
  ([err, count]) => `- ${count}x: ${err}`
).join("\n") || "None"}

## Phase 4: Async Wait + Price Manipulation

- Price manipulations: ${phase4.priceManipulations.length}
${phase4.priceManipulations.map(p =>
  `  - ${p.symbol}: ${p.direction} (${p.priceBefore} → ${p.priceAfter})`
).join("\n")}
- Open positions at end: ${phase4.openPositionsAtEnd}

## Phase 5: Database Verification

### Matching Engine PG Tables

| Table | Count | Expected | Result |
|-------|-------|----------|--------|
${phase5.checks.map(c =>
  `| ${c.table} | ${c.count} | ${c.expected} | ${c.pass ? "PASS" : "**FAIL**"} |`
).join("\n")}

### Engine API

${phase5.engineApiChecks.map(c =>
  `- ${c.pass ? "PASS" : "FAIL"}: ${c.name} = ${c.details}`
).join("\n")}

### Referral

${phase5.referralChecks.map(c =>
  `- ${c.pass ? "PASS" : "FAIL"}: ${c.name} = ${c.details}`
).join("\n") || "No referral checks (referrer not set up)"}

---

## Failed Checks (${report.failedChecks.length})

${report.failedChecks.map(c => `- ${c}`).join("\n") || "None"}

---

*Generated by E2E Production Test Pipeline*
`;
}

function fmt(ms?: number): string {
  if (!ms) return "N/A";
  return ms > 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`;
}
