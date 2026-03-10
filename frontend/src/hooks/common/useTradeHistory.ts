"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount } from "wagmi";
import { getWebSocketClient } from "@/lib/websocket";

/**
 * 现货交易记录 (用于 TokenFactory 代币交易)
 * 注意：与永续合约的 PerpTradeRecord 不同，这是现货交易专用类型
 */
export interface SpotTradeRecord {
  id: string;
  token: string;              // 代币地址
  trader: string;             // 交易者地址
  side: "buy" | "sell";       // 交易方向
  size: string;               // 代币数量
  value: string;              // ETH 金额
  price: string;              // 成交价格
  txHash: string;             // 交易哈希
  timestamp: number;          // 时间戳
}

// 向后兼容别名 (deprecated, 请使用 SpotTradeRecord)
/** @deprecated 使用 SpotTradeRecord 代替 */
export type TradeRecord = SpotTradeRecord;

interface UseTradeHistoryOptions {
  token?: string;             // 代币地址 (过滤特定代币)
  limit?: number;             // 最大记录数
}

/**
 * 现货交易历史 Hook (纯 WebSocket 实时推送)
 *
 * 功能：
 * 1. 订阅 WebSocket spot_trade 消息
 * 2. 实时接收新交易并更新列表
 * 3. 按时间倒序排列 (最新在前)
 *
 * @param options.token 过滤特定代币的交易
 * @param options.limit 保留的最大记录数 (默认 50)
 */
export function useTradeHistory(options: UseTradeHistoryOptions = {}) {
  const { token, limit = 50 } = options;
  const { address } = useAccount();
  const [trades, setTrades] = useState<SpotTradeRecord[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 用于防止重复订阅
  const subscribedRef = useRef(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // 转换后端消息格式到前端格式
  const formatTradeMessage = useCallback((message: Record<string, unknown>): SpotTradeRecord | null => {
    try {
      // 后端 spot_trade 消息格式:
      // { type: "spot_trade", token, trader, isBuy, ethAmount, tokenAmount, price, txHash, timestamp }
      const data = (message.data as Record<string, unknown> | undefined) ?? message;
      const s = (key1: string, key2: string, fallback = ""): string =>
        String(data[key1] ?? data[key2] ?? fallback);

      return {
        id: s("txHash", "tx_hash") || `${Date.now()}-${Math.random()}`,
        token: s("token", "token"),
        trader: s("trader", "trader"),
        side: (data.isBuy || data.is_buy) ? "buy" : "sell",
        size: s("tokenAmount", "token_amount", "0"),
        value: s("ethAmount", "eth_amount", "0"),
        price: s("price", "price", "0"),
        txHash: s("txHash", "tx_hash"),
        timestamp: Number(data.timestamp) || Date.now(),
      };
    } catch (err) {
      console.error("[useTradeHistory] Failed to format trade message:", err);
      return null;
    }
  }, []);

  // WebSocket 连接和订阅
  useEffect(() => {
    const ws = getWebSocketClient();

    const setupWebSocket = async () => {
      try {
        // 连接 WebSocket
        await ws.connect();
        setIsConnected(true);
        setError(null);

        // 订阅 spot_trade 消息
        // 如果指定了 token，只订阅该 token；否则订阅全局交易流
        const topics = token
          ? [`spot_trade:${token.toLowerCase()}`]
          : ["spot_trade"];

        await ws.subscribe(topics);
        subscribedRef.current = true;

      } catch (err) {
        console.error("[useTradeHistory] WebSocket setup failed:", err);
        setError(err instanceof Error ? err.message : "WebSocket connection failed");
        setIsConnected(false);
      }
    };

    setupWebSocket();

    // 监听 spot_trade 消息
    const handleMessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);

        // 只处理 spot_trade 消息
        if (message.type !== "spot_trade") return;

        // 如果指定了 token，过滤非目标 token 的交易
        const tradeToken = message.token || message.data?.token;
        if (tokenRef.current && tradeToken?.toLowerCase() !== tokenRef.current.toLowerCase()) {
          return;
        }

        // 如果指定了 address，只显示该用户的交易
        const tradeTrader = message.trader || message.data?.trader;
        // 注意：这里不过滤 trader，因为交易历史应该显示市场上所有交易
        // 如果需要只显示用户自己的交易，取消下面注释
        // if (address && tradeTrader?.toLowerCase() !== address.toLowerCase()) {
        //   return;
        // }

        const newTrade = formatTradeMessage(message);
        if (!newTrade) return;

        // 添加新交易到列表头部 (最新在前)
        setTrades(prev => {
          // 检查是否已存在 (防止重复)
          if (prev.some(t => t.txHash === newTrade.txHash)) {
            return prev;
          }

          // 添加到头部，保持最大 limit 条
          const updated = [newTrade, ...prev].slice(0, limit);
          return updated;
        });

        setError(null);
      } catch (err) {
        console.error("[useTradeHistory] Message parsing failed:", err);
      }
    };

    // 添加消息监听器
    const wsInstance = ws.getWebSocket();
    if (wsInstance) {
      wsInstance.addEventListener("message", handleMessage);
    }

    // 清理
    return () => {
      // 移除监听器
      const currentWs = ws.getWebSocket();
      if (currentWs) {
        currentWs.removeEventListener("message", handleMessage);
      }

      // 取消订阅
      if (subscribedRef.current) {
        const topics = token
          ? [`spot_trade:${token.toLowerCase()}`]
          : ["spot_trade"];

        ws.unsubscribe(topics).catch(() => {
          // 忽略取消订阅错误
        });
        subscribedRef.current = false;

      }
    };
  }, [token, limit, formatTradeMessage]);

  // 清空交易历史
  const clearTrades = useCallback(() => {
    setTrades([]);
  }, []);

  return {
    trades,
    isConnected,
    isLoading: false, // WebSocket 模式不需要 loading 状态
    error,
    clearTrades,
  };
}
