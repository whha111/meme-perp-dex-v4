/**
 * PerpVault 模块 — GMX-style LP Pool 交互
 *
 * 功能:
 * 1. 查询链上 PerpVault 池子状态 (poolValue, sharePrice, OI)
 * 2. 在开/平仓时执行链上 OI 更新
 * 3. 在平仓/清算时执行链上结算 (settleTraderProfit/Loss, settleLiquidation)
 * 4. 收取交易手续费 (collectFee)
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
// PerpVault ABI (minimal — only what we need)
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
    name: "getWithdrawalInfo",
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
// Batch Settlement Queue (for payable calls)
// ============================================================

/**
 * Payable PerpVault calls (settleTraderLoss, settleLiquidation, collectFee)
 * require msg.value = ETH amount. The engine wallet may not have enough ETH
 * to execute these immediately. Queue them and batch-execute periodically.
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
// ============================================================
let globalTxLock = false;

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
  if (pendingOIDelta.size === 0) return;

  globalTxLock = true;
  // Snapshot and clear the queue
  const snapshot = new Map(pendingOIDelta);
  pendingOIDelta.clear();

  let successCount = 0;
  let failCount = 0;

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
    // AUDIT-FIX ME-C03: 使用正确的锁变量 globalTxLock (isFlushingOI 未定义)
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
      logger.info("PerpVault", `OI ${isIncrease ? "increased" : "decreased"} (batch): token=${token.slice(0, 10)} ${isLong ? "LONG" : "SHORT"} ${isIncrease ? "+" : "-"}${absDelta} tx=${txHash}`);
    } catch (error: any) {
      oiUpdatesFailed++;
      failCount++;
      const errorMsg = error?.shortMessage || error?.message || String(error);
      logger.error("PerpVault", `OI batch ${isIncrease ? "increase" : "decrease"} FAILED: ${errorMsg.slice(0, 200)} | token=${token.slice(0, 10)} delta=${delta}`);
      // Re-queue the failed delta
      const existing = pendingOIDelta.get(key) || 0n;
      pendingOIDelta.set(key, existing + delta);
      // Break on first failure — subsequent nonces would be invalid
      // Re-queue remaining items
      let foundFailed = false;
      for (const [remainKey, remainDelta] of snapshot.entries()) {
        if (remainKey === key) { foundFailed = true; continue; }
        if (!foundFailed) continue; // skip already-processed items
        if (remainDelta === 0n) continue;
        const existingRemain = pendingOIDelta.get(remainKey) || 0n;
        pendingOIDelta.set(remainKey, existingRemain + remainDelta);
      }
      break;
    }
  }

  if (successCount > 0 || failCount > 0) {
    logger.info("PerpVault", `OI batch flush: ${successCount} ok, ${failCount} failed, ${pendingOIDelta.size} re-queued`);
  }
  globalTxLock = false;
}

export function startOIFlush(): void {
  if (oiFlushIntervalId) return;
  oiFlushIntervalId = setInterval(flushOIQueue, OI_FLUSH_INTERVAL_MS);
  logger.info("PerpVault", `OI batch flush started (interval: ${OI_FLUSH_INTERVAL_MS}ms)`);
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

  logger.info("PerpVault", `Module initialized, PerpVault: ${perpVaultAddress}`);
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
 * Get pool value (ETH balance of PerpVault contract)
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
 * Check if a new position would exceed OI limits
 */
export async function canIncreaseOI(
  token: Address,
  isLong: boolean,
  sizeETH: bigint
): Promise<boolean> {
  if (!isPerpVaultEnabled()) return true; // No PerpVault → no OI limit

  try {
    const [totalOI, maxOI] = await Promise.all([
      publicClient.readContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: "getTotalOI",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: perpVaultAddress!,
        abi: PERP_VAULT_ABI,
        functionName: "getMaxOI",
      }) as Promise<bigint>,
    ]);

    if (maxOI === 0n) return true; // Empty pool
    return totalOI + sizeETH <= maxOI;
  } catch (error) {
    logger.error("PerpVault", "Failed to check OI limits:", error);
    return true; // Allow on error
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
        functionName: "getWithdrawalInfo",
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
 * - Profit: executed immediately (nonpayable — PerpVault sends ETH from pool)
 * - Loss: queued for batch execution (payable — requires engine wallet ETH)
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
    // P3-P4: Queue profit settlement (was fire-and-forget with no retry)
    // Profit: pool pays trader — nonpayable, but still queue for retry + nonce safety
    pendingSettlements.push({ type: "profit", trader, amount, timestamp: Date.now() });
    logger.debug("PerpVault", `Profit queued: trader=${trader.slice(0, 10)} amount=${amount} (queue size: ${pendingSettlements.length})`);
    return { success: true }; // Queued successfully
  } else {
    // Loss: payable — queue for batch execution
    pendingSettlements.push({ type: "loss", amount, timestamp: Date.now() });
    logger.debug("PerpVault", `Loss queued: amount=${amount} (queue size: ${pendingSettlements.length})`);
    return { success: true }; // Queued successfully
  }
}

/**
 * Settle liquidation — collateral goes to pool, reward to liquidator
 * Queued for batch execution (payable — requires engine wallet ETH)
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
 */
export async function increaseOI(
  token: Address,
  isLong: boolean,
  sizeETH: bigint
): Promise<{ success: boolean }> {
  if (!isPerpVaultEnabled() || !walletClient) return { success: false };
  if (sizeETH === 0n) return { success: true };

  queueOIDelta(token, isLong, sizeETH);
  logger.debug("PerpVault", `OI increase queued: token=${token.slice(0, 10)} ${isLong ? "LONG" : "SHORT"} +${sizeETH} (queue: ${pendingOIDelta.size})`);
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
  if (!isPerpVaultEnabled() || !walletClient) return { success: false };
  if (sizeETH === 0n) return { success: true };

  queueOIDelta(token, isLong, -sizeETH);
  logger.debug("PerpVault", `OI decrease queued: token=${token.slice(0, 10)} ${isLong ? "LONG" : "SHORT"} -${sizeETH} (queue: ${pendingOIDelta.size})`);
  return { success: true };
}

/**
 * Collect trading fee — ETH goes into pool, increasing share price
 * Queued for batch execution (payable — requires engine wallet ETH)
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
 * Execute all queued payable settlements in priority order.
 * Called every BATCH_INTERVAL_MS (30s).
 *
 * Priority: loss > liquidation > fee
 * If engine wallet balance is insufficient, execute what we can.
 */
export async function executeBatchSettlement(): Promise<void> {
  if (!isPerpVaultEnabled() || !walletClient || !publicClient || globalTxLock) return;
  if (pendingSettlements.length === 0) return;

  globalTxLock = true;
  try {
    // Check engine wallet ETH balance
    const matcherAddress = walletClient.account?.address;
    if (!matcherAddress) { globalTxLock = false; return; }

    const walletBalance = await publicClient.getBalance({ address: matcherAddress });

    if (walletBalance < MIN_WALLET_BALANCE_WEI) {
      logger.warn("PerpVault", `⚠️ Engine wallet balance LOW: ${walletBalance} wei (${Number(walletBalance) / 1e18} ETH). Settlement queue has ${pendingSettlements.length} items.`);
      batchesSkippedLowBalance++;
      globalTxLock = false;
      return;
    }

    // Sort by priority: profit first (nonpayable), loss, liquidation, fee
    const priorityOrder: Record<string, number> = { profit: 0, loss: 1, liquidation: 2, fee: 3 };
    const sorted = [...pendingSettlements].sort((a, b) => (priorityOrder[a.type] ?? 9) - (priorityOrder[b.type] ?? 9));

    let remainingBalance = walletBalance - MIN_WALLET_BALANCE_WEI; // Reserve 0.05 ETH for gas
    const executed: number[] = [];
    let totalSettled = 0n;

    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      // Profit is nonpayable (PerpVault sends from pool), doesn't consume engine wallet
      const requiredETH = item.type === "profit" ? 0n : item.type === "liquidation" ? item.collateralETH : item.amount;

      if (requiredETH > remainingBalance) {
        logger.debug("PerpVault", `Batch: skipping ${item.type} (need ${requiredETH}, have ${remainingBalance})`);
        continue; // Skip items we can't afford, try smaller ones
      }

      try {
        let txHash: string;

        if (item.type === "profit") {
          // P3-P4: Profit settlement — nonpayable, PerpVault sends from pool
          txHash = await walletClient.writeContract({
            address: perpVaultAddress!,
            abi: PERP_VAULT_ABI,
            functionName: "settleTraderProfit",
            args: [item.trader, item.amount],
          });
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

        remainingBalance -= requiredETH;
        executed.push(pendingSettlements.indexOf(item));
        settlementsExecuted++;

        logger.debug("PerpVault", `Batch ${item.type}: ${requiredETH} wei settled, tx=${txHash}`);
      } catch (error: any) {
        settlementsFailed++;
        const msg = error?.shortMessage || error?.message || String(error);
        logger.error("PerpVault", `Batch ${item.type} failed: ${msg.slice(0, 100)}`);
        // Remove failed item from queue anyway (don't retry forever)
        executed.push(pendingSettlements.indexOf(item));
      }
    }

    // Remove executed items (in reverse order to preserve indices)
    for (const idx of executed.sort((a, b) => b - a)) {
      if (idx >= 0) pendingSettlements.splice(idx, 1);
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
};
