/**
 * Balance Auditor — Verify user balances match on-chain state
 * Rule: sum(all user balances) <= SettlementV2 balance + PerpVault value
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { formatEther, type Address } from "viem";
import { ENV, CONTRACTS, ABI } from "../config/test-config";
import { getPublicClient } from "../utils/rpc-client";
import { log } from "../utils/logger";

interface AuditResult {
  timestamp: number;
  totalUserBalances: number;    // Sum of all user balances (BNB)
  settlementBalance: number;    // SettlementV2 WBNB balance
  perpVaultValue: number;       // PerpVault pool value
  totalOnChain: number;         // settlement + perpVault
  drift: number;                // totalOnChain - totalUserBalances
  passed: boolean;
  details: string[];
}

export async function runBalanceAudit(): Promise<AuditResult> {
  log.monitor.info("═══ Running Balance Audit ═══");

  const wallets = JSON.parse(
    readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8")
  );
  const client = getPublicClient();
  const details: string[] = [];

  // 1. Sum all user balances from engine
  let totalUserBalances = 0;
  let negativeBalances = 0;

  for (const wallet of wallets) {
    try {
      const resp = await fetch(`${ENV.ENGINE_URL}/api/user/${wallet.address}/balance`);
      const data = await resp.json() as any;
      const balance = Number(data.totalBalance || data.availableBalance || 0) / 1e18;
      if (balance < 0) {
        negativeBalances++;
        details.push(`NEGATIVE: ${wallet.address.slice(0, 10)} = ${balance} BNB`);
      }
      totalUserBalances += Math.max(0, balance);
    } catch {}
  }

  // 2. Get SettlementV2 WBNB balance (on-chain)
  const settlementWbnb = await client.readContract({
    address: CONTRACTS.WBNB,
    abi: ABI.WBNB,
    functionName: "balanceOf",
    args: [CONTRACTS.SettlementV2],
  });
  const settlementBalance = Number(formatEther(settlementWbnb as bigint));

  // Also check native BNB balance of SettlementV2
  const settlementBnb = await client.getBalance({ address: CONTRACTS.SettlementV2 });
  const settlementNative = Number(formatEther(settlementBnb));

  // 3. Get PerpVault pool value
  let perpVaultValue = 0;
  try {
    const poolValue = await client.readContract({
      address: CONTRACTS.PerpVault,
      abi: ABI.PerpVault,
      functionName: "getPoolValue",
    });
    perpVaultValue = Number(formatEther(poolValue as bigint));
  } catch (e) {
    details.push(`PerpVault.getPoolValue() failed: ${(e as Error).message}`);
  }

  // 4. Calculate drift
  const totalOnChain = settlementBalance + settlementNative + perpVaultValue;
  const drift = totalOnChain - totalUserBalances;

  const passed = drift >= -0.01 && negativeBalances === 0;

  const result: AuditResult = {
    timestamp: Date.now(),
    totalUserBalances,
    settlementBalance: settlementBalance + settlementNative,
    perpVaultValue,
    totalOnChain,
    drift,
    passed,
    details,
  };

  log.monitor.info({
    userBalances: `${totalUserBalances.toFixed(4)} BNB`,
    onChain: `${totalOnChain.toFixed(4)} BNB`,
    drift: `${drift.toFixed(4)} BNB`,
    passed,
    negativeBalances,
  }, "Balance audit result");

  return result;
}

if (import.meta.main) {
  runBalanceAudit().then(console.log).catch(console.error);
}
