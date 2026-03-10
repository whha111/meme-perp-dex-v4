/**
 * Full Wallet Balance Audit
 *
 * Checks ALL 200 wallets for:
 *  - Native ETH balance
 *  - WETH (wrapped ETH) balance
 *  - SettlementV2 userDeposits (on-chain)
 *
 * Also checks key contracts:
 *  - SettlementV2 total WETH
 *  - PerpVault poolValue
 *  - Deployer balance
 */
import { createPublicClient, http, formatEther, type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { readFileSync } from "fs";
import {
  CONTRACTS,
  WETH_ADDRESS,
  SETTLEMENT_V2_ABI,
  WETH_ABI,
  PERP_VAULT_ABI,
  RPC,
} from "./config.js";

const client = createPublicClient({
  chain: bscTestnet,
  transport: http(RPC.http),
});

// Load all 200 main wallets
interface WalletEntry {
  index: number;
  address: string;
  privateKey: string;
}

const mainWallets: WalletEntry[] = JSON.parse(
  readFileSync(
    new URL("../backend/src/matching/main-wallets.json", import.meta.url).pathname,
    "utf-8",
  ),
);

// Also load extended wallets if they exist
let extendedWallets: WalletEntry[] = [];
try {
  const ext = JSON.parse(
    readFileSync("/Users/qinlinqiu/Desktop/Namespace/scripts/market-maker/wallets.json", "utf-8"),
  );
  extendedWallets = ext.wallets || [];
} catch {
  console.log("[Audit] No extended wallets file found, skipping");
}

const DEPLOYER = "0x5AF11d4784c3739cf2FD51Fdc272ae4957ADf7fE" as Address;
const BATCH_SIZE = 20; // queries per batch to avoid rate limits

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function queryBatch(
  addresses: Address[],
): Promise<{ eth: bigint; weth: bigint; deposit: bigint }[]> {
  // Use multicall for efficiency
  const ethCalls = addresses.map((addr) => ({
    address: WETH_ADDRESS,
    abi: WETH_ABI,
    functionName: "balanceOf" as const,
    args: [addr],
  }));

  const depositCalls = addresses.map((addr) => ({
    address: CONTRACTS.settlementV2,
    abi: SETTLEMENT_V2_ABI,
    functionName: "userDeposits" as const,
    args: [addr],
  }));

  // Get ETH balances individually (no multicall for eth_getBalance)
  const ethBalances = await Promise.all(
    addresses.map((addr) => client.getBalance({ address: addr }).catch(() => 0n)),
  );

  // WETH balances via multicall
  let wethBalances: bigint[];
  try {
    const wethResults = await client.multicall({ contracts: ethCalls });
    wethBalances = wethResults.map((r) => (r.status === "success" ? (r.result as bigint) : 0n));
  } catch {
    wethBalances = addresses.map(() => 0n);
  }

  // SettlementV2 deposits via multicall
  let depositBalances: bigint[];
  try {
    const depResults = await client.multicall({ contracts: depositCalls });
    depositBalances = depResults.map((r) =>
      r.status === "success" ? (r.result as bigint) : 0n,
    );
  } catch {
    depositBalances = addresses.map(() => 0n);
  }

  return addresses.map((_, i) => ({
    eth: ethBalances[i],
    weth: wethBalances[i],
    deposit: depositBalances[i],
  }));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  FULL WALLET BALANCE AUDIT — 60 ETH Investigation");
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── 1. Check deployer + key contracts ──
  console.log("── Key Accounts ──────────────────────────────────────────\n");

  const [deployerBal, settlementWeth, perpPoolValue] = await Promise.all([
    client.getBalance({ address: DEPLOYER }),
    client.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [CONTRACTS.settlementV2],
    }) as Promise<bigint>,
    client.readContract({
      address: CONTRACTS.perpVault,
      abi: PERP_VAULT_ABI,
      functionName: "getPoolValue",
    }) as Promise<bigint>,
  ]);

  console.log(`  Deployer (0x5AF1...):        ${formatEther(deployerBal)} ETH`);
  console.log(`  SettlementV2 WETH balance:   ${formatEther(settlementWeth)} WETH`);
  console.log(`  PerpVault poolValue:         ${formatEther(perpPoolValue)} ETH`);

  // Also check PerpVault raw ETH + WETH
  const [perpVaultEth, perpVaultWeth, vaultEth, vaultWeth] = await Promise.all([
    client.getBalance({ address: CONTRACTS.perpVault }),
    client.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [CONTRACTS.perpVault],
    }) as Promise<bigint>,
    client.getBalance({ address: CONTRACTS.vault }),
    client.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [CONTRACTS.vault],
    }) as Promise<bigint>,
  ]);
  console.log(`  PerpVault raw ETH:           ${formatEther(perpVaultEth)} ETH`);
  console.log(`  PerpVault WETH:              ${formatEther(perpVaultWeth)} WETH`);
  console.log(`  Vault (0xcc4F...) ETH:       ${formatEther(vaultEth)} ETH`);
  console.log(`  Vault (0xcc4F...) WETH:      ${formatEther(vaultWeth)} WETH`);

  // Settlement V1 balance
  const [settlementV1Eth, settlementV1Weth] = await Promise.all([
    client.getBalance({ address: CONTRACTS.settlement }),
    client.readContract({
      address: WETH_ADDRESS,
      abi: WETH_ABI,
      functionName: "balanceOf",
      args: [CONTRACTS.settlement],
    }) as Promise<bigint>,
  ]);
  console.log(`  Settlement V1 (0x1660...) ETH: ${formatEther(settlementV1Eth)} ETH`);
  console.log(`  Settlement V1 (0x1660...) WETH: ${formatEther(settlementV1Weth)} WETH`);

  // Insurance fund, liquidation, funding rate contracts
  const [insuranceEth, liquidationEth, fundingEth] = await Promise.all([
    client.getBalance({ address: CONTRACTS.insuranceFund }),
    client.getBalance({ address: CONTRACTS.liquidation }),
    client.getBalance({ address: CONTRACTS.fundingRate }),
  ]);
  console.log(`  InsuranceFund ETH:           ${formatEther(insuranceEth)} ETH`);
  console.log(`  Liquidation ETH:             ${formatEther(liquidationEth)} ETH`);
  console.log(`  FundingRate ETH:             ${formatEther(fundingEth)} ETH`);

  // TokenFactory balance (bonding curve reserves)
  const tokenFactoryEth = await client.getBalance({ address: CONTRACTS.tokenFactory });
  console.log(`  TokenFactory ETH:            ${formatEther(tokenFactoryEth)} ETH`);

  // ── 2. Scan all 200 main wallets ──
  console.log("\n── Main Wallets (200) ─────────────────────────────────────\n");

  let totalMainEth = 0n;
  let totalMainWeth = 0n;
  let totalMainDeposit = 0n;
  let nonZeroCount = 0;
  const topWallets: { idx: number; addr: string; total: bigint }[] = [];

  for (let batch = 0; batch < mainWallets.length; batch += BATCH_SIZE) {
    const slice = mainWallets.slice(batch, batch + BATCH_SIZE);
    const addrs = slice.map((w) => w.address as Address);

    const results = await queryBatch(addrs);
    await sleep(500); // rate limit protection

    for (let i = 0; i < slice.length; i++) {
      const w = slice[i];
      const r = results[i];
      const total = r.eth + r.weth + r.deposit;

      totalMainEth += r.eth;
      totalMainWeth += r.weth;
      totalMainDeposit += r.deposit;

      if (total > 0n) {
        nonZeroCount++;
        topWallets.push({ idx: w.index, addr: w.address, total });
      }
    }

    const pct = Math.min(100, ((batch + BATCH_SIZE) / mainWallets.length) * 100);
    process.stdout.write(`\r  Scanning... ${pct.toFixed(0)}% (${Math.min(batch + BATCH_SIZE, mainWallets.length)}/${mainWallets.length})`);
  }
  console.log("\n");

  // Sort top wallets by total balance desc
  topWallets.sort((a, b) => (a.total > b.total ? -1 : 1));

  console.log(`  Non-zero wallets: ${nonZeroCount} / ${mainWallets.length}`);
  console.log(`  Total ETH:        ${formatEther(totalMainEth)} ETH`);
  console.log(`  Total WETH:       ${formatEther(totalMainWeth)} WETH`);
  console.log(`  Total Deposits:   ${formatEther(totalMainDeposit)} WETH (in SettlementV2)`);
  console.log(`  MAIN SUBTOTAL:    ${formatEther(totalMainEth + totalMainWeth + totalMainDeposit)} ETH equivalent`);

  if (topWallets.length > 0) {
    console.log("\n  Top 20 wallets by total balance:");
    for (const w of topWallets.slice(0, 20)) {
      console.log(`    [${w.idx.toString().padStart(3)}] ${w.addr.slice(0, 10)}... = ${formatEther(w.total)} ETH`);
    }
  }

  // ── 3. Scan extended wallets (if any) ──
  let totalExtEth = 0n;
  let totalExtWeth = 0n;
  let totalExtDeposit = 0n;

  if (extendedWallets.length > 0) {
    console.log(`\n── Extended Wallets (${extendedWallets.length}) ──────────────────────────────────\n`);

    for (let batch = 0; batch < extendedWallets.length; batch += BATCH_SIZE) {
      const slice = extendedWallets.slice(batch, batch + BATCH_SIZE);
      const addrs = slice.map((w) => w.address as Address);

      const results = await queryBatch(addrs);
      await sleep(500);

      for (let i = 0; i < slice.length; i++) {
        const r = results[i];
        totalExtEth += r.eth;
        totalExtWeth += r.weth;
        totalExtDeposit += r.deposit;
      }

      const pct = Math.min(100, ((batch + BATCH_SIZE) / extendedWallets.length) * 100);
      process.stdout.write(`\r  Scanning... ${pct.toFixed(0)}%`);
    }
    console.log("\n");

    console.log(`  Total ETH:        ${formatEther(totalExtEth)} ETH`);
    console.log(`  Total WETH:       ${formatEther(totalExtWeth)} WETH`);
    console.log(`  Total Deposits:   ${formatEther(totalExtDeposit)} WETH (in SettlementV2)`);
    console.log(`  EXT SUBTOTAL:     ${formatEther(totalExtEth + totalExtWeth + totalExtDeposit)} ETH equivalent`);
  }

  // ── 4. Grand Total ──
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  GRAND TOTAL — Where is the 60 ETH?");
  console.log("═══════════════════════════════════════════════════════════\n");

  const contractsTotal = deployerBal + settlementWeth + perpVaultEth + perpVaultWeth + vaultEth + vaultWeth + settlementV1Eth + settlementV1Weth + insuranceEth + liquidationEth + fundingEth + tokenFactoryEth;
  const walletsTotal = totalMainEth + totalMainWeth + totalMainDeposit + totalExtEth + totalExtWeth + totalExtDeposit;
  const grandTotal = contractsTotal + walletsTotal;

  console.log(`  Deployer wallet:             ${formatEther(deployerBal)} ETH`);
  console.log(`  Contracts total:             ${formatEther(contractsTotal - deployerBal)} ETH`);
  console.log(`    ├─ SettlementV2 WETH:      ${formatEther(settlementWeth)}`);
  console.log(`    ├─ PerpVault:              ${formatEther(perpVaultEth + perpVaultWeth)}`);
  console.log(`    ├─ Vault:                  ${formatEther(vaultEth + vaultWeth)}`);
  console.log(`    ├─ Settlement V1:          ${formatEther(settlementV1Eth + settlementV1Weth)}`);
  console.log(`    ├─ TokenFactory:           ${formatEther(tokenFactoryEth)}`);
  console.log(`    └─ Others:                 ${formatEther(insuranceEth + liquidationEth + fundingEth)}`);
  console.log(`  Main wallets (${mainWallets.length}):         ${formatEther(totalMainEth + totalMainWeth + totalMainDeposit)} ETH`);
  if (extendedWallets.length > 0) {
    console.log(`  Extended wallets (${extendedWallets.length}):       ${formatEther(totalExtEth + totalExtWeth + totalExtDeposit)} ETH`);
  }
  console.log(`  ─────────────────────────────────────`);
  console.log(`  GRAND TOTAL:                 ${formatEther(grandTotal)} ETH`);
  console.log(`  Missing from 60 ETH:         ${formatEther(60_000_000_000_000_000_000n - grandTotal)} ETH`);
  console.log(`  Accounted:                   ${((Number(grandTotal) / 60e18) * 100).toFixed(1)}%`);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  NOTE: 'Missing' ETH was likely spent on:");
  console.log("  1. Gas fees across hundreds of transactions");
  console.log("  2. Bonding curve trades (ETH locked in TokenFactory)");
  console.log("  3. Contract deployments (deployer funded them)");
  console.log("  4. Failed/reverted transactions (gas still consumed)");
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
