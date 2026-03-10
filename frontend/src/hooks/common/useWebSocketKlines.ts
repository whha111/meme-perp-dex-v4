"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { getWebSocketClient } from "@/lib/websocket";
import { MATCHING_ENGINE_URL } from "@/config/api";

export interface Kline {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades?: number;
}

export type KlineInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/**
 * WebSocket K线数据 Hook
 *
 * 功能：
 * 1. 初始加载历史K线 (REST API)
 * 2. 实时订阅K线更新 (WebSocket)
 * 3. 自动合并和更新K线数据
 *
 * @param token 代币地址
 * @param interval K线周期 (目前后端仅支持1分钟，前端需要聚合其他周期)
 * @param limit 历史K线数量
 */
export function useWebSocketKlines(
  token?: string,
  interval: KlineInterval = "1m",
  limit: number = 100
) {
  const [klines, setKlines] = useState<Kline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 获取初始历史数据
  // ✅ 使用新的 spot kline API，从 Redis 获取包含真实交易的 K 线
  const fetchInitialData = useCallback(async () => {
    if (!token) {
      return;
    }

    try {
      setLoading(true);
      // 新 API: /api/v1/spot/klines/latest/{token}?resolution=1m&limit=100
      const url = `${MATCHING_ENGINE_URL}/api/v1/spot/klines/latest/${token.toLowerCase()}?resolution=${interval}&limit=${limit}`;
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`Failed to fetch klines: ${res.status}`);
      }

      const json = await res.json();

      if (!json.success || !json.data) {
        setKlines([]);
        setError(json.error || "No data");
        return;
      }

      // 新 API 返回格式: { success: true, data: [{ time, open, high, low, close, volume, trades }] }
      // 需要转换 time (秒) 为 timestamp (毫秒) 以保持兼容
      const formattedKlines: Kline[] = json.data.map((bar: {
        time: number;
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string;
        trades?: number;
      }) => ({
        timestamp: bar.time * 1000, // 秒 -> 毫秒
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        trades: bar.trades || 0,
      }));

      // 按时间正序排列
      formattedKlines.sort((a, b) => a.timestamp - b.timestamp);

      setKlines(formattedKlines);
      setError(null);
    } catch (e) {
      console.error("Failed to fetch initial klines:", e);
      setError(e instanceof Error ? e.message : "Unknown error");
      setKlines([]);
    } finally {
      setLoading(false);
    }
  }, [token, interval, limit]);

  // WebSocket 实时更新
  useEffect(() => {
    if (!token) {
      setKlines([]);
      setLoading(false);
      return;
    }

    // 1. 加载初始数据
    fetchInitialData();

    // 2. 订阅 WebSocket
    const ws = getWebSocketClient();

    // 连接并订阅
    const setupWebSocket = async () => {
      try {
        await ws.connect();

        // 订阅代币市场数据 (包含K线推送)
        await ws.subscribe([`kline:${token.toLowerCase()}`]);

        // subscribed
      } catch (err) {
        console.error("[useWebSocketKlines] WebSocket setup failed:", err);
      }
    };

    setupWebSocket();

    // 3. 监听 K线消息
    // ✅ 使用 onRawMessage 而非直接 addEventListener，确保重连后监听器仍有效
    const handleMessage = (event: MessageEvent) => {
      try {
        // Skip non-JSON heartbeat messages (e.g. "pong")
        if (typeof event.data === "string" && !event.data.startsWith("{")) return;
        const message = JSON.parse(event.data);

        // 只处理 K线消息
        if (message.type !== "kline") return;

        // 检查是否是当前订阅的代币
        if (message.data.token.toLowerCase() !== token.toLowerCase()) return;

        const newKline: Kline = {
          timestamp: message.data.timestamp,
          open: message.data.open,
          high: message.data.high,
          low: message.data.low,
          close: message.data.close,
          volume: message.data.volume,
          trades: message.data.trades,
        };

        // 减少日志噪音 - 仅在开发调试时启用
        // console.log(`[useWebSocketKlines] Received kline update:`, newKline);

        // 更新K线数组
        setKlines(prev => {
          // 查找是否已存在该时间戳的K线
          const existingIndex = prev.findIndex(k => k.timestamp === newKline.timestamp);

          if (existingIndex >= 0) {
            // 更新现有K线 (实时K线)
            const updated = [...prev];
            updated[existingIndex] = newKline;
            return updated;
          } else {
            // 添加新K线
            const updated = [...prev, newKline];
            // 按时间排序
            updated.sort((a, b) => a.timestamp - b.timestamp);
            // 保持最多 limit 个
            return updated.slice(-limit);
          }
        });

        setError(null);
      } catch (err) {
        console.error("[useWebSocketKlines] Message parsing failed:", err);
      }
    };

    // ✅ 使用 WebSocketClient 的 onRawMessage 方法注册监听器
    // 这确保了即使 WebSocket 重连，监听器也会继续工作
    const unsubscribeMessage = ws.onRawMessage(handleMessage);

    // 清理
    return () => {
      // 取消订阅
      ws.unsubscribe([`kline:${token.toLowerCase()}`]).catch(() => {
        // 忽略取消订阅错误
      });

      // ✅ 移除消息监听器
      unsubscribeMessage();

      // unsubscribed
    };
  }, [token, interval, limit, fetchInitialData]);

  // 格式化为图表数据 (lightweight-charts 格式)
  // ✅ 使用 useMemo 缓存，避免每次渲染都创建新数组导致消费者组件无限循环
  const chartData = useMemo(() => klines.map(k => ({
    time: k.timestamp / 1000, // 转换为秒
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    volume: Number(k.volume),
  })), [klines]);

  // 获取最新价格
  const latestPrice = useMemo(() => klines.length > 0
    ? Number(klines[klines.length - 1].close)
    : 0, [klines]);

  return {
    klines,
    chartData,
    latestPrice,
    loading,
    error,
    refresh: fetchInitialData, // 手动刷新
  };
}
