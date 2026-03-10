/**
 * 强平管理模块
 *
 * 功能:
 * 1. 强平检测
 * 2. 强平执行
 * 3. ADL 自动减仓
 */

import type { Address } from "viem";
import { PositionRepo } from "../database/redis";
import { logger } from "../utils/logger";
import { engine } from "../server";
import { closePosition } from "./position";
import type { Position, LiquidationCandidate, ADLQueue, RiskLevel, HeatmapCell, LiquidationHeatmapResponse } from "../types";
import { isPerpVaultEnabled, settleLiquidation as vaultSettleLiquidation, decreaseOI as vaultDecreaseOI } from "./perpVault";
import { LIQUIDATOR_BOT_ADDRESS } from "../config";

// ============================================================
// State
// ============================================================

let liquidationQueue: LiquidationCandidate[] = [];
const adlQueues = new Map<Address, ADLQueue>();

// ============================================================
// Liquidation Detection
// ============================================================

/**
 * 检测可强平仓位
 */
export async function detectLiquidations(token: Address, currentPrice: bigint): Promise<LiquidationCandidate[]> {
  const candidates: LiquidationCandidate[] = [];
  const positions = await PositionRepo.getByToken(token);

  for (const position of positions) {
    if (position.isLiquidating || position.status !== 0) continue;

    const marginRatio = Number(position.marginRatio);

    // marginRatio >= 100% (10000bp) 触发强平
    if (marginRatio >= 10000) {
      const urgency = Math.min(100, Math.max(0, Math.floor((marginRatio - 10000) / 100)));
      candidates.push({ position, marginRatio, urgency });
    }
  }

  // 按保证金率排序 (越高越危险)
  candidates.sort((a, b) => b.marginRatio - a.marginRatio);

  return candidates;
}

/**
 * 更新全局强平队列
 */
export function updateLiquidationQueue(candidates: LiquidationCandidate[]): void {
  liquidationQueue = candidates;
}

/**
 * 获取强平队列
 */
export function getLiquidationQueue(): LiquidationCandidate[] {
  return [...liquidationQueue];
}

// ============================================================
// Liquidation Execution
// ============================================================

/**
 * 执行强平
 */
export async function executeLiquidation(positionId: string): Promise<boolean> {
  const position = await PositionRepo.get(positionId);
  if (!position) {
    logger.error("Liquidation", `Position not found: ${positionId}`);
    return false;
  }

  // 标记为正在强平
  await PositionRepo.update(positionId, { isLiquidating: true });

  try {
    const orderBook = engine.getOrderBook(position.token);
    const currentPrice = orderBook.getCurrentPrice();

    // 检查是否穿仓
    const currentMargin = position.margin;
    if (currentMargin < 0n) {
      // 穿仓，需要 ADL
      const deficit = -currentMargin;
      logger.warn("Liquidation", `Position ${positionId} is bankrupt, deficit: ${deficit}`);
      await executeADL(position, deficit);
    }

    // 平仓
    // AUDIT-FIX ME-C13: skipPerpVault=true — 强平路径在下方 L114-127 自行处理 PerpVault
    // closePosition 内部的 vaultDecreaseOI + vaultSettlePnL 会被跳过，防止双重结算
    const result = await closePosition(positionId, currentPrice, undefined, true);
    if (!result) {
      throw new Error("Failed to close position");
    }

    // 更新状态
    await PositionRepo.update(positionId, {
      status: 2, // LIQUIDATED
      isLiquidating: false,
    });

    // ✅ Mode 2: 纯链下强平，不调用链上合约
    // 用户 equity 已在 closePosition 中更新

    // PerpVault 清算结算 + OI 减少
    if (isPerpVaultEnabled()) {
      const sizeETH = (position.size * position.entryPrice) / (10n ** 18n);
      try {
        await vaultDecreaseOI(position.token, position.isLong, sizeETH);
        const collateral = position.collateral > 0n ? position.collateral : 0n;
        if (collateral > 0n) {
          const liquidatorReward = (collateral * 75n) / 1000n; // 7.5% — 与 Liquidation.sol 对齐
          await vaultSettleLiquidation(collateral, liquidatorReward, LIQUIDATOR_BOT_ADDRESS);
        }
      } catch (err) {
        logger.error("Liquidation", `PerpVault liquidation settlement failed for ${positionId}: ${err}`);
      }
    }

    logger.info("Liquidation", `Liquidated position: ${positionId} (off-chain mode)`);
    return true;
  } catch (error) {
    logger.error("Liquidation", `Failed to liquidate ${positionId}:`, error);
    await PositionRepo.update(positionId, { isLiquidating: false });
    return false;
  }
}

/**
 * 处理强平队列
 */
export async function processLiquidations(): Promise<number> {
  if (liquidationQueue.length === 0) return 0;

  let processed = 0;
  const toProcess = liquidationQueue.splice(0, 10); // 每次处理10个

  for (const candidate of toProcess) {
    const success = await executeLiquidation(candidate.position.id);
    if (success) processed++;
  }

  return processed;
}

// ============================================================
// ADL (Auto-Deleveraging)
// ============================================================

/**
 * 计算 ADL 评分
 */
export function calculateADLScore(position: Position): number {
  const upnl = Number(position.unrealizedPnL);
  const margin = Number(position.collateral);
  const leverage = Number(position.leverage) / 10000;

  if (margin === 0 || upnl <= 0) return 0;

  return (upnl / margin) * leverage;
}

/**
 * 计算 ADL 排名 (1-5)
 */
export function calculateADLRanking(score: number, allScores: number[]): number {
  if (score <= 0) return 1;

  const sorted = allScores.filter(s => s > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 1;

  const percentile = sorted.findIndex(s => s >= score) / sorted.length;

  if (percentile >= 0.8) return 5;
  if (percentile >= 0.6) return 4;
  if (percentile >= 0.4) return 3;
  if (percentile >= 0.2) return 2;
  return 1;
}

/**
 * 更新 ADL 队列
 */
export async function updateADLQueues(): Promise<void> {
  adlQueues.clear();

  const allPositions = await PositionRepo.getAll();

  for (const position of allPositions) {
    if (position.status !== 0) continue; // 只处理开放仓位

    const token = position.token.toLowerCase() as Address;
    let queue = adlQueues.get(token);
    if (!queue) {
      queue = { token, longQueue: [], shortQueue: [] };
      adlQueues.set(token, queue);
    }

    // 只有盈利的仓位才加入 ADL 队列
    if (position.unrealizedPnL > 0n) {
      if (position.isLong) {
        queue.longQueue.push(position);
      } else {
        queue.shortQueue.push(position);
      }
    }
  }

  // 按 adlScore 降序排序
  for (const queue of adlQueues.values()) {
    queue.longQueue.sort((a, b) => Number(b.adlScore - a.adlScore));
    queue.shortQueue.sort((a, b) => Number(b.adlScore - a.adlScore));
  }
}

/**
 * 执行 ADL 减仓
 */
export async function executeADL(bankruptPosition: Position, deficit: bigint): Promise<void> {
  const token = bankruptPosition.token.toLowerCase() as Address;
  const queue = adlQueues.get(token);

  if (!queue) {
    logger.error("ADL", `No ADL queue for token ${token}`);
    return;
  }

  // 穿仓的是多头，需要从空头盈利队列减仓（反之亦然）
  const targetQueue = bankruptPosition.isLong ? queue.shortQueue : queue.longQueue;

  if (targetQueue.length === 0) {
    logger.error("ADL", "No profitable positions for ADL");
    return;
  }

  let remainingDeficit = deficit;
  const adlTargets: { position: Position; amount: bigint }[] = [];

  for (const pos of targetQueue) {
    if (remainingDeficit <= 0n) break;

    const positionValue = pos.collateral + pos.unrealizedPnL;
    if (positionValue <= 0n) continue;

    const adlAmount = remainingDeficit > positionValue ? positionValue : remainingDeficit;
    adlTargets.push({ position: pos, amount: adlAmount });
    remainingDeficit -= adlAmount;

    logger.info("ADL", `Target: ${pos.trader.slice(0, 10)} ${pos.isLong ? "LONG" : "SHORT"} amount=${adlAmount}`);
  }

  // 执行 ADL
  const orderBook = engine.getOrderBook(token);
  const currentPrice = orderBook.getCurrentPrice();

  for (const { position, amount } of adlTargets) {
    const adlRatio = Number(amount) / (Number(position.collateral) + Number(position.unrealizedPnL));
    const sizeToClose = BigInt(Math.floor(Number(position.size) * adlRatio));

    await closePosition(position.id, currentPrice, sizeToClose);
    logger.info("ADL", `Executed ADL on ${position.id}, ratio=${(adlRatio * 100).toFixed(2)}%`);
  }
}

/**
 * 获取 ADL 队列
 */
export function getADLQueue(token: Address): ADLQueue | undefined {
  return adlQueues.get(token.toLowerCase() as Address);
}

// ============================================================
// Liquidation Heatmap Generation
// ============================================================

/**
 * 时间范围配置
 */
const TIME_RANGE_CONFIG: Record<string, { duration: number; resolution: number; slots: number }> = {
  "12h": { duration: 12 * 60 * 60 * 1000, resolution: 30 * 60 * 1000, slots: 24 },    // 30分钟分辨率
  "1d":  { duration: 24 * 60 * 60 * 1000, resolution: 60 * 60 * 1000, slots: 24 },    // 1小时分辨率
  "3d":  { duration: 3 * 24 * 60 * 60 * 1000, resolution: 3 * 60 * 60 * 1000, slots: 24 }, // 3小时分辨率
  "7d":  { duration: 7 * 24 * 60 * 60 * 1000, resolution: 6 * 60 * 60 * 1000, slots: 28 }, // 6小时分辨率
  "1m":  { duration: 30 * 24 * 60 * 60 * 1000, resolution: 24 * 60 * 60 * 1000, slots: 30 }, // 1天分辨率
};

/**
 * 生成清算热力图数据
 * @param token 代币地址
 * @param timeRange 时间范围 (12h, 1d, 3d, 7d, 1m)
 * @param priceLevels 价格档位数量 (默认20)
 */
export async function generateLiquidationHeatmap(
  token: Address,
  timeRange: string = "1d",
  priceLevels: number = 20
): Promise<LiquidationHeatmapResponse> {
  // 规范化 token 地址为小写
  const normalizedToken = token.toLowerCase() as Address;

  const config = TIME_RANGE_CONFIG[timeRange] || TIME_RANGE_CONFIG["1d"];
  const now = Date.now();
  const timeStart = now;
  const timeEnd = now + config.duration;
  const timeSlots = config.slots;

  // 获取当前价格
  const orderBook = engine.getOrderBook(normalizedToken);
  const currentPrice = orderBook.getCurrentPrice();

  // 计算价格范围 (当前价格 ±20%)
  const priceRange = (currentPrice * 20n) / 100n;
  const priceMin = currentPrice - priceRange;
  const priceMax = currentPrice + priceRange;
  const priceStep = (priceMax - priceMin) / BigInt(priceLevels);

  // 获取所有仓位 - 先尝试 token 索引，失败则从全部仓位过滤
  let positions = await PositionRepo.getByToken(normalizedToken);
  if (positions.length === 0) {
    const allPositions = await PositionRepo.getAll();
    positions = allPositions.filter(
      p => p.token.toLowerCase() === normalizedToken
    );
  }

  // 初始化热力图数据
  const heatmap: HeatmapCell[] = [];
  let longTotal = 0n;
  let shortTotal = 0n;
  let longAccountTotal = 0;
  let shortAccountTotal = 0;

  // 统计每个仓位的清算价格落在哪个价格档位
  const priceBuckets: Map<number, { longSize: bigint; shortSize: bigint; longCount: number; shortCount: number }> = new Map();

  for (const position of positions) {
    if (position.status !== 0) continue; // 只处理开放仓位

    const liqPrice = position.liquidationPrice;
    if (liqPrice <= 0n) continue;

    // 计算价格档位索引
    const priceIndex = Number((liqPrice - priceMin) * BigInt(priceLevels) / (priceMax - priceMin));
    if (priceIndex < 0 || priceIndex >= priceLevels) continue;

    // 计算仓位价值 (USD)
    const positionValueUsd = (position.size * position.markPrice) / BigInt(1e24); // size(1e18) * price(1e12) / 1e24 = USD(1e6)

    let bucket = priceBuckets.get(priceIndex);
    if (!bucket) {
      bucket = { longSize: 0n, shortSize: 0n, longCount: 0, shortCount: 0 };
      priceBuckets.set(priceIndex, bucket);
    }

    if (position.isLong) {
      bucket.longSize += positionValueUsd;
      bucket.longCount++;
      longTotal += positionValueUsd;
      longAccountTotal++;
    } else {
      bucket.shortSize += positionValueUsd;
      bucket.shortCount++;
      shortTotal += positionValueUsd;
      shortAccountTotal++;
    }
  }

  // 计算最大值用于归一化强度
  let maxSize = 1n;
  for (const bucket of priceBuckets.values()) {
    const total = bucket.longSize + bucket.shortSize;
    if (total > maxSize) maxSize = total;
  }

  // 生成扁平化热力图数据
  // 由于我们没有历史数据，所有时间槽使用相同的当前快照数据
  // 但我们可以模拟一些时间分布
  for (let priceLevel = 0; priceLevel < priceLevels; priceLevel++) {
    const bucket = priceBuckets.get(priceLevel);

    for (let timeSlot = 0; timeSlot < timeSlots; timeSlot++) {
      // 对于没有历史数据的情况，我们将当前数据平均分布
      // 实际生产环境应该从历史数据中获取
      const timeFactor = timeSlot < timeSlots / 2 ? 0.5 : 1.0; // 越靠近当前时间，数据越多

      const cell: HeatmapCell = {
        priceLevel,
        timeSlot,
        longLiquidationSize: bucket ? BigInt(Math.floor(Number(bucket.longSize) * timeFactor)) : 0n,
        shortLiquidationSize: bucket ? BigInt(Math.floor(Number(bucket.shortSize) * timeFactor)) : 0n,
        longAccountCount: bucket ? Math.floor(bucket.longCount * timeFactor) : 0,
        shortAccountCount: bucket ? Math.floor(bucket.shortCount * timeFactor) : 0,
        intensity: bucket ? Math.floor(Number((bucket.longSize + bucket.shortSize) * 100n / maxSize) * timeFactor) : 0,
      };

      heatmap.push(cell);
    }
  }

  // 格式化时间分辨率
  const resolutionStr = config.resolution >= 24 * 60 * 60 * 1000 ? `${config.resolution / (24 * 60 * 60 * 1000)}d` :
                        config.resolution >= 60 * 60 * 1000 ? `${config.resolution / (60 * 60 * 1000)}h` :
                        `${config.resolution / (60 * 1000)}m`;

  return {
    token: normalizedToken,
    currentPrice: currentPrice.toString(),
    priceMin: priceMin.toString(),
    priceMax: priceMax.toString(),
    priceStep: priceStep.toString(),
    priceLevels,
    timeStart,
    timeEnd,
    timeSlots,
    resolution: resolutionStr,
    heatmap,
    longTotal: longTotal.toString(),
    shortTotal: shortTotal.toString(),
    longAccountTotal,
    shortAccountTotal,
    timestamp: now,
  };
}

/**
 * 获取简化的清算地图数据（用于向后兼容旧的条形图组件）
 */
export async function getLiquidationMapData(token: Address): Promise<{
  token: string;
  currentPrice: string;
  longs: Array<{ price: string; size: string; accounts: number }>;
  shorts: Array<{ price: string; size: string; accounts: number }>;
  totalLongSize: string;
  totalShortSize: string;
  totalLongAccounts: number;
  totalShortAccounts: number;
}> {
  // 规范化 token 地址为小写
  const normalizedToken = token.toLowerCase() as Address;

  const orderBook = engine.getOrderBook(normalizedToken);
  const currentPrice = orderBook.getCurrentPrice();

  // 获取仓位 - 先尝试 token 索引，失败则从全部仓位过滤
  let positions = await PositionRepo.getByToken(normalizedToken);
  if (positions.length === 0) {
    const allPositions = await PositionRepo.getAll();
    positions = allPositions.filter(
      p => p.token.toLowerCase() === normalizedToken
    );
  }

  // 按清算价格分组
  const longLevels: Map<string, { size: bigint; accounts: number }> = new Map();
  const shortLevels: Map<string, { size: bigint; accounts: number }> = new Map();

  let totalLongSize = 0n;
  let totalShortSize = 0n;
  let totalLongAccounts = 0;
  let totalShortAccounts = 0;

  for (const position of positions) {
    if (position.status !== 0) continue;

    const liqPrice = position.liquidationPrice;
    if (liqPrice <= 0n) continue;

    // 将价格四舍五入到合适的精度
    const roundedPrice = ((liqPrice / BigInt(1e8)) * BigInt(1e8)).toString();
    const positionValue = (position.size * position.markPrice) / BigInt(1e24);

    if (position.isLong) {
      // 多头清算价格在当前价格下方
      const level = longLevels.get(roundedPrice) || { size: 0n, accounts: 0 };
      level.size += positionValue;
      level.accounts++;
      longLevels.set(roundedPrice, level);
      totalLongSize += positionValue;
      totalLongAccounts++;
    } else {
      // 空头清算价格在当前价格上方
      const level = shortLevels.get(roundedPrice) || { size: 0n, accounts: 0 };
      level.size += positionValue;
      level.accounts++;
      shortLevels.set(roundedPrice, level);
      totalShortSize += positionValue;
      totalShortAccounts++;
    }
  }

  // 转换为数组并排序
  const longs = Array.from(longLevels.entries())
    .map(([price, { size, accounts }]) => ({ price, size: size.toString(), accounts }))
    .sort((a, b) => Number(BigInt(b.price) - BigInt(a.price))); // 从高到低

  const shorts = Array.from(shortLevels.entries())
    .map(([price, { size, accounts }]) => ({ price, size: size.toString(), accounts }))
    .sort((a, b) => Number(BigInt(a.price) - BigInt(b.price))); // 从低到高

  return {
    token: normalizedToken,
    currentPrice: currentPrice.toString(),
    longs,
    shorts,
    totalLongSize: totalLongSize.toString(),
    totalShortSize: totalShortSize.toString(),
    totalLongAccounts,
    totalShortAccounts,
  };
}

export default {
  detectLiquidations,
  updateLiquidationQueue,
  getLiquidationQueue,
  executeLiquidation,
  processLiquidations,
  calculateADLScore,
  calculateADLRanking,
  updateADLQueues,
  executeADL,
  getADLQueue,
  generateLiquidationHeatmap,
  getLiquidationMapData,
};
