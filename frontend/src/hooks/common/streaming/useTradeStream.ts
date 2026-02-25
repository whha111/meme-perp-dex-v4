"use client";

/**
 * @deprecated 此 hook 使用 System A (WebSocketClient) 的 useWebSocketMessage/useWebSocketConnection,
 * 但 trade 事件只通过 System B (WebSocketManager) 接收。subscribeInstrument() 是 no-op。
 * 除非 System A 被其他 hook (如 useWebSocketKlines) 连接，否则此 hook 不会收到任何数据。
 *
 * TODO: 迁移到 System B (tradingDataStore) 或统一 WebSocket 系统后重写。
 */

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getWebSocketServices,
  InstrumentTradeEvent as TradeEventData,
  MessageType,
  useWebSocketMessage,
  useWebSocketConnection,
} from "@/lib/websocket";

/**
 * Trade Event from WebSocket trade_event
 */
export interface TradeEvent {
  instId: string;  // 交易对ID，如 "MEME-BNB"
  txHash: string;
  tradeType: "BUY" | "SELL";
  traderAddress: string;
  tokenAmount: string;
  ethAmount: string;
  newPrice: string;
  timestamp: number;
  blockNumber: number;
}

/**
 * Hook return type
 */
export interface UseTradeStreamReturn {
  trades: TradeEvent[];
  latestTrade: TradeEvent | null;
  isConnected: boolean;
  isReconnecting: boolean;
  error: Error | null;
  reconnectCount: number;
  clearTrades: () => void;
}

/**
 * Configuration
 */
const MAX_TRADES_CACHE = 100; // Keep last 100 trades in memory

/**
 * Hook to stream real-time trade events via WebSocket
 * 
 * Features:
 * - Real-time trade updates via WebSocket
 * - Automatic reconnection with exponential backoff
 * - Integrates with React Query cache for data consistency
 * - Performance optimization to prevent over-rendering
 * 
 * @example
 * ```tsx
 * const { trades, latestTrade, isConnected } = useTradeStream({
 *   instIds: ["MEME-BNB"],
 *   enabled: true
 * });
 * ```
 */
export function useTradeStream(params?: {
  instIds?: string[];
  clientId?: string;
  enabled?: boolean;
  onTrade?: (trade: TradeEvent) => void;
}): UseTradeStreamReturn {
  const { instIds = [], clientId, enabled = true, onTrade } = params || {};
  
  const [trades, setTrades] = useState<TradeEvent[]>([]);
  const [latestTrade, setLatestTrade] = useState<TradeEvent | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const queryClient = useQueryClient();

  // [FIX F-H-04] Use refs to prevent unnecessary re-renders and memory leaks
  const isMountedRef = useRef(true);
  const pendingTradesRef = useRef<TradeEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  const onTradeRef = useRef(onTrade);
  // [FIX F-H-04] 使用 ref 存储 instIds，避免 callback 依赖变化导致内存泄漏
  const instIdsRef = useRef<string[]>(instIds);

  // Get WebSocket connection status
  const { status: connectionStatus, isConnected } = useWebSocketConnection();

  // Keep refs updated without causing re-renders
  useEffect(() => {
    onTradeRef.current = onTrade;
  }, [onTrade]);

  // [FIX F-H-04] 更新 instIds ref
  useEffect(() => {
    instIdsRef.current = instIds;
  }, [instIds]);

  // Batch state updates using requestAnimationFrame
  const flushPendingTrades = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      if (pendingTradesRef.current.length > 0 && isMountedRef.current) {
        const newTrades = pendingTradesRef.current;
        
        setTrades((prev) => {
          const combined = [...prev, ...newTrades];
          return combined.slice(-MAX_TRADES_CACHE);
        });

        // Update latest trade
        const latest = newTrades[newTrades.length - 1];
        if (latest) {
          setLatestTrade(latest);

          // Call onTrade callback
          newTrades.forEach(trade => {
            onTradeRef.current?.(trade);
          });

          // ✅ 只 invalidate tokenAsset，不 invalidate tradeHistory
          // tradeHistory 通过 realtimeTrades 实时显示，不需要重新请求
          // 之前 invalidate tradeHistory 会导致列表短暂清空
          queryClient.invalidateQueries({
            queryKey: ["tokenAsset", latest.instId],
          });
        }

        pendingTradesRef.current = [];
      }
    });
  }, [queryClient]);

  // Clear trades function
  const clearTrades = useCallback(() => {
    setTrades([]);
    setLatestTrade(null);
    pendingTradesRef.current = [];
  }, []);

  // [FIX F-H-04] Handle WebSocket trade events - 使用 ref 避免依赖变化
  const handleTradeEvent = useCallback((message: any) => {
    if (!message.data) return;

    const wsEvent = message.data as TradeEventData;

    // [FIX F-H-04] 使用 ref 获取最新的 instIds，避免 callback 重建
    const currentInstIds = instIdsRef.current;
    if (currentInstIds.length > 0 && !currentInstIds.includes(wsEvent.inst_id)) {
      return;
    }

    // Convert WebSocket event to TradeEvent format
    const tradeEvent: TradeEvent = {
      instId: wsEvent.inst_id,
      txHash: wsEvent.tx_hash,
      tradeType: wsEvent.trade_type,
      traderAddress: wsEvent.trader_address,
      tokenAmount: wsEvent.token_amount,
      ethAmount: wsEvent.eth_amount,
      newPrice: wsEvent.new_price,
      timestamp: wsEvent.timestamp,
      blockNumber: 0, // WebSocket events don't include block number
    };

    // Add to pending trades
    pendingTradesRef.current.push(tradeEvent);
    flushPendingTrades();
  }, [flushPendingTrades]); // [FIX F-H-04] 移除 instIds 依赖

  // Subscribe to trade events
  useWebSocketMessage(MessageType.TRADE_EVENT, handleTradeEvent);

  // Stabilize instIds to prevent unnecessary re-subscriptions
  const instIdsKey = useMemo(() => instIds.sort().join(','), [instIds]);
  const stableInstIds = useMemo(() => instIds, [instIdsKey]);

  // Subscribe to instrument topics when enabled
  useEffect(() => {
    if (!enabled || !isConnected || stableInstIds.length === 0) {
      return;
    }

    const wsServices = getWebSocketServices();

    // Subscribe to each instrument's trade topic
    const subscribePromises = stableInstIds.map(instId =>
      wsServices.subscribeInstrument(instId).catch(err => {
        console.warn(`Failed to subscribe to instrument ${instId}:`, err);
      })
    );

    Promise.all(subscribePromises).catch(err => {
      console.error("Failed to subscribe to trade topics:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
    });

    // Cleanup: unsubscribe from topics
    return () => {
      const unsubscribePromises = stableInstIds.map(instId =>
        wsServices.unsubscribeInstrument(instId).catch(err => {
          console.warn(`Failed to unsubscribe from instrument ${instId}:`, err);
        })
      );

      Promise.all(unsubscribePromises).catch(err => {
        console.error("Failed to unsubscribe from trade topics:", err);
      });
    };
  }, [enabled, isConnected, instIdsKey, stableInstIds]);

  // Component unmount cleanup
  useEffect(() => {
    isMountedRef.current = true;
    
    return () => {
      isMountedRef.current = false;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return {
    trades,
    latestTrade,
    isConnected,
    isReconnecting: connectionStatus === "reconnecting",
    error,
    reconnectCount: 0, // WebSocket client handles reconnection internally
    clearTrades,
  };
}

/**
 * Simplified hook for single instrument trade streaming
 */
export function useInstrumentTradeStream(
  instId: string | null,
  options?: {
    enabled?: boolean;
    onTrade?: (trade: TradeEvent) => void;
  }
) {
  const { enabled = true, onTrade } = options || {};

  // [FIX] Memoize instIds array to prevent infinite re-renders
  const instIds = useMemo(() => instId ? [instId] : [], [instId]);

  return useTradeStream({
    instIds,
    enabled: enabled && !!instId,
    onTrade,
  });
}