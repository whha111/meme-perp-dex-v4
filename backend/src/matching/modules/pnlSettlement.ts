/**
 * PnL Settlement Module — 链下→链上余额同步
 *
 * Purpose:
 * - 将 mode2PnLAdjustments 中累积的盈亏同步到链上 Settlement 合约
 * - 确保盈利用户可以从链上提取利润（而非被链上余额限制）
 *
 * Architecture:
 * 1. collectSettlementItems(): 读取所有非零 mode2Adj，区分 losers/winners
 * 2. validateOnChainBalances(): 验证亏损方链上余额足够扣减
 * 3. buildBatchCalldata(): 构建 batchSettlePnL 调用参数
 * 4. executeOnChain(): 调用 Settlement.batchSettlePnL()
 * 5. reduceAdjustments(): 成功后扣减 mode2Adj
 *
 * Scheduled: 每小时执行一次（在 Merkle snapshot 之前），确保链上状态先同步
 */

import { type Address, type Hex, type PublicClient, type WalletClient, parseEther } from "viem";

// ============================================================
// Types
// ============================================================

export interface PnLSettlementConfig {
  intervalMs: number;         // 结算间隔（默认 1 小时）
  minSettleAmount: bigint;    // 最小结算金额（过滤粉尘）
  maxBatchSize: number;       // 每批最大对数（200）
  dryRun: boolean;            // 试运行模式（只打印，不发 tx）
}

export interface SettlementResult {
  success: boolean;
  txHash?: string;
  losersSettled: number;
  winnersSettled: number;
  totalTransferred: bigint;
  errors: string[];
  timestamp: number;
}

interface SettlementDeps {
  getAdjustments: () => Map<Address, bigint>;
  reduceAdjustment: (trader: Address, amount: bigint) => void;
  settlementAddress: Address;
  settlementAbi: readonly any[];
  matcherWalletClient: WalletClient;
  publicClient: PublicClient;
  insuranceFundAddress?: Address;
}

const DEFAULT_CONFIG: PnLSettlementConfig = {
  intervalMs: 60 * 60 * 1000,  // 1 hour
  minSettleAmount: parseEther("0.0001"),  // 0.0001 ETH minimum
  maxBatchSize: 200,
  dryRun: false,
};

// ============================================================
// State
// ============================================================

let deps: SettlementDeps | null = null;
let config: PnLSettlementConfig = { ...DEFAULT_CONFIG };
let settlementTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let lastSettlementTime = 0;
let lastResult: SettlementResult | null = null;

// ============================================================
// Initialization
// ============================================================

export function initializePnLSettlement(initDeps: SettlementDeps): void {
  deps = initDeps;
  console.log(`[PnLSettlement] Module initialized (Settlement: ${initDeps.settlementAddress})`);
}

export function startPnLSettlementJob(userConfig?: Partial<PnLSettlementConfig>): void {
  if (!deps) {
    console.warn("[PnLSettlement] Cannot start: module not initialized");
    return;
  }

  config = { ...DEFAULT_CONFIG, ...userConfig };

  if (settlementTimer) {
    clearInterval(settlementTimer);
  }

  // 首次延迟 5 分钟执行（等系统稳定）
  setTimeout(async () => {
    await executePnLSettlement();
  }, 5 * 60 * 1000);

  // 之后按配置间隔定期执行
  settlementTimer = setInterval(async () => {
    await executePnLSettlement();
  }, config.intervalMs);

  console.log(`[PnLSettlement] Job started (interval: ${config.intervalMs / 60000}min, minAmount: ${Number(config.minSettleAmount) / 1e18} ETH, dryRun: ${config.dryRun})`);
}

export function stopPnLSettlementJob(): void {
  if (settlementTimer) {
    clearInterval(settlementTimer);
    settlementTimer = null;
    console.log("[PnLSettlement] Job stopped");
  }
}

// ============================================================
// Core Settlement Logic
// ============================================================

export async function executePnLSettlement(): Promise<SettlementResult> {
  if (!deps) {
    return { success: false, losersSettled: 0, winnersSettled: 0, totalTransferred: 0n, errors: ["Module not initialized"], timestamp: Date.now() };
  }

  if (isRunning) {
    console.log("[PnLSettlement] Already running, skipping");
    return { success: false, losersSettled: 0, winnersSettled: 0, totalTransferred: 0n, errors: ["Already running"], timestamp: Date.now() };
  }

  isRunning = true;
  const startTime = Date.now();
  const errors: string[] = [];

  try {
    // 1. Collect all non-zero adjustments
    const adjustments = deps.getAdjustments();
    const losers: { address: Address; amount: bigint }[] = [];
    const winners: { address: Address; amount: bigint }[] = [];

    for (const [addr, adj] of adjustments) {
      if (adj < -config.minSettleAmount) {
        losers.push({ address: addr, amount: -adj }); // Convert negative to positive for transfer
      } else if (adj > config.minSettleAmount) {
        winners.push({ address: addr, amount: adj });
      }
    }

    if (losers.length === 0 && winners.length === 0) {
      console.log("[PnLSettlement] No significant adjustments to settle");
      lastResult = { success: true, losersSettled: 0, winnersSettled: 0, totalTransferred: 0n, errors: [], timestamp: Date.now() };
      return lastResult;
    }

    console.log(`[PnLSettlement] Found ${losers.length} losers, ${winners.length} winners`);

    // 2. Validate on-chain balances for losers
    const validatedLosers: { address: Address; amount: bigint }[] = [];
    let totalLossAvailable = 0n;

    for (const loser of losers) {
      try {
        const [available] = await deps.publicClient.readContract({
          address: deps.settlementAddress,
          abi: deps.settlementAbi,
          functionName: "getUserBalance",
          args: [loser.address],
        }) as [bigint, bigint];

        // Only settle up to the available balance
        const settleAmount = loser.amount > available ? available : loser.amount;
        if (settleAmount > config.minSettleAmount) {
          validatedLosers.push({ address: loser.address, amount: settleAmount });
          totalLossAvailable += settleAmount;
        } else if (available < config.minSettleAmount) {
          console.log(`[PnLSettlement] Loser ${loser.address.slice(0, 10)} has insufficient chain balance ($${Number(available) / 1e18}), skipping`);
        }
      } catch (e: any) {
        errors.push(`Failed to read balance for ${loser.address.slice(0, 10)}: ${e.message}`);
      }
    }

    if (validatedLosers.length === 0) {
      console.log("[PnLSettlement] No losers with sufficient on-chain balance");
      lastResult = { success: true, losersSettled: 0, winnersSettled: 0, totalTransferred: 0n, errors, timestamp: Date.now() };
      return lastResult;
    }

    // 3. Calculate total winnings to distribute (capped by available losses)
    let totalWinnings = winners.reduce((sum, w) => sum + w.amount, 0n);
    const distributableAmount = totalLossAvailable < totalWinnings ? totalLossAvailable : totalWinnings;

    console.log(`[PnLSettlement] Loss available: $${Number(totalLossAvailable) / 1e18}, Winnings claimed: $${Number(totalWinnings) / 1e18}, Distributable: $${Number(distributableAmount) / 1e18}`);

    // 4. Build batch calldata — direct transfers (losers → winners)
    // Pair losers with winners directly
    const fromAddrs: Address[] = [];
    const toAddrs: Address[] = [];
    const amounts: bigint[] = [];

    let remainingDistributable = distributableAmount;
    let loserIdx = 0;
    let loserRemaining = validatedLosers.length > 0 ? validatedLosers[0].amount : 0n;

    for (const winner of winners) {
      if (remainingDistributable <= 0n) break;

      let winnerRemaining = winner.amount > remainingDistributable ? remainingDistributable : winner.amount;

      while (winnerRemaining > 0n && loserIdx < validatedLosers.length) {
        const transferAmount = winnerRemaining > loserRemaining ? loserRemaining : winnerRemaining;

        if (transferAmount > 0n) {
          fromAddrs.push(validatedLosers[loserIdx].address);
          toAddrs.push(winner.address);
          amounts.push(transferAmount);

          winnerRemaining -= transferAmount;
          loserRemaining -= transferAmount;
          remainingDistributable -= transferAmount;
        }

        if (loserRemaining <= 0n) {
          loserIdx++;
          if (loserIdx < validatedLosers.length) {
            loserRemaining = validatedLosers[loserIdx].amount;
          }
        }
      }
    }

    if (fromAddrs.length === 0) {
      console.log("[PnLSettlement] No transfers to execute after pairing");
      lastResult = { success: true, losersSettled: 0, winnersSettled: 0, totalTransferred: 0n, errors, timestamp: Date.now() };
      return lastResult;
    }

    // Cap at maxBatchSize
    const batchCount = Math.min(fromAddrs.length, config.maxBatchSize);
    const batchFrom = fromAddrs.slice(0, batchCount);
    const batchTo = toAddrs.slice(0, batchCount);
    const batchAmounts = amounts.slice(0, batchCount);

    const totalBatchAmount = batchAmounts.reduce((sum, a) => sum + a, 0n);
    console.log(`[PnLSettlement] Executing batch: ${batchCount} transfers, total $${Number(totalBatchAmount) / 1e18}`);

    // 5. Execute on-chain (or dry run)
    if (config.dryRun) {
      console.log("[PnLSettlement] DRY RUN — would execute:");
      for (let i = 0; i < batchCount; i++) {
        console.log(`  ${batchFrom[i].slice(0, 10)} → ${batchTo[i].slice(0, 10)}: $${Number(batchAmounts[i]) / 1e18}`);
      }
      lastResult = { success: true, losersSettled: 0, winnersSettled: 0, totalTransferred: 0n, errors: ["DRY_RUN"], timestamp: Date.now() };
      return lastResult;
    }

    try {
      const txHash = await deps.matcherWalletClient.writeContract({
        address: deps.settlementAddress,
        abi: deps.settlementAbi,
        functionName: "batchSettlePnL",
        args: [batchFrom, batchTo, batchAmounts],
      });

      console.log(`[PnLSettlement] TX submitted: ${txHash}`);

      // Wait for confirmation
      const receipt = await deps.publicClient.waitForTransactionReceipt({ hash: txHash });

      if (receipt.status === "success") {
        console.log(`[PnLSettlement] TX confirmed in block ${receipt.blockNumber}`);

        // 6. Reduce mode2Adj for settled amounts
        // Track per-address settled amounts
        const settledPerAddress = new Map<Address, bigint>();

        for (let i = 0; i < batchCount; i++) {
          const fromAddr = batchFrom[i];
          const toAddr = batchTo[i];
          const amt = batchAmounts[i];

          // Losers: their negative adj should increase (become less negative)
          const currentFromSettled = settledPerAddress.get(fromAddr) || 0n;
          settledPerAddress.set(fromAddr, currentFromSettled + amt);

          // Winners: their positive adj should decrease (become less positive)
          const currentToSettled = settledPerAddress.get(toAddr) || 0n;
          settledPerAddress.set(toAddr, currentToSettled - amt); // Negative because we're reducing positive adj
        }

        for (const [addr, settledDelta] of settledPerAddress) {
          if (settledDelta > 0n) {
            // This is a loser — their adj was negative, we settled some → make less negative
            deps.reduceAdjustment(addr, settledDelta);
          } else if (settledDelta < 0n) {
            // This is a winner — their adj was positive, we settled some → make less positive
            deps.reduceAdjustment(addr, settledDelta); // settledDelta is already negative
          }
        }

        const uniqueLosers = new Set(batchFrom).size;
        const uniqueWinners = new Set(batchTo).size;

        console.log(`[PnLSettlement] ✅ Settled: ${uniqueLosers} losers, ${uniqueWinners} winners, total $${Number(totalBatchAmount) / 1e18}`);

        lastResult = {
          success: true,
          txHash,
          losersSettled: uniqueLosers,
          winnersSettled: uniqueWinners,
          totalTransferred: totalBatchAmount,
          errors,
          timestamp: Date.now(),
        };
        lastSettlementTime = Date.now();
        return lastResult;
      } else {
        errors.push("Transaction reverted");
        console.error(`[PnLSettlement] ❌ TX reverted: ${txHash}`);
      }
    } catch (e: any) {
      errors.push(`TX failed: ${e.message}`);
      console.error(`[PnLSettlement] ❌ TX error: ${e.message}`);
    }

    lastResult = { success: false, losersSettled: 0, winnersSettled: 0, totalTransferred: 0n, errors, timestamp: Date.now() };
    return lastResult;
  } catch (e: any) {
    errors.push(`Unexpected error: ${e.message}`);
    console.error(`[PnLSettlement] ❌ Error: ${e.message}`);
    lastResult = { success: false, losersSettled: 0, winnersSettled: 0, totalTransferred: 0n, errors, timestamp: Date.now() };
    return lastResult;
  } finally {
    isRunning = false;
    console.log(`[PnLSettlement] Completed in ${Date.now() - startTime}ms`);
  }
}

// ============================================================
// Status & Admin
// ============================================================

export function getSettlementStatus() {
  return {
    initialized: !!deps,
    running: isRunning,
    lastSettlementTime,
    lastResult,
    config,
  };
}
