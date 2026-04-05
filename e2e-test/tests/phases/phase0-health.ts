/**
 * Phase 0: Health Check + Prerequisites
 *
 * Verifies all services running, tokens perp-enabled, LP funded, wallets have balance.
 * Aborts test if critical checks fail.
 */
import { formatEther, type Address, parseEther } from "viem";
import { ENV, CONTRACTS, ABI } from "../../config/test-config";
import { getPublicClient, getWalletClient, waitForTx } from "../../utils/rpc-client";

const ENGINE = ENV.ENGINE_URL;

export interface Phase0Result {
  engineHealthy: boolean;
  goBackendHealthy: boolean;
  tokens: Record<string, { perpEnabled: boolean; price: bigint; ethReserve: string }>;
  lpPoolBnb: string;
  walletsWithBalance: number;
  walletsTotalChecked: number;
  passed: boolean;
  errors: string[];
}

export async function runPhase0(
  wallets: any[],
  tokenData: Record<string, { address: string }>,
): Promise<Phase0Result> {
  console.log("\n══════════════════════════════════════════════");
  console.log("  PHASE 0: Health Check + Prerequisites");
  console.log("══════════════════════════════════════════════\n");

  const errors: string[] = [];
  const client = getPublicClient();

  // 1. Engine health
  let engineHealthy = false;
  try {
    const resp = await fetch(`${ENGINE}/health`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json() as any;
      engineHealthy = data.status === "ok" || resp.status === 200;
      console.log(`  [OK] Engine healthy — redis: ${data.services?.redis || "?"}`);
    }
  } catch (e: any) {
    errors.push(`Engine unreachable: ${e.message}`);
    console.log(`  [FAIL] Engine unreachable`);
  }

  // 2. Go backend health
  let goBackendHealthy = false;
  try {
    const resp = await fetch(`${ENV.BACKEND_URL}/health`, { signal: AbortSignal.timeout(5000) });
    goBackendHealthy = resp.ok;
    console.log(`  [${resp.ok ? "OK" : "FAIL"}] Go backend — ${resp.status}`);
  } catch (e: any) {
    errors.push(`Go backend unreachable: ${e.message}`);
    console.log(`  [FAIL] Go backend unreachable`);
  }

  // 3. Token perp status
  const tokens: Phase0Result["tokens"] = {};
  for (const [symbol, info] of Object.entries(tokenData)) {
    const addr = info.address as Address;
    try {
      const state = await client.readContract({
        address: CONTRACTS.TokenFactory,
        abi: ABI.TokenFactory,
        functionName: "getPoolState",
        args: [addr],
      }) as any;

      let price = 0n;
      try {
        price = await client.readContract({
          address: CONTRACTS.TokenFactory,
          abi: ABI.TokenFactory,
          functionName: "getCurrentPrice",
          args: [addr],
        }) as bigint;
      } catch {}

      tokens[symbol] = {
        perpEnabled: state.perpEnabled,
        price,
        ethReserve: formatEther(state.realETHReserve),
      };

      const status = state.perpEnabled ? "OK" : "FAIL";
      console.log(`  [${status}] ${symbol}: perpEnabled=${state.perpEnabled}, ETH=${formatEther(state.realETHReserve)}, price=${price}`);

      if (!state.perpEnabled) {
        errors.push(`${symbol} perpEnabled=false (needs 6+ BNB, has ${formatEther(state.realETHReserve)})`);
      }
    } catch (e: any) {
      tokens[symbol] = { perpEnabled: false, price: 0n, ethReserve: "0" };
      errors.push(`${symbol} getPoolState failed: ${e.message?.slice(0, 100)}`);
    }
  }

  // 4. PerpVault LP
  let lpPoolBnb = "0";
  try {
    const poolValue = await client.readContract({
      address: CONTRACTS.PerpVault,
      abi: ABI.PerpVault,
      functionName: "getPoolValue",
    }) as bigint;
    lpPoolBnb = formatEther(poolValue);
    const ok = poolValue >= parseEther("3");
    console.log(`  [${ok ? "OK" : "WARN"}] PerpVault LP: ${lpPoolBnb} BNB`);
    if (!ok) errors.push(`LP pool only ${lpPoolBnb} BNB (need >= 3)`);
  } catch (e: any) {
    errors.push(`PerpVault.getPoolValue() failed: ${e.message?.slice(0, 100)}`);
  }

  // 5. Wallet balance check
  let walletsWithBalance = 0;
  const checkCount = Math.min(wallets.length, 50);
  for (let i = 0; i < checkCount; i++) {
    try {
      const resp = await fetch(`${ENGINE}/api/user/${wallets[i].address}/balance`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const bal = BigInt(data.balance || data.available || data.totalBalance || "0");
        if (bal > 0n) walletsWithBalance++;
      }
    } catch {}
  }
  const walletOk = walletsWithBalance >= checkCount * 0.8;
  console.log(`  [${walletOk ? "OK" : "WARN"}] Wallets with balance: ${walletsWithBalance}/${checkCount}`);
  if (!walletOk) errors.push(`Only ${walletsWithBalance}/${checkCount} wallets have balance`);

  // Overall
  const passed = engineHealthy && Object.values(tokens).every(t => t.perpEnabled);
  console.log(`\n  Phase 0 result: ${passed ? "PASS" : "FAIL"} (${errors.length} issues)`);
  if (errors.length > 0) errors.forEach(e => console.log(`    - ${e}`));

  return {
    engineHealthy,
    goBackendHealthy,
    tokens,
    lpPoolBnb,
    walletsWithBalance,
    walletsTotalChecked: checkCount,
    passed,
    errors,
  };
}
