"use client";

/**
 * 清算热力图数据Hook
 */

import { useState, useEffect, useCallback } from "react";
import type { LiquidationHeatmapData, TimeRange } from "./types";
import { MATCHING_ENGINE_URL as API_BASE } from "@/config/api";

interface UseHeatmapDataResult {
  data: LiquidationHeatmapData | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useHeatmapData(
  token: string | undefined,
  timeRange: TimeRange = "1d",
  refreshInterval: number = 60000
): UseHeatmapDataResult {
  const [data, setData] = useState<LiquidationHeatmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE}/api/liquidation-map/${token}?timeRange=${timeRange}`
      );

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const json = await response.json();

      if (json.error) {
        throw new Error(json.error);
      }

      setData(json);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch heatmap data:", err);
      setError(err instanceof Error ? err.message : "Failed to load heatmap data");
    } finally {
      setLoading(false);
    }
  }, [token, timeRange]);

  // 初始加载
  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // 定时刷新
  useEffect(() => {
    if (!token || refreshInterval <= 0) return;

    const interval = setInterval(fetchData, refreshInterval);
    return () => clearInterval(interval);
  }, [token, refreshInterval, fetchData]);

  return {
    data,
    loading,
    error,
    refetch: fetchData,
  };
}
