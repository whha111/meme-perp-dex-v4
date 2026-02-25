/**
 * 🎯 做市商测试脚本
 *
 * 功能：
 * 1. 生成/加载 200 个测试主钱包
 * 2. 用主钱包的 ETH 买入现货代币
 * 3. 创建 100 个派生交易钱包
 * 4. 给派生钱包充值 10,000 USDT
 * 5. 用 100 个钱包进行双边做市
 * 6. 实时输出订单簿、成交、K线变化
 * 7. 记录所有遇到的问题到日志文件
 *
 * 运行方式：
 * ```bash
 * cd backend/src/matching
 * bun run market-making-test.ts
 * ```
 *
 * 可选参数：
 * --skip-buy    跳过现货代币买入
 * --skip-mint   跳过 USDT mint
 *
 * 环境要求：
 * - 需要设置 MINTER_PRIVATE_KEY 环境变量（有 mint 权限的钱包）
 * - 或者在 main-wallets.json 的第一个钱包需要有 USDT mint 权限
 * - 主钱包需要有少量 ETH (每个约 0.0001 ETH)
 *
 * 输出文件：
 * - main-wallets.json           主钱包列表
 * - trading-wallets.json        派生交易钱包列表
 * - market-making-problems.log  遇到的所有问题
 */

import { ethers } from "ethers";
import { createWalletClient, http, parseEther, formatEther, type Address, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import fs from "fs";
import path from "path";

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  RPC_URL: process.env.RPC_URL || "https://base-sepolia.g.alchemy.com/v2/Dr8sMe-1MYIF7jBYuZZj8PMOPAAeJ16d",
  CHAIN_ID: 84532,

  // 合约地址
  SETTLEMENT_ADDRESS: "0x027131BbC5EF6427826F64D12BACAAb447Ee1B13" as Address,
  USDT_ADDRESS: "0xAa2a6b49C37E0241f9b5385dc4637eDF51026519" as Address,
  TOKEN_FACTORY_ADDRESS: (process.env.NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS || "0x583d35e9d407Ea03dE5A2139e792841353CB67b1") as Address,

  // 测试代币（使用链上第一个代币）
  TEST_TOKEN_ADDRESS: "0x8C219589Db787C1a5B57b1d2075C76C0d3f51C73" as Address,

  // 做市参数
  NUM_MAIN_WALLETS: 200,
  NUM_TRADING_WALLETS: 100,
  USDT_PER_WALLET: 10000, // 每个钱包 10,000 USDT

  // 订单簿参数
  BUY_ORDERS: 50,  // 买单数量
  SELL_ORDERS: 50, // 卖单数量
  PRICE_SPREAD_MIN: 0.01, // 最小价差 1%
  PRICE_SPREAD_MAX: 0.10, // 最大价差 10%

  // 更新频率
  ORDER_UPDATE_INTERVAL: 5000, // 5秒更新一次订单
  PRICE_MOVE_INTERVAL: 10000,  // 10秒调整一次中心价
};

// ============================================================
// USDT 合约 ABI (mint 功能)
// ============================================================

const USDT_ABI = [
  {
    "inputs": [
      { "name": "to", "type": "address" },
      { "name": "amount", "type": "uint256" }
    ],
    "name": "mint",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [{ "name": "account", "type": "address" }],
    "name": "balanceOf",
    "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [{ "name": "", "type": "uint8" }],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

// ============================================================
// TokenFactory ABI (买币功能)
// ============================================================

const TOKEN_FACTORY_ABI = [
  {
    "inputs": [
      { "name": "token", "type": "address" },
      { "name": "minAmountOut", "type": "uint256" }
    ],
    "name": "buy",
    "outputs": [{ "name": "amountOut", "type": "uint256" }],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      { "name": "token", "type": "address" },
      { "name": "ethAmount", "type": "uint256" }
    ],
    "name": "getEthToTokenPrice",
    "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view",
    "type": "function"
  },
] as const;

// ============================================================
// EIP-712 订单签名
// ============================================================

const EIP712_DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: CONFIG.CHAIN_ID,
  verifyingContract: CONFIG.SETTLEMENT_ADDRESS,
};

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

enum OrderType {
  MARKET = 0,
  LIMIT = 1,
}

interface OrderParams {
  trader: Address;
  token: Address;
  isLong: boolean;
  size: bigint;
  leverage: bigint;
  price: bigint;
  deadline: bigint;
  nonce: bigint;
  orderType: number;
}

/**
 * 使用 Viem 签署订单
 */
async function signOrderWithViem(
  walletClient: WalletClient,
  orderParams: OrderParams
): Promise<Hex> {
  const signature = await walletClient.signTypedData({
    account: walletClient.account!,
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: orderParams,
  });
  return signature;
}

// ============================================================
// 工具函数
// ============================================================

// 问题日志记录
const problemsLog: string[] = [];

function logProblem(problem: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${problem}`;
  problemsLog.push(entry);
  console.error("⚠️ 问题:", problem);
}

function saveProblemLog() {
  if (problemsLog.length > 0) {
    const filepath = path.join(__dirname, 'market-making-problems.log');
    fs.writeFileSync(filepath, problemsLog.join('\n'));
    log("📝", `问题日志已保存到: ${filepath}`);
    log("⚠️", `共遇到 ${problemsLog.length} 个问题`);
  }
}

function log(emoji: string, ...args: any[]) {
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${timestamp}] ${emoji}`, ...args);
}

function saveWalletsToFile(wallets: any[], filename: string) {
  const filepath = path.join(__dirname, filename);
  fs.writeFileSync(filepath, JSON.stringify(wallets, null, 2));
  log("💾", `钱包已保存到: ${filepath}`);
}

function loadWalletsFromFile(filename: string): any[] | null {
  const filepath = path.join(__dirname, filename);
  if (fs.existsSync(filepath)) {
    const data = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(data);
  }
  return null;
}

// ============================================================
// 阶段 1: 钱包管理
// ============================================================

/**
 * 生成或加载主钱包
 */
async function setupMainWallets(): Promise<ethers.Wallet[]> {
  log("🔑", `开始设置 ${CONFIG.NUM_MAIN_WALLETS} 个主钱包...`);

  // 尝试加载已存在的钱包
  const existing = loadWalletsFromFile('main-wallets.json');
  if (existing && existing.length === CONFIG.NUM_MAIN_WALLETS) {
    log("✅", `从文件加载了 ${existing.length} 个主钱包`);
    return existing.map(w => new ethers.Wallet(w.privateKey));
  }

  // 生成新钱包
  log("⏳", "生成新的主钱包...");
  const wallets: ethers.Wallet[] = [];
  const walletsData: any[] = [];

  for (let i = 0; i < CONFIG.NUM_MAIN_WALLETS; i++) {
    const wallet = ethers.Wallet.createRandom();
    wallets.push(wallet);
    walletsData.push({
      index: i,
      address: wallet.address,
      privateKey: wallet.privateKey,
    });

    if ((i + 1) % 50 === 0) {
      log("📊", `生成进度: ${i + 1}/${CONFIG.NUM_MAIN_WALLETS}`);
    }
  }

  saveWalletsToFile(walletsData, 'main-wallets.json');
  log("✅", `生成了 ${wallets.length} 个主钱包`);

  return wallets;
}

/**
 * 创建派生交易钱包
 */
async function setupTradingWallets(mainWallets: ethers.Wallet[]): Promise<ethers.Wallet[]> {
  log("🔑", `开始创建 ${CONFIG.NUM_TRADING_WALLETS} 个派生钱包...`);

  const existing = loadWalletsFromFile('trading-wallets.json');
  if (existing && existing.length === CONFIG.NUM_TRADING_WALLETS) {
    log("✅", `从文件加载了 ${existing.length} 个派生钱包`);
    return existing.map(w => new ethers.Wallet(w.privateKey));
  }

  const tradingWallets: ethers.Wallet[] = [];
  const walletsData: any[] = [];

  // 使用前 100 个主钱包
  for (let i = 0; i < CONFIG.NUM_TRADING_WALLETS; i++) {
    const mainWallet = mainWallets[i];

    // 使用确定性派生
    const message = `Trading wallet for ${mainWallet.address}`;
    const signature = await mainWallet.signMessage(message);
    const derivedKey = ethers.keccak256(signature);
    const derivedWallet = new ethers.Wallet(derivedKey);

    tradingWallets.push(derivedWallet);
    walletsData.push({
      index: i,
      mainAddress: mainWallet.address,
      derivedAddress: derivedWallet.address,
      privateKey: derivedWallet.privateKey,
    });

    if ((i + 1) % 25 === 0) {
      log("📊", `派生进度: ${i + 1}/${CONFIG.NUM_TRADING_WALLETS}`);
    }
  }

  saveWalletsToFile(walletsData, 'trading-wallets.json');
  log("✅", `创建了 ${tradingWallets.length} 个派生钱包`);

  return tradingWallets;
}

// ============================================================
// 阶段 1.5: 买入现货代币
// ============================================================

/**
 * 用主钱包的 ETH 买入现货代币
 */
async function buySpotTokens(mainWallets: ethers.Wallet[], tokenAddress: Address) {
  log("💎", `开始用 ${mainWallets.length} 个主钱包买入现货代币...`);

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const tokenFactory = new ethers.Contract(CONFIG.TOKEN_FACTORY_ADDRESS, TOKEN_FACTORY_ABI, provider);

  let successCount = 0;
  let failCount = 0;
  let totalTokensBought = 0n;

  // 每个钱包用 0.0001 ETH 买币 (测试网少量ETH)
  const ethPerWallet = parseEther("0.0001");

  for (let i = 0; i < mainWallets.length; i++) {
    const wallet = mainWallets[i].connect(provider);

    try {
      log("⏳", `[${i + 1}/${mainWallets.length}] ${wallet.address.slice(0, 10)}... 买入代币...`);

      // 检查 ETH 余额
      const ethBalance = await provider.getBalance(wallet.address);
      if (ethBalance < ethPerWallet) {
        const msg = `主钱包[${i + 1}] ETH余额不足: ${formatEther(ethBalance)} ETH < ${formatEther(ethPerWallet)} ETH`;
        log("⚠️", msg);
        logProblem(msg);
        failCount++;
        continue;
      }

      // 获取预期输出 (设置 1% 滑点保护)
      const expectedOut = await tokenFactory.getEthToTokenPrice(tokenAddress, ethPerWallet);
      const minAmountOut = (expectedOut * 99n) / 100n;

      // 执行买入
      const connectedFactory = tokenFactory.connect(wallet) as any;
      const tx = await connectedFactory.buy(tokenAddress, minAmountOut, {
        value: ethPerWallet,
        gasLimit: 500000,
      });
      const receipt = await tx.wait();

      totalTokensBought += expectedOut;
      successCount++;
      log("✅", `买入成功，获得约 ${formatEther(expectedOut)} 代币`);

    } catch (error: any) {
      failCount++;
      const errorMsg = `现货代币买入失败 [钱包${i + 1}/${mainWallets.length}]: ${error.message.slice(0, 100)}`;
      log("❌", errorMsg);
      logProblem(errorMsg);
    }

    // 每 5 个暂停，避免 RPC 限流
    if ((i + 1) % 5 === 0) {
      log("⏸️", "暂停 1 秒...");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  log("📊", `买入完成: 成功 ${successCount}, 失败 ${failCount}`);
  log("💰", `总共买入约: ${formatEther(totalTokensBought)} 代币`);
}

// ============================================================
// 阶段 2: 资金准备
// ============================================================

/**
 * Mint USDT 到派生钱包
 */
async function mintUSDT(tradingWallets: ethers.Wallet[]) {
  log("💰", `开始给 ${tradingWallets.length} 个钱包充值 USDT...`);

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);

  // 使用第一个主钱包作为 minter（假设有权限）
  const minterPrivateKey = process.env.MINTER_PRIVATE_KEY || loadWalletsFromFile('main-wallets.json')?.[0]?.privateKey;
  if (!minterPrivateKey) {
    throw new Error("未找到 minter 私钥");
  }

  const minter = new ethers.Wallet(minterPrivateKey, provider);
  const usdtContract = new ethers.Contract(CONFIG.USDT_ADDRESS, USDT_ABI, minter);

  log("🔍", `Minter 地址: ${minter.address}`);

  // 获取 decimals
  const decimals = await usdtContract.decimals();
  const amountPerWallet = BigInt(CONFIG.USDT_PER_WALLET) * (10n ** BigInt(decimals));

  log("📊", `每个钱包充值: ${CONFIG.USDT_PER_WALLET} USDT (${amountPerWallet.toString()} 最小单位)`);

  // 批量 mint
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < tradingWallets.length; i++) {
    const wallet = tradingWallets[i];

    try {
      log("⏳", `[${i + 1}/${tradingWallets.length}] 充值到 ${wallet.address.slice(0, 10)}...`);

      const tx = await usdtContract.mint(wallet.address, amountPerWallet);
      await tx.wait();

      successCount++;
      log("✅", `成功充值 ${CONFIG.USDT_PER_WALLET} USDT`);

    } catch (error: any) {
      failCount++;
      const errorMsg = `USDT充值失败 [钱包${i + 1}/${tradingWallets.length}]: ${error.message}`;
      log("❌", errorMsg);
      logProblem(errorMsg);
    }

    // 每 10 个暂停一下，避免 RPC 限流
    if ((i + 1) % 10 === 0) {
      log("⏸️", "暂停 2 秒...");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  log("📊", `充值完成: 成功 ${successCount}, 失败 ${failCount}`);
}

/**
 * 验证余额
 */
async function verifyBalances(tradingWallets: ethers.Wallet[]) {
  log("🔍", "验证钱包余额...");

  const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
  const usdtContract = new ethers.Contract(CONFIG.USDT_ADDRESS, USDT_ABI, provider);
  const decimals = await usdtContract.decimals();

  let totalBalance = 0n;
  let walletsWithBalance = 0;

  for (const wallet of tradingWallets.slice(0, 10)) { // 只检查前 10 个
    const balance = await usdtContract.balanceOf(wallet.address);
    const formatted = Number(balance) / (10 ** Number(decimals));

    if (balance > 0) {
      walletsWithBalance++;
      totalBalance += balance;
    }

    log("💵", `${wallet.address.slice(0, 10)}... : ${formatted.toFixed(2)} USDT`);
  }

  log("📊", `前 10 个钱包中有 ${walletsWithBalance} 个有余额`);
}

// ============================================================
// 阶段 3: 做市交易
// ============================================================

interface Order {
  id: string;
  wallet: ethers.Wallet;
  side: "buy" | "sell";
  price: string;
  size: string;
}

/**
 * 生成订单簿
 */
function generateOrderBook(centerPrice: number, tradingWallets: ethers.Wallet[]): Order[] {
  const orders: Order[] = [];

  // 买单 (中心价下方)
  for (let i = 0; i < CONFIG.BUY_ORDERS; i++) {
    const wallet = tradingWallets[i];
    const spread = CONFIG.PRICE_SPREAD_MIN + (CONFIG.PRICE_SPREAD_MAX - CONFIG.PRICE_SPREAD_MIN) * (i / CONFIG.BUY_ORDERS);
    const price = centerPrice * (1 - spread);
    const size = (Math.random() * 900 + 100).toFixed(0); // 100-1000

    orders.push({
      id: `buy-${i}`,
      wallet,
      side: "buy",
      price: (price * 1e12).toFixed(0), // 转换为 1e12 精度
      size: (Number(size) * 1e18).toFixed(0), // 转换为 1e18 精度
    });
  }

  // 卖单 (中心价上方)
  for (let i = 0; i < CONFIG.SELL_ORDERS; i++) {
    const wallet = tradingWallets[CONFIG.BUY_ORDERS + i];
    const spread = CONFIG.PRICE_SPREAD_MIN + (CONFIG.PRICE_SPREAD_MAX - CONFIG.PRICE_SPREAD_MIN) * (i / CONFIG.SELL_ORDERS);
    const price = centerPrice * (1 + spread);
    const size = (Math.random() * 900 + 100).toFixed(0);

    orders.push({
      id: `sell-${i}`,
      wallet,
      side: "sell",
      price: (price * 1e12).toFixed(0),
      size: (Number(size) * 1e18).toFixed(0),
    });
  }

  return orders;
}

/**
 * 获取用户 nonce
 */
async function getUserNonce(trader: Address): Promise<bigint> {
  try {
    const res = await fetch(`http://localhost:8081/api/user/${trader}/nonce`);
    const data = await res.json();
    return BigInt(data.nonce || "0");
  } catch {
    return 0n;
  }
}

/**
 * 提交订单到撮合引擎
 */
async function submitOrder(order: Order, token: Address, nonce: bigint): Promise<boolean> {
  const apiUrl = "http://localhost:8081";

  try {
    // 创建 wallet client
    const account = privateKeyToAccount(order.wallet.privateKey as Hex);
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(CONFIG.RPC_URL),
    });

    // 构造订单参数
    const LEVERAGE_PRECISION = 10000n;
    const orderParams: OrderParams = {
      trader: account.address,
      token,
      isLong: order.side === "buy",
      size: BigInt(order.size),
      leverage: 5n * LEVERAGE_PRECISION, // 5x 杠杆 (DORMANT 代币最大支持 5x)
      price: BigInt(order.price),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1小时有效期
      nonce,
      orderType: OrderType.LIMIT,
    };

    // EIP-712 签名
    const signature = await signOrderWithViem(walletClient, orderParams);

    // 提交到撮合引擎
    const response = await fetch(`${apiUrl}/api/order/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader: orderParams.trader,
        token: orderParams.token,
        isLong: orderParams.isLong,
        size: orderParams.size.toString(),
        leverage: orderParams.leverage.toString(),
        price: orderParams.price.toString(),
        deadline: orderParams.deadline.toString(),
        nonce: orderParams.nonce.toString(),
        orderType: orderParams.orderType,
        signature,
      }),
    });

    const result = await response.json();

    if (result.success) {
      log("✅", `订单提交成功: ${order.side.toUpperCase()} @ $${(Number(order.price) / 1e12).toFixed(8)}`);
      return true;
    } else {
      const errorMsg = `订单提交失败 [${order.side.toUpperCase()}]: ${result.error || "Unknown error"}`;
      log("❌", errorMsg);
      logProblem(errorMsg);
      return false;
    }

  } catch (error: any) {
    const errorMsg = `订单提交异常 [${order.side.toUpperCase()}]: ${error.message}`;
    log("❌", errorMsg);
    logProblem(errorMsg);
    return false;
  }
}

/**
 * 做市主循环
 */
async function runMarketMaking(tradingWallets: ethers.Wallet[], tokenAddress: Address) {
  log("🎯", "开始做市...");

  let centerPrice = 0.001; // 初始中心价 $0.001
  let iteration = 0;

  // 获取所有钱包的初始 nonce
  const nonceMap = new Map<string, bigint>();
  log("🔍", "获取初始 nonce...");
  for (let i = 0; i < Math.min(10, tradingWallets.length); i++) {
    const wallet = tradingWallets[i];
    const account = privateKeyToAccount(wallet.privateKey as Hex);
    const nonce = await getUserNonce(account.address);
    nonceMap.set(wallet.address.toLowerCase(), nonce);
    if (i < 3) {
      log("  ", `钱包 ${i + 1}: nonce = ${nonce}`);
    }
  }

  const interval = setInterval(async () => {
    iteration++;
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("📊", `迭代 #${iteration} | 中心价: $${centerPrice.toFixed(8)}`);

    // 生成订单簿
    const orders = generateOrderBook(centerPrice, tradingWallets);

    // 显示订单簿深度
    const buyOrders = orders.filter(o => o.side === "buy").slice(0, 5);
    const sellOrders = orders.filter(o => o.side === "sell").slice(0, 5);

    log("📗", "买单 (前5档):");
    buyOrders.forEach((o, i) => {
      const price = Number(o.price) / 1e12;
      const size = Number(o.size) / 1e18;
      log("  ", `  ${i + 1}. $${price.toFixed(8)} × ${size.toFixed(0)}`);
    });

    log("📕", "卖单 (前5档):");
    sellOrders.forEach((o, i) => {
      const price = Number(o.price) / 1e12;
      const size = Number(o.size) / 1e18;
      log("  ", `  ${i + 1}. $${price.toFixed(8)} × ${size.toFixed(0)}`);
    });

    // 提交订单 (只提交前10个以避免过载)
    log("📤", "提交订单到撮合引擎...");
    let successCount = 0;
    let failCount = 0;

    const ordersToSubmit = orders.slice(0, 10);
    for (const order of ordersToSubmit) {
      const walletAddr = order.wallet.address.toLowerCase();
      let nonce = nonceMap.get(walletAddr) || 0n;

      const success = await submitOrder(order, tokenAddress, nonce);
      if (success) {
        successCount++;
        // 递增 nonce
        nonceMap.set(walletAddr, nonce + 1n);
      } else {
        failCount++;
      }

      // 暂停避免限流
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    log("📊", `提交结果: 成功 ${successCount}, 失败 ${failCount}`);

    // 调整中心价 (随机游走)
    const priceChange = (Math.random() - 0.5) * 0.02; // ±2%
    centerPrice *= (1 + priceChange);

    log("📈", `价格变动: ${(priceChange * 100).toFixed(2)}%`);

  }, CONFIG.ORDER_UPDATE_INTERVAL);

  // 运行 5 分钟后停止
  setTimeout(() => {
    clearInterval(interval);
    log("🛑", "做市测试完成");
    process.exit(0);
  }, 5 * 60 * 1000);
}

// ============================================================
// 主函数
// ============================================================

async function main() {
  log("🚀", "=== 做市商测试脚本 ===");
  log("📝", "配置:");
  log("  ", `- 主钱包数: ${CONFIG.NUM_MAIN_WALLETS}`);
  log("  ", `- 交易钱包数: ${CONFIG.NUM_TRADING_WALLETS}`);
  log("  ", `- 每钱包 USDT: ${CONFIG.USDT_PER_WALLET}`);
  log("  ", `- 买单数: ${CONFIG.BUY_ORDERS}`);
  log("  ", `- 卖单数: ${CONFIG.SELL_ORDERS}`);

  try {
    // 检查代币地址
    if (!CONFIG.TEST_TOKEN_ADDRESS) {
      log("❌", "请先设置 TEST_TOKEN_ADDRESS");
      log("💡", "提示: 修改脚本顶部的 CONFIG.TEST_TOKEN_ADDRESS");
      return;
    }

    // 检查撮合引擎是否运行
    try {
      const healthCheck = await fetch("http://localhost:8081/health");
      const health = await healthCheck.json();
      if (health.success) {
        log("✅", "撮合引擎运行正常");
      }
    } catch (error) {
      log("⚠️", "警告: 撮合引擎未运行，请先启动 Matching Engine");
      log("💡", "运行: cd backend/src/matching && bun run server.ts");
      logProblem("撮合引擎未运行");
    }

    // 阶段 1: 设置钱包
    log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("📍", "阶段 1: 设置钱包");
    const mainWallets = await setupMainWallets();
    const tradingWallets = await setupTradingWallets(mainWallets);

    // 阶段 1.5: 买入现货代币
    log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("📍", "阶段 1.5: 用主钱包买入现货代币");

    const skipBuy = process.argv.includes('--skip-buy');
    if (skipBuy) {
      log("⏭️", "跳过买币 (使用 --skip-buy)");
    } else {
      try {
        await buySpotTokens(mainWallets, CONFIG.TEST_TOKEN_ADDRESS);
      } catch (error: any) {
        logProblem(`买入现货代币失败: ${error.message}`);
      }
    }

    // 阶段 2: 充值 USDT
    log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("📍", "阶段 2: 充值 USDT 到派生钱包");

    const skipMint = process.argv.includes('--skip-mint');
    if (skipMint) {
      log("⏭️", "跳过 mint (使用 --skip-mint)");
    } else {
      await mintUSDT(tradingWallets);
    }

    await verifyBalances(tradingWallets);

    // 阶段 3: 做市
    log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("📍", "阶段 3: 开始做市");
    log("💡", "打开浏览器查看实时效果:");
    log("  ", `http://localhost:3000/perp?symbol=${CONFIG.TEST_TOKEN_ADDRESS}`);
    log("");

    await runMarketMaking(tradingWallets, CONFIG.TEST_TOKEN_ADDRESS);

    // 保存问题日志
    saveProblemLog();

  } catch (error: any) {
    log("❌", "致命错误:", error.message);
    console.error(error);
    logProblem(`致命错误: ${error.message}`);
  } finally {
    // 确保问题日志被保存
    saveProblemLog();
  }
}

// ============================================================
// 信号处理 (确保日志保存)
// ============================================================

process.on('SIGINT', () => {
  log("🛑", "收到 SIGINT 信号，保存日志并退出...");
  saveProblemLog();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log("🛑", "收到 SIGTERM 信号，保存日志并退出...");
  saveProblemLog();
  process.exit(0);
});

// ============================================================
// 运行
// ============================================================

if (require.main === module) {
  main().catch((error) => {
    console.error("未捕获的错误:", error);
    logProblem(`未捕获的错误: ${error.message}`);
    saveProblemLog();
    process.exit(1);
  });
}

export { setupMainWallets, setupTradingWallets, mintUSDT, runMarketMaking };
