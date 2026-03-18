/**
 * 统一交易数据 Store
 *
 * 集中管理所有交易相关数据，消除多数据源冲突
 * 所有组件通过这个 Store 读取数据，由 WebSocket 统一更新
 */

import { create } from "zustand";
import { subscribeWithSelector, persist } from "zustand/middleware";
import { type Address } from "viem";

// ============================================================
// Types
// ============================================================

// WSS token list (替代 useOnChainTokenList 的 400+ RPC 调用)
export interface WssOnChainToken {
  address: `0x${string}`;
  name: string;
  symbol: string;
  creator: string;
  createdAt: number;
  isGraduated: boolean;
  isActive: boolean;
  price: string;       // wei string from bonding curve
  marketCap: string;   // wei string
  soldSupply: string;
  metadataURI: string;
  perpEnabled: boolean;
  realETHReserve: string;
  priceChangePercent24h?: string;
}

// 仓位方向
export type PositionSide = "long" | "short";

// 保证金模式 (与合约 IPositionManager.MarginMode 对应)
export type MarginMode = "cross" | "isolated";

// 保证金模式枚举值 (用于与后端/合约交互)
export const MarginModeValue = {
  ISOLATED: 0,
  CROSS: 1,
} as const;

// 仓位状态 (与合约 IPositionManager.PositionStatus 对应)
export type PositionStatus = "open" | "closed" | "liquidated";

// 仓位状态枚举值 (用于与后端/合约交互)
export const PositionStatusValue = {
  OPEN: 0,
  CLOSED: 1,
  LIQUIDATED: 2,
} as const;

// 订单类型
export type PerpOrderType = "market" | "limit" | "stop_limit" | "stop_market";

// 杠杆设置
export interface LeverageSettings {
  instId: string;
  leverage: number;
  marginMode: MarginMode;
}

// 订单表单状态
export interface OrderFormState {
  side: PositionSide;
  orderType: PerpOrderType;
  price: string;
  stopPrice: string;
  size: string;
  leverage: number;
  marginMode: MarginMode;
  takeProfitPrice: string;
  stopLossPrice: string;
  reduceOnly: boolean;
  postOnly: boolean;
}

// 默认订单表单状态
const DEFAULT_ORDER_FORM: OrderFormState = {
  side: "long",
  orderType: "market",
  price: "",
  stopPrice: "",
  size: "",
  leverage: 10,
  marginMode: "cross",
  takeProfitPrice: "",
  stopLossPrice: "",
  reduceOnly: false,
  postOnly: false,
};

export interface OrderBookLevel {
  price: string;
  size: string;
  count: number;
}

export interface OrderBookData {
  longs: OrderBookLevel[];
  shorts: OrderBookLevel[];
  lastPrice: string;
  timestamp?: number;
}

export interface TradeData {
  id: string;
  price: string;
  size: string;
  side: "buy" | "sell";
  timestamp: number;
}

export interface PairedPosition {
  pairId: string;
  trader?: Address;                   // 仓位持有者地址 (后端风控推送)
  token: Address;
  isLong: boolean;
  size: string;
  entryPrice: string;
  leverage: string;
  marginMode: MarginMode;       // 保证金模式 (逐仓/全仓)
  markPrice?: string;
  liquidationPrice?: string;    // 统一使用 liquidationPrice (删除重复的 liqPrice)
  breakEvenPrice?: string;
  collateral: string;
  margin?: string;
  marginRatio?: string;
  maintenanceMargin?: string;
  mmr?: string;
  unrealizedPnL: string;
  realizedPnL?: string;
  roe?: string;
  fundingFee?: string;
  takeProfitPrice?: string;
  stopLossPrice?: string;
  counterparty: Address;
  openTime?: number;
  updatedAt?: number;

  // === 风控字段 (与合约 IPositionManager 对应) ===
  status?: PositionStatus;              // 仓位状态 (open/closed/liquidated)
  isLiquidatable?: boolean;             // 是否可被强平
  isLiquidating?: boolean;              // 是否正在强平中 (防止重复操作)
  bankruptcyPrice?: string;             // 破产价格 (保险基金接管价)
  adlRanking?: number;                  // ADL 排名 (1-5)
  adlScore?: string;                    // ADL 评分
  isAdlCandidate?: boolean;             // 是否为 ADL 候选仓位
  riskLevel?: "low" | "medium" | "high" | "critical";  // 风险等级
}

export interface OrderInfo {
  id: string;
  clientOrderId?: string;
  token: Address;
  isLong: boolean;
  size: string;
  leverage: string;
  price: string;
  orderType: "MARKET" | "LIMIT";
  timeInForce: "GTC" | "IOC" | "FOK" | "GTD";
  reduceOnly: boolean;
  status: string;
  filledSize: string;
  avgFillPrice: string;
  totalFillValue: string;
  fee: string;                    // 手续费金额 (ETH)
  margin: string;
  collateral: string;
  takeProfitPrice?: string;
  stopLossPrice?: string;
  createdAt: number;
  updatedAt: number;
  lastFillTime?: number;
  source: "API" | "WEB" | "APP";
  lastFillPrice?: string;
  lastFillSize?: string;
  tradeId?: string;
}

export interface HistoricalOrder extends OrderInfo {
  closeReason?: "filled" | "cancelled" | "expired" | "liquidated";
}

/**
 * 永续合约成交记录
 * 这是永续合约交易的标准类型，与现货交易的 SpotTradeRecord 不同
 */
export interface PerpTradeRecord {
  id: string;
  orderId: string;
  pairId?: string;
  token: Address;
  trader?: Address;            // 交易者地址
  isLong: boolean;
  isMaker: boolean;
  size: string;
  price: string;
  fee: string;
  realizedPnL?: string;
  timestamp: number;
  type?: "open" | "normal" | "liquidation" | "adl" | "close";  // 成交类型
}

// 向后兼容别名
/** @deprecated 使用 PerpTradeRecord 代替 */
export type TradeRecord = PerpTradeRecord;

export interface UserBalance {
  available: bigint;
  locked: bigint;
  unrealizedPnL: bigint;
  equity: bigint;
  walletBalance?: bigint;
  contractBalance?: bigint;
}

export interface TokenStats {
  lastPrice: string;
  priceChange24h: string;
  priceChangePercent24h: string;
  volume24h: string;
  high24h: string;
  low24h: string;
  trades24h: number;
  openInterest: string;
}

export interface FundingRateInfo {
  rate: string;
  nextFundingTime: number;
  interval: string;
  predictedRate?: string;
}

export interface InsuranceFundInfo {
  balance: string;
  totalContributions: string;
  totalPayouts: string;
  lastUpdated: number;
  display?: {
    balance: string;
    totalContributions: string;
    totalPayouts: string;
  };
}

export interface RiskAlert {
  type: "margin_warning" | "liquidation_warning" | "adl_warning" | "funding_warning";
  severity: "info" | "warning" | "danger";
  pairId?: string;
  message: string;
  timestamp: number;
}

// ============================================================
// Store State
// ============================================================

interface TradingDataState {
  // Current token being viewed
  currentToken: Address | null;
  currentTrader: Address | null;

  // Token metadata (name/symbol, from WSS)
  tokenInfoMap: Record<string, { name: string; symbol: string }>;

  // Full token list from WSS (replaces useOnChainTokenList RPC calls)
  allTokens: WssOnChainToken[];
  allTokensLoaded: boolean;

  // Real-time market data (per token)
  orderBooks: Map<Address, OrderBookData>;
  recentTrades: Map<Address, TradeData[]>;
  tokenStats: Map<Address, TokenStats>;
  fundingRates: Map<Address, FundingRateInfo>;

  // User data
  positions: PairedPosition[];
  pendingOrders: OrderInfo[];
  orderHistory: HistoricalOrder[];
  tradeHistory: PerpTradeRecord[];
  balance: UserBalance | null;

  // Risk data
  insuranceFund: InsuranceFundInfo | null;
  riskAlerts: RiskAlert[];

  // Connection status
  wsConnected: boolean;
  wsError: string | null;
  lastUpdated: number;
  dataStale: boolean; // P3-77: true when WS disconnects, cleared on reconnect data refresh

  // Loading states
  isLoadingPositions: boolean;
  isLoadingOrders: boolean;
  isLoadingHistory: boolean;

  // Order form state (从 perpetualStore 迁移)
  orderForm: OrderFormState;
  leverageSettings: Record<string, LeverageSettings>;
  selectedInstId: string;

  // Actions
  setCurrentToken: (token: Address | null) => void;
  setCurrentTrader: (trader: Address | null) => void;

  // Token info setter (WSS-only)
  setTokenInfoMap: (info: Record<string, { name: string; symbol: string }>) => void;
  setAllTokens: (tokens: WssOnChainToken[]) => void;

  // Market data setters
  setOrderBook: (token: Address, orderBook: OrderBookData) => void;
  addRecentTrade: (token: Address, trade: TradeData) => void;
  setRecentTrades: (token: Address, trades: TradeData[]) => void;
  setTokenStats: (token: Address, stats: TokenStats) => void;
  setTokenStatsBatch: (entries: Array<{ token: Address; stats: TokenStats }>) => void;
  setFundingRate: (token: Address, rate: FundingRateInfo) => void;

  // User data setters
  setPositions: (positions: PairedPosition[]) => void;
  updatePosition: (pairId: string, updates: Partial<PairedPosition>) => void;
  removePosition: (pairId: string) => void;
  setPendingOrders: (orders: OrderInfo[]) => void;
  addPendingOrder: (order: OrderInfo) => void;
  updatePendingOrder: (orderId: string, updates: Partial<OrderInfo>) => void;
  removePendingOrder: (orderId: string) => void;
  setOrderHistory: (orders: HistoricalOrder[]) => void;
  setTradeHistory: (trades: PerpTradeRecord[]) => void;
  setBalance: (balance: UserBalance | null) => void;

  // Risk data setters
  setInsuranceFund: (fund: InsuranceFundInfo | null) => void;
  addRiskAlert: (alert: RiskAlert) => void;
  clearRiskAlerts: () => void;

  // Connection status
  setWsConnected: (connected: boolean) => void;
  setWsError: (error: string | null) => void;
  setLastUpdated: (timestamp: number) => void;
  setDataStale: (stale: boolean) => void;

  // Loading states
  setIsLoadingPositions: (loading: boolean) => void;
  setIsLoadingOrders: (loading: boolean) => void;
  setIsLoadingHistory: (loading: boolean) => void;

  // Order form actions (从 perpetualStore 迁移)
  updateOrderForm: (updates: Partial<OrderFormState>) => void;
  resetOrderForm: () => void;
  setLeverageSettings: (instId: string, settings: LeverageSettings) => void;
  updateLeverage: (instId: string, leverage: number) => void;
  updateMarginMode: (instId: string, mode: MarginMode) => void;
  setSelectedInstId: (instId: string) => void;

  // Utility
  getOrderBook: (token: Address) => OrderBookData | null;
  getRecentTrades: (token: Address) => TradeData[];
  getTokenStats: (token: Address) => TokenStats | null;
  getFundingRate: (token: Address) => FundingRateInfo | null;
  getLeverageSettings: (instId: string) => LeverageSettings | undefined;
  reset: () => void;
}

// ============================================================
// Initial State
// ============================================================

const initialState = {
  currentToken: null as Address | null,
  currentTrader: null as Address | null,
  tokenInfoMap: {} as Record<string, { name: string; symbol: string }>,
  allTokens: [] as WssOnChainToken[],
  allTokensLoaded: false,
  orderBooks: new Map<Address, OrderBookData>(),
  recentTrades: new Map<Address, TradeData[]>(),
  tokenStats: new Map<Address, TokenStats>(),
  fundingRates: new Map<Address, FundingRateInfo>(),
  positions: [] as PairedPosition[],
  pendingOrders: [] as OrderInfo[],
  orderHistory: [] as HistoricalOrder[],
  tradeHistory: [] as PerpTradeRecord[],
  balance: null as UserBalance | null,
  insuranceFund: null as InsuranceFundInfo | null,
  riskAlerts: [] as RiskAlert[],
  wsConnected: false,
  wsError: null as string | null,
  lastUpdated: 0,
  dataStale: false,
  isLoadingPositions: false,
  isLoadingOrders: false,
  isLoadingHistory: false,
  // Order form state (从 perpetualStore 迁移)
  orderForm: DEFAULT_ORDER_FORM,
  leverageSettings: {} as Record<string, LeverageSettings>,
  selectedInstId: "",
};

// ============================================================
// Store
// ============================================================

export const useTradingDataStore = create<TradingDataState>()(
  subscribeWithSelector((set, get) => ({
    ...initialState,

    // Token/Trader setters
    setCurrentToken: (token) => set({ currentToken: token }),
    setCurrentTrader: (trader) => set({ currentTrader: trader }),

    // Token info (WSS-only)
    setTokenInfoMap: (info) => set({ tokenInfoMap: info }),
    setAllTokens: (tokens) => set({ allTokens: tokens, allTokensLoaded: true }),

    // Market data setters
    setOrderBook: (token, orderBook) =>
      set((state) => {
        const newOrderBooks = new Map(state.orderBooks);
        newOrderBooks.set(token.toLowerCase() as Address, orderBook);
        return { orderBooks: newOrderBooks };
      }),

    addRecentTrade: (token, trade) =>
      set((state) => {
        const newRecentTrades = new Map(state.recentTrades);
        const normalizedToken = token.toLowerCase() as Address;
        const existing = newRecentTrades.get(normalizedToken) || [];
        newRecentTrades.set(normalizedToken, [trade, ...existing.slice(0, 99)]);
        return { recentTrades: newRecentTrades };
      }),

    setRecentTrades: (token, trades) =>
      set((state) => {
        const newRecentTrades = new Map(state.recentTrades);
        newRecentTrades.set(token.toLowerCase() as Address, trades);
        return { recentTrades: newRecentTrades };
      }),

    setTokenStats: (token, stats) =>
      set((state) => {
        const normalizedToken = token.toLowerCase() as Address;
        const existing = state.tokenStats.get(normalizedToken);
        // 浅比较: 如果关键字段未变化则跳过更新，避免不必要的 re-render
        if (existing &&
          existing.lastPrice === stats.lastPrice &&
          existing.volume24h === stats.volume24h &&
          existing.openInterest === stats.openInterest &&
          existing.high24h === stats.high24h &&
          existing.low24h === stats.low24h &&
          existing.priceChange24h === stats.priceChange24h &&
          existing.trades24h === stats.trades24h) {
          return state; // 不触发更新
        }
        const newTokenStats = new Map(state.tokenStats);
        newTokenStats.set(normalizedToken, stats);
        return { tokenStats: newTokenStats };
      }),

    // Batch update: single Map clone for all tokens (avoids N re-renders from all_market_stats)
    setTokenStatsBatch: (entries) =>
      set((state) => {
        let changed = false;
        const newMap = new Map(state.tokenStats);
        for (const { token, stats } of entries) {
          const normalizedToken = token.toLowerCase() as Address;
          const existing = newMap.get(normalizedToken);
          if (existing &&
            existing.lastPrice === stats.lastPrice &&
            existing.volume24h === stats.volume24h &&
            existing.openInterest === stats.openInterest &&
            existing.high24h === stats.high24h &&
            existing.low24h === stats.low24h &&
            existing.priceChange24h === stats.priceChange24h &&
            existing.trades24h === stats.trades24h) {
            continue; // This token unchanged
          }
          newMap.set(normalizedToken, stats);
          changed = true;
        }
        return changed ? { tokenStats: newMap } : state;
      }),

    setFundingRate: (token, rate) =>
      set((state) => {
        const normalizedToken = token.toLowerCase() as Address;
        const existing = state.fundingRates.get(normalizedToken);
        // 浅比较: 费率未变化则跳过更新
        if (existing && existing.rate === rate.rate) {
          return state; // 不触发更新
        }
        const newFundingRates = new Map(state.fundingRates);
        newFundingRates.set(normalizedToken, rate);
        return { fundingRates: newFundingRates };
      }),

    // User data setters
    setPositions: (positions) =>
      set({ positions, lastUpdated: Date.now(), isLoadingPositions: false }),

    updatePosition: (pairId, updates) =>
      set((state) => ({
        positions: state.positions.map((p) =>
          p.pairId === pairId ? { ...p, ...updates } : p
        ),
        lastUpdated: Date.now(),
      })),

    removePosition: (pairId) =>
      set((state) => ({
        positions: state.positions.filter((p) => p.pairId !== pairId),
        lastUpdated: Date.now(),
      })),

    setPendingOrders: (orders) =>
      set({ pendingOrders: orders, isLoadingOrders: false }),

    addPendingOrder: (order) =>
      set((state) => ({
        pendingOrders: [order, ...state.pendingOrders],
      })),

    updatePendingOrder: (orderId, updates) =>
      set((state) => ({
        pendingOrders: state.pendingOrders.map((o) =>
          o.id === orderId ? { ...o, ...updates } : o
        ),
      })),

    removePendingOrder: (orderId) =>
      set((state) => ({
        pendingOrders: state.pendingOrders.filter((o) => o.id !== orderId),
      })),

    setOrderHistory: (orders) =>
      set({ orderHistory: orders, isLoadingHistory: false }),

    setTradeHistory: (trades) =>
      set({ tradeHistory: trades, isLoadingHistory: false }),

    setBalance: (balance) => set({ balance }),

    // Risk data setters
    setInsuranceFund: (fund) => set({ insuranceFund: fund }),

    addRiskAlert: (alert) =>
      set((state) => ({
        riskAlerts: [alert, ...state.riskAlerts].slice(0, 50),
      })),

    clearRiskAlerts: () => set({ riskAlerts: [] }),

    // Connection status
    setWsConnected: (connected) => set((state) => ({
      wsConnected: connected,
      // P3-77: Mark data as stale when WS disconnects
      dataStale: !connected ? true : state.dataStale,
    })),
    setWsError: (error) => set({ wsError: error }),
    setLastUpdated: (timestamp) => set({ lastUpdated: timestamp }),
    setDataStale: (stale) => set({ dataStale: stale }),

    // Loading states
    setIsLoadingPositions: (loading) => set({ isLoadingPositions: loading }),
    setIsLoadingOrders: (loading) => set({ isLoadingOrders: loading }),
    setIsLoadingHistory: (loading) => set({ isLoadingHistory: loading }),

    // Utility getters
    getOrderBook: (token) => {
      return get().orderBooks.get(token.toLowerCase() as Address) || null;
    },

    getRecentTrades: (token) => {
      return get().recentTrades.get(token.toLowerCase() as Address) || [];
    },

    getTokenStats: (token) => {
      return get().tokenStats.get(token.toLowerCase() as Address) || null;
    },

    getFundingRate: (token) => {
      return get().fundingRates.get(token.toLowerCase() as Address) || null;
    },

    getLeverageSettings: (instId) => {
      return get().leverageSettings[instId];
    },

    // Order form actions (从 perpetualStore 迁移)
    updateOrderForm: (updates) =>
      set((state) => ({
        orderForm: { ...state.orderForm, ...updates },
      })),

    resetOrderForm: () =>
      set((state) => ({
        orderForm: {
          ...DEFAULT_ORDER_FORM,
          leverage: state.leverageSettings[state.selectedInstId]?.leverage || 10,
          marginMode: state.leverageSettings[state.selectedInstId]?.marginMode || "cross",
        },
      })),

    setLeverageSettings: (instId, settings) =>
      set((state) => ({
        leverageSettings: {
          ...state.leverageSettings,
          [instId]: settings,
        },
      })),

    updateLeverage: (instId, leverage) =>
      set((state) => ({
        leverageSettings: {
          ...state.leverageSettings,
          [instId]: {
            ...(state.leverageSettings[instId] || { instId, marginMode: "cross" as MarginMode }),
            leverage,
          },
        },
        orderForm: {
          ...state.orderForm,
          leverage,
        },
      })),

    updateMarginMode: (instId, mode) =>
      set((state) => ({
        leverageSettings: {
          ...state.leverageSettings,
          [instId]: {
            ...(state.leverageSettings[instId] || { instId, leverage: 10 }),
            marginMode: mode,
          },
        },
        orderForm: {
          ...state.orderForm,
          marginMode: mode,
        },
      })),

    setSelectedInstId: (instId) => set({ selectedInstId: instId }),

    reset: () => set(initialState),
  }))
);

// ============================================================
// Selectors
// ============================================================

// ✅ 稳定的空数组/对象常量，避免每次返回新引用导致无限循环
const EMPTY_ARRAY: readonly never[] = [];
const EMPTY_TRADES: readonly TradeData[] = [];
const EMPTY_POSITIONS: readonly PairedPosition[] = [];
const EMPTY_ORDERS: readonly OrderInfo[] = [];

// Current token's order book
export const useCurrentOrderBook = () =>
  useTradingDataStore((state) => {
    const token = state.currentToken;
    return token ? state.orderBooks.get(token.toLowerCase() as Address) : null;
  });

// Current token's recent trades
// ✅ 使用稳定的 EMPTY_TRADES 常量而不是 || []
export const useCurrentRecentTrades = () =>
  useTradingDataStore((state) => {
    const token = state.currentToken;
    if (!token) return EMPTY_TRADES;
    return state.recentTrades.get(token.toLowerCase() as Address) ?? EMPTY_TRADES;
  });

// Current token's stats
export const useCurrentTokenStats = () =>
  useTradingDataStore((state) => {
    const token = state.currentToken;
    return token
      ? state.tokenStats.get(token.toLowerCase() as Address)
      : null;
  });

// Current token's funding rate
export const useCurrentFundingRate = () =>
  useTradingDataStore((state) => {
    const token = state.currentToken;
    return token
      ? state.fundingRates.get(token.toLowerCase() as Address)
      : null;
  });

// Current token's positions
// ✅ 使用稳定的空数组常量
export const useCurrentPositions = () =>
  useTradingDataStore((state) => {
    const token = state.currentToken;
    if (!token) return EMPTY_POSITIONS;
    const filtered = state.positions.filter(
      (p) => p.token.toLowerCase() === token.toLowerCase()
    );
    return filtered.length > 0 ? filtered : EMPTY_POSITIONS;
  });

// All positions
export const useAllPositions = () =>
  useTradingDataStore((state) => state.positions);

// Pending orders (for current token only)
// ✅ 使用稳定的空数组常量
export const useCurrentPendingOrders = () =>
  useTradingDataStore((state) => {
    const token = state.currentToken;
    if (!token) return EMPTY_ORDERS;
    const filtered = state.pendingOrders.filter(
      (o) =>
        o.token.toLowerCase() === token.toLowerCase() &&
        (o.status === "PENDING" || o.status === "PARTIALLY_FILLED")
    );
    return filtered.length > 0 ? filtered : EMPTY_ORDERS;
  });

// All pending orders
// ✅ 使用稳定的空数组常量
export const useAllPendingOrders = () =>
  useTradingDataStore((state) => {
    const filtered = state.pendingOrders.filter(
      (o) => o.status === "PENDING" || o.status === "PARTIALLY_FILLED"
    );
    return filtered.length > 0 ? filtered : EMPTY_ORDERS;
  });

// Order history
export const useOrderHistory = () =>
  useTradingDataStore((state) => state.orderHistory);

// Trade history
export const useTradeHistory = () =>
  useTradingDataStore((state) => state.tradeHistory);

// Balance
export const useBalance = () => useTradingDataStore((state) => state.balance);

// Risk alerts
export const useRiskAlerts = () =>
  useTradingDataStore((state) => state.riskAlerts);

// Connection status
// ✅ 移除 lastUpdated 以避免频繁触发重渲染 (每条 WebSocket 消息都会更新 lastUpdated)
// 如果需要 lastUpdated，请单独使用 useWsLastUpdated 选择器
export const useWsStatus = () =>
  useTradingDataStore((state) => ({
    connected: state.wsConnected,
    error: state.wsError,
  }));

// 单独的 lastUpdated 选择器 (仅在需要时使用，会频繁触发更新)
export const useWsLastUpdated = () =>
  useTradingDataStore((state) => state.lastUpdated);

// Loading states
export const useLoadingStates = () =>
  useTradingDataStore((state) => ({
    positions: state.isLoadingPositions,
    orders: state.isLoadingOrders,
    history: state.isLoadingHistory,
  }));

// Order form (从 perpetualStore 迁移)
export const useOrderForm = () =>
  useTradingDataStore((state) => state.orderForm);

// Leverage settings (从 perpetualStore 迁移)
const DEFAULT_LEVERAGE_SETTINGS: LeverageSettings = {
  instId: "",
  leverage: 10,
  marginMode: "cross" as MarginMode,
};

export const useLeverageSettings = (instId: string) =>
  useTradingDataStore(
    (state) => state.leverageSettings[instId] ?? DEFAULT_LEVERAGE_SETTINGS
  );

// Selected instrument ID
export const useSelectedInstId = () =>
  useTradingDataStore((state) => state.selectedInstId);

export default useTradingDataStore;
