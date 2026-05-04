/**
 * 保证金批量操作模块 — 派生钱包 ↔ PerpVault 保证金锁定/释放
 *
 * 架构: 乐观执行 (Optimistic Execution)
 * 1. 撮合引擎即时撮合，内存软锁定余额 (用户看到即时反馈)
 * 2. 异步批量上链: 每 MARGIN_FLUSH_INTERVAL_MS 一批
 * 3. 链上确认后转为 confirmed
 * 4. 链上失败则回滚 (强平仓位 + 通知用户)
 *
 * 依赖:
 * - perpVault.ts: 复用 globalTxLock + nonce 管理机制
 * - wallet.ts: 获取派生钱包签名密钥 (代签链上交易)
 */

import { createWalletClient, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { PERP_VAULT_ADDRESS, rpcTransport } from "../config";
import { getActiveSessionForDerived, getSigningKey } from "./wallet";
import { isPerpVaultEnabled, txLockRef } from "./perpVault";
import { logger } from "../utils/logger";

// ============================================================
// PerpVault Margin ABI (new functions from Phase 1)
// ============================================================

const MARGIN_ABI = [
  {
    name: "depositMargin",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    name: "withdrawMargin",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "trader", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "settleClose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "trader", type: "address" },
      { name: "pnl", type: "int256" },
      { name: "marginRelease", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "batchSettleClose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "traders", type: "address[]" },
      { name: "pnls", type: "int256[]" },
      { name: "marginReleases", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    name: "getTraderMargin",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ============================================================
// Types
// ============================================================

export interface PendingMarginOp {
  type: "DEPOSIT" | "SETTLE_CLOSE" | "WITHDRAW";
  trader: Address;
  token?: Address;
  amount: bigint;          // margin amount
  pnl?: bigint;            // only for SETTLE_CLOSE (signed)
  marginRelease?: bigint;  // only for SETTLE_CLOSE
  orderId?: string;        // for rollback tracing
  positionId?: string;     // for rollback tracing
  timestamp: number;
  retryCount: number;
}

// ============================================================
// State
// ============================================================

const pendingMarginOps: PendingMarginOp[] = [];
let marginFlushIntervalId: NodeJS.Timer | null = null;

// Global tx lock — shared with perpVault.ts via txLockRef
// Prevents nonce collisions between OI flush, settlement batch, and margin flush

const MARGIN_FLUSH_INTERVAL_MS = 10_000; // 10 seconds
const MAX_RETRIES = 3;

// Metrics
let depositsExecuted = 0;
let depositsFailed = 0;
let settlementsExecuted = 0;
let settlementsFailed = 0;

// Wallet client cache: derivedAddress → walletClient
const walletClientCache = new Map<Address, any>();

// Engine wallet client (for authorized-only calls like settleClose, withdrawMargin)
let engineWalletClient: any = null;
let publicClient: any = null;

// ============================================================
// Initialization
// ============================================================

export function initMarginBatch(
  _publicClient: any,
  _engineWalletClient: any
): void {
  publicClient = _publicClient;
  engineWalletClient = _engineWalletClient;
  logger.info("MarginBatch", "Module initialized");
}

// ============================================================
// Queue Operations (called synchronously from server.ts)
// ============================================================

/**
 * Queue a margin deposit for a trader's derived wallet → PerpVault.
 * Called when an order is filled and margin needs to be locked on-chain.
 */
export function queueMarginDeposit(
  trader: Address,
  amount: bigint,
  orderId?: string,
  token?: Address
): void {
  if (amount === 0n) return;
  pendingMarginOps.push({
    type: "DEPOSIT",
    trader,
    amount,
    orderId,
    token,
    timestamp: Date.now(),
    retryCount: 0,
  });
  logger.debug("MarginBatch", `DEPOSIT queued: trader=${trader.slice(0, 10)} amount=${amount} (queue: ${pendingMarginOps.length})`);
}

/**
 * Queue a position close settlement: PerpVault releases margin ± PnL to derived wallet.
 * Called when a position is closed.
 */
export function queueSettleClose(
  trader: Address,
  pnl: bigint,
  marginRelease: bigint,
  positionId?: string
): void {
  if (marginRelease === 0n && pnl === 0n) return;
  pendingMarginOps.push({
    type: "SETTLE_CLOSE",
    trader,
    amount: marginRelease,
    pnl,
    marginRelease,
    positionId,
    timestamp: Date.now(),
    retryCount: 0,
  });
  logger.debug("MarginBatch", `SETTLE_CLOSE queued: trader=${trader.slice(0, 10)} pnl=${pnl} margin=${marginRelease} (queue: ${pendingMarginOps.length})`);
}

/**
 * Queue a margin withdrawal: PerpVault → derived wallet.
 * Called when a trader reduces margin on an open position.
 */
export function queueMarginWithdraw(
  trader: Address,
  amount: bigint
): void {
  if (amount === 0n) return;
  pendingMarginOps.push({
    type: "WITHDRAW",
    trader,
    amount,
    timestamp: Date.now(),
    retryCount: 0,
  });
  logger.debug("MarginBatch", `WITHDRAW queued: trader=${trader.slice(0, 10)} amount=${amount} (queue: ${pendingMarginOps.length})`);
}

// ============================================================
// Flush Logic (async batch execution)
// ============================================================

/**
 * Flush all pending margin operations to chain.
 * Groups operations by type and executes:
 * - DEPOSIT: Each trader sends from their own derived wallet → PerpVault
 * - SETTLE_CLOSE: Engine calls PerpVault.batchSettleClose() (batched)
 * - WITHDRAW: Engine calls PerpVault.withdrawMargin() per trader
 */
export async function flushMarginQueue(): Promise<void> {
  if (!isPerpVaultEnabled() || !engineWalletClient || !publicClient) return;
  if (pendingMarginOps.length === 0) return;
  if (txLockRef.locked) return;

  txLockRef.locked = true;

  // Snapshot and clear
  const snapshot = [...pendingMarginOps];
  pendingMarginOps.length = 0;

  const deposits = snapshot.filter(op => op.type === "DEPOSIT");
  const settles = snapshot.filter(op => op.type === "SETTLE_CLOSE");
  const withdraws = snapshot.filter(op => op.type === "WITHDRAW");

  try {
    // 1. Process DEPOSIT ops — each trader signs from their own wallet
    await processDeposits(deposits);

    // 2. Process SETTLE_CLOSE ops — engine calls batchSettleClose
    await processSettlements(settles);

    // 3. Process WITHDRAW ops — engine calls withdrawMargin per trader
    await processWithdrawals(withdraws);

  } catch (error: any) {
    logger.error("MarginBatch", `Flush error: ${error?.message?.slice(0, 200)}`);
  } finally {
    txLockRef.locked = false;
  }
}

// ============================================================
// DEPOSIT: Derived wallet → PerpVault.depositMargin()
// ============================================================

async function processDeposits(ops: PendingMarginOp[]): Promise<void> {
  for (const op of ops) {
    try {
      const traderWalletClient = await getOrCreateWalletClient(op.trader);
      if (!traderWalletClient) {
        logger.error("MarginBatch", `No wallet client for ${op.trader.slice(0, 10)} — cannot deposit margin`);
        handleDepositFailure(op);
        continue;
      }

      const txHash = await traderWalletClient.writeContract({
        address: PERP_VAULT_ADDRESS!,
        abi: MARGIN_ABI,
        functionName: "depositMargin",
        value: op.amount,
      });

      depositsExecuted++;
      logger.info("MarginBatch", `DEPOSIT ok: trader=${op.trader.slice(0, 10)} amount=${op.amount} tx=${txHash}`);

    } catch (error: any) {
      depositsFailed++;
      const msg = error?.shortMessage || error?.message || String(error);
      logger.error("MarginBatch", `DEPOSIT failed: trader=${op.trader.slice(0, 10)} amount=${op.amount} error=${msg.slice(0, 150)}`);

      if (op.retryCount < MAX_RETRIES) {
        op.retryCount++;
        pendingMarginOps.push(op); // Re-queue for retry
        logger.info("MarginBatch", `DEPOSIT re-queued (retry ${op.retryCount}/${MAX_RETRIES})`);
      } else {
        handleDepositFailure(op);
      }
    }
  }
}

// ============================================================
// SETTLE_CLOSE: Engine → PerpVault.batchSettleClose()
// ============================================================

async function processSettlements(ops: PendingMarginOp[]): Promise<void> {
  if (ops.length === 0) return;

  // Batch all settlements into one call
  const traders: Address[] = [];
  const pnls: bigint[] = [];
  const marginReleases: bigint[] = [];

  for (const op of ops) {
    traders.push(op.trader);
    pnls.push(op.pnl ?? 0n);
    marginReleases.push(op.marginRelease ?? 0n);
  }

  try {
    const txHash = await engineWalletClient.writeContract({
      address: PERP_VAULT_ADDRESS!,
      abi: MARGIN_ABI,
      functionName: "batchSettleClose",
      args: [traders, pnls, marginReleases],
    });

    settlementsExecuted += ops.length;
    logger.info("MarginBatch", `BATCH_SETTLE ok: ${ops.length} traders, tx=${txHash}`);

  } catch (error: any) {
    settlementsFailed += ops.length;
    const msg = error?.shortMessage || error?.message || String(error);
    logger.error("MarginBatch", `BATCH_SETTLE failed: ${ops.length} traders, error=${msg.slice(0, 200)}`);

    // Re-queue all for retry
    for (const op of ops) {
      if (op.retryCount < MAX_RETRIES) {
        op.retryCount++;
        pendingMarginOps.push(op);
      } else {
        logger.error("MarginBatch", `SETTLE_CLOSE max retries: trader=${op.trader.slice(0, 10)} — needs manual resolution`);
      }
    }
  }
}

// ============================================================
// WITHDRAW: Engine → PerpVault.withdrawMargin()
// ============================================================

async function processWithdrawals(ops: PendingMarginOp[]): Promise<void> {
  for (const op of ops) {
    try {
      const txHash = await engineWalletClient.writeContract({
        address: PERP_VAULT_ADDRESS!,
        abi: MARGIN_ABI,
        functionName: "withdrawMargin",
        args: [op.trader, op.amount],
      });

      logger.info("MarginBatch", `WITHDRAW ok: trader=${op.trader.slice(0, 10)} amount=${op.amount} tx=${txHash}`);

    } catch (error: any) {
      const msg = error?.shortMessage || error?.message || String(error);
      logger.error("MarginBatch", `WITHDRAW failed: trader=${op.trader.slice(0, 10)} error=${msg.slice(0, 150)}`);

      if (op.retryCount < MAX_RETRIES) {
        op.retryCount++;
        pendingMarginOps.push(op);
      }
    }
  }
}

// ============================================================
// Failure Handling
// ============================================================

// Callback: set by server.ts to handle position rollback
let onDepositFailure: ((op: PendingMarginOp) => Promise<void>) | null = null;

export function setOnDepositFailure(handler: (op: PendingMarginOp) => Promise<void>): void {
  onDepositFailure = handler;
}

async function handleDepositFailure(op: PendingMarginOp): Promise<void> {
  logger.error("MarginBatch", `DEPOSIT permanently failed: trader=${op.trader.slice(0, 10)} amount=${op.amount} orderId=${op.orderId}`);
  if (onDepositFailure) {
    try {
      await onDepositFailure(op);
    } catch (e: any) {
      logger.error("MarginBatch", `Deposit failure handler error: ${e?.message?.slice(0, 100)}`);
    }
  }
}

// ============================================================
// Wallet Client Management
// ============================================================

/**
 * Get or create a viem WalletClient for a trader's derived wallet.
 * Uses the session system to retrieve the private key.
 */
async function getOrCreateWalletClient(traderAddress: Address): Promise<any | null> {
  const normalized = traderAddress.toLowerCase() as Address;

  // Cache hit
  const cached = walletClientCache.get(normalized);
  if (cached) return cached;

  // Look up session → signing key
  const sessionId = await getActiveSessionForDerived(normalized);
  if (!sessionId) {
    logger.warn("MarginBatch", `No active session for ${normalized.slice(0, 10)}`);
    return null;
  }

  const signingKey = await getSigningKey(sessionId);
  if (!signingKey) {
    logger.warn("MarginBatch", `Cannot decrypt signing key for ${normalized.slice(0, 10)}`);
    return null;
  }

  const account = privateKeyToAccount(signingKey);
  const chain = bsc;
  const client = createWalletClient({
    account,
    chain,
    transport: rpcTransport,
  });

  walletClientCache.set(normalized, client);
  return client;
}

/**
 * Invalidate cached wallet client (e.g., when session expires)
 */
export function invalidateWalletClient(traderAddress: Address): void {
  walletClientCache.delete(traderAddress.toLowerCase() as Address);
}

/**
 * 直接注册交易钱包私钥（用于 API-only 做市商 / 内部服务）
 * 参考 Hyperliquid approveAgent 模式 — 做市商无需 session 派生流程
 */
export function registerWalletKey(traderAddress: Address, privateKey: Hex): void {
  const normalized = traderAddress.toLowerCase() as Address;
  const account = privateKeyToAccount(privateKey);
  const chain = bsc;
  const client = createWalletClient({
    account,
    chain,
    transport: rpcTransport,
  });
  walletClientCache.set(normalized, client);
  logger.info("MarginBatch", `Registered wallet key directly for ${normalized.slice(0, 10)}`);
}

// ============================================================
// Chain Read Functions
// ============================================================

/**
 * Read trader's on-chain locked margin from PerpVault
 */
export async function getOnChainTraderMargin(trader: Address): Promise<bigint> {
  if (!publicClient || !PERP_VAULT_ADDRESS) return 0n;

  try {
    const margin = await publicClient.readContract({
      address: PERP_VAULT_ADDRESS,
      abi: MARGIN_ABI,
      functionName: "getTraderMargin",
      args: [trader],
    });
    return margin as bigint;
  } catch {
    return 0n;
  }
}

// ============================================================
// Lifecycle
// ============================================================

export function startMarginFlush(): void {
  if (marginFlushIntervalId) return;
  marginFlushIntervalId = setInterval(flushMarginQueue, MARGIN_FLUSH_INTERVAL_MS);
  logger.info("MarginBatch", `Margin flush started (interval: ${MARGIN_FLUSH_INTERVAL_MS}ms)`);
}

export function stopMarginFlush(): void {
  if (marginFlushIntervalId) {
    clearInterval(marginFlushIntervalId);
    marginFlushIntervalId = null;
    logger.info("MarginBatch", "Margin flush stopped");
  }
}

// ============================================================
// Metrics
// ============================================================

export function getMarginBatchMetrics() {
  return {
    queueLength: pendingMarginOps.length,
    depositsExecuted,
    depositsFailed,
    settlementsExecuted,
    settlementsFailed,
    walletClientCacheSize: walletClientCache.size,
  };
}

export function getPendingMarginOps(): readonly PendingMarginOp[] {
  return pendingMarginOps;
}
