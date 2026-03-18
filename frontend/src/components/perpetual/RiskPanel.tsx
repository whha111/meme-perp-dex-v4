"use client";

/**
 * 风险控制面板
 *
 * 集成显示:
 * 1. 风险预警通知
 * 2. 保险基金状态
 * 3. 用户仓位风险指标
 * 4. ADL 排名指示器
 * 5. 资金费率信息
 */

import React, { useState, useEffect } from "react";
import { type Address } from "viem";
import { useTranslations } from "next-intl";
import { useRiskControl, type RiskAlert, type PositionRisk } from "@/hooks/perpetual/useRiskControl";

// ============================================================
// 子组件: 风险预警通知
// ============================================================

interface RiskAlertsProps {
  alerts: RiskAlert[];
  onClear: () => void;
  maxDisplay?: number;
}

function RiskAlerts({ alerts, onClear, maxDisplay = 5 }: RiskAlertsProps) {
  const t = useTranslations("perp");
  const displayAlerts = alerts.slice(0, maxDisplay);

  if (displayAlerts.length === 0) {
    return null;
  }

  const getSeverityStyles = (severity: RiskAlert["severity"]) => {
    switch (severity) {
      case "danger":
        return "bg-red-900/50 border-red-500 text-red-400";
      case "warning":
        return "bg-yellow-900/50 border-yellow-500 text-yellow-400";
      default:
        return "bg-blue-900/50 border-blue-500 text-blue-400";
    }
  };

  const getAlertIcon = (type: RiskAlert["type"]) => {
    switch (type) {
      case "liquidation_warning":
        return (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        );
      case "adl_warning":
        return (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
          </svg>
        );
      case "funding_warning":
        return (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
          </svg>
        );
      default:
        return (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
        );
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-okx-text-primary flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
          </span>
          {t("riskAlerts")} ({alerts.length})
        </h4>
        <button
          onClick={onClear}
          className="text-xs text-okx-text-tertiary hover:text-okx-text-secondary"
        >
          {t("clearAll")}
        </button>
      </div>
      <div className="space-y-1.5 max-h-40 overflow-y-auto">
        {displayAlerts.map((alert, index) => (
          <div
            key={`${alert.timestamp}-${index}`}
            className={`flex items-start gap-2 p-2 rounded border text-xs ${getSeverityStyles(alert.severity)}`}
          >
            {getAlertIcon(alert.type)}
            <div className="flex-1 min-w-0">
              <p className="truncate">{alert.message}</p>
              <p className="text-xs opacity-70 mt-0.5">
                {new Date(alert.timestamp).toLocaleTimeString()}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// 子组件: ADL 排名指示器
// ============================================================

interface ADLIndicatorProps {
  ranking: number; // 1-5
  score: number;
}

function ADLIndicator({ ranking, score }: ADLIndicatorProps) {
  const bars = [1, 2, 3, 4, 5];

  return (
    <div className="flex items-center gap-1">
      {bars.map((bar) => (
        <div
          key={bar}
          className={`w-1.5 h-3 rounded-sm transition-colors ${
            bar <= ranking
              ? ranking >= 4
                ? "bg-red-500"
                : ranking >= 3
                ? "bg-yellow-500"
                : "bg-green-500"
              : "bg-gray-700"
          }`}
        />
      ))}
      <span className="text-xs text-okx-text-tertiary ml-1">
        {score.toFixed(2)}
      </span>
    </div>
  );
}

// ============================================================
// 子组件: 保险基金状态
// ============================================================

interface InsuranceFundDisplayProps {
  balance: string;
  totalContributions: string;
  totalPayouts: string;
}

function InsuranceFundDisplay({ balance, totalContributions, totalPayouts }: InsuranceFundDisplayProps) {
  const t = useTranslations("perp");
  const formatUSD = (value: string) => {
    const num = parseFloat(value);
    if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `$${(num / 1000).toFixed(2)}K`;
    return `$${num.toFixed(2)}`;
  };

  const usagePercent = parseFloat(totalContributions) > 0
    ? (parseFloat(totalPayouts) / parseFloat(totalContributions)) * 100
    : 0;

  return (
    <div className="bg-okx-bg-secondary rounded-lg p-3">
      <h4 className="text-sm font-medium text-okx-text-primary mb-3 flex items-center gap-2">
        <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
        </svg>
        {t("insuranceFund")}
      </h4>

      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <span className="text-xs text-okx-text-tertiary">{t("balance")}</span>
          <span className="text-sm font-bold text-green-400">{formatUSD(balance)}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-xs text-okx-text-tertiary">{t("totalIn")}</span>
          <span className="text-xs text-okx-text-secondary">{formatUSD(totalContributions)}</span>
        </div>

        <div className="flex justify-between items-center">
          <span className="text-xs text-okx-text-tertiary">{t("totalOut")}</span>
          <span className="text-xs text-okx-text-secondary">{formatUSD(totalPayouts)}</span>
        </div>

        {/* Usage Bar */}
        <div className="mt-2">
          <div className="flex justify-between text-xs text-okx-text-tertiary mb-1">
            <span>{t("usage")}</span>
            <span>{usagePercent.toFixed(1)}%</span>
          </div>
          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                usagePercent > 80 ? "bg-red-500" : usagePercent > 50 ? "bg-yellow-500" : "bg-green-500"
              }`}
              style={{ width: `${Math.min(100, usagePercent)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 子组件: 仓位风险卡片
// ============================================================

interface PositionRiskCardProps {
  position: PositionRisk;
  currentPrice: string;
}

function PositionRiskCard({ position, currentPrice }: PositionRiskCardProps) {
  const t = useTranslations("perp");
  const getRiskColor = (level: PositionRisk["riskLevel"]) => {
    switch (level) {
      case "critical": return "text-red-500 bg-red-900/30";
      case "high": return "text-orange-500 bg-orange-900/30";
      case "medium": return "text-yellow-500 bg-yellow-900/30";
      default: return "text-green-500 bg-green-900/30";
    }
  };

  // 格式化价格 - 使用下标格式，避免科学计数法
  const formatPrice = (price: string) => {
    const p = parseFloat(price);
    if (p <= 0) return "0";
    if (p >= 1) return p.toFixed(4);
    if (p >= 0.0001) return p.toFixed(8);
    // 极小数使用下标格式
    const priceStr = p.toFixed(18);
    const match = priceStr.match(/^0\.(0*)([1-9]\d*)/);
    if (match) {
      const zeroCount = match[1].length;
      const significantDigits = match[2].slice(0, 4);
      const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
      const subscriptNum = zeroCount.toString().split("").map((d) => subscripts[parseInt(d)]).join("");
      return `0.0${subscriptNum}${significantDigits}`;
    }
    return p.toFixed(10);
  };

  const marginRatioPercent = (position.marginRatio / 100).toFixed(2);
  const mmrPercent = (position.mmr / 100).toFixed(2);

  return (
    <div className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${
            position.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"
          }`}>
            {position.isLong ? t("long") : t("short")}
          </span>
          <span className="text-xs text-okx-text-primary font-medium">
            {position.leverage}x
          </span>
        </div>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${getRiskColor(position.riskLevel)}`}>
          {t(position.riskLevel)}
        </span>
      </div>

      {/* Risk Metrics */}
      <div className="space-y-2 text-xs">
        {/* Margin Ratio */}
        <div>
          <div className="flex justify-between text-okx-text-tertiary mb-1">
            <span>{t("marginRatio")}</span>
            <span className={position.marginRatio < position.mmr * 1.2 ? "text-red-400" : ""}>
              {marginRatioPercent}% / {mmrPercent}% {t("mmr")}
            </span>
          </div>
          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${
                position.marginRatio < position.mmr ? "bg-red-500" :
                position.marginRatio < position.mmr * 1.2 ? "bg-orange-500" :
                position.marginRatio < position.mmr * 1.5 ? "bg-yellow-500" : "bg-green-500"
              }`}
              style={{ width: `${Math.min(100, (position.marginRatio / (position.mmr * 3)) * 100)}%` }}
            />
          </div>
        </div>

        {/* Price Info */}
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <span className="text-okx-text-tertiary">{t("entry")}</span>
            <p className="font-mono text-okx-text-primary">${formatPrice(position.entryPrice)}</p>
          </div>
          <div>
            <span className="text-okx-text-tertiary">{t("liqPrice")}</span>
            <p className="font-mono text-red-400">${formatPrice(position.liquidationPrice)}</p>
          </div>
        </div>

        {/* ADL Ranking */}
        <div className="flex items-center justify-between pt-2 border-t border-okx-border-primary">
          <span className="text-okx-text-tertiary">{t("adlRisk")}</span>
          <ADLIndicator ranking={position.adlRanking} score={position.adlScore} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 主组件: RiskPanel
// ============================================================

interface RiskPanelProps {
  trader?: Address;
  token?: Address;
  compact?: boolean;
  className?: string;
}

export function RiskPanel({ trader, token, compact = false, className = "" }: RiskPanelProps) {
  const t = useTranslations("perp");
  const {
    positionRisks,
    insuranceFund,
    fundingRates,
    alerts,
    isConnected,
    error,
    lastUpdated,
    clearAlerts,
    reconnect,
  } = useRiskControl({ trader, token });

  // 获取当前代币的资金费率
  const fundingRate = token
    ? fundingRates.find(f => f.token.toLowerCase() === token.toLowerCase())
    : fundingRates[0];

  // 计算整体风险等级
  const overallRisk = positionRisks.reduce((worst, pos) => {
    const levels = ["low", "medium", "high", "critical"];
    return levels.indexOf(pos.riskLevel) > levels.indexOf(worst) ? pos.riskLevel : worst;
  }, "low" as PositionRisk["riskLevel"]);

  if (compact) {
    return (
      <div className={`flex items-center gap-4 ${className}`}>
        {/* Alerts Badge */}
        {alerts.length > 0 && (
          <div className="relative">
            <button className="p-2 rounded-lg bg-red-900/30 text-red-400">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
              </svg>
            </button>
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">
              {alerts.length > 9 ? "9+" : alerts.length}
            </span>
          </div>
        )}

        {/* Overall Risk Indicator */}
        {positionRisks.length > 0 && (
          <div className={`px-2 py-1 rounded text-xs font-medium ${
            overallRisk === "critical" ? "bg-red-900/50 text-red-400" :
            overallRisk === "high" ? "bg-orange-900/50 text-orange-400" :
            overallRisk === "medium" ? "bg-yellow-900/50 text-yellow-400" :
            "bg-green-900/50 text-green-400"
          }`}>
            {t("risk")}: {t(overallRisk)}
          </div>
        )}

        {/* Insurance Fund Mini */}
        {insuranceFund && (
          <div className="text-xs text-okx-text-tertiary">
            <span className="text-green-400 font-medium">
              ${(parseFloat(insuranceFund.display.balance)).toLocaleString()}
            </span>
            <span className="ml-1">IF</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`bg-okx-bg-primary rounded-lg p-4 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-okx-text-primary flex items-center gap-2">
          <svg className="w-5 h-5 text-okx-brand" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          {t("riskControl")}
        </h3>
        {lastUpdated && (
          <span className="text-xs text-okx-text-tertiary">
            {t("updated")}: {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Connection Status */}
      {!isConnected && !lastUpdated && (
        <div className="animate-pulse space-y-4">
          <div className="h-20 bg-okx-bg-secondary rounded-lg" />
          <div className="h-32 bg-okx-bg-secondary rounded-lg" />
          <p className="text-center text-okx-text-tertiary text-xs">{t("connectingToServer")}</p>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-red-400 text-sm p-4 bg-red-900/20 rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={reconnect}
            className="px-2 py-1 bg-red-900/50 rounded text-xs hover:bg-red-800"
          >
            {t("retry")}
          </button>
        </div>
      )}

      {/* Content */}
      {(isConnected || lastUpdated) && !error && (
        <div className="space-y-4">
          {/* Connection indicator */}
          <div className="flex items-center gap-2 text-xs text-okx-text-tertiary">
            <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-yellow-500"}`} />
            <span>{isConnected ? t("realTime") : t("reconnecting")}</span>
          </div>

          {/* Risk Alerts */}
          {alerts.length > 0 && (
            <RiskAlerts alerts={alerts} onClear={clearAlerts} />
          )}

          {/* Funding Rate Info */}
          {fundingRate && (
            <div className="bg-okx-bg-secondary rounded-lg p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-okx-text-primary">{t("fundingRate")}</h4>
                <span className={`text-sm font-bold ${
                  fundingRate.currentRate >= 0 ? "text-green-400" : "text-red-400"
                }`}>
                  {fundingRate.currentRate >= 0 ? "+" : ""}{(fundingRate.currentRate / 100).toFixed(4)}%
                </span>
              </div>
              <div className="flex items-center justify-between mt-2 text-xs text-okx-text-tertiary">
                <span>{t("nextSettlement")}</span>
                <span>{new Date(fundingRate.nextSettlement).toLocaleTimeString()}</span>
              </div>
              <div className="flex items-center justify-between mt-1 text-xs text-okx-text-tertiary">
                <span>{t("longShortImbalance")}</span>
                <span className={fundingRate.imbalance >= 0 ? "text-green-400" : "text-red-400"}>
                  {fundingRate.imbalance >= 0 ? "+" : ""}{fundingRate.imbalance.toFixed(2)}%
                </span>
              </div>
            </div>
          )}

          {/* Insurance Fund */}
          {insuranceFund && (
            <InsuranceFundDisplay
              balance={insuranceFund.display.balance}
              totalContributions={insuranceFund.display.totalContributions}
              totalPayouts={insuranceFund.display.totalPayouts}
            />
          )}

          {/* Position Risks */}
          {positionRisks.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-okx-text-primary">
                {t("positionRisks")} ({positionRisks.length})
              </h4>
              {positionRisks.map((pos) => (
                <PositionRiskCard
                  key={pos.pairId}
                  position={pos}
                  currentPrice={pos.markPrice}
                />
              ))}
            </div>
          )}

          {/* Empty State */}
          {!alerts.length && !positionRisks.length && !insuranceFund && (
            <div className="text-center py-8 text-okx-text-tertiary">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <p>{t("noRiskData")}</p>
              <p className="text-xs mt-1">{t("openPositionsToSeeRisk")}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default RiskPanel;
