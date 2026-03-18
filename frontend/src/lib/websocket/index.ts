/**
 * WebSocket 模块主入口 (未对接版本)
 *
 * 接口保留，返回空数据
 * TODO: 对接真实后端服务
 */

export * from "./types";
export * from "./client";
export * from "./hooks";

// 核心类型
export {
  MessageType,
  ConnectionStatus,
  type Message,
  type WebSocketMessage,
  type QuoteReq,
  type QuoteResp,
  type TradeReq,
  type TradeResp,
  type TradeEvent,
  type PriceUpdate,
  // 工具函数
  nowUnix,
  generateRequestId,
  createMessage,
  createTokenTopic,
  createPriceTopic,
} from "./types";

export { WebSocketClient, getWebSocketClient } from "./client";

export {
  useWebSocketStatus,
  useWebSocketMessage,
  useWebSocketRequest,
  useWebSocketConnection,
  useWebSocketSubscription,
} from "./hooks";

// ============================================================
// 交易对资产数据类型 (保留所有类型定义)
// ============================================================

import { MATCHING_ENGINE_URL } from "@/config/api";

/** 交易对资产数据 */
export interface InstrumentAssetData {
  instId: string;
  symbol?: string;
  tokenAddress?: string;
  poolAddress?: string;
  creatorAddress?: string;
  currentPrice: string;
  fdv: string;
  volume24h?: string;
  priceChange24h?: number;
  soldSupply?: string;
  totalSupply?: string;
  isGraduated?: boolean;
  securityStatus?: string;
  createdAt?: number;
  uniqueTraders?: number;
  logo?: string;
  imageUrl?: string;
}

/** 交易对资产更新事件 */
export interface InstrumentAssetUpdate {
  inst_id: string;
  current_price: string;
  fdv: string;
  total_supply?: string;
  sold_supply?: string;
}

/** 持仓者信息 */
export interface HolderInfo {
  rank: number;
  address: string;
  balance: string;
  percentage: number;
  is_creator: boolean;
  is_dev: boolean;
  label?: string;
  pnl_percentage?: number;
}

/** 持仓分布响应 */
export interface TopHoldersResp {
  success: boolean;
  inst_id?: string;
  holders: HolderInfo[];
  total_holders: number;
  top10_percentage: number;
  creator_address?: string;
  creator_holding?: number;
  concentration_risk: "HIGH" | "MEDIUM" | "LOW";
  // Pool info (bonding curve)
  pool_address?: string;
  pool_holding?: number;        // Pool's percentage of total supply
  sold_percentage?: number;     // Percentage of tokens sold (graduation progress)
  is_graduated?: boolean;
}

/** 交易对交易事件 */
export interface InstrumentTradeEvent {
  inst_id: string;
  tx_hash: string;
  trade_type: "BUY" | "SELL";
  trader_address: string;
  token_amount: string;
  eth_amount: string;
  new_price: string;
  timestamp: number;
  block_number?: number;
}

/** K 线数据 */
export interface KlineBar {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** 代币列表请求参数 */
export interface TokenListParams {
  page_size?: number;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  filter_by?: string;
}

/** 代币列表响应 */
export interface TokenListResponse {
  success: boolean;
  tokens?: Array<{
    inst_id: string;
    symbol?: string;
    token_address?: string;
    pool_address?: string;
    creator_address?: string;
    current_price: string;
    fdv: string;
    volume_24h?: string;
    price_change_24h?: number;
    sold_supply?: string;
    total_supply?: string;
    is_graduated?: boolean;
    security_status?: string;
    created_at?: number;
    unique_traders?: number;
  }>;
  message?: string;
}

// ============================================================
// WebSocket 服务封装类 (未对接 - 返回空数据)
// ============================================================

class WebSocketServices {
  constructor() {}

  /**
   * 订阅/取消订阅交易对 (no-op, 保留接口兼容)
   */
  async subscribeInstrument(_instId: string): Promise<void> {}
  async unsubscribeInstrument(_instId: string): Promise<void> {}

  /**
   * 获取交易历史 — calls REST API /api/v1/spot/trades/{token}
   */
  async getTradeHistory(params: {
    inst_id: string;
    page_size?: number;
  }): Promise<{
    transactions: Array<{
      transaction_type: "BUY" | "SELL";
      buyer_wallet?: string;
      seller_wallet?: string;
      price: string;
      token_amount: string;
      transaction_timestamp: string;
      tx_hash: string;
    }>;
  }> {
    try {
      // inst_id 可能是 "0xABC..." 或 "0xABC...-BNB"，提取 token 地址
      const token = params.inst_id.split("-")[0];
      if (!token.startsWith("0x")) {
        return { transactions: [] };
      }
      const limit = params.page_size || 50;
      const url = `${MATCHING_ENGINE_URL}/api/v1/spot/trades/${token.toLowerCase()}?limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) {
        return { transactions: [] };
      }
      const json = await res.json();
      if (!json.success || !json.data) {
        return { transactions: [] };
      }
      // 将 SpotTrade 格式转换为 TradingTerminal 期望的 transactions 格式
      return {
        transactions: json.data.map((t: {
          trader: string;
          isBuy: boolean;
          price: string;
          tokenAmount: string;
          ethAmount: string;
          timestamp: number;
          txHash: string;
        }) => ({
          transaction_type: t.isBuy ? "BUY" : "SELL",
          buyer_wallet: t.isBuy ? t.trader : undefined,
          seller_wallet: t.isBuy ? undefined : t.trader,
          price: t.price,
          token_amount: t.tokenAmount,
          transaction_timestamp: t.timestamp.toString(),
          tx_hash: t.txHash,
        })),
      };
    } catch {
      return { transactions: [] };
    }
  }

  /**
   * 获取持仓分布 — calls REST API
   */
  async getTopHolders(params: {
    inst_id: string;
    limit?: number;
  }): Promise<TopHoldersResp> {
    try {
      // inst_id may be "0xABC..." or "0xABC...-USDT"; extract token address
      const token = params.inst_id.split("-")[0];
      if (!token.startsWith("0x")) {
        return { success: false, holders: [], total_holders: 0, top10_percentage: 0, concentration_risk: "LOW" };
      }
      const url = `${MATCHING_ENGINE_URL}/api/v1/spot/holders/${token}?limit=${params.limit ?? 10}`;
      const res = await fetch(url);
      if (!res.ok) {
        return { success: false, holders: [], total_holders: 0, top10_percentage: 0, concentration_risk: "LOW" };
      }
      return await res.json();
    } catch {
      return { success: false, holders: [], total_holders: 0, top10_percentage: 0, concentration_risk: "LOW" };
    }
  }

}

// 全局单例
let servicesInstance: WebSocketServices | null = null;

/**
 * 获取 WebSocket 服务实例
 */
export function getWebSocketServices(): WebSocketServices {
  if (!servicesInstance) {
    servicesInstance = new WebSocketServices();
  }
  return servicesInstance;
}

/**
 * 适配交易对资产响应
 * 支持 snake_case 和 camelCase 两种格式
 */
export function adaptInstrumentAssetResponse(
  response: Record<string, unknown>
): InstrumentAssetData {
  // Helper: 安全读取 snake_case / camelCase 字段
  const s = (a: string, b: string, fallback = ""): string =>
    String(response[a] ?? response[b] ?? fallback);
  const n = (a: string, b: string, fallback = 0): number =>
    Number(response[a] ?? response[b] ?? fallback);

  const instId = s("inst_id", "instId");
  return {
    instId,
    symbol: s("symbol", "symbol") || instId.split("-")[0],
    tokenAddress: s("token_address", "tokenAddress") || undefined,
    poolAddress: s("pool_address", "poolAddress") || undefined,
    creatorAddress: s("creator_address", "creatorAddress") || undefined,
    currentPrice: s("current_price", "currentPrice", "0"),
    fdv: s("fdv", "fdv", "0"),
    volume24h: s("volume_24h", "volume24h", "0"),
    priceChange24h: n("price_change_24h", "priceChange24h"),
    soldSupply: s("sold_supply", "soldSupply") || undefined,
    totalSupply: s("total_supply", "totalSupply") || undefined,
    isGraduated: !!(response.is_graduated ?? response.isGraduated ?? false),
    securityStatus: s("security_status", "securityStatus") || undefined,
    createdAt: n("created_at", "createdAt") || undefined,
    uniqueTraders: n("unique_traders", "uniqueTraders"),
    logo: s("logo_url", "logoUrl") || (response.logo as string) || undefined,
    imageUrl: s("image_url", "imageUrl") || undefined,
  };
}

/** 适配代币资产列表 */
export function adaptTokenAssetList(
  tokens: TokenListResponse["tokens"]
): InstrumentAssetData[] {
  if (!tokens) return [];
  return tokens.map((t) =>
    adaptInstrumentAssetResponse(t as unknown as Record<string, unknown>)
  );
}
