"use client";

/**
 * useOnChainTrades - 现货交易数据 Hook
 *
 * 功能：
 * - 从后端 API 获取历史交易数据
 * - 通过 WebSocket 接收实时交易更新
 * - 自动合并历史和实时数据
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { getWebSocketClient } from "@/lib/websocket";

export interface OnChainTrade {
  tokenAddress: string;
  trader: string;
  isBuy: boolean;
  ethAmount: bigint;
  tokenAmount: bigint;
  virtualEth: bigint;
  virtualToken: bigint;
  timestamp: number;
  blockNumber: bigint;
  transactionHash: string;
  price: number;
}

export interface KlineBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface UseOnChainTradesReturn {
  trades: OnChainTrade[];
  klines: KlineBar[];
  isLoading: boolean;
  error: Error | null;
  latestPrice: number | null;
  refetch: () => Promise<void>;
}

interface SpotTradeFromAPI {
  id: string;
  token: string;
  trader: string;
  isBuy: boolean;
  ethAmount: string;
  tokenAmount: string;
  virtualEth: string;
  virtualToken: string;
  price: string;
  priceUsd: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

/**
 * useOnChainTrades - 获取现货交易历史和实时更新
 */
export function useOnChainTrades(
  tokenAddress: string | null,
  options?: {
    enabled?: boolean;
    resolutionSeconds?: number;
    fromBlock?: bigint;
    maxBlocks?: bigint;
  }
): UseOnChainTradesReturn {
  const { enabled = true } = options || {};

  const [trades, setTrades] = useState<OnChainTrade[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // 从后端获取历史交易
  const fetchTrades = useCallback(async () => {
    if (!tokenAddress || !enabled) return;

    setIsLoading(true);
    setError(null);

    try {
      const url = `${MATCHING_ENGINE_URL}/api/v1/spot/trades/${tokenAddress.toLowerCase()}?limit=100`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch trades: ${response.status}`);
      }

      const json = await response.json();

      if (!json.success) {
        throw new Error(json.error || "Failed to fetch trades");
      }

      // 转换 API 响应为 OnChainTrade 格式
      const apiTrades: OnChainTrade[] = (json.data || []).map((t: SpotTradeFromAPI) => ({
        tokenAddress: t.token,
        trader: t.trader,
        isBuy: t.isBuy,
        ethAmount: BigInt(t.ethAmount || "0"),
        tokenAmount: BigInt(t.tokenAmount || "0"),
        virtualEth: BigInt(t.virtualEth || "0"),
        virtualToken: BigInt(t.virtualToken || "0"),
        timestamp: t.timestamp,
        blockNumber: BigInt(t.blockNumber || 0),
        transactionHash: t.txHash,
        price: parseFloat(t.price || "0"),
      }));

      setTrades(apiTrades);
    } catch (e) {
      console.error("[useOnChainTrades] Failed to fetch trades:", e);
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, [tokenAddress, enabled]);

  // 初始加载
  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  // 订阅 WebSocket 实时更新
  useEffect(() => {
    if (!tokenAddress || !enabled) return;

    const ws = getWebSocketClient();
    const normalizedToken = tokenAddress.toLowerCase();

    // 连接并订阅
    const setupWebSocket = async () => {
      try {
        await ws.connect();
        await ws.subscribe([normalizedToken]);
      } catch (e) {
        console.error("[useOnChainTrades] WebSocket setup failed:", e);
      }
    };

    setupWebSocket();

    // 监听实时交易消息
    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);

        // 处理 spot_trade 消息
        if (message.type !== "spot_trade") return;

        const tradeToken = (message.token || message.data?.token || "").toLowerCase();
        if (tradeToken !== normalizedToken) return;

        // 构建新交易
        const newTrade: OnChainTrade = {
          tokenAddress: message.token,
          trader: message.trader,
          isBuy: message.isBuy,
          ethAmount: BigInt(message.ethAmount || "0"),
          tokenAmount: BigInt(message.tokenAmount || "0"),
          virtualEth: BigInt("0"),
          virtualToken: BigInt("0"),
          timestamp: message.timestamp || Date.now(),
          blockNumber: BigInt(0),
          transactionHash: message.txHash || "",
          price: parseFloat(message.price || "0"),
        };

        // 添加到列表顶部 (最新在前)
        setTrades((prev) => {
          // 检查是否已存在
          if (prev.some((t) => t.transactionHash === newTrade.transactionHash)) {
            return prev;
          }
          // 添加新交易，保持最多 100 条
          return [newTrade, ...prev].slice(0, 100);
        });
      } catch (e) {
        // 忽略解析错误
      }
    };

    // 使用原始消息处理器
    const unsubscribe = ws.onRawMessage(handleMessage);

    return () => {
      unsubscribe();
      ws.unsubscribe([normalizedToken]).catch((err) => console.warn("[OnChainTrades] Unsubscribe error:", err));
    };
  }, [tokenAddress, enabled]);

  // 计算最新价格
  const latestPrice = useMemo(() => {
    if (trades.length === 0) return null;
    return trades[0].price;
  }, [trades]);

  // 空 K 线 (由 useWebSocketKlines 处理)
  const klines = useMemo(() => [] as KlineBar[], []);

  return {
    trades,
    klines,
    isLoading,
    error,
    latestPrice,
    refetch: fetchTrades,
  };
}

/**
 * useOnChainTradeStream - 实时交易流 Hook
 */
export function useOnChainTradeStream(
  tokenAddress: string | null,
  options?: {
    enabled?: boolean;
    onTrade?: (trade: OnChainTrade) => void;
  }
) {
  const { enabled = true, onTrade } = options || {};
  const [latestTrade, setLatestTrade] = useState<OnChainTrade | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!tokenAddress || !enabled) return;

    const ws = getWebSocketClient();
    const normalizedToken = tokenAddress.toLowerCase();

    const setupWebSocket = async () => {
      try {
        await ws.connect();
        await ws.subscribe([normalizedToken]);
        setIsConnected(true);
      } catch (e) {
        console.error("[useOnChainTradeStream] WebSocket setup failed:", e);
        setIsConnected(false);
      }
    };

    setupWebSocket();

    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type !== "spot_trade") return;

        const tradeToken = (message.token || "").toLowerCase();
        if (tradeToken !== normalizedToken) return;

        const trade: OnChainTrade = {
          tokenAddress: message.token,
          trader: message.trader,
          isBuy: message.isBuy,
          ethAmount: BigInt(message.ethAmount || "0"),
          tokenAmount: BigInt(message.tokenAmount || "0"),
          virtualEth: BigInt("0"),
          virtualToken: BigInt("0"),
          timestamp: message.timestamp || Date.now(),
          blockNumber: BigInt(0),
          transactionHash: message.txHash || "",
          price: parseFloat(message.price || "0"),
        };

        setLatestTrade(trade);
        onTrade?.(trade);
      } catch (e) {
        // 忽略
      }
    };

    const unsubscribe = ws.onRawMessage(handleMessage);

    // 监听连接状态
    const unsubscribeConnection = ws.onConnectionChange((status) => {
      setIsConnected(status === "connected");
    });

    return () => {
      unsubscribe();
      unsubscribeConnection();
      ws.unsubscribe([normalizedToken]).catch((err) => console.warn("[OnChainTrades] Unsubscribe error:", err));
    };
  }, [tokenAddress, enabled, onTrade]);

  return {
    latestTrade,
    isConnected,
  };
}
