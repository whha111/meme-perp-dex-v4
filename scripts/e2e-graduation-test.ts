/**
 * 🎓 端到端毕业测试脚本 — 30 分钟全流程
 *
 * Phase 1 (0~20min):  渐进买入画 K 线 + 合约交易（开仓/平仓/爆仓）
 * Phase 2 (20~25min): 加速买入推到毕业
 * Phase 3 (25~30min): 毕业后继续合约交易 + DEX 现货买卖
 *
 * Usage:
 *   bun run scripts/e2e-graduation-test.ts
 *   # 或指定撮合引擎地址:
 *   ME_URL=http://23.27.201.207:8081 bun run scripts/e2e-graduation-test.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  keccak256,
  type Address,
  type Hex,
  encodeFunctionData,
  parseAbi,
} from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════

const RPC = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const ME = process.env.ME_URL || "http://23.27.201.207:8081";

const TOKEN_FACTORY: Address = "0xB40541Ff9f24883149fc6F9CD1021dB9C7BCcB83";
const SETTLEMENT_V2: Address = "0xF83D5d2E437D0e27144900cb768d2B5933EF3d6b";
const WBNB: Address = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const PANCAKE_ROUTER: Address = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";

// 选 DOGE 作为毕业目标
const TARGET_TOKEN: Address = "0xe96B9071FdF8494A84C5bAC4ea198D9Be5C5ABc2";
const TARGET_NAME = "DOGE";

// Deployer = bonding curve 买手
const DEPLOYER_KEY: Hex = "0x4698c351c4aead4844a41399b035e1177535db94a5418a79df07b7f0bf158776";
const deployer = privateKeyToAccount(DEPLOYER_KEY);

// 合约交易使用的测试钱包 (从 main-wallets.json 挑 4 个有余额的)
const PERP_WALLETS: { key: Hex; addr: Address }[] = [
  { key: "0xb1b635271517a8061fd58dbf260e185d5b327872b1a3c51d1d36b6f6f8771477", addr: "0xCd6217Dbc3670acDa6Ec2526e99DD699b136b63a" },
  { key: "0x5864d1a4dc2897d3a9c56b48f442306997c89a60adf7c35e63fb26b2cfb891c4", addr: "0xe796edf6a2A0F3f1505A0bE57192f2a9F06f0226" },
  { key: "0xe30e1e5d6bb7863ad333807865b7fa391ecb8732192d7e0bb3bb708351fd2092", addr: "0x0e03798EC626BE86fe766355497C363cb8410577" },
  { key: "0xcbe4cc7cf82c6d1cc3d117ae3289153b55112c90b0525ffec06d7b896c9a6614", addr: "0x4561a71E348d40C8A16Fd9e7c97A307a4b1c0917" },
];

// EIP-712 域 (合约交易签名) — 引擎用 Settlement V1 地址作 verifyingContract
const SETTLEMENT_V1: Address = "0x32de01f0E464521583E52d50f125492D10EfDBB3";
const DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: bscTestnet.id,
  verifyingContract: SETTLEMENT_V1,
} as const;

const TYPES = {
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
} as const;

const FACTORY_ABI = [
  ...parseAbi([
    "function buy(address tokenAddress, uint256 minTokensOut) external payable",
    "function buyExactTokens(address tokenAddress, uint256 tokenAmount) external payable",
    "function sell(address tokenAddress, uint256 tokenAmount, uint256 minETHOut) external",
    "function getCurrentPrice(address) view returns (uint256)",
    "function previewBuy(address,uint256) view returns (uint256)",
  ]),
  // getPoolState returns a struct — need full ABI JSON
  {
    type: "function" as const,
    name: "getPoolState" as const,
    inputs: [{ name: "tokenAddress", type: "address" as const }],
    outputs: [{
      name: "", type: "tuple" as const,
      components: [
        { name: "realETHReserve", type: "uint256" as const },
        { name: "realTokenReserve", type: "uint256" as const },
        { name: "soldTokens", type: "uint256" as const },
        { name: "isGraduated", type: "bool" as const },
        { name: "isActive", type: "bool" as const },
        { name: "creator", type: "address" as const },
        { name: "createdAt", type: "uint64" as const },
        { name: "metadataURI", type: "string" as const },
        { name: "graduationFailed", type: "bool" as const },
        { name: "graduationAttempts", type: "uint8" as const },
        { name: "perpEnabled", type: "bool" as const },
        { name: "lendingEnabled", type: "bool" as const },
      ],
    }],
    stateMutability: "view" as const,
  },
] as const;

const SETTLEMENT_ABI = parseAbi([
  "function depositBNB() external payable",
]);

const ROUTER_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable returns (uint256[] memory amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

const client = createPublicClient({ chain: bscTestnet, transport: http(RPC) });

const nonces = new Map<string, bigint>();
const accounts = new Map<string, PrivateKeyAccount>();

// Pre-init accounts
for (const w of PERP_WALLETS) {
  accounts.set(w.addr.toLowerCase(), privateKeyToAccount(w.key));
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function now() { return Math.floor(Date.now() / 1000); }
function log(tag: string, msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${t}] [${tag}] ${msg}`);
}

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  return r.json();
}

// ═══════════════════════════════════════════════════════════════
//  BONDING CURVE (现货买入)
// ══════════════════���════════════════════════════════════════════

async function getPoolProgress(): Promise<{ ethReserve: bigint; soldPct: number; isGraduated: boolean; price: bigint }> {
  const state = await client.readContract({
    address: TOKEN_FACTORY, abi: FACTORY_ABI,
    functionName: "getPoolState", args: [TARGET_TOKEN],
  }) as any;

  const ethReserve = state.realETHReserve as bigint;
  const soldTokens = state.soldTokens as bigint;
  const isGraduated = state.isGraduated as boolean;

  const sellable = parseEther("793000000"); // 1B - 207M
  const soldPct = Number(soldTokens * 10000n / sellable) / 100;

  const price = await client.readContract({
    address: TOKEN_FACTORY, abi: FACTORY_ABI,
    functionName: "getCurrentPrice", args: [TARGET_TOKEN],
  }) as bigint;

  return { ethReserve, soldPct, isGraduated, price };
}

async function buyOnCurve(amountBNB: bigint): Promise<string | null> {
  try {
    const walletClient = createWalletClient({
      account: deployer,
      chain: bscTestnet,
      transport: http(RPC),
    });

    const hash = await walletClient.writeContract({
      address: TOKEN_FACTORY, abi: FACTORY_ABI,
      functionName: "buy",
      args: [TARGET_TOKEN, 0n], // minTokensOut = 0 (accept any)
      value: amountBNB,
      gas: 500_000n,
    });
    return hash;
  } catch (e: any) {
    log("SPOT", `❌ Buy failed: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

/** 买光剩余代币直到毕业 (大额，需要 5M gas 给 graduation) */
async function buyToGraduation(maxBNB: bigint): Promise<string | null> {
  try {
    const walletClient = createWalletClient({
      account: deployer,
      chain: bscTestnet,
      transport: http(RPC),
    });
    const hash = await walletClient.writeContract({
      address: TOKEN_FACTORY, abi: FACTORY_ABI,
      functionName: "buyExactTokens",
      args: [TARGET_TOKEN, 0n], // 0 = buy all remaining to graduation
      value: maxBNB,
      gas: 5_000_000n, // 毕业需要 3.5M+ gas
    });
    return hash;
  } catch (e: any) {
    log("GRAD", `❌ Graduation tx failed: ${e.message?.slice(0, 120)}`);
    return null;
  }
}

// ════════════════════════════════���══════════════════════════════
//  合约交易 (PERP)
// ═══════════════════════════════════════════════════════════════

async function syncNonce(addr: Address) {
  try {
    const d = await fetchJson(`${ME}/api/user/${addr}/nonce`);
    nonces.set(addr.toLowerCase(), BigInt(d.nonce ?? 0));
  } catch {}
}

async function getSpotPrice(): Promise<bigint> {
  try {
    // 引擎 orderbook 端点返回 lastPrice
    const d = await fetchJson(`${ME}/api/orderbook/${TARGET_TOKEN}`);
    const p = BigInt(d.lastPrice || "0");
    if (p > 0n) return p;
  } catch { /* fallback below */ }
  try {
    // Fallback: read from contract
    return await client.readContract({
      address: TOKEN_FACTORY, abi: FACTORY_ABI,
      functionName: "getCurrentPrice", args: [TARGET_TOKEN],
    }) as bigint;
  } catch { return 0n; }
}

async function submitOrder(
  wallet: { key: Hex; addr: Address },
  isLong: boolean,
  size: bigint,
  leverage: bigint,
  price: bigint,
  orderType: number = 1,
): Promise<{ success: boolean; matched: boolean; error?: string }> {
  const account = accounts.get(wallet.addr.toLowerCase())!;
  const nonce = nonces.get(wallet.addr.toLowerCase()) ?? 0n;
  const deadline = BigInt(now() + 3600);

  const msg = {
    trader: wallet.addr, token: TARGET_TOKEN, isLong,
    size, leverage, price, deadline, nonce, orderType,
  };

  let sig: string;
  try {
    sig = await account.signTypedData({
      domain: DOMAIN, types: TYPES, primaryType: "Order" as const, message: msg,
    });
  } catch (e: any) {
    return { success: false, matched: false, error: `sign: ${e.message?.slice(0, 60)}` };
  }

  try {
    const resp = await fetch(`${ME}/api/order/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...msg,
        size: msg.size.toString(),
        leverage: msg.leverage.toString(),
        price: msg.price.toString(),
        deadline: msg.deadline.toString(),
        nonce: msg.nonce.toString(),
        signature: sig,
      }),
    });
    const result = await resp.json() as { success: boolean; matches?: any[]; error?: string };

    if (result.success) {
      nonces.set(wallet.addr.toLowerCase(), nonce + 1n);
      return { success: true, matched: (result.matches?.length ?? 0) > 0 };
    }

    if (result.error?.includes("nonce")) await syncNonce(wallet.addr);
    return { success: false, matched: false, error: result.error };
  } catch (e: any) {
    return { success: false, matched: false, error: `fetch: ${e.message?.slice(0, 60)}` };
  }
}

/** 给钱包存 BNB 到 SettlementV2 */
async function depositToSettlement(wallet: { key: Hex; addr: Address }, amount: bigint) {
  try {
    const account = privateKeyToAccount(wallet.key);
    const walletClient = createWalletClient({
      account, chain: bscTestnet, transport: http(RPC),
    });
    const hash = await walletClient.writeContract({
      address: SETTLEMENT_V2, abi: SETTLEMENT_ABI,
      functionName: "depositBNB",
      value: amount,
      gas: 150_000n,
    });
    log("DEPOSIT", `${wallet.addr.slice(0, 10)} deposited ${formatEther(amount)} BNB → tx: ${hash.slice(0, 16)}...`);
    return hash;
  } catch (e: any) {
    log("DEPOSIT", `❌ ${wallet.addr.slice(0, 10)} failed: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

/** 从 deployer 给测试钱包转 BNB */
async function fundWallet(to: Address, amount: bigint) {
  try {
    const walletClient = createWalletClient({
      account: deployer, chain: bscTestnet, transport: http(RPC),
    });
    const hash = await walletClient.sendTransaction({
      to, value: amount, gas: 21000n,
    });
    log("FUND", `→ ${to.slice(0, 10)} : ${formatEther(amount)} BNB`);
    return hash;
  } catch (e: any) {
    log("FUND", `❌ ${e.message?.slice(0, 60)}`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  DEX 交易 (毕业后)
// ════════════════════���══════════════════════════════════════════

async function dexBuy(amountBNB: bigint): Promise<string | null> {
  try {
    const walletClient = createWalletClient({
      account: deployer, chain: bscTestnet, transport: http(RPC),
    });
    const deadline = BigInt(now() + 300);
    const hash = await walletClient.writeContract({
      address: PANCAKE_ROUTER, abi: ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [0n, [WBNB, TARGET_TOKEN], deployer.address, deadline],
      value: amountBNB,
      gas: 300_000n,
    });
    log("DEX", `🛒 Buy ${formatEther(amountBNB)} BNB → ${TARGET_NAME} | tx: ${hash.slice(0, 16)}...`);
    return hash;
  } catch (e: any) {
    log("DEX", `❌ Buy failed: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

async function dexSell(tokenAmount: bigint): Promise<string | null> {
  try {
    const walletClient = createWalletClient({
      account: deployer, chain: bscTestnet, transport: http(RPC),
    });
    // Approve router first
    await walletClient.writeContract({
      address: TARGET_TOKEN, abi: ERC20_ABI,
      functionName: "approve",
      args: [PANCAKE_ROUTER, tokenAmount],
      gas: 100_000n,
    });
    await sleep(3000);

    const deadline = BigInt(now() + 300);
    const hash = await walletClient.writeContract({
      address: PANCAKE_ROUTER, abi: ROUTER_ABI,
      functionName: "swapExactTokensForETH",
      args: [tokenAmount, 0n, [TARGET_TOKEN, WBNB], deployer.address, deadline],
      gas: 300_000n,
    });
    log("DEX", `💰 Sell ${Number(formatEther(tokenAmount)).toLocaleString()} ${TARGET_NAME} → BNB | tx: ${hash.slice(0, 16)}...`);
    return hash;
  } catch (e: any) {
    log("DEX", `�� Sell failed: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN ORCHESTRATOR
// ═══════════════════��═══════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  const DURATION = 30 * 60 * 1000; // 30 minutes
  const elapsed = () => Math.floor((Date.now() - startTime) / 1000);
  const elapsedMin = () => (elapsed() / 60).toFixed(1);

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  🎓 E2E Graduation Test — 30 min full flow          ║");
  console.log("║  Token: DOGE (0xe96B...ABc2)                        ║");
  console.log("║  ME: " + ME.padEnd(47) + "║");
  console.log("╚══════════════════════════════════════════════════════╝");

  // ── Step 0: 初始状态 ──
  const initial = await getPoolProgress();
  log("INIT", `${TARGET_NAME} 进度: ${initial.soldPct.toFixed(2)}% | ETH: ${formatEther(initial.ethReserve)} | Price: ${initial.price}`);
  log("INIT", `Deployer: ${formatEther(await client.getBalance({ address: deployer.address }))} BNB`);

  if (initial.isGraduated) {
    log("INIT", "⚠️ Token already graduated! Skipping to Phase 3...");
    await phase3_postGraduation(startTime, DURATION);
    return;
  }

  // ── Step 1: 给合约交易钱包充值 ──
  log("SETUP", "给 4 个合约交易钱包充值 0.5 BNB each...");
  for (const w of PERP_WALLETS) {
    const bal = await client.getBalance({ address: w.addr });
    if (bal < parseEther("0.3")) {
      await fundWallet(w.addr, parseEther("0.5"));
      await sleep(3000);
    }
  }

  // 存入 SettlementV2 做保证金
  log("SETUP", "钱包存款到 SettlementV2...");
  for (const w of PERP_WALLETS) {
    await depositToSettlement(w, parseEther("0.15"));
    await sleep(4000);
  }

  // 等待引擎检测到存款
  log("SETUP", "等待 70s 让引擎检测到链上存款...");
  await sleep(70000);

  // 同步 nonces
  for (const w of PERP_WALLETS) {
    await syncNonce(w.addr);
    log("SETUP", `${w.addr.slice(0, 10)} nonce=${nonces.get(w.addr.toLowerCase())}`);
  }

  // ══════════════════════════════════════════════════════
  //  Phase 1: 渐进买入 + 合约交易 (0~20 min)
  // ══════════════════════════════════════════════════════
  log("PHASE1", "═══ 开始 Phase 1: 渐进买入 + 合约交易 ═══");

  let buyRound = 0;
  let perpRound = 0;
  let graduated = false;

  while (elapsed() < 20 * 60 && !graduated) {
    const minute = elapsedMin();

    // ── 现货: 每 30s 小额买入 ──
    const buyAmount = parseEther("0.3") + BigInt(Math.floor(Math.random() * 5)) * parseEther("0.1");
    log("SPOT", `[${minute}m] 🛒 第${++buyRound}轮买入 ${formatEther(buyAmount)} BNB`);
    const txHash = await buyOnCurve(buyAmount);
    if (txHash) {
      await sleep(5000); // wait for confirmation
      const progress = await getPoolProgress();
      log("SPOT", `  ✅ 进度: ${progress.soldPct.toFixed(2)}% | Price: ${progress.price} | ETH: ${formatEther(progress.ethReserve)}`);
      graduated = progress.isGraduated;
    }

    await sleep(5000);

    // ── 合约交易: 每轮下 2~4 单 ──
    const spotPrice = await getSpotPrice();
    if (spotPrice > 0n) {
      perpRound++;
      const spread = spotPrice / 200n; // 0.5% spread

      // Wallet 0: Long limit
      const longPrice = spotPrice - spread;
      const r1 = await submitOrder(PERP_WALLETS[0], true, parseEther("0.02"), 25000n, longPrice, 1);
      log("PERP", `  [${minute}m] #${perpRound} W0 Long@${longPrice}: ${r1.success ? (r1.matched ? "✅ matched" : "📋 placed") : `❌ ${r1.error?.slice(0, 50)}`}`);

      // Wallet 1: Short limit
      const shortPrice = spotPrice + spread;
      const r2 = await submitOrder(PERP_WALLETS[1], false, parseEther("0.02"), 25000n, shortPrice, 1);
      log("PERP", `  [${minute}m] #${perpRound} W1 Short@${shortPrice}: ${r2.success ? (r2.matched ? "✅ matched" : "📋 placed") : `❌ ${r2.error?.slice(0, 50)}`}`);

      // Wallet 2: Market long (hits W1's short)
      if (perpRound % 3 === 0) {
        const r3 = await submitOrder(PERP_WALLETS[2], true, parseEther("0.015"), 25000n, spotPrice + spread * 2n, 1);
        log("PERP", `  [${minute}m] #${perpRound} W2 Aggr Long: ${r3.success ? (r3.matched ? "✅ matched" : "📋 placed") : `❌ ${r3.error?.slice(0, 50)}`}`);
      }

      // Wallet 3: Market short (hits W0's long)
      if (perpRound % 3 === 1) {
        const r4 = await submitOrder(PERP_WALLETS[3], false, parseEther("0.015"), 25000n, spotPrice - spread * 2n, 1);
        log("PERP", `  [${minute}m] #${perpRound} W3 Aggr Short: ${r4.success ? (r4.matched ? "✅ matched" : "📋 placed") : `❌ ${r4.error?.slice(0, 50)}`}`);
      }

      // 高杠杆单 (容易爆仓)
      if (perpRound % 5 === 0) {
        const highLevWallet = PERP_WALLETS[perpRound % 2 === 0 ? 2 : 3];
        const r5 = await submitOrder(highLevWallet, perpRound % 4 === 0, parseEther("0.03"), 25000n, spotPrice, 1);
        log("PERP", `  [${minute}m] 🎰 高杠杆: ${r5.success ? "✅" : `❌ ${r5.error?.slice(0, 50)}`}`);
      }
    } else {
      log("PERP", `  ⏭️ 无价格数据，跳过合约交易`);
    }

    // 每轮间隔 25-35s
    const interval = 25000 + Math.floor(Math.random() * 10000);
    await sleep(interval);
  }

  // ══════════════════════════════════════════════════════
  //  Phase 2: 加速推到毕业 (20~25 min)
  // ══════════════════════════════════════════════════════
  if (!graduated) {
    log("PHASE2", "═══ 开始 Phase 2: 加速买入推到毕业 ═══");

    // 大额加速
    for (let i = 0; i < 10 && !graduated; i++) {
      const buyAmt = parseEther("2.0") + BigInt(Math.floor(Math.random() * 10)) * parseEther("0.2");
      log("SPOT", `加速买入 ${formatEther(buyAmt)} BNB (第${i + 1}/10轮)`);
      await buyOnCurve(buyAmt);
      await sleep(8000);

      const progress = await getPoolProgress();
      log("SPOT", `  进度: ${progress.soldPct.toFixed(2)}% | ETH: ${formatEther(progress.ethReserve)}`);
      graduated = progress.isGraduated;

      if (progress.soldPct > 95 && !graduated) {
        log("GRAD", "🚀 进度 >95%，执行最终毕业交易！");
        const hash = await buyToGraduation(parseEther("10"));
        if (hash) {
          await sleep(10000);
          const final = await getPoolProgress();
          graduated = final.isGraduated;
          log("GRAD", graduated ? "🎓🎓🎓 毕业成功！！！" : "⚠️ 毕业未触发，继续买入...");
        }
      }
    }

    // 如果还没毕业，一笔到位
    if (!graduated) {
      log("GRAD", "⚡ 最终一击 buyExactTokens(0) — 32 BNB");
      await buyToGraduation(parseEther("32"));
      await sleep(15000);
      const final = await getPoolProgress();
      graduated = final.isGraduated;
      log("GRAD", graduated ? "🎓🎓🎓 毕业成功！！！" : "❌ 毕业失败");
    }
  }

  if (!graduated) {
    log("ERROR", "毕业失败，退出");
    process.exit(1);
  }

  // 等待引擎检测到毕业事件
  log("GRAD", "等待 90s 让引擎检测到 LiquidityMigrated 事件...");
  await sleep(90000);

  // ══════════════════════════════════════════════════════
  //  Phase 3: 毕业后交易 (25~30 min)
  // ══════════════════════════════════════════════════════
  await phase3_postGraduation(startTime, DURATION);
}

async function phase3_postGraduation(startTime: number, DURATION: number) {
  const elapsed = () => Math.floor((Date.now() - startTime) / 1000);
  const elapsedMin = () => (elapsed() / 60).toFixed(1);

  log("PHASE3", "═══ 开始 Phase 3: 毕业后交易 ═══");

  let dexRound = 0;

  while (elapsed() < DURATION / 1000) {
    dexRound++;
    const minute = elapsedMin();

    // ── DEX 现货交易 ──
    const buyAmt = parseEther("0.05") + BigInt(Math.floor(Math.random() * 5)) * parseEther("0.01");
    log("DEX", `[${minute}m] 第${dexRound}轮 DEX 买入 ${formatEther(buyAmt)} BNB`);
    await dexBuy(buyAmt);
    await sleep(10000);

    // 卖一半回来
    if (dexRound % 3 === 0) {
      const tokenBal = await client.readContract({
        address: TARGET_TOKEN, abi: ERC20_ABI,
        functionName: "balanceOf", args: [deployer.address],
      }) as bigint;
      if (tokenBal > parseEther("1000")) {
        const sellAmt = tokenBal / 3n;
        log("DEX", `[${minute}m] 卖出 ${Number(formatEther(sellAmt)).toLocaleString()} ${TARGET_NAME}`);
        await dexSell(sellAmt);
      }
    }

    await sleep(5000);

    // ── 继续合约交易 ──
    const spotPrice = await getSpotPrice();
    if (spotPrice > 0n) {
      const spread = spotPrice / 100n; // 1% spread

      // Long + Short 对冲
      const r1 = await submitOrder(PERP_WALLETS[0], true, parseEther("0.025"), 25000n, spotPrice - spread, 1);
      const r2 = await submitOrder(PERP_WALLETS[1], false, parseEther("0.025"), 25000n, spotPrice + spread, 1);
      log("PERP", `[${minute}m] Long: ${r1.success ? "✅" : "❌"} | Short: ${r2.success ? "✅" : "❌"}`);

      // 吃单
      if (dexRound % 2 === 0) {
        const r3 = await submitOrder(PERP_WALLETS[2], true, parseEther("0.02"), 25000n, spotPrice + spread, 1);
        log("PERP", `[${minute}m] Taker long: ${r3.success ? (r3.matched ? "✅ matched" : "📋") : "❌"}`);
      }
    }

    await sleep(20000);
  }

  // ── 完成 ──
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  ✅ E2E Graduation Test 完成！                       ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  const final = await getPoolProgress();
  log("DONE", `最终状态: graduated=${final.isGraduated} | price=${final.price}`);
  log("DONE", `Deployer 余额: ${formatEther(await client.getBalance({ address: deployer.address }))} BNB`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
