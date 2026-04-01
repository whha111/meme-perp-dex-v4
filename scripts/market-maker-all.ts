/**
 * HIGH-FREQUENCY Market Maker — 120+ trades/minute
 *
 * Optimizations:
 * 1. Fire-and-forget: No receipt waits during trading (only setup waits)
 * 2. Manual nonce: Track locally, periodic resync
 * 3. Pre-approve MAX_UINT256: Sells need 1 tx not 2
 * 4. 3 tokens trade in parallel (one loop each)
 * 5. 8 wallets with trend state machine for volatility
 *
 * Usage: cd scripts && npx tsx market-maker-all.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  erc20Abi,
  maxUint256,
  encodeFunctionData,
  type Address,
  type Hex,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { resolve } from "path";
import { bsc, bscTestnet } from "viem/chains";

// ============================================================
// Config — All values from environment variables
// ============================================================

const RPC_URL = process.env.RPC_URL || process.env.MEMEPERP_BLOCKCHAIN_RPC_URL || "https://bsc-dataseed.binance.org/";
const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_MATCHING_ENGINE_URL || "http://localhost:8081";
const CHAIN_ID = parseInt(process.env.CHAIN_ID || process.env.MEMEPERP_BLOCKCHAIN_CHAIN_ID || "56");

// AUDIT-FIX DP-C01/C05: Deployer key from env (optional — can use pre-funded wallets)
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex | undefined;
// EIP-712 verifyingContract MUST match matching engine's SETTLEMENT_ADDRESS (V1)
const SETTLEMENT = process.env.SETTLEMENT_ADDRESS as Address;
const SETTLEMENT_V2 = process.env.SETTLEMENT_V2_ADDRESS as Address;
const WETH_ADDRESS = process.env.WETH_ADDRESS as Address; // WBNB: 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c (mainnet)
const TOKEN_FACTORY = process.env.TOKEN_FACTORY_ADDRESS as Address;

// Validate required env vars
const requiredMM = { SETTLEMENT, SETTLEMENT_V2, WETH_ADDRESS, TOKEN_FACTORY };
const missingMM = Object.entries(requiredMM).filter(([, v]) => !v).map(([k]) => k);
if (missingMM.length > 0) {
  console.error(`🚨 Missing required env vars for market maker: ${missingMM.join(", ")}`);
  console.error("Set these in .env or pass them on the command line.");
  process.exit(1);
}

// Token addresses — loaded dynamically from TokenFactory at startup
// (populated in main() via fetchTokens, or override with MM_TOKENS env var)
let TOKENS: [string, Address][] = [];
const MM_TOKENS_ENV = process.env.MM_TOKENS; // Format: "DOGE:0x...,PEPE:0x...,SHIB:0x..."
if (MM_TOKENS_ENV) {
  TOKENS = MM_TOKENS_ENV.split(",").map((pair) => {
    const [name, addr] = pair.split(":");
    return [name, addr as Address];
  });
}

// Pre-funded wallets from main-wallets.json (no deployer funding needed)
const MAIN_WALLETS_PATH = resolve(import.meta.dir, "../backend/src/matching/main-wallets.json");
const SPOT_WALLET_COUNT = 5;    // Use 5 wallets for spot trading
const PERP_WALLET_COUNT = 3;    // Use 3 wallets for perp trading
const PERP_DEPOSIT_ETH = 0.02;  // Each perp wallet deposits this much into SettlementV2

// Speed knobs
const TRADE_INTERVAL = 500;  // ms between trades per token loop
const TRADE_ETH_MIN = 0.001;
const TRADE_ETH_MAX = 0.005;
const SELL_FRACTION_MIN = 20;  // sell 20-80% of tracked balance
const SELL_FRACTION_MAX = 80;
const PERP_INTERVAL = 30_000;
const PERP_LEVELS = 2;
const STATS_INTERVAL = 60_000;

// ============================================================
// ABI
// ============================================================

const TF_ABI = [
  { inputs: [{ name: "t", type: "address" }, { name: "m", type: "uint256" }], name: "buy", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "t", type: "address" }, { name: "a", type: "uint256" }, { name: "m", type: "uint256" }], name: "sell", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "t", type: "address" }], name: "getCurrentPrice", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "getAllTokens", outputs: [{ type: "address[]" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "t", type: "address" }], name: "tokenInfo", outputs: [{ name: "creator", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "imageUri", type: "string" }, { name: "description", type: "string" }, { name: "isGraduated", type: "bool" }], stateMutability: "view", type: "function" },
] as const;

const EIP712_DOMAIN = { name: "MemePerp" as const, version: "1" as const, chainId: CHAIN_ID, verifyingContract: SETTLEMENT };
const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" }, { name: "token", type: "address" },
    { name: "isLong", type: "bool" }, { name: "size", type: "uint256" },
    { name: "leverage", type: "uint256" }, { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
  ],
} as const;

const WETH_ABI = [
  { inputs: [], name: "deposit", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const SV2_ABI = [
  { inputs: [{ name: "amount", type: "uint256" }], name: "deposit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "user", type: "address" }], name: "userBalances", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const LEV_PREC = 10000n;

// ============================================================
// Viem clients — with timeout
// ============================================================

const transport = http(RPC_URL, { timeout: 30_000 });
const pub = createPublicClient({ chain: CHAIN_ID === 56 ? bsc : bscTestnet, transport });

// ============================================================
// Wallet
// ============================================================

interface W {
  key: Hex; addr: Address;
  acc: ReturnType<typeof privateKeyToAccount>;
  cli: ReturnType<typeof createWalletClient>;
  nonce: number; busy: boolean;
}

function mkW(key: Hex): W {
  const acc = privateKeyToAccount(key);
  return { key, addr: acc.address, acc, cli: createWalletClient({ account: acc, chain: CHAIN_ID === 56 ? bsc : bscTestnet, transport }), nonce: -1, busy: false };
}

// Load pre-funded wallets sorted by balance (will be determined in setup)
let deployer: W;
let wallets: W[] = [];
let perpWs: W[] = [];
const perpNonces = new Map<string, bigint>();

// Stats
let nBuy = 0, nSell = 0, nFail = 0, nPerpOk = 0, nPerpFill = 0;
let t0 = Date.now();

// In-memory token balance tracking (avoids getBalance RPC calls)
// Key: `${walletAddr}:${tokenAddr}`, Value: estimated token balance
const tokenHoldings = new Map<string, bigint>();
function holdKey(w: W, token: Address) { return `${w.addr}:${token}`; }
function getHolding(w: W, token: Address): bigint { return tokenHoldings.get(holdKey(w, token)) || 0n; }
function addHolding(w: W, token: Address, amt: bigint) { tokenHoldings.set(holdKey(w, token), getHolding(w, token) + amt); }
function subHolding(w: W, token: Address, amt: bigint) {
  const cur = getHolding(w, token);
  tokenHoldings.set(holdKey(w, token), cur > amt ? cur - amt : 0n);
}

// ============================================================
// Helpers
// ============================================================

const ts = () => new Date().toISOString().split("T")[1].split(".")[0];
const log = (tag: string, e: string, ...a: any[]) => console.log(`[${ts()}] [${tag}] ${e}`, ...a);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const priceS = (p: bigint) => (Number(p) / 1e18).toExponential(3);

// ============================================================
// Nonce
// ============================================================

async function syncNonce(w: W) {
  try { w.nonce = await pub.getTransactionCount({ address: w.addr, blockTag: "pending" }); }
  catch { /* keep current */ }
}
function bumpNonce(w: W): number { return w.nonce++; }

// ============================================================
// Setup-only helpers (wait for receipts)
// ============================================================

async function fundWait(to: Address, amt: bigint) {
  try {
    const n = bumpNonce(deployer);
    const h = await deployer.cli.sendTransaction({ to, value: amt, nonce: n });
    await pub.waitForTransactionReceipt({ hash: h, timeout: 30_000 });
  } catch {}
}

async function approveWait(w: W, token: Address) {
  try {
    const n = bumpNonce(w);
    const h = await w.cli.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [TOKEN_FACTORY, maxUint256], nonce: n });
    await pub.waitForTransactionReceipt({ hash: h, timeout: 30_000 });
  } catch {}
}

async function buyWait(w: W, token: Address, eth: bigint) {
  try {
    const n = bumpNonce(w);
    const h = await w.cli.writeContract({ address: TOKEN_FACTORY, abi: TF_ABI, functionName: "buy", args: [token, 0n], value: eth, nonce: n });
    await pub.waitForTransactionReceipt({ hash: h, timeout: 30_000 });
  } catch {}
}

// ============================================================
// Fire-and-forget trading ops
// ============================================================

// Pre-encoded calldata + sendTransaction = skip simulation (eth_call) = 2x faster
const GAS_LIMIT = 350_000n; // Fixed gas, no eth_estimateGas needed

async function fireBuy(w: W, token: Address, eth: bigint): Promise<boolean> {
  if (w.busy) return false;
  w.busy = true;
  try {
    const n = bumpNonce(w);
    const data = encodeFunctionData({ abi: TF_ABI, functionName: "buy", args: [token, 0n] });
    await w.cli.sendTransaction({ to: TOKEN_FACTORY, data, value: eth, nonce: n, gas: GAS_LIMIT });
    addHolding(w, token, eth * 1000000n);
    nBuy++;
    return true;
  } catch {
    try { await syncNonce(w); } catch {}
    nFail++;
    return false;
  } finally { w.busy = false; }
}

async function fireSell(w: W, token: Address, amt: bigint): Promise<boolean> {
  if (w.busy || amt === 0n) return false;
  w.busy = true;
  try {
    const n = bumpNonce(w);
    const data = encodeFunctionData({ abi: TF_ABI, functionName: "sell", args: [token, amt, 0n] });
    await w.cli.sendTransaction({ to: TOKEN_FACTORY, data, nonce: n, gas: GAS_LIMIT });
    subHolding(w, token, amt);
    nSell++;
    return true;
  } catch {
    try { await syncNonce(w); } catch {}
    nFail++;
    return false;
  } finally { w.busy = false; }
}

async function getBalance(owner: Address, token: Address): Promise<bigint> {
  try { return await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }); }
  catch { return 0n; }
}

async function getPrice(token: Address): Promise<bigint> {
  try { return await pub.readContract({ address: TOKEN_FACTORY, abi: TF_ABI, functionName: "getCurrentPrice", args: [token] }); }
  catch { return 0n; }
}

async function enginePrice(token: Address): Promise<bigint> {
  try {
    const r = await fetch(`${API_URL}/api/stats/${token.toLowerCase()}`);
    const d = (await r.json()) as any;
    // price is already a 1e18-precision bigint string from the engine — use directly
    const p = BigInt(d.price || "0");
    return p > 0n ? p : 0n;
  } catch { return 0n; }
}

// Real on-chain deposit: ETH → WETH (wrap) → approve → SettlementV2.deposit()
async function depositOnChain(w: W, amt: bigint) {
  try {
    // Step 1: Wrap ETH → WETH
    log("DEPOSIT", "1️⃣", `${w.addr.slice(0, 10)} wrapping ${formatEther(amt)} ETH → WETH`);
    const n1 = bumpNonce(w);
    const h1 = await w.cli.writeContract({ address: WETH_ADDRESS, abi: WETH_ABI, functionName: "deposit", value: amt, nonce: n1 });
    await pub.waitForTransactionReceipt({ hash: h1, timeout: 60_000 });

    // Step 2: Approve SettlementV2 to spend WETH
    log("DEPOSIT", "2️⃣", `${w.addr.slice(0, 10)} approving SettlementV2`);
    const n2 = bumpNonce(w);
    const h2 = await w.cli.writeContract({ address: WETH_ADDRESS, abi: WETH_ABI, functionName: "approve", args: [SETTLEMENT_V2, amt], nonce: n2 });
    await pub.waitForTransactionReceipt({ hash: h2, timeout: 60_000 });

    // Step 3: Deposit into SettlementV2
    log("DEPOSIT", "3️⃣", `${w.addr.slice(0, 10)} depositing ${formatEther(amt)} WETH into SettlementV2`);
    const n3 = bumpNonce(w);
    const h3 = await w.cli.writeContract({ address: SETTLEMENT_V2, abi: SV2_ABI, functionName: "deposit", args: [amt], nonce: n3 });
    await pub.waitForTransactionReceipt({ hash: h3, timeout: 60_000 });

    log("DEPOSIT", "✅", `${w.addr.slice(0, 10)} deposited ${formatEther(amt)} WETH`);
    return true;
  } catch (e: any) {
    log("DEPOSIT", "❌", `${w.addr.slice(0, 10)} failed: ${e.message?.slice(0, 120)}`);
    await syncNonce(w);
    return false;
  }
}

async function submitOrder(w: W, p: { token: Address; isLong: boolean; size: bigint; leverage: bigint; price: bigint; orderType: number }) {
  try {
    const nonce = await (async () => {
      try {
        const r = await fetch(`${API_URL}/api/user/${w.addr.toLowerCase()}/nonce`);
        const d = (await r.json()) as any;
        const api = BigInt(d.nonce || "0");
        const local = perpNonces.get(w.addr.toLowerCase()) || 0n;
        return api > local ? api : local;
      } catch { return perpNonces.get(w.addr.toLowerCase()) || 0n; }
    })();
    const msg = { trader: w.addr, token: p.token, isLong: p.isLong, size: p.size, leverage: p.leverage, price: p.price, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce, orderType: p.orderType };
    const sig = await w.cli.signTypedData({ account: w.acc, domain: EIP712_DOMAIN, types: ORDER_TYPES, primaryType: "Order", message: msg });
    const body = Object.fromEntries(Object.entries(msg).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    const res = await fetch(`${API_URL}/api/order/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, signature: sig }) });
    const result = (await res.json()) as any;
    if (result.success || result.orderId) perpNonces.set(w.addr.toLowerCase(), nonce + 1n);
    return { ok: !!(result.success || result.orderId), fills: result.matches?.length || 0 };
  } catch { return { ok: false, fills: 0 }; }
}

// ============================================================
// SETUP
// ============================================================

async function setup() {
  log("SETUP", "⚡", "═══ HIGH-FREQUENCY MARKET MAKER ═══");

  // Load tokens from TokenFactory if not provided via MM_TOKENS env
  if (TOKENS.length === 0) {
    log("SETUP", "🔍", "Loading tokens from TokenFactory...");
    try {
      const allTokens = await pub.readContract({
        address: TOKEN_FACTORY,
        abi: TF_ABI,
        functionName: "getAllTokens",
      }) as Address[];
      for (const addr of allTokens) {
        try {
          const info = await pub.readContract({
            address: TOKEN_FACTORY,
            abi: TF_ABI,
            functionName: "tokenInfo",
            args: [addr],
          }) as [Address, string, string, string, string, boolean];
          const symbol = info[2] || addr.slice(0, 10);
          TOKENS.push([symbol, addr]);
        } catch {
          TOKENS.push([addr.slice(0, 10), addr]);
        }
      }
      log("SETUP", "✅", `Loaded ${TOKENS.length} tokens: ${TOKENS.map(([n]) => n).join(", ")}`);
    } catch (e: any) {
      log("SETUP", "❌", `Failed to load tokens: ${e.message?.slice(0, 100)}`);
      process.exit(1);
    }
  }

  // Load pre-funded wallets from main-wallets.json (no deployer needed)
  log("SETUP", "📂", `Loading wallets from main-wallets.json`);
  const rawWallets: { address: string; privateKey: string }[] = JSON.parse(readFileSync(MAIN_WALLETS_PATH, "utf-8"));

  // Check balances in parallel batches and sort by richest
  log("SETUP", "💰", `Checking balances of ${rawWallets.length} wallets...`);
  const withBal: { key: Hex; addr: Address; bal: bigint }[] = [];
  for (let i = 0; i < rawWallets.length; i += 20) {
    const batch = rawWallets.slice(i, i + 20);
    const results = await Promise.allSettled(batch.map(w => pub.getBalance({ address: w.address as Address })));
    for (let j = 0; j < batch.length; j++) {
      const bal = results[j].status === "fulfilled" ? (results[j] as PromiseFulfilledResult<bigint>).value : 0n;
      if (bal > parseEther("0.003")) withBal.push({ key: batch[j].privateKey as Hex, addr: batch[j].address as Address, bal });
    }
  }
  withBal.sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0));
  log("SETUP", "💰", `Found ${withBal.length} wallets with > 0.003 ETH (total: ${formatEther(withBal.reduce((s, w) => s + w.bal, 0n))} ETH)`);

  if (withBal.length < SPOT_WALLET_COUNT + PERP_WALLET_COUNT) {
    log("SETUP", "❌", `Need ${SPOT_WALLET_COUNT + PERP_WALLET_COUNT} wallets, only ${withBal.length} available`);
    process.exit(1);
  }

  // Richest → perp (need ETH for on-chain deposit), rest → spot
  perpWs = withBal.slice(0, PERP_WALLET_COUNT).map(w => mkW(w.key));
  wallets = withBal.slice(PERP_WALLET_COUNT, PERP_WALLET_COUNT + SPOT_WALLET_COUNT).map(w => mkW(w.key));
  deployer = perpWs[0]; // Richest wallet is deployer
  log("SETUP", "👛", `${wallets.length} spot + ${perpWs.length} perp wallets (pre-funded, no deployer transfer needed)`);
  for (const w of perpWs) log("SETUP", "💰", `  Perp: ${w.addr.slice(0, 10)} = ${formatEther(withBal.find(x => x.addr === w.addr)?.bal || 0n)} ETH`);

  // Sync all nonces
  const allW = [...wallets, ...perpWs];
  await Promise.all(allW.map(w => syncNonce(w)));

  // Pre-approve all tokens — send all approve txs, then wait in batch
  log("SETUP", "📝", "Pre-approving tokens...");
  const approveHashes: Hash[] = [];
  for (const w of wallets) {
    for (const [, token] of TOKENS) {
      try {
        const n = bumpNonce(w);
        const h = await w.cli.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [TOKEN_FACTORY, maxUint256], nonce: n });
        approveHashes.push(h);
      } catch {}
    }
  }
  log("SETUP", "⏳", `Waiting for ${approveHashes.length} approvals...`);
  await Promise.allSettled(approveHashes.map(h => pub.waitForTransactionReceipt({ hash: h, timeout: 60_000 })));
  log("SETUP", "✅", "Approved");

  // Resync nonces after approvals
  await Promise.all(wallets.map(w => syncNonce(w)));
  await syncNonce(deployer);

  // Seed wallets with tokens — fire-and-forget batch buys
  log("SETUP", "🌱", "Seeding wallets with tokens...");
  const seedHashes: Hash[] = [];
  for (const [, token] of TOKENS) {
    for (const w of wallets) {
      try {
        const n = bumpNonce(w);
        const h = await w.cli.writeContract({ address: TOKEN_FACTORY, abi: TF_ABI, functionName: "buy", args: [token, 0n], value: parseEther("0.001"), nonce: n });
        seedHashes.push(h);
        addHolding(w, token, parseEther("0.001") * 1000000n); // rough estimate
      } catch {}
    }
  }
  log("SETUP", "⏳", `Waiting for ${seedHashes.length} seed buys...`);
  await Promise.allSettled(seedHashes.map(h => pub.waitForTransactionReceipt({ hash: h, timeout: 60_000 })));
  // Sync actual balances into holdings
  for (const [, token] of TOKENS) {
    for (const w of wallets) {
      try {
        const bal = await getBalance(w.addr, token);
        tokenHoldings.set(holdKey(w, token), bal);
      } catch {}
    }
  }
  log("SETUP", "✅", "Seeded (balances synced)");

  // Final nonce sync
  await Promise.all([...wallets, ...perpWs].map(w => syncNonce(w)));

  // On-chain SettlementV2 deposits for perp wallets (3-step: wrap → approve → deposit)
  log("SETUP", "🏦", "On-chain SettlementV2 deposits (3-step chain flow)...");
  for (const w of perpWs) {
    await depositOnChain(w, parseEther(PERP_DEPOSIT_ETH.toString()));
  }

  // Register wallet keys directly for all perp wallets (enables engine MarginBatch to sign on-chain txs)
  // 参考 Hyperliquid approveAgent 模式 — 做市商直接注册私钥，无需 session 派生
  // Session 派生 (keccak256(signature)) 会产生不同的地址，做市商需要用原始私钥
  log("SETUP", "🔑", "Registering wallet keys for perp wallets (direct key mode)...");
  const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
  if (!INTERNAL_KEY) {
    log("SETUP", "⚠️", "INTERNAL_API_KEY not set — skipping wallet key registration (engine margin deposits will fail)");
  } else {
    for (const w of perpWs) {
      try {
        const res = await fetch(`${API_URL}/api/internal/register-wallet-key`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_KEY },
          body: JSON.stringify({ trader: w.addr, privateKey: w.key }),
        });
        const data = (await res.json()) as any;
        if (data.success) {
          log("SETUP", "✅", `Wallet key registered: ${w.addr.slice(0, 10)} (direct key — no session derivation)`);
        } else {
          log("SETUP", "⚠️", `Key registration failed for ${w.addr.slice(0, 10)}: ${data.error}`);
        }
      } catch (e: any) {
        log("SETUP", "❌", `Key registration error for ${w.addr.slice(0, 10)}: ${e.message}`);
      }
    }
  }

  // Wait for engine to detect deposit events via watchContractEvent
  log("SETUP", "⏳", "Waiting 15s for engine to process deposit events...");
  await sleep(15_000);

  // Verify engine credited the deposits
  for (const w of perpWs) {
    try {
      const r = await fetch(`${API_URL}/api/user/${w.addr.toLowerCase()}/balance`);
      const d = (await r.json()) as any;
      const avail = d.availableBalance || d.data?.availableBalance || "0";
      log("SETUP", "💳", `${w.addr.slice(0, 10)} engine balance: ${(Number(avail) / 1e18).toFixed(6)} ETH`);
    } catch {}
  }

  // Reset stats
  nBuy = 0; nSell = 0; nFail = 0; nPerpOk = 0; nPerpFill = 0;
  t0 = Date.now();

  log("SETUP", "🚀", "Ready! Starting high-frequency trading...\n");
}

// ============================================================
// SPOT LOOP — one per token, runs forever
// ============================================================

async function spotLoop(tokenName: string, token: Address) {
  // Trend state machine: cycles between modes for natural volatility
  const modes = ["PUMP", "DUMP", "CHOP", "PUMP", "DUMP", "CHOP", "PUMP", "DUMP"];
  let mi = Math.floor(Math.random() * modes.length);
  let cnt = 0;
  let modeLen = 15 + Math.floor(Math.random() * 25); // 15-40 trades per mode

  while (true) {
    const mode = modes[mi % modes.length];
    const buyProb = mode === "PUMP" ? 0.8 : mode === "DUMP" ? 0.2 : 0.5;

    // Pick non-busy wallet
    const avail = wallets.filter(w => !w.busy);
    if (avail.length === 0) { await sleep(30); continue; }
    const w = pick(avail);

    const isBuy = Math.random() < buyProb;
    if (isBuy) {
      const eth = parseEther(rand(TRADE_ETH_MIN, TRADE_ETH_MAX).toFixed(4));
      // DON'T await — fire and move on immediately
      fireBuy(w, token, eth);
    } else {
      // Use in-memory holdings — NO RPC balance check
      const holding = getHolding(w, token);
      if (holding > 1000n) {
        const fraction = BigInt(Math.floor(rand(SELL_FRACTION_MIN, SELL_FRACTION_MAX)));
        const sellAmt = (holding * fraction) / 100n;
        if (sellAmt > 0n) fireSell(w, token, sellAmt);
      } else {
        // No tokens tracked → buy
        fireBuy(w, token, parseEther(rand(TRADE_ETH_MIN, TRADE_ETH_MAX).toFixed(4)));
      }
    }

    cnt++;
    if (cnt >= modeLen) {
      mi++;
      cnt = 0;
      modeLen = 15 + Math.floor(Math.random() * 25);
    }

    await sleep(TRADE_INTERVAL + Math.floor(rand(-100, 100)));
  }
}

// ============================================================
// PERP LOOP
// ============================================================

async function perpLoop() {
  await sleep(20_000); // Let spot establish prices first

  while (true) {
    for (const [name, token] of TOKENS) {
      try {
        let p = await enginePrice(token);
        if (p === 0n) p = await getPrice(token);
        if (p === 0n) continue;

        const proms: Promise<any>[] = [];
        for (let i = 1; i <= PERP_LEVELS; i++) {
          const w1 = perpWs[((i - 1) * 2) % perpWs.length];
          const w2 = perpWs[((i - 1) * 2 + 1) % perpWs.length];
          const sz = parseEther(rand(0.003, 0.006).toFixed(6));
          const lev = 2n * LEV_PREC;
          const sp = 0.003 + i * 0.005;
          proms.push(
            submitOrder(w1, { token, isLong: true, size: sz, leverage: lev, price: BigInt(Math.floor(Number(p) * (1 - sp))), orderType: 1 }),
            submitOrder(w2, { token, isLong: false, size: sz, leverage: lev, price: BigInt(Math.floor(Number(p) * (1 + sp))), orderType: 1 }),
          );
        }
        // Crossing orders for fills
        const cs = parseEther(rand(0.004, 0.01).toFixed(6));
        const cl = BigInt(Math.floor(rand(2, 5))) * LEV_PREC;
        proms.push(
          submitOrder(deployer, { token, isLong: true, size: cs, leverage: cl, price: BigInt(Math.floor(Number(p) * 1.03)), orderType: 1 }),
          submitOrder(deployer, { token, isLong: false, size: cs, leverage: cl, price: BigInt(Math.floor(Number(p) * 0.97)), orderType: 1 }),
        );

        const results = await Promise.all(proms);
        let placed = 0, fills = 0;
        for (const r of results) { if (r.ok) { placed++; nPerpOk++; } fills += r.fills || 0; nPerpFill += r.fills || 0; }
        log("PERP", "📋", `${name}: ${placed} placed, ${fills} fills`);
      } catch {}
    }
    await sleep(PERP_INTERVAL);
  }
}

// ============================================================
// NONCE REPAIR — every 20s
// ============================================================

async function nonceLoop() {
  let syncCount = 0;
  while (true) {
    await sleep(20_000);
    await Promise.allSettled([deployer, ...wallets].map(w => syncNonce(w)));
    syncCount++;
    // Every 3rd sync (~60s), also refresh token holdings from chain
    if (syncCount % 3 === 0) {
      for (const [, token] of TOKENS) {
        for (const w of wallets) {
          try {
            const bal = await getBalance(w.addr, token);
            tokenHoldings.set(holdKey(w, token), bal);
          } catch {}
        }
      }
    }
  }
}

// ============================================================
// STATS — every 60s
// ============================================================

async function statsLoop() {
  const startP: Record<string, bigint> = {};
  for (const [n, t] of TOKENS) startP[n] = await getPrice(t);

  while (true) {
    await sleep(STATS_INTERVAL);
    const sec = (Date.now() - t0) / 1000;
    const total = nBuy + nSell;
    const tpm = Math.round(total / (sec / 60));
    log("STATS", "📊", `${total} trades in ${Math.round(sec)}s = ${tpm}/min | Buy:${nBuy} Sell:${nSell} Fail:${nFail}`);
    log("STATS", "📋", `Perp: ${nPerpOk} placed, ${nPerpFill} fills`);
    for (const [name, token] of TOKENS) {
      const p = await getPrice(token);
      const s = startP[name];
      const chg = s > 0n ? ((Number(p) - Number(s)) / Number(s) * 100).toFixed(1) : "?";
      log("STATS", "💹", `${name}: ${priceS(p)} (${Number(chg) >= 0 ? "+" : ""}${chg}%)`);
    }
    console.log();
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  ⚡ HIGH-FREQUENCY MARKET MAKER (120+ tx/min) ⚡  ║");
  console.log("║  Fire-and-forget • Parallel • Trend cycles       ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  await setup();

  // Launch all loops in parallel — they run forever
  await Promise.all([
    ...TOKENS.map(([name, addr]) => spotLoop(name, addr)),
    perpLoop(),
    nonceLoop(),
    statsLoop(),
  ]);
}

(async () => {
  while (true) {
    try { await main(); }
    catch (e: any) {
      log("MAIN", "💀", `Crashed: ${e.message?.slice(0, 100)}`);
      log("MAIN", "🔄", "Restarting in 5s...");
      await sleep(5_000);
    }
  }
})();
