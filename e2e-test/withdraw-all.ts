/**
 * 合约 BNB 提取脚本
 *
 * 从所有合约中提取测试 BNB 到 Deployer 地址
 *
 * 可提取:
 * 1. Liquidation.withdrawInsuranceFund() — 立即
 * 2. PerpVault.requestEmergencyRescue() — 48h 后 executeEmergencyRescue()
 * 3. TokenFactory — 通过卖代币取回 bonding curve BNB
 * 4. SettlementV2 — 只能用户自己提款 (Merkle proof)
 * 5. Deployer EOA — 已在 deployer 手上
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  type Address,
  type Hex,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

// ============ Config ============
const RPC_URL = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
const DEPLOYER_PK = "0x4698c351c4aead4844a41399b035e1177535db94a5418a79df07b7f0bf158776" as Hex;
const DEPLOYER = "0xAecb229194314999E396468eb091b42E44Bc3c8c" as Address;

const CONTRACTS = {
  TokenFactory: "0xB40541Ff9f24883149fc6F9CD1021dB9C7BCcB83" as Address,
  SettlementV2: "0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b" as Address,
  PerpVault: "0xF0db95eD967318BC7757A671399f0D4FFC853e05" as Address,
  Liquidation: "0x5587Cf6b94E52e2Da0B8412381fcdfe4D39CA562" as Address,
  InsuranceFund: "0xa20488Ed2CEABD0e6441496c2F4F5fBA18F4cE83" as Address,
  WBNB: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as Address,
};

// ============ ABI fragments ============
const LIQUIDATION_ABI = [
  {
    name: "withdrawInsuranceFund",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

const PERPVAULT_ABI = [
  {
    name: "requestEmergencyRescue",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "executeEmergencyRescue",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [],
    outputs: [],
  },
  {
    name: "pendingRescue",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "executeAfter", type: "uint256" },
        ],
      },
    ],
  },
] as const;

const INSURANCE_ABI = [
  {
    name: "emergencyWithdrawETH",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const WBNB_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

const TOKEN_FACTORY_ABI = [
  {
    name: "claimPlatformEarnings",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [],
    outputs: [],
  },
  {
    name: "platformEarnings",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "getAllTokens",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    name: "getPoolState",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "virtualETHReserve", type: "uint256" },
          { name: "virtualTokenReserve", type: "uint256" },
          { name: "realETHReserve", type: "uint256" },
          { name: "realTokenReserve", type: "uint256" },
          { name: "tokenAddress", type: "address" },
          { name: "creator", type: "address" },
          { name: "isActive", type: "bool" },
          { name: "isGraduated", type: "bool" },
          { name: "totalSupply", type: "uint256" },
          { name: "lastTradeTime", type: "uint256" },
          { name: "perpEnabled", type: "bool" },
          { name: "graduationFailed", type: "bool" },
          { name: "graduationAttempts", type: "uint256" },
        ],
      },
    ],
  },
] as const;

// ============ Setup ============
const account = privateKeyToAccount(DEPLOYER_PK);
const client = createPublicClient({ chain: bscTestnet, transport: http(RPC_URL) });
const wallet = createWalletClient({ account, chain: bscTestnet, transport: http(RPC_URL) });

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTx(description: string, fn: () => Promise<Hex>) {
  try {
    console.log(`  ⏳ ${description}...`);
    const hash = await fn();
    console.log(`  ✅ ${description} — tx: ${hash}`);
    // Wait for confirmation
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
    if (receipt.status === "reverted") {
      console.log(`  ❌ ${description} — REVERTED`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.log(`  ❌ ${description} — ERROR: ${e.message?.slice(0, 120)}`);
    return false;
  }
}

// ============ Main ============
async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  BNB Withdrawal Script — BSC Testnet");
  console.log("═══════════════════════════════════════════════\n");

  const deployerBNBBefore = await client.getBalance({ address: DEPLOYER });
  console.log(`Deployer BNB before: ${formatEther(deployerBNBBefore)}\n`);

  let totalWithdrawn = 0n;

  // ─── 1. Liquidation: withdrawInsuranceFund ───
  console.log("━━━ 1. Liquidation Contract ━━━");
  const liqBalance = await client.getBalance({ address: CONTRACTS.Liquidation });
  console.log(`  Balance: ${formatEther(liqBalance)} BNB`);
  if (liqBalance > 0n) {
    const ok = await sendTx(`Withdraw ${formatEther(liqBalance)} BNB from Liquidation`, () =>
      wallet.writeContract({
        address: CONTRACTS.Liquidation,
        abi: LIQUIDATION_ABI,
        functionName: "withdrawInsuranceFund",
        args: [liqBalance],
      })
    );
    if (ok) totalWithdrawn += liqBalance;
  }

  // ─── 2. InsuranceFund: emergencyWithdrawETH ───
  console.log("\n━━━ 2. InsuranceFund Contract ━━━");
  const insBalance = await client.getBalance({ address: CONTRACTS.InsuranceFund });
  console.log(`  Balance: ${formatEther(insBalance)} BNB`);
  if (insBalance > 0n) {
    const ok = await sendTx(`Withdraw ${formatEther(insBalance)} BNB from InsuranceFund`, () =>
      wallet.writeContract({
        address: CONTRACTS.InsuranceFund,
        abi: INSURANCE_ABI,
        functionName: "emergencyWithdrawETH",
        args: [DEPLOYER, insBalance],
      })
    );
    if (ok) totalWithdrawn += insBalance;
  }

  // ─── 3. PerpVault: requestEmergencyRescue (48h timelock) ───
  console.log("\n━━━ 3. PerpVault Contract (48h Timelock) ━━━");
  const pvBalance = await client.getBalance({ address: CONTRACTS.PerpVault });
  console.log(`  Balance: ${formatEther(pvBalance)} BNB`);

  // Check pending rescue
  const pending = await client.readContract({
    address: CONTRACTS.PerpVault,
    abi: PERPVAULT_ABI,
    functionName: "pendingRescue",
  });
  const pendingTo = (pending as any).to || (pending as any)[0];
  const pendingAmount = (pending as any).amount || (pending as any)[1];
  const pendingAfter = (pending as any).executeAfter || (pending as any)[2];

  if (pendingAmount > 0n) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now >= pendingAfter) {
      console.log(`  ⏰ Pending rescue is READY to execute! Amount: ${formatEther(pendingAmount)} BNB`);
      const ok = await sendTx("Execute PerpVault emergency rescue", () =>
        wallet.writeContract({
          address: CONTRACTS.PerpVault,
          abi: PERPVAULT_ABI,
          functionName: "executeEmergencyRescue",
        })
      );
      if (ok) totalWithdrawn += pendingAmount;
    } else {
      const hoursLeft = Number(pendingAfter - now) / 3600;
      console.log(`  ⏳ Pending rescue exists, ${hoursLeft.toFixed(1)}h remaining`);
      console.log(`  Amount: ${formatEther(pendingAmount)} BNB, executeAfter: ${new Date(Number(pendingAfter) * 1000).toISOString()}`);
    }
  } else if (pvBalance > 0n) {
    // Request new rescue
    const ok = await sendTx(`Request emergency rescue for ${formatEther(pvBalance)} BNB (48h timelock)`, () =>
      wallet.writeContract({
        address: CONTRACTS.PerpVault,
        abi: PERPVAULT_ABI,
        functionName: "requestEmergencyRescue",
        args: [DEPLOYER, pvBalance],
      })
    );
    if (ok) {
      const newPending = await client.readContract({
        address: CONTRACTS.PerpVault,
        abi: PERPVAULT_ABI,
        functionName: "pendingRescue",
      });
      const execAfter = (newPending as any).executeAfter || (newPending as any)[2];
      console.log(`  📅 Can execute after: ${new Date(Number(execAfter) * 1000).toISOString()}`);
    }
  }

  // ─── 4. TokenFactory: claim platform earnings + check pools ───
  console.log("\n━━━ 4. TokenFactory Contract ━━━");
  const tfBalance = await client.getBalance({ address: CONTRACTS.TokenFactory });
  console.log(`  Total Balance: ${formatEther(tfBalance)} BNB`);

  const platformEarnings = await client.readContract({
    address: CONTRACTS.TokenFactory,
    abi: TOKEN_FACTORY_ABI,
    functionName: "platformEarnings",
  }) as bigint;

  if (platformEarnings > 0n) {
    const ok = await sendTx(`Claim ${formatEther(platformEarnings)} BNB platform earnings`, () =>
      wallet.writeContract({
        address: CONTRACTS.TokenFactory,
        abi: TOKEN_FACTORY_ABI,
        functionName: "claimPlatformEarnings",
      })
    );
    if (ok) totalWithdrawn += platformEarnings;
  } else {
    console.log("  platformEarnings = 0");
  }

  // Show per-token pool state
  try {
    const tokens = await client.readContract({
      address: CONTRACTS.TokenFactory,
      abi: TOKEN_FACTORY_ABI,
      functionName: "getAllTokens",
    }) as Address[];

    console.log(`  Tokens in factory: ${tokens.length}`);
    let totalRealETH = 0n;
    for (const token of tokens) {
      const pool = await client.readContract({
        address: CONTRACTS.TokenFactory,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getPoolState",
        args: [token],
      }) as any;
      const realETH = pool.realETHReserve || pool[2];
      if (realETH > 0n) {
        const graduated = pool.isGraduated || pool[7];
        const active = pool.isActive || pool[6];
        console.log(`    ${(token as string).slice(0,10)}... realETH: ${formatEther(realETH)} BNB (active=${active}, graduated=${graduated})`);
        totalRealETH += realETH;
      }
    }
    console.log(`  Total locked in bonding curves: ${formatEther(totalRealETH)} BNB`);
    console.log("  ⚠️  Cannot withdraw — BNB is locked in active bonding curves");
    console.log("  ℹ️  To extract: sell tokens back to curves, or trigger graduation failure");
  } catch (e: any) {
    console.log(`  Failed to read tokens: ${e.message?.slice(0, 80)}`);
  }

  // ─── 5. SettlementV2: WBNB (no admin withdrawal) ───
  console.log("\n━━━ 5. SettlementV2 Contract ━━━");
  const sv2WBNB = await client.readContract({
    address: CONTRACTS.WBNB,
    abi: WBNB_ABI,
    functionName: "balanceOf",
    args: [CONTRACTS.SettlementV2],
  }) as bigint;
  console.log(`  WBNB Balance: ${formatEther(sv2WBNB)} WBNB`);
  console.log("  ⚠️  No admin withdrawal function — only users can withdraw via Merkle proof");

  // ─── 6. Deployer WBNB → unwrap to BNB ───
  console.log("\n━━━ 6. Deployer WBNB Unwrap ━━━");
  const deployerWBNB = await client.readContract({
    address: CONTRACTS.WBNB,
    abi: WBNB_ABI,
    functionName: "balanceOf",
    args: [DEPLOYER],
  }) as bigint;
  console.log(`  Deployer WBNB: ${formatEther(deployerWBNB)}`);
  if (deployerWBNB > 0n) {
    const ok = await sendTx(`Unwrap ${formatEther(deployerWBNB)} WBNB → BNB`, () =>
      wallet.writeContract({
        address: CONTRACTS.WBNB,
        abi: WBNB_ABI,
        functionName: "withdraw",
        args: [deployerWBNB],
      })
    );
    if (ok) totalWithdrawn += deployerWBNB;
  }

  // ─── Final Summary ───
  console.log("\n═══════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════\n");

  const deployerBNBAfter = await client.getBalance({ address: DEPLOYER });
  const pvBalanceAfter = await client.getBalance({ address: CONTRACTS.PerpVault });

  console.log("┌─────────────────────────┬──────────────┬─────────────┐");
  console.log("│ Source                  │ Amount (BNB) │ Status      │");
  console.log("├─────────────────────────┼──────────────┼─────────────┤");
  console.log(`│ Deployer EOA            │ ${formatEther(deployerBNBAfter).padStart(12)} │ ✅ In hand  │`);
  console.log(`│ PerpVault (48h lock)    │ ${formatEther(pvBalanceAfter).padStart(12)} │ ⏳ Pending  │`);
  console.log(`│ TokenFactory (curves)   │ ${formatEther(tfBalance).padStart(12)} │ 🔒 Locked   │`);
  console.log(`│ SettlementV2 (WBNB)     │ ${formatEther(sv2WBNB).padStart(12)} │ 🔒 Users    │`);
  console.log("└─────────────────────────┴──────────────┴─────────────┘");
  console.log(`\nTotal withdrawn this run: ${formatEther(totalWithdrawn)} BNB`);
  console.log(`Deployer final BNB balance: ${formatEther(deployerBNBAfter)} BNB`);

  const grandTotal = deployerBNBAfter + pvBalanceAfter + tfBalance + sv2WBNB;
  console.log(`\nGrand total across all contracts: ${formatEther(grandTotal)} BNB equivalent`);
}

main().catch(console.error);
