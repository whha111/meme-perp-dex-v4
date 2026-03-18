/**
 * PostgreSQL 数据库层 — P1-5: Redis 订单镜像持久化
 *
 * 架构: Write-Through Cache
 * - Redis: 主存储（高速读写，撮合引擎实时使用）
 * - PostgreSQL: 持久化镜像（订单备份，Redis 丢失时恢复）
 *
 * 设计原则:
 * 1. PostgreSQL 写入是异步的，不阻塞撮合引擎
 * 2. PostgreSQL 不可用时，系统仍然正常运行（仅使用 Redis）
 * 3. 重启时: 先尝试 Redis → 如果 Redis 为空，fallback 到 PostgreSQL
 */

import postgres from "postgres";
import { POSTGRES_URL } from "../config";
import { logger } from "../utils/logger";
import type { Address, Hex } from "viem";

// ============================================================
// Types
// ============================================================

export interface DerivedWallet {
  id: string;
  userAddress: Address;
  derivedAddress: Address;
  encryptedPrivateKey: string;
  salt: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TradeHistory {
  id: string;
  txHash: Hex | null;
  token: Address;
  longTrader: Address;
  shortTrader: Address;
  price: string;
  size: string;
  longOrderId: string;
  shortOrderId: string;
  fee: string;
  timestamp: Date;
}

/** PostgreSQL 中存储的订单镜像 */
export interface PgOrderMirror {
  id: string;
  trader: string;
  token: string;
  symbol: string;
  is_long: boolean;
  size: string;
  price: string;
  leverage: number;
  margin: string;
  fee: string;
  order_type: string;
  side: string;
  status: string;
  filled_size: string;
  avg_fill_price: string;
  reduce_only: boolean;
  post_only: boolean;
  trigger_price: string | null;
  signature: string;
  deadline: number;
  nonce: string;
  created_at: number;
  updated_at: number;
}

/** PostgreSQL 中存储的仓位镜像 */
export interface PgPositionMirror {
  id: string;                    // pairId (UUID)
  trader: string;                // 钱包地址 (lowercase)
  token: string;                 // token 合约地址 (lowercase)
  symbol: string;                // "0xabc...-ETH"
  is_long: boolean;
  size: string;                  // 1e18 字符串
  entry_price: string;
  leverage: number;
  collateral: string;            // 保证金 (1e18 ETH) — 用 collateral 不用 initialMargin 避免字段名歧义
  maintenance_margin: string;
  mark_price: string;
  liquidation_price: string;
  unrealized_pnl: string;
  margin_ratio: string;
  funding_index: string;
  funding_fee: string;
  is_liquidating: boolean;
  risk_level: string;
  adl_score: string;
  adl_ranking: number;
  status: string;                // "OPEN" | "CLOSED" | "LIQUIDATED"
  created_at: number;
  updated_at: number;
}

// ============================================================
// PostgreSQL Client
// ============================================================

let sql: ReturnType<typeof postgres> | null = null;
let isConnected = false;

/**
 * 连接 PostgreSQL 并自动创建镜像表
 * @returns 是否成功连接
 */
export async function connectPostgres(): Promise<boolean> {
  if (!POSTGRES_URL) {
    logger.warn("Postgres", "DATABASE_URL not set, PostgreSQL mirroring disabled");
    return false;
  }

  try {
    sql = postgres(POSTGRES_URL, {
      max: 5,               // 最大连接数（镜像写入不需要太多）
      idle_timeout: 30,     // 空闲 30 秒后释放连接
      connect_timeout: 5,   // 连接超时 5 秒
      transform: {
        undefined: null,    // undefined → null
      },
    });

    // 测试连接
    await sql`SELECT 1`;
    logger.info("Postgres", "Connected successfully");

    // 自动创建镜像表
    await ensureMirrorTable();

    isConnected = true;
    return true;
  } catch (error: any) {
    logger.warn("Postgres", `Connection failed (mirroring disabled): ${error.message}`);
    sql = null;
    isConnected = false;
    return false;
  }
}

export async function disconnectPostgres(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
  isConnected = false;
}

export function isPostgresConnected(): boolean {
  return isConnected && sql !== null;
}

/**
 * 自动创建订单镜像表（如果不存在）
 * 不依赖 Go 后端的 migration，独立维护
 */
async function ensureMirrorTable(): Promise<void> {
  if (!sql) return;

  await sql`
    CREATE TABLE IF NOT EXISTS perp_order_mirror (
      id VARCHAR(64) PRIMARY KEY,
      trader VARCHAR(42) NOT NULL,
      token VARCHAR(42) NOT NULL,
      symbol VARCHAR(32) NOT NULL,
      is_long BOOLEAN NOT NULL,
      size VARCHAR(78) NOT NULL,
      price VARCHAR(78) NOT NULL,
      leverage REAL NOT NULL,
      margin VARCHAR(78) NOT NULL DEFAULT '0',
      fee VARCHAR(78) NOT NULL DEFAULT '0',
      order_type VARCHAR(16) NOT NULL,
      side VARCHAR(8) NOT NULL,
      status VARCHAR(20) NOT NULL,
      filled_size VARCHAR(78) NOT NULL DEFAULT '0',
      avg_fill_price VARCHAR(78) NOT NULL DEFAULT '0',
      reduce_only BOOLEAN NOT NULL DEFAULT FALSE,
      post_only BOOLEAN NOT NULL DEFAULT FALSE,
      trigger_price VARCHAR(78),
      signature TEXT NOT NULL,
      deadline BIGINT NOT NULL,
      nonce VARCHAR(78) NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // 添加索引（如果不存在）
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pom_trader ON perp_order_mirror(trader)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pom_status ON perp_order_mirror(status)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pom_token ON perp_order_mirror(token)
  `;

  logger.info("Postgres", "Mirror table ready: perp_order_mirror");

  // ── Position mirror table ──
  await sql`
    CREATE TABLE IF NOT EXISTS perp_position_mirror (
      id VARCHAR(256) PRIMARY KEY,
      trader VARCHAR(42) NOT NULL,
      token VARCHAR(42) NOT NULL,
      symbol VARCHAR(64) NOT NULL,
      is_long BOOLEAN NOT NULL,
      size VARCHAR(78) NOT NULL,
      entry_price VARCHAR(78) NOT NULL,
      leverage REAL NOT NULL,
      collateral VARCHAR(78) NOT NULL DEFAULT '0',
      maintenance_margin VARCHAR(78) NOT NULL DEFAULT '0',
      mark_price VARCHAR(78) NOT NULL DEFAULT '0',
      liquidation_price VARCHAR(78) NOT NULL DEFAULT '0',
      unrealized_pnl VARCHAR(78) NOT NULL DEFAULT '0',
      margin_ratio VARCHAR(78) NOT NULL DEFAULT '10000',
      funding_index VARCHAR(78) NOT NULL DEFAULT '0',
      funding_fee VARCHAR(78) NOT NULL DEFAULT '0',
      is_liquidating BOOLEAN NOT NULL DEFAULT FALSE,
      risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
      adl_score VARCHAR(78) NOT NULL DEFAULT '0',
      adl_ranking INTEGER NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;

  // Migration: widen id column if existing table has varchar(64)
  await sql`ALTER TABLE perp_position_mirror ALTER COLUMN id TYPE VARCHAR(256)`.catch(() => {});

  await sql`CREATE INDEX IF NOT EXISTS idx_ppm_trader ON perp_position_mirror(trader)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ppm_token ON perp_position_mirror(token)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ppm_status ON perp_position_mirror(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ppm_trader_token ON perp_position_mirror(trader, token, is_long) WHERE status = 'OPEN'`;

  logger.info("Postgres", "Mirror table ready: perp_position_mirror");
}

// ============================================================
// Order Mirror Repository (P1-5)
// ============================================================

export const OrderMirrorRepo = {
  /**
   * 创建或更新订单镜像（Upsert）
   * 异步调用，不阻塞撮合引擎
   */
  async upsert(order: PgOrderMirror): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      await sql`
        INSERT INTO perp_order_mirror (
          id, trader, token, symbol, is_long, size, price, leverage,
          margin, fee, order_type, side, status, filled_size, avg_fill_price,
          reduce_only, post_only, trigger_price, signature, deadline, nonce,
          created_at, updated_at
        ) VALUES (
          ${order.id}, ${order.trader}, ${order.token}, ${order.symbol},
          ${order.is_long}, ${order.size}, ${order.price}, ${order.leverage},
          ${order.margin}, ${order.fee}, ${order.order_type}, ${order.side},
          ${order.status}, ${order.filled_size}, ${order.avg_fill_price},
          ${order.reduce_only}, ${order.post_only}, ${order.trigger_price},
          ${order.signature}, ${order.deadline}, ${order.nonce},
          ${order.created_at}, ${order.updated_at}
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          filled_size = EXCLUDED.filled_size,
          avg_fill_price = EXCLUDED.avg_fill_price,
          updated_at = EXCLUDED.updated_at
      `;
    } catch (error: any) {
      // P0-2: 写入失败不能静默 — 必须传播错误让调用方知道
      logger.error("Postgres", `Failed to upsert order ${order.id}: ${error.message}`);
      throw error;
    }
  },

  /**
   * 更新订单状态
   */
  async updateStatus(
    orderId: string,
    status: string,
    filledSize?: string,
    avgFillPrice?: string,
  ): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      const now = Date.now();
      if (filledSize !== undefined && avgFillPrice !== undefined) {
        await sql`
          UPDATE perp_order_mirror
          SET status = ${status},
              filled_size = ${filledSize},
              avg_fill_price = ${avgFillPrice},
              updated_at = ${now}
          WHERE id = ${orderId}
        `;
      } else {
        await sql`
          UPDATE perp_order_mirror
          SET status = ${status}, updated_at = ${now}
          WHERE id = ${orderId}
        `;
      }
    } catch (error: any) {
      // P0-2: 写入失败不能静默
      logger.error("Postgres", `Failed to update order ${orderId}: ${error.message}`);
      throw error;
    }
  },

  /**
   * 获取所有活跃订单（PENDING / PARTIALLY_FILLED）
   * 用于 Redis 丢失后恢复
   */
  async getActiveOrders(): Promise<PgOrderMirror[]> {
    if (!sql || !isConnected) return [];

    try {
      const rows = await sql<PgOrderMirror[]>`
        SELECT * FROM perp_order_mirror
        WHERE status IN ('PENDING', 'PARTIALLY_FILLED')
        ORDER BY created_at ASC
      `;
      return rows;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get active orders: ${error.message}`);
      return [];
    }
  },

  /**
   * 获取指定代币的活跃订单
   */
  async getActiveByToken(token: string): Promise<PgOrderMirror[]> {
    if (!sql || !isConnected) return [];

    try {
      const rows = await sql<PgOrderMirror[]>`
        SELECT * FROM perp_order_mirror
        WHERE token = ${token} AND status IN ('PENDING', 'PARTIALLY_FILLED')
        ORDER BY created_at ASC
      `;
      return rows;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get active orders for ${token}: ${error.message}`);
      return [];
    }
  },

  /**
   * 统计活跃订单数
   */
  async countActive(): Promise<number> {
    if (!sql || !isConnected) return 0;

    try {
      const [{ count }] = await sql`
        SELECT COUNT(*) as count FROM perp_order_mirror
        WHERE status IN ('PENDING', 'PARTIALLY_FILLED')
      `;
      return Number(count);
    } catch (error: any) {
      logger.error("Postgres", `Failed to count active orders: ${error.message}`);
      return 0;
    }
  },
};

// ============================================================
// Position Mirror Repository
// ============================================================

export const PositionMirrorRepo = {
  /**
   * 创建或更新仓位镜像 (Upsert)
   * 每次 savePositionToRedis 成功后调用
   */
  async upsert(position: PgPositionMirror): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      await sql`
        INSERT INTO perp_position_mirror (
          id, trader, token, symbol, is_long, size, entry_price, leverage,
          collateral, maintenance_margin, mark_price, liquidation_price,
          unrealized_pnl, margin_ratio, funding_index, funding_fee,
          is_liquidating, risk_level, adl_score, adl_ranking,
          status, created_at, updated_at
        ) VALUES (
          ${position.id}, ${position.trader}, ${position.token}, ${position.symbol},
          ${position.is_long}, ${position.size}, ${position.entry_price}, ${position.leverage},
          ${position.collateral}, ${position.maintenance_margin}, ${position.mark_price},
          ${position.liquidation_price}, ${position.unrealized_pnl}, ${position.margin_ratio},
          ${position.funding_index}, ${position.funding_fee}, ${position.is_liquidating},
          ${position.risk_level}, ${position.adl_score}, ${position.adl_ranking},
          ${position.status}, ${position.created_at}, ${position.updated_at}
        )
        ON CONFLICT (id) DO UPDATE SET
          size = EXCLUDED.size,
          entry_price = EXCLUDED.entry_price,
          leverage = EXCLUDED.leverage,
          collateral = EXCLUDED.collateral,
          maintenance_margin = EXCLUDED.maintenance_margin,
          mark_price = EXCLUDED.mark_price,
          liquidation_price = EXCLUDED.liquidation_price,
          unrealized_pnl = EXCLUDED.unrealized_pnl,
          margin_ratio = EXCLUDED.margin_ratio,
          funding_index = EXCLUDED.funding_index,
          funding_fee = EXCLUDED.funding_fee,
          is_liquidating = EXCLUDED.is_liquidating,
          risk_level = EXCLUDED.risk_level,
          adl_score = EXCLUDED.adl_score,
          adl_ranking = EXCLUDED.adl_ranking,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to upsert position ${position.id}: ${error.message}`);
      throw error;
    }
  },

  /**
   * 标记仓位已关闭 (软删除，保留历史数据供审计)
   * 每次 deletePositionFromRedis 后调用
   */
  async markClosed(positionId: string, status: "CLOSED" | "LIQUIDATED" = "CLOSED"): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      const now = Date.now();
      await sql`
        UPDATE perp_position_mirror
        SET status = ${status}, size = '0', updated_at = ${now}
        WHERE id = ${positionId}
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to mark position ${positionId} as ${status}: ${error.message}`);
      throw error;
    }
  },

  /**
   * 获取所有活跃仓位 (status = 'OPEN')
   * 用于 Redis 丢失后恢复
   */
  async getActivePositions(): Promise<PgPositionMirror[]> {
    if (!sql || !isConnected) return [];

    try {
      const rows = await sql<PgPositionMirror[]>`
        SELECT * FROM perp_position_mirror
        WHERE status = 'OPEN'
        ORDER BY created_at ASC
      `;
      return rows;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get active positions: ${error.message}`);
      return [];
    }
  },

  /**
   * 统计活跃仓位数
   */
  async countActive(): Promise<number> {
    if (!sql || !isConnected) return 0;

    try {
      const [{ count }] = await sql`
        SELECT COUNT(*) as count FROM perp_position_mirror
        WHERE status = 'OPEN'
      `;
      return Number(count);
    } catch (error: any) {
      logger.error("Postgres", `Failed to count active positions: ${error.message}`);
      return 0;
    }
  },
};

// ============================================================
// Wallet Repository (Placeholder - 未来实现)
// ============================================================

export const WalletRepo = {
  async create(data: Omit<DerivedWallet, "id" | "createdAt" | "updatedAt">): Promise<DerivedWallet> {
    throw new Error("PostgreSQL WalletRepo not implemented - use Redis");
  },

  async getByUser(userAddress: Address): Promise<DerivedWallet | null> {
    throw new Error("PostgreSQL WalletRepo not implemented - use Redis");
  },

  async getByDerivedAddress(derivedAddress: Address): Promise<DerivedWallet | null> {
    throw new Error("PostgreSQL WalletRepo not implemented - use Redis");
  },
};

// ============================================================
// Trade History Repository (Placeholder - 未来实现)
// ============================================================

export const TradeHistoryRepo = {
  async create(data: Omit<TradeHistory, "id">): Promise<TradeHistory> {
    throw new Error("PostgreSQL TradeHistoryRepo not implemented");
  },

  async getByToken(token: Address, limit = 100): Promise<TradeHistory[]> {
    return [];
  },

  async getByTrader(trader: Address, limit = 100): Promise<TradeHistory[]> {
    return [];
  },
};

export default {
  connect: connectPostgres,
  disconnect: disconnectPostgres,
  isConnected: isPostgresConnected,
  OrderMirrorRepo,
  PositionMirrorRepo,
  WalletRepo,
  TradeHistoryRepo,
};
