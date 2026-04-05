/**
 * Report Generator — Aggregates all test results into HTML + Markdown report
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { log } from "../utils/logger";
import { getHealthSummary } from "../monitors/engine-health";

interface ReportData {
  timestamp: string;
  duration: string;
  modules: { name: string; passed: boolean; details: string }[];
  replay: {
    total: number;
    accepted: number;
    rejected: number;
    failed: number;
    acceptanceRate: string;
    p50: number;
    p90: number;
    p99: number;
  };
  health: any;
  balanceAudit: any;
  verdict: "PASS" | "FAIL";
  failures: string[];
}

async function main() {
  log.report.info("═══ Generating E2E Test Report ═══");

  const failures: string[] = [];
  const data: ReportData = {
    timestamp: new Date().toISOString(),
    duration: "—",
    modules: [],
    replay: {
      total: 0, accepted: 0, rejected: 0, failed: 0,
      acceptanceRate: "0%", p50: 0, p90: 0, p99: 0,
    },
    health: null,
    balanceAudit: null,
    verdict: "PASS",
    failures: [],
  };

  // Load Playwright results
  const playwrightResults = resolve(__dirname, "results.json");
  if (existsSync(playwrightResults)) {
    const results = JSON.parse(readFileSync(playwrightResults, "utf8"));
    data.modules = (results.suites || []).map((s: any) => ({
      name: s.title,
      passed: s.specs?.every((sp: any) => sp.ok) || false,
      details: s.specs?.map((sp: any) => `${sp.ok ? "✅" : "❌"} ${sp.title}`).join("\n") || "",
    }));

    const failedModules = data.modules.filter((m) => !m.passed);
    if (failedModules.length > 0) {
      failures.push(`${failedModules.length} module tests failed`);
    }
  }

  // Health summary
  data.health = getHealthSummary();

  // Generate Markdown
  let md = `# E2E Test Report\n\n`;
  md += `**Date**: ${data.timestamp}\n\n`;
  md += `## Module Tests\n\n`;
  md += `| Module | Status |\n|--------|--------|\n`;
  for (const m of data.modules) {
    md += `| ${m.name} | ${m.passed ? "✅ PASS" : "❌ FAIL"} |\n`;
  }

  if (data.health) {
    md += `\n## Engine Health\n\n`;
    md += `- Status: ${data.health.status}\n`;
    md += `- Memory: ${data.health.memory?.min}-${data.health.memory?.max} MB\n`;
    md += `- Redis: ${data.health.redis?.connected ? "OK" : "DISCONNECTED"}\n`;
    md += `- Peak positions: ${data.health.peak?.positions}\n`;
  }

  md += `\n## Verdict: **${failures.length === 0 ? "PASS ✅" : "FAIL ❌"}**\n\n`;
  if (failures.length > 0) {
    md += `### Failures\n`;
    for (const f of failures) {
      md += `- ${f}\n`;
    }
  }

  // Save
  const mdPath = resolve(__dirname, "report.md");
  writeFileSync(mdPath, md);
  log.report.info({ path: mdPath }, "Report saved");

  console.log("\n" + md);
}

main().catch(console.error);
