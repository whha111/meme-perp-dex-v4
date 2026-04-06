/**
 * 撮合引擎 HTTP API 服务器 + WebSocket 推送
 *
 * 为前端提供：
 * - REST API: 订单提交、订单簿查询、仓位查询等
 * - WebSocket: 实时推送订单簿、成交记录
 */

import "dotenv/config";
import { enableStructuredConsole } from "./utils/logger";
enableStructuredConsole(); // In production: all console.* outputs become JSON
import { type Address, type Hex, verifyTypedData, verifyMessage, createPublicClient, http, webSocket, parseEther, formatEther, formatUnits, getAddress } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { CHAIN_ID as CONFIG_CHAIN_ID, rpcTransport } from "./config";
const activeChain = CONFIG_CHAIN_ID === 97 ? bscTestnet : bsc;
import { WebSocketServer, WebSocket } from "ws";
import { MatchingEngine, OrderType, OrderStatus, TimeInForce, OrderSource, registerPriceChangeCallback, type Order, type Match, type Trade, type Kline, type TokenStats } from "./engine";
// ❌ Mode 2: SettlementSubmitter 已从导入中移除
import type { TradeRecord } from "./types";
import db, {
  // ⚠️ PositionRepo 已移至 database/redis.ts — 用 trader/token/isLong 字段 (不再用 userAddress/symbol/side)
  OrderRepo,
  VaultRepo,
  SettlementLogRepo,
  MarketStatsRepo,
  type Position as DBPosition,
  type Order as DBOrder,
  type UserVault,
  type SettlementLog,
  type MarketStats,
} from "./database";
import { connectRedis as connectNewRedis, disconnectRedis, PositionRepo, TradeRepo, OrderMarginRepo, Mode2AdjustmentRepo, NonceRepo, InsuranceFundRepo, ReferralRepo, SettlementLogRepo as RedisSettlementLogRepo, PendingWithdrawalMode2Repo, BalanceRepo as RedisBalanceRepo, type PendingWithdrawalMode2, withLock, safeBigInt, cleanupStaleOrders, cleanupClosedPositions, type PerpTrade } from "./database/redis";
// P1-5: PostgreSQL 订单镜像 (Write-Through Cache)
import { connectPostgres, disconnectPostgres, isPostgresConnected, OrderMirrorRepo, PositionMirrorRepo, TradeMirrorRepo, Mode2AdjustmentMirrorRepo, BillMirrorRepo, BalanceSnapshotRepo, FundingRateMirrorRepo, SyncStateRepo, pgMirrorWriteWithRetry, getPgMirrorStats, type PgOrderMirror, type PgPositionMirror, type PgTradeMirror, type PgBill, type PgBalanceSnapshot } from "./database/postgres";
// P2-4: 仓位大小限制常量
import { TRADING, ALLOW_FAKE_DEPOSIT, RESET_MODE2_ON_START, PRECISION_MULTIPLIER, WETH_ADDRESS as WETH_ADDR_FROM_CONFIG, PANCAKESWAP_FACTORY_ADDRESS } from "./config";
import { verifyOrderSignature } from "./utils/crypto";
import { createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getSigningKey, getActiveSessionForDerived, registerTradingSession } from "./modules/wallet";
import { getTokenHolders } from "./modules/tokenHolders";
import { getTokenState, isTradingEnabled, getTokenHeatTier, getCoverageRatio, pauseToken, unpauseToken, initializeTokenLifecycle, TokenState, startLifecycleChecker, updateOnChainData, getTokenParameters } from "./modules/lifecycle";
// ============================================================
// Mode 2 Modules (Off-chain Execution + On-chain Attestation)
// ============================================================
import { initializeSnapshotModule, startSnapshotJob, stopSnapshotJob, getUserProof, getSnapshotJobStatus, runSnapshotCycle } from "./modules/snapshot";
import { initializeWithdrawModule, syncNoncesFromChain, resetNonceFromChain, requestWithdrawal, generateFastWithdrawalSignature, getWithdrawModuleStatus, cleanupExpiredWithdrawals } from "./modules/withdraw";
import { createEventPoller, stopAllPollers, getPollerStats, setBlockPersistPgCallback } from "./modules/eventPoller";
import {
  initLendingLiquidation,
  detectLendingLiquidations,
  updateLendingLiquidationQueue,
  processLendingLiquidations,
  getActiveBorrows,
  getLendingLiquidationMetrics,
  trackBorrow,
  trackRepay,
} from "./modules/lendingLiquidation";
import {
  initPerpVault,
  isPerpVaultEnabled,
  getPoolStats as getPerpVaultPoolStats,
  getTokenOI as getPerpVaultTokenOI,
  getLPInfo as getPerpVaultLPInfo,
  getPerpVaultMetrics,
  startBatchSettlement,
  getPendingSettlementInfo,
  increaseOI as vaultIncreaseOI,
  decreaseOI as vaultDecreaseOI,
  settleTraderPnL as vaultSettleTraderPnL,
  settleLiquidation as vaultSettleLiquidation,
  collectTradingFee as vaultCollectFee,
  startOIFlush,
  txLockRef,
  updateGraduatedTokens as vaultUpdateGraduatedTokens,
  getAvailableOIHeadroom,
  getPoolStats,
  canOpenPosition,
  isCircuitBreakerOpen,
  getCircuitBreakerStatus,
  getEngineTotalOI,
} from "./modules/perpVault";
import {
  initMarginBatch,
  queueMarginDeposit,
  queueSettleClose,
  queueMarginWithdraw,
  startMarginFlush,
  stopMarginFlush,
  setOnDepositFailure,
  getOnChainTraderMargin,
  getMarginBatchMetrics,
  registerWalletKey,
  type PendingMarginOp,
} from "./modules/marginBatch";

// ============================================================
// Configuration
// ============================================================

const PORT = parseInt(process.env.PORT || "8081");
const RPC_URL = process.env.RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/";
const WSS_URL = process.env.WSS_URL || "wss://bsc-testnet-rpc.publicnode.com";
const MATCHER_PRIVATE_KEY = process.env.MATCHER_PRIVATE_KEY as Hex;
// Role separation: PLATFORM_SIGNER_KEY signs EIP-712 withdrawals, MATCHER_PRIVATE_KEY sends on-chain txs
const PLATFORM_SIGNER_KEY = (process.env.PLATFORM_SIGNER_KEY || process.env.MATCHER_PRIVATE_KEY) as Hex;
const SETTLEMENT_ADDRESS = process.env.SETTLEMENT_ADDRESS as Address;
const SETTLEMENT_V2_ADDRESS = process.env.SETTLEMENT_V2_ADDRESS as Address; // dYdX v3 style Merkle withdrawal contract
// All contract addresses loaded from env vars (no fallbacks — fail fast via config.ts validation)
const TOKEN_FACTORY_ADDRESS = process.env.TOKEN_FACTORY_ADDRESS as Address;
const PRICE_FEED_ADDRESS = process.env.PRICE_FEED_ADDRESS as Address;
const LENDING_POOL_ADDRESS_LOCAL = process.env.LENDING_POOL_ADDRESS as Address;
const LIQUIDATION_ADDRESS_LOCAL = process.env.LIQUIDATION_ADDRESS as Address;
const PERP_VAULT_ADDRESS_LOCAL = process.env.PERP_VAULT_ADDRESS as Address;
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS || "30000"); // 30 seconds
const FUNDING_RATE_INTERVAL_MS = parseInt(process.env.FUNDING_RATE_INTERVAL_MS || "5000"); // 5 seconds
const SPOT_PRICE_SYNC_INTERVAL_MS = parseInt(process.env.SPOT_PRICE_SYNC_INTERVAL_MS || "3000"); // 3s — balanced between price accuracy and RPC rate limits
// P0-1: 签名验证仅在 NODE_ENV=test 时可跳过，生产环境硬编码开启
const SKIP_SIGNATURE_VERIFY = process.env.NODE_ENV === "test" && process.env.SKIP_SIGNATURE_VERIFY === "true";
// P0-1: 生产环境硬保护 — 即使 env 配错也不能绕过签名
if (process.env.NODE_ENV === "production" && process.env.SKIP_SIGNATURE_VERIFY === "true") {
  console.error("🚨 FATAL: SKIP_SIGNATURE_VERIFY=true is FORBIDDEN in production! Aborting.");
  process.exit(1);
}
const FEE_RECEIVER_ADDRESS = (process.env.FEE_RECEIVER_ADDRESS || "").toLowerCase() as Address; // 平台手续费接收钱包 (validated in config.ts)

// P2-57: 生产环境必须显式配置所有合约地址，禁止使用 localhost 默认值
// NOTE: config.ts now has comprehensive startup validation for ALL contract addresses.
// This block provides an additional safety net for server.ts-specific local variables.
if (process.env.NODE_ENV === "production") {
  const requiredEnvVars = [
    "MATCHER_PRIVATE_KEY", "SETTLEMENT_ADDRESS", "TOKEN_FACTORY_ADDRESS",
    "PRICE_FEED_ADDRESS", "RPC_URL", "FEE_RECEIVER_ADDRESS",
    "SETTLEMENT_V2_ADDRESS", "PERP_VAULT_ADDRESS", "COLLATERAL_TOKEN_ADDRESS",
    "INSURANCE_FUND_ADDRESS", "VAULT_ADDRESS", "POSITION_MANAGER_ADDRESS",
    "FUNDING_RATE_ADDRESS", "LIQUIDATION_ADDRESS", "LENDING_POOL_ADDRESS",
  ];
  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`🚨 FATAL: Missing required env vars in production: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ============================================================
// Server Telemetry Counters
// ============================================================
const serverStartTime = Date.now();
let totalRequestCount = 0;
let totalOrdersSubmitted = 0;

// BNB/USD 价格 - 仅用于 UI 参考显示，不影响 BNB 本位交易逻辑
// TODO: 可后续接入价格预言机 (如 Chainlink) 获取实时价格
let currentEthPriceUsd = 600;

// 支持的代币列表（动态从 TokenFactory 获取）
const SUPPORTED_TOKENS: Address[] = [
  // 不再硬编码，从链上 TokenFactory.getAllTokens() 获取
];

// ── Token 元数据内存缓存 (name/symbol, 启动时一次性从链上读取) ──
export const TOKEN_INFO_CACHE = new Map<string, { name: string; symbol: string }>();

// ── Token 完整 pool 数据缓存 (前端 token 列表 WSS-only 架构) ──
interface CachedPoolState {
  creator: string;
  createdAt: number;
  isGraduated: boolean;
  isActive: boolean;
  metadataURI: string;
  perpEnabled: boolean;
  realETHReserve: string;  // wei string
  soldTokens: string;      // wei string
  price: string;           // wei string (bonding curve price)
}
const TOKEN_POOL_CACHE = new Map<string, CachedPoolState>();

// ============================================================
// 毕业代币追踪 (Uniswap V2 价格源切换)
// ============================================================
// 当代币从 bonding curve 毕业到 Uniswap V2 后，价格源需要切换
// token address (lowercase) => { pairAddress, isWethToken0 }

const WETH_ADDRESS = getAddress(WETH_ADDR_FROM_CONFIG) as Address;
const UNISWAP_V2_FACTORY_ADDRESS = PANCAKESWAP_FACTORY_ADDRESS ? getAddress(PANCAKESWAP_FACTORY_ADDRESS) as Address : undefined;

interface GraduatedTokenInfo {
  pairAddress: Address;    // Uniswap V2 Pair 地址
  isWethToken0: boolean;   // WETH 是否为 token0 (影响 reserve 顺序)
}

const graduatedTokens = new Map<string, GraduatedTokenInfo>();

// ============================================================
// Memory Safety: Bounded Map limits (prevent unbounded growth)
// ============================================================
const MAX_GRADUATED_TOKENS = 1000;
const MAX_USER_NONCES = 50_000;
const MAX_USER_TRADES_ENTRIES = 50_000; // total users with trade history
const MAX_TRADES_PER_USER = 500;       // trades kept per user (latest N)

/** Evict oldest entries from a Map when it exceeds maxSize (FIFO based on insertion order) */
function evictOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  if (map.size <= maxSize) return;
  const excess = map.size - maxSize;
  const iter = map.keys();
  for (let i = 0; i < excess; i++) {
    const key = iter.next().value;
    if (key !== undefined) map.delete(key);
  }
}

// ============================================================
// EIP-712 Types for Signature Verification
// ============================================================

const EIP712_DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: CONFIG_CHAIN_ID, // BSC — reads from env CHAIN_ID (default 97)
  verifyingContract: SETTLEMENT_ADDRESS,
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
} as const;

// ============================================================
// Settlement 合约 ABI (Mode 2 精简版 - 仅资金托管)
// ============================================================
// Mode 2: 移除所有仓位相关函数 (getPairedPosition, settleBatch, closePair, liquidate)
// 仅保留: 余额查询、存款、提款、资金事件监听
const SETTLEMENT_ABI = [
  // ========== View Functions (资金托管) ==========
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserBalance",
    outputs: [
      { name: "available", type: "uint256" },
      { name: "locked", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  // ========== Write Functions (资金托管) ==========
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    // depositETH: 存入原生 ETH → 自动包装为 WETH → 计入用户 available 余额
    // 调用者 (msg.sender) 的 ETH 被发送到合约，合约内部 wrap 为 WETH
    inputs: [],
    name: "depositETH",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // ========== Events (资金变动监听) ==========
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DepositedFor",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "relayer", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  // ========== Batch PnL Settlement (链下→链上同步) ==========
  {
    inputs: [
      { name: "from", type: "address[]" },
      { name: "to", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    name: "batchSettlePnL",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ============================================================
// SettlementV2 ABI (dYdX v3 style: Merkle proof + EIP-712 withdrawal)
// ============================================================
const SETTLEMENT_V2_ABI = [
  // State root management (backend submits Merkle root)
  {
    inputs: [{ name: "newRoot", type: "bytes32" }],
    name: "updateStateRoot",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Deposit (user deposits WETH collateral)
  {
    inputs: [{ name: "amount", type: "uint256" }],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // DepositFor (relayer deposits on behalf of user)
  {
    inputs: [
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "depositFor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Withdraw (user submits Merkle proof + platform signature)
  {
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "userEquity", type: "uint256" },
      { name: "merkleProof", type: "bytes32[]" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // View: user deposits
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserDeposits",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // View: user nonce
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserNonce",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // View: total withdrawn
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserTotalWithdrawn",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // View: verify Merkle proof
  {
    inputs: [
      { name: "user", type: "address" },
      { name: "equity", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    name: "verifyMerkleProof",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  // Events
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "totalDeposits", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DepositedFor",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "relayer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DepositedBNB",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "totalDeposits", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "StateRootUpdated",
    inputs: [
      { name: "root", type: "bytes32", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
      { name: "snapshotId", type: "uint256", indexed: false },
    ],
  },
  // fastWithdraw function (TradingVault)
  {
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    name: "fastWithdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // FastWithdrawn event (TradingVault)
  {
    type: "event",
    name: "FastWithdrawn",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
] as const;

// TokenFactory ABI (用于监听现货交易事件)
const TOKEN_FACTORY_ABI = [
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "uri", type: "string", indexed: false },
      { name: "totalSupply", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Trade",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "isBuy", type: "bool", indexed: false },
      { name: "ethAmount", type: "uint256", indexed: false },
      { name: "tokenAmount", type: "uint256", indexed: false },
      { name: "virtualEth", type: "uint256", indexed: false },
      { name: "virtualToken", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    inputs: [{ name: "tokenAddress", type: "address" }],
    name: "getCurrentPrice",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getAllTokens",
    outputs: [{ name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  // getPoolState - 用于检测代币毕业状态
  {
    inputs: [{ name: "tokenAddress", type: "address" }],
    name: "getPoolState",
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "realETHReserve", type: "uint256" },
        { name: "realTokenReserve", type: "uint256" },
        { name: "soldTokens", type: "uint256" },
        { name: "isGraduated", type: "bool" },
        { name: "isActive", type: "bool" },
        { name: "creator", type: "address" },
        { name: "createdAt", type: "uint64" },
        { name: "metadataURI", type: "string" },
        { name: "graduationFailed", type: "bool" },
        { name: "graduationAttempts", type: "uint8" },
        { name: "perpEnabled", type: "bool" },
      ],
    }],
    stateMutability: "view",
    type: "function",
  },
  // LiquidityMigrated 事件 - 代币毕业到 Uniswap V2
  {
    type: "event",
    name: "LiquidityMigrated",
    inputs: [
      { name: "tokenAddress", type: "address", indexed: true },
      { name: "pairAddress", type: "address", indexed: true },
      { name: "ethLiquidity", type: "uint256", indexed: false },
      { name: "tokenLiquidity", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

// Uniswap V2 Pair ABI (用于毕业后从 DEX 读取价格)
const UNISWAP_V2_PAIR_ABI = [
  {
    inputs: [],
    name: "getReserves",
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token0",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  // P2-3: Swap event — 用于毕业后 K 线生成
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "sender", type: "address" },
      { indexed: false, name: "amount0In", type: "uint256" },
      { indexed: false, name: "amount1In", type: "uint256" },
      { indexed: false, name: "amount0Out", type: "uint256" },
      { indexed: false, name: "amount1Out", type: "uint256" },
      { indexed: true, name: "to", type: "address" },
    ],
    name: "Swap",
    type: "event",
  },
] as const;

// Uniswap V2 Factory ABI (用于查找 Pair 地址)
const UNISWAP_V2_FACTORY_ABI = [
  {
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
    ],
    name: "getPair",
    outputs: [{ name: "pair", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ============================================================
// State
// ============================================================

const engine = new MatchingEngine();
// ❌ Mode 2: submitter 已移除，不再提交到链上
// let submitter: SettlementSubmitter | null = null;

// ============================================================
// Redis Error Tracking (for health monitoring)
// ============================================================
let redisErrorCount = 0;
let redisErrorCountWindow = 0; // errors in the last 60s window
let lastRedisErrorWindowReset = Date.now();
const REDIS_ERROR_WARN_THRESHOLD = 10; // warn if >10 errors in 60s

function trackRedisError(context: string, err: unknown): void {
  redisErrorCount++;
  redisErrorCountWindow++;
  console.error(`[Redis] ${context}: ${err}`);
  // Reset window counter every 60s
  const now = Date.now();
  if (now - lastRedisErrorWindowReset > 60_000) {
    if (redisErrorCountWindow > REDIS_ERROR_WARN_THRESHOLD) {
      console.warn(`[Redis] ⚠️ HIGH ERROR RATE: ${redisErrorCountWindow} Redis errors in last 60s`);
    }
    redisErrorCountWindow = 0;
    lastRedisErrorWindowReset = now;
  }
}

// ============================================================
// 订单ID生成 — 与 engine.ts generateOrderId 格式一致
// ============================================================
// 用于 close/liquidation/ADL/TP-SL 等非引擎生成的 trade orderId
// 格式: {trader后2位}{YYYYMMDD}{HHmmss}{3位序号}
// 例: 3220260317190435001
let tradeOrderIdCounter = 0;
function generateTradeOrderId(trader: string): string {
  const now = new Date();
  const prefix = trader ? trader.slice(-2).toUpperCase() : "XX";
  const date = now.getFullYear().toString()
    + (now.getMonth() + 1).toString().padStart(2, "0")
    + now.getDate().toString().padStart(2, "0");
  const time = now.getHours().toString().padStart(2, "0")
    + now.getMinutes().toString().padStart(2, "0")
    + now.getSeconds().toString().padStart(2, "0");
  const seq = (++tradeOrderIdCounter % 1000).toString().padStart(3, "0");
  return `${prefix}${date}${time}${seq}`;
}

// ============================================================
// ETH 本位系统: 不再需要 ETH/USD 价格
// ============================================================
// 所有计算直接使用 Token/ETH 价格 (1e18)
// 用户 PnL 只受 Token/ETH 波动影响，与 ETH/USD 无关

// Server state (for graceful shutdown)
let httpServer: import("http").Server | null = null;
let fundingRateCalcInterval: NodeJS.Timeout | null = null;
let rateLimitCleanupInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;
// WebSocket state
let wss: WebSocketServer | null = null;
const wsClients = new Map<WebSocket, Set<Address>>(); // client => subscribed tokens
const wsTraderClients = new Map<Address, Set<WebSocket>>(); // trader => websocket connections (for risk data)
const wsRiskSubscribers = new Set<WebSocket>(); // clients subscribed to global risk data
const wsMarketStatsSubscribers = new Set<WebSocket>(); // clients subscribed to all_market_stats broadcast

// Risk broadcast throttling
let lastRiskBroadcast = 0;
const RISK_BROADCAST_INTERVAL_MS = 500; // Broadcast risk data every 500ms max

// Liquidation map broadcast throttling (per token)
const lastLiquidationMapBroadcast = new Map<Address, number>();
const LIQUIDATION_MAP_BROADCAST_INTERVAL_MS = 2000; // 2 seconds between broadcasts per token

// User nonces - 撮合引擎自行追踪，防止签名重放攻击
// P0-1: 每个 trader 的 nonce 必须严格递增
// AUDIT-FIX ME-C06: L1 in-memory cache, backed by Redis (loaded on startup, write-through on update)
const userNonces = new Map<Address, bigint>();

// Submitted pairs tracking
const submittedMatches = new Map<string, Match>();

// Position tracking (from on-chain events, simplified for now)
/**
 * 仓位信息 (ETH 本位 - 参考 OKX/Binance/Bybit)
 *
 * Meme Perp 特有字段：
 * - bankruptcyPrice: 穿仓价格
 * - mmr: 动态维持保证金率 (meme 需要更高)
 * - adlScore: ADL 评分用于排序
 *
 * ETH 本位: 所有价格/保证金/盈亏都以 ETH 计价 (1e18 精度)
 */
interface Position {
  // === 基本标识 ===
  pairId: string;
  trader: Address;
  token: Address;

  // === 仓位参数 ===
  isLong: boolean;
  size: string;                   // 仓位大小 (代币数量, 1e18)
  entryPrice: string;             // 开仓均价 (ETH/Token, 1e18)
  averageEntryPrice: string;      // 加仓后的平均价格 (ETH/Token, 1e18)
  leverage: string;               // 杠杆倍数 (整数)

  // === 价格信息 ===
  markPrice: string;              // 标记价格 (ETH/Token, 1e18)
  liquidationPrice: string;       // 强平价格 (ETH/Token, 1e18)
  bankruptcyPrice: string;        // 穿仓价格 (ETH/Token, 1e18)
  breakEvenPrice: string;         // 盈亏平衡价格 (含手续费, 1e18)

  // === 保证金信息 (ETH 本位) ===
  collateral: string;             // 初始保证金 (1e18 ETH)
  margin: string;                 // 当前保证金 = 初始 + UPNL (1e18 ETH)
  marginRatio: string;            // 保证金率 (基点, 10000 = 100%)
  mmr: string;                    // 维持保证金率 (基点, 动态调整)
  maintenanceMargin: string;      // 维持保证金金额 (1e18 ETH)

  // === 盈亏信息 (ETH 本位) ===
  unrealizedPnL: string;          // 未实现盈亏 (1e18 ETH)
  realizedPnL: string;            // 已实现盈亏 (1e18 ETH)
  roe: string;                    // 收益率 ROE% (基点)
  fundingFee: string;             // 累计资金费 (1e18 ETH)

  // === 止盈止损 ===
  takeProfitPrice: string | null;
  stopLossPrice: string | null;

  // === 关联订单 ===
  orderId: string;                // 创建此仓位的订单ID (排查用)
  orderIds: string[];             // 所有关联订单ID (加仓时追加)

  // === 系统信息 ===
  counterparty: Address;
  createdAt: number;
  updatedAt: number;

  // === ADL 风险指标 (Meme Perp 核心) ===
  adlRanking: number;             // ADL 排名等级 (1-5, 5最危险)
  adlScore: string;               // ADL 评分 = (UPNL% / margin) × leverage
  riskLevel: "low" | "medium" | "high" | "critical"; // 风险等级
  isLiquidatable: boolean;        // 是否可被强平
  isAdlCandidate: boolean;        // 是否为 ADL 候选 (盈利方)
}
const userPositions = new Map<Address, Position[]>();

// ════════════════════════════════════════════════════════════════
// Price staleness tracking (GMX Oracle.sol maxPriceAge pattern)
// Records when each token's price was last successfully updated.
// Orders are rejected if price is older than TRADING.MAX_PRICE_AGE_MS.
// ════════════════════════════════════════════════════════════════
const priceLastUpdatedAt = new Map<string, number>(); // token (lowercase) → Date.now() ms

function isPriceStale(token: Address): boolean {
  const lastUpdate = priceLastUpdatedAt.get(token.toLowerCase());
  if (!lastUpdate) return true; // never updated = stale
  return (Date.now() - lastUpdate) > TRADING.MAX_PRICE_AGE_MS;
}

// 主钱包 → 派生钱包地址映射 (register-session 时填充, Redis 持久化)
const traderToDerivedWallet = new Map<Address, Address>();
// Redis key for owner→derived mapping persistence
const DERIVED_WALLET_MAP_KEY = "memeperp:owner_to_derived";

// 用户交易历史 (强平、ADL、正常平仓等)
const userTrades = new Map<Address, TradeRecord[]>();

// ============================================================
// Redis 数据同步函数
// ============================================================

/**
 * 从 Redis 加载所有仓位到内存
 */
async function loadPositionsFromRedis(): Promise<void> {
  if (!db.isConnected()) return;

  try {
    const dbPositions = await PositionRepo.getAll();
    console.log(`[Redis] Loading ${dbPositions.length} positions from database...`);

    let loaded = 0;
    let skippedLiquidating = 0;

    for (const dbPos of dbPositions) {
      try {
        // deserializePosition 已兼容旧格式 (userAddress→trader, symbol→token, side→isLong, initialMargin→collateral)
        // 跳过正在被强平的仓位 (上次重启前未完成的强平)
        if (dbPos.isLiquidating) {
          skippedLiquidating++;
          console.log(`[Redis] Skipping liquidating position: ${dbPos.id} (${dbPos.trader?.slice(0, 10) || '?'})`);
          // 从 Redis 中删除已标记为强平的仓位 (清理过期数据)
          PositionRepo.delete(dbPos.id).catch(e => trackRedisError("Failed to delete liquidating position", e));
          continue;
        }

        // ✅ 清理僵尸仓位: collateral=0 且 size>0 说明已被强平但未从 Redis 清理
        // ⚠️ Redis 中用 initialMargin (DB schema), 内存中用 collateral — 必须两个都检查
        const posCollateral = BigInt(
          dbPos.initialMargin?.toString() || dbPos.collateral?.toString() || "0"
        );
        const posSize = BigInt(dbPos.size?.toString() || "0");
        if (posCollateral <= 0n && posSize > 0n) {
          skippedLiquidating++;
          console.log(`[Redis] Cleaning zombie position (collateral=0): ${dbPos.id} (${(dbPos.trader || dbPos.userAddress)?.slice(0, 10) || '?'} size=${dbPos.size})`);
          PositionRepo.delete(dbPos.id).catch(e => trackRedisError("Failed to delete zombie position", e));
          continue;
        }

        // 验证必要字段
        // dbPos.trader 来自 deserializePosition，已兼容旧格式 (data.trader || data.userAddress)
        const traderRaw = dbPos.trader || (dbPos as any).userAddress || "";
        const userAddr = traderRaw.toLowerCase() as Address;
        if (!userAddr || userAddr.length < 10) {
          console.warn(`[Redis] Skipping position with empty trader: ${dbPos.id} (raw trader='${traderRaw}', keys=${Object.keys(dbPos).slice(0, 5).join(",")})`);
          continue;
        }

        // token 也需要兼容旧格式
        const tokenRaw = dbPos.token || ((dbPos as any).symbol ? (dbPos as any).symbol.replace("-ETH", "") : "");
        const tokenAddr = tokenRaw.toLowerCase() as Address;
        if (!tokenAddr || tokenAddr.length < 10) {
          console.warn(`[Redis] Skipping position with empty token: ${dbPos.id} (raw token='${tokenRaw}')`);
          continue;
        }

        // deserializePosition 返回 bigint 字段 (types.ts Position)
        // 内存中用 string 字段 (server.ts local Position) — 必须全部转换
        const memPos: Position = {
          id: dbPos.id,
          pairId: dbPos.pairId || dbPos.id,
          trader: userAddr,
          token: tokenAddr,
          counterparty: dbPos.counterparty || ("0x0000000000000000000000000000000000000000" as Address),
          isLong: dbPos.isLong,
          size: dbPos.size?.toString() || "0",
          entryPrice: dbPos.entryPrice?.toString() || "0",
          averageEntryPrice: dbPos.averageEntryPrice?.toString() || dbPos.entryPrice?.toString() || "0",
          leverage: dbPos.leverage?.toString() || "1",
          markPrice: dbPos.markPrice?.toString() || "0",
          liquidationPrice: dbPos.liquidationPrice?.toString() || "0",
          bankruptcyPrice: dbPos.bankruptcyPrice?.toString() || "0",
          breakEvenPrice: dbPos.breakEvenPrice?.toString() || "0",
          collateral: dbPos.collateral?.toString() || dbPos.margin?.toString() || "0",
          margin: dbPos.margin?.toString() || dbPos.collateral?.toString() || "0",
          marginRatio: dbPos.marginRatio?.toString() || "10000",
          mmr: dbPos.mmr?.toString() || "200",
          maintenanceMargin: dbPos.maintenanceMargin?.toString() || "0",
          unrealizedPnL: dbPos.unrealizedPnL?.toString() || "0",
          realizedPnL: dbPos.realizedPnL?.toString() || "0",
          roe: dbPos.roe?.toString() || "0",
          fundingFee: dbPos.accumulatedFunding?.toString() || "0",
          takeProfitPrice: dbPos.takeProfitPrice?.toString() || null,
          stopLossPrice: dbPos.stopLossPrice?.toString() || null,
          orderId: "",
          orderIds: [],
          adlRanking: dbPos.adlRanking || 1,
          adlScore: dbPos.adlScore?.toString() || "0",
          riskLevel: dbPos.riskLevel || "low",
          isLiquidatable: dbPos.riskLevel === "critical",
          isAdlCandidate: false,
          accFundingFee: dbPos.accumulatedFunding?.toString() || "0",
          fundingIndex: dbPos.fundingIndex?.toString() || "0",
          createdAt: dbPos.createdAt || Date.now(),
          updatedAt: dbPos.updatedAt || Date.now(),
        };

        const existing = userPositions.get(userAddr) || [];

        // ✅ 修复: 去重 — 同一 (token, isLong) 只保留最新的仓位 (最大 size)
        // 防止旧 bug 导致的重复 Redis 记录全部加载到内存
        const dupeIndex = existing.findIndex(
          (p) => p.token === tokenAddr && p.isLong === memPos.isLong
        );
        if (dupeIndex >= 0) {
          const dupePos = existing[dupeIndex];
          // 保留 size 更大的那个 (最终合并后的仓位)
          if (BigInt(memPos.size) > BigInt(dupePos.size)) {
            console.log(`[Redis] Dedup: replacing ${dupePos.pairId.slice(0, 12)} (size=${dupePos.size}) with ${memPos.pairId.slice(0, 12)} (size=${memPos.size})`);
            // 删除旧的重复记录
            PositionRepo.delete(dupePos.pairId).catch(e =>
              console.error(`[Redis] Failed to delete duplicate position:`, e));
            existing[dupeIndex] = memPos;
          } else {
            // 当前记录 size 更小，说明它是旧的部分成交记录，删除它
            PositionRepo.delete(memPos.pairId).catch(e =>
              console.error(`[Redis] Failed to delete duplicate position:`, e));
          }
        } else {
          existing.push(memPos);
        }

        userPositions.set(userAddr, existing);
        loaded++;
      } catch (posError) {
        console.error(`[Redis] Failed to load position ${dbPos.id}:`, posError);
      }
    }

    console.log(`[Redis] Loaded ${loaded} positions into memory (skipped ${skippedLiquidating} liquidating)`);
  } catch (error) {
    console.error("[Redis] Failed to load positions:", error);
  }
}

/**
 * 从 Redis 加载所有待处理订单到撮合引擎
 */
async function loadOrdersFromRedis(): Promise<void> {
  if (!db.isConnected()) return;

  try {
    let totalOrders = 0;
    const symbols = new Set<string>();

    // 获取所有支持的代币
    for (const token of SUPPORTED_TOKENS) {
      const symbol = `${token.slice(0, 10).toUpperCase()}-ETH`;
      symbols.add(symbol);
    }

    console.log(`[Redis] Loading orders from ${symbols.size} symbols...`);

    // 从数据库加载每个交易对的待处理订单
    for (const symbol of symbols) {
      const dbOrders = await OrderRepo.getPendingBySymbol(symbol);

      for (const dbOrder of dbOrders) {
        // 将数据库订单转换为引擎订单格式
        const engineOrder: Order = {
          id: dbOrder.id,
          clientOrderId: undefined,
          trader: dbOrder.userAddress,
          token: dbOrder.token,
          isLong: dbOrder.side === "LONG",
          size: BigInt(dbOrder.size),
          leverage: BigInt(Math.floor(dbOrder.leverage * 10000)), // 5x -> 50000
          price: BigInt(dbOrder.price),
          orderType: dbOrder.orderType === "MARKET" ? OrderType.MARKET : OrderType.LIMIT,
          timeInForce: TimeInForce.GTC,
          reduceOnly: dbOrder.reduceOnly,
          postOnly: dbOrder.postOnly,
          status: OrderStatus.PENDING,
          filledSize: BigInt(dbOrder.filledSize),
          avgFillPrice: BigInt(dbOrder.avgFillPrice),
          totalFillValue: 0n,
          fee: BigInt(dbOrder.fee),
          feeCurrency: "BNB",
          margin: BigInt(dbOrder.margin),
          collateral: BigInt(dbOrder.margin),
          takeProfitPrice: dbOrder.triggerPrice ? BigInt(dbOrder.triggerPrice) : undefined,
          stopLossPrice: undefined,
          createdAt: dbOrder.createdAt,
          updatedAt: dbOrder.updatedAt,
          deadline: BigInt(dbOrder.deadline),
          nonce: BigInt(dbOrder.nonce),
          signature: dbOrder.signature as Hex,
          source: OrderSource.API,
        };

        // 添加到引擎的 allOrders Map
        engine.allOrders.set(engineOrder.id, engineOrder);

        // 添加到订单簿
        const orderBook = engine.getOrderBook(dbOrder.token);
        orderBook.addOrder(engineOrder);

        totalOrders++;
      }
    }

    console.log(`[Redis] ✅ Loaded ${totalOrders} pending orders into orderbook`);
  } catch (error) {
    console.error("[Redis] ❌ Failed to load orders:", error);
  }
}

/**
 * 保存仓位到 Redis
 *
 * ✅ 修复 1：用 token + trader + isLong 查找已有仓位，避免重复创建
 * ✅ 修复 2：per-user 锁防止并发写入创建重复记录 (partial fill 批量成交场景)
 *
 * 原理：当同一用户的多笔部分成交在同一个撮合批次中完成时，
 * 多次异步 savePositionToRedis 可能并行执行。
 * 没有锁时，第2-N次调用会在第1次创建完成前查询 Redis，找不到已有记录，
 * 从而各自创建新记录，导致同一仓位出现多条 Redis 记录（僵尸仓位）。
 */
const positionSaveLocks = new Map<string, Promise<string | null>>();

async function savePositionToRedis(position: Position): Promise<string | null> {
  if (!db.isConnected()) return null;

  // 构建锁 key: trader + token + side
  const lockKey = `${position.trader}_${position.token}_${position.isLong}`.toLowerCase();

  // 等待同一仓位的前一次保存完成 (串行化)
  const prevLock = positionSaveLocks.get(lockKey);
  if (prevLock) {
    await prevLock.catch(() => {}); // 忽略前一次的错误
  }

  // 创建新的锁 promise
  const savePromise = _doSavePositionToRedis(position);
  positionSaveLocks.set(lockKey, savePromise);

  try {
    return await savePromise;
  } finally {
    // 只有当前 promise 仍是最新的锁时才清理
    if (positionSaveLocks.get(lockKey) === savePromise) {
      positionSaveLocks.delete(lockKey);
    }
  }
}

async function _doSavePositionToRedis(position: Position): Promise<string | null> {
  try {
    // ⚠️ 直接使用 Position 对象保存到 Redis — 不用 memoryPositionToDB()
    // memoryPositionToDB 把 collateral→initialMargin, trader→userAddress 等字段名映射
    // 这导致 serializePosition 找不到 collateral 字段而 crash, 每次保存都静默失败

    // 先按 token + trader + isLong 查找已有仓位
    const existingPositions = await PositionRepo.getByUser(position.trader);
    const existing = existingPositions.find(
      (p) => p.token === position.token &&
             p.isLong === position.isLong  // ✅ 用 isLong 比较, 不用 p.side (deserialized Position 没有 side 字段)
    );

    let redisId: string;
    if (existing) {
      // 更新已有仓位 — 直接传 position (不是 DBPosition)
      await PositionRepo.update(existing.id, position);
      redisId = existing.id;
    } else {
      // 创建新仓位 — 直接传 position
      const created = await PositionRepo.create(position);
      console.log(`[Redis] Position created: ${created.id} (trader=${position.trader.slice(0, 10)})`);
      redisId = created.id;
    }

    // PostgreSQL 镜像 (fire-and-forget，不阻塞撮合)
    if (isPostgresConnected()) {
      const pgPos = memoryPositionToPgMirror(position);
      pgPos.id = position.pairId || redisId; // 确保使用稳定 ID
      pgMirrorWrite(PositionMirrorRepo.upsert(pgPos), `PositionUpsert:${pgPos.id.slice(0, 16)}`);
    }

    return redisId;
  } catch (error) {
    console.error("[Redis] Failed to save position:", error);
    return null;
  }
}

/**
 * 从 Redis 删除仓位
 * closeData: 平仓信息 (价格/盈亏/手续费)，用于 PG 历史记录
 */
async function deletePositionFromRedis(
  positionId: string,
  closeStatus: "CLOSED" | "LIQUIDATED" = "CLOSED",
  traderHint?: Address,
  closeData?: { closePrice?: string; closingPnl?: string; closeFee?: string },
): Promise<boolean> {
  if (!db.isConnected()) return false;

  try {
    // 先尝试直接删除 (positionId 可能就是 Redis UUID)
    let deleted = await PositionRepo.delete(positionId);

    // ✅ 如果直接删除失败, 说明 positionId 是 pairId 而非 Redis UUID
    // 需要按 trader 遍历查找真正的 Redis ID
    if (!deleted && traderHint) {
      const userPositionIds = await PositionRepo.getByUser(traderHint);
      for (const pos of userPositionIds) {
        if (pos.pairId === positionId || pos.id === positionId) {
          deleted = await PositionRepo.delete(pos.id);
          if (deleted) {
            console.log(`[Redis] Deleted position by pairId lookup: ${pos.id} (pairId=${positionId})`);
            break;
          }
        }
      }
    }

    // PostgreSQL 镜像: 软删除 + 记录平仓数据
    if (isPostgresConnected()) {
      pgMirrorWrite(PositionMirrorRepo.markClosed(positionId, closeStatus, closeData), `PositionClose:${positionId.slice(0, 16)}`);
    }

    return deleted;
  } catch (error) {
    console.error("[Redis] Failed to delete position:", error);
    return false;
  }
}

/**
 * 更新 Redis 中的仓位风险指标
 */
async function updatePositionRiskInRedis(positionId: string, updates: Partial<Position>): Promise<void> {
  if (!db.isConnected()) return;

  try {
    await PositionRepo.update(positionId, updates);
  } catch (error) {
    console.error("[Redis] Failed to update position risk:", error);
  }
}

/**
 * 记录结算流水
 */
async function logSettlement(
  userAddress: Address,
  type: SettlementLog["type"],
  amount: string,
  balanceBefore: string,
  balanceAfter: string,
  proofData: Record<string, unknown>,
  positionId?: string,
  orderId?: string
): Promise<void> {
  if (!db.isConnected()) return;

  try {
    await SettlementLogRepo.create({
      userAddress,
      type,
      amount,
      balanceBefore,
      balanceAfter,
      onChainStatus: "PENDING",
      proofData: JSON.stringify(proofData),
      positionId,
      orderId,
      txHash: null,
    });
  } catch (error) {
    console.error("[Redis] Failed to log settlement:", error);
  }
}

/**
 * 转换: 内存 Position → DB Position
 * ETH 本位: 所有金额字段都是 ETH (1e18 精度)
 */
function memoryPositionToDB(pos: Position): Omit<DBPosition, "id" | "createdAt" | "updatedAt"> {
  return {
    userAddress: pos.trader.toLowerCase() as Address,
    symbol: `${pos.token}-ETH`,  // ETH 本位交易对
    side: pos.isLong ? "LONG" : "SHORT",
    size: pos.size,
    entryPrice: pos.entryPrice,
    leverage: Number(pos.leverage),
    marginType: "ISOLATED",
    initialMargin: pos.collateral,  // 1e18 ETH
    maintMargin: pos.maintenanceMargin || "0",  // 1e18 ETH
    fundingIndex: pos.fundingIndex || "0",
    fundingFee: pos.fundingFee || "0",  // 累计资金费 (负数=已扣除)
    isLiquidating: pos.isLiquidating || false,
    markPrice: pos.markPrice,
    unrealizedPnL: pos.unrealizedPnL,  // 1e18 ETH
    marginRatio: pos.marginRatio,
    liquidationPrice: pos.liquidationPrice,
    riskLevel: pos.riskLevel,
    adlScore: pos.adlScore,
    adlRanking: pos.adlRanking,
  };
}

/**
 * 转换: 内存 Position → PgPositionMirror (PostgreSQL 镜像)
 * V2: 完整映射所有 Position 字段，与主流交易所仓位信息对齐
 */
function memoryPositionToPgMirror(pos: Position, status: "OPEN" | "CLOSED" | "LIQUIDATED" = "OPEN"): PgPositionMirror {
  const now = Date.now();
  const s = (v: any) => (v ?? "0").toString(); // bigint/string → string, null/undefined → "0"
  return {
    // 基本标识
    id: pos.pairId,
    trader: pos.trader.toLowerCase(),
    token: pos.token.toLowerCase(),
    symbol: `${pos.token.toLowerCase()}-ETH`,
    counterparty: (pos.counterparty || "").toLowerCase(),

    // 仓位参数
    is_long: pos.isLong,
    size: s(pos.size),
    entry_price: s(pos.entryPrice || pos.averageEntryPrice),
    average_entry_price: s(pos.averageEntryPrice || pos.entryPrice),
    leverage: Number(pos.leverage) || 1,
    margin_mode: pos.marginMode ?? 0,

    // 价格信息
    mark_price: s(pos.markPrice),
    liquidation_price: s(pos.liquidationPrice),
    bankruptcy_price: s(pos.bankruptcyPrice),
    break_even_price: s(pos.breakEvenPrice),

    // 保证金信息
    collateral: s(pos.collateral),
    margin: s(pos.margin),
    margin_ratio: s(pos.marginRatio || "10000"),
    mmr: s(pos.mmr),
    maintenance_margin: s(pos.maintenanceMargin),

    // 盈亏信息
    unrealized_pnl: s(pos.unrealizedPnL),
    realized_pnl: s(pos.realizedPnL),
    roe: s(pos.roe),
    accumulated_funding: s((pos as any).fundingFee ?? pos.accumulatedFunding),

    // 止盈止损
    tp_price: pos.takeProfitPrice != null ? pos.takeProfitPrice.toString() : null,
    sl_price: pos.stopLossPrice != null ? pos.stopLossPrice.toString() : null,

    // 风险指标
    adl_ranking: pos.adlRanking || 1,
    adl_score: s(pos.adlScore),
    risk_level: pos.riskLevel || "low",
    is_liquidatable: pos.isLiquidatable || false,
    is_adl_candidate: pos.isAdlCandidate || false,

    // 状态
    status,
    funding_index: s(pos.fundingIndex),
    is_liquidating: pos.isLiquidating || false,

    // 时间戳
    created_at: pos.createdAt || now,
    updated_at: now,

    // 平仓信息 (开仓时为 null)
    close_price: null,
    closing_pnl: null,
    close_fee: null,
    closed_at: null,
  };
}

/**
 * 转换: DB Position → 内存 Position
 */
function dbPositionToMemory(dbPos: DBPosition): Position {
  const token = dbPos.symbol.replace("-ETH", "") as Address;
  return {
    pairId: dbPos.id,
    trader: dbPos.userAddress,
    token,
    isLong: dbPos.side === "LONG",
    size: dbPos.size,
    entryPrice: dbPos.entryPrice,
    leverage: dbPos.leverage.toString(),
    collateral: dbPos.initialMargin,
    maintenanceMargin: dbPos.maintMargin,
    margin: dbPos.initialMargin,
    markPrice: dbPos.markPrice || "0",
    unrealizedPnL: dbPos.unrealizedPnL || "0",
    marginRatio: dbPos.marginRatio || "10000",
    mmr: "200",
    liquidationPrice: dbPos.liquidationPrice || "0",
    bankruptcyPrice: "0",
    roe: "0",
    realizedPnL: "0",
    accFundingFee: dbPos.fundingFee || "0",
    fundingFee: dbPos.fundingFee || "0",
    adlRanking: dbPos.adlRanking || 1,
    adlScore: dbPos.adlScore || "0",
    riskLevel: dbPos.riskLevel || "low",
    isLiquidatable: dbPos.riskLevel === "critical",
    isAdlCandidate: false,
    fundingIndex: dbPos.fundingIndex || "0",
    isLiquidating: dbPos.isLiquidating,
    createdAt: dbPos.createdAt,
    updatedAt: dbPos.updatedAt,
  };
}

// ============================================================
// ADL 自动减仓系统 (Meme Perp 核心)
// ============================================================

/**
 * ADL 队列 - 按 adlScore 排序的盈利仓位
 * 当穿仓发生时，从队列头部开始减仓
 */
interface ADLQueue {
  token: Address;
  longQueue: Position[];   // 多头盈利队列 (按 adlScore 降序)
  shortQueue: Position[];  // 空头盈利队列 (按 adlScore 降序)
}
const adlQueues = new Map<Address, ADLQueue>();

/**
 * 强平队列 - 按 marginRatio 排序
 * 优先强平高风险仓位
 */
interface LiquidationCandidate {
  position: Position;
  marginRatio: number;     // 当前保证金率 (越低越危险)
  urgency: number;         // 紧急程度 (0-100)
}
const liquidationQueue: LiquidationCandidate[] = [];

/**
 * 计算 ADL Score
 * 公式: ADL Score = (UPNL / Margin) × Leverage
 *
 * 盈利越多、杠杆越高，ADL 风险越高
 */
// P3-P2: BigInt-safe ADL score — Number() loses precision above 0.009 ETH (9e15 > MAX_SAFE_INTEGER)
function calculateADLScore(position: Position): bigint {
  const upnl = BigInt(position.unrealizedPnL);
  const margin = BigInt(position.collateral);
  const leverage = BigInt(Math.round(parseFloat(position.leverage) * 10000)); // 1e4 basis points

  if (margin === 0n) return 0n;

  // 只有盈利的仓位才有 ADL 风险
  if (upnl <= 0n) return 0n;

  // ADL Score = (UPNL / margin) × leverage, scaled by 1e8 to preserve precision
  // score = upnl * leverage * 1e8 / margin
  return (upnl * leverage * 100_000_000n) / margin;
}

/**
 * 计算 ADL 排名 (1-5)
 * 1 = 最安全, 5 = 最危险 (最可能被 ADL)
 */
// P3-P2: BigInt-safe ADL ranking
function calculateADLRanking(score: bigint, allScores: bigint[]): number {
  if (score <= 0n) return 1; // 亏损仓位不会被 ADL

  // 按分位数划分 (BigInt comparison for sort)
  const sorted = allScores.filter(s => s > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length === 0) return 1;

  const percentile = sorted.findIndex(s => s >= score) / sorted.length;

  if (percentile >= 0.8) return 5;      // Top 20% 最危险
  if (percentile >= 0.6) return 4;
  if (percentile >= 0.4) return 3;
  if (percentile >= 0.2) return 2;
  return 1;
}

/**
 * 更新 ADL 队列
 */
function updateADLQueues(): void {
  // 清空旧队列
  adlQueues.clear();

  // 遍历所有仓位，按 token 分组
  for (const [trader, positions] of userPositions.entries()) {
    for (const pos of positions) {
      const token = pos.token.toLowerCase() as Address;

      // 获取或创建队列
      let queue = adlQueues.get(token);
      if (!queue) {
        queue = { token, longQueue: [], shortQueue: [] };
        adlQueues.set(token, queue);
      }

      // 只有盈利的仓位才加入 ADL 队列
      const upnl = Number(pos.unrealizedPnL);
      if (upnl > 0) {
        if (pos.isLong) {
          queue.longQueue.push(pos);
        } else {
          queue.shortQueue.push(pos);
        }
      }
    }
  }

  // 按 adlScore 降序排序
  for (const [token, queue] of adlQueues.entries()) {
    queue.longQueue.sort((a, b) => { const diff = BigInt(b.adlScore || "0") - BigInt(a.adlScore || "0"); return diff < 0n ? -1 : diff > 0n ? 1 : 0; });
    queue.shortQueue.sort((a, b) => { const diff = BigInt(b.adlScore || "0") - BigInt(a.adlScore || "0"); return diff < 0n ? -1 : diff > 0n ? 1 : 0; });
  }
}

/**
 * 执行 ADL 减仓
 * 当穿仓发生时调用
 *
 * @param bankruptPosition 穿仓的仓位
 * @param deficit 穿仓金额 (需要从对手方减仓的金额)
 */
async function executeADL(
  bankruptPosition: Position,
  deficit: bigint
): Promise<void> {
  const token = bankruptPosition.token.toLowerCase() as Address;

  // ADL 诊断日志
  console.log(`[ADL] Executing for bankrupt ${bankruptPosition.isLong ? 'LONG' : 'SHORT'} position: token=${token.slice(0, 10)}, deficit=Ξ${Number(deficit) / 1e18}`);
  console.log(`[ADL] ADL queues available: ${adlQueues.size} tokens`);
  for (const [qToken, q] of adlQueues) {
    console.log(`[ADL]   ${qToken.slice(0, 10)}: longs=${q.longQueue.length}, shorts=${q.shortQueue.length}`);
  }

  let queue = adlQueues.get(token);

  if (!queue) {
    // 尝试刷新 ADL 队列 (可能仓位加载后 PnL 未更新)
    console.log(`[ADL] No queue for token ${token.slice(0, 10)}, refreshing ADL queues...`);
    updateADLQueues();
    queue = adlQueues.get(token);
  }

  if (!queue) {
    console.log(`[ADL] Still no queue after refresh, socializing loss`);
    socializeLoss(token, deficit);
    return;
  }

  // 穿仓的是多头，需要从空头盈利队列减仓
  // 穿仓的是空头，需要从多头盈利队列减仓
  const targetQueue = bankruptPosition.isLong ? queue.shortQueue : queue.longQueue;
  const queueType = bankruptPosition.isLong ? "SHORT (profit)" : "LONG (profit)";

  if (targetQueue.length === 0) {
    console.log(`[ADL] No ${queueType} positions to ADL against, socializing loss: Ξ${Number(deficit) / 1e18}`);
    socializeLoss(token, deficit);
    return;
  }

  console.log(`[ADL] Found ${targetQueue.length} ${queueType} positions for ADL`);

  let remainingDeficit = deficit;
  const adlTargets: { position: Position; amount: bigint }[] = [];

  // 从队列头部开始减仓 (盈利最多的先被减仓)
  for (const pos of targetQueue) {
    if (remainingDeficit <= 0n) break;

    const positionValue = BigInt(pos.collateral) + BigInt(pos.unrealizedPnL);

    if (positionValue <= 0n) continue;

    // 计算需要减仓的金额 (取对方盈利和剩余亏损的较小值)
    const adlAmount = remainingDeficit > positionValue ? positionValue : remainingDeficit;

    adlTargets.push({ position: pos, amount: adlAmount });
    remainingDeficit -= adlAmount;

    console.log(`[ADL] Target: ${pos.trader.slice(0, 10)} ${pos.isLong ? 'LONG' : 'SHORT'} deduct=$${Number(adlAmount) / 1e18}`);
  }

  // 执行 ADL: 从对手方仓位中扣除金额
  const currentPrice = engine.getOrderBook(token).getCurrentPrice();

  for (const { position, amount } of adlTargets) {
    try {
      const normalizedTrader = position.trader.toLowerCase() as Address;

      // 计算减仓比例
      const positionValue = BigInt(position.collateral) + BigInt(position.unrealizedPnL);
      const adlRatio = Number(amount) / Number(positionValue);

      console.log(`[ADL] Executing ADL on pairId ${position.pairId}, ratio=${(adlRatio * 100).toFixed(2)}%`);

      if (adlRatio >= 0.99) {
        // 全部平仓
        const positions = userPositions.get(normalizedTrader) || [];
        const updatedPositions = positions.filter(p => p.pairId !== position.pairId);
        userPositions.set(normalizedTrader, updatedPositions);

        // 退还剩余抵押品 (扣除 ADL 金额后)
        const refund = positionValue - amount;
        if (refund > 0n) {
          adjustUserBalance(normalizedTrader, refund, "ADL_CLOSE_REFUND");
        }
        // Mode 2: ADL 的链下调整 = 退款 - 原始保证金 (损失部分)
        const adlAdjustment = refund - BigInt(position.collateral);
        addMode2Adjustment(normalizedTrader, adlAdjustment, "ADL_CLOSE");

        // ★ FIX: Sync Redis + PG mirror (was missing — caused PG OPEN count drift)
        try {
          await deletePositionFromRedis(position.pairId, "LIQUIDATED", normalizedTrader, {
            closePrice: currentPrice.toString(),
            closingPnl: adlAdjustment.toString(),
          });
        } catch (e) {
          console.error(`[ADL] CRITICAL: Failed to delete position from Redis/PG: ${e}`);
        }

        console.log(`[ADL] Position ${position.pairId} fully closed, refund: $${Number(refund) / 1e18}`);
      } else {
        // 部分平仓 - 减少仓位大小和抵押品
        const ratioMultiplier = BigInt(Math.floor((1 - adlRatio) * 1e6));
        const newCollateral = (BigInt(position.collateral) * ratioMultiplier) / 1000000n;
        const newSize = (BigInt(position.size) * ratioMultiplier) / 1000000n;

        position.collateral = newCollateral.toString();
        position.size = newSize.toString();
        position.margin = newCollateral.toString();

        // ★ FIX: Persist partial ADL to Redis + PG mirror (was missing)
        try {
          await savePositionToRedis(position);
        } catch (e) {
          console.error(`[ADL] CRITICAL: Failed to persist partial ADL to Redis/PG: ${e}`);
        }

        console.log(`[ADL] Position ${position.pairId} reduced by ${(adlRatio * 100).toFixed(2)}%`);
      }

      // ✅ 记录 ADL 成交到 userTrades
      const adlTrade: TradeRecord = {
        id: `adl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        orderId: generateTradeOrderId(position.trader),
        pairId: position.pairId,
        token: position.token,
        trader: position.trader,
        isLong: position.isLong,
        isMaker: false,
        size: (adlRatio >= 0.99 ? BigInt(position.size) : (BigInt(position.size) * BigInt(Math.floor(adlRatio * 1e6)) / 1000000n)).toString(),
        price: currentPrice.toString(),
        fee: "0",
        realizedPnL: (-amount).toString(),
        timestamp: Date.now(),
        type: "adl",
      };
      const adlTraderTrades = userTrades.get(normalizedTrader) || [];
      adlTraderTrades.push(adlTrade);
      userTrades.set(normalizedTrader, adlTraderTrades);
      createTradeWithMirror({
        orderId: adlTrade.orderId, pairId: adlTrade.pairId,
        token: token, trader: normalizedTrader,
        isLong: adlTrade.isLong, isMaker: false,
        size: adlTrade.size, price: adlTrade.price,
        fee: "0", realizedPnL: adlTrade.realizedPnL,
        timestamp: adlTrade.timestamp, type: "adl",
      }, "adl");

      // ✅ 记录 ADL 账单 (穿仓补偿)
      // FIX: 使用 computeSettlementBalance 替代硬编码 "0"
      const adlEffectiveAfter = computeSettlementBalance(normalizedTrader);
      createBillWithMirror({
        userAddress: normalizedTrader,
        type: "SETTLE_PNL",
        amount: (-amount).toString(),
        balanceBefore: adlEffectiveAfter.toString(),
        balanceAfter: adlEffectiveAfter.toString(),
        onChainStatus: "ENGINE_SETTLED",
        proofData: JSON.stringify({
          token: position.token, pairId: position.pairId,
          isLong: position.isLong, adlRatio: adlRatio.toFixed(4),
          deductAmount: amount.toString(), closeType: "adl",
        }),
        positionId: position.pairId, orderId: adlTrade.orderId, txHash: null,
      });

      // 广播 ADL 事件
      broadcastADLEvent(position, amount, currentPrice);
    } catch (e) {
      console.error(`[ADL] Failed to execute ADL on ${position.pairId}:`, e);
    }
  }

  // ============================================================
  // 链上 ADL 同步 (best-effort, 不阻塞链下流程)
  // ============================================================
  if (adlTargets.length > 0 && MATCHER_PRIVATE_KEY && LIQUIDATION_ADDRESS_LOCAL) {
    (async () => {
      try {
        const sortedUsers = adlTargets.map(t => t.position.trader as Address);
        // targetSide: true=减少多头, false=减少空头
        // 穿仓的是多头 → 减仓空头盈利方 → targetSide=false
        // 穿仓的是空头 → 减仓多头盈利方 → targetSide=true
        const targetSide = !bankruptPosition.isLong;

        const adlAccount = privateKeyToAccount(MATCHER_PRIVATE_KEY);
        const adlWalletClient = createWalletClient({
          account: adlAccount,
          chain: activeChain,
          transport: rpcTransport,
        });

        const tx = await adlWalletClient.writeContract({
          address: LIQUIDATION_ADDRESS_LOCAL,
          abi: [{
            name: "executeADLWithSortedUsers",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "sortedUsers", type: "address[]" },
              { name: "targetSide", type: "bool" },
              { name: "targetAmount", type: "uint256" },
            ],
            outputs: [],
          }] as const,
          functionName: "executeADLWithSortedUsers",
          args: [sortedUsers, targetSide, deficit],
        });
        console.log(`[ADL] On-chain ADL sync submitted: ${tx}`);
      } catch (e: any) {
        const msg = e?.shortMessage || e?.message || String(e);
        console.error(`[ADL] On-chain ADL sync failed (off-chain already executed): ${msg.slice(0, 100)}`);
        // Non-fatal: off-chain state is already correct
      }
    })();
  }

  // 如果还有剩余亏损无法通过 ADL 覆盖，则社会化损失
  if (remainingDeficit > 0n) {
    console.log(`[ADL] Remaining deficit after ADL: $${Number(remainingDeficit) / 1e18}, socializing`);
    socializeLoss(token, remainingDeficit);
  }
}

/**
 * 社会化损失 - 当保险基金和 ADL 都无法覆盖穿仓时
 * 将损失分摊到所有同代币的盈利仓位
 */
function socializeLoss(token: Address, deficit: bigint): void {
  const normalizedToken = token.toLowerCase() as Address;

  // 找出所有该代币的盈利仓位
  const profitablePositions: Position[] = [];
  let totalProfit = 0n;

  for (const [, positions] of userPositions) {
    for (const pos of positions) {
      if (pos.token.toLowerCase() === normalizedToken) {
        const pnl = BigInt(pos.unrealizedPnL || "0");
        if (pnl > 0n) {
          profitablePositions.push(pos);
          totalProfit += pnl;
        }
      }
    }
  }

  if (profitablePositions.length === 0 || totalProfit <= 0n) {
    console.log(`[SocializeLoss] No profitable positions, loss absorbed: $${Number(deficit) / 1e18}`);
    // 无法分摊，系统承担损失
    return;
  }

  // 按盈利比例分摊损失
  for (const pos of profitablePositions) {
    const pnl = BigInt(pos.unrealizedPnL || "0");
    const share = (deficit * pnl) / totalProfit;

    // 从未实现盈亏中扣除
    const newPnL = pnl - share;
    pos.unrealizedPnL = newPnL.toString();

    console.log(`[SocializeLoss] ${pos.trader.slice(0, 10)} share: -$${Number(share) / 1e18}`);
  }

  console.log(`[SocializeLoss] Deficit $${Number(deficit) / 1e18} socialized across ${profitablePositions.length} positions`);
}

/**
 * 广播 ADL 事件到前端
 */
function broadcastADLEvent(position: Position, amount: bigint, price: bigint): void {
  const message = JSON.stringify({
    type: "adl_triggered",
    pairId: position.pairId,
    trader: position.trader,
    token: position.token,
    isLong: position.isLong,
    adlAmount: amount.toString(),
    price: price.toString(),
    timestamp: Date.now(),
  });

  for (const [client] of wsClients.entries()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// ============================================================
// Event-Driven Risk Engine - Meme Perp 核心
// 架构参考: Hyperliquid / dYdX / Binance
//
// 核心原则:
// 1. 价格变化时立即检查受影响仓位 (事件驱动, <10ms)
// 2. 1s 周期兜底检查防止遗漏 (安全网)
// ============================================================

let riskEngineInterval: NodeJS.Timeout | null = null;
const RISK_ENGINE_INTERVAL_MS = 500; // P0-3: 500ms 兜底检查 (was 1s) — 配合事件驱动双保险
const REDIS_SYNC_CYCLES = 1; // 每个周期同步到 Redis
let riskEngineCycleCount = 0;
let lendingLiqCheckCounter = 0; // 借贷清算检查计数器 (每50个风控周期 ≈ 5秒)

// 事件驱动强平统计
let eventDrivenLiquidations = 0;
let lastEventDrivenCheck = 0;

/**
 * 事件驱动强平检查 (价格变化时触发)
 *
 * 当任意 token 价格变化超过 0.1% 时，立即检查该 token 的所有仓位
 * 延迟: <10ms (vs 原100ms轮询)
 *
 * 参考 Hyperliquid: "When the mark price changes, check positions in real-time"
 */
function onPriceChange(token: Address, oldPrice: bigint, newPrice: bigint): void {
  const startTime = Date.now();
  const normalizedToken = token.toLowerCase() as Address;

  // 计算价格变化幅度
  const priceDelta = oldPrice > 0n
    ? Number((newPrice > oldPrice ? newPrice - oldPrice : oldPrice - newPrice) * 10000n / oldPrice)
    : 0;

  let checkedCount = 0;
  let liquidatedCount = 0;
  const urgentLiquidations: Array<{
    position: Position;
    marginRatio: number;
    urgency: number;
  }> = [];

  // 只检查该 token 的仓位
  for (const [trader, positions] of userPositions.entries()) {
    for (const pos of positions) {
      if (pos.token.toLowerCase() !== normalizedToken) continue;
      checkedCount++;

      const entryPrice = BigInt(pos.entryPrice);
      if (entryPrice <= 0n) continue;

      // 计算 UPNL
      const upnl = calculateUnrealizedPnL(
        BigInt(pos.size),
        entryPrice,
        newPrice,
        pos.isLong
      );

      // 计算当前保证金 (包含累积资金费)
      const accFundingFee = BigInt(pos.fundingFee || "0");
      const currentMargin = BigInt(pos.collateral) + upnl + accFundingFee;

      // 动态 MMR
      // ⚠️ size 是 ETH 名义价值 (1e18 精度)，直接就是 positionValue
      const positionValue = BigInt(pos.size);
      const effectiveCollateral = BigInt(pos.collateral) + accFundingFee;
      const leverage = effectiveCollateral > 0n
        ? (positionValue * 10000n) / effectiveCollateral
        : BigInt(Math.round(parseFloat(pos.leverage) * 10000));
      const initialMarginRate = 10000n * 10000n / leverage;
      const baseMmr = 200n;
      const maxMmr = initialMarginRate / 2n;
      const mmr = Number(baseMmr < maxMmr ? baseMmr : maxMmr);

      // 计算维持保证金
      const maintenanceMargin = (positionValue * BigInt(mmr)) / 10000n;

      // 计算保证金率
      const marginRatio = currentMargin > 0n
        ? Number((maintenanceMargin * 10000n) / currentMargin)
        : 10000;

      // 检测是否需要立即强平
      if (marginRatio >= 10000) {
        const urgency = Math.max(0, Math.min(100, Math.floor((marginRatio - 10000) / 100)));

        // 更新仓位状态
        pos.markPrice = newPrice.toString();
        pos.unrealizedPnL = upnl.toString();
        pos.margin = currentMargin.toString();
        pos.marginRatio = marginRatio.toString();
        pos.isLiquidatable = true;

        if (pos.riskLevel !== "critical") {
          pos.riskLevel = "critical";
          sendRiskAlert(
            pos.trader,
            "liquidation_warning",
            "danger",
            `⚡ 实时强平预警: Position ${pos.pairId.slice(0, 8)} marginRatio=${(marginRatio / 100).toFixed(2)}%`,
            pos.pairId
          );
        }

        urgentLiquidations.push({ position: pos, marginRatio, urgency });
        liquidatedCount++;
      }
    }
  }

  // 立即处理紧急强平
  if (urgentLiquidations.length > 0) {
    urgentLiquidations.sort((a, b) => b.marginRatio - a.marginRatio);

    // 同步添加到全局队列并处理
    for (const item of urgentLiquidations) {
      liquidationQueue.push(item);
    }

    // 异步执行强平 (不阻塞价格更新)
    setImmediate(() => {
      processLiquidations();
    });
  }

  const elapsed = Date.now() - startTime;
  lastEventDrivenCheck = startTime;
  eventDrivenLiquidations += liquidatedCount;

  // 只在有强平或检查时间过长时打印日志
  if (liquidatedCount > 0 || elapsed > 10) {
    console.log(
      `[EventDriven] Token ${normalizedToken.slice(0, 8)} price ${priceDelta}bp: ` +
      `checked=${checkedCount} liquidated=${liquidatedCount} elapsed=${elapsed}ms`
    );
  }
}

/**
 * 启动 Risk Engine
 * - 注册事件驱动回调 (实时强平)
 * - 启动 1s 兜底检查 (安全网)
 */
function startRiskEngine(): void {
  if (riskEngineInterval) {
    clearInterval(riskEngineInterval);
  }

  // 注册事件驱动强平回调
  registerPriceChangeCallback(onPriceChange);
  console.log(`[RiskEngine] 🚀 Event-driven liquidation enabled (Hyperliquid-style)`);

  // 启动 1s 兜底检查 (安全网)
  console.log(`[RiskEngine] Starting ${RISK_ENGINE_INTERVAL_MS}ms safety-net check...`);

  riskEngineInterval = setInterval(() => {
    runRiskCheck();
  }, RISK_ENGINE_INTERVAL_MS);
}

/**
 * 停止 Risk Engine
 */
function stopRiskEngine(): void {
  if (riskEngineInterval) {
    clearInterval(riskEngineInterval);
    riskEngineInterval = null;
  }
}

/**
 * 风险检查主循环 (每 100ms 执行)
 */
function runRiskCheck(): void {
  const startTime = Date.now();

  // 清空强平队列
  liquidationQueue.length = 0;

  // 收集所有仓位的 ADL scores 用于排名计算
  const allScores: bigint[] = [];

  // 遍历所有仓位，更新风险指标
  for (const [trader, positions] of userPositions.entries()) {
    let traderTotalPnL = 0n; // 累加该交易者所有仓位的 unrealized PnL
    for (const pos of positions) {
      const token = pos.token.toLowerCase() as Address;
      const orderBook = engine.getOrderBook(token);
      const currentPrice = orderBook.getCurrentPrice();

      // ========== 安全检查: 价格有效性 ==========
      if (currentPrice <= 0n) {
        // 没有有效价格，跳过此仓位的风险计算
        continue;
      }

      // ========== 安全检查: 价格过时 (GMX Oracle.sol maxPriceAge) ==========
      // 不在过时价格上执行清算 — 可能导致错误清算
      // GMX: Oracle 过时 → 整个交易回滚; 我们: 跳过该仓位的风险检查
      if (isPriceStale(token)) continue;

      const entryPrice = BigInt(pos.entryPrice);

      // ========== 安全检查: 价格精度验证 (参考 GMX validateLiquidation 多状态) ==========
      // 入场价格和当前价格偏差过大时记录告警，但不跳过风险计算
      // dYdX v4: 清算决策基于 maintenance margin，不做 priceRatio 跳过
      // GMX v1: validateLiquidation 返回状态码 (0/1/2)，不跳过计算
      if (entryPrice > 0n && currentPrice > 0n) {
        const priceRatio = entryPrice > currentPrice
          ? Number(entryPrice / currentPrice)
          : Number(currentPrice / entryPrice);

        if (priceRatio > 10) {
          // 记录告警但继续计算 — 让 marginRatio 决定是否清算
          console.error(
            `[RiskEngine] PRICE ANOMALY: ${pos.pairId.slice(0, 8)} ` +
            `entry=${entryPrice} current=${currentPrice} ratio=${priceRatio}x`
          );
        }
      }

      // 更新标记价格
      pos.markPrice = currentPrice.toString();

      // 计算 UPNL
      const upnl = calculateUnrealizedPnL(
        BigInt(pos.size),
        entryPrice,
        currentPrice,
        pos.isLong
      );
      pos.unrealizedPnL = upnl.toString();
      traderTotalPnL += upnl; // 累加到交易者总 PnL

      // 计算当前保证金 (包含累积资金费 — 资金费减少有效保证金)
      const accFundingFee = BigInt(pos.fundingFee || "0"); // 负数 = 已扣除
      const currentMargin = BigInt(pos.collateral) + upnl + accFundingFee;
      pos.margin = currentMargin.toString();

      // 计算有效抵押品 (原始保证金 + 累积资金费) 用于动态强平价
      const effectiveCollateral = BigInt(pos.collateral) + accFundingFee;

      // 动态 MMR (根据杠杆调整)
      // ⚠️ size 是 ETH 名义价值 (1e18 精度)
      const positionValue = BigInt(pos.size);
      // 基于有效抵押品重新计算实际杠杆
      const effectiveLeverage = effectiveCollateral > 0n
        ? (positionValue * 10000n) / effectiveCollateral  // 1e4 精度
        : BigInt(Math.round(parseFloat(pos.leverage) * 10000));
      const leverage = effectiveLeverage > 0n ? effectiveLeverage : 10000n; // fallback to 1x if zero
      // MMR = min(2%, 初始保证金率 * 50%)
      // 这样确保 MMR < 初始保证金率，强平价才会在正确的一侧
      const initialMarginRate = 10000n * 10000n / leverage; // 基点
      const baseMmr = 200n; // 基础 2%
      const maxMmr = initialMarginRate / 2n; // 不能超过初始保证金率的一半
      const mmr = Number(baseMmr < maxMmr ? baseMmr : maxMmr);
      pos.mmr = mmr.toString();

      // 动态重算强平价 (基于有效杠杆，资金费越多→杠杆越高→强平价越近)
      const entryPriceBI = BigInt(pos.entryPrice);
      if (entryPriceBI > 0n && effectiveCollateral > 0n) {
        pos.liquidationPrice = calculateLiquidationPrice(
          entryPriceBI, leverage, pos.isLong, BigInt(mmr)
        ).toString();
      }

      // 计算维持保证金
      const maintenanceMargin = (positionValue * BigInt(mmr)) / 10000n;
      pos.maintenanceMargin = maintenanceMargin.toString();

      // ============================================================
      // 计算保证金率 (行业标准 - Binance/Bybit)
      // marginRatio = 维持保证金 / 账户权益 × 100%
      // 越高越危险，>= 100% 触发强平
      // ============================================================
      const marginRatio = currentMargin > 0n
        ? Number((maintenanceMargin * 10000n) / currentMargin)
        : 10000;
      pos.marginRatio = marginRatio.toString();

      // 计算 ROE
      const collateral = BigInt(pos.collateral);
      const roe = collateral > 0n
        ? Number((upnl * 10000n) / collateral)
        : 0;
      pos.roe = roe.toString();

      // 计算 ADL Score
      const adlScore = calculateADLScore(pos);
      pos.adlScore = adlScore.toString();
      allScores.push(adlScore);

      // 判断是否可被强平 (marginRatio >= 100% 触发强平)
      pos.isLiquidatable = marginRatio >= 10000;

      // 判断是否为 ADL 候选 (盈利方)
      pos.isAdlCandidate = upnl > 0n;

      // ============================================================
      // 更新风险等级并发送预警
      // marginRatio = 维持保证金/权益 × 100%, 越高越危险
      // >= 100% 触发强平
      // ============================================================
      const prevRiskLevel = pos.riskLevel;
      if (marginRatio >= 10000) {
        // >= 100%: 触发强平
        pos.riskLevel = "critical";
        if (prevRiskLevel !== "critical") {
          sendRiskAlert(
            pos.trader,
            "liquidation_warning",
            "danger",
            `Position ${pos.pairId.slice(0, 8)} is at liquidation risk! Margin ratio: ${(marginRatio / 100).toFixed(2)}%`,
            pos.pairId
          );
        }
      } else if (marginRatio >= 8000) {
        // >= 80%: 高风险
        pos.riskLevel = "high";
        if (prevRiskLevel === "low" || prevRiskLevel === "medium") {
          sendRiskAlert(
            pos.trader,
            "margin_warning",
            "warning",
            `Position ${pos.pairId.slice(0, 8)} margin ratio is high: ${(marginRatio / 100).toFixed(2)}%`,
            pos.pairId
          );
        }
      } else if (marginRatio >= 5000) {
        // >= 50%: 中等风险
        pos.riskLevel = "medium";
      } else {
        // < 50%: 低风险
        pos.riskLevel = "low";
      }

      // 如果可被强平，加入强平队列
      if (pos.isLiquidatable) {
        // urgency 基于 margin ratio 超过100%的程度
        const urgency = Math.max(0, Math.min(100, Math.floor((marginRatio - 10000) / 100)));
        liquidationQueue.push({
          position: pos,
          marginRatio,
          urgency,
        });
      }

      // ============================================================
      // P2: Take Profit / Stop Loss 监控
      // ============================================================
      checkTakeProfitStopLoss(pos, currentPrice);

      pos.updatedAt = Date.now();
    }

    // 更新该交易者的 balance.unrealizedPnL (用于 WS balance 广播)
    const traderBalance = getUserBalance(trader);
    traderBalance.unrealizedPnL = traderTotalPnL;
  }

  // 更新所有仓位的 ADL 排名
  for (const [trader, positions] of userPositions.entries()) {
    for (const pos of positions) {
      const score = BigInt(pos.adlScore || "0");
      pos.adlRanking = calculateADLRanking(score, allScores);
    }
  }

  // 按 marginRatio 升序排序强平队列 (最危险的在前面)
  liquidationQueue.sort((a, b) => a.marginRatio - b.marginRatio);

  // 更新 ADL 队列
  updateADLQueues();

  // 处理强平 (直接强平，无缓冲)
  processLiquidations();

  // 借贷清算检测 (每 50 个风控周期 = ~5秒检查一次)
  lendingLiqCheckCounter++;
  if (lendingLiqCheckCounter >= 50) {
    lendingLiqCheckCounter = 0;
    // 异步检测，不阻塞风控循环
    (async () => {
      try {
        for (const token of SUPPORTED_TOKENS) {
          const candidates = await detectLendingLiquidations(token);
          if (candidates.length > 0) {
            updateLendingLiquidationQueue(candidates);
            const processed = await processLendingLiquidations();
            if (processed > 0) {
              // 广播借贷清算事件
              broadcast("lending_liquidation", {
                token,
                liquidationsProcessed: processed,
              });
            }
          }
        }
      } catch (e) {
        console.error("[LendingLiq] Detection error:", e);
      }
    })();
  }

  // 处理 TP/SL 触发队列 (P2)
  processTPSLTriggerQueue();

  // 广播风控数据 (实时推送)
  broadcastRiskData();

  // 广播各代币的强平热力图
  for (const token of SUPPORTED_TOKENS) {
    broadcastLiquidationMap(token);
  }

  // 每秒同步一次仓位风险到 Redis (批量更新)
  riskEngineCycleCount++;
  if (riskEngineCycleCount >= REDIS_SYNC_CYCLES) {
    riskEngineCycleCount = 0;
    syncPositionRisksToRedis();
  }

  const elapsed = Date.now() - startTime;
  if (elapsed > 50) {
    console.warn(`[RiskEngine] Slow risk check: ${elapsed}ms`);
  }
}

/**
 * 批量同步仓位风险数据到 Redis (每秒一次)
 */
function syncPositionRisksToRedis(): void {
  if (!db.isConnected()) return;

  const updates: Array<{ id: string; data: Partial<Position> }> = [];

  for (const [trader, positions] of userPositions.entries()) {
    for (const pos of positions) {
      // 只同步有 Redis UUID 的仓位 (UUID 格式: 8-4-4-4-12，总长 36)
      // 排除初始 pairId 格式 "${token}_${trader}_${timestamp}" (含 0x 和下划线)
      if (!pos.pairId || pos.pairId.includes("0x") || pos.pairId.length < 30) continue;

      updates.push({
        id: pos.pairId,
        data: {
          markPrice: pos.markPrice,
          unrealizedPnL: pos.unrealizedPnL,
          marginRatio: pos.marginRatio,
          liquidationPrice: pos.liquidationPrice,
          riskLevel: pos.riskLevel,
          adlScore: pos.adlScore,
          adlRanking: pos.adlRanking,
          isLiquidating: pos.isLiquidatable,
        },
      });
    }
  }

  if (updates.length > 0) {
    PositionRepo.batchUpdateRisk(updates).catch((err) => {
      trackRedisError("Batch risk update failed", err);
    });
  }
}

/**
 * 处理强平队列
 */
async function processLiquidations(): Promise<void> {
  if (liquidationQueue.length === 0) return;

  console.log(`[RiskEngine] ${liquidationQueue.length} positions pending liquidation`);

  for (const candidate of liquidationQueue) {
    const pos = candidate.position;
    const normalizedTrader = pos.trader.toLowerCase() as Address;
    const normalizedToken = pos.token.toLowerCase() as Address;

    console.log(`[Liquidation] Processing: ${pos.trader.slice(0, 10)} ${pos.isLong ? 'LONG' : 'SHORT'} marginRatio=${candidate.marginRatio}bp urgency=${candidate.urgency}`);

    // 获取当前价格
    const orderBook = engine.getOrderBook(normalizedToken);
    const currentPrice = orderBook.getCurrentPrice();

    // ========== 安全检查 1: 价格有效性 ==========
    if (currentPrice <= 0n) {
      console.log(`[Liquidation] SKIPPED: No valid market price for ${normalizedToken.slice(0, 10)}`);
      continue;
    }

    // 计算当前保证金（含 PnL）
    const collateral = BigInt(pos.collateral);
    const size = BigInt(pos.size);
    const entryPrice = BigInt(pos.entryPrice);

    // ========== 安全检查 2: 入场价格有效性 ==========
    // 入场价格应该在当前价格的 10x 范围内 (防止精度错误)
    if (entryPrice > 0n && currentPrice > 0n) {
      const priceRatio = entryPrice > currentPrice
        ? Number(entryPrice / currentPrice)
        : Number(currentPrice / entryPrice);

      if (priceRatio > 10) {
        console.log(`[Liquidation] SKIPPED: Entry/current price ratio too high (${priceRatio.toFixed(2)}x), possible precision error`);
        console.log(`[Liquidation]   entryPrice=${entryPrice}, currentPrice=${currentPrice}`);
        continue;
      }
    }

    // 使用标准 PnL 计算函数 (ETH 本位精度: 1e18 * 1e18 / 1e18 = 1e18)
    const pnl = calculateUnrealizedPnL(size, entryPrice, currentPrice, pos.isLong);

    const currentMargin = collateral + pnl;

    // ========== 安全检查 3: PnL 合理性 ==========
    // PnL 不应该超过仓位价值的 10 倍 (防止计算错误)
    // size 已经是 ETH 名义价值 (1e18 精度)，不需要再乘价格
    const positionValue = size;
    const maxReasonablePnL = positionValue * 10n;
    const absPnl = pnl < 0n ? -pnl : pnl;

    if (absPnl > maxReasonablePnL && maxReasonablePnL > 0n) {
      console.log(`[Liquidation] SKIPPED: PnL unreasonably large ($${Number(pnl) / 1e18}), max expected: $${Number(maxReasonablePnL) / 1e18}`);
      console.log(`[Liquidation]   size=${size}, entryPrice=${entryPrice}, currentPrice=${currentPrice}`);
      continue;
    }

    console.log(`[Liquidation] Position details: collateral=$${Number(collateral) / 1e18}, pnl=$${Number(pnl) / 1e18}, currentMargin=$${Number(currentMargin) / 1e18}`);

    // P3-P2: 分布式锁 — 防止并发强平同一仓位 (与 handleClosePair 互斥)
    await withLock(`position:${normalizedTrader}`, 10000, async () => {
    // Re-check: position may have been closed/liquidated concurrently
    const currentPositions = userPositions.get(normalizedTrader) || [];
    const stillExists = currentPositions.find(p => p.pairId === pos.pairId);
    if (!stillExists) {
      console.log(`[Liquidation] SKIPPED: Position ${pos.pairId} no longer exists (concurrent close?)`);
      return;
    }

    let liquidationPenalty = 0n;
    let insuranceFundPayout = 0n;
    let refundToTrader = 0n;

    if (currentMargin < 0n) {
      // ========== 穿仓处理 (Bankruptcy) ==========
      const deficit = -currentMargin;
      console.log(`[Liquidation] BANKRUPTCY! Deficit: $${Number(deficit) / 1e18}`);

      // 1. 先尝试用保险基金覆盖
      const tokenFund = getTokenInsuranceFund(normalizedToken);
      const globalFundAvailable = insuranceFund.balance;

      if (tokenFund.balance >= deficit) {
        // 代币保险基金足够
        insuranceFundPayout = payFromInsuranceFund(deficit, normalizedToken);
        console.log(`[Liquidation] Deficit covered by token insurance fund: $${Number(insuranceFundPayout) / 1e18}`);
      } else if (tokenFund.balance + globalFundAvailable >= deficit) {
        // 代币 + 全局保险基金
        const fromToken = payFromInsuranceFund(tokenFund.balance, normalizedToken);
        const fromGlobal = payFromInsuranceFund(deficit - fromToken);
        insuranceFundPayout = fromToken + fromGlobal;
        console.log(`[Liquidation] Deficit covered by insurance funds: token=$${Number(fromToken) / 1e18}, global=$${Number(fromGlobal) / 1e18}`);
      } else {
        // 2. 保险基金不足，触发 ADL
        const partialCoverage = payFromInsuranceFund(tokenFund.balance, normalizedToken) + payFromInsuranceFund(globalFundAvailable);
        const remainingDeficit = deficit - partialCoverage;
        console.log(`[Liquidation] Insurance fund insufficient! Covered: $${Number(partialCoverage) / 1e18}, remaining deficit: $${Number(remainingDeficit) / 1e18}`);

        // 执行 ADL (自动减仓)
        await executeADL(pos, remainingDeficit);
        insuranceFundPayout = partialCoverage;
      }
    } else {
      // ========== 正常强平处理 (Bybit/Binance 标准) ==========
      // 清算罚金 = 仓位名义价值 × 1% (固定罚金率)
      // 剩余保证金退还交易者，罚金 100% 进保险基金
      const LIQUIDATION_PENALTY_RATE = 100n; // 1% = 100bp
      const positionValue = size; // 已经是 ETH 名义价值
      const liquidationFee = (positionValue * LIQUIDATION_PENALTY_RATE) / 10000n;

      if (currentMargin >= liquidationFee) {
        // 正常情况：剩余保证金足以支付罚金
        liquidationPenalty = liquidationFee;
        refundToTrader = currentMargin - liquidationFee;
      } else {
        // 边界情况：剩余保证金不足以支付罚金
        liquidationPenalty = currentMargin;
        refundToTrader = 0n;
      }

      // 罚金注入保险基金
      contributeToInsuranceFund(liquidationPenalty, normalizedToken);
      console.log(`[Liquidation] Fee to insurance: Ξ${Number(liquidationPenalty) / 1e18}, refund to trader: Ξ${Number(refundToTrader) / 1e18}`);
    }

    // ✅ PerpVault: 强平 — 减少 OI + 释放保证金 + 扣除亏损
    if (isPerpVaultEnabled()) {
      const liqSizeETH = size; // 已经是 ETH 名义价值
      vaultDecreaseOI(normalizedToken, pos.isLong, liqSizeETH).catch(err =>
        console.error(`[PerpVault] decreaseOI failed (liquidation): ${err}`)
      );
      // 强平结算: 通过 settleClose 释放保证金，PnL 为负数（亏损留在池子）
      // pnl = -(collateral - refundToTrader) 即 trader 的实际亏损（含罚金）
      // marginRelease = collateral（释放全部锁定保证金，扣除亏损后的 refund 由合约计算）
      const liquidationPnl = -(collateral - refundToTrader); // 负值: 亏损
      queueSettleClose(normalizedTrader, liquidationPnl, collateral, pos.pairId);
    }

    // ========== 关闭仓位 ==========
    // Mode 2: 强平链下调整
    // 仓位关闭后 positionMargin 自动减少 collateral（因为仓位从列表移除）
    // 所以 mode2Adj 需要减去 (collateral - refundToTrader) 来反映实际损失
    // 退还部分 refundToTrader 留在 available 中（不需要额外调整）
    const traderLoss = collateral - refundToTrader;
    addMode2Adjustment(normalizedTrader, -traderLoss, "LIQUIDATION_LOSS");

    // 1. 从用户仓位列表中移除
    const positions = userPositions.get(normalizedTrader) || [];
    const updatedPositions = positions.filter(p => p.pairId !== pos.pairId);
    userPositions.set(normalizedTrader, updatedPositions);
    console.log(`[Liquidation] Position closed: ${pos.pairId}, remaining positions: ${updatedPositions.length}`);

    // 2. 移除相关的 TP/SL 订单
    tpslOrders.delete(pos.pairId);

    // 3. ★ 同步删除 Redis + PG 中的仓位
    try {
      await deletePositionFromRedis(pos.pairId, "LIQUIDATED", normalizedTrader, {
        closePrice: pos.liquidationPrice?.toString(),
        closingPnl: liquidationPnl.toString(),
      });
    } catch (e) {
      console.error("[Position] CRITICAL: Failed to delete liquidated position from Redis:", e);
    }

    // 4. 记录强平到交易历史
    const liquidationTrade: TradeRecord = {
      id: `liq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      orderId: generateTradeOrderId(pos.trader),
      pairId: pos.pairId,
      token: pos.token,
      trader: pos.trader,
      isLong: pos.isLong,
      isMaker: false,
      size: pos.size,
      price: currentPrice.toString(),
      fee: liquidationPenalty.toString(),
      realizedPnL: pnl.toString(),
      timestamp: Date.now(),
      type: "liquidation",
    };

    const traderTrades = userTrades.get(normalizedTrader) || [];
    traderTrades.push(liquidationTrade);
    userTrades.set(normalizedTrader, traderTrades);

    // Save liquidation trade to Redis
    createTradeWithMirror({
      orderId: liquidationTrade.orderId,
      pairId: liquidationTrade.pairId,
      token: normalizedToken,
      trader: normalizedTrader,
      isLong: liquidationTrade.isLong,
      isMaker: false,
      size: liquidationTrade.size,
      price: liquidationTrade.price,
      fee: liquidationTrade.fee,
      realizedPnL: liquidationTrade.realizedPnL,
      timestamp: liquidationTrade.timestamp,
      type: "liquidation",
    }, "liquidation");

    // ✅ 记录 LIQUIDATION 账单
    // FIX: 使用 computeSettlementBalance 替代硬编码值
    try {
      const liqEffectiveAfter = computeSettlementBalance(normalizedTrader);
      const liqEffectiveBefore = liqEffectiveAfter + traderLoss; // undo the -traderLoss mode2 adjustment
      createBillWithMirror({
        userAddress: normalizedTrader,
        type: "LIQUIDATION",
        amount: (-traderLoss).toString(), // 负数表示用户损失
        balanceBefore: liqEffectiveBefore.toString(),
        balanceAfter: liqEffectiveAfter.toString(),
        onChainStatus: "ENGINE_SETTLED",
        proofData: JSON.stringify({
          token: pos.token, pairId: pos.pairId, isLong: pos.isLong,
          entryPrice: pos.entryPrice, liquidationPrice: currentPrice.toString(),
          size: pos.size, penalty: liquidationPenalty.toString(),
          refund: refundToTrader.toString(), traderLoss: traderLoss.toString(),
        }),
        positionId: pos.pairId, orderId: liquidationTrade.orderId, txHash: null,
      });
    } catch (billErr) {
      console.error("[Liquidation] Failed to log liquidation bill:", billErr);
    }

    // 5. 调用链上强平 (TODO: 实际合约调用 - 目前仅链下执行)
    // 链上强平功能待实现，当前版本在链下完成强平处理

    // 6. 广播强平事件 + position_closed (双重保障前端移除仓位)
    broadcastLiquidationEvent(pos);
    // 额外发送 position_closed，前端 WS handler 会调用 removePosition()
    const closedMsg = JSON.stringify({ type: "position_closed", data: { pairId: pos.pairId } });
    const liqWsSet = wsTraderClients.get(normalizedTrader);
    if (liqWsSet) {
      for (const ws of liqWsSet) {
        if (ws.readyState === WebSocket.OPEN) ws.send(closedMsg);
      }
    }

    // 7. 广播仓位和余额更新 (确保前端即时反映强平后状态)
    broadcastPositionUpdate(normalizedTrader, normalizedToken);
    broadcastBalanceUpdate(normalizedTrader);

    console.log(`[Liquidation] SUCCESS: ${pos.trader.slice(0, 10)} ${pos.isLong ? 'LONG' : 'SHORT'} position liquidated at price $${Number(currentPrice) / 1e18}`);

    }, 3, 100); // withLock: 3 retries, 100ms delay
  }
}

/**
 * 广播强平事件
 */
function broadcastLiquidationEvent(position: Position): void {
  // AUDIT-FIX M-03: Send only to the trader's own WS clients (not all clients)
  const message = JSON.stringify({
    type: "liquidation_warning",
    pairId: position.pairId,
    trader: position.trader,
    token: position.token,
    isLong: position.isLong,
    marginRatio: position.marginRatio,
    mmr: position.mmr,
    riskLevel: position.riskLevel,
    timestamp: Date.now(),
  });

  const trader = position.trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(trader);
  if (wsSet) {
    for (const client of wsSet) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }
}

// ============================================================
// 保险基金 (Insurance Fund) - Meme Perp 核心
// ============================================================

/**
 * 保险基金状态
 * 用于:
 * 1. 穿仓时，在 ADL 之前先用保险基金覆盖
 * 2. 强平收益的一部分注入保险基金
 */
interface InsuranceFund {
  balance: bigint;                    // 当前余额 (1e18 ETH)
  totalContributions: bigint;         // 累计注入 (来自清算收益、手续费)
  totalPayouts: bigint;               // 累计支出 (弥补穿仓)
  lastUpdated: number;
}

// 全局保险基金 (链上化: PerpVault = 保险基金, 此处仅作为本地计数器)
// Phase 5: 初始余额归零 — 真正的保险基金由 PerpVault 链上合约持有
let insuranceFund: InsuranceFund = {
  balance: 0n,
  totalContributions: 0n,
  totalPayouts: 0n,
  lastUpdated: Date.now(),
};

// 每个代币的保险基金 (用于隔离风险)
const tokenInsuranceFunds = new Map<Address, InsuranceFund>();

/**
 * 获取代币保险基金
 */
function getTokenInsuranceFund(token: Address): InsuranceFund {
  const normalizedToken = token.toLowerCase() as Address;
  let fund = tokenInsuranceFunds.get(normalizedToken);
  if (!fund) {
    fund = {
      balance: 0n,                       // Phase 5: 链上化 — PerpVault 是真正的保险基金
      totalContributions: 0n,
      totalPayouts: 0n,
      lastUpdated: Date.now(),
    };
    tokenInsuranceFunds.set(normalizedToken, fund);
  }
  return fund;
}

/**
 * 向保险基金注入资金
 * 来源: 清算手续费、交易手续费的一部分
 */
function contributeToInsuranceFund(amount: bigint, token?: Address): void {
  if (token) {
    const fund = getTokenInsuranceFund(token);
    const balBefore = fund.balance;
    fund.balance += amount;
    fund.totalContributions += amount;
    fund.lastUpdated = Date.now();
    console.log(`[InsuranceFund] Token ${token.slice(0, 10)} contribution: +$${Number(amount) / 1e18}, balance: $${Number(fund.balance) / 1e18}`);
    InsuranceFundRepo.saveToken(token, fund).catch(() => {});
    // L3: Bill for insurance fund contribution
    if (isPostgresConnected()) {
      pgMirrorWrite(BillMirrorRepo.insert({
        id: crypto.randomUUID(), trader: "insurance_fund",
        type: "INSURANCE_CONTRIBUTION", amount: amount.toString(),
        balance_before: balBefore.toString(), balance_after: fund.balance.toString(),
        on_chain_status: "OFF_CHAIN", proof_data: JSON.stringify({ token }),
        position_id: null, order_id: null, timestamp: Date.now(), created_at: Date.now(),
      }), `InsuranceBill:contrib:${token.slice(0, 10)}`);
    }
  } else {
    const balBefore = insuranceFund.balance;
    insuranceFund.balance += amount;
    insuranceFund.totalContributions += amount;
    insuranceFund.lastUpdated = Date.now();
    console.log(`[InsuranceFund] Global contribution: +$${Number(amount) / 1e18}, balance: $${Number(insuranceFund.balance) / 1e18}`);
    InsuranceFundRepo.saveGlobal(insuranceFund).catch(() => {});
    if (isPostgresConnected()) {
      pgMirrorWrite(BillMirrorRepo.insert({
        id: crypto.randomUUID(), trader: "insurance_fund",
        type: "INSURANCE_CONTRIBUTION", amount: amount.toString(),
        balance_before: balBefore.toString(), balance_after: insuranceFund.balance.toString(),
        on_chain_status: "OFF_CHAIN", proof_data: "{}",
        position_id: null, order_id: null, timestamp: Date.now(), created_at: Date.now(),
      }), `InsuranceBill:contrib:global`);
    }
  }
}

/**
 * 从保险基金支出
 * 用途: Oracle 结算盈利、穿仓覆盖
 *
 * @returns 实际支出金额 (可能小于请求金额)
 */
function payFromInsuranceFund(amount: bigint, token?: Address): bigint {
  if (token) {
    const fund = getTokenInsuranceFund(token);
    const balBefore = fund.balance;
    const actualPayout = amount > fund.balance ? fund.balance : amount;
    fund.balance -= actualPayout;
    fund.totalPayouts += actualPayout;
    fund.lastUpdated = Date.now();
    console.log(`[InsuranceFund] Token ${token.slice(0, 10)} payout: -$${Number(actualPayout) / 1e18}, balance: $${Number(fund.balance) / 1e18}`);
    InsuranceFundRepo.saveToken(token, fund).catch(() => {});
    // L3: Bill for insurance fund payout
    if (actualPayout > 0n && isPostgresConnected()) {
      pgMirrorWrite(BillMirrorRepo.insert({
        id: crypto.randomUUID(), trader: "insurance_fund",
        type: "INSURANCE_PAYOUT", amount: (-actualPayout).toString(),
        balance_before: balBefore.toString(), balance_after: fund.balance.toString(),
        on_chain_status: "OFF_CHAIN", proof_data: JSON.stringify({ token }),
        position_id: null, order_id: null, timestamp: Date.now(), created_at: Date.now(),
      }), `InsuranceBill:payout:${token.slice(0, 10)}`);
    }
    return actualPayout;
  } else {
    const balBefore = insuranceFund.balance;
    const actualPayout = amount > insuranceFund.balance ? insuranceFund.balance : amount;
    insuranceFund.balance -= actualPayout;
    insuranceFund.totalPayouts += actualPayout;
    insuranceFund.lastUpdated = Date.now();
    console.log(`[InsuranceFund] Global payout: -$${Number(actualPayout) / 1e18}, balance: $${Number(insuranceFund.balance) / 1e18}`);
    InsuranceFundRepo.saveGlobal(insuranceFund).catch(() => {});
    if (actualPayout > 0n && isPostgresConnected()) {
      pgMirrorWrite(BillMirrorRepo.insert({
        id: crypto.randomUUID(), trader: "insurance_fund",
        type: "INSURANCE_PAYOUT", amount: (-actualPayout).toString(),
        balance_before: balBefore.toString(), balance_after: insuranceFund.balance.toString(),
        on_chain_status: "OFF_CHAIN", proof_data: "{}",
        position_id: null, order_id: null, timestamp: Date.now(), created_at: Date.now(),
      }), `InsuranceBill:payout:global`);
    }
    return actualPayout;
  }
}

/**
 * 分配交易手续费: 80% → LP (PerpVault), 20% → 保险基金
 * 强平罚金: 100% → 保险基金 (不经过此函数，直接走 contributeToInsuranceFund)
 */
function distributeTradingFee(fee: bigint, token?: Address): void {
  if (fee <= 0n) return;
  const insurancePortion = (fee * 20n) / 100n;   // 20% → 保险基金
  const lpPortion = fee - insurancePortion;        // 80% → LP (PerpVault)

  // 保险基金部分 (本地计数器)
  contributeToInsuranceFund(insurancePortion, token);

  // LP 部分 → PerpVault 链上
  if (isPerpVaultEnabled() && lpPortion > 0n) {
    vaultCollectFee(lpPortion).catch(err =>
      console.error(`[PerpVault] collectFee failed (LP 80%): ${err}`)
    );
  }

  console.log(`[Fee Split] Total: Ξ${Number(fee) / 1e18} → LP 80%: Ξ${Number(lpPortion) / 1e18}, Insurance 20%: Ξ${Number(insurancePortion) / 1e18}`);
}

// ============================================================
// ADL 比率监控 (经济模型 V2 — 500ms 检查)
// ============================================================

// ADL 状态缓存 per token
const adlRatioState = new Map<Address, { ratio: bigint; level: string; lastLog: number }>();

/**
 * ============================================================
 * ADL 比率监控 — 渐进式风控 (经济模型 V2)
 * ============================================================
 *
 * ADL 比率 = (LP池余额 + 保险基金) / max(净敞口, 1)
 * 净敞口 = 全部仓位未实现盈利总和 - 全部仓位未实现亏损总和
 *
 * | ADL 比率  | 级别     | 动作                                    |
 * |-----------|----------|----------------------------------------|
 * | > 200%    | NORMAL   | 正常交易                                |
 * | 150-200%  | WARNING  | 新仓位杠杆限制至 2x                     |
 * | 100-150%  | PAUSE    | 暂停新开仓 + 渐进减仓 (每轮减 50%)      |
 * | < 100%    | CRITICAL | 暂停新开仓 + 强制平仓 (全仓，从盈利最高) |
 *
 * 冷却期: 引擎启动后 60 秒内不触发 ADL (等 LP poolValue 缓存刷新)
 */

const ADL_STARTUP_COOLDOWN_MS = process.env.NODE_ENV === "test" ? 3_600_000 : 60_000; // test mode: 1hr cooldown
const ADL_CHECK_INTERVAL_MS = 2000;     // 每 2 秒检查 (减少 500ms 的刷屏)
let adlMonitorStartTime = 0;

// 读取 LP 池余额 — 异步版本，确保缓存已刷新
async function getADLCoverage(token: Address): Promise<{ coverage: bigint; lpBalance: bigint; insuranceBalance: bigint }> {
  const tokenFund = getTokenInsuranceFund(token);

  let lpBalance = 0n;
  try {
    // ★ 用 async getPoolStats() 确保链上读取，不依赖可能为空的 cachedPoolStats
    const stats = await getPoolStats();
    lpBalance = stats?.poolValue ?? 0n;
  } catch {}

  return {
    coverage: lpBalance + tokenFund.balance,
    lpBalance,
    insuranceBalance: tokenFund.balance,
  };
}

async function checkADLRatioForToken(token: Address): Promise<void> {
  const normalizedToken = token.toLowerCase() as Address;

  // 收集所有该 token 的仓位
  let totalProfit = 0n;
  let totalLoss = 0n;

  for (const [, positionList] of userPositions) {
    for (const pos of positionList) {
      if ((pos.token || "").toLowerCase() !== normalizedToken) continue;
      const pnl = BigInt(pos.unrealizedPnL || "0");
      if (pnl > 0n) totalProfit += pnl;
      else if (pnl < 0n) totalLoss += (-pnl);
    }
  }

  // 净敞口 = 盈利总额 - 亏损总额 (亏损归 LP 所以减掉)
  const netExposure = totalProfit > totalLoss ? totalProfit - totalLoss : 0n;
  if (netExposure === 0n) return;

  // 获取覆盖资金 (LP + 保险基金) — 异步
  const { coverage, lpBalance, insuranceBalance } = await getADLCoverage(normalizedToken);

  // ★ 安全检查: LP 池余额为 0 时跳过 (大概率缓存未加载，不要误触 ADL)
  if (lpBalance === 0n && isPerpVaultEnabled()) {
    return; // 等待 LP 池余额缓存刷新
  }

  // ADL 比率 (basis points: 20000 = 200%)
  const adlRatio = (coverage * 10000n) / netExposure;

  // 分级动作
  const now = Date.now();
  const prevState = adlRatioState.get(normalizedToken);
  const shouldLog = !prevState || now - prevState.lastLog > 30000; // 每 30 秒日志一次

  if (adlRatio < 10000n) {
    // ═══════ < 100%: CRITICAL — 强制平仓 ═══════
    if (shouldLog) {
      console.warn(`[ADL Monitor] ${normalizedToken.slice(0, 10)} ratio=${Number(adlRatio) / 100}% (LP=Ξ${Number(lpBalance) / 1e18}, ins=Ξ${Number(insuranceBalance) / 1e18}, exposure=Ξ${Number(netExposure) / 1e18}) < 100% → FORCE CLOSE`);
    }
    adlRatioState.set(normalizedToken, { ratio: adlRatio, level: "CRITICAL", lastLog: now });
    triggerADLByRatio(normalizedToken, netExposure - coverage, "FORCE_CLOSE").catch(err =>
      console.error(`[ADL Monitor] triggerADLByRatio failed: ${err}`)
    );
  } else if (adlRatio < 15000n) {
    // ═══════ 100-150%: PAUSE — 暂停开仓 + 渐进减仓 ═══════
    if (shouldLog) {
      console.warn(`[ADL Monitor] ${normalizedToken.slice(0, 10)} ratio=${Number(adlRatio) / 100}% < 150% → PAUSE + DELEVERAGE`);
    }
    adlRatioState.set(normalizedToken, { ratio: adlRatio, level: "PAUSE", lastLog: now });
    pauseToken(normalizedToken, `ADL ratio ${Number(adlRatio) / 100}% < 150%`);
    // 渐进减仓: 每轮减 50%，目标恢复到 150%
    const targetCoverage = (netExposure * 15000n) / 10000n; // 目标 150%
    const deleverageAmount = targetCoverage > coverage ? targetCoverage - coverage : 0n;
    if (deleverageAmount > 0n) {
      triggerADLByRatio(normalizedToken, deleverageAmount, "DELEVERAGE").catch(err =>
        console.error(`[ADL Monitor] deleverage failed: ${err}`)
      );
    }
  } else if (adlRatio < 20000n) {
    // ═══════ 150-200%: WARNING — 限杠杆至 2x ═══════
    if (shouldLog) {
      console.log(`[ADL Monitor] ${normalizedToken.slice(0, 10)} ratio=${Number(adlRatio) / 100}% < 200% → WARNING (max 2x leverage)`);
    }
    adlRatioState.set(normalizedToken, { ratio: adlRatio, level: "WARNING", lastLog: now });
    // 如果之前暂停了，恢复交易 (但限杠杆)
    unpauseToken(normalizedToken);
  } else {
    // ═══════ > 200%: NORMAL ═══════
    if (prevState && prevState.level !== "NORMAL") {
      console.log(`[ADL Monitor] ${normalizedToken.slice(0, 10)} ratio=${Number(adlRatio) / 100}% → NORMAL`);
      unpauseToken(normalizedToken);
    }
    adlRatioState.set(normalizedToken, { ratio: adlRatio, level: "NORMAL", lastLog: now });
  }
}

/**
 * 渐进式 ADL 执行
 *
 * mode = "DELEVERAGE": 先减仓 50%，目标恢复覆盖比率到 150%
 * mode = "FORCE_CLOSE": 全仓平掉，覆盖比率 < 100% 时的紧急措施
 */
const adlInProgress = new Set<string>();

async function triggerADLByRatio(token: Address, deficit: bigint, mode: "DELEVERAGE" | "FORCE_CLOSE"): Promise<void> {
  const normalizedToken = token.toLowerCase() as Address;

  // 防重入: 上一轮还没执行完就不重复触发
  if (adlInProgress.has(normalizedToken)) return;
  adlInProgress.add(normalizedToken);

  try {
    console.warn(`[ADL ${mode}] Token ${normalizedToken.slice(0, 10)}, deficit: Ξ${Number(deficit) / 1e18}`);

    // 暂停该 token 开仓
    pauseToken(normalizedToken, `ADL ${mode}`);

    // 收集所有该 token 的盈利仓位，按盈利从高到低排序
    const profitablePositions: { trader: Address; pos: Position; profit: bigint }[] = [];

    for (const [trader, positionList] of userPositions) {
      for (const pos of positionList) {
        if ((pos.token || "").toLowerCase() !== normalizedToken) continue;
        const pnl = BigInt(pos.unrealizedPnL || "0");
        if (pnl > 0n) {
          profitablePositions.push({ trader: trader as Address, pos, profit: pnl });
        }
      }
    }

    profitablePositions.sort((a, b) => (b.profit > a.profit ? 1 : b.profit < a.profit ? -1 : 0));

    let remaining = deficit;
    for (const { trader, pos, profit } of profitablePositions) {
      if (remaining <= 0n) break;

      const posSize = BigInt(pos.size);
      if (posSize <= 0n) continue;

      const currentPrice = BigInt(pos.markPrice || pos.entryPrice);
      if (currentPrice <= 0n) continue;

      let closeSize: bigint;

      if (mode === "DELEVERAGE") {
        // ═══ 渐进减仓: 每次只减该仓位的 50% ═══
        // 不全平，给用户保留仓位，多轮检查后逐步恢复比率
        const halfSize = posSize / 2n;
        if (remaining >= profit) {
          // deficit 超过这个仓位盈利 → 减半
          closeSize = halfSize > 0n ? halfSize : posSize;
        } else {
          // deficit 小于盈利 → 按比例减仓，但最多减半
          const proportional = (posSize * remaining) / profit;
          closeSize = proportional < halfSize ? proportional : halfSize;
          if (closeSize <= 0n) closeSize = 1n; // 最少减 1 wei
        }
      } else {
        // ═══ FORCE_CLOSE: 全仓平掉 ═══
        if (remaining >= profit) {
          closeSize = posSize;
        } else {
          closeSize = (posSize * remaining) / profit;
          if (closeSize <= 0n) closeSize = posSize;
        }
      }

      try {
        const action = mode === "DELEVERAGE" ? "Reducing" : "Force closing";
        console.warn(`[ADL ${mode}] ${action} ${trader.slice(0, 10)} ${pos.isLong ? 'LONG' : 'SHORT'} close=${Number(closeSize) / 1e18}/${Number(posSize) / 1e18} at price=${Number(currentPrice) / 1e18}`);

        // ★ 复用 closePositionByMatch 完整路径
        await closePositionByMatch(
          trader,
          normalizedToken,
          pos.isLong,
          closeSize,
          currentPrice,
          `adl-${mode.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        );

        // 通知用户
        sendToTrader(trader, "adl_warning", {
          token: normalizedToken,
          level: mode,
          closedSize: closeSize.toString(),
          remainingSize: (posSize - closeSize).toString(),
          closePrice: currentPrice.toString(),
          message: mode === "DELEVERAGE"
            ? "Position partially reduced to restore LP coverage ratio"
            : "Position force-closed due to critical LP coverage shortage",
        });

        // 扣减 remaining
        const adlPnl = pos.isLong
          ? (closeSize * (currentPrice - BigInt(pos.entryPrice))) / BigInt(pos.entryPrice)
          : (closeSize * (BigInt(pos.entryPrice) - currentPrice)) / BigInt(pos.entryPrice);
        remaining -= adlPnl > 0n ? adlPnl : 0n;

        console.log(`[ADL ${mode}] ✅ Done, remaining deficit: Ξ${Number(remaining) / 1e18}`);
      } catch (err) {
        console.error(`[ADL ${mode}] Failed: ${trader.slice(0, 10)}: ${err}`);
      }
    }

    if (remaining > 0n && mode === "DELEVERAGE") {
      console.warn(`[ADL ${mode}] Remaining Ξ${Number(remaining) / 1e18} after deleverage round — will retry next cycle`);
    }
  } finally {
    adlInProgress.delete(normalizedToken);
  }
}

/**
 * ADL 比率监控定时器
 */
let adlRatioInterval: NodeJS.Timeout | null = null;

function startADLRatioMonitor(): void {
  if (adlRatioInterval) return;

  adlMonitorStartTime = Date.now();

  adlRatioInterval = setInterval(async () => {
    // ★ 启动冷却期: 等 LP poolValue 缓存刷新，避免误触 ADL
    if (Date.now() - adlMonitorStartTime < ADL_STARTUP_COOLDOWN_MS) return;

    // 遍历所有有仓位的 token
    const tokensWithPositions = new Set<Address>();
    for (const [, positionList] of userPositions) {
      for (const pos of positionList) {
        if (pos.token) tokensWithPositions.add(pos.token.toLowerCase() as Address);
      }
    }

    for (const token of tokensWithPositions) {
      try {
        await checkADLRatioForToken(token);
      } catch (err) {
        // 静默失败，不影响其他 token
      }
    }
  }, ADL_CHECK_INTERVAL_MS);

  console.log(`[ADL Monitor] Started ratio monitor (${ADL_CHECK_INTERVAL_MS}ms interval, ${ADL_STARTUP_COOLDOWN_MS / 1000}s cooldown)`);
}

function stopADLRatioMonitor(): void {
  if (adlRatioInterval) {
    clearInterval(adlRatioInterval);
    adlRatioInterval = null;
  }
}

/**
 * 获取 token 的 ADL 比率 (外部查询用)
 */
function getADLRatio(token: Address): { ratio: bigint; level: string } {
  const state = adlRatioState.get(token.toLowerCase() as Address);
  return state ? { ratio: state.ratio, level: state.level } : { ratio: 99999n, level: "NORMAL" };
}

/**
 * 检查保险基金是否充足
 *
 * Phase 5: 链上化 — PerpVault = 保险基金 (GMX 模式)
 * 如果 PerpVault 启用，使用链上 poolValue 作为保险基金真实余额。
 * 本地计数器作为辅助追踪，PerpVault 是 source of truth。
 */
function hasInsuranceFundCoverage(amount: bigint, token?: Address): boolean {
  // PerpVault 链上保险基金检查 (GMX 模式)
  if (isPerpVaultEnabled()) {
    try {
      const metrics = getPerpVaultMetrics();
      const poolValueStr = metrics.poolValue || "0";
      const poolValue = BigInt(poolValueStr);
      return poolValue >= amount;
    } catch (err) {
      // PerpVault 查询失败，降级到本地计数器
      console.warn(`[InsuranceFund] PerpVault query failed, using local counter:`, err instanceof Error ? err.message : err);
    }
  }

  // 降级: 本地计数器
  if (token) {
    const fund = getTokenInsuranceFund(token);
    return fund.balance >= amount;
  }
  return insuranceFund.balance >= amount;
}

// ============================================================
// Dynamic Funding (动态资金费) - Meme Perp P1 功能
// ============================================================

/**
 * Meme Token 动态资金费配置
 *
 * 与 BTC/ETH 不同，Meme Token 需要:
 * 1. 更频繁的结算周期 (1h vs 8h)
 * 2. 更高的最大费率 (3% vs 0.75%)
 * 3. 波动率调整的费率
 * 4. 实时费率更新
 */
interface DynamicFundingConfig {
  token: Address;
  baseInterval: number;          // 结算周期 (ms) — 固定 15 分钟
  maxRate: number;               // 最大费率 (basis points, 100 = 1%)
  volatilityMultiplier: number;  // 波动率乘数 (应用于 base rate)
  baseFundingRateBps: number;    // 基础费率 (bps, 1 = 0.01%)
  skewFactor: number;            // 倾斜系数 (bps, 5000 = 50%)
}

// 默认 Meme Token 资金费配置
const DEFAULT_MEME_FUNDING_CONFIG: Omit<DynamicFundingConfig, "token"> = {
  baseInterval: 15 * 60 * 1000,      // 15 分钟固定结算周期
  maxRate: 50,                       // 最大 0.5% — 对齐链上 FundingRate.sol maxFundingRateBps=50
  volatilityMultiplier: 1.5,         // 波动率每增加 1%，费率增加 1.5 倍
  baseFundingRateBps: 1,             // 基础费率 0.01%
  skewFactor: 5000,                  // 倾斜系数 50%
};

const tokenFundingConfigs = new Map<Address, DynamicFundingConfig>();

/**
 * 获取代币资金费配置
 */
function getTokenFundingConfig(token: Address): DynamicFundingConfig {
  const normalizedToken = token.toLowerCase() as Address;
  let config = tokenFundingConfigs.get(normalizedToken);
  if (!config) {
    config = { token: normalizedToken, ...DEFAULT_MEME_FUNDING_CONFIG };
    tokenFundingConfigs.set(normalizedToken, config);
  }
  return config;
}

/**
 * 资金费支付记录
 */
interface FundingPayment {
  pairId: string;
  trader: Address;
  token: Address;
  isLong: boolean;
  positionSize: string;
  fundingRate: string;            // 费率 (basis points)
  fundingAmount: string;          // 支付金额 (1e18 ETH)
  isPayer: boolean;               // true = 付款方, false = 收款方
  timestamp: number;
}

// 资金费支付历史 (按代币分组)
const fundingPaymentHistory = new Map<Address, FundingPayment[]>();

// 下次资金费结算时间 (按代币)
const nextFundingSettlement = new Map<Address, number>();

// 当前资金费率 (按代币, basis points)
const currentFundingRates = new Map<Address, bigint>();
// 双边倾斜费率 (longRate/shortRate 分开存储，用于结算)
const currentFundingRatesSkewed = new Map<Address, { longRate: bigint; shortRate: bigint }>();

/**
 * 波动率跟踪器 (用于动态资金费计算)
 */
interface VolatilityTracker {
  token: Address;
  volatility: number;     // 当前波动率 (%)
  priceHistory: Array<{ price: number; timestamp: number }>;  // 历史价格
  lastUpdate: number;
}
const volatilityTrackers = new Map<Address, VolatilityTracker>();

/**
 * 更新价格波动率
 * 使用最近 N 个价格点计算标准差
 */
function updateVolatility(token: Address, currentPrice: number): void {
  const normalizedToken = token.toLowerCase() as Address;
  let tracker = volatilityTrackers.get(normalizedToken);

  if (!tracker) {
    tracker = {
      token: normalizedToken,
      volatility: 0,
      priceHistory: [],
      lastUpdate: Date.now(),
    };
    volatilityTrackers.set(normalizedToken, tracker);
  }

  // 添加新价格点
  tracker.priceHistory.push({ price: currentPrice, timestamp: Date.now() });

  // 只保留最近 100 个价格点 (约 100 秒的数据)
  const maxHistory = 100;
  if (tracker.priceHistory.length > maxHistory) {
    tracker.priceHistory = tracker.priceHistory.slice(-maxHistory);
  }

  // 计算波动率 (价格变化的标准差 / 平均价格 * 100)
  if (tracker.priceHistory.length >= 10) {
    const prices = tracker.priceHistory.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    tracker.volatility = (stdDev / avg) * 100;
  }

  tracker.lastUpdate = Date.now();
}

/**
 * 计算动态资金费率
 *
 * 动态费率 = 基础费率 × (1 + 波动率调整) × (1 + 不平衡调整)
 * 使用 EWMA 平滑避免费率频繁跳动
 *
 * 基础费率来自引擎的 calculateFundingRate
 */

// EWMA 平滑因子: 0.1 = 新值占 10%, 旧值占 90% (防止跳动)
const FUNDING_RATE_EWMA_ALPHA = 0.1;
// 存储上一次平滑后的费率 (Number 精度, 用于 EWMA 计算)
const smoothedFundingRates = new Map<Address, number>();

function calculateDynamicFundingRate(token: Address): { longRate: bigint; shortRate: bigint; displayRate: bigint } {
  const normalizedToken = token.toLowerCase() as Address;
  const config = getTokenFundingConfig(normalizedToken);

  // 1. 基础费率 (来自配置，始终为正)
  let baseBps = config.baseFundingRateBps; // e.g. 1 = 0.01%

  // 2. 波动率调整 (波动率越高，基础费率越高)
  const tracker = volatilityTrackers.get(normalizedToken);
  const volatility = tracker?.volatility || 0;
  const volatilityAdjustment = 1 + (volatility * config.volatilityMultiplier / 100);
  baseBps = Math.max(1, Math.floor(baseBps * volatilityAdjustment));

  // 3. 计算 OI 失衡比 imbalanceRatio: (longOI - shortOI) / totalOI
  //    range [-10000, 10000] (BPS 精度)
  //    > 0: 多头占优 → 多头费率更高
  //    < 0: 空头占优 → 空头费率更高
  const { longOI, shortOI } = calculateOpenInterest(normalizedToken);
  const totalOI = longOI + shortOI;
  let imbalanceRatioBps = 0; // [-10000, 10000]
  if (totalOI > 0n) {
    if (longOI >= shortOI) {
      imbalanceRatioBps = Number((longOI - shortOI) * 10000n / totalOI);
    } else {
      imbalanceRatioBps = -Number((shortOI - longOI) * 10000n / totalOI);
    }
  }

  // 4. 双边动态倾斜费率
  //    longRate  = baseBps * (10000 + skewFactor * imbalance / 10000) / 10000
  //    shortRate = baseBps * (10000 - skewFactor * imbalance / 10000) / 10000
  //    多数方费率更高，少数方费率更低，双方始终 >= 0
  const skewAdjust = Math.floor(config.skewFactor * imbalanceRatioBps / 10000);
  let longRateBps = Math.floor(baseBps * (10000 + skewAdjust) / 10000);
  let shortRateBps = Math.floor(baseBps * (10000 - skewAdjust) / 10000);

  // 确保双方始终 >= 0 (双边收取)
  if (longRateBps < 0) longRateBps = 0;
  if (shortRateBps < 0) shortRateBps = 0;

  // Cap at maxRate
  if (longRateBps > config.maxRate) longRateBps = config.maxRate;
  if (shortRateBps > config.maxRate) shortRateBps = config.maxRate;

  // 5. EWMA 平滑 (仅用于前端显示，防止跳动)
  //    显示费率: 正 = 多头费率更高，负 = 空头费率更高
  const rawDisplay = imbalanceRatioBps >= 0 ? longRateBps : -shortRateBps;
  const prevSmoothed = smoothedFundingRates.get(normalizedToken);
  let smoothed: number;
  if (prevSmoothed === undefined) {
    smoothed = rawDisplay;
  } else {
    smoothed = FUNDING_RATE_EWMA_ALPHA * rawDisplay + (1 - FUNDING_RATE_EWMA_ALPHA) * prevSmoothed;
  }
  smoothedFundingRates.set(normalizedToken, smoothed);

  const displayRate = BigInt(Math.round(smoothed));
  const longRate = BigInt(longRateBps);
  const shortRate = BigInt(shortRateBps);

  // 存储
  currentFundingRates.set(normalizedToken, displayRate);
  currentFundingRatesSkewed.set(normalizedToken, { longRate, shortRate });

  console.log(`[DynamicFunding] Token ${token.slice(0, 10)}: base=${baseBps}bp vol=${volatility.toFixed(2)}% imbal=${imbalanceRatioBps}bp longRate=${longRateBps}bp shortRate=${shortRateBps}bp display=${smoothed.toFixed(2)}bp`);

  return { longRate, shortRate, displayRate };
}

/**
 * 计算多空持仓量
 */
function calculateOpenInterest(token: Address): { longOI: bigint; shortOI: bigint } {
  const normalizedToken = token.toLowerCase() as Address;
  let longOI = 0n;
  let shortOI = 0n;

  for (const [trader, positions] of userPositions.entries()) {
    for (const pos of positions) {
      if ((pos.token.toLowerCase() as Address) === normalizedToken) {
        const positionValue = BigInt(pos.size);
        if (pos.isLong) {
          longOI += positionValue;
        } else {
          shortOI += positionValue;
        }
      }
    }
  }

  return { longOI, shortOI };
}

/**
 * 获取资金费结算周期 — 固定 15 分钟
 */
function getFundingInterval(token: Address): number {
  const normalizedToken = token.toLowerCase() as Address;
  const config = getTokenFundingConfig(normalizedToken);
  return config.baseInterval; // 固定 15 分钟
}

/**
 * 执行资金费结算 — 双边收取 + 动态倾斜费率
 *
 * 核心逻辑:
 * 1. 多头和空头都要缴纳资金费（双边收取）
 * 2. 多数方费率更高，少数方费率更低（动态倾斜）
 * 3. 所有资金费 100% 注入保险基金（不在交易者间转移）
 */
async function settleFunding(token: Address): Promise<void> {
  const normalizedToken = token.toLowerCase() as Address;
  const skewed = currentFundingRatesSkewed.get(normalizedToken);
  const displayRate = currentFundingRates.get(normalizedToken) || 0n;

  if (!skewed || (skewed.longRate === 0n && skewed.shortRate === 0n)) {
    console.log(`[DynamicFunding] No funding rates for ${token.slice(0, 10)}`);
    return;
  }

  const { longRate, shortRate } = skewed;
  console.log(`[DynamicFunding] Settling funding for ${token.slice(0, 10)} longRate=${longRate}bp shortRate=${shortRate}bp`);

  const payments: FundingPayment[] = [];
  let totalLongPayment = 0n;
  let totalShortPayment = 0n;
  let totalCollected = 0n;

  // 遍历所有仓位 — 双边都收取
  // AUDIT-FIX ME-C07: 只在锁外捕获 trader 列表，positions 必须在锁内重新读取
  // 否则 handleClosePair 可能在锁获取前替换了 positions 数组引用
  const traderList = [...userPositions.keys()];
  for (const trader of traderList) {
    // P3-P2: per-trader 分布式锁 — 防止 funding 结算与 close/liquidation 并发竞态
    await withLock(`position:${trader}`, 5000, async () => {
    // AUDIT-FIX ME-C07: 在锁内重新读取 positions，确保拿到最新引用
    const positions = userPositions.get(trader) || [];
    for (const pos of positions) {
      if ((pos.token.toLowerCase() as Address) !== normalizedToken) continue;

      const positionValue = BigInt(pos.size);

      // 双边收取: 多头用 longRate, 空头用 shortRate
      const applicableRate = pos.isLong ? longRate : shortRate;
      const fundingAmount = (positionValue * applicableRate) / 10000n;

      if (fundingAmount === 0n) continue;

      const payment: FundingPayment = {
        pairId: pos.pairId,
        trader: pos.trader,
        token: pos.token,
        isLong: pos.isLong,
        positionSize: pos.size,
        fundingRate: applicableRate.toString(),
        fundingAmount: (-fundingAmount).toString(), // 负数 = 扣除
        isPayer: true, // 双边模式下所有持仓者都是付款方
        timestamp: Date.now(),
      };
      payments.push(payment);

      // 更新仓位的累计资金费和 fundingIndex
      const currentFundingFee = BigInt(pos.fundingFee || "0");
      pos.fundingFee = (currentFundingFee - fundingAmount).toString();
      const currentIndex = BigInt(pos.fundingIndex || "0");
      pos.fundingIndex = (currentIndex + 1n).toString();

      // 从 trader 余额中扣除资金费
      const traderAddr = pos.trader.toLowerCase() as Address;
      const balance = getUserBalance(traderAddr);
      const signedAmount = -fundingAmount;
      const balanceBefore = balance.totalBalance;
      balance.totalBalance += signedAmount;
      balance.availableBalance += signedAmount;
      addMode2Adjustment(traderAddr, signedAmount, "FUNDING_FEE");
      const balanceAfter = balance.totalBalance;

      // 写入结算日志 (Redis)
      try {
        createBillWithMirror({
          userAddress: traderAddr,
          type: "FUNDING_FEE",
          amount: signedAmount.toString(),
          balanceBefore: balanceBefore.toString(),
          balanceAfter: balanceAfter.toString(),
          onChainStatus: "ENGINE_SETTLED",
          proofData: JSON.stringify({
            token: pos.token,
            longRate: longRate.toString(),
            shortRate: shortRate.toString(),
            appliedRate: applicableRate.toString(),
            isLong: pos.isLong,
            positionSize: pos.size,
            pairId: pos.pairId,
          }),
          positionId: pos.pairId,
          orderId: null,
          txHash: null,
        });
      } catch (billErr) {
        console.error("[DynamicFunding] Failed to log funding bill:", billErr);
      }

      // 统计
      totalCollected += fundingAmount;
      if (pos.isLong) {
        totalLongPayment += fundingAmount;
      } else {
        totalShortPayment += fundingAmount;
      }
    }
    }, 3, 100); // withLock per trader
  }

  // 全部资金费注入保险基金
  if (totalCollected > 0n) {
    contributeToInsuranceFund(totalCollected, normalizedToken);
    console.log(`[DynamicFunding] Insurance fund received: Ξ${Number(totalCollected) / 1e18} from funding fees`);

    // 链上记账: 将资金费排入 PerpVault batch settlement 队列
    // 复用 collectTradingFee() — 与交易手续费走同一条链上路径
    // PerpVault.collectFee() 是 nonpayable (纯记账)，30s 批量执行
    try {
      const { collectTradingFee } = await import("./modules/perpVault");
      const result = await collectTradingFee(totalCollected);
      if (result.success) {
        console.log(`[DynamicFunding] Funding fee queued for on-chain settlement: Ξ${Number(totalCollected) / 1e18}`);
      } else {
        console.warn(`[DynamicFunding] Failed to queue funding fee for on-chain: PerpVault not enabled`);
      }
    } catch (err) {
      console.error(`[DynamicFunding] On-chain funding fee queue error:`, err instanceof Error ? err.message : err);
    }
  }

  // 保存支付记录
  const history = fundingPaymentHistory.get(normalizedToken) || [];
  history.push(...payments);
  if (history.length > 10000) {
    fundingPaymentHistory.set(normalizedToken, history.slice(-10000));
  } else {
    fundingPaymentHistory.set(normalizedToken, history);
  }

  // 设置下次结算时间 (固定 15 分钟)
  const nextInterval = getFundingInterval(normalizedToken);
  const nextSettlementTime = Date.now() + nextInterval;
  nextFundingSettlement.set(normalizedToken, nextSettlementTime);

  // 持久化资金费状态到 Redis (重启恢复)
  try {
    const { FundingStateRepo } = await import("./database/redis");
    FundingStateRepo.save(normalizedToken, {
      nextSettlement: nextSettlementTime,
      longRate: longRate.toString(),
      shortRate: shortRate.toString(),
      displayRate: displayRate.toString(),
      lastSettlementTime: Date.now(),
    }).catch(() => {});
  } catch { /* Redis module import fail — non-blocking */ }

  // M2: Persist funding rate snapshot to PG (audit trail + historical queries)
  if (isPostgresConnected()) {
    const { longOI: frLongOI, shortOI: frShortOI } = calculateOpenInterest(normalizedToken);
    pgMirrorWrite(
      FundingRateMirrorRepo.insert({
        token: normalizedToken,
        longRate: longRate.toString(),
        shortRate: shortRate.toString(),
        displayRate: displayRate.toString(),
        totalCollected: totalCollected.toString(),
        longOi: frLongOI.toString(),
        shortOi: frShortOI.toString(),
      }),
      `FundingRate:${normalizedToken.slice(0, 10)}`
    );
  }

  console.log(`[DynamicFunding] Settled: longPaid=${totalLongPayment} shortPaid=${totalShortPayment} payments=${payments.length}`);

  // 广播结算事件
  broadcastFundingSettlement(normalizedToken, displayRate, payments.length);
}

/**
 * 广播资金费结算事件
 */
function broadcastFundingSettlement(
  token: Address,
  displayRate: bigint,
  paymentCount: number
): void {
  const skewed = currentFundingRatesSkewed.get(token);
  const message = JSON.stringify({
    type: "funding_settlement",
    token,
    rate: displayRate.toString(),
    longRate: skewed?.longRate.toString() || "0",
    shortRate: skewed?.shortRate.toString() || "0",
    paymentCount,
    nextSettlement: nextFundingSettlement.get(token),
    timestamp: Date.now(),
  });

  for (const [client] of wsClients.entries()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * 启动动态资金费引擎
 */
let dynamicFundingInterval: NodeJS.Timeout | null = null;
const DYNAMIC_FUNDING_CHECK_INTERVAL = 10000; // 每 10 秒检查一次

async function startDynamicFundingEngine(): Promise<void> {
  if (dynamicFundingInterval) {
    clearInterval(dynamicFundingInterval);
  }

  console.log(`[DynamicFunding] Starting dynamic funding engine...`);

  // 从 Redis 恢复资金费状态 (防重启丢失)
  const now = Date.now();
  try {
    const { FundingStateRepo } = await import("./database/redis");
    const savedStates = await FundingStateRepo.getAll();
    let restoredCount = 0;
    for (const [token, state] of savedStates.entries()) {
      const addr = token.toLowerCase() as Address;
      if (state.nextSettlement > now) {
        // 恢复有效的下次结算时间
        nextFundingSettlement.set(addr, state.nextSettlement);
        // 恢复费率
        currentFundingRates.set(addr, BigInt(state.displayRate));
        currentFundingRatesSkewed.set(addr, {
          longRate: BigInt(state.longRate),
          shortRate: BigInt(state.shortRate),
        });
        restoredCount++;
        console.log(`[DynamicFunding] Restored state for ${addr.slice(0, 10)}: next=${new Date(state.nextSettlement).toISOString()} longRate=${state.longRate}bp shortRate=${state.shortRate}bp`);
      } else {
        console.log(`[DynamicFunding] Skipped expired state for ${addr.slice(0, 10)} (last settlement: ${new Date(state.lastSettlementTime).toISOString()})`);
      }
    }
    if (restoredCount > 0) {
      console.log(`[DynamicFunding] Restored ${restoredCount} funding states from Redis`);
    }
  } catch (err) {
    console.warn(`[DynamicFunding] Failed to restore funding states from Redis:`, err instanceof Error ? err.message : err);
  }

  // 初始化所有代币的下次结算时间 (固定 15 分钟，仅对未恢复的代币)
  for (const token of SUPPORTED_TOKENS) {
    const normalizedToken = token.toLowerCase() as Address;
    const interval = getFundingInterval(normalizedToken);
    if (!nextFundingSettlement.has(normalizedToken)) {
      nextFundingSettlement.set(normalizedToken, now + interval);
      console.log(`[DynamicFunding] Initialized ${normalizedToken.slice(0, 10)}: next settlement in ${interval / 1000}s (${interval / 60000}min)`);
    }
  }

  dynamicFundingInterval = setInterval(() => {
    const now = Date.now();

    for (const token of SUPPORTED_TOKENS) {
      const normalizedToken = token.toLowerCase() as Address;

      // 计算动态费率
      calculateDynamicFundingRate(normalizedToken);

      // 检查是否到达结算时间
      const nextSettlement = nextFundingSettlement.get(normalizedToken);
      if (!nextSettlement || now >= nextSettlement) {
        settleFunding(normalizedToken).catch((e) => {
          console.error(`[DynamicFunding] Settlement failed for ${token.slice(0, 10)}:`, e);
        });
      }
    }
  }, DYNAMIC_FUNDING_CHECK_INTERVAL);
}

/**
 * 停止动态资金费引擎
 */
function stopDynamicFundingEngine(): void {
  if (dynamicFundingInterval) {
    clearInterval(dynamicFundingInterval);
    dynamicFundingInterval = null;
  }
}

// ============================================================
// Take Profit / Stop Loss (止盈止损) - Meme Perp P2 功能
// ============================================================

/**
 * TP/SL 订单类型
 */
interface TPSLOrder {
  pairId: string;
  trader: Address;
  token: Address;
  isLong: boolean;

  // 止盈配置
  takeProfitPrice: bigint | null;
  takeProfitTriggered: boolean;

  // 止损配置
  stopLossPrice: bigint | null;
  stopLossTriggered: boolean;

  // 触发后的执行状态
  executionStatus: "pending" | "executing" | "executed" | "failed";
  executedAt: number | null;
  executionPrice: bigint | null;
  executionPnL: bigint | null;

  createdAt: number;
  updatedAt: number;
}

// TP/SL 订单存储 (按 pairId)
const tpslOrders = new Map<string, TPSLOrder>();

// 待执行的 TP/SL 触发队列
const tpslTriggerQueue: { order: TPSLOrder; triggerType: "tp" | "sl"; triggerPrice: bigint }[] = [];

/**
 * 设置或更新 TP/SL
 */
function setTakeProfitStopLoss(
  pairId: string,
  takeProfitPrice: bigint | null,
  stopLossPrice: bigint | null
): TPSLOrder | null {
  // 查找仓位
  let position: Position | null = null;
  for (const [trader, positions] of userPositions.entries()) {
    const found = positions.find(p => p.pairId === pairId);
    if (found) {
      position = found;
      break;
    }
  }

  if (!position) {
    console.error(`[TP/SL] Position not found: ${pairId}`);
    return null;
  }

  const entryPrice = BigInt(position.entryPrice);

  // 验证 TP/SL 价格合理性
  if (takeProfitPrice !== null) {
    // 多头 TP 必须高于入场价，空头 TP 必须低于入场价
    if (position.isLong && takeProfitPrice <= entryPrice) {
      console.error(`[TP/SL] Invalid TP for LONG: TP ${takeProfitPrice} <= entry ${entryPrice}`);
      return null;
    }
    if (!position.isLong && takeProfitPrice >= entryPrice) {
      console.error(`[TP/SL] Invalid TP for SHORT: TP ${takeProfitPrice} >= entry ${entryPrice}`);
      return null;
    }
  }

  if (stopLossPrice !== null) {
    // 多头 SL 必须低于入场价，空头 SL 必须高于入场价
    if (position.isLong && stopLossPrice >= entryPrice) {
      console.error(`[TP/SL] Invalid SL for LONG: SL ${stopLossPrice} >= entry ${entryPrice}`);
      return null;
    }
    if (!position.isLong && stopLossPrice <= entryPrice) {
      console.error(`[TP/SL] Invalid SL for SHORT: SL ${stopLossPrice} <= entry ${entryPrice}`);
      return null;
    }

    // SL 不能低于/高于强平价
    const liqPrice = BigInt(position.liquidationPrice);
    if (position.isLong && stopLossPrice <= liqPrice) {
      console.error(`[TP/SL] SL ${stopLossPrice} below liquidation price ${liqPrice}`);
      return null;
    }
    if (!position.isLong && stopLossPrice >= liqPrice) {
      console.error(`[TP/SL] SL ${stopLossPrice} above liquidation price ${liqPrice}`);
      return null;
    }
  }

  // 更新或创建 TP/SL 订单
  let order = tpslOrders.get(pairId);
  const now = Date.now();

  if (order) {
    // 更新现有订单
    order.takeProfitPrice = takeProfitPrice;
    order.stopLossPrice = stopLossPrice;
    order.updatedAt = now;
  } else {
    // 创建新订单
    order = {
      pairId,
      trader: position.trader,
      token: position.token,
      isLong: position.isLong,
      takeProfitPrice,
      takeProfitTriggered: false,
      stopLossPrice,
      stopLossTriggered: false,
      executionStatus: "pending",
      executedAt: null,
      executionPrice: null,
      executionPnL: null,
      createdAt: now,
      updatedAt: now,
    };
    tpslOrders.set(pairId, order);
  }

  // 更新仓位的 TP/SL 价格显示
  position.takeProfitPrice = takeProfitPrice?.toString() || null;
  position.stopLossPrice = stopLossPrice?.toString() || null;

  console.log(`[TP/SL] Set for ${pairId}: TP=${takeProfitPrice?.toString() || 'none'} SL=${stopLossPrice?.toString() || 'none'}`);

  return order;
}

/**
 * 取消 TP/SL
 */
function cancelTakeProfitStopLoss(pairId: string, cancelType: "tp" | "sl" | "both"): boolean {
  const order = tpslOrders.get(pairId);
  if (!order) return false;

  if (cancelType === "tp" || cancelType === "both") {
    order.takeProfitPrice = null;
    order.takeProfitTriggered = false;
  }

  if (cancelType === "sl" || cancelType === "both") {
    order.stopLossPrice = null;
    order.stopLossTriggered = false;
  }

  // 更新仓位显示
  for (const [trader, positions] of userPositions.entries()) {
    const position = positions.find(p => p.pairId === pairId);
    if (position) {
      if (cancelType === "tp" || cancelType === "both") position.takeProfitPrice = null;
      if (cancelType === "sl" || cancelType === "both") position.stopLossPrice = null;
      break;
    }
  }

  // 如果都取消了，删除订单
  if (order.takeProfitPrice === null && order.stopLossPrice === null) {
    tpslOrders.delete(pairId);
  }

  console.log(`[TP/SL] Cancelled ${cancelType} for ${pairId}`);
  return true;
}

/**
 * 检查 TP/SL 触发 (在 Risk Engine 中调用)
 */
function checkTakeProfitStopLoss(position: Position, currentPrice: bigint): void {
  const order = tpslOrders.get(position.pairId);
  if (!order || order.executionStatus !== "pending") return;

  // 检查止盈
  if (order.takeProfitPrice !== null && !order.takeProfitTriggered) {
    const tpPrice = order.takeProfitPrice;

    // 多头: 当前价格 >= TP 价格触发
    // 空头: 当前价格 <= TP 价格触发
    const tpTriggered = position.isLong
      ? currentPrice >= tpPrice
      : currentPrice <= tpPrice;

    if (tpTriggered) {
      order.takeProfitTriggered = true;
      tpslTriggerQueue.push({ order, triggerType: "tp", triggerPrice: currentPrice });
      console.log(`[TP/SL] 🎯 Take Profit TRIGGERED: ${position.pairId} @ ${currentPrice}`);
      broadcastTPSLTriggered(position, "tp", currentPrice);
    }
  }

  // 检查止损 (如果止盈没触发)
  if (order.stopLossPrice !== null && !order.stopLossTriggered && !order.takeProfitTriggered) {
    const slPrice = order.stopLossPrice;

    // 多头: 当前价格 <= SL 价格触发
    // 空头: 当前价格 >= SL 价格触发
    const slTriggered = position.isLong
      ? currentPrice <= slPrice
      : currentPrice >= slPrice;

    if (slTriggered) {
      order.stopLossTriggered = true;
      tpslTriggerQueue.push({ order, triggerType: "sl", triggerPrice: currentPrice });
      console.log(`[TP/SL] 🛑 Stop Loss TRIGGERED: ${position.pairId} @ ${currentPrice}`);
      broadcastTPSLTriggered(position, "sl", currentPrice);
    }
  }
}

/**
 * 处理 TP/SL 触发队列 (每次 Risk Check 后调用)
 */
async function processTPSLTriggerQueue(): Promise<void> {
  while (tpslTriggerQueue.length > 0) {
    const trigger = tpslTriggerQueue.shift()!;
    const { order, triggerType, triggerPrice } = trigger;

    // 查找仓位
    let position: Position | null = null;
    for (const [trader, positions] of userPositions.entries()) {
      const found = positions.find(p => p.pairId === order.pairId);
      if (found) {
        position = found;
        break;
      }
    }

    if (!position) {
      console.error(`[TP/SL] Position not found for execution: ${order.pairId}`);
      order.executionStatus = "failed";
      continue;
    }

    const normalizedTraderForLock = position.trader.toLowerCase() as Address;

    // ★ F-3 FIX: 加锁防止与 closePositionByMatch / handleClosePair 并发关闭同一仓位
    try {
    await withLock(`position:${normalizedTraderForLock}`, 10000, async () => {

      // Re-check: 仓位可能已被并发平仓
      const currentPositions = userPositions.get(normalizedTraderForLock) || [];
      const stillExists = currentPositions.find(p => p.pairId === order.pairId);
      if (!stillExists) {
        console.log(`[TP/SL] Position ${order.pairId} already closed (concurrent close), skipping`);
        order.executionStatus = "failed";
        return;
      }
      // 用最新的 position 引用
      position = stillExists;

      order.executionStatus = "executing";

      // 执行全额平仓
      const currentSize = BigInt(position.size);
      const currentPrice = triggerPrice;

      // 计算 PnL
      const pnl = calculateUnrealizedPnL(
        currentSize,
        BigInt(position.entryPrice),
        currentPrice,
        position.isLong
      );

      // 计算平仓手续费 (Taker 费率 — 市价平仓)
      // currentSize 已经是 ETH 名义价值 (1e18 精度)
      const positionValue = currentSize;
      const closeFee = (positionValue * TRADING.TAKER_FEE_RATE) / 10000n;

      // 更新订单状态
      order.executedAt = Date.now();
      order.executionPrice = currentPrice;
      order.executionPnL = pnl;
      order.executionStatus = "executed";

      // 从用户仓位列表中移除
      const normalizedTrader = position.trader.toLowerCase() as Address;
      const normalizedToken = position.token.toLowerCase() as Address;
      const positions = userPositions.get(normalizedTrader) || [];
      const updatedPositions = positions.filter(p => p.pairId !== order.pairId);
      userPositions.set(normalizedTrader, updatedPositions);

      // 移除 TP/SL 订单
      tpslOrders.delete(order.pairId);

      // ✅ PerpVault: TP/SL 平仓 — 减少 OI + 结算 PnL + 收取手续费
      if (isPerpVaultEnabled()) {
        vaultDecreaseOI(normalizedToken, position.isLong, currentSize).catch(err =>
          console.error(`[PerpVault] decreaseOI failed (TP/SL): ${err}`)
        );
        if (pnl > 0n) {
          vaultSettleTraderPnL(normalizedTrader, pnl, true).catch(err =>
            console.error(`[PerpVault] settleTraderProfit failed (TP/SL): ${err}`)
          );
        } else if (pnl < 0n) {
          vaultSettleTraderPnL(normalizedTrader, -pnl, false).catch(err =>
            console.error(`[PerpVault] settleTraderLoss failed (TP/SL): ${err}`)
          );
        }
        if (closeFee > 0n) {
          distributeTradingFee(closeFee, normalizedToken);
        }
      }

      // ✅ 模式 2: 平仓收益加入用户余额
      const returnAmount = BigInt(position.collateral) + pnl - closeFee;
      if (returnAmount > 0n) {
        adjustUserBalance(normalizedTrader, returnAmount, "TPSL_CLOSE");
      }
      // Mode 2: TP/SL 链下调整 = PnL - 手续费
      const tpslPnlMinusFee = pnl - closeFee;
      addMode2Adjustment(normalizedTrader, tpslPnlMinusFee, "TPSL_CLOSE");
      // ✅ TP/SL 手续费 80/20 分配
      if (closeFee > 0n) {
        addMode2Adjustment(FEE_RECEIVER_ADDRESS, closeFee, "PLATFORM_FEE");
      }
      broadcastBalanceUpdate(normalizedTrader);

      // ✅ 记录 TP/SL 平仓成交到 userTrades
      const tpslTrade: TradeRecord = {
        id: `tpsl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        orderId: generateTradeOrderId(position.trader),
        pairId: order.pairId,
        token: position.token,
        trader: position.trader,
        isLong: position.isLong,
        isMaker: false,
        size: position.size,
        price: currentPrice.toString(),
        fee: closeFee.toString(),
        realizedPnL: pnl.toString(),
        timestamp: Date.now(),
        type: "close",
      };
      const tpslTraderTrades = userTrades.get(normalizedTrader) || [];
      tpslTraderTrades.push(tpslTrade);
      userTrades.set(normalizedTrader, tpslTraderTrades);
      createTradeWithMirror({
        orderId: tpslTrade.orderId, pairId: tpslTrade.pairId,
        token: normalizedToken, trader: normalizedTrader,
        isLong: tpslTrade.isLong, isMaker: false,
        size: tpslTrade.size, price: tpslTrade.price,
        fee: tpslTrade.fee, realizedPnL: tpslTrade.realizedPnL,
        timestamp: tpslTrade.timestamp, type: "close",
      }, "tpsl");

      // Bill: record close fee for TP/SL close
      if (closeFee > 0n) {
        const tpslBal = getUserBalance(normalizedTrader);
        createBillWithMirror({
          userAddress: normalizedTrader, type: "CLOSE_FEE", amount: (-closeFee).toString(),
          balanceBefore: (tpslBal.totalBalance + closeFee).toString(),
          balanceAfter: tpslBal.totalBalance.toString(),
          positionId: order.pairId, onChainStatus: "OFF_CHAIN",
        });
      }

      // ✅ 记录 SETTLE_PNL 账单
      // FIX: 使用 computeSettlementBalance 替代硬编码 "0" / returnAmount
      const tpslEffectiveAfter = computeSettlementBalance(normalizedTrader);
      const tpslPnlMinusFeeForBill = pnl - closeFee;
      const tpslEffectiveBefore = tpslEffectiveAfter - tpslPnlMinusFeeForBill;
      createBillWithMirror({
        userAddress: normalizedTrader,
        type: "SETTLE_PNL",
        amount: pnl.toString(),
        balanceBefore: tpslEffectiveBefore.toString(),
        balanceAfter: tpslEffectiveAfter.toString(),
        onChainStatus: "ENGINE_SETTLED",
        proofData: JSON.stringify({
          token: position.token, pairId: order.pairId,
          isLong: position.isLong, triggerType,
          entryPrice: position.entryPrice, exitPrice: currentPrice.toString(),
          size: position.size, closeFee: closeFee.toString(),
          returnAmount: returnAmount.toString(),
          releasedCollateral: BigInt(position.collateral).toString(),
          closeType: triggerType === "tp" ? "take_profit" : "stop_loss",
        }),
        positionId: order.pairId, orderId: tpslTrade.orderId, txHash: null,
      });

      // 同步删除 Redis 中的仓位
      deletePositionFromRedis(order.pairId, "CLOSED", normalizedTrader, {
        closePrice: currentPrice.toString(),
        closingPnl: pnl.toString(),
        closeFee: closeFee.toString(),
      }).catch(e =>
        console.error("[Redis] Failed to delete TP/SL closed position:", e));

      // 广播执行事件
      broadcastTPSLExecuted(position, triggerType, currentPrice, pnl, closeFee);
      broadcastPositionUpdate(normalizedTrader, normalizedToken);

      console.log(`[TP/SL] ✅ Executed ${triggerType.toUpperCase()}: ${order.pairId} PnL=$${Number(pnl) / 1e18}`);

    }); // end withLock
    } catch (e) {
      console.error(`[TP/SL] Execution failed: ${order.pairId}`, e);
      order.executionStatus = "failed";
    }
  }
}

/**
 * 广播 TP/SL 触发事件
 */
function broadcastTPSLTriggered(
  position: Position,
  triggerType: "tp" | "sl",
  triggerPrice: bigint
): void {
  // AUDIT-FIX M-02: Send only to the trader's own WS clients (not all clients)
  const message = JSON.stringify({
    type: "tpsl_triggered",
    pairId: position.pairId,
    trader: position.trader,
    token: position.token,
    isLong: position.isLong,
    triggerType,
    triggerPrice: triggerPrice.toString(),
    timestamp: Date.now(),
  });

  const trader = position.trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(trader);
  if (wsSet) {
    for (const client of wsSet) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }
}

/**
 * 广播 TP/SL 执行事件
 */
function broadcastTPSLExecuted(
  position: Position,
  triggerType: "tp" | "sl",
  executionPrice: bigint,
  pnl: bigint,
  fee: bigint
): void {
  // AUDIT-FIX M-02: Send only to the trader's own WS clients (not all clients)
  const message = JSON.stringify({
    type: "tpsl_executed",
    pairId: position.pairId,
    trader: position.trader,
    token: position.token,
    isLong: position.isLong,
    triggerType,
    executionPrice: executionPrice.toString(),
    realizedPnL: pnl.toString(),
    closeFee: fee.toString(),
    timestamp: Date.now(),
  });

  const trader = position.trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(trader);
  if (wsSet) {
    for (const client of wsSet) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }
}


function broadcast(type: string, data: Record<string, unknown>): void {
  const message = JSON.stringify({ type, ...data, timestamp: Date.now() });
  for (const [client] of wsClients.entries()) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

// ============================================================
// Real-time Risk Data Broadcasting (风控数据实时推送)
// ============================================================

/**
 * 广播风控数据给所有订阅者
 * 包括: 用户仓位风险、强平队列、保险基金、资金费率
 */
function broadcastRiskData(): void {
  const now = Date.now();
  if (now - lastRiskBroadcast < RISK_BROADCAST_INTERVAL_MS) {
    return; // Throttle
  }
  lastRiskBroadcast = now;

  // 1. 向每个订阅风控的交易者推送其仓位风险数据
  for (const [trader, wsSet] of wsTraderClients.entries()) {
    const positions = userPositions.get(trader) || [];
    if (positions.length === 0) continue;

    const positionRisks = positions.map(pos => ({
      pairId: pos.pairId,
      trader: pos.trader,
      token: pos.token,
      isLong: pos.isLong,
      size: pos.size,
      entryPrice: pos.entryPrice,
      leverage: pos.leverage,
      marginRatio: pos.marginRatio || "10000",
      mmr: pos.mmr || "200",
      roe: pos.roe || "0",
      liquidationPrice: pos.liquidationPrice || "0",
      markPrice: pos.markPrice || "0",
      unrealizedPnL: pos.unrealizedPnL || "0",
      collateral: pos.collateral,
      adlScore: parseFloat(pos.adlScore || "0"),
      adlRanking: pos.adlRanking || 1,
      riskLevel: pos.riskLevel || "low",
    }));

    const message = JSON.stringify({
      type: "position_risks",
      positions: positionRisks,
      timestamp: now,
    });

    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }

    // 同步推送该交易者的余额更新 (包含最新 unrealizedPnL + usedMargin)
    // 解决: deposit 页面 WS storeBalance 中 unrealizedPnL 和 usedMargin 为 0 的问题
    const traderBalance = getUserBalance(trader);
    const balMessage = JSON.stringify({
      type: "balance",
      data: {
        trader,
        totalBalance: traderBalance.totalBalance.toString(),
        availableBalance: traderBalance.availableBalance.toString(),
        usedMargin: (traderBalance.usedMargin || 0n).toString(),
        unrealizedPnL: (traderBalance.unrealizedPnL || 0n).toString(),
        walletBalance: (traderBalance.walletBalance || 0n).toString(),
        settlementAvailable: (traderBalance.settlementAvailable || 0n).toString(),
        settlementLocked: (traderBalance.settlementLocked || 0n).toString(),
      },
      timestamp: Math.floor(now / 1000),
    });
    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(balMessage);
      }
    }
  }

  // 2. 向所有风控订阅者推送全局数据
  if (wsRiskSubscribers.size > 0) {
    // 强平队列
    const liquidationQueueData = liquidationQueue.slice(0, 20).map(item => ({
      pairId: item.position.pairId,
      trader: item.position.trader,
      token: item.position.token,
      isLong: item.position.isLong,
      size: item.position.size,
      marginRatio: item.marginRatio,
      urgency: item.urgency < 30 ? "LOW" : item.urgency < 60 ? "MEDIUM" : item.urgency < 80 ? "HIGH" : "CRITICAL",
    }));

    // 保险基金
    const insuranceFundData = {
      balance: insuranceFund.balance.toString(),
      totalContributions: insuranceFund.totalContributions.toString(),
      totalPayouts: insuranceFund.totalPayouts.toString(),
      lastUpdated: insuranceFund.lastUpdated,
      display: {
        balance: (Number(insuranceFund.balance) / 1e18).toFixed(2),
        totalContributions: (Number(insuranceFund.totalContributions) / 1e18).toFixed(2),
        totalPayouts: (Number(insuranceFund.totalPayouts) / 1e18).toFixed(2),
      },
    };

    // 各代币资金费率
    const fundingRates: Record<string, unknown>[] = [];
    for (const token of SUPPORTED_TOKENS) {
      const normalizedToken = token.toLowerCase() as Address;
      const currentRate = currentFundingRates.get(normalizedToken) || 0n;
      const nextSettlement = nextFundingSettlement.get(normalizedToken) || 0;
      const { longOI, shortOI } = calculateOpenInterest(normalizedToken);

      fundingRates.push({
        token,
        currentRate: currentRate.toString(),
        nextSettlement,
        lastSettlement: Date.now(),
        longSize: longOI.toString(),
        shortSize: shortOI.toString(),
        imbalance: longOI > 0n || shortOI > 0n
          ? Number((longOI - shortOI) * 10000n / (longOI + shortOI + 1n)) / 100
          : 0,
      });
    }

    const globalMessage = JSON.stringify({
      type: "risk_data",
      liquidationQueue: liquidationQueueData,
      insuranceFund: insuranceFundData,
      fundingRates,
      timestamp: now,
    });

    for (const ws of wsRiskSubscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(globalMessage);
      }
    }
  }
}

/**
 * 广播强平热力图数据 (节流: 每 2 秒一次)
 */
function broadcastLiquidationMap(token: Address): void {
  const normalizedToken = token.toLowerCase() as Address;

  // Throttle: only broadcast every 2 seconds per token
  const now = Date.now();
  const lastBroadcast = lastLiquidationMapBroadcast.get(normalizedToken) || 0;
  if (now - lastBroadcast < LIQUIDATION_MAP_BROADCAST_INTERVAL_MS) {
    return;
  }
  lastLiquidationMapBroadcast.set(normalizedToken, now);

  const positions = Array.from(userPositions.values()).flat().filter(
    p => p.token.toLowerCase() === normalizedToken
  );

  if (positions.length === 0) return;

  const currentPrice = engine.getOrderBook(normalizedToken).getCurrentPrice();

  // 计算多头和空头的强平价格分布
  const longLevels = new Map<string, { size: bigint; accounts: number }>();
  const shortLevels = new Map<string, { size: bigint; accounts: number }>();

  let totalLongSize = 0n;
  let totalShortSize = 0n;
  let totalLongAccounts = 0;
  let totalShortAccounts = 0;

  for (const pos of positions) {
    const liqPrice = pos.liquidationPrice || "0";
    const size = BigInt(pos.size);

    if (pos.isLong) {
      totalLongSize += size;
      totalLongAccounts++;
      const level = longLevels.get(liqPrice) || { size: 0n, accounts: 0 };
      level.size += size;
      level.accounts++;
      longLevels.set(liqPrice, level);
    } else {
      totalShortSize += size;
      totalShortAccounts++;
      const level = shortLevels.get(liqPrice) || { size: 0n, accounts: 0 };
      level.size += size;
      level.accounts++;
      shortLevels.set(liqPrice, level);
    }
  }

  const maxSize = totalLongSize > totalShortSize ? totalLongSize : totalShortSize;

  const formatLevel = (price: string, data: { size: bigint; accounts: number }) => ({
    price,
    size: data.size.toString(),
    accounts: data.accounts,
    percentage: maxSize > 0n ? Number((data.size * 100n) / maxSize) : 0,
  });

  const longs = Array.from(longLevels.entries())
    .map(([price, data]) => formatLevel(price, data))
    .sort((a, b) => Number(BigInt(b.price) - BigInt(a.price)));

  const shorts = Array.from(shortLevels.entries())
    .map(([price, data]) => formatLevel(price, data))
    .sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)));

  const message = JSON.stringify({
    type: "liquidation_map",
    token: normalizedToken,
    currentPrice: currentPrice.toString(),
    longs,
    shorts,
    totalLongSize: totalLongSize.toString(),
    totalShortSize: totalShortSize.toString(),
    totalLongAccounts,
    totalShortAccounts,
    timestamp: Date.now(),
  });

  for (const [client, tokens] of wsClients.entries()) {
    if (client.readyState === WebSocket.OPEN && tokens.has(normalizedToken)) {
      client.send(message);
    }
  }
}

/**
 * 向特定交易者发送风险预警
 */
function sendRiskAlert(
  trader: Address,
  alertType: "margin_warning" | "liquidation_warning" | "adl_warning" | "funding_warning",
  severity: "info" | "warning" | "danger",
  message: string,
  pairId?: string
): void {
  const wsSet = wsTraderClients.get(trader.toLowerCase() as Address);
  if (!wsSet) return;

  const alertMessage = JSON.stringify({
    type: "risk_alert",
    alertType,
    severity,
    message,
    pairId,
    timestamp: Date.now(),
  });

  for (const ws of wsSet) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(alertMessage);
    }
  }
}

// ============================================================
// P5: Referral System (推荐返佣系统)
// ============================================================

/**
 * 推荐返佣系统
 * - 用户可生成邀请码邀请新用户
 * - 被邀请用户交易时，邀请人获得手续费返佣
 * - 支持多级返佣 (最多 2 级)
 * - 返佣比例可配置
 */

// 返佣配置
const REFERRAL_CONFIG = {
  // 一级返佣: 直接邀请人获得被邀请人手续费的 30%
  level1Rate: 3000,  // 30% (basis points)
  // 二级返佣: 邀请人的邀请人获得 10%
  level2Rate: 1000,  // 10% (basis points)
  // 最低提现金额 (ETH, 1e18)
  minWithdrawAmount: 10n ** 16n,  // 0.01 ETH (~$25)
  // 邀请码长度
  codeLength: 8,
};

/**
 * 推荐人信息
 */
interface Referrer {
  address: Address;
  code: string;                      // 邀请码
  level1Referrals: Address[];        // 直接邀请的用户
  level2Referrals: Address[];        // 二级邀请的用户

  // 返佣统计
  totalEarnings: bigint;             // 累计返佣收入
  pendingEarnings: bigint;           // 待提取返佣
  withdrawnEarnings: bigint;         // 已提取返佣

  // 明细
  level1Earnings: bigint;            // 一级返佣收入
  level2Earnings: bigint;            // 二级返佣收入

  // 统计
  totalTradesReferred: number;       // 被邀请用户总交易次数
  totalVolumeReferred: bigint;       // 被邀请用户总交易额

  createdAt: number;
  updatedAt: number;
}

/**
 * 被邀请人信息
 */
interface Referee {
  address: Address;
  referrerCode: string;              // 使用的邀请码
  referrer: Address;                 // 直接邀请人
  level2Referrer: Address | null;    // 二级邀请人 (邀请人的邀请人)

  // 贡献统计
  totalFeesPaid: bigint;             // 累计支付手续费
  totalCommissionGenerated: bigint;  // 累计产生的返佣

  joinedAt: number;
}

/**
 * 返佣记录
 */
interface ReferralCommission {
  id: string;
  referrer: Address;                 // 获得返佣的人
  referee: Address;                  // 产生返佣的交易者
  level: 1 | 2;                      // 返佣级别
  tradeId: string;                   // 关联的交易ID
  tradeFee: bigint;                  // 原始交易手续费
  commissionAmount: bigint;          // 返佣金额
  commissionRate: number;            // 返佣比例 (basis points)
  timestamp: number;
  status: "pending" | "credited" | "withdrawn";
}

// 推荐人存储: address => Referrer
const referrers = new Map<Address, Referrer>();

// 邀请码映射: code => address
const referralCodes = new Map<string, Address>();

// 被邀请人存储: address => Referee
const referees = new Map<Address, Referee>();

// 返佣记录
const referralCommissions: ReferralCommission[] = [];
let commissionIdCounter = 0;

/**
 * 生成邀请码
 */
function generateReferralCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < REFERRAL_CONFIG.codeLength; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * 注册成为推荐人 (获取邀请码)
 */
function registerAsReferrer(address: Address): Referrer | { error: string } {
  const normalizedAddress = address.toLowerCase() as Address;

  // 检查是否已注册
  if (referrers.has(normalizedAddress)) {
    return referrers.get(normalizedAddress)!;
  }

  // 生成唯一邀请码
  let code: string;
  do {
    code = generateReferralCode();
  } while (referralCodes.has(code));

  const now = Date.now();

  const referrer: Referrer = {
    address: normalizedAddress,
    code,
    level1Referrals: [],
    level2Referrals: [],
    totalEarnings: 0n,
    pendingEarnings: 0n,
    withdrawnEarnings: 0n,
    level1Earnings: 0n,
    level2Earnings: 0n,
    totalTradesReferred: 0,
    totalVolumeReferred: 0n,
    createdAt: now,
    updatedAt: now,
  };

  referrers.set(normalizedAddress, referrer);
  referralCodes.set(code, normalizedAddress);

  // 持久化到 Redis (异步，不阻塞)
  ReferralRepo.saveReferrer(referrer).catch(e =>
    console.error(`[Referral] Failed to persist referrer: ${e}`)
  );
  ReferralRepo.saveCode(code, normalizedAddress).catch(e =>
    console.error(`[Referral] Failed to persist code: ${e}`)
  );

  console.log(`[Referral] Registered referrer ${normalizedAddress.slice(0, 10)} with code ${code}`);

  return referrer;
}

/**
 * 使用邀请码绑定推荐关系
 */
function bindReferral(
  newUserAddress: Address,
  referralCode: string
): { success: boolean; error?: string } {
  const normalizedAddress = newUserAddress.toLowerCase() as Address;
  const upperCode = referralCode.toUpperCase();

  // 检查是否已被邀请
  if (referees.has(normalizedAddress)) {
    return { success: false, error: "Already bound to a referrer" };
  }

  // 检查邀请码是否存在
  const referrerAddress = referralCodes.get(upperCode);
  if (!referrerAddress) {
    return { success: false, error: "Invalid referral code" };
  }

  // 不能邀请自己
  if (referrerAddress === normalizedAddress) {
    return { success: false, error: "Cannot refer yourself" };
  }

  const referrer = referrers.get(referrerAddress);
  if (!referrer) {
    return { success: false, error: "Referrer not found" };
  }

  // 获取二级邀请人 (邀请人的邀请人)
  const referrerAsReferee = referees.get(referrerAddress);
  const level2Referrer = referrerAsReferee?.referrer || null;

  // 创建被邀请人记录
  const referee: Referee = {
    address: normalizedAddress,
    referrerCode: upperCode,
    referrer: referrerAddress,
    level2Referrer,
    totalFeesPaid: 0n,
    totalCommissionGenerated: 0n,
    joinedAt: Date.now(),
  };

  referees.set(normalizedAddress, referee);

  // 更新推荐人的邀请列表
  referrer.level1Referrals.push(normalizedAddress);
  referrer.updatedAt = Date.now();

  // 更新二级推荐人的邀请列表
  if (level2Referrer) {
    const level2ReferrerData = referrers.get(level2Referrer);
    if (level2ReferrerData) {
      level2ReferrerData.level2Referrals.push(normalizedAddress);
      level2ReferrerData.updatedAt = Date.now();
    }
  }

  console.log(`[Referral] ${normalizedAddress.slice(0, 10)} bound to referrer ${referrerAddress.slice(0, 10)} (code: ${upperCode})`);

  // 持久化到 Redis (异步，不阻塞)
  ReferralRepo.saveReferee(referee).catch(e =>
    console.error(`[Referral] Failed to persist referee: ${e}`)
  );
  ReferralRepo.saveReferrer(referrer).catch(e =>
    console.error(`[Referral] Failed to persist referrer (L1 update): ${e}`)
  );
  if (level2Referrer) {
    const l2Data = referrers.get(level2Referrer);
    if (l2Data) {
      ReferralRepo.saveReferrer(l2Data).catch(e =>
        console.error(`[Referral] Failed to persist referrer (L2 update): ${e}`)
      );
    }
  }

  broadcastReferralBound(normalizedAddress, referrerAddress, upperCode);

  return { success: true };
}

/**
 * 计算并记录交易返佣
 * 在每笔交易完成后调用
 */
function processTradeCommission(
  trader: Address,
  tradeId: string,
  tradeFee: bigint,
  tradeVolume: bigint
): void {
  const normalizedTrader = trader.toLowerCase() as Address;

  // 检查是否是被邀请用户
  const referee = referees.get(normalizedTrader);
  if (!referee) return;

  // 更新被邀请人统计
  referee.totalFeesPaid += tradeFee;

  const now = Date.now();

  // 一级返佣
  const level1Referrer = referrers.get(referee.referrer);
  if (level1Referrer) {
    const level1Commission = (tradeFee * BigInt(REFERRAL_CONFIG.level1Rate)) / 10000n;

    if (level1Commission > 0n) {
      const commission: ReferralCommission = {
        id: `comm_${++commissionIdCounter}_${now}`,
        referrer: level1Referrer.address,
        referee: normalizedTrader,
        level: 1,
        tradeId,
        tradeFee,
        commissionAmount: level1Commission,
        commissionRate: REFERRAL_CONFIG.level1Rate,
        timestamp: now,
        status: "credited",
      };

      referralCommissions.push(commission);

      // 更新推荐人收益
      level1Referrer.totalEarnings += level1Commission;
      level1Referrer.pendingEarnings += level1Commission;
      level1Referrer.level1Earnings += level1Commission;
      level1Referrer.totalTradesReferred++;
      level1Referrer.totalVolumeReferred += tradeVolume;
      level1Referrer.updatedAt = now;

      referee.totalCommissionGenerated += level1Commission;

      console.log(`[Referral] L1 commission: ${level1Referrer.address.slice(0, 10)} earned $${Number(level1Commission) / 1e18} from ${normalizedTrader.slice(0, 10)}`);

      broadcastCommissionEarned(level1Referrer.address, level1Commission, 1, normalizedTrader);
    }
  }

  // 二级返佣
  if (referee.level2Referrer) {
    const level2Referrer = referrers.get(referee.level2Referrer);
    if (level2Referrer) {
      const level2Commission = (tradeFee * BigInt(REFERRAL_CONFIG.level2Rate)) / 10000n;

      if (level2Commission > 0n) {
        const commission: ReferralCommission = {
          id: `comm_${++commissionIdCounter}_${now}`,
          referrer: level2Referrer.address,
          referee: normalizedTrader,
          level: 2,
          tradeId,
          tradeFee,
          commissionAmount: level2Commission,
          commissionRate: REFERRAL_CONFIG.level2Rate,
          timestamp: now,
          status: "credited",
        };

        referralCommissions.push(commission);

        // 更新推荐人收益
        level2Referrer.totalEarnings += level2Commission;
        level2Referrer.pendingEarnings += level2Commission;
        level2Referrer.level2Earnings += level2Commission;
        level2Referrer.updatedAt = now;

        referee.totalCommissionGenerated += level2Commission;

        console.log(`[Referral] L2 commission: ${level2Referrer.address.slice(0, 10)} earned $${Number(level2Commission) / 1e18} from ${normalizedTrader.slice(0, 10)}`);

        broadcastCommissionEarned(level2Referrer.address, level2Commission, 2, normalizedTrader);
      }
    }
  }

  // 保留最近 10000 条返佣记录
  if (referralCommissions.length > 10000) {
    referralCommissions.splice(0, referralCommissions.length - 10000);
  }

  // 持久化推荐人和被邀请人到 Redis (异步，不阻塞交易路径)
  const l1Ref = referrers.get(referee.referrer);
  if (l1Ref) {
    ReferralRepo.saveReferrer(l1Ref).catch(e =>
      console.error(`[Referral] Failed to persist L1 referrer after commission: ${e}`)
    );
  }
  if (referee.level2Referrer) {
    const l2Ref = referrers.get(referee.level2Referrer);
    if (l2Ref) {
      ReferralRepo.saveReferrer(l2Ref).catch(e =>
        console.error(`[Referral] Failed to persist L2 referrer after commission: ${e}`)
      );
    }
  }
  ReferralRepo.saveReferee(referee).catch(e =>
    console.error(`[Referral] Failed to persist referee after commission: ${e}`)
  );
}

/**
 * 提取返佣
 */
async function withdrawCommission(
  referrerAddress: Address,
  amount?: bigint
): Promise<{ success: boolean; withdrawnAmount?: bigint; error?: string }> {
  const normalizedAddress = referrerAddress.toLowerCase() as Address;
  const referrer = referrers.get(normalizedAddress);

  if (!referrer) {
    return { success: false, error: "Not a registered referrer" };
  }

  const withdrawAmount = amount || referrer.pendingEarnings;

  if (withdrawAmount <= 0n) {
    return { success: false, error: "No earnings to withdraw" };
  }

  if (withdrawAmount > referrer.pendingEarnings) {
    return { success: false, error: "Insufficient pending earnings" };
  }

  if (withdrawAmount < REFERRAL_CONFIG.minWithdrawAmount) {
    return {
      success: false,
      error: `Minimum withdrawal amount is $${Number(REFERRAL_CONFIG.minWithdrawAmount) / 1e18}`
    };
  }

  // CR-2: 原子化 — 先保存快照用于回滚
  const prevPending = referrer.pendingEarnings;
  const prevWithdrawn = referrer.withdrawnEarnings;
  const prevUpdatedAt = referrer.updatedAt;

  // 扣除待提取，增加已提取
  referrer.pendingEarnings -= withdrawAmount;
  referrer.withdrawnEarnings += withdrawAmount;
  referrer.updatedAt = Date.now();

  try {
    // ✅ 实际转账: 从平台手续费钱包扣除，转入推荐人可用余额
    // addMode2Adjustment 已有 Redis 持久化 (Mode2AdjustmentRepo.save)
    addMode2Adjustment(FEE_RECEIVER_ADDRESS, -withdrawAmount, "REFERRAL_PAYOUT");
    addMode2Adjustment(normalizedAddress, withdrawAmount, "REFERRAL_PAYOUT");
    console.log(`[Referral] ✅ Payout: ${normalizedAddress.slice(0, 10)} received Ξ${Number(withdrawAmount) / 1e18} from platform fee wallet`);

    // 持久化推荐人数据 — await 确保写入成功
    await ReferralRepo.saveReferrer(referrer);

    broadcastCommissionWithdrawn(normalizedAddress, withdrawAmount);

    return { success: true, withdrawnAmount };
  } catch (e) {
    // 回滚内存状态
    referrer.pendingEarnings = prevPending;
    referrer.withdrawnEarnings = prevWithdrawn;
    referrer.updatedAt = prevUpdatedAt;
    console.error(`[Referral] ❌ Withdrawal failed, rolled back: ${e}`);
    return { success: false, error: "Withdrawal failed, please retry" };
  }
}

/**
 * 获取推荐人信息
 */
function getReferrerInfo(address: Address): Referrer | null {
  const normalizedAddress = address.toLowerCase() as Address;
  return referrers.get(normalizedAddress) || null;
}

/**
 * 获取被邀请人信息
 */
function getRefereeInfo(address: Address): Referee | null {
  const normalizedAddress = address.toLowerCase() as Address;
  return referees.get(normalizedAddress) || null;
}

/**
 * 获取推荐人的返佣记录
 */
function getReferrerCommissions(
  address: Address,
  limit: number = 50
): ReferralCommission[] {
  const normalizedAddress = address.toLowerCase() as Address;
  return referralCommissions
    .filter(c => c.referrer === normalizedAddress)
    .slice(-limit)
    .reverse();
}

/**
 * 获取全局推荐统计
 */
function getReferralStats(): {
  totalReferrers: number;
  totalReferees: number;
  totalCommissionsPaid: bigint;
  totalCommissionsPending: bigint;
} {
  let totalPaid = 0n;
  let totalPending = 0n;

  for (const referrer of referrers.values()) {
    totalPaid += referrer.withdrawnEarnings;
    totalPending += referrer.pendingEarnings;
  }

  return {
    totalReferrers: referrers.size,
    totalReferees: referees.size,
    totalCommissionsPaid: totalPaid,
    totalCommissionsPending: totalPending,
  };
}

/**
 * 获取推荐排行榜
 */
function getReferralLeaderboard(limit: number = 20): {
  address: Address;
  code: string;
  referralCount: number;
  totalEarnings: bigint;
}[] {
  return Array.from(referrers.values())
    .sort((a, b) => Number(b.totalEarnings - a.totalEarnings))
    .slice(0, limit)
    .map(r => ({
      address: r.address,
      code: r.code,
      referralCount: r.level1Referrals.length,
      totalEarnings: r.totalEarnings,
    }));
}

// 推荐系统私发函数 (H-4: 改用 wsTraderClients 发送给目标用户，不广播)
function sendToTrader(trader: Address, type: string, data: Record<string, unknown>): void {
  const normalized = trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(normalized);
  if (wsSet) {
    const message = JSON.stringify({ type, ...data, timestamp: Date.now() });
    for (const client of wsSet) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}

function broadcastReferralBound(referee: Address, referrer: Address, code: string): void {
  // 只通知被邀请人和推荐人，不广播给全部用户
  sendToTrader(referee, "referral_bound", { referee, referrer, code });
  sendToTrader(referrer, "referral_bound", { referee, referrer, code });
}

function broadcastCommissionEarned(referrer: Address, amount: bigint, level: number, from: Address): void {
  // H-4: 只通知推荐人自己，不泄露佣金信息给其他用户
  sendToTrader(referrer, "commission_earned", {
    referrer,
    amount: amount.toString(),
    level,
    from,
    display: `$${(Number(amount) / 1e18).toFixed(4)}`,
  });
}

async function handleGetTicker(instId: string): Promise<Response> {
  const token = instId.split("-")[0] as Address;
  const orderBook = engine.getOrderBook(token);
  const depth = orderBook.getDepth(1);
  const currentPrice = orderBook.getCurrentPrice();

  const trades = engine.getRecentTrades(token, 1);
  const lastTrade = trades[0];

  const bestBid = depth.longs.length > 0 ? depth.longs[0].price : currentPrice;
  const bestAsk = depth.shorts.length > 0 ? depth.shorts[0].price : currentPrice;
  const bestBidSz = depth.longs.length > 0 ? depth.longs[0].totalSize : 0n;
  const bestAskSz = depth.shorts.length > 0 ? depth.shorts[0].totalSize : 0n;

  return new Response(JSON.stringify({
    code: "0",
    msg: "success",
    data: [{
      instId,
      last: currentPrice.toString(),
      lastSz: lastTrade?.size?.toString() || "0",
      askPx: bestAsk.toString(),
      askSz: bestAskSz.toString(),
      bidPx: bestBid.toString(),
      bidSz: bestBidSz.toString(),
      open24h: currentPrice.toString(),
      high24h: currentPrice.toString(),
      low24h: currentPrice.toString(),
      volCcy24h: "0",
      vol24h: "0",
      ts: Date.now(),
    }],
  }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleGetMarketTrades(instId: string, limit: number): Promise<Response> {
  const token = instId.split("-")[0] as Address;
  const trades = engine.getRecentTrades(token, limit);

  return new Response(JSON.stringify({
    code: "0",
    msg: "success",
    data: trades.map((trade) => ({
      instId,
      tradeId: trade.id,
      px: trade.price.toString(),
      sz: trade.size.toString(),
      side: trade.side,
      ts: trade.timestamp,
    })),
  }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function broadcastCommissionWithdrawn(referrer: Address, amount: bigint): void {
  // H-4: 只通知推荐人自己，不泄露提现信息给其他用户
  sendToTrader(referrer, "commission_withdrawn", {
    referrer,
    amount: amount.toString(),
    display: `$${(Number(amount) / 1e18).toFixed(2)}`,
  });
}

// ============================================================
// 用户余额管理 (行业标准 - Binance/OKX)
// ============================================================

interface UserBalance {
  totalBalance: bigint;          // 总余额 = walletBalance + mode2Adj, 1e18 精度
  usedMargin: bigint;            // 已使用保证金 (活跃仓位占用), 1e18 精度
  availableBalance: bigint;      // 可用余额 = walletBalance + mode2Adj - positionMargin - pendingLocked, 1e18 精度
  unrealizedPnL: bigint;         // 所有仓位的未实现盈亏, 1e18 精度
  frozenMargin: bigint;          // 冻结保证金 (挂单占用), 1e18 精度
  walletBalance: bigint;         // 派生钱包总余额 (native BNB + WBNB), 1e18 精度
  nativeEthBalance: bigint;      // 派生钱包 native BNB 余额, 1e18 精度
  wethBalance: bigint;           // 派生钱包 WBNB 余额, 1e18 精度
  settlementAvailable: bigint;   // [废弃] 保留字段兼容性，新架构始终为 0n
  settlementLocked: bigint;      // [废弃] 保留字段兼容性，新架构始终为 0n
}

const userBalances = new Map<Address, UserBalance>();

// P1-2: PG/Redis 镜像写入失败计数 — 每 10 次输出告警
let pgWriteFailures = 0;
const PG_FAILURE_ALERT_THRESHOLD = 10;

/** P1-2: 统一的镜像写入封装 — 异步不阻塞，失败只告警不崩溃 */
function pgMirrorWrite(repoCall: Promise<unknown>, context: string): void {
  repoCall.catch(e => {
    pgWriteFailures++;
    console.error(`[PG-MIRROR] ${context} failed (${pgWriteFailures} total): ${e}`);
    if (pgWriteFailures % PG_FAILURE_ALERT_THRESHOLD === 0) {
      console.error(`🚨 [PG-MIRROR] ${pgWriteFailures} failures — check PostgreSQL/Redis connection`);
    }
  });
}

/**
 * P0-2: 创建交易记录并同步写入 PG 镜像
 * 封装 TradeRepo.create + TradeMirrorRepo.upsert
 */
function createTradeWithMirror(data: Omit<PerpTrade, "id">, context: string): void {
  TradeRepo.create(data).then(trade => {
    // PG 双写
    pgMirrorWrite(
      TradeMirrorRepo.upsert({
        id: trade.id,
        order_id: data.orderId,
        pair_id: data.pairId || "",
        token: data.token,
        trader: data.trader,
        is_long: data.isLong,
        is_maker: data.isMaker,
        size: data.size,
        price: data.price,
        fee: data.fee,
        realized_pnl: data.realizedPnL,
        timestamp: data.timestamp,
        type: data.type,
      }),
      `TradeMirror ${context}`
    );
  }).catch(e => console.error(`[DB] Failed to save trade (${context}):`, e));
}

/**
 * Mode 2: 累计链下盈亏调整 (PnL from closes, funding fees, ADL, etc.)
 *
 * 因为 Mode 2 不在链上执行平仓/结算，链上 Settlement 余额不会变化。
 * 此 Map 记录每个用户的累计链下调整金额，在读取余额时加到 chainAvailable 上。
 *
 * 增加场景：平仓盈利、ADL 退款
 * 减少场景：平仓亏损、资金费扣除
 * 重置场景：提现时（提现会先从链上扣，此时链下调整也需要相应减少）
 */
const mode2PnLAdjustments = new Map<Address, bigint>();

function getMode2Adjustment(trader: Address): bigint {
  return mode2PnLAdjustments.get(trader.toLowerCase() as Address) || 0n;
}

function addMode2Adjustment(trader: Address, amount: bigint, reason: string): void {
  const normalized = trader.toLowerCase() as Address;
  const current = mode2PnLAdjustments.get(normalized) || 0n;
  const updated = current + amount;
  mode2PnLAdjustments.set(normalized, updated);
  const sign = amount >= 0n ? "+" : "";
  console.log(`[Mode2Adj] ${reason}: ${normalized.slice(0, 10)} ${sign}Ξ${Number(amount) / 1e18}, cumulative=Ξ${Number(updated) / 1e18}`);
  // 持久化到 Redis (异步，不阻塞)
  Mode2AdjustmentRepo.save(normalized, updated).catch(e =>
    console.error(`[Mode2Adj] Failed to persist to Redis: ${e}`)
  );
  // P0-2: 双写 PG (累计值 + 变动明细)
  pgMirrorWriteWithRetry(
    () => Mode2AdjustmentMirrorRepo.upsert(normalized, updated, amount, reason),
    `Mode2Adj:${normalized.slice(0, 10)}:${reason}`
  );
}

// ============================================================
// P0-2: Unified Bill creation helper (Redis + PG dual-write)
// ============================================================

/** Create settlement log in Redis + mirror to PG bills table.
 *  Accepts both bigint and string for amount fields (server.ts uses mixed types). */
function createBillWithMirror(data: any): void {
  RedisSettlementLogRepo.create(data).then(log => {
    pgMirrorWriteWithRetry(
      () => BillMirrorRepo.insert({
        id: log.id,
        trader: log.userAddress,
        type: log.type,
        amount: log.amount.toString(),
        balance_before: log.balanceBefore.toString(),
        balance_after: log.balanceAfter.toString(),
        on_chain_status: log.onChainStatus,
        proof_data: log.proofData,
        position_id: log.positionId || null,
        order_id: log.orderId || null,
        timestamp: log.createdAt,
        created_at: Date.now(),
      }),
      `Bill:${log.id.slice(0, 8)}:${log.type}`
    );
  }).catch(e => console.error(`[DB] Failed to save bill:`, e));
}

// ============================================================
// Pending Withdrawal Mode2 Reconciliation
// ============================================================
// 提款授权时预扣 mode2 → 链上 tx 可能回退 → 需要定期对账自动回滚。
// dYdX v3 等平台也有类似的 "pending withdrawal" 追踪机制。
const pendingWithdrawalMode2s = new Map<string, PendingWithdrawalMode2>();

/** Record a pending mode2 deduction when generating withdrawal auth */
function recordPendingWithdrawalMode2(
  trader: Address,
  mode2Portion: bigint,
  withdrawAmount: bigint,
  deadline: number,
  nonce: bigint,
  totalWithdrawnBefore: bigint,
): void {
  const id = `${trader.toLowerCase()}:${nonce.toString()}`;
  const record: PendingWithdrawalMode2 = {
    id,
    trader: trader.toLowerCase(),
    mode2Portion: mode2Portion.toString(),
    withdrawAmount: withdrawAmount.toString(),
    deadline,
    nonce: nonce.toString(),
    totalWithdrawnBefore: totalWithdrawnBefore.toString(),
    createdAt: Date.now(),
  };
  pendingWithdrawalMode2s.set(id, record);
  PendingWithdrawalMode2Repo.save(record).catch(e =>
    console.error(`[Reconcile] Failed to persist pending withdrawal: ${e}`)
  );
  console.log(`[Reconcile] Recorded pending mode2 deduction: ${id}, mode2Portion=Ξ${Number(mode2Portion) / 1e18}`);
}

/**
 * Reconcile pending withdrawal mode2 deductions against on-chain state.
 * Called periodically (every 60s). For each pending record:
 * - If deadline + buffer expired AND on-chain totalWithdrawn didn't increase → REVERSE mode2
 * - If on-chain totalWithdrawn increased → withdrawal succeeded, FINALIZE (remove record)
 * - If not yet expired → skip (wait for user to submit or for deadline to pass)
 */
async function reconcilePendingWithdrawals(): Promise<void> {
  if (pendingWithdrawalMode2s.size === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const EXPIRY_BUFFER_SECONDS = 300; // 5 minutes after deadline to allow for slow tx confirmations

  for (const [id, record] of pendingWithdrawalMode2s) {
    // Don't reconcile until deadline + buffer has passed
    if (now < record.deadline + EXPIRY_BUFFER_SECONDS) continue;

    try {
      const { getUserTotalWithdrawn } = await import("./modules/relay");
      const currentTotalWithdrawn = await getUserTotalWithdrawn(record.trader as Address);
      const beforeWithdrawn = BigInt(record.totalWithdrawnBefore);

      if (currentTotalWithdrawn > beforeWithdrawn) {
        // ✅ Withdrawal confirmed on-chain — mode2 deduction was correct
        console.log(`[Reconcile] ✅ Withdrawal confirmed on-chain for ${record.trader.slice(0, 10)}, ` +
          `totalWithdrawn: ${Number(beforeWithdrawn) / 1e18} → ${Number(currentTotalWithdrawn) / 1e18}. Mode2 deduction finalized.`);
      } else {
        // ❌ Withdrawal did NOT happen on-chain — REVERSE the mode2 deduction
        const mode2Portion = BigInt(record.mode2Portion);
        addMode2Adjustment(record.trader as Address, mode2Portion, "WITHDRAW_REVERSAL");
        console.log(`[Reconcile] 🔄 REVERSED mode2 deduction for ${record.trader.slice(0, 10)}: ` +
          `+Ξ${Number(mode2Portion) / 1e18} (withdrawal expired without on-chain confirmation)`);

        // Reset nonce from chain — prevents InvalidSignature on next withdrawal attempt
        // (engine incremented nonce optimistically, but chain tx never landed)
        try {
          const { createPublicClient } = await import("viem");
          const reconClient = createPublicClient({ chain: activeChain, transport: rpcTransport });
          await resetNonceFromChain(reconClient, record.trader as Address);
        } catch (nonceErr) {
          console.warn(`[Reconcile] Failed to reset nonce for ${record.trader.slice(0, 10)}:`, nonceErr);
        }
      }

      // Clean up — whether confirmed or reversed
      pendingWithdrawalMode2s.delete(id);
      PendingWithdrawalMode2Repo.remove(id).catch(e =>
        console.error(`[Reconcile] Failed to remove record ${id}: ${e}`)
      );
    } catch (e) {
      console.error(`[Reconcile] Failed to check on-chain state for ${id}:`, e);
      // Don't delete — will retry on next cycle
    }
  }
}

/** Load pending records from Redis on startup */
async function loadPendingWithdrawalMode2s(): Promise<number> {
  const records = await PendingWithdrawalMode2Repo.getAll();
  for (const record of records) {
    pendingWithdrawalMode2s.set(record.id, record);
  }
  if (records.length > 0) {
    console.log(`[Reconcile] Loaded ${records.length} pending withdrawal mode2 records from Redis`);
  }
  return records.length;
}

/**
 * 获取用户余额，如果不存在则创建默认余额
 */
function getUserBalance(trader: Address): UserBalance {
  const normalizedTrader = trader.toLowerCase() as Address;
  let balance = userBalances.get(normalizedTrader);
  if (!balance) {
    balance = {
      totalBalance: 0n,
      usedMargin: 0n,
      availableBalance: 0n,
      unrealizedPnL: 0n,
      frozenMargin: 0n,
      walletBalance: 0n,
      nativeEthBalance: 0n,
      wethBalance: 0n,
      settlementAvailable: 0n,
      settlementLocked: 0n,
    };
    userBalances.set(normalizedTrader, balance);
  }
  return balance;
}

/**
 * 计算用户可用余额 (与 API balance endpoint 的 availableBalance 一致)
 * = (派生钱包 BNB 余额 + 链下 mode2 调整) - 仓位保证金 - 挂单锁定
 * 这是用户在前端右上角看到的余额
 */
function computeSettlementBalance(trader: Address): bigint {
  const normalizedTrader = trader.toLowerCase() as Address;
  const balance = getUserBalance(normalizedTrader);
  const mode2Adj = getMode2Adjustment(normalizedTrader);
  const effective = (balance.walletBalance || 0n) + mode2Adj;

  // 计算仓位保证金 (与 balance API 一致)
  const positions = userPositions.get(normalizedTrader) || [];
  let positionMargin = 0n;
  for (const pos of positions) {
    positionMargin += BigInt(pos.collateral || "0");
  }

  // 计算挂单锁定金额 (与 balance API 一致)
  let pendingOrdersLocked = 0n;
  const userOrders = engine.getUserOrders(normalizedTrader);
  for (const order of userOrders) {
    if (order.status === "PENDING" || order.status === "PARTIALLY_FILLED") {
      const marginInfo = orderMarginInfos.get(order.id);
      if (marginInfo) {
        const unfilledRatio = marginInfo.totalSize > 0n
          ? ((marginInfo.totalSize - marginInfo.settledSize) * 10000n) / marginInfo.totalSize
          : 10000n;
        pendingOrdersLocked += (marginInfo.totalDeducted * unfilledRatio) / 10000n;
      }
    }
  }

  let available = effective - positionMargin - pendingOrdersLocked;
  if (available < 0n) available = 0n;
  return available;
}

/**
 * 充值 (增加总余额)
 */
function deposit(trader: Address, amount: bigint): void {
  const balanceBefore = computeSettlementBalance(trader);
  const balance = getUserBalance(trader);
  balance.totalBalance += amount;
  balance.availableBalance += amount;
  // ★ Also track as mode2 adjustment so it survives syncUserBalanceFromChain
  addMode2Adjustment(trader, amount, "API_DEPOSIT");
  // P1-1: Persist to Redis (same pattern as adjustUserBalance)
  const normalized = trader.toLowerCase() as Address;
  RedisBalanceRepo.update(normalized, {
    walletBalance: balance.totalBalance,
    availableBalance: balance.availableBalance,
    usedMargin: balance.usedMargin || 0n,
    frozenMargin: balance.frozenMargin || 0n,
    lastSyncTime: Date.now(),
  }).catch(e => console.error(`[Balance] Redis persist failed (deposit): ${e}`));
  console.log(`[Balance] Deposit: ${trader.slice(0, 10)} +$${Number(amount) / 1e18}, total: $${Number(balance.totalBalance) / 1e18}`);

  // ★ FIX: 写 DEPOSIT Bill
  const balanceAfter = computeSettlementBalance(trader);
  RedisSettlementLogRepo.create({
    userAddress: trader,
    type: "DEPOSIT",
    amount: amount.toString(),
    balanceBefore: balanceBefore.toString(),
    balanceAfter: balanceAfter.toString(),
    onChainStatus: "ENGINE_SETTLED",
    proofData: JSON.stringify({ source: "API_DEPOSIT" }),
    positionId: undefined, orderId: undefined, txHash: null,
  }).catch(e => console.error(`[Bill] Failed to log deposit:`, e));
}

/**
 * 提现 (减少总余额)
 */
function withdraw(trader: Address, amount: bigint): boolean {
  const balance = getUserBalance(trader);
  if (balance.availableBalance < amount) {
    console.log(`[Balance] Withdraw failed: ${trader.slice(0, 10)} insufficient available balance`);
    return false;
  }
  const balanceBefore = computeSettlementBalance(trader);
  balance.totalBalance -= amount;
  balance.availableBalance -= amount;
  // P1-1: Persist to Redis
  const normalized = trader.toLowerCase() as Address;
  RedisBalanceRepo.update(normalized, {
    walletBalance: balance.totalBalance,
    availableBalance: balance.availableBalance,
    usedMargin: balance.usedMargin || 0n,
    frozenMargin: balance.frozenMargin || 0n,
    lastSyncTime: Date.now(),
  }).catch(e => console.error(`[Balance] Redis persist failed (withdraw): ${e}`));
  console.log(`[Balance] Withdraw: ${trader.slice(0, 10)} -$${Number(amount) / 1e18}, total: $${Number(balance.totalBalance) / 1e18}`);

  // ★ FIX: 写 WITHDRAW Bill
  const balanceAfter = computeSettlementBalance(trader);
  RedisSettlementLogRepo.create({
    userAddress: trader,
    type: "WITHDRAW",
    amount: (-amount).toString(),
    balanceBefore: balanceBefore.toString(),
    balanceAfter: balanceAfter.toString(),
    onChainStatus: "ENGINE_SETTLED",
    proofData: JSON.stringify({ source: "WITHDRAW" }),
    positionId: undefined, orderId: undefined, txHash: null,
  }).catch(e => console.error(`[Bill] Failed to log withdraw:`, e));

  return true;
}

/**
 * 调整用户余额 (用于强平退款、ADL 等)
 * @param amount 正数增加，负数减少
 * @param reason 调整原因 (用于日志)
 *
 * ★ 注意: 此函数只改内存余额 (即时更新给前端)。
 *   持久化靠 addMode2Adjustment (Redis) — 两者必须配合使用。
 *   下次 syncUserBalanceFromChain 时内存余额会从 chainAvailable + mode2Adj 重算，
 *   所以 adjustUserBalance 的改动是临时的。
 *   adjustUserBalance 传入 collateral+pnl-fee (含保证金退还)，
 *   addMode2Adjustment 只传 pnl-fee (保证金退还由 positionMargin 减少隐式处理)。
 */
function adjustUserBalance(trader: Address, amount: bigint, reason: string): void {
  const balance = getUserBalance(trader);
  balance.totalBalance += amount;
  balance.availableBalance += amount;

  // 确保余额不为负
  if (balance.totalBalance < 0n) balance.totalBalance = 0n;
  if (balance.availableBalance < 0n) balance.availableBalance = 0n;

  const sign = amount >= 0n ? "+" : "";
  console.log(`[Balance] Adjust (${reason}): ${trader.slice(0, 10)} ${sign}$${Number(amount) / 1e18}, total: $${Number(balance.totalBalance) / 1e18}`);

  // P1-1: 持久化余额到 Redis (异步，不阻塞撮合)
  persistBalanceToRedis(trader, balance);
}

/**
 * P1-1: 将内存余额异步写入 Redis BalanceRepo
 * 重启时可从 Redis 恢复，避免昂贵的全量链上同步
 */
function persistBalanceToRedis(trader: Address, balance: UserBalance): void {
  const normalized = trader.toLowerCase() as Address;
  RedisBalanceRepo.update(normalized, {
    walletBalance: balance.walletBalance,
    frozenMargin: balance.frozenMargin,
    usedMargin: balance.usedMargin,
    unrealizedPnL: balance.unrealizedPnL,
    availableBalance: balance.availableBalance,
    equity: balance.totalBalance, // server.ts totalBalance ≈ Redis equity
    lastSyncTime: Date.now(),
  }).catch(e => {
    pgWriteFailures++;
    console.error(`[Balance] Redis persist failed for ${normalized.slice(0, 10)}: ${e}`);
  });
}

/**
 * 开仓时锁定保证金
 */
function lockMargin(trader: Address, margin: bigint): boolean {
  const balance = getUserBalance(trader);
  if (balance.availableBalance < margin) {
    console.log(`[Balance] Lock margin failed: ${trader.slice(0, 10)} needs $${Number(margin) / 1e18}, available: $${Number(balance.availableBalance) / 1e18}`);
    return false;
  }
  balance.usedMargin += margin;
  balance.availableBalance -= margin;
  console.log(`[Balance] Locked margin: ${trader.slice(0, 10)} $${Number(margin) / 1e18}, used: $${Number(balance.usedMargin) / 1e18}, available: $${Number(balance.availableBalance) / 1e18}`);
  persistBalanceToRedis(trader, balance);
  return true;
}

/**
 * 平仓时释放保证金并结算盈亏
 */
function releaseMargin(trader: Address, margin: bigint, realizedPnL: bigint): void {
  const balance = getUserBalance(trader);
  balance.usedMargin -= margin;
  // 可用余额 = 释放的保证金 + 已实现盈亏
  balance.availableBalance += margin + realizedPnL;
  // 如果盈利，总余额增加
  if (realizedPnL > 0n) {
    balance.totalBalance += realizedPnL;
  } else {
    // 如果亏损，总余额减少
    balance.totalBalance += realizedPnL; // realizedPnL 是负数
  }
  console.log(`[Balance] Released margin: ${trader.slice(0, 10)} $${Number(margin) / 1e18}, PnL: $${Number(realizedPnL) / 1e18}, available: $${Number(balance.availableBalance) / 1e18}`);
  persistBalanceToRedis(trader, balance);
}

// ============================================================
// 订单保证金扣除/退还 (下单时扣，撤单时退)
// ============================================================

// 手续费率: 从 config.ts 统一读取 (Taker 费率用于预扣，Maker 成交后退差额)
const ORDER_FEE_RATE = TRADING.TAKER_FEE_RATE;

// 记录每个订单的保证金和手续费 (用于撤单退款)
interface OrderMarginInfo {
  margin: bigint;        // 保证金
  fee: bigint;           // 手续费
  totalDeducted: bigint; // 总扣除金额
  totalSize: bigint;     // 订单总大小 (用于计算部分成交比例)
  settledSize: bigint;   // 已结算大小
}
const orderMarginInfos = new Map<string, OrderMarginInfo>();

/**
 * 计算订单所需的保证金和手续费
 *
 * ✅ 修复：size 现在是 ETH 名义价值 (1e18 精度)，与合约保持一致
 * 合约计算: collateral = size * LEVERAGE_PRECISION / leverage
 *
 * @param size ETH 名义价值 (1e18 精度, 如 $500 = 500_000_000)
 * @param _price 价格 (不再使用，保留参数兼容性)
 * @param leverage 杠杆 (1e4 精度, 如 10x = 100000)
 * @returns { margin, fee, total } 都是 1e18 ETH 精度
 */
function calculateOrderCost(size: bigint, _price: bigint, leverage: bigint): { margin: bigint; fee: bigint; total: bigint } {
  // size 已经是 ETH 名义价值 (1e18 精度)
  // 与合约 Settlement.sol 第 524 行保持一致:
  // collateral = (matchSize * LEVERAGE_PRECISION) / leverage

  // 保证金 = size * 10000 / leverage
  const margin = (size * 10000n) / leverage;

  // 手续费 = size * Taker费率 (预扣最大费率，Maker 成交后退差额)
  const fee = (size * ORDER_FEE_RATE) / 10000n;

  // 总计 = 保证金 + 手续费
  const total = margin + fee;

  return { margin, fee, total };
}

/**
 * [新架构] 同步用户余额
 *
 * 派生钱包模式:
 * - 派生钱包原生 BNB + WBNB 就是用户可用资金
 * - 无需 Settlement 合约存款
 * - mode2Adj 追踪平仓盈亏等链下调整
 * - 仓位保证金从后端内存计算
 * - 挂单预留从 orderMarginInfos 计算
 *
 * 公式:
 *   walletBalance    = nativeBNB + WBNB - gasReserve
 *   availableBalance = walletBalance + mode2Adj - positionMargin - pendingLocked
 *   totalBalance     = walletBalance + mode2Adj
 */
async function syncUserBalanceFromChain(trader: Address): Promise<void> {
  const normalizedTrader = trader.toLowerCase() as Address;
  const balance = getUserBalance(normalizedTrader);

  try {
    const publicClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });

    // 1. 读取派生钱包余额 (native BNB + WBNB)
    const derivedWallet = traderToDerivedWallet.get(normalizedTrader);
    const balanceTarget = derivedWallet || normalizedTrader;

    const nativeEthBalance = await publicClient.getBalance({ address: balanceTarget });

    let wethBalance = 0n;
    if (WETH_ADDRESS) {
      try {
        wethBalance = await publicClient.readContract({
          address: WETH_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [balanceTarget],
        }) as bigint;
      } catch { /* WBNB 查询失败忽略 */ }
    }

    const gasReserve = BigInt(5e15); // 0.005 BNB gas 预留
    const usableNativeEth = nativeEthBalance > gasReserve ? nativeEthBalance - gasReserve : 0n;
    const walletEthBalance = usableNativeEth + wethBalance;

    // 2. mode2 调整 (平仓盈亏、资金费等链下调整)
    const mode2Adj = getMode2Adjustment(normalizedTrader);

    // 3. 仓位保证金 (从后端内存)
    const positions = userPositions.get(normalizedTrader) || [];
    let positionMargin = 0n;
    for (const pos of positions) {
      positionMargin += BigInt(pos.collateral || "0");
    }

    // 4. 挂单预留
    const pendingLocked = getPendingOrdersLocked(normalizedTrader);

    // 5. 余额计算
    // 总资金 = 钱包余额 + mode2 调整 (盈亏可正可负)
    const totalFunds = walletEthBalance + mode2Adj;

    balance.walletBalance = walletEthBalance;
    balance.nativeEthBalance = nativeEthBalance;
    balance.wethBalance = wethBalance;
    balance.settlementAvailable = 0n;  // 新架构不使用 Settlement
    balance.settlementLocked = 0n;
    balance.usedMargin = positionMargin;
    balance.totalBalance = totalFunds > 0n ? totalFunds : 0n;

    // 可用余额 = 总资金 - 仓位保证金 - 挂单预留
    let available = totalFunds - positionMargin - pendingLocked;
    if (available < 0n) available = 0n;
    balance.availableBalance = available;

    console.log(`[Balance] ${normalizedTrader.slice(0, 10)} wallet=${(Number(walletEthBalance) / 1e18).toFixed(4)}, mode2Adj=${(Number(mode2Adj) / 1e18).toFixed(4)}, posMargin=${(Number(positionMargin) / 1e18).toFixed(4)}, pending=${(Number(pendingLocked) / 1e18).toFixed(4)}, available=${(Number(available) / 1e18).toFixed(4)}`);
  } catch (e) {
    console.warn(`[Balance] Failed to sync balance: ${e}`);
  }
}

/**
 * 计算用户挂单锁定总额 (内存中的 orderMarginInfos)
 * 用于从可用余额中扣除已被挂单预留的金额
 */
function getPendingOrdersLocked(trader: Address): bigint {
  const normalizedTrader = trader.toLowerCase() as Address;
  let locked = 0n;
  const userOrders = engine.getUserOrders(normalizedTrader);
  for (const order of userOrders) {
    if (order.status === "PENDING" || order.status === "PARTIALLY_FILLED") {
      const marginInfo = orderMarginInfos.get(order.id);
      if (marginInfo) {
        const unfilledRatio = marginInfo.totalSize > 0n
          ? ((marginInfo.totalSize - marginInfo.settledSize) * 10000n) / marginInfo.totalSize
          : 10000n;
        locked += (marginInfo.totalDeducted * unfilledRatio) / 10000n;
      }
    }
  }
  return locked;
}

/**
 * 下单时扣除保证金和手续费 (内存记账)
 *
 * 调用前: autoDepositIfNeeded 已确认派生钱包余额足够
 * 此函数: 检查 availableBalance → 记录 orderMarginInfos → 扣减内存余额
 *
 * availableBalance 的本地扣减防止连续下单之间的双花
 * totalBalance 不变 — 资金从"可用"变"预留"
 */
async function deductOrderAmount(trader: Address, orderId: string, size: bigint, price: bigint, leverage: bigint): Promise<boolean> {
  // autoDepositIfNeeded 已在调用前读取了链上余额并更新到内存
  // 这里只做内存余额检查，不再重复链上读取

  const balance = getUserBalance(trader);
  const { margin, fee, total } = calculateOrderCost(size, price, leverage);

  if (balance.availableBalance < total) {
    console.log(`[Balance] Deduct failed: ${trader.slice(0, 10)} available $${Number(balance.availableBalance) / 1e18} < required $${Number(total) / 1e18} (margin=$${Number(margin) / 1e18} + fee=$${Number(fee) / 1e18})`);
    return false;
  }

  // 本地扣减 (防止连续下单双花，下次 sync 会重新算)
  balance.availableBalance -= total;
  // 注意: 不改 totalBalance — 资金从可用→预留，总资产不变

  // 记录订单保证金信息 (getPendingOrdersLocked 会读取这个)
  orderMarginInfos.set(orderId, {
    margin,
    fee,
    totalDeducted: total,
    totalSize: size,
    settledSize: 0n,
  });

  // 持久化到 Redis (重启后可恢复)
  OrderMarginRepo.save(orderId, {
    margin: margin.toString(),
    fee: fee.toString(),
    totalDeducted: total.toString(),
    totalSize: size.toString(),
    settledSize: "0",
    trader: trader.toLowerCase(),
  }).catch(e => trackRedisError(`Failed to persist margin info for ${orderId}`, e));

  console.log(`[Balance] Deducted: ${trader.slice(0, 10)} -$${Number(total) / 1e18} (margin=$${Number(margin) / 1e18} + fee=$${Number(fee) / 1e18}), remaining: $${Number(balance.availableBalance) / 1e18}`);
  return true;
}

// ============================================================
// ERC20 最小 ABI (用于 approve + balanceOf)
// ============================================================

const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * [新架构] 检查用户派生钱包余额是否足够下单
 *
 * 安全模型:
 * - 派生钱包原生 BNB 就是用户的可用资金
 * - 无需 Settlement 合约存款
 * - 引擎读取链上 getBalance() 检查余额
 * - mode2Adj 追踪链下盈亏调整 (平仓盈亏、资金费等)
 */
async function autoDepositIfNeeded(trader: Address, requiredAmount: bigint): Promise<void> {
  // SettlementV2 模式: 派生钱包 BNB 余额即可用余额
  // 不需要通过 Settlement 合约存款，直接检查链上原生 BNB + WBNB
  if (SETTLEMENT_V2_ADDRESS) {
    const normalizedTrader = trader.toLowerCase() as Address;
    const publicClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });

    // 读取派生钱包链上余额 (原生 BNB + WBNB)
    let walletBalance = 0n;
    try {
      const nativeBNB = await publicClient.getBalance({ address: normalizedTrader });
      let wbnbBalance = 0n;
      if (WETH_ADDRESS) {
        try {
          wbnbBalance = await publicClient.readContract({
            address: WETH_ADDRESS,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [normalizedTrader],
          }) as bigint;
        } catch { /* WBNB 查询失败忽略 */ }
      }
      walletBalance = nativeBNB + wbnbBalance;
    } catch (e) {
      console.error(`[AutoDeposit] Failed to read wallet balance for ${normalizedTrader.slice(0, 10)}: ${e}`);
    }

    // 加入 mode2 调整 (平仓盈亏等链下调整)
    const mode2Adj = getMode2Adjustment(normalizedTrader);

    // 计算已占用金额 (仓位保证金 + 挂单锁定)
    const positions = userPositions.get(normalizedTrader) || [];
    let positionMargin = 0n;
    for (const pos of positions) {
      positionMargin += BigInt(pos.collateral || "0");
    }
    const pendingLocked = getPendingOrdersLocked(normalizedTrader);
    const usedTotal = positionMargin + pendingLocked;

    // 可用余额 = 钱包余额 + mode2调整 - 已占用 - gas预留
    const gasReserve = BigInt(5e15); // 0.005 BNB for gas
    const totalFunds = walletBalance + (mode2Adj > 0n ? mode2Adj : 0n);
    const available = totalFunds > (usedTotal + gasReserve)
      ? totalFunds - usedTotal - gasReserve
      : 0n;

    if (available < requiredAmount) {
      throw new Error(`余额不足: 需要 ${(Number(requiredAmount) / 1e18).toFixed(4)} BNB，可用 ${(Number(available) / 1e18).toFixed(4)} BNB (钱包: ${(Number(walletBalance) / 1e18).toFixed(4)}, mode2: ${(Number(mode2Adj) / 1e18).toFixed(4)}, 占用: ${(Number(usedTotal) / 1e18).toFixed(4)})`);
    }

    // 更新内存余额缓存
    const balanceObj = getUserBalance(normalizedTrader);
    balanceObj.walletBalance = walletBalance;
    balanceObj.availableBalance = available;
    balanceObj.usedMargin = positionMargin;
    balanceObj.totalBalance = totalFunds;

    return;
  }

  // V1 Settlement 路径已废弃 — 新架构只使用派生钱包 BNB
  // 如果走到这里说明 SETTLEMENT_V2_ADDRESS 未配置，用 syncUserBalanceFromChain 兜底
  await syncUserBalanceFromChain(trader);
  const balance = getUserBalance(trader);
  if (balance.availableBalance < requiredAmount) {
    throw new Error(`余额不足: 需要 ${(Number(requiredAmount) / 1e18).toFixed(4)} BNB，可用 ${(Number(balance.availableBalance) / 1e18).toFixed(4)} BNB。请确保派生钱包有足够的 BNB。`);
  }
}

/**
 * 撤单时退还保证金和手续费 (仅退还未成交部分)
 * @returns 退还金额 (1e18 ETHT 精度), 0n 表示无需退款
 */
function refundOrderAmount(trader: Address, orderId: string): bigint {
  const balance = getUserBalance(trader);
  const marginInfo = orderMarginInfos.get(orderId);

  if (!marginInfo) {
    console.log(`[Balance] Refund skipped: no margin info for order ${orderId}`);
    return 0n;
  }

  // 计算未结算比例
  const unfilledRatio = marginInfo.totalSize > 0n
    ? ((marginInfo.totalSize - marginInfo.settledSize) * 10000n) / marginInfo.totalSize
    : 10000n;

  // 按未成交比例退还 (保证金 + 手续费)
  const refundMargin = (marginInfo.margin * unfilledRatio) / 10000n;
  const refundFee = (marginInfo.fee * unfilledRatio) / 10000n;
  const refundTotal = refundMargin + refundFee;

  // 本地退还 (下次 sync 会从链上+orderMarginInfos 重新算)
  balance.availableBalance += refundTotal;
  // 注意: 不改 totalBalance — 资金从预留→可用，总资产不变

  // 删除记录 (getPendingOrdersLocked 不再计入此订单)
  orderMarginInfos.delete(orderId);
  OrderMarginRepo.delete(orderId).catch(e => trackRedisError(`Failed to delete margin info for ${orderId}`, e));

  console.log(`[Balance] Refunded: ${trader.slice(0, 10)} +$${Number(refundTotal) / 1e18} (unfilled ${Number(unfilledRatio) / 100}%), balance: $${Number(balance.availableBalance) / 1e18}`);
  return refundTotal;
}

/**
 * [Mode 2] 撤单时更新内存余额
 *
 * Mode 2 变更:
 * - 不再调用链上 Settlement.withdraw()
 * - 直接更新内存余额 (refundOrderAmount 已经做了)
 * - 用户提现时通过 Merkle 证明从 SettlementV2 提取
 */
/**
 * P3-P5: No-op in Mode 2 (off-chain matching) — balance updates happen in-memory via
 * refundOrderAmount(). This function exists as a compatibility shim for Mode 1 (fully on-chain)
 * settlement flow. In a future version with full chain settlement, this would call
 * SettlementV2.depositFor() to return funds to the user's on-chain deposit.
 */
async function withdrawFromSettlement(trader: Address, amount: bigint): Promise<void> {
  if (amount <= 0n) return;

  // Mode 2: 只记录日志，不做链上操作
  // 余额已在 refundOrderAmount 中更新到内存
  console.log(`[Mode2] ${trader.slice(0, 10)} refund $${Number(amount) / 1e18} (off-chain only)`);
}

/**
 * 订单成交时处理保证金 (支持部分成交)
 * - 按成交比例将保证金转为仓位保证金 (usedMargin)
 * - 手续费按 Maker/Taker 角色收取 (Maker 0.02%, Taker 0.05%)
 * @param filledSize 本次成交大小
 * @param isMaker true = 挂单方 (Maker, 费率更低)
 */
function settleOrderMargin(trader: Address, orderId: string, filledSize: bigint, isMaker: boolean = false): void {
  const balance = getUserBalance(trader);
  const marginInfo = orderMarginInfos.get(orderId);

  if (!marginInfo) {
    console.log(`[Balance] Settle skipped: no margin info for order ${orderId}`);
    return;
  }

  // 计算本次成交比例
  const fillRatio = marginInfo.totalSize > 0n
    ? (filledSize * 10000n) / marginInfo.totalSize
    : 10000n;

  // 按比例结算保证金
  const settleMargin = (marginInfo.margin * fillRatio) / 10000n;
  // 预扣的手续费 (按 Taker 费率 0.05%)
  const preDeductedFee = (marginInfo.fee * fillRatio) / 10000n;

  // 实际手续费: 从 config.ts 统一读取 (Maker/Taker 费率)
  const actualFeeRate = isMaker ? TRADING.MAKER_FEE_RATE : TRADING.TAKER_FEE_RATE;
  const actualFee = (filledSize * actualFeeRate) / 10000n;

  balance.usedMargin += settleMargin;

  // Queue on-chain margin deposit (optimistic: already settled in memory, async to chain)
  if (isPerpVaultEnabled() && settleMargin > 0n) {
    queueMarginDeposit(trader, settleMargin + actualFee, orderId);
  }

  // Mode 2: 开仓手续费是消耗品 — 从 chainAvailable 中"扣除"
  // 当 orderMarginInfos 删除后，pendingOrdersLocked 减少了 margin+fee，
  // 但 positionMargin 只增加 margin，所以 fee 部分会虚增 available
  // 需要通过 mode2Adj -= fee 来抵消
  if (actualFee > 0n) {
    const balBefore = balance.totalBalance;
    addMode2Adjustment(trader, -actualFee, "OPEN_FEE");
    // Bill: record opening fee for audit trail
    createBillWithMirror({
      userAddress: trader, type: "OPEN_FEE", amount: (-actualFee).toString(),
      balanceBefore: balBefore.toString(), balanceAfter: (balBefore - actualFee).toString(),
      positionId: marginInfo?.orderId || "", onChainStatus: "OFF_CHAIN",
    });
    // ✅ 手续费 80/20 分配: 80% LP (PerpVault) + 20% 保险基金
    addMode2Adjustment(FEE_RECEIVER_ADDRESS, actualFee, "PLATFORM_FEE");
    distributeTradingFee(actualFee);
    console.log(`[Fee] Open fee Ξ${Number(actualFee) / 1e18} (${isMaker ? `Maker ${TRADING.MAKER_FEE_RATE}bp` : `Taker ${TRADING.TAKER_FEE_RATE}bp`}) → 80% LP + 20% insurance`);
  }

  // Maker 退还多扣的手续费差额 (预扣 Taker fee - 实际 Maker fee)
  if (isMaker && preDeductedFee > actualFee) {
    const refund = preDeductedFee - actualFee;
    const refundBalBefore = balance.totalBalance;
    balance.availableBalance += refund;
    // mode2Adj 只扣了 actualFee，而预扣里包含了 preDeductedFee
    // 差额 refund 需要补回 mode2Adj (因为 pendingOrdersLocked 仍按原额释放)
    addMode2Adjustment(trader, refund, "MAKER_FEE_REFUND");
    createBillWithMirror({
      userAddress: trader, type: "MAKER_FEE_REFUND", amount: refund.toString(),
      balanceBefore: refundBalBefore.toString(), balanceAfter: (refundBalBefore + refund).toString(),
      onChainStatus: "OFF_CHAIN",
    });
    console.log(`[Fee] Maker fee refund Ξ${Number(refund) / 1e18} → ${trader.slice(0, 10)}`);
  }

  // 更新已结算大小
  marginInfo.settledSize += filledSize;

  // 如果完全成交，删除记录
  if (marginInfo.settledSize >= marginInfo.totalSize) {
    orderMarginInfos.delete(orderId);
    OrderMarginRepo.delete(orderId).catch(e => trackRedisError("Failed to delete settled margin", e));
    console.log(`[Balance] Fully settled: ${trader.slice(0, 10)} margin=$${Number(marginInfo.margin) / 1e18} → usedMargin`);
  } else {
    OrderMarginRepo.updateSettledSize(orderId, marginInfo.settledSize).catch(e => trackRedisError("Failed to update settledSize", e));
    console.log(`[Balance] Partial settle: ${trader.slice(0, 10)} +$${Number(settleMargin) / 1e18} (${Number(marginInfo.settledSize)}/${Number(marginInfo.totalSize)} filled)`);
  }
}

/**
 * 更新用户的未实现盈亏（根据所有仓位计算）
 */
function updateUnrealizedPnL(trader: Address, currentPrices: Map<Address, bigint>): void {
  const normalizedTrader = trader.toLowerCase() as Address;
  const positions = userPositions.get(normalizedTrader) || [];
  const balance = getUserBalance(trader);

  let totalPnL = 0n;
  for (const pos of positions) {
    const currentPrice = currentPrices.get(pos.token.toLowerCase() as Address) || BigInt(pos.entryPrice);
    const pnl = calculateUnrealizedPnL(
      BigInt(pos.size),
      BigInt(pos.entryPrice),
      currentPrice,
      pos.isLong
    );
    totalPnL += pnl;
  }
  balance.unrealizedPnL = totalPnL;
}

/**
 * 计算账户权益 = 可用余额 + 已使用保证金 + 未实现盈亏
 */
function getEquity(trader: Address): bigint {
  const balance = getUserBalance(trader);
  return balance.availableBalance + balance.usedMargin + balance.unrealizedPnL;
}

// ============================================================
// 链上仓位同步
// ============================================================

/**
 * 从 TokenFactory 获取所有支持的代币
 * 用于资金费计算
 */
async function syncSupportedTokens(): Promise<void> {
  if (!TOKEN_FACTORY_ADDRESS) {
    console.log("[Sync] No TokenFactory address configured");
    return;
  }

  try {
    const publicClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });

    const tokens = await publicClient.readContract({
      address: TOKEN_FACTORY_ADDRESS,
      abi: TOKEN_FACTORY_ABI,
      functionName: "getAllTokens",
    }) as Address[];

    // 清空并重新填充
    SUPPORTED_TOKENS.length = 0;
    for (const token of tokens) {
      const normalizedToken = token.toLowerCase() as Address;
      if (!SUPPORTED_TOKENS.includes(normalizedToken)) {
        SUPPORTED_TOKENS.push(normalizedToken);
      }
    }

    console.log(`[Sync] Loaded ${SUPPORTED_TOKENS.length} supported tokens from TokenFactory`);
    if (SUPPORTED_TOKENS.length > 0) {
      console.log(`[Sync] Tokens: ${SUPPORTED_TOKENS.map(t => t.slice(0, 10)).join(", ")}`);
    }

    // 为每个 token 初始化 lifecycle（如果尚未初始化）
    for (const token of SUPPORTED_TOKENS) {
      const state = getTokenState(token);
      if (state === TokenState.INACTIVE || state === undefined) {
        const orderBook = engine.getOrderBook(token);
        const price = orderBook?.getCurrentPrice() || 0n;
        const info = initializeTokenLifecycle(token, price);
        // 开发环境：自动激活所有 token 以便测试
        if (process.env.NODE_ENV === "development" || ALLOW_FAKE_DEPOSIT) {
          info.state = TokenState.ACTIVE;
          console.log(`[Lifecycle] Dev mode: auto-activated ${token.slice(0, 10)} → ACTIVE`);
        }
      }
    }

    // 检测已毕业的代币，注册其 Uniswap V2 Pair 地址
    await detectGraduatedTokens();
  } catch (e) {
    console.error("[Sync] Failed to load supported tokens:", e);
  }
}

/**
 * 批量从链上获取所有代币的 name/symbol，缓存到内存
 * 使用 multicall 一次性读取，避免逐个 RPC 调用
 */
async function syncTokenInfoCache(): Promise<void> {
  if (SUPPORTED_TOKENS.length === 0) return;

  const ERC20_NAME_SYMBOL_ABI = [
    { inputs: [], name: "name", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  ] as const;

  try {
    const publicClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });

    // 构建 multicall: 每个代币 2 个调用 (name + symbol)
    const calls = SUPPORTED_TOKENS.flatMap(token => [
      { address: token, abi: ERC20_NAME_SYMBOL_ABI, functionName: "name" as const },
      { address: token, abi: ERC20_NAME_SYMBOL_ABI, functionName: "symbol" as const },
    ]);

    const results = await publicClient.multicall({ contracts: calls });

    let cached = 0;
    for (let i = 0; i < SUPPORTED_TOKENS.length; i++) {
      const nameResult = results[i * 2];
      const symbolResult = results[i * 2 + 1];

      if (nameResult.status === "success" && symbolResult.status === "success") {
        TOKEN_INFO_CACHE.set(SUPPORTED_TOKENS[i].toLowerCase(), {
          name: nameResult.result as string,
          symbol: symbolResult.result as string,
        });
        cached++;
      }
    }
    console.log(`[TokenInfo] Cached name/symbol for ${cached}/${SUPPORTED_TOKENS.length} tokens via multicall`);
  } catch (e: any) {
    console.warn("[TokenInfo] Failed to sync token info cache:", (e?.message || "").slice(0, 100));
  }
}

/**
 * 批量读取所有代币的 getPoolState + getCurrentPrice，缓存到 TOKEN_POOL_CACHE
 * 使用 multicall 一次性读取，消除前端 400+ RPC 调用
 */
async function syncFullTokenData(): Promise<void> {
  if (SUPPORTED_TOKENS.length === 0) return;

  try {
    const publicClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });

    // multicall: 每个代币 2 个调用 (getPoolState + getCurrentPrice)
    const calls = SUPPORTED_TOKENS.flatMap(token => [
      {
        address: TOKEN_FACTORY_ADDRESS,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getPoolState" as const,
        args: [token],
      },
      {
        address: TOKEN_FACTORY_ADDRESS,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getCurrentPrice" as const,
        args: [token],
      },
    ]);

    const results = await publicClient.multicall({ contracts: calls });

    let cached = 0;
    for (let i = 0; i < SUPPORTED_TOKENS.length; i++) {
      const poolResult = results[i * 2];
      const priceResult = results[i * 2 + 1];

      if (poolResult.status === "success") {
        const pool = poolResult.result as {
          realETHReserve: bigint;
          realTokenReserve: bigint;
          soldTokens: bigint;
          isGraduated: boolean;
          isActive: boolean;
          creator: string;
          createdAt: bigint;
          metadataURI: string;
          graduationFailed: boolean;
          graduationAttempts: number;
          perpEnabled: boolean;
        };
        const price = priceResult.status === "success" ? (priceResult.result as bigint) : 0n;

        const tokenAddr = SUPPORTED_TOKENS[i].toLowerCase();
        const prevState = TOKEN_POOL_CACHE.get(tokenAddr);
        TOKEN_POOL_CACHE.set(tokenAddr, {
          creator: pool.creator,
          createdAt: Number(pool.createdAt),
          isGraduated: pool.isGraduated,
          isActive: pool.isActive,
          metadataURI: pool.metadataURI,
          perpEnabled: pool.perpEnabled,
          realETHReserve: pool.realETHReserve.toString(),
          soldTokens: pool.soldTokens.toString(),
          price: price.toString(),
        });
        cached++;

        // Sync graduation status to Redis metadata when chain state changes
        if (pool.isGraduated && (!prevState || !prevState.isGraduated)) {
          import("./modules/tokenMetadata").then(({ updateGraduationStatus }) => {
            updateGraduationStatus(tokenAddr, true, Math.floor(Date.now() / 1000)).catch(() => {});
          });
        }
      }
    }
    console.log(`[TokenPool] Cached full pool state for ${cached}/${SUPPORTED_TOKENS.length} tokens via multicall`);

    // 经济模型 V2: 同步 lifecycle 状态
    for (const token of SUPPORTED_TOKENS) {
      const poolCache = TOKEN_POOL_CACHE.get(token.toLowerCase());
      if (!poolCache) continue;

      const price = BigInt(poolCache.price || "0");
      const reserveETH = BigInt(poolCache.realETHReserve || "0");

      // Initialize if not yet tracked
      if (!getTokenState(token) || getTokenState(token) === "INACTIVE") {
        initializeTokenLifecycle(token, price, reserveETH, 0n);
      }

      // BC progress: soldTokens / REAL_TOKEN_SUPPLY (800M = 80% of 1B)
      const soldTokens = BigInt(poolCache.soldTokens || "0");
      const REAL_TOKEN_SUPPLY = 800_000_000n * 10n ** 18n;
      const bcProgressPct = REAL_TOKEN_SUPPLY > 0n
        ? Number((soldTokens * 100n) / REAL_TOKEN_SUPPLY)
        : 0;

      // Holder count: lazy-load only (don't block startup with 2M block scan)
      // getTokenHolders() scans historical Transfer events — too slow for BSC Testnet pruned RPCs
      // Holders will be populated on first API request to /api/token/:address/holders
      let holderCount = 1;

      updateOnChainData(token, reserveETH, 0n, holderCount, bcProgressPct);
    }
  } catch (e: any) {
    console.warn("[TokenPool] Failed to sync full token data:", (e?.message || "").slice(0, 100));
  }
}

/**
 * 添加代币到支持列表（当检测到新代币时）
 */
function addSupportedToken(token: Address): void {
  const normalizedToken = token.toLowerCase() as Address;
  if (!SUPPORTED_TOKENS.includes(normalizedToken)) {
    SUPPORTED_TOKENS.push(normalizedToken);
    console.log(`[Sync] Added new supported token: ${normalizedToken.slice(0, 10)}`);
  }
}

/**
 * 注册毕业代币 - 记录其 Uniswap V2 Pair 地址用于价格读取
 *
 * 当代币从 bonding curve 毕业到 Uniswap V2 后:
 * 1. TokenFactory.getCurrentPrice() 返回冻结的旧价格 (因为 reserve 没有归零)
 * 2. 真实市场价格在 Uniswap V2 Pair 上
 * 3. 需要从 Pair.getReserves() 读取真实价格
 *
 * @param token - 代币地址
 * @param pairAddress - Uniswap V2 Pair 地址
 */
async function registerGraduatedToken(token: Address, pairAddress: Address): Promise<void> {
  const normalizedToken = token.toLowerCase();
  const normalizedPair = pairAddress.toLowerCase() as Address;

  // 判断 WETH 是 token0 还是 token1
  // Uniswap V2 中 token0 < token1 (按地址排序)
  const isWethToken0 = WETH_ADDRESS.toLowerCase() < normalizedToken;

  graduatedTokens.set(normalizedToken, {
    pairAddress: normalizedPair,
    isWethToken0,
  });

  // Sync graduated tokens set to PerpVault for per-token OI tracking
  vaultUpdateGraduatedTokens(graduatedTokens);

  console.log(`[Graduation] ✅ Registered graduated token: ${normalizedToken.slice(0, 10)}`);
  console.log(`[Graduation]    Pair: ${normalizedPair.slice(0, 10)}, WETH is token${isWethToken0 ? '0' : '1'}`);

  // P2-3: 自动启动 Swap 事件监听 (异步，不阻塞注册流程)
  try {
    startSwapEventWatching(normalizedToken as Address, { pairAddress: normalizedPair, isWethToken0 });
  } catch (_e) {
    // Swap watcher 失败不影响毕业注册
  }
}

// ============================================================
// P2-3: Uniswap V2 Swap 事件监听 → K 线生成
// ============================================================

// 已激活的 Swap 监听器 (防止重复监听)
const activeSwapWatchers = new Set<string>();

/**
 * P2-3: 为毕业代币启动 Uniswap V2 Swap 事件监听
 * 从 Swap 事件中提取价格 + 成交量，生成 K 线数据
 */
function startSwapEventWatching(
  token: Address,
  graduatedInfo: GraduatedTokenInfo
): void {
  const normalizedToken = token.toLowerCase();

  // 防止重复监听
  if (activeSwapWatchers.has(normalizedToken)) {
    console.log(`[SwapPoller] Already active for ${normalizedToken.slice(0, 10)}`);
    return;
  }

  // 使用 HTTP 轮询替代 WebSocket watchContractEvent
  // WebSocket 会静默断开导致价格更新丢失
  const swapAbi = {
    type: "event" as const,
    name: "Swap" as const,
    inputs: [
      { name: "sender", type: "address" as const, indexed: true },
      { name: "amount0In", type: "uint256" as const, indexed: false },
      { name: "amount1In", type: "uint256" as const, indexed: false },
      { name: "amount0Out", type: "uint256" as const, indexed: false },
      { name: "amount1Out", type: "uint256" as const, indexed: false },
      { name: "to", type: "address" as const, indexed: true },
    ],
  };

  createEventPoller({
    name: `swap-${normalizedToken.slice(0, 10)}`,
    contractAddress: graduatedInfo.pairAddress,
    eventAbi: swapAbi,
    pollIntervalMs: 3000,
    backfillBlocks: 100n,
    batchSize: 500n,
    rpcUrl: RPC_URL,
    chainId: CONFIG_CHAIN_ID,
    onLogs: async (logs) => {
      for (const log of logs) {
        try {
          const { amount0In, amount1In, amount0Out, amount1Out } = (log as any).args as {
            sender: Address; amount0In: bigint; amount1In: bigint;
            amount0Out: bigint; amount1Out: bigint; to: Address;
          };

          let ethAmount: bigint, tokenAmount: bigint, isBuy: boolean;
          if (graduatedInfo.isWethToken0) {
            ethAmount = amount0In > 0n ? amount0In : amount0Out;
            tokenAmount = amount1In > 0n ? amount1In : amount1Out;
            isBuy = amount0In > 0n;
          } else {
            ethAmount = amount1In > 0n ? amount1In : amount1Out;
            tokenAmount = amount0In > 0n ? amount0In : amount0Out;
            isBuy = amount1In > 0n;
          }

          if (ethAmount === 0n || tokenAmount === 0n) continue;

          const priceEth = Number(ethAmount) / Number(tokenAmount);
          const ethVolume = Number(ethAmount) / 1e18;

          // 更新 K 线
          const { KlineRepo, KLINE_RESOLUTIONS, SpotStatsRepo } = await import("../spot/spotHistory");
          const { getRedisClient: getRedis, isRedisConnected: isRedisOk } = await import("./database/redis");
          const now = Math.floor(Date.now() / 1000);

          if (!isRedisOk()) continue;
          const redisClient = getRedis();

          for (const resolution of Object.keys(KLINE_RESOLUTIONS) as (keyof typeof KLINE_RESOLUTIONS)[]) {
            const resolutionSeconds = KLINE_RESOLUTIONS[resolution];
            const bucketTime = Math.floor(now / resolutionSeconds) * resolutionSeconds;
            const key = `spot:kline:${normalizedToken}:${resolution}`;
            const existing = await redisClient.hget(key, bucketTime.toString());

            let bar;
            if (existing) {
              bar = JSON.parse(existing);
              bar.high = Math.max(parseFloat(bar.high), priceEth).toString();
              bar.low = Math.min(parseFloat(bar.low), priceEth).toString();
              bar.close = priceEth.toString();
              bar.volume = (parseFloat(bar.volume) + ethVolume).toString();
              bar.trades += 1;
            } else {
              const prevBucketTime = bucketTime - resolutionSeconds;
              const prevBarJson = await redisClient.hget(key, prevBucketTime.toString());
              const prevClose = prevBarJson ? parseFloat(JSON.parse(prevBarJson).close) : priceEth;
              bar = {
                time: bucketTime, open: prevClose.toString(),
                high: Math.max(prevClose, priceEth).toString(), low: Math.min(prevClose, priceEth).toString(),
                close: priceEth.toString(), volume: ethVolume.toString(), trades: 1,
              };
            }
            await redisClient.hset(key, bucketTime.toString(), JSON.stringify(bar));
            const expireSeconds = resolution === "1m" ? 7 * 24 * 60 * 60 : 30 * 24 * 60 * 60;
            await redisClient.expire(key, expireSeconds);
          }

          await SpotStatsRepo.updatePrice(normalizedToken as Address, priceEth.toString(), priceEth.toString());

          const priceBigInt = BigInt(Math.floor(priceEth * 1e18));
          if (priceBigInt > 0n) {
            engine.updatePrice(normalizedToken as Address, priceBigInt);
            engine.setSpotPrice(normalizedToken as Address, priceBigInt);
            priceLastUpdatedAt.set((normalizedToken as string).toLowerCase(), Date.now());
            updateVolatility(normalizedToken as Address, priceEth);
            broadcastOrderBook(normalizedToken as Address);
          }

          const currentBucket = Math.floor(now / 60) * 60;
          const klines = await KlineRepo.get(normalizedToken as Address, "1m", currentBucket, currentBucket);
          if (klines.length > 0) {
            const kline = klines[0];
            broadcastKline(normalizedToken as Address, {
              timestamp: kline.time * 1000, open: kline.open, high: kline.high,
              low: kline.low, close: kline.close, volume: kline.volume,
            });
          }

          broadcastSpotTrade(normalizedToken as Address, {
            token: normalizedToken as Address,
            trader: ((log as any).args?.to || "0x") as Address,
            isBuy, ethAmount: ethAmount.toString(), tokenAmount: tokenAmount.toString(),
            price: priceEth.toString(), txHash: (log as any).transactionHash || null, timestamp: now,
          });
        } catch (swapErr: any) {
          console.warn(`[SwapPoller] Error for ${normalizedToken.slice(0, 10)}:`, swapErr?.message?.slice(0, 100));
        }
      }
    },
  }).catch(err => {
    console.error(`[SwapPoller] Failed to start for ${normalizedToken.slice(0, 10)}:`, err?.message);
  });

  activeSwapWatchers.add(normalizedToken);
  console.log(`[SwapPoller] ✅ Started HTTP poller for ${normalizedToken.slice(0, 10)} on Pair ${graduatedInfo.pairAddress.slice(0, 10)}`);
}

/**
 * P2-3: 为所有已毕业的代币启动 Swap 事件监听
 * 在 startEventWatching() 之后调用
 */
function startAllSwapWatchers(): void {
  for (const [token, info] of graduatedTokens.entries()) {
    startSwapEventWatching(token as Address, info);
  }
  console.log(`[P2-3] Started ${activeSwapWatchers.size} Swap event watchers for graduated tokens`);
}

/**
 * 检测已毕业的代币并注册其 Pair 地址
 * 在启动时调用，处理服务器重启期间发生的毕业事件
 */
async function detectGraduatedTokens(): Promise<void> {
  if (SUPPORTED_TOKENS.length === 0) return;

  const publicClient = createPublicClient({
    chain: activeChain,
    transport: rpcTransport,
  });

  console.log(`[Graduation] Checking ${SUPPORTED_TOKENS.length} tokens for graduation status...`);

  for (const token of SUPPORTED_TOKENS) {
    try {
      // 读取 PoolState 检查 isGraduated
      const poolState = await publicClient.readContract({
        address: TOKEN_FACTORY_ADDRESS,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getPoolState",
        args: [token],
      }) as {
        realETHReserve: bigint;
        realTokenReserve: bigint;
        soldTokens: bigint;
        isGraduated: boolean;
        isActive: boolean;
        creator: string;
        createdAt: bigint;
        metadataURI: string;
        graduationFailed: boolean;
        graduationAttempts: number;
        perpEnabled: boolean;
      };

      if (poolState.isGraduated) {
        // 通过 Uniswap V2 Factory 查找 Pair 地址
        const pairAddress = await publicClient.readContract({
          address: UNISWAP_V2_FACTORY_ADDRESS,
          abi: UNISWAP_V2_FACTORY_ABI,
          functionName: "getPair",
          args: [token, WETH_ADDRESS],
        }) as Address;

        const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
        if (pairAddress && pairAddress.toLowerCase() !== ZERO_ADDRESS) {
          await registerGraduatedToken(token, pairAddress);
        } else {
          console.warn(`[Graduation] ⚠️ Token ${token.slice(0, 10)} is graduated but no Pair found!`);
        }
      }
    } catch (e: any) {
      console.warn(`[Graduation] Error checking ${token.slice(0, 10)}:`, e?.message?.slice(0, 80));
    }
  }

  console.log(`[Graduation] Found ${graduatedTokens.size} graduated tokens`);
}

/**
 * [模式 2] 仓位只存后端 Redis，不再从链上同步
 *
 * 旧模式: 从链上 Settlement 同步所有 PairedPosition
 * 新模式: 仓位 = Redis 唯一真理源，链上只做资金托管 + 快照存证
 */
async function syncPositionsFromChain(): Promise<void> {
  console.log("[Mode2] Position sync from chain is DISABLED");
  console.log("[Mode2] Positions are stored in Redis only, chain is for fund custody + snapshot attestation");
}

/**
 * 添加仓位到用户的仓位列表
 */
async function addPositionToUser(position: Position): Promise<void> {
  const normalizedTrader = position.trader.toLowerCase() as Address;
  const positions = userPositions.get(normalizedTrader) || [];

  // 检查是否已存在（避免重复）
  const existingIndex = positions.findIndex(
    (p) => p.pairId === position.pairId && p.isLong === position.isLong
  );

  if (existingIndex >= 0) {
    positions[existingIndex] = position; // 更新
  } else {
    positions.push(position); // 新增
    console.log(`[Position] Added: ${normalizedTrader.slice(0, 10)} ${position.isLong ? 'LONG' : 'SHORT'} liqPrice=${position.liquidationPrice}`);
  }

  userPositions.set(normalizedTrader, positions);

  // ★ 同步持久化到 Redis + PG（必须成功，否则重启丢仓位）
  try {
    const redisId = await savePositionToRedis(position);
    if (redisId && !position.pairId.includes("-")) {
      position.pairId = redisId;
    }
  } catch (err) {
    console.error("[Position] CRITICAL: Failed to persist position to Redis:", err);
  }
}

// ============================================================
// 链上事件监听 (实时同步链上状态变化)
// ============================================================

let eventWatcherUnwatch: (() => void) | null = null;

/**
 * 启动链上事件监听
 * 新架构: 仅使用 SettlementV2 HTTP 事件轮询 (下方)
 * V1 Settlement WebSocket 监听器已废弃并移除
 */
async function startEventWatching(): Promise<void> {
  if (!SETTLEMENT_ADDRESS && !SETTLEMENT_V2_ADDRESS) {
    console.log("[Events] No Settlement address configured, skipping event watching");
    return;
  }

  // V1 Settlement WebSocket 事件监听器已移除
  // 新架构使用派生钱包 BNB 余额，不需要监听 Settlement V1 Deposited/Withdrawn
  if (SETTLEMENT_ADDRESS && !SETTLEMENT_V2_ADDRESS) {
    console.log("[Events] ⚠️ Only Settlement V1 configured — V1 event watchers removed. Configure SETTLEMENT_V2_ADDRESS for event polling.");
  }

  // ============================================================
  // 🔄 模式 2: 以下事件监听器已禁用
  // - PairOpened, PairClosed, Liquidated 不再需要
  // - 仓位只存后端 Redis，不从链上同步
  // - 链上只做资金托管 + Merkle Root 快照存证
  // ============================================================
  console.log("[Events] Mode 2: PairOpened/PairClosed/Liquidated listeners DISABLED");
  console.log("[Events] Mode 2: Positions are stored in Redis only");

  // ============================================================
  // SettlementV2 事件轮询 (HTTP getLogs + 区块追踪)
  // 替代 WebSocket watchContractEvent — WebSocket 会静默断开导致充值事件丢失
  // 参考: dYdX v4 Ender 按区块处理 + GMX Keeper 直查链上
  // ============================================================
  // Helper: stagger poller startups to avoid RPC burst at boot
  const staggerDelay = (ms: number) => new Promise(r => setTimeout(r, ms));

  if (SETTLEMENT_V2_ADDRESS) {
    console.log("[Events] Starting SettlementV2 HTTP event pollers (staggered):", SETTLEMENT_V2_ADDRESS);

    // 所有 SettlementV2 事件用同一个轮询器（同一合约，一次 getLogs 拿所有事件）
    // Deposited: event Deposited(address indexed user, uint256 amount, uint256 totalDeposits)
    const v2DepositedAbi = {
      type: "event" as const,
      name: "Deposited" as const,
      inputs: [
        { name: "user", type: "address" as const, indexed: true },
        { name: "amount", type: "uint256" as const, indexed: false },
        { name: "totalDeposits", type: "uint256" as const, indexed: false },
      ],
    };
    await createEventPoller({
      name: "settlementV2-deposited",
      contractAddress: SETTLEMENT_V2_ADDRESS,
      eventAbi: v2DepositedAbi,
      pollIntervalMs: 60000,
      backfillBlocks: 50n,
      batchSize: 500n,
      rpcUrl: RPC_URL,
      chainId: CONFIG_CHAIN_ID,
      onLogs: async (logs) => {
        for (const log of logs) {
          const { user, amount, totalDeposits } = (log as any).args as {
            user: Address; amount: bigint; totalDeposits: bigint;
          };
          console.log(`[EventPoller:V2] Deposited: ${user.slice(0, 10)} +Ξ${Number(amount) / 1e18} (total: Ξ${Number(totalDeposits) / 1e18})`);
          try {
            await syncUserBalanceFromChain(user);
            broadcastBalanceUpdate(user);
          } catch (e: any) {
            console.error(`[EventPoller:V2] Failed to sync after Deposited: ${e.message}`);
          }
        }
      },
    });

    await staggerDelay(3000); // Stagger to avoid RPC burst

    // DepositedBNB: event DepositedBNB(address indexed user, uint256 amount, uint256 totalDeposits)
    const v2DepositedBNBAbi = {
      type: "event" as const,
      name: "DepositedBNB" as const,
      inputs: [
        { name: "user", type: "address" as const, indexed: true },
        { name: "amount", type: "uint256" as const, indexed: false },
        { name: "totalDeposits", type: "uint256" as const, indexed: false },
      ],
    };
    await createEventPoller({
      name: "settlementV2-depositedBNB",
      contractAddress: SETTLEMENT_V2_ADDRESS,
      eventAbi: v2DepositedBNBAbi,
      pollIntervalMs: 60000,
      backfillBlocks: 50n,
      batchSize: 500n,
      rpcUrl: RPC_URL,
      chainId: CONFIG_CHAIN_ID,
      onLogs: async (logs) => {
        for (const log of logs) {
          const { user, amount, totalDeposits } = (log as any).args as {
            user: Address; amount: bigint; totalDeposits: bigint;
          };
          console.log(`[EventPoller:V2] DepositedBNB: ${user.slice(0, 10)} +Ξ${Number(amount) / 1e18} (total: Ξ${Number(totalDeposits) / 1e18})`);
          try {
            await syncUserBalanceFromChain(user);
            broadcastBalanceUpdate(user);
          } catch (e: any) {
            console.error(`[EventPoller:V2] Failed to sync after DepositedBNB: ${e.message}`);
          }
        }
      },
    });

    await staggerDelay(3000);

    // DepositedFor: event DepositedFor(address indexed user, address indexed relayer, uint256 amount)
    const v2DepositedForAbi = {
      type: "event" as const,
      name: "DepositedFor" as const,
      inputs: [
        { name: "user", type: "address" as const, indexed: true },
        { name: "relayer", type: "address" as const, indexed: true },
        { name: "amount", type: "uint256" as const, indexed: false },
      ],
    };
    await createEventPoller({
      name: "settlementV2-depositedFor",
      contractAddress: SETTLEMENT_V2_ADDRESS,
      eventAbi: v2DepositedForAbi,
      pollIntervalMs: 60000,
      backfillBlocks: 50n,
      batchSize: 500n,
      rpcUrl: RPC_URL,
      chainId: CONFIG_CHAIN_ID,
      onLogs: async (logs) => {
        for (const log of logs) {
          const { user, relayer, amount } = (log as any).args as {
            user: Address; relayer: Address; amount: bigint;
          };
          console.log(`[EventPoller:V2] DepositedFor: ${relayer.slice(0, 10)} → ${user.slice(0, 10)} +Ξ${Number(amount) / 1e18}`);
          try {
            await syncUserBalanceFromChain(user);
            broadcastBalanceUpdate(user);
          } catch (e: any) {
            console.error(`[EventPoller:V2] Failed to sync after DepositedFor: ${e.message}`);
          }
        }
      },
    });

    await staggerDelay(3000);

    // Withdrawn: event Withdrawn(address indexed user, uint256 amount, uint256 nonce)
    const v2WithdrawnAbi = {
      type: "event" as const,
      name: "Withdrawn" as const,
      inputs: [
        { name: "user", type: "address" as const, indexed: true },
        { name: "amount", type: "uint256" as const, indexed: false },
        { name: "nonce", type: "uint256" as const, indexed: false },
      ],
    };
    await createEventPoller({
      name: "settlementV2-withdrawn",
      contractAddress: SETTLEMENT_V2_ADDRESS,
      eventAbi: v2WithdrawnAbi,
      pollIntervalMs: 60000,
      backfillBlocks: 50n,
      batchSize: 500n,
      rpcUrl: RPC_URL,
      chainId: CONFIG_CHAIN_ID,
      onLogs: async (logs) => {
        for (const log of logs) {
          const { user, amount, nonce } = (log as any).args as {
            user: Address; amount: bigint; nonce: bigint;
          };
          const normalizedUser = user.toLowerCase() as Address;
          console.log(`[EventPoller:V2] Withdrawn: ${normalizedUser.slice(0, 10)} -Ξ${Number(amount) / 1e18} (nonce: ${nonce})`);
          try {
            // ★ BUG FIX: Deduct mode2Adj by withdrawal amount BEFORE syncing balance.
            // Without this, syncUserBalanceFromChain sees walletBalance INCREASE (WBNB arrived
            // in user's wallet from SettlementV2) but mode2Adj stays the same → balance inflates.
            //
            // The handler (/api/wallet/withdraw) may have already pre-deducted a "profit portion"
            // from mode2 (the part exceeding chainDeposit). We deduct the FULL amount here because
            // walletBalance will increase by the full withdrawal amount. If the handler already
            // deducted some mode2, that pre-deduction covered a different scenario (walletBalance
            // was zero at request time, so profit portion was mode2-only money).
            // After chain withdrawal: walletBalance↑ by `amount`, so we need mode2↓ by `amount`.
            //
            // Check if handler already deducted mode2 for this withdrawal (via pending record)
            let alreadyDeducted = 0n;
            for (const [, record] of pendingWithdrawalMode2s) {
              if (record.trader.toLowerCase() === normalizedUser &&
                  BigInt(record.withdrawAmount) === amount) {
                alreadyDeducted = BigInt(record.mode2Portion);
                // Clean up the pending record — withdrawal confirmed
                pendingWithdrawalMode2s.delete(record.id || "");
                PendingWithdrawalMode2Repo.remove(record.id || "").catch(() => {});
                break;
              }
            }
            const remainingDeduction = amount - alreadyDeducted;
            if (remainingDeduction > 0n) {
              addMode2Adjustment(normalizedUser, -remainingDeduction, "CHAIN_WITHDRAWN");
            }
            if (alreadyDeducted > 0n) {
              console.log(`[EventPoller:V2] Withdrawn: handler pre-deducted Ξ${Number(alreadyDeducted) / 1e18}, event deducted Ξ${Number(remainingDeduction) / 1e18}`);
            }

            // Write WITHDRAWAL bill
            const balanceBefore = computeSettlementBalance(normalizedUser);
            await syncUserBalanceFromChain(normalizedUser);
            const balanceAfter = computeSettlementBalance(normalizedUser);
            createBillWithMirror({
              userAddress: normalizedUser,
              type: "WITHDRAWAL",
              amount: (-amount).toString(),
              balanceBefore: balanceBefore.toString(),
              balanceAfter: balanceAfter.toString(),
              timestamp: Date.now(),
              note: `on-chain withdrawal nonce=${nonce}`,
            });

            broadcastBalanceUpdate(normalizedUser);
          } catch (e: any) {
            console.error(`[EventPoller:V2] Failed to sync after Withdrawn: ${e.message}`);
          }
        }
      },
    });

    console.log("[Events] SettlementV2 HTTP pollers active: Deposited, DepositedBNB, DepositedFor, Withdrawn (3s interval)");
  }

  await staggerDelay(5000); // Longer delay before TokenFactory pollers

  // TokenFactory LiquidityMigrated: HTTP 轮询 (代币毕业到 Uniswap V2)
  console.log("[Events] Starting TokenFactory LiquidityMigrated HTTP poller:", TOKEN_FACTORY_ADDRESS);
  const liquidityMigratedAbi = {
    type: "event" as const,
    name: "LiquidityMigrated" as const,
    inputs: [
      { name: "tokenAddress", type: "address" as const, indexed: true },
      { name: "pairAddress", type: "address" as const, indexed: false },
      { name: "ethLiquidity", type: "uint256" as const, indexed: false },
      { name: "tokenLiquidity", type: "uint256" as const, indexed: false },
      { name: "timestamp", type: "uint256" as const, indexed: false },
    ],
  };
  await createEventPoller({
    name: "tokenFactory-liquidityMigrated",
    contractAddress: TOKEN_FACTORY_ADDRESS,
    eventAbi: liquidityMigratedAbi,
    pollIntervalMs: 120000,
    backfillBlocks: 50n,
    batchSize: 500n,
    rpcUrl: RPC_URL,
    chainId: CONFIG_CHAIN_ID,
    onLogs: async (logs) => {
      for (const log of logs) {
        const { tokenAddress, pairAddress, ethLiquidity, tokenLiquidity } = (log as any).args as {
          tokenAddress: Address; pairAddress: Address; ethLiquidity: bigint; tokenLiquidity: bigint;
        };
        console.log(`[EventPoller] 🎓 LiquidityMigrated: ${tokenAddress.slice(0, 10)} → Pair ${pairAddress.slice(0, 10)}`);
        console.log(`[EventPoller]    ETH: ${Number(ethLiquidity) / 1e18}, Tokens: ${Number(tokenLiquidity) / 1e18}`);
        await registerGraduatedToken(tokenAddress, pairAddress);
        console.log(`[EventPoller] ✅ Price source switched to Uniswap V2 for ${tokenAddress.slice(0, 10)}`);
      }
    },
  });

  await staggerDelay(3000);

  // TokenFactory TokenCreated: HTTP 轮询 (新代币创建)
  console.log("[Events] Starting TokenFactory TokenCreated HTTP poller:", TOKEN_FACTORY_ADDRESS);
  const tokenCreatedAbi = {
    type: "event" as const,
    name: "TokenCreated" as const,
    inputs: [
      { name: "tokenAddress", type: "address" as const, indexed: true },
      { name: "creator", type: "address" as const, indexed: true },
      { name: "name", type: "string" as const, indexed: false },
      { name: "symbol", type: "string" as const, indexed: false },
      { name: "uri", type: "string" as const, indexed: false },
      { name: "totalSupply", type: "uint256" as const, indexed: false },
    ],
  };
  await createEventPoller({
    name: "tokenFactory-tokenCreated",
    contractAddress: TOKEN_FACTORY_ADDRESS,
    eventAbi: tokenCreatedAbi,
    pollIntervalMs: 120000,
    backfillBlocks: 50n,
    batchSize: 500n,
    rpcUrl: RPC_URL,
    chainId: CONFIG_CHAIN_ID,
    onLogs: async (logs) => {
      for (const log of logs) {
        const { tokenAddress, creator, name, symbol, uri } = (log as any).args as {
          tokenAddress: Address; creator: Address; name: string; symbol: string; uri: string;
        };
        console.log(`[EventPoller] TokenCreated: ${symbol} (${name}) at ${tokenAddress.slice(0, 10)} by ${creator.slice(0, 10)}`);
        addSupportedToken(tokenAddress);

        // 更新 TOKEN_INFO_CACHE
        const normalizedTokenAddr = tokenAddress.toLowerCase();
        TOKEN_INFO_CACHE.set(normalizedTokenAddr, { name, symbol: symbol.toUpperCase() });

        // 广播给 WS 客户端
        const tokenInfoUpdate = JSON.stringify({
          type: "all_token_info",
          data: Object.fromEntries(TOKEN_INFO_CACHE),
          timestamp: Date.now(),
        });
        for (const [client] of wsClients.entries()) {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(tokenInfoUpdate); } catch {}
          }
        }

        // 自动创建 metadata
        try {
          const { saveTokenMetadata, getTokenMetadata } = await import("./modules/tokenMetadata");
          const instId = `${symbol.toUpperCase()}-USDT-SWAP`;
          const existing = await getTokenMetadata(instId);
          if (!existing) {
            let description = "", imageUrl = "", website = "", twitter = "", telegram = "", discord = "";
            if (uri) {
              try {
                let metadataJson: any = null;
                if (uri.startsWith("data:application/json;base64,")) {
                  const base64 = uri.replace("data:application/json;base64,", "");
                  metadataJson = JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
                } else if (uri.startsWith("ipfs://")) {
                  const ipfsHash = uri.replace("ipfs://", "");
                  const resp = await fetch(`https://gateway.pinata.cloud/ipfs/${ipfsHash}`, { signal: AbortSignal.timeout(5000) });
                  if (resp.ok) metadataJson = await resp.json();
                }
                if (metadataJson) {
                  description = metadataJson.description || "";
                  imageUrl = metadataJson.image || metadataJson.imageUrl || "";
                  website = metadataJson.external_url || "";
                  for (const attr of (metadataJson.attributes || [])) {
                    if (attr.trait_type === "twitter") twitter = attr.value || "";
                    if (attr.trait_type === "telegram") telegram = attr.value || "";
                    if (attr.trait_type === "discord") discord = attr.value || "";
                  }
                }
              } catch (parseErr) {
                console.warn(`[EventPoller] Failed to parse metadataURI for ${symbol}:`, parseErr);
              }
            }
            await saveTokenMetadata({
              instId, tokenAddress, name, symbol: symbol.toUpperCase(),
              description, logoUrl: imageUrl, imageUrl, website, twitter, telegram, discord,
              creatorAddress: creator, totalSupply: "1000000000",
            });
            console.log(`[EventPoller] ✅ Auto-created metadata for ${symbol}`);
          }
        } catch (metaErr: any) {
          console.warn(`[EventPoller] Failed to auto-create metadata for ${symbol}: ${metaErr?.message}`);
        }

        // 创建初始 K 线
        try {
          const { initializeTokenKline } = await import("../spot/spotHistory");
          const rpcClient = createPublicClient({ chain: activeChain, transport: rpcTransport });
          const getCurrentPriceAbi = [{
            inputs: [{ name: "token", type: "address" }], name: "getCurrentPrice",
            outputs: [{ type: "uint256" }], stateMutability: "view", type: "function",
          }] as const;
          const priceWei = await rpcClient.readContract({
            address: TOKEN_FACTORY_ADDRESS, abi: getCurrentPriceAbi,
            functionName: "getCurrentPrice", args: [tokenAddress],
          });
          const initialPriceEth = Number(priceWei) / 1e18;
          const ethPriceUsd = currentEthPriceUsd || 600;
          await initializeTokenKline(tokenAddress, initialPriceEth.toString(), (initialPriceEth * ethPriceUsd).toString(), Number((log as any).blockNumber || 0n));
          console.log(`[EventPoller] Initialized K-line for ${symbol}: ${initialPriceEth.toExponential(4)} ETH`);
        } catch (initErr) {
          console.warn("[EventPoller] Failed to initialize K-line:", initErr);
        }
      }
    },
  });

  // TokenFactory Trade 事件: WebSocket 版已删除
  // 只保留 HTTP 轮询版 (startTradeEventPoller, 更可靠)

  // 监听 WBNB ERC20 Transfer 事件 (用户转 WBNB 到/从派生钱包)
  if (WETH_ADDRESS && WSS_URL) {
    console.log("[Events] Starting WBNB Transfer event watching:", WETH_ADDRESS);
    const wbnbWatchClient = createPublicClient({
      chain: activeChain,
      transport: webSocket(WSS_URL),
    });
    wbnbWatchClient.watchContractEvent({
      address: WETH_ADDRESS,
      abi: [{
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      }],
      eventName: "Transfer",
      onLogs: async (logs) => {
        for (const log of logs) {
          const { from, to, value } = log.args as { from: Address; to: Address; value: bigint };
          const normalizedTo = to.toLowerCase() as Address;
          const normalizedFrom = from.toLowerCase() as Address;

          // 转入派生钱包 → 同步余额 + 推送
          // ★ Skip if from SettlementV2 — Withdrawn event handler will handle mode2Adj + sync
          // Without this, walletBalance inflates before mode2 deduction → 60s race window
          const isFromSettlement = SETTLEMENT_V2_ADDRESS &&
            normalizedFrom === SETTLEMENT_V2_ADDRESS.toLowerCase();
          if (!isFromSettlement && getUserBalance(normalizedTo).totalBalance !== undefined) {
            console.log(`[Events] WETH Transfer IN: ${from.slice(0, 10)} → ${to.slice(0, 10)}, +Ξ${Number(value) / 1e18}`);
            await syncUserBalanceFromChain(normalizedTo);
            broadcastBalanceUpdate(normalizedTo);
          } else if (isFromSettlement) {
            console.log(`[Events] WETH Transfer IN (from SettlementV2, skip sync — Withdrawn handler will reconcile): ${to.slice(0, 10)}, +Ξ${Number(value) / 1e18}`);
          }

          // 从派生钱包转出 → 同步余额 + 推送
          if (getUserBalance(normalizedFrom).totalBalance !== undefined) {
            console.log(`[Events] WETH Transfer OUT: ${from.slice(0, 10)} → ${to.slice(0, 10)}, -Ξ${Number(value) / 1e18}`);
            await syncUserBalanceFromChain(normalizedFrom);
            broadcastBalanceUpdate(normalizedFrom);
          }
        }
      },
    });
  } else {
    console.warn("[Events] WETH_ADDRESS not configured, skipping Transfer event watching");
  }

  console.log("[Events] Event watching started successfully");

  // ========================================
  // Trade 事件监听已整合到 syncSpotPrices 周期中 (每 5 次 sync = ~15s)
  // 不再单独启动 TradePoller — 避免额外 RPC 请求被限流
  // ========================================
  console.log("[Events] Trade event detection integrated into syncSpotPrices (every ~15s)");
}

/**
 * 基于 HTTP 轮询的 Trade 事件监听
 *
 * WebSocket 事件订阅容易静默断开（尤其是免费公共节点），
 * 此轮询器使用 HTTP getLogs 定期扫描新区块，确保不漏掉任何交易。
 *
 * 工作方式:
 * 1. 启动时从当前区块开始记录 lastScannedBlock
 * 2. 每 15 秒轮询一次，获取 lastScannedBlock+1 到 latest 之间的 Trade 事件
 * 3. 调用 processTradeEvent 存储（内部会自动去重）
 */
let lastScannedBlock = 0n;
const TRADE_POLL_INTERVAL_MS = 15_000; // 15 秒轮询一次

async function startTradeEventPoller(): Promise<void> {
  const { createPublicClient, http, parseAbiItem, fallback } = await import("viem");

  // Use a DEDICATED transport for TradePoller to avoid competing with syncSpotPrices
  // Primary: fallback URL 1 (different endpoint from main transport)
  // Backup: fallback URL 2, then main RPC_URL
  const tradeRpcUrls = [
    process.env.RPC_URL_FALLBACK_1,
    process.env.RPC_URL_FALLBACK_2,
    RPC_URL,
  ].filter(Boolean) as string[];
  const tradeTransport = tradeRpcUrls.length > 1
    ? fallback(tradeRpcUrls.map(url => http(url, { retryCount: 1, retryDelay: 2000 })))
    : http(tradeRpcUrls[0] || RPC_URL, { retryCount: 2, retryDelay: 1000 });
  console.log(`[TradePoller] Using dedicated RPC: ${tradeRpcUrls[0]?.slice(0, 40)}...`);

  const pollClient = createPublicClient({
    chain: activeChain,
    transport: tradeTransport,
  });

  const TRADE_EVENT_ABI = parseAbiItem(
    "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 virtualEth, uint256 virtualToken, uint256 timestamp)"
  );

  // 获取当前区块作为起始点
  const currentBlock = await pollClient.getBlockNumber();
  lastScannedBlock = currentBlock;
  console.log(`[TradePoller] Started at block ${currentBlock}, polling every ${TRADE_POLL_INTERVAL_MS / 1000}s`);

  // 启动前先回填：扫描最近 20 个区块（~1 分钟）
  // 减少回填范围以避免与其他 EventPoller 启动竞争 RPC 配额
  try {
    const backfillFrom = currentBlock > 20n ? currentBlock - 20n : 0n;
    console.log(`[TradePoller] Backfilling from block ${backfillFrom} to ${currentBlock}...`);
    await pollTradeEvents(pollClient, TRADE_EVENT_ABI, backfillFrom, currentBlock);
  } catch (e: any) {
    console.error(`[TradePoller] Backfill failed:`, e.message);
  }

  // 定期轮询新事件
  setInterval(async () => {
    try {
      const latestBlock = await pollClient.getBlockNumber();
      if (latestBlock <= lastScannedBlock) return; // 没有新区块

      const fromBlock = lastScannedBlock + 1n;
      const toBlock = latestBlock;

      await pollTradeEvents(pollClient, TRADE_EVENT_ABI, fromBlock, toBlock);
      lastScannedBlock = toBlock;
    } catch (e: any) {
      console.error(`[TradePoller] Poll error:`, e.message);
      // 不更新 lastScannedBlock，下次重试
    }
  }, TRADE_POLL_INTERVAL_MS);
}

/**
 * 轮询指定区块范围内的 Trade 事件并处理
 */
async function pollTradeEvents(
  client: any,
  eventAbi: any,
  fromBlock: bigint,
  toBlock: bigint
): Promise<void> {
  const BATCH_SIZE = 500n; // BSC Testnet public RPC limits getLogs range
  let totalProcessed = 0;

  for (let start = fromBlock; start <= toBlock; start += BATCH_SIZE) {
    const end = start + BATCH_SIZE > toBlock ? toBlock : start + BATCH_SIZE;

    const logs = await client.getLogs({
      address: TOKEN_FACTORY_ADDRESS,
      event: eventAbi,
      fromBlock: start,
      toBlock: end,
    });

    if (logs.length === 0) continue;

    for (const log of logs) {
      const args = log.args as {
        token: Address;
        trader: Address;
        isBuy: boolean;
        ethAmount: bigint;
        tokenAmount: bigint;
        virtualEth: bigint;
        virtualToken: bigint;
        timestamp: bigint;
      };

      try {
        const { processTradeEvent } = await import("../spot/spotHistory");
        const ethPriceUsd = currentEthPriceUsd || 600;

        // processTradeEvent 内部会检查 exists() 自动去重
        await processTradeEvent(
          args.token,
          args.trader,
          args.isBuy,
          args.ethAmount,
          args.tokenAmount,
          args.virtualEth,
          args.virtualToken,
          args.timestamp,
          log.transactionHash as Hex,
          log.blockNumber ?? 0n,
          ethPriceUsd
        );
        totalProcessed++;

        // 确保代币在支持列表中
        addSupportedToken(args.token);

        // 广播给 WebSocket 客户端
        let afterVirtualEth: bigint;
        let afterVirtualToken: bigint;
        if (args.isBuy) {
          afterVirtualEth = args.virtualEth + args.ethAmount;
          afterVirtualToken = args.virtualToken - args.tokenAmount;
        } else {
          const FEE_MULTIPLIER = 0.99;
          const ethOutTotal = BigInt(Math.ceil(Number(args.ethAmount) / FEE_MULTIPLIER));
          afterVirtualEth = args.virtualEth - ethOutTotal;
          afterVirtualToken = args.virtualToken + args.tokenAmount;
        }
        const afterPrice = afterVirtualToken > 0n
          ? Number(afterVirtualEth) / Number(afterVirtualToken)
          : Number(args.virtualEth) / Number(args.virtualToken);

        broadcastSpotTrade(args.token, {
          token: args.token,
          trader: args.trader,
          isBuy: args.isBuy,
          ethAmount: args.ethAmount.toString(),
          tokenAmount: args.tokenAmount.toString(),
          price: afterPrice.toString(),
          txHash: log.transactionHash,
          timestamp: Number(args.timestamp),
        });
      } catch (tradeErr: any) {
        console.error(`[TradePoller] Failed to process trade ${log.transactionHash?.slice(0, 10)}:`, tradeErr.message);
      }
    }
  }

  if (totalProcessed > 0) {
    console.log(`[TradePoller] Processed ${totalProcessed} trades from blocks ${fromBlock}-${toBlock}`);
  }
}

/**
 * [模式 2] 此函数已弃用
 *
 * 旧模式: 从链上 PairOpened 事件同步仓位
 * 新模式: 仓位完全在后端管理，由 addPositionToUser() 在撮合时创建
 */
// function syncPositionFromChainData() - DEPRECATED in Mode 2

/**
 * 根据 pairId 移除仓位
 */
function removePositionByPairId(pairId: string): void {
  for (const [trader, positions] of userPositions.entries()) {
    const filteredPositions = positions.filter((p) => p.pairId !== pairId);
    if (filteredPositions.length !== positions.length) {
      console.log(`[Position] Removed pairId ${pairId} from ${trader.slice(0, 10)}`);
      userPositions.set(trader, filteredPositions);

      // 同步删除 Redis 中的仓位
      deletePositionFromRedis(pairId, "CLOSED", trader as Address).catch((err) => {
        console.error("[Redis] Failed to delete position:", err);
      });
    }
  }
}

/**
 * 广播余额更新到前端
 */
function broadcastBalanceUpdate(user: Address): void {
  const normalizedUser = user.toLowerCase();
  const balance = getUserBalance(normalizedUser as Address);
  const message = JSON.stringify({
    type: "balance",
    data: {
      trader: normalizedUser,
      totalBalance: balance.totalBalance.toString(),
      availableBalance: balance.availableBalance.toString(),
      usedMargin: (balance.usedMargin || 0n).toString(),
      unrealizedPnL: (balance.unrealizedPnL || 0n).toString(),
      walletBalance: (balance.walletBalance || 0n).toString(),
      settlementAvailable: (balance.settlementAvailable || 0n).toString(),
      settlementLocked: (balance.settlementLocked || 0n).toString(),
    },
    timestamp: Math.floor(Date.now() / 1000),
  });

  // AUDIT-FIX ME-C01: 仅向该用户自己的 WS 客户端发送余额 (通过 subscribe_risk 订阅)
  // 旧代码遍历所有 wsClients 导致 User A 能看到 User B 的余额 — 严重隐私泄露
  const wsSet = wsTraderClients.get(normalizedUser as Address);
  if (wsSet) {
    for (const client of wsSet) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}

/**
 * 广播仓位更新到前端
 * 1. 发送 "positions" 通知 (触发前端 HTTP refetch, 兼容旧逻辑)
 * 2. 立即推送 "position_risks" 完整仓位数据 (实时更新, 无需等 500ms 周期)
 */
function broadcastPositionUpdate(user: Address, token: Address): void {
  const normalizedToken = token.toLowerCase() as Address;
  const normalizedUser = user.toLowerCase() as Address;

  // 1. 通知所有订阅该 token 的客户端 (触发 HTTP refetch)
  const notification = JSON.stringify({
    type: "positions",
    user: normalizedUser,
    token: normalizedToken,
    timestamp: Date.now(),
  });

  for (const [client, subscriptions] of wsClients.entries()) {
    if (client.readyState === WebSocket.OPEN && subscriptions.has(normalizedToken)) {
      client.send(notification);
    }
  }

  // 2. 立即推送该用户的完整仓位数据 (position_risks)
  // 不等待 broadcastRiskData 的 500ms 周期，确保仓位变更即时反映
  broadcastUserPositionRisks(normalizedUser);
}

/**
 * 向指定用户推送其完整仓位风险数据
 * 通过 wsTraderClients (subscribe_risk 订阅) 发送
 */
function broadcastUserPositionRisks(trader: Address): void {
  const wsSet = wsTraderClients.get(trader);
  if (!wsSet || wsSet.size === 0) return;

  const positions = userPositions.get(trader) || [];
  const positionRisks = positions.map(pos => ({
    pairId: pos.pairId,
    trader: pos.trader,
    token: pos.token,
    isLong: pos.isLong,
    size: pos.size,
    entryPrice: pos.entryPrice,
    leverage: pos.leverage,
    marginRatio: pos.marginRatio || "10000",
    mmr: pos.mmr || "200",
    roe: pos.roe || "0",
    liquidationPrice: pos.liquidationPrice || "0",
    markPrice: pos.markPrice || "0",
    unrealizedPnL: pos.unrealizedPnL || "0",
    collateral: pos.collateral,
    adlScore: parseFloat(pos.adlScore || "0"),
    adlRanking: pos.adlRanking || 1,
    riskLevel: pos.riskLevel || "low",
  }));

  const message = JSON.stringify({
    type: "position_risks",
    positions: positionRisks,
    timestamp: Date.now(),
  });

  for (const ws of wsSet) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * 广播现货交易事件到前端
 */
function broadcastSpotTrade(token: Address, trade: {
  token: Address;
  trader: Address;
  isBuy: boolean;
  ethAmount: string;
  tokenAmount: string;
  price: string;
  txHash: Hex | null;
  timestamp: number;
}): void {
  const normalizedToken = token.toLowerCase() as Address;
  const message = JSON.stringify({
    type: "spot_trade",
    token: normalizedToken,
    ...trade,
  });

  for (const [client, subscriptions] of wsClients.entries()) {
    if (client.readyState === WebSocket.OPEN && subscriptions.has(normalizedToken)) {
      client.send(message);
    }
  }
}

/**
 * 广播 K线更新到前端
 */
function broadcastKline(token: Address, kline: {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}): void {
  const normalizedToken = token.toLowerCase() as Address;
  // 统一消息格式: 与 handlers.ts 的 broadcastKline 保持一致
  // 前端 useWebSocketKlines 读取 message.data.xxx
  const message = JSON.stringify({
    type: "kline",
    data: { token: normalizedToken, ...kline },
    timestamp: Date.now(),
  });

  for (const [client, subscriptions] of wsClients.entries()) {
    if (client.readyState === WebSocket.OPEN && subscriptions.has(normalizedToken)) {
      client.send(message);
    }
  }
}

// ============================================================
// 猎杀场：清算追踪系统
// ============================================================

interface LiquidationRecord {
  id: string;
  token: Address;
  liquidatedTrader: Address;
  liquidator: Address;
  isLong: boolean;
  size: string;
  entryPrice: string;
  liquidationPrice: string;
  collateralLost: string;
  timestamp: number;
}

interface HunterStats {
  address: Address;
  totalKills: number;
  totalProfitUSD: string;
  lastKillTime: number;
}

// 清算历史记录（按代币）
const liquidationHistory = new Map<Address, LiquidationRecord[]>();

// 猎杀者排行榜
const hunterStats = new Map<Address, HunterStats>();

// 全局清算计数
let globalLiquidationCount = 0;

/**
 * 创建虚拟 LP 订单 (LP 作为对手方时使用)
 * LP 不是真实交易者，只是 PerpVault 池子的占位符
 */
function createVirtualLPOrder(
  token: Address,
  isLong: boolean,
  size: bigint,
  price: bigint,
  leverage: bigint
): Order {
  const now = Date.now();
  return {
    id: `lp_fill_${now}_${Math.random().toString(36).slice(2, 8)}`,
    trader: PERP_VAULT_ADDRESS_LOCAL as Address,
    token: token.toLowerCase() as Address,
    isLong,
    size,
    leverage,
    price,
    orderType: OrderType.MARKET,
    timeInForce: TimeInForce.GTC,
    reduceOnly: false,
    postOnly: false,
    status: OrderStatus.FILLED,
    filledSize: size,
    avgFillPrice: price,
    totalFillValue: size,
    fee: 0n,
    feeCurrency: "ETH",
    margin: 0n,
    collateral: 0n,
    createdAt: now,
    updatedAt: now,
    deadline: BigInt(Math.floor(now / 1000) + 86400),
    nonce: 0n,
    signature: "0x" as `0x${string}`,
    source: OrderSource.API,
  };
}

/**
 * 创建或更新持仓记录
 */
async function createOrUpdatePosition(
  trader: Address,
  token: Address,
  isLong: boolean,
  size: bigint,
  entryPrice: bigint,
  leverage: bigint,
  counterparty: Address,
  orderId: string
): void {
  const normalizedTrader = trader.toLowerCase() as Address;
  const normalizedToken = token.toLowerCase() as Address;
  const now = Date.now();

  // 调试：打印输入参数
  console.log(`[Position] Input: size=${size}, entryPrice=${entryPrice}, leverage=${leverage}`);

  // 计算保证金 (参考 GMX/Binance)
  // 精度说明:
  //   - size: 1e18 精度 (ETH 名义价值)
  //   - entryPrice: 1e18 精度 (ETH/token 价格，来自 Bonding Curve)
  //   - leverage: 1e4 精度 (10x = 100000)
  //   - collateral 输出: 1e18 精度 (ETH)
  //
  // ⚠️ 重要：前端传的 size 已经是 ETH 名义价值 (1e18 精度)
  // 例如：0.2 ETH 仓位 → size = 200000000000000000 (0.2 * 1e18)
  const positionValue = size; // size 本身就是 ETH 名义价值 (1e18 精度)
  console.log(`[Position] positionValue (1e18 ETH) = ${positionValue} ($${Number(positionValue) / 1e18})`);

  // 保证金 = 仓位价值 / 杠杆倍数
  // 因为 leverage 是 1e4 精度, 所以: collateral = positionValue * 1e4 / leverage
  const collateral = (positionValue * 10000n) / leverage; // USD, 1e18 精度
  console.log(`[Position] collateral (1e18 ETH) = ${collateral}, in USD = $${Number(collateral) / 1e18}`)

  // 注意: 保证金已在下单时扣除 (deductOrderAmount)，并在成交时结算 (settleOrderMargin)
  // 这里不再调用 lockMargin，避免重复扣款

  // ============================================================
  // 动态 MMR 计算 (与 calculateLiquidationPrice 保持一致)
  // ============================================================
  // MMR = min(基础MMR 2%, 初始保证金率 * 50%)
  // 这样确保 MMR < 初始保证金率，强平价才会在正确的一侧
  const baseMmr = 200n; // 基础 2%
  const initialMarginRateBp = (10000n * 10000n) / leverage; // 初始保证金率 (基点)
  const maxMmr = initialMarginRateBp / 2n; // 不能超过初始保证金率的一半
  const effectiveMmr = baseMmr < maxMmr ? baseMmr : maxMmr;

  // 计算清算价格 (使用动态 MMR)
  const liquidationPrice = calculateLiquidationPrice(entryPrice, leverage, isLong, effectiveMmr);

  // 初始保证金率 = 1 / 杠杆倍数 = 1e4 / leverage * 1e4 = 1e8 / leverage
  // 例如 10x: marginRatio = 1e8 / 100000 = 1000 (10%)
  const marginRatio = (10n ** 8n) / leverage;

  // 计算开仓手续费 (Taker 费率 — 开仓初始显示用)
  // 行业标准: 刚开仓时价格没变，未实现盈亏 = -手续费
  const openFee = (positionValue * TRADING.TAKER_FEE_RATE) / 10000n; // USD, 1e18 精度

  // 盈亏平衡价格 = 开仓价 ± 手续费对应的价格变动
  const breakEvenPrice = isLong
    ? entryPrice + (entryPrice * TRADING.TAKER_FEE_RATE) / 10000n
    : entryPrice - (entryPrice * TRADING.TAKER_FEE_RATE) / 10000n;

  // 计算维持保证金 (使用动态 MMR)
  const maintenanceMargin = (positionValue * effectiveMmr) / 10000n; // USD, 1e18 精度

  console.log(`[Position] leverage=${Number(leverage)/10000}x, initialMarginRate=${Number(initialMarginRateBp)/100}%, effectiveMmr=${Number(effectiveMmr)/100}%`);

  // 初始未实现盈亏 = -开仓手续费 (刚开仓价格没变就是亏手续费)
  const initialPnL = -openFee;

  // 初始保证金率 = 维持保证金 / (保证金 + PnL)
  // 行业标准 (Binance): marginRatio = MM / Equity, 越大越危险
  const equity = collateral + initialPnL;
  const initialMarginRatio = equity > 0n
    ? (maintenanceMargin * 10000n) / equity
    : 10000n;

  console.log(`[Position] openFee: $${Number(openFee) / 1e18}, initialPnL: $${Number(initialPnL) / 1e18}`);
  console.log(`[Position] equity: $${Number(equity) / 1e18}, marginRatio: ${Number(initialMarginRatio) / 100}%`);

  const position: Position = {
    // 基本标识
    pairId: `${normalizedToken}_${normalizedTrader}_${now}`,
    trader: normalizedTrader,
    token: normalizedToken,

    // 仓位参数
    isLong,
    size: size.toString(),
    entryPrice: entryPrice.toString(),
    leverage: (leverage / 10000n).toString(), // 转换为人类可读 (10x = "10")

    // 价格信息
    markPrice: entryPrice.toString(), // 初始化为开仓价
    liquidationPrice: liquidationPrice.toString(),
    breakEvenPrice: breakEvenPrice.toString(),

    // 保证金信息
    collateral: collateral.toString(),
    margin: collateral.toString(),
    marginRatio: initialMarginRatio.toString(),
    maintenanceMargin: maintenanceMargin.toString(),
    mmr: effectiveMmr.toString(), // 动态维持保证金率 (基点)

    // 盈亏信息 (初始为 -手续费)
    unrealizedPnL: initialPnL.toString(),
    realizedPnL: "0",
    roe: collateral > 0n ? ((initialPnL * 10000n) / collateral).toString() : "0", // ROE% = PnL / 保证金 * 100
    fundingFee: "0",

    // 止盈止损
    takeProfitPrice: null,
    stopLossPrice: null,

    // 关联订单
    orderId,
    orderIds: [orderId],

    // 系统信息
    counterparty,
    createdAt: now,
    updatedAt: now,

    // 风险指标
    adlRanking: 3,
    riskLevel: "medium",
  };

  // 获取用户现有持仓
  const positions = userPositions.get(normalizedTrader) || [];

  // 查找是否有同方向同代币的持仓
  const existingIndex = positions.findIndex(
    (p) => p.token === normalizedToken && p.isLong === isLong
  );

  if (existingIndex >= 0) {
    // 合并持仓（加仓）
    const existing = positions[existingIndex];
    const oldSize = BigInt(existing.size);
    const oldEntryPrice = BigInt(existing.entryPrice);
    const newSize = oldSize + size;

    // 计算新的平均入场价
    const newEntryPrice = (oldSize * oldEntryPrice + size * entryPrice) / newSize;
    const newCollateral = BigInt(existing.collateral) + collateral;
    // AUDIT-FIX ME-C03: 加仓路径也需要动态 MMR (与新开仓路径 L6029-6032 保持一致)
    // 旧代码缺少 mmr 参数，使用默认 200n，高杠杆时强平价格计算错误
    const baseMmr = 200n;
    const initialMarginRateBp = (10000n * 10000n) / leverage;
    const maxMmr = initialMarginRateBp / 2n;
    const effectiveMmr = baseMmr < maxMmr ? baseMmr : maxMmr;
    const newLiquidationPrice = calculateLiquidationPrice(newEntryPrice, leverage, isLong, effectiveMmr);

    const updatedPosition = {
      ...existing,
      size: newSize.toString(),
      entryPrice: newEntryPrice.toString(),
      collateral: newCollateral.toString(),
      liquidationPrice: newLiquidationPrice.toString(),
      marginRatio: ((newCollateral * 10000n) / newSize).toString(),
      orderIds: [...(existing.orderIds || []), orderId],
      updatedAt: Date.now(),
    };
    positions[existingIndex] = updatedPosition;
    userPositions.set(normalizedTrader, positions);

    // ★ 同步持久化加仓后的仓位到 Redis + PG
    if (existing.pairId) {
      try {
        await savePositionToRedis(updatedPosition);
      } catch (err) {
        console.error("[Position] CRITICAL: Failed to persist merged position:", err);
      }
    }

    console.log(`[Position] ${isLong ? "Long" : "Short"} increased: ${trader.slice(0, 10)} size=${newSize} liq=${newLiquidationPrice}`);

    // ✅ PerpVault: 加仓也需要增加 OI (只增加本次新增的部分)
    if (isPerpVaultEnabled()) {
      const addedSizeETH = size; // size 已经是 ETH 名义价值 (1e18)
      vaultIncreaseOI(normalizedToken, isLong, addedSizeETH).catch(err =>
        console.error(`[PerpVault] increaseOI failed (merge): ${err}`)
      );
    }

    // ✅ 广播仓位更新到前端
    broadcastPositionUpdate(normalizedTrader, normalizedToken);
  } else {
    // 新开仓位 - 同步持久化到 Redis + PG
    await addPositionToUser(position);
    console.log(`[Position] ${isLong ? "Long" : "Short"} opened: ${trader.slice(0, 10)} size=${size} liq=${liquidationPrice}`);

    // ✅ PerpVault: 新仓位增加 OI
    if (isPerpVaultEnabled()) {
      const sizeETH = size; // size 已经是 ETH 名义价值 (1e18)
      vaultIncreaseOI(normalizedToken, isLong, sizeETH).catch(err =>
        console.error(`[PerpVault] increaseOI failed (new): ${err}`)
      );
    }

    // ✅ 广播仓位更新到前端
    broadcastPositionUpdate(normalizedTrader, normalizedToken);
  }
}

/**
 * 平仓匹配: reduce-only 订单成交时调用，关闭或减少现有仓位
 * 计算 PnL 并退还剩余保证金
 */
async function closePositionByMatch(
  trader: Address,
  token: Address,
  closingSide: boolean, // true = 关闭多头, false = 关闭空头
  closeSize: bigint,
  closePrice: bigint,
  orderId: string
): void {
  const normalizedTrader = trader.toLowerCase() as Address;
  const normalizedToken = token.toLowerCase() as Address;

  // ★ 并发锁: 与强平/TP/SL/funding 共享 position:${trader} 锁
  // 防止同一仓位被多个路径同时关闭导致双倍记账
  await withLock(`position:${normalizedTrader}`, 10000, async () => {

  const positions = userPositions.get(normalizedTrader) || [];

  const posIdx = positions.findIndex(
    (p) => p.token.toLowerCase() === normalizedToken && p.isLong === closingSide && BigInt(p.size) > 0n
  );

  if (posIdx < 0) {
    console.error(`[CloseByMatch] No ${closingSide ? 'LONG' : 'SHORT'} position to close for ${normalizedTrader.slice(0, 10)}`);
    return;
  }

  const pos = positions[posIdx];
  const posSize = BigInt(pos.size);
  const entryPrice = BigInt(pos.entryPrice);
  const collateral = BigInt(pos.collateral);

  // ★ 快照平仓前余额 (用于 Bill balanceBefore)
  const balanceBefore = computeSettlementBalance(normalizedTrader);

  // PnL 计算 (GMX 标准)
  let pnl = closingSide // isLong
    ? (closeSize * (closePrice - entryPrice)) / entryPrice
    : (closeSize * (entryPrice - closePrice)) / entryPrice;

  // ★ LP Max Profit Cap: 单笔盈利不超过 LP 池价值的 9%
  // 防止协调攻击掏空 LP 池 (参考 gTrade 1% cap, 我们用 9% 因为 Meme 波动大)
  if (pnl > 0n) {
    try {
      const poolStats = await getPoolStats();
      const poolValue = BigInt(poolStats.totalValue);
      if (poolValue > 0n) {
        const MAX_PROFIT_RATE = TRADING.MAX_PROFIT_RATE;
        const maxProfit = (poolValue * MAX_PROFIT_RATE) / 10000n;
        if (pnl > maxProfit) {
          console.warn(`[ProfitCap] Trader ${normalizedTrader.slice(0, 10)} profit ${Number(pnl) / 1e18} BNB capped to ${Number(maxProfit) / 1e18} BNB (9% of pool ${Number(poolValue) / 1e18})`);
          pnl = maxProfit;
        }
      }
    } catch (e) {
      // 获取池子状态失败不阻塞平仓，但记录警告
      console.warn(`[ProfitCap] Failed to check pool stats, skipping cap:`, e);
    }
  }

  // 平仓手续费 (Taker 费率 — 市价平仓)
  const closeFee = (closeSize * TRADING.TAKER_FEE_RATE) / 10000n;

  // 判断平仓类型 (从 orderId 推断)
  const closeType: string = orderId.startsWith("adl-") ? "adl"
    : orderId.startsWith("liq-") ? "liquidation" : "close";

  if (closeSize >= posSize) {
    // 全部平仓
    const returnAmount = collateral + pnl - closeFee;
    if (returnAmount > 0n) {
      adjustUserBalance(normalizedTrader, returnAmount, "CLOSE_POSITION");
    }
    addMode2Adjustment(normalizedTrader, pnl - closeFee, "CLOSE_PNL");

    // 解锁已用保证金
    const traderBalance = userBalances.get(normalizedTrader);
    if (traderBalance) {
      traderBalance.usedMargin = (traderBalance.usedMargin || 0n) - collateral;
      if (traderBalance.usedMargin < 0n) traderBalance.usedMargin = 0n;
    }

    positions.splice(posIdx, 1);
    userPositions.set(normalizedTrader, positions);
    try {
      await deletePositionFromRedis(pos.pairId, "CLOSED", normalizedTrader, {
        closePrice: closePrice.toString(),
        closingPnl: pnl.toString(),
        closeFee: closeFee.toString(),
      });
    } catch (e) {
      console.error("[Position] CRITICAL: Failed to delete closed position from Redis:", e);
    }
    tpslOrders.delete(pos.pairId);

    console.log(`[CloseByMatch] Fully closed ${closingSide ? 'LONG' : 'SHORT'}: ${normalizedTrader.slice(0, 10)} PnL=$${Number(pnl) / 1e18}, fee=$${Number(closeFee) / 1e18}`);
  } else {
    // 部分平仓
    const ratio = (closeSize * 10000n) / posSize;
    const releasedCollateral = (collateral * ratio) / 10000n;
    const returnAmount = releasedCollateral + pnl - closeFee;
    if (returnAmount > 0n) {
      adjustUserBalance(normalizedTrader, returnAmount, "PARTIAL_CLOSE");
    }
    addMode2Adjustment(normalizedTrader, pnl - closeFee, "PARTIAL_CLOSE_PNL");

    // 部分解锁已用保证金
    const traderBalance = userBalances.get(normalizedTrader);
    if (traderBalance) {
      traderBalance.usedMargin = (traderBalance.usedMargin || 0n) - releasedCollateral;
      if (traderBalance.usedMargin < 0n) traderBalance.usedMargin = 0n;
    }

    const newSize = posSize - closeSize;
    const newCollateral = collateral - releasedCollateral;
    positions[posIdx] = {
      ...pos,
      size: newSize.toString(),
      collateral: newCollateral.toString(),
      margin: newCollateral.toString(),
      updatedAt: Date.now(),
    };
    userPositions.set(normalizedTrader, positions);
    try {
      await savePositionToRedis(positions[posIdx]);
    } catch (e) {
      console.error("[Position] CRITICAL: Failed to persist partial close:", e);
    }

    console.log(`[CloseByMatch] Partially closed ${closingSide ? 'LONG' : 'SHORT'}: ${normalizedTrader.slice(0, 10)} closed=${closeSize}, remaining=${newSize}`);
  }

  // ════════════════════════════════════════════════════════════
  // ★ FIX: 写 Trade 记录 (平仓/ADL/强平都经过此函数，之前遗漏)
  // ════════════════════════════════════════════════════════════
  const closeTradeRecord: TradeRecord = {
    id: `close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    orderId,
    pairId: pos.pairId,
    token: normalizedToken as string,
    trader: normalizedTrader as string,
    isLong: closingSide,
    isMaker: false,
    size: closeSize.toString(),
    price: closePrice.toString(),
    fee: closeFee.toString(),
    realizedPnL: pnl.toString(),
    timestamp: Date.now(),
    type: closeType,
  };
  const traderCloseTrades = userTrades.get(normalizedTrader) || [];
  traderCloseTrades.push(closeTradeRecord);
  userTrades.set(normalizedTrader, traderCloseTrades);
  createTradeWithMirror({
    orderId: closeTradeRecord.orderId,
    pairId: closeTradeRecord.pairId,
    token: normalizedToken,
    trader: normalizedTrader,
    isLong: closeTradeRecord.isLong,
    isMaker: false,
    size: closeTradeRecord.size,
    price: closeTradeRecord.price,
    fee: closeTradeRecord.fee,
    realizedPnL: closeTradeRecord.realizedPnL,
    timestamp: closeTradeRecord.timestamp,
    type: closeType,
  }, `close:${closeType}`);

  // ════════════════════════════════════════════════════════════
  // ★ FIX: 写 Bill (SETTLE_PNL / TRADING_FEE)
  // ════════════════════════════════════════════════════════════
  const balanceAfter = computeSettlementBalance(normalizedTrader);
  const billType = closeType === "adl" ? "SETTLE_PNL"
    : closeType === "liquidation" ? "LIQUIDATION" : "SETTLE_PNL";

  createBillWithMirror({
    userAddress: normalizedTrader,
    type: billType,
    amount: pnl.toString(),
    balanceBefore: balanceBefore.toString(),
    balanceAfter: balanceAfter.toString(),
    onChainStatus: "ENGINE_SETTLED",
    proofData: JSON.stringify({
      token: normalizedToken, pairId: pos.pairId,
      isLong: closingSide, closeType,
      closeSize: closeSize.toString(), closePrice: closePrice.toString(),
      entryPrice: entryPrice.toString(), pnl: pnl.toString(),
    }),
    positionId: pos.pairId, orderId, txHash: null,
  });

  // 手续费单独记 Bill
  if (closeFee > 0n) {
    createBillWithMirror({
      userAddress: normalizedTrader,
      type: "TRADING_FEE" as any,
      amount: (-closeFee).toString(),
      balanceBefore: balanceAfter.toString(),
      balanceAfter: balanceAfter.toString(),
      onChainStatus: "ENGINE_SETTLED",
      proofData: JSON.stringify({
        token: normalizedToken, closeType, feeRate: "0.3%",
      }),
      positionId: pos.pairId, orderId, txHash: null,
    });
  }

  // PerpVault: 减少 OI
  if (isPerpVaultEnabled()) {
    vaultDecreaseOI(normalizedToken, closingSide, closeSize).catch(err =>
      console.error(`[PerpVault] decreaseOI failed (close): ${err}`)
    );

    const marginToRelease = closeSize >= posSize ? collateral : (collateral * ((closeSize * 10000n) / posSize)) / 10000n;
    queueSettleClose(normalizedTrader, pnl - closeFee, marginToRelease, pos.pairId);
  }

  broadcastPositionUpdate(normalizedTrader, normalizedToken);

  // Bill: record close fee as separate audit entry
  if (closeFee > 0n) {
    const traderBal = getUserBalance(normalizedTrader);
    createBillWithMirror({
      userAddress: normalizedTrader, type: "CLOSE_FEE", amount: (-closeFee).toString(),
      balanceBefore: (traderBal.totalBalance + closeFee).toString(),
      balanceAfter: traderBal.totalBalance.toString(),
      positionId: pos.pairId, onChainStatus: "OFF_CHAIN",
    });
  }

  // 扣除平仓手续费 (从 FEE_RECEIVER 收取)
  const feeReceiver = (process.env.FEE_RECEIVER_ADDRESS || "").toLowerCase() as Address;
  if (feeReceiver && closeFee > 0n) {
    addMode2Adjustment(feeReceiver, closeFee, "CLOSE_FEE");
  }

  }, 3, 100); // withLock: position:${trader}
}

// ============================================================
// Helpers
// ============================================================

function jsonResponse(data: object, status = 200): Response {
  // ⚠️ BigInt 值无法直接 JSON.stringify — 需要 replacer 转为字符串
  return new Response(JSON.stringify(data, (_, v) => typeof v === "bigint" ? v.toString() : v), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ success: false, error: message }, status);
}

// ============================================================
// 签名验证已移至 utils/crypto.ts
// ============================================================

// P3-P1: EIP-191 签名验证 — 用于非订单的私有端点 (close, cancel, withdraw, TPSL)
// 与 WS auth 使用同一模式 (handlers.ts L234 handleAuth)
// AUDIT-FIX ME-C02: 必须与 L91 保持一致 — 仅在测试环境下可跳过
const SKIP_SIGNATURE_VERIFY_ENV = process.env.NODE_ENV === "test" && process.env.SKIP_SIGNATURE_VERIFY === "true";

async function verifyTraderSignature(
  trader: string,
  signature: string | undefined,
  expectedMessage: string,
): Promise<{ valid: boolean; error?: string }> {
  if (SKIP_SIGNATURE_VERIFY_ENV) return { valid: true };
  if (!signature) return { valid: false, error: "Missing signature" };
  try {
    const isValid = await verifyMessage({
      address: trader as Address,
      message: expectedMessage,
      signature: signature as Hex,
    });
    if (!isValid) return { valid: false, error: "Invalid signature" };
    return { valid: true };
  } catch (err: any) {
    console.error(`[Auth] Signature verification error for ${trader}: ${err?.message || err?.code || String(err)}`);
    return { valid: false, error: "Signature verification failed" };
  }
}

// AUDIT-FIX CR-01: Auth signature verification for withdrawal requests
// Verifies the user signed a "withdraw:{amount}:{nonce}:{deadline}" message
async function verifyAuthSignature(
  trader: Address,
  nonce: bigint,
  deadline: bigint,
  signature: Hex,
): Promise<{ valid: boolean; error?: string }> {
  if (SKIP_SIGNATURE_VERIFY_ENV) return { valid: true };
  // Check deadline hasn't passed
  if (deadline < BigInt(Math.floor(Date.now() / 1000))) {
    return { valid: false, error: "Auth signature expired" };
  }
  const message = `withdraw:${nonce.toString()}:${deadline.toString()}`;
  return verifyTraderSignature(trader as string, signature as string, message);
}

function getUserNonce(trader: Address): bigint {
  // AUDIT-FIX ME-C06: L1 in-memory cache (loaded from Redis on startup)
  return userNonces.get(trader.toLowerCase() as Address) || 0n;
}

async function persistNonce(trader: Address, nonce: bigint): Promise<void> {
  // AUDIT-FIX ME-C06: Write-through to Redis for crash recovery
  const normalized = trader.toLowerCase() as Address;
  userNonces.set(normalized, nonce);
  // Fire-and-forget Redis write (in-memory is source of truth during runtime)
  NonceRepo.set(normalized, nonce).catch((e) => {
    console.error(`[Nonce] Failed to persist nonce for ${normalized.slice(0, 10)}: ${e}`);
  });
}

/** @deprecated Use persistNonce() instead — kept for backward compat */
function incrementUserNonce(trader: Address): void {
  const current = getUserNonce(trader);
  const next = current + 1n;
  const normalized = trader.toLowerCase() as Address;
  userNonces.set(normalized, next);
  // Write-through to Redis
  NonceRepo.set(normalized, next).catch((e) => {
    console.error(`[Nonce] Failed to persist nonce for ${normalized.slice(0, 10)}: ${e}`);
  });
}

// ============================================================
// Reduce-Only Order Validation
// ============================================================

/**
 * Validate a reduce-only order against the trader's existing positions.
 * A reduce-only order must:
 * 1. Have an existing position in the OPPOSITE direction (reduce-only closes positions)
 * 2. Not exceed the current position size
 */
function validateReduceOnlyOrder(
  trader: Address,
  token: Address,
  isLong: boolean,
  size: bigint
): { valid: boolean; reason?: string } {
  const normalizedTrader = trader.toLowerCase() as Address;
  const positions = userPositions.get(normalizedTrader) || [];

  // Find position for this token in the OPPOSITE direction
  // A reduce-only LONG order closes an existing SHORT, and vice versa
  const existingPosition = positions.find(
    (p) =>
      p.token.toLowerCase() === token.toLowerCase() &&
      p.isLong !== isLong &&
      BigInt(p.size) > 0n
  );

  if (!existingPosition) {
    return {
      valid: false,
      reason: "No open position to reduce. Reduce-only orders require an existing position in the opposite direction.",
    };
  }

  const positionSize = BigInt(existingPosition.size);
  if (size > positionSize) {
    return {
      valid: false,
      reason: `Reduce-only size (${size}) exceeds position size (${positionSize}). Maximum reduce size: ${positionSize}`,
    };
  }

  return { valid: true };
}

// ============================================================
// API Handlers
// ============================================================

async function handleOrderSubmit(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const {
      trader,
      token,
      isLong,
      size,
      leverage,
      price,
      deadline,
      nonce,
      orderType,
      signature,
      reduceOnly = false,  // P2: 只减仓标志
      postOnly = false,    // P3: 只挂单模式 (Maker Only)
      timeInForce = "GTC", // P3: 订单有效期 (GTC/IOC/FOK/GTD)
      takeProfit = null,   // P2-2: 止盈价 (ETH string or null)
      stopLoss = null,     // P2-2: 止损价 (ETH string or null)
    } = body;

    // Validate required fields
    if (!trader || !token || !signature) {
      return errorResponse("Missing required fields");
    }

    // Parse bigint values
    const sizeBigInt = BigInt(size);
    const leverageBigInt = BigInt(leverage);
    const priceBigInt = BigInt(price);
    const deadlineBigInt = BigInt(deadline);
    const nonceBigInt = BigInt(nonce);

    // Check deadline (P2-5)
    if (deadlineBigInt < BigInt(Math.floor(Date.now() / 1000))) {
      return errorResponse("Order expired");
    }

    // ============================================================
    // P2-4: 仓位大小限制检查
    // ============================================================
    if (sizeBigInt > TRADING.MAX_POSITION_SIZE) {
      return errorResponse(`Position too large. Maximum: ${Number(TRADING.MAX_POSITION_SIZE / PRECISION_MULTIPLIER.ETH)} BNB`);
    }
    if (sizeBigInt < TRADING.MIN_POSITION_SIZE) {
      return errorResponse(`Position too small. Minimum: ${Number(TRADING.MIN_POSITION_SIZE * 1000n / PRECISION_MULTIPLIER.ETH) / 1000} BNB`);
    }

    // ============================================================
    // AUDIT-FIX H-07: Validate leverage against phase-specific MAX_LEVERAGE
    // 内盘阶段 2.5x, 毕业后 5x — 由 lifecycle getTokenParameters() 决定
    // ============================================================
    const phaseParams = getTokenParameters(token.toLowerCase() as Address);
    let maxLevForToken = phaseParams.maxLeverage;

    // ★ ADL WARNING 级别: 覆盖比率 150-200% 时限杠杆至 2x
    const adlState = adlRatioState.get(token.toLowerCase() as Address);
    if (adlState && adlState.level === "WARNING") {
      const warningMaxLev = 20000n; // 2x = 20000 (1e4 精度)
      if (maxLevForToken > warningMaxLev) maxLevForToken = warningMaxLev;
    }

    if (leverageBigInt < TRADING.MIN_LEVERAGE || leverageBigInt > maxLevForToken) {
      return errorResponse(`Invalid leverage: must be between ${Number(TRADING.MIN_LEVERAGE) / 10000}x and ${Number(maxLevForToken) / 10000}x`);
    }

    // ============================================================
    // 经济模型 V2: 合约激活检查 + 单账户持仓 token 数限制
    // ============================================================
    if (!reduceOnly) {
      const normalizedTokenCheck = (token as string).toLowerCase() as Address;
      const normalizedTraderCheck = (trader as string).toLowerCase() as Address;

      // 检查 token 是否允许合约交易
      const tokenState = getTokenState(normalizedTokenCheck);
      if (!isTradingEnabled(normalizedTokenCheck)) {
        return errorResponse(`Token not activated for perp trading (state: ${tokenState})`);
      }

      // 单账户最多持仓 5 个不同 token
      const traderPositions = userPositions.get(normalizedTraderCheck) || [];
      const uniqueTokens = new Set(traderPositions.map((p: any) => (p.token || p.tokenAddress || "").toLowerCase()));
      if (!uniqueTokens.has(normalizedTokenCheck) && uniqueTokens.size >= TRADING.MAX_TOKENS_PER_ACCOUNT) {
        return errorResponse(`Maximum ${TRADING.MAX_TOKENS_PER_ACCOUNT} tokens per account. Close a position first.`);
      }

      // ════════════════════════════════════════════════════════════
      // ★ OI Circuit Breaker Pre-check (engine-side, no RPC call)
      // Rejects new positions when OI exceeds pool capacity.
      // Reduce-only orders always pass (closing reduces risk).
      // ════════════════════════════════════════════════════════════
      if (isPerpVaultEnabled()) {
        const oiCheck = await canOpenPosition(normalizedTokenCheck, sizeBigInt);
        if (!oiCheck.allowed) {
          return errorResponse(`Position rejected: ${oiCheck.reason}`);
        }
      }
    }

    // ============================================================
    // P2: Reduce-Only 订单验证
    // ============================================================
    if (reduceOnly) {
      const validation = validateReduceOnlyOrder(
        trader as Address,
        token as Address,
        isLong,
        sizeBigInt
      );

      if (!validation.valid) {
        return errorResponse(validation.reason || "Reduce-only validation failed");
      }
    }

    // P3-P2: Nonce check moved INSIDE withLock for atomicity (see below ~L6380)
    // Old check was here (outside lock) — allowed concurrent nonce reuse

    // Verify signature (可通过 SKIP_SIGNATURE_VERIFY=true 跳过，仅用于测试)
    if (!SKIP_SIGNATURE_VERIFY) {
      const isValid = await verifyOrderSignature(
        trader as Address,
        token as Address,
        isLong,
        sizeBigInt,
        leverageBigInt,
        priceBigInt,
        deadlineBigInt,
        nonceBigInt,
        orderType,
        signature as Hex
      );

      if (!isValid) {
        return errorResponse("Invalid signature");
      }
    } else {
      console.log(`[API] Skipping signature verification (TEST MODE)`);
    }

    // ============================================================
    // P3: 解析 timeInForce
    // ============================================================
    let tif: TimeInForce;
    switch (timeInForce.toUpperCase()) {
      case "IOC":
        tif = TimeInForce.IOC;
        break;
      case "FOK":
        tif = TimeInForce.FOK;
        break;
      case "GTD":
        tif = TimeInForce.GTD;
        break;
      default:
        tif = TimeInForce.GTC;
    }

    // ============================================================
    // P3: Post-Only 和市价单冲突检查
    // ============================================================
    if (postOnly && (orderType === OrderType.MARKET || priceBigInt === 0n)) {
      return errorResponse("Post-Only orders cannot be market orders");
    }

    // ============================================================
    // Price staleness check (GMX Oracle.sol maxPriceAge pattern)
    // Reject ALL orders when price data is stale — prevents trading
    // on outdated prices when RPC is down or syncSpotPrices fails.
    // ============================================================
    if (!reduceOnly && isPriceStale(token as Address)) {
      const lastUpdate = priceLastUpdatedAt.get((token as string).toLowerCase());
      const ageMs = lastUpdate ? Date.now() - lastUpdate : Infinity;
      return errorResponse(`Price data stale for this token (age: ${Math.round(ageMs / 1000)}s, max: ${TRADING.MAX_PRICE_AGE_MS / 1000}s). Trading paused until price feed recovers.`);
    }

    // ============================================================
    // P3: 价格带保护 — 限价单价格不能偏离 Spot Price ±50%
    // 防止恶意挂单（流动性差的 Meme 币场景尤为重要）
    // ============================================================
    if (orderType === OrderType.LIMIT && priceBigInt > 0n) {
      const spotPrice = engine.getSpotPrice(token as Address);
      if (spotPrice > 0n) {
        const maxDeviation = (spotPrice * TRADING.PRICE_BAND_BPS) / 10000n;
        const upperBound = spotPrice + maxDeviation;
        const lowerBound = spotPrice > maxDeviation ? spotPrice - maxDeviation : 0n;
        if (priceBigInt > upperBound || priceBigInt < lowerBound) {
          return errorResponse(`Limit price deviates more than 50% from spot price. Spot: ${spotPrice}, Your price: ${priceBigInt}`);
        }
      }
    }

    // ============================================================
    // 扣除保证金 + 手续费 (下单时立即扣除)
    // ============================================================
    // 对于市价单，使用当前价格计算并加 2% 缓冲（防止价格波动导致保证金不足）
    // ✅ 修复：size 现在是 ETH 名义价值，不再需要 price 计算保证金
    // 但仍需要 price 用于撮合和存储订单
    const orderBook = engine.getOrderBook(token as Address);
    let priceForCalc = priceBigInt > 0n ? priceBigInt : orderBook.getCurrentPrice();

    // 如果订单簿没有价格，尝试从现货价格获取
    if (priceForCalc === 0n) {
      try {
        const spotPrice = await engine.fetchSpotPrice(token as Address);
        if (spotPrice && spotPrice > 0n) {
          priceForCalc = spotPrice;
          console.log(`[API] Using spot price for margin calculation: ${spotPrice}`);
        }
      } catch (e) {
        console.warn("[API] Failed to fetch spot price:", e);
      }
    }

    if (priceForCalc === 0n) {
      return errorResponse("Cannot determine order price for margin calculation. No price data available.");
    }

    // ============================================================
    // 价格带验证 (参考 dYdX v4 fillable price / Hyperliquid price band)
    // 限价单价格不能偏离当前标记价格超过 MAX_PRICE_DEVIATION_PCT
    // 防止因客户端 bug 提交精度错误的价格 (如 1e28 vs 1e10)
    // ============================================================
    if (priceBigInt > 0n) {
      const markPrice = orderBook.getCurrentPrice();
      if (markPrice > 0n) {
        const deviation = priceBigInt > markPrice
          ? ((priceBigInt - markPrice) * 100n) / markPrice
          : ((markPrice - priceBigInt) * 100n) / priceBigInt;

        if (deviation > 100n) { // > 100% deviation → reject
          return errorResponse(
            `Order price deviates ${deviation}% from mark price (max 100%). ` +
            `Order: ${priceBigInt}, Mark: ${markPrice}. Check price precision.`
          );
        }
      }
    }

    // ============================================================
    // 余额检查 + 内部扣款 (加锁防竞争)
    // ============================================================
    //
    // 新架构: 检查派生钱包 BNB 余额是否足够
    //   1. autoDepositIfNeeded: 读链上 getBalance() 检查余额
    //   2. deductOrderAmount: 内存记账 (防连续下单双花)
    //
    // ★ 分布式锁: 防止同一用户并发下单导致双花
    //
    const { total: requiredAmount } = calculateOrderCost(sizeBigInt, priceForCalc, leverageBigInt);
    const normalizedTraderForLock = (trader as string).toLowerCase();

    // 生成临时订单ID (在锁外生成，确保时间戳唯一)
    const traderSuffix = (trader as string).slice(-2).toUpperCase();
    const now = new Date();
    const tempOrderId = `${traderSuffix}${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,"0")}${now.getDate().toString().padStart(2,"0")}${now.getHours().toString().padStart(2,"0")}${now.getMinutes().toString().padStart(2,"0")}${now.getSeconds().toString().padStart(2,"0")}TMP`;

    // 使用分布式锁保护 autoDeposit + deduct 原子操作
    // TTL 30秒 (足够完成链上交易)，失败重试3次
    let depositAndDeductResult: { success: boolean; error?: string };
    try {
      depositAndDeductResult = await withLock(
        `balance:${normalizedTraderForLock}`,
        30000,
        async () => {
          // P3-P2: Nonce 严格校验 (在锁内原子执行，防并发重放)
          const expectedNonce = getUserNonce(trader);
          if (nonceBigInt !== expectedNonce) {
            return { success: false, error: `Invalid nonce. Expected ${expectedNonce}, got ${nonceBigInt}` };
          }

          // 1. 检查派生钱包余额是否足够
          try {
            await autoDepositIfNeeded(trader as Address, requiredAmount);
          } catch (e: any) {
            console.error(`[API] Balance check failed for ${(trader as string).slice(0, 10)}: ${e.message}`);
            return { success: false, error: e.message };
          }

          // 2. 内部账本扣款
          const deductSuccess = await deductOrderAmount(
            trader as Address,
            tempOrderId,
            sizeBigInt,
            priceForCalc,
            leverageBigInt
          );

          if (!deductSuccess) {
            return { success: false, error: "余额不足，请确保派生钱包有足够的 BNB" };
          }

          // P3-P2: Nonce increment inside lock — atomic with balance deduction
          // AUDIT-FIX ME-C06: Write-through to Redis for persistence
          await persistNonce(trader as Address, nonceBigInt + 1n);

          return { success: true };
        },
        3,
        200
      );
    } catch (lockError: any) {
      console.error(`[API] Lock acquisition failed for ${(trader as string).slice(0, 10)}: ${lockError.message}`);
      return errorResponse("系统繁忙，请稍后重试");
    }

    if (!depositAndDeductResult.success) {
      return errorResponse(depositAndDeductResult.error || "保证金处理失败");
    }

    // Submit to matching engine with P3 options
    const { order, matches, rejected, rejectReason } = engine.submitOrder(
      trader as Address,
      token as Address,
      isLong,
      sizeBigInt,
      leverageBigInt,
      priceBigInt,
      deadlineBigInt,
      nonceBigInt,
      orderType as OrderType,
      signature as Hex,
      {
        reduceOnly,
        postOnly,
        timeInForce: tif,
      }
    );

    // ============================================================
    // P3: 处理被拒绝的订单
    // ============================================================
    if (rejected) {
      // 订单被拒绝，退还保证金和手续费
      refundOrderAmount(trader as Address, tempOrderId);
      console.log(`[API] Order rejected: ${rejectReason}`);
      return jsonResponse({
        success: false,
        orderId: order.id,
        status: order.status,
        rejected: true,
        rejectReason,
      });
    }

    // 将保证金信息从临时ID转移到实际订单ID
    const marginInfo = orderMarginInfos.get(tempOrderId);
    if (marginInfo) {
      orderMarginInfos.delete(tempOrderId);
      orderMarginInfos.set(order.id, marginInfo);
    }

    // 市价单没有对手方时保持 PENDING 状态，加入订单簿，让用户在"当前委托"中看到
    // 用户可以自己决定是否撤销，撤销时会退还保证金

    // AUDIT-FIX ME-C14: Nonce update 已在 withLock 内 (L6437) 原子执行
    // 删除此处锁外的冗余更新 — 它会与锁内更新竞争，可能导致 nonce 跳跃或重放
    // （之前是 "belt-and-suspenders" 但实际上是 race condition 源头）

    console.log(`[API] Order submitted: ${order.id} (${matches.length} matches, postOnly=${postOnly}, timeInForce=${tif})`);

    // ============================================================
    // 💾 保存订单到数据库 (Redis)
    // ============================================================
    try {
      // 生成交易对符号 (格式: TOKEN-ETH)
      const tokenSymbol = token.slice(0, 10).toUpperCase(); // 简化处理
      const symbol = `${tokenSymbol}-ETH`;

      // 映射 OrderType 枚举到字符串
      let orderTypeStr: "LIMIT" | "MARKET" | "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP";
      switch (order.orderType) {
        case OrderType.MARKET:
          orderTypeStr = "MARKET";
          break;
        case OrderType.LIMIT:
          orderTypeStr = "LIMIT";
          break;
        default:
          orderTypeStr = "LIMIT";
      }

      // 映射 OrderStatus 枚举到数据库格式
      let statusStr: "PENDING" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "TRIGGERED";
      switch (order.status) {
        case OrderStatus.PENDING:
          statusStr = "PENDING";
          break;
        case OrderStatus.PARTIALLY_FILLED:
          statusStr = "PARTIALLY_FILLED";
          break;
        case OrderStatus.FILLED:
          statusStr = "FILLED";
          break;
        case OrderStatus.CANCELLED:
          statusStr = "CANCELED";
          break;
        default:
          statusStr = "PENDING";
      }

      await OrderRepo.create({
        id: order.id,
        userAddress: order.trader,
        symbol,
        token: order.token,
        orderType: orderTypeStr,
        side: order.isLong ? "LONG" : "SHORT",
        price: order.price.toString(),
        size: order.size.toString(),
        filledSize: order.filledSize.toString(),
        avgFillPrice: order.avgFillPrice.toString(),
        status: statusStr,
        reduceOnly: order.reduceOnly,
        postOnly: order.postOnly,
        triggerPrice: order.takeProfitPrice?.toString() || order.stopLossPrice?.toString() || null,
        leverage: Number(order.leverage) / 10000, // 转换回实际倍数 (如 50000 -> 5x)
        margin: order.margin.toString(),
        fee: order.fee.toString(),
        signature: order.signature,
        deadline: Number(order.deadline),
        nonce: order.nonce.toString(),
      });
      console.log(`[DB] ✅ Order saved to database: ${order.id}`);

      // P1-5: 异步镜像到 PostgreSQL (不阻塞)
      if (isPostgresConnected()) {
        pgMirrorWrite(OrderMirrorRepo.upsert({
          id: order.id,
          trader: order.trader,
          token: order.token,
          symbol: `${(token as string).slice(0, 10).toUpperCase()}-ETH`,
          is_long: order.isLong,
          size: order.size.toString(),
          price: order.price.toString(),
          leverage: Number(order.leverage) / 10000,
          margin: order.margin.toString(),
          fee: order.fee.toString(),
          order_type: orderTypeStr,
          side: order.isLong ? "LONG" : "SHORT",
          status: statusStr,
          filled_size: order.filledSize.toString(),
          avg_fill_price: order.avgFillPrice.toString(),
          reduce_only: order.reduceOnly,
          post_only: order.postOnly,
          trigger_price: order.takeProfitPrice?.toString() || order.stopLossPrice?.toString() || null,
          signature: order.signature,
          deadline: Number(order.deadline),
          nonce: order.nonce.toString(),
          created_at: order.createdAt,
          updated_at: order.updatedAt,
        }), `Order:${order.id.slice(0, 8)}`);
      }
    } catch (dbError) {
      console.error(`[DB] ❌ Failed to save order ${order.id}:`, dbError);
      // 不阻塞订单提交，继续执行
    }

    // Broadcast orderbook update via WebSocket
    broadcastOrderBook(token.toLowerCase() as Address);

    // 推送订单状态更新给交易者
    broadcastOrderUpdate(order);

    // ============================================================
    // 🔄 模式 2: 链下执行，仓位只存后端
    // - 不再实时上链结算
    // - 仓位存 Redis，定时快照上链 Merkle Root
    // - 提现时验证 Merkle 证明
    // ============================================================
    if (matches.length > 0) {
      // 从引擎中移除已匹配的订单
      engine.removePendingMatches(matches);

      // 记录匹配 (用于后续快照)
      for (const match of matches) {
        const matchId = `${match.longOrder.id}_${match.shortOrder.id}`;
        submittedMatches.set(matchId, match);
      }

      console.log(`[Match] ✅ ${matches.length} matches processed (off-chain mode)`);
    }

    // Broadcast trades via WebSocket and create positions (只有链上结算成功后才执行)
    for (const match of matches) {
      // LP fill 检测: LP 侧不创建仓位/不结算保证金
      const lpAddr = PERP_VAULT_ADDRESS_LOCAL?.toLowerCase();
      const longIsLP = lpAddr ? match.longOrder.trader.toLowerCase() === lpAddr : false;
      const shortIsLP = lpAddr ? match.shortOrder.trader.toLowerCase() === lpAddr : false;

      const trade: Trade = {
        id: `trade_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        token: token as Address,
        price: match.matchPrice,
        size: match.matchSize,
        side: order.isLong ? "buy" : "sell",
        timestamp: match.timestamp,
        longTrader: match.longOrder.trader,
        shortTrader: match.shortOrder.trader,
      };
      broadcastTrade(trade);

      // 创建/更新持仓记录 (关联订单号便于排查)
      // ★ 同步 await 确保仓位持久化后再继续
      // LP 侧不创建仓位 (LP 是无状态对手方，风险通过 OI 追踪)
      if (!longIsLP) {
        if (match.longOrder.reduceOnly) {
          await closePositionByMatch(
            match.longOrder.trader, token as Address, false,
            match.matchSize, match.matchPrice, match.longOrder.id
          );
        } else {
          await createOrUpdatePosition(
            match.longOrder.trader,
            token as Address,
            true,
            match.matchSize,
            match.matchPrice,
            match.longOrder.leverage,
            match.shortOrder.trader,
            match.longOrder.id
          );
        }
      }
      if (!shortIsLP) {
        if (match.shortOrder.reduceOnly) {
          await closePositionByMatch(
            match.shortOrder.trader, token as Address, true,
            match.matchSize, match.matchPrice, match.shortOrder.id
          );
        } else {
          await createOrUpdatePosition(
            match.shortOrder.trader,
            token as Address,
            false,
            match.matchSize,
            match.matchPrice,
            match.shortOrder.leverage,
            match.longOrder.trader,
            match.shortOrder.id
          );
        }
      }

      // ============================================================
      // 成交后结算保证金 (LP 侧跳过)
      // ============================================================
      const longIsMakerSettle = match.longOrder.createdAt < match.shortOrder.createdAt;
      if (!longIsLP) {
        settleOrderMargin(match.longOrder.trader, match.longOrder.id, match.matchSize, longIsMakerSettle);
      }
      if (!shortIsLP) {
        settleOrderMargin(match.shortOrder.trader, match.shortOrder.id, match.matchSize, !longIsMakerSettle);
      }

      // ============================================================
      // P5: 处理推荐返佣 + Maker/Taker 差异费率 (LP 侧跳过)
      // ============================================================
      const tradeValue = match.matchSize;
      const longIsMaker = match.longOrder.createdAt < match.shortOrder.createdAt;
      if (match.isLpFill) {
        // LP fill: trader 方收 taker 费率，LP 侧不收费
        const traderFee = (tradeValue * TRADING.TAKER_FEE_RATE) / 10000n;
        const realTrader = longIsLP ? match.shortOrder.trader : match.longOrder.trader;
        processTradeCommission(realTrader, trade.id, traderFee, tradeValue);
        // LP 手续费收入 (80% 归 LP 池)
        const lpFeeIncome = (traderFee * 80n) / 100n;
        vaultCollectFee(lpFeeIncome).catch(err =>
          console.error(`[PerpVault] collectTradingFee failed (LP fill): ${err}`)
        );
      } else {
        // P2P: 双边都结算
        const longFeeRate = longIsMaker ? TRADING.MAKER_FEE_RATE : TRADING.TAKER_FEE_RATE;
        const shortFeeRate = longIsMaker ? TRADING.TAKER_FEE_RATE : TRADING.MAKER_FEE_RATE;
        const longFee = (tradeValue * longFeeRate) / 10000n;
        const shortFee = (tradeValue * shortFeeRate) / 10000n;
        processTradeCommission(match.longOrder.trader, trade.id, longFee, tradeValue);
        processTradeCommission(match.shortOrder.trader, trade.id, shortFee, tradeValue);
      }

      // ============================================================
      // 保存用户成交记录 (LP 侧跳过)
      // ============================================================
      const pairId = `pair_${trade.id}`;
      const lpFillLongIsMaker = match.isLpFill ? false : longIsMaker;
      const lpFillLongFeeRate = match.isLpFill ? TRADING.TAKER_FEE_RATE : (longIsMaker ? TRADING.MAKER_FEE_RATE : TRADING.TAKER_FEE_RATE);
      const lpFillShortFeeRate = match.isLpFill ? TRADING.TAKER_FEE_RATE : (longIsMaker ? TRADING.TAKER_FEE_RATE : TRADING.MAKER_FEE_RATE);
      const saveTradeRecord = (trader: Address, orderId: string, isLong: boolean, isMaker: boolean, fee: bigint) => {
        const record: TradeRecord = {
          id: `${trade.id}_${isLong ? "long" : "short"}`,
          orderId,
          pairId,
          token: token as string,
          trader: trader as string,
          isLong,
          isMaker,
          size: match.matchSize.toString(),
          price: match.matchPrice.toString(),
          fee: fee.toString(),
          realizedPnL: "0",
          timestamp: match.timestamp,
          type: "open",
        };
        const normalizedTrader = trader.toLowerCase() as Address;
        const traderTrades = userTrades.get(normalizedTrader) || [];
        traderTrades.push(record);
        userTrades.set(normalizedTrader, traderTrades);
        // Save to Redis + PG mirror (fire-and-forget)
        createTradeWithMirror({
          orderId: record.orderId,
          pairId: record.pairId,
          token: token.toLowerCase() as Address,
          trader: normalizedTrader,
          isLong: record.isLong,
          isMaker: record.isMaker,
          size: record.size,
          price: record.price,
          fee: record.fee,
          realizedPnL: record.realizedPnL,
          timestamp: record.timestamp,
          type: "open",
        }, "open");
      };
      if (!longIsLP) {
        saveTradeRecord(match.longOrder.trader, match.longOrder.id, true, lpFillLongIsMaker,
          (tradeValue * lpFillLongFeeRate) / 10000n);
      }
      if (!shortIsLP) {
        saveTradeRecord(match.shortOrder.trader, match.shortOrder.id, false, !lpFillLongIsMaker,
          (tradeValue * lpFillShortFeeRate) / 10000n);
      }
    }

    // ============================================================
    // LP 兜底填充: P2P 未成交部分由 LP 池吃
    // 优先级: P2P > LP，仅在有剩余时触发
    // ============================================================
    const lpRemainingSize = order.size - order.filledSize;
    if (lpRemainingSize > 0n
      && !order.reduceOnly
      && !order.postOnly
      && isPerpVaultEnabled()
      && PERP_VAULT_ADDRESS_LOCAL
      && isTradingEnabled(token.toLowerCase() as Address)
    ) {
      try {
        const spotPrice = engine.getOrderBook(token as Address).getCurrentPrice();
        if (spotPrice > 0n) {
          // 获取 OI 剩余额度
          const insuranceFundBalance = BigInt(insuranceFund?.balance ?? 0n);
          const coverageRatio = getCoverageRatio(token.toLowerCase() as Address);
          const oiHeadroom = await getAvailableOIHeadroom(
            token.toLowerCase() as Address,
            insuranceFundBalance,
            coverageRatio
          );

          const lpFillSize = lpRemainingSize < oiHeadroom ? lpRemainingSize : oiHeadroom;

          if (lpFillSize > 0n) {
            // 创建虚拟 LP 订单 (LP 取对手方向)
            const lpOrder = createVirtualLPOrder(
              token as Address, !order.isLong, lpFillSize, spotPrice, order.leverage
            );

            const lpMatch: Match = {
              longOrder: order.isLong ? order : lpOrder,
              shortOrder: order.isLong ? lpOrder : order,
              matchPrice: spotPrice,
              matchSize: lpFillSize,
              timestamp: Date.now(),
              isLpFill: true,
            };

            // 更新订单状态
            order.filledSize += lpFillSize;
            if (order.filledSize >= order.size) {
              order.status = OrderStatus.FILLED;
            } else {
              order.status = OrderStatus.PARTIALLY_FILLED;
            }

            // 记录 LP match
            const lpMatchId = `${order.id}_${lpOrder.id}`;
            submittedMatches.set(lpMatchId, lpMatch);

            // 只为真实 trader 创建仓位 (LP 无仓位)
            await createOrUpdatePosition(
              order.trader as Address,
              token as Address,
              order.isLong,
              lpFillSize,
              spotPrice,
              order.leverage,
              PERP_VAULT_ADDRESS_LOCAL as Address,
              order.id
            );

            // OI 追踪: createOrUpdatePosition() 内部已调用 vaultIncreaseOI，此处不重复

            // 结算 trader 保证金 (taker 费率)
            settleOrderMargin(order.trader as Address, order.id, lpFillSize, false);

            // LP 手续费收入
            const LP_TAKER_FEE = 30n;
            const lpTradeFee = (lpFillSize * LP_TAKER_FEE) / 10000n;
            const lpFeeIncome = (lpTradeFee * 80n) / 100n;
            vaultCollectFee(lpFeeIncome).catch(err =>
              console.error(`[PerpVault] collectTradingFee failed (LP fill): ${err}`)
            );

            // 广播成交
            const lpTrade: Trade = {
              id: `trade_lp_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              token: token as Address,
              price: spotPrice,
              size: lpFillSize,
              side: order.isLong ? "buy" : "sell",
              timestamp: Date.now(),
              longTrader: order.isLong ? order.trader : PERP_VAULT_ADDRESS_LOCAL as Address,
              shortTrader: order.isLong ? PERP_VAULT_ADDRESS_LOCAL as Address : order.trader,
            };
            broadcastTrade(lpTrade);

            // 保存成交记录 (只保存 trader 侧)
            const lpTradeRecord: TradeRecord = {
              id: `${lpTrade.id}_${order.isLong ? "long" : "short"}`,
              orderId: order.id,
              pairId: `pair_${lpTrade.id}`,
              token: token as string,
              trader: order.trader as string,
              isLong: order.isLong,
              isMaker: false,
              size: lpFillSize.toString(),
              price: spotPrice.toString(),
              fee: lpTradeFee.toString(),
              realizedPnL: "0",
              timestamp: Date.now(),
              type: "open",
            };
            const normalizedLPTrader = (order.trader as string).toLowerCase() as Address;
            const traderLPTrades = userTrades.get(normalizedLPTrader) || [];
            traderLPTrades.push(lpTradeRecord);
            userTrades.set(normalizedLPTrader, traderLPTrades);
            TradeRepo.create({
              orderId: lpTradeRecord.orderId,
              pairId: lpTradeRecord.pairId,
              token: token.toLowerCase() as Address,
              trader: normalizedLPTrader,
              isLong: lpTradeRecord.isLong,
              isMaker: false,
              size: lpTradeRecord.size,
              price: lpTradeRecord.price,
              fee: lpTradeRecord.fee,
              realizedPnL: "0",
              timestamp: lpTradeRecord.timestamp,
              type: "open",
            }).catch(e => console.error(`[DB] Failed to save LP fill trade record:`, e));

            // 处理 trader 返佣
            processTradeCommission(order.trader as Address, lpTrade.id, lpTradeFee, lpFillSize);

            // ★ FIX: 回写订单到 Redis OrderRepo (否则 order history 显示 EXPIRED)
            order.avgFillPrice = spotPrice;
            order.lastFillPrice = spotPrice;
            order.lastFillSize = lpFillSize;
            order.lastFillTime = Date.now();
            order.fee = lpTradeFee;
            OrderRepo.update(order.id, {
              status: order.status === OrderStatus.FILLED ? "FILLED" : "PARTIALLY_FILLED",
              filledSize: order.filledSize.toString(),
              avgFillPrice: spotPrice.toString(),
              fee: lpTradeFee.toString(),
            }).catch(e => console.error(`[DB] Failed to update order after LP fill:`, e));

            // 广播订单簿和订单状态更新
            broadcastOrderBook(token.toLowerCase() as Address);
            broadcastOrderUpdate(order);

            console.log(
              `[LP Fill] ${order.isLong ? "LONG" : "SHORT"} ${formatEther(lpFillSize)} @ ${formatEther(spotPrice)} ` +
              `(trader=${order.trader.slice(0, 8)} ← LP pool, OI headroom=${formatEther(oiHeadroom)})`
            );
          } else {
            console.log(`[LP Fill] Skipped: OI headroom = 0 for ${(token as string).slice(0, 10)}`);
          }
        }
      } catch (lpErr) {
        console.error(`[LP Fill] Error:`, lpErr);
      }
    }

    // ============================================================
    // P2-2: 自动设置止盈止损 (订单成交后)
    // ============================================================
    if (matches.length > 0 && (takeProfit || stopLoss)) {
      const normalizedTraderTP = (trader as string).toLowerCase() as Address;
      const positions = userPositions.get(normalizedTraderTP);
      if (positions && positions.length > 0) {
        // 找到当前订单创建的最新仓位 (按 orderId 匹配)
        const latestPos = positions.find(p => p.orderId === order.id) || positions[positions.length - 1];
        if (latestPos) {
          const tpPrice = takeProfit ? BigInt(Math.floor(parseFloat(takeProfit) * 1e18)) : null;
          const slPrice = stopLoss ? BigInt(Math.floor(parseFloat(stopLoss) * 1e18)) : null;
          const tpslResult = setTakeProfitStopLoss(latestPos.pairId, tpPrice, slPrice);
          if (tpslResult) {
            console.log(`[P2-2] TP/SL auto-set for ${latestPos.pairId}: TP=${takeProfit || 'none'} SL=${stopLoss || 'none'}`);
          }
        }
      }
    }

    // ============================================================
    // 推送余额更新到前端 (下单扣款后实时通知)
    // ============================================================
    const normalizedTraderAddr = (trader as string).toLowerCase() as Address;
    await syncUserBalanceFromChain(normalizedTraderAddr);
    broadcastBalanceUpdate(normalizedTraderAddr);

    // H-4: 对手方余额也需要刷新 (成交后对手方仓位/保证金已变)
    if (matches.length > 0) {
      const counterparties = new Set<Address>();
      for (const m of matches) {
        const cp = (order.isLong ? m.shortOrder.trader : m.longOrder.trader).toLowerCase() as Address;
        if (cp !== normalizedTraderAddr) {
          counterparties.add(cp);
        }
      }
      for (const cp of counterparties) {
        broadcastBalanceUpdate(cp);
      }
    }

    return jsonResponse({
      success: true,
      orderId: order.id,
      status: order.status,
      filledSize: order.filledSize.toString(),
      matches: matches.map((m) => ({
        matchPrice: m.matchPrice.toString(),
        matchSize: m.matchSize.toString(),
        counterparty: order.isLong ? m.shortOrder.trader : m.longOrder.trader,
      })),
    });
  } catch (e) {
    console.error("[API] Order submit error:", e);
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

async function handleGetNonce(trader: string): Promise<Response> {
  const normalizedTrader = trader.toLowerCase() as Address;

  // 从链上读取 nonce (source of truth)
  if (SETTLEMENT_ADDRESS) {
    try {
      const publicClient = createPublicClient({
        chain: activeChain,
        transport: rpcTransport,
      });
      const chainNonce = await publicClient.readContract({
        address: SETTLEMENT_ADDRESS,
        abi: [{ inputs: [{ name: "", type: "address" }], name: "nonces", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }],
        functionName: "nonces",
        args: [normalizedTrader],
      }) as bigint;

      // 取链上 nonce 和内存 nonce 的较大值
      // (内存 nonce 可能因为刚提交的订单而更高，但链上还没确认)
      const memoryNonce = getUserNonce(normalizedTrader);
      const effectiveNonce = chainNonce > memoryNonce ? chainNonce : memoryNonce;

      // AUDIT-FIX ME-C06: 同步到内存 + Redis
      if (effectiveNonce > memoryNonce) {
        await persistNonce(normalizedTrader, effectiveNonce);
      }

      return jsonResponse({ nonce: effectiveNonce.toString() });
    } catch (e) {
      console.warn(`[Nonce] Failed to read chain nonce for ${normalizedTrader}:`, e);
    }
  }

  // fallback: 内存 nonce
  const nonce = getUserNonce(normalizedTrader);
  return jsonResponse({ nonce: nonce.toString() });
}

async function handleGetOrderBook(token: string): Promise<Response> {
  const orderBook = engine.getOrderBook(token as Address);
  const depth = orderBook.getDepth(20);
  let currentPrice = orderBook.getCurrentPrice();

  // 如果订单簿没有价格，使用现货价格
  if (currentPrice === 0n) {
    try {
      const spotPrice = await engine.fetchSpotPrice(token as Address);
      if (spotPrice && spotPrice > 0n) {
        currentPrice = spotPrice;
      }
    } catch (e) {
      // 忽略错误，使用0
    }
  }

  return jsonResponse({
    longs: depth.longs.map((level) => ({
      price: level.price.toString(),
      size: level.totalSize.toString(),
      count: level.orders.length,
    })),
    shorts: depth.shorts.map((level) => ({
      price: level.price.toString(),
      size: level.totalSize.toString(),
      count: level.orders.length,
    })),
    lastPrice: currentPrice.toString(),
  });
}

// ============================================================
// Authentication Handlers (P2)
// ============================================================

/**
 * Get nonce for wallet login
 * POST /api/v1/auth/nonce
 */
async function handleGetAuthNonce(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { address } = body;

    if (!address || typeof address !== "string") {
      return jsonResponse({
        code: "1",
        msg: "Invalid request: address required",
      });
    }

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return jsonResponse({
        code: "1",
        msg: "Invalid address format",
      });
    }

    const { generateLoginNonce } = await import("./modules/auth");
    const { nonce, message } = await generateLoginNonce(address as Address);

    return jsonResponse({
      code: "0",
      msg: "success",
      data: { nonce, message },
    });
  } catch (error) {
    console.error("[Auth] Get nonce error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Login with wallet signature
 * POST /api/v1/auth/login
 */
async function handleAuthLogin(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { address, signature, nonce } = body;

    if (!address || !signature || !nonce) {
      return jsonResponse({
        code: "1",
        msg: "Invalid request: address, signature, and nonce required",
      });
    }

    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return jsonResponse({
        code: "1",
        msg: "Invalid address format",
      });
    }

    // Validate signature format
    if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) {
      return jsonResponse({
        code: "1",
        msg: "Invalid signature format",
      });
    }

    const { verifySignatureAndLogin } = await import("./modules/auth");
    const credentials = await verifySignatureAndLogin(
      address as Address,
      signature as Hex,
      nonce
    );

    if (!credentials) {
      return jsonResponse({
        code: "1",
        msg: "Authentication failed: invalid signature or expired nonce",
      });
    }

    return jsonResponse({
      code: "0",
      msg: "success",
      data: {
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
        address: credentials.address,
        expiresAt: credentials.expiresAt,
      },
    });
  } catch (error) {
    console.error("[Auth] Login error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

// ============================================================
// Token Metadata Handlers (P2)
// ============================================================

/**
 * Save or update token metadata
 * POST /api/v1/token/metadata
 */
async function handleSaveTokenMetadata(req: Request): Promise<Response> {
  try {
    const body = await req.json();

    const { saveTokenMetadata } = await import("./modules/tokenMetadata");
    const metadata = await saveTokenMetadata(body);

    return jsonResponse({
      code: "0",
      msg: "success",
      data: metadata,
    });
  } catch (error) {
    console.error("[TokenMetadata] Save error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Get token metadata by instId
 * GET /api/v1/token/metadata?instId={instId}
 */
async function handleGetTokenMetadata(instId: string): Promise<Response> {
  try {
    const { getTokenMetadata } = await import("./modules/tokenMetadata");
    const metadata = await getTokenMetadata(instId);

    if (!metadata) {
      return jsonResponse({
        code: "1",
        msg: "Token metadata not found",
      }, 404);
    }

    return jsonResponse({
      code: "0",
      msg: "success",
      data: metadata,
    });
  } catch (error) {
    console.error("[TokenMetadata] Get error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Get all token metadata
 * GET /api/v1/token/metadata/all
 */
async function handleGetAllTokenMetadata(): Promise<Response> {
  try {
    const { getAllTokenMetadata } = await import("./modules/tokenMetadata");
    const metadata = await getAllTokenMetadata();

    return jsonResponse({
      code: "0",
      msg: "success",
      data: metadata,
    });
  } catch (error) {
    console.error("[TokenMetadata] Get all error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

// ============================================================
// FOMO Events & Leaderboard Handlers
// ============================================================

/**
 * Get recent FOMO events
 * GET /api/fomo/events?limit={limit}
 */
async function handleGetFomoEvents(limit: number): Promise<Response> {
  try {
    const { getRecentFomoEvents } = await import("./modules/fomo");
    const events = getRecentFomoEvents(limit);

    // Convert bigint to string for JSON serialization
    const serializedEvents = events.map((event) => ({
      id: event.id,
      type: event.type,
      trader: event.trader,
      token: event.token,
      tokenSymbol: event.tokenSymbol,
      isLong: event.isLong,
      size: event.size.toString(),
      price: event.price.toString(),
      pnl: event.pnl?.toString(),
      leverage: event.leverage?.toString(),
      timestamp: event.timestamp,
      message: event.message,
    }));

    return jsonResponse({
      code: "0",
      msg: "success",
      data: serializedEvents,
    });
  } catch (error) {
    console.error("[FOMO] Get events error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Get global leaderboard
 * GET /api/leaderboard/global?sortBy={pnl|volume|wins}&limit={limit}
 */
async function handleGetGlobalLeaderboard(
  sortBy: "pnl" | "volume" | "wins",
  limit: number
): Promise<Response> {
  try {
    const { getGlobalLeaderboard } = await import("./modules/fomo");
    const entries = getGlobalLeaderboard(sortBy, limit);

    // Convert bigint to string for JSON serialization
    const serializedEntries = entries.map((entry, index) => ({
      trader: entry.trader,
      displayName: entry.displayName || formatTraderAddress(entry.trader),
      totalPnL: entry.totalPnL.toString(),
      totalVolume: entry.totalVolume.toString(),
      tradeCount: entry.tradeCount,
      winRate: entry.winRate,
      biggestWin: entry.biggestWin.toString(),
      biggestLoss: entry.biggestLoss.toString(),
      rank: index + 1,
    }));

    return jsonResponse({
      code: "0",
      msg: "success",
      data: serializedEntries,
    });
  } catch (error) {
    console.error("[FOMO] Get global leaderboard error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Get token-specific leaderboard
 * GET /api/leaderboard/token/{token}?sortBy={pnl|volume|wins}&limit={limit}
 */
async function handleGetTokenLeaderboard(
  token: Address,
  sortBy: "pnl" | "volume" | "wins",
  limit: number
): Promise<Response> {
  try {
    const { getTokenLeaderboard } = await import("./modules/fomo");
    const entries = getTokenLeaderboard(token, sortBy, limit);

    // Convert bigint to string for JSON serialization
    const serializedEntries = entries.map((entry, index) => ({
      trader: entry.trader,
      displayName: entry.displayName || formatTraderAddress(entry.trader),
      totalPnL: entry.totalPnL.toString(),
      totalVolume: entry.totalVolume.toString(),
      tradeCount: entry.tradeCount,
      winRate: entry.winRate,
      biggestWin: entry.biggestWin.toString(),
      biggestLoss: entry.biggestLoss.toString(),
      rank: index + 1,
    }));

    return jsonResponse({
      code: "0",
      msg: "success",
      data: serializedEntries,
    });
  } catch (error) {
    console.error("[FOMO] Get token leaderboard error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Get trader statistics
 * GET /api/trader/{trader}/stats
 */
async function handleGetTraderStats(trader: Address): Promise<Response> {
  try {
    const { getTraderStats } = await import("./modules/fomo");
    const stats = getTraderStats(trader);

    if (!stats) {
      return jsonResponse({
        code: "1",
        msg: "Trader stats not found",
      }, 404);
    }

    // Convert bigint to string for JSON serialization
    const serializedStats = {
      trader: stats.trader,
      displayName: stats.displayName || formatTraderAddress(stats.trader),
      totalPnL: stats.totalPnL.toString(),
      totalVolume: stats.totalVolume.toString(),
      tradeCount: stats.tradeCount,
      winRate: stats.winRate,
      biggestWin: stats.biggestWin.toString(),
      biggestLoss: stats.biggestLoss.toString(),
    };

    return jsonResponse({
      code: "0",
      msg: "success",
      data: serializedStats,
    });
  } catch (error) {
    console.error("[FOMO] Get trader stats error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Helper: Format trader address for display
 */
function formatTraderAddress(address: Address): string {
  return `${address.substring(0, 6)}...${address.substring(38)}`;
}

// ============================================================
// Relay Service Handlers (P2)
// ============================================================

/**
 * Get relay service status
 * GET /api/v1/relay/status
 */
async function handleGetRelayStatus(): Promise<Response> {
  try {
    const { getRelayerStatus } = await import("./modules/relay");
    const status = await getRelayerStatus();

    return jsonResponse({
      code: "0",
      msg: "success",
      data: status,
    });
  } catch (error) {
    console.error("[Relay] Get status error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Get user's meta-tx nonce
 * GET /api/v1/relay/nonce/:address
 */
async function handleGetMetaTxNonce(user: Address): Promise<Response> {
  try {
    const { getMetaTxNonce } = await import("./modules/relay");
    const nonce = await getMetaTxNonce(user);

    return jsonResponse({
      code: "0",
      msg: "success",
      data: {
        user,
        nonce: nonce.toString(),
      },
    });
  } catch (error) {
    console.error("[Relay] Get nonce error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Get user's Settlement balance (Relay API)
 * GET /api/v1/relay/balance/:address
 */
async function handleGetRelayUserBalance(user: Address): Promise<Response> {
  try {
    const { getUserBalance } = await import("./modules/relay");
    const balance = await getUserBalance(user);

    return jsonResponse({
      code: "0",
      msg: "success",
      data: {
        user,
        available: balance.available.toString(),
        reserved: balance.reserved.toString(),
      },
    });
  } catch (error) {
    console.error("[Relay] Get balance error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

/**
 * Relay depositFor on SettlementV2
 * POST /api/v1/relay/deposit
 * Body: { user: Address, amount: string }
 */
async function handleRelayDeposit(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { user, amount } = body;

    if (!user || !amount) {
      return jsonResponse({
        code: "1",
        msg: "Missing required fields: user, amount",
      });
    }

    const { relayDeposit } = await import("./modules/relay");
    const result = await relayDeposit({
      user: user as Address,
      amount,
    });

    if (result.success) {
      return jsonResponse({
        code: "0",
        msg: "success",
        data: { txHash: result.txHash },
      });
    } else {
      return jsonResponse({
        code: "1",
        msg: result.error || "Relay deposit failed",
      });
    }
  } catch (error) {
    console.error("[Relay] Deposit error:", error);
    return jsonResponse({
      code: "1",
      msg: error instanceof Error ? error.message : "Internal server error",
    });
  }
}


// ============================================================
// Market Data Handlers
// ============================================================

/**
 * 获取所有代币的行情数据 (OKX 格式)
 * GET /api/v1/market/tickers
 */
async function handleGetTickers(): Promise<Response> {
  const tickers = [];

  for (const token of SUPPORTED_TOKENS) {
    try {
      const orderBook = engine.getOrderBook(token);
      const depth = orderBook.getDepth(1);
      const currentPrice = orderBook.getCurrentPrice();

      // 获取24h交易数据
      const trades = engine.getRecentTrades(token, 1000);
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const trades24h = trades.filter(t => t.timestamp >= oneDayAgo);

      // 计算24h统计
      let vol24h = 0n;
      let volCcy24h = 0n;
      let high24h = currentPrice;
      let low24h = currentPrice;
      let open24h = currentPrice;

      if (trades24h.length > 0) {
        open24h = trades24h[trades24h.length - 1].price; // oldest trade
        for (const trade of trades24h) {
          vol24h += trade.size;
          volCcy24h += (trade.price * trade.size) / BigInt(1e18);
          if (trade.price > high24h) high24h = trade.price;
          if (trade.price < low24h) low24h = trade.price;
        }
      }

      // 获取最佳买卖价
      const bestBid = depth.longs.length > 0 ? depth.longs[0].price : currentPrice;
      const bestAsk = depth.shorts.length > 0 ? depth.shorts[0].price : currentPrice;
      const bestBidSz = depth.longs.length > 0 ? depth.longs[0].totalSize : 0n;
      const bestAskSz = depth.shorts.length > 0 ? depth.shorts[0].totalSize : 0n;

      tickers.push({
        instId: `${token}-ETH`,
        last: currentPrice.toString(),
        lastSz: "0",
        askPx: bestAsk.toString(),
        askSz: bestAskSz.toString(),
        bidPx: bestBid.toString(),
        bidSz: bestBidSz.toString(),
        open24h: open24h.toString(),
        high24h: high24h.toString(),
        low24h: low24h.toString(),
        volCcy24h: volCcy24h.toString(),
        vol24h: vol24h.toString(),
        ts: now,
      });
    } catch (e) {
      console.error(`[Tickers] Error getting ticker for ${token}:`, e);
    }
  }

  // 返回 OKX 格式的响应
  return new Response(JSON.stringify({
    code: "0",
    msg: "success",
    data: tickers,
  }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleGetTrades(token: string, url: URL): Promise<Response> {
  const limit = parseInt(url.searchParams.get("limit") || "100");

  // 1. Try perpetual engine in-memory trades
  const trades = engine.getRecentTrades(token as Address, limit);
  if (trades.length > 0) {
    return jsonResponse({
      trades: trades.map((t) => ({
        id: t.id,
        token: t.token,
        price: t.price.toString(),
        size: t.size.toString(),
        side: t.side,
        timestamp: t.timestamp,
      })),
    });
  }

  // 2. Fallback: spot trades from Redis (SpotTradeRepo)
  try {
    const { SpotTradeRepo } = await import("../spot/spotHistory");
    const spotTrades = await SpotTradeRepo.getByToken(token.toLowerCase() as Address, limit);
    if (spotTrades.length > 0) {
      return jsonResponse({
        trades: spotTrades.map((t) => ({
          id: t.id,
          token: t.token,
          price: t.price,
          size: (Number(t.tokenAmount) / 1e18).toString(),
          side: t.isBuy ? "buy" : "sell",
          timestamp: t.timestamp,
          ethAmount: t.ethAmount,
          trader: t.trader,
          txHash: t.txHash,
        })),
      });
    }
  } catch (e) {
    console.warn("[Trades] Failed to read spot trades from Redis:", (e as Error).message);
  }

  return jsonResponse({ trades: [] });
}

async function handleGetUserOrders(trader: string): Promise<Response> {
  const normalizedTrader = trader.toLowerCase() as Address;
  const orders = engine.getUserOrders(trader as Address);

  // Map engine orders to response format
  const orderList = orders.map((o) => ({
    // === 基本标识 ===
    id: o.id,
    clientOrderId: o.clientOrderId || null,
    token: o.token,

    // === 订单参数 ===
    isLong: o.isLong,
    size: o.size.toString(),
    leverage: o.leverage.toString(),
    price: o.price.toString(),
    orderType: o.orderType === 0 ? "MARKET" : "LIMIT",
    timeInForce: o.timeInForce || "GTC",
    reduceOnly: o.reduceOnly || false,

    // === 成交信息 ===
    status: o.status,
    filledSize: o.filledSize.toString(),
    avgFillPrice: (o.avgFillPrice || 0n).toString(),
    totalFillValue: (o.totalFillValue || 0n).toString(),

    // === 费用信息 ===
    fee: (o.fee || 0n).toString(),
    feeCurrency: o.feeCurrency || "BNB",

    // === 保证金信息 ===
    margin: (o.margin || 0n).toString(),
    collateral: (o.collateral || 0n).toString(),

    // === 止盈止损 ===
    takeProfitPrice: o.takeProfitPrice ? o.takeProfitPrice.toString() : null,
    stopLossPrice: o.stopLossPrice ? o.stopLossPrice.toString() : null,

    // === 时间戳 ===
    createdAt: o.createdAt,
    updatedAt: o.updatedAt || o.createdAt,
    lastFillTime: o.lastFillTime || null,

    // === 来源 ===
    source: o.source || "API",

    // === 最后成交明细 ===
    lastFillPrice: o.lastFillPrice ? o.lastFillPrice.toString() : null,
    lastFillSize: o.lastFillSize ? o.lastFillSize.toString() : null,
    tradeId: o.tradeId || null,
  }));

  // Append liquidation/close events as synthetic orders in order history
  const trades = userTrades.get(normalizedTrader) || [];
  for (const t of trades) {
    if (t.type === "liquidation" || t.type === "adl" || t.type === "close") {
      orderList.push({
        id: t.id,
        clientOrderId: null,
        token: t.token as Address,
        isLong: t.isLong,
        size: t.size,
        leverage: "0",
        price: t.price,
        orderType: "MARKET",
        timeInForce: "GTC",
        reduceOnly: true,
        status: t.type === "liquidation" ? "LIQUIDATED" : t.type === "adl" ? "ADL" : "CLOSED",
        filledSize: t.size,
        avgFillPrice: t.price,
        totalFillValue: "0",
        fee: t.fee,
        feeCurrency: "BNB",
        margin: "0",
        collateral: "0",
        takeProfitPrice: null,
        stopLossPrice: null,
        createdAt: t.timestamp,
        updatedAt: t.timestamp,
        lastFillTime: t.timestamp,
        source: "API",
        lastFillPrice: t.price,
        lastFillSize: t.size,
        tradeId: t.id,
      });
    }
  }

  // Sort by time descending (most recent first)
  orderList.sort((a, b) => b.updatedAt - a.updatedAt);

  return jsonResponse(orderList);
}

async function handleCancelOrder(req: Request, orderId: string): Promise<Response> {
  try {
    const body = await req.json();
    const { trader, signature } = body;

    if (!trader || !signature) {
      return errorResponse("Missing required fields");
    }

    // 先获取订单信息（用于广播更新和退款）
    const order = engine.getOrder(orderId);
    if (!order) {
      return errorResponse("Order not found");
    }

    // ★ 分布式锁: 防止撤单与成交竞争 (使用订单锁而非用户锁)
    const normalizedTrader = (trader as string).toLowerCase();
    let cancelResult: { success: boolean; refundTotal: bigint };
    try {
      cancelResult = await withLock(
        `order:${orderId}`,
        5000,
        async () => {
          // 在锁内重新检查订单状态
          const currentOrder = engine.getOrder(orderId);
          if (!currentOrder || currentOrder.status === OrderStatus.CANCELLED || currentOrder.status === OrderStatus.FILLED) {
            return { success: false, refundTotal: 0n };
          }

          // P3-P1: 验证取消签名 — 前端签名 "Cancel order {orderId}" (usePerpetualV2.ts L601)
          const cancelMessage = `Cancel order ${orderId}`;
          console.log(`[Cancel] orderId=${orderId}, trader=${trader}, orderTrader=${currentOrder.trader}, message="${cancelMessage}"`);
          const cancelAuth = await verifyTraderSignature(trader, signature, cancelMessage);
          if (!cancelAuth.valid) {
            console.log(`[Cancel] Signature verification FAILED: ${cancelAuth.error}`);
            return { success: false, refundTotal: 0n };
          }
          // 验证订单属于该 trader
          if (currentOrder.trader.toLowerCase() !== normalizedTrader) {
            console.log(`[Cancel] Trader mismatch: order=${currentOrder.trader.toLowerCase()} vs request=${normalizedTrader}`);
            return { success: false, refundTotal: 0n };
          }
          const success = engine.cancelOrder(orderId, trader as Address);
          if (!success) {
            return { success: false, refundTotal: 0n };
          }

          // 退款
          const refundTotal = refundOrderAmount(trader as Address, orderId);
          return { success: true, refundTotal };
        },
        3,
        100
      );
    } catch (lockError: any) {
      console.error(`[API] Cancel lock failed for ${orderId}: ${lockError.message}`);
      return errorResponse("系统繁忙，请稍后重试");
    }

    if (!cancelResult.success) {
      return errorResponse("Order not found or cannot be cancelled");
    }

    const refundTotal = cancelResult.refundTotal;

    console.log(`[API] Order cancelled: ${orderId}, refund: $${Number(refundTotal) / 1e18}`);

    // 广播订单簿更新
    broadcastOrderBook(order.token.toLowerCase() as Address);

    // 推送订单状态更新 (设置状态为已取消)
    order.status = OrderStatus.CANCELLED;
    order.updatedAt = Date.now();
    broadcastOrderUpdate(order);

    // 持久化取消状态到 Redis（重启后不会复活已取消的订单）
    OrderRepo.update(orderId, { status: OrderStatus.CANCELLED } as any)
      .catch(e => trackRedisError(`Failed to update cancel status for ${orderId}`, e));

    // P1-5: 镜像到 PostgreSQL
    if (isPostgresConnected()) {
      pgMirrorWrite(OrderMirrorRepo.updateStatus(orderId, "CANCELED"), `OrderCancel:${orderId.slice(0, 10)}`);
    }

    // 链上退款: 从 Settlement 提取保证金回派生钱包（异步，不阻塞响应）
    if (refundTotal > 0n) {
      withdrawFromSettlement(trader as Address, refundTotal)
        .then(() => syncUserBalanceFromChain(trader as Address))
        .then(() => broadcastBalanceUpdate(trader as Address))
        .catch((e) => console.error(`[CancelOrder] Post-cancel settlement withdraw error:`, e));
    }

    return jsonResponse({ success: true });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * Get user's CURRENT positions (real-time state)
 *
 * RESPONSIBILITY: Returns active positions tracked in memory from recent matches.
 * This is the real-time view of open positions.
 *
 * For historical positions (closed, liquidated), use Go Backend:
 * GET /api/v1/account/positions-history
 */
async function handleGetUserPositions(trader: string): Promise<Response> {
  const normalizedTrader = trader.toLowerCase() as Address;
  const positions = userPositions.get(normalizedTrader) || [];
  return jsonResponse(positions);
}

/**
 * 获取用户交易历史 (强平、ADL、平仓等)
 * GET /api/user/:trader/trades
 */
async function handleGetUserTradesHistory(trader: string, limit: number = 100): Promise<Response> {
  const normalizedTrader = trader.toLowerCase() as Address;

  // Try in-memory first, then fall back to Redis
  let trades: TradeRecord[] = userTrades.get(normalizedTrader) || [];

  if (trades.length === 0) {
    try {
      const redisTrades = await TradeRepo.getByUser(normalizedTrader, limit);
      if (redisTrades.length > 0) {
        // Map PerpTrade → TradeRecord format
        trades = redisTrades.map(t => ({
          id: t.id,
          orderId: t.orderId,
          pairId: t.pairId,
          token: t.token as string,
          trader: t.trader as string,
          isLong: t.isLong,
          isMaker: t.isMaker,
          size: t.size,
          price: t.price,
          fee: t.fee,
          realizedPnL: t.realizedPnL,
          timestamp: t.timestamp,
          type: t.type as TradeRecord["type"],
        }));
      }
    } catch (e) {
      console.error("[API] Failed to read trades from Redis:", e);
    }
  }

  // 按时间倒序，最新的在前
  const sortedTrades = [...trades].sort((a, b) => b.timestamp - a.timestamp);
  const limitedTrades = sortedTrades.slice(0, limit);

  return jsonResponse({
    success: true,
    trades: limitedTrades,
    total: trades.length,
  });
}

/**
 * 获取用户余额 (Mode 2: 链上资金托管 + 后端仓位)
 * GET /api/user/:trader/balance
 *
 * 数据来源：
 * - available: 从链上 Settlement 合约读取 (资金托管)
 * - usedMargin: 从后端内存计算 (仓位保证金)
 * - unrealizedPnL: 后端实时计算 (基于当前价格)
 *
 * ⚠️ Mode 2: Settlement.locked 已废弃，仓位保证金从后端内存计算
 */
async function handleGetUserBalance(trader: string): Promise<Response> {
  const normalizedTrader = trader.toLowerCase() as Address;
  console.log(`[Balance API] Queried for trader=${normalizedTrader}, derivedWallet=${traderToDerivedWallet.get(normalizedTrader) || 'NOT_FOUND'}`);

  // ========================================
  // 1. 读取派生钱包链上余额 (native BNB + WBNB)
  // ========================================
  let walletEthBalance = 0n;

  const publicClient = createPublicClient({
    chain: activeChain,
    transport: rpcTransport,
  });

  const derivedWallet2 = traderToDerivedWallet.get(normalizedTrader);
  const balanceTarget2 = derivedWallet2 || normalizedTrader;

  let nativeEthBalance = 0n;
  let wethBalance = 0n;
  try {
    nativeEthBalance = await publicClient.getBalance({ address: balanceTarget2 });
  } catch (e) {
    console.warn(`[Balance] Failed to fetch native BNB balance for ${balanceTarget2}:`, e);
  }

  try {
    if (WETH_ADDRESS) {
      wethBalance = await publicClient.readContract({
        address: WETH_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [balanceTarget2],
      }) as bigint;
    }
  } catch (e) {
    console.warn(`[Balance] Failed to fetch wallet WBNB balance for ${balanceTarget2}:`, e);
  }

  walletEthBalance = nativeEthBalance + wethBalance;

  // ========================================
  // 2. 计算挂单锁定金额 (内存中的 orderMarginInfos)
  // ========================================
  const positions = userPositions.get(normalizedTrader) || [];
  const userOrders = engine.getUserOrders(normalizedTrader);

  let pendingOrdersLocked = 0n;
  for (const order of userOrders) {
    if (order.status === "PENDING" || order.status === "PARTIALLY_FILLED") {
      const marginInfo = orderMarginInfos.get(order.id);
      if (marginInfo) {
        const unfilledRatio = marginInfo.totalSize > 0n
          ? ((marginInfo.totalSize - marginInfo.settledSize) * 10000n) / marginInfo.totalSize
          : 10000n;
        pendingOrdersLocked += (marginInfo.totalDeducted * unfilledRatio) / 10000n;
      }
    }
  }

  // ========================================
  // 3. 仓位保证金 (从后端内存)
  // ========================================
  let positionMargin = 0n;
  for (const pos of positions) {
    positionMargin += BigInt(pos.collateral || "0");
  }

  // ========================================
  // 4. mode2 调整 (平仓盈亏、资金费等链下调整)
  // ========================================
  const mode2Adj = getMode2Adjustment(normalizedTrader);

  // ========================================
  // 5. 余额计算 (派生钱包 BNB = 可用资金)
  // ========================================
  const totalFunds = walletEthBalance + mode2Adj;
  let availableBalance = totalFunds - positionMargin - pendingOrdersLocked;
  if (availableBalance < 0n) availableBalance = 0n;
  const usedMargin = positionMargin;
  const totalBalance = totalFunds > 0n ? totalFunds : 0n;

  // ========================================
  // 6. 未实现盈亏 (基于实时价格)
  // ========================================
  let totalPnL = 0n;
  for (const pos of positions) {
    const orderBook = engine.getOrderBook(pos.token as Address);
    const currentPrice = orderBook.getCurrentPrice();
    const pnl = calculateUnrealizedPnL(
      BigInt(pos.size),
      BigInt(pos.entryPrice),
      currentPrice,
      pos.isLong
    );
    totalPnL += pnl;
  }

  // ========================================
  // 7. 账户权益
  // ========================================
  const equity = availableBalance + usedMargin + totalPnL;

  console.log(`[Balance API] ${normalizedTrader.slice(0, 10)}: wallet=${(Number(walletEthBalance) / 1e18).toFixed(4)}, mode2=${(Number(mode2Adj) / 1e18).toFixed(4)}, available=${(Number(availableBalance) / 1e18).toFixed(4)}`);

  return jsonResponse({
    totalBalance: totalBalance.toString(),
    availableBalance: availableBalance.toString(),
    usedMargin: usedMargin.toString(),
    frozenMargin: "0",
    walletBalance: walletEthBalance.toString(),
    settlementAvailable: "0",  // 新架构不使用 Settlement
    settlementLocked: "0",
    positionMargin: positionMargin.toString(),
    pendingOrdersLocked: pendingOrdersLocked.toString(),
    unrealizedPnL: totalPnL.toString(),
    equity: equity.toString(),
    positionCount: positions.length,
    chainData: {
      available: "0",
      locked: "0",
      nativeEth: nativeEthBalance.toString(),
      weth: wethBalance.toString(),
      walletTotal: walletEthBalance.toString(),
      mode2Adjustment: mode2Adj.toString(),
      effectiveAvailable: availableBalance.toString(),
    },
    source: walletEthBalance > 0n ? "chain+backend" : "backend",
    mode: "mode2",  // 标记当前运行模式
    // 人类可读格式 (BSC: BNB 本位)
    display: {
      totalBalance: `BNB ${(Number(totalBalance) / 1e18).toFixed(6)}`,
      availableBalance: `BNB ${(Number(availableBalance) / 1e18).toFixed(6)}`,
      walletBalance: `BNB ${(Number(walletEthBalance) / 1e18).toFixed(6)}`,
      settlementAvailable: "BNB 0.000000 (deprecated)",
      mode2Adjustment: `BNB ${(Number(mode2Adj) / 1e18).toFixed(6)}`,
      effectiveAvailable: `BNB ${(Number(availableBalance) / 1e18).toFixed(6)}`,
      positionMargin: `BNB ${(Number(positionMargin) / 1e18).toFixed(6)}`,
      pendingOrdersLocked: `BNB ${(Number(pendingOrdersLocked) / 1e18).toFixed(6)}`,
      usedMargin: `BNB ${(Number(usedMargin) / 1e18).toFixed(6)}`,
      unrealizedPnL: `BNB ${(Number(totalPnL) / 1e18).toFixed(6)}`,
      equity: `BNB ${(Number(equity) / 1e18).toFixed(6)}`,
    }
  });
}

/**
 * 充值 (测试用 — 默认禁用)
 * POST /api/user/:trader/deposit
 * Body: { amount: "1000000000000000000" } // 1e18 精度, 1 ETH
 *
 * ⚠️ 此接口凭空创建余额，不走链上合约。
 * 生产环境必须禁用 (ALLOW_FAKE_DEPOSIT=false)。
 * 用户应通过 SettlementV2.deposit() 链上存款。
 */
async function handleDeposit(req: Request, trader: string): Promise<Response> {
  // Gate: reject fake deposits unless explicitly allowed for testing
  if (!ALLOW_FAKE_DEPOSIT) {
    return jsonResponse({
      error: "Direct deposit disabled. Use SettlementV2.deposit() on-chain.",
      hint: "Set ALLOW_FAKE_DEPOSIT=true for testing only.",
    }, 403);
  }

  try {
    const body = await req.json();
    const { amount } = body;

    if (!amount) {
      return errorResponse("Missing amount");
    }

    const amountBigInt = BigInt(amount);
    if (amountBigInt <= 0n) {
      return errorResponse("Amount must be positive");
    }

    const normalizedTrader = trader.toLowerCase() as Address;
    deposit(normalizedTrader, amountBigInt);

    const balance = getUserBalance(normalizedTrader);
    return jsonResponse({
      success: true,
      message: `Deposited $${Number(amountBigInt) / 1e18}`,
      balance: {
        totalBalance: balance.totalBalance.toString(),
        availableBalance: balance.availableBalance.toString(),
      }
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * 提现
 * POST /api/user/:trader/withdraw
 * Body: { amount: "1000000000000000000" } // 1e18 精度, 1 ETH
 */
async function handleWithdraw(req: Request, trader: string): Promise<Response> {
  try {
    // AUDIT-FIX C-02: 与 C-01 一致，生产环境禁用虚假提款 API
    if (!ALLOW_FAKE_DEPOSIT) {
      return jsonResponse({
        error: "Direct withdraw disabled. Use /api/wallet/withdraw with Merkle proof.",
        hint: "Set ALLOW_FAKE_DEPOSIT=true for testing only.",
      }, 403);
    }

    const body = await req.json();
    const { amount, signature } = body;

    if (!amount) {
      return errorResponse("Missing amount");
    }

    const amountBigInt = BigInt(amount);
    if (amountBigInt <= 0n) {
      return errorResponse("Amount must be positive");
    }

    const normalizedTrader = trader.toLowerCase() as Address;

    // P3-P1: 验证提款签名
    const withdrawMessage = `Withdraw ${amount} for ${normalizedTrader}`;
    const auth = await verifyTraderSignature(trader, signature, withdrawMessage);
    if (!auth.valid) {
      return errorResponse(auth.error || "Authentication failed", 401);
    }
    const success = withdraw(normalizedTrader, amountBigInt);

    if (!success) {
      return errorResponse("Insufficient available balance");
    }

    const balance = getUserBalance(normalizedTrader);
    return jsonResponse({
      success: true,
      message: `Withdrew $${Number(amountBigInt) / 1e18}`,
      balance: {
        totalBalance: balance.totalBalance.toString(),
        availableBalance: balance.availableBalance.toString(),
      }
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * 平仓处理 (支持部分平仓)
 *
 * POST /api/position/:pairId/close
 * Body: {
 *   trader: Address,
 *   closeRatio?: number,  // 0-1, 默认 1 (全部平仓)
 *   closeSize?: string,   // 或直接指定平仓数量
 * }
 */
async function handleClosePair(req: Request, pairId: string): Promise<Response> {
  try {
    const body = await req.json();
    const { trader, closeRatio = 1, closeSize, signature } = body;

    if (!trader) {
      return errorResponse("Missing trader address");
    }

    // P3-P1: 验证签名 — 前端已签名 "Close pair {pairId} for {trader}" (usePerpetualV2.ts L638)
    const expectedMessage = `Close pair ${pairId} for ${trader.toLowerCase()}`;
    const auth = await verifyTraderSignature(trader, signature, expectedMessage);
    if (!auth.valid) {
      return errorResponse(auth.error || "Authentication failed", 401);
    }

    const normalizedTrader = trader.toLowerCase() as Address;

    // P3-P2: 分布式锁 — 防止并发 close 导致双倍扣仓
    return await withLock(
      `position:${normalizedTrader}`,
      15000,
      async () => {

    // 查找仓位
    const positions = userPositions.get(normalizedTrader) || [];
    const position = positions.find(p => p.pairId === pairId);

    if (!position) {
      return errorResponse("Position not found");
    }

    const currentSize = BigInt(position.size);
    const token = position.token.toLowerCase() as Address;
    const orderBook = engine.getOrderBook(token);
    const currentPrice = orderBook.getCurrentPrice();

    // 计算平仓数量
    let sizeToClose: bigint;
    if (closeSize) {
      sizeToClose = BigInt(closeSize);
    } else {
      sizeToClose = (currentSize * BigInt(Math.floor(closeRatio * 10000))) / 10000n;
    }

    // 验证平仓数量
    if (sizeToClose <= 0n) {
      return errorResponse("Invalid close size");
    }
    if (sizeToClose > currentSize) {
      sizeToClose = currentSize;
    }

    const isFullClose = sizeToClose >= currentSize;
    const closeRatioActual = Number(sizeToClose) / Number(currentSize);

    console.log(`[Close] pairId=${pairId} trader=${normalizedTrader.slice(0, 10)} ratio=${(closeRatioActual * 100).toFixed(2)}% isFullClose=${isFullClose}`);

    // AUDIT-FIX ME-C05: 使用实时价格计算平仓PnL，而非存储的旧 unrealizedPnL
    // position.unrealizedPnL 仅在定期价格更新时刷新，可能已过期
    // 必须用 currentPrice (L8029) 实时计算，确保平仓结算金额准确
    const entryPrice = BigInt(position.entryPrice || position.averageEntryPrice);
    const totalUpnl = calculateUnrealizedPnL(currentSize, entryPrice, currentPrice, position.isLong);
    const closePnL = (totalUpnl * sizeToClose) / currentSize;

    // 计算释放的保证金 (按比例)
    const totalCollateral = BigInt(position.collateral);
    const releasedCollateral = (totalCollateral * sizeToClose) / currentSize;

    // 计算平仓手续费 (Taker 费率 — 市价平仓)
    // sizeToClose 已经是 ETH 名义价值 (1e18 精度)
    const positionValue = sizeToClose;
    const closeFee = (positionValue * TRADING.TAKER_FEE_RATE) / 10000n;

    // 实际返还金额 = 释放保证金 + PnL - 手续费
    const returnAmount = releasedCollateral + closePnL - closeFee;

    console.log(`[Close] PnL=$${Number(closePnL) / 1e18} collateral=$${Number(releasedCollateral) / 1e18} fee=$${Number(closeFee) / 1e18} return=$${Number(returnAmount) / 1e18}`);

    if (isFullClose) {
      // ============================================================
      // 🔄 模式 2: 全部平仓 - 纯链下执行
      // - 不调用链上 closePair
      // - 直接更新后端余额 (returnAmount 加入 available)
      // - 用户后续可通过 Merkle 证明提取资金
      // ============================================================

      // 从用户仓位列表中移除
      const updatedPositions = positions.filter(p => p.pairId !== pairId);
      userPositions.set(normalizedTrader, updatedPositions);

      // 同步删除 Redis 中的仓位
      deletePositionFromRedis(pairId, "CLOSED", normalizedTrader, {
        closePrice: currentPrice.toString(),
        closingPnl: closePnL.toString(),
        closeFee: closeFee.toString(),
      }).catch((err) => {
        console.error("[Redis] Failed to delete closed position:", err);
      });

      // ✅ 模式 2: 平仓收益记入链下调整 (HTTP API 读取时会加上)
      // returnAmount = releasedCollateral + closePnL - closeFee
      // 链下调整 = closePnL - closeFee (保证金部分是从仓位释放，不属于链下增量)
      const pnlMinusFee = closePnL - closeFee;
      addMode2Adjustment(normalizedTrader, pnlMinusFee, "CLOSE_PNL");
      // ✅ 平仓手续费 80/20 分配
      if (closeFee > 0n) {
        addMode2Adjustment(FEE_RECEIVER_ADDRESS, closeFee, "PLATFORM_FEE");
      }

      // 同步更新内存余额 (用于 WS 广播)
      // AUDIT-FIX ME-C01: 全仓平仓必须释放 usedMargin，防止 totalBalance 膨胀
      const balance = getUserBalance(normalizedTrader);
      const releasedCollateral = BigInt(position.collateral || "0");
      if (balance.usedMargin && balance.usedMargin > 0n) {
        balance.usedMargin -= releasedCollateral;
        if (balance.usedMargin < 0n) balance.usedMargin = 0n;
      }
      if (returnAmount > 0n) {
        balance.availableBalance += returnAmount;
        balance.totalBalance = balance.availableBalance + (balance.usedMargin || 0n);
        console.log(`[Close] Mode 2: Added Ξ${Number(returnAmount) / 1e18} to ${normalizedTrader.slice(0, 10)} available balance (released margin: Ξ${Number(releasedCollateral) / 1e18})`);
      } else if (returnAmount < 0n) {
        // AUDIT-FIX ME-C11: 亏损情况 — 即使余额不足也必须扣除（扣至0）
        const loss = -returnAmount;
        balance.availableBalance = balance.availableBalance >= loss ? balance.availableBalance - loss : 0n;
        balance.totalBalance = balance.availableBalance + (balance.usedMargin || 0n);
        console.log(`[Close] Mode 2: Deducted Ξ${Number(loss) / 1e18} loss from ${normalizedTrader.slice(0, 10)} (balance clamped to 0 if insufficient)`);
      } else {
        balance.totalBalance = balance.availableBalance + (balance.usedMargin || 0n);
      }

      // 广播余额更新
      broadcastBalanceUpdate(normalizedTrader);

      // ✅ PerpVault: 全部平仓 — 减少 OI + 结算 PnL + 收取手续费
      if (isPerpVaultEnabled()) {
        const closeSizeETH = sizeToClose; // 已经是 ETH 名义价值 (1e18)
        vaultDecreaseOI(token, position.isLong, closeSizeETH).catch(err =>
          console.error(`[PerpVault] decreaseOI failed (full close): ${err}`)
        );
        // 结算 PnL: 盈利从池子付出, 亏损流入池子
        if (closePnL > 0n) {
          vaultSettleTraderPnL(normalizedTrader, closePnL, true).catch(err =>
            console.error(`[PerpVault] settleTraderProfit failed: ${err}`)
          );
        } else if (closePnL < 0n) {
          vaultSettleTraderPnL(normalizedTrader, -closePnL, false).catch(err =>
            console.error(`[PerpVault] settleTraderLoss failed: ${err}`)
          );
        }
        if (closeFee > 0n) {
          distributeTradingFee(closeFee, token);
        }
      }

      // 广播平仓事件
      broadcastPositionClosed(position, currentPrice, closePnL);
      // ✅ 修复：也发送 positions 消息触发前端刷新仓位列表
      broadcastPositionUpdate(normalizedTrader, token);

      // ✅ 记录平仓成交到 userTrades (用于成交记录 + 历史委托)
      const closeTrade: TradeRecord = {
        id: `close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        orderId: generateTradeOrderId(normalizedTrader),
        pairId,
        token: position.token,
        trader: position.trader,
        isLong: position.isLong,
        isMaker: false,
        size: sizeToClose.toString(),
        price: currentPrice.toString(),
        fee: closeFee.toString(),
        realizedPnL: closePnL.toString(),
        timestamp: Date.now(),
        type: "close",
      };
      const traderTrades = userTrades.get(normalizedTrader) || [];
      traderTrades.push(closeTrade);
      userTrades.set(normalizedTrader, traderTrades);
      // 持久化到 Redis
      createTradeWithMirror({
        orderId: closeTrade.orderId, pairId: closeTrade.pairId,
        token: token, trader: normalizedTrader,
        isLong: closeTrade.isLong, isMaker: false,
        size: closeTrade.size, price: closeTrade.price,
        fee: closeTrade.fee, realizedPnL: closeTrade.realizedPnL,
        timestamp: closeTrade.timestamp, type: "close",
      }, "close");

      // ✅ 记录 SETTLE_PNL 账单
      // FIX: 使用 computeSettlementBalance (chain + mode2) 与前端右上角余额一致
      // 旧代码用 balance.totalBalance 包含了已释放的保证金，导致 balanceAfter 虚高
      try {
        const effectiveAfter = computeSettlementBalance(normalizedTrader);
        const pnlMinusFee = closePnL - closeFee;
        const effectiveBefore = effectiveAfter - pnlMinusFee;
        createBillWithMirror({
          userAddress: normalizedTrader,
          type: "SETTLE_PNL",
          amount: closePnL.toString(),
          balanceBefore: effectiveBefore.toString(),
          balanceAfter: effectiveAfter.toString(),
          onChainStatus: "ENGINE_SETTLED",
          proofData: JSON.stringify({
            token: position.token, pairId, isLong: position.isLong,
            entryPrice: position.entryPrice, exitPrice: currentPrice.toString(),
            size: sizeToClose.toString(), closeFee: closeFee.toString(),
            returnAmount: returnAmount.toString(),
            releasedCollateral: releasedCollateral.toString(),
            closeType: "manual",
          }),
          positionId: pairId, orderId: closeTrade.orderId, txHash: null,
        });
      } catch (billErr) {
        console.error("[Close] Failed to log settle PnL bill:", billErr);
      }

      // Bill: record close fee for HTTP manual close
      if (closeFee > 0n) {
        const httpCloseBal = getUserBalance(normalizedTrader);
        createBillWithMirror({
          userAddress: normalizedTrader, type: "CLOSE_FEE", amount: (-closeFee).toString(),
          balanceBefore: (httpCloseBal.totalBalance + closeFee).toString(),
          balanceAfter: httpCloseBal.totalBalance.toString(),
          positionId: pairId, onChainStatus: "OFF_CHAIN",
        });
      }

      return jsonResponse({
        success: true,
        type: "full_close",
        pairId,
        closedSize: sizeToClose.toString(),
        exitPrice: currentPrice.toString(),
        realizedPnL: closePnL.toString(),
        closeFee: closeFee.toString(),
        returnAmount: returnAmount.toString(),
      });
    } else {
      // 部分平仓 - 更新后端仓位状态
      const remainingSize = currentSize - sizeToClose;
      const remainingCollateral = totalCollateral - releasedCollateral;

      // 更新仓位
      position.size = remainingSize.toString();
      position.collateral = remainingCollateral.toString();
      position.margin = remainingCollateral.toString();
      position.realizedPnL = (BigInt(position.realizedPnL || "0") + closePnL).toString();
      position.updatedAt = Date.now();

      // 重新计算剩余仓位的指标
      const newUpnl = totalUpnl - closePnL;
      position.unrealizedPnL = newUpnl.toString();

      // 重新计算 ROE
      if (remainingCollateral > 0n) {
        position.roe = ((newUpnl * 10000n) / remainingCollateral).toString();
      }

      // ✅ 记录部分平仓成交到 userTrades
      const partialCloseTrade: TradeRecord = {
        id: `close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        orderId: generateTradeOrderId(normalizedTrader),
        pairId,
        token: position.token,
        trader: position.trader,
        isLong: position.isLong,
        isMaker: false,
        size: sizeToClose.toString(),
        price: currentPrice.toString(),
        fee: closeFee.toString(),
        realizedPnL: closePnL.toString(),
        timestamp: Date.now(),
        type: "close",
      };
      const partialTrades = userTrades.get(normalizedTrader) || [];
      partialTrades.push(partialCloseTrade);
      userTrades.set(normalizedTrader, partialTrades);
      createTradeWithMirror({
        orderId: partialCloseTrade.orderId, pairId: partialCloseTrade.pairId,
        token: token, trader: normalizedTrader,
        isLong: partialCloseTrade.isLong, isMaker: false,
        size: partialCloseTrade.size, price: partialCloseTrade.price,
        fee: partialCloseTrade.fee, realizedPnL: partialCloseTrade.realizedPnL,
        timestamp: partialCloseTrade.timestamp, type: "close",
      }, "partial_close");

      // ✅ 记录部分平仓 SETTLE_PNL 账单
      // FIX: 使用 computeSettlementBalance 替代硬编码 "0"
      try {
        const effectiveAfter = computeSettlementBalance(normalizedTrader);
        const partialPnlMinusFeeForBill = closePnL - closeFee;
        const effectiveBefore = effectiveAfter - partialPnlMinusFeeForBill;
        createBillWithMirror({
          userAddress: normalizedTrader,
          type: "SETTLE_PNL",
          amount: closePnL.toString(),
          balanceBefore: effectiveBefore.toString(),
          balanceAfter: effectiveAfter.toString(),
          onChainStatus: "ENGINE_SETTLED",
          proofData: JSON.stringify({
            token: position.token, pairId, isLong: position.isLong,
            entryPrice: position.entryPrice, exitPrice: currentPrice.toString(),
            size: sizeToClose.toString(), closeFee: closeFee.toString(),
            returnAmount: returnAmount.toString(),
            releasedCollateral: releasedCollateral.toString(),
            closeType: "partial",
          }),
          positionId: pairId, orderId: partialCloseTrade.orderId, txHash: null,
        });
      } catch (billErr) {
        console.error("[Close] Failed to log partial settle PnL bill:", billErr);
      }

      // ✅ 模式 2: 部分平仓收益记入链下调整 + 更新内存余额
      const partialPnlMinusFee = closePnL - closeFee;
      addMode2Adjustment(normalizedTrader, partialPnlMinusFee, "PARTIAL_CLOSE_PNL");
      // ✅ 部分平仓手续费 80/20 分配
      if (closeFee > 0n) {
        addMode2Adjustment(FEE_RECEIVER_ADDRESS, closeFee, "PLATFORM_FEE");
      }

      if (returnAmount > 0n) {
        const balance = getUserBalance(normalizedTrader);
        balance.availableBalance += returnAmount;
        balance.usedMargin -= releasedCollateral;
        if (balance.usedMargin < 0n) balance.usedMargin = 0n;
        balance.totalBalance = balance.availableBalance + (balance.usedMargin || 0n);
      } else if (returnAmount < 0n) {
        const balance = getUserBalance(normalizedTrader);
        const loss = -returnAmount;
        if (balance.availableBalance >= loss) {
          balance.availableBalance -= loss;
        }
        balance.usedMargin -= releasedCollateral;
        if (balance.usedMargin < 0n) balance.usedMargin = 0n;
        balance.totalBalance = balance.availableBalance + (balance.usedMargin || 0n);
      }
      broadcastBalanceUpdate(normalizedTrader);

      // ✅ PerpVault: 部分平仓 — 减少 OI + 结算 PnL + 收取手续费
      if (isPerpVaultEnabled()) {
        const partialSizeETH = sizeToClose;
        vaultDecreaseOI(token, position.isLong, partialSizeETH).catch(err =>
          console.error(`[PerpVault] decreaseOI failed (partial close): ${err}`)
        );
        if (closePnL > 0n) {
          vaultSettleTraderPnL(normalizedTrader, closePnL, true).catch(err =>
            console.error(`[PerpVault] settleTraderProfit failed (partial): ${err}`)
          );
        } else if (closePnL < 0n) {
          vaultSettleTraderPnL(normalizedTrader, -closePnL, false).catch(err =>
            console.error(`[PerpVault] settleTraderLoss failed (partial): ${err}`)
          );
        }
        if (closeFee > 0n) {
          distributeTradingFee(closeFee, token);
        }
      }

      // 广播部分平仓事件
      broadcastPartialClose(position, sizeToClose, currentPrice, closePnL);

      return jsonResponse({
        success: true,
        type: "partial_close",
        pairId,
        closedSize: sizeToClose.toString(),
        remainingSize: remainingSize.toString(),
        exitPrice: currentPrice.toString(),
        realizedPnL: closePnL.toString(),
        closeFee: closeFee.toString(),
        returnAmount: returnAmount.toString(),
      });
    }

    }, 3, 100); // withLock: 3 retries, 100ms delay

  } catch (e) {
    console.error("[Close] Error:", e);
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * 广播全部平仓事件
 */
function broadcastPositionClosed(position: Position, exitPrice: bigint, pnl: bigint): void {
  // AUDIT-FIX M-04: Send only to the trader's own WS clients (not all clients)
  const message = JSON.stringify({
    type: "position_closed",
    pairId: position.pairId,
    trader: position.trader,
    token: position.token,
    isLong: position.isLong,
    exitPrice: exitPrice.toString(),
    realizedPnL: pnl.toString(),
    timestamp: Date.now(),
  });

  const trader = position.trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(trader);
  if (wsSet) {
    for (const client of wsSet) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }
}

/**
 * 广播部分平仓事件
 */
function broadcastPartialClose(position: Position, closedSize: bigint, exitPrice: bigint, pnl: bigint): void {
  // AUDIT-FIX M-04: Send only to the trader's own WS clients (not all clients)
  const message = JSON.stringify({
    type: "partial_close",
    pairId: position.pairId,
    trader: position.trader,
    token: position.token,
    isLong: position.isLong,
    closedSize: closedSize.toString(),
    remainingSize: position.size,
    exitPrice: exitPrice.toString(),
    realizedPnL: pnl.toString(),
    timestamp: Date.now(),
  });

  const trader = position.trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(trader);
  if (wsSet) {
    for (const client of wsSet) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }
}

async function handleUpdatePrice(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { token, price } = body;

    if (!token || !price) {
      return errorResponse("Missing token or price");
    }

    const priceBigInt = BigInt(price);
    engine.updatePrice(token as Address, priceBigInt);

    // ❌ Mode 2: 不再更新链上价格，永续交易使用后端价格
    // 现货交易价格由 TokenFactory AMM 自动计算
    console.log(`[API] Price updated in engine: ${token.slice(0, 10)} = ${priceBigInt}`);

    return jsonResponse({ success: true, price: priceBigInt.toString() });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * Get K-line (candlestick) data
 * 优先使用现货交易历史生成的 K 线（存储在 Redis），如果没有则回退到撮合引擎内存数据
 */
async function handleGetKlines(token: string, url: URL): Promise<Response> {
  const interval = url.searchParams.get("interval") || "1m";
  const limit = parseInt(url.searchParams.get("limit") || "100");

  // 首先尝试从 Redis 获取现货交易历史生成的 K 线
  try {
    const { handleGetLatestKlines } = await import("./api/handlers");
    const result = await handleGetLatestKlines(token as Address, interval, limit);
    if (result.success && result.data && result.data.length > 0) {
      // 格式化极小数字，避免科学计数法
      const formatSmallNumber = (val: string | number): string => {
        const num = typeof val === 'string' ? parseFloat(val) : val;
        if (num === 0) return "0";
        if (num < 1e-10) return num.toFixed(15);
        if (num < 1e-8) return num.toFixed(12);
        if (num < 1e-6) return num.toFixed(10);
        if (num < 1e-4) return num.toFixed(8);
        return num.toString();
      };

      return jsonResponse({
        klines: result.data.map((k: any) => ({
          timestamp: k.time * 1000, // 转换为毫秒
          open: formatSmallNumber(k.open),
          high: formatSmallNumber(k.high),
          low: formatSmallNumber(k.low),
          close: formatSmallNumber(k.close),
          volume: k.volume,
          trades: k.trades,
        })),
      });
    }
  } catch (e) {
    console.warn("[Server] Failed to get spot klines from Redis:", e);
  }

  // 回退到撮合引擎内存数据
  // ETH 本位: 撮合引擎存的是 ETH/Token 价格 (1e18 精度)
  const klines = engine.getKlines(token as Address, interval, limit);

  return jsonResponse({
    klines: klines.map(k => ({
      timestamp: k.timestamp * 1000, // 统一转为毫秒
      // ETH 本位: 直接输出 ETH 价格 (1e18 精度 → 小数)
      open: (Number(k.open) / 1e18).toString(),
      high: (Number(k.high) / 1e18).toString(),
      low: (Number(k.low) / 1e18).toString(),
      close: (Number(k.close) / 1e18).toString(),
      // 交易量: Token 数量 (1e18 精度 → 小数)
      volume: (Number(k.volume) / 1e18).toString(),
      trades: k.trades,
    })),
  });
}

/**
 * Get token statistics
 * 优先使用现货交易历史的 24h 统计（存储在 Redis），如果没有则回退到撮合引擎数据
 */
async function handleGetStats(token: string): Promise<Response> {
  const normalizedToken = token.toLowerCase() as Address;

  // ✅ 价格回退链: Redis现货统计 → 订单簿价格(由syncSpotPrices设置) → 撮合引擎
  const orderBook = engine.getOrderBook(normalizedToken);
  let markPrice = orderBook.getCurrentPrice();
  if (markPrice <= 0n) {
    markPrice = engine.getSpotPrice(normalizedToken);
  }

  // ✅ 计算真实未平仓合约 (from in-memory userPositions)
  const { longOI, shortOI } = calculateOpenInterest(normalizedToken);
  const totalOI = longOI + shortOI;

  // ✅ 使用动态倾斜资金费率
  const currentRate = currentFundingRates.get(normalizedToken) || 0n;
  const nextSettlement = nextFundingSettlement.get(normalizedToken) || (Date.now() + 15 * 60 * 1000);


  // 首先尝试从 Redis 获取现货交易的 24h 统计
  try {
    const { handleGetSpotPrice } = await import("./api/handlers");
    const spotResult = await handleGetSpotPrice(token as Address);
    if (spotResult.success && spotResult.data) {
      const data = spotResult.data;
      const changePercent = parseFloat(data.change24h || "0"); // 已是百分比 (如 5.23 = 5.23%)
      // 使用 spot 价格，如果没有则使用订单簿价格
      const priceStr = data.price || (markPrice > 0n ? (Number(markPrice) / 1e18).toString() : "0");
      // ✅ 计算原始价格差值 (与 WS broadcastMarketData 一致)
      const price = parseFloat(priceStr);
      const open24h = parseFloat(data.open24h || "0");
      const priceChange = open24h > 0 ? price - open24h : 0;
      return jsonResponse({
        price: priceStr,
        priceChange24h: priceChange.toString(),
        priceChangePercent24h: changePercent.toFixed(2),
        high24h: data.high24h || "0",
        low24h: data.low24h || "0",
        volume24h: data.volume24h || "0",
        trades24h: data.trades24h || 0,
        openInterest: totalOI.toString(),
        longOI: longOI.toString(),
        shortOI: shortOI.toString(),
        fundingRate: currentRate.toString(),
        nextFundingTime: nextSettlement,
      });
    }
  } catch (e) {
    console.warn("[Server] Failed to get spot stats from Redis:", e);
  }

  // 回退到撮合引擎数据 + 订单簿价格
  const stats = engine.getStats(token as Address);
  const fallbackPrice = markPrice > 0n ? markPrice : stats.price;

  return jsonResponse({
    price: fallbackPrice.toString(),
    priceChange24h: stats.priceChange24h.toString(),
    high24h: stats.high24h.toString(),
    low24h: stats.low24h.toString(),
    volume24h: stats.volume24h.toString(),
    trades24h: stats.trades24h,
    openInterest: totalOI.toString(),
    longOI: longOI.toString(),
    shortOI: shortOI.toString(),
    fundingRate: currentRate.toString(),
    nextFundingTime: nextSettlement,
  });
}

/**
 * Get funding rate (使用动态资金费配置)
 */
async function handleGetFundingRate(token: string): Promise<Response> {
  const normalizedToken = token.toLowerCase() as Address;

  // 使用动态倾斜资金费率
  const currentRate = currentFundingRates.get(normalizedToken) || 0n;
  const skewed = currentFundingRatesSkewed.get(normalizedToken);
  const nextSettlement = nextFundingSettlement.get(normalizedToken) || Date.now() + 15 * 60 * 1000;
  const interval = getFundingInterval(normalizedToken);

  return jsonResponse({
    rate: currentRate.toString(),
    longRate: skewed?.longRate.toString() || "0",
    shortRate: skewed?.shortRate.toString() || "0",
    nextFundingTime: nextSettlement,
    interval: `${Math.floor(interval / 60000)}m`,  // 15m
  });
}

// ============================================================
// 猎杀场 API
// ============================================================

/**
 * 计算清算价格 (ETH 本位 - Bybit 行业标准)
 * 多头: liqPrice = entryPrice * (1 - 1/leverage + MMR)
 * 空头: liqPrice = entryPrice * (1 + 1/leverage - MMR)
 *
 * ETH 本位:
 * - entryPrice: ETH/Token (1e18 精度)
 * - 返回值: ETH/Token (1e18 精度)
 * - leverage 是 1e4 精度 (10x = 100000)
 */
function calculateLiquidationPrice(
  entryPrice: bigint,   // ETH/Token (1e18 精度)
  leverage: bigint,     // 1e4 精度 (10x = 100000)
  isLong: boolean,
  mmr: bigint = 200n    // 基础 MMR，会根据杠杆动态调整
): bigint {
  const PRECISION = 10000n; // 基点精度

  // Guard against zero leverage (corrupt position data)
  if (leverage <= 0n) return 0n;
  // leverage 是 1e4 精度, 直接用于计算
  // 1/leverage = PRECISION / (leverage / PRECISION) = PRECISION * PRECISION / leverage
  // 例如: 10x leverage = 100000, inverseLevel = 10000 * 10000 / 100000 = 1000 (表示 10%)
  const inverseLevel = (PRECISION * PRECISION) / leverage;

  // ============================================================
  // 动态 MMR 计算 (行业标准 - 参考 Bybit/Binance)
  // ============================================================
  // 关键规则: MMR 必须小于 1/leverage，否则一开仓就会被清算
  //
  // 安全系数: MMR = min(基础MMR, 初始保证金率 * 50%)
  // 这样确保强平价格距离入场价至少有 50% 的保证金缓冲
  //
  // 例如:
  // - 10x: 初始保证金 10%, MMR = min(2%, 5%) = 2%
  // - 50x: 初始保证金 2%, MMR = min(2%, 1%) = 1%
  // - 75x: 初始保证金 1.33%, MMR = min(2%, 0.67%) = 0.67%
  // - 100x: 初始保证金 1%, MMR = min(2%, 0.5%) = 0.5%
  // ============================================================
  const maxMmr = inverseLevel / 2n; // MMR 不能超过初始保证金率的一半
  const effectiveMmr = mmr < maxMmr ? mmr : maxMmr;

  if (isLong) {
    // 多头: liqPrice = entryPrice * (1 - 1/leverage + MMR)
    // 因为 MMR < 1/leverage，所以 factor < 1，强平价低于入场价
    // 75x 多头 (effectiveMmr=0.67%): factor = 10000 - 133 + 67 = 9934 (99.34%)
    const factor = PRECISION - inverseLevel + effectiveMmr;
    return (entryPrice * factor) / PRECISION;
  } else {
    // 空头: liqPrice = entryPrice * (1 + 1/leverage - MMR)
    // 因为 MMR < 1/leverage，所以 factor > 1，强平价高于入场价
    // 75x 空头 (effectiveMmr=0.67%): factor = 10000 + 133 - 67 = 10066 (100.66%)
    const factor = PRECISION + inverseLevel - effectiveMmr;
    return (entryPrice * factor) / PRECISION;
  }
}

/**
 * 计算穿仓价格 (Bankruptcy Price) - ETH 本位
 *
 * 穿仓价格 = 保证金完全亏损的价格 (MMR = 0)
 *
 * 多头: bankruptcyPrice = entryPrice * (1 - 1/leverage)
 * 空头: bankruptcyPrice = entryPrice * (1 + 1/leverage)
 *
 * ETH 本位: 所有价格都是 ETH/Token (1e18 精度)
 */
function calculateBankruptcyPrice(
  entryPrice: bigint,   // ETH/Token (1e18 精度)
  leverage: bigint,     // 1e4 精度
  isLong: boolean
): bigint {
  const PRECISION = 10000n;
  const inverseLevel = (PRECISION * PRECISION) / leverage;

  if (isLong) {
    // 多头穿仓价 = entryPrice * (1 - 1/leverage)
    // 10x 多头: factor = 10000 - 1000 = 9000 (90%)
    const factor = PRECISION - inverseLevel;
    return (entryPrice * factor) / PRECISION;
  } else {
    // 空头穿仓价 = entryPrice * (1 + 1/leverage)
    // 10x 空头: factor = 10000 + 1000 = 11000 (110%)
    const factor = PRECISION + inverseLevel;
    return (entryPrice * factor) / PRECISION;
  }
}

/**
 * 计算未实现盈亏 (ETH 本位 - GMX 标准)
 * 公式: PnL = Size × (MarkPrice - EntryPrice) / EntryPrice × Direction
 *
 * ETH 本位说明:
 * AUDIT-FIX ME-H11: size 是 ETH 名义价值，不是 Token 数量
 * - size: ETH 名义价值 (1e18 精度), 即 tokenCount * entryPrice / 1e18
 * - entryPrice/currentPrice: ETH/Token (1e18)
 * - 返回值: ETH 盈亏 (1e18 精度)
 *
 * 计算步骤:
 * 1. priceDelta = |currentPrice - entryPrice|
 * 2. delta = size * priceDelta / entryPrice (ETH 盈亏)
 * 3. 多头价格上涨盈利，空头价格下跌盈利
 */
function calculateUnrealizedPnL(
  size: bigint,         // ETH 名义价值 (1e18 精度)
  entryPrice: bigint,   // ETH/Token (1e18 精度)
  currentPrice: bigint, // ETH/Token (1e18 精度)
  isLong: boolean
): bigint {
  if (entryPrice <= 0n) return 0n;

  // GMX 标准 PnL 计算
  const priceDelta = currentPrice > entryPrice
    ? currentPrice - entryPrice
    : entryPrice - currentPrice;

  // delta = size * priceDelta / entryPrice
  // 精度: (1e18 * 1e18) / 1e18 = 1e18 (ETH)
  const delta = (size * priceDelta) / entryPrice;

  const hasProfit = isLong
    ? currentPrice > entryPrice
    : entryPrice > currentPrice;

  return hasProfit ? delta : -delta;
}

/**
 * 计算保证金率 (ETH 本位 - Binance/OKX 标准)
 * 公式: 保证金率 = 维持保证金 / 账户权益
 *
 * 触发条件: 保证金率 >= 100% 时触发强平
 * 越小越安全，越大越危险
 *
 * ETH 本位精度:
 * - collateral: 1e18 (ETH)
 * - size: 1e18 (Token 数量)
 * - entryPrice/currentPrice: 1e18 (ETH/Token)
 * - 返回值: 1e4 精度 (10000 = 100%)
 */
function calculateMarginRatio(
  collateral: bigint,   // 1e18 精度 (ETH) - 初始保证金
  size: bigint,         // 1e18 精度 (ETH 名义价值, NOT token count)
  entryPrice: bigint,   // 1e18 精度 (ETH/Token)
  currentPrice: bigint, // 1e18 精度 (ETH/Token)
  isLong: boolean,
  mmr: bigint = 50n     // 维持保证金率 0.5% (1e4 精度, 50 = 0.5%)
): bigint {
  if (size === 0n || currentPrice === 0n) return 0n; // 无仓位，0%风险

  // AUDIT-FIX ME-C04: size 已经是 ETH 名义价值 (not token count)
  // 之前错误地乘以 currentPrice/1e18，将 ETH notional 当作 token count 处理
  // 导致 positionValue 偏差巨大，API 返回的保证金率完全错误
  const positionValue = size;
  if (positionValue === 0n) return 0n;

  // 计算维持保证金 = 仓位价值 * MMR
  // maintenanceMargin = positionValue * mmr / 10000 (ETH)
  const maintenanceMargin = (positionValue * mmr) / 10000n;

  // 计算未实现盈亏 (ETH 本位)
  const pnl = calculateUnrealizedPnL(size, entryPrice, currentPrice, isLong);

  // 账户权益 = 初始保证金 + 未实现盈亏 (ETH)
  const equity = collateral + pnl;
  if (equity <= 0n) return 100000n; // 权益为负，返回 1000% (已爆仓)

  // 保证金率 = 维持保证金 / 账户权益 * 10000 (1e4 精度)
  // 越小越安全，>= 10000 (100%) 触发强平
  return (maintenanceMargin * 10000n) / equity;
}

/**
 * 获取清算地图
 * 显示各价格点的清算量分布
 */
async function handleGetLiquidationMap(token: string): Promise<Response> {
  const normalizedToken = token.toLowerCase() as Address;
  const currentPrice = engine.getOrderBook(normalizedToken).getCurrentPrice();

  // 收集所有持仓的清算价格
  const longLiquidations: Map<string, { size: bigint; accounts: number }> = new Map();
  const shortLiquidations: Map<string, { size: bigint; accounts: number }> = new Map();

  for (const [trader, positions] of userPositions) {
    for (const pos of positions) {
      if (pos.token.toLowerCase() !== normalizedToken) continue;

      const liqPrice = pos.liquidationPrice;
      // 按价格分组（精度降低以便聚合）
      const priceKey = roundPrice(BigInt(liqPrice));

      if (pos.isLong) {
        const existing = longLiquidations.get(priceKey) || { size: 0n, accounts: 0 };
        longLiquidations.set(priceKey, {
          size: existing.size + BigInt(pos.size),
          accounts: existing.accounts + 1,
        });
      } else {
        const existing = shortLiquidations.get(priceKey) || { size: 0n, accounts: 0 };
        shortLiquidations.set(priceKey, {
          size: existing.size + BigInt(pos.size),
          accounts: existing.accounts + 1,
        });
      }
    }
  }

  // 转换为数组并排序
  const longs = Array.from(longLiquidations.entries())
    .map(([price, data]) => ({
      price,
      size: data.size.toString(),
      accounts: data.accounts,
    }))
    .sort((a, b) => Number(BigInt(b.price) - BigInt(a.price))); // 从高到低

  const shorts = Array.from(shortLiquidations.entries())
    .map(([price, data]) => ({
      price,
      size: data.size.toString(),
      accounts: data.accounts,
    }))
    .sort((a, b) => Number(BigInt(a.price) - BigInt(b.price))); // 从低到高

  return jsonResponse({
    token: normalizedToken,
    currentPrice: currentPrice.toString(),
    longs, // 多头清算点（价格低于当前价）
    shorts, // 空头清算点（价格高于当前价）
    totalLongSize: longs.reduce((sum, l) => sum + BigInt(l.size), 0n).toString(),
    totalShortSize: shorts.reduce((sum, s) => sum + BigInt(s.size), 0n).toString(),
    totalLongAccounts: longs.reduce((sum, l) => sum + l.accounts, 0),
    totalShortAccounts: shorts.reduce((sum, s) => sum + s.accounts, 0),
  });
}

/**
 * 价格四舍五入（用于聚合）
 */
function roundPrice(price: bigint): string {
  // 按 1% 精度聚合
  const precision = price / 100n;
  if (precision === 0n) return price.toString();
  return ((price / precision) * precision).toString();
}

/**
 * 获取全局持仓列表
 * 公开所有用户的持仓信息
 */
async function handleGetAllPositions(token: string): Promise<Response> {
  const normalizedToken = token.toLowerCase() as Address;
  const currentPrice = engine.getOrderBook(normalizedToken).getCurrentPrice();

  const allPositions: Array<{
    trader: string;
    isLong: boolean;
    size: string;
    entryPrice: string;
    collateral: string;
    leverage: string;
    liquidationPrice: string;
    marginRatio: string;
    unrealizedPnL: string;
    riskLevel: string; // "safe" | "warning" | "danger"
  }> = [];

  for (const [trader, positions] of userPositions) {
    for (const pos of positions) {
      if (pos.token.toLowerCase() !== normalizedToken) continue;

      // 计算实时保证金率 (行业标准: 维持保证金/权益, 越大越危险)
      const marginRatio = calculateMarginRatio(
        BigInt(pos.collateral),
        BigInt(pos.size),
        BigInt(pos.entryPrice),
        currentPrice,
        pos.isLong
      );

      // 计算未实现盈亏 (行业标准: Size × (Mark - Entry))
      const pnl = calculateUnrealizedPnL(
        BigInt(pos.size),
        BigInt(pos.entryPrice),
        currentPrice,
        pos.isLong
      );

      // 风险等级 (保证金率越大越危险，>=100%强平)
      let riskLevel: string;
      if (marginRatio < 5000n) {
        riskLevel = "safe"; // < 50%
      } else if (marginRatio < 8000n) {
        riskLevel = "warning"; // 50-80%
      } else {
        riskLevel = "danger"; // >= 80% (接近强平)
      }

      allPositions.push({
        trader: trader,
        isLong: pos.isLong,
        size: pos.size,
        entryPrice: pos.entryPrice,
        collateral: pos.collateral,
        leverage: pos.leverage,
        liquidationPrice: pos.liquidationPrice,
        marginRatio: marginRatio.toString(),
        unrealizedPnL: pnl.toString(),
        riskLevel,
      });
    }
  }

  // 按风险等级排序（danger 优先）
  allPositions.sort((a, b) => {
    const riskOrder = { danger: 0, warning: 1, safe: 2 };
    return riskOrder[a.riskLevel as keyof typeof riskOrder] - riskOrder[b.riskLevel as keyof typeof riskOrder];
  });

  return jsonResponse({
    token: normalizedToken,
    currentPrice: currentPrice.toString(),
    positions: allPositions,
    totalPositions: allPositions.length,
    dangerCount: allPositions.filter(p => p.riskLevel === "danger").length,
    warningCount: allPositions.filter(p => p.riskLevel === "warning").length,
  });
}

/**
 * 获取清算历史
 */
async function handleGetLiquidations(token: string, url: URL): Promise<Response> {
  const normalizedToken = token.toLowerCase() as Address;
  const limit = parseInt(url.searchParams.get("limit") || "50");

  const history = liquidationHistory.get(normalizedToken) || [];
  const recentHistory = history.slice(-limit).reverse(); // 最新的在前

  return jsonResponse({
    token: normalizedToken,
    liquidations: recentHistory,
    total: history.length,
  });
}

/**
 * 获取猎杀排行榜
 */
async function handleGetHunterLeaderboard(url: URL): Promise<Response> {
  const period = url.searchParams.get("period") || "all"; // "24h" | "7d" | "all"
  const limit = parseInt(url.searchParams.get("limit") || "20");

  let hunters = Array.from(hunterStats.values());

  // 按时间筛选
  if (period !== "all") {
    const now = Date.now();
    const cutoff = period === "24h" ? now - 24 * 60 * 60 * 1000 : now - 7 * 24 * 60 * 60 * 1000;
    hunters = hunters.filter(h => h.lastKillTime >= cutoff);
  }

  // 按猎杀数量排序
  hunters.sort((a, b) => b.totalKills - a.totalKills);

  return jsonResponse({
    period,
    hunters: hunters.slice(0, limit).map((h, index) => ({
      rank: index + 1,
      address: h.address,
      kills: h.totalKills,
      profit: h.totalProfitUSD,
      lastKill: h.lastKillTime,
    })),
    totalHunters: hunterStats.size,
    totalLiquidations: globalLiquidationCount,
  });
}

/**
 * 记录清算事件
 */
function recordLiquidation(
  token: Address,
  liquidatedTrader: Address,
  liquidator: Address,
  position: Position,
  liquidationPrice: bigint
): void {
  const record: LiquidationRecord = {
    id: `liq_${Date.now()}_${globalLiquidationCount++}`,
    token,
    liquidatedTrader,
    liquidator,
    isLong: position.isLong,
    size: position.size,
    entryPrice: position.entryPrice,
    liquidationPrice: liquidationPrice.toString(),
    collateralLost: position.collateral,
    timestamp: Date.now(),
  };

  // 添加到历史记录
  const history = liquidationHistory.get(token) || [];
  history.push(record);
  if (history.length > 1000) history.shift(); // 保留最近 1000 条
  liquidationHistory.set(token, history);

  // 更新猎杀者统计
  const hunter = hunterStats.get(liquidator) || {
    address: liquidator,
    totalKills: 0,
    totalProfitUSD: "0",
    lastKillTime: 0,
  };
  hunter.totalKills += 1;
  hunter.totalProfitUSD = (BigInt(hunter.totalProfitUSD) + BigInt(position.collateral) / 10n).toString(); // 假设获得 10% 奖励
  hunter.lastKillTime = Date.now();
  hunterStats.set(liquidator, hunter);

  // 广播清算事件
  broadcastLiquidation(token, record);

  console.log(`[Liquidation] 🔥 ${liquidatedTrader.slice(0, 10)} was liquidated by ${liquidator.slice(0, 10)}`);
}

/**
 * 广播清算事件到 WebSocket
 */
function broadcastLiquidation(token: Address, record: LiquidationRecord): void {
  if (!wss) return;

  const message = JSON.stringify({
    type: "liquidation",
    token,
    data: record,
  });

  for (const [ws, tokens] of wsClients) {
    if (tokens.has(token.toLowerCase() as Address) && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

// ============================================================
// 保险基金 & Oracle API Handlers (P1)
// ============================================================

/**
 * 获取全局保险基金状态
 * GET /api/insurance-fund
 */
async function handleGetInsuranceFund(): Promise<Response> {
  return jsonResponse({
    balance: insuranceFund.balance.toString(),
    totalContributions: insuranceFund.totalContributions.toString(),
    totalPayouts: insuranceFund.totalPayouts.toString(),
    lastUpdated: insuranceFund.lastUpdated,
    display: {
      balance: `$${(Number(insuranceFund.balance) / 1e18).toFixed(2)}`,
      totalContributions: `$${(Number(insuranceFund.totalContributions) / 1e18).toFixed(2)}`,
      totalPayouts: `$${(Number(insuranceFund.totalPayouts) / 1e18).toFixed(2)}`,
    },
    tokenFunds: Array.from(tokenInsuranceFunds.entries()).map(([token, fund]) => ({
      token,
      balance: fund.balance.toString(),
      display: `$${(Number(fund.balance) / 1e18).toFixed(2)}`,
    })),
  });
}

/**
 * 获取代币保险基金状态
 * GET /api/insurance-fund/:token
 */
async function handleGetTokenInsuranceFund(token: string): Promise<Response> {
  const normalizedToken = token.toLowerCase() as Address;
  const fund = getTokenInsuranceFund(normalizedToken);

  return jsonResponse({
    token: normalizedToken,
    balance: fund.balance.toString(),
    totalContributions: fund.totalContributions.toString(),
    totalPayouts: fund.totalPayouts.toString(),
    lastUpdated: fund.lastUpdated,
    display: {
      balance: `$${(Number(fund.balance) / 1e18).toFixed(2)}`,
      totalContributions: `$${(Number(fund.totalContributions) / 1e18).toFixed(2)}`,
      totalPayouts: `$${(Number(fund.totalPayouts) / 1e18).toFixed(2)}`,
    },
  });
}

// ============================================================
// Dynamic Funding API Handlers (P1)
// ============================================================

/**
 * 获取动态资金费信息
 * GET /api/dynamic-funding/:token
 */
async function handleGetDynamicFunding(token: string): Promise<Response> {
  const normalizedToken = token.toLowerCase() as Address;
  const config = getTokenFundingConfig(normalizedToken);
  const currentRate = currentFundingRates.get(normalizedToken) || 0n;
  const skewed = currentFundingRatesSkewed.get(normalizedToken);
  const nextSettlement = nextFundingSettlement.get(normalizedToken) || 0;
  const tracker = volatilityTrackers.get(normalizedToken);
  const { longOI, shortOI } = calculateOpenInterest(normalizedToken);

  // 固定 15 分钟周期
  const interval = getFundingInterval(normalizedToken);

  // 计算年化费率
  const intervalsPerYear = 365 * 24 * 60 * 60 * 1000 / interval;
  const annualizedRate = Number(currentRate) * intervalsPerYear / 100;

  return jsonResponse({
    token: normalizedToken,
    currentRate: currentRate.toString(),
    longRate: skewed?.longRate.toString() || "0",
    shortRate: skewed?.shortRate.toString() || "0",
    config: {
      baseInterval: config.baseInterval,
      maxRate: config.maxRate,
      volatilityMultiplier: config.volatilityMultiplier,
      baseFundingRateBps: config.baseFundingRateBps,
      skewFactor: config.skewFactor,
    },
    dynamics: {
      currentInterval: interval,
      volatility: tracker?.volatility || 0,
      longOI: longOI.toString(),
      shortOI: shortOI.toString(),
      imbalanceRatio: longOI + shortOI > 0n
        ? ((Number(longOI - shortOI) / Number(longOI + shortOI)) * 100).toFixed(2)
        : "0",
    },
    nextSettlement,
    annualizedRate: annualizedRate.toFixed(2),
    display: {
      currentRate: `${(Number(currentRate) / 100).toFixed(4)}%`,
      longRate: `${(Number(skewed?.longRate || 0n) / 100).toFixed(4)}%`,
      shortRate: `${(Number(skewed?.shortRate || 0n) / 100).toFixed(4)}%`,
      annualizedRate: `${annualizedRate.toFixed(2)}%`,
      nextSettlement: new Date(nextSettlement).toISOString(),
      interval: `${Math.floor(interval / 60000)} minutes`,
    },
  });
}

/**
 * 获取资金费支付历史
 * GET /api/funding-history/:token
 */
async function handleGetFundingHistory(token: string, url: URL): Promise<Response> {
  const normalizedToken = token.toLowerCase() as Address;
  const limit = parseInt(url.searchParams.get("limit") || "100");
  const trader = url.searchParams.get("trader")?.toLowerCase() as Address | undefined;

  let history = fundingPaymentHistory.get(normalizedToken) || [];

  // 按 trader 过滤
  if (trader) {
    history = history.filter(p => p.trader.toLowerCase() === trader);
  }

  // 按时间倒序
  history = history.slice(-limit).reverse();

  return jsonResponse({
    token: normalizedToken,
    count: history.length,
    payments: history.map(p => ({
      pairId: p.pairId,
      trader: p.trader,
      isLong: p.isLong,
      positionSize: p.positionSize,
      fundingRate: p.fundingRate,
      fundingAmount: p.fundingAmount,
      isPayer: p.isPayer,
      timestamp: p.timestamp,
      display: {
        fundingRate: `${(Number(p.fundingRate) / 100).toFixed(4)}%`,
        fundingAmount: `$${(Number(p.fundingAmount) / 1e18).toFixed(2)}`,
        time: new Date(p.timestamp).toISOString(),
      },
    })),
  });
}

/**
 * 手动触发资金费结算 (管理员)
 * POST /api/funding/settle
 * Body: { token: Address }
 */
async function handleManualFundingSettlement(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { token, adminKey } = body;

    // AUDIT-FIX ME-C10: 管理员操作需要鉴权
    const expectedAdminKey = process.env.ADMIN_API_KEY;
    if (!expectedAdminKey || adminKey !== expectedAdminKey) {
      return errorResponse("Unauthorized: admin API key required", 401);
    }

    if (!token) {
      return errorResponse("Missing token address");
    }

    const normalizedToken = token.toLowerCase() as Address;

    // 计算最新费率
    const rate = calculateDynamicFundingRate(normalizedToken);

    // 执行结算
    await settleFunding(normalizedToken);

    return jsonResponse({
      success: true,
      token: normalizedToken,
      settledRate: rate.toString(),
      nextSettlement: nextFundingSettlement.get(normalizedToken),
      display: {
        settledRate: `${(Number(rate) / 100).toFixed(4)}%`,
      },
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

// ============================================================
// Take Profit / Stop Loss API Handlers (P2)
// ============================================================

/**
 * 设置/更新 TP/SL
 * POST /api/position/:pairId/tpsl
 * Body: {
 *   trader: Address,           // 仓位所有者
 *   signature: Hex,            // EIP-191 签名
 *   takeProfitPrice?: string,  // 1e18 精度 (自动检测并转换 1e12)
 *   stopLossPrice?: string,    // 1e18 精度 (自动检测并转换 1e12)
 * }
 */
async function handleSetTPSL(req: Request, pairId: string): Promise<Response> {
  try {
    const body = await req.json();
    const { trader, signature, takeProfitPrice, stopLossPrice } = body;

    // P3-P1: 验证签名
    if (!trader) {
      return errorResponse("Missing trader address");
    }
    const tpslMessage = `Set TPSL ${pairId} for ${(trader as string).toLowerCase()}`;
    const auth = await verifyTraderSignature(trader, signature, tpslMessage);
    if (!auth.valid) {
      return errorResponse(auth.error || "Authentication failed", 401);
    }

    // P3-P2: 统一 TP/SL 精度为 1e18 — 自动检测并转换旧 1e12 格式
    // 仅当仓位入场价 >= 1e15 时才转换 (排除价格本身就很小的 meme 代币)
    let positionEntryPrice = 0n;
    for (const [, positions] of userPositions.entries()) {
      const found = positions.find(p => p.pairId === pairId);
      if (found) { positionEntryPrice = BigInt(found.entryPrice); break; }
    }

    function normalizeToE18(raw: string | bigint): bigint {
      const val = BigInt(raw);
      // Only auto-convert if the position's entry price is >= 1e15 (normal 1e18 scale)
      // For tiny meme token prices (entry < 1e15), values are real — don't normalize
      if (val > 0n && val < 1_000_000_000_000_000n && positionEntryPrice >= 1_000_000_000_000_000n) {
        console.warn(`[TP/SL] Auto-converting 1e12 → 1e18: ${val} → ${val * 1_000_000n}`);
        return val * 1_000_000n;
      }
      return val;
    }

    const tp = takeProfitPrice ? normalizeToE18(takeProfitPrice) : null;
    const sl = stopLossPrice ? normalizeToE18(stopLossPrice) : null;

    if (tp === null && sl === null) {
      return errorResponse("At least one of takeProfitPrice or stopLossPrice is required");
    }

    const order = setTakeProfitStopLoss(pairId, tp, sl);

    if (!order) {
      return errorResponse("Failed to set TP/SL. Check price validity.");
    }

    return jsonResponse({
      success: true,
      pairId,
      takeProfitPrice: order.takeProfitPrice?.toString() || null,
      stopLossPrice: order.stopLossPrice?.toString() || null,
      display: {
        // P3-P2: 显示用 1e18 精度
        takeProfitPrice: order.takeProfitPrice ? `$${(Number(order.takeProfitPrice) / 1e18).toFixed(8)}` : "Not set",
        stopLossPrice: order.stopLossPrice ? `$${(Number(order.stopLossPrice) / 1e18).toFixed(8)}` : "Not set",
      },
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * 获取 TP/SL 状态
 * GET /api/position/:pairId/tpsl
 */
async function handleGetTPSL(pairId: string): Promise<Response> {
  const order = tpslOrders.get(pairId);

  if (!order) {
    return jsonResponse({
      pairId,
      hasTPSL: false,
      takeProfitPrice: null,
      stopLossPrice: null,
    });
  }

  return jsonResponse({
    pairId,
    hasTPSL: true,
    trader: order.trader,
    token: order.token,
    isLong: order.isLong,
    takeProfitPrice: order.takeProfitPrice?.toString() || null,
    takeProfitTriggered: order.takeProfitTriggered,
    stopLossPrice: order.stopLossPrice?.toString() || null,
    stopLossTriggered: order.stopLossTriggered,
    executionStatus: order.executionStatus,
    executedAt: order.executedAt,
    executionPrice: order.executionPrice?.toString() || null,
    executionPnL: order.executionPnL?.toString() || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    display: {
      // P3-P2: 显示用 1e18 精度
      takeProfitPrice: order.takeProfitPrice ? `$${(Number(order.takeProfitPrice) / 1e18).toFixed(8)}` : "Not set",
      stopLossPrice: order.stopLossPrice ? `$${(Number(order.stopLossPrice) / 1e18).toFixed(8)}` : "Not set",
      executionPnL: order.executionPnL ? `$${(Number(order.executionPnL) / 1e18).toFixed(2)}` : null,
    },
  });
}

/**
 * 取消 TP/SL
 * DELETE /api/position/:pairId/tpsl
 * Body: { cancelType: "tp" | "sl" | "both" }
 */
async function handleCancelTPSL(req: Request, pairId: string): Promise<Response> {
  try {
    const body = await req.json();
    const { cancelType = "both", trader, signature } = body;

    // Verify trader identity (matches handleSetTPSL pattern)
    if (!trader) {
      return errorResponse("Missing trader address", 401);
    }
    const cancelMessage = `Cancel TPSL ${pairId} for ${(trader as string).toLowerCase()}`;
    const auth = await verifyTraderSignature(trader, signature, cancelMessage);
    if (!auth.valid) {
      return errorResponse(auth.error || "Authentication failed", 401);
    }

    // Verify the TP/SL order belongs to this trader
    const existing = tpslOrders.get(pairId);
    if (existing && existing.trader.toLowerCase() !== (trader as string).toLowerCase()) {
      return errorResponse("Not authorized to cancel this TP/SL", 403);
    }

    if (!["tp", "sl", "both"].includes(cancelType)) {
      return errorResponse('cancelType must be "tp", "sl", or "both"');
    }

    const success = cancelTakeProfitStopLoss(pairId, cancelType as "tp" | "sl" | "both");

    if (!success) {
      return errorResponse("TP/SL order not found");
    }

    return jsonResponse({
      success: true,
      pairId,
      cancelled: cancelType,
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * 获取所有 TP/SL 订单
 * GET /api/tpsl/orders
 */
async function handleGetAllTPSLOrders(): Promise<Response> {
  const orders = Array.from(tpslOrders.values()).map(order => ({
    pairId: order.pairId,
    trader: order.trader,
    token: order.token,
    isLong: order.isLong,
    takeProfitPrice: order.takeProfitPrice?.toString() || null,
    stopLossPrice: order.stopLossPrice?.toString() || null,
    executionStatus: order.executionStatus,
    createdAt: order.createdAt,
  }));

  return jsonResponse({
    count: orders.length,
    orders,
  });
}

// ============================================================
// Add/Remove Margin (追加/减少保证金) - Meme Perp P2 功能
// ============================================================

/**
 * 追加保证金结果
 */
interface AddMarginResult {
  success: boolean;
  pairId: string;
  addedAmount: bigint;
  newCollateral: bigint;
  newLeverage: number;
  newLiquidationPrice: bigint;
  reason?: string;
}

/**
 * 减少保证金结果
 */
interface RemoveMarginResult {
  success: boolean;
  pairId: string;
  removedAmount: bigint;
  newCollateral: bigint;
  newLeverage: number;
  newLiquidationPrice: bigint;
  maxRemovable: bigint;
  reason?: string;
}

/**
 * 追加保证金
 *
 * 效果:
 * 1. 增加仓位的保证金
 * 2. 降低有效杠杆
 * 3. 降低强平价格风险
 *
 * @param pairId 仓位 ID
 * @param amount 追加金额 (1e18 ETH)
 */
function addMarginToPosition(pairId: string, amount: bigint): AddMarginResult {
  // 查找仓位 — AUDIT-FIX ME-C09: 保存 trader 地址以便后续扣余额
  let position: Position | null = null;
  let positionTrader: string | null = null;
  for (const [trader, positions] of userPositions.entries()) {
    const found = positions.find(p => p.pairId === pairId);
    if (found) {
      position = found;
      positionTrader = trader;
      break;
    }
  }

  if (!position) {
    return {
      success: false,
      pairId,
      addedAmount: 0n,
      newCollateral: 0n,
      newLeverage: 0,
      newLiquidationPrice: 0n,
      reason: "Position not found",
    };
  }

  if (amount <= 0n) {
    return {
      success: false,
      pairId,
      addedAmount: 0n,
      newCollateral: BigInt(position.collateral),
      newLeverage: Number(position.leverage),
      newLiquidationPrice: BigInt(position.liquidationPrice),
      reason: "Amount must be positive",
    };
  }

  // AUDIT-FIX ME-C09: 从 trader 的 availableBalance 扣除追加金额
  const traderBalance = getUserBalance(positionTrader! as Address);
  if (traderBalance.availableBalance < amount) {
    return {
      success: false,
      pairId,
      addedAmount: 0n,
      newCollateral: BigInt(position.collateral),
      newLeverage: Number(position.leverage),
      newLiquidationPrice: BigInt(position.liquidationPrice),
      reason: `Insufficient balance: available=${Number(traderBalance.availableBalance) / 1e18}, required=${Number(amount) / 1e18}`,
    };
  }
  traderBalance.availableBalance -= amount;
  traderBalance.usedMargin = (traderBalance.usedMargin || 0n) + amount;
  // totalBalance 不变: available↓ + usedMargin↑ = 0 net

  // Queue on-chain margin deposit for the additional margin
  if (isPerpVaultEnabled()) {
    queueMarginDeposit(positionTrader! as Address, amount, undefined, position.token as Address);
  }

  const oldCollateral = BigInt(position.collateral);
  const newCollateral = oldCollateral + amount;

  // 计算新杠杆 = 仓位价值 / 新保证金
  const currentPrice = BigInt(position.markPrice);
  // position.size 已经是 ETH 名义价值 (1e18 精度)
  const positionValue = BigInt(position.size);
  // M-06 FIX: 全程 BigInt 计算杠杆 (1e4 basis points)，避免 Math.floor 截断
  const leverageBp = (positionValue * 10000n) / newCollateral;  // e.g. 58000 = 5.8x
  const newLeverage = Number(leverageBp) / 10000;  // e.g. 5.8

  // 更新仓位
  position.collateral = newCollateral.toString();
  position.margin = (newCollateral + BigInt(position.unrealizedPnL)).toString();
  position.leverage = newLeverage.toString();

  // 重新计算强平价格
  const entryPrice = BigInt(position.entryPrice);
  const mmr = BigInt(position.mmr);
  const newLiquidationPrice = calculateLiquidationPrice(
    entryPrice,
    leverageBp,
    position.isLong,
    mmr
  );
  position.liquidationPrice = newLiquidationPrice.toString();

  // 重新计算保证金率
  const newMarginRatio = positionValue > 0n
    ? Number((newCollateral * 10000n) / positionValue)
    : 10000;
  position.marginRatio = newMarginRatio.toString();

  position.updatedAt = Date.now();

  console.log(`[Margin] Added $${Number(amount) / 1e18} to ${pairId}. New collateral: $${Number(newCollateral) / 1e18}, leverage: ${newLeverage.toFixed(2)}x`);

  // Persist to Redis
  savePositionToRedis(position as any).catch(e =>
    console.error(`[Margin] Failed to save position to Redis after addMargin: ${e}`)
  );

  // 广播保证金更新
  broadcastMarginUpdate(position, "add", amount);

  return {
    success: true,
    pairId,
    addedAmount: amount,
    newCollateral,
    newLeverage,
    newLiquidationPrice,
  };
}

/**
 * 减少保证金
 *
 * 效果:
 * 1. 减少仓位的保证金
 * 2. 提高有效杠杆
 * 3. 提高强平价格风险
 *
 * 限制:
 * - 新杠杆不能超过最大杠杆 (100x)
 * - 新保证金率不能低于维持保证金率 × 1.5
 *
 * @param pairId 仓位 ID
 * @param amount 减少金额 (1e18 ETH)
 */
function removeMarginFromPosition(pairId: string, amount: bigint): RemoveMarginResult {
  // 查找仓位
  let position: Position | null = null;
  for (const [trader, positions] of userPositions.entries()) {
    const found = positions.find(p => p.pairId === pairId);
    if (found) {
      position = found;
      break;
    }
  }

  if (!position) {
    return {
      success: false,
      pairId,
      removedAmount: 0n,
      newCollateral: 0n,
      newLeverage: 0,
      newLiquidationPrice: 0n,
      maxRemovable: 0n,
      reason: "Position not found",
    };
  }

  const oldCollateral = BigInt(position.collateral);
  const currentPrice = BigInt(position.markPrice);
  // position.size 已经是 ETH 名义价值 (1e18 精度)
  const positionValue = BigInt(position.size);
  const mmr = BigInt(position.mmr);

  // 计算最大可减少金额
  // 限制1: 新杠杆 <= 100x -> 新保证金 >= 仓位价值 / 100
  const minCollateralForLeverage = positionValue / 100n;

  // 限制2: 新保证金率 >= MMR × 1.5 -> 新保证金 >= 仓位价值 × MMR × 1.5 / 10000
  const minCollateralForHealth = (positionValue * mmr * 15n) / 100000n;

  const minCollateral = minCollateralForLeverage > minCollateralForHealth
    ? minCollateralForLeverage
    : minCollateralForHealth;

  const maxRemovable = oldCollateral > minCollateral ? oldCollateral - minCollateral : 0n;

  if (amount <= 0n) {
    return {
      success: false,
      pairId,
      removedAmount: 0n,
      newCollateral: oldCollateral,
      newLeverage: Number(position.leverage),
      newLiquidationPrice: BigInt(position.liquidationPrice),
      maxRemovable,
      reason: "Amount must be positive",
    };
  }

  if (amount > maxRemovable) {
    return {
      success: false,
      pairId,
      removedAmount: 0n,
      newCollateral: oldCollateral,
      newLeverage: Number(position.leverage),
      newLiquidationPrice: BigInt(position.liquidationPrice),
      maxRemovable,
      reason: `Amount exceeds maximum removable. Max: $${Number(maxRemovable) / 1e18}`,
    };
  }

  const newCollateral = oldCollateral - amount;
  // M-06 FIX: 全程 BigInt 计算杠杆
  const leverageBp = (positionValue * 10000n) / newCollateral;
  const newLeverage = Number(leverageBp) / 10000;

  // 更新仓位
  position.collateral = newCollateral.toString();
  position.margin = (newCollateral + BigInt(position.unrealizedPnL)).toString();
  position.leverage = newLeverage.toString();

  // 重新计算强平价格
  const entryPrice = BigInt(position.entryPrice);
  const newLiquidationPrice = calculateLiquidationPrice(
    entryPrice,
    leverageBp,
    position.isLong,
    mmr
  );
  position.liquidationPrice = newLiquidationPrice.toString();

  // 重新计算保证金率
  const newMarginRatio = positionValue > 0n
    ? Number((newCollateral * 10000n) / positionValue)
    : 10000;
  position.marginRatio = newMarginRatio.toString();

  position.updatedAt = Date.now();

  console.log(`[Margin] Removed $${Number(amount) / 1e18} from ${pairId}. New collateral: $${Number(newCollateral) / 1e18}, leverage: ${newLeverage.toFixed(2)}x`);

  // Persist to Redis
  savePositionToRedis(position as any).catch(e =>
    console.error(`[Margin] Failed to save position to Redis after removeMargin: ${e}`)
  );

  // 广播保证金更新
  broadcastMarginUpdate(position, "remove", amount);

  return {
    success: true,
    pairId,
    removedAmount: amount,
    newCollateral,
    newLeverage,
    newLiquidationPrice,
    maxRemovable: maxRemovable - amount,
  };
}

/**
 * 获取可调整保证金信息
 */
function getMarginAdjustmentInfo(pairId: string): {
  pairId: string;
  currentCollateral: bigint;
  currentLeverage: number;
  maxRemovable: bigint;
  minCollateral: bigint;
  positionValue: bigint;
} | null {
  let position: Position | null = null;
  for (const [trader, positions] of userPositions.entries()) {
    const found = positions.find(p => p.pairId === pairId);
    if (found) {
      position = found;
      break;
    }
  }

  if (!position) return null;

  const currentCollateral = BigInt(position.collateral);
  const currentPrice = BigInt(position.markPrice);
  const entryPrice = BigInt(position.entryPrice);
  // position.size 已经是 ETH 名义价值 (1e18 精度)
  const positionValue = BigInt(position.size);
  const mmr = BigInt(position.mmr);

  const minCollateralForLeverage = positionValue / 100n;
  const minCollateralForHealth = (positionValue * mmr * 15n) / 100000n;
  const minCollateral = minCollateralForLeverage > minCollateralForHealth
    ? minCollateralForLeverage
    : minCollateralForHealth;

  // ── 行业标准 (Binance/Bybit): 扣除未实现浮亏 ──
  // maxRemovable = max(0, collateral - minCollateral - max(0, unrealizedLoss))
  // GMX PnL: delta = size * |currentPrice - avgPrice| / avgPrice
  let unrealizedLoss = 0n;
  if (entryPrice > 0n) {
    const priceDiffAbs = currentPrice > entryPrice ? currentPrice - entryPrice : entryPrice - currentPrice;
    const pnlDelta = (positionValue * priceDiffAbs) / entryPrice;
    const hasProfit = position.isLong ? (currentPrice > entryPrice) : (entryPrice > currentPrice);
    if (!hasProfit) {
      unrealizedLoss = pnlDelta; // 浮亏为正数
    }
  }
  const effectiveMinCollateral = minCollateral + unrealizedLoss;
  const maxRemovable = currentCollateral > effectiveMinCollateral ? currentCollateral - effectiveMinCollateral : 0n;

  return {
    pairId,
    currentCollateral,
    currentLeverage: Number(position.leverage),
    maxRemovable,
    minCollateral,
    positionValue,
  };
}

/**
 * 广播保证金更新事件
 */
function broadcastMarginUpdate(position: Position, action: "add" | "remove", amount: bigint): void {
  // AUDIT-FIX H-02: Send only to the trader's own WS clients (not all clients)
  const message = JSON.stringify({
    type: "margin_updated",
    pairId: position.pairId,
    trader: position.trader,
    token: position.token,
    action,
    amount: amount.toString(),
    newCollateral: position.collateral,
    newLeverage: position.leverage,
    newLiquidationPrice: position.liquidationPrice,
    timestamp: Date.now(),
  });

  const trader = position.trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(trader);
  if (wsSet) {
    for (const client of wsSet) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }
}

// ============================================================
// AUDIT-FIX ME-C08: HTTP handlers for margin adjustment API
// These were referenced in the router but never defined, causing crashes
// ============================================================

/**
 * GET /api/position/:pairId/margin — 获取保证金调整信息
 */
async function handleGetMarginInfo(pairId: string): Promise<Response> {
  const info = getMarginAdjustmentInfo(pairId);
  if (!info) {
    return errorResponse("Position not found", 404);
  }
  return jsonResponse({
    success: true,
    data: {
      pairId: info.pairId,
      currentCollateral: info.currentCollateral.toString(),
      currentLeverage: info.currentLeverage,
      maxRemovable: info.maxRemovable.toString(),
      minCollateral: info.minCollateral.toString(),
      positionValue: info.positionValue.toString(),
    },
  });
}

/**
 * POST /api/position/:pairId/margin/add — 追加保证金
 */
async function handleAddMargin(req: Request, pairId: string): Promise<Response> {
  try {
    const { amount, trader, signature } = await req.json();
    if (!amount || !trader) {
      return errorResponse("Missing required fields: amount, trader");
    }

    // 验证签名
    const authMsg = `Add margin ${amount} to ${pairId} for ${trader.toLowerCase()}`;
    const auth = await verifyTraderSignature(trader, signature, authMsg);
    if (!auth.valid) {
      return errorResponse(auth.error || "Authentication failed", 401);
    }

    const normalizedTrader = (trader as string).toLowerCase();
    const result = await withLock(`position:${normalizedTrader}`, 10000, async () => {
      return addMarginToPosition(pairId, BigInt(amount));
    });

    if (!result.success) {
      return errorResponse(result.reason || "Failed to add margin");
    }
    return jsonResponse({
      success: true,
      data: {
        pairId: result.pairId,
        addedAmount: result.addedAmount.toString(),
        newCollateral: result.newCollateral.toString(),
        newLeverage: result.newLeverage,
        newLiquidationPrice: result.newLiquidationPrice.toString(),
      },
    });
  } catch (e: any) {
    return errorResponse(e.message || "Internal error");
  }
}

/**
 * POST /api/position/:pairId/margin/remove — 减少保证金
 */
async function handleRemoveMargin(req: Request, pairId: string): Promise<Response> {
  try {
    const { amount, trader, signature } = await req.json();
    if (!amount || !trader) {
      return errorResponse("Missing required fields: amount, trader");
    }

    // 验证签名
    const authMsg = `Remove margin ${amount} from ${pairId} for ${trader.toLowerCase()}`;
    const auth = await verifyTraderSignature(trader, signature, authMsg);
    if (!auth.valid) {
      return errorResponse(auth.error || "Authentication failed", 401);
    }

    const normalizedTrader = (trader as string).toLowerCase() as Address;
    const result = await withLock(`position:${normalizedTrader}`, 10000, async () => {
      return removeMarginFromPosition(pairId, BigInt(amount));
    });

    if (!result.success) {
      return errorResponse(result.reason || "Failed to remove margin");
    }

    // AUDIT-FIX: 减少的保证金应返还 trader 的 availableBalance
    const balance = getUserBalance(normalizedTrader);
    balance.availableBalance += BigInt(amount);
    balance.usedMargin = (balance.usedMargin || 0n) - BigInt(amount);
    if (balance.usedMargin < 0n) balance.usedMargin = 0n;

    // Queue on-chain margin withdrawal: PerpVault → derived wallet
    if (isPerpVaultEnabled()) {
      queueMarginWithdraw(normalizedTrader, BigInt(amount));
    }

    return jsonResponse({
      success: true,
      data: {
        pairId: result.pairId,
        removedAmount: result.removedAmount.toString(),
        newCollateral: result.newCollateral.toString(),
        newLeverage: result.newLeverage,
        newLiquidationPrice: result.newLiquidationPrice.toString(),
        maxRemovable: result.maxRemovable.toString(),
      },
    });
  } catch (e: any) {
    return errorResponse(e.message || "Internal error");
  }
}

// ============================================================
// P5: Referral System API Handlers
// ============================================================

/**
 * 注册成为推荐人 (获取邀请码)
 * POST /api/referral/register
 */
async function handleRegisterReferrer(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { address } = body;

    if (!address) {
      return errorResponse("Missing address");
    }

    const result = registerAsReferrer(address as Address);

    if ("error" in result) {
      return errorResponse(result.error);
    }

    return jsonResponse({
      success: true,
      referrer: {
        address: result.address,
        code: result.code,
        referralCount: result.level1Referrals.length,
        totalEarnings: result.totalEarnings.toString(),
        createdAt: result.createdAt,
      },
      message: `Your referral code is: ${result.code}`,
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * 绑定邀请码
 * POST /api/referral/bind
 */
async function handleBindReferral(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { address, referralCode } = body;

    if (!address || !referralCode) {
      return errorResponse("Missing address or referralCode");
    }

    const result = bindReferral(address as Address, referralCode);

    if (!result.success) {
      return errorResponse(result.error || "Failed to bind referral");
    }

    const referee = getRefereeInfo(address as Address);

    return jsonResponse({
      success: true,
      referee: referee ? {
        address: referee.address,
        referrer: referee.referrer,
        referralCode: referee.referrerCode,
        joinedAt: referee.joinedAt,
      } : null,
      message: "Successfully bound to referrer",
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * 获取推荐人信息
 * GET /api/referral/referrer?address=0x...
 */
async function handleGetReferrer(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");

  if (!address) {
    return errorResponse("Missing address parameter");
  }

  const referrer = getReferrerInfo(address as Address);

  if (!referrer) {
    return jsonResponse({
      isReferrer: false,
      message: "Not a registered referrer. Call POST /api/referral/register to get a referral code.",
    });
  }

  return jsonResponse({
    isReferrer: true,
    referrer: {
      address: referrer.address,
      code: referrer.code,
      level1Referrals: referrer.level1Referrals.length,
      level2Referrals: referrer.level2Referrals.length,
      totalEarnings: referrer.totalEarnings.toString(),
      pendingEarnings: referrer.pendingEarnings.toString(),
      withdrawnEarnings: referrer.withdrawnEarnings.toString(),
      level1Earnings: referrer.level1Earnings.toString(),
      level2Earnings: referrer.level2Earnings.toString(),
      totalTradesReferred: referrer.totalTradesReferred,
      totalVolumeReferred: referrer.totalVolumeReferred.toString(),
      createdAt: referrer.createdAt,
      display: {
        totalEarnings: `$${(Number(referrer.totalEarnings) / 1e18).toFixed(2)}`,
        pendingEarnings: `$${(Number(referrer.pendingEarnings) / 1e18).toFixed(2)}`,
        withdrawnEarnings: `$${(Number(referrer.withdrawnEarnings) / 1e18).toFixed(2)}`,
        level1Earnings: `$${(Number(referrer.level1Earnings) / 1e18).toFixed(2)}`,
        level2Earnings: `$${(Number(referrer.level2Earnings) / 1e18).toFixed(2)}`,
        totalVolumeReferred: `$${(Number(referrer.totalVolumeReferred) / 1e18).toFixed(2)}`,
      },
    },
  });
}

/**
 * 获取被邀请人信息
 * GET /api/referral/referee?address=0x...
 */
async function handleGetReferee(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");

  if (!address) {
    return errorResponse("Missing address parameter");
  }

  const referee = getRefereeInfo(address as Address);

  if (!referee) {
    return jsonResponse({
      isReferred: false,
      message: "Not referred by anyone. Use POST /api/referral/bind to bind a referral code.",
    });
  }

  return jsonResponse({
    isReferred: true,
    referee: {
      address: referee.address,
      referrer: referee.referrer,
      referralCode: referee.referrerCode,
      level2Referrer: referee.level2Referrer,
      totalFeesPaid: referee.totalFeesPaid.toString(),
      totalCommissionGenerated: referee.totalCommissionGenerated.toString(),
      joinedAt: referee.joinedAt,
      display: {
        totalFeesPaid: `$${(Number(referee.totalFeesPaid) / 1e18).toFixed(2)}`,
        totalCommissionGenerated: `$${(Number(referee.totalCommissionGenerated) / 1e18).toFixed(2)}`,
      },
    },
  });
}

/**
 * 获取返佣记录
 * GET /api/referral/commissions?address=0x...&limit=50
 */
async function handleGetCommissions(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  const limit = parseInt(url.searchParams.get("limit") || "50");

  if (!address) {
    return errorResponse("Missing address parameter");
  }

  const commissions = getReferrerCommissions(address as Address, limit);

  return jsonResponse({
    count: commissions.length,
    commissions: commissions.map(c => ({
      id: c.id,
      referee: c.referee,
      level: c.level,
      tradeId: c.tradeId,
      tradeFee: c.tradeFee.toString(),
      commissionAmount: c.commissionAmount.toString(),
      commissionRate: c.commissionRate,
      timestamp: c.timestamp,
      status: c.status,
      display: {
        tradeFee: `$${(Number(c.tradeFee) / 1e18).toFixed(4)}`,
        commissionAmount: `$${(Number(c.commissionAmount) / 1e18).toFixed(4)}`,
        commissionRate: `${c.commissionRate / 100}%`,
      },
    })),
  });
}

/**
 * 提取返佣
 * POST /api/referral/withdraw
 */
async function handleWithdrawCommission(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { address, amount, signature } = body;

    if (!address) {
      return errorResponse("Missing address");
    }

    const normalizedAddress = (address as string).toLowerCase() as Address;

    // CR-1: 鉴权 — 验证提现请求确实来自钱包持有者
    const withdrawAmount = amount ? BigInt(amount) : undefined;
    const withdrawMessage = `Withdraw commission${withdrawAmount ? ` ${withdrawAmount}` : ""} for ${normalizedAddress}`;
    const auth = await verifyTraderSignature(address, signature, withdrawMessage);
    if (!auth.valid) {
      return errorResponse(auth.error || "Authentication failed", 401);
    }

    // CR-2: withLock 防止并发提现导致双倍支付
    const result = await withLock(
      `referral:withdraw:${normalizedAddress}`,
      15000,
      async () => {
        return withdrawCommission(normalizedAddress, withdrawAmount);
      }
    );

    if (!result.success) {
      return errorResponse(result.error || "Failed to withdraw");
    }

    const referrer = getReferrerInfo(normalizedAddress);

    return jsonResponse({
      success: true,
      withdrawnAmount: result.withdrawnAmount?.toString(),
      remainingPending: referrer?.pendingEarnings.toString(),
      display: {
        withdrawnAmount: `$${(Number(result.withdrawnAmount || 0n) / 1e18).toFixed(2)}`,
        remainingPending: referrer ? `$${(Number(referrer.pendingEarnings) / 1e18).toFixed(2)}` : "$0.00",
      },
    });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 500);
  }
}

/**
 * 获取推荐排行榜
 * GET /api/referral/leaderboard?limit=20
 */
async function handleGetReferralLeaderboard(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") || "20");

  const leaderboard = getReferralLeaderboard(limit);

  return jsonResponse({
    leaderboard: leaderboard.map((entry, index) => ({
      rank: index + 1,
      address: entry.address,
      code: entry.code,
      referralCount: entry.referralCount,
      totalEarnings: entry.totalEarnings.toString(),
      display: {
        totalEarnings: `$${(Number(entry.totalEarnings) / 1e18).toFixed(2)}`,
      },
    })),
  });
}

/**
 * 获取全局推荐统计
 * GET /api/referral/stats
 */
async function handleGetReferralStats(): Promise<Response> {
  const stats = getReferralStats();

  return jsonResponse({
    totalReferrers: stats.totalReferrers,
    totalReferees: stats.totalReferees,
    totalCommissionsPaid: stats.totalCommissionsPaid.toString(),
    totalCommissionsPending: stats.totalCommissionsPending.toString(),
    config: {
      level1Rate: REFERRAL_CONFIG.level1Rate,
      level2Rate: REFERRAL_CONFIG.level2Rate,
      minWithdrawAmount: REFERRAL_CONFIG.minWithdrawAmount.toString(),
    },
    display: {
      totalCommissionsPaid: `$${(Number(stats.totalCommissionsPaid) / 1e18).toFixed(2)}`,
      totalCommissionsPending: `$${(Number(stats.totalCommissionsPending) / 1e18).toFixed(2)}`,
      level1Rate: `${REFERRAL_CONFIG.level1Rate / 100}%`,
      level2Rate: `${REFERRAL_CONFIG.level2Rate / 100}%`,
      minWithdrawAmount: `$${Number(REFERRAL_CONFIG.minWithdrawAmount) / 1e18}`,
    },
  });
}

/**
 * 通过邀请码查询推荐人
 * GET /api/referral/code/:code
 */
async function handleGetReferrerByCode(code: string): Promise<Response> {
  const upperCode = code.toUpperCase();
  const referrerAddress = referralCodes.get(upperCode);

  if (!referrerAddress) {
    return jsonResponse({
      valid: false,
      message: "Invalid referral code",
    });
  }

  const referrer = getReferrerInfo(referrerAddress);

  return jsonResponse({
    valid: true,
    code: upperCode,
    referrer: referrer ? {
      address: referrer.address,
      referralCount: referrer.level1Referrals.length,
      createdAt: referrer.createdAt,
    } : null,
  });
}

// ============================================================
// [模式 2] Batch Submission Loop - DISABLED
// ============================================================
// 旧模式: 定期将未结算的 matches 批量提交到链上
// 新模式: 不提交到链上，matches 存 submittedMatches 用于 Merkle 快照

async function runBatchSubmissionLoop(): Promise<void> {
  console.log("[Batch] Mode 2: On-chain batch submission DISABLED");
  console.log("[Batch] Mode 2: Matches are tracked in memory for Merkle snapshots");
}

// ============================================================
// Request Router
// ============================================================

async function handleRequest(req: Request): Promise<Response> {
  totalRequestCount++;
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // Enhanced health check
  if (path === "/health") {
    const { isRedisConnected } = await import("./database/redis");
    const redisOk = isRedisConnected();
    const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
    const memUsage = process.memoryUsage();
    const status = redisOk ? "ok" : "degraded";

    const body = {
      status,
      uptime: uptimeSeconds,
      services: {
        redis: redisOk ? "connected" : "disconnected",
        redisErrors: { total: redisErrorCount, last60s: redisErrorCountWindow },
      },
      metrics: {
        memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        totalRequests: totalRequestCount,
        totalOrders: totalOrdersSubmitted,
        pendingMatches: engine.getPendingMatches().length,
        mapSizes: {
          graduatedTokens: graduatedTokens.size,
          userNonces: userNonces.size,
          userTrades: userTrades.size,
          userPositions: userPositions.size,
        },
      },
      oiCircuitBreakers: getCircuitBreakerStatus(),
      engineTotalOI: getEngineTotalOI().toString(),
    };

    return new Response(JSON.stringify(body), {
      status: redisOk ? 200 : 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Prometheus metrics endpoint
  if (path === "/metrics") {
    const { isRedisConnected } = await import("./database/redis");
    const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
    const memUsage = process.memoryUsage();

    const metrics = [
      `# HELP memeperp_uptime_seconds Server uptime in seconds`,
      `# TYPE memeperp_uptime_seconds gauge`,
      `memeperp_uptime_seconds ${uptimeSeconds}`,
      `# HELP memeperp_requests_total Total HTTP requests handled`,
      `# TYPE memeperp_requests_total counter`,
      `memeperp_requests_total ${totalRequestCount}`,
      `# HELP memeperp_orders_submitted_total Total orders submitted`,
      `# TYPE memeperp_orders_submitted_total counter`,
      `memeperp_orders_submitted_total ${totalOrdersSubmitted}`,
      `# HELP memeperp_redis_connected Whether Redis is connected (1=yes, 0=no)`,
      `# TYPE memeperp_redis_connected gauge`,
      `memeperp_redis_connected ${isRedisConnected() ? 1 : 0}`,
      `# HELP process_heap_bytes Process heap memory in bytes`,
      `# TYPE process_heap_bytes gauge`,
      `process_heap_bytes ${memUsage.heapUsed}`,
      `# HELP memeperp_pending_matches Number of pending order matches`,
      `# TYPE memeperp_pending_matches gauge`,
      `memeperp_pending_matches ${engine.getPendingMatches().length}`,
      // ── Snapshot health ──
      `# HELP memeperp_snapshot_total Total Merkle snapshots created`,
      `# TYPE memeperp_snapshot_total counter`,
      `memeperp_snapshot_total ${getSnapshotJobStatus().totalSnapshots}`,
      `# HELP memeperp_snapshot_last_time_seconds Last snapshot Unix timestamp`,
      `# TYPE memeperp_snapshot_last_time_seconds gauge`,
      `memeperp_snapshot_last_time_seconds ${Math.floor(getSnapshotJobStatus().lastSnapshotTime / 1000)}`,
      // ── Price staleness ──
      `# HELP memeperp_price_stale_tokens Number of tokens with stale prices`,
      `# TYPE memeperp_price_stale_tokens gauge`,
      `memeperp_price_stale_tokens ${SUPPORTED_TOKENS.filter(t => isPriceStale(t)).length}`,
      // ── Withdrawal reconciliation ──
      `# HELP memeperp_pending_withdrawals Number of pending withdrawal reconciliations`,
      `# TYPE memeperp_pending_withdrawals gauge`,
      `memeperp_pending_withdrawals ${pendingWithdrawalMode2s.size}`,
      // ── User/position counts ──
      `# HELP memeperp_user_balances Number of tracked user balances`,
      `# TYPE memeperp_user_balances gauge`,
      `memeperp_user_balances ${userBalances.size}`,
      `# HELP memeperp_user_positions Number of users with open positions`,
      `# TYPE memeperp_user_positions gauge`,
      `memeperp_user_positions ${userPositions.size}`,
    ].join("\n");

    return new Response(metrics + "\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  }

  // 查询毕业代币信息 (价格源切换状态)
  if (path === "/api/graduated-tokens" && method === "GET") {
    const result: Record<string, { pairAddress: string; priceSource: string }> = {};
    for (const [token, info] of graduatedTokens.entries()) {
      result[token] = {
        pairAddress: info.pairAddress,
        priceSource: "uniswap_v2",
      };
    }
    return jsonResponse({
      success: true,
      graduatedCount: graduatedTokens.size,
      totalTokens: SUPPORTED_TOKENS.length,
      tokens: result,
    });
  }

  // ============================================================
  // Mode 2 APIs (Merkle Snapshots + Withdrawal Authorization)
  // ============================================================

  // Get snapshot status
  if (path === "/api/v2/snapshot/status" && method === "GET") {
    const status = getSnapshotJobStatus();
    return jsonResponse({
      success: true,
      ...status,
    });
  }

  // Get Merkle proof for a user
  if (path === "/api/v2/snapshot/proof" && method === "GET") {
    const user = url.searchParams.get("user") as Address;
    if (!user) {
      return errorResponse("Missing user parameter");
    }
    let proof = getUserProof(user);
    // On-demand snapshot: if user has no proof, generate one immediately
    if (!proof) {
      try {
        await runSnapshotCycle({ submitToChain: true });
        proof = getUserProof(user);
      } catch (e) {
        console.error(`[Snapshot:Proof] On-demand snapshot failed:`, e);
      }
    }
    if (!proof) {
      return errorResponse("No proof available for user");
    }
    return jsonResponse({
      success: true,
      proof: {
        user: proof.user,
        equity: proof.equity.toString(),
        merkleProof: proof.proof,
        leaf: proof.leaf,
        root: proof.root,
      },
    });
  }

  // Request withdrawal authorization
  // AUDIT-FIX CR-01: Add authentication + balance deduction
  if (path === "/api/v2/withdraw/request" && method === "POST") {
    try {
      const body = await req.json();
      const { user, amount, signature, nonce: authNonce, deadline: authDeadline } = body;
      if (!user || !amount) {
        return errorResponse("Missing user or amount");
      }

      const normalizedUser = (user as string).toLowerCase() as Address;
      const withdrawAmount = BigInt(amount);

      // CR-01 FIX: Require signature authentication — verify the requester IS the user
      if (!signature || !authNonce || !authDeadline) {
        return errorResponse("Authentication required: signature, nonce, deadline", 401);
      }
      if (!SKIP_SIGNATURE_VERIFY) {
        const authResult = await verifyAuthSignature(
          normalizedUser,
          BigInt(authNonce),
          BigInt(authDeadline),
          signature as Hex
        );
        if (!authResult.valid) {
          return errorResponse("Invalid authentication signature", 401);
        }
      }

      // CR-01 FIX: Check and deduct user balance BEFORE generating signature
      const balance = getUserBalance(normalizedUser);
      if (!balance || balance.availableBalance < withdrawAmount) {
        const avail = balance ? balance.availableBalance.toString() : "0";
        return errorResponse(`Insufficient balance: available=${avail}, requested=${withdrawAmount.toString()}`);
      }

      // Ensure Merkle proof exists — generate on-demand if missing
      let existingProofV2 = getUserProof(normalizedUser);
      if (!existingProofV2) {
        console.log(`[Withdraw:V2] No snapshot proof for ${normalizedUser.slice(0, 10)} — generating on-demand snapshot...`);
        try {
          const snapshot = await runSnapshotCycle({ submitToChain: true });
          if (snapshot) {
            console.log(`[Withdraw:V2] On-demand snapshot created: root=${snapshot.root.slice(0, 18)}, users=${snapshot.equities.length}`);
            existingProofV2 = getUserProof(normalizedUser);
          }
        } catch (e) {
          console.error(`[Withdraw:V2] On-demand snapshot failed:`, e);
        }
        if (!existingProofV2) {
          return errorResponse("No equity snapshot available for user — snapshot generation failed");
        }
      }

      // Deduct balance atomically (freeze the withdrawal amount)
      balance.availableBalance -= withdrawAmount;
      balance.frozenMargin = (balance.frozenMargin || 0n) + withdrawAmount;

      const result = await requestWithdrawal(normalizedUser, withdrawAmount);
      if (!result.success) {
        // Rollback balance deduction on failure
        balance.availableBalance += withdrawAmount;
        balance.frozenMargin = (balance.frozenMargin || 0n) - withdrawAmount;
        return errorResponse(result.error || "Withdrawal request failed");
      }

      console.log(`[Withdraw] CR-01 FIX: Authenticated withdrawal for ${normalizedUser.slice(0, 10)}, amount=${withdrawAmount.toString()}, balance deducted`);

      // Include userEquity from Merkle proof — needed by SettlementV2.withdraw()
      const proof = getUserProof(normalizedUser);
      const userEquity = proof?.equity ?? 0n;

      return jsonResponse({
        success: true,
        authorization: {
          user: result.authorization!.user,
          amount: result.authorization!.amount.toString(),
          userEquity: userEquity.toString(),
          nonce: result.authorization!.nonce.toString(),
          deadline: result.authorization!.deadline,
          merkleRoot: result.authorization!.merkleRoot,
          merkleProof: result.authorization!.merkleProof,
          signature: result.authorization!.signature,
        },
      });
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : "Unknown error");
    }
  }

  // Get withdraw module status
  if (path === "/api/v2/withdraw/status" && method === "GET") {
    const status = getWithdrawModuleStatus();
    return jsonResponse({
      success: true,
      ...status,
    });
  }

  // Redis status check (internal only)
  if (path === "/api/redis/status") {
    const expectedKey = process.env.INTERNAL_API_KEY;
    const providedKey = req.headers.get("x-api-key");
    if (!expectedKey || providedKey !== expectedKey) {
      return errorResponse("Unauthorized", 401);
    }
    const connected = db.isConnected();
    const positionCount = await PositionRepo.getAll().then(p => p.length).catch(() => 0);
    return jsonResponse({
      connected,
      positionCount,
      message: connected ? "Redis connected" : "Redis not connected",
    });
  }

  // Test Redis write (internal only, for debugging)
  if (path === "/api/redis/test" && method === "POST") {
    const expectedKey = process.env.INTERNAL_API_KEY;
    const providedKey = req.headers.get("x-api-key");
    if (!expectedKey || providedKey !== expectedKey) {
      return errorResponse("Unauthorized", 401);
    }
    if (!db.isConnected()) {
      return errorResponse("Redis not connected");
    }
    try {
      const testPosition = await PositionRepo.create({
        pairId: `test_${Date.now()}`,
        trader: "0x0000000000000000000000000000000000000001" as Address,
        token: "0x0000000000000000000000000000000000000002" as Address,
        counterparty: "0x0000000000000000000000000000000000000000" as Address,
        isLong: true,
        size: 1000000000000000000n,
        entryPrice: 100000000n,
        averageEntryPrice: 100000000n,
        leverage: 100000n,
        marginMode: 0,
        markPrice: 100000000n,
        liquidationPrice: 0n,
        bankruptcyPrice: 0n,
        breakEvenPrice: 0n,
        collateral: 10000000n,
        margin: 10000000n,
        marginRatio: 10000n,
        mmr: 200n,
        maintenanceMargin: 500000n,
        unrealizedPnL: 0n,
        realizedPnL: 0n,
        roe: 0n,
        accumulatedFunding: 0n,
        takeProfitPrice: null,
        stopLossPrice: null,
        adlRanking: 1,
        adlScore: 0n,
        riskLevel: "low" as const,
        isLiquidatable: false,
        isAdlCandidate: false,
        status: 0,
        fundingIndex: 0n,
        isLiquidating: false,
      } as any);
      // Delete test position immediately
      await PositionRepo.delete(testPosition.id);
      return jsonResponse({
        success: true,
        message: "Redis write test passed",
        testId: testPosition.id,
      });
    } catch (error) {
      return errorResponse(`Redis write test failed: ${error}`);
    }
  }

  // API routes

  // ============================================================
  // Authentication API (P2)
  // ============================================================

  // Get nonce for login
  if (path === "/api/v1/auth/nonce" && method === "POST") {
    return handleGetAuthNonce(req);
  }

  // Login with wallet signature
  if (path === "/api/v1/auth/login" && method === "POST") {
    return handleAuthLogin(req);
  }

  // ============================================================
  // Token Metadata API (P2)
  // ============================================================

  // Create or update token metadata
  if (path === "/api/v1/token/metadata" && method === "POST") {
    return handleSaveTokenMetadata(req);
  }

  // Get single token metadata
  if (path === "/api/v1/token/metadata" && method === "GET") {
    const instId = url.searchParams.get("instId");
    if (!instId) {
      return errorResponse("Missing instId parameter", 400);
    }
    return handleGetTokenMetadata(instId);
  }

  // Get all token metadata
  if (path === "/api/v1/token/metadata/all" && method === "GET") {
    return handleGetAllTokenMetadata();
  }

  // ── Token info cache (name/symbol from memory, no RPC needed) ──
  // GET /api/v1/tokens/info - returns all cached token name/symbol pairs
  // GET /api/v1/tokens/info?address=0x... - returns single token info
  if (path === "/api/v1/tokens/info" && method === "GET") {
    const addressParam = url.searchParams.get("address");
    if (addressParam) {
      const info = TOKEN_INFO_CACHE.get(addressParam.toLowerCase());
      return jsonResponse({
        code: "0",
        data: info || null,
      });
    }
    // Return all cached token info
    const allInfo: Record<string, { name: string; symbol: string }> = {};
    for (const [addr, info] of TOKEN_INFO_CACHE) {
      allInfo[addr] = info;
    }
    return jsonResponse({
      code: "0",
      data: allInfo,
    });
  }

  // ============================================================
  // Token Holders API
  // ============================================================

  // Get token holders distribution
  if (path.startsWith("/api/v1/spot/holders/") && method === "GET") {
    const token = path.split("/").pop();
    if (!token || !token.startsWith("0x")) {
      return errorResponse("Invalid token address", 400);
    }
    const limit = parseInt(url.searchParams.get("limit") || "10");
    const includePnl = url.searchParams.get("includePnl") === "true";
    try {
      const result = await getTokenHolders(token as Address, limit, includePnl);
      return jsonResponse(result);
    } catch (error: any) {
      console.error("[Holders API] Error:", error);
      return jsonResponse({
        success: false,
        holders: [],
        total_holders: 0,
        top10_percentage: 0,
        concentration_risk: "LOW",
        error: error.message,
      });
    }
  }

  // ============================================================
  // FOMO Events & Leaderboard API (P2)
  // ============================================================

  // Get recent FOMO events
  if (path === "/api/fomo/events" && method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") || "20");
    return handleGetFomoEvents(limit);
  }

  // Get global leaderboard
  if (path === "/api/leaderboard/global" && method === "GET") {
    const sortBy = (url.searchParams.get("sortBy") || "pnl") as "pnl" | "volume" | "wins";
    const limit = parseInt(url.searchParams.get("limit") || "10");
    return handleGetGlobalLeaderboard(sortBy, limit);
  }

  // Get token-specific leaderboard
  if (path.match(/^\/api\/leaderboard\/token\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[4] as Address;
    const sortBy = (url.searchParams.get("sortBy") || "pnl") as "pnl" | "volume" | "wins";
    const limit = parseInt(url.searchParams.get("limit") || "10");
    return handleGetTokenLeaderboard(token, sortBy, limit);
  }

  // Get trader stats
  if (path.match(/^\/api\/trader\/0x[a-fA-F0-9]+\/stats$/) && method === "GET") {
    const trader = path.split("/")[3] as Address;
    return handleGetTraderStats(trader);
  }

  // ============================================================
  // Relay Service API (P2)
  // ============================================================

  // Get relay service status
  if (path === "/api/v1/relay/status" && method === "GET") {
    return handleGetRelayStatus();
  }

  // Get user's meta-tx nonce
  if (path.match(/^\/api\/v1\/relay\/nonce\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const user = path.split("/")[5] as Address;
    return handleGetMetaTxNonce(user);
  }

  // Get user's Settlement balance (Relay API)
  if (path.match(/^\/api\/v1\/relay\/balance\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const user = path.split("/")[5] as Address;
    return handleGetRelayUserBalance(user);
  }

  // Relay depositFor (SettlementV2 ERC-20 collateral)
  if (path === "/api/v1/relay/deposit" && method === "POST") {
    return handleRelayDeposit(req);
  }

  // Market data endpoints (OKX format)
  if (path === "/api/v1/market/tickers" && method === "GET") {
    return handleGetTickers();
  }

  if (path === "/api/v1/market/ticker" && method === "GET") {
    const instId = url.searchParams.get("instId");
    if (!instId) {
      return jsonResponse({ code: "1", msg: "instId required" }, 400);
    }
    return handleGetTicker(instId);
  }

  if (path === "/api/v1/market/trades" && method === "GET") {
    const instId = url.searchParams.get("instId");
    const limit = parseInt(url.searchParams.get("limit") || "100");
    if (!instId) {
      return jsonResponse({ code: "1", msg: "instId required" }, 400);
    }
    return handleGetMarketTrades(instId, limit);
  }

  // Order Book (OKX format) - /api/v1/market/books
  if (path === "/api/v1/market/books" && method === "GET") {
    const instId = url.searchParams.get("instId");
    if (!instId) {
      return jsonResponse({ code: "1", msg: "instId required" }, 400);
    }
    const token = instId.split("-")[0] as Address;
    return handleGetOrderBook(token);
  }

  // Mark Price (OKX format) - /api/v1/market/mark-price
  if (path === "/api/v1/market/mark-price" && method === "GET") {
    const instId = url.searchParams.get("instId");
    // 如果没有指定 instId，返回所有代币的标记价格
    const tokens = instId ? [instId.split("-")[0] as Address] : engine.getSupportedTokens();
    const markPrices = tokens.map(token => {
      const ob = engine.getOrderBook(token);
      const currentPrice = ob.getCurrentPrice();
      return {
        instId: `${token}-ETH`,
        markPx: currentPrice.toString(),
        ts: Date.now(),
      };
    });
    return jsonResponse({ code: "0", msg: "success", data: markPrices });
  }

  // Funding Rate (OKX format) - /api/v1/market/funding-rate
  if (path === "/api/v1/market/funding-rate" && method === "GET") {
    const instId = url.searchParams.get("instId");
    if (!instId) {
      return jsonResponse({ code: "1", msg: "instId required" }, 400);
    }
    const token = instId.split("-")[0] as Address;
    return handleGetFundingRate(token);
  }

  // 前端充值/提现后同步链上余额
  // M-05 FIX: 需要 EIP-191 签名鉴权 (防止 DoS — 每次调用触发链上 RPC)
  if (path === "/api/balance/sync" && method === "POST") {
    try {
      const { trader, signature, authNonce, authDeadline } = await req.json();
      if (!trader) return errorResponse("Missing trader");
      const normalizedTrader = (trader as string).toLowerCase() as Address;

      // 鉴权: 只允许用户同步自己的余额
      if (signature && authNonce !== undefined && authDeadline) {
        const authResult = await verifyAuthSignature(normalizedTrader, BigInt(authNonce), BigInt(authDeadline), signature as Hex);
        if (!authResult.valid) {
          return errorResponse(`Authentication failed: ${authResult.error}`, 401);
        }
      } else {
        return errorResponse("Authentication required: signature, authNonce, authDeadline", 401);
      }

      await syncUserBalanceFromChain(normalizedTrader);
      broadcastBalanceUpdate(normalizedTrader);
      return jsonResponse({ success: true });
    } catch (e: any) {
      return errorResponse(e.message || "Failed to sync balance");
    }
  }

  // 后端辅助提现: 用 session key 签名 Settlement.withdraw + ERC20 transfer 回主钱包
  if (path === "/api/wallet/withdraw" && method === "POST") {
    try {
      const { tradingWallet, mainWallet, amount, token, signature } = await req.json();
      if (!tradingWallet || !mainWallet || !amount) {
        return errorResponse("Missing required fields: tradingWallet, mainWallet, amount");
      }
      const normalizedTrader = (tradingWallet as string).toLowerCase() as Address;

      // P3-P1: 验证提款签名
      const walletWithdrawMsg = `Withdraw ${amount} for ${normalizedTrader}`;
      const walletAuth = await verifyTraderSignature(tradingWallet, signature, walletWithdrawMsg);
      if (!walletAuth.valid) {
        return errorResponse(walletAuth.error || "Authentication failed", 401);
      }
      const withdrawAmount = BigInt(amount);

      // ═══════════════════════════════════════════════════════════
      // SettlementV2 Merkle Proof Withdrawal
      // Returns authorization params for frontend to call SettlementV2.withdraw()
      // H-6: withLock prevents concurrent withdrawal requests from double-spending
      // ★ F-9 FIX: 使用 balance: 锁 (与下单/平仓共享) 防止 TOCTOU 超支
      // ═══════════════════════════════════════════════════════════
      if (SETTLEMENT_V2_ADDRESS) {
        return withLock(`balance:${normalizedTrader}`, 15000, async () => {
          // 1. Check pending orders locked margin
          let pendingOrdersLocked = 0n;
          const userOrders = engine.getUserOrders(normalizedTrader);
          for (const order of userOrders) {
            if (order.status === "PENDING" || order.status === "PARTIALLY_FILLED") {
              const marginInfo = orderMarginInfos.get(order.id);
              if (marginInfo) {
                const unfilledRatio = marginInfo.totalSize > 0n
                  ? ((marginInfo.totalSize - marginInfo.settledSize) * 10000n) / marginInfo.totalSize
                  : 10000n;
                pendingOrdersLocked += (marginInfo.totalDeducted * unfilledRatio) / 10000n;
              }
            }
          }

          // 2. Check position margin
          const posMargin = (userPositions.get(normalizedTrader) || []).reduce(
            (sum, p) => sum + BigInt(p.collateral || "0"), 0n
          );

          // 3. Sync fresh balance from chain before checking (fixes stale cache issue)
          await syncUserBalanceFromChain(normalizedTrader);
          const userBal = getUserBalance(normalizedTrader);
          const availableForWithdraw = userBal.availableBalance - pendingOrdersLocked;
          if (withdrawAmount > availableForWithdraw) {
            return errorResponse(
              `提取金额超出可用余额。可提取: Ξ${Number(availableForWithdraw > 0n ? availableForWithdraw : 0n) / 1e18}, ` +
              `挂单锁定: Ξ${Number(pendingOrdersLocked) / 1e18}, ` +
              `仓位保证金: Ξ${Number(posMargin) / 1e18}`
            );
          }

          // 4. Snapshot on-chain totalWithdrawn BEFORE authorization
          // Used by reconciliation job to detect if chain tx reverted
          let totalWithdrawnBefore = 0n;
          try {
            const { getUserTotalWithdrawn } = await import("./modules/relay");
            totalWithdrawnBefore = await getUserTotalWithdrawn(normalizedTrader as Address);
          } catch (e) {
            console.warn(`[Withdraw:Merkle] Failed to read on-chain totalWithdrawn, proceeding: ${e}`);
          }

          // 5. Ensure Merkle proof exists — generate on-demand if missing
          // ★ 用户要求余额变动实时反映，不能依赖定时快照周期
          // 如果用户没有 Merkle proof，立即生成一个新快照 + 提交链上
          let existingProof = getUserProof(normalizedTrader as Address);
          if (!existingProof) {
            console.log(`[Withdraw:Merkle] No snapshot proof for ${normalizedTrader.slice(0, 10)} — generating on-demand snapshot...`);
            try {
              const snapshot = await runSnapshotCycle({ submitToChain: true });
              if (snapshot) {
                console.log(`[Withdraw:Merkle] On-demand snapshot created: root=${snapshot.root.slice(0, 18)}, users=${snapshot.equities.length}`);
                existingProof = getUserProof(normalizedTrader as Address);
              }
            } catch (e) {
              console.error(`[Withdraw:Merkle] On-demand snapshot failed:`, e);
            }
            if (!existingProof) {
              return errorResponse("No equity snapshot available for user — snapshot generation failed. Please try again in a few seconds.");
            }
          }

          // 6. Generate Merkle proof withdrawal authorization
          // SettlementV2 uses: withdraw(amount, userEquity, merkleProof[], deadline, signature)
          const result = await requestWithdrawal(normalizedTrader as Address, withdrawAmount);
          if (!result.success || !result.authorization) {
            return errorResponse(result.error || "Withdrawal authorization failed");
          }

          // Get user equity from Merkle proof (needed by SettlementV2.withdraw)
          const proof = getUserProof(normalizedTrader as Address);
          const userEquity = proof?.equity ?? 0n;

          // 6. Pre-deduct balance to prevent double-spending
          if (userBal.availableBalance >= withdrawAmount) {
            userBal.availableBalance -= withdrawAmount;
          } else {
            userBal.availableBalance = 0n;
          }
          userBal.totalBalance = userBal.availableBalance + (userBal.usedMargin || 0n);

          // 7. Deduct mode2 adjustment for the portion exceeding chain deposit
          // Without this, after syncUserBalanceFromChain the balance would "resurrect":
          //   chainAvailable = deposits - withdrawn = 0 (correct)
          //   mode2Adj = +0.5 (NOT deducted → 0.5 BNB appears from nowhere!)
          // Fix: deduct the excess from mode2 so effective stays correct
          // ⚠️ CRITICAL: Record pending deduction for reconciliation — if chain tx reverts,
          // the reconciliation job will automatically reverse this deduction
          const chainDeposit = userBal.walletBalance || 0n;
          let mode2Portion = 0n;
          if (withdrawAmount > chainDeposit) {
            mode2Portion = withdrawAmount - chainDeposit;
            addMode2Adjustment(normalizedTrader, -mode2Portion, "WITHDRAW_PROFIT");
            console.log(`[Withdraw:Merkle] ${normalizedTrader.slice(0, 10)} mode2 deducted Ξ${Number(mode2Portion) / 1e18} (profit withdrawal)`);
          }

          // 8. Record pending deduction for auto-reversal if chain tx reverts
          if (mode2Portion > 0n) {
            recordPendingWithdrawalMode2(
              normalizedTrader as Address,
              mode2Portion,
              withdrawAmount,
              result.authorization.deadline,
              result.authorization.nonce,
              totalWithdrawnBefore,
            );
          }

          console.log(`[Withdraw:Merkle] ${normalizedTrader.slice(0, 10)} authorized Ξ${Number(withdrawAmount) / 1e18} (balance pre-deducted, reconciliation=${mode2Portion > 0n ? 'tracked' : 'n/a'})`);

          // 7. Return Merkle proof authorization for frontend
          // Frontend calls SettlementV2.withdraw(amount, userEquity, merkleProof, merkleRoot, deadline, signature)
          return jsonResponse({
            success: true,
            authorization: {
              amount: withdrawAmount.toString(),
              userEquity: userEquity.toString(),
              merkleProof: result.authorization.merkleProof,
              merkleRoot: result.authorization.merkleRoot,
              deadline: result.authorization.deadline.toString(),
              signature: result.authorization.signature,
            },
          });
        });
      }

      // V1 Settlement 已废弃 — 新架构使用 SettlementV2 Merkle 提款
      return errorResponse("请配置 SETTLEMENT_V2_ADDRESS 使用 Merkle 提款系统。V1 Settlement 已废弃。");
    } catch (e: any) {
      return errorResponse(e.message || "Withdraw failed");
    }
  }

  // SettlementV2 Merkle 系统状态
  if (path === "/api/v2/status" && method === "GET") {
    const snapshotStatus = getSnapshotJobStatus();
    const withdrawStatus = getWithdrawModuleStatus();
    return jsonResponse({
      success: true,
      settlementV2: {
        address: SETTLEMENT_V2_ADDRESS || null,
        enabled: !!SETTLEMENT_V2_ADDRESS,
      },
      snapshot: snapshotStatus,
      withdraw: withdrawStatus,
    });
  }

  // 注册前端交易钱包 session (用于自动 approve+deposit)
  if (path === "/api/wallet/register-session" && method === "POST") {
    try {
      const body = await req.json();
      const { signature, expiresInSeconds, ownerAddress } = body;
      if (!signature) {
        return errorResponse("Missing signature");
      }
      const result = await registerTradingSession(signature, expiresInSeconds || 86400);

      // 保存主钱包→派生钱包映射，余额查询用 (内存 + Redis 持久化)
      if (ownerAddress) {
        const normalizedOwner = (ownerAddress as string).toLowerCase() as Address;
        const derivedAddr = result.tradingWalletAddress.toLowerCase() as Address;
        traderToDerivedWallet.set(normalizedOwner, derivedAddr);
        // 持久化到 Redis Hash，重启后可恢复
        import("./database/redis").then(({ getRedisClient: r }) =>
          r().hset(DERIVED_WALLET_MAP_KEY, normalizedOwner, derivedAddr)
        ).catch(e =>
          console.error(`[Wallet] Failed to persist derived mapping: ${e}`)
        );
        console.log(`[Wallet] Mapped ${normalizedOwner.slice(0, 10)} → derived ${derivedAddr.slice(0, 10)}`);
      }

      return jsonResponse({ success: true, data: result });
    } catch (e: any) {
      return errorResponse(e.message || "Failed to register session");
    }
  }

  if (path === "/api/order/submit" && method === "POST") {
    totalOrdersSubmitted++;
    return handleOrderSubmit(req);
  }

  if (path.match(/^\/api\/user\/0x[a-fA-F0-9]+\/nonce$/) && method === "GET") {
    const trader = path.split("/")[3];
    return handleGetNonce(trader);
  }

  if (path.match(/^\/api\/orderbook\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetOrderBook(token);
  }

  if (path.match(/^\/api\/user\/0x[a-fA-F0-9]+\/orders$/) && method === "GET") {
    const trader = path.split("/")[3];
    return handleGetUserOrders(trader);
  }

  if (path.match(/^\/api\/order\/[^/]+\/cancel$/) && method === "POST") {
    const orderId = path.split("/")[3];
    return handleCancelOrder(req, orderId);
  }

  if (path.match(/^\/api\/user\/0x[a-fA-F0-9]+\/positions$/) && method === "GET") {
    const trader = path.split("/")[3];
    return handleGetUserPositions(trader);
  }

  if (path.match(/^\/api\/user\/0x[a-fA-F0-9]+\/trades$/) && method === "GET") {
    const trader = path.split("/")[3];
    const limit = parseInt(url.searchParams.get("limit") || "100");
    return handleGetUserTradesHistory(trader, limit);
  }

  // 余额相关 API
  if (path.match(/^\/api\/user\/0x[a-fA-F0-9]+\/balance$/) && method === "GET") {
    const trader = path.split("/")[3];
    return handleGetUserBalance(trader);
  }

  if (path.match(/^\/api\/user\/0x[a-fA-F0-9]+\/deposit$/) && method === "POST") {
    const trader = path.split("/")[3];
    return handleDeposit(req, trader);
  }

  if (path.match(/^\/api\/user\/0x[a-fA-F0-9]+\/withdraw$/) && method === "POST") {
    const trader = path.split("/")[3];
    return handleWithdraw(req, trader);
  }

  if (path.match(/^\/api\/position\/[^/]+\/close$/) && method === "POST") {
    const pairId = path.split("/")[3];
    return handleClosePair(req, pairId);
  }

  if (path === "/api/price/update" && method === "POST") {
    return handleUpdatePrice(req);
  }

  if (path.match(/^\/api\/trades\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetTrades(token, url);
  }

  if (path.match(/^\/api\/kline\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetKlines(token, url);
  }

  if (path.match(/^\/api\/stats\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetStats(token);
  }

  if (path.match(/^\/api\/funding\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetFundingRate(token);
  }

  // ============================================================
  // 猎杀场 API 路由
  // ============================================================

  // 清算地图：显示各价格点的清算量分布
  if (path.match(/^\/api\/liquidation-map\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetLiquidationMap(token);
  }

  // 全局持仓列表：公开所有用户持仓
  if (path.match(/^\/api\/positions\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetAllPositions(token);
  }

  // 清算历史
  if (path.match(/^\/api\/liquidations\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetLiquidations(token, url);
  }

  // 猎杀排行榜
  if (path === "/api/hunters" && method === "GET") {
    return handleGetHunterLeaderboard(url);
  }

  // ============================================================
  // 借贷清算 API
  // ============================================================

  // 获取代币的活跃借贷
  if (path.match(/^\/api\/lending\/borrows\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[4] as Address;
    const borrows = getActiveBorrows(token);
    return new Response(JSON.stringify({
      ok: true,
      data: {
        token,
        borrows: borrows.map(b => ({
          borrower: b.borrower,
          amount: b.amount.toString(),
          trackedAt: b.trackedAt,
          lastChecked: b.lastChecked,
        })),
        count: borrows.length,
      },
    }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  // 获取借贷清算模块状态
  if (path === "/api/lending/metrics" && method === "GET") {
    const metrics = getLendingLiquidationMetrics();
    return new Response(JSON.stringify({
      ok: true,
      data: metrics,
    }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  // ============================================================
  // PerpVault API
  // ============================================================

  // 获取 PerpVault 池子状态
  if (path === "/api/vault/info" && method === "GET") {
    const stats = await getPerpVaultPoolStats();
    const metrics = getPerpVaultMetrics();
    return new Response(JSON.stringify({
      ok: true,
      data: {
        enabled: metrics.enabled,
        ...(stats ? {
          poolValue: stats.poolValue.toString(),
          sharePrice: stats.sharePrice.toString(),
          totalShares: stats.totalShares.toString(),
          totalOI: stats.totalOI.toString(),
          maxOI: stats.maxOI.toString(),
          utilization: stats.utilization.toString(),
          totalFeesCollected: stats.totalFeesCollected.toString(),
          totalProfitsPaid: stats.totalProfitsPaid.toString(),
          totalLossesReceived: stats.totalLossesReceived.toString(),
          totalLiquidationReceived: stats.totalLiquidationReceived.toString(),
        } : {}),
        metrics,
      },
    }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  // 获取 LP 信息
  if (path.match(/^\/api\/vault\/lp\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const lpAddress = path.split("/")[4] as Address;
    const lpInfo = await getPerpVaultLPInfo(lpAddress);
    return new Response(JSON.stringify({
      ok: true,
      data: lpInfo ? {
        shares: lpInfo.shares.toString(),
        value: lpInfo.value.toString(),
        pendingWithdrawalShares: lpInfo.pendingWithdrawalShares.toString(),
        withdrawalRequestTime: lpInfo.withdrawalRequestTime.toString(),
        withdrawalExecuteAfter: lpInfo.withdrawalExecuteAfter.toString(),
        withdrawalEstimatedETH: lpInfo.withdrawalEstimatedETH.toString(),
      } : null,
    }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  // 获取代币 OI 信息
  if (path.match(/^\/api\/vault\/oi\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[4] as Address;
    const oi = await getPerpVaultTokenOI(token);
    return new Response(JSON.stringify({
      ok: true,
      data: {
        token,
        longOI: oi.longOI.toString(),
        shortOI: oi.shortOI.toString(),
        totalOI: (oi.longOI + oi.shortOI).toString(),
      },
    }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  // ============================================================
  // Internal API (Keeper / monitoring)
  // ============================================================

  // GET /api/internal/positions/all — 返回所有非零仓位 (供 Keeper 查询)
  // AUDIT-FIX ME-H08: 内部 API 需要鉴权，防止信息泄露
  if (path === "/api/internal/positions/all" && method === "GET") {
    // AUDIT-FIX H-14: Internal API auth 改为强制（非可选）
    // 生产环境必须设置 INTERNAL_API_KEY，否则拒绝所有请求
    const internalKey = url.searchParams.get("key") || req.headers.get("x-internal-key");
    const expectedKey = process.env.INTERNAL_API_KEY;
    if (!expectedKey) {
      return errorResponse("INTERNAL_API_KEY not configured — internal API disabled for security", 503);
    }
    if (internalKey !== expectedKey) {
      return errorResponse("Unauthorized: internal API key required", 401);
    }
    const allPositions: Array<{
      trader: string;
      token: string;
      isLong: boolean;
      size: string;
      collateral: string;
      entryPrice: string;
      leverage: string;
      liquidationPrice: string;
      markPrice: string;
      unrealizedPnl: string;
      timestamp: number;
    }> = [];

    for (const [trader, positions] of userPositions.entries()) {
      for (const pos of positions) {
        if (BigInt(pos.size || "0") === 0n) continue;
        allPositions.push({
          trader,
          token: pos.token,
          isLong: pos.isLong,
          size: pos.size,
          collateral: pos.collateral,
          entryPrice: pos.entryPrice,
          leverage: pos.leverage || "1",
          liquidationPrice: pos.liquidationPrice || "0",
          markPrice: pos.markPrice || "0",
          unrealizedPnl: pos.unrealizedPnL || "0",
          timestamp: pos.timestamp || Date.now(),
        });
      }
    }

    return new Response(JSON.stringify({
      positions: allPositions,
      count: allPositions.length,
      timestamp: Date.now(),
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // POST /api/internal/snapshot/trigger — 手动触发 Merkle 快照 (测试/运维)
  // AUDIT-FIX H-03: Require INTERNAL_API_KEY authentication
  if (path === "/api/internal/snapshot/trigger" && method === "POST") {
    const internalKey = url.searchParams.get("key") || req.headers.get("x-internal-key");
    const expectedKey = process.env.INTERNAL_API_KEY;
    if (!expectedKey) {
      return errorResponse("INTERNAL_API_KEY not configured — internal API disabled for security", 503);
    }
    if (internalKey !== expectedKey) {
      return errorResponse("Unauthorized: internal API key required", 401);
    }
    try {
      const { runSnapshotCycle } = await import("./modules/snapshot");
      const snapshot = await runSnapshotCycle({ submitToChain: !!SETTLEMENT_V2_ADDRESS });
      if (!snapshot) {
        return jsonResponse({ success: false, error: "Snapshot already running" });
      }
      return jsonResponse({
        success: true,
        snapshotId: snapshot.id,
        root: snapshot.root,
        userCount: snapshot.leaves.length,
        timestamp: snapshot.timestamp,
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message }, 500);
    }
  }

  // POST /api/internal/liquidation/trigger — Keeper 触发强平检查
  // AUDIT-FIX H-03: Require INTERNAL_API_KEY authentication
  if (path === "/api/internal/liquidation/trigger" && method === "POST") {
    const internalKey = url.searchParams.get("key") || req.headers.get("x-internal-key");
    const expectedKey = process.env.INTERNAL_API_KEY;
    if (!expectedKey) {
      return errorResponse("INTERNAL_API_KEY not configured — internal API disabled for security", 503);
    }
    if (internalKey !== expectedKey) {
      return errorResponse("Unauthorized: internal API key required", 401);
    }
    try {
      const body = await req.json();
      const { trader, token } = body as { trader: string; token: string };
      if (!trader || !token) {
        return new Response(JSON.stringify({ error: "trader and token required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      console.log(`[Keeper] Liquidation trigger received: trader=${(trader as string).slice(0, 10)}, token=${(token as string).slice(0, 10)}`);
      // The matching engine's risk engine will pick this up in its next cycle
      return new Response(JSON.stringify({ status: "acknowledged" }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // POST /api/internal/register-wallet-key — 做市商/API trader 直接注册私钥
  // 参考 Hyperliquid approveAgent — 无需 session 派生流程
  if (path === "/api/internal/register-wallet-key" && method === "POST") {
    const internalKey = url.searchParams.get("key") || req.headers.get("x-internal-key");
    const expectedKey = process.env.INTERNAL_API_KEY;
    if (!expectedKey || internalKey !== expectedKey) {
      return errorResponse("Unauthorized: internal API key required", 401);
    }
    try {
      const body = await req.json();
      const { trader, privateKey } = body as { trader: string; privateKey: string };
      if (!trader || !privateKey) {
        return errorResponse("trader and privateKey required", 400);
      }
      registerWalletKey(trader.toLowerCase() as Address, privateKey as `0x${string}`);
      return jsonResponse({ success: true, message: `Wallet key registered for ${trader.slice(0, 10)}` });
    } catch (e: any) {
      return errorResponse(e.message || "Failed to register wallet key");
    }
  }

  // ============================================================
  // 保险基金 API (P1)
  // ============================================================

  // 获取全局保险基金状态
  if (path === "/api/insurance-fund" && method === "GET") {
    return handleGetInsuranceFund();
  }

  // 获取代币保险基金状态
  if (path.match(/^\/api\/insurance-fund\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetTokenInsuranceFund(token);
  }

  // ============================================================
  // Dynamic Funding API (P1)
  // ============================================================

  // 获取动态资金费信息
  if (path.match(/^\/api\/dynamic-funding\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetDynamicFunding(token);
  }

  // 获取资金费支付历史
  if (path.match(/^\/api\/funding-history\/0x[a-fA-F0-9]+$/) && method === "GET") {
    const token = path.split("/")[3];
    return handleGetFundingHistory(token, url);
  }

  // 手动触发资金费结算 (管理员)
  if (path === "/api/funding/settle" && method === "POST") {
    return handleManualFundingSettlement(req);
  }

  // ============================================================
  // 现货交易历史 & K 线 API
  // ============================================================

  // 获取现货交易历史
  // C-5: try-catch 保护 — ./api/handlers 模块可能不存在 (仅永续部署时)
  if (path.match(/^\/api\/v1\/spot\/trades\/0x[a-fA-F0-9]+$/) && method === "GET") {
    try {
      const token = path.split("/")[5] as Address;
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const before = url.searchParams.get("before") ? parseInt(url.searchParams.get("before")!) : undefined;
      const { handleGetSpotTrades } = await import("./api/handlers");
      const result = await handleGetSpotTrades(token, limit, before);
      return jsonResponse(result);
    } catch (e) {
      console.warn("[Spot API] handlers module unavailable for /spot/trades:", (e as Error).message);
      return jsonResponse({ success: false, error: "Spot trading API not available" }, 503);
    }
  }

  // 获取现货 K 线数据 (时间范围查询)
  if (path.match(/^\/api\/v1\/spot\/klines\/0x[a-fA-F0-9]+$/) && method === "GET") {
    try {
      const token = path.split("/")[5] as Address;
      const resolution = url.searchParams.get("resolution") || "1m";
      const from = parseInt(url.searchParams.get("from") || "0");
      const to = parseInt(url.searchParams.get("to") || Math.floor(Date.now() / 1000).toString());
      try {
        const { handleGetKlines: handleGetSpotKlines } = await import("./api/handlers");
        const result = await handleGetSpotKlines(token, resolution, from, to);
        return jsonResponse(result);
      } catch (handlerErr) {
        // Fallback: read from Redis HASH (spot:kline:TOKEN:RESOLUTION)
        console.warn("[Kline API] Handler import failed, using Redis fallback:", (handlerErr as Error).message);
        const { getRedisClient } = await import("./database/redis");
        const redis = getRedisClient();
        const normalizedToken = token.toLowerCase();
        const bars: Array<{ time: number; open: string; high: string; low: string; close: string; volume: string }> = [];

        // Read from spot:kline HASH (same format as spotHistory.ts)
        const hashKey = `spot:kline:${normalizedToken}:${resolution}`;
        const allBars = await redis.hgetall(hashKey);

        if (allBars && Object.keys(allBars).length > 0) {
          for (const [, barJson] of Object.entries(allBars)) {
            try {
              const bar = JSON.parse(barJson);
              if (bar.time >= from && bar.time <= to) {
                bars.push({
                  time: bar.time,
                  open: bar.open,
                  high: bar.high,
                  low: bar.low,
                  close: bar.close,
                  volume: bar.volume,
                });
              }
            } catch { /* skip malformed */ }
          }
        }

        bars.sort((a, b) => a.time - b.time);
        return jsonResponse({ success: true, data: bars, source: "redis-fallback" });
      }
    } catch (e) {
      console.error("[Kline API] Error:", (e as Error).message);
      return jsonResponse({ success: false, error: "Failed to fetch klines" }, 500);
    }
  }

  // 获取最新 K 线数据 (简化接口 — 前端主要使用)
  if (path.match(/^\/api\/v1\/spot\/klines\/latest\/0x[a-fA-F0-9]+$/) && method === "GET") {
    try {
      const token = path.split("/")[6] as Address;
      const resolution = url.searchParams.get("resolution") || "1m";
      const limit = parseInt(url.searchParams.get("limit") || "100");
      try {
        const { handleGetLatestKlines } = await import("./api/handlers");
        const result = await handleGetLatestKlines(token, resolution, limit);
        return jsonResponse(result);
      } catch (handlerErr) {
        // Fallback: read latest K-lines directly from Redis HASH (spot:kline:TOKEN:RESOLUTION)
        console.warn("[Kline API] Handler import failed, using Redis fallback:", (handlerErr as Error).message);
        const { getRedisClient } = await import("./database/redis");
        const redis = getRedisClient();
        const normalizedToken = token.toLowerCase();
        const bars: Array<{ time: number; open: string; high: string; low: string; close: string; volume: string; trades: number }> = [];

        // Read from spot:kline HASH (same format as spotHistory.ts KlineRepo)
        const hashKey = `spot:kline:${normalizedToken}:${resolution}`;
        const allBars = await redis.hgetall(hashKey);

        if (allBars && Object.keys(allBars).length > 0) {
          for (const [, barJson] of Object.entries(allBars)) {
            try {
              const bar = JSON.parse(barJson);
              bars.push({
                time: bar.time,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
                trades: bar.trades || 0,
              });
            } catch { /* skip malformed */ }
          }
        }

        // Sort and return latest 'limit' bars
        bars.sort((a, b) => a.time - b.time);
        const latest = bars.slice(-limit);
        return jsonResponse({ success: true, data: latest, count: latest.length, source: "redis-fallback" });
      }
    } catch (e) {
      console.error("[Kline API] Error:", (e as Error).message);
      return jsonResponse({ success: false, error: "Failed to fetch klines" }, 500);
    }
  }

  // 获取现货价格和 24h 统计
  if (path.match(/^\/api\/v1\/spot\/price\/0x[a-fA-F0-9]+$/) && method === "GET") {
    try {
      const token = path.split("/")[5] as Address;
      const { handleGetSpotPrice } = await import("./api/handlers");
      const result = await handleGetSpotPrice(token);
      return jsonResponse(result);
    } catch (e) {
      console.warn("[Spot API] handlers module unavailable for /spot/price:", (e as Error).message);
      return jsonResponse({ success: false, error: "Spot trading API not available" }, 503);
    }
  }

  // 回填历史交易数据 (管理员)
  if (path.match(/^\/api\/v1\/spot\/backfill\/0x[a-fA-F0-9]+$/) && method === "POST") {
    const token = path.split("/")[5] as Address;
    const body = await req.json().catch(() => ({}));
    const fromBlock = BigInt(body.fromBlock || 0);
    const toBlock = body.toBlock ? BigInt(body.toBlock) : undefined;

    try {
      const publicClient = createPublicClient({
        chain: activeChain,
        transport: rpcTransport,
      });
      const currentBlock = toBlock || await publicClient.getBlockNumber();
      const startBlock = fromBlock > 0n ? fromBlock : currentBlock - 50000n; // 默认回填最近 50000 个区块

      const { backfillHistoricalTrades } = await import("../spot/spotHistory");
      const count = await backfillHistoricalTrades(token, startBlock, currentBlock, currentEthPriceUsd);

      return jsonResponse({
        success: true,
        data: {
          token,
          fromBlock: startBlock.toString(),
          toBlock: currentBlock.toString(),
          tradesProcessed: count,
        },
      });
    } catch (e: any) {
      return jsonResponse({ success: false, error: e.message });
    }
  }

  // ============================================================
  // Take Profit / Stop Loss API (P2)
  // ============================================================

  // 设置/更新 TP/SL
  if (path.match(/^\/api\/position\/[^/]+\/tpsl$/) && method === "POST") {
    const pairId = path.split("/")[3];
    return handleSetTPSL(req, pairId);
  }

  // 获取 TP/SL 状态
  if (path.match(/^\/api\/position\/[^/]+\/tpsl$/) && method === "GET") {
    const pairId = path.split("/")[3];
    return handleGetTPSL(pairId);
  }

  // 取消 TP/SL
  if (path.match(/^\/api\/position\/[^/]+\/tpsl$/) && method === "DELETE") {
    const pairId = path.split("/")[3];
    return handleCancelTPSL(req, pairId);
  }

  // 获取所有 TP/SL 订单
  if (path === "/api/tpsl/orders" && method === "GET") {
    return handleGetAllTPSLOrders();
  }

  // ============================================================
  // Add/Remove Margin API (P2)
  // ============================================================

  // 获取保证金调整信息
  if (path.match(/^\/api\/position\/[^/]+\/margin$/) && method === "GET") {
    const pairId = path.split("/")[3];
    return handleGetMarginInfo(pairId);
  }

  // 追加保证金
  if (path.match(/^\/api\/position\/[^/]+\/margin\/add$/) && method === "POST") {
    const pairId = path.split("/")[3];
    return handleAddMargin(req, pairId);
  }

  // 减少保证金
  if (path.match(/^\/api\/position\/[^/]+\/margin\/remove$/) && method === "POST") {
    const pairId = path.split("/")[3];
    return handleRemoveMargin(req, pairId);
  }

  // ============================================================
  // Referral System API (P5)
  // ============================================================

  // 注册成为推荐人
  if (path === "/api/referral/register" && method === "POST") {
    return handleRegisterReferrer(req);
  }

  // 绑定邀请码
  if (path === "/api/referral/bind" && method === "POST") {
    return handleBindReferral(req);
  }

  // 获取推荐人信息
  if (path === "/api/referral/referrer" && method === "GET") {
    return handleGetReferrer(req);
  }

  // 获取被邀请人信息
  if (path === "/api/referral/referee" && method === "GET") {
    return handleGetReferee(req);
  }

  // 获取返佣记录
  if (path === "/api/referral/commissions" && method === "GET") {
    return handleGetCommissions(req);
  }

  // 提取返佣
  if (path === "/api/referral/withdraw" && method === "POST") {
    return handleWithdrawCommission(req);
  }

  // 获取推荐排行榜
  if (path === "/api/referral/leaderboard" && method === "GET") {
    return handleGetReferralLeaderboard(req);
  }

  // 获取全局推荐统计
  if (path === "/api/referral/stats" && method === "GET") {
    return handleGetReferralStats();
  }

  // 通过邀请码查询推荐人
  if (path.match(/^\/api\/referral\/code\/[A-Za-z0-9]+$/) && method === "GET") {
    const code = path.split("/")[4];
    return handleGetReferrerByCode(code);
  }

  // ✅ 账单 API: GET /api/user/:trader/bills
  const billsMatch = path.match(/^\/api\/user\/(0x[a-fA-F0-9]+)\/bills$/);
  if (billsMatch && method === "GET") {
    const trader = billsMatch[1].toLowerCase() as Address;
    const type = url.searchParams.get("type") || undefined;
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const before = url.searchParams.get("before") ? parseInt(url.searchParams.get("before")!) : undefined;

    try {
      // 优先从 Redis 读取 (热数据, 30天TTL)
      const logs = await RedisSettlementLogRepo.getByUser(trader, limit);
      let filtered = logs;
      if (type) filtered = filtered.filter(l => l.type === type);
      if (before) filtered = filtered.filter(l => l.createdAt < before);

      // P0-2: 如果 Redis 为空且 PG 可用, 从 PG 读取 (持久化数据)
      if (filtered.length === 0 && isPostgresConnected()) {
        const pgBills = type
          ? await BillMirrorRepo.getByTraderAndType(trader, type, limit)
          : await BillMirrorRepo.getByTrader(trader, limit);
        const pgFiltered = before ? pgBills.filter(b => b.timestamp < before) : pgBills;
        return jsonResponse(pgFiltered.map(b => ({
          id: b.id,
          txHash: null,
          type: b.type,
          amount: b.amount,
          balanceBefore: b.balance_before,
          balanceAfter: b.balance_after,
          onChainStatus: b.on_chain_status,
          proofData: b.proof_data,
          positionId: b.position_id,
          orderId: b.order_id,
          createdAt: b.timestamp,
        })));
      }

      const serialized = filtered.map(log => ({
        id: log.id,
        txHash: log.txHash,
        type: log.type,
        amount: log.amount.toString(),
        balanceBefore: log.balanceBefore.toString(),
        balanceAfter: log.balanceAfter.toString(),
        onChainStatus: log.onChainStatus,
        proofData: log.proofData,
        positionId: log.positionId,
        orderId: log.orderId,
        createdAt: log.createdAt,
      }));
      return jsonResponse(serialized);
    } catch (e) {
      console.error("[Bills] Error fetching bills:", e);
      return jsonResponse([]);
    }
  }

  // Not found
  return errorResponse("Not found", 404);
}

// ============================================================
// Security: Log Sanitization
// ============================================================

/**
 * Sanitizes log messages to prevent sensitive data leakage
 * Redacts: private keys (0x + 64 hex chars), API secrets, passwords
 */
function sanitizeLog(message: string): string {
  return message
    // Redact private keys (0x followed by 64 hex characters)
    .replace(/0x[0-9a-fA-F]{64}/g, '0x***PRIVATE_KEY_REDACTED***')
    // Redact any remaining long hex strings that might be sensitive
    .replace(/0x[0-9a-fA-F]{40,}/g, (match) => {
      // Keep addresses (40 chars) but redact longer ones
      if (match.length === 42) return match; // 0x + 40 chars = address
      return '0x***REDACTED***';
    });
}

/**
 * Safe console.log that sanitizes sensitive data
 */
function safeLog(message: string): void {
  console.log(sanitizeLog(message));
}

/**
 * Safe console.error that sanitizes sensitive data
 */
function safeError(message: string, error?: any): void {
  console.error(sanitizeLog(message), error);
}

// ============================================================
// WebSocket Handlers
// ============================================================

interface WSMessage {
  type: "subscribe" | "unsubscribe";
  channel: "orderbook" | "trades";
  token: Address;
}

function broadcastOrderBook(token: Address): void {
  if (!wss) return;

  const orderBook = engine.getOrderBook(token);
  const depth = orderBook.getDepth(20);
  const currentPrice = orderBook.getCurrentPrice();

  const message = JSON.stringify({
    type: "orderbook",
    token,
    data: {
      longs: depth.longs.map((level) => ({
        price: level.price.toString(),
        size: level.totalSize.toString(),
        count: level.orders.length,
      })),
      shorts: depth.shorts.map((level) => ({
        price: level.price.toString(),
        size: level.totalSize.toString(),
        count: level.orders.length,
      })),
      lastPrice: currentPrice.toString(),
    },
  });

  for (const [client, tokens] of wsClients) {
    if (client.readyState === WebSocket.OPEN && tokens.has(token)) {
      client.send(message);
    }
  }
}

function broadcastTrade(trade: Trade): void {
  if (!wss) return;

  const message = JSON.stringify({
    type: "trade",
    token: trade.token,
    data: {
      id: trade.id,
      price: trade.price.toString(),
      size: trade.size.toString(),
      side: trade.side,
      timestamp: trade.timestamp,
    },
  });

  for (const [client, tokens] of wsClients) {
    if (client.readyState === WebSocket.OPEN && tokens.has(trade.token)) {
      client.send(message);
    }
  }
}

/**
 * 推送市场数据给订阅该代币的所有客户端
 * 前端期望格式: { type: "market_data", token: "0x...", data: { lastPrice, high24h, ... } }
 *
 * ✅ 合并永续 + 现货统计: volume24h, trades24h, high24h, low24h 均包含现货交易数据
 */

// 缓存现货 24h 统计 (每 10 秒从 Redis 刷新一次，避免 broadcastMarketData 变 async)
const cachedSpotStats = new Map<Address, { volume24h: string; high24h: string; low24h: string; open24h: string; change24h: string; trades24h: number; updatedAt: number }>();

async function refreshSpotStatsCache(): Promise<void> {
  try {
    const { SpotStatsRepo } = await import("../spot/spotHistory");
    // ✅ Refresh for all supported tokens (not just subscribed) — ensures cache is warm
    // before any WS client subscribes, avoiding stale open24h on first market_data push
    const tokensToRefresh = new Set<Address>(SUPPORTED_TOKENS);
    for (const [, tokens] of wsClients) {
      for (const token of tokens) {
        tokensToRefresh.add(token);
      }
    }
    for (const token of tokensToRefresh) {
      const stats = await SpotStatsRepo.get24hStats(token);
      if (stats) {
        cachedSpotStats.set(token, { ...stats, updatedAt: Date.now() });
      }
    }
  } catch (e: any) {
    console.warn("[MarketData] Failed to refresh spot stats cache:", e.message);
  }
}

function broadcastMarketData(token: Address): void {
  if (!wss) return;

  const normalizedToken = token.toLowerCase() as Address;
  const orderBook = engine.getOrderBook(normalizedToken);
  const depth = orderBook.getDepth(20);
  const trades = engine.getRecentTrades(normalizedToken, 100);

  // ✅ 价格回退链: 永续成交价 → 现货价格 (TokenFactory AMM) → cachedSpotStats
  // 当永续订单簿没有成交时，使用现货价格作为标记价格
  let currentPrice = orderBook.getCurrentPrice();
  if (currentPrice <= 0n) {
    currentPrice = engine.getSpotPrice(normalizedToken);
  }
  // ✅ 最终回退: 从 cachedSpotStats 获取价格 (避免 currentPrice=0 导致 -100%)
  if (currentPrice <= 0n) {
    const spotFallback = cachedSpotStats.get(normalizedToken);
    if (spotFallback) {
      const spotPrice = parseFloat(spotFallback.high24h || spotFallback.open24h || "0");
      if (spotPrice > 0) currentPrice = BigInt(Math.floor(spotPrice * 1e18));
    }
  }

  // 计算24小时统计 (永续交易)
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const trades24h = trades.filter(t => t.timestamp >= oneDayAgo);

  let high24h = currentPrice;
  let low24h = currentPrice;
  let volume24h = 0n;
  let open24h = currentPrice;
  let trades24hCount = 0;

  if (trades24h.length > 0) {
    open24h = trades24h[trades24h.length - 1].price;
    trades24hCount = trades24h.length;
    for (const t of trades24h) {
      if (t.price > high24h) high24h = t.price;
      if (t.price < low24h) low24h = t.price;
      // 计算 ETH 成交量: size (1e18) * price (1e18) / 1e18 = ETH (1e18 精度)
      volume24h += (t.size * t.price) / (10n ** 18n);
    }
  } else {
    // ✅ 无永续交易时，回退到现货 24h open 价格（避免 priceChange 恒为 0）
    const spotStatsForOpen = cachedSpotStats.get(normalizedToken);
    if (spotStatsForOpen && spotStatsForOpen.open24h) {
      const spotOpen = parseFloat(spotStatsForOpen.open24h);
      if (spotOpen > 0) {
        open24h = BigInt(Math.floor(spotOpen * 1e18));
      }
    }
  }

  // ✅ 合并现货 24h 统计 (从缓存读取，避免 async)
  const spotStats = cachedSpotStats.get(normalizedToken);
  if (spotStats) {
    // 现货 volume (ETH float string → BigInt wei)
    const spotVolumeEth = parseFloat(spotStats.volume24h || "0");
    if (spotVolumeEth > 0) {
      volume24h += BigInt(Math.floor(spotVolumeEth * 1e18));
    }
    // 合并交易次数
    trades24hCount += spotStats.trades24h || 0;
    // 合并 high/low (现货价格是 ETH 单位的浮点字符串)
    const spotHighWei = BigInt(Math.floor(parseFloat(spotStats.high24h || "0") * 1e18));
    const spotLowVal = parseFloat(spotStats.low24h || "0");
    const spotLowWei = spotLowVal > 0 ? BigInt(Math.floor(spotLowVal * 1e18)) : 0n;
    if (spotHighWei > high24h) high24h = spotHighWei;
    if (spotLowWei > 0n && spotLowWei < low24h) low24h = spotLowWei;
  }

  const priceChange = currentPrice - open24h;
  const priceChangePercent = open24h > 0n ? Number(priceChange * 10000n / open24h) / 100 : 0;

  // ✅ 计算真实未平仓合约 (Open Interest)
  const { longOI, shortOI } = calculateOpenInterest(normalizedToken);
  const totalOI = longOI + shortOI;

  // 构建市场数据 - 前端期望 token 在顶层
  const marketData = {
    lastPrice: currentPrice.toString(),
    markPrice: currentPrice.toString(),
    indexPrice: currentPrice.toString(),
    high24h: high24h.toString(),
    low24h: low24h.toString(),
    volume24h: volume24h.toString(),
    open24h: open24h.toString(),
    priceChange24h: priceChange.toString(),
    priceChangePercent24h: priceChangePercent.toFixed(2),
    trades24h: trades24hCount,
    openInterest: totalOI.toString(),
    longOI: longOI.toString(),
    shortOI: shortOI.toString(),
    timestamp: now,
  };

  const message = JSON.stringify({
    type: "market_data",
    token: normalizedToken,
    data: marketData,
    timestamp: now,
  });

  for (const [client, tokens] of wsClients) {
    if (client.readyState === WebSocket.OPEN && tokens.has(normalizedToken)) {
      client.send(message);
    }
  }
}

/**
 * 发送市场数据给单个客户端 (用于初次订阅时推送快照)
 */
function sendMarketDataToClient(ws: WebSocket, token: Address): void {
  if (ws.readyState !== WebSocket.OPEN) return;

  const normalizedToken = token.toLowerCase() as Address;
  const orderBook = engine.getOrderBook(normalizedToken);

  let currentPrice = orderBook.getCurrentPrice();
  if (currentPrice <= 0n) {
    currentPrice = engine.getSpotPrice(normalizedToken);
  }

  const trades = engine.getRecentTrades(normalizedToken, 100);
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const trades24h = trades.filter(t => t.timestamp >= oneDayAgo);

  let high24h = currentPrice;
  let low24h = currentPrice;
  let volume24h = 0n;
  let open24h = currentPrice;
  let trades24hCount = 0;

  if (trades24h.length > 0) {
    open24h = trades24h[trades24h.length - 1].price;
    trades24hCount = trades24h.length;
    for (const t of trades24h) {
      if (t.price > high24h) high24h = t.price;
      if (t.price < low24h) low24h = t.price;
      volume24h += (t.size * t.price) / (10n ** 18n);
    }
  } else {
    // ✅ 无永续交易时，回退到现货 24h open 价格（避免 priceChange 恒为 0）
    const spotStatsForOpen = cachedSpotStats.get(normalizedToken);
    if (spotStatsForOpen && spotStatsForOpen.open24h) {
      const spotOpen = parseFloat(spotStatsForOpen.open24h);
      if (spotOpen > 0) {
        open24h = BigInt(Math.floor(spotOpen * 1e18));
      }
    }
  }

  // ✅ 合并现货 24h 统计 (从缓存读取)
  const spotStats = cachedSpotStats.get(normalizedToken);
  if (spotStats) {
    const spotVolumeEth = parseFloat(spotStats.volume24h || "0");
    if (spotVolumeEth > 0) {
      volume24h += BigInt(Math.floor(spotVolumeEth * 1e18));
    }
    trades24hCount += spotStats.trades24h || 0;
    const spotHighWei = BigInt(Math.floor(parseFloat(spotStats.high24h || "0") * 1e18));
    const spotLowVal = parseFloat(spotStats.low24h || "0");
    const spotLowWei = spotLowVal > 0 ? BigInt(Math.floor(spotLowVal * 1e18)) : 0n;
    if (spotHighWei > high24h) high24h = spotHighWei;
    if (spotLowWei > 0n && spotLowWei < low24h) low24h = spotLowWei;
  }

  const priceChange = currentPrice - open24h;
  const priceChangePercent = open24h > 0n ? Number(priceChange * 10000n / open24h) / 100 : 0;
  const { longOI, shortOI } = calculateOpenInterest(normalizedToken);
  const totalOI = longOI + shortOI;

  ws.send(JSON.stringify({
    type: "market_data",
    token: normalizedToken,
    data: {
      lastPrice: currentPrice.toString(),
      markPrice: currentPrice.toString(),
      indexPrice: currentPrice.toString(),
      high24h: high24h.toString(),
      low24h: low24h.toString(),
      volume24h: volume24h.toString(),
      open24h: open24h.toString(),
      priceChange24h: priceChange.toString(),
      priceChangePercent24h: priceChangePercent.toFixed(2),
      trades24h: trades24hCount,
      openInterest: totalOI.toString(),
      longOI: longOI.toString(),
      shortOI: shortOI.toString(),
      timestamp: now,
    },
    timestamp: now,
  }));
}

/**
 * 推送资金费率给订阅该代币的所有客户端
 * 前端期望格式: { type: "funding_rate", token: "0x...", rate: "...", nextFundingTime: ... }
 */
function broadcastFundingRateWS(token: Address): void {
  if (!wss) return;

  const normalizedToken = token.toLowerCase() as Address;

  // 从资金费率状态获取当前费率
  const rate = currentFundingRates.get(normalizedToken) || 0n;

  // 固定 15 分钟周期
  const nextFundingTime = nextFundingSettlement.get(normalizedToken) || (Date.now() + 15 * 60 * 1000);
  const skewed = currentFundingRatesSkewed.get(normalizedToken);
  const interval = getFundingInterval(normalizedToken);

  const message = JSON.stringify({
    type: "funding_rate",
    token: normalizedToken,
    rate: rate.toString(),
    longRate: skewed?.longRate.toString() || "0",
    shortRate: skewed?.shortRate.toString() || "0",
    nextFundingTime,
    interval: `${Math.round(interval / 60000)}m`,
    timestamp: Date.now(),
  });

  for (const [client, tokens] of wsClients) {
    if (client.readyState === WebSocket.OPEN && tokens.has(normalizedToken)) {
      client.send(message);
    }
  }
}

// 市场数据推送间隔 (用于 setInterval)
let marketDataPushInterval: NodeJS.Timeout | null = null;

// 上一次推送的市场数据缓存 (用于变化检测，避免无变化时频繁推送导致前端抖动)
const lastBroadcastedMarketData = new Map<Address, string>();
const lastBroadcastedFundingRate = new Map<Address, string>();

/**
 * 启动市场数据定时推送
 *
 * 使用变化检测: 只有数据确实变化时才推送，避免前端因为频繁 re-render 导致 UI 抖动
 * - market_data: 每秒检查，但只有 lastPrice/OI/volume 等变化时才推送
 * - funding_rate: 每 10 秒推送一次 (与 DYNAMIC_FUNDING_CHECK_INTERVAL 同步)
 */
let fundingRatePushCounter = 0;

function startMarketDataPush(): void {
  if (marketDataPushInterval) return;

  console.log("[MarketData] Starting periodic market data push (1s check, change-detection)");

  // ✅ Refresh spot stats cache every 10 seconds (async, non-blocking)
  setInterval(() => {
    refreshSpotStatsCache().catch(() => {});
  }, 10_000);
  // Initial refresh
  refreshSpotStatsCache().catch(() => {});

  marketDataPushInterval = setInterval(() => {
    // 获取所有被订阅的代币
    const subscribedTokens = new Set<Address>();
    for (const [, tokens] of wsClients) {
      for (const token of tokens) {
        subscribedTokens.add(token);
      }
    }

    fundingRatePushCounter++;

    for (const token of subscribedTokens) {
      // market_data: 只有数据变化时才推送
      broadcastMarketDataIfChanged(token);

      // funding_rate: 每 ~10 秒推送一次 (不需要每秒推送，费率变化很缓慢)
      if (fundingRatePushCounter % 20 === 0) { // P0-3: 20 * 500ms = 10s
        broadcastFundingRateWS(token);
      }
    }

    // ✅ 首页全量市场统计广播（内部自行节流，每 3 秒一次）
    broadcastAllMarketStats();
  }, 500); // P0-3: 500ms (was 1s) — faster market data push
}

/**
 * 广播所有代币的市场统计数据给订阅了 all_market_stats 的客户端
 * 用于首页一次性获取所有代币的 volume/traders，无需逐个订阅
 */
let allMarketStatsCounter = 0;
function broadcastAllMarketStats(): void {
  if (wsMarketStatsSubscribers.size === 0) return;

  // 每 6 次调用才执行一次（配合 500ms 间隔 = 每 3 秒推送一次）
  allMarketStatsCounter++;
  if (allMarketStatsCounter % 6 !== 0) return;

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const stats: Record<string, {
    lastPrice: string;
    volume24h: string;
    trades24h: number;
    priceChangePercent24h: string;
    high24h: string;
    low24h: string;
    openInterest: string;
  }> = {};

  for (const [addr] of TOKEN_INFO_CACHE) {
    const normalizedToken = addr.toLowerCase() as Address;
    const orderBook = engine.getOrderBook(normalizedToken);
    const trades = engine.getRecentTrades(normalizedToken, 100);

    let currentPrice = orderBook.getCurrentPrice();
    if (currentPrice <= 0n) {
      currentPrice = engine.getSpotPrice(normalizedToken);
    }
    // ✅ 最终回退: 从 cachedSpotStats 获取价格 (避免 currentPrice=0 导致 -100%)
    if (currentPrice <= 0n) {
      const spotFallback = cachedSpotStats.get(normalizedToken);
      if (spotFallback) {
        const spotPrice = parseFloat(spotFallback.high24h || spotFallback.open24h || "0");
        if (spotPrice > 0) currentPrice = BigInt(Math.floor(spotPrice * 1e18));
      }
    }

    const trades24h = trades.filter(t => t.timestamp >= oneDayAgo);
    let volume24h = 0n;
    let high24h = currentPrice;
    let low24h = currentPrice;
    let open24h = currentPrice;
    let trades24hCount = 0;

    if (trades24h.length > 0) {
      open24h = trades24h[trades24h.length - 1].price;
      trades24hCount = trades24h.length;
      for (const t of trades24h) {
        if (t.price > high24h) high24h = t.price;
        if (t.price < low24h) low24h = t.price;
        volume24h += (t.size * t.price) / (10n ** 18n);
      }
    } else {
      // ✅ 无永续交易时，回退到现货 24h open 价格
      const spotStatsForOpen = cachedSpotStats.get(normalizedToken);
      if (spotStatsForOpen && spotStatsForOpen.open24h) {
        const spotOpen = parseFloat(spotStatsForOpen.open24h);
        if (spotOpen > 0) {
          open24h = BigInt(Math.floor(spotOpen * 1e18));
        }
      }
    }

    // 合并现货统计
    const spotStats = cachedSpotStats.get(normalizedToken);
    if (spotStats) {
      const spotVolumeEth = parseFloat(spotStats.volume24h || "0");
      if (spotVolumeEth > 0) {
        volume24h += BigInt(Math.floor(spotVolumeEth * 1e18));
      }
      trades24hCount += spotStats.trades24h || 0;
      const spotHighWei = BigInt(Math.floor(parseFloat(spotStats.high24h || "0") * 1e18));
      const spotLowVal = parseFloat(spotStats.low24h || "0");
      const spotLowWei = spotLowVal > 0 ? BigInt(Math.floor(spotLowVal * 1e18)) : 0n;
      if (spotHighWei > high24h) high24h = spotHighWei;
      if (spotLowWei > 0n && spotLowWei < low24h) low24h = spotLowWei;
    }

    const priceChange = currentPrice - open24h;
    const priceChangePercent = open24h > 0n ? Number(priceChange * 10000n / open24h) / 100 : 0;
    const { longOI, shortOI } = calculateOpenInterest(normalizedToken);

    stats[normalizedToken] = {
      lastPrice: currentPrice.toString(),
      volume24h: volume24h.toString(),
      trades24h: trades24hCount,
      priceChangePercent24h: priceChangePercent.toFixed(2),
      high24h: high24h.toString(),
      low24h: low24h.toString(),
      openInterest: (longOI + shortOI).toString(),
    };
  }

  const message = JSON.stringify({
    type: "all_market_stats",
    data: stats,
    timestamp: now,
  });

  // 清理已断开的连接 + 发送
  for (const ws of wsMarketStatsSubscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else {
      wsMarketStatsSubscribers.delete(ws);
    }
  }
}

/**
 * 只在市场数据变化时才广播 (避免前端无意义 re-render)
 */
function broadcastMarketDataIfChanged(token: Address): void {
  if (!wss) return;

  const normalizedToken = token.toLowerCase() as Address;
  const orderBook = engine.getOrderBook(normalizedToken);

  // 快速检查: 用 lastPrice + OI + spot volume 组合作为变化指纹
  let currentPrice = orderBook.getCurrentPrice();
  if (currentPrice <= 0n) {
    currentPrice = engine.getSpotPrice(normalizedToken);
  }
  const { longOI, shortOI } = calculateOpenInterest(normalizedToken);
  // Include spot stats in fingerprint so spot trade changes trigger broadcast
  // ✅ 包含 open24h 确保缓存刷新后触发重新广播 (避免首次为空导致 priceChange 恒为 0)
  const spotStats = cachedSpotStats.get(normalizedToken);
  const spotVolume = spotStats?.volume24h || "0";
  const spotTrades = spotStats?.trades24h || 0;
  const spotOpen24h = spotStats?.open24h || "0";
  const fingerprint = `${currentPrice}_${longOI}_${shortOI}_${spotVolume}_${spotTrades}_${spotOpen24h}`;

  const lastFingerprint = lastBroadcastedMarketData.get(normalizedToken);
  if (lastFingerprint === fingerprint) {
    return; // 数据未变化，跳过推送
  }
  lastBroadcastedMarketData.set(normalizedToken, fingerprint);

  // 数据有变化，执行完整推送
  broadcastMarketData(token);
}

/**
 * 推送订单更新给交易者
 */
function broadcastOrderUpdate(order: Order): void {
  // P1-5: 每次订单状态变更时异步镜像到 PostgreSQL
  if (isPostgresConnected()) {
    const statusMap: Record<number, string> = {
      [OrderStatus.PENDING]: "PENDING",
      [OrderStatus.PARTIALLY_FILLED]: "PARTIALLY_FILLED",
      [OrderStatus.FILLED]: "FILLED",
      [OrderStatus.CANCELLED]: "CANCELED",
    };
    const pgStatus = statusMap[order.status as number] || "PENDING";
    pgMirrorWrite(
      OrderMirrorRepo.updateStatus(order.id, pgStatus, order.filledSize.toString(), order.avgFillPrice.toString()),
      `OrderStatus:${order.id.slice(0, 10)}`
    );
  }

  if (!wss) return;

  const trader = order.trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(trader);
  if (!wsSet || wsSet.size === 0) return;

  const message = JSON.stringify({
    type: "orders",
    order: {
      id: order.id,
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      trader: order.trader,
      token: order.token,
      isLong: order.isLong,
      size: order.size.toString(),
      price: order.price.toString(),
      leverage: order.leverage.toString(),
      margin: order.margin.toString(),
      fee: order.fee.toString(),
      orderType: order.orderType,
      timeInForce: order.timeInForce,
      reduceOnly: order.reduceOnly,
      postOnly: order.postOnly,
      filledSize: order.filledSize.toString(),
      avgFillPrice: order.avgFillPrice.toString(),
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    },
    timestamp: Date.now(),
  });

  for (const ws of wsSet) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * 推送所有待处理订单给交易者
 */
function broadcastPendingOrders(trader: Address): void {
  if (!wss) return;

  const normalizedTrader = trader.toLowerCase() as Address;
  const wsSet = wsTraderClients.get(normalizedTrader);
  if (!wsSet || wsSet.size === 0) return;

  const orders = engine.getUserOrders(normalizedTrader);
  const pendingOrders = orders.filter(o =>
    o.status === OrderStatus.PENDING || o.status === OrderStatus.PARTIALLY_FILLED
  );

  const message = JSON.stringify({
    type: "orders",
    orders: pendingOrders.map(o => ({
      id: o.id,
      orderId: o.orderId,
      clientOrderId: o.clientOrderId,
      trader: o.trader,
      token: o.token,
      isLong: o.isLong,
      size: o.size.toString(),
      price: o.price.toString(),
      leverage: o.leverage.toString(),
      margin: o.margin.toString(),
      fee: o.fee.toString(),
      orderType: o.orderType,
      timeInForce: o.timeInForce,
      reduceOnly: o.reduceOnly,
      postOnly: o.postOnly,
      filledSize: o.filledSize.toString(),
      avgFillPrice: o.avgFillPrice.toString(),
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    })),
    timestamp: Date.now(),
  });

  for (const ws of wsSet) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

// AUDIT-FIX H-01: Changed to async for signature verification in subscribe_risk
async function handleWSMessage(ws: WebSocket, message: string): Promise<void> {
  // 处理 ping/pong 心跳
  if (message === "ping") {
    ws.send("pong");
    return;
  }

  try {
    const msg = JSON.parse(message) as WSMessage & { trader?: string; data?: any; request_id?: string };

    // ✅ 新增：处理带 request_id 的 subscribe 请求（新 API 格式）
    if (msg.type === "subscribe" && msg.data && Array.isArray(msg.data.topics)) {
      const tokens = wsClients.get(ws) || new Set();

      // 订阅所有 topics
      for (const topic of msg.data.topics) {
        // 提取 token 地址: "tickers:0x123" -> "0x123", 或纯地址 "0x123" -> "0x123"
        const parts = topic.split(':');
        if (parts.length >= 2) {
          const token = parts[1].toLowerCase() as Address;
          tokens.add(token);
          console.log(`[WS] Client subscribed to topic: ${topic}`);
        } else if (topic.startsWith("0x")) {
          // 前端直接发纯 token 地址 (useOnChainTrades 的格式)
          tokens.add(topic.toLowerCase() as Address);
          console.log(`[WS] Client subscribed to token address: ${topic}`);
        }
      }

      wsClients.set(ws, tokens);

      // 立即发送每个 token 的 orderbook + market_data
      for (const token of tokens) {
        broadcastOrderBook(token);
        sendMarketDataToClient(ws, token);
      }

      // ✅ 发送确认响应（防止前端超时）
      if (msg.request_id) {
        ws.send(JSON.stringify({
          type: "subscribe",
          request_id: msg.request_id,
          data: { success: true, topics: msg.data.topics },
          timestamp: Date.now(),
        }));
      }
    }
    // ✅ 处理旧格式：subscribe with token field
    else if (msg.type === "subscribe" && msg.token) {
      const tokens = wsClients.get(ws) || new Set();
      tokens.add(msg.token.toLowerCase() as Address);
      wsClients.set(ws, tokens);

      // Send current orderbook + market_data immediately
      broadcastOrderBook(msg.token.toLowerCase() as Address);
      sendMarketDataToClient(ws, msg.token.toLowerCase() as Address);
      console.log(`[WS] Client subscribed to ${msg.token}`);

      // ✅ 发送确认响应
      if (msg.request_id) {
        ws.send(JSON.stringify({
          type: "subscribe",
          request_id: msg.request_id,
          data: { success: true, token: msg.token },
          timestamp: Date.now(),
        }));
      }
    }
    // ✅ 新增：处理 subscribe_token（直接格式）
    else if (msg.type === "subscribe_token" && msg.token) {
      const tokens = wsClients.get(ws) || new Set();
      tokens.add(msg.token.toLowerCase() as Address);
      wsClients.set(ws, tokens);
      console.log(`[WS] Client subscribed to token: ${msg.token}`);

      // 立即发送当前市场数据 (orderbook + market_data)
      broadcastOrderBook(msg.token.toLowerCase() as Address);
      sendMarketDataToClient(ws, msg.token.toLowerCase() as Address);
    }
    // ✅ 新增：处理 unsubscribe 请求（新 API 格式）
    else if (msg.type === "unsubscribe" && msg.data && Array.isArray(msg.data.topics)) {
      const tokens = wsClients.get(ws);
      if (tokens) {
        for (const topic of msg.data.topics) {
          const parts = topic.split(':');
          if (parts.length >= 2) {
            const token = parts[1].toLowerCase() as Address;
            tokens.delete(token);
            console.log(`[WS] Client unsubscribed from topic: ${topic}`);
          } else if (topic.startsWith("0x")) {
            tokens.delete(topic.toLowerCase() as Address);
            console.log(`[WS] Client unsubscribed from token address: ${topic}`);
          }
        }
      }

      // ✅ 发送确认响应
      if (msg.request_id) {
        ws.send(JSON.stringify({
          type: "unsubscribe",
          request_id: msg.request_id,
          data: { success: true, topics: msg.data.topics },
          timestamp: Date.now(),
        }));
      }
    }
    // ✅ 处理旧格式：unsubscribe with token field
    else if (msg.type === "unsubscribe" && msg.token) {
      const tokens = wsClients.get(ws);
      if (tokens) {
        tokens.delete(msg.token.toLowerCase() as Address);
      }
      console.log(`[WS] Client unsubscribed from ${msg.token}`);

      // ✅ 发送确认响应
      if (msg.request_id) {
        ws.send(JSON.stringify({
          type: "unsubscribe",
          request_id: msg.request_id,
          data: { success: true, token: msg.token },
          timestamp: Date.now(),
        }));
      }
    }
    // ✅ 新增：处理 unsubscribe_token（直接格式）
    else if (msg.type === "unsubscribe_token" && msg.token) {
      const tokens = wsClients.get(ws);
      if (tokens) {
        tokens.delete(msg.token.toLowerCase() as Address);
      }
      console.log(`[WS] Client unsubscribed from token: ${msg.token}`);
    }
    // AUDIT-FIX H-01: subscribe_risk requires signature authentication
    // Client must send: { type: "subscribe_risk", trader, signature, timestamp }
    // Signature signs message: "subscribe_risk:{trader}:{timestamp}"
    // Timestamp must be within 5 minutes to prevent replay attacks
    else if (msg.type === "subscribe_risk" && msg.trader) {
      const trader = msg.trader.toLowerCase() as Address;

      // Verify ownership of trader address
      if (!SKIP_SIGNATURE_VERIFY_ENV) {
        const { signature, timestamp } = msg;
        if (!signature || !timestamp) {
          ws.send(JSON.stringify({
            type: "error",
            error: "subscribe_risk requires signature and timestamp for authentication",
            timestamp: Date.now(),
          }));
          return;
        }
        // Anti-replay: timestamp must be within 5 minutes
        const now = Math.floor(Date.now() / 1000);
        const ts = Number(timestamp);
        if (Math.abs(now - ts) > 300) {
          ws.send(JSON.stringify({
            type: "error",
            error: "subscribe_risk timestamp expired (must be within 5 minutes)",
            timestamp: Date.now(),
          }));
          return;
        }
        const expectedMessage = `subscribe_risk:${trader}:${timestamp}`;
        const auth = await verifyTraderSignature(trader, signature, expectedMessage);
        if (!auth.valid) {
          ws.send(JSON.stringify({
            type: "error",
            error: `subscribe_risk auth failed: ${auth.error}`,
            timestamp: Date.now(),
          }));
          return;
        }
      }

      const wsSet = wsTraderClients.get(trader) || new Set();
      wsSet.add(ws);
      wsTraderClients.set(trader, wsSet);

      // 立即发送当前仓位风险数据
      const positions = userPositions.get(trader) || [];
      if (positions.length > 0) {
        const positionRisks = positions.map(pos => ({
          pairId: pos.pairId,
          trader: pos.trader,
          token: pos.token,
          isLong: pos.isLong,
          size: pos.size,
          entryPrice: pos.entryPrice,
          leverage: pos.leverage,
          marginRatio: pos.marginRatio || "10000",
          mmr: pos.mmr || "200",
          roe: pos.roe || "0",
          liquidationPrice: pos.liquidationPrice || "0",
          markPrice: pos.markPrice || "0",
          unrealizedPnL: pos.unrealizedPnL || "0",
          collateral: pos.collateral,
          adlScore: parseFloat(pos.adlScore || "0"),
          adlRanking: pos.adlRanking || 1,
          riskLevel: pos.riskLevel || "low",
        }));

        ws.send(JSON.stringify({
          type: "position_risks",
          positions: positionRisks,
          timestamp: Date.now(),
        }));
      }

      // 推送待处理订单
      broadcastPendingOrders(trader);

      console.log(`[WS] Trader ${trader.slice(0, 10)} subscribed to risk data`);
    }
    // 取消风控数据订阅
    else if (msg.type === "unsubscribe_risk" && msg.trader) {
      const trader = msg.trader.toLowerCase() as Address;
      const wsSet = wsTraderClients.get(trader);
      if (wsSet) {
        wsSet.delete(ws);
        if (wsSet.size === 0) {
          wsTraderClients.delete(trader);
        }
      }
      console.log(`[WS] Trader ${trader.slice(0, 10)} unsubscribed from risk data`);
    }
    // AUDIT-FIX M-01: subscribe_global_risk requires signature authentication
    // Client must send: { type: "subscribe_global_risk", trader, signature, timestamp }
    // Signature signs message: "subscribe_global_risk:{trader}:{timestamp}"
    // Only authenticated traders can see global risk data (insurance fund, liquidation queue)
    else if (msg.type === "subscribe_global_risk") {
      if (!SKIP_SIGNATURE_VERIFY_ENV) {
        const { trader, signature, timestamp } = msg;
        if (!trader || !signature || !timestamp) {
          ws.send(JSON.stringify({
            type: "error",
            error: "subscribe_global_risk requires trader, signature and timestamp for authentication",
            timestamp: Date.now(),
          }));
          return;
        }
        const normalizedTrader = trader.toLowerCase() as Address;
        // Anti-replay: timestamp must be within 5 minutes
        const now = Math.floor(Date.now() / 1000);
        const ts = Number(timestamp);
        if (Math.abs(now - ts) > 300) {
          ws.send(JSON.stringify({
            type: "error",
            error: "subscribe_global_risk timestamp expired (must be within 5 minutes)",
            timestamp: Date.now(),
          }));
          return;
        }
        const expectedMessage = `subscribe_global_risk:${normalizedTrader}:${timestamp}`;
        const auth = await verifyTraderSignature(normalizedTrader, signature, expectedMessage);
        if (!auth.valid) {
          ws.send(JSON.stringify({
            type: "error",
            error: `subscribe_global_risk auth failed: ${auth.error}`,
            timestamp: Date.now(),
          }));
          return;
        }
      }
      wsRiskSubscribers.add(ws);

      // 立即发送当前全局风控数据
      const insuranceFundData = {
        balance: insuranceFund.balance.toString(),
        totalContributions: insuranceFund.totalContributions.toString(),
        totalPayouts: insuranceFund.totalPayouts.toString(),
        lastUpdated: insuranceFund.lastUpdated,
        display: {
          balance: (Number(insuranceFund.balance) / 1e18).toFixed(2),
          totalContributions: (Number(insuranceFund.totalContributions) / 1e18).toFixed(2),
          totalPayouts: (Number(insuranceFund.totalPayouts) / 1e18).toFixed(2),
        },
      };

      ws.send(JSON.stringify({
        type: "risk_data",
        liquidationQueue: [],
        insuranceFund: insuranceFundData,
        fundingRates: [],
        timestamp: Date.now(),
      }));

      console.log(`[WS] Client subscribed to global risk data`);
    }
    // 取消全局风控数据订阅
    else if (msg.type === "unsubscribe_global_risk") {
      wsRiskSubscribers.delete(ws);
      console.log(`[WS] Client unsubscribed from global risk data`);
    }
    // ✅ 首页订阅所有代币的市场统计（volume/traders/价格变化）
    else if (msg.type === "subscribe_all_market_stats") {
      wsMarketStatsSubscribers.add(ws);
      console.log(`[WS] Client subscribed to all_market_stats (${wsMarketStatsSubscribers.size} subscribers)`);

      // 立即发送一次完整数据（不等 3 秒周期）
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const stats: Record<string, any> = {};
      for (const [addr] of TOKEN_INFO_CACHE) {
        const normalizedToken = addr.toLowerCase() as Address;
        const orderBook = engine.getOrderBook(normalizedToken);
        const trades = engine.getRecentTrades(normalizedToken, 100);
        let currentPrice = orderBook.getCurrentPrice();
        if (currentPrice <= 0n) currentPrice = engine.getSpotPrice(normalizedToken);
        // ✅ 最终回退: 从 cachedSpotStats 获取价格 (避免 currentPrice=0 导致 -100%)
        if (currentPrice <= 0n) {
          const spotFallback = cachedSpotStats.get(normalizedToken);
          if (spotFallback) {
            const spotPrice = parseFloat(spotFallback.high24h || spotFallback.open24h || "0");
            if (spotPrice > 0) currentPrice = BigInt(Math.floor(spotPrice * 1e18));
          }
        }
        const trades24h = trades.filter(t => t.timestamp >= oneDayAgo);
        let volume24h = 0n, high24h = currentPrice, low24h = currentPrice, open24h = currentPrice, trades24hCount = 0;
        if (trades24h.length > 0) {
          open24h = trades24h[trades24h.length - 1].price;
          trades24hCount = trades24h.length;
          for (const t of trades24h) {
            if (t.price > high24h) high24h = t.price;
            if (t.price < low24h) low24h = t.price;
            volume24h += (t.size * t.price) / (10n ** 18n);
          }
        }
        const spotStats = cachedSpotStats.get(normalizedToken);
        if (spotStats) {
          const spotVolumeEth = parseFloat(spotStats.volume24h || "0");
          if (spotVolumeEth > 0) volume24h += BigInt(Math.floor(spotVolumeEth * 1e18));
          trades24hCount += spotStats.trades24h || 0;
        }
        const priceChange = currentPrice - open24h;
        const priceChangePercent = open24h > 0n ? Number(priceChange * 10000n / open24h) / 100 : 0;
        const { longOI, shortOI } = calculateOpenInterest(normalizedToken);
        stats[normalizedToken] = {
          lastPrice: currentPrice.toString(),
          volume24h: volume24h.toString(),
          trades24h: trades24hCount,
          priceChangePercent24h: priceChangePercent.toFixed(2),
          high24h: high24h.toString(),
          low24h: low24h.toString(),
          openInterest: (longOI + shortOI).toString(),
        };
      }
      ws.send(JSON.stringify({ type: "all_market_stats", data: stats, timestamp: now }));
    }
    // ✅ 取消首页市场统计订阅
    else if (msg.type === "unsubscribe_all_market_stats") {
      wsMarketStatsSubscribers.delete(ws);
      console.log(`[WS] Client unsubscribed from all_market_stats`);
    }
    // ✅ 返回所有代币 name/symbol（前端 WSS-only 架构）
    else if (msg.type === "get_all_token_info") {
      const data: Record<string, { name: string; symbol: string }> = {};
      for (const [addr, info] of TOKEN_INFO_CACHE) {
        data[addr] = info;
      }
      ws.send(JSON.stringify({
        type: "all_token_info",
        data,
        timestamp: Date.now(),
      }));
      console.log(`[WS] Sent all_token_info (${TOKEN_INFO_CACHE.size} tokens)`);
    }
    // ✅ 返回完整代币列表 (替代前端 400+ RPC 调用)
    else if (msg.type === "get_all_tokens") {
      const TOTAL_SUPPLY_WEI = 1000000000n * 10n ** 18n; // 1B tokens
      const tokens: Array<Record<string, unknown>> = [];
      for (const addr of SUPPORTED_TOKENS) {
        const normalizedAddr = addr.toLowerCase();
        const info = TOKEN_INFO_CACHE.get(normalizedAddr);
        const pool = TOKEN_POOL_CACHE.get(normalizedAddr);
        if (!pool) continue;
        const priceWei = BigInt(pool.price || "0");
        const marketCapWei = priceWei > 0n ? (priceWei * TOTAL_SUPPLY_WEI) / 10n ** 18n : 0n;

        tokens.push({
          address: addr,
          name: info?.name || "Unknown",
          symbol: info?.symbol || "???",
          creator: pool.creator,
          createdAt: pool.createdAt,
          isGraduated: pool.isGraduated,
          isActive: pool.isActive,
          metadataURI: pool.metadataURI,
          perpEnabled: pool.perpEnabled,
          price: priceWei.toString(),
          marketCap: marketCapWei.toString(),
          soldSupply: pool.soldTokens,
          realETHReserve: formatUnits(BigInt(pool.realETHReserve || "0"), 18),
        });
      }
      ws.send(JSON.stringify({
        type: "all_tokens",
        data: tokens,
        timestamp: Date.now(),
      }));
      console.log(`[WS] Sent all_tokens (${tokens.length} tokens)`);
    }
    // ── P1-4: 重连后主动拉取状态 ──
    else if (msg.type === "get_positions" && msg.trader) {
      const normalizedTrader = (msg.trader as string).toLowerCase() as Address;
      const positions = userPositions.get(normalizedTrader) || [];
      ws.send(JSON.stringify({
        type: "position_risks",
        positions: positions.map(p => ({
          ...p,
          size: p.size?.toString(),
          entryPrice: p.entryPrice?.toString(),
          collateral: p.collateral?.toString(),
          margin: p.margin?.toString(),
          unrealizedPnL: p.unrealizedPnL?.toString(),
          liquidationPrice: p.liquidationPrice?.toString(),
          markPrice: p.markPrice?.toString(),
        })),
        timestamp: Date.now(),
      }));
    }
    else if (msg.type === "get_balance" && msg.trader) {
      const normalizedTrader = (msg.trader as string).toLowerCase() as Address;
      const balance = getUserBalance(normalizedTrader);
      ws.send(JSON.stringify({
        type: "balance",
        data: {
          trader: normalizedTrader,
          totalBalance: balance.totalBalance.toString(),
          availableBalance: balance.availableBalance.toString(),
          usedMargin: (balance.usedMargin || 0n).toString(),
          frozenMargin: (balance.frozenMargin || 0n).toString(),
          unrealizedPnL: (balance.unrealizedPnL || 0n).toString(),
          equity: (balance.totalBalance + (balance.unrealizedPnL || 0n)).toString(),
        },
        timestamp: Date.now(),
      }));
    }
    else if (msg.type === "get_pending_orders" && msg.trader) {
      const normalizedTrader = (msg.trader as string).toLowerCase() as Address;
      const allOrders = engine.getUserOrders(normalizedTrader);
      ws.send(JSON.stringify({
        type: "orders",
        orders: allOrders.map(o => ({
          ...o,
          size: o.size?.toString(),
          price: o.price?.toString(),
          filledSize: o.filledSize?.toString(),
          avgFillPrice: o.avgFillPrice?.toString(),
          margin: o.margin?.toString(),
          fee: o.fee?.toString(),
          leverage: o.leverage?.toString(),
        })),
        timestamp: Date.now(),
      }));
    }
    // ── WS Auth + Subscribe handler (with signature verification) ──
    else if ((msg.type === "auth" || msg.type === "subscribe_trader") && msg.trader) {
      const normalizedTrader = (msg.trader as string).toLowerCase() as Address;

      if (!SKIP_SIGNATURE_VERIFY_ENV) {
        const { signature, timestamp } = msg;
        if (!signature || !timestamp) {
          ws.send(JSON.stringify({
            type: "error",
            error: `${msg.type} requires signature and timestamp for authentication`,
            timestamp: Date.now(),
          }));
          return;
        }
        // Anti-replay: timestamp must be within 5 minutes
        const now = Math.floor(Date.now() / 1000);
        const ts = Number(timestamp);
        if (Math.abs(now - ts) > 300) {
          ws.send(JSON.stringify({
            type: "error",
            error: `${msg.type} timestamp expired (must be within 5 minutes)`,
            timestamp: Date.now(),
          }));
          return;
        }
        const expectedMessage = `${msg.type}:${normalizedTrader}:${timestamp}`;
        const auth = await verifyTraderSignature(normalizedTrader, signature, expectedMessage);
        if (!auth.valid) {
          ws.send(JSON.stringify({
            type: "error",
            error: `${msg.type} auth failed: ${auth.error}`,
            timestamp: Date.now(),
          }));
          return;
        }
      }

      if (msg.type === "auth") {
        ws.send(JSON.stringify({ type: "auth_success", timestamp: Date.now() }));
      }

      // Subscribe trader to personal updates
      const wsSet = wsTraderClients.get(normalizedTrader) || new Set();
      wsSet.add(ws);
      wsTraderClients.set(normalizedTrader, wsSet);
    }
  } catch (e) {
    console.error("[WS] Invalid message:", e);
  }
}

/**
 * 清理 WebSocket 连接相关的所有订阅
 */
function cleanupWSConnection(ws: WebSocket): void {
  // 清理 token 订阅
  wsClients.delete(ws);

  // 清理 trader 风控订阅
  for (const [trader, wsSet] of wsTraderClients.entries()) {
    wsSet.delete(ws);
    if (wsSet.size === 0) {
      wsTraderClients.delete(trader);
    }
  }

  // 清理全局风控订阅
  wsRiskSubscribers.delete(ws);

  // 清理首页市场统计订阅
  wsMarketStatsSubscribers.delete(ws);
}

// ============================================================
// Server Start
// ============================================================

async function startServer(): Promise<void> {
  // ========================================
  // 连接 Redis 数据库
  // ========================================
  console.log("[Server] Connecting to Redis...");
  const redisConnected = await db.connect();
  // Also connect the new Redis module (used by spotHistory, balance, etc.)
  await connectNewRedis();

  // P1-5: 连接 PostgreSQL（订单镜像，非阻塞）
  console.log("[Server] Connecting to PostgreSQL (order mirror)...");
  const pgConnected = await connectPostgres();
  if (pgConnected) {
    console.log("[Server] ✅ PostgreSQL connected — order + position mirroring enabled");
    // L1: Register PG dual-write callback for event poller block cursors
    setBlockPersistPgCallback((name, block) => {
      pgMirrorWrite(SyncStateRepo.upsert(`eventPoller:lastBlock:${name}`, block.toString()), `SyncState:${name}`);
    });
  } else {
    console.warn("[Server] ⚠️ PostgreSQL not available — running with Redis only (orders not mirrored)");
  }

  if (redisConnected) {
    console.log("[Server] Redis connected successfully");

    // 从 Redis 加载已有仓位到内存 (兼容现有风控引擎)
    await loadPositionsFromRedis();

    // P1-1: 从 Redis BalanceRepo 恢复余额 (比全量链上同步快 100x)
    // 注意: 仅恢复 key fields，chain sync 仍会在 syncAllBalances 中更新
    try {
      const allTraders = new Set<string>();
      // 收集所有已知 trader 地址 (从仓位 + nonce 列表)
      // ★ 必须包含无仓位用户，否则 Merkle 快照会跳过他们 → 无法提款
      for (const [trader] of userPositions) allTraders.add(trader);
      for (const [trader] of userNonces) allTraders.add(trader);
      // 从 Redis 恢复已持久化的余额
      let restoredCount = 0;
      for (const traderAddr of allTraders) {
        const normalized = traderAddr.toLowerCase() as Address;
        const saved = await RedisBalanceRepo.getOrCreate(normalized);
        if (saved.walletBalance > 0n || saved.availableBalance > 0n || saved.usedMargin > 0n) {
          const balance = getUserBalance(normalized);
          balance.walletBalance = saved.walletBalance;
          balance.availableBalance = saved.availableBalance;
          balance.usedMargin = saved.usedMargin;
          balance.frozenMargin = saved.frozenMargin;
          balance.unrealizedPnL = saved.unrealizedPnL;
          balance.totalBalance = saved.equity; // Redis equity → server totalBalance
          restoredCount++;
        }
      }
      console.log(`[Server] P1-1: Restored ${restoredCount}/${allTraders.size} user balances from Redis BalanceRepo`);
    } catch (e) {
      console.error("[Server] Failed to restore balances from Redis:", e);
    }

    // AUDIT-FIX ME-C06: 从 Redis 恢复用户 nonce (防重启后重放攻击)
    try {
      const savedNonces = await NonceRepo.getAll();
      for (const [user, nonce] of savedNonces) {
        userNonces.set(user.toLowerCase() as Address, nonce);
      }
      console.log(`[Server] Restored ${savedNonces.size} user nonces from Redis`);
    } catch (e) {
      console.error("[Server] Failed to restore user nonces:", e);
    }

    // 从 Redis 恢复订单保证金记录 (重启后撤单退款依赖此数据)
    try {
      const savedMargins = await OrderMarginRepo.getAll();
      for (const [orderId, info] of savedMargins) {
        orderMarginInfos.set(orderId, {
          margin: info.margin,
          fee: info.fee,
          totalDeducted: info.totalDeducted,
          totalSize: info.totalSize,
          settledSize: info.settledSize,
        });
      }
      console.log(`[Server] Restored ${savedMargins.size} order margin records from Redis`);
    } catch (e) {
      console.error("[Server] Failed to restore order margin records:", e);
    }

    // 从 Redis 恢复主钱包→派生钱包映射 (余额查询依赖)
    try {
      const { getRedisClient: getDerivedRedis } = await import("./database/redis");
      const derivedRedis = getDerivedRedis();
      const mappings = await derivedRedis.hgetall(DERIVED_WALLET_MAP_KEY);
      let mapCount = 0;
      for (const [owner, derived] of Object.entries(mappings)) {
        traderToDerivedWallet.set(owner.toLowerCase() as Address, derived.toLowerCase() as Address);
        mapCount++;
      }
      if (mapCount > 0) {
        console.log(`[Server] Restored ${mapCount} owner→derived wallet mappings from Redis`);
      }
    } catch (e) {
      console.error("[Server] Failed to restore derived wallet mappings:", e);
    }

    // 从 Redis 恢复 Mode 2 链下盈亏调整 (平仓盈亏、资金费等)
    try {
      if (RESET_MODE2_ON_START) {
        // Clear stale mode2 adjustments (e.g. from old fake deposits before real on-chain deposits)
        const staleAdjustments = await Mode2AdjustmentRepo.getAll();
        for (const [user] of staleAdjustments) {
          await Mode2AdjustmentRepo.save(user.toLowerCase() as Address, 0n);
        }
        console.log(`[Server] RESET_MODE2_ON_START: cleared ${staleAdjustments.size} stale Mode 2 adjustments`);
      } else {
        const savedAdjustments = await Mode2AdjustmentRepo.getAll();
        for (const [user, adj] of savedAdjustments) {
          mode2PnLAdjustments.set(user.toLowerCase() as Address, adj);
        }
        console.log(`[Server] Restored ${savedAdjustments.size} Mode 2 PnL adjustments from Redis`);

        // P1-3: 启动对账 — Redis vs PG Mode2 累计值
        if (isPostgresConnected()) {
          try {
            const pgMode2 = await Mode2AdjustmentMirrorRepo.getAll();
            let mismatchCount = 0;
            for (const [user, redisVal] of savedAdjustments) {
              const pgVal = pgMode2.get(user) || 0n;
              if (redisVal !== pgVal) {
                mismatchCount++;
                console.warn(`[Reconcile] ⚠️ Mode2 mismatch: ${user.slice(0, 10)} Redis=${Number(redisVal)/1e18} PG=${Number(pgVal)/1e18}`);
                // 以 Redis 为准（Redis 是主存储），但记录告警
                // 如果 Redis 丢失（值为 0 而 PG 不为 0），以 PG 为准恢复
                if (redisVal === 0n && pgVal !== 0n) {
                  mode2PnLAdjustments.set(user.toLowerCase() as Address, pgVal);
                  Mode2AdjustmentRepo.save(user.toLowerCase() as Address, pgVal).catch(() => {});
                  console.warn(`[Reconcile] ✅ Restored ${user.slice(0, 10)} from PG: Ξ${Number(pgVal)/1e18}`);
                }
              }
            }
            // Check PG entries not in Redis
            for (const [user, pgVal] of pgMode2) {
              if (!savedAdjustments.has(user) && pgVal !== 0n) {
                mismatchCount++;
                console.warn(`[Reconcile] ⚠️ Mode2 in PG but not Redis: ${user.slice(0, 10)} PG=Ξ${Number(pgVal)/1e18}`);
                mode2PnLAdjustments.set(user.toLowerCase() as Address, pgVal);
                Mode2AdjustmentRepo.save(user.toLowerCase() as Address, pgVal).catch(() => {});
                console.warn(`[Reconcile] ✅ Restored ${user.slice(0, 10)} from PG: Ξ${Number(pgVal)/1e18}`);
              }
            }
            if (mismatchCount === 0) {
              console.log(`[Reconcile] ✅ Mode2 reconciliation passed: ${savedAdjustments.size} Redis = ${pgMode2.size} PG entries`);
            } else {
              console.warn(`[Reconcile] ⚠️ ${mismatchCount} Mode2 mismatches found and resolved`);
            }
          } catch (reconErr) {
            console.error(`[Reconcile] Mode2 reconciliation failed:`, reconErr);
          }
        }
      }
    } catch (e) {
      console.error("[Server] Failed to restore Mode 2 adjustments:", e);
    }

    // P1-3: 启动对账 — Redis Mode2 vs PG Mode2
    // 参考 dYdX Ender 的"每区块原子应用"思路 — 我们启动时做一次对账
    if (isPostgresConnected()) {
      try {
        const pgMode2 = await Mode2AdjustmentMirrorRepo.getAll();
        let mismatchCount = 0;
        for (const [user, pgValue] of pgMode2) {
          const normalized = user.toLowerCase() as Address;
          const redisValue = mode2PnLAdjustments.get(normalized) || 0n;
          if (redisValue !== pgValue) {
            mismatchCount++;
            console.warn(`[P1-3] Mode2 mismatch: ${normalized.slice(0, 10)} Redis=${redisValue} PG=${pgValue}`);
            // PG is more durable — use it when Redis disagrees and isn't reset
            if (!RESET_MODE2_ON_START) {
              mode2PnLAdjustments.set(normalized, pgValue);
              Mode2AdjustmentRepo.save(normalized, pgValue).catch(() => {});
            }
          }
        }
        if (mismatchCount > 0) {
          console.warn(`[P1-3] Fixed ${mismatchCount} Mode2 mismatches (PG → Redis)`);
        } else {
          console.log(`[P1-3] Mode2 reconciliation: ${pgMode2.size} entries consistent`);
        }
      } catch (e) {
        console.error("[P1-3] Mode2 reconciliation failed:", e);
      }
    }

    // 从 Redis 恢复待确认提款 mode2 扣减记录
    try {
      const pendingCount = await loadPendingWithdrawalMode2s();
      if (pendingCount > 0) {
        console.log(`[Server] ⚠️ ${pendingCount} pending withdrawal mode2 deductions loaded — reconciliation will run in 60s`);
      }
    } catch (e) {
      console.error("[Server] Failed to load pending withdrawal mode2 records:", e);
    }

    // 从 Redis 恢复保险基金 (防重启后归零)
    try {
      const savedGlobal = await InsuranceFundRepo.getGlobal();
      if (savedGlobal) {
        insuranceFund.balance = savedGlobal.balance;
        insuranceFund.totalContributions = savedGlobal.totalContributions;
        insuranceFund.totalPayouts = savedGlobal.totalPayouts;
        insuranceFund.lastUpdated = savedGlobal.lastUpdated;
      }
      const savedTokenFunds = await InsuranceFundRepo.getAllTokens();
      for (const [token, fund] of savedTokenFunds) {
        tokenInsuranceFunds.set(token.toLowerCase() as Address, {
          balance: fund.balance,
          totalContributions: fund.totalContributions,
          totalPayouts: fund.totalPayouts,
          lastUpdated: fund.lastUpdated,
        });
      }
      const globalBal = Number(insuranceFund.balance) / 1e18;
      console.log(`[Server] Restored insurance fund from Redis: global=$${globalBal.toFixed(4)}, ${savedTokenFunds.size} token funds`);
    } catch (e) {
      console.error("[Server] Failed to restore insurance fund:", e);
    }

    // H-6: 从 Redis 恢复推荐系统数据 — 逐条 try-catch，一条坏数据不影响其余
    {
      let referrerOk = 0, referrerFail = 0, refereeOk = 0, refereeFail = 0;
      try {
        const savedReferrers = await ReferralRepo.getAllReferrers();
        for (const [addr, data] of savedReferrers) {
          try {
            const referrer: Referrer = {
              address: addr as Address,
              code: data.code,
              level1Referrals: JSON.parse(data.level1Referrals || "[]"),
              level2Referrals: JSON.parse(data.level2Referrals || "[]"),
              totalEarnings: BigInt(data.totalEarnings || "0"),
              pendingEarnings: BigInt(data.pendingEarnings || "0"),
              withdrawnEarnings: BigInt(data.withdrawnEarnings || "0"),
              level1Earnings: BigInt(data.level1Earnings || "0"),
              level2Earnings: BigInt(data.level2Earnings || "0"),
              totalTradesReferred: parseInt(data.totalTradesReferred || "0"),
              totalVolumeReferred: BigInt(data.totalVolumeReferred || "0"),
              createdAt: parseInt(data.createdAt || "0"),
              updatedAt: parseInt(data.updatedAt || "0"),
            };
            referrers.set(addr as Address, referrer);
            referralCodes.set(referrer.code, addr as Address);
            referrerOk++;
          } catch (e) {
            referrerFail++;
            console.error(`[Server] Failed to restore referrer ${addr.slice(0, 10)}:`, e);
          }
        }
      } catch (e) {
        console.error("[Server] Failed to fetch referrers from Redis:", e);
      }

      try {
        const savedReferees = await ReferralRepo.getAllReferees();
        for (const [addr, data] of savedReferees) {
          try {
            const referee: Referee = {
              address: addr as Address,
              referrerCode: data.referrerCode,
              referrer: data.referrer as Address,
              level2Referrer: data.level2Referrer ? data.level2Referrer as Address : null,
              totalFeesPaid: BigInt(data.totalFeesPaid || "0"),
              totalCommissionGenerated: BigInt(data.totalCommissionGenerated || "0"),
              joinedAt: parseInt(data.joinedAt || "0"),
            };
            referees.set(addr as Address, referee);
            refereeOk++;
          } catch (e) {
            refereeFail++;
            console.error(`[Server] Failed to restore referee ${addr.slice(0, 10)}:`, e);
          }
        }
      } catch (e) {
        console.error("[Server] Failed to fetch referees from Redis:", e);
      }

      console.log(`[Server] Restored referral data: ${referrerOk} referrers (${referrerFail} failed), ${refereeOk} referees (${refereeFail} failed), ${referralCodes.size} codes`);
    }
  } else {
    console.warn("[Server] Redis connection failed, using in-memory storage only");
  }

  // ❌ Mode 2: submitter 已移除，不再提交仓位到链上
  // 链上只做资金托管，不做仓位结算
  console.log("[Server] Mode 2: On-chain position settlement DISABLED");

  // ============================================================
  // 初始化 Mode 2 模块 (dYdX v3 style: Merkle 快照 + 提现签名)
  // ============================================================

  // 判断是否启用 SettlementV2 Merkle 提款系统
  const useSettlementV2 = !!(SETTLEMENT_V2_ADDRESS && MATCHER_PRIVATE_KEY);

  if (useSettlementV2) {
    // --- SettlementV2 Merkle 路径 (dYdX v3 行业主流方案) ---
    const v2UpdaterAccount = privateKeyToAccount(MATCHER_PRIVATE_KEY);
    const v2WalletClient = createWalletClient({
      account: v2UpdaterAccount,
      chain: activeChain,
      transport: rpcTransport,
    });
    const v2PublicClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });

    // ★ 启动时同步所有已知用户的链上余额 (从 nonce 列表获取用户地址)
    // 确保 userBalances Map 被填充，否则 Merkle 快照会是空的
    if (process.env.SKIP_BALANCE_SYNC === "true") {
      // ★ Even with SKIP, sync users whose walletBalance is still 0 after Redis restore
      // Without this, Merkle snapshot calculates equity=0 → user excluded → cannot withdraw
      const knownTraders = Array.from(userNonces.keys());
      const missingBalanceTraders = knownTraders.filter(t => {
        const bal = getUserBalance(t);
        return bal.walletBalance === 0n && bal.totalBalance === 0n;
      });
      if (missingBalanceTraders.length > 0) {
        console.log(`[Server] SKIP_BALANCE_SYNC=true — but syncing ${missingBalanceTraders.length} users with no Redis balance...`);
        const BATCH_SIZE = 10;
        let syncedCount = 0;
        for (let i = 0; i < missingBalanceTraders.length; i += BATCH_SIZE) {
          const batch = missingBalanceTraders.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(
            batch.map(async (user) => {
              try {
                await syncUserBalanceFromChain(user);
                syncedCount++;
              } catch (e: any) {
                console.debug(`[Server] Balance gap-fill skipped for ${user.slice(0, 10)}: ${e.message}`);
              }
            })
          );
        }
        console.log(`[Server] Gap-filled ${syncedCount}/${missingBalanceTraders.length} user balances from chain`);
      } else {
        console.log(`[Server] SKIP_BALANCE_SYNC=true — all ${knownTraders.length} users have Redis balance, no chain sync needed`);
      }
    } else {
      const knownTraders = Array.from(userNonces.keys());
      console.log(`[Server] Syncing on-chain balances for ${knownTraders.length} known users...`);
      let syncedCount = 0;
      const BATCH_SIZE = 10;
      for (let i = 0; i < knownTraders.length; i += BATCH_SIZE) {
        const batch = knownTraders.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map(async (user) => {
            try {
              await syncUserBalanceFromChain(user);
              syncedCount++;
            } catch (e: any) {
              console.debug(`[Server] Balance sync skipped for ${user.slice(0, 10)}: ${e.message}`);
            }
          })
        );
      }
      console.log(`[Server] Synced ${syncedCount}/${knownTraders.length} user balances from chain`);
    }

    // 初始化 Snapshot 模块 — 带链上 root 提交
    initializeSnapshotModule({
      getBalance: getUserBalance,
      getPositions: (trader: Address) => userPositions.get(trader.toLowerCase() as Address) || [],
      getAllTraders: () => Array.from(userBalances.keys()) as Address[],
      submitRoot: async (root: Hex, _timestamp: number): Promise<Hex | null> => {
        try {
          const txHash = await v2WalletClient.writeContract({
            address: SETTLEMENT_V2_ADDRESS,
            abi: SETTLEMENT_V2_ABI,
            functionName: "updateStateRoot",
            args: [root as `0x${string}`],
          });
          // ★ 必须等待 TX 确认，否则 Merkle proof 会对旧 root 验证失败 (InvalidProof)
          await v2PublicClient.waitForTransactionReceipt({
            hash: txHash,
            confirmations: 1,
          });
          console.log(`[SettlementV2] State root confirmed: ${txHash}`);
          return txHash;
        } catch (e: any) {
          console.error(`[SettlementV2] Failed to submit state root: ${e.message}`);
          return null;
        }
      },
    });
    console.log(`[Server] Mode 2: Snapshot module initialized (SettlementV2: ${SETTLEMENT_V2_ADDRESS})`);

    // 初始化提现模块 — 使用 PLATFORM_SIGNER_KEY 签名 EIP-712 提款授权
    // Role separation: signer key ≠ on-chain tx key (dYdX v3 best practice)
    initializeWithdrawModule({
      signerPrivateKey: PLATFORM_SIGNER_KEY,
      contractAddress: SETTLEMENT_V2_ADDRESS,
      chainId: CONFIG_CHAIN_ID,
    });
    const signerAccount = privateKeyToAccount(PLATFORM_SIGNER_KEY);
    console.log(`[Server] Mode 2: Withdraw module initialized (signer: ${signerAccount.address.slice(0, 10)}...)`);

    // 从链上同步提款 nonce（防止引擎重启后 nonce 重放攻击）
    const v2ReadClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });
    const knownUsers = Array.from(userBalances.keys()) as Address[];
    if (knownUsers.length > 0) {
      syncNoncesFromChain(v2ReadClient, knownUsers).catch((e: any) =>
        console.error(`[Server] Nonce sync failed (non-fatal): ${e.message}`)
      );
    }

    // 启动快照定时任务 — 每分钟生成 Merkle root 并提交到链上
    const snapshotIntervalMs = parseInt(process.env.SNAPSHOT_INTERVAL_MS || "300000"); // 默认 5 分钟 (testnet), 生产环境设 3600000
    startSnapshotJob({
      intervalMs: snapshotIntervalMs,
      submitToChain: true, // SettlementV2 已配置，启用链上提交
      pruneAfterHours: 24,
    });
    console.log(`[Server] Mode 2: Snapshot job started (${snapshotIntervalMs / 1000}s interval, chain submission ON)`);
  } else if (MATCHER_PRIVATE_KEY && SETTLEMENT_ADDRESS) {
    // --- 降级模式: 无 SettlementV2，仅生成本地快照 (不提交链上) ---
    initializeSnapshotModule({
      getBalance: getUserBalance,
      getPositions: (trader: Address) => userPositions.get(trader.toLowerCase() as Address) || [],
      getAllTraders: () => Array.from(userBalances.keys()) as Address[],
    });

    initializeWithdrawModule({
      signerPrivateKey: PLATFORM_SIGNER_KEY,
      contractAddress: SETTLEMENT_ADDRESS,
      chainId: CONFIG_CHAIN_ID,
    });

    startSnapshotJob({
      intervalMs: 60 * 60 * 1000,
      submitToChain: false, // 无 SettlementV2，不提交链上
      pruneAfterHours: 24,
    });
    console.log("[Server] Mode 2: Fallback mode — snapshot only (no chain submission, awaiting SettlementV2 deployment)");
  } else {
    console.warn("[Server] Mode 2: MATCHER_PRIVATE_KEY missing, withdraw module disabled");
  }

  // Initialize Relay Service (P2)
  const { logRelayStatus } = await import("./modules/relay");
  logRelayStatus();

  // ============================================================
  // 初始化借贷清算模块
  // ============================================================
  {
    const lendingPublicClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });

    let lendingWalletClient = null;
    if (MATCHER_PRIVATE_KEY) {
      const matcherAccount = privateKeyToAccount(MATCHER_PRIVATE_KEY);
      lendingWalletClient = createWalletClient({
        account: matcherAccount,
        chain: activeChain,
        transport: rpcTransport,
      });
    }

    initLendingLiquidation(
      lendingPublicClient,
      lendingWalletClient,
      LENDING_POOL_ADDRESS_LOCAL
    );
    console.log(`[Server] Lending liquidation module initialized (LendingPool: ${LENDING_POOL_ADDRESS_LOCAL})`);
  }

  // ============================================================
  // 初始化 PerpVault 模块 (GMX-style LP Pool)
  // ============================================================
  if (PERP_VAULT_ADDRESS_LOCAL) {
    const vaultPublicClient = createPublicClient({
      chain: activeChain,
      transport: rpcTransport,
    });

    let vaultWalletClient = null;
    if (MATCHER_PRIVATE_KEY) {
      const matcherAccount = privateKeyToAccount(MATCHER_PRIVATE_KEY);
      vaultWalletClient = createWalletClient({
        account: matcherAccount,
        chain: activeChain,
        transport: rpcTransport,
      });
    }

    initPerpVault(
      vaultPublicClient,
      vaultWalletClient,
      PERP_VAULT_ADDRESS_LOCAL
    );
    startBatchSettlement();
    startOIFlush();

    // Initialize margin batch module (derived wallet ↔ PerpVault margin)
    initMarginBatch(vaultPublicClient, vaultWalletClient);
    setOnDepositFailure(async (op: PendingMarginOp) => {
      // When margin deposit fails on-chain, force close the related position
      console.error(`[MarginBatch] Deposit failed permanently for ${op.trader.slice(0, 10)}, rolling back...`);
      if (op.orderId) {
        // Find and close the position that was opened with this order
        const positions = userPositions.get(op.trader.toLowerCase() as Address) || [];
        const pos = positions.find(p => p.token?.toLowerCase() === op.token?.toLowerCase());
        if (pos) {
          const currentPrice = BigInt(pos.markPrice || pos.entryPrice);
          await closePositionByMatch(
            op.trader,
            pos.token as Address,
            pos.isLong,
            BigInt(pos.size),
            currentPrice,
            `rollback_${op.orderId}`
          );
          console.log(`[MarginBatch] Position rolled back for ${op.trader.slice(0, 10)}`);
        }
      }
      // Refund the soft-locked amount
      const balance = getUserBalance(op.trader);
      balance.availableBalance += op.amount;
      balance.usedMargin -= op.amount;
      if (balance.usedMargin < 0n) balance.usedMargin = 0n;
      broadcastBalanceUpdate(op.trader);
    });
    startMarginFlush();
    console.log(`[Server] PerpVault module initialized + batch settlement + OI flush + margin flush started (PerpVault: ${PERP_VAULT_ADDRESS_LOCAL})`);
  } else {
    console.log("[Server] PerpVault: No PERP_VAULT_ADDRESS set, vault mode disabled");
  }

  // 配置价格数据源（TokenFactory 获取真实现货价格）
  engine.configurePriceSource(RPC_URL, TOKEN_FACTORY_ADDRESS, PRICE_FEED_ADDRESS);
  console.log(`[Server] TokenFactory: ${TOKEN_FACTORY_ADDRESS}`);
  console.log(`[Server] PriceFeed: ${PRICE_FEED_ADDRESS}`);

  // ❌ Mode 2: batch submission 已禁用
  // runBatchSubmissionLoop();

  // Start cleanup interval
  setInterval(() => {
    engine.cleanupExpired();
  }, 60000); // Clean up every minute

  // Start Redis data cleanup interval (daily)
  const runRedisCleanup = async () => {
    try {
      const ordersRemoved = await cleanupStaleOrders(7);
      const positionsRemoved = await cleanupClosedPositions(7);
      if (ordersRemoved > 0 || positionsRemoved > 0) {
        console.log(`[Redis Cleanup] Removed ${ordersRemoved} stale orders, ${positionsRemoved} closed positions`);
      }
    } catch (err) {
      console.error("[Redis Cleanup] Error:", err);
    }
  };
  // Run immediately on startup, then every 24 hours
  runRedisCleanup();
  setInterval(runRedisCleanup, 24 * 60 * 60 * 1000);

  // AUDIT-FIX ME-H01: 定期清理过期的 pendingWithdrawals（每 5 分钟）
  setInterval(cleanupExpiredWithdrawals, 5 * 60 * 1000);

  // ⚠️ CRITICAL: 提款 mode2 对账 — 每 60 秒检查链上 totalWithdrawn
  // 如果签名过期 + 5分钟缓冲后链上 totalWithdrawn 未增加 → 自动回滚 mode2 扣减
  // 修复: 链上 tx 回退但后端不回滚导致用户资金「凭空消失」的严重 bug
  setInterval(reconcilePendingWithdrawals, 60 * 1000);
  // 启动时立即运行一次（处理上次重启前遗留的待确认记录）
  reconcilePendingWithdrawals().catch(e =>
    console.error("[Reconcile] Startup reconciliation failed:", e)
  );

  // P1-1: 每 5 分钟全量余额快照写 PG (重启时跨存储对账)
  const BALANCE_SNAPSHOT_INTERVAL = 5 * 60 * 1000;
  async function snapshotBalancesToPG(): Promise<void> {
    if (!isPostgresConnected()) return;
    try {
      const snapshots: PgBalanceSnapshot[] = [];
      const now = Date.now();
      for (const [trader, balance] of userBalances) {
        const mode2Adj = getMode2Adjustment(trader);
        snapshots.push({
          trader,
          total_balance: balance.totalBalance.toString(),
          available_balance: balance.availableBalance.toString(),
          used_margin: balance.usedMargin.toString(),
          frozen_margin: balance.frozenMargin.toString(),
          unrealized_pnl: balance.unrealizedPnL.toString(),
          settlement_available: (balance.settlementAvailable || 0n).toString(),
          mode2_adjustment: mode2Adj.toString(),
          snapshot_time: now,
        });
      }
      if (snapshots.length > 0) {
        const count = await BalanceSnapshotRepo.upsertBatch(snapshots);
        console.log(`[P1-1] Balance snapshot: ${count}/${snapshots.length} traders written to PG`);
      }
    } catch (e) {
      console.error("[P1-1] Balance snapshot failed:", e);
    }
  }
  setInterval(snapshotBalancesToPG, BALANCE_SNAPSHOT_INTERVAL);

  // 定期从 TokenFactory / Uniswap V2 Pair 同步现货价格并更新 K 线
  // ✅ ETH 本位: 直接使用 Token/ETH 价格 (1e18 精度)，不做 USD 转换
  // ✅ 毕业代币: 自动从 Uniswap V2 Pair 读取真实市场价格
  // ── syncSpotPrices: 使用 multicall 批量读取所有代币价格 (1 次 RPC 调用) ──
  // 日志节流: 避免 429 错误刷屏
  let _lastSyncErrorLog = 0;

  let syncTradeCounter = 0;
  let lastSyncTradeBlock = 0n;
  let tradeBackfillDone = false;

  const syncSpotPrices = async () => {
    const { updateKlineWithCurrentPrice } = await import("../spot/spotHistory");

    // 使用备用 RPC 避免限流 (publicnode 比 sepolia.base.org 限制更宽松)
    // BUGFIX: default must match CHAIN_ID — don't hardcode mainnet when running on testnet!
    const SYNC_RPC = process.env.SPOT_SYNC_RPC_URL || RPC_URL;
    const publicClient = createPublicClient({
      chain: activeChain,
      transport: http(SYNC_RPC),
    });

    const LOCAL_TOKEN_FACTORY_ABI = [
      {
        inputs: [{ name: "token", type: "address" }],
        name: "getCurrentPrice",
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ] as const;

    if (SUPPORTED_TOKENS.length === 0) {
      return;
    }

    // ── Step 1: 分离毕业代币和未毕业代币 ──
    const bondingCurveTokens: Address[] = [];
    const graduatedTokenList: { token: Address; info: typeof graduatedTokens extends Map<string, infer V> ? V : never }[] = [];

    for (const token of SUPPORTED_TOKENS) {
      const graduatedInfo = graduatedTokens.get(token.toLowerCase());
      if (graduatedInfo) {
        graduatedTokenList.push({ token, info: graduatedInfo });
      } else {
        bondingCurveTokens.push(token);
      }
    }

    // ── Step 2: 用 multicall 批量读取所有 bonding curve 代币价格 (1次RPC) ──
    const priceResults = new Map<string, { price: bigint; source: string }>();

    if (bondingCurveTokens.length > 0) {
      try {
        const calls = bondingCurveTokens.map(token => ({
          address: TOKEN_FACTORY_ADDRESS as Address,
          abi: LOCAL_TOKEN_FACTORY_ABI,
          functionName: "getCurrentPrice" as const,
          args: [token] as const,
        }));

        const results = await publicClient.multicall({ contracts: calls });

        for (let i = 0; i < bondingCurveTokens.length; i++) {
          const r = results[i];
          if (r.status === "success" && r.result && (r.result as bigint) > 0n) {
            priceResults.set(bondingCurveTokens[i].toLowerCase(), {
              price: r.result as bigint,
              source: "bonding_curve",
            });
          }
        }
      } catch (e: any) {
        const now = Date.now();
        if (now - _lastSyncErrorLog > 30_000) { // 30秒内只打印一次错误
          console.warn(`[syncSpotPrices] Multicall failed (${bondingCurveTokens.length} tokens):`, (e?.message || "").slice(0, 100));
          _lastSyncErrorLog = now;
        }
      }
    }

    // ── Step 3: 批量读取毕业代币 Uniswap V2 储备 (另一个 multicall) ──
    if (graduatedTokenList.length > 0) {
      try {
        const reserveCalls = graduatedTokenList.map(({ info }) => ({
          address: info.pairAddress as Address,
          abi: UNISWAP_V2_PAIR_ABI,
          functionName: "getReserves" as const,
        }));

        const reserveResults = await publicClient.multicall({ contracts: reserveCalls });

        for (let i = 0; i < graduatedTokenList.length; i++) {
          const r = reserveResults[i];
          const { token, info } = graduatedTokenList[i];

          if (r.status === "success" && r.result) {
            const [reserve0, reserve1] = r.result as [bigint, bigint, number];
            if (reserve0 > 0n && reserve1 > 0n) {
              const spotPriceEthRaw = info.isWethToken0
                ? (reserve0 * (10n ** 18n)) / reserve1
                : (reserve1 * (10n ** 18n)) / reserve0;
              priceResults.set(token.toLowerCase(), {
                price: spotPriceEthRaw,
                source: "uniswap_v2",
              });
              // Update TOKEN_POOL_CACHE with DEX ETH reserve for graduated tokens
              const poolCache = TOKEN_POOL_CACHE.get(token.toLowerCase());
              if (poolCache) {
                const ethReserve = info.isWethToken0 ? reserve0 : reserve1;
                poolCache.realETHReserve = ethReserve.toString();
              }
            }
          }
        }
      } catch (e: any) {
        const now = Date.now();
        if (now - _lastSyncErrorLog > 30_000) {
          console.warn(`[syncSpotPrices] UniV2 multicall failed:`, (e?.message || "").slice(0, 100));
          _lastSyncErrorLog = now;
        }
      }
    }

    // ── Step 4: 批量更新引擎 + 广播 ──
    let updatedCount = 0;
    for (const token of SUPPORTED_TOKENS) {
      const entry = priceResults.get(token.toLowerCase());
      if (!entry || entry.price <= 0n) continue;

      const priceEth = Number(entry.price) / 1e18;

      // 更新 K线、波动率、引擎价格
      await updateKlineWithCurrentPrice(token, priceEth.toString(), priceEth.toString());
      updateVolatility(token, priceEth);
      // ── Circuit Breaker (Synthetix CircuitBreaker.sol pattern) ──
      // If price deviates >20% from last known value, pause the token.
      // Prevents oracle manipulation / flash loan attacks on bonding curves.
      const prevPrice = engine.getSpotPrice(token);
      if (prevPrice > 0n && entry.price > 0n) {
        const deviation = prevPrice > entry.price
          ? ((prevPrice - entry.price) * 10000n) / prevPrice
          : ((entry.price - prevPrice) * 10000n) / prevPrice;
        if (deviation > TRADING.CIRCUIT_BREAKER_DEVIATION_BPS) {
          console.warn(`[CircuitBreaker] 🚨 ${token.slice(0, 10)} price deviation ${Number(deviation) / 100}% exceeds threshold. ` +
            `prev=${prevPrice}, new=${entry.price}. Pausing token.`);
          pauseToken(token, `Circuit breaker: ${Number(deviation) / 100}% price deviation`);
          // Still update the price (so it's not stale), but trading is paused
        }
      }

      engine.updatePrice(token, entry.price);
      engine.setSpotPrice(token, entry.price);
      priceLastUpdatedAt.set(token.toLowerCase(), Date.now());
      broadcastOrderBook(token);

      // 广播K线
      try {
        const { KlineRepo } = await import("../spot/spotHistory");
        const now = Math.floor(Date.now() / 1000);
        const bucketTime = Math.floor(now / 60) * 60;
        const klines = await KlineRepo.get(token, "1m", bucketTime, bucketTime);
        if (klines.length > 0) {
          const kline = klines[0];
          broadcastKline(token, {
            timestamp: kline.time * 1000,
            open: kline.open,
            high: kline.high,
            low: kline.low,
            close: kline.close,
            volume: kline.volume,
          });
        }
      } catch (_klineErr) {
        console.warn(`[Startup] Kline history load failed for position:`, _klineErr instanceof Error ? _klineErr.message : _klineErr);
      }

      updatedCount++;
    }

    if (updatedCount > 0) {
      console.log(`[syncSpotPrices] Updated ${updatedCount}/${SUPPORTED_TOKENS.length} tokens (${priceResults.size} prices fetched via multicall)`);
      // P0-3: 价格变动即触发风控检查 — 不等 500ms 兜底轮询
      // 参考 GMX: Keeper 监控 oracle 价格变动即触发清算
      try { runRiskCheck(); } catch (e) { /* 非关键路径 */ }
    }

    // ── Piggyback: 每 5 次 sync (~15s) 顺便检查链上 Trade 事件 ──
    // 复用 syncSpotPrices 的 RPC 连接，避免 TradePoller 的额外请求被限流
    syncTradeCounter++;
    if (syncTradeCounter >= 5) {
      syncTradeCounter = 0;
      try {
        const { parseAbiItem } = await import("viem");
        const TRADE_ABI = parseAbiItem(
          "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 virtualEth, uint256 virtualToken, uint256 timestamp)"
        );
        const latestBlock = await publicClient.getBlockNumber();

        // 首次运行: 回填最近 2000 个区块 (~100 分钟) 的历史交易
        if (!tradeBackfillDone) {
          tradeBackfillDone = true;
          const BACKFILL_BLOCKS = 2000n;
          const backfillFrom = latestBlock > BACKFILL_BLOCKS ? latestBlock - BACKFILL_BLOCKS : 0n;
          console.log(`[TradeBackfill] Scanning blocks ${backfillFrom} → ${latestBlock} for historical trades...`);
          try {
            await pollTradeEvents(publicClient, TRADE_ABI, backfillFrom, latestBlock);
            console.log(`[TradeBackfill] Historical trade backfill complete`);
          } catch (backfillErr: any) {
            console.warn(`[TradeBackfill] Backfill failed (will retry incrementally):`, backfillErr?.message?.slice(0, 100));
          }
          lastSyncTradeBlock = latestBlock;
          return; // 回填完成后跳过本轮增量扫描
        }

        // 增量扫描: 扫描上次到现在的新区块
        if (latestBlock > lastSyncTradeBlock && lastSyncTradeBlock > 0n) {
          await pollTradeEvents(publicClient, TRADE_ABI, lastSyncTradeBlock + 1n, latestBlock);
        }
        lastSyncTradeBlock = latestBlock;
      } catch (e: any) {
        // 非关键 — 不影响价格同步，但记录错误便于排查
        console.warn(`[syncSpotPrices] Trade event scan error:`, e?.message?.slice(0, 120));
      }
    }
  };

  // ── updatePriceFeedOnChain: 定期更新 PriceFeed 合约的毕业代币价格 ──
  // 毕业代币的价格源是 Uniswap V2 Pair，但链上 PriceFeed 需要被显式调用
  const PRICE_FEED_UPDATE_INTERVAL_MS = 30_000; // 30 seconds

  const PRICE_FEED_ABI = [{
    name: "updateTokenPriceFromUniswap",
    type: "function",
    stateMutability: "nonpayable" as const,
    inputs: [{ name: "token", type: "address" as const }],
    outputs: [],
  }] as const;

  const updatePriceFeedOnChain = async () => {
    if (graduatedTokens.size === 0) return;
    if (!PRICE_FEED_ADDRESS || !MATCHER_PRIVATE_KEY) return;

    for (const [token] of graduatedTokens.entries()) {
      try {
        // Acquire global tx lock to avoid nonce conflicts with OI/settlement batches
        if (txLockRef.locked) {
          console.log(`[PriceFeed] ⏳ TX lock held, skipping update cycle`);
          return; // Will retry next interval
        }
        txLockRef.locked = true;

        const matcherAccount = privateKeyToAccount(MATCHER_PRIVATE_KEY);
        const priceFeedWallet = createWalletClient({
          account: matcherAccount,
          chain: activeChain,
          transport: rpcTransport,
        });

        await priceFeedWallet.writeContract({
          address: PRICE_FEED_ADDRESS,
          abi: PRICE_FEED_ABI,
          functionName: "updateTokenPriceFromUniswap",
          args: [token as Address],
        });

        console.log(`[PriceFeed] ✅ Updated on-chain price for ${token.slice(0, 10)}`);
      } catch (e: any) {
        console.error(`[PriceFeed] ❌ Failed to update ${token.slice(0, 10)}: ${(e?.message || "").slice(0, 120)}`);
        // Continue with other tokens
      } finally {
        txLockRef.locked = false;
      }
    }
  };

  // 从 TokenFactory 同步支持的代币列表 (必须在 syncSpotPrices 之前)
  await syncSupportedTokens();

  // 批量缓存所有代币 name/symbol (multicall, 1次RPC调用)
  await syncTokenInfoCache();

  // 批量缓存所有代币 pool state + price (multicall, 前端 token list WSS-only)
  await syncFullTokenData();

  // 初始同步 (在代币列表加载后)
  console.log("[Server] Starting initial spot price sync...");
  syncSpotPrices();

  // 从 Redis 加载待处理订单 (在代币列表同步后)
  await loadOrdersFromRedis();

  // P1-5: 如果 Redis 中没有加载到订单，尝试从 PostgreSQL 恢复
  if (isPostgresConnected()) {
    const engineOrderCount = engine.allOrders.size;
    if (engineOrderCount === 0) {
      console.log("[Server] Redis had no orders, attempting PostgreSQL recovery...");
      try {
        const pgOrders = await OrderMirrorRepo.getActiveOrders();
        if (pgOrders.length > 0) {
          let recovered = 0;
          for (const pgOrder of pgOrders) {
            try {
              const engineOrder: Order = {
                id: pgOrder.id,
                clientOrderId: undefined,
                trader: pgOrder.trader as Address,
                token: pgOrder.token as Address,
                isLong: pgOrder.is_long,
                size: BigInt(pgOrder.size),
                leverage: BigInt(Math.floor(pgOrder.leverage * 10000)),
                price: BigInt(pgOrder.price),
                orderType: pgOrder.order_type === "MARKET" ? OrderType.MARKET : OrderType.LIMIT,
                timeInForce: TimeInForce.GTC,
                reduceOnly: pgOrder.reduce_only,
                postOnly: pgOrder.post_only,
                status: pgOrder.status === "PARTIALLY_FILLED" ? OrderStatus.PARTIALLY_FILLED : OrderStatus.PENDING,
                filledSize: BigInt(pgOrder.filled_size),
                avgFillPrice: BigInt(pgOrder.avg_fill_price),
                totalFillValue: 0n,
                fee: BigInt(pgOrder.fee),
                feeCurrency: "BNB",
                margin: BigInt(pgOrder.margin),
                collateral: BigInt(pgOrder.margin),
                takeProfitPrice: pgOrder.trigger_price ? BigInt(pgOrder.trigger_price) : undefined,
                stopLossPrice: undefined,
                createdAt: pgOrder.created_at,
                updatedAt: pgOrder.updated_at,
                deadline: BigInt(pgOrder.deadline),
                nonce: BigInt(pgOrder.nonce),
                signature: pgOrder.signature as Hex,
                source: OrderSource.API,
              };
              engine.allOrders.set(engineOrder.id, engineOrder);
              const orderBook = engine.getOrderBook(pgOrder.token as Address);
              orderBook.addOrder(engineOrder);
              recovered++;
            } catch (recoverErr: any) {
              console.error(`[PG Recovery] Failed to restore order ${pgOrder.id}: ${recoverErr.message}`);
            }
          }
          console.log(`[Server] ✅ Recovered ${recovered}/${pgOrders.length} orders from PostgreSQL`);
        } else {
          console.log("[Server] PostgreSQL also has no active orders");
        }
      } catch (pgError: any) {
        console.error(`[Server] PostgreSQL recovery failed: ${pgError.message}`);
      }
    } else {
      const pgCount = await OrderMirrorRepo.countActive().catch(() => 0);
      console.log(`[Server] Redis has ${engineOrderCount} orders, PostgreSQL mirror has ${pgCount} active orders`);
    }
  }

  // ============================================================
  // 🧹 清理 Redis 中不在内存的 orphan position keys
  // 原因: deletePositionFromRedis 之前用 pairId 而非 Redis UUID, 导致 delete 失败
  // 这些 orphan 在每次重启时被 loadPositionsFromRedis 重新加载, 造成 zombie 强平
  // ============================================================
  if (db.isConnected()) {
    try {
      const allRedisPositions = await PositionRepo.getAll();
      const memoryPairIds = new Set<string>();
      for (const [, positions] of userPositions.entries()) {
        for (const pos of positions) {
          memoryPairIds.add(pos.pairId);
          memoryPairIds.add(pos.id || "");
        }
      }

      let orphanCount = 0;
      for (const redisPos of allRedisPositions) {
        const inMemory = memoryPairIds.has(redisPos.pairId) || memoryPairIds.has(redisPos.id);
        if (!inMemory) {
          // Not in memory → orphan, delete from Redis
          await PositionRepo.delete(redisPos.id).catch(() => {});
          orphanCount++;
        }
      }
      if (orphanCount > 0) {
        console.log(`[Server] 🧹 Cleaned ${orphanCount} orphaned position keys from Redis (of ${allRedisPositions.length} total)`);
      }
    } catch (err: any) {
      console.error(`[Server] Redis position cleanup failed: ${err.message}`);
    }
  }

  // ============================================================
  // 🔄 Position recovery from PostgreSQL + cross-validation
  // ============================================================
  if (isPostgresConnected()) {
    const memoryPositionCount = Array.from(userPositions.values()).reduce((sum, arr) => sum + arr.length, 0);

    // ✅ 获取 PG 中的活跃仓位 (无论 Redis 是否有数据, 都与 PG 对比)
    try {
      const pgPositions = await PositionMirrorRepo.getActivePositions();
      const pgCount = pgPositions.length;

      if (memoryPositionCount === 0 && pgCount > 0) {
        // Case 1: Redis 空, PG 有数据 → 完全恢复
        console.log(`[Server] Redis had no positions, recovering ${pgCount} from PostgreSQL...`);
      } else if (memoryPositionCount > 0 && pgCount > 0) {
        // Case 2: 两边都有 → 交叉验证, 修复 collateral=0 的 zombie
        console.log(`[Server] Cross-validating: memory=${memoryPositionCount} positions vs PG=${pgCount} active`);
      } else {
        console.log(`[Server] Memory=${memoryPositionCount} positions, PG=${pgCount} active — no recovery needed`);
      }

      if (pgCount > 0) {
        let recovered = 0;
        let repaired = 0;
        for (const pgPos of pgPositions) {
          try {
            // 跳过强平中或 zombie 仓位
            if (pgPos.is_liquidating) continue;
            const pgCollateral = BigInt(pgPos.collateral || "0");
            const pgSize = BigInt(pgPos.size || "0");
            if (pgCollateral <= 0n && pgSize > 0n) continue;
            if (pgSize <= 0n) continue;

            const token = pgPos.token.toLowerCase() as Address;
            const trader = pgPos.trader.toLowerCase() as Address;

            // 检查内存中是否已有此仓位 (从 Redis 加载)
            const existingPositions = userPositions.get(trader) || [];
            const memMatch = existingPositions.find(
              p => p.token === token && p.isLong === pgPos.is_long
            );

            if (memMatch) {
              // ✅ 内存中已有 — 检查 collateral 是否为 0 (zombie 修复)
              const memCollateral = BigInt(memMatch.collateral || "0");
              if (memCollateral <= 0n && pgCollateral > 0n) {
                // Zombie detected! 用 PG 的正确数据修复
                memMatch.collateral = pgPos.collateral;
                memMatch.margin = pgPos.collateral;
                memMatch.maintenanceMargin = pgPos.maintenance_margin || memMatch.maintenanceMargin;
                repaired++;
                console.log(`[PG Repair] Fixed zombie collateral: ${trader.slice(0, 10)} ${pgPos.is_long ? 'LONG' : 'SHORT'} collateral: 0 → ${Number(pgCollateral) / 1e18}`);
              }
              continue; // 已存在, 不需要恢复
            }

            // 内存中没有此仓位 → 从 PG V2 恢复
            const memPos: Position = {
              pairId: pgPos.id,
              trader,
              token,
              isLong: pgPos.is_long,
              size: pgPos.size,
              entryPrice: pgPos.entry_price,
              averageEntryPrice: pgPos.average_entry_price || pgPos.entry_price,
              leverage: pgPos.leverage.toString(),
              marginMode: pgPos.margin_mode ?? 0,
              collateral: pgPos.collateral,
              margin: pgPos.margin || pgPos.collateral,
              maintenanceMargin: pgPos.maintenance_margin || "0",
              markPrice: pgPos.mark_price || "0",
              liquidationPrice: pgPos.liquidation_price || "0",
              bankruptcyPrice: pgPos.bankruptcy_price || "0",
              breakEvenPrice: pgPos.break_even_price || pgPos.entry_price,
              unrealizedPnL: pgPos.unrealized_pnl || "0",
              realizedPnL: pgPos.realized_pnl || "0",
              marginRatio: pgPos.margin_ratio || "10000",
              mmr: pgPos.mmr || "200",
              roe: pgPos.roe || "0",
              accumulatedFunding: pgPos.accumulated_funding || "0",
              fundingIndex: pgPos.funding_index || "0",
              takeProfitPrice: pgPos.tp_price || null,
              stopLossPrice: pgPos.sl_price || null,
              orderId: "",
              orderIds: [],
              counterparty: (pgPos.counterparty || "0x0000000000000000000000000000000000000000") as Address,
              createdAt: pgPos.created_at,
              updatedAt: pgPos.updated_at,
              adlRanking: pgPos.adl_ranking || 1,
              adlScore: pgPos.adl_score || "0",
              riskLevel: (pgPos.risk_level as Position["riskLevel"]) || "low",
              isLiquidatable: pgPos.is_liquidatable || false,
              isAdlCandidate: pgPos.is_adl_candidate || false,
            };

            // 添加到内存
            const existing = userPositions.get(trader) || [];
            existing.push(memPos);
            userPositions.set(trader, existing);

            // 回写 Redis 保持一致性
            savePositionToRedis(memPos).catch(e =>
              console.error(`[PG Recovery] Failed to re-save position to Redis: ${e.message}`)
            );
            recovered++;
          } catch (err: any) {
            console.error(`[PG Recovery] Failed to restore position ${pgPos.id}: ${err.message}`);
          }
        }
        if (recovered > 0 || repaired > 0) {
          console.log(`[Server] ✅ PG sync: recovered=${recovered}, zombie-repaired=${repaired} (from ${pgCount} PG active)`);
        }
      }
    } catch (pgError: any) {
      console.error(`[Server] PostgreSQL position recovery failed: ${pgError.message}`);
    }
  }

  // ============================================================
  // 🧹 清理孤儿 orderMarginInfos (重启后 Redis 恢复的记录可能已过期)
  // ============================================================
  // orderMarginInfos 在 Redis 恢复时加载 (line ~9822)，但对应的订单可能已成交/取消
  // loadOrdersFromRedis 只恢复 PENDING/PARTIALLY_FILLED 订单到引擎
  // 对比: 如果 marginInfo 对应的 orderId 在引擎中不存在，说明是孤儿记录
  {
    let orphanCount = 0;
    const marginEntries = [...orderMarginInfos.entries()];
    for (const [orderId, _info] of marginEntries) {
      const engineOrder = engine.getOrder(orderId);
      if (!engineOrder || (engineOrder.status !== "PENDING" && engineOrder.status !== "PARTIALLY_FILLED")) {
        orderMarginInfos.delete(orderId);
        OrderMarginRepo.delete(orderId).catch(e =>
          console.error(`[Cleanup] Failed to delete orphaned margin from Redis: ${orderId}`, e)
        );
        orphanCount++;
      }
    }
    if (orphanCount > 0) {
      console.log(`[Server] Cleaned up ${orphanCount} orphaned orderMarginInfos (no matching active order in engine)`);
    } else {
      console.log(`[Server] No orphaned orderMarginInfos found (${marginEntries.length} records all valid)`);
    }
  }

  // ============================================================
  // 🛡️ 启动安全检查: 单边仓位检测 (仅日志，不强制关闭)
  // ============================================================
  // PerpVault LP 架构下，单边仓位是正常的 — LP 池是对手方
  // 对手方被强平后，剩余仓位的盈利由 PerpVault 兜底
  // 仅记录日志供人工审查，不自动关闭
  {
    const tokenPositionMap = new Map<string, { longs: Position[], shorts: Position[] }>();

    for (const [, positions] of userPositions) {
      for (const pos of positions) {
        const tok = (pos.token || "").toLowerCase();
        if (!tok) continue;
        let group = tokenPositionMap.get(tok);
        if (!group) {
          group = { longs: [], shorts: [] };
          tokenPositionMap.set(tok, group);
        }
        if (pos.isLong) {
          group.longs.push(pos);
        } else {
          group.shorts.push(pos);
        }
      }
    }

    for (const [tok, group] of tokenPositionMap) {
      const hasLongs = group.longs.length > 0;
      const hasShorts = group.shorts.length > 0;

      if (hasLongs && !hasShorts) {
        console.log(`[SafetyCheck] Token ${tok.slice(0, 10)}: ${group.longs.length} LONG position(s), no SHORT — PerpVault LP is counterparty`);
      } else if (hasShorts && !hasLongs) {
        console.log(`[SafetyCheck] Token ${tok.slice(0, 10)}: ${group.shorts.length} SHORT position(s), no LONG — PerpVault LP is counterparty`);
      }
    }
  }

  // ============================================================
  // 🔄 模式 2: 仓位存 Redis，不从链上同步
  // ============================================================
  // 启动时从 Redis 加载仓位 (而非从链上)
  console.log("[Server] Mode 2: Positions loaded from Redis, chain sync DISABLED");

  // 定时同步现货价格 (仍需要，供现货交易使用)
  setInterval(syncSpotPrices, SPOT_PRICE_SYNC_INTERVAL_MS);
  console.log(`[Server] Spot price sync interval: ${SPOT_PRICE_SYNC_INTERVAL_MS}ms`);

  // 定时更新 PriceFeed 合约的毕业代币价格 (每 30 秒)
  setInterval(updatePriceFeedOnChain, PRICE_FEED_UPDATE_INTERVAL_MS);
  console.log(`[Server] PriceFeed on-chain update interval: ${PRICE_FEED_UPDATE_INTERVAL_MS}ms`);

  // 定时刷新 token pool cache (60秒, 覆盖新上币/状态变化)
  setInterval(async () => {
    await syncSupportedTokens();
    await syncTokenInfoCache();
    await syncFullTokenData();
  }, 60_000);

  // NOTE: Balance snapshot already runs at line ~15112 via snapshotBalancesToPG() every 5 min
  // (removed broken duplicate that called nonexistent insertBatch/cleanup)

  // ========================================
  // 启动链上事件监听 (实时同步链上状态)
  // ========================================
  startEventWatching().catch((e) => {
    console.error("[Events] Failed to start event watching:", e);
  });

  // P2-3: 为已毕业代币启动 Swap 事件监听 (K线生成)
  // 注意: detectGraduatedTokens() 已在前面执行，graduatedTokens Map 已填充
  startAllSwapWatchers();

  // ========================================
  // 启动时回填现货交易数据 (异步，不阻塞启动)
  // 回填最近 50000 个区块 (~28 小时) 以捕获重启期间遗漏的交易
  // ========================================
  (async () => {
    try {
      const { createPublicClient, http } = await import("viem");
      const backfillClient = createPublicClient({
        chain: activeChain,
        transport: rpcTransport,
      });
      const currentBlock = await backfillClient.getBlockNumber();
      // BSC Testnet public RPC has strict getLogs limits, use smaller range
      const backfillFrom = currentBlock > 5000n ? currentBlock - 5000n : 0n;
      console.log(`[Startup] Backfilling spot trades from block ${backfillFrom} to ${currentBlock} for all supported tokens...`);
      const { backfillHistoricalTrades } = await import("../spot/spotHistory");
      for (const token of SUPPORTED_TOKENS) {
        try {
          const count = await backfillHistoricalTrades(token, backfillFrom, currentBlock, currentEthPriceUsd || 600);
          if (count > 0) {
            console.log(`[Startup] Backfilled ${count} trades for ${token.slice(0, 10)}`);
          }
        } catch (e: any) {
          console.error(`[Startup] Backfill failed for ${token.slice(0, 10)}:`, e.message);
        }
      }
      console.log("[Startup] Spot trade backfill complete");
    } catch (e: any) {
      console.error("[Startup] Spot trade backfill failed:", e.message);
    }
  })();

  // ========================================
  // 启动 Event-Driven Risk Engine (Meme Perp 核心)
  // 架构: Hyperliquid-style 实时强平 + 1s 兜底检查
  // ========================================
  startRiskEngine();
  console.log(`[Server] Risk Engine started: Event-driven + ${RISK_ENGINE_INTERVAL_MS}ms safety-net`);

  // ========================================
  // 启动 Lifecycle Checker (经济模型 V2 — 30s)
  // ========================================
  startLifecycleChecker(30000);

  // ========================================
  // 启动 ADL 比率监控 (经济模型 V2 — 500ms)
  // ========================================
  startADLRatioMonitor();

  // ========================================
  // 启动 Dynamic Funding Engine (P1)
  // ========================================
  await startDynamicFundingEngine();
  console.log(`[Server] Dynamic Funding Engine started: ${DYNAMIC_FUNDING_CHECK_INTERVAL}ms check interval`);

  // 定期计算资金费率（基于现货价格锚定）
  // 注意：暂时禁用链上资金费率更新，避免 nonce 冲突影响订单结算
  fundingRateCalcInterval = setInterval(() => {
    for (const token of SUPPORTED_TOKENS) {
      const rate = engine.calculateFundingRate(token);
      // 资金费率仍在内存中计算，但不再推送到链上
      // 这样可以避免频繁的链上交易导致 nonce 不同步
      // TODO: 实现更好的 nonce 管理后再启用链上更新
    }
  }, FUNDING_RATE_INTERVAL_MS);
  console.log(`[Server] Funding rate interval: ${FUNDING_RATE_INTERVAL_MS}ms (on-chain update disabled)`);

  // ============================================================
  // Rate Limiter (in-memory sliding window)
  // ============================================================
  // 三级速率限制: 读 100/s, 写 20/s, 下单 5/s
  const rateLimitMap = new Map<string, { read: number[]; write: number[]; order: number[] }>();

  function isRateLimited(ip: string, isWrite: boolean, isOrderSubmit: boolean): boolean {
    const now = Date.now();
    const windowMs = 1000; // 1 second sliding window

    if (!rateLimitMap.has(ip)) {
      rateLimitMap.set(ip, { read: [], write: [], order: [] });
    }
    const entry = rateLimitMap.get(ip)!;

    // Clean expired timestamps
    entry.read = entry.read.filter(t => now - t < windowMs);
    entry.write = entry.write.filter(t => now - t < windowMs);
    entry.order = entry.order.filter(t => now - t < windowMs);

    // NOTE: Limits raised for stress testing. Production values: order=5, write=20, read=100
    const orderLimit = process.env.NODE_ENV === "test" ? 500 : 5;
    const writeLimit = process.env.NODE_ENV === "test" ? 2000 : 20;
    const readLimit = process.env.NODE_ENV === "test" ? 5000 : 100;

    if (isOrderSubmit) {
      if (entry.order.length >= orderLimit) return true;
      entry.order.push(now);
    }
    if (isWrite) {
      if (entry.write.length >= writeLimit) return true;
      entry.write.push(now);
    }
    if (entry.read.length >= readLimit) return true;
    entry.read.push(now);

    return false;
  }

  // Cleanup stale entries every 60s to prevent memory leak
  rateLimitCleanupInterval = setInterval(() => {
    const now = Date.now();
    // Rate limit map cleanup
    for (const [ip, entry] of rateLimitMap) {
      entry.read = entry.read.filter(t => now - t < 2000);
      entry.write = entry.write.filter(t => now - t < 2000);
      entry.order = entry.order.filter(t => now - t < 2000);
      if (entry.read.length === 0 && entry.write.length === 0 && entry.order.length === 0) {
        rateLimitMap.delete(ip);
      }
    }

    // Memory safety: evict oldest entries from unbounded Maps
    const prevSizes = {
      graduated: graduatedTokens.size,
      nonces: userNonces.size,
      trades: userTrades.size,
    };
    evictOldest(graduatedTokens, MAX_GRADUATED_TOKENS);
    evictOldest(userNonces, MAX_USER_NONCES);
    evictOldest(userTrades, MAX_USER_TRADES_ENTRIES);
    // Cap per-user trade arrays to MAX_TRADES_PER_USER (keep latest)
    for (const [trader, trades] of userTrades) {
      if (trades.length > MAX_TRADES_PER_USER) {
        userTrades.set(trader, trades.slice(-MAX_TRADES_PER_USER));
      }
    }
    // Log only when eviction actually happened
    if (graduatedTokens.size < prevSizes.graduated ||
        userNonces.size < prevSizes.nonces ||
        userTrades.size < prevSizes.trades) {
      console.log(`[MemCleanup] Evicted: graduated ${prevSizes.graduated}→${graduatedTokens.size}, nonces ${prevSizes.nonces}→${userNonces.size}, trades ${prevSizes.trades}→${userTrades.size}`);
    }
  }, 60_000);

  // Start HTTP server (Node.js compatible)
  import("http").then((http) => {
    const server = http.createServer(async (req, res) => {
      // Set CORS headers for all responses
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      // Rate limiting
      const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      const reqPath = req.url?.split("?")[0] || "";
      const isWrite = req.method === "POST";
      const isOrderSubmit = reqPath === "/api/order/submit";
      // Skip rate limiting for health/metrics endpoints
      if (reqPath !== "/health" && reqPath !== "/metrics") {
        if (isRateLimited(clientIp, isWrite, isOrderSubmit)) {
          res.statusCode = 429;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Retry-After", "1");
          res.end(JSON.stringify({ error: "Too many requests", retryAfter: 1 }));
          return;
        }
      }

      try {
        const url = `http://${req.headers.host}${req.url}`;

        // Read body if present
        let bodyStr = "";
        if (req.method !== "GET" && req.method !== "HEAD") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          bodyStr = Buffer.concat(chunks).toString();
        }

        // Create Request with body included
        const request = new Request(url, {
          method: req.method,
          headers: req.headers as HeadersInit,
          body: bodyStr || undefined,
        });

        const response = await handleRequest(request);

        // Set response headers
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        res.statusCode = response.status;

        // Send response body
        const text = await response.text();
        res.end(text);
      } catch (error) {
        console.error("[Server] Request error:", error);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });

    httpServer = server; // capture for graceful shutdown
    server.listen(PORT, () => {
      console.log(`[Server] Matching engine API running on http://localhost:${PORT}`);
      console.log(`[Server] Batch interval: ${BATCH_INTERVAL_MS}ms`);

      // P0-1: 启动时警告签名验证状态
      if (SKIP_SIGNATURE_VERIFY) {
        console.warn("⚠️⚠️⚠️ [SECURITY] SIGNATURE VERIFICATION IS DISABLED (NODE_ENV=test) ⚠️⚠️⚠️");
        console.warn("⚠️⚠️⚠️ [SECURITY] DO NOT USE THIS IN PRODUCTION ⚠️⚠️⚠️");
      } else {
        console.log("[Security] ✅ Signature verification is ENABLED");
      }

      // Start WebSocket server on same port
      wss = new WebSocketServer({ server });
      console.log(`[Server] WebSocket server running on ws://localhost:${PORT}`);

      wss.on("connection", (ws) => {
        console.log("[WS] Client connected");
        wsClients.set(ws, new Set());

        ws.on("message", (data) => {
          handleWSMessage(ws, data.toString());
        });

        ws.on("close", () => {
          cleanupWSConnection(ws);
          console.log("[WS] Client disconnected");
        });

        ws.on("error", (err) => {
          console.error("[WS] Error:", err);
          cleanupWSConnection(ws);
        });
      });

      // 启动市场数据定时推送
      startMarketDataPush();
    });
  });
}

// ============================================================
// Graceful Shutdown (SIGTERM / SIGINT)
// ============================================================
// Ensures timers are stopped and DB connections are flushed
// before Docker/K8s kills the process during rolling updates.

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return; // prevent double shutdown
  isShuttingDown = true;
  console.log(`\n[Server] ${signal} received — initiating graceful shutdown...`);

  const shutdownStart = Date.now();

  try {
    // 1. Stop accepting new connections
    if (httpServer) {
      httpServer.close();
      console.log("[Shutdown] HTTP server closed (no new connections)");
    }

    // 2. Close all WebSocket clients
    if (wss) {
      for (const client of wss.clients) {
        client.close(1001, "Server shutting down");
      }
      wss.close();
      console.log("[Shutdown] WebSocket server closed");
    }

    // 3. Stop all periodic intervals
    // Module timers
    stopRiskEngine();
    stopDynamicFundingEngine();
    stopSnapshotJob();
    stopMarginFlush();
    // Local timers
    if (marketDataPushInterval) {
      clearInterval(marketDataPushInterval);
      marketDataPushInterval = null;
    }
    if (fundingRateCalcInterval) {
      clearInterval(fundingRateCalcInterval);
      fundingRateCalcInterval = null;
    }
    if (rateLimitCleanupInterval) {
      clearInterval(rateLimitCleanupInterval);
      rateLimitCleanupInterval = null;
    }
    stopAllPollers();
    console.log("[Shutdown] All intervals + event pollers cleared");

    // 4. Close database connections
    await disconnectRedis();
    console.log("[Shutdown] Redis disconnected");
    await disconnectPostgres();
    console.log("[Shutdown] PostgreSQL disconnected");

    const elapsed = Date.now() - shutdownStart;
    console.log(`[Server] Graceful shutdown completed in ${elapsed}ms`);
  } catch (err) {
    console.error("[Shutdown] Error during graceful shutdown:", err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start if running directly
if (import.meta.main) {
  startServer();
}

export { startServer, engine };
