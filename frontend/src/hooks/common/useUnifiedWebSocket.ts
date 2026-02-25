"use client";

/**
 * 统一 WebSocket Hook
 *
 * 合并所有 WebSocket 订阅，单一连接处理所有消息类型：
 * - orderbook: 订单簿实时更新
 * - trade: 最新成交
 * - candle: K线实时推送
 * - position_risks: 仓位风险数据
 * - risk_data: 全局风控数据
 * - mark_price: 标记价格
 * - balance: 余额变化
 * - risk_alert: 风险预警
 *
 * 优点：
 * - 单一连接，减少资源消耗
 * - 统一的心跳和重连逻辑
 * - 所有数据写入统一的 Store
 */

import { useEffect, useCallback, useRef } from "react";
import { type Address } from "viem";
import {
  useTradingDataStore,
  type OrderBookData,
  type TradeData,
  type PairedPosition,
  type OrderInfo,
  type TokenStats,
  type FundingRateInfo,
  type InsuranceFundInfo,
  type RiskAlert,
  type UserBalance,
} from "@/lib/stores/tradingDataStore";

import { WS_URL } from "@/config/api";

// ============================================================
// Configuration
// ============================================================

const getWsUrl = (): string => WS_URL;

// Reconnection config
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;

// Heartbeat config
const PING_INTERVAL = 30000; // 30 seconds
const PONG_TIMEOUT = 60000; // 60 seconds without pong = reconnect

// ============================================================
// Types
// ============================================================

interface WSMessage {
  type: string;
  token?: Address;
  trader?: Address;
  data?: unknown;
  [key: string]: unknown;
}

interface UseUnifiedWebSocketOptions {
  token?: Address;
  trader?: Address;
  enabled?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: string) => void;
}

interface UseUnifiedWebSocketReturn {
  isConnected: boolean;
  reconnect: () => void;
  subscribe: (token: Address) => void;
  unsubscribe: (token: Address) => void;
  subscribeRisk: (trader: Address) => void;
  unsubscribeRisk: (trader: Address) => void;
}

// ============================================================
// Singleton WebSocket Manager
// ============================================================

class WebSocketManager {
  private static instance: WebSocketManager | null = null;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastPong: number = Date.now();
  private isConnecting = false;
  private subscribedTokens: Set<Address> = new Set();
  private subscribedTraders: Set<Address> = new Set();
  private listeners: Set<(connected: boolean) => void> = new Set();

  static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    const wsUrl = getWsUrl();
    // connecting

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        // connected
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.lastPong = Date.now();

        // Update store
        useTradingDataStore.getState().setWsConnected(true);
        useTradingDataStore.getState().setWsError(null);

        // Notify listeners
        this.listeners.forEach((listener) => listener(true));

        // Start heartbeat
        this.startPing();

        // Resubscribe to all tokens and traders
        this.resubscribeAll();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = () => {
        // disconnected
        this.isConnecting = false;
        this.stopPing();

        // Update store
        useTradingDataStore.getState().setWsConnected(false);

        // Notify listeners
        this.listeners.forEach((listener) => listener(false));

        // Attempt reconnection
        this.attemptReconnect();
      };

      this.ws.onerror = () => {
        console.warn("[UnifiedWS] Connection error");
        this.isConnecting = false;
        useTradingDataStore.getState().setWsError("WebSocket connection error");
      };
    } catch (error) {
      console.error("[UnifiedWS] Failed to create WebSocket:", error);
      this.isConnecting = false;
      useTradingDataStore
        .getState()
        .setWsError("Failed to create WebSocket connection");
    }
  }

  disconnect(): void {
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedTokens.clear();
    this.subscribedTraders.clear();
    useTradingDataStore.getState().setWsConnected(false);
  }

  private handleMessage(data: string): void {
    // Handle simple pong response
    if (data === "pong" || data === '"pong"') {
      this.lastPong = Date.now();
      return;
    }

    try {
      const msg = JSON.parse(data) as WSMessage;
      const store = useTradingDataStore.getState();

      switch (msg.type) {
        case "orderbook":
          if (msg.token && msg.data) {
            const obData = msg.data as OrderBookData;
            store.setOrderBook(msg.token, obData);
          }
          break;

        case "trade":
          if (msg.token && msg.data) {
            const trade = msg.data as TradeData;
            store.addRecentTrade(msg.token, trade);
          }
          break;

        case "kline":
          // K线数据更新 - 由 useWebSocketKlines 单独处理
          // 这里可以发出事件供图表组件使用
          break;

        case "position_risks":
          if (msg.positions) {
            const positions = msg.positions as PairedPosition[];
            store.setPositions(positions);
          }
          break;

        case "orders":
          if (msg.orders) {
            const orders = msg.orders as OrderInfo[];
            store.setPendingOrders(
              orders.filter(
                (o) => o.status === "PENDING" || o.status === "PARTIALLY_FILLED"
              )
            );
          }
          break;

        case "order_update":
          if (msg.order) {
            const order = msg.order as OrderInfo;
            if (
              order.status === "PENDING" ||
              order.status === "PARTIALLY_FILLED"
            ) {
              store.updatePendingOrder(order.id, order);
            } else {
              store.removePendingOrder(order.id);
            }
          }
          break;

        case "balance":
          if (msg.balance) {
            const balance = msg.balance as {
              available: string;
              locked: string;
              unrealizedPnL?: string;
            };
            store.setBalance({
              available: BigInt(balance.available || "0"),
              locked: BigInt(balance.locked || "0"),
              unrealizedPnL: BigInt(balance.unrealizedPnL || "0"),
              equity:
                BigInt(balance.available || "0") +
                BigInt(balance.locked || "0") +
                BigInt(balance.unrealizedPnL || "0"),
            });
          }
          break;

        case "market_data":
          // 市场数据推送 - 包含价格、涨跌幅、24h统计等
          if (msg.token && msg.data) {
            const data = msg.data as {
              lastPrice?: string;
              price?: string;
              priceChange24h?: string;
              priceChangePercent24h?: string;
              high24h?: string;
              low24h?: string;
              volume24h?: string;
              trades24h?: number;
              openInterest?: string;
            };
            store.setTokenStats(msg.token, {
              lastPrice: data.lastPrice || data.price || "0",
              priceChange24h: data.priceChange24h || "0",
              priceChangePercent24h: data.priceChangePercent24h || "0",
              high24h: data.high24h || "0",
              low24h: data.low24h || "0",
              volume24h: data.volume24h || "0",
              trades24h: data.trades24h || 0,
              openInterest: data.openInterest || "0",
            });
          }
          break;

        case "funding_rate":
          if (msg.token) {
            store.setFundingRate(msg.token, {
              rate: String(msg.rate || "0"),
              nextFundingTime: Number(msg.nextFundingTime || Date.now() + 3600000),
              interval: String(msg.interval || "1h"),
              predictedRate: msg.predictedRate
                ? String(msg.predictedRate)
                : undefined,
            });
          }
          break;

        case "risk_data":
          if (msg.insuranceFund) {
            store.setInsuranceFund(msg.insuranceFund as InsuranceFundInfo);
          }
          if (msg.fundingRates) {
            const rates = msg.fundingRates as Array<FundingRateInfo & { token: Address }>;
            rates.forEach((rate) => {
              if (rate.token) {
                store.setFundingRate(rate.token, rate);
              }
            });
          }
          break;

        case "risk_alert":
          store.addRiskAlert({
            type: msg.alertType as RiskAlert["type"],
            severity: msg.severity as RiskAlert["severity"],
            pairId: msg.pairId as string | undefined,
            message: String(msg.message || ""),
            timestamp: Number(msg.timestamp || Date.now()),
          });
          break;

        case "liquidation":
          store.addRiskAlert({
            type: "liquidation_warning",
            severity: "danger",
            pairId: msg.pairId as string | undefined,
            message: `Position ${String(msg.pairId || "").slice(0, 8)} was liquidated`,
            timestamp: Date.now(),
          });
          break;

        case "liquidation_map":
          // Handled separately by specific components
          break;

        default:
          // Unknown message type
          break;
      }
    } catch (error) {
      console.error("[UnifiedWS] Failed to parse message:", error);
    }
  }

  private startPing(): void {
    this.stopPing();

    this.pingInterval = setInterval(() => {
      // Check for pong timeout
      if (Date.now() - this.lastPong > PONG_TIMEOUT) {
        console.warn("[UnifiedWS] Heartbeat timeout, reconnecting...");
        this.ws?.close();
        return;
      }

      // Send ping
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
      }
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("[UnifiedWS] Max reconnect attempts reached");
      useTradingDataStore
        .getState()
        .setWsError("Failed to connect after multiple attempts");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private resubscribeAll(): void {
    // Resubscribe to tokens
    this.subscribedTokens.forEach((token) => {
      this.sendSubscribe(token);
    });

    // Resubscribe to traders
    this.subscribedTraders.forEach((trader) => {
      this.sendSubscribeRisk(trader);
    });

    // Subscribe to global risk data
    this.sendGlobalRiskSubscribe();
  }

  private send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendSubscribe(token: Address): void {
    this.send({
      type: "subscribe",
      channel: "orderbook",
      token,
    });
    this.send({
      type: "subscribe",
      channel: "trades",
      token,
    });
  }

  private sendUnsubscribe(token: Address): void {
    this.send({
      type: "unsubscribe",
      channel: "orderbook",
      token,
    });
    this.send({
      type: "unsubscribe",
      channel: "trades",
      token,
    });
  }

  private sendSubscribeRisk(trader: Address): void {
    this.send({
      type: "subscribe_risk",
      trader,
    });
  }

  private sendUnsubscribeRisk(trader: Address): void {
    this.send({
      type: "unsubscribe_risk",
      trader,
    });
  }

  private sendGlobalRiskSubscribe(): void {
    this.send({
      type: "subscribe_global_risk",
    });
  }

  subscribe(token: Address): void {
    const normalizedToken = token.toLowerCase() as Address;
    if (!this.subscribedTokens.has(normalizedToken)) {
      this.subscribedTokens.add(normalizedToken);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendSubscribe(normalizedToken);
      }
    }
  }

  /**
   * 批量订阅多个 token（用于首页一次性订阅所有 token）
   */
  subscribeAll(tokens: Address[]): void {
    for (const token of tokens) {
      this.subscribe(token);
    }
  }

  unsubscribe(token: Address): void {
    const normalizedToken = token.toLowerCase() as Address;
    if (this.subscribedTokens.has(normalizedToken)) {
      this.subscribedTokens.delete(normalizedToken);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendUnsubscribe(normalizedToken);
      }
    }
  }

  subscribeRisk(trader: Address): void {
    const normalizedTrader = trader.toLowerCase() as Address;
    if (!this.subscribedTraders.has(normalizedTrader)) {
      this.subscribedTraders.add(normalizedTrader);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendSubscribeRisk(normalizedTrader);
      }
    }
  }

  unsubscribeRisk(trader: Address): void {
    const normalizedTrader = trader.toLowerCase() as Address;
    if (this.subscribedTraders.has(normalizedTrader)) {
      this.subscribedTraders.delete(normalizedTrader);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendUnsubscribeRisk(normalizedTrader);
      }
    }
  }

  addListener(listener: (connected: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  forceReconnect(): void {
    this.reconnectAttempts = 0;
    this.disconnect();
    this.connect();
  }
}

// ============================================================
// Global accessor (for non-hook contexts like MarketOverview)
// ============================================================

/**
 * 获取 WebSocketManager 单例（非 hook，可在任意上下文调用）
 * 注意：如果 WebSocket 尚未初始化，返回 null
 */
export function getWebSocketManager(): WebSocketManager | null {
  return WebSocketManager.getInstance();
}

// ============================================================
// Hook
// ============================================================

export function useUnifiedWebSocket(
  options: UseUnifiedWebSocketOptions = {}
): UseUnifiedWebSocketReturn {
  const {
    token,
    trader,
    enabled = true,
    onConnect,
    onDisconnect,
    onError,
  } = options;

  const managerRef = useRef<WebSocketManager | null>(null);
  const isConnected = useTradingDataStore((state) => state.wsConnected);

  // Stable refs for callbacks — prevents infinite re-render loop
  // (function refs change every render; useRef keeps a stable container)
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;
  onErrorRef.current = onError;

  // Initialize manager
  useEffect(() => {
    if (!enabled) return;

    managerRef.current = WebSocketManager.getInstance();
    managerRef.current.connect();

    // Listen for connection changes
    const removeListener = managerRef.current.addListener((connected) => {
      if (connected) {
        onConnectRef.current?.();
      } else {
        onDisconnectRef.current?.();
      }
    });

    return () => {
      removeListener();
    };
  }, [enabled]);

  // Subscribe to token when it changes
  useEffect(() => {
    if (!enabled || !token || !managerRef.current) return;

    const normalizedToken = token.toLowerCase() as Address;
    useTradingDataStore.getState().setCurrentToken(normalizedToken);
    managerRef.current.subscribe(normalizedToken);

    return () => {
      managerRef.current?.unsubscribe(normalizedToken);
    };
  }, [enabled, token]);

  // Subscribe to trader when it changes
  useEffect(() => {
    if (!enabled || !trader || !managerRef.current) return;

    const normalizedTrader = trader.toLowerCase() as Address;
    useTradingDataStore.getState().setCurrentTrader(normalizedTrader);
    managerRef.current.subscribeRisk(normalizedTrader);

    return () => {
      managerRef.current?.unsubscribeRisk(normalizedTrader);
    };
  }, [enabled, trader]);

  // Handle errors
  const wsError = useTradingDataStore((state) => state.wsError);
  useEffect(() => {
    if (wsError) {
      onErrorRef.current?.(wsError);
    }
  }, [wsError]);

  // Actions
  const reconnect = useCallback(() => {
    managerRef.current?.forceReconnect();
  }, []);

  const subscribe = useCallback((tokenAddr: Address) => {
    managerRef.current?.subscribe(tokenAddr);
  }, []);

  const unsubscribe = useCallback((tokenAddr: Address) => {
    managerRef.current?.unsubscribe(tokenAddr);
  }, []);

  const subscribeRisk = useCallback((traderAddr: Address) => {
    managerRef.current?.subscribeRisk(traderAddr);
  }, []);

  const unsubscribeRisk = useCallback((traderAddr: Address) => {
    managerRef.current?.unsubscribeRisk(traderAddr);
  }, []);

  return {
    isConnected,
    reconnect,
    subscribe,
    unsubscribe,
    subscribeRisk,
    unsubscribeRisk,
  };
}

export default useUnifiedWebSocket;
