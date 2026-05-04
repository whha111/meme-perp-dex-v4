/**
 * 代币生命周期管理模块 (经济模型 V2)
 *
 * 合约激活四重门槛:
 * - 流动性深度 ≥ 15 BNB (realEthReserve)
 * - 持币人数 ≥ 500
 * - 1h 现货交易量 ≥ 30 BNB
 * - Bonding Curve 进度 ≥ 60%
 *
 * 热度三级:
 * - JUST_ACTIVATED: 刚达标，覆盖系数 20%
 * - ACTIVE: 1h量≥30 BNB + 持币≥500
 * - HOT: 1h量≥100 BNB + 持币≥2000
 *
 * 阶段演进:
 * - 内盘 → 毕业 (DEX) → 热门
 */

import type { Address } from "viem";
import { logger } from "../utils/logger";

// ============================================================
// 代币状态枚举
// ============================================================

export enum TokenState {
  INACTIVE = "INACTIVE",           // 未激活 — 不允许合约交易
  JUST_ACTIVATED = "JUST_ACTIVATED", // 刚激活 — 覆盖系数 20%
  ACTIVE = "ACTIVE",               // 活跃 — 覆盖系数 35%
  HOT = "HOT",                     // 热门 — 覆盖系数 50%
  PAUSED = "PAUSED",               // 暂停开仓 (激活条件不再满足 / ADL 触发)
  GRADUATED = "GRADUATED",         // 已毕业 — 上 DEX
}

// ============================================================
// 热度等级 (用于 OI 动态计算)
// ============================================================

export enum HeatTier {
  JUST_ACTIVATED = "JUST_ACTIVATED",
  ACTIVE = "ACTIVE",
  HOT = "HOT",
}

// 覆盖系数: OI 上限 = (LP + 保险基金) × coverageRatio
export const HEAT_COVERAGE_RATIO: Record<HeatTier, number> = {
  [HeatTier.JUST_ACTIVATED]: 20,
  [HeatTier.ACTIVE]: 35,
  [HeatTier.HOT]: 50,
};

// ============================================================
// 合约激活门槛
// ============================================================

export interface ActivationCriteria {
  minLiquidityBNB: bigint;     // realEthReserve 最低
  minHolders: number;           // 最低持币人数
  minVolume1hBNB: bigint;      // 1h 现货交易量
  minBCProgressPct: number;     // BC 进度百分比
}

// Test mode: drastically lower thresholds for automated tests only.
const IS_TEST_MODE = process.env.NODE_ENV === "test";

const ACTIVATION_THRESHOLDS: ActivationCriteria = IS_TEST_MODE
  ? {
      minLiquidityBNB: 0n,                // no liquidity requirement in tests
      minHolders: 0,
      minVolume1hBNB: 0n,                 // no volume requirement in tests
      minBCProgressPct: 0,
    }
  : {
      minLiquidityBNB: 15n * 10n ** 18n,  // 15 BNB
      minHolders: 500,
      minVolume1hBNB: 30n * 10n ** 18n,   // 30 BNB
      minBCProgressPct: 60,
    };

// 热度升级门槛
interface HeatThresholds {
  // JUST_ACTIVATED → ACTIVE
  activeVolume1h: bigint;
  activeHolders: number;

  // ACTIVE → HOT
  hotVolume1h: bigint;
  hotHolders: number;
}

const HEAT_THRESHOLDS: HeatThresholds = IS_TEST_MODE
  ? {
      activeVolume1h: 0n,
      activeHolders: 1,
      hotVolume1h: 1n * 10n ** 16n,     // 0.01 BNB in tests
      hotHolders: 5,
    }
  : {
      activeVolume1h: 30n * 10n ** 18n,   // 30 BNB
      activeHolders: 500,
      hotVolume1h: 100n * 10n ** 18n,     // 100 BNB
      hotHolders: 2000,
    };

// ============================================================
// 阶段参数 (内盘 vs 毕业 vs 热门DEX)
// ============================================================

export interface PhaseParameters {
  maxLeverage: bigint;         // 1e4 精度 (2.5x = 25000)
  initialMarginRate: bigint;   // 基点 (40% = 4000)
  maintenanceMarginRate: bigint; // 基点 (30% = 3000)
  makerFee: bigint;            // 基点 (0.05% = 5)
  takerFee: bigint;            // 基点 (0.3% = 30)
  tradingEnabled: boolean;
}

// 内盘阶段参数 (所有热度共用)
const INTERNAL_PHASE_PARAMS: PhaseParameters = {
  maxLeverage: 25000n,         // 2.5x
  initialMarginRate: 4000n,    // 40%
  maintenanceMarginRate: 3000n, // 30%
  makerFee: 5n,                // 0.05%
  takerFee: 30n,               // 0.3%
  tradingEnabled: true,
};

// 毕业阶段参数
const GRADUATED_PHASE_PARAMS: PhaseParameters = {
  maxLeverage: 50000n,         // 5x
  initialMarginRate: 2000n,    // 20%
  maintenanceMarginRate: 1500n, // 15%
  makerFee: 3n,                // 0.03%
  takerFee: 15n,               // 0.15%
  tradingEnabled: true,
};

// ============================================================
// 代币生命周期信息
// ============================================================

export interface TokenLifecycleInfo {
  token: Address;
  state: TokenState;
  heatTier: HeatTier;

  // 活跃度指标
  volume24h: bigint;
  volume1h: bigint;
  tradeCount24h: number;
  tradeCount1h: number;

  // 未平仓合约
  openInterestLong: bigint;
  openInterestShort: bigint;
  positionCount: number;

  // 价格信息
  currentPrice: bigint;
  priceChange24h: bigint;
  lastTradeTime: number;

  // 链上数据 (用于激活检查)
  bondingCurveReserveETH: bigint;
  bondingCurveReserveToken: bigint;
  holderCount: number;
  bcProgressPct: number;       // 0-100

  // 时间戳
  createdAt: number;
  stateChangedAt: number;
  lastActivityTime: number;
}

// ============================================================
// 存储
// ============================================================

const tokenLifecycles = new Map<Address, TokenLifecycleInfo>();
const hourlyTrades = new Map<Address, { timestamp: number; volume: bigint }[]>();

// ============================================================
// 核心函数
// ============================================================

export function initializeTokenLifecycle(
  token: Address,
  initialPrice: bigint,
  bondingCurveReserveETH: bigint = 0n,
  bondingCurveReserveToken: bigint = 0n
): TokenLifecycleInfo {
  const now = Date.now();

  const info: TokenLifecycleInfo = {
    token,
    state: TokenState.INACTIVE,
    heatTier: HeatTier.JUST_ACTIVATED,
    volume24h: 0n,
    volume1h: 0n,
    tradeCount24h: 0,
    tradeCount1h: 0,
    openInterestLong: 0n,
    openInterestShort: 0n,
    positionCount: 0,
    currentPrice: initialPrice,
    priceChange24h: 0n,
    lastTradeTime: 0,
    bondingCurveReserveETH,
    bondingCurveReserveToken,
    holderCount: 0,
    bcProgressPct: 0,
    createdAt: now,
    stateChangedAt: now,
    lastActivityTime: now,
  };

  const key = token.toLowerCase() as Address;
  tokenLifecycles.set(key, info);
  hourlyTrades.set(key, []);

  // Immediately evaluate state with initial data
  evaluateState(info);
  logger.info("Lifecycle", `Initialized token ${token.slice(0, 10)} → ${info.state}`);
  return info;
}

export function getTokenLifecycle(token: Address): TokenLifecycleInfo | null {
  return tokenLifecycles.get(token.toLowerCase() as Address) || null;
}

export function getTokenState(token: Address): TokenState {
  const info = tokenLifecycles.get(token.toLowerCase() as Address);
  return info?.state || TokenState.INACTIVE;
}

export function getTokenHeatTier(token: Address): HeatTier {
  const info = tokenLifecycles.get(token.toLowerCase() as Address);
  return info?.heatTier || HeatTier.JUST_ACTIVATED;
}

export function getCoverageRatio(token: Address): number {
  return HEAT_COVERAGE_RATIO[getTokenHeatTier(token)];
}

/**
 * 获取代币阶段参数
 */
export function getTokenParameters(token: Address): PhaseParameters {
  const state = getTokenState(token);

  if (state === TokenState.GRADUATED) return GRADUATED_PHASE_PARAMS;
  if (state === TokenState.INACTIVE || state === TokenState.PAUSED) {
    return { ...INTERNAL_PHASE_PARAMS, tradingEnabled: false };
  }
  return INTERNAL_PHASE_PARAMS;
}

/**
 * 检查 token 是否满足合约交易激活条件
 */
export function checkActivationCriteria(info: TokenLifecycleInfo): {
  passed: boolean;
  details: Record<string, { required: string; actual: string; pass: boolean }>;
} {
  const t = ACTIVATION_THRESHOLDS;

  const liquidityPass = info.bondingCurveReserveETH >= t.minLiquidityBNB;
  const holdersPass = info.holderCount >= t.minHolders;
  const volumePass = info.volume1h >= t.minVolume1hBNB;
  const bcPass = info.bcProgressPct >= t.minBCProgressPct;

  return {
    passed: liquidityPass && holdersPass && volumePass && bcPass,
    details: {
      liquidity: {
        required: `≥${Number(t.minLiquidityBNB) / 1e18} BNB`,
        actual: `${(Number(info.bondingCurveReserveETH) / 1e18).toFixed(2)} BNB`,
        pass: liquidityPass,
      },
      holders: {
        required: `≥${t.minHolders}`,
        actual: `${info.holderCount}`,
        pass: holdersPass,
      },
      volume1h: {
        required: `≥${Number(t.minVolume1hBNB) / 1e18} BNB`,
        actual: `${(Number(info.volume1h) / 1e18).toFixed(2)} BNB`,
        pass: volumePass,
      },
      bcProgress: {
        required: `≥${t.minBCProgressPct}%`,
        actual: `${info.bcProgressPct}%`,
        pass: bcPass,
      },
    },
  };
}

/**
 * 判断 token 是否允许新开仓
 */
export function isTradingEnabled(token: Address): boolean {
  const state = getTokenState(token);
  return state === TokenState.JUST_ACTIVATED
    || state === TokenState.ACTIVE
    || state === TokenState.HOT
    || state === TokenState.GRADUATED;
}

// ============================================================
// 数据更新
// ============================================================

/**
 * 记录合约交易并更新指标
 */
export function recordTrade(token: Address, volume: bigint, price: bigint): void {
  const info = tokenLifecycles.get(token.toLowerCase() as Address);
  if (!info) return;

  const now = Date.now();
  const trades = hourlyTrades.get(info.token) || [];
  trades.push({ timestamp: now, volume });

  // 清理过期记录
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const cutoff1h = now - 60 * 60 * 1000;
  const filtered = trades.filter(t => t.timestamp > cutoff24h);
  hourlyTrades.set(info.token, filtered);

  let volume24h = 0n, volume1h = 0n, tradeCount24h = 0, tradeCount1h = 0;
  for (const trade of filtered) {
    volume24h += trade.volume;
    tradeCount24h++;
    if (trade.timestamp > cutoff1h) {
      volume1h += trade.volume;
      tradeCount1h++;
    }
  }

  info.volume24h = volume24h;
  info.volume1h = volume1h;
  info.tradeCount24h = tradeCount24h;
  info.tradeCount1h = tradeCount1h;
  info.currentPrice = price;
  info.lastTradeTime = now;
  info.lastActivityTime = now;
}

/**
 * 更新链上数据 (外部定时调用)
 */
export function updateOnChainData(
  token: Address,
  reserveETH: bigint,
  reserveToken: bigint,
  holderCount: number,
  bcProgressPct: number
): void {
  const info = tokenLifecycles.get(token.toLowerCase() as Address);
  if (!info) return;

  info.bondingCurveReserveETH = reserveETH;
  info.bondingCurveReserveToken = reserveToken;
  info.holderCount = holderCount;
  info.bcProgressPct = bcProgressPct;
}

export function updateOpenInterest(
  token: Address,
  longDelta: bigint,
  shortDelta: bigint,
  positionCountDelta: number
): void {
  const info = tokenLifecycles.get(token.toLowerCase() as Address);
  if (!info) return;

  info.openInterestLong += longDelta;
  info.openInterestShort += shortDelta;
  info.positionCount += positionCountDelta;

  if (info.openInterestLong < 0n) info.openInterestLong = 0n;
  if (info.openInterestShort < 0n) info.openInterestShort = 0n;
  if (info.positionCount < 0) info.positionCount = 0;
  info.lastActivityTime = Date.now();
}

export function markTokenGraduated(token: Address): void {
  const info = tokenLifecycles.get(token.toLowerCase() as Address);
  if (!info) return;

  const old = info.state;
  info.state = TokenState.GRADUATED;
  info.stateChangedAt = Date.now();
  logger.info("Lifecycle", `${token.slice(0, 10)} graduated: ${old} → GRADUATED`);
}

/**
 * 暂停开仓 (ADL 或激活条件降级时调用)
 */
export function pauseToken(token: Address, reason: string): void {
  const info = tokenLifecycles.get(token.toLowerCase() as Address);
  if (!info || info.state === TokenState.GRADUATED) return;

  if (info.state !== TokenState.PAUSED) {
    const old = info.state;
    info.state = TokenState.PAUSED;
    info.stateChangedAt = Date.now();
    logger.warn("Lifecycle", `${token.slice(0, 10)} PAUSED: ${old} → PAUSED (${reason})`);
  }
}

/**
 * 恢复交易
 */
export function unpauseToken(token: Address): void {
  const info = tokenLifecycles.get(token.toLowerCase() as Address);
  if (!info || info.state !== TokenState.PAUSED) return;

  // 重新评估应该在哪个热度
  evaluateState(info);
  logger.info("Lifecycle", `${token.slice(0, 10)} unpaused → ${info.state}`);
}

// ============================================================
// 状态转换逻辑 (每 30 秒检查)
// ============================================================

function evaluateState(info: TokenLifecycleInfo): void {
  if (info.state === TokenState.GRADUATED) return;

  const activation = checkActivationCriteria(info);
  const h = HEAT_THRESHOLDS;

  if (!activation.passed) {
    // 不满足激活条件
    if (info.state !== TokenState.INACTIVE && info.state !== TokenState.PAUSED) {
      // 已有仓位 → 暂停开仓 (不关仓)
      if (info.positionCount > 0) {
        info.state = TokenState.PAUSED;
      } else {
        info.state = TokenState.INACTIVE;
      }
      info.stateChangedAt = Date.now();
      logger.info("Lifecycle", `${info.token.slice(0, 10)} deactivated → ${info.state}`);
    }
    return;
  }

  // 满足激活条件 — 判定热度
  if (info.volume1h >= h.hotVolume1h && info.holderCount >= h.hotHolders) {
    if (info.state !== TokenState.HOT) {
      info.state = TokenState.HOT;
      info.heatTier = HeatTier.HOT;
      info.stateChangedAt = Date.now();
      logger.info("Lifecycle", `${info.token.slice(0, 10)} → HOT`);
    }
  } else if (info.volume1h >= h.activeVolume1h && info.holderCount >= h.activeHolders) {
    if (info.state !== TokenState.ACTIVE) {
      info.state = TokenState.ACTIVE;
      info.heatTier = HeatTier.ACTIVE;
      info.stateChangedAt = Date.now();
      logger.info("Lifecycle", `${info.token.slice(0, 10)} → ACTIVE`);
    }
  } else {
    if (info.state === TokenState.INACTIVE || info.state === TokenState.PAUSED) {
      info.state = TokenState.JUST_ACTIVATED;
      info.heatTier = HeatTier.JUST_ACTIVATED;
      info.stateChangedAt = Date.now();
      logger.info("Lifecycle", `${info.token.slice(0, 10)} → JUST_ACTIVATED`);
    }
  }
}

// ============================================================
// 定时检查 (每 30 秒)
// ============================================================

let checkInterval: ReturnType<typeof setInterval> | null = null;

export function startLifecycleChecker(intervalMs: number = 30000): void {
  if (checkInterval) return;

  checkInterval = setInterval(() => {
    for (const info of tokenLifecycles.values()) {
      evaluateState(info);
    }
  }, intervalMs);

  logger.info("Lifecycle", `Started lifecycle checker (interval: ${intervalMs}ms)`);
}

export function stopLifecycleChecker(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    logger.info("Lifecycle", "Stopped lifecycle checker");
  }
}

// ============================================================
// 查询
// ============================================================

export function getActiveTokens(): TokenLifecycleInfo[] {
  return Array.from(tokenLifecycles.values()).filter(
    info => info.state === TokenState.JUST_ACTIVATED
      || info.state === TokenState.ACTIVE
      || info.state === TokenState.HOT
  );
}

export function getHotTokens(): TokenLifecycleInfo[] {
  return Array.from(tokenLifecycles.values()).filter(
    info => info.state === TokenState.HOT
  );
}

export function getAllTokenLifecycles(): TokenLifecycleInfo[] {
  return Array.from(tokenLifecycles.values());
}

export function getLifecycleStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const state of Object.values(TokenState)) {
    stats[state] = 0;
  }
  for (const info of tokenLifecycles.values()) {
    stats[info.state]++;
  }
  return stats;
}

/**
 * 获取激活门槛 (前端展示用)
 */
export function getActivationThresholds(): ActivationCriteria {
  return { ...ACTIVATION_THRESHOLDS };
}

// ============================================================
// 兼容旧接口 (DORMANT/DEAD 映射)
// ============================================================

// 旧代码可能引用这些，映射到新状态
export const TokenStateCompat = {
  DORMANT: TokenState.INACTIVE,
  DEAD: TokenState.INACTIVE,
  ...TokenState,
} as const;

export function getDeadTokens(): TokenLifecycleInfo[] {
  return Array.from(tokenLifecycles.values()).filter(
    info => info.state === TokenState.INACTIVE
  );
}

// ============================================================
// 导出常量
// ============================================================

export { ACTIVATION_THRESHOLDS, HEAT_THRESHOLDS };

export interface StateParameters {
  maxLeverage: bigint;
  minMargin: bigint;
  makerFee: bigint;
  takerFee: bigint;
  maxPositionSize: bigint;
  tradingEnabled: boolean;
}

// 兼容旧 STATE_PARAMETERS 引用
export const STATE_PARAMETERS: Record<string, StateParameters> = {
  [TokenState.INACTIVE]: {
    maxLeverage: 0n,
    minMargin: 0n,
    makerFee: 0n,
    takerFee: 0n,
    maxPositionSize: 0n,
    tradingEnabled: false,
  },
  [TokenState.JUST_ACTIVATED]: {
    maxLeverage: 25000n,
    minMargin: BigInt(1e16),
    makerFee: 5n,
    takerFee: 30n,
    maxPositionSize: BigInt(5e18),  // 动态 OI 决定，这是 fallback
    tradingEnabled: true,
  },
  [TokenState.ACTIVE]: {
    maxLeverage: 25000n,
    minMargin: BigInt(1e16),
    makerFee: 5n,
    takerFee: 30n,
    maxPositionSize: BigInt(5e18),
    tradingEnabled: true,
  },
  [TokenState.HOT]: {
    maxLeverage: 25000n,
    minMargin: BigInt(1e16),
    makerFee: 5n,
    takerFee: 30n,
    maxPositionSize: BigInt(5e18),
    tradingEnabled: true,
  },
  [TokenState.PAUSED]: {
    maxLeverage: 0n,
    minMargin: 0n,
    makerFee: 0n,
    takerFee: 0n,
    maxPositionSize: 0n,
    tradingEnabled: false,
  },
  [TokenState.GRADUATED]: {
    maxLeverage: 50000n,
    minMargin: BigInt(1e15),
    makerFee: 3n,
    takerFee: 15n,
    maxPositionSize: BigInt(1e20),
    tradingEnabled: true,
  },
};

export const DEFAULT_THRESHOLDS = ACTIVATION_THRESHOLDS;
