/**
 * Redis 数据库层
 *
 * 核心表:
 * 1. positions - 仓位风控表
 * 2. orders - 订单撮合表
 * 3. user_vaults - 链上资金镜像
 * 4. settlement_logs - 结算审计表
 * 5. market_stats - 市场统计
 */

import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import type { Address } from "viem";
import { REDIS_URL, REDIS_KEY_PREFIX, REDIS_SENTINEL_HOSTS, REDIS_MASTER_NAME, REDIS_PASSWORD } from "../config";
import { logger } from "../utils/logger";
import {
  type Position,
  type Order,
  type UserBalance,
  type SettlementLog,
  type MarketStats,
  type PositionStatus,
  OrderStatus,
  type RiskLevel,
  MarginMode,
} from "../types";

// ============================================================
// Redis Client
// ============================================================

let redis: Redis | null = null;
let isConnected = false;

export function getRedisClient(): Redis {
  if (!redis) {
    if (REDIS_SENTINEL_HOSTS) {
      // Sentinel 高可用模式
      const sentinels = REDIS_SENTINEL_HOSTS.split(",").map((hostPort) => {
        const [host, port] = hostPort.trim().split(":");
        return { host, port: parseInt(port || "26379") };
      });
      redis = new Redis({
        sentinels,
        name: REDIS_MASTER_NAME,
        keyPrefix: REDIS_KEY_PREFIX,
        password: REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
        commandTimeout: 5000,
        sentinelRetryStrategy: (times: number) => Math.min(times * 100, 3000),
      });
      logger.info("Redis", `Sentinel mode: master="${REDIS_MASTER_NAME}", sentinels=${REDIS_SENTINEL_HOSTS}`);
    } else {
      // 单节点模式 (开发/测试)
      redis = new Redis(REDIS_URL, {
        keyPrefix: REDIS_KEY_PREFIX,
        password: REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: 3,
        connectTimeout: 3000,
        commandTimeout: 5000,
      });
      logger.info("Redis", `Standalone mode: ${REDIS_URL}`);
    }

    redis.on("connect", () => {
      logger.info("Redis", "Connected");
      isConnected = true;
    });

    redis.on("ready", () => {
      logger.info("Redis", "Ready");
      isConnected = true;
    });

    redis.on("error", (err) => {
      logger.error("Redis", "Connection error:", err.message);
      isConnected = false;
    });

    redis.on("close", () => {
      logger.info("Redis", "Connection closed");
      isConnected = false;
    });
  }
  return redis;
}

export async function connectRedis(): Promise<boolean> {
  try {
    const client = getRedisClient();
    await client.ping();
    logger.info("Redis", "Connection verified");
    isConnected = true;
    return true;
  } catch (error: any) {
    logger.warn("Redis", "Failed to connect:", error.message);
    isConnected = false;
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    isConnected = false;
  }
}

export function isRedisConnected(): boolean {
  return isConnected && redis !== null && redis.status === "ready";
}

// ============================================================
// 安全的 BigInt 解析 (防止精度丢失和崩溃)
// ============================================================

export function safeBigInt(value: unknown, fallback = 0n): bigint {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fallback;
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return fallback;
    // 处理科学计数法
    if (trimmed.includes("e") || trimmed.includes("E")) {
      const num = parseFloat(trimmed);
      if (!Number.isFinite(num)) return fallback;
      return BigInt(Math.floor(num));
    }
    // 处理小数 (截断)
    if (trimmed.includes(".")) {
      const [intPart] = trimmed.split(".");
      if (!intPart || intPart === "-") return fallback;
      try {
        return BigInt(intPart);
      } catch {
        return fallback;
      }
    }
    try {
      return BigInt(trimmed);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

// ============================================================
// 分布式锁 (防止竞争条件)
// ============================================================

// Lua 脚本: 只释放自己的锁 (CAS)
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export async function withLock<T>(
  lockKey: string,
  ttlMs: number,
  fn: () => Promise<T>,
  retries = 3,
  retryDelayMs = 100
): Promise<T> {
  const client = getRedisClient();
  const fullKey = `lock:${lockKey}`;
  const lockValue = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    // 尝试获取锁 (SET NX PX)
    const acquired = await client.set(fullKey, lockValue, "PX", ttlMs, "NX");

    if (acquired === "OK") {
      try {
        return await fn();
      } finally {
        // 使用 Lua 脚本安全释放锁 (Redis 原子操作，非 JS eval)
        await client.call("EVAL", RELEASE_LOCK_SCRIPT, 1, fullKey, lockValue).catch((err) => {
          logger.warn("Redis", `Lock release failed for ${fullKey}: ${err}`);
        });
      }
    }

    // 等待重试
    if (attempt < retries - 1) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }

  throw new Error(`Failed to acquire lock: ${lockKey} after ${retries} attempts`);
}

// 非阻塞锁 (获取失败不重试，直接返回 null)
export async function tryLock<T>(
  lockKey: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T | null> {
  try {
    return await withLock(lockKey, ttlMs, fn, 1, 0);
  } catch {
    return null;
  }
}

// ============================================================
// Key Generators
// ============================================================

export const Keys = {
  // Lock keys (分布式锁)
  lock: (resource: string) => `lock:${resource}`,
  balanceLock: (user: Address) => `lock:balance:${user.toLowerCase()}`,
  orderLock: (orderId: string) => `lock:order:${orderId}`,

  // Position keys
  position: (id: string) => `position:${id}`,
  userPositions: (user: Address) => `user:${user.toLowerCase()}:positions`,
  tokenPositions: (token: Address) => `token:${token.toLowerCase()}:positions`,
  allPositions: () => "positions:all",

  // Order keys
  order: (id: string) => `order:${id}`,
  userOrders: (user: Address) => `user:${user.toLowerCase()}:orders`,
  tokenOrders: (token: Address) => `token:${token.toLowerCase()}:orders`,
  pendingOrders: (token: Address) => `token:${token.toLowerCase()}:orders:pending`,
  symbolPendingOrders: (symbol: string) => `symbol:${symbol}:orders:pending`,

  // Trade keys (perpetual)
  trade: (id: string) => `perp:trade:${id}`,
  userTrades: (user: Address) => `user:${user.toLowerCase()}:perp_trades`,
  tokenTrades: (token: Address) => `token:${token.toLowerCase()}:perp_trades`,

  // User balance keys
  userBalance: (user: Address) => `balance:${user.toLowerCase()}`,

  // Settlement log keys
  settlementLog: (id: string) => `settlement:${id}`,
  userSettlements: (user: Address) => `user:${user.toLowerCase()}:settlements`,

  // Market stats keys
  marketStats: (token: Address) => `market:${token.toLowerCase()}:stats`,
  fundingIndex: (token: Address) => `market:${token.toLowerCase()}:funding_index`,

  // Trigger price keys (for TP/SL/Liquidation)
  triggerLong: (token: Address) => `trigger:long:${token.toLowerCase()}`,
  triggerShort: (token: Address) => `trigger:short:${token.toLowerCase()}`,
  liquidationLong: (token: Address) => `liquidation:long:${token.toLowerCase()}`,
  liquidationShort: (token: Address) => `liquidation:short:${token.toLowerCase()}`,

  // Session keys
  session: (sessionId: string) => `session:${sessionId}`,
  userSessions: (user: Address) => `user:${user.toLowerCase()}:sessions`,

  // Wallet keys
  wallet: (user: Address) => `wallet:${user.toLowerCase()}`,
  allWallets: () => "wallets:derived:all",

  // Order margin info keys (保证金记账，必须持久化)
  orderMargin: (orderId: string) => `order_margin:${orderId}`,
  allOrderMargins: () => "order_margins:all",

  // Mode 2 PnL adjustments (链下盈亏调整，必须持久化)
  mode2Adjustment: (user: Address) => `mode2_adj:${user.toLowerCase()}`,
  allMode2Adjustments: () => "mode2_adj:all",

  // Pending withdrawal mode2 deductions (链上确认前的待回滚记录)
  pendingWithdrawalMode2: (id: string) => `pending_wd_mode2:${id}`,
  allPendingWithdrawalMode2: () => "pending_wd_mode2:all",

  // Auth nonce keys (防重放攻击，必须持久化)
  userNonce: (user: Address) => `nonce:${user.toLowerCase()}`,
  allUserNonces: () => "nonces:all",

  // Insurance fund keys (保险基金，必须持久化)
  insuranceFundGlobal: () => "insurance_fund:global",
  insuranceFundToken: (token: Address) => `insurance_fund:token:${token.toLowerCase()}`,
  allInsuranceFundTokens: () => "insurance_fund:tokens:all",

  // Funding state keys (资金费状态，必须持久化 — 重启恢复)
  fundingState: (token: Address) => `funding:state:${token.toLowerCase()}`,
  allFundingTokens: () => "funding:tokens:all",

  // Referral keys (推荐系统，必须持久化 — 推荐关系 + 佣金累计)
  referrer: (address: Address) => `referral:referrer:${address.toLowerCase()}`,
  allReferrers: () => "referral:referrers:all",
  referee: (address: Address) => `referral:referee:${address.toLowerCase()}`,
  allReferees: () => "referral:referees:all",
  referralCode: (code: string) => `referral:code:${code.toUpperCase()}`,
  allReferralCodes: () => "referral:codes:all",
};

// ============================================================
// Position Repository
// ============================================================

export const PositionRepo = {
  async create(data: Omit<Position, "id" | "createdAt" | "updatedAt">): Promise<Position> {
    const client = getRedisClient();
    const id = uuidv4();
    const now = Date.now();

    const position: Position = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
    };

    const key = Keys.position(id);
    await client.hset(key, serializePosition(position));

    // Add to indexes
    await client.sadd(Keys.userPositions(data.trader), id);
    await client.sadd(Keys.tokenPositions(data.token), id);
    await client.sadd(Keys.allPositions(), id);

    // Add to liquidation trigger ZSet
    // 注意: ZSet score 是 64位浮点数，最大安全整数 ~9e15
    // 价格精度 1e12，降为 1e6 存储防止精度丢失 (支持价格到 $9,000,000,000)
    // ⚠️ liquidationPrice 可能是 bigint 或 string (server.ts 传 string)
    const liqPrice = safeBigInt(position.liquidationPrice);
    if (liqPrice > 0n) {
      const liqPriceScaled = Number(liqPrice / 1_000_000n);
      const triggerKey = position.isLong
        ? Keys.liquidationLong(data.token)
        : Keys.liquidationShort(data.token);
      await client.zadd(triggerKey, liqPriceScaled, id);
    }

    logger.info("Redis", `Position created: ${id}`);
    return position;
  },

  async get(id: string): Promise<Position | null> {
    const client = getRedisClient();
    const data = await client.hgetall(Keys.position(id));
    if (!data || Object.keys(data).length === 0) return null;
    return deserializePosition(data);
  },

  async update(id: string, updates: Partial<Position>): Promise<Position | null> {
    const client = getRedisClient();
    const key = Keys.position(id);

    const exists = await client.exists(key);
    if (!exists) return null;

    const serialized = serializePartialPosition(updates);
    serialized.updatedAt = Date.now().toString();
    await client.hset(key, serialized);

    // Update liquidation trigger if price changed (1e6 scaled)
    // ⚠️ updates.liquidationPrice 可能是 bigint 或 string
    if (updates.liquidationPrice !== undefined) {
      const position = await this.get(id);
      if (position) {
        const liqPrice = safeBigInt(updates.liquidationPrice);
        const liqPriceScaled = Number(liqPrice / 1_000_000n);
        const triggerKey = position.isLong
          ? Keys.liquidationLong(position.token)
          : Keys.liquidationShort(position.token);
        await client.zadd(triggerKey, liqPriceScaled, id);
      }
    }

    return this.get(id);
  },

  async delete(id: string): Promise<boolean> {
    const client = getRedisClient();
    const position = await this.get(id);
    if (!position) return false;

    // Remove from indexes
    await client.srem(Keys.userPositions(position.trader), id);
    await client.srem(Keys.tokenPositions(position.token), id);
    await client.srem(Keys.allPositions(), id);

    // Remove from liquidation triggers
    await client.zrem(Keys.liquidationLong(position.token), id);
    await client.zrem(Keys.liquidationShort(position.token), id);

    await client.del(Keys.position(id));
    logger.info("Redis", `Position deleted: ${id}`);
    return true;
  },

  async getByUser(trader: Address): Promise<Position[]> {
    if (!isRedisConnected()) return [];
    try {
      const client = getRedisClient();
      const ids = await client.smembers(Keys.userPositions(trader));
      if (ids.length === 0) return [];

      const positions = await Promise.all(ids.map(id => this.get(id)));
      return positions.filter((p): p is Position => p !== null);
    } catch {
      return [];
    }
  },

  async getByToken(token: Address): Promise<Position[]> {
    if (!isRedisConnected()) return [];
    try {
      const client = getRedisClient();
      const ids = await client.smembers(Keys.tokenPositions(token));
      if (ids.length === 0) return [];

      const positions = await Promise.all(ids.map(id => this.get(id)));
      return positions.filter((p): p is Position => p !== null);
    } catch {
      return [];
    }
  },

  async getAll(): Promise<Position[]> {
    if (!isRedisConnected()) return [];
    try {
      const client = getRedisClient();
      const ids = await client.smembers(Keys.allPositions());
      if (ids.length === 0) return [];

      const positions = await Promise.all(ids.map(id => this.get(id)));
      return positions.filter((p): p is Position => p !== null);
    } catch {
      return [];
    }
  },

  /**
   * 获取强平候选仓位
   * @param token 代币地址
   * @param currentPrice 当前价格 (1e12 精度，内部会缩放为 1e6)
   */
  async getLiquidationCandidates(token: Address, currentPrice: number): Promise<Position[]> {
    const client = getRedisClient();
    // ZSet 存储的是 1e6 精度，需要同步缩放
    const priceScaled = Math.floor(currentPrice / 1_000_000);

    // 多头: 当前价 <= 强平价 (查找强平价 >= 当前价的仓位)
    const longIds = await client.zrangebyscore(
      Keys.liquidationLong(token),
      priceScaled,
      "+inf"
    );

    // 空头: 当前价 >= 强平价 (查找强平价 <= 当前价的仓位)
    const shortIds = await client.zrangebyscore(
      Keys.liquidationShort(token),
      "-inf",
      priceScaled
    );

    const allIds = [...longIds, ...shortIds];
    if (allIds.length === 0) return [];

    const positions = await Promise.all(allIds.map(id => this.get(id)));
    return positions.filter((p): p is Position => p !== null && !p.isLiquidating);
  },

  async batchUpdateRisk(updates: Array<{ id: string; data: Partial<Position> }>): Promise<void> {
    if (!isRedisConnected() || updates.length === 0) return;
    try {
      const client = getRedisClient();
      const pipeline = client.pipeline();

      for (const { id, data } of updates) {
        const serialized = serializePartialPosition(data);
        serialized.updatedAt = Date.now().toString();
        pipeline.hset(Keys.position(id), serialized);
      }

      await pipeline.exec();
    } catch {
      // Silently ignore Redis errors during batch update
    }
  },
};

// ============================================================
// Order Repository
// ============================================================

export const OrderRepo = {
  async create(data: Omit<Order, "createdAt" | "updatedAt">): Promise<Order> {
    const client = getRedisClient();
    const now = Date.now();

    const order: Order = {
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    const key = Keys.order(data.id);
    await client.hset(key, serializeOrder(order));

    await client.sadd(Keys.userOrders(data.trader), data.id);
    await client.sadd(Keys.tokenOrders(data.token), data.id);

    if (data.status === OrderStatus.PENDING || data.status === OrderStatus.PARTIALLY_FILLED) {
      await client.sadd(Keys.pendingOrders(data.token), data.id);
    }

    // Add to trigger ZSet for conditional orders (1e6 scaled to prevent precision loss)
    if (data.triggerPrice && data.triggerPrice > 0n) {
      const triggerKey = data.isLong
        ? Keys.triggerLong(data.token)
        : Keys.triggerShort(data.token);
      const triggerPriceScaled = Number(data.triggerPrice / 1_000_000n);
      await client.zadd(triggerKey, triggerPriceScaled, data.id);
    }

    logger.info("Redis", `Order created: ${data.id}`);
    return order;
  },

  async get(id: string): Promise<Order | null> {
    const client = getRedisClient();
    const data = await client.hgetall(Keys.order(id));
    if (!data || Object.keys(data).length === 0) return null;
    return deserializeOrder(data);
  },

  async update(id: string, updates: Partial<Order>): Promise<Order | null> {
    const client = getRedisClient();
    const key = Keys.order(id);

    const exists = await client.exists(key);
    if (!exists) return null;

    const oldOrder = await this.get(id);
    const serialized = serializePartialOrder(updates);
    serialized.updatedAt = Date.now().toString();
    await client.hset(key, serialized);

    // Update pending orders index
    if (updates.status !== undefined && oldOrder) {
      const isPending = updates.status === OrderStatus.PENDING || updates.status === OrderStatus.PARTIALLY_FILLED;
      const wasPending = oldOrder.status === OrderStatus.PENDING || oldOrder.status === OrderStatus.PARTIALLY_FILLED;

      if (isPending && !wasPending) {
        await client.sadd(Keys.pendingOrders(oldOrder.token), id);
      } else if (!isPending && wasPending) {
        await client.srem(Keys.pendingOrders(oldOrder.token), id);
      }
    }

    return this.get(id);
  },

  async getByUser(trader: Address, status?: OrderStatus): Promise<Order[]> {
    const client = getRedisClient();
    const ids = await client.smembers(Keys.userOrders(trader));
    if (ids.length === 0) return [];

    const orders = await Promise.all(ids.map(id => this.get(id)));
    const filtered = orders.filter((o): o is Order => o !== null);

    if (status !== undefined) {
      return filtered.filter(o => o.status === status);
    }
    return filtered;
  },

  async getPendingByToken(token: Address): Promise<Order[]> {
    const client = getRedisClient();
    const ids = await client.smembers(Keys.pendingOrders(token));
    if (ids.length === 0) return [];

    const orders = await Promise.all(ids.map(id => this.get(id)));
    return orders.filter((o): o is Order => o !== null);
  },

  /**
   * 获取触发的条件单
   * @param token 代币地址
   * @param currentPrice 当前价格 (1e12 精度，内部会缩放为 1e6)
   */
  async getTriggeredOrders(token: Address, currentPrice: number): Promise<Order[]> {
    const client = getRedisClient();
    // ZSet 存储的是 1e6 精度
    const priceScaled = Math.floor(currentPrice / 1_000_000);

    const longIds = await client.zrangebyscore(
      Keys.triggerLong(token),
      priceScaled,
      "+inf"
    );

    const shortIds = await client.zrangebyscore(
      Keys.triggerShort(token),
      "-inf",
      priceScaled
    );

    const allIds = [...longIds, ...shortIds];
    if (allIds.length === 0) return [];

    const orders = await Promise.all(allIds.map(id => this.get(id)));
    return orders.filter((o): o is Order =>
      o !== null && (o.status === OrderStatus.PENDING || o.status === OrderStatus.PARTIALLY_FILLED)
    );
  },

  async removeFromTrigger(order: Order): Promise<void> {
    const client = getRedisClient();
    const triggerKey = order.isLong
      ? Keys.triggerLong(order.token)
      : Keys.triggerShort(order.token);
    await client.zrem(triggerKey, order.id);
  },
};

// ============================================================
// Balance Repository
// ============================================================

export const BalanceRepo = {
  async getOrCreate(trader: Address): Promise<UserBalance> {
    const defaultBalance: UserBalance = {
      trader: trader.toLowerCase() as Address,
      walletBalance: 0n,
      frozenMargin: 0n,
      usedMargin: 0n,
      unrealizedPnL: 0n,
      availableBalance: 0n,
      equity: 0n,
      lastSyncBlock: 0n,
      lastSyncTime: Date.now(),
    };

    if (!isRedisConnected()) {
      return defaultBalance;
    }

    try {
      const client = getRedisClient();
      const key = Keys.userBalance(trader);
      const data = await client.hgetall(key);

      if (data && Object.keys(data).length > 0) {
        return deserializeBalance(data, trader);
      }

      await client.hset(key, serializeBalance(defaultBalance));
      return defaultBalance;
    } catch {
      return defaultBalance;
    }
  },

  async update(trader: Address, updates: Partial<UserBalance>): Promise<UserBalance> {
    const client = getRedisClient();
    const key = Keys.userBalance(trader);
    await client.hset(key, serializePartialBalance(updates));
    return this.getOrCreate(trader);
  },

  async freezeMargin(trader: Address, amount: bigint): Promise<boolean> {
    // P0-2: 使用 try/catch 防止 update 失败导致 margin 双花
    try {
      const balance = await this.getOrCreate(trader);
      if (balance.availableBalance < amount) {
        return false;
      }

      await this.update(trader, {
        availableBalance: balance.availableBalance - amount,
        frozenMargin: balance.frozenMargin + amount,
      });
      return true;
    } catch (err) {
      logger.error("Redis", `freezeMargin failed for ${trader} (${amount}): ${err}`);
      return false; // 失败时拒绝冻结，防止双花
    }
  },

  async unfreezeMargin(trader: Address, amount: bigint): Promise<void> {
    const balance = await this.getOrCreate(trader);
    const toUnfreeze = amount > balance.frozenMargin ? balance.frozenMargin : amount;

    await this.update(trader, {
      availableBalance: balance.availableBalance + toUnfreeze,
      frozenMargin: balance.frozenMargin - toUnfreeze,
    });
  },

  async syncFromChain(trader: Address, walletBalance: bigint, blockNumber: bigint): Promise<void> {
    await this.update(trader, {
      walletBalance,
      lastSyncBlock: blockNumber,
      lastSyncTime: Date.now(),
    });
  },
};

// ============================================================
// Settlement Log Repository
// ============================================================

export const SettlementLogRepo = {
  async create(data: Omit<SettlementLog, "id" | "createdAt">): Promise<SettlementLog> {
    const client = getRedisClient();
    const id = uuidv4();
    const now = Date.now();

    const log: SettlementLog = {
      ...data,
      id,
      createdAt: now,
    };

    const key = Keys.settlementLog(id);
    await client.hset(key, serializeSettlementLog(log));

    await client.lpush(Keys.userSettlements(data.userAddress), id);
    await client.ltrim(Keys.userSettlements(data.userAddress), 0, 999);

    return log;
  },

  async updateStatus(id: string, onChainStatus: SettlementLog["onChainStatus"], txHash?: string): Promise<void> {
    const client = getRedisClient();
    const updates: Record<string, string> = { onChainStatus };
    if (txHash) updates.txHash = txHash;
    await client.hset(Keys.settlementLog(id), updates);
  },

  async getByUser(trader: Address, limit = 100): Promise<SettlementLog[]> {
    const client = getRedisClient();
    const ids = await client.lrange(Keys.userSettlements(trader), 0, limit - 1);
    if (ids.length === 0) return [];

    const logs = await Promise.all(ids.map(async (id) => {
      const data = await client.hgetall(Keys.settlementLog(id));
      if (!data || Object.keys(data).length === 0) return null;
      return deserializeSettlementLog(data);
    }));

    return logs.filter((l): l is SettlementLog => l !== null);
  },
};

// ============================================================
// Trade Repository (Perpetual Trades)
// ============================================================

export interface PerpTrade {
  id: string;
  orderId: string;
  pairId: string;
  token: Address;
  trader: Address;
  isLong: boolean;
  isMaker: boolean;
  size: string;          // bigint as string
  price: string;         // bigint as string
  fee: string;           // bigint as string
  realizedPnL: string;   // bigint as string
  timestamp: number;
  type: "normal" | "liquidation" | "adl" | "close";
}

export const TradeRepo = {
  async create(data: Omit<PerpTrade, "id">): Promise<PerpTrade> {
    if (!isRedisConnected()) {
      return { ...data, id: uuidv4() };
    }

    const client = getRedisClient();
    const id = uuidv4();

    const trade: PerpTrade = {
      ...data,
      id,
    };

    const key = Keys.trade(id);
    await client.hset(key, {
      id: trade.id,
      orderId: trade.orderId,
      pairId: trade.pairId,
      token: trade.token,
      trader: trade.trader,
      isLong: trade.isLong.toString(),
      isMaker: trade.isMaker.toString(),
      size: trade.size,
      price: trade.price,
      fee: trade.fee,
      realizedPnL: trade.realizedPnL,
      timestamp: trade.timestamp.toString(),
      type: trade.type,
    });

    // Set TTL (30 days)
    await client.expire(key, 30 * 24 * 60 * 60);

    // Add to user trades list (sorted by timestamp)
    await client.zadd(Keys.userTrades(trade.trader), trade.timestamp, id);

    // Add to token trades list
    await client.zadd(Keys.tokenTrades(trade.token), trade.timestamp, id);

    // Trim to keep only last 1000 trades per user/token
    await client.zremrangebyrank(Keys.userTrades(trade.trader), 0, -1001);
    await client.zremrangebyrank(Keys.tokenTrades(trade.token), 0, -1001);

    logger.info("Redis", `Trade created: ${id} for ${trade.trader.slice(0, 8)}`);
    return trade;
  },

  async get(id: string): Promise<PerpTrade | null> {
    if (!isRedisConnected()) return null;

    const client = getRedisClient();
    const data = await client.hgetall(Keys.trade(id));
    if (!data || Object.keys(data).length === 0) return null;

    return {
      id: data.id,
      orderId: data.orderId,
      pairId: data.pairId,
      token: data.token as Address,
      trader: data.trader as Address,
      isLong: data.isLong === "true",
      isMaker: data.isMaker === "true",
      size: data.size,
      price: data.price,
      fee: data.fee,
      realizedPnL: data.realizedPnL,
      timestamp: parseInt(data.timestamp || "0"),
      type: data.type as PerpTrade["type"],
    };
  },

  async getByUser(trader: Address, limit = 50): Promise<PerpTrade[]> {
    if (!isRedisConnected()) return [];

    try {
      const client = getRedisClient();
      const ids = await client.zrevrange(Keys.userTrades(trader), 0, limit - 1);
      if (ids.length === 0) return [];

      const trades = await Promise.all(ids.map((id) => this.get(id)));
      return trades.filter((t): t is PerpTrade => t !== null);
    } catch {
      return [];
    }
  },

  async getByToken(token: Address, limit = 100): Promise<PerpTrade[]> {
    if (!isRedisConnected()) return [];

    try {
      const client = getRedisClient();
      const ids = await client.zrevrange(Keys.tokenTrades(token), 0, limit - 1);
      if (ids.length === 0) return [];

      const trades = await Promise.all(ids.map((id) => this.get(id)));
      return trades.filter((t): t is PerpTrade => t !== null);
    } catch {
      return [];
    }
  },
};

// ============================================================
// Market Stats Repository
// ============================================================

export const MarketStatsRepo = {
  async getOrCreate(token: Address): Promise<MarketStats> {
    const client = getRedisClient();
    const key = Keys.marketStats(token);
    const data = await client.hgetall(key);

    if (data && Object.keys(data).length > 0) {
      return deserializeMarketStats(data, token);
    }

    const stats: MarketStats = {
      token,
      symbol: `${token.slice(0, 8)}-USDT`,
      lastPrice: 0n,
      markPrice: 0n,
      indexPrice: 0n,
      high24h: 0n,
      low24h: 0n,
      volume24h: 0n,
      openInterestLong: 0n,
      openInterestShort: 0n,
      fundingRate: 0n,
      nextFundingTime: Date.now() + 8 * 60 * 60 * 1000,
      updatedAt: Date.now(),
    };

    await client.hset(key, serializeMarketStats(stats));
    return stats;
  },

  async update(token: Address, updates: Partial<MarketStats>): Promise<void> {
    const client = getRedisClient();
    const serialized = serializePartialMarketStats(updates);
    serialized.updatedAt = Date.now().toString();
    await client.hset(Keys.marketStats(token), serialized);
  },

  async updateFundingIndex(token: Address, fundingRate: bigint): Promise<void> {
    const client = getRedisClient();
    const now = Date.now();
    await client.hset(Keys.marketStats(token), {
      fundingRate: fundingRate.toString(),
      nextFundingTime: (now + 8 * 60 * 60 * 1000).toString(),
      updatedAt: now.toString(),
    });
  },
};

// ============================================================
// Serialization Helpers
// ============================================================

function serializePosition(pos: Position): Record<string, string> {
  // ✅ 使用 ?? 防御 undefined/null，避免 .toString() 在缺失字段上 crash
  return {
    id: pos.id,
    pairId: pos.pairId,
    trader: pos.trader,
    token: pos.token,
    // 旧格式兼容 (双写)
    userAddress: pos.trader,
    symbol: `${pos.token}-ETH`,
    counterparty: pos.counterparty || "",
    isLong: String(pos.isLong ?? false),
    size: String(pos.size ?? "0"),
    entryPrice: String(pos.entryPrice ?? "0"),
    averageEntryPrice: String(pos.averageEntryPrice ?? pos.entryPrice ?? "0"),
    leverage: String(pos.leverage ?? "1"),
    marginMode: String(pos.marginMode ?? 0),  // 保证金模式 (0=ISOLATED, 1=CROSS)
    markPrice: String(pos.markPrice ?? "0"),
    liquidationPrice: String(pos.liquidationPrice ?? "0"),
    bankruptcyPrice: String(pos.bankruptcyPrice ?? "0"),
    breakEvenPrice: String(pos.breakEvenPrice ?? pos.entryPrice ?? "0"),
    collateral: String(pos.collateral ?? "0"),
    margin: String(pos.margin ?? "0"),
    marginRatio: String(pos.marginRatio ?? "10000"),
    mmr: String(pos.mmr ?? "200"),
    maintenanceMargin: String(pos.maintenanceMargin ?? "0"),
    unrealizedPnL: String(pos.unrealizedPnL ?? "0"),
    realizedPnL: String(pos.realizedPnL ?? "0"),
    roe: String(pos.roe ?? "0"),
    accumulatedFunding: String(pos.accumulatedFunding ?? (pos as any).accFundingFee ?? "0"),
    takeProfitPrice: pos.takeProfitPrice?.toString() || "",
    stopLossPrice: pos.stopLossPrice?.toString() || "",
    adlRanking: String(pos.adlRanking ?? 1),
    adlScore: String(pos.adlScore ?? "0"),
    riskLevel: pos.riskLevel || "low",
    isLiquidatable: String(pos.isLiquidatable ?? false),
    isAdlCandidate: String(pos.isAdlCandidate ?? false),
    status: String(pos.status ?? 0),
    fundingIndex: String(pos.fundingIndex ?? "0"),
    isLiquidating: String(pos.isLiquidating ?? false),
    createdAt: String(pos.createdAt ?? Date.now()),
    updatedAt: String(pos.updatedAt ?? Date.now()),
  };
}

function serializePartialPosition(pos: Partial<Position>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(pos)) {
    if (value !== undefined && value !== null) {
      result[key] = typeof value === "bigint" ? value.toString() : String(value);
    }
  }
  return result;
}

function deserializePosition(data: Record<string, string>): Position {
  // 兼容旧格式: userAddress → trader, symbol → token (去掉 -ETH 后缀)
  const trader = (data.trader || data.userAddress || "") as Address;
  const token = (data.token || (data.symbol ? data.symbol.replace("-ETH", "") : "")) as Address;
  const pairId = data.pairId || data.id || "";

  return {
    id: data.id,
    pairId,
    trader,
    token,
    counterparty: data.counterparty as Address,
    // 兼容旧格式: side=LONG/SHORT → isLong
    isLong: data.isLong !== undefined ? data.isLong === "true" : data.side === "LONG",
    size: safeBigInt(data.size),
    entryPrice: safeBigInt(data.entryPrice),
    averageEntryPrice: safeBigInt(data.averageEntryPrice),
    leverage: safeBigInt(data.leverage),
    marginMode: parseInt(data.marginMode || "0") as MarginMode,
    markPrice: safeBigInt(data.markPrice),
    liquidationPrice: safeBigInt(data.liquidationPrice),
    bankruptcyPrice: safeBigInt(data.bankruptcyPrice),
    breakEvenPrice: safeBigInt(data.breakEvenPrice),
    // 兼容旧格式: initialMargin → collateral
    collateral: safeBigInt(data.collateral || data.initialMargin),
    margin: safeBigInt(data.margin || data.initialMargin),
    marginRatio: safeBigInt(data.marginRatio),
    mmr: safeBigInt(data.mmr),
    maintenanceMargin: safeBigInt(data.maintenanceMargin || data.maintMargin),
    unrealizedPnL: safeBigInt(data.unrealizedPnL),
    realizedPnL: safeBigInt(data.realizedPnL),
    roe: safeBigInt(data.roe),
    accumulatedFunding: safeBigInt(data.accumulatedFunding),
    takeProfitPrice: data.takeProfitPrice ? safeBigInt(data.takeProfitPrice) : null,
    stopLossPrice: data.stopLossPrice ? safeBigInt(data.stopLossPrice) : null,
    adlRanking: parseInt(data.adlRanking || "1"),
    adlScore: safeBigInt(data.adlScore),
    riskLevel: (data.riskLevel || "low") as RiskLevel,
    isLiquidatable: data.isLiquidatable === "true",
    isAdlCandidate: data.isAdlCandidate === "true",
    status: parseInt(data.status || "0") as PositionStatus,
    fundingIndex: safeBigInt(data.fundingIndex),
    isLiquidating: data.isLiquidating === "true",
    createdAt: parseInt(data.createdAt || "0"),
    updatedAt: parseInt(data.updatedAt || "0"),
  };
}

function serializeOrder(order: Order): Record<string, string> {
  return {
    id: order.id,
    orderId: order.orderId,
    clientOrderId: order.clientOrderId || "",
    trader: order.trader,
    token: order.token,
    isLong: order.isLong.toString(),
    size: order.size.toString(),
    price: order.price.toString(),
    leverage: order.leverage.toString(),
    margin: order.margin.toString(),
    fee: order.fee.toString(),
    orderType: order.orderType.toString(),
    timeInForce: order.timeInForce,
    reduceOnly: order.reduceOnly.toString(),
    postOnly: order.postOnly.toString(),
    filledSize: order.filledSize.toString(),
    avgFillPrice: order.avgFillPrice.toString(),
    totalFillValue: order.totalFillValue.toString(),
    takeProfitPrice: order.takeProfitPrice?.toString() || "",
    stopLossPrice: order.stopLossPrice?.toString() || "",
    triggerPrice: order.triggerPrice?.toString() || "",
    status: order.status.toString(),
    source: order.source,
    signature: order.signature,
    deadline: order.deadline.toString(),
    nonce: order.nonce.toString(),
    createdAt: order.createdAt.toString(),
    updatedAt: order.updatedAt.toString(),
    lastFillTime: order.lastFillTime?.toString() || "",
  };
}

function serializePartialOrder(order: Partial<Order>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(order)) {
    if (value !== undefined && value !== null) {
      result[key] = typeof value === "bigint" ? value.toString() : String(value);
    }
  }
  return result;
}

function deserializeOrder(data: Record<string, string>): Order {
  return {
    id: data.id,
    orderId: data.orderId,
    clientOrderId: data.clientOrderId || undefined,
    trader: data.trader as Address,
    token: data.token as Address,
    isLong: data.isLong === "true",
    size: safeBigInt(data.size),
    price: safeBigInt(data.price),
    leverage: safeBigInt(data.leverage),
    margin: safeBigInt(data.margin),
    fee: safeBigInt(data.fee),
    orderType: parseInt(data.orderType || "0"),
    timeInForce: (data.timeInForce || "GTC") as Order["timeInForce"],
    reduceOnly: data.reduceOnly === "true",
    postOnly: data.postOnly === "true",
    filledSize: safeBigInt(data.filledSize),
    avgFillPrice: safeBigInt(data.avgFillPrice),
    totalFillValue: safeBigInt(data.totalFillValue),
    takeProfitPrice: data.takeProfitPrice ? safeBigInt(data.takeProfitPrice) : undefined,
    stopLossPrice: data.stopLossPrice ? safeBigInt(data.stopLossPrice) : undefined,
    triggerPrice: data.triggerPrice ? safeBigInt(data.triggerPrice) : undefined,
    status: parseInt(data.status || "0"),
    source: (data.source || "API") as Order["source"],
    signature: data.signature as `0x${string}`,
    deadline: safeBigInt(data.deadline),
    nonce: safeBigInt(data.nonce),
    createdAt: parseInt(data.createdAt || "0"),
    updatedAt: parseInt(data.updatedAt || "0"),
    lastFillTime: data.lastFillTime ? parseInt(data.lastFillTime) : undefined,
  };
}

function serializeBalance(balance: UserBalance): Record<string, string> {
  return {
    trader: balance.trader,
    walletBalance: balance.walletBalance.toString(),
    frozenMargin: balance.frozenMargin.toString(),
    usedMargin: balance.usedMargin.toString(),
    unrealizedPnL: balance.unrealizedPnL.toString(),
    availableBalance: balance.availableBalance.toString(),
    equity: balance.equity.toString(),
    lastSyncBlock: balance.lastSyncBlock.toString(),
    lastSyncTime: balance.lastSyncTime.toString(),
  };
}

function serializePartialBalance(balance: Partial<UserBalance>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(balance)) {
    if (value !== undefined && value !== null) {
      result[key] = typeof value === "bigint" ? value.toString() : String(value);
    }
  }
  return result;
}

function deserializeBalance(data: Record<string, string>, trader: Address): UserBalance {
  return {
    trader: trader.toLowerCase() as Address,
    walletBalance: BigInt(data.walletBalance || "0"),
    frozenMargin: BigInt(data.frozenMargin || "0"),
    usedMargin: BigInt(data.usedMargin || "0"),
    unrealizedPnL: BigInt(data.unrealizedPnL || "0"),
    availableBalance: BigInt(data.availableBalance || "0"),
    equity: BigInt(data.equity || "0"),
    lastSyncBlock: BigInt(data.lastSyncBlock || "0"),
    lastSyncTime: parseInt(data.lastSyncTime || "0"),
  };
}

function serializeSettlementLog(log: SettlementLog): Record<string, string> {
  return {
    id: log.id,
    txHash: log.txHash || "",
    userAddress: log.userAddress,
    type: log.type,
    amount: log.amount.toString(),
    balanceBefore: log.balanceBefore.toString(),
    balanceAfter: log.balanceAfter.toString(),
    onChainStatus: log.onChainStatus,
    proofData: log.proofData,
    positionId: log.positionId || "",
    orderId: log.orderId || "",
    createdAt: log.createdAt.toString(),
  };
}

function deserializeSettlementLog(data: Record<string, string>): SettlementLog {
  return {
    id: data.id,
    txHash: data.txHash ? (data.txHash as `0x${string}`) : null,
    userAddress: data.userAddress as Address,
    type: data.type as SettlementLog["type"],
    amount: BigInt(data.amount || "0"),
    balanceBefore: BigInt(data.balanceBefore || "0"),
    balanceAfter: BigInt(data.balanceAfter || "0"),
    onChainStatus: data.onChainStatus as SettlementLog["onChainStatus"],
    proofData: data.proofData,
    positionId: data.positionId || undefined,
    orderId: data.orderId || undefined,
    createdAt: parseInt(data.createdAt || "0"),
  };
}

function serializeMarketStats(stats: MarketStats): Record<string, string> {
  return {
    token: stats.token,
    symbol: stats.symbol,
    lastPrice: stats.lastPrice.toString(),
    markPrice: stats.markPrice.toString(),
    indexPrice: stats.indexPrice.toString(),
    high24h: stats.high24h.toString(),
    low24h: stats.low24h.toString(),
    volume24h: stats.volume24h.toString(),
    openInterestLong: stats.openInterestLong.toString(),
    openInterestShort: stats.openInterestShort.toString(),
    fundingRate: stats.fundingRate.toString(),
    nextFundingTime: stats.nextFundingTime.toString(),
    updatedAt: stats.updatedAt.toString(),
  };
}

function serializePartialMarketStats(stats: Partial<MarketStats>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value !== undefined && value !== null) {
      result[key] = typeof value === "bigint" ? value.toString() : String(value);
    }
  }
  return result;
}

function deserializeMarketStats(data: Record<string, string>, token: Address): MarketStats {
  return {
    token,
    symbol: data.symbol || `${token.slice(0, 8)}-USDT`,
    lastPrice: BigInt(data.lastPrice || "0"),
    markPrice: BigInt(data.markPrice || "0"),
    indexPrice: BigInt(data.indexPrice || "0"),
    high24h: BigInt(data.high24h || "0"),
    low24h: BigInt(data.low24h || "0"),
    volume24h: BigInt(data.volume24h || "0"),
    openInterestLong: BigInt(data.openInterestLong || "0"),
    openInterestShort: BigInt(data.openInterestShort || "0"),
    fundingRate: BigInt(data.fundingRate || "0"),
    nextFundingTime: parseInt(data.nextFundingTime || "0"),
    updatedAt: parseInt(data.updatedAt || "0"),
  };
}

// ============================================================
// Wallet Repository
// ============================================================

export const WalletRepo = {
  /**
   * 添加派生钱包到追踪列表
   */
  async addDerivedWallet(derivedAddress: Address): Promise<void> {
    if (!isRedisConnected()) return;
    const client = getRedisClient();
    await client.sadd(Keys.allWallets(), derivedAddress.toLowerCase());
  },

  /**
   * 获取所有已知的派生钱包地址
   */
  async getAllDerivedWallets(): Promise<Address[]> {
    if (!isRedisConnected()) return [];
    const client = getRedisClient();
    const wallets = await client.smembers(Keys.allWallets());
    return wallets as Address[];
  },

  /**
   * 检查地址是否是已知的派生钱包
   */
  async isDerivedWallet(address: Address): Promise<boolean> {
    if (!isRedisConnected()) return false;
    const client = getRedisClient();
    return (await client.sismember(Keys.allWallets(), address.toLowerCase())) === 1;
  },
};

// ============================================================
// Order Margin Info Repository (保证金记账持久化)
// TTL: 7天 (足够处理任何交易周期，防止内存溢出)
// ============================================================

const ORDER_MARGIN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export const OrderMarginRepo = {
  async save(orderId: string, info: {
    margin: string;
    fee: string;
    totalDeducted: string;
    totalSize: string;
    settledSize: string;
    trader: string;
  }): Promise<void> {
    if (!isRedisConnected()) return;
    const client = getRedisClient();
    const key = Keys.orderMargin(orderId);
    await client.hset(key, { ...info, createdAt: Date.now().toString() });
    await client.expire(key, ORDER_MARGIN_TTL_SECONDS);
    await client.sadd(Keys.allOrderMargins(), orderId);
  },

  async get(orderId: string): Promise<{
    margin: bigint;
    fee: bigint;
    totalDeducted: bigint;
    totalSize: bigint;
    settledSize: bigint;
    trader: string;
  } | null> {
    if (!isRedisConnected()) return null;
    const client = getRedisClient();
    const data = await client.hgetall(Keys.orderMargin(orderId));
    if (!data || Object.keys(data).length === 0) return null;
    return {
      margin: safeBigInt(data.margin),
      fee: safeBigInt(data.fee),
      totalDeducted: safeBigInt(data.totalDeducted),
      totalSize: safeBigInt(data.totalSize),
      settledSize: safeBigInt(data.settledSize),
      trader: data.trader || "",
    };
  },

  async delete(orderId: string): Promise<void> {
    if (!isRedisConnected()) return;
    const client = getRedisClient();
    await client.del(Keys.orderMargin(orderId));
    await client.srem(Keys.allOrderMargins(), orderId);
  },

  async updateSettledSize(orderId: string, settledSize: bigint): Promise<void> {
    if (!isRedisConnected()) return;
    const client = getRedisClient();
    await client.hset(Keys.orderMargin(orderId), { settledSize: settledSize.toString() });
  },

  async getAll(): Promise<Map<string, {
    margin: bigint;
    fee: bigint;
    totalDeducted: bigint;
    totalSize: bigint;
    settledSize: bigint;
    trader: string;
  }>> {
    const result = new Map();
    if (!isRedisConnected()) return result;
    const client = getRedisClient();
    const ids = await client.smembers(Keys.allOrderMargins());
    for (const id of ids) {
      const info = await this.get(id);
      if (info) result.set(id, info);
    }
    return result;
  },

  /**
   * 清理过期的保证金记录 (已完成或取消的订单)
   * 从 Set 中移除不存在的 key (TTL 过期后自动清理)
   */
  async cleanup(): Promise<number> {
    if (!isRedisConnected()) return 0;
    const client = getRedisClient();
    const ids = await client.smembers(Keys.allOrderMargins());
    let cleaned = 0;

    for (const id of ids) {
      const exists = await client.exists(Keys.orderMargin(id));
      if (!exists) {
        await client.srem(Keys.allOrderMargins(), id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info("Redis", `Cleaned ${cleaned} stale order margin entries`);
    }
    return cleaned;
  },
};

// ============================================================
// Mode 2 PnL Adjustment Repository (链下盈亏调整持久化)
// ============================================================

export const Mode2AdjustmentRepo = {
  async save(user: Address, amount: bigint): Promise<void> {
    if (!isRedisConnected()) return;
    try {
      const client = getRedisClient();
      const key = Keys.mode2Adjustment(user);
      await client.set(key, amount.toString());
      await client.sadd(Keys.allMode2Adjustments(), user.toLowerCase());
    } catch (e) {
      logger.error("Redis", `Failed to save mode2 adjustment for ${user}: ${e}`);
    }
  },

  async get(user: Address): Promise<bigint> {
    if (!isRedisConnected()) return 0n;
    try {
      const client = getRedisClient();
      const key = Keys.mode2Adjustment(user);
      const value = await client.get(key);
      return value ? BigInt(value) : 0n;
    } catch {
      return 0n;
    }
  },

  async getAll(): Promise<Map<string, bigint>> {
    const result = new Map<string, bigint>();
    if (!isRedisConnected()) return result;
    try {
      const client = getRedisClient();
      const users = await client.smembers(Keys.allMode2Adjustments());
      for (const user of users) {
        const key = Keys.mode2Adjustment(user as Address);
        const value = await client.get(key);
        if (value && value !== "0") {
          result.set(user.toLowerCase(), BigInt(value));
        }
      }
    } catch (e) {
      logger.error("Redis", `Failed to load mode2 adjustments: ${e}`);
    }
    return result;
  },
};

// ============================================================
// Pending Withdrawal Mode2 Deductions (链上确认前的回滚记录)
// ============================================================
// 当后端预扣 mode2 后返回提款签名，但链上 tx 可能回退。
// 这些记录允许定期对账：deadline 过期 + 链上 totalWithdrawn 未增加 → 自动回滚。

export interface PendingWithdrawalMode2 {
  id: string;                  // `${trader}:${nonce}`
  trader: string;              // 用户地址
  mode2Portion: string;        // 被扣减的 mode2 金额 (bigint string)
  withdrawAmount: string;      // 请求提款金额 (bigint string)
  deadline: number;            // 提款签名过期时间 (Unix 秒)
  nonce: string;               // 提款 nonce (bigint string)
  totalWithdrawnBefore: string; // 授权时链上 totalWithdrawn 快照 (bigint string)
  createdAt: number;           // 创建时间 (Date.now())
}

export const PendingWithdrawalMode2Repo = {
  async save(record: PendingWithdrawalMode2): Promise<void> {
    if (!isRedisConnected()) return;
    try {
      const client = getRedisClient();
      const key = Keys.pendingWithdrawalMode2(record.id);
      await client.set(key, JSON.stringify(record));
      await client.sadd(Keys.allPendingWithdrawalMode2(), record.id);
    } catch (e) {
      logger.error("Redis", `Failed to save pending withdrawal mode2: ${e}`);
    }
  },

  async remove(id: string): Promise<void> {
    if (!isRedisConnected()) return;
    try {
      const client = getRedisClient();
      await client.del(Keys.pendingWithdrawalMode2(id));
      await client.srem(Keys.allPendingWithdrawalMode2(), id);
    } catch (e) {
      logger.error("Redis", `Failed to remove pending withdrawal mode2: ${e}`);
    }
  },

  async getAll(): Promise<PendingWithdrawalMode2[]> {
    const result: PendingWithdrawalMode2[] = [];
    if (!isRedisConnected()) return result;
    try {
      const client = getRedisClient();
      const ids = await client.smembers(Keys.allPendingWithdrawalMode2());
      for (const id of ids) {
        const key = Keys.pendingWithdrawalMode2(id);
        const value = await client.get(key);
        if (value) {
          try {
            result.push(JSON.parse(value));
          } catch {
            // Corrupted record — clean up
            await client.del(key);
            await client.srem(Keys.allPendingWithdrawalMode2(), id);
          }
        } else {
          // Dangling set member — clean up
          await client.srem(Keys.allPendingWithdrawalMode2(), id);
        }
      }
    } catch (e) {
      logger.error("Redis", `Failed to load pending withdrawal mode2 records: ${e}`);
    }
    return result;
  },
};

// ============================================================
// Insurance Fund Repository (保险基金持久化 — 防重启归零)
// ============================================================

interface InsuranceFundData {
  balance: string;
  totalContributions: string;
  totalPayouts: string;
  lastUpdated: string;
}

export const InsuranceFundRepo = {
  /**
   * 保存全局保险基金到 Redis
   */
  async saveGlobal(fund: { balance: bigint; totalContributions: bigint; totalPayouts: bigint; lastUpdated: number }): Promise<void> {
    if (!isRedisConnected()) return;
    try {
      const client = getRedisClient();
      await client.hset(Keys.insuranceFundGlobal(), {
        balance: fund.balance.toString(),
        totalContributions: fund.totalContributions.toString(),
        totalPayouts: fund.totalPayouts.toString(),
        lastUpdated: fund.lastUpdated.toString(),
      });
    } catch (e) {
      logger.error("Redis", `Failed to save global insurance fund: ${e}`);
    }
  },

  /**
   * 读取全局保险基金
   */
  async getGlobal(): Promise<{ balance: bigint; totalContributions: bigint; totalPayouts: bigint; lastUpdated: number } | null> {
    if (!isRedisConnected()) return null;
    try {
      const client = getRedisClient();
      const data = await client.hgetall(Keys.insuranceFundGlobal()) as InsuranceFundData;
      if (!data || !data.balance) return null;
      return {
        balance: BigInt(data.balance),
        totalContributions: BigInt(data.totalContributions),
        totalPayouts: BigInt(data.totalPayouts),
        lastUpdated: parseInt(data.lastUpdated) || Date.now(),
      };
    } catch (e) {
      logger.error("Redis", `Failed to load global insurance fund: ${e}`);
      return null;
    }
  },

  /**
   * 保存代币保险基金到 Redis
   */
  async saveToken(token: Address, fund: { balance: bigint; totalContributions: bigint; totalPayouts: bigint; lastUpdated: number }): Promise<void> {
    if (!isRedisConnected()) return;
    try {
      const client = getRedisClient();
      await client.hset(Keys.insuranceFundToken(token), {
        balance: fund.balance.toString(),
        totalContributions: fund.totalContributions.toString(),
        totalPayouts: fund.totalPayouts.toString(),
        lastUpdated: fund.lastUpdated.toString(),
      });
      await client.sadd(Keys.allInsuranceFundTokens(), token.toLowerCase());
    } catch (e) {
      logger.error("Redis", `Failed to save token insurance fund for ${token}: ${e}`);
    }
  },

  /**
   * 读取所有代币保险基金 (启动时恢复)
   */
  async getAllTokens(): Promise<Map<string, { balance: bigint; totalContributions: bigint; totalPayouts: bigint; lastUpdated: number }>> {
    const result = new Map<string, { balance: bigint; totalContributions: bigint; totalPayouts: bigint; lastUpdated: number }>();
    if (!isRedisConnected()) return result;
    try {
      const client = getRedisClient();
      const tokens = await client.smembers(Keys.allInsuranceFundTokens());
      for (const token of tokens) {
        const data = await client.hgetall(Keys.insuranceFundToken(token as Address)) as InsuranceFundData;
        if (data && data.balance) {
          result.set(token.toLowerCase(), {
            balance: BigInt(data.balance),
            totalContributions: BigInt(data.totalContributions),
            totalPayouts: BigInt(data.totalPayouts),
            lastUpdated: parseInt(data.lastUpdated) || Date.now(),
          });
        }
      }
    } catch (e) {
      logger.error("Redis", `Failed to load token insurance funds: ${e}`);
    }
    return result;
  },
};

// ============================================================
// Funding State Repository (资金费状态持久化 — 重启恢复)
// ============================================================

interface FundingStateData {
  nextSettlement: string;
  longRate: string;
  shortRate: string;
  displayRate: string;
  lastSettlementTime: string;
}

export const FundingStateRepo = {
  /**
   * 保存代币资金费状态到 Redis
   */
  async save(token: Address, state: {
    nextSettlement: number;
    longRate: string;
    shortRate: string;
    displayRate: string;
    lastSettlementTime: number;
  }): Promise<void> {
    if (!isRedisConnected()) return;
    try {
      const client = getRedisClient();
      await client.hset(Keys.fundingState(token), {
        nextSettlement: state.nextSettlement.toString(),
        longRate: state.longRate,
        shortRate: state.shortRate,
        displayRate: state.displayRate,
        lastSettlementTime: state.lastSettlementTime.toString(),
      });
      await client.sadd(Keys.allFundingTokens(), token.toLowerCase());
    } catch (e) {
      logger.error("Redis", `Failed to save funding state for ${token}: ${e}`);
    }
  },

  /**
   * 读取单个代币资金费状态
   */
  async get(token: Address): Promise<{
    nextSettlement: number;
    longRate: string;
    shortRate: string;
    displayRate: string;
    lastSettlementTime: number;
  } | null> {
    if (!isRedisConnected()) return null;
    try {
      const client = getRedisClient();
      const data = await client.hgetall(Keys.fundingState(token)) as FundingStateData;
      if (!data || !data.nextSettlement) return null;
      return {
        nextSettlement: parseInt(data.nextSettlement) || 0,
        longRate: data.longRate || "0",
        shortRate: data.shortRate || "0",
        displayRate: data.displayRate || "0",
        lastSettlementTime: parseInt(data.lastSettlementTime) || 0,
      };
    } catch (e) {
      logger.error("Redis", `Failed to load funding state for ${token}: ${e}`);
      return null;
    }
  },

  /**
   * 读取所有代币资金费状态 (启动时恢复)
   */
  async getAll(): Promise<Map<string, {
    nextSettlement: number;
    longRate: string;
    shortRate: string;
    displayRate: string;
    lastSettlementTime: number;
  }>> {
    const result = new Map<string, {
      nextSettlement: number;
      longRate: string;
      shortRate: string;
      displayRate: string;
      lastSettlementTime: number;
    }>();
    if (!isRedisConnected()) return result;
    try {
      const client = getRedisClient();
      const tokens = await client.smembers(Keys.allFundingTokens());
      for (const token of tokens) {
        const data = await client.hgetall(Keys.fundingState(token as Address)) as FundingStateData;
        if (data && data.nextSettlement) {
          result.set(token.toLowerCase(), {
            nextSettlement: parseInt(data.nextSettlement) || 0,
            longRate: data.longRate || "0",
            shortRate: data.shortRate || "0",
            displayRate: data.displayRate || "0",
            lastSettlementTime: parseInt(data.lastSettlementTime) || 0,
          });
        }
      }
    } catch (e) {
      logger.error("Redis", `Failed to load funding states: ${e}`);
    }
    return result;
  },
};

// ============================================================
// Nonce Repository (防重放攻击，持久化到 Redis — AUDIT-FIX ME-C06)
// ============================================================

export const NonceRepo = {
  /**
   * 获取用户当前 nonce (0n if not set)
   */
  async get(trader: Address): Promise<bigint> {
    if (!isRedisConnected()) return 0n;
    try {
      const client = getRedisClient();
      const value = await client.get(Keys.userNonce(trader));
      return value ? BigInt(value) : 0n;
    } catch (e) {
      logger.error("Redis", `Failed to get nonce for ${trader}: ${e}`);
      return 0n;
    }
  },

  /**
   * 设置用户 nonce (原子写入)
   */
  async set(trader: Address, nonce: bigint): Promise<void> {
    if (!isRedisConnected()) return;
    try {
      const client = getRedisClient();
      const normalizedTrader = trader.toLowerCase();
      await client.set(Keys.userNonce(trader), nonce.toString());
      await client.sadd(Keys.allUserNonces(), normalizedTrader);
    } catch (e) {
      logger.error("Redis", `Failed to set nonce for ${trader}: ${e}`);
    }
  },

  /**
   * 加载所有用户 nonce (启动时恢复)
   * @returns Map<lowercase address, nonce>
   */
  async getAll(): Promise<Map<string, bigint>> {
    const result = new Map<string, bigint>();
    if (!isRedisConnected()) return result;
    try {
      const client = getRedisClient();
      const users = await client.smembers(Keys.allUserNonces());
      for (const user of users) {
        const value = await client.get(Keys.userNonce(user as Address));
        if (value) {
          result.set(user.toLowerCase(), BigInt(value));
        }
      }
    } catch (e) {
      logger.error("Redis", `Failed to load all nonces: ${e}`);
    }
    return result;
  },
};

// ============================================================
// Referral Repository (推荐系统持久化 — 防重启丢失推荐关系和佣金)
// ============================================================

interface ReferrerData {
  address: string;
  code: string;
  level1Referrals: string;     // JSON array of addresses
  level2Referrals: string;     // JSON array of addresses
  totalEarnings: string;       // bigint as string
  pendingEarnings: string;
  withdrawnEarnings: string;
  level1Earnings: string;
  level2Earnings: string;
  totalTradesReferred: string;
  totalVolumeReferred: string;
  createdAt: string;
  updatedAt: string;
}

interface RefereeData {
  address: string;
  referrerCode: string;
  referrer: string;
  level2Referrer: string;      // "" if null
  totalFeesPaid: string;
  totalCommissionGenerated: string;
  joinedAt: string;
}

export const ReferralRepo = {
  // --- Referrer CRUD ---
  async saveReferrer(referrer: {
    address: string; code: string;
    level1Referrals: string[]; level2Referrals: string[];
    totalEarnings: bigint; pendingEarnings: bigint; withdrawnEarnings: bigint;
    level1Earnings: bigint; level2Earnings: bigint;
    totalTradesReferred: number; totalVolumeReferred: bigint;
    createdAt: number; updatedAt: number;
  }): Promise<void> {
    if (!isRedisConnected()) {
      logger.warn("Redis", `saveReferrer skipped: Redis disconnected (referrer=${referrer.address.slice(0, 10)})`);
      return;
    }
    try {
      const client = getRedisClient();
      const key = Keys.referrer(referrer.address as Address);
      await client.hset(key, {
        address: referrer.address.toLowerCase(),
        code: referrer.code,
        level1Referrals: JSON.stringify(referrer.level1Referrals),
        level2Referrals: JSON.stringify(referrer.level2Referrals),
        totalEarnings: referrer.totalEarnings.toString(),
        pendingEarnings: referrer.pendingEarnings.toString(),
        withdrawnEarnings: referrer.withdrawnEarnings.toString(),
        level1Earnings: referrer.level1Earnings.toString(),
        level2Earnings: referrer.level2Earnings.toString(),
        totalTradesReferred: referrer.totalTradesReferred.toString(),
        totalVolumeReferred: referrer.totalVolumeReferred.toString(),
        createdAt: referrer.createdAt.toString(),
        updatedAt: referrer.updatedAt.toString(),
      });
      await client.sadd(Keys.allReferrers(), referrer.address.toLowerCase());
    } catch (e) {
      logger.error("Redis", `Failed to save referrer ${referrer.address}: ${e}`);
    }
  },

  async getReferrer(address: Address): Promise<ReferrerData | null> {
    if (!isRedisConnected()) {
      logger.warn("Redis", `getReferrer skipped: Redis disconnected (address=${(address as string).slice(0, 10)})`);
      return null;
    }
    try {
      const client = getRedisClient();
      const data = await client.hgetall(Keys.referrer(address)) as unknown as ReferrerData;
      return data && data.address ? data : null;
    } catch (e) {
      logger.error("Redis", `Failed to get referrer ${address}: ${e}`);
      return null;
    }
  },

  async getAllReferrers(): Promise<Map<string, ReferrerData>> {
    const result = new Map<string, ReferrerData>();
    if (!isRedisConnected()) {
      logger.warn("Redis", "getAllReferrers skipped: Redis disconnected");
      return result;
    }
    try {
      const client = getRedisClient();
      const addresses = await client.smembers(Keys.allReferrers());
      for (const addr of addresses) {
        const data = await client.hgetall(Keys.referrer(addr as Address)) as unknown as ReferrerData;
        if (data && data.address) {
          result.set(addr.toLowerCase(), data);
        }
      }
    } catch (e) {
      logger.error("Redis", `Failed to load all referrers: ${e}`);
    }
    return result;
  },

  // --- Referee CRUD ---
  async saveReferee(referee: {
    address: string; referrerCode: string; referrer: string;
    level2Referrer: string | null;
    totalFeesPaid: bigint; totalCommissionGenerated: bigint;
    joinedAt: number;
  }): Promise<void> {
    if (!isRedisConnected()) {
      logger.warn("Redis", `saveReferee skipped: Redis disconnected (referee=${referee.address.slice(0, 10)})`);
      return;
    }
    try {
      const client = getRedisClient();
      const key = Keys.referee(referee.address as Address);
      await client.hset(key, {
        address: referee.address.toLowerCase(),
        referrerCode: referee.referrerCode,
        referrer: referee.referrer.toLowerCase(),
        level2Referrer: referee.level2Referrer?.toLowerCase() || "",
        totalFeesPaid: referee.totalFeesPaid.toString(),
        totalCommissionGenerated: referee.totalCommissionGenerated.toString(),
        joinedAt: referee.joinedAt.toString(),
      });
      await client.sadd(Keys.allReferees(), referee.address.toLowerCase());
    } catch (e) {
      logger.error("Redis", `Failed to save referee ${referee.address}: ${e}`);
    }
  },

  async getAllReferees(): Promise<Map<string, RefereeData>> {
    const result = new Map<string, RefereeData>();
    if (!isRedisConnected()) {
      logger.warn("Redis", "getAllReferees skipped: Redis disconnected");
      return result;
    }
    try {
      const client = getRedisClient();
      const addresses = await client.smembers(Keys.allReferees());
      for (const addr of addresses) {
        const data = await client.hgetall(Keys.referee(addr as Address)) as unknown as RefereeData;
        if (data && data.address) {
          result.set(addr.toLowerCase(), data);
        }
      }
    } catch (e) {
      logger.error("Redis", `Failed to load all referees: ${e}`);
    }
    return result;
  },

  // --- Code → Address mapping ---
  async saveCode(code: string, address: Address): Promise<void> {
    if (!isRedisConnected()) {
      logger.warn("Redis", `saveCode skipped: Redis disconnected (code=${code})`);
      return;
    }
    try {
      const client = getRedisClient();
      await client.set(Keys.referralCode(code), address.toLowerCase());
      await client.sadd(Keys.allReferralCodes(), code.toUpperCase());
    } catch (e) {
      logger.error("Redis", `Failed to save referral code ${code}: ${e}`);
    }
  },

  async getAllCodes(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!isRedisConnected()) {
      logger.warn("Redis", "getAllCodes skipped: Redis disconnected");
      return result;
    }
    try {
      const client = getRedisClient();
      const codes = await client.smembers(Keys.allReferralCodes());
      for (const code of codes) {
        const addr = await client.get(Keys.referralCode(code));
        if (addr) {
          result.set(code.toUpperCase(), addr.toLowerCase());
        }
      }
    } catch (e) {
      logger.error("Redis", `Failed to load all referral codes: ${e}`);
    }
    return result;
  },
};

// ============================================================
// 定期清理任务
// ============================================================

/**
 * 清理过期的订单数据 (7天前的已完成订单)
 */
export async function cleanupStaleOrders(daysOld = 7): Promise<number> {
  if (!isRedisConnected()) return 0;

  const client = getRedisClient();
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  // 遍历所有用户的订单
  const userKeys = await client.keys("user:*:orders");
  for (const userKey of userKeys) {
    const orderIds = await client.smembers(userKey);

    for (const orderId of orderIds) {
      const order = await OrderRepo.get(orderId);
      if (!order) {
        // 订单不存在，从 Set 移除
        await client.srem(userKey, orderId);
        cleaned++;
        continue;
      }

      // 只清理已完成/取消且超过保留期的订单
      const isFinal = order.status !== OrderStatus.PENDING &&
                      order.status !== OrderStatus.PARTIALLY_FILLED;
      const isOld = order.updatedAt < cutoff;

      if (isFinal && isOld) {
        await client.del(Keys.order(orderId));
        await client.srem(userKey, orderId);
        await client.srem(Keys.tokenOrders(order.token), orderId);
        cleaned++;
      }
    }
  }

  if (cleaned > 0) {
    logger.info("Redis", `Cleaned ${cleaned} stale orders (>${daysOld} days)`);
  }
  return cleaned;
}

/**
 * 清理已关闭的仓位 (7天前已关闭/强平的仓位)
 */
export async function cleanupClosedPositions(daysOld = 7): Promise<number> {
  if (!isRedisConnected()) return 0;

  const client = getRedisClient();
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  const positionIds = await client.smembers(Keys.allPositions());

  for (const posId of positionIds) {
    const position = await PositionRepo.get(posId);
    if (!position) {
      await client.srem(Keys.allPositions(), posId);
      cleaned++;
      continue;
    }

    // 只清理已关闭且超过保留期的仓位
    const isClosed = position.status !== 0; // 0 = OPEN
    const isOld = position.updatedAt < cutoff;

    if (isClosed && isOld) {
      await PositionRepo.delete(posId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info("Redis", `Cleaned ${cleaned} closed positions (>${daysOld} days)`);
  }
  return cleaned;
}

// Default export
export default {
  connect: connectRedis,
  disconnect: disconnectRedis,
  isConnected: isRedisConnected,
  getClient: getRedisClient,
  Keys,
  PositionRepo,
  OrderRepo,
  BalanceRepo,
  SettlementLogRepo,
  TradeRepo,
  MarketStatsRepo,
  WalletRepo,
  OrderMarginRepo,
  InsuranceFundRepo,
  NonceRepo,
  ReferralRepo,
  // 工具函数
  safeBigInt,
  withLock,
  tryLock,
  // 清理任务
  cleanupStaleOrders,
  cleanupClosedPositions,
};
