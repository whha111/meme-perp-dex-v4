/**
 * Stress Test Configuration
 *
 * All contract addresses, RPC settings, rate limits, and wallet groupings.
 * Based on empirical RPC rate limit testing (90% of observed maximums).
 */
import type { Address } from "viem";

// ── RPC Endpoints (from env vars, default to BSC Mainnet) ─────
export const RPC = {
  http: process.env.RPC_URL || "https://bsc-dataseed.binance.org/",
  wss: process.env.WSS_URL || "wss://bsc-rpc.publicnode.com",
  httpBackup: process.env.RPC_URL_BACKUP || "https://bsc-dataseed1.defibit.io/",
} as const;

// ── Rate Limits (90% of empirically tested maximums) ───────────
export const RATE_LIMITS = {
  httpReqPerSec: 45,       // Tested: ≥50 req/s sustained
  wssReqPerSec: 18,        // Tested: ≥20 req/s sustained
  wssMaxConnections: 135,  // Tested: ~150-170 before 429
  maxRetries: 3,
  retryBaseDelayMs: 1000,  // Exponential backoff base
  batchSize: 30,           // JSON-RPC batch size per request
} as const;

// ── Chain Config ───────────────────────────────────────────────
export const CHAIN = {
  id: parseInt(process.env.CHAIN_ID || "56"),
  name: parseInt(process.env.CHAIN_ID || "56") === 56 ? "BSC Mainnet" : "BSC Testnet",
} as const;

// ── Contract Addresses (from env vars — NO hardcoded fallbacks) ──
// Settlement must match matching engine's EIP-712 verifyingContract
export const CONTRACTS = {
  settlement: (process.env.SETTLEMENT_ADDRESS || "") as Address,
  settlementV2: (process.env.SETTLEMENT_V2_ADDRESS || "") as Address,
  tokenFactory: (process.env.TOKEN_FACTORY_ADDRESS || "") as Address,
  perpTokenFactory: (process.env.TOKEN_FACTORY_ADDRESS || "") as Address,
  priceFeed: (process.env.PRICE_FEED_ADDRESS || "") as Address,
  perpVault: (process.env.PERP_VAULT_ADDRESS || "") as Address,
  positionManager: (process.env.POSITION_MANAGER_ADDRESS || "") as Address,
  liquidation: (process.env.LIQUIDATION_ADDRESS || "") as Address,
  insuranceFund: (process.env.INSURANCE_FUND_ADDRESS || "") as Address,
  fundingRate: (process.env.FUNDING_RATE_ADDRESS || "") as Address,
  vault: (process.env.VAULT_ADDRESS || "") as Address,
  lendingPool: (process.env.LENDING_POOL_ADDRESS || "") as Address,
} as const;

// ── Matching Engine ────────────────────────────────────────────
export const MATCHING_ENGINE = {
  url: "http://localhost:8081",
  submitEndpoint: "/api/order/submit",
} as const;

// ── WBNB (from env var — default to BSC Mainnet WBNB) ───────
export const WETH_ADDRESS = (process.env.WETH_ADDRESS || process.env.COLLATERAL_TOKEN_ADDRESS || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c") as Address;

// ── EIP-712 Signing ────────────────────────────────────────────
// MUST use Settlement V1 address as verifyingContract because the matching engine's
// config.ts L150 uses `SETTLEMENT_ADDRESS` (V1) for its EIP-712 domain verification.
// Mismatch = "Invalid signature" error on all perp orders.
export const EIP712_DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: CHAIN.id,
  verifyingContract: CONTRACTS.settlement, // V1 = 0x1660b3... (matches matching engine)
} as const;

export const ORDER_TYPES = {
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

// ── Wallet Grouping ────────────────────────────────────────────
export const WALLET_GROUPS = {
  spot: { start: 0, count: 200 },   // Indices 0-199 for spot trading
  perp: { start: 200, count: 200 }, // Indices 200-399 for perp trading (main 200 + extended overflow)
} as const;

// ── Wallet Source Files ────────────────────────────────────────
export const WALLET_SOURCES = {
  main: new URL("../backend/src/matching/main-wallets.json", import.meta.url).pathname,
  extended: "/Users/qinlinqiu/Desktop/Namespace/scripts/market-maker/wallets.json",
} as const;

// ── Trading Parameters ─────────────────────────────────────────
export const SPOT_CONFIG = {
  walletsPerRound: [5, 12],          // 5-12 wallets per round (scaled for 200 wallets)
  roundIntervalMs: [1500, 4000],     // 1.5-4s between rounds (faster pace for more wallets)
  buyProbability: 0.4,
  sellProbability: 0.3,
  createTokenProbability: 0.15,
  // remaining 0.15 = provide liquidity
  minBuyEth: 0.0003,                 // Low threshold — main wallets have ~0.003 ETH
  maxBuyEth: 0.001,                  // Max ~0.001 ETH per buy (wallet can do ~2-3 buys)
  sellPercentRange: [0.1, 0.5],      // Sell 10-50% of token holdings
} as const;

export const PERP_CONFIG = {
  walletsPerRound: [5, 15],          // 5-15 wallets per round (scaled for 200 wallets)
  roundIntervalMs: [2000, 4000],     // 2-4s between rounds (faster pace for more wallets)
  openLongProbability: 0.30,
  openShortProbability: 0.30,
  closeProbability: 0.25,
  addMarginProbability: 0.10,
  highLeverageProbability: 0.05,     // 10x for liquidation testing (engine max = 10x after H-07 fix)
  leverageRange: [2, 10],            // Normal leverage range (max 10x)
  highLeverageRange: [10, 10],       // High leverage = max 10x (was 50-100x, blocked by H-07 fix)
  minSizeEth: 0.001,                 // Matching engine minimum position size = 0.001 ETH
  maxSizeEth: 0.005,                 // Larger notional OK (margin = size/leverage is small)
  leveragePrecision: 10000n,         // Contract uses 1e4 for leverage
} as const;

// ── Monitor Intervals ──────────────────────────────────────────
export const MONITOR_INTERVALS = {
  fundAuditMs: 5 * 60 * 1000,         // Every 5 minutes
  pnlTrackMs: 2 * 60 * 1000,          // Every 2 minutes
  insuranceTrackMs: 2 * 60 * 1000,    // Every 2 minutes
  liquidationScanMs: 60 * 1000,       // Every 1 minute
  profitWithdrawalMs: 10 * 60 * 1000,  // Every 10 minutes (was 1 hour — too slow for short tests)
  checkpointMs: 10 * 60 * 1000,       // Every 10 minutes
  summaryMs: 5 * 60 * 1000,           // Every 5 minutes
} as const;

// ── Scenario Config ────────────────────────────────────────────
export const SCENARIO_CONFIG = {
  intervalHoursRange: [3, 6],        // 3-6 hours between scenarios
  minExecutionsPerScenario: 2,       // Each scenario runs at least 2x in 48h
  prePostAuditDelayMs: 30_000,       // 30s delay before/after for audit
} as const;

// ── Fund Audit Thresholds ──────────────────────────────────────
export const AUDIT_THRESHOLDS = {
  conservationToleranceEth: 1.0,    // ±1.0 ETH tolerance (400 wallets, sampling introduces variance)
  alertToleranceEth: 5.0,           // Alert if > 5 ETH deviation (scaled for 10+ ETH total deposits)
  pauseToleranceEth: 20.0,          // Pause only on serious deviation (scaled for 400 wallet tests)
} as const;

// ── ABIs ───────────────────────────────────────────────────────

// Settlement V1 — DEPRECATED, kept for reference only
export const SETTLEMENT_V1_ABI = [
  { inputs: [], name: "depositETH", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "user", type: "address" }], name: "getUserBalance", outputs: [{ name: "available", type: "uint256" }, { name: "locked", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

// SettlementV2 — dYdX-style Merkle proof withdrawal (ALL deposits/withdrawals use this)
export const SETTLEMENT_V2_ABI = [
  { inputs: [{ name: "amount", type: "uint256" }], name: "deposit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "depositFor", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "amount", type: "uint256" }, { name: "userEquity", type: "uint256" }, { name: "merkleProof", type: "bytes32[]" }, { name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "userDeposits", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "collateralToken", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "currentStateRoot", outputs: [{ type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "platformSigner", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "withdrawalNonces", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

// Backward compat alias — code that used SETTLEMENT_ABI should now use SETTLEMENT_V2_ABI
export const SETTLEMENT_ABI = SETTLEMENT_V2_ABI;

// PerpVault — LP pool + PnL settlement + OI tracking
export const PERP_VAULT_ABI = [
  { name: "getPoolValue", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getTotalOI", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getMaxOI", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getSharePrice", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "getTokenOI", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "long_", type: "uint256" }, { name: "short_", type: "uint256" }] },
  { name: "getPoolStats", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "poolValue", type: "uint256" }, { name: "sharePrice", type: "uint256" }, { name: "_totalShares", type: "uint256" }, { name: "totalOI", type: "uint256" }, { name: "maxOI", type: "uint256" }, { name: "utilization", type: "uint256" }, { name: "totalFeesCollected", type: "uint256" }, { name: "totalProfitsPaid", type: "uint256" }, { name: "totalLossesReceived", type: "uint256" }, { name: "totalLiquidationReceived", type: "uint256" }] },
] as const;

// WETH — wrap ETH for SettlementV2 deposits
export const WETH_ABI = [
  { inputs: [], name: "deposit", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "wad", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "guy", type: "address" }, { name: "wad", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "src", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

// ERC20 — for token balance checks
export const ERC20_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
] as const;

export const TOKEN_FACTORY_ABI = [
  { inputs: [{ name: "tokenAddress", type: "address" }, { name: "minTokensOut", type: "uint256" }], name: "buy", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "tokenAddress", type: "address" }, { name: "tokenAmount", type: "uint256" }, { name: "minETHOut", type: "uint256" }], name: "sell", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "tokenAddress", type: "address" }], name: "getPoolState", outputs: [{ components: [{ name: "realETHReserve", type: "uint256" }, { name: "realTokenReserve", type: "uint256" }, { name: "soldTokens", type: "uint256" }, { name: "isGraduated", type: "bool" }, { name: "isActive", type: "bool" }, { name: "creator", type: "address" }, { name: "createdAt", type: "uint64" }, { name: "metadataURI", type: "string" }], type: "tuple" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "tokenAddress", type: "address" }], name: "getCurrentPrice", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "metadataURI", type: "string" }, { name: "minTokensOut", type: "uint256" }], name: "createToken", outputs: [{ type: "address" }], stateMutability: "payable", type: "function" },
  { inputs: [], name: "getAllTokens", outputs: [{ type: "address[]" }], stateMutability: "view", type: "function" },
] as const;

export const PRICE_FEED_ABI = [
  { inputs: [{ name: "token", type: "address" }], name: "getPrice", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "token", type: "address" }, { name: "price", type: "uint256" }], name: "updateTokenPrice", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "token", type: "address" }], name: "updateTokenPriceFromFactory", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

export const POSITION_MANAGER_ABI = [
  { inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }], name: "getPositionByToken", outputs: [{ components: [{ name: "size", type: "uint256" }, { name: "collateral", type: "uint256" }, { name: "avgPrice", type: "uint256" }, { name: "isLong", type: "bool" }, { name: "lastFundingIndex", type: "uint256" }, { name: "openTimestamp", type: "uint256" }], type: "tuple" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }], name: "getLiquidationPrice", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }], name: "getUnrealizedPnl", outputs: [{ name: "pnl", type: "int256" }, { name: "hasProfit", type: "bool" }], stateMutability: "view", type: "function" },
] as const;

export const LIQUIDATION_ABI = [
  // ── Write functions ──
  { inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }], name: "liquidateToken", outputs: [], stateMutability: "nonpayable", type: "function" },
  // ── View functions ──
  { inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }], name: "canLiquidateToken", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "users", type: "address[]" }, { name: "token", type: "address" }], name: "getLiquidatableTokenUsers", outputs: [{ type: "address[]" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }], name: "getUserPnLToken", outputs: [{ name: "pnl", type: "int256" }], stateMutability: "view", type: "function" },
] as const;

export const FUNDING_RATE_ABI = [
  { inputs: [{ name: "token", type: "address" }], name: "getCurrentFundingRate", outputs: [{ type: "int256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "token", type: "address" }], name: "accumulatedFundingRate", outputs: [{ type: "int256" }], stateMutability: "view", type: "function" },
] as const;

export const INSURANCE_FUND_ABI = [
  { inputs: [], name: "getBalance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;
