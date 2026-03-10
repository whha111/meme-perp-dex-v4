/**
 * EIP-712 订单签名工具
 *
 * 用户在前端签署订单，发送到撮合引擎
 * 撮合引擎配对后提交到链上验证签名并结算
 */

import { type Address, type Hex, type WalletClient, parseEther, formatEther, parseUnits } from "viem";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { type PerpTradeRecord } from "@/lib/stores/tradingDataStore";

// ============================================================
// Types
// ============================================================

export enum OrderType {
  MARKET = 0,
  LIMIT = 1,
}

export interface OrderParams {
  token: Address;
  isLong: boolean;
  size: bigint;
  leverage: bigint;
  price: bigint;
  deadline: bigint;
  nonce: bigint;
  orderType: OrderType;
}

export interface SignedOrder extends OrderParams {
  trader: Address;
  signature: Hex;
}

// ============================================================
// EIP-712 Domain & Types
// ============================================================

const getEIP712Domain = (settlementAddress: Address, chainId: number) => ({
  name: "MemePerp",
  version: "1",
  chainId,
  verifyingContract: settlementAddress,
});

const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "token", type: "address" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "leverage", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
  ],
} as const;

// ============================================================
// Signing Functions
// ============================================================

/**
 * 签署订单
 */
export async function signOrder(
  walletClient: WalletClient,
  settlementAddress: Address,
  orderParams: OrderParams
): Promise<SignedOrder> {
  const account = walletClient.account;
  if (!account) {
    throw new Error("Wallet not connected");
  }

  const chainId = walletClient.chain?.id || 56;
  const domain = getEIP712Domain(settlementAddress, chainId);

  const message = {
    trader: account.address,
    token: orderParams.token,
    isLong: orderParams.isLong,
    size: orderParams.size,
    leverage: orderParams.leverage,
    price: orderParams.price,
    deadline: orderParams.deadline,
    nonce: orderParams.nonce,
    orderType: orderParams.orderType,
  };

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: ORDER_TYPES,
    primaryType: "Order",
    message,
  });

  return {
    ...orderParams,
    trader: account.address,
    signature,
  };
}

/**
 * 创建市价单参数 (ETH 本位)
 * @param sizeEth - 订单名义价值（ETH），例如 0.2 表示 0.2 ETH
 */
export function createMarketOrderParams(
  token: Address,
  isLong: boolean,
  sizeEth: number,
  leverage: number,
  nonce: bigint
): OrderParams {
  const LEVERAGE_PRECISION = 10000n;

  return {
    token,
    isLong,
    // ETH 本位：size 是 ETH 名义价值，使用 1e18 精度
    size: parseEther(sizeEth.toString()),
    leverage: BigInt(Math.floor(leverage)) * LEVERAGE_PRECISION,
    price: 0n, // 市价
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1小时有效
    nonce,
    orderType: OrderType.MARKET,
  };
}

/**
 * 创建限价单参数 (ETH 本位)
 * @param sizeEth - 订单名义价值（ETH），例如 0.2 表示 0.2 ETH
 * @param limitPrice - 限价价格（Token/ETH，1e18 精度）
 */
export function createLimitOrderParams(
  token: Address,
  isLong: boolean,
  sizeEth: number,
  leverage: number,
  limitPrice: number,
  nonce: bigint,
  validityHours: number = 24
): OrderParams {
  const LEVERAGE_PRECISION = 10000n;

  return {
    token,
    isLong,
    // ETH 本位：size 是 ETH 名义价值，使用 1e18 精度
    size: parseEther(sizeEth.toString()),
    leverage: BigInt(Math.floor(leverage)) * LEVERAGE_PRECISION,
    price: parseEther(limitPrice.toString()),
    deadline: BigInt(Math.floor(Date.now() / 1000) + validityHours * 3600),
    nonce,
    orderType: OrderType.LIMIT,
  };
}

// ============================================================
// API Functions
// ============================================================

/**
 * Get Matching Engine API URL
 */
const getApiUrl = (): string => MATCHING_ENGINE_URL;

/**
 * 提交签名订单到撮合引擎
 */
export async function submitOrder(
  signedOrder: SignedOrder,
  options?: { takeProfit?: string; stopLoss?: string }
): Promise<{
  success: boolean;
  orderId?: string;
  status?: string;
  matches?: Array<{
    matchPrice: string;
    matchSize: string;
    counterparty: Address;
  }>;
  error?: string;
}> {
  try {
    const body: Record<string, any> = {
      trader: signedOrder.trader,
      token: signedOrder.token,
      isLong: signedOrder.isLong,
      size: signedOrder.size.toString(),
      leverage: signedOrder.leverage.toString(),
      price: signedOrder.price.toString(),
      deadline: signedOrder.deadline.toString(),
      nonce: signedOrder.nonce.toString(),
      orderType: signedOrder.orderType,
      signature: signedOrder.signature,
    };

    // P2-2: 止盈止损参数
    if (options?.takeProfit) body.takeProfit = options.takeProfit;
    if (options?.stopLoss) body.stopLoss = options.stopLoss;

    const response = await fetch(`${getApiUrl()}/api/order/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return await response.json();
  } catch (error) {
    console.error("Failed to submit order:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 获取用户当前 nonce
 */
export async function getUserNonce(trader: Address): Promise<bigint> {
  try {
    const response = await fetch(`${getApiUrl()}/api/user/${trader}/nonce`);
    const data = await response.json();
    return BigInt(data.nonce || "0");
  } catch {
    return 0n;
  }
}

/**
 * 获取订单簿
 */
export async function getOrderBook(token: Address): Promise<{
  longs: Array<{ price: string; size: string; count: number }>;
  shorts: Array<{ price: string; size: string; count: number }>;
  lastPrice: string;
}> {
  try {
    const response = await fetch(`${getApiUrl()}/api/orderbook/${token}`);
    return await response.json();
  } catch {
    return { longs: [], shorts: [], lastPrice: "0" };
  }
}

/**
 * 获取最近成交记录
 */
export async function getRecentTrades(token: Address, limit = 100): Promise<
  Array<{
    id: string;
    price: string;
    size: string;
    side: "buy" | "sell";
    timestamp: number;
  }>
> {
  try {
    const response = await fetch(`${getApiUrl()}/api/trades/${token}?limit=${limit}`);
    const data = await response.json();
    return data.trades || [];
  } catch {
    return [];
  }
}

/**
 * 订单详细信息类型 (行业标准 - 参考 OKX/Binance)
 */
export interface OrderDetails {
  // === 基本标识 ===
  id: string;
  clientOrderId: string | null;
  token: Address;

  // === 订单参数 ===
  isLong: boolean;
  size: string;
  leverage: string;
  price: string;
  orderType: "MARKET" | "LIMIT";
  timeInForce: "GTC" | "IOC" | "FOK" | "GTD";
  reduceOnly: boolean;

  // === 成交信息 ===
  status: string;
  filledSize: string;
  avgFillPrice: string;
  totalFillValue: string;

  // === 费用信息 ===
  fee: string;                    // 手续费金额 (ETH)

  // === 保证金信息 ===
  margin: string;
  collateral: string;

  // === 止盈止损 ===
  takeProfitPrice: string | null;
  stopLossPrice: string | null;

  // === 时间戳 ===
  createdAt: number;
  updatedAt: number;
  lastFillTime: number | null;

  // === 来源 ===
  source: "API" | "WEB" | "APP";

  // === 最后成交明细 ===
  lastFillPrice: string | null;
  lastFillSize: string | null;
  tradeId: string | null;
}

/**
 * 获取用户订单 (行业标准完整信息)
 */
export async function getUserOrders(trader: Address): Promise<OrderDetails[]> {
  try {
    const response = await fetch(`${getApiUrl()}/api/user/${trader}/orders`);
    const data = await response.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.orders)) return data.orders;
    return [];
  } catch {
    return [];
  }
}

/**
 * 取消订单
 */
export async function cancelOrder(
  orderId: string,
  trader: Address,
  signature: Hex
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${getApiUrl()}/api/order/${orderId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trader, signature }),
    });
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 获取用户仓位（从撮合引擎 API）
 *
 * ETH 本位返回值精度说明：
 * - size: 1e18 (ETH 名义价值)
 * - entryPrice, markPrice, liquidationPrice: 1e18 (ETH/Token 价格)
 * - collateral, unrealizedPnL, maintenanceMargin: 1e18 (ETH 金额)
 * - marginRatio, mmr, roe: 基点 (100 = 1%)
 * - leverage: 人类可读 (如 "75")
 */
export async function getUserPositions(trader: Address): Promise<
  Array<{
    pairId: string;
    token: Address;
    isLong: boolean;
    size: string;              // 1e18 精度 (ETH 名义价值)
    entryPrice: string;        // 1e18 精度 (ETH/Token)
    collateral: string;        // 1e18 精度 (ETH)
    leverage: string;          // 人类可读 (如 "75")
    marginMode: "cross" | "isolated"; // 保证金模式
    counterparty: Address;
    unrealizedPnL: string;     // 1e18 精度 (ETH)
    // 可选字段
    markPrice?: string;        // 1e18 精度 (ETH/Token)
    liquidationPrice?: string; // 1e18 精度 (ETH/Token)
    breakEvenPrice?: string;   // 1e18 精度 (ETH/Token)
    margin?: string;           // 1e18 精度 (ETH)
    marginRatio?: string;      // 基点 (100 = 1%)
    maintenanceMargin?: string;// 1e18 精度 (ETH)
    mmr?: string;              // 基点 (100 = 1%)
    roe?: string;              // 基点 (100 = 1%)
    realizedPnL?: string;      // 1e18 精度 (ETH)
    fundingFee?: string;       // 1e18 精度 (ETH)
    riskLevel?: "low" | "medium" | "high" | "critical";  // 风险等级
    isLiquidatable?: boolean;
    adlRanking?: number;
  }>
> {
  try {
    const response = await fetch(`${getApiUrl()}/api/user/${trader}/positions`);
    const data = await response.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.positions)) return data.positions;
    return [];
  } catch {
    return [];
  }
}

/**
 * Historical order type (completed/cancelled/expired)
 */
export interface HistoricalOrder extends OrderDetails {
  closeReason?: "filled" | "cancelled" | "expired" | "liquidated";
}

// 重新导出 PerpTradeRecord 以保持向后兼容
// 永续合约成交记录类型定义在 tradingDataStore.ts
export type { PerpTradeRecord };
/** @deprecated 使用 PerpTradeRecord 代替 */
export type TradeRecord = PerpTradeRecord;

/**
 * 获取历史订单 (已完成/已取消/已过期)
 */
export async function getOrderHistory(trader: Address, limit = 50): Promise<HistoricalOrder[]> {
  try {
    const response = await fetch(`${getApiUrl()}/api/user/${trader}/orders?limit=${limit}`);
    const data = await response.json();
    // Backend returns bare array, but handle wrapped format defensively
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.orders)) return data.orders;
    return [];
  } catch {
    return [];
  }
}

/**
 * 获取永续合约成交记录
 */
export async function getTradeHistory(trader: Address, limit = 50): Promise<PerpTradeRecord[]> {
  try {
    const response = await fetch(`${getApiUrl()}/api/user/${trader}/trades?limit=${limit}`);
    const data = await response.json();
    // Backend returns { success, trades, total } — extract the trades array
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.trades)) return data.trades;
    return [];
  } catch {
    return [];
  }
}

/**
 * 平仓请求
 * H-08 fix: 添加签名验证，防止任何人冒充 trader 平仓
 */
export async function requestClosePair(
  pairId: string,
  trader: Address,
  signature?: Hex
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const response = await fetch(`${getApiUrl()}/api/position/${pairId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trader, signature }),
    });
    return await response.json();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * 生成平仓签名消息
 * H-08: 用于签名平仓请求，防伪造
 */
export function getClosePairMessage(pairId: string, trader: Address): string {
  // BUGFIX: Backend uses trader.toLowerCase() in expected message (server.ts L8049),
  // so frontend must also lowercase to produce matching message for signature verification
  return `Close pair ${pairId} for ${trader.toLowerCase()}`;
}

// ============================================================
// Settlement Contract Functions (直接调用链上)
// ============================================================

export const SETTLEMENT_ABI = [
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "recipient", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "depositTo",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "getSupportedTokens",
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "token", type: "address" }],
    name: "isTokenSupported",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "token", type: "address" }],
    name: "getTokenDecimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "incrementNonce",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "pairId", type: "uint256" }],
    name: "closePair",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "pairId", type: "uint256" }],
    name: "liquidate",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserBalance",
    outputs: [
      { name: "available", type: "uint256" },
      { name: "locked", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "nonces",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "pairId", type: "uint256" }],
    name: "getPairedPosition",
    outputs: [
      {
        components: [
          { name: "pairId", type: "uint256" },
          { name: "longTrader", type: "address" },
          { name: "shortTrader", type: "address" },
          { name: "token", type: "address" },
          { name: "size", type: "uint256" },
          { name: "entryPrice", type: "uint256" },
          { name: "longCollateral", type: "uint256" },
          { name: "shortCollateral", type: "uint256" },
          { name: "longLeverage", type: "uint256" },
          { name: "shortLeverage", type: "uint256" },
          { name: "openTime", type: "uint256" },
          { name: "lastFundingSettled", type: "uint256" },
          { name: "accFundingLong", type: "int256" },
          { name: "accFundingShort", type: "int256" },
          { name: "status", type: "uint8" },
        ],
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserPairIds",
    outputs: [{ type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "pairId", type: "uint256" }],
    name: "getUnrealizedPnL",
    outputs: [
      { name: "longPnL", type: "int256" },
      { name: "shortPnL", type: "int256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "pairId", type: "uint256" }],
    name: "canLiquidate",
    outputs: [
      { name: "liquidateLong", type: "bool" },
      { name: "liquidateShort", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "depositWithPermit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ERC20 ABI for token operations
export const ERC20_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export default {
  signOrder,
  createMarketOrderParams,
  createLimitOrderParams,
  submitOrder,
  getUserNonce,
  getOrderBook,
  getUserOrders,
  cancelOrder,
  getUserPositions,
  requestClosePair,
  OrderType,
  SETTLEMENT_ABI,
  ERC20_ABI,
};
