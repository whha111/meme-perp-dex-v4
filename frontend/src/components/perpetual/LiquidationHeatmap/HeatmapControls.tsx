"use client";

/**
 * 热力图时间范围控制器
 */

import { useTranslations } from "next-intl";
import type { TimeRange } from "./types";
import { TIME_RANGE_OPTIONS } from "./heatmapUtils";

interface Props {
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  onRefresh: () => void;
  isLoading?: boolean;
}

export function HeatmapControls({
  timeRange,
  onTimeRangeChange,
  onRefresh,
  isLoading = false,
}: Props) {
  const t = useTranslations("perp");

  return (
    <div className="flex items-center gap-1">
      {/* 时间范围选择器 */}
      <div className="flex bg-gray-800 rounded p-0.5">
        {TIME_RANGE_OPTIONS.map((option) => (
          <button
            key={option.key}
            onClick={() => onTimeRangeChange(option.key as TimeRange)}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              timeRange === option.key
                ? "bg-blue-600 text-white"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* 刷新按钮 */}
      <button
        onClick={onRefresh}
        disabled={isLoading}
        className={`p-1 rounded transition-colors ${
          isLoading
            ? "text-gray-600 cursor-not-allowed"
            : "text-gray-400 hover:text-white hover:bg-gray-800"
        }`}
        title={t("retry")}
      >
        <svg
          className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
      </button>
    </div>
  );
}
