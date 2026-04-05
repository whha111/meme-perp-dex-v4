/**
 * Pre-flight Infrastructure Verification
 * Checks everything is ready before running tests
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { formatEther } from "viem";
import { ENV, CONTRACTS } from "../config/test-config";
import { getPublicClient, getBnbBalance } from "../utils/rpc-client";
import { log } from "../utils/logger";

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

async function main() {
  log.infra.info("═══ Pre-flight Infrastructure Check ═══\n");

  const checks: CheckResult[] = [];

  // 1. Data files exist
  const files = [
    "data/wallets.json",
    "data/token-addresses.json",
    "data/gmx-trades.json",
  ];
  for (const f of files) {
    const path = resolve(__dirname, "..", f);
    const exists = existsSync(path);
    checks.push({
      name: `File: ${f}`,
      passed: exists,
      message: exists ? "OK" : "MISSING",
    });
  }

  // 2. Frontend reachable
  try {
    const resp = await fetch(ENV.FRONTEND_URL, { signal: AbortSignal.timeout(5000) });
    checks.push({
      name: "Frontend (localhost:3000)",
      passed: resp.ok,
      message: resp.ok ? `HTTP ${resp.status}` : `HTTP ${resp.status}`,
    });
  } catch (e) {
    checks.push({
      name: "Frontend (localhost:3000)",
      passed: false,
      message: (e as Error).message,
    });
  }

  // 3. Matching Engine health
  try {
    const resp = await fetch(`${ENV.ENGINE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json() as any;
    checks.push({
      name: "Matching Engine (localhost:8081)",
      passed: data.status === "ok",
      message: `status=${data.status}, mem=${data.metrics?.memoryMB}MB, redis=${data.services?.redis}`,
    });
  } catch (e) {
    checks.push({
      name: "Matching Engine (localhost:8081)",
      passed: false,
      message: (e as Error).message,
    });
  }

  // 4. Backend API health
  try {
    const resp = await fetch(`${ENV.BACKEND_URL}/health`, { signal: AbortSignal.timeout(5000) });
    checks.push({
      name: "Backend API (localhost:8080)",
      passed: resp.ok,
      message: resp.ok ? "OK" : `HTTP ${resp.status}`,
    });
  } catch (e) {
    checks.push({
      name: "Backend API (localhost:8080)",
      passed: false,
      message: (e as Error).message,
    });
  }

  // 5. Wallet funding
  if (existsSync(resolve(__dirname, "../data/wallets.json"))) {
    const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
    let funded = 0;
    let totalBalance = 0;

    for (const w of wallets.slice(0, 10)) { // Check first 10 as sample
      try {
        const balance = await getBnbBalance(w.address);
        const bnb = Number(formatEther(balance));
        if (bnb > 0.1) funded++;
        totalBalance += bnb;
      } catch {}
    }

    checks.push({
      name: "Wallet Funding (sample 10)",
      passed: funded >= 8,
      message: `${funded}/10 funded, ${totalBalance.toFixed(2)} BNB total in sample`,
    });
  }

  // 6. Token creation
  if (existsSync(resolve(__dirname, "../data/token-addresses.json"))) {
    const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
    const count = Object.keys(tokens).length;
    checks.push({
      name: "Test Tokens",
      passed: count >= 4,
      message: `${count} tokens: ${Object.keys(tokens).join(", ")}`,
    });
  }

  // 7. BSC Testnet connectivity
  try {
    const client = getPublicClient();
    const blockNumber = await client.getBlockNumber();
    checks.push({
      name: "BSC Testnet RPC",
      passed: blockNumber > 0n,
      message: `Block #${blockNumber}`,
    });
  } catch (e) {
    checks.push({
      name: "BSC Testnet RPC",
      passed: false,
      message: (e as Error).message,
    });
  }

  // Print results
  console.log("\n" + "═".repeat(60));
  let allPassed = true;
  for (const check of checks) {
    const icon = check.passed ? "✅" : "❌";
    console.log(`  ${icon} ${check.name.padEnd(35)} ${check.message}`);
    if (!check.passed) allPassed = false;
  }
  console.log("═".repeat(60));
  console.log(`\n${allPassed ? "✅ ALL CHECKS PASSED" : "❌ SOME CHECKS FAILED"}\n`);

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch(console.error);
