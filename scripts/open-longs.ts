/**
 * Open long positions using 5 wallets
 *
 * Steps per wallet:
 * 1. Deployer sends BNB to wallet
 * 2. Wallet wraps BNB → WBNB
 * 3. Wallet approves + deposits WBNB → SettlementV2
 * 4. Wait for matching engine to detect deposits
 * 5. Each wallet places a long market order
 *
 * Usage: cd scripts && bun run open-longs.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  erc20Abi,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { readFileSync } from "fs";
import { resolve } from "path";

// ============================================================
// Config — all values from env vars or deployments JSON
// ============================================================
const deployments = JSON.parse(readFileSync(resolve(__dirname, "../deployments/97.json"), "utf-8"));

const RPC_URL = process.env.RPC_URL || process.env.MEMEPERP_BLOCKCHAIN_RPC_URL;
if (!RPC_URL) throw new Error("Set RPC_URL or MEMEPERP_BLOCKCHAIN_RPC_URL env var");
const API_URL = process.env.API_URL || "http://localhost:8081";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || String(deployments.chainId));

const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY || process.env.MEMEPERP_BLOCKCHAIN_PRIVATE_KEY) as Hex;
if (!DEPLOYER_KEY) throw new Error("Set DEPLOYER_PRIVATE_KEY env var");
const SETTLEMENT_V2 = (deployments.contracts.SettlementV2) as Address;
const SETTLEMENT_V1 = (deployments.contracts.Settlement) as Address;
const WBNB = (deployments.contracts.WBNB) as Address;
const TOKEN1 = (process.env.TOKEN1_ADDRESS || "0x2a69B7aEcc3c0860840B469E5322359bc6c3d612") as Address;

const FUND_PER_WALLET = parseEther("0.12"); // 0.12 BNB per wallet (0.1 deposit + gas)
const DEPOSIT_AMOUNT = parseEther("0.1");   // 0.1 BNB deposit to SettlementV2
const WALLET_COUNT = 5;

// ============================================================
// Load wallets
// ============================================================
const walletsPath = resolve(import.meta.dir, "../backend/src/matching/main-wallets.json");
const allWallets = JSON.parse(readFileSync(walletsPath, "utf-8")) as { index: number; address: string; privateKey: string }[];
const wallets = allWallets.slice(0, WALLET_COUNT).map(w => ({
  account: privateKeyToAccount(w.privateKey as Hex),
  address: w.address as Address,
  key: w.privateKey as Hex,
}));

// ============================================================
// Clients
// ============================================================
const publicClient = createPublicClient({ chain: bscTestnet, transport: http(RPC_URL) });
const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
const deployerClient = createWalletClient({ account: deployerAccount, chain: bscTestnet, transport: http(RPC_URL) });

// ABIs
const WBNB_ABI = [
  { inputs: [], name: "deposit", outputs: [], stateMutability: "payable", type: "function" },
  ...erc20Abi,
] as const;

const SV2_ABI = [
  { inputs: [{ name: "amount", type: "uint256" }], name: "deposit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "", type: "address" }], name: "userDeposits", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

// EIP-712
const EIP712_DOMAIN = { name: "MemePerp" as const, version: "1" as const, chainId: CHAIN_ID, verifyingContract: SETTLEMENT_V1 };
const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "token", type: "address" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "leverage", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
  ],
};

// ============================================================
// Helpers
// ============================================================
async function getNonce(addr: Address): Promise<bigint> {
  const res = await fetch(`${API_URL}/api/user/${addr}/nonce`);
  const json = await res.json() as any;
  return BigInt(json.nonce || "0");
}

async function submitOrder(wallet: typeof wallets[0], params: {
  size: bigint; leverage: bigint; nonce: bigint;
}) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const message = {
    trader: wallet.address,
    token: TOKEN1,
    isLong: true,
    size: params.size,
    leverage: params.leverage,
    price: 0n,
    deadline,
    nonce: params.nonce,
    orderType: 0,
  };

  const wc = createWalletClient({ account: wallet.account, chain: bscTestnet, transport: http(RPC_URL) });
  const signature = await wc.signTypedData({
    account: wallet.account,
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message,
  });

  const body = Object.fromEntries(
    Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])
  );

  const res = await fetch(`${API_URL}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, signature }),
  });
  return await res.json() as any;
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log("=== Open Longs with 5 Wallets ===\n");

  const deployerBal = await publicClient.getBalance({ address: deployerAccount.address });
  console.log(`Deployer: ${deployerAccount.address}`);
  console.log(`Deployer BNB: ${formatEther(deployerBal)}`);
  const totalNeeded = FUND_PER_WALLET * BigInt(WALLET_COUNT);
  console.log(`Total needed: ${formatEther(totalNeeded)} BNB (${WALLET_COUNT} × ${formatEther(FUND_PER_WALLET)})\n`);

  if (deployerBal < totalNeeded) {
    console.error(`❌ Deployer needs at least ${formatEther(totalNeeded)} BNB, has ${formatEther(deployerBal)}`);
    process.exit(1);
  }

  // Step 1: Fund wallets
  console.log("--- Step 1: Fund wallets ---");
  for (const w of wallets) {
    const bal = await publicClient.getBalance({ address: w.address });
    if (bal >= FUND_PER_WALLET) {
      console.log(`  ${w.address}: already has ${formatEther(bal)} BNB, skipping`);
      continue;
    }
    const tx = await deployerClient.sendTransaction({ to: w.address, value: FUND_PER_WALLET });
    console.log(`  ${w.address}: sent ${formatEther(FUND_PER_WALLET)} BNB → ${tx}`);
    await publicClient.waitForTransactionReceipt({ hash: tx });
  }
  console.log("  ✅ All wallets funded\n");

  // Step 2: Each wallet wraps + approves + deposits
  console.log("--- Step 2: Wrap + Approve + Deposit ---");
  for (const w of wallets) {
    const sv2Bal = await publicClient.readContract({
      address: SETTLEMENT_V2, abi: SV2_ABI, functionName: "userDeposits", args: [w.address],
    });
    if (sv2Bal >= DEPOSIT_AMOUNT) {
      console.log(`  ${w.address}: already has ${formatEther(sv2Bal)} in SV2, skipping`);
      continue;
    }

    const wc = createWalletClient({ account: w.account, chain: bscTestnet, transport: http(RPC_URL) });

    // Wrap
    const wrapTx = await wc.writeContract({ address: WBNB, abi: WBNB_ABI, functionName: "deposit", value: DEPOSIT_AMOUNT });
    await publicClient.waitForTransactionReceipt({ hash: wrapTx });

    // Approve
    const appTx = await wc.writeContract({ address: WBNB, abi: erc20Abi, functionName: "approve", args: [SETTLEMENT_V2, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: appTx });

    // Deposit
    const depTx = await wc.writeContract({ address: SETTLEMENT_V2, abi: SV2_ABI, functionName: "deposit", args: [DEPOSIT_AMOUNT] });
    await publicClient.waitForTransactionReceipt({ hash: depTx });

    console.log(`  ${w.address}: deposited ${formatEther(DEPOSIT_AMOUNT)} BNB ✅`);
  }
  console.log();

  // Step 3: Wait for matching engine to detect deposits
  console.log("--- Step 3: Waiting 15s for matching engine to detect deposits ---");
  await new Promise(r => setTimeout(r, 15000));

  // Verify balances
  for (const w of wallets) {
    const res = await fetch(`${API_URL}/api/user/${w.address}/balance`);
    const bal = await res.json() as any;
    console.log(`  ${w.address}: ${bal.display?.availableBalance || "BNB 0"}`);
  }
  console.log();

  // Step 4: Place long orders
  console.log("--- Step 4: Place Long Orders ---");
  const orderConfigs = [
    { size: parseEther("0.01"), leverage: 100000n, label: "10x" },  // 10x
    { size: parseEther("0.015"), leverage: 50000n,  label: "5x" },  // 5x
    { size: parseEther("0.02"), leverage: 30000n,  label: "3x" },  // 3x
    { size: parseEther("0.01"), leverage: 70000n,  label: "7x" },  // 7x
    { size: parseEther("0.025"), leverage: 20000n,  label: "2x" },  // 2x
  ];

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const cfg = orderConfigs[i];
    const nonce = await getNonce(w.address);

    console.log(`  Wallet ${i}: ${w.address} → Long ${formatEther(cfg.size)} BNB @ ${cfg.label}`);
    try {
      const result = await submitOrder(w, { size: cfg.size, leverage: cfg.leverage, nonce });
      if (result.success || result.code === "0") {
        console.log(`    ✅ Order placed! ID: ${result.data?.orderId || result.orderId || "ok"}`);
      } else {
        console.log(`    ❌ Failed: ${JSON.stringify(result)}`);
      }
    } catch (e: any) {
      console.log(`    ❌ Error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log();
  console.log("=== Done! Checking positions ===");
  for (const w of wallets) {
    const posRes = await fetch(`${API_URL}/api/user/${w.address}/positions`);
    const pos = await posRes.json() as any;
    const positions = Array.isArray(pos) ? pos : (pos.data || []);
    if (positions.length > 0) {
      for (const p of positions) {
        console.log(`  ${w.address}: ${p.isLong ? "LONG" : "SHORT"} size=${p.size} leverage=${p.leverage} entry=${p.entryPrice}`);
      }
    } else {
      console.log(`  ${w.address}: no positions (order may be pending)`);
    }
  }
}

main().catch(console.error);
