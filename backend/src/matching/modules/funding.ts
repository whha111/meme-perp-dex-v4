/**
 * 资金费率模块（ETH 本位简化版）
 *
 * 内盘合约固定资金费设计：
 * - 固定费率：0.01% / 5分钟
 * - 双方都收（多头和空头都扣）
 * - 全部进入保险基金
 *
 * ETH 本位:
 * - 所有金额以 ETH 计价 (1e18 精度)
 * - fundingAmount = positionValue(ETH) * rate
 */

import type { Address } from "viem";
import { PositionRepo, SettlementLogRepo } from "../database/redis";
import { logger } from "../utils/logger";
import { calculateLiquidationPriceWithCollateral } from "../utils/precision";
import type { Position, FundingRate, FundingPayment } from "../types";
import { isPerpVaultEnabled, collectTradingFee as vaultCollectFee } from "./perpVault";

// ============================================================
// Constants
// ============================================================

// 固定资金费率：0.01% = 1bp = 1/10000
const FIXED_FUNDING_RATE = 1n; // 1 basis point

// 结算周期：5分钟
const FUNDING_INTERVAL_MS = 5 * 60 * 1000;

// 精度
const RATE_PRECISION = 10000n;

// ============================================================
// State
// ============================================================

// 每个代币的下次结算时间
const nextFundingSettlement = new Map<Address, number>();

// 资金费支付历史
const fundingPaymentHistory = new Map<Address, FundingPayment[]>();

// 保险基金累计收入
let insuranceFundAccumulated = 0n;

// 定时器
let fundingInterval: NodeJS.Timeout | null = null;

// 支持的代币列表（从外部设置）
let supportedTokens: Address[] = [];

// ============================================================
// Configuration
// ============================================================

/**
 * 设置支持的代币列表
 */
export function setSupportedTokens(tokens: Address[]): void {
  supportedTokens = tokens.map(t => t.toLowerCase() as Address);
}

/**
 * 获取固定资金费率
 */
export function getFundingRate(): bigint {
  return FIXED_FUNDING_RATE;
}

/**
 * 获取结算周期（毫秒）
 */
export function getFundingInterval(): number {
  return FUNDING_INTERVAL_MS;
}

/**
 * 获取保险基金累计收入
 */
export function getInsuranceFundAccumulated(): bigint {
  return insuranceFundAccumulated;
}

// ============================================================
// Funding Settlement
// ============================================================

/**
 * 执行资金费结算（简化版）
 *
 * - 固定费率 0.01%
 * - 多头和空头都扣
 * - 全部进保险基金
 */
export async function settleFunding(token: Address): Promise<FundingPayment[]> {
  const normalizedToken = token.toLowerCase() as Address;
  const positions = await PositionRepo.getByToken(normalizedToken);
  const payments: FundingPayment[] = [];
  const timestamp = Date.now();

  let totalFundingCollected = 0n;

  for (const position of positions) {
    // 只处理活跃仓位
    if (position.status !== 0) continue;

    // ETH 本位: 计算资金费
    // fundingAmount = 仓位 ETH 价值 × 固定费率
    // positionValueETH = size * markPrice / 1e18 (需要 markPrice)
    // 简化: 使用 collateral * leverage 作为近似仓位价值
    // fundingAmount = collateral * leverage / 10000 * FIXED_FUNDING_RATE / 10000
    // 简化版直接按保证金收取: fundingAmount = collateral * rate / 10000
    const fundingAmount = (position.collateral * FIXED_FUNDING_RATE) / RATE_PRECISION;

    if (fundingAmount === 0n) continue;

    // 双方都扣，资金费都是正数（支出）
    const newCollateral = position.collateral - fundingAmount;

    // 重新计算爆仓价格（关键！保证金减少后爆仓价会变化）
    // 使用基于当前保证金的计算方法，而不是初始杠杆
    const newLiquidationPrice = calculateLiquidationPriceWithCollateral(
      position.entryPrice,
      position.size,
      newCollateral,
      position.mmr,
      position.isLong
    );

    // 更新仓位
    await PositionRepo.update(position.id, {
      collateral: newCollateral,
      margin: newCollateral,  // margin 也要同步更新
      accumulatedFunding: position.accumulatedFunding + fundingAmount,
      liquidationPrice: newLiquidationPrice,  // 更新爆仓价
    });

    logger.debug("Funding", `Position ${position.id}: new collateral=${newCollateral}, new liqPrice=${newLiquidationPrice}`);

    // 累计到保险基金
    totalFundingCollected += fundingAmount;

    // 记录支付
    const payment: FundingPayment = {
      id: `${position.id}-${timestamp}`,
      trader: position.trader,
      token: normalizedToken,
      positionId: position.id,
      isLong: position.isLong,
      positionSize: position.size,
      fundingRate: FIXED_FUNDING_RATE,
      fundingAmount: fundingAmount,
      timestamp,
    };
    payments.push(payment);

    // 记录结算日志
    await SettlementLogRepo.create({
      txHash: null,
      userAddress: position.trader,
      type: "FUNDING_FEE",
      amount: -fundingAmount, // 负数表示扣除
      balanceBefore: position.collateral,
      balanceAfter: newCollateral,
      onChainStatus: "SUCCESS",
      proofData: JSON.stringify({
        positionId: position.id,
        fundingRate: FIXED_FUNDING_RATE.toString(),
        fundingAmount: fundingAmount.toString(),
        destination: "INSURANCE_FUND",
      }),
      positionId: position.id,
    });

    logger.debug("Funding", `Position ${position.id}: collected ${fundingAmount} funding fee`);
  }

  // 更新保险基金累计
  insuranceFundAccumulated += totalFundingCollected;

  // P0-2: PerpVault 资金费进入 LP 池子 — 必须 await（保险基金收入不可丢失）
  if (isPerpVaultEnabled() && totalFundingCollected > 0n) {
    try {
      await vaultCollectFee(totalFundingCollected);
    } catch (err) {
      logger.error("Funding", `PerpVault fee collection failed (${totalFundingCollected}): ${err}`);
    }
  }

  // 记录历史
  if (payments.length > 0) {
    let history = fundingPaymentHistory.get(normalizedToken) || [];
    history.unshift(...payments);
    if (history.length > 1000) history = history.slice(0, 1000);
    fundingPaymentHistory.set(normalizedToken, history);
  }

  // 更新下次结算时间
  nextFundingSettlement.set(normalizedToken, Date.now() + FUNDING_INTERVAL_MS);

  if (payments.length > 0) {
    logger.info("Funding", `Settled funding for ${token.slice(0, 10)}: ${payments.length} positions, total=${totalFundingCollected}, insurance_fund=${insuranceFundAccumulated}`);
  }

  return payments;
}

/**
 * 检查仓位是否需要因资金费而被清算
 *
 * 返回保证金率低于维持保证金率的仓位
 */
export async function checkFundingLiquidations(token: Address, maintenanceMarginRate: bigint = 500n): Promise<Position[]> {
  const normalizedToken = token.toLowerCase() as Address;
  const positions = await PositionRepo.getByToken(normalizedToken);
  const needsLiquidation: Position[] = [];

  for (const position of positions) {
    if (position.status !== 0) continue;

    // ETH 本位: 保证金率 = 保证金 / 仓位价值 * 10000
    // 简化: 假设仓位价值 ≈ 保证金 × 杠杆
    // marginRate = collateral / (collateral * leverage / 10000) * 10000
    //            = 10000 * 10000 / leverage
    const marginRate = (10000n * 10000n) / position.leverage;

    // 如果保证金率低于维持保证金率（默认5% = 500bp），需要清算
    if (marginRate < maintenanceMarginRate) {
      needsLiquidation.push(position);
      logger.warn("Funding", `Position ${position.id} needs liquidation after funding: marginRate=${marginRate}bp`);
    }
  }

  return needsLiquidation;
}

// ============================================================
// Query Functions
// ============================================================

/**
 * 获取资金费支付历史
 */
export function getFundingPaymentHistory(token: Address, limit = 100): FundingPayment[] {
  const history = fundingPaymentHistory.get(token.toLowerCase() as Address) || [];
  return history.slice(0, limit);
}

/**
 * 获取下次结算时间
 */
export function getNextFundingTime(token: Address): number {
  return nextFundingSettlement.get(token.toLowerCase() as Address) || 0;
}

/**
 * 获取距离下次结算的剩余时间（毫秒）
 */
export function getTimeUntilNextFunding(token: Address): number {
  const nextTime = getNextFundingTime(token);
  if (nextTime === 0) return FUNDING_INTERVAL_MS;
  const remaining = nextTime - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * 获取资金费率信息
 */
export function getFundingRateInfo(token: Address, currentPrice: bigint): FundingRate {
  const normalizedToken = token.toLowerCase() as Address;

  return {
    token: normalizedToken,
    rate: FIXED_FUNDING_RATE,
    markPrice: currentPrice,
    indexPrice: currentPrice, // 内盘合约，mark = index = spot
    nextSettlementTime: nextFundingSettlement.get(normalizedToken) || Date.now() + FUNDING_INTERVAL_MS,
    timestamp: Date.now(),
  };
}

// ============================================================
// Timer Management
// ============================================================

/**
 * 启动资金费定时器
 */
export function startFundingTimer(): void {
  if (fundingInterval) return;

  // 初始化所有代币的下次结算时间
  const now = Date.now();
  for (const token of supportedTokens) {
    if (!nextFundingSettlement.has(token)) {
      nextFundingSettlement.set(token, now + FUNDING_INTERVAL_MS);
    }
  }

  fundingInterval = setInterval(async () => {
    const now = Date.now();

    for (const token of supportedTokens) {
      const nextTime = nextFundingSettlement.get(token);
      if (!nextTime || now >= nextTime) {
        try {
          await settleFunding(token);
        } catch (error) {
          logger.error("Funding", `Failed to settle funding for ${token}: ${error}`);
        }
      }
    }
  }, 10000); // 每10秒检查一次

  logger.info("Funding", `Started funding timer: ${FIXED_FUNDING_RATE}bp every ${FUNDING_INTERVAL_MS / 1000}s`);
}

/**
 * 停止资金费定时器
 */
export function stopFundingTimer(): void {
  if (fundingInterval) {
    clearInterval(fundingInterval);
    fundingInterval = null;
    logger.info("Funding", "Stopped funding timer");
  }
}

/**
 * 手动触发资金费结算（用于测试）
 */
export async function triggerFundingSettlement(token: Address): Promise<FundingPayment[]> {
  return settleFunding(token);
}

// ============================================================
// Export
// ============================================================

export default {
  setSupportedTokens,
  getFundingRate,
  getFundingInterval,
  getInsuranceFundAccumulated,
  settleFunding,
  checkFundingLiquidations,
  getFundingPaymentHistory,
  getNextFundingTime,
  getTimeUntilNextFunding,
  getFundingRateInfo,
  startFundingTimer,
  stopFundingTimer,
  triggerFundingSettlement,
};
