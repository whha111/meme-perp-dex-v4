/**
 * TradingVault 模块 — Unified fund custody (user margin + LP pool)
 *
 * Architecture:
 * TradingVault = SettlementV2 (user margin, withdrawals) + PerpVault (LP pool, settlement, OI)
 * All funds in ONE contract as WBNB. Settlement is pure bookkeeping (no cross-contract transfers).
 *
 * 功能:
 * 1. 查询链上 TradingVault 池子状态 (poolValue, sharePrice, OI)
 * 2. 在开/平仓时执行链上 OI 更新
 * 3. 在平仓/清算时执行链上结算 (settleTraderProfit/Loss, settleLiquidation)
 *    — 全部 nonpayable，纯记账，不需要 engine wallet 有 BNB
 * 4. 收取交易手续费 (collectFee) — nonpayable，纯记账
 *
 * 使用方式:
 * - server.ts 启动时调用 initPerpVault()
 * - position.ts 开仓时调用 increaseOI()
 * - position.ts 平仓时调用 decreaseOI() + settleTraderPnL()
 * - liquidation.ts 清算时调用 settleLiquidation()
 * - funding.ts 资金费结算时调用 collectTradingFee()
 */

import type { Address, Hex } from "viem";
import { logger } from "../utils/logger";

// ============================================================
// TradingVault ABI (minimal — only what we need)
// ============================================================

const PERP_VAULT_ABI = [
  {
    name: "getPoolValue",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getSharePrice",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getMaxOI",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getTotalOI",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getTokenOI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "long_", type: "uint256" },
      { name: "short_", type: "uint256" },
    ],
  },
  {
    name: "getPoolStats",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "poolValue", type: "uint256" },
      { name: "sharePrice", type: "uint256" },
      { name: "_totalShares", type: "uint256" },
      { name: "totalOI", type: "uint256" },
      { name: "maxOI", type: "uint256" },
      { name: "utilization", type: "uint256" },
      { name: "_totalFeesCollected", type: "uint256" },
      { name: "_totalProfitsPaid", type: "uint256" },
      { name: "_totalLossesReceived", type: "uint256" },
      { name: "_totalLiquidationReceived", type: "uint256" },
    ],
  },
  {
    name: "getLPValue",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "lp", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "shares",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getLPWithdrawalInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "lp", type: "address" }],
    outputs: [
      { name: "pendingShares", type: "uint256" },
      { name: "requestTime", type: "uint256" },
      { name: "executeAfter", type: "uint256" },
      { name: "estimatedETH", type: "uint256" },
    ],
  },
  {
    name: "getUtilization",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  // ── Write functions ──
  {
    name: "settleTraderProfit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "trader", type: "address" },
      { name: "profitETH", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "settleTraderLoss",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "lossETH", type: "uint256" }],
    outputs: [],
  },
  {
    name: "settleLiquidation",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "collateralETH", type: "uint256" },
      { name: "liquidatorReward", type: "uint256" },
      { name: "liquidator", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "increaseOI",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "isLong", type: "bool" },
      { name: "sizeETH", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "decreaseOI",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "isLong", type: "bool" },
      { name: "sizeETH", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "collectFee",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "feeETH", type: "uint256" }],
    outputs: [],
  },
] as const;

// ============================================================
// Types
// ============================================================

export interface PerpVaultPoolStats {
  poolValue: bigint;
  sharePrice: bigint;
  totalShares: bigint;
  totalOI: bigint;
  maxOI: bigint;
  utilization: bigint;
  totalFeesCollected: bigint;
  totalProfitsPaid: bigint;
  totalLossesReceived: bigint;
  totalLiquidationReceived: bigint;
}

export interface PerpVaultLPInfo {
  shares: bigint;
  value: bigint;
  pendingWithdrawalShares: bigint;
  withdrawalRequestTime: bigint;
  withdrawalExecuteAfter: bigint;
  withdrawalEstimatedETH: bigint;
}

// ============================================================
// State
// ============================================================

let publicClient: any = null;
let walletClient: any = null;
let perpVaultAddress: Address | null = null;
let initialized = false;

// Metrics
let settlementsExecuted = 0;
let settlementsFailed = 0;
let oiUpdatesExecuted = 0;
let oiUpdatesFailed = 0;
let feesCollectedCount = 0;
let batchesExecuted = 0;
let batchesSkippedLowBalance = 0;

// Cache (refreshed every 5s)
let cachedPoolStats: PerpVaultPoolStats | null = null;
let lastPoolStatsFetch = 0;
const POOL_STATS_CACHE_MS = 5000;

// ============================================================
// Batch Settlement Queue
// ============================================================

/**
 * TradingVault settlement calls (settleTraderLoss, settleLiquidation, collectFee,
 * settleTraderProfit) are all nonpayable — pure bookkeeping that adjusts lpPoolBalance.
 * We still batch them for retry + nonce safety (sequential on-chain tx ordering).
 */

interface PendingLossSettlement {
  type: "loss";
  amount: bigint;
  timestamp: number;
}

interface PendingLiquidationSettlement {
  type: "liquidation";
  collateralETH: bigint;
  liquidatorReward: bigint;
  liquidator: Address;
  timestamp: number;
}

// P3-P4: Add profit to queue (was fire-and-forget, no retry on failure)
interface PendingProfitSettlement {
  type: "profit";
  trader: Address;
  amount: bigint;
  timestamp: number;
}

interface PendingFeeCollection {
  type: "fee";
  amount: bigint;
  timestamp: number;
}

type PendingSettlement = PendingLossSettlement | PendingProfitSettlement | PendingLiquidationSettlement | PendingFeeCollection;

const pendingSettlements: PendingSettlement[] = [];
let batchSettlementIntervalId: NodeJS.Timer | null = null;

const MIN_WALLET_BALANCE_WEI = 50_000_000_000_000_000n; // 0.05 ETH — below this, warn
const BATCH_INTERVAL_MS = 30_000; // 30 seconds
const OI_FLUSH_INTERVAL_MS = 10_000; // 10 seconds

// ============================================================
// Global tx lock — prevents OI flush and batch settlement from
// sending on-chain txs simultaneously (nonce collision protection)
// Shared as ref object so marginBatch.ts can also acquire the lock
// ============================================================
let globalTxLock = false;

/** Shared lock ref for cross-module access (marginBatch.ts) */
export const txLockRef = {
  get locked() { return globalTxLock; },
  set locked(v: boolean) { globalTxLock = v; },
};

// ============================================================
// Per-token OI tracking: graduated (DEX) tokens track OI, internal (bonding curve) skip
// ============================================================
let graduatedTokensSet = new Set<string>();

// ============================================================
// Engine-side OI mirror + Circuit Breaker
// ============================================================
// Engine maintains its own OI tracking so we don't need to hit RPC for every pre-check.
// Circuit breaker trips when on-chain OI update fails with ExceedsMaxOI — pauses new
// positions for that token until pool grows or OI decreases enough.

/** Engine-side OI mirror per token per side */
const engineOI = new Map<string, bigint>(); // key: `${token}_${isLong}` → size in wei

/** Circuit breaker state per token */
interface CircuitBreakerState {
  status: "CLOSED" | "OPEN";     // CLOSED = normal, OPEN = paused
  trippedAt: number;             // timestamp when breaker opened
  reason: string;                // why it tripped
  lastCheckAt: number;           // last time we checked if pool grew
  consecutiveFailures: number;   // how many OI flush failures in a row
}
const circuitBreakers = new Map<string, CircuitBreakerState>();

const BREAKER_RECHECK_INTERVAL_MS = 60_000;  // Re-check every 60s if breaker can close
const BREAKER_MAX_CONSECUTIVE = 3;            // Trip after 3 consecutive ExceedsMaxOI

/** Get engine-tracked OI for a token side */
export function getEngineOI(token: string, isLong: boolean): bigint {
  return engineOI.get(`${token.toLowerCase()}_${isLong}`) || 0n;
}

/** Get total engine-tracked OI across all tokens */
export function getEngineTotalOI(): bigint {
  let total = 0n;
  for (const v of engineOI.values()) {
    total += v > 0n ? v : 0n;
  }
  return total;
}

/** Update engine OI mirror (called on position open/close) */
function updateEngineOI(token: string, isLong: boolean, delta: bigint): void {
  const key = `${token.toLowerCase()}_${isLong}`;
  const current = engineOI.get(key) || 0n;
  const updated = current + delta;
  engineOI.set(key, updated > 0n ? updated : 0n);
}

/** Check if circuit breaker is open for a token */
export function isCircuitBreakerOpen(token: string): boolean {
  const state = circuitBreakers.get(token.toLowerCase());
  return state?.status === "OPEN";
}

/** Get circuit breaker status for all tokens */
export function getCircuitBreakerStatus(): Record<string, CircuitBreakerState> {
  const result: Record<string, CircuitBreakerState> = {};
  for (const [k, v] of circuitBreakers) {
    result[k] = { ...v };
  }
  return result;
}

/** Trip the circuit breaker for a token */
function tripCircuitBreaker(token: string, reason: string): void {
  const normalized = token.toLowerCase();
  const existing = circuitBreakers.get(normalized);
  if (existing?.status === "OPEN") return; // Already open

  circuitBreakers.set(normalized, {
    status: "OPEN",
    trippedAt: Date.now(),
    reason,
    lastCheckAt: Date.now(),
    consecutiveFailures: existing?.consecutiveFailures || BREAKER_MAX_CONSECUTIVE,
  });
  logger.warn("PerpVault", `⚡ CIRCUIT BREAKER OPEN for ${normalized.slice(0, 10)}: ${reason}`);
}

/** Record OI flush failure for a token; trip breaker after N consecutive failures */
function recordOIFlushFailure(token: string, errorMsg: string): void {
  const normalized = token.toLowerCase();
  const state = circuitBreakers.get(normalized) || {
    status: "CLOSED" as const,
    trippedAt: 0,
    reason: "",
    lastCheckAt: 0,
    consecutiveFailures: 0,
  };
  state.consecutiveFailures++;

  if (state.consecutiveFailures >= BREAKER_MAX_CONSECUTIVE) {
    tripCircuitBreaker(normalized, `${BREAKER_MAX_CONSECUTIVE}x ExceedsMaxOI: ${errorMsg.slice(0, 80)}`);
  } else {
    circuitBreakers.set(normalized, state);
  }
}

/** Record OI flush success for a token; reset failure counter */
function recordOIFlushSuccess(token: string): void {
  const normalized = token.toLowerCase();
  const state = circuitBreakers.get(normalized);
  if (state) {
    state.consecutiveFailures = 0;
    if (state.status === "OPEN") {
      state.status = "CLOSED";
      logger.info("PerpVault", `✅ CIRCUIT BREAKER CLOSED for ${normalized.slice(0, 10)} — OI flush succeeded`);
    }
  }
}

/** Periodically try to close open circuit breakers by checking if maxOI increased */
async function tryRecoverCircuitBreakers(): Promise<void> {
  if (!isPerpVaultEnabled() || !publicClient) return;

  const now = Date.now();
  for (const [token, state] of circuitBreakers) {
    if (state.status !== "OPEN") continue;
    if (now - state.lastCheckAt < BREAKER_RECHECK_INTERVAL_MS) continue;

    state.lastCheckAt = now;

    try {
      const maxOI = (await publicClient.readContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: "getMaxOI",
      })) as bigint;

      const totalChainOI = (await publicClient.readContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: "getTotalOI",
      })) as bigint;

      // Check if there's now headroom on chain
      const pendingDelta = getPendingOIDeltaForToken(token);
      if (maxOI > 0n && totalChainOI + pendingDelta <= maxOI) {
        state.status = "CLOSED";
        state.consecutiveFailures = 0;
        logger.info("PerpVault", `✅ CIRCUIT BREAKER AUTO-RECOVERED for ${token.slice(0, 10)} — maxOI=${maxOI}, chainOI=${totalChainOI}, pending=${pendingDelta}`);
      } else {
        logger.debug("PerpVault", `⚡ Breaker still open for ${token.slice(0, 10)}: maxOI=${maxOI}, chainOI=${totalChainOI}, pending=${pendingDelta}`);
      }
    } catch {
      // RPC error — will retry next cycle
    }
  }
}

/** Sum pending OI deltas for a specific token */
function getPendingOIDeltaForToken(token: string): bigint {
  const normalized = token.toLowerCase();
  let total = 0n;
  for (const [key, delta] of pendingOIDelta) {
    if (key.startsWith(normalized + "_") && delta > 0n) {
      total += delta;
    }
  }
  return total;
}

/**
 * Engine-side OI pre-check: can we open a new position?
 *
 * Uses cached maxOI + engine-side OI mirror (no RPC call).
 * If circuit breaker is open, rejects immediately.
 */
let cachedMaxOI: bigint = 0n;
let lastMaxOIFetch = 0;
const MAX_OI_CACHE_MS = 30_000; // Refresh maxOI every 30s

export async function canOpenPosition(
  token: string,
  sizeETH: bigint
): Promise<{ allowed: boolean; reason?: string }> {
  const normalized = token.toLowerCase();

  // 1. Circuit breaker check (instant, no RPC)
  if (isCircuitBreakerOpen(normalized)) {
    const state = circuitBreakers.get(normalized)!;
    return {
      allowed: false,
      reason: `OI circuit breaker open for this token (since ${new Date(state.trippedAt).toISOString()}). Pool needs more LP liquidity.`,
    };
  }

  // 2. Engine-side OI check against cached maxOI
  const now = Date.now();
  if (now - lastMaxOIFetch > MAX_OI_CACHE_MS && isPerpVaultEnabled() && publicClient) {
    try {
      cachedMaxOI = (await publicClient.readContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: "getMaxOI",
      })) as bigint;
      lastMaxOIFetch = now;
    } catch {
      // Use stale cache — better than blocking
    }
  }

  if (cachedMaxOI > 0n) {
    const engineTotal = getEngineTotalOI();
    if (engineTotal + sizeETH > cachedMaxOI) {
      return {
        allowed: false,
        reason: `OI limit reached: current=${(Number(engineTotal) / 1e18).toFixed(2)}, new=${(Number(sizeETH) / 1e18).toFixed(4)}, max=${(Number(cachedMaxOI) / 1e18).toFixed(2)} BNB. Need more LP.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Update the set of graduated tokens (called from server.ts on graduation events).
 * Graduated tokens have LP pool as counterparty → must track OI.
 * Internal (bonding curve) tokens are pure P2P → skip OI.
 */
export function updateGraduatedTokens(tokens: Map<string, any>): void {
  const newSet = new Set<string>();
  for (const key of tokens.keys()) {
    newSet.add(key.toLowerCase());
  }
  graduatedTokensSet = newSet;
  logger.info("PerpVault", `Graduated tokens set updated: ${graduatedTokensSet.size} tokens`);
}

/**
 * Determine whether OI should be tracked for a given token.
 * LP 作为对手方后，所有活跃代币都需要追踪 OI 以防过度敞口。
 */
function shouldTrackOI(_token: Address): boolean {
  return true;
}

// ============================================================
// Batched OI Queue (prevents nonce conflicts from concurrent calls)
// ============================================================
// Key: `${token}_${isLong}` → net delta (positive = increase, negative = decrease)
const pendingOIDelta = new Map<string, bigint>();
let oiFlushIntervalId: NodeJS.Timer | null = null;

function queueOIDelta(token: Address, isLong: boolean, delta: bigint): void {
  const key = `${token.toLowerCase()}_${isLong}`;
  const existing = pendingOIDelta.get(key) || 0n;
  pendingOIDelta.set(key, existing + delta);
}

async function flushOIQueue(): Promise<void> {
  if (!isPerpVaultEnabled() || !walletClient || !publicClient || globalTxLock) return;
  if (pendingOIDelta.size === 0) {
    // Even if queue is empty, try recovering circuit breakers
    await tryRecoverCircuitBreakers();
    return;
  }

  globalTxLock = true;
  // Snapshot and clear the queue
  const snapshot = new Map(pendingOIDelta);
  pendingOIDelta.clear();

  let successCount = 0;
  let failCount = 0;
  let skippedBreaker = 0;

  // Fetch nonce once to avoid RPC staleness between sequential calls
  let nonce: number;
  try {
    nonce = await publicClient.getTransactionCount({
      address: walletClient.account.address,
      blockTag: "pending" as const,
    });
  } catch {
    // Re-queue everything if we can't even get the nonce
    for (const [key, delta] of snapshot.entries()) {
      const existing = pendingOIDelta.get(key) || 0n;
      pendingOIDelta.set(key, existing + delta);
    }
    globalTxLock = false;
    return;
  }

  for (const [key, delta] of snapshot.entries()) {
    if (delta === 0n) continue;

    const [tokenStr, isLongStr] = key.split("_");
    const token = tokenStr as Address;
    const isLong = isLongStr === "true";
    const isIncrease = delta > 0n;
    const absDelta = isIncrease ? delta : -delta;

    // Skip increase if circuit breaker is open for this token
    // (decrease OI should always go through — closing positions reduces risk)
    if (isIncrease && isCircuitBreakerOpen(token)) {
      // Keep in queue but don't retry this cycle — wait for recovery
      const existing = pendingOIDelta.get(key) || 0n;
      pendingOIDelta.set(key, existing + delta);
      skippedBreaker++;
      continue;
    }

    try {
      const txHash = await walletClient.writeContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: isIncrease ? "increaseOI" : "decreaseOI",
        args: [token, isLong, absDelta],
        nonce,
      });
      nonce++; // increment for next tx in this batch
      oiUpdatesExecuted++;
      cachedPoolStats = null;
      successCount++;

      // Record success — may close circuit breaker
      recordOIFlushSuccess(token);

      logger.info("PerpVault", `OI ${isIncrease ? "increased" : "decreased"} (batch): token=${token.slice(0, 10)} ${isLong ? "LONG" : "SHORT"} ${isIncrease ? "+" : "-"}${absDelta} tx=${txHash}`);
    } catch (error: any) {
      oiUpdatesFailed++;
      failCount++;
      const errorMsg = error?.shortMessage || error?.message || String(error);
      const isExceedsMaxOI = errorMsg.includes("0x8a9d1c41") || errorMsg.includes("ExceedsMaxOI");

      if (isExceedsMaxOI && isIncrease) {
        // ExceedsMaxOI on increase — record failure, may trip breaker
        recordOIFlushFailure(token, errorMsg);
        logger.warn("PerpVault", `OI ExceedsMaxOI: token=${token.slice(0, 10)} delta=${absDelta}. Failure #${circuitBreakers.get(token.toLowerCase())?.consecutiveFailures || 0}/${BREAKER_MAX_CONSECUTIVE}`);

        // Re-queue the delta (will be skipped by breaker on next flush)
        const existing = pendingOIDelta.get(key) || 0n;
        pendingOIDelta.set(key, existing + delta);
      } else {
        // Other errors (nonce, RPC, etc.) — re-queue and break
        logger.error("PerpVault", `OI batch ${isIncrease ? "increase" : "decrease"} FAILED: ${errorMsg.slice(0, 200)} | token=${token.slice(0, 10)} delta=${delta}`);
        const existing = pendingOIDelta.get(key) || 0n;
        pendingOIDelta.set(key, existing + delta);
      }

      // Break on first failure — subsequent nonces would be invalid
      // Re-queue remaining items
      let foundFailed = false;
      for (const [remainKey, remainDelta] of snapshot.entries()) {
        if (remainKey === key) { foundFailed = true; continue; }
        if (!foundFailed) continue;
        if (remainDelta === 0n) continue;
        const existingRemain = pendingOIDelta.get(remainKey) || 0n;
        pendingOIDelta.set(remainKey, existingRemain + remainDelta);
      }
      break;
    }
  }

  if (successCount > 0 || failCount > 0 || skippedBreaker > 0) {
    logger.info("PerpVault", `OI batch flush: ${successCount} ok, ${failCount} failed, ${skippedBreaker} breaker-skipped, ${pendingOIDelta.size} queued`);
  }

  // Try recovering circuit breakers after flush
  await tryRecoverCircuitBreakers();

  globalTxLock = false;
}

export function startOIFlush(): void {
  if (oiFlushIntervalId) return;
  // Always start the timer — graduated tokens may appear later.
  // The flush function already skips when pendingOIDelta is empty.
  // Per-token filtering happens in increaseOI/decreaseOI via shouldTrackOI().
  oiFlushIntervalId = setInterval(flushOIQueue, OI_FLUSH_INTERVAL_MS);
  if (process.env.SKIP_OI_TRACKING === "true") {
    logger.info("PerpVault", `OI flush timer started (per-token mode: only graduated tokens tracked)`);
  } else {
    logger.info("PerpVault", `OI batch flush started (interval: ${OI_FLUSH_INTERVAL_MS}ms)`);
  }
}

export function stopOIFlush(): void {
  if (oiFlushIntervalId) {
    clearInterval(oiFlushIntervalId);
    oiFlushIntervalId = null;
  }
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize PerpVault module
 * Must be called during server startup with blockchain clients
 */
export function initPerpVault(
  _publicClient: any,
  _walletClient: any,
  _perpVaultAddress: Address
): void {
  publicClient = _publicClient;
  walletClient = _walletClient;
  perpVaultAddress = _perpVaultAddress;
  initialized = true;

  logger.info("PerpVault", `Module initialized, TradingVault: ${perpVaultAddress}`);
}

/**
 * Check if PerpVault module is initialized and has a valid address
 */
export function isPerpVaultEnabled(): boolean {
  return initialized && perpVaultAddress !== null && perpVaultAddress !== ("" as Address);
}

// ============================================================
// Read Functions (on-chain queries)
// ============================================================

/**
 * Get pool value (lpPoolBalance - netPendingPnL from TradingVault)
 */
export async function getPoolValue(): Promise<bigint> {
  if (!isPerpVaultEnabled()) return 0n;

  try {
    return (await publicClient.readContract({
      address: perpVaultAddress!,
      abi: PERP_VAULT_ABI,
      functionName: "getPoolValue",
    })) as bigint;
  } catch (error) {
    logger.error("PerpVault", "Failed to get pool value:", error);
    return 0n;
  }
}

/**
 * Get share price (1e18 precision)
 */
export async function getSharePrice(): Promise<bigint> {
  if (!isPerpVaultEnabled()) return 10n ** 18n; // Default 1:1

  try {
    return (await publicClient.readContract({
      address: perpVaultAddress!,
      abi: PERP_VAULT_ABI,
      functionName: "getSharePrice",
    })) as bigint;
  } catch (error) {
    logger.error("PerpVault", "Failed to get share price:", error);
    return 10n ** 18n;
  }
}

/**
 * Get full pool stats (cached for 5s to reduce RPC calls)
 */
export async function getPoolStats(): Promise<PerpVaultPoolStats | null> {
  if (!isPerpVaultEnabled()) return null;

  const now = Date.now();
  if (cachedPoolStats && now - lastPoolStatsFetch < POOL_STATS_CACHE_MS) {
    return cachedPoolStats;
  }

  try {
    const result = (await publicClient.readContract({
      address: perpVaultAddress!,
      abi: PERP_VAULT_ABI,
      functionName: "getPoolStats",
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

    cachedPoolStats = {
      poolValue: result[0],
      sharePrice: result[1],
      totalShares: result[2],
      totalOI: result[3],
      maxOI: result[4],
      utilization: result[5],
      totalFeesCollected: result[6],
      totalProfitsPaid: result[7],
      totalLossesReceived: result[8],
      totalLiquidationReceived: result[9],
    };
    lastPoolStatsFetch = now;

    return cachedPoolStats;
  } catch (error) {
    logger.error("PerpVault", "Failed to get pool stats:", error);
    return null;
  }
}

/**
 * Get OI for a specific token
 */
export async function getTokenOI(token: Address): Promise<{ longOI: bigint; shortOI: bigint }> {
  if (!isPerpVaultEnabled()) return { longOI: 0n, shortOI: 0n };

  try {
    const result = (await publicClient.readContract({
      address: perpVaultAddress!,
      abi: PERP_VAULT_ABI,
      functionName: "getTokenOI",
      args: [token],
    })) as readonly [bigint, bigint];

    return { longOI: result[0], shortOI: result[1] };
  } catch (error) {
    logger.error("PerpVault", `Failed to get token OI for ${token.slice(0, 10)}:`, error);
    return { longOI: 0n, shortOI: 0n };
  }
}

/**
 * 动态 OI 上限计算
 *
 * tokenOICap = (LP池余额 + 保险基金) × coverageRatio%
 * 单仓上限 = tokenOICap × 10%
 *
 * coverageRatio 由 lifecycle.ts 的热度等级决定 (20%/35%/50%)
 */
export async function getDynamicOICap(
  insuranceFundBalance: bigint,
  coverageRatioPct: number
): Promise<bigint> {
  const lpBalance = await getPoolValue();
  const total = lpBalance + insuranceFundBalance;
  return (total * BigInt(coverageRatioPct)) / 100n;
}

/**
 * 获取单仓最大保证金
 */
export async function getMaxPositionMargin(
  insuranceFundBalance: bigint,
  coverageRatioPct: number
): Promise<bigint> {
  const oiCap = await getDynamicOICap(insuranceFundBalance, coverageRatioPct);
  return oiCap / 10n; // 单仓 = tokenOI × 10%
}

/**
 * 获取某代币的 OI 剩余可用额度 (LP fill 用)
 */
export async function getAvailableOIHeadroom(
  token: Address,
  insuranceFundBalance: bigint,
  coverageRatioPct: number
): Promise<bigint> {
  if (!isPerpVaultEnabled()) return 0n;
  try {
    const oiCap = await getDynamicOICap(insuranceFundBalance, coverageRatioPct);
    const { longOI, shortOI } = await getTokenOI(token);
    const currentOI = longOI + shortOI;
    return oiCap > currentOI ? oiCap - currentOI : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Check if a new position would exceed dynamic OI limits
 *
 * 优先使用动态 OI 上限，fallback 到链上 maxOI
 */
export async function canIncreaseOI(
  token: Address,
  isLong: boolean,
  sizeETH: bigint,
  insuranceFundBalance: bigint = 0n,
  coverageRatioPct: number = 0
): Promise<boolean> {
  if (!isPerpVaultEnabled()) return true;

  try {
    const totalOI = (await publicClient.readContract({
      address: perpVaultAddress!,
      abi: PERP_VAULT_ABI,
      functionName: "getTotalOI",
    })) as bigint;

    // 动态 OI 上限 (新经济模型)
    if (coverageRatioPct > 0) {
      const dynamicCap = await getDynamicOICap(insuranceFundBalance, coverageRatioPct);
      if (dynamicCap > 0n) {
        return totalOI + sizeETH <= dynamicCap;
      }
    }

    // Fallback: 链上静态 maxOI
    const maxOI = (await publicClient.readContract({
      address: perpVaultAddress!,
      abi: PERP_VAULT_ABI,
      functionName: "getMaxOI",
    })) as bigint;

    if (maxOI === 0n) return true;
    return totalOI + sizeETH <= maxOI;
  } catch (error) {
    logger.error("PerpVault", "Failed to check OI limits:", error);
    return true;
  }
}

/**
 * Get LP info for a specific address
 */
export async function getLPInfo(lp: Address): Promise<PerpVaultLPInfo | null> {
  if (!isPerpVaultEnabled()) return null;

  try {
    const [sharesResult, valueResult, withdrawalResult] = await Promise.all([
      publicClient.readContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: "shares",
        args: [lp],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: "getLPValue",
        args: [lp],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: "getLPWithdrawalInfo",
        args: [lp],
      }) as Promise<readonly [bigint, bigint, bigint, bigint]>,
    ]);

    return {
      shares: sharesResult,
      value: valueResult,
      pendingWithdrawalShares: withdrawalResult[0],
      withdrawalRequestTime: withdrawalResult[1],
      withdrawalExecuteAfter: withdrawalResult[2],
      withdrawalEstimatedETH: withdrawalResult[3],
    };
  } catch (error) {
    logger.error("PerpVault", `Failed to get LP info for ${lp.slice(0, 10)}:`, error);
    return null;
  }
}

// ============================================================
// Write Functions (on-chain transactions)
// ============================================================

/**
 * Settle trader PnL — either profit (pool pays) or loss (pool receives)
 *
 * Both are nonpayable in TradingVault — pure bookkeeping:
 * - Profit: lpPoolBalance -= amount (trader withdraws later via fastWithdraw)
 * - Loss: lpPoolBalance += amount
 * Queued for batch execution (nonce safety + retry).
 */
export async function settleTraderPnL(
  trader: Address,
  amount: bigint,
  isProfit: boolean
): Promise<{ success: boolean; txHash?: string }> {
  if (!isPerpVaultEnabled() || !walletClient) {
    logger.warn("PerpVault", "Not enabled or no wallet client — skipping PnL settlement");
    return { success: false };
  }

  if (amount === 0n) return { success: true };

  if (isProfit) {
    pendingSettlements.push({ type: "profit", trader, amount, timestamp: Date.now() });
    logger.debug("PerpVault", `Profit queued: trader=${trader.slice(0, 10)} amount=${amount} (queue size: ${pendingSettlements.length})`);
    return { success: true };
  } else {
    pendingSettlements.push({ type: "loss", amount, timestamp: Date.now() });
    logger.debug("PerpVault", `Loss queued: amount=${amount} (queue size: ${pendingSettlements.length})`);
    return { success: true };
  }
}

/**
 * Settle liquidation — collateral goes to pool, reward to liquidator (WBNB)
 * Nonpayable in TradingVault — pure bookkeeping. Queued for batch execution.
 */
export async function settleLiquidation(
  collateralETH: bigint,
  liquidatorReward: bigint,
  liquidator: Address
): Promise<{ success: boolean; txHash?: string }> {
  if (!isPerpVaultEnabled() || !walletClient) {
    return { success: false };
  }

  pendingSettlements.push({
    type: "liquidation",
    collateralETH,
    liquidatorReward,
    liquidator,
    timestamp: Date.now(),
  });
  logger.debug("PerpVault", `Liquidation queued: collateral=${collateralETH} reward=${liquidatorReward} (queue: ${pendingSettlements.length})`);
  return { success: true }; // Queued successfully
}

/**
 * Increase open interest (on position open)
 * Queued for batch execution to avoid nonce conflicts from concurrent calls.
 *
 * Pure P2P mode (SKIP_OI_TRACKING=true): OI tracking is skipped because
 * risk is symmetric between traders, not borne by an LP pool. The OI cap
 * protects LPs — in P2P mode there are no LPs during internal matching.
 */
export async function increaseOI(
  token: Address,
  isLong: boolean,
  sizeETH: bigint
): Promise<{ success: boolean }> {
  if (!shouldTrackOI(token)) return { success: true };
  if (!isPerpVaultEnabled() || !walletClient) return { success: false };
  if (sizeETH === 0n) return { success: true };

  // Update engine-side OI mirror (instant, no RPC)
  updateEngineOI(token, isLong, sizeETH);

  // Queue for on-chain batch flush
  queueOIDelta(token, isLong, sizeETH);
  logger.debug("PerpVault", `OI increase queued: token=${token.slice(0, 10)} ${isLong ? "LONG" : "SHORT"} +${sizeETH} engineOI=${getEngineOI(token, isLong)} (queue: ${pendingOIDelta.size})`);
  return { success: true };
}

/**
 * Decrease open interest (on position close)
 * Queued for batch execution to avoid nonce conflicts from concurrent calls.
 */
export async function decreaseOI(
  token: Address,
  isLong: boolean,
  sizeETH: bigint
): Promise<{ success: boolean }> {
  if (!shouldTrackOI(token)) return { success: true };
  if (!isPerpVaultEnabled() || !walletClient) return { success: false };
  if (sizeETH === 0n) return { success: true };

  // Update engine-side OI mirror (instant, no RPC)
  updateEngineOI(token, isLong, -sizeETH);

  // Queue for on-chain batch flush
  queueOIDelta(token, isLong, -sizeETH);
  logger.debug("PerpVault", `OI decrease queued: token=${token.slice(0, 10)} ${isLong ? "LONG" : "SHORT"} -${sizeETH} engineOI=${getEngineOI(token, isLong)} (queue: ${pendingOIDelta.size})`);
  return { success: true };
}

/**
 * Collect trading fee — credited to LP pool, increasing share price
 * Nonpayable in TradingVault — pure bookkeeping. Queued for batch execution.
 */
export async function collectTradingFee(
  feeETH: bigint
): Promise<{ success: boolean; txHash?: string }> {
  if (!isPerpVaultEnabled() || !walletClient) return { success: false };
  if (feeETH === 0n) return { success: true };

  pendingSettlements.push({ type: "fee", amount: feeETH, timestamp: Date.now() });
  logger.debug("PerpVault", `Fee queued: ${feeETH} (queue: ${pendingSettlements.length})`);
  return { success: true }; // Queued successfully
}

// ============================================================
// Batch Settlement Execution
// ============================================================

/**
 * Execute all queued settlements sequentially.
 * Called every BATCH_INTERVAL_MS (30s).
 *
 * All TradingVault settlement calls are nonpayable (pure bookkeeping).
 * Engine wallet only needs gas — no ETH value transfers.
 * Priority: profit > loss > liquidation > fee
 */
export async function executeBatchSettlement(): Promise<void> {
  if (!isPerpVaultEnabled() || !walletClient || !publicClient || globalTxLock) return;
  if (pendingSettlements.length === 0) return;

  globalTxLock = true;
  try {
    const matcherAddress = walletClient.account?.address;
    if (!matcherAddress) { globalTxLock = false; return; }

    // Only need gas — check minimum balance for tx fees
    const walletBalance = await publicClient.getBalance({ address: matcherAddress });
    if (walletBalance < MIN_WALLET_BALANCE_WEI) {
      logger.warn("PerpVault", `Engine wallet gas LOW: ${Number(walletBalance) / 1e18} BNB. Queue: ${pendingSettlements.length} items.`);
      batchesSkippedLowBalance++;
      globalTxLock = false;
      return;
    }

    // Sort by priority: profit first, then loss, liquidation, fee
    const priorityOrder: Record<string, number> = { profit: 0, loss: 1, liquidation: 2, fee: 3 };
    const sorted = [...pendingSettlements].sort((a, b) => (priorityOrder[a.type] ?? 9) - (priorityOrder[b.type] ?? 9));

    const executed: number[] = [];
    let totalSettled = 0n;

    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];

      try {
        let txHash: string;

        if (item.type === "profit") {
          txHash = await walletClient.writeContract({
            address: perpVaultAddress!,
            abi: PERP_VAULT_ABI,
            functionName: "settleTraderProfit",
            args: [item.trader, item.amount],
          });
          totalSettled += item.amount;
          logger.info("PerpVault", `Profit settled: trader=${item.trader.slice(0, 10)} amount=${item.amount} tx=${txHash}`);
        } else if (item.type === "loss") {
          txHash = await walletClient.writeContract({
            address: perpVaultAddress!,
            abi: PERP_VAULT_ABI,
            functionName: "settleTraderLoss",
            args: [item.amount],
            value: item.amount,
          });
          totalSettled += item.amount;
        } else if (item.type === "liquidation") {
          txHash = await walletClient.writeContract({
            address: perpVaultAddress!,
            abi: PERP_VAULT_ABI,
            functionName: "settleLiquidation",
            args: [item.collateralETH, item.liquidatorReward, item.liquidator],
            value: item.collateralETH,
          });
          totalSettled += item.collateralETH;
        } else {
          // fee
          txHash = await walletClient.writeContract({
            address: perpVaultAddress!,
            abi: PERP_VAULT_ABI,
            functionName: "collectFee",
            args: [item.amount],
            value: item.amount,
          });
          feesCollectedCount++;
          totalSettled += item.amount;
        }

        executed.push(pendingSettlements.indexOf(item));
        settlementsExecuted++;

        logger.debug("PerpVault", `Batch ${item.type}: settled, tx=${txHash}`);
      } catch (error: any) {
        settlementsFailed++;
        const msg = error?.shortMessage || error?.message || String(error);
        logger.error("PerpVault", `Batch ${item.type} failed: ${msg.slice(0, 100)}`);
        // Remove failed item from queue anyway (don't retry forever)
        executed.push(pendingSettlements.indexOf(item));
      }
    }

    // Remove executed items from queue (reverse order to preserve indices)
    const executedIndices = new Set(executed.filter(idx => idx >= 0));
    for (let i = pendingSettlements.length - 1; i >= 0; i--) {
      if (executedIndices.has(i)) {
        pendingSettlements.splice(i, 1);
      }
    }

    batchesExecuted++;
    if (totalSettled > 0n) {
      cachedPoolStats = null; // Invalidate cache
      logger.info("PerpVault", `Batch settlement: ${executed.length} items, ${totalSettled} wei total. Queue remaining: ${pendingSettlements.length}`);
    }
  } catch (error: any) {
    const msg = error?.shortMessage || error?.message || String(error);
    logger.error("PerpVault", `Batch settlement error: ${msg.slice(0, 150)}`);
  } finally {
    globalTxLock = false;
  }
}

/**
 * Update net pending PnL on PerpVault for accurate pool valuation.
 * Called periodically (every 30s) with aggregate unrealized PnL.
 */
export async function updatePendingPnL(netPnL: bigint): Promise<void> {
  if (!isPerpVaultEnabled() || !walletClient) return;

  try {
    await walletClient.writeContract({
      address: perpVaultAddress!,
      abi: [
        {
          name: "updatePendingPnL",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [{ name: "_netPnL", type: "int256" }],
          outputs: [],
        },
      ] as const,
      functionName: "updatePendingPnL",
      args: [netPnL],
    });
    logger.debug("PerpVault", `PendingPnL updated: ${netPnL}`);
  } catch (error: any) {
    const msg = error?.shortMessage || error?.message || String(error);
    logger.error("PerpVault", `updatePendingPnL failed: ${msg.slice(0, 100)}`);
  }
}

/**
 * Start the batch settlement loop.
 * Called during server initialization.
 */
export function startBatchSettlement(): void {
  if (batchSettlementIntervalId) return;
  if (!isPerpVaultEnabled()) {
    logger.info("PerpVault", "Batch settlement NOT started (PerpVault not enabled)");
    return;
  }

  batchSettlementIntervalId = setInterval(async () => {
    try {
      // Refresh pool stats cache so getPerpVaultMetrics().poolValue stays current
      // (used by hasInsuranceFundCoverage in server.ts for liquidation decisions)
      await getPoolStats();
      await executeBatchSettlement();
    } catch (e) {
      // Defensive catch — executeBatchSettlement has its own error handling
    }
  }, BATCH_INTERVAL_MS);

  logger.info("PerpVault", `Batch settlement started (interval: ${BATCH_INTERVAL_MS}ms)`);
}

/**
 * Stop the batch settlement loop.
 */
export function stopBatchSettlement(): void {
  if (batchSettlementIntervalId) {
    clearInterval(batchSettlementIntervalId);
    batchSettlementIntervalId = null;
    logger.info("PerpVault", "Batch settlement stopped");
  }
}

/**
 * Get pending settlement queue info (for health endpoint)
 */
export function getPendingSettlementInfo(): {
  queueLength: number;
  totalPendingETH: bigint;
  oldestTimestamp: number | null;
} {
  let total = 0n;
  for (const item of pendingSettlements) {
    total += item.type === "liquidation" ? item.collateralETH : item.amount;
  }
  return {
    queueLength: pendingSettlements.length,
    totalPendingETH: total,
    oldestTimestamp: pendingSettlements.length > 0 ? pendingSettlements[0].timestamp : null,
  };
}

// ============================================================
// Metrics
// ============================================================

/**
 * Get module metrics
 */
export function getPerpVaultMetrics(): {
  initialized: boolean;
  enabled: boolean;
  address: string | null;
  poolValue: string;
  settlementsExecuted: number;
  settlementsFailed: number;
  oiUpdatesExecuted: number;
  oiUpdatesFailed: number;
  feesCollectedCount: number;
  batchesExecuted: number;
  batchesSkippedLowBalance: number;
  pendingQueueLength: number;
  pendingQueueETH: string;
} {
  const pending = getPendingSettlementInfo();
  // Circuit breaker summary
  const breakerSummary: Record<string, string> = {};
  for (const [token, state] of circuitBreakers) {
    if (state.status === "OPEN") {
      breakerSummary[token.slice(0, 10)] = `OPEN since ${new Date(state.trippedAt).toISOString()} (${state.reason.slice(0, 60)})`;
    }
  }

  return {
    initialized,
    enabled: isPerpVaultEnabled(),
    address: perpVaultAddress,
    poolValue: cachedPoolStats?.poolValue?.toString() ?? "0",
    settlementsExecuted,
    settlementsFailed,
    oiUpdatesExecuted,
    oiUpdatesFailed,
    feesCollectedCount,
    batchesExecuted,
    batchesSkippedLowBalance,
    pendingQueueLength: pending.queueLength,
    pendingQueueETH: pending.totalPendingETH.toString(),
    engineTotalOI: getEngineTotalOI().toString(),
    cachedMaxOI: cachedMaxOI.toString(),
    circuitBreakers: breakerSummary,
  };
}

// ============================================================
// Export
// ============================================================

export default {
  initPerpVault,
  isPerpVaultEnabled,
  getPoolValue,
  getSharePrice,
  getPoolStats,
  getTokenOI,
  canIncreaseOI,
  canOpenPosition,
  isCircuitBreakerOpen,
  getCircuitBreakerStatus,
  getEngineOI,
  getEngineTotalOI,
  getLPInfo,
  settleTraderPnL,
  settleLiquidation,
  increaseOI,
  decreaseOI,
  collectTradingFee,
  updatePendingPnL,
  executeBatchSettlement,
  startBatchSettlement,
  stopBatchSettlement,
  getPendingSettlementInfo,
  getPerpVaultMetrics,
  updateGraduatedTokens,
};
