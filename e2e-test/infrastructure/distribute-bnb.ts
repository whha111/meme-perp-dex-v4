/**
 * Distribute BNB from master wallet to 100 sub-wallets
 * Reads: data/wallets.json
 * Requires: MASTER_PRIVATE_KEY in .env with >= 100 BNB
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { formatEther, parseEther, type Address } from "viem";
import { ENV, TEST_PARAMS } from "../config/test-config";
import { getBnbBalance, batchSendBnb, getPublicClient } from "../utils/rpc-client";
import { getAccount } from "../utils/rpc-client";
import { log } from "../utils/logger";

interface WalletEntry {
  index: number;
  address: string;
  privateKey: string;
  role: string;
}

async function main() {
  log.infra.info("═══ Distributing BNB to Test Wallets ═══");

  if (!ENV.MASTER_PRIVATE_KEY) {
    throw new Error("MASTER_PRIVATE_KEY not set in .env");
  }

  // Load wallets
  const walletsPath = resolve(__dirname, "../data/wallets.json");
  const wallets: WalletEntry[] = JSON.parse(readFileSync(walletsPath, "utf8"));
  log.infra.info({ walletCount: wallets.length }, "Wallets loaded");

  // Check master balance
  const masterAccount = getAccount(ENV.MASTER_PRIVATE_KEY as `0x${string}`);
  const masterBalance = await getBnbBalance(masterAccount.address);
  const masterBnb = Number(formatEther(masterBalance));
  log.infra.info({
    masterAddress: masterAccount.address,
    balance: `${masterBnb.toFixed(4)} BNB`,
  }, "Master wallet");

  const totalNeeded = TEST_PARAMS.WALLET_COUNT * TEST_PARAMS.BNB_PER_WALLET
    + TEST_PARAMS.LP_POOL_BNB
    + TEST_PARAMS.TOKEN_LIQUIDITY_BNB * 4
    + TEST_PARAMS.GAS_RESERVE_BNB
    + TEST_PARAMS.MARKET_MAKER_BNB;

  if (masterBnb < totalNeeded) {
    throw new Error(
      `Insufficient balance: ${masterBnb.toFixed(2)} BNB < ${totalNeeded.toFixed(2)} BNB needed`
    );
  }

  // Build recipient list with role-based amounts
  const recipients = wallets.map((w) => {
    let amount = TEST_PARAMS.BNB_PER_WALLET;
    if (w.role === "market-maker") amount = TEST_PARAMS.MARKET_MAKER_BNB / 5; // Split MM budget across 5
    if (w.role === "lp-provider") amount = TEST_PARAMS.LP_POOL_BNB / 3;       // Split LP budget across 3
    return { address: w.address as Address, amount };
  });

  const totalToSend = recipients.reduce((sum, r) => sum + r.amount, 0);
  log.infra.info({
    totalToSend: `${totalToSend.toFixed(2)} BNB`,
    traders: `${TEST_PARAMS.BNB_PER_WALLET} BNB each`,
    marketMakers: `${(TEST_PARAMS.MARKET_MAKER_BNB / 5).toFixed(2)} BNB each`,
    lpProviders: `${(TEST_PARAMS.LP_POOL_BNB / 3).toFixed(2)} BNB each`,
  }, "Distribution plan");

  // Check which wallets already have sufficient balance
  const client = getPublicClient();
  let alreadyFunded = 0;
  const needsFunding: typeof recipients = [];

  for (const r of recipients) {
    const balance = await client.getBalance({ address: r.address });
    if (Number(formatEther(balance)) >= r.amount * 0.9) {
      alreadyFunded++;
    } else {
      needsFunding.push(r);
    }
  }

  log.infra.info({
    alreadyFunded,
    needsFunding: needsFunding.length,
  }, "Funding check");

  if (needsFunding.length === 0) {
    console.log("✅ All wallets already funded!");
    return;
  }

  // Distribute
  console.log(`\nSending BNB to ${needsFunding.length} wallets...`);
  const result = await batchSendBnb(
    ENV.MASTER_PRIVATE_KEY as `0x${string}`,
    needsFunding,
    10
  );

  // Verify
  const masterBalanceAfter = await getBnbBalance(masterAccount.address);
  console.log(`\n✅ Distribution complete`);
  console.log(`   Sent: ${result.success}, Failed: ${result.failed}`);
  console.log(`   Master balance: ${formatEther(masterBalanceAfter)} BNB remaining`);
}

main().catch(console.error);
