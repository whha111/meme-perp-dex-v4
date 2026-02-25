/**
 * 配置常量 - 统一定义
 */

import "dotenv/config";
import type { Address, Hex } from "viem";

// ============================================================
// 服务器配置
// ============================================================

export const PORT = parseInt(process.env.PORT || "8081");
export const RPC_URL = process.env.RPC_URL || "https://base-sepolia-rpc.publicnode.com";
export const CHAIN_ID = 84532; // Base Sepolia

// ============================================================
// 合约地址
// ============================================================

export const MATCHER_PRIVATE_KEY = process.env.MATCHER_PRIVATE_KEY as Hex;
export const SETTLEMENT_ADDRESS = process.env.SETTLEMENT_ADDRESS as Address;
export const INSURANCE_FUND_ADDRESS = process.env.INSURANCE_FUND_ADDRESS as Address;
export const TOKEN_FACTORY_ADDRESS = (process.env.TOKEN_FACTORY_ADDRESS || "0x583d35e9d407Ea03dE5A2139e792841353CB67b1") as Address;
export const PRICE_FEED_ADDRESS = (process.env.PRICE_FEED_ADDRESS || "0xa97a1E55cFfF5C1e45Ac2c1D882717cDD4F44e01") as Address;
export const VAULT_ADDRESS = (process.env.VAULT_ADDRESS || "0x780E415Ffd8104Ee2EECD7418A9227Bb92ebE294") as Address;
export const POSITION_MANAGER_ADDRESS = (process.env.POSITION_MANAGER_ADDRESS || "0xbff432BfBc3505712BB727D3F61E869769DB5724") as Address;
export const FUNDING_RATE_ADDRESS = (process.env.FUNDING_RATE_ADDRESS || "0x82D72703a089fE245763f365876d5445EDc8BA9e") as Address;
export const LIQUIDATION_ADDRESS = (process.env.LIQUIDATION_ADDRESS || "0x80c720F87cd061B5952d1d84Ce900aa91CBB167B") as Address;
export const LENDING_POOL_ADDRESS = (process.env.LENDING_POOL_ADDRESS || "0x7Ddb15B5E680D8a74FE44958d18387Bb3999C633") as Address;
export const PERP_VAULT_ADDRESS = (process.env.PERP_VAULT_ADDRESS || "") as Address;
export const COLLATERAL_TOKEN_ADDRESS = process.env.COLLATERAL_TOKEN_ADDRESS as Address;
export const FEE_RECEIVER_ADDRESS = (process.env.FEE_RECEIVER_ADDRESS || "0x5AF11d4784c3739cf2FD51Fdc272ae4957ADf7fE") as Address;

// ============================================================
// 时间间隔配置 (毫秒)
// ============================================================

export const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS || "30000"); // 30秒批量上链
export const DAILY_SETTLEMENT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24小时日结周期
export const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || "60000"); // 1分钟健康检查
export const FUNDING_RATE_INTERVAL_MS = parseInt(process.env.FUNDING_RATE_INTERVAL_MS || "5000"); // 5秒更新资金费率
export const SPOT_PRICE_SYNC_INTERVAL_MS = parseInt(process.env.SPOT_PRICE_SYNC_INTERVAL_MS || "1000"); // 1秒同步现货价格
export const RISK_ENGINE_INTERVAL_MS = 100; // 100ms风险检查
export const RISK_BROADCAST_INTERVAL_MS = 500; // 500ms风控广播
export const REDIS_SYNC_CYCLES = 10; // 每10个周期(1秒)同步Redis

// ============================================================
// 精度配置 (ETH 本位)
// ============================================================

export const PRECISION = {
  SIZE: 18n,           // Token 数量精度 1e18
  PRICE: 18n,          // 价格精度 1e18 (ETH/Token, 直接用 Bonding Curve)
  ETH: 18n,            // ETH 金额精度 1e18 (替代 USD)
  LEVERAGE: 4n,        // 杠杆精度 1e4
  RATE: 4n,            // 费率精度 1e4 (基点)
} as const;

export const PRECISION_MULTIPLIER = {
  SIZE: 10n ** PRECISION.SIZE,
  PRICE: 10n ** PRECISION.PRICE,
  ETH: 10n ** PRECISION.ETH,
  LEVERAGE: 10n ** PRECISION.LEVERAGE,
  RATE: 10n ** PRECISION.RATE,
} as const;

// ============================================================
// 交易参数
// ============================================================

export const TRADING = {
  MIN_LEVERAGE: 1n,
  MAX_LEVERAGE: 100n,
  MIN_MARGIN: 1n * 10n ** 15n, // 最小保证金 0.001 ETH (约 $2.5)
  MIN_POSITION_SIZE: 1n * 10n ** 15n, // 最小仓位 0.001 ETH (约 $2.5)
  MAX_POSITION_SIZE: 1000n * PRECISION_MULTIPLIER.ETH, // 最大仓位 1000 ETH
  TAKER_FEE_RATE: 5n,  // 0.05% = 5bp
  MAKER_FEE_RATE: 2n,  // 0.02% = 2bp
  BASE_MMR: 200n,      // 基础维持保证金率 2% = 200bp
} as const;

// ============================================================
// 资金费配置 (Meme Token)
// ============================================================

export const FUNDING = {
  BASE_INTERVAL_MS: 60 * 60 * 1000,    // 1小时基础周期
  MIN_INTERVAL_MS: 15 * 60 * 1000,     // 最小15分钟
  MAX_RATE: 300n,                       // 最大3% = 300bp
  VOLATILITY_MULTIPLIER: 1.5,           // 波动率乘数
  IMBALANCE_MULTIPLIER: 2,              // 不平衡乘数
} as const;

// ============================================================
// 保险基金配置
// ============================================================

export const INSURANCE = {
  INITIAL_GLOBAL_BALANCE: 5n * PRECISION_MULTIPLIER.ETH,   // 5 ETH (约 $10,000)
  INITIAL_TOKEN_BALANCE: 5n * 10n ** 17n,                  // 0.5 ETH/代币 (约 $1,000)
  LIQUIDATION_FEE_TO_INSURANCE: 50n,  // 50%清算收益进保险基金
} as const;

// ============================================================
// 借贷清算配置
// ============================================================

export const LENDING = {
  CHECK_INTERVAL_MS: 5000,                                    // 5秒检查一次借贷健康度
  UTILIZATION_WARNING: 85n * 10n ** 16n,                     // 85% (1e18 精度, 匹配 LendingPool.sol)
  UTILIZATION_CRITICAL: 90n * 10n ** 16n,                    // 90% (1e18 精度, 匹配 LendingPool.sol MAX_UTILIZATION)
  MAX_LIQUIDATIONS_PER_CYCLE: 5,                              // 每轮最多清算5个
  LIQUIDATION_BONUS_BPS: 500n,                               // 清算奖励 5%
} as const;

// ============================================================
// 支持的代币
// ============================================================

export const SUPPORTED_TOKENS: Address[] = [
  // 动态从 TokenFactory 获取，不再硬编码
];

// ============================================================
// 开发/测试配置
// ============================================================

export const SKIP_SIGNATURE_VERIFY = process.env.SKIP_SIGNATURE_VERIFY === "true";

// ============================================================
// EIP-712 签名配置
// ============================================================

export const EIP712_DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: SETTLEMENT_ADDRESS,
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

// ============================================================
// Redis配置
// ============================================================

export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
export const REDIS_KEY_PREFIX = "memeperp:";
// Sentinel 高可用配置 (格式: "host1:port1,host2:port2,host3:port3")
export const REDIS_SENTINEL_HOSTS = process.env.REDIS_SENTINEL_HOSTS || "";
export const REDIS_MASTER_NAME = process.env.REDIS_MASTER_NAME || "mymaster";
export const REDIS_PASSWORD = process.env.REDIS_PASSWORD || "";

// ============================================================
// PostgreSQL配置
// ============================================================

export const POSTGRES_URL = process.env.DATABASE_URL || "postgresql://localhost:5432/memeperp";
