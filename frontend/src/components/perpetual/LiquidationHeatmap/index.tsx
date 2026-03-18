"use client";

/**
 * 清算热力图组件
 *
 * 参考 CoinGlass 设计，显示2D清算热力图
 * - X轴: 时间
 * - Y轴: 价格
 * - 颜色: 清算强度 (紫→蓝→绿→黄)
 */

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { LiquidationHeatmapCanvas } from "./LiquidationHeatmapCanvas";
import { HeatmapControls } from "./HeatmapControls";
import { HeatmapTooltip } from "./HeatmapTooltip";
import { useHeatmapData } from "./useHeatmapData";
import { formatUsdAmount } from "./heatmapUtils";
import type { TimeRange, HeatmapTooltipData } from "./types";

interface Props {
  token: string;
  apiUrl?: string;
}

export function LiquidationHeatmap({ token }: Props) {
  const t = useTranslations("perp");
  const [timeRange, setTimeRange] = useState<TimeRange>("1d");
  const [tooltipData, setTooltipData] = useState<HeatmapTooltipData | null>(null);

  const { data, loading, error, refetch } = useHeatmapData(token, timeRange, 5000);

  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    setTimeRange(range);
  }, []);

  const handleHover = useCallback((data: HeatmapTooltipData | null) => {
    setTooltipData(data);
  }, []);

  if (loading && !data) {
    return (
      <div className="bg-gray-900 rounded-lg p-3">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-sm font-bold text-okx-text-primary">{t("liquidationMap")}</h3>
        </div>
        <div className="animate-pulse">
          <div className="h-[200px] bg-gray-800 rounded" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-gray-900 rounded-lg p-3">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-sm font-bold text-okx-text-primary">{t("liquidationMap")}</h3>
        </div>
        <div className="text-center text-red-400 py-4 text-xs">
          <p>{error}</p>
          <button
            onClick={refetch}
            className="mt-2 px-3 py-1 bg-red-900/30 text-red-400 rounded hover:bg-red-900/50 text-xs"
          >
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 rounded-lg p-3">
      {/* 头部 */}
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-bold text-okx-text-primary">{t("liquidationMap")}</h3>
        <HeatmapControls
          timeRange={timeRange}
          onTimeRangeChange={handleTimeRangeChange}
          onRefresh={refetch}
          isLoading={loading}
        />
      </div>

      {/* 热力图 */}
      {data && (
        <div className="relative">
          <LiquidationHeatmapCanvas
            data={data}
            width={390}
            height={200}
            onHover={handleHover}
          />

          {/* 悬停提示 */}
          <HeatmapTooltip data={tooltipData} visible={!!tooltipData} />
        </div>
      )}

      {/* 图例和统计 - 更紧凑 */}
      <div className="mt-2 pt-2 border-t border-gray-700">
        {/* 颜色图例 */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <span className="text-xs text-gray-400">{t("low") || "Low"}</span>
          <div
            className="w-24 h-2 rounded"
            style={{
              background: "linear-gradient(to right, #581c87, #5b21b6, #2563eb, #10b981, #facc15, #fde047)",
            }}
          />
          <span className="text-xs text-gray-400">{t("high") || "High"}</span>
        </div>

        {/* 多空统计 - 紧凑版 */}
        {data && (
          <div className="flex justify-center gap-4 text-xs">
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 bg-red-500 rounded-full" />
              <span className="text-red-400 font-medium">
                {formatUsdAmount(data.longTotal)}
              </span>
              <span className="text-gray-500 text-xs">({data.longAccountTotal})</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 bg-green-500 rounded-full" />
              <span className="text-green-400 font-medium">
                {formatUsdAmount(data.shortTotal)}
              </span>
              <span className="text-gray-500 text-xs">({data.shortAccountTotal})</span>
            </div>
          </div>
        )}
      </div>

      {/* 空数据提示 */}
      {data && data.heatmap.every(cell => cell.intensity === 0) && (
        <div className="text-center text-gray-500 py-2 text-xs">
          <p>{t("noPositionsToLiquidate")}</p>
        </div>
      )}
    </div>
  );
}

export default LiquidationHeatmap;
