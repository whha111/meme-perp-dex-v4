/**
 * 仓位管理模块 (ETH 本位)
 *
 * 功能:
 * 1. 创建/更新仓位
 * 2. 平仓
 * 3. 计算风险指标
 *
 * ETH 本位精度:
 * - size: Token 数量 (1e18)
 * - price: ETH/Token (1e18)
 * - collateral/margin/PnL: ETH (1e18)
 */

import { v4 as uuidv4 } from "uuid";
import type { Address } from "viem";
import { PositionRepo, MarketStatsRepo } from "../database/redis";
import { TRADING } from "../config";
import { logger } from "../utils/logger";
import { calculatePnL, calculateLiquidationPrice, calculateMarginRatio, calculateADLScore } from "../utils/precision";
import type { Position, PositionStatus, RiskLevel, Match } from "../types";
import { MarginMode } from "../types";
import { updateOpenInterest } from "./lifecycle";
import { recordOpenPosition, recordClosePosition, recordLiquidation } from "./fomo";
import { isPerpVaultEnabled, increaseOI as vaultIncreaseOI, decreaseOI as vaultDecreaseOI, settleTraderPnL as vaultSettlePnL } from "./perpVault";

// ============================================================
// Position Creation
// ============================================================

/**
 * 从撮合结果创建仓位
 */
export async function createPositionFromMatch(match: Match): Promise<{ longPosition: Position; shortPosition: Position }> {
  const now = Date.now();
  const basePosition = {
    id: "",
    pairId: uuidv4(),
    token: match.longOrder.token,
    size: match.matchSize,
    entryPrice: match.matchPrice,
    averageEntryPrice: match.matchPrice,
    markPrice: match.matchPrice,
    marginMode: MarginMode.ISOLATED, // 默认逐仓模式
    unrealizedPnL: 0n,
    realizedPnL: 0n,
    roe: 0n,
    accumulatedFunding: 0n,
    takeProfitPrice: null,
    stopLossPrice: null,
    adlRanking: 1,
    adlScore: 0n,
    riskLevel: "low" as RiskLevel,
    isLiquidatable: false,
    isAdlCandidate: false,
    status: 0 as PositionStatus, // OPEN
    fundingIndex: 0n,
    isLiquidating: false,
    createdAt: now,
    updatedAt: now,
  };

  // 多头仓位
  const longLeverage = match.longOrder.leverage;
  const longCollateral = match.longOrder.margin;
  const longMmr = calculateDynamicMMR(longLeverage);
  const longLiqPrice = calculateLiquidationPrice(match.matchPrice, longLeverage, longMmr, true);
  // ETH 本位: maintenanceMargin = notionalETH * MMR / 10000
  // notionalETH = size * price / 1e18
  // maintenanceMargin = (size * price / 1e18) * mmr / 10000 = size * price * mmr / 1e22
  const longMaintenanceMargin = (match.matchSize * match.matchPrice * longMmr) / (10n ** 18n) / 10000n;

  const longPosition: Position = {
    ...basePosition,
    id: uuidv4(),
    trader: match.longOrder.trader,
    counterparty: match.shortOrder.trader,
    isLong: true,
    leverage: longLeverage,
    collateral: longCollateral,
    margin: longCollateral,
    marginRatio: 0n,
    mmr: longMmr,
    maintenanceMargin: longMaintenanceMargin,
    liquidationPrice: longLiqPrice,
    bankruptcyPrice: calculateBankruptcyPrice(match.matchPrice, longLeverage, true),
    breakEvenPrice: match.matchPrice, // TODO: 加入手续费
  };

  // 空头仓位
  const shortLeverage = match.shortOrder.leverage;
  const shortCollateral = match.shortOrder.margin;
  const shortMmr = calculateDynamicMMR(shortLeverage);
  const shortLiqPrice = calculateLiquidationPrice(match.matchPrice, shortLeverage, shortMmr, false);
  // ETH 本位: maintenanceMargin = notionalETH * MMR / 10000
  const shortMaintenanceMargin = (match.matchSize * match.matchPrice * shortMmr) / (10n ** 18n) / 10000n;

  const shortPosition: Position = {
    ...basePosition,
    id: uuidv4(),
    pairId: longPosition.pairId, // 共享 pairId
    trader: match.shortOrder.trader,
    counterparty: match.longOrder.trader,
    isLong: false,
    leverage: shortLeverage,
    collateral: shortCollateral,
    margin: shortCollateral,
    marginRatio: 0n,
    mmr: shortMmr,
    maintenanceMargin: shortMaintenanceMargin,
    liquidationPrice: shortLiqPrice,
    bankruptcyPrice: calculateBankruptcyPrice(match.matchPrice, shortLeverage, false),
    breakEvenPrice: match.matchPrice,
  };

  // 存储到数据库
  await PositionRepo.create(longPosition);
  await PositionRepo.create(shortPosition);

  // 更新代币生命周期的未平仓合约
  updateOpenInterest(
    match.longOrder.token,
    match.matchSize,  // 多头OI增加
    match.matchSize,  // 空头OI增加
    2                 // 新增2个仓位
  );

  // P0-2: PerpVault OI 追踪 — 必须 await + 错误日志（不能 fire-and-forget）
  // AUDIT-FIX ME-C12: 使用统一 token 变量，防止 longOrder.token !== shortOrder.token 时 OI 腐败
  if (isPerpVaultEnabled()) {
    const matchToken = match.longOrder.token; // 撮合引擎保证 long/short 同 token
    const sizeETH = (match.matchSize * match.matchPrice) / (10n ** 18n);
    try {
      await vaultIncreaseOI(matchToken, true, sizeETH);
      await vaultIncreaseOI(matchToken, false, sizeETH);
    } catch (err) {
      logger.error("Position", `PerpVault OI increase failed for pair ${matchToken}: ${err}`);
    }
  }

  // 记录FOMO事件（大额开仓）
  recordOpenPosition(
    match.longOrder.trader,
    match.longOrder.token,
    match.longOrder.token.slice(0, 8),  // 简化symbol
    true,
    match.matchSize,
    match.matchPrice,
    match.longOrder.leverage
  );
  recordOpenPosition(
    match.shortOrder.trader,
    match.shortOrder.token,
    match.shortOrder.token.slice(0, 8),
    false,
    match.matchSize,
    match.matchPrice,
    match.shortOrder.leverage
  );

  logger.info("Position", `Created pair: ${longPosition.pairId} LONG(${match.longOrder.trader.slice(0, 8)}) <-> SHORT(${match.shortOrder.trader.slice(0, 8)})`);

  return { longPosition, shortPosition };
}

/**
 * 更新仓位 (加仓)
 */
export async function addToPosition(
  positionId: string,
  additionalSize: bigint,
  price: bigint,
  additionalMargin: bigint
): Promise<Position | null> {
  const position = await PositionRepo.get(positionId);
  if (!position) return null;

  // 计算新的平均价格
  const totalValue = position.size * position.averageEntryPrice + additionalSize * price;
  const newSize = position.size + additionalSize;
  const newAvgPrice = totalValue / newSize;

  // 更新
  const updates: Partial<Position> = {
    size: newSize,
    averageEntryPrice: newAvgPrice,
    collateral: position.collateral + additionalMargin,
    margin: position.margin + additionalMargin,
    liquidationPrice: calculateLiquidationPrice(newAvgPrice, position.leverage, position.mmr, position.isLong),
  };

  return PositionRepo.update(positionId, updates);
}

/**
 * 平仓
 */
export async function closePosition(
  positionId: string,
  closePrice: bigint,
  closeSize?: bigint,
  skipPerpVault?: boolean  // AUDIT-FIX ME-C13: 强平路径自行处理 PerpVault，避免双重结算
): Promise<{ position: Position; realizedPnL: bigint } | null> {
  const position = await PositionRepo.get(positionId);
  if (!position) return null;

  const sizeToClose = closeSize || position.size;
  const actualCloseSize = sizeToClose > position.size ? position.size : sizeToClose;

  // 计算已实现盈亏
  const pnl = calculatePnL(actualCloseSize, position.entryPrice, closePrice, position.isLong);

  if (actualCloseSize >= position.size) {
    // 全部平仓
    await PositionRepo.update(positionId, {
      size: 0n,
      status: 1, // CLOSED
      realizedPnL: position.realizedPnL + pnl,
    });

    // 更新未平仓合约
    const oiDelta = -position.size;
    if (position.isLong) {
      updateOpenInterest(position.token, oiDelta, 0n, -1);
    } else {
      updateOpenInterest(position.token, 0n, oiDelta, -1);
    }

    // 记录FOMO事件（平仓/大盈利/大亏损）
    recordClosePosition(
      position.trader,
      position.token,
      position.token.slice(0, 8),
      position.isLong,
      position.size,
      closePrice,
      pnl
    );

    // P0-2: PerpVault OI减少 + PnL结算 — 必须 await + 错误日志
    // AUDIT-FIX ME-C13: 强平路径 (executeLiquidation) 设置 skipPerpVault=true
    // 因为它自行调用 vaultDecreaseOI + vaultSettleLiquidation，避免 OI 双减 + PnL 双算
    if (isPerpVaultEnabled() && !skipPerpVault) {
      const sizeETH = (position.size * position.entryPrice) / (10n ** 18n);
      try {
        await vaultDecreaseOI(position.token, position.isLong, sizeETH);
        if (pnl !== 0n) {
          const isProfit = pnl > 0n;
          const absAmount = isProfit ? pnl : -pnl;
          await vaultSettlePnL(position.trader, absAmount, isProfit);
        }
      } catch (err) {
        logger.error("Position", `PerpVault close settlement failed for ${positionId}: ${err}`);
      }
    }

    const closedPosition = await PositionRepo.get(positionId);
    logger.info("Position", `Closed position: ${positionId} PnL=${pnl}`);
    return { position: closedPosition!, realizedPnL: pnl };
  } else {
    // 部分平仓
    const newSize = position.size - actualCloseSize;
    const collateralRatio = newSize * 10000n / position.size;
    const newCollateral = position.collateral * collateralRatio / 10000n;

    await PositionRepo.update(positionId, {
      size: newSize,
      collateral: newCollateral,
      margin: newCollateral,
      realizedPnL: position.realizedPnL + pnl,
    });

    // 更新未平仓合约
    const oiDelta = -actualCloseSize;
    if (position.isLong) {
      updateOpenInterest(position.token, oiDelta, 0n, 0);
    } else {
      updateOpenInterest(position.token, 0n, oiDelta, 0);
    }

    // P0-2: PerpVault OI减少 + PnL结算 (部分平仓) — 必须 await
    if (isPerpVaultEnabled()) {
      const sizeETH = (actualCloseSize * position.entryPrice) / (10n ** 18n);
      try {
        await vaultDecreaseOI(position.token, position.isLong, sizeETH);
        if (pnl !== 0n) {
          const isProfit = pnl > 0n;
          const absAmount = isProfit ? pnl : -pnl;
          await vaultSettlePnL(position.trader, absAmount, isProfit);
        }
      } catch (err) {
        logger.error("Position", `PerpVault partial close settlement failed for ${position.id}: ${err}`);
      }
    }

    const updatedPosition = await PositionRepo.get(positionId);
    logger.info("Position", `Partially closed position: ${positionId} size=${actualCloseSize} PnL=${pnl}`);
    return { position: updatedPosition!, realizedPnL: pnl };
  }
}

// ============================================================
// Position Queries
// ============================================================

export async function getPosition(positionId: string): Promise<Position | null> {
  return PositionRepo.get(positionId);
}

export async function getUserPositions(trader: Address): Promise<Position[]> {
  return PositionRepo.getByUser(trader);
}

export async function getTokenPositions(token: Address): Promise<Position[]> {
  return PositionRepo.getByToken(token);
}

export async function getAllPositions(): Promise<Position[]> {
  return PositionRepo.getAll();
}

// ============================================================
// Risk Calculations
// ============================================================

/**
 * 更新仓位风险指标
 */
export async function updatePositionRisk(
  positionId: string,
  markPrice: bigint
): Promise<Position | null> {
  const position = await PositionRepo.get(positionId);
  if (!position) return null;

  // 计算未实现盈亏
  const unrealizedPnL = calculatePnL(position.size, position.entryPrice, markPrice, position.isLong);

  // 计算当前保证金
  const currentMargin = position.collateral + unrealizedPnL;

  // 计算保证金率
  const marginRatio = calculateMarginRatio(currentMargin, position.maintenanceMargin);

  // 计算 ROE
  const roe = position.collateral > 0n ? (unrealizedPnL * 10000n) / position.collateral : 0n;

  // 计算 ADL 评分
  const adlScore = unrealizedPnL > 0n
    ? calculateADLScore(unrealizedPnL, position.collateral, position.leverage)
    : 0n;

  // 判断风险等级
  let riskLevel: RiskLevel;
  if (marginRatio >= 10000n) {
    riskLevel = "critical";
  } else if (marginRatio >= 8000n) {
    riskLevel = "high";
  } else if (marginRatio >= 5000n) {
    riskLevel = "medium";
  } else {
    riskLevel = "low";
  }

  const updates: Partial<Position> = {
    markPrice,
    unrealizedPnL,
    margin: currentMargin,
    marginRatio,
    roe,
    adlScore,
    riskLevel,
    isLiquidatable: marginRatio >= 10000n,
    isAdlCandidate: unrealizedPnL > 0n,
    updatedAt: Date.now(),
  };

  return PositionRepo.update(positionId, updates);
}

/**
 * 批量更新仓位风险
 */
export async function batchUpdatePositionRisk(
  updates: Array<{ id: string; data: Partial<Position> }>
): Promise<void> {
  await PositionRepo.batchUpdateRisk(updates);
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * 计算动态维持保证金率
 * MMR = min(2%, 初始保证金率 * 50%)
 */
function calculateDynamicMMR(leverage: bigint): bigint {
  const initialMarginRate = 10000n * 10000n / leverage; // 基点
  const halfIMR = initialMarginRate / 2n;
  return TRADING.BASE_MMR < halfIMR ? TRADING.BASE_MMR : halfIMR;
}

/**
 * 计算穿仓价格
 */
function calculateBankruptcyPrice(
  entryPrice: bigint,
  leverage: bigint,
  isLong: boolean
): bigint {
  const leverageNum = Number(leverage) / 10000;
  if (isLong) {
    return BigInt(Math.floor(Number(entryPrice) * (1 - 1 / leverageNum)));
  } else {
    return BigInt(Math.floor(Number(entryPrice) * (1 + 1 / leverageNum)));
  }
}

export default {
  createPositionFromMatch,
  addToPosition,
  closePosition,
  getPosition,
  getUserPositions,
  getTokenPositions,
  getAllPositions,
  updatePositionRisk,
  batchUpdatePositionRisk,
};
