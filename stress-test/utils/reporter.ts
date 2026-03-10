/**
 * Report Generator — generates JSON + HTML report after test completion
 *
 * Includes chain verification stats, fund safety score, and V2 audit details.
 */
import { writeFileSync, mkdirSync } from "fs";
import { formatEther } from "viem";
import type { SpotStats } from "../engines/spot-engine.js";
import type { PerpStats } from "../engines/perp-engine.js";
import type { AuditStats } from "../monitors/fund-auditor.js";
import type { PnlStats } from "../monitors/pnl-tracker.js";
import type { InsuranceStats } from "../monitors/insurance-monitor.js";
import type { LiquidationStats } from "../monitors/liquidation-verifier.js";
import type { SchedulerStats } from "../scenarios/scenario-scheduler.js";

export interface FullReport {
  meta: {
    startTime: number;
    endTime: number;
    durationHours: number;
    totalWallets: number;
    spotWallets: number;
    perpWallets: number;
    mode?: string;
  };
  spot: SpotStats;
  perp: PerpStats;
  audit: AuditStats;
  pnl: PnlStats;
  insurance: InsuranceStats;
  liquidation: LiquidationStats;
  scenarios: SchedulerStats;
  rpc: { totalRequests: number; retries: number; failures: number };
  chainHealth?: {
    settlementWeth: string;
    perpVaultPool: string;
    perpVaultOI: string;
    pass: boolean;
    issues: string[];
  };
}

/** Calculate fund safety score (0-100%) */
function calculateSafetyScore(r: FullReport): { score: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};

  // Audit pass rate (40 points max)
  if (r.audit.totalAudits > 0) {
    breakdown.auditPassRate = Math.round((r.audit.passedAudits / r.audit.totalAudits) * 40);
  } else {
    breakdown.auditPassRate = 0;
  }

  // PerpVault health (20 points max)
  if (r.audit.perpVaultHealthChecks > 0) {
    breakdown.perpVaultHealth = Math.round((r.audit.perpVaultHealthPasses / r.audit.perpVaultHealthChecks) * 20);
  } else {
    breakdown.perpVaultHealth = 0;
  }

  // OI consistency (15 points max) — no mismatches = full score
  if (r.audit.oiConsistencyChecks > 0) {
    const oiPassRate = 1 - (r.audit.oiMismatches / r.audit.oiConsistencyChecks);
    breakdown.oiConsistency = Math.round(oiPassRate * 15);
  } else {
    breakdown.oiConsistency = 15; // No checks = assume OK
  }

  // Engine-chain drift (15 points max) — low drift = good
  const maxDriftWei = r.audit.engineStateDriftMax;
  const maxDriftEth = Number(maxDriftWei) / 1e18;
  if (maxDriftEth < 0.01) {
    breakdown.engineChainDrift = 15;
  } else if (maxDriftEth < 0.1) {
    breakdown.engineChainDrift = 10;
  } else if (maxDriftEth < 0.5) {
    breakdown.engineChainDrift = 5;
  } else {
    breakdown.engineChainDrift = 0;
  }

  // Final chain health (10 points max)
  if (r.chainHealth?.pass) {
    breakdown.chainHealth = 10;
  } else {
    breakdown.chainHealth = r.chainHealth ? 0 : 5; // 5 if no data
  }

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, breakdown };
}

export function generateReport(report: FullReport): void {
  const reportsDir = new URL("../reports", import.meta.url).pathname;
  mkdirSync(reportsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // Write JSON
  const jsonPath = `${reportsDir}/report-${timestamp}.json`;
  writeFileSync(jsonPath, JSON.stringify(report, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value, 2));

  // Write HTML
  const htmlPath = `${reportsDir}/report-${timestamp}.html`;
  writeFileSync(htmlPath, generateHtml(report));

  // Symlink latest
  const latestJson = `${reportsDir}/latest.json`;
  const latestHtml = `${reportsDir}/latest.html`;
  try { writeFileSync(latestJson, JSON.stringify(report, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value, 2)); } catch {}
  try { writeFileSync(latestHtml, generateHtml(report)); } catch {}

  console.log(`[Reporter] Reports saved:`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  HTML: ${htmlPath}`);
}

function generateHtml(r: FullReport): string {
  const duration = ((r.meta.endTime - r.meta.startTime) / 3600000).toFixed(1);
  const totalTrades = r.spot.buys + r.spot.sells + r.spot.creates + r.perp.ordersSubmitted;
  const auditPassRate = r.audit.totalAudits > 0
    ? ((r.audit.passedAudits / r.audit.totalAudits) * 100).toFixed(1)
    : "N/A";

  const safety = calculateSafetyScore(r);
  const safetyColor = safety.score >= 95 ? "#3fb950" : safety.score >= 80 ? "#d29922" : "#f85149";
  const safetyVerdict = safety.score >= 95
    ? "READY FOR LAUNCH"
    : safety.score >= 80
    ? "NEEDS REVIEW"
    : "NOT READY — DO NOT LAUNCH";

  // Spot success rate
  const spotTotal = r.spot.buys + r.spot.sells + r.spot.creates;
  const spotSuccessRate = spotTotal > 0
    ? (((spotTotal - r.spot.failures) / spotTotal) * 100).toFixed(1)
    : "N/A";

  // Perp success rate
  const perpTotal = r.perp.ordersSubmitted;
  const perpSuccessRate = perpTotal > 0
    ? (((perpTotal - r.perp.failures) / perpTotal) * 100).toFixed(1)
    : "N/A";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Stress Test Report</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 1000px; margin: 2em auto; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; } h2 { color: #79c0ff; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  th, td { padding: 8px 12px; text-align: left; border: 1px solid #30363d; }
  th { background: #161b22; color: #58a6ff; }
  .pass { color: #3fb950; } .fail { color: #f85149; } .warn { color: #d29922; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1em; margin: 1em 0; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1em; }
  .stat-value { font-size: 1.8em; font-weight: bold; color: #58a6ff; }
  .stat-label { color: #8b949e; font-size: 0.85em; }
  .safety-box { background: #161b22; border: 2px solid ${safetyColor}; border-radius: 12px; padding: 1.5em; text-align: center; margin: 1.5em 0; }
  .safety-score { font-size: 3em; font-weight: bold; color: ${safetyColor}; }
  .safety-verdict { font-size: 1.2em; color: ${safetyColor}; margin-top: 0.5em; }
  .breakdown { display: flex; gap: 1em; justify-content: center; margin-top: 1em; flex-wrap: wrap; }
  .breakdown-item { padding: 0.5em 1em; background: #0d1117; border-radius: 6px; font-size: 0.85em; }
</style></head><body>
<h1>Meme-Perp-DEX Soak Test Report</h1>
<p>Mode: <b>${(r.meta.mode || "soak").toUpperCase()}</b> | Duration: <b>${duration} hours</b> | Wallets: <b>${r.meta.totalWallets}</b> (${r.meta.spotWallets} spot + ${r.meta.perpWallets} perp)</p>
<p>Period: ${new Date(r.meta.startTime).toLocaleString()} — ${new Date(r.meta.endTime).toLocaleString()}</p>

<div class="safety-box">
  <div style="color:#8b949e;font-size:0.9em;">FUND SAFETY SCORE</div>
  <div class="safety-score">${safety.score}%</div>
  <div class="safety-verdict">${safetyVerdict}</div>
  <div class="breakdown">
    ${Object.entries(safety.breakdown).map(([k, v]) =>
      `<div class="breakdown-item">${k}: ${v}pts</div>`
    ).join("")}
  </div>
</div>

<div class="stat-grid">
  <div class="stat-card"><div class="stat-value">${totalTrades.toLocaleString()}</div><div class="stat-label">Total Trades</div></div>
  <div class="stat-card"><div class="stat-value ${auditPassRate === "100.0" ? "pass" : "fail"}">${auditPassRate}%</div><div class="stat-label">Fund Audit Pass Rate</div></div>
  <div class="stat-card"><div class="stat-value">${r.liquidation.liquidationsSucceeded}</div><div class="stat-label">Liquidations Executed</div></div>
  <div class="stat-card"><div class="stat-value">${r.spot.graduations}</div><div class="stat-label">Token Graduations</div></div>
</div>

<h2>Chain Verification</h2>
<table>
  <tr><th>Check</th><th>Value</th><th>Status</th></tr>
  <tr>
    <td>SettlementV2 WETH Balance</td>
    <td>${r.chainHealth ? formatEther(BigInt(r.chainHealth.settlementWeth)) + " WETH" : "N/A"}</td>
    <td class="${r.chainHealth?.pass ? "pass" : "fail"}">${r.chainHealth?.pass ? "✅" : "⚠️"}</td>
  </tr>
  <tr>
    <td>PerpVault Pool Value</td>
    <td>${r.chainHealth ? formatEther(BigInt(r.chainHealth.perpVaultPool)) + " ETH" : "N/A"}</td>
    <td class="${BigInt(r.chainHealth?.perpVaultPool || "0") > 0n ? "pass" : "fail"}">${BigInt(r.chainHealth?.perpVaultPool || "0") > 0n ? "✅" : "❌"}</td>
  </tr>
  <tr>
    <td>PerpVault Total OI</td>
    <td>${r.chainHealth ? formatEther(BigInt(r.chainHealth.perpVaultOI)) + " ETH" : "N/A"}</td>
    <td>ℹ️</td>
  </tr>
  <tr>
    <td>PerpVault Health Checks</td>
    <td>${r.audit.perpVaultHealthPasses}/${r.audit.perpVaultHealthChecks} passed</td>
    <td class="${r.audit.perpVaultHealthChecks > 0 && r.audit.perpVaultHealthPasses === r.audit.perpVaultHealthChecks ? "pass" : "warn"}">${r.audit.perpVaultHealthPasses === r.audit.perpVaultHealthChecks ? "✅" : "⚠️"}</td>
  </tr>
  <tr>
    <td>PerpVault Pool Min/Max</td>
    <td>${formatEther(r.audit.perpVaultPoolValueMin)} — ${formatEther(r.audit.perpVaultPoolValueMax)} ETH</td>
    <td>ℹ️</td>
  </tr>
  <tr>
    <td>Engine-Chain Drift (max)</td>
    <td>${formatEther(r.audit.engineStateDriftMax)} ETH</td>
    <td class="${Number(r.audit.engineStateDriftMax) / 1e18 < 0.5 ? "pass" : "fail"}">${Number(r.audit.engineStateDriftMax) / 1e18 < 0.5 ? "✅" : "❌"}</td>
  </tr>
  <tr>
    <td>OI Consistency</td>
    <td>${r.audit.oiMismatches} mismatches in ${r.audit.oiConsistencyChecks} checks</td>
    <td class="${r.audit.oiMismatches === 0 ? "pass" : "fail"}">${r.audit.oiMismatches === 0 ? "✅" : "❌"}</td>
  </tr>
  ${r.chainHealth?.issues.length ? r.chainHealth.issues.map(i =>
    `<tr><td colspan="2" class="fail">${i}</td><td class="fail">❌</td></tr>`
  ).join("\n  ") : ""}
</table>

<h2>Spot Trading</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Rounds</td><td>${r.spot.totalRounds}</td></tr>
  <tr><td>Buys</td><td>${r.spot.buys}</td></tr>
  <tr><td>Sells</td><td>${r.spot.sells}</td></tr>
  <tr><td>Token Creates</td><td>${r.spot.creates}</td></tr>
  <tr><td>Graduations</td><td>${r.spot.graduations}</td></tr>
  <tr><td>PriceFeed Syncs</td><td>${r.spot.priceFeedSyncs}</td></tr>
  <tr><td>Price Verifications</td><td>${r.spot.priceVerifications} (${r.spot.priceVerificationFailures} issues)</td></tr>
  <tr><td>Success Rate</td><td class="${parseFloat(spotSuccessRate) >= 90 ? "pass" : "warn"}">${spotSuccessRate}%</td></tr>
  <tr><td>Failures</td><td class="${r.spot.failures > 0 ? "warn" : ""}">${r.spot.failures}</td></tr>
</table>

<h2>Perpetual Trading</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Rounds</td><td>${r.perp.totalRounds}</td></tr>
  <tr><td>Orders Submitted</td><td>${r.perp.ordersSubmitted}</td></tr>
  <tr><td>Orders Matched</td><td>${r.perp.ordersMatched}</td></tr>
  <tr><td>Deposits Made</td><td>${r.perp.deposits}</td></tr>
  ${'withdrawals' in r.perp ? `<tr><td>Withdrawal Tests</td><td>${(r.perp as any).withdrawals} (${(r.perp as any).withdrawalFailures} failures)</td></tr>` : ""}
  ${'lifecycleChecks' in r.perp ? `<tr><td>Lifecycle Verifications</td><td>${(r.perp as any).lifecycleChecks} (${(r.perp as any).lifecycleFailures} failures)</td></tr>` : ""}
  <tr><td>Success Rate</td><td class="${parseFloat(perpSuccessRate) >= 85 ? "pass" : "warn"}">${perpSuccessRate}%</td></tr>
  <tr><td>Failures</td><td class="${r.perp.failures > 0 ? "warn" : ""}">${r.perp.failures}</td></tr>
</table>

<h2>Fund Conservation Audit</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Total Audits</td><td>${r.audit.totalAudits}</td></tr>
  <tr><td>Passed</td><td class="pass">${r.audit.passedAudits}</td></tr>
  <tr><td>Failed</td><td class="${r.audit.failedAudits > 0 ? "fail" : ""}">${r.audit.failedAudits}</td></tr>
  <tr><td>Max Deviation</td><td>${formatEther(r.audit.maxDeviation)} ETH</td></tr>
</table>

<h2>Liquidation & Profit Withdrawal</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Scans</td><td>${r.liquidation.totalScans}</td></tr>
  <tr><td>Liquidations Triggered</td><td>${r.liquidation.liquidationsTriggered}</td></tr>
  <tr><td>Liquidations Succeeded</td><td>${r.liquidation.liquidationsSucceeded}</td></tr>
  <tr><td>Profit Withdrawals</td><td>${r.liquidation.profitWithdrawals}</td></tr>
</table>

<h2>Extreme Market Scenarios</h2>
<table>
  <tr><th>Scenario</th><th>Executions</th></tr>
  ${Object.entries(r.scenarios.scenarioCounts).map(([k, v]) =>
    `<tr><td>${k}</td><td>${v}</td></tr>`
  ).join("\n  ")}
  <tr><th>Total</th><th>${r.scenarios.executedScenarios.length}</th></tr>
</table>

<h2>RPC Usage</h2>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Total Requests</td><td>${r.rpc.totalRequests.toLocaleString()}</td></tr>
  <tr><td>Retries</td><td>${r.rpc.retries}</td></tr>
  <tr><td>Failures</td><td>${r.rpc.failures}</td></tr>
  <tr><td>Failure Rate</td><td class="${r.rpc.totalRequests > 0 && (r.rpc.failures / r.rpc.totalRequests) < 0.05 ? "pass" : "warn"}">${r.rpc.totalRequests > 0 ? ((r.rpc.failures / r.rpc.totalRequests) * 100).toFixed(2) : "0"}%</td></tr>
</table>

<h2>Launch Readiness Checklist</h2>
<table>
  <tr><th>Criterion</th><th>Threshold</th><th>Actual</th><th>Status</th></tr>
  <tr>
    <td>Fund Audit Pass Rate</td><td>≥ 95%</td>
    <td>${auditPassRate}%</td>
    <td class="${parseFloat(auditPassRate) >= 95 ? "pass" : "fail"}">${parseFloat(auditPassRate) >= 95 ? "✅" : "❌"}</td>
  </tr>
  <tr>
    <td>PerpVault Pool Value</td><td>> 0.5 ETH (continuous)</td>
    <td>min ${formatEther(r.audit.perpVaultPoolValueMin)} ETH</td>
    <td class="${r.audit.perpVaultPoolValueMin > 500000000000000000n ? "pass" : "fail"}">${r.audit.perpVaultPoolValueMin > 500000000000000000n ? "✅" : "❌"}</td>
  </tr>
  <tr>
    <td>OI Consistency</td><td>0 mismatches</td>
    <td>${r.audit.oiMismatches} mismatches</td>
    <td class="${r.audit.oiMismatches === 0 ? "pass" : "fail"}">${r.audit.oiMismatches === 0 ? "✅" : "❌"}</td>
  </tr>
  <tr>
    <td>Engine-Chain Drift</td><td>< 0.5 ETH</td>
    <td>${formatEther(r.audit.engineStateDriftMax)} ETH</td>
    <td class="${Number(r.audit.engineStateDriftMax) / 1e18 < 0.5 ? "pass" : "fail"}">${Number(r.audit.engineStateDriftMax) / 1e18 < 0.5 ? "✅" : "❌"}</td>
  </tr>
  <tr>
    <td>Spot Success Rate</td><td>≥ 90%</td>
    <td>${spotSuccessRate}%</td>
    <td class="${parseFloat(spotSuccessRate) >= 90 ? "pass" : "warn"}">${parseFloat(spotSuccessRate) >= 90 ? "✅" : "⚠️"}</td>
  </tr>
  <tr>
    <td>Perp Success Rate</td><td>≥ 85%</td>
    <td>${perpSuccessRate}%</td>
    <td class="${parseFloat(perpSuccessRate) >= 85 ? "pass" : "warn"}">${parseFloat(perpSuccessRate) >= 85 ? "✅" : "⚠️"}</td>
  </tr>
  <tr>
    <td>RPC Failure Rate</td><td>< 5%</td>
    <td>${r.rpc.totalRequests > 0 ? ((r.rpc.failures / r.rpc.totalRequests) * 100).toFixed(2) : "0"}%</td>
    <td class="${r.rpc.totalRequests > 0 && (r.rpc.failures / r.rpc.totalRequests) < 0.05 ? "pass" : "warn"}">${r.rpc.totalRequests > 0 && (r.rpc.failures / r.rpc.totalRequests) < 0.05 ? "✅" : "⚠️"}</td>
  </tr>
  <tr>
    <td>Price Verification</td><td>0 failures</td>
    <td>${r.spot.priceVerificationFailures} failures</td>
    <td class="${r.spot.priceVerificationFailures === 0 ? "pass" : "warn"}">${r.spot.priceVerificationFailures === 0 ? "✅" : "⚠️"}</td>
  </tr>
</table>

<footer style="color:#8b949e;margin-top:2em;text-align:center;">
Generated by meme-perp-dex soak test system | ${new Date().toISOString()}
</footer></body></html>`;
}
