/**
 * WebSocket 类型定义
 *
 * ⚔️ 三大铁律 (The Iron Laws):
 * 1. 命名律: JSON 字段一律使用 snake_case (下划线命名)
 * 2. 数值律: 金额、价格、大整数在 JSON 中一律用 string
 * 3. 时间律: 所有时间戳一律使用 Unix 秒 (int64)
 */

// ============================================================================
// 基础类型别名
// ============================================================================

/** Wei 金额字符串 (BigInt 序列化) */
export type WeiAmount = string;

/** 以太坊地址 */
export type Address = string;

/** Unix 时间戳 (秒) */
export type UnixTimestamp = number;

// ============================================================================
// 消息类型枚举
// ============================================================================

export enum MessageType {
  // 系统消息
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  HEARTBEAT = 'heartbeat',

  // 交易相关
  QUOTE = 'quote',
  TRADE = 'trade',
  TRADE_EVENT = 'trade_event',

  // 行情数据
  TICKER = 'tickers',
  CANDLE = 'candle',
  BOOKS = 'books',
  MARK_PRICE = 'mark-price',
  FUNDING_RATE = 'funding-rate',

  // 价格更新
  PRICE_UPDATE = 'price_update',

  // 订阅
  SUBSCRIBE = 'subscribe',
  UNSUBSCRIBE = 'unsubscribe',

  // 钱包认证
  WALLET_AUTH_CHALLENGE = 'wallet_auth_challenge',
  WALLET_AUTH_VERIFY = 'wallet_auth_verify',

  // 账户相关 (私有频道)
  ACCOUNT = 'account',
  BALANCE = 'balance',
  POSITIONS = 'positions',
  ORDERS = 'orders',
  LIQUIDATION_WARNING = 'liquidation-warning',

  // 元数据
  GET_METADATA_REQUEST = 'get_metadata_request',
  SAVE_METADATA_REQUEST = 'save_metadata_request',
}

// ============================================================================
// 错误码
// ============================================================================

export enum ErrorCode {
  INVALID_REQUEST = 'INVALID_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  NOT_FOUND = 'NOT_FOUND',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
}

// ============================================================================
// 基础消息结构
// ============================================================================

export interface Message<T = unknown> {
  type: string;
  request_id?: string;
  data?: T;
  error?: string;
  error_code?: ErrorCode;
  timestamp: number;
}

// ============================================================================
// 交易相关类型
// ============================================================================

export interface QuoteReq {
  token_address: Address;
  side: 'buy' | 'sell';
  amount: WeiAmount;
}

export interface QuoteResp {
  token_address: Address;
  side: 'buy' | 'sell';
  input_amount: WeiAmount;
  output_amount: WeiAmount;
  price_impact: number;
  fee: WeiAmount;
}

export interface TradeReq {
  token_address: Address;
  side: 'buy' | 'sell';
  amount: WeiAmount;
  min_output: WeiAmount;
  deadline: UnixTimestamp;
}

export interface TradeResp {
  success: boolean;
  tx_hash?: string;
  message?: string;
}

export interface TradeEvent {
  token_address: Address;
  trade_type: 'BUY' | 'SELL';
  trader_address: Address;
  eth_amount: WeiAmount;
  token_amount: WeiAmount;
  new_price: WeiAmount;
  timestamp: UnixTimestamp;
  tx_hash: string;
}

// ============================================================================
// 价格更新
// ============================================================================

export interface PriceUpdate {
  token_address: Address;
  current_price: WeiAmount;
  price_change_24h: number;
  market_cap: WeiAmount;
  volume_24h: WeiAmount;
  timestamp: UnixTimestamp;
}

// ============================================================================
// 订阅管理
// ============================================================================

export interface SubscribeReq {
  topics: string[];
}

export interface UnsubscribeReq {
  topics: string[];
}

// ============================================================================
// 钱包认证
// ============================================================================

export interface WalletAuthChallengeReq {
  wallet_address: Address;
}

export interface WalletAuthChallengeResp {
  success: boolean;
  challenge?: string;
  expires_at?: UnixTimestamp;
  error?: string;
}

export interface WalletAuthVerifyReq {
  wallet_address: Address;
  signature: string;
}

export interface WalletAuthVerifyResp {
  success: boolean;
  token?: string;
  expires_at?: UnixTimestamp;
  error?: string;
}

// ============================================================================
// WebSocket 客户端专用类型
// ============================================================================

/** WebSocket 连接状态 */
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

/** WebSocket 客户端配置 */
export interface WebSocketConfig {
  url: string;
  reconnectAttempts?: number;
  reconnectDelay?: number;
  heartbeatInterval?: number;
  debug?: boolean;
}

/**
 * 获取安全的 WebSocket URL
 * P1: 使用集中配置，避免硬编码 localhost — config/api.ts 已有生产环境 HTTPS 自动升级
 */
function getSecureWebSocketUrl(): string {
  // 优先使用独立 WS env，否则从 config/api.ts 的 MATCHING_ENGINE_URL 派生
  const explicitWsUrl = process.env.NEXT_PUBLIC_WEBSOCKET_URL;
  if (explicitWsUrl) {
    const isProduction = process.env.NODE_ENV === 'production';
    const isLocalhost = explicitWsUrl.includes('localhost') || explicitWsUrl.includes('127.0.0.1');
    if (isProduction && explicitWsUrl.startsWith('ws://') && !isLocalhost) {
      console.error('[WebSocket Security] 生产环境不允许使用非加密 WebSocket (ws://)。');
      return explicitWsUrl.replace('ws://', 'wss://');
    }
    return explicitWsUrl;
  }

  // 从 MATCHING_ENGINE_URL 派生（与 config/api.ts 的 WS_URL 逻辑一致）
  const httpUrl =
    process.env.NEXT_PUBLIC_MATCHING_ENGINE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:8081';
  return httpUrl.replace(/^http/, 'ws') + '/ws';
}

/** 默认配置 */
export const DEFAULT_CONFIG: WebSocketConfig = {
  url: getSecureWebSocketUrl(),
  reconnectAttempts: 10,
  reconnectDelay: 1000,
  heartbeatInterval: 20000,
  debug: process.env.NODE_ENV === 'development',
};

// ============================================================================
// 工具函数
// ============================================================================

/** 生成请求 ID */
export function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/** 获取当前 Unix 时间戳 (秒) */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** 创建消息 */
export function createMessage<T>(type: string, data?: T, requestId?: string): Message<T> {
  return {
    type,
    request_id: requestId || generateRequestId(),
    data,
    timestamp: nowUnix(),
  };
}

/** 创建主题 */
export function createTokenTopic(tokenAddress: string): string {
  return `token:${tokenAddress}`;
}

export function createTradesTopic(tokenAddress: string): string {
  return `trades:${tokenAddress}`;
}

export function createPriceTopic(tokenAddress: string): string {
  return `price:${tokenAddress}`;
}

export function createUserTopic(userAddress: string): string {
  return `user:${userAddress}`;
}

// ============================================================================
// K 线历史
// ============================================================================

export interface KlineHistoryRequestData {
  token_address: string;
  resolution: string;
  from: number;
  to: number;
}

export interface KlineBar {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface KlineHistoryResponseData {
  success: boolean;
  bars: KlineBar[];
  message?: string;
}

// ============================================================================
// 兼容类型别名
// ============================================================================

/** WebSocket 消息 (兼容别名) */
export interface WebSocketMessage<T = unknown> {
  type: string;
  request_id?: string;
  data?: T;
  error?: string;
  timestamp: number;
}

/** 订阅请求数据 */
export interface SubscribeRequestData {
  topics: string[];
}

/** 取消订阅请求数据 */
export interface UnsubscribeRequestData {
  topics: string[];
}
