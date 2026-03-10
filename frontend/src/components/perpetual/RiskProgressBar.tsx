"use client";

/**
 * 风险进度条组件
 *
 * 可视化展示仓位距离清算的风险程度
 * - 0-50%: 红色 (危险)
 * - 50-75%: 黄色 (警告)
 * - 75-100%: 绿色 (安全)
 */

import { useMemo } from "react";
import { useTranslations } from "next-intl";

interface Props {
  /** 是否为多头仓位 */
  isLong: boolean;
  /** 开仓价格 */
  entryPrice: number;
  /** 标记价格 */
  markPrice: number;
  /** 清算价格 */
  liquidationPrice: number;
  /** 是否显示文字标签 */
  showLabel?: boolean;
  /** 自定义高度 */
  height?: number;
}

/**
 * 计算风险百分比
 * - 100%: 完全安全（价格远离清算价）
 * - 0%: 即将清算（价格接近清算价）
 */
function calculateRiskPercent(
  isLong: boolean,
  entryPrice: number,
  markPrice: number,
  liquidationPrice: number
): number {
  if (liquidationPrice <= 0 || entryPrice <= 0) return 100;

  if (isLong) {
    // 多头: 清算价在开仓价下方
    // 风险距离 = (markPrice - liquidationPrice) / (entryPrice - liquidationPrice)
    const safeRange = entryPrice - liquidationPrice;
    if (safeRange <= 0) return 0;

    const currentDistance = markPrice - liquidationPrice;
    const percent = (currentDistance / safeRange) * 100;

    return Math.max(0, Math.min(100, percent));
  } else {
    // 空头: 清算价在开仓价上方
    // 风险距离 = (liquidationPrice - markPrice) / (liquidationPrice - entryPrice)
    const safeRange = liquidationPrice - entryPrice;
    if (safeRange <= 0) return 0;

    const currentDistance = liquidationPrice - markPrice;
    const percent = (currentDistance / safeRange) * 100;

    return Math.max(0, Math.min(100, percent));
  }
}

/**
 * 根据风险百分比获取颜色
 */
function getRiskColor(percent: number): { bg: string; text: string; label: string } {
  if (percent <= 50) {
    return {
      bg: "bg-red-500",
      text: "text-red-400",
      label: "danger",
    };
  } else if (percent <= 75) {
    return {
      bg: "bg-yellow-500",
      text: "text-yellow-400",
      label: "warning",
    };
  }
  return {
    bg: "bg-green-500",
    text: "text-green-400",
    label: "safe",
  };
}

export function RiskProgressBar({
  isLong,
  entryPrice,
  markPrice,
  liquidationPrice,
  showLabel = true,
  height = 4,
}: Props) {
  const t = useTranslations("perp");

  const riskPercent = useMemo(
    () => calculateRiskPercent(isLong, entryPrice, markPrice, liquidationPrice),
    [isLong, entryPrice, markPrice, liquidationPrice]
  );

  const colors = useMemo(() => getRiskColor(riskPercent), [riskPercent]);

  const statusLabel = useMemo(() => {
    if (colors.label === "danger") return t("danger");
    if (colors.label === "warning") return t("warning");
    return t("low");
  }, [colors.label, t]);

  return (
    <div className="w-full">
      {/* 进度条 */}
      <div
        className="w-full bg-gray-700 rounded-full overflow-hidden"
        style={{ height: `${height}px` }}
      >
        <div
          className={`h-full ${colors.bg} transition-all duration-300`}
          style={{ width: `${riskPercent}%` }}
        />
      </div>

      {/* 标签 */}
      {showLabel && (
        <div className="flex justify-between items-center mt-1">
          <span className={`text-xs ${colors.text}`}>
            {riskPercent.toFixed(0)}%
          </span>
          <span className={`text-xs ${colors.text}`}>
            ({statusLabel})
            {riskPercent <= 50 && (
              <svg className="w-3.5 h-3.5 ml-1 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 紧凑版风险进度条（用于表格）
 */
export function RiskProgressBarCompact({
  isLong,
  entryPrice,
  markPrice,
  liquidationPrice,
}: Omit<Props, "showLabel" | "height">) {
  const riskPercent = useMemo(
    () => calculateRiskPercent(isLong, entryPrice, markPrice, liquidationPrice),
    [isLong, entryPrice, markPrice, liquidationPrice]
  );

  const colors = useMemo(() => getRiskColor(riskPercent), [riskPercent]);

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${colors.bg} transition-all duration-300`}
          style={{ width: `${riskPercent}%` }}
        />
      </div>
      <span className={`text-xs font-medium min-w-[40px] text-right ${colors.text}`}>
        {riskPercent.toFixed(0)}%
      </span>
    </div>
  );
}

export default RiskProgressBar;
