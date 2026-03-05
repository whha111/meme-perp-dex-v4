/**
 * 中心化撮合引擎
 *
 * 核心流程：
 * 1. 用户签名订单 → 发送到撮合引擎
 * 2. 撮合引擎验证订单 → 加入订单簿
 * 3. 撮合配对（价格优先、时间优先）
 * 4. 定时批量提交到链上结算
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  parseEther,
  formatEther,
  encodeAbiParameters,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

// ============================================================
// Types
// ============================================================

export enum OrderType {
  MARKET = 0,
  LIMIT = 1,
}

export enum OrderStatus {
  PENDING = "PENDING",
  FILLED = "FILLED",
  PARTIALLY_FILLED = "PARTIALLY_FILLED",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
}

// 订单有效期类型 (参考 OKX/Binance)
export enum TimeInForce {
  GTC = "GTC",     // Good Till Cancel - 一直有效直到取消
  IOC = "IOC",     // Immediate Or Cancel - 立即成交或取消
  FOK = "FOK",     // Fill Or Kill - 全部成交或取消
  GTD = "GTD",     // Good Till Date - 指定时间前有效
}

// 订单来源
export enum OrderSource {
  API = "API",
  WEB = "WEB",
  APP = "APP",
}

export interface Order {
  // === 基本标识 ===
  id: string;                    // 系统订单ID
  clientOrderId?: string;        // 用户自定义订单ID (clOrdId)
  trader: Address;               // 交易者地址
  token: Address;                // 交易代币地址

  // === 订单参数 ===
  isLong: boolean;               // 多头/空头 (true=多, false=空)
  size: bigint;                  // Meme 代币数量 (1e18 精度) - 行业标准
  leverage: bigint;              // 杠杆倍数 (1-100x, 带 1e4 精度)
  price: bigint;                 // 订单价格 (1e12 精度, 0=市价单)
  orderType: OrderType;          // 订单类型 (市价/限价)
  timeInForce: TimeInForce;      // 有效期类型 (GTC/IOC/FOK/GTD)
  reduceOnly: boolean;           // 是否只减仓
  postOnly: boolean;             // P3: 是否只挂单 (Maker Only)

  // === 成交信息 ===
  status: OrderStatus;           // 订单状态
  filledSize: bigint;            // 已成交数量 (executedQty/accFillSz)
  avgFillPrice: bigint;          // 平均成交价格 (avgPrice/avgPx)
  totalFillValue: bigint;        // 累计成交金额 (cumQuote/fillNotionalUsd)

  // === 费用信息 ===
  fee: bigint;                   // 手续费金额
  feeCurrency: string;           // 手续费币种

  // === 保证金信息 ===
  margin: bigint;                // 占用保证金 (USD, 1e6 精度) - 统一稳定币计价
  collateral: bigint;            // 抵押品价值 (USD, 1e6 精度)

  // === 止盈止损 ===
  takeProfitPrice?: bigint;      // 止盈触发价 (tpTriggerPx)
  stopLossPrice?: bigint;        // 止损触发价 (slTriggerPx)
  takeProfitOrderId?: string;    // 止盈订单ID
  stopLossOrderId?: string;      // 止损订单ID

  // === 时间戳 ===
  createdAt: number;             // 创建时间 (cTime/time)
  updatedAt: number;             // 更新时间 (uTime/updateTime)
  lastFillTime?: number;         // 最后成交时间 (fillTime)

  // === 系统字段 ===
  deadline: bigint;              // 订单截止时间
  nonce: bigint;                 // 用户 nonce
  signature: Hex;                // 签名
  source: OrderSource;           // 订单来源 (API/WEB/APP)

  // === 成交明细 (最近一笔成交) ===
  lastFillPrice?: bigint;        // 最后成交价格 (fillPx)
  lastFillSize?: bigint;         // 最后成交数量 (fillSz)
  tradeId?: string;              // 最后成交ID (tradeId)
}

export interface Match {
  longOrder: Order;
  shortOrder: Order;
  matchPrice: bigint;
  matchSize: bigint;
  timestamp: number;
}

export interface OrderBookLevel {
  price: bigint;
  totalSize: bigint;
  orders: Order[];
}

// ============================================================
// Order Book
// ============================================================

// 价格变化回调类型 (事件驱动强平用)
export type PriceChangeCallback = (token: Address, oldPrice: bigint, newPrice: bigint) => void;

// 全局价格变化回调 (由 server.ts 注册)
let globalPriceChangeCallback: PriceChangeCallback | null = null;

/**
 * 注册全局价格变化回调 (事件驱动强平)
 * 当任何 token 价格变化时，立即触发回调检查强平
 */
export function registerPriceChangeCallback(callback: PriceChangeCallback): void {
  globalPriceChangeCallback = callback;
  console.log("[Engine] Price change callback registered for event-driven liquidation");
}

export class OrderBook {
  private token: Address;
  private longOrders: Map<string, Order> = new Map(); // orderId => Order
  private shortOrders: Map<string, Order> = new Map();
  private currentPrice: bigint = 0n;

  constructor(token: Address) {
    this.token = token;
  }

  /**
   * 设置当前价格 (触发事件驱动强平检查)
   * @param price 新价格 (1e12 精度)
   * @param skipCallback 是否跳过回调 (内部用，避免循环)
   */
  setCurrentPrice(price: bigint, skipCallback: boolean = false): void {
    const oldPrice = this.currentPrice;
    this.currentPrice = price;

    // 如果价格有实质变化且有注册回调，立即触发强平检查
    // 避免 oldPrice=0 的初始化情况触发不必要的检查
    if (!skipCallback && globalPriceChangeCallback && oldPrice > 0n && price !== oldPrice) {
      // 计算价格变化幅度 (basis points)
      const priceDelta = oldPrice > 0n
        ? Number((price > oldPrice ? price - oldPrice : oldPrice - price) * 10000n / oldPrice)
        : 0;

      // 价格变化超过 0.1% (10bp) 时触发强平检查
      // 这避免了微小波动导致的频繁检查
      if (priceDelta >= 10) {
        // 异步触发，不阻塞价格更新
        setImmediate(() => {
          globalPriceChangeCallback!(this.token, oldPrice, price);
        });
      }
    }
  }

  getCurrentPrice(): bigint {
    return this.currentPrice;
  }

  /**
   * 添加订单
   */
  addOrder(order: Order): void {
    // Compare normalized addresses (lowercase)
    if (order.token.toLowerCase() !== this.token.toLowerCase()) {
      throw new Error("Token mismatch");
    }

    if (order.isLong) {
      this.longOrders.set(order.id, order);
    } else {
      this.shortOrders.set(order.id, order);
    }

    console.log(
      `[OrderBook ${this.token.slice(0, 8)}] Added ${order.isLong ? "LONG" : "SHORT"} order: ` +
        `${formatEther(order.size)} @ ${order.price === 0n ? "MARKET" : formatEther(order.price)}`
    );
  }

  /**
   * 取消订单
   */
  cancelOrder(orderId: string): boolean {
    if (this.longOrders.has(orderId)) {
      const order = this.longOrders.get(orderId)!;
      order.status = OrderStatus.CANCELLED;
      this.longOrders.delete(orderId);
      return true;
    }
    if (this.shortOrders.has(orderId)) {
      const order = this.shortOrders.get(orderId)!;
      order.status = OrderStatus.CANCELLED;
      this.shortOrders.delete(orderId);
      return true;
    }
    return false;
  }

  /**
   * 获取排序后的多单（出价高的优先）
   */
  getSortedLongs(): Order[] {
    const orders = Array.from(this.longOrders.values()).filter(
      (o) => (o.status === OrderStatus.PENDING || o.status === OrderStatus.PARTIALLY_FILLED) && o.size > o.filledSize
    );

    return orders.sort((a, b) => {
      // 市价单优先
      if (a.price === 0n && b.price !== 0n) return -1;
      if (b.price === 0n && a.price !== 0n) return 1;
      // 价格高的优先
      if (a.price !== b.price) return Number(b.price - a.price);
      // 时间早的优先
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * 获取排序后的空单（要价低的优先）
   */
  getSortedShorts(): Order[] {
    const orders = Array.from(this.shortOrders.values()).filter(
      (o) => (o.status === OrderStatus.PENDING || o.status === OrderStatus.PARTIALLY_FILLED) && o.size > o.filledSize
    );

    return orders.sort((a, b) => {
      // 市价单优先
      if (a.price === 0n && b.price !== 0n) return -1;
      if (b.price === 0n && a.price !== 0n) return 1;
      // 价格低的优先
      if (a.price !== b.price) return Number(a.price - b.price);
      // 时间早的优先
      return a.createdAt - b.createdAt;
    });
  }

  /**
   * 获取订单簿深度
   */
  getDepth(levels: number = 10): { longs: OrderBookLevel[]; shorts: OrderBookLevel[] } {
    const aggregateLevels = (orders: Order[], isLong: boolean): OrderBookLevel[] => {
      const priceMap = new Map<string, OrderBookLevel>();

      for (const order of orders) {
        const priceKey = order.price.toString();
        if (!priceMap.has(priceKey)) {
          priceMap.set(priceKey, { price: order.price, totalSize: 0n, orders: [] });
        }
        const level = priceMap.get(priceKey)!;
        level.totalSize += order.size - order.filledSize;
        level.orders.push(order);
      }

      const result = Array.from(priceMap.values());
      if (isLong) {
        result.sort((a, b) => Number(b.price - a.price));
      } else {
        result.sort((a, b) => Number(a.price - b.price));
      }
      return result.slice(0, levels);
    };

    return {
      longs: aggregateLevels(this.getSortedLongs(), true),
      shorts: aggregateLevels(this.getSortedShorts(), false),
    };
  }

  /**
   * 清理过期订单
   */
  cleanupExpired(): void {
    const now = BigInt(Math.floor(Date.now() / 1000));

    for (const [id, order] of this.longOrders) {
      if (order.deadline < now) {
        order.status = OrderStatus.EXPIRED;
        this.longOrders.delete(id);
      }
    }

    for (const [id, order] of this.shortOrders) {
      if (order.deadline < now) {
        order.status = OrderStatus.EXPIRED;
        this.shortOrders.delete(id);
      }
    }
  }
}

// ============================================================
// Matching Engine
// ============================================================

// Trade record for history
export interface Trade {
  id: string;
  token: Address;
  price: bigint;
  size: bigint;
  side: "buy" | "sell"; // taker side
  timestamp: number;
  longTrader: Address;
  shortTrader: Address;
}

// K-line (candlestick) data
export interface Kline {
  timestamp: number;  // Start of interval
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  trades: number;
}

// Token statistics
export interface TokenStats {
  price: bigint;
  priceChange24h: bigint;  // Basis points (100 = 1%)
  high24h: bigint;
  low24h: bigint;
  volume24h: bigint;
  trades24h: number;
  openInterest: bigint;
  fundingRate: bigint;  // Basis points per 8 hours
  nextFundingTime: number;
}

// PriceFeed ABI for reading spot prices
const PRICE_FEED_ABI = [
  {
    name: "getTokenSpotPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getTokenMarkPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// TokenFactory ABI for reading current spot price from bonding curve
const TOKEN_FACTORY_ABI = [
  {
    name: "getCurrentPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenAddress", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export class MatchingEngine {
  private orderBooks: Map<Address, OrderBook> = new Map();
  private pendingMatches: Match[] = [];
  private allOrders: Map<string, Order> = new Map();
  private orderIdCounter = 0;
  private recentTrades: Map<Address, Trade[]> = new Map(); // token => trades
  private tradeIdCounter = 0;
  private maxTradesPerToken = 1000; // Keep last 1000 trades per token

  // K-line storage: token => interval => timestamp => kline
  private klines: Map<Address, Map<string, Map<number, Kline>>> = new Map();
  private klineIntervals = ["1m", "5m", "15m", "1h", "4h", "1d"];

  // Funding rate: token => rate (basis points per 8 hours)
  private fundingRates: Map<Address, bigint> = new Map();
  private lastFundingTime: Map<Address, number> = new Map();

  // Open interest tracking: token => total size
  private openInterest: Map<Address, bigint> = new Map();

  // 现货价格锚定：从 TokenFactory/PriceFeed 获取的现货价格
  private spotPrices: Map<Address, bigint> = new Map();
  private priceClient: ReturnType<typeof createPublicClient> | null = null;
  private priceFeedAddress: Address | null = null;
  private tokenFactoryAddress: Address | null = null;

  /**
   * 配置价格数据源（优先使用 TokenFactory 获取真实现货价格）
   */
  configurePriceSource(rpcUrl: string, tokenFactoryAddress: Address, priceFeedAddress?: Address): void {
    this.priceClient = createPublicClient({
      chain: bsc,
      transport: http(rpcUrl),
    });
    this.tokenFactoryAddress = tokenFactoryAddress;
    this.priceFeedAddress = priceFeedAddress || null;
    console.log(`[Engine] TokenFactory configured: ${tokenFactoryAddress}`);
    if (priceFeedAddress) {
      console.log(`[Engine] PriceFeed configured: ${priceFeedAddress}`);
    }
  }

  /**
   * 旧方法兼容
   */
  configurePriceFeed(rpcUrl: string, priceFeedAddress: Address): void {
    this.configurePriceSource(rpcUrl, "0xd05A38E6C2a39762De453D90a670ED0Af65ff2f8" as Address, priceFeedAddress);
  }

  // ETH 本位系统: 不再需要 ETH/USD 价格转换
  // TokenFactory 返回的 Token/ETH 价格直接使用

  /**
   * 从 TokenFactory 获取真实现货价格（Bonding Curve 价格）
   * ETH 本位系统: 价格直接使用 Token/ETH (1e18)，无需 USD 转换
   *
   * TokenFactory.getCurrentPrice() 返回 ETH per Token (1e18 精度)
   * 这个价格直接用于永续合约的标记价格
   */
  async fetchSpotPrice(token: Address): Promise<bigint> {
    const normalizedToken = token.toLowerCase() as Address;

    if (!this.priceClient) {
      console.warn("[Engine] Price client not configured");
      return this.spotPrices.get(normalizedToken) || 0n;
    }

    // 从 TokenFactory 获取真实现货价格 (Token/ETH)
    if (this.tokenFactoryAddress) {
      try {
        const spotPriceETH = await this.priceClient.readContract({
          address: this.tokenFactoryAddress,
          abi: TOKEN_FACTORY_ABI,
          functionName: "getCurrentPrice",
          args: [token],
        }) as bigint;

        if (spotPriceETH > 0n) {
          // ETH 本位: 直接使用 Token/ETH 价格 (1e18 精度)
          const oldPrice = this.spotPrices.get(normalizedToken) || 0n;
          this.spotPrices.set(normalizedToken, spotPriceETH);

          // 合约价格持续跟踪现货价格 (Oracle 模式)
          const orderBook = this.getOrderBook(normalizedToken);
          const currentContractPrice = orderBook.getCurrentPrice();

          if (spotPriceETH > 0n) {
            // 始终更新合约价格以跟踪现货
            orderBook.setCurrentPrice(spotPriceETH);

            // 更新 K 线数据 (即使没有永续交易，也要跟踪现货价格)
            this.updateKlineFromSpotPrice(normalizedToken, spotPriceETH);

            // 只在价格变化超过 0.1% 时打印日志
            if (currentContractPrice === 0n || Math.abs(Number(spotPriceETH - currentContractPrice)) > Number(currentContractPrice) / 1000) {
              const priceETH = Number(spotPriceETH) / 1e18;
              console.log(`[Spot] ${token.slice(0, 10)}: ${priceETH.toExponential(6)} ETH/Token`);
            }
          }
        }
        return this.spotPrices.get(normalizedToken) || 0n;
      } catch (e: any) {
        // TokenFactory 可能没有这个代币
        const errorMsg = e?.shortMessage || e?.message || "";
        if (!errorMsg.includes("execution reverted")) {
          console.error(`[Engine] TokenFactory price error:`, errorMsg.slice(0, 50));
        }
      }
    }

    // 回退到 PriceFeed (也返回 ETH 价格)
    if (this.priceFeedAddress) {
      try {
        const spotPriceETH = await this.priceClient.readContract({
          address: this.priceFeedAddress,
          abi: PRICE_FEED_ABI,
          functionName: "getTokenSpotPrice",
          args: [token],
        }) as bigint;

        if (spotPriceETH > 0n) {
          // ETH 本位: 直接使用 ETH 价格
          this.spotPrices.set(normalizedToken, spotPriceETH);

          // 合约价格持续跟踪现货价格
          const orderBook = this.getOrderBook(normalizedToken);
          orderBook.setCurrentPrice(spotPriceETH);
        }
        return this.spotPrices.get(normalizedToken) || 0n;
      } catch (e: any) {
        // 忽略 TokenNotSupported 错误
      }
    }

    return this.spotPrices.get(normalizedToken) || 0n;
  }

  /**
   * 获取缓存的现货价格（如果有）
   */
  getSpotPrice(token: Address): bigint {
    const normalizedToken = token.toLowerCase() as Address;
    return this.spotPrices.get(normalizedToken) || 0n;
  }

  /**
   * 设置现货价格（用于测试或外部同步）
   */
  setSpotPrice(token: Address, price: bigint): void {
    const normalizedToken = token.toLowerCase() as Address;
    this.spotPrices.set(normalizedToken, price);
  }

  /**
   * 获取或创建订单簿
   */
  getOrderBook(token: Address): OrderBook {
    // Normalize to lowercase for consistent lookups
    const normalizedToken = token.toLowerCase() as Address;
    if (!this.orderBooks.has(normalizedToken)) {
      this.orderBooks.set(normalizedToken, new OrderBook(normalizedToken));
    }
    return this.orderBooks.get(normalizedToken)!;
  }

  /**
   * 更新价格
   */
  updatePrice(token: Address, price: bigint): void {
    this.getOrderBook(token).setCurrentPrice(price);
  }

  /**
   * 生成订单ID
   * 格式: {用户后2位}{YYYYMMDD}{HHmmss}{3位序号}
   * 例: 2E20250205040435001
   *     ├─ 2E = trader 地址最后2个字符 (识别用户)
   *     ├─ 20250205 = 日期
   *     ├─ 040435 = 时分秒
   *     └─ 001 = 毫秒内序号 (防重复)
   */
  private generateOrderId(trader?: string): string {
    const now = new Date();
    const prefix = trader ? trader.slice(-2).toUpperCase() : "XX";
    const date = now.getFullYear().toString()
      + (now.getMonth() + 1).toString().padStart(2, "0")
      + now.getDate().toString().padStart(2, "0");
    const time = now.getHours().toString().padStart(2, "0")
      + now.getMinutes().toString().padStart(2, "0")
      + now.getSeconds().toString().padStart(2, "0");
    const seq = (++this.orderIdCounter % 1000).toString().padStart(3, "0");
    return `${prefix}${date}${time}${seq}`;
  }

  /**
   * 提交订单 (行业标准)
   *
   * 必需参数:
   * - trader: 交易者地址
   * - token: 代币地址
   * - isLong: 多/空
   * - size: 数量
   * - leverage: 杠杆
   * - price: 价格 (0=市价)
   * - deadline: 截止时间
   * - nonce: 用户nonce
   * - orderType: 订单类型
   * - signature: 签名
   *
   * 可选参数 (options):
   * - clientOrderId: 用户自定义订单ID (clOrdId)
   * - timeInForce: 有效期类型 (GTC/IOC/FOK/GTD)
   * - reduceOnly: 只减仓
   * - takeProfitPrice: 止盈价
   * - stopLossPrice: 止损价
   * - source: 订单来源 (API/WEB/APP)
   */
  submitOrder(
    trader: Address,
    token: Address,
    isLong: boolean,
    size: bigint,
    leverage: bigint,
    price: bigint,
    deadline: bigint,
    nonce: bigint,
    orderType: OrderType,
    signature: Hex,
    // 可选参数
    options?: {
      clientOrderId?: string;
      timeInForce?: TimeInForce;
      reduceOnly?: boolean;
      postOnly?: boolean;          // P3: 只挂单模式
      takeProfitPrice?: bigint;
      stopLossPrice?: bigint;
      source?: OrderSource;
    }
  ): { order: Order; matches: Match[]; rejected?: boolean; rejectReason?: string } {
    const now = Date.now();

    // 获取当前市场价格（用于市价单保证金计算）
    const orderBook = this.getOrderBook(token);
    const currentPrice = orderBook.getCurrentPrice();

    // ============================================================
    // 保证金计算 (ETH 本位, 1e18 精度)
    // ============================================================
    //
    // 行业标准公式: margin = notionalValue / leverage
    // 其中: notionalValue = size * price (名义价值)
    //
    // 精度说明 (ETH 本位):
    // - size: Token 数量 (1e18 精度)
    // - price: ETH/Token (1e18 精度)
    // - leverage: 杠杆倍数 (1e4 精度), 如 10x = 100000n
    // - margin: 保证金 (1e18 精度, ETH)
    //
    // 计算步骤:
    // notionalETH = size * price / 1e18 = ETH 名义价值 (1e18 精度)
    // margin = notionalETH * 10000 / leverage (1e18 精度)
    //
    // 示例:
    // - 用户开 0.1 ETH 仓位，10x 杠杆，保证金 = 0.01 ETH
    // - margin = 10000000000000000 (1e16 = 0.01 ETH)
    //
    // ============================================================

    const BASIS_POINTS_DIVISOR = 10000n;  // GMX 标准

    // Step 1: 确定价格 (ETH 本位)
    // - 市价单: price=0, 使用 currentPrice (1e18 精度)
    // - 限价单: price>0, 前端发送 1e18 精度
    const isMarketOrder = price === 0n;

    // M-29 FIX: 市价单在无历史价格时拒绝 (防止 0 价成交)
    if (isMarketOrder && currentPrice === 0n) {
      return {
        order: { id: "", trader, token, isLong, size, price: 0n, leverage, filledSize: 0n, status: "REJECTED" as any, createdAt: now, updatedAt: now, margin: 0n, source: params.source || "api" },
        matches: [],
        rejected: true,
        rejectReason: "Market orders require an established price. Submit a limit order first.",
      };
    }

    const priceETH = isMarketOrder ? currentPrice : price;  // 都是 1e18 精度

    // Step 2: 计算仓位的 ETH 价值 (名义价值)
    // notionalETH = size (tokens) * priceETH (ETH/token)
    //
    // 精度: 1e18 * 1e18 = 1e36, 需要除以 1e18 得到 1e18 精度
    const notionalETH = (size * priceETH) / (10n ** 18n);  // 结果是 1e18 精度的 ETH 值

    // Step 3: 计算保证金 (GMX 公式)
    // margin = notionalETH * BASIS_POINTS_DIVISOR / leverage
    //
    // leverage 是 1e4 精度 (10x = 100000)
    // 所以: margin = notionalETH * 10000 / leverage
    const margin = leverage > 0n
      ? (notionalETH * BASIS_POINTS_DIVISOR) / leverage
      : 0n;

    // DEBUG: 追踪保证金计算 (ETH 本位)
    console.log(`[Margin ETH] ==================`);
    console.log(`[Margin ETH] size (tokens): ${size} (${Number(size) / 1e18} tokens)`);
    console.log(`[Margin ETH] priceETH (1e18): ${priceETH} (${Number(priceETH) / 1e18} ETH/token)`);
    console.log(`[Margin ETH] notionalETH (1e18): ${notionalETH} (${Number(notionalETH) / 1e18} ETH)`);
    console.log(`[Margin ETH] leverage: ${leverage} (${Number(leverage) / 10000}x)`);
    console.log(`[Margin ETH] margin (1e18): ${margin} (${Number(margin) / 1e18} ETH)`);
    console.log(`[Margin ETH] ==================`);

    // 统一小写 — getUserOrders/getPendingOrdersLocked 全部用 lowercase 查询
    const normalizedTrader = trader.toLowerCase() as Address;
    const normalizedToken = token.toLowerCase() as Address;

    const order: Order = {
      // === 基本标识 ===
      id: this.generateOrderId(trader),
      clientOrderId: options?.clientOrderId,
      trader: normalizedTrader,
      token: normalizedToken,

      // === 订单参数 ===
      isLong,
      size,
      leverage,
      price,
      orderType,
      timeInForce: options?.timeInForce || TimeInForce.GTC,
      reduceOnly: options?.reduceOnly || false,
      postOnly: options?.postOnly || false,   // P3: 只挂单 (Maker Only)

      // === 成交信息 ===
      status: OrderStatus.PENDING,
      filledSize: 0n,
      avgFillPrice: 0n,
      totalFillValue: 0n,

      // === 费用信息 ===
      fee: 0n,
      feeCurrency: "ETH",  // ETH 本位系统

      // === 保证金信息 ===
      margin,
      collateral: margin,

      // === 止盈止损 ===
      takeProfitPrice: options?.takeProfitPrice,
      stopLossPrice: options?.stopLossPrice,

      // === 时间戳 ===
      createdAt: now,
      updatedAt: now,

      // === 系统字段 ===
      deadline,
      nonce,
      signature,
      source: options?.source || OrderSource.API,
    };

    this.allOrders.set(order.id, order);

    // ================================================================
    // P3: Post-Only 订单验证
    // Post-Only 订单只能作为 Maker (挂单)，不能立即成交
    // 如果会立即成交，则拒绝该订单
    // ================================================================
    if (order.postOnly) {
      // 市价单不能设置 Post-Only
      if (order.orderType === OrderType.MARKET || order.price === 0n) {
        console.log(`[PostOnly] Rejected: Market orders cannot be Post-Only`);
        order.status = OrderStatus.CANCELLED;
        return {
          order,
          matches: [],
          rejected: true,
          rejectReason: "Market orders cannot be Post-Only"
        };
      }

      // 检查是否会立即成交
      if (this.wouldImmediatelyMatch(order)) {
        console.log(`[PostOnly] Rejected: Order would immediately match`);
        order.status = OrderStatus.CANCELLED;
        return {
          order,
          matches: [],
          rejected: true,
          rejectReason: "Post-Only order would immediately match"
        };
      }

      console.log(`[PostOnly] Order ${order.id} accepted as Maker`);
    }

    // 尝试撮合
    const matches = this.tryMatch(order);

    // ================================================================
    // P3: IOC/FOK 订单处理
    // IOC (Immediate Or Cancel): 立即成交能成交的部分，剩余取消
    // FOK (Fill Or Kill): 必须全部成交，否则全部取消
    // ================================================================
    if (order.timeInForce === TimeInForce.IOC) {
      // IOC: 如果有未成交部分，取消剩余
      if (order.filledSize < order.size) {
        const unfilledSize = order.size - order.filledSize;
        console.log(`[IOC] Order ${order.id}: Filled ${order.filledSize}, cancelling remaining ${unfilledSize}`);

        if (order.filledSize === 0n) {
          order.status = OrderStatus.CANCELLED;
        } else {
          order.status = OrderStatus.FILLED; // 部分成交后标记完成
        }
        // 不加入订单簿
        return { order, matches };
      }
    } else if (order.timeInForce === TimeInForce.FOK) {
      // FOK: 如果不能全部成交，取消整个订单
      if (order.filledSize < order.size) {
        console.log(`[FOK] Order ${order.id}: Only filled ${order.filledSize}/${order.size}, rejecting entire order`);

        // 回滚成交 (这里简化处理，实际需要更复杂的回滚逻辑)
        // FOK 的正确实现应该是先检查能否全部成交，再执行
        // 这里我们返回 rejected 状态
        order.status = OrderStatus.CANCELLED;
        order.filledSize = 0n;
        order.avgFillPrice = 0n;
        order.totalFillValue = 0n;

        return {
          order,
          matches: [],
          rejected: true,
          rejectReason: "FOK order could not be fully filled"
        };
      }
    }

    // 如果订单未完全成交且是 GTC/GTD 类型，加入订单簿
    // 注意：部分成交的订单 (PARTIALLY_FILLED) 也需要加入订单簿等待后续撮合
    // 市价单也加入订单簿，让用户在"当前委托"中看到，用户可以自己决定是否撤销
    if (order.filledSize < order.size &&
        (order.status === OrderStatus.PENDING || order.status === OrderStatus.PARTIALLY_FILLED) &&
        (order.timeInForce === TimeInForce.GTC || order.timeInForce === TimeInForce.GTD)) {
      this.getOrderBook(token).addOrder(order);

      if (isMarketOrder) {
        console.log(`[Engine] Market order ${order.id} added to orderbook, waiting for counterparty (${order.filledSize}/${order.size})`);
      }
    }

    return { order, matches };
  }

  /**
   * 更新订单成交信息 (行业标准)
   * 计算加权平均价格、累计成交金额、手续费等
   *
   * @param isMaker true = 挂单方 (Maker, 0.02%), false = 吃单方 (Taker, 0.05%)
   */
  private updateOrderFillInfo(
    order: Order,
    fillPrice: bigint,
    fillSize: bigint,
    tradeId: string,
    isMaker: boolean = false
  ): void {
    const now = Date.now();

    // 计算之前的累计成交金额
    const previousFillValue = order.totalFillValue;
    const previousFillSize = order.filledSize;

    // 本次成交金额
    const currentFillValue = fillSize * fillPrice / (10n ** 18n);

    // 更新累计成交金额
    order.totalFillValue = previousFillValue + currentFillValue;

    // 更新已成交数量 (在调用此函数前已更新，这里重新计算用于平均价格)
    const newFilledSize = previousFillSize + fillSize;

    // 计算加权平均成交价格 (避免除零)
    if (newFilledSize > 0n) {
      // avgFillPrice = totalValue / totalSize
      order.avgFillPrice = (order.totalFillValue * (10n ** 18n)) / newFilledSize;
    }

    // 手续费: Maker 0.02%, Taker 0.05% (行业标准: 鼓励挂单提供流动性)
    const TAKER_FEE_RATE = 5n; // 0.05% = 5 / 10000
    const MAKER_FEE_RATE = 2n; // 0.02% = 2 / 10000
    const feeRate = isMaker ? MAKER_FEE_RATE : TAKER_FEE_RATE;
    const fillFee = currentFillValue * feeRate / 10000n;
    order.fee = order.fee + fillFee;

    // 更新最后成交信息
    order.lastFillPrice = fillPrice;
    order.lastFillSize = fillSize;
    order.lastFillTime = now;
    order.tradeId = tradeId;

    // 更新时间戳
    order.updatedAt = now;
  }

  /**
   * P3: 检查订单是否会立即成交
   * 用于 Post-Only 订单验证
   */
  private wouldImmediatelyMatch(order: Order): boolean {
    const orderBook = this.getOrderBook(order.token);
    const currentPrice = orderBook.getCurrentPrice();

    if (order.isLong) {
      // 做多单：检查是否有可匹配的空单
      const shorts = orderBook.getSortedShorts();
      for (const shortOrder of shorts) {
        const longPrice = order.price === 0n ? currentPrice : order.price;
        const shortPrice = shortOrder.price === 0n ? currentPrice : shortOrder.price;

        // 市价单总是会匹配
        if (order.price === 0n || shortOrder.price === 0n) {
          if (shorts.length > 0) return true;
        }

        // 做多出价 >= 做空要价 = 会成交
        if (longPrice >= shortPrice) {
          return true;
        }
      }
    } else {
      // 做空单：检查是否有可匹配的多单
      const longs = orderBook.getSortedLongs();
      for (const longOrder of longs) {
        const longPrice = longOrder.price === 0n ? currentPrice : longOrder.price;
        const shortPrice = order.price === 0n ? currentPrice : order.price;

        // 市价单总是会匹配
        if (order.price === 0n || longOrder.price === 0n) {
          if (longs.length > 0) return true;
        }

        // 做多出价 >= 做空要价 = 会成交
        if (longPrice >= shortPrice) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 尝试撮合订单
   */
  private tryMatch(incomingOrder: Order): Match[] {
    const matches: Match[] = [];
    const orderBook = this.getOrderBook(incomingOrder.token);
    const currentPrice = orderBook.getCurrentPrice();

    let remainingSize = incomingOrder.size - incomingOrder.filledSize;

    if (incomingOrder.isLong) {
      // 做多单：与做空单匹配
      const shorts = orderBook.getSortedShorts();

      for (const shortOrder of shorts) {
        if (remainingSize <= 0n) break;

        // 自我成交防护：同一 trader 的订单不能互相撮合
        if (shortOrder.trader.toLowerCase() === incomingOrder.trader.toLowerCase()) {
          continue;
        }

        // 检查价格是否匹配
        const longPrice = incomingOrder.price === 0n ? currentPrice : incomingOrder.price;
        const shortPrice = shortOrder.price === 0n ? currentPrice : shortOrder.price;

        // 做多出价 >= 做空要价 才能成交
        if (longPrice < shortPrice && incomingOrder.price !== 0n && shortOrder.price !== 0n) {
          continue;
        }

        // 计算成交数量
        const shortRemaining = shortOrder.size - shortOrder.filledSize;
        const matchSize = remainingSize < shortRemaining ? remainingSize : shortRemaining;

        // 计算成交价格（Maker价格优先：已在订单簿中的订单价格）
        const matchPrice = shortPrice;

        // M-29 FIX: 绝不在 0 价成交
        if (matchPrice === 0n) continue;

        // 创建配对
        const match: Match = {
          longOrder: incomingOrder,
          shortOrder: shortOrder,
          matchPrice,
          matchSize,
          timestamp: Date.now(),
        };

        // 生成成交ID
        const tradeId = `trade_${Date.now()}_${this.tradeIdCounter + 1}`;

        matches.push(match);
        this.pendingMatches.push(match);
        this.recordTrade(match); // Record trade immediately for real-time display

        // 更新成交量 (先更新，再计算平均价格)
        incomingOrder.filledSize += matchSize;
        shortOrder.filledSize += matchSize;
        remainingSize -= matchSize;

        // 更新订单详细成交信息 (行业标准)
        // incomingOrder = Taker (吃单), shortOrder = Maker (挂单)
        this.updateOrderFillInfo(incomingOrder, matchPrice, matchSize, tradeId, false);
        this.updateOrderFillInfo(shortOrder, matchPrice, matchSize, tradeId, true);

        // 更新订单状态
        if (shortOrder.filledSize >= shortOrder.size) {
          shortOrder.status = OrderStatus.FILLED;
        } else {
          shortOrder.status = OrderStatus.PARTIALLY_FILLED;
        }

        console.log(
          `[Match] LONG ${formatEther(matchSize)} @ ${formatEther(matchPrice)} ` +
            `(${incomingOrder.trader.slice(0, 8)} <-> ${shortOrder.trader.slice(0, 8)})`
        );
      }
    } else {
      // 做空单：与做多单匹配
      const longs = orderBook.getSortedLongs();

      for (const longOrder of longs) {
        if (remainingSize <= 0n) break;

        // 自我成交防护：同一 trader 的订单不能互相撮合
        if (longOrder.trader.toLowerCase() === incomingOrder.trader.toLowerCase()) {
          continue;
        }

        const longPrice = longOrder.price === 0n ? currentPrice : longOrder.price;
        const shortPrice = incomingOrder.price === 0n ? currentPrice : incomingOrder.price;

        if (longPrice < shortPrice && incomingOrder.price !== 0n && longOrder.price !== 0n) {
          continue;
        }

        const longRemaining = longOrder.size - longOrder.filledSize;
        const matchSize = remainingSize < longRemaining ? remainingSize : longRemaining;
        // Maker's price (existing order in book) determines match price
        const matchPrice = longPrice;

        // M-29 FIX: 绝不在 0 价成交
        if (matchPrice === 0n) continue;

        // 生成成交ID
        const tradeId = `trade_${Date.now()}_${this.tradeIdCounter + 1}`;

        const match: Match = {
          longOrder: longOrder,
          shortOrder: incomingOrder,
          matchPrice,
          matchSize,
          timestamp: Date.now(),
        };

        matches.push(match);
        this.pendingMatches.push(match);
        this.recordTrade(match); // Record trade immediately for real-time display

        // 更新成交量 (先更新，再计算平均价格)
        incomingOrder.filledSize += matchSize;
        longOrder.filledSize += matchSize;
        remainingSize -= matchSize;

        // 更新订单详细成交信息 (行业标准)
        // incomingOrder = Taker (吃单), longOrder = Maker (挂单)
        this.updateOrderFillInfo(incomingOrder, matchPrice, matchSize, tradeId, false);
        this.updateOrderFillInfo(longOrder, matchPrice, matchSize, tradeId, true);

        if (longOrder.filledSize >= longOrder.size) {
          longOrder.status = OrderStatus.FILLED;
        } else {
          longOrder.status = OrderStatus.PARTIALLY_FILLED;
        }

        console.log(
          `[Match] SHORT ${formatEther(matchSize)} @ ${formatEther(matchPrice)} ` +
            `(${longOrder.trader.slice(0, 8)} <-> ${incomingOrder.trader.slice(0, 8)})`
        );
      }
    }

    // 更新订单状态
    if (incomingOrder.filledSize >= incomingOrder.size) {
      incomingOrder.status = OrderStatus.FILLED;
    } else if (incomingOrder.filledSize > 0n) {
      incomingOrder.status = OrderStatus.PARTIALLY_FILLED;
    }

    return matches;
  }

  /**
   * 获取待提交的配对
   */
  getPendingMatches(): Match[] {
    return [...this.pendingMatches];
  }

  /**
   * 清空待提交队列
   * Note: Trades are recorded immediately when matched, not here
   */
  clearPendingMatches(): void {
    this.pendingMatches = [];
  }

  /**
   * 移除已结算的配对 (用于即时结算后清理，避免批量循环重复提交)
   */
  removePendingMatches(matchesToRemove: Match[]): void {
    const removeIds = new Set(
      matchesToRemove.map(m => `${m.longOrder.id}_${m.shortOrder.id}`)
    );
    this.pendingMatches = this.pendingMatches.filter(
      m => !removeIds.has(`${m.longOrder.id}_${m.shortOrder.id}`)
    );
  }

  /**
   * 回滚匹配 — 链上结算失败时撤销引擎内部状态变更
   *
   * 原理:
   *   OrderBook 的 longOrders/shortOrders Map 持有 Order 对象引用。
   *   tryMatch 只修改引用对象的 filledSize/status，不会从 Map 中删除。
   *   getSortedLongs/Shorts 过滤 filledSize >= size 的订单。
   *   因此只需还原 filledSize/status，对手方订单自动恢复可匹配。
   *   入场订单需要从 book + allOrders 中移除。
   */
  rollbackMatches(incomingOrder: Order, matches: Match[]): void {
    if (matches.length === 0) return;

    const token = incomingOrder.token.toLowerCase() as Address;
    const orderBook = this.getOrderBook(token);

    for (const match of matches) {
      // 识别对手方订单
      const isIncomingLong = incomingOrder.id === match.longOrder.id;
      const counterOrder = isIncomingLong ? match.shortOrder : match.longOrder;

      // 还原对手方 filledSize
      counterOrder.filledSize -= match.matchSize;
      if (counterOrder.filledSize < 0n) counterOrder.filledSize = 0n;

      // 还原对手方成交信息 (avgFillPrice, totalFillValue, fee)
      this.reverseOrderFillInfo(counterOrder, match.matchPrice, match.matchSize);

      // 还原对手方状态
      if (counterOrder.filledSize <= 0n) {
        counterOrder.status = OrderStatus.PENDING;
      } else {
        counterOrder.status = OrderStatus.PARTIALLY_FILLED;
      }
    }

    // 入场订单: 标记取消，从 book 和 allOrders 移除
    incomingOrder.status = OrderStatus.CANCELLED;
    incomingOrder.filledSize = 0n;
    incomingOrder.totalFillValue = 0n;
    incomingOrder.avgFillPrice = 0n;
    incomingOrder.fee = 0n;
    orderBook.cancelOrder(incomingOrder.id); // 从 book Map 中删除
    this.allOrders.delete(incomingOrder.id);

    // 从待结算队列移除
    this.removePendingMatches(matches);

    console.log(
      `[Engine] Rolled back ${matches.length} matches for order ${incomingOrder.id} ` +
      `(${matches.reduce((s, m) => s + Number(m.matchSize), 0)} total size)`
    );
  }

  /**
   * 撤销单次成交对订单成交信息的影响
   */
  private reverseOrderFillInfo(order: Order, fillPrice: bigint, fillSize: bigint): void {
    const FEE_RATE = 5n; // 0.05%
    const fillValue = (fillSize * fillPrice) / (10n ** 18n);

    order.totalFillValue -= fillValue;
    if (order.totalFillValue < 0n) order.totalFillValue = 0n;

    order.fee -= (fillValue * FEE_RATE) / 10000n;
    if (order.fee < 0n) order.fee = 0n;

    // 重新计算加权平均价格
    if (order.filledSize > 0n && order.totalFillValue > 0n) {
      order.avgFillPrice = (order.totalFillValue * (10n ** 18n)) / order.filledSize;
    } else {
      order.avgFillPrice = 0n;
      order.totalFillValue = 0n;
      order.fee = 0n;
    }

    order.updatedAt = Date.now();
  }

  /**
   * 记录成交
   */
  private recordTrade(match: Match): void {
    const normalizedToken = match.longOrder.token.toLowerCase() as Address;
    const trade: Trade = {
      id: `trade_${Date.now()}_${++this.tradeIdCounter}`,
      token: normalizedToken,
      price: match.matchPrice,
      size: match.matchSize,
      side: match.longOrder.createdAt > match.shortOrder.createdAt ? "buy" : "sell",
      timestamp: match.timestamp,
      longTrader: match.longOrder.trader,
      shortTrader: match.shortOrder.trader,
    };

    const tokenTrades = this.recentTrades.get(normalizedToken) || [];
    tokenTrades.push(trade);

    // Keep only recent trades
    if (tokenTrades.length > this.maxTradesPerToken) {
      tokenTrades.shift();
    }

    this.recentTrades.set(normalizedToken, tokenTrades);

    // Update K-line data
    this.updateKline(trade);

    // Update open interest
    const currentOI = this.openInterest.get(normalizedToken) || 0n;
    this.openInterest.set(normalizedToken, currentOI + match.matchSize);

    // ⚠️ Meme 永续合约架构: 合约成交不影响 Mark Price
    // Mark Price 只来源于现货 AMM (syncSpotPrices)
    // 原因: Meme 代币流动性浅，如果合约成交能改价格，
    //       大户可以用小资金操控价格触发恶意强平
    //
    // 价格来源: syncSpotPrices() → AMM.getSpotPrice() → OrderBook.setCurrentPrice()
    //
    // 已删除: this.getOrderBook(normalizedToken).setCurrentPrice(match.matchPrice);
  }

  /**
   * 获取最近成交记录
   */
  getRecentTrades(token: Address, limit = 100): Trade[] {
    const normalizedToken = token.toLowerCase() as Address;
    const trades = this.recentTrades.get(normalizedToken) || [];
    return trades.slice(-limit).reverse(); // Most recent first
  }

  /**
   * 获取订单
   */
  getOrder(orderId: string): Order | undefined {
    return this.allOrders.get(orderId);
  }

  /**
   * 获取用户订单
   */
  getUserOrders(trader: Address): Order[] {
    const normalized = trader.toLowerCase();
    return Array.from(this.allOrders.values()).filter((o) => o.trader === normalized);
  }

  /**
   * 取消订单
   */
  cancelOrder(orderId: string, trader: Address): boolean {
    const order = this.allOrders.get(orderId);
    if (!order || order.trader !== trader.toLowerCase()) return false;
    if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.PARTIALLY_FILLED) {
      return false;
    }

    return this.getOrderBook(order.token).cancelOrder(orderId);
  }

  /**
   * 清理过期订单
   */
  cleanupExpired(): void {
    for (const orderBook of this.orderBooks.values()) {
      orderBook.cleanupExpired();
    }
  }

  /**
   * Update K-line data from a trade
   */
  private updateKline(trade: Trade): void {
    this.updateKlineFromPrice(trade.token, trade.price, trade.size, trade.timestamp);
  }

  /**
   * Update K-line data from spot price (called when spot price changes)
   * This ensures K-lines are updated even without perpetual trades
   */
  updateKlineFromSpotPrice(token: Address, price: bigint): void {
    this.updateKlineFromPrice(token, price, 0n, Date.now());
  }

  /**
   * Internal K-line update function
   */
  private updateKlineFromPrice(token: Address, price: bigint, volume: bigint, timestamp: number): void {
    const normalizedToken = token.toLowerCase() as Address;

    if (!this.klines.has(normalizedToken)) {
      this.klines.set(normalizedToken, new Map());
    }
    const tokenKlines = this.klines.get(normalizedToken)!;

    for (const interval of this.klineIntervals) {
      const intervalMs = this.getIntervalMs(interval);
      const klineTime = Math.floor(timestamp / intervalMs) * intervalMs;

      if (!tokenKlines.has(interval)) {
        tokenKlines.set(interval, new Map());
      }
      const intervalKlines = tokenKlines.get(interval)!;

      if (!intervalKlines.has(klineTime)) {
        intervalKlines.set(klineTime, {
          timestamp: klineTime,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: volume,
          trades: volume > 0n ? 1 : 0,
        });
      } else {
        const kline = intervalKlines.get(klineTime)!;
        if (price > kline.high) kline.high = price;
        if (price < kline.low) kline.low = price;
        kline.close = price;
        if (volume > 0n) {
          kline.volume += volume;
          kline.trades++;
        }
      }

      // Keep only last 500 klines per interval
      if (intervalKlines.size > 500) {
        const times = Array.from(intervalKlines.keys()).sort((a, b) => a - b);
        for (let i = 0; i < times.length - 500; i++) {
          intervalKlines.delete(times[i]);
        }
      }
    }
  }

  private getIntervalMs(interval: string): number {
    const units: Record<string, number> = {
      "1m": 60 * 1000,
      "5m": 5 * 60 * 1000,
      "15m": 15 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "4h": 4 * 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000,
    };
    return units[interval] || 60 * 1000;
  }

  /**
   * Get K-line data for a token
   */
  getKlines(token: Address, interval: string, limit: number = 100): Kline[] {
    const normalizedToken = token.toLowerCase() as Address;
    const tokenKlines = this.klines.get(normalizedToken);
    if (!tokenKlines) return [];

    const intervalKlines = tokenKlines.get(interval);
    if (!intervalKlines) return [];

    const klines = Array.from(intervalKlines.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);

    return klines;
  }

  /**
   * Get token statistics
   */
  getStats(token: Address): TokenStats {
    const normalizedToken = token.toLowerCase() as Address;
    const orderBook = this.getOrderBook(normalizedToken);
    const currentPrice = orderBook.getCurrentPrice();
    const trades = this.recentTrades.get(normalizedToken) || [];

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Filter 24h trades
    const trades24h = trades.filter(t => t.timestamp >= oneDayAgo);

    let high24h = currentPrice;
    let low24h = currentPrice;
    let volume24h = 0n;
    let priceChange24h = 0n;

    if (trades24h.length > 0) {
      high24h = trades24h.reduce((max, t) => t.price > max ? t.price : max, trades24h[0].price);
      low24h = trades24h.reduce((min, t) => t.price < min ? t.price : min, trades24h[0].price);
      volume24h = trades24h.reduce((sum, t) => sum + t.size, 0n);

      // Calculate price change (first trade 24h ago vs current)
      const firstPrice = trades24h[0].price;
      if (firstPrice > 0n) {
        priceChange24h = ((currentPrice - firstPrice) * 10000n) / firstPrice;
      }
    }

    const fundingRate = this.fundingRates.get(normalizedToken) || 0n;
    const lastFunding = this.lastFundingTime.get(normalizedToken) || now;
    const nextFundingTime = lastFunding + 8 * 60 * 60 * 1000; // 8 hours

    return {
      price: currentPrice,
      priceChange24h,
      high24h,
      low24h,
      volume24h,
      trades24h: trades24h.length,
      openInterest: this.openInterest.get(normalizedToken) || 0n,
      fundingRate,
      nextFundingTime,
    };
  }

  /**
   * Update funding rate for a token
   */
  updateFundingRate(token: Address, rate: bigint): void {
    const normalizedToken = token.toLowerCase() as Address;
    this.fundingRates.set(normalizedToken, rate);
    this.lastFundingTime.set(normalizedToken, Date.now());
  }

  /**
   * Get funding rate for a token
   */
  getFundingRate(token: Address): { rate: bigint; nextFundingTime: number } {
    const normalizedToken = token.toLowerCase() as Address;
    const rate = this.fundingRates.get(normalizedToken) || 0n;
    const lastFunding = this.lastFundingTime.get(normalizedToken) || Date.now();
    const nextFundingTime = lastFunding + 8 * 60 * 60 * 1000;
    return { rate, nextFundingTime };
  }

  /**
   * 计算资金费率 (Binance 行业标准)
   *
   * Binance 公式:
   * 1. Premium Index (P) = (Contract Price - Spot Price) / Spot Price
   * 2. Interest Rate (I) = 0.01% per 8 hours (固定)
   * 3. Funding Rate (F) = P + clamp(I - P, -0.05%, 0.05%)
   *
   * clamp 函数确保资金费率不会偏离 Premium 太多
   * - 正资金费率：合约价格 > 现货价格，多头付给空头
   * - 负资金费率：合约价格 < 现货价格，空头付给多头
   *
   * @param token 代币地址
   * @returns 资金费率 (basis points per 8 hours, 100 = 1%)
   */
  calculateFundingRate(token: Address): bigint {
    const normalizedToken = token.toLowerCase() as Address;
    const orderBook = this.getOrderBook(normalizedToken);

    // 获取合约价格（订单簿最新成交价）
    const contractPrice = orderBook.getCurrentPrice();
    if (contractPrice === 0n) {
      console.log(`[Funding] No contract price for ${token.slice(0, 10)}`);
      return 0n;
    }

    // 获取现货价格
    const spotPrice = this.spotPrices.get(normalizedToken) || 0n;
    if (spotPrice === 0n) {
      console.log(`[Funding] No spot price for ${token.slice(0, 10)}, using imbalance method`);
      return this.calculateFundingRateByImbalance(token);
    }

    // Step 1: 计算 Premium Index (P)
    // P = (contractPrice - spotPrice) / spotPrice
    // 使用 10000 作为基数，结果单位是 basis points (0.01% = 1, 1% = 100)
    const premium = ((contractPrice - spotPrice) * 10000n) / spotPrice;

    // Step 2: Interest Rate (I) = 0.01% = 1 basis point (固定)
    const INTEREST_RATE = 1n; // 0.01% per 8 hours

    // Step 3: clamp(I - P, -5, 5) 其中 5 = 0.05%
    const CLAMP_MAX = 5n;  // 0.05%
    const CLAMP_MIN = -5n; // -0.05%
    let clampValue = INTEREST_RATE - premium;
    if (clampValue > CLAMP_MAX) clampValue = CLAMP_MAX;
    if (clampValue < CLAMP_MIN) clampValue = CLAMP_MIN;

    // Step 4: Funding Rate = P + clamp(I - P, -0.05%, 0.05%)
    let rate = premium + clampValue;

    // 限制最大资金费率 (Binance: ±0.75% for 25x or below, ±3% otherwise)
    // 我们使用 ±0.75% = ±75 basis points
    const MAX_RATE = 75n;
    if (rate > MAX_RATE) rate = MAX_RATE;
    if (rate < -MAX_RATE) rate = -MAX_RATE;

    this.fundingRates.set(normalizedToken, rate);
    this.lastFundingTime.set(normalizedToken, Date.now());

    console.log(`[Funding] Token ${token.slice(0, 10)}: contract=${contractPrice}, spot=${spotPrice}, premium=${premium}bp, rate=${rate}bp`);

    return rate;
  }

  /**
   * 基于订单簿不平衡计算资金费率（备用方法）
   */
  private calculateFundingRateByImbalance(token: Address): bigint {
    const normalizedToken = token.toLowerCase() as Address;
    const orderBook = this.getOrderBook(normalizedToken);
    const depth = orderBook.getDepth(10);

    let longVolume = 0n;
    let shortVolume = 0n;

    for (const level of depth.longs) {
      longVolume += level.totalSize;
    }
    for (const level of depth.shorts) {
      shortVolume += level.totalSize;
    }

    let rate = 0n;
    const total = longVolume + shortVolume;
    if (total > 0n) {
      const imbalance = ((longVolume - shortVolume) * 10000n) / total;
      rate = imbalance / 100n;
    }

    // 限制最大资金费率
    const MAX_RATE = 75n;
    if (rate > MAX_RATE) rate = MAX_RATE;
    if (rate < -MAX_RATE) rate = -MAX_RATE;

    this.fundingRates.set(normalizedToken, rate);
    this.lastFundingTime.set(normalizedToken, Date.now());

    return rate;
  }

  /**
   * 获取所有支持的代币
   */
  getSupportedTokens(): Address[] {
    return Array.from(this.orderBooks.keys());
  }
}

// ============================================================
// Spot Price Updater (原 SettlementSubmitter，Mode 2 精简版)
// ============================================================
// Mode 2: 仅保留现货价格更新功能
// 永续交易的 submitBatch/closePair 已移除

export class SettlementSubmitter {
  private client: ReturnType<typeof createPublicClient>;
  private walletClient: ReturnType<typeof createWalletClient>;
  private settlementAddress: Address;

  constructor(rpcUrl: string, matcherPrivateKey: Hex, settlementAddress: Address) {
    this.client = createPublicClient({
      chain: bsc,
      transport: http(rpcUrl),
    });

    const account = privateKeyToAccount(matcherPrivateKey);
    this.walletClient = createWalletClient({
      account,
      chain: bsc,
      transport: http(rpcUrl),
    });

    this.settlementAddress = settlementAddress;
  }

  /**
   * 更新链上价格 (PriceFeed 合约，现货交易用)
   */
  async updatePrice(token: Address, price: bigint): Promise<Hex | null> {
    try {
      const hash = await this.walletClient.writeContract({
        address: this.settlementAddress,
        abi: PRICE_UPDATE_ABI,
        functionName: "updatePrice",
        args: [token, price],
      });
      return hash;
    } catch (e) {
      console.error("[PriceUpdater] Failed to update price:", e);
      return null;
    }
  }
}

// ============================================================
// ABI (精简版 - 价格更新写入)
// ============================================================

const PRICE_UPDATE_ABI = [
  {
    inputs: [{ name: "token", type: "address" }, { name: "price", type: "uint256" }],
    name: "updatePrice",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ============================================================
// Export
// ============================================================

export default {
  OrderBook,
  MatchingEngine,
  SettlementSubmitter,
  OrderType,
  OrderStatus,
  registerPriceChangeCallback,
};
