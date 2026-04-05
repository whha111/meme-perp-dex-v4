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

/** PostgreSQL 中存储的仓位镜像 — 与 types.ts Position 接口完全对齐 */
export interface PgPositionMirror {
  // 基本标识
  id: string;                    // pairId (UUID)
  trader: string;                // 钱包地址 (lowercase)
  token: string;                 // token 合约地址 (lowercase)
  symbol: string;                // "0xabc...-ETH"
  counterparty: string;          // 对手方地址

  // 仓位参数
  is_long: boolean;
  size: string;                  // Token 数量 (1e18 字符串)
  entry_price: string;           // 开仓价 (1e18)
  average_entry_price: string;   // 加仓后平均价 (1e18)
  leverage: number;              // 杠杆倍数
  margin_mode: number;           // 0=逐仓, 1=全仓

  // 价格信息
  mark_price: string;            // 标记价格 (1e18)
  liquidation_price: string;     // 强平价格 (1e18)
  bankruptcy_price: string;      // 穿仓价格 (1e18)
  break_even_price: string;      // 盈亏平衡价 (1e18)

  // 保证金信息
  collateral: string;            // 初始保证金 ETH (1e18)
  margin: string;                // 当前保证金 = 初始 + UPNL (1e18)
  margin_ratio: string;          // 保证金率 (基点, 10000=100%)
  mmr: string;                   // 维持保证金率 (基点)
  maintenance_margin: string;    // 维持保证金金额 ETH (1e18)

  // 盈亏信息
  unrealized_pnl: string;        // 未实现盈亏 ETH (1e18)
  realized_pnl: string;          // 已实现盈亏 ETH (1e18)
  roe: string;                   // 收益率 (基点)
  accumulated_funding: string;   // 累计资金费 ETH (1e18)

  // 止盈止损
  tp_price: string | null;       // 止盈价 (1e18)
  sl_price: string | null;       // 止损价 (1e18)

  // 风险指标
  adl_ranking: number;           // ADL排名 1-5
  adl_score: string;             // ADL评分
  risk_level: string;            // low/medium/high/critical
  is_liquidatable: boolean;
  is_adl_candidate: boolean;

  // 状态
  status: string;                // "OPEN" | "CLOSED" | "LIQUIDATED"
  funding_index: string;         // 开仓时的资金费索引
  is_liquidating: boolean;

  // 时间戳
  created_at: number;
  updated_at: number;

  // 平仓信息 (仅平仓后填充)
  close_price: string | null;    // 平仓成交价 (1e18)
  closing_pnl: string | null;    // 平仓盈亏 (1e18)
  close_fee: string | null;      // 平仓手续费 (1e18)
  closed_at: number | null;      // 平仓时间戳
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
    await ensureP1Tables();

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

  // ── Position mirror table (V2 — 完整对齐 Position 接口) ──
  await sql`
    CREATE TABLE IF NOT EXISTS perp_position_mirror (
      id VARCHAR(256) PRIMARY KEY,

      -- 基本标识
      trader VARCHAR(42) NOT NULL,
      token VARCHAR(128) NOT NULL,
      symbol VARCHAR(64) NOT NULL,
      counterparty VARCHAR(42) NOT NULL DEFAULT '',

      -- 仓位参数
      is_long BOOLEAN NOT NULL,
      size VARCHAR(78) NOT NULL,
      entry_price VARCHAR(78) NOT NULL,
      average_entry_price VARCHAR(78) NOT NULL DEFAULT '0',
      leverage REAL NOT NULL,
      margin_mode SMALLINT NOT NULL DEFAULT 0,

      -- 价格信息
      mark_price VARCHAR(78) NOT NULL DEFAULT '0',
      liquidation_price VARCHAR(78) NOT NULL DEFAULT '0',
      bankruptcy_price VARCHAR(78) NOT NULL DEFAULT '0',
      break_even_price VARCHAR(78) NOT NULL DEFAULT '0',

      -- 保证金信息
      collateral VARCHAR(78) NOT NULL DEFAULT '0',
      margin VARCHAR(78) NOT NULL DEFAULT '0',
      margin_ratio VARCHAR(78) NOT NULL DEFAULT '10000',
      mmr VARCHAR(78) NOT NULL DEFAULT '0',
      maintenance_margin VARCHAR(78) NOT NULL DEFAULT '0',

      -- 盈亏信息
      unrealized_pnl VARCHAR(78) NOT NULL DEFAULT '0',
      realized_pnl VARCHAR(78) NOT NULL DEFAULT '0',
      roe VARCHAR(78) NOT NULL DEFAULT '0',
      accumulated_funding VARCHAR(78) NOT NULL DEFAULT '0',

      -- 止盈止损
      tp_price VARCHAR(78),
      sl_price VARCHAR(78),

      -- 风险指标
      adl_ranking INTEGER NOT NULL DEFAULT 1,
      adl_score VARCHAR(78) NOT NULL DEFAULT '0',
      risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
      is_liquidatable BOOLEAN NOT NULL DEFAULT FALSE,
      is_adl_candidate BOOLEAN NOT NULL DEFAULT FALSE,

      -- 状态
      status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
      funding_index VARCHAR(78) NOT NULL DEFAULT '0',
      is_liquidating BOOLEAN NOT NULL DEFAULT FALSE,

      -- 时间戳
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,

      -- 平仓信息 (仅平仓后填充)
      close_price VARCHAR(78),
      closing_pnl VARCHAR(78),
      close_fee VARCHAR(78),
      closed_at BIGINT
    )
  `;

  // ── Migration: 从旧表结构升级到 V2 ──
  // 每个 ALTER 独立 catch，已存在的列会静默跳过
  const newColumns = [
    `ALTER TABLE perp_position_mirror ALTER COLUMN id TYPE VARCHAR(256)`,
    `ALTER TABLE perp_position_mirror ALTER COLUMN token TYPE VARCHAR(128)`,
    `ALTER TABLE perp_position_mirror ADD COLUMN counterparty VARCHAR(42) NOT NULL DEFAULT ''`,
    `ALTER TABLE perp_position_mirror ADD COLUMN average_entry_price VARCHAR(78) NOT NULL DEFAULT '0'`,
    `ALTER TABLE perp_position_mirror ADD COLUMN margin_mode SMALLINT NOT NULL DEFAULT 0`,
    `ALTER TABLE perp_position_mirror ADD COLUMN bankruptcy_price VARCHAR(78) NOT NULL DEFAULT '0'`,
    `ALTER TABLE perp_position_mirror ADD COLUMN break_even_price VARCHAR(78) NOT NULL DEFAULT '0'`,
    `ALTER TABLE perp_position_mirror ADD COLUMN margin VARCHAR(78) NOT NULL DEFAULT '0'`,
    `ALTER TABLE perp_position_mirror ADD COLUMN mmr VARCHAR(78) NOT NULL DEFAULT '0'`,
    `ALTER TABLE perp_position_mirror ADD COLUMN realized_pnl VARCHAR(78) NOT NULL DEFAULT '0'`,
    `ALTER TABLE perp_position_mirror ADD COLUMN roe VARCHAR(78) NOT NULL DEFAULT '0'`,
    `ALTER TABLE perp_position_mirror ADD COLUMN accumulated_funding VARCHAR(78) NOT NULL DEFAULT '0'`,
    `ALTER TABLE perp_position_mirror ADD COLUMN tp_price VARCHAR(78)`,
    `ALTER TABLE perp_position_mirror ADD COLUMN sl_price VARCHAR(78)`,
    `ALTER TABLE perp_position_mirror ADD COLUMN is_liquidatable BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE perp_position_mirror ADD COLUMN is_adl_candidate BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE perp_position_mirror ADD COLUMN close_price VARCHAR(78)`,
    `ALTER TABLE perp_position_mirror ADD COLUMN closing_pnl VARCHAR(78)`,
    `ALTER TABLE perp_position_mirror ADD COLUMN close_fee VARCHAR(78)`,
    `ALTER TABLE perp_position_mirror ADD COLUMN closed_at BIGINT`,
  ];
  for (const ddl of newColumns) {
    await sql.unsafe(ddl).catch(() => {});
  }

  // ── 索引 ──
  await sql`CREATE INDEX IF NOT EXISTS idx_ppm_trader ON perp_position_mirror(trader)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ppm_token ON perp_position_mirror(token)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ppm_status ON perp_position_mirror(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ppm_trader_token ON perp_position_mirror(trader, token, is_long) WHERE status = 'OPEN'`;
  // Unique constraint: one OPEN position per trader+token+side (dYdX v4 keys positions by subaccountId+perpetualId)
  // This prevents duplicate PG rows when pairId format changes between restarts
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_ppm_open_position ON perp_position_mirror(trader, token, is_long) WHERE status = 'OPEN'`).catch(() => {});

  logger.info("Postgres", "Mirror table ready: perp_position_mirror (V2)");

  // ── P0-2: Trade mirror table ──
  await sql`
    CREATE TABLE IF NOT EXISTS perp_trade_mirror (
      id VARCHAR(64) PRIMARY KEY,
      order_id VARCHAR(64) NOT NULL,
      pair_id VARCHAR(256) NOT NULL,
      token VARCHAR(128) NOT NULL,
      trader VARCHAR(42) NOT NULL,
      is_long BOOLEAN NOT NULL,
      is_maker BOOLEAN NOT NULL DEFAULT FALSE,
      size VARCHAR(78) NOT NULL,
      price VARCHAR(78) NOT NULL,
      fee VARCHAR(78) NOT NULL DEFAULT '0',
      realized_pnl VARCHAR(78) NOT NULL DEFAULT '0',
      timestamp BIGINT NOT NULL,
      type VARCHAR(16) NOT NULL DEFAULT 'normal',
      created_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ptm_trader ON perp_trade_mirror(trader)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ptm_token ON perp_trade_mirror(token)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ptm_timestamp ON perp_trade_mirror(timestamp)`;
  logger.info("Postgres", "Mirror table ready: perp_trade_mirror");

  // ── P0-2: Mode2 adjustment tables ──
  await sql`
    CREATE TABLE IF NOT EXISTS mode2_adjustments (
      trader VARCHAR(42) PRIMARY KEY,
      cumulative_amount VARCHAR(78) NOT NULL DEFAULT '0',
      updated_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS mode2_adjustment_log (
      id VARCHAR(64) PRIMARY KEY,
      trader VARCHAR(42) NOT NULL,
      amount VARCHAR(78) NOT NULL,
      reason VARCHAR(64) NOT NULL,
      cumulative_after VARCHAR(78) NOT NULL,
      timestamp BIGINT NOT NULL
    )
  `;
  // L2: Add auto-incrementing sequence column for strict ordering
  await sql.unsafe(`ALTER TABLE mode2_adjustment_log ADD COLUMN IF NOT EXISTS seq SERIAL`).catch(() => {});
  await sql`CREATE INDEX IF NOT EXISTS idx_m2log_trader ON mode2_adjustment_log(trader)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_m2log_timestamp ON mode2_adjustment_log(timestamp)`;
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_m2log_seq ON mode2_adjustment_log(seq)`).catch(() => {});
  logger.info("Postgres", "Mirror tables ready: mode2_adjustments + mode2_adjustment_log");

  // ── P0-2: Bill (settlement log) table ──
  await sql`
    CREATE TABLE IF NOT EXISTS perp_bills (
      id VARCHAR(64) PRIMARY KEY,
      trader VARCHAR(42) NOT NULL,
      type VARCHAR(32) NOT NULL,
      amount VARCHAR(78) NOT NULL,
      balance_before VARCHAR(78) NOT NULL DEFAULT '0',
      balance_after VARCHAR(78) NOT NULL DEFAULT '0',
      on_chain_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      proof_data TEXT NOT NULL DEFAULT '{}',
      position_id VARCHAR(256),
      order_id VARCHAR(64),
      timestamp BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_pb_trader ON perp_bills(trader)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pb_type ON perp_bills(type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pb_timestamp ON perp_bills(timestamp)`;
  logger.info("Postgres", "Mirror table ready: perp_bills");

  // ── P1-1: Balance snapshots table ──
  await sql`
    CREATE TABLE IF NOT EXISTS balance_snapshots (
      id SERIAL PRIMARY KEY,
      trader VARCHAR(42) NOT NULL,
      total_balance VARCHAR(78) NOT NULL DEFAULT '0',
      available_balance VARCHAR(78) NOT NULL DEFAULT '0',
      used_margin VARCHAR(78) NOT NULL DEFAULT '0',
      frozen_margin VARCHAR(78) NOT NULL DEFAULT '0',
      mode2_adjustment VARCHAR(78) NOT NULL DEFAULT '0',
      snapshot_time BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_bs_trader ON balance_snapshots(trader)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bs_time ON balance_snapshots(snapshot_time)`;
  logger.info("Postgres", "Mirror table ready: balance_snapshots");

  // ── M2: Funding rate history table ──
  await sql`
    CREATE TABLE IF NOT EXISTS funding_rate_history (
      id SERIAL PRIMARY KEY,
      token VARCHAR(128) NOT NULL,
      long_rate VARCHAR(78) NOT NULL DEFAULT '0',
      short_rate VARCHAR(78) NOT NULL DEFAULT '0',
      display_rate VARCHAR(78) NOT NULL DEFAULT '0',
      total_collected VARCHAR(78) NOT NULL DEFAULT '0',
      long_oi VARCHAR(78) NOT NULL DEFAULT '0',
      short_oi VARCHAR(78) NOT NULL DEFAULT '0',
      funding_time BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_frh_token ON funding_rate_history(token)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_frh_time ON funding_rate_history(funding_time)`;
  logger.info("Postgres", "Mirror table ready: funding_rate_history");

  // ── L1: Sync states (event poller block cursors, etc.) ──
  await sql`
    CREATE TABLE IF NOT EXISTS sync_states (
      key VARCHAR(128) PRIMARY KEY,
      value VARCHAR(256) NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
  logger.info("Postgres", "Mirror table ready: sync_states");
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
   * 创建或更新仓位镜像 (Upsert) — V2 完整字段
   * Uses unique partial index uq_ppm_open_position(trader, token, is_long) WHERE status='OPEN'
   * to prevent duplicate rows when pairId format varies between restarts.
   * Pattern: dYdX v4 keys positions by (subaccountId, perpetualId), not by UUID.
   */
  async upsert(position: PgPositionMirror): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      // Use ON CONFLICT on the unique partial index for OPEN positions
      // This ensures only one OPEN row per trader+token+side, regardless of ID format
      await sql`
        INSERT INTO perp_position_mirror (
          id, trader, token, symbol, counterparty,
          is_long, size, entry_price, average_entry_price, leverage, margin_mode,
          mark_price, liquidation_price, bankruptcy_price, break_even_price,
          collateral, margin, margin_ratio, mmr, maintenance_margin,
          unrealized_pnl, realized_pnl, roe, accumulated_funding,
          tp_price, sl_price,
          adl_ranking, adl_score, risk_level, is_liquidatable, is_adl_candidate,
          status, funding_index, is_liquidating,
          created_at, updated_at,
          close_price, closing_pnl, close_fee, closed_at
        ) VALUES (
          ${position.id}, ${position.trader}, ${position.token}, ${position.symbol}, ${position.counterparty},
          ${position.is_long}, ${position.size}, ${position.entry_price}, ${position.average_entry_price},
          ${position.leverage}, ${position.margin_mode},
          ${position.mark_price}, ${position.liquidation_price}, ${position.bankruptcy_price}, ${position.break_even_price},
          ${position.collateral}, ${position.margin}, ${position.margin_ratio}, ${position.mmr}, ${position.maintenance_margin},
          ${position.unrealized_pnl}, ${position.realized_pnl}, ${position.roe}, ${position.accumulated_funding},
          ${position.tp_price}, ${position.sl_price},
          ${position.adl_ranking}, ${position.adl_score}, ${position.risk_level}, ${position.is_liquidatable}, ${position.is_adl_candidate},
          ${position.status}, ${position.funding_index}, ${position.is_liquidating},
          ${position.created_at}, ${position.updated_at},
          ${position.close_price}, ${position.closing_pnl}, ${position.close_fee}, ${position.closed_at}
        )
        ON CONFLICT (id) DO UPDATE SET
          size = EXCLUDED.size,
          entry_price = EXCLUDED.entry_price,
          average_entry_price = EXCLUDED.average_entry_price,
          leverage = EXCLUDED.leverage,
          margin_mode = EXCLUDED.margin_mode,
          mark_price = EXCLUDED.mark_price,
          liquidation_price = EXCLUDED.liquidation_price,
          bankruptcy_price = EXCLUDED.bankruptcy_price,
          break_even_price = EXCLUDED.break_even_price,
          collateral = EXCLUDED.collateral,
          margin = EXCLUDED.margin,
          margin_ratio = EXCLUDED.margin_ratio,
          mmr = EXCLUDED.mmr,
          maintenance_margin = EXCLUDED.maintenance_margin,
          unrealized_pnl = EXCLUDED.unrealized_pnl,
          realized_pnl = EXCLUDED.realized_pnl,
          roe = EXCLUDED.roe,
          accumulated_funding = EXCLUDED.accumulated_funding,
          tp_price = EXCLUDED.tp_price,
          sl_price = EXCLUDED.sl_price,
          adl_ranking = EXCLUDED.adl_ranking,
          adl_score = EXCLUDED.adl_score,
          risk_level = EXCLUDED.risk_level,
          is_liquidatable = EXCLUDED.is_liquidatable,
          is_adl_candidate = EXCLUDED.is_adl_candidate,
          funding_index = EXCLUDED.funding_index,
          is_liquidating = EXCLUDED.is_liquidating,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `;
    } catch (error: any) {
      // If ON CONFLICT (id) missed but unique index caught it, try update by trader+token+is_long
      if (error.message?.includes("uq_ppm_open_position")) {
        try {
          await sql`
            UPDATE perp_position_mirror SET
              id = ${position.id},
              size = ${position.size},
              entry_price = ${position.entry_price},
              average_entry_price = ${position.average_entry_price},
              leverage = ${position.leverage},
              mark_price = ${position.mark_price},
              liquidation_price = ${position.liquidation_price},
              bankruptcy_price = ${position.bankruptcy_price},
              break_even_price = ${position.break_even_price},
              collateral = ${position.collateral},
              margin = ${position.margin},
              margin_ratio = ${position.margin_ratio},
              mmr = ${position.mmr},
              maintenance_margin = ${position.maintenance_margin},
              unrealized_pnl = ${position.unrealized_pnl},
              realized_pnl = ${position.realized_pnl},
              roe = ${position.roe},
              accumulated_funding = ${position.accumulated_funding},
              tp_price = ${position.tp_price},
              sl_price = ${position.sl_price},
              funding_index = ${position.funding_index},
              is_liquidating = ${position.is_liquidating},
              status = ${position.status},
              updated_at = ${position.updated_at}
            WHERE trader = ${position.trader}
              AND token = ${position.token}
              AND is_long = ${position.is_long}
              AND status = 'OPEN'
          `;
          return;
        } catch (e2: any) {
          logger.error("Postgres", `Position fallback update failed: ${e2.message}`);
        }
      }
      logger.error("Postgres", `Failed to upsert position ${position.id}: ${error.message}`);
      throw error;
    }
  },

  /**
   * 标记仓位已关闭 — 记录平仓价格、盈亏、手续费
   * 每次 deletePositionFromRedis 后调用
   */
  async markClosed(
    positionId: string,
    status: "CLOSED" | "LIQUIDATED" = "CLOSED",
    closeData?: { closePrice?: string; closingPnl?: string; closeFee?: string },
  ): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      const now = Date.now();
      // Try by id first; if no rows affected, try by pairId-like composite match
      const result = await sql`
        UPDATE perp_position_mirror
        SET status = ${status},
            updated_at = ${now},
            closed_at = ${now},
            close_price = COALESCE(${closeData?.closePrice ?? null}, close_price),
            closing_pnl = COALESCE(${closeData?.closingPnl ?? null}, closing_pnl),
            close_fee = COALESCE(${closeData?.closeFee ?? null}, close_fee)
        WHERE id = ${positionId} AND status = 'OPEN'
      `;
      // If the positionId contains trader info (composite key format), try extracting and matching
      if (result.count === 0 && positionId.includes("_")) {
        const parts = positionId.toLowerCase().split("_");
        if (parts.length >= 2) {
          await sql`
            UPDATE perp_position_mirror
            SET status = ${status},
                updated_at = ${now},
                closed_at = ${now},
                close_price = COALESCE(${closeData?.closePrice ?? null}, close_price),
                closing_pnl = COALESCE(${closeData?.closingPnl ?? null}, closing_pnl),
                close_fee = COALESCE(${closeData?.closeFee ?? null}, close_fee)
            WHERE LOWER(token) = ${parts[0]} AND LOWER(trader) = ${parts[1]} AND status = 'OPEN'
          `;
        }
      }
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
// Trade Mirror Repository (P0-2: 成交记录持久化)
// ============================================================

export interface PgTradeMirror {
  id: string;
  order_id: string;
  pair_id: string;
  token: string;
  trader: string;
  is_long: boolean;
  is_maker: boolean;
  size: string;
  price: string;
  fee: string;
  realized_pnl: string;
  timestamp: number;
  type: string;
}

export const TradeMirrorRepo = {
  async upsert(trade: PgTradeMirror): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      await sql`
        INSERT INTO perp_trade_mirror (
          id, order_id, pair_id, token, trader, is_long, is_maker,
          size, price, fee, realized_pnl, timestamp, type, created_at
        ) VALUES (
          ${trade.id}, ${trade.order_id}, ${trade.pair_id}, ${trade.token},
          ${trade.trader}, ${trade.is_long}, ${trade.is_maker},
          ${trade.size}, ${trade.price}, ${trade.fee}, ${trade.realized_pnl},
          ${trade.timestamp}, ${trade.type}, ${Date.now()}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to upsert trade ${trade.id}: ${error.message}`);
    }
  },

  async getByTrader(trader: string, limit = 100): Promise<PgTradeMirror[]> {
    if (!sql || !isConnected) return [];

    try {
      const rows = await sql<PgTradeMirror[]>`
        SELECT * FROM perp_trade_mirror
        WHERE trader = ${trader.toLowerCase()}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
      return rows;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get trades for ${trader}: ${error.message}`);
      return [];
    }
  },
};

// ============================================================
// Bill Mirror Repository (P0-2: 资金流水持久化)
// ============================================================

export interface PgBill {
  id: string;
  trader: string;
  type: string; // DEPOSIT, WITHDRAW, SETTLE_PNL, TRADING_FEE, CLOSE_FEE, OPEN_FEE, FUNDING_FEE, LIQUIDATION, ADL
  amount: string;
  balance_before?: string;
  balance_after: string;
  on_chain_status?: string;
  proof_data?: string;
  position_id?: string;
  order_id?: string;
  timestamp: number;
  created_at?: number;
}

export const BillMirrorRepo = {
  async insert(bill: PgBill): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      await sql`
        INSERT INTO perp_bills (
          id, trader, type, amount, balance_before, balance_after,
          on_chain_status, proof_data, position_id, order_id,
          timestamp, created_at
        ) VALUES (
          ${bill.id}, ${bill.trader}, ${bill.type}, ${bill.amount},
          ${bill.balance_before || "0"}, ${bill.balance_after},
          ${bill.on_chain_status || "ENGINE_SETTLED"}, ${bill.proof_data || "{}"},
          ${bill.position_id || null}, ${bill.order_id || null},
          ${bill.timestamp}, ${bill.created_at || Date.now()}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to insert bill ${bill.id}: ${error.message}`);
    }
  },

  async getByTrader(trader: string, limit = 100, type?: string): Promise<PgBill[]> {
    if (!sql || !isConnected) return [];

    try {
      if (type) {
        return await sql<PgBill[]>`
          SELECT * FROM perp_bills
          WHERE trader = ${trader.toLowerCase()} AND type = ${type}
          ORDER BY timestamp DESC
          LIMIT ${limit}
        `;
      }
      return await sql<PgBill[]>`
        SELECT * FROM perp_bills
        WHERE trader = ${trader.toLowerCase()}
        ORDER BY timestamp DESC
        LIMIT ${limit}
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get bills for ${trader}: ${error.message}`);
      return [];
    }
  },
};

// ============================================================
// Mode2 Adjustment Mirror (P0-2: 链下盈亏调整持久化)
// ============================================================

export const Mode2AdjustmentMirrorRepo = {
  async upsert(trader: string, cumulativeAmount: string, deltaAmount: string, reason: string): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      const now = Date.now();
      // Upsert cumulative value
      await sql`
        INSERT INTO perp_mode2_adjustments (trader, cumulative_amount, updated_at)
        VALUES (${trader.toLowerCase()}, ${cumulativeAmount}, ${now})
        ON CONFLICT (trader) DO UPDATE SET
          cumulative_amount = EXCLUDED.cumulative_amount,
          updated_at = EXCLUDED.updated_at
      `;
      // Append audit log entry
      await sql`
        INSERT INTO perp_mode2_log (trader, amount, reason, cumulative_after, timestamp)
        VALUES (${trader.toLowerCase()}, ${deltaAmount}, ${reason}, ${cumulativeAmount}, ${now})
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to upsert mode2 for ${trader}: ${error.message}`);
    }
  },

  async getByTrader(trader: string): Promise<{ cumulative_amount: string; updated_at: number } | null> {
    if (!sql || !isConnected) return null;

    try {
      const [row] = await sql`
        SELECT cumulative_amount, updated_at FROM perp_mode2_adjustments
        WHERE trader = ${trader.toLowerCase()}
      `;
      return row ? { cumulative_amount: row.cumulative_amount as string, updated_at: Number(row.updated_at) } : null;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get mode2 for ${trader}: ${error.message}`);
      return null;
    }
  },

  async getAll(): Promise<Map<string, bigint>> {
    if (!sql || !isConnected) return new Map();

    try {
      const rows = await sql`SELECT trader, cumulative_amount FROM perp_mode2_adjustments`;
      const result = new Map<string, bigint>();
      for (const row of rows) {
        result.set(row.trader as string, BigInt(row.cumulative_amount as string));
      }
      return result;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get all mode2 adjustments: ${error.message}`);
      return new Map();
    }
  },
};

// ============================================================
// Balance Snapshot Repository (P1-1: 定期余额快照)
// ============================================================

export interface PgBalanceSnapshot {
  trader: string;
  total_balance: string;
  available_balance: string;
  used_margin: string;
  frozen_margin: string;
  unrealized_pnl: string;
  settlement_available: string;
  mode2_adjustment: string;
  snapshot_time: number;
}

export const BalanceSnapshotRepo = {
  async upsertBatch(snapshots: PgBalanceSnapshot[]): Promise<number> {
    if (!sql || !isConnected || snapshots.length === 0) return 0;

    try {
      // Use a transaction for batch upsert
      let count = 0;
      for (const snap of snapshots) {
        await sql`
          INSERT INTO perp_balance_snapshots (
            trader, total_balance, available_balance, used_margin,
            frozen_margin, unrealized_pnl, settlement_available,
            mode2_adjustment, snapshot_time
          ) VALUES (
            ${snap.trader}, ${snap.total_balance}, ${snap.available_balance},
            ${snap.used_margin}, ${snap.frozen_margin}, ${snap.unrealized_pnl},
            ${snap.settlement_available}, ${snap.mode2_adjustment}, ${snap.snapshot_time}
          )
          ON CONFLICT (trader) DO UPDATE SET
            total_balance = EXCLUDED.total_balance,
            available_balance = EXCLUDED.available_balance,
            used_margin = EXCLUDED.used_margin,
            frozen_margin = EXCLUDED.frozen_margin,
            unrealized_pnl = EXCLUDED.unrealized_pnl,
            settlement_available = EXCLUDED.settlement_available,
            mode2_adjustment = EXCLUDED.mode2_adjustment,
            snapshot_time = EXCLUDED.snapshot_time
        `;
        count++;
      }
      return count;
    } catch (error: any) {
      logger.error("Postgres", `Failed to upsert balance snapshots: ${error.message}`);
      return 0;
    }
  },

  async getAll(): Promise<PgBalanceSnapshot[]> {
    if (!sql || !isConnected) return [];

    try {
      return await sql<PgBalanceSnapshot[]>`SELECT * FROM perp_balance_snapshots`;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get balance snapshots: ${error.message}`);
      return [];
    }
  },
};

// ============================================================
// Additional mirror tables (P0-2 / P1-1)
// ============================================================

async function ensureP1Tables(): Promise<void> {
  if (!sql) return;

  // Trade mirror table
  await sql`
    CREATE TABLE IF NOT EXISTS perp_trade_mirror (
      id VARCHAR(64) PRIMARY KEY,
      order_id VARCHAR(64) NOT NULL,
      pair_id VARCHAR(256),
      token VARCHAR(42) NOT NULL,
      trader VARCHAR(42) NOT NULL,
      is_long BOOLEAN NOT NULL,
      is_maker BOOLEAN NOT NULL,
      size VARCHAR(78) NOT NULL,
      price VARCHAR(78) NOT NULL,
      fee VARCHAR(78) NOT NULL DEFAULT '0',
      realized_pnl VARCHAR(78) NOT NULL DEFAULT '0',
      timestamp BIGINT NOT NULL,
      type VARCHAR(32) NOT NULL DEFAULT 'normal'
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ptm_trader ON perp_trade_mirror(trader)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ptm_token ON perp_trade_mirror(token)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ptm_timestamp ON perp_trade_mirror(timestamp)`;
  logger.info("Postgres", "Mirror table ready: perp_trade_mirror");

  // Bills table (append-only ledger)
  await sql`
    CREATE TABLE IF NOT EXISTS perp_bills (
      id VARCHAR(64) PRIMARY KEY,
      trader VARCHAR(42) NOT NULL,
      type VARCHAR(32) NOT NULL,
      amount VARCHAR(78) NOT NULL,
      balance_after VARCHAR(78) NOT NULL DEFAULT '0',
      position_id VARCHAR(256),
      order_id VARCHAR(64),
      token VARCHAR(42),
      reason TEXT,
      timestamp BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_pb_trader ON perp_bills(trader)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pb_type ON perp_bills(trader, type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pb_timestamp ON perp_bills(timestamp)`;
  logger.info("Postgres", "Mirror table ready: perp_bills");

  // Mode2 adjustments (cumulative per-trader)
  await sql`
    CREATE TABLE IF NOT EXISTS perp_mode2_adjustments (
      trader VARCHAR(42) PRIMARY KEY,
      cumulative_amount VARCHAR(78) NOT NULL DEFAULT '0',
      updated_at BIGINT NOT NULL
    )
  `;
  logger.info("Postgres", "Mirror table ready: perp_mode2_adjustments");

  // Mode2 audit log (append-only)
  await sql`
    CREATE TABLE IF NOT EXISTS perp_mode2_log (
      id SERIAL PRIMARY KEY,
      trader VARCHAR(42) NOT NULL,
      amount VARCHAR(78) NOT NULL,
      reason TEXT,
      cumulative_after VARCHAR(78) NOT NULL,
      timestamp BIGINT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_pml_trader ON perp_mode2_log(trader)`;
  logger.info("Postgres", "Mirror table ready: perp_mode2_log");

  // Balance snapshots (one row per trader, updated periodically)
  await sql`
    CREATE TABLE IF NOT EXISTS perp_balance_snapshots (
      trader VARCHAR(42) PRIMARY KEY,
      total_balance VARCHAR(78) NOT NULL DEFAULT '0',
      available_balance VARCHAR(78) NOT NULL DEFAULT '0',
      used_margin VARCHAR(78) NOT NULL DEFAULT '0',
      frozen_margin VARCHAR(78) NOT NULL DEFAULT '0',
      unrealized_pnl VARCHAR(78) NOT NULL DEFAULT '0',
      settlement_available VARCHAR(78) NOT NULL DEFAULT '0',
      mode2_adjustment VARCHAR(78) NOT NULL DEFAULT '0',
      snapshot_time BIGINT NOT NULL
    )
  `;
  logger.info("Postgres", "Mirror table ready: perp_balance_snapshots");
}

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


// ============================================================
// Sync State Repository (L1 — event poller block cursors)
// ============================================================

export const SyncStateRepo = {
  async upsert(key: string, value: string): Promise<void> {
    if (!sql || !isConnected) return;
    try {
      await sql`
        INSERT INTO sync_states (key, value, updated_at) VALUES (${key}, ${value}, ${Date.now()})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to upsert sync state ${key}: ${error.message}`);
    }
  },

  async get(key: string): Promise<string | null> {
    if (!sql || !isConnected) return null;
    try {
      const [row] = await sql`SELECT value FROM sync_states WHERE key = ${key}`;
      return row?.value ?? null;
    } catch {
      return null;
    }
  },
};

// ============================================================
// Funding Rate History Repository (M2)
// ============================================================

export const FundingRateMirrorRepo = {
  async insert(data: {
    token: string;
    longRate: string;
    shortRate: string;
    displayRate: string;
    totalCollected: string;
    longOi: string;
    shortOi: string;
  }): Promise<void> {
    if (!sql || !isConnected) return;

    try {
      await sql`
        INSERT INTO funding_rate_history (token, long_rate, short_rate, display_rate, total_collected, long_oi, short_oi, funding_time)
        VALUES (${data.token}, ${data.longRate}, ${data.shortRate}, ${data.displayRate}, ${data.totalCollected}, ${data.longOi}, ${data.shortOi}, ${Date.now()})
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to insert funding rate: ${error.message}`);
      throw error;
    }
  },

  async getByToken(token: string, limit = 100): Promise<any[]> {
    if (!sql || !isConnected) return [];

    try {
      return await sql`
        SELECT * FROM funding_rate_history
        WHERE token = ${token}
        ORDER BY funding_time DESC
        LIMIT ${limit}
      `;
    } catch (error: any) {
      logger.error("Postgres", `Failed to get funding rates for ${token}: ${error.message}`);
      return [];
    }
  },
};

// ============================================================
// P0-2: pgMirrorWrite Helper (可靠镜像写入 + 失败计数)
// ============================================================
// 替换现有的静默 .catch(console.error) 模式
// 写入失败不阻塞主流程，但累计计数 + 定期告警

let pgWriteFailures = 0;
let pgWriteRetries = 0;
const PG_FAILURE_ALERT_THRESHOLD = 10;
const PG_MAX_RETRIES = 3;
const PG_RETRY_BASE_MS = 500; // exponential backoff: 500ms, 1s, 2s

export function pgMirrorWrite(repoCall: Promise<void>, context: string): void {
  repoCall.catch((e: any) => {
    pgWriteFailures++;
    logger.error("PG-MIRROR", `${context} failed (#${pgWriteFailures}): ${e.message}`);
    if (pgWriteFailures % PG_FAILURE_ALERT_THRESHOLD === 0) {
      logger.error("PG-MIRROR", `🚨 ${pgWriteFailures} total failures — check PostgreSQL connection`);
    }
  });
}

/**
 * Enhanced pgMirrorWrite with retry + exponential backoff.
 * Use for critical writes (bills, mode2, positions) that must not be silently lost.
 * Pattern: Drift Protocol retry queue with bounded attempts.
 */
export function pgMirrorWriteWithRetry(
  repoCallFn: () => Promise<void>,
  context: string,
  attempt = 0,
): void {
  repoCallFn().catch((e: any) => {
    pgWriteFailures++;
    if (attempt < PG_MAX_RETRIES) {
      const delayMs = PG_RETRY_BASE_MS * Math.pow(2, attempt);
      pgWriteRetries++;
      logger.warn("PG-MIRROR", `${context} retry ${attempt + 1}/${PG_MAX_RETRIES} in ${delayMs}ms: ${e.message}`);
      setTimeout(() => pgMirrorWriteWithRetry(repoCallFn, context, attempt + 1), delayMs);
    } else {
      logger.error("PG-MIRROR", `${context} PERMANENTLY FAILED after ${PG_MAX_RETRIES} retries: ${e.message}`);
      if (pgWriteFailures % PG_FAILURE_ALERT_THRESHOLD === 0) {
        logger.error("PG-MIRROR", `🚨 ${pgWriteFailures} total failures — check PostgreSQL connection`);
      }
    }
  });
}

export function getPgMirrorStats(): { failures: number } {
  return { failures: pgWriteFailures };
}

export default {
  connect: connectPostgres,
  disconnect: disconnectPostgres,
  isConnected: isPostgresConnected,
  OrderMirrorRepo,
  PositionMirrorRepo,
  TradeMirrorRepo,
  Mode2AdjustmentMirrorRepo,
  BillMirrorRepo,
  BalanceSnapshotRepo,
  FundingRateMirrorRepo,
  SyncStateRepo,
  WalletRepo,
  TradeHistoryRepo,
  pgMirrorWrite,
  pgMirrorWriteWithRetry,
  getPgMirrorStats,
};
