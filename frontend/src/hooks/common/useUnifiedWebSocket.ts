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
  type WssOnChainToken,
} from "@/lib/stores/tradingDataStore";

import { WS_URL } from "@/config/api";

// ============================================================
// Configuration
// ============================================================

const getWsUrl = (): string => WS_URL;

// Reconnection config
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
// AUDIT-FIX M-10: 增加重连上限并在达到上限后定期重试（不再永久放弃）
const MAX_RECONNECT_ATTEMPTS = 30;

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
  private longRetryTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastPong: number = Date.now();
  private isConnecting = false;
  private shouldReconnect = false;
  private subscribedTokens: Set<Address> = new Set();
  private subscribedTraders: Set<Address> = new Set();
  private listeners: Set<(connected: boolean) => void> = new Set();

  // Auth state for trader-specific WS subscriptions
  private authenticatedTrader: Address | null = null;
  private pendingAuthSignFn: ((msg: string) => Promise<string>) | null = null;
  private pendingAuthTrader: Address | null = null;

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

    this.shouldReconnect = true;
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

        // Request full token list via WSS (replaces 400+ RPC calls)
        this.send({ type: "get_all_tokens" });

        // Request all token info via WSS (no HTTP needed)
        this.send({ type: "get_all_token_info" });

        // Subscribe to all_market_stats for homepage volume/traders data
        this.send({ type: "subscribe_all_market_stats" });

        // Subscribe to curated meme perp markets and oracle status
        this.send({ type: "subscribe_markets" });

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
        if (this.shouldReconnect) {
          this.attemptReconnect();
        }
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
    this.shouldReconnect = false;
    this.isConnecting = false;
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.longRetryTimeout) {
      clearTimeout(this.longRetryTimeout);
      this.longRetryTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedTokens.clear();
    this.subscribedTraders.clear();
    this.reconnectAttempts = 0;
    useTradingDataStore.getState().setWsConnected(false);
    useTradingDataStore.getState().setWsError(null);
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
        // ── Auth ──────────────────────────────────────────────
        case "auth_success":
          // After auth, the server has already subscribed this socket to trader updates.
          if (this.pendingAuthTrader) {
            this.authenticatedTrader = this.pendingAuthTrader;
            // P1-4: 重连后主动拉取最新状态 — 参考 Drift DriftClient 订阅模型
            // 确保断线期间的仓位/余额/挂单变化不丢失
            this.send({ type: "get_positions", trader: this.pendingAuthTrader });
            this.send({ type: "get_balance", trader: this.pendingAuthTrader });
            this.send({ type: "get_pending_orders", trader: this.pendingAuthTrader });
          }
          break;

        // ── Order Book ────────────────────────────────────────
        case "orderbook":
          if (msg.token && msg.data) {
            const obData = msg.data as OrderBookData;
            store.setOrderBook(msg.token, obData);
          }
          break;

        // ── Trade ─────────────────────────────────────────────
        case "trade":
          if (msg.token && msg.data) {
            const trade = msg.data as TradeData;
            store.addRecentTrade(msg.token, trade);
          }
          break;

        // ── K-line ────────────────────────────────────────────
        case "kline":
          break;

        // ── Position (private update after auth) ──────────────
        case "position": {
          const posData = msg.data;
          if (posData && typeof posData === "object") {
            // Single position object from broadcastPosition
            const pos = posData as PairedPosition;
            if (pos.pairId) {
              store.updatePosition(pos.pairId, pos);
            }
          }
          if (Array.isArray(msg.data)) {
            // Array from get_positions response
            store.setPositions(msg.data as PairedPosition[]);
          }
          break;
        }

        // ── Position closed ───────────────────────────────────
        case "position_closed": {
          const closedPos = (msg.data ?? msg) as { pairId?: string; id?: string };
          const closedId = closedPos.pairId || closedPos.id;
          if (closedId) {
            store.removePosition(closedId);
          }
          break;
        }

        // ── Legacy position_risks (keep for backward compat) ──
        case "position_risks":
          if (msg.positions) {
            store.setPositions(msg.positions as PairedPosition[]);
          }
          break;

        // ── Orders (private update after auth) ────────────────
        case "orders":
          if (msg.orders && Array.isArray(msg.orders)) {
            // Batch: full pending orders list
            const orders = msg.orders as OrderInfo[];
            store.setPendingOrders(
              orders.filter(
                (o) => o.status === "PENDING" || o.status === "PARTIALLY_FILLED"
                    || o.status === "0" || o.status === "1"
              )
            );
          } else if (msg.order) {
            // Single order update
            const order = msg.order as OrderInfo;
            if (
              order.status === "PENDING" || order.status === "PARTIALLY_FILLED"
              || order.status === "0" || order.status === "1"
            ) {
              store.updatePendingOrder(order.id, order);
            } else {
              store.removePendingOrder(order.id);
            }
          }
          break;

        // ── Balance (private update after auth) ───────────────
        case "balance": {
          // Server format: { data: { trader, totalBalance, availableBalance, usedMargin, unrealizedPnL, equity } }
          // OR legacy: { balance: { available, locked, unrealizedPnL } }
          const balData = (msg.data ?? msg.balance) as Record<string, string> | undefined;
          if (balData) {
            const available = BigInt(balData.availableBalance || balData.available || "0");
            const locked = BigInt(balData.usedMargin || balData.locked || "0");
            const unrealizedPnL = BigInt(balData.unrealizedPnL || "0");
            const equity = BigInt(balData.equity || "0") || (available + locked + unrealizedPnL);
            // ★ FIX: use walletBalance field (派生钱包余额), NOT totalBalance (含仓位保证金)
            const walletBalance = BigInt(balData.walletBalance || "0");
            store.setBalance({
              available,
              locked,
              unrealizedPnL,
              equity,
              walletBalance,
            });
          }
          break;
        }

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

        case "all_tokens":
          // 完整代币列表 (替代 useOnChainTokenList 的 400+ RPC 调用)
          if (msg.data && Array.isArray(msg.data)) {
            store.setAllTokens(msg.data as WssOnChainToken[]);
          }
          break;

        case "all_token_info":
          if (msg.data && typeof msg.data === "object") {
            store.setTokenInfoMap(msg.data as Record<string, { name: string; symbol: string }>);
          }
          break;

        case "all_market_stats":
          // 首页全量市场统计 — batch update (single store write, avoids 100+ re-renders)
          if (msg.data && typeof msg.data === "object") {
            const statsMap = msg.data as Record<string, {
              lastPrice?: string;
              volume24h?: string;
              trades24h?: number;
              priceChangePercent24h?: string;
              high24h?: string;
              low24h?: string;
              openInterest?: string;
            }>;
            const entries = Object.entries(statsMap).map(([token, data]) => ({
              token: token as Address,
              stats: {
                lastPrice: data.lastPrice || "0",
                priceChange24h: "0",
                priceChangePercent24h: data.priceChangePercent24h || "0",
                high24h: data.high24h || "0",
                low24h: data.low24h || "0",
                volume24h: data.volume24h || "0",
                trades24h: data.trades24h || 0,
                openInterest: data.openInterest || "0",
              },
            }));
            store.setTokenStatsBatch(entries);
          }
          break;

        case "markets":
        case "prices":
        case "oracle_status":
          // The curated meme markets page uses REST for initial render; recognizing
          // these WS frames keeps market/oracle streaming quiet until store wiring lands.
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

        case "risk":
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
        case "liquidation_warning":
          store.addRiskAlert({
            type: "liquidation_warning",
            severity: "danger",
            pairId: msg.pairId as string | undefined,
            message: `Position ${String(msg.pairId || "").slice(0, 8)} was liquidated`,
            timestamp: Date.now(),
          });
          // 强平后立即移除仓位（不依赖 position_risks 消息）
          if (msg.pairId) {
            store.removePosition(msg.pairId as string);
          }
          break;

        // ── ADL Warning (经济模型 V2) ──────────────────────
        case "adl_warning": {
          const adlData = msg.data as { token?: string; level?: string; adlAmount?: string; message?: string } | undefined;
          const level = adlData?.level || msg.level as string || "WARNING";
          const adlMsg = adlData?.message || msg.message as string || "ADL warning";
          store.addRiskAlert({
            type: level === "FORCE_CLOSE" ? "liquidation_warning" : "margin_warning",
            severity: level === "FORCE_CLOSE" ? "danger" : "warning",
            message: adlMsg,
            timestamp: Date.now(),
          });
          break;
        }

        case "liquidation_map":
          // Handled separately by specific components
          break;

        // H-3: Handle referral commission events from targeted WS broadcasts
        case "commission_earned":
          // A commission was earned from a referee's trade
          // Invalidate referral queries to refresh data
          console.log("[UnifiedWS] Commission earned event received");
          break;

        case "referral_bound":
          // A new user bound using our referral code
          console.log("[UnifiedWS] Referral bound event received");
          break;

        case "commission_withdrawn":
          // Commission withdrawal was processed
          console.log("[UnifiedWS] Commission withdrawn event received");
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
      // AUDIT-FIX M-10: 达到上限后不再永久放弃，而是 60 秒后重置计数器自动恢复
      console.warn("[UnifiedWS] Max reconnect attempts reached, will retry in 60s");
      useTradingDataStore
        .getState()
        .setWsError("Connection lost. Retrying in 60s...");
      this.longRetryTimeout = setTimeout(() => {
        this.reconnectAttempts = 0;
        this.connect();
      }, 60_000);
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

    // Resubscribe to traders (risk data)
    this.subscribedTraders.forEach((trader) => {
      void this.sendSubscribeRisk(trader);
    });

    // Subscribe to global risk data
    this.sendGlobalRiskSubscribe();

    // Re-authenticate for trader-specific data (position/balance/orders)
    this.authenticatedTrader = null; // Reset so reauthenticate will proceed
    this.reauthenticate();
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

  private async sendSubscribeRisk(trader: Address): Promise<void> {
    if (!this.pendingAuthSignFn) return;

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = await this.pendingAuthSignFn(`subscribe_risk:${trader}:${timestamp}`);
      this.send({
        type: "subscribe_risk",
        trader,
        signature,
        timestamp,
      });
    } catch (e) {
      console.error("[UnifiedWS] subscribe_risk signing failed:", e);
    }
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

  /**
   * Authenticate with matching engine and subscribe to trader-specific data.
   * Flow: auth -> auth_success -> position/balance/orders push
   */
  async authenticate(trader: Address, signMessage: (msg: string) => Promise<string>): Promise<void> {
    const normalizedTrader = trader.toLowerCase() as Address;

    // Already authenticated for this trader
    if (this.authenticatedTrader === normalizedTrader) return;

    this.pendingAuthTrader = normalizedTrader;
    this.pendingAuthSignFn = signMessage;

    if (this.ws?.readyState !== WebSocket.OPEN) return;

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = `auth:${normalizedTrader}:${timestamp}`;
      const signature = await signMessage(message);

      this.send({ type: "auth", trader: normalizedTrader, signature, timestamp });
    } catch (e) {
      console.error("[UnifiedWS] Auth signing failed:", e);
      this.pendingAuthTrader = null;
      this.pendingAuthSignFn = null;
    }
  }

  /**
   * Re-authenticate after reconnect (if previously authenticated)
   */
  private async reauthenticate(): Promise<void> {
    if (this.pendingAuthSignFn && this.pendingAuthTrader) {
      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const message = `auth:${this.pendingAuthTrader}:${timestamp}`;
        const signature = await this.pendingAuthSignFn(message);
        this.send({ type: "auth", trader: this.pendingAuthTrader, signature, timestamp });
      } catch (e) {
        console.error("[UnifiedWS] Re-auth failed:", e);
      }
    }
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
        void this.sendSubscribeRisk(normalizedTrader);
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
    this.shouldReconnect = true;
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
    managerRef.current = WebSocketManager.getInstance();

    if (!enabled) {
      managerRef.current.disconnect();
      return;
    }

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
