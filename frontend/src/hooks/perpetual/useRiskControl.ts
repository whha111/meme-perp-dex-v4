"use client";

/**
 * useRiskControl - 风控数据 Hook
 *
 * 已对接: 从 tradingDataStore 读取 WebSocket 实时推送的仓位风险数据
 * 后端 broadcastRiskData() 每 500ms 推送 position_risks → store.setPositions()
 */

import { useState, useCallback, useMemo } from "react";
import { type Address } from "viem";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";

// ============================================================
// 类型定义 (保留所有类型)
// ============================================================

export interface PositionRisk {
  pairId: string;
  trader: Address;
  token: Address;
  isLong: boolean;
  size: string;
  entryPrice: string;
  leverage: number;
  marginRatio: number;
  mmr: number;
  liquidationPrice: string;
  markPrice: string;
  unrealizedPnL: string;
  collateral: string;
  adlScore: number;
  adlRanking: number;
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface LiquidationMapData {
  token: Address;
  currentPrice: string;
  longs: LiquidationLevel[];
  shorts: LiquidationLevel[];
  totalLongSize: string;
  totalShortSize: string;
  totalLongAccounts: number;
  totalShortAccounts: number;
}

export interface LiquidationLevel {
  price: string;
  size: string;
  accounts: number;
  percentage: number;
}

export interface InsuranceFund {
  balance: string;
  totalContributions: string;
  totalPayouts: string;
  lastUpdated: number;
  display: {
    balance: string;
    totalContributions: string;
    totalPayouts: string;
  };
}

export interface FundingRateInfo {
  token: Address;
  currentRate: number;
  nextSettlement: number;
  lastSettlement: number;
  longSize: string;
  shortSize: string;
  imbalance: number;
}

export interface LiquidationQueueItem {
  pairId: string;
  trader: Address;
  token: Address;
  isLong: boolean;
  size: string;
  marginRatio: number;
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

export interface RiskAlert {
  type: "margin_warning" | "liquidation_warning" | "adl_warning" | "funding_warning";
  severity: "info" | "warning" | "danger";
  pairId?: string;
  message: string;
  timestamp: number;
}

// ============================================================
// 计算函数 (保留，可用于本地计算)
// ============================================================

export function calculateLiquidationPrice(
  entryPrice: bigint,
  leverage: number,
  isLong: boolean,
  mmr: number = 200
): bigint {
  const mmrDecimal = BigInt(mmr);
  const leverageBigInt = BigInt(leverage);

  if (isLong) {
    const factor = 10000n - (10000n / leverageBigInt) + mmrDecimal;
    return (entryPrice * factor) / 10000n;
  } else {
    const factor = 10000n + (10000n / leverageBigInt) - mmrDecimal;
    return (entryPrice * factor) / 10000n;
  }
}

export function calculateMarginRatio(
  equity: bigint,
  positionValue: bigint
): number {
  if (positionValue === 0n) return 10000;
  return Number((equity * 10000n) / positionValue);
}

export function calculateRiskLevel(
  marginRatio: number,
  mmr: number
): "low" | "medium" | "high" | "critical" {
  const ratio = marginRatio / mmr;
  if (ratio < 1) return "critical";
  if (ratio < 1.2) return "high";
  if (ratio < 1.5) return "medium";
  return "low";
}

export function calculateADLScore(
  unrealizedPnL: bigint,
  margin: bigint,
  leverage: number
): number {
  if (margin === 0n || unrealizedPnL <= 0n) return 0;
  return Number((unrealizedPnL * BigInt(leverage) * 10000n) / margin) / 10000;
}

// ============================================================
// Hook: useRiskControl (已对接 tradingDataStore)
// ============================================================

interface UseRiskControlOptions {
  trader?: Address;
  token?: Address;
  autoConnect?: boolean;
}

interface UseRiskControlReturn {
  positionRisks: PositionRisk[];
  liquidationMap: LiquidationMapData | null;
  insuranceFund: InsuranceFund | null;
  fundingRates: FundingRateInfo[];
  liquidationQueue: LiquidationQueueItem[];
  alerts: RiskAlert[];
  isConnected: boolean;
  error: string | null;
  lastUpdated: number | null;
  clearAlerts: () => void;
  reconnect: () => void;
}

export function useRiskControl(_options: UseRiskControlOptions = {}): UseRiskControlReturn {
  // ✅ 从 tradingDataStore 读取 WebSocket 实时推送的仓位数据
  // 后端 broadcastRiskData() 每 500ms 推送 position_risks
  // useUnifiedWebSocket 接收后存入 store.setPositions()
  const storePositions = useTradingDataStore((state) => state.positions);

  // 将 PairedPosition[] 映射为 PositionRisk[] (字段兼容)
  const positionRisks: PositionRisk[] = useMemo(() => {
    return storePositions.map((pos) => ({
      pairId: pos.pairId,
      trader: (pos.trader || pos.counterparty) as Address,
      token: pos.token,
      isLong: pos.isLong,
      size: pos.size,
      entryPrice: pos.entryPrice,
      leverage: parseFloat(pos.leverage || "1"),
      marginRatio: parseFloat(pos.marginRatio || "0"),
      mmr: parseFloat(pos.mmr || "200"),
      liquidationPrice: pos.liquidationPrice || "0",
      markPrice: pos.markPrice || "0",
      unrealizedPnL: pos.unrealizedPnL || "0",
      collateral: pos.collateral,
      adlScore: typeof pos.adlScore === "number" ? Number(pos.adlScore) : parseFloat(pos.adlScore || "0"),
      adlRanking: pos.adlRanking || 1,
      riskLevel: (pos.riskLevel || "low") as PositionRisk["riskLevel"],
    }));
  }, [storePositions]);

  const [liquidationMap] = useState<LiquidationMapData | null>(null);
  const [insuranceFund] = useState<InsuranceFund | null>(null);
  const [fundingRates] = useState<FundingRateInfo[]>([]);
  const [liquidationQueue] = useState<LiquidationQueueItem[]>([]);
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const isConnected = storePositions.length > 0; // 有数据即视为已连接
  const [error] = useState<string | null>(null);
  const lastUpdated = useTradingDataStore((state) => state.lastUpdated);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  const reconnect = useCallback(() => {
    // WebSocket 重连由 useUnifiedWebSocket 管理
  }, []);

  return {
    positionRisks,
    liquidationMap,
    insuranceFund,
    fundingRates,
    liquidationQueue,
    alerts,
    isConnected,
    error,
    lastUpdated,
    clearAlerts,
    reconnect,
  };
}

// ============================================================
// Hook: usePositionRisk (本地计算)
// ============================================================

interface UsePositionRiskReturn {
  marginRatio: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  liquidationPrice: string;
  adlRanking: number;
  distanceToLiquidation: number;
  isAtRisk: boolean;
}

export function usePositionRisk(
  position: {
    entryPrice: string;
    markPrice: string;
    leverage: number;
    isLong: boolean;
    collateral: string;
    size: string;
    unrealizedPnL: string;
  } | null
): UsePositionRiskReturn {
  if (!position) {
    return {
      marginRatio: 10000,
      riskLevel: "low",
      liquidationPrice: "0",
      adlRanking: 1,
      distanceToLiquidation: 100,
      isAtRisk: false,
    };
  }

  const mmr = 200;
  const entryPrice = BigInt(position.entryPrice || "0");
  const markPrice = BigInt(position.markPrice || "0");
  const collateral = BigInt(position.collateral || "0");
  const size = BigInt(position.size || "0");
  const unrealizedPnL = BigInt(position.unrealizedPnL || "0");

  // AUDIT-FIX FE-C03: size 是 ETH 名义价值 (1e18)，markPrice 是 1e18
  // size * markPrice 产生 1e36 量级，需除以 1e18 得到 ETH 值
  // 之前除以 1e24 导致 positionValue 缩小 1e6 倍 → 所有仓位永远显示低风险
  const positionValue = size > 0n && markPrice > 0n
    ? (size * markPrice) / (10n ** 18n)
    : 0n;

  const equity = collateral + unrealizedPnL;
  const marginRatio = calculateMarginRatio(equity, positionValue);
  const riskLevel = calculateRiskLevel(marginRatio, mmr);

  const liquidationPrice = calculateLiquidationPrice(
    entryPrice,
    position.leverage,
    position.isLong,
    mmr
  );

  const adlScore = calculateADLScore(
    unrealizedPnL,
    collateral,
    position.leverage
  );
  const adlRanking = Math.min(5, Math.max(1, Math.ceil(adlScore)));

  const distanceToLiquidation = markPrice > 0n
    ? position.isLong
      ? Number(((markPrice - liquidationPrice) * 10000n) / markPrice) / 100
      : Number(((liquidationPrice - markPrice) * 10000n) / markPrice) / 100
    : 100;

  return {
    marginRatio,
    riskLevel,
    liquidationPrice: liquidationPrice.toString(),
    adlRanking,
    distanceToLiquidation: Math.max(0, distanceToLiquidation),
    isAtRisk: riskLevel === "high" || riskLevel === "critical",
  };
}

export default useRiskControl;
