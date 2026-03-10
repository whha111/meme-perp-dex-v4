/**
 * Stress Test Orchestrator — Main entry point
 *
 * Manages all engines, monitors, and scenario schedulers.
 * Supports 3 modes: soak (gentle), stress (aggressive), full (alternating).
 *
 * Usage:
 *   bun run orchestrator.ts --duration 48h --spot 200 --perp 200 --mode soak
 *   bun run orchestrator.ts --duration 2h --spot 200 --perp 200 --mode stress
 *   bun run orchestrator.ts --duration 8h --spot 200 --perp 200 --mode full
 */
import { formatEther, parseEther } from "viem";
import { loadWallets, getSpotWallets, getPerpWallets } from "./utils/wallet-manager.js";
import { getRpcPool } from "./utils/rpc-pool.js";
import { SpotEngine } from "./engines/spot-engine.js";
import { PerpEngine } from "./engines/perp-engine.js";
import { FundAuditor } from "./monitors/fund-auditor.js";
import { PnlTracker } from "./monitors/pnl-tracker.js";
import { InsuranceMonitor } from "./monitors/insurance-monitor.js";
import { LiquidationVerifier } from "./monitors/liquidation-verifier.js";
import { ScenarioScheduler } from "./scenarios/scenario-scheduler.js";
import { generateReport, type FullReport } from "./utils/reporter.js";
import {
  CONTRACTS,
  PERP_VAULT_ABI,
  WETH_ABI,
  WETH_ADDRESS,
  MONITOR_INTERVALS,
} from "./config.js";

// ── Types ────────────────────────────────────────────────────

type TestMode = "soak" | "stress" | "full";

// ── CLI Args ───────────────────────────────────────────────────

function parseArgs(): {
  durationMs: number;
  spotCount: number;
  perpCount: number;
  deployerKey: string;
  mode: TestMode;
} {
  const args = process.argv.slice(2);
  let durationMs = 48 * 3600 * 1000; // Default 48h
  let spotCount = 200;
  let perpCount = 200; // Default 200 perp (uses extended wallets as overflow)
  let deployerKey = process.env.DEPLOYER_KEY || "";
  let mode: TestMode = "soak";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--duration" && args[i + 1]) {
      const val = args[i + 1];
      if (val.endsWith("h")) durationMs = parseFloat(val) * 3600 * 1000;
      else if (val.endsWith("m")) durationMs = parseFloat(val) * 60 * 1000;
      else durationMs = parseFloat(val) * 1000;
      i++;
    } else if (args[i] === "--spot" && args[i + 1]) {
      spotCount = parseInt(args[i + 1]); i++;
    } else if (args[i] === "--perp" && args[i + 1]) {
      perpCount = parseInt(args[i + 1]); i++;
    } else if (args[i] === "--deployer-key" && args[i + 1]) {
      deployerKey = args[i + 1]; i++;
    } else if (args[i] === "--mode" && args[i + 1]) {
      const m = args[i + 1].toLowerCase();
      if (m === "soak" || m === "stress" || m === "full") {
        mode = m;
      } else {
        console.warn(`[Init] Unknown mode "${m}", defaulting to "soak"`);
      }
      i++;
    }
  }

  return { durationMs, spotCount, perpCount, deployerKey, mode };
}

// ── Health Check ──────────────────────────────────────────────

async function runHealthCheck(): Promise<{
  settlementWeth: bigint;
  perpVaultPool: bigint;
  perpVaultOI: bigint;
  engineWalletGas: bigint;
  pass: boolean;
  issues: string[];
}> {
  const pool = getRpcPool();
  const issues: string[] = [];
  let settlementWeth = 0n;
  let perpVaultPool = 0n;
  let perpVaultOI = 0n;
  let engineWalletGas = 0n;

  try {
    settlementWeth = await pool.call(() =>
      pool.httpClient.readContract({
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "balanceOf",
        args: [CONTRACTS.settlementV2],
      })
    ) as bigint;
  } catch { issues.push("Cannot read SettlementV2 WETH balance"); }

  try {
    perpVaultPool = await pool.call(() =>
      pool.httpClient.readContract({
        address: CONTRACTS.perpVault,
        abi: PERP_VAULT_ABI,
        functionName: "getPoolValue",
      })
    ) as bigint;
  } catch { issues.push("Cannot read PerpVault poolValue"); }

  try {
    perpVaultOI = await pool.call(() =>
      pool.httpClient.readContract({
        address: CONTRACTS.perpVault,
        abi: PERP_VAULT_ABI,
        functionName: "getTotalOI",
      })
    ) as bigint;
  } catch { issues.push("Cannot read PerpVault totalOI"); }

  // Check PerpVault health
  if (perpVaultPool === 0n) {
    issues.push("PerpVault poolValue is ZERO");
  } else if (perpVaultPool < parseEther("0.5")) {
    issues.push(`PerpVault poolValue LOW: ${formatEther(perpVaultPool)}`);
  }

  const pass = issues.length === 0;
  return { settlementWeth, perpVaultPool, perpVaultOI, engineWalletGas, pass, issues };
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const { durationMs, spotCount, perpCount, deployerKey, mode } = parseArgs();
  const durationHours = durationMs / 3600000;
  const startTime = Date.now();

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Meme-Perp-DEX Soak Test / Stress Test System      ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`Mode: ${mode.toUpperCase()} | Duration: ${durationHours}h | Spot: ${spotCount} | Perp: ${perpCount}`);
  console.log(`Start: ${new Date().toLocaleString()}`);
  console.log(`End:   ${new Date(startTime + durationMs).toLocaleString()}\n`);

  // Mode descriptions
  switch (mode) {
    case "soak":
      console.log("[Mode] SOAK — Normal trading + periodic chain verification. Gentle pace.");
      break;
    case "stress":
      console.log("[Mode] STRESS — High concurrency + extreme scenarios. Aggressive pace.");
      break;
    case "full":
      console.log("[Mode] FULL — Alternating soak/stress phases. Production simulation.");
      break;
  }

  // ── 1. Load Wallets ────────────────────────────────────────
  const allWallets = loadWallets(spotCount, perpCount);
  const spotWallets = getSpotWallets(allWallets);
  const perpWallets = getPerpWallets(allWallets);

  // ── 2. Pre-flight Health Check ─────────────────────────────
  console.log("\n[Init] Running pre-flight health check...");
  const preflight = await runHealthCheck();
  console.log(`[Init] SettlementV2 WETH: ${formatEther(preflight.settlementWeth)}`);
  console.log(`[Init] PerpVault pool: ${formatEther(preflight.perpVaultPool)}`);
  console.log(`[Init] PerpVault OI: ${formatEther(preflight.perpVaultOI)}`);
  if (!preflight.pass) {
    console.warn(`[Init] ⚠ Pre-flight issues: ${preflight.issues.join("; ")}`);
  }

  // ── 3. Check Wallet Balances ───────────────────────────────
  console.log("\n[Init] Checking wallet balances...");
  const pool = getRpcPool();
  let totalEth = 0n;
  let fundedCount = 0;

  // Sample first 20 of each group (scaled for 400 wallet tests)
  for (const w of [...spotWallets.slice(0, 10), ...perpWallets.slice(0, 10)]) {
    try {
      const balance = await pool.call(() =>
        pool.httpClient.getBalance({ address: w.address })
      );
      if (balance > 0n) {
        totalEth += balance;
        fundedCount++;
      }
    } catch {}
  }

  console.log(`[Init] Sampled 20 wallets: ${fundedCount} funded, ~${formatEther(totalEth)} ETH total`);

  // ── 4. Initialize Components ───────────────────────────────
  const spotEngine = new SpotEngine(spotWallets);
  const perpEngine = new PerpEngine(perpWallets);

  // Pass a pause callback that stops trading engines
  const pauseAll = () => {
    console.error("\n⚠️ EMERGENCY PAUSE: Stopping all trading engines!\n");
    spotEngine.stop();
    perpEngine.stop();
  };

  const fundAuditor = new FundAuditor(allWallets, pauseAll);
  const pnlTracker = new PnlTracker(perpWallets);
  const insuranceMonitor = new InsuranceMonitor();
  const liquidationVerifier = new LiquidationVerifier(
    perpWallets,
    spotWallets[0], // Use first spot wallet as liquidation executor
  );

  let scenarioScheduler: ScenarioScheduler | null = null;
  // Scenarios only in stress/full mode, or if deployer key available
  if (deployerKey && (mode === "stress" || mode === "full")) {
    scenarioScheduler = new ScenarioScheduler(
      deployerKey as `0x${string}`,
      fundAuditor,
    );
  } else if (!deployerKey) {
    console.warn("[Init] No DEPLOYER_KEY — scenario injection disabled");
  } else if (mode === "soak") {
    console.log("[Init] Soak mode — scenario injection disabled (use --mode stress or full)");
  }

  // ── 5. Start All Components ────────────────────────────────
  console.log("\n[Init] Starting all components...\n");

  // Adjust intervals based on mode
  const auditInterval = mode === "stress"
    ? MONITOR_INTERVALS.fundAuditMs / 2     // 2.5 min in stress
    : MONITOR_INTERVALS.fundAuditMs;          // 5 min in soak
  const warmupDelay = mode === "stress" ? 60_000 : 120_000;

  // Fire and forget — all run concurrently
  const tasks = [
    spotEngine.start(),
    perpEngine.start(),
    // Warmup delay: wait for batch deposits to settle before first audit
    (async () => {
      console.log(`[FundAudit] Waiting ${warmupDelay / 1000}s warmup for deposits to settle...`);
      await new Promise(r => setTimeout(r, warmupDelay));
      return fundAuditor.startPeriodic(auditInterval);
    })(),
    pnlTracker.startPeriodic(MONITOR_INTERVALS.pnlTrackMs),
    insuranceMonitor.startPeriodic(MONITOR_INTERVALS.insuranceTrackMs),
    liquidationVerifier.startScanning(
      MONITOR_INTERVALS.liquidationScanMs,
      MONITOR_INTERVALS.profitWithdrawalMs,
    ),
  ];

  if (scenarioScheduler) {
    tasks.push(scenarioScheduler.start());
  }

  // ── 6. Enhanced Summary + Health Check Logger ──────────────
  const summaryInterval = setInterval(async () => {
    const elapsed = (Date.now() - startTime) / 3600000;
    const remaining = durationHours - elapsed;
    const rpcStats = pool.getStats();

    // Run lightweight health check
    const health = await runHealthCheck();

    console.log(`\n╔══ Summary [${elapsed.toFixed(1)}h / ${durationHours}h] (${mode.toUpperCase()}) ══════════╗`);

    // Spot stats (with new V2 fields)
    console.log(
      `║ Spot:  rounds=${spotEngine.stats.totalRounds} buys=${spotEngine.stats.buys} ` +
      `sells=${spotEngine.stats.sells} creates=${spotEngine.stats.creates} ` +
      `grads=${spotEngine.stats.graduations}`
    );
    console.log(
      `║        priceSyncs=${spotEngine.stats.priceFeedSyncs} ` +
      `priceChecks=${spotEngine.stats.priceVerifications} ` +
      `priceIssues=${spotEngine.stats.priceVerificationFailures}`
    );

    // Perp stats (with new V2 fields)
    console.log(
      `║ Perp:  rounds=${perpEngine.stats.totalRounds} orders=${perpEngine.stats.ordersSubmitted} ` +
      `matched=${perpEngine.stats.ordersMatched} deposits=${perpEngine.stats.deposits}`
    );
    if ('withdrawals' in perpEngine.stats) {
      console.log(
        `║        withdrawals=${(perpEngine.stats as any).withdrawals} ` +
        `lifecycleChecks=${(perpEngine.stats as any).lifecycleChecks}`
      );
    }

    // Chain verification
    const auditPassStr = fundAuditor.stats.totalAudits > 0
      ? `${fundAuditor.stats.passedAudits}/${fundAuditor.stats.totalAudits}`
      : "pending";
    console.log(`║ Audit: ${auditPassStr} passed`);

    // Health check results
    const settlementStr = health.pass ? "✅" : "⚠️";
    console.log(
      `║ ${settlementStr} SettlementV2: ${formatEther(health.settlementWeth)} WETH`
    );
    console.log(
      `║ ${health.perpVaultPool > 0n ? "✅" : "❌"} PerpVault: pool=${formatEther(health.perpVaultPool)} ` +
      `OI=${formatEther(health.perpVaultOI)}`
    );
    if (fundAuditor.stats.engineStateDriftMax > 0n) {
      console.log(
        `║    Mode2 drift max: ${formatEther(fundAuditor.stats.engineStateDriftMax)}`
      );
    }

    // Infrastructure
    console.log(
      `║ Liq:   ${liquidationVerifier.stats.liquidationsSucceeded} liquidations`
    );
    console.log(
      `║ RPC:   ${rpcStats.totalRequests} calls, ${rpcStats.retries} retries, ${rpcStats.failures} failures`
    );
    if (scenarioScheduler) {
      console.log(
        `║ Scenarios: ${scenarioScheduler.stats.executedScenarios.length} executed`
      );
    }
    console.log(`║ Remaining: ${remaining.toFixed(1)} hours`);

    // Health issues
    if (!health.pass) {
      for (const issue of health.issues) {
        console.log(`║ ⚠️  ${issue}`);
      }
    }

    console.log(`╚═══════════════════════════════════════════════════════╝\n`);
  }, MONITOR_INTERVALS.summaryMs);

  // ── 7. Duration Timer ──────────────────────────────────────
  const timeout = setTimeout(() => {
    console.log("\n\n⏰ Duration reached. Shutting down gracefully...\n");
    shutdown();
  }, durationMs);

  // ── 8. Graceful Shutdown ───────────────────────────────────
  let isShuttingDown = false;

  function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearInterval(summaryInterval);
    clearTimeout(timeout);

    console.log("[Shutdown] Stopping engines...");
    spotEngine.stop();
    perpEngine.stop();
    fundAuditor.stop();
    pnlTracker.stop();
    insuranceMonitor.stop();
    liquidationVerifier.stop();
    scenarioScheduler?.stop();

    // Final audit
    console.log("[Shutdown] Running final audit...");
    fundAuditor.runOnce().then(async () => {
      // Final health check
      const finalHealth = await runHealthCheck();
      console.log(`[Shutdown] Final health: ${finalHealth.pass ? "✅ PASS" : "❌ FAIL"}`);
      if (!finalHealth.pass) {
        for (const issue of finalHealth.issues) {
          console.warn(`[Shutdown]   ${issue}`);
        }
      }

      // Generate report
      const report: FullReport = {
        meta: {
          startTime,
          endTime: Date.now(),
          durationHours: (Date.now() - startTime) / 3600000,
          totalWallets: allWallets.length,
          spotWallets: spotWallets.length,
          perpWallets: perpWallets.length,
          mode,
        },
        spot: spotEngine.stats,
        perp: perpEngine.stats,
        audit: fundAuditor.stats,
        pnl: pnlTracker.stats,
        insurance: insuranceMonitor.stats,
        liquidation: liquidationVerifier.stats,
        scenarios: scenarioScheduler?.stats ?? {
          executedScenarios: [],
          scenarioCounts: { flash_crash: 0, pump: 0, dump: 0, whipsaw: 0, slow_bleed: 0, near_zero: 0 },
          nextScheduled: 0,
        },
        rpc: pool.getStats(),
        chainHealth: {
          settlementWeth: finalHealth.settlementWeth.toString(),
          perpVaultPool: finalHealth.perpVaultPool.toString(),
          perpVaultOI: finalHealth.perpVaultOI.toString(),
          pass: finalHealth.pass,
          issues: finalHealth.issues,
        },
      };

      generateReport(report);
      console.log("\n[Shutdown] Complete. Reports generated.");
      process.exit(0);
    });
  }

  process.on("SIGINT", () => {
    console.log("\n\nReceived SIGINT...");
    shutdown();
  });

  process.on("SIGTERM", () => {
    console.log("\n\nReceived SIGTERM...");
    shutdown();
  });

  // Wait for all tasks
  await Promise.allSettled(tasks);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
