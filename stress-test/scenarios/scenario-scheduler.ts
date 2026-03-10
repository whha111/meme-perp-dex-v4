/**
 * Scenario Scheduler — rotates 6 extreme scenarios over 48h
 *
 * - Each scenario executes at least 2x in 48h (12+ total injections)
 * - Random order, 3-6 hours between injections
 * - Pre/post audit snapshots for each injection
 */
import { MarketScenarios, type ScenarioType, type ScenarioResult } from "./market-scenarios.js";
import { FundAuditor } from "../monitors/fund-auditor.js";
import { SCENARIO_CONFIG } from "../config.js";
import { randInt } from "../utils/wallet-manager.js";

const ALL_SCENARIOS: ScenarioType[] = [
  "flash_crash", "pump", "dump", "whipsaw", "slow_bleed", "near_zero",
];

export interface SchedulerStats {
  executedScenarios: ScenarioResult[];
  scenarioCounts: Record<ScenarioType, number>;
  nextScheduled: number;
}

export class ScenarioScheduler {
  private running = false;
  private scenarios: MarketScenarios;
  private auditor: FundAuditor;
  private queue: ScenarioType[] = [];
  readonly stats: SchedulerStats = {
    executedScenarios: [],
    scenarioCounts: { flash_crash: 0, pump: 0, dump: 0, whipsaw: 0, slow_bleed: 0, near_zero: 0 },
    nextScheduled: 0,
  };

  constructor(deployerKey: `0x${string}`, auditor: FundAuditor) {
    this.scenarios = new MarketScenarios(deployerKey);
    this.auditor = auditor;
    this.buildQueue();
  }

  /** Build a randomized queue ensuring each scenario runs at least 2x */
  private buildQueue(): void {
    this.queue = [];
    // 2 passes of all 6 scenarios = 12 minimum
    for (let pass = 0; pass < SCENARIO_CONFIG.minExecutionsPerScenario; pass++) {
      const shuffled = [...ALL_SCENARIOS].sort(() => Math.random() - 0.5);
      this.queue.push(...shuffled);
    }
    // Add a few bonus random ones
    for (let i = 0; i < 4; i++) {
      this.queue.push(ALL_SCENARIOS[randInt(0, ALL_SCENARIOS.length - 1)]);
    }
    console.log(`[Scheduler] Built queue with ${this.queue.length} scenarios: ${this.queue.join(", ")}`);
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Scheduler] Started — will execute ${this.queue.length} scenarios over test duration`);

    while (this.running && this.queue.length > 0) {
      const scenario = this.queue.shift()!;

      // Wait 3-6 hours before next scenario (but much less for first one)
      const isFirst = this.stats.executedScenarios.length === 0;
      const delayHours = isFirst
        ? 0.5 // First scenario after 30 min warmup
        : randInt(SCENARIO_CONFIG.intervalHoursRange[0], SCENARIO_CONFIG.intervalHoursRange[1]);
      const delayMs = delayHours * 3600 * 1000;

      this.stats.nextScheduled = Date.now() + delayMs;
      console.log(`[Scheduler] Next: ${scenario} in ${delayHours}h (${new Date(this.stats.nextScheduled).toLocaleTimeString()})`);

      // Wait with cancellation check
      const waitEnd = Date.now() + delayMs;
      while (this.running && Date.now() < waitEnd) {
        await new Promise(r => setTimeout(r, 30_000)); // Check every 30s
      }
      if (!this.running) break;

      // Pre-audit
      console.log(`[Scheduler] Pre-scenario audit...`);
      await this.auditor.runOnce();

      // Wait for audit to settle
      await new Promise(r => setTimeout(r, SCENARIO_CONFIG.prePostAuditDelayMs));

      // Execute scenario
      const result = await this.scenarios.execute(scenario);
      this.stats.executedScenarios.push(result);
      this.stats.scenarioCounts[scenario]++;

      // Wait for market impact
      await new Promise(r => setTimeout(r, 60_000)); // 1 min for effects

      // Post-audit
      console.log(`[Scheduler] Post-scenario audit...`);
      await this.auditor.runOnce();

      // Recover prices after 5 min
      await new Promise(r => setTimeout(r, 5 * 60_000));
      if (result.success) {
        await this.scenarios.recoverPrices(result.pricesBefore);
      }

      console.log(
        `[Scheduler] Scenario ${scenario} complete. ` +
        `Queue remaining: ${this.queue.length}. ` +
        `Total executed: ${this.stats.executedScenarios.length}`
      );
    }

    console.log(`[Scheduler] All scenarios completed`);
  }

  stop(): void {
    this.running = false;
  }
}
