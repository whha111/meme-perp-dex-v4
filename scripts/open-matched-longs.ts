/**
 * Open matched long positions: wallet[0-4] place limit shorts, wallet[5-9] place market longs
 * This ensures orders actually match and create positions.
 *
 * Usage: cd scripts && bun run open-matched-longs.ts
 */
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther,
  erc20Abi, maxUint256, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { readFileSync } from "fs";
import { resolve } from "path";

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

const FUND_PER_WALLET = parseEther("0.12");
const DEPOSIT_AMOUNT = parseEther("0.1");

const walletsPath = resolve(import.meta.dir, "../backend/src/matching/main-wallets.json");
const allWallets = JSON.parse(readFileSync(walletsPath, "utf-8")) as { address: string; privateKey: string }[];
const wallets = allWallets.slice(0, 10).map(w => ({
  account: privateKeyToAccount(w.privateKey as Hex),
  address: w.address as Address,
}));

const publicClient = createPublicClient({ chain: bscTestnet, transport: http(RPC_URL) });
const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
const deployerClient = createWalletClient({ account: deployerAccount, chain: bscTestnet, transport: http(RPC_URL) });

const EIP712_DOMAIN = { name: "MemePerp" as const, version: "1" as const, chainId: CHAIN_ID, verifyingContract: SETTLEMENT_V1 };
const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" }, { name: "token", type: "address" },
    { name: "isLong", type: "bool" }, { name: "size", type: "uint256" },
    { name: "leverage", type: "uint256" }, { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
  ],
};

async function getNonce(addr: Address): Promise<bigint> {
  const res = await fetch(`${API_URL}/api/user/${addr}/nonce`);
  const json = await res.json() as any;
  return BigInt(json.nonce || "0");
}

async function getCurrentPrice(): Promise<bigint> {
  const res = await fetch(`${API_URL}/api/v1/market/tickers`);
  const json = await res.json() as any;
  return BigInt(json.data?.[0]?.last || "0");
}

async function submitOrder(wallet: typeof wallets[0], params: {
  isLong: boolean; size: bigint; leverage: bigint; price: bigint; nonce: bigint; orderType: number;
}) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const message = {
    trader: wallet.address, token: TOKEN1, isLong: params.isLong,
    size: params.size, leverage: params.leverage, price: params.price,
    deadline, nonce: params.nonce, orderType: params.orderType,
  };
  const wc = createWalletClient({ account: wallet.account, chain: bscTestnet, transport: http(RPC_URL) });
  const signature = await wc.signTypedData({ account: wallet.account, domain: EIP712_DOMAIN, types: ORDER_TYPES, primaryType: "Order", message });
  const body = Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  const res = await fetch(`${API_URL}/api/order/submit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, signature }),
  });
  return await res.json() as any;
}

async function cancelAllOrders(addr: Address) {
  try {
    const res = await fetch(`${API_URL}/api/user/${addr}/orders/cancel-all`, { method: "POST" });
    return await res.json();
  } catch { return null; }
}

async function ensureFundedAndDeposited(w: typeof wallets[0]) {
  // Fund
  const bal = await publicClient.getBalance({ address: w.address });
  if (bal < FUND_PER_WALLET) {
    const tx = await deployerClient.sendTransaction({ to: w.address, value: FUND_PER_WALLET });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`  Funded ${w.address}`);
  }
  // Check SV2 deposit
  const sv2Bal = await publicClient.readContract({
    address: SETTLEMENT_V2,
    abi: [{ inputs: [{ name: "", type: "address" }], name: "userDeposits", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }] as const,
    functionName: "userDeposits", args: [w.address],
  });
  if (sv2Bal < DEPOSIT_AMOUNT) {
    const wc = createWalletClient({ account: w.account, chain: bscTestnet, transport: http(RPC_URL) });
    const wrapTx = await wc.writeContract({ address: WBNB, abi: [{ inputs: [], name: "deposit", outputs: [], stateMutability: "payable", type: "function" }] as const, functionName: "deposit", value: DEPOSIT_AMOUNT });
    await publicClient.waitForTransactionReceipt({ hash: wrapTx });
    const appTx = await wc.writeContract({ address: WBNB, abi: erc20Abi, functionName: "approve", args: [SETTLEMENT_V2, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash: appTx });
    const depTx = await wc.writeContract({ address: SETTLEMENT_V2, abi: [{ inputs: [{ name: "amount", type: "uint256" }], name: "deposit", outputs: [], stateMutability: "nonpayable", type: "function" }] as const, functionName: "deposit", args: [DEPOSIT_AMOUNT] });
    await publicClient.waitForTransactionReceipt({ hash: depTx });
    console.log(`  Deposited ${formatEther(DEPOSIT_AMOUNT)} BNB for ${w.address}`);
  }
}

async function main() {
  console.log("=== Open 5 Matched Long Positions ===\n");

  const currentPrice = await getCurrentPrice();
  console.log(`Current price: ${currentPrice}\n`);
  if (currentPrice === 0n) { console.error("No price!"); process.exit(1); }

  // Cancel previous pending orders for wallets 0-4
  console.log("--- Cancel old pending orders ---");
  for (let i = 0; i < 5; i++) {
    await cancelAllOrders(wallets[i].address);
  }

  // Use wallets 0-4 for SHORT limit orders (counterparty), wallets 5-9 for LONG market orders
  const shortWallets = wallets.slice(0, 5);
  const longWallets = wallets.slice(5, 10);

  console.log("\n--- Funding & depositing all 10 wallets ---");
  for (const w of wallets) {
    await ensureFundedAndDeposited(w);
  }

  console.log("\nWaiting 12s for matching engine to sync deposits...");
  await new Promise(r => setTimeout(r, 12000));

  // Order configs - 5 pairs
  const pairs = [
    { size: parseEther("0.01"), leverage: 100000n, label: "10x" },
    { size: parseEther("0.015"), leverage: 50000n, label: "5x" },
    { size: parseEther("0.02"), leverage: 30000n, label: "3x" },
    { size: parseEther("0.01"), leverage: 70000n, label: "7x" },
    { size: parseEther("0.025"), leverage: 20000n, label: "2x" },
  ];

  // Step 1: Place SHORT limit orders at current price (these become maker orders)
  console.log("\n--- Place SHORT limit orders (counterparty) ---");
  for (let i = 0; i < 5; i++) {
    const w = shortWallets[i];
    const cfg = pairs[i];
    const nonce = await getNonce(w.address);
    console.log(`  Short wallet ${i}: ${w.address} → Short ${formatEther(cfg.size)} BNB @ ${cfg.label}, price=${currentPrice}`);
    const result = await submitOrder(w, {
      isLong: false, size: cfg.size, leverage: cfg.leverage,
      price: currentPrice, nonce, orderType: 1, // LIMIT
    });
    console.log(`    ${result.success || result.code === "0" ? "✅" : "❌"} ${JSON.stringify(result).slice(0, 120)}`);
    await new Promise(r => setTimeout(r, 500));
  }

  await new Promise(r => setTimeout(r, 2000));

  // Step 2: Place LONG market orders (these match against the shorts)
  console.log("\n--- Place LONG market orders ---");
  for (let i = 0; i < 5; i++) {
    const w = longWallets[i];
    const cfg = pairs[i];
    const nonce = await getNonce(w.address);
    console.log(`  Long wallet ${i}: ${w.address} → Long ${formatEther(cfg.size)} BNB @ ${cfg.label}`);
    const result = await submitOrder(w, {
      isLong: true, size: cfg.size, leverage: cfg.leverage,
      price: 0n, nonce, orderType: 0, // MARKET
    });
    console.log(`    ${result.success || result.code === "0" ? "✅" : "❌"} ${JSON.stringify(result).slice(0, 120)}`);
    await new Promise(r => setTimeout(r, 1000));
  }

  await new Promise(r => setTimeout(r, 3000));

  // Check positions for long wallets
  console.log("\n=== Positions (Long wallets) ===");
  for (let i = 0; i < 5; i++) {
    const w = longWallets[i];
    const posRes = await fetch(`${API_URL}/api/user/${w.address}/positions`);
    const pos = await posRes.json() as any;
    const positions = Array.isArray(pos) ? pos : (pos.data || []);
    if (positions.length > 0) {
      for (const p of positions) {
        console.log(`  ✅ ${w.address}: LONG size=${p.size} leverage=${p.leverage} entry=${p.entryPrice}`);
      }
    } else {
      console.log(`  ⏳ ${w.address}: no positions yet`);
    }
  }
}

main().catch(console.error);
