/**
 * Snapshot Module for Mode 2 (Off-chain Execution + On-chain Attestation)
 *
 * Purpose:
 * - Collect user equities from backend state
 * - Generate Merkle tree snapshots
 * - Submit state roots to chain periodically
 *
 * Architecture:
 * 1. collectUserEquities(): Read all user balances + positions → compute equity
 * 2. createSnapshot(): Build Merkle tree → store locally
 * 3. submitRootToChain(): Call SettlementV2.updateStateRoot(root, timestamp)
 * 4. Scheduled job runs every hour (configurable)
 */

import { type Address, type Hex } from "viem";
import { merkleTreeManager, type UserEquity, type SnapshotState, type MerkleProof } from "./merkle";
import { getPendingWithdrawalAmount } from "./withdraw";

// Import from server.ts (will be provided via injection)
type BalanceGetter = (trader: Address) => {
  totalBalance: bigint;
  availableBalance: bigint;
  usedMargin?: bigint;
  unrealizedPnL?: bigint;
  /** Settlement 合约可用余额 (链上原始值, 不含钱包余额) */
  settlementAvailable?: bigint;
  /** 钱包余额 (native + WETH, 用于排除非托管资金) */
  walletBalance?: bigint;
};

type PositionGetter = (trader: Address) => Array<{
  token: Address;
  size: string;
  unrealizedPnL: string;
  collateral: string;
}>;

type AllTradersGetter = () => Address[];

/**
 * Snapshot configuration
 */
export interface SnapshotConfig {
  intervalMs: number;       // Snapshot interval (default: 1 hour)
  minEquity: bigint;        // Minimum equity to include (filter dust accounts)
  submitToChain: boolean;   // Whether to submit root to chain
  pruneAfterHours: number;  // Prune snapshots older than this
}

const DEFAULT_CONFIG: SnapshotConfig = {
  intervalMs: 60 * 60 * 1000, // 1 hour
  minEquity: 100n,            // $0.0001 minimum (1e6 precision)
  submitToChain: true,
  pruneAfterHours: 24,
};

/**
 * Snapshot job state
 */
interface SnapshotJobState {
  isRunning: boolean;
  lastSnapshotTime: number;
  lastSnapshotId: number | null;
  lastRootSubmitted: Hex | null;
  totalSnapshots: number;
  intervalId: NodeJS.Timer | null;
}

const jobState: SnapshotJobState = {
  isRunning: false,
  lastSnapshotTime: 0,
  lastSnapshotId: null,
  lastRootSubmitted: null,
  totalSnapshots: 0,
  intervalId: null,
};

/**
 * Dependencies injected from server.ts
 */
let getBalanceFunc: BalanceGetter | null = null;
let getPositionsFunc: PositionGetter | null = null;
let getAllTradersFunc: AllTradersGetter | null = null;
let submitRootFunc: ((root: Hex, timestamp: number) => Promise<Hex | null>) | null = null;

/**
 * Initialize snapshot module with dependencies
 */
export function initializeSnapshotModule(deps: {
  getBalance: BalanceGetter;
  getPositions: PositionGetter;
  getAllTraders: AllTradersGetter;
  submitRoot?: (root: Hex, timestamp: number) => Promise<Hex | null>;
}): void {
  getBalanceFunc = deps.getBalance;
  getPositionsFunc = deps.getPositions;
  getAllTradersFunc = deps.getAllTraders;
  submitRootFunc = deps.submitRoot ?? null;
  console.log("[Snapshot] Module initialized");
}

/**
 * Calculate user equity from balance + positions
 * Equity = Total Balance + Unrealized PnL
 */
function calculateUserEquity(trader: Address): bigint {
  if (!getBalanceFunc || !getPositionsFunc) {
    throw new Error("Snapshot module not initialized");
  }

  const balance = getBalanceFunc(trader);
  const positions = getPositionsFunc(trader);

  // ★ Merkle equity = SETTLEMENT-ONLY balance (excluding wallet BNB/WBNB)
  // Using totalBalance - walletBalance gives us: settlementAvailable + mode2Adj + positionMargin
  // This prevents users from withdrawing non-deposited funds from SettlementV2 pool
  const walletBal = balance.walletBalance ?? 0n;
  let equity = balance.totalBalance - walletBal;

  // AUDIT-FIX ME-H07: Only include OPEN positions (size > 0)
  // Closed positions (size=0) may have stale unrealizedPnL that inflates equity
  for (const pos of positions) {
    if (BigInt(pos.size || "0") === 0n) continue;
    const upnl = BigInt(pos.unrealizedPnL || "0");
    equity += upnl;
  }

  // M-08 FIX: 扣减待处理提款金额 — 防止用户用已请求提款的金额再次提款
  // 如果用户已请求提款 X ETH，其 Merkle equity 应减去 X
  const pendingWithdrawal = getPendingWithdrawalAmount(trader);
  equity -= pendingWithdrawal;

  return equity;
}

/**
 * Collect all user equities
 */
export function collectUserEquities(minEquity: bigint = DEFAULT_CONFIG.minEquity): UserEquity[] {
  if (!getAllTradersFunc) {
    throw new Error("Snapshot module not initialized");
  }

  const traders = getAllTradersFunc();
  const equities: UserEquity[] = [];

  for (const trader of traders) {
    try {
      const equity = calculateUserEquity(trader);

      // Filter out dust accounts
      if (equity >= minEquity) {
        equities.push({
          user: trader,
          equity,
        });
      }
    } catch (e) {
      console.warn(`[Snapshot] Failed to calculate equity for ${trader.slice(0, 10)}:`, e);
    }
  }

  console.log(`[Snapshot] Collected ${equities.length} user equities (from ${traders.length} traders)`);
  return equities;
}

/**
 * Create a new snapshot
 */
export function createSnapshot(config: Partial<SnapshotConfig> = {}): SnapshotState {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const equities = collectUserEquities(mergedConfig.minEquity);

  const snapshot = merkleTreeManager.createSnapshot(equities);

  jobState.lastSnapshotTime = snapshot.timestamp;
  jobState.lastSnapshotId = snapshot.snapshotId;
  jobState.totalSnapshots++;

  return snapshot;
}

/**
 * Submit state root to chain
 */
export async function submitRootToChain(root: Hex, timestamp: number): Promise<Hex | null> {
  if (!submitRootFunc) {
    console.log("[Snapshot] Chain submission not configured, skipping");
    return null;
  }

  try {
    const txHash = await submitRootFunc(root, timestamp);
    if (txHash) {
      jobState.lastRootSubmitted = root;
      console.log(`[Snapshot] Root submitted to chain: ${txHash}`);
    }
    return txHash;
  } catch (e) {
    console.error("[Snapshot] Failed to submit root to chain:", e);
    return null;
  }
}

/**
 * Run a single snapshot cycle
 */
export async function runSnapshotCycle(config: Partial<SnapshotConfig> = {}): Promise<SnapshotState | null> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  if (jobState.isRunning) {
    console.warn("[Snapshot] Snapshot cycle already running, skipping");
    return null;
  }

  jobState.isRunning = true;

  try {
    // 1. Create snapshot
    const snapshot = createSnapshot(mergedConfig);

    // 2. Submit to chain if configured
    if (mergedConfig.submitToChain) {
      await submitRootToChain(snapshot.root, snapshot.timestamp);
    }

    // 3. Prune old snapshots
    const keepSnapshots = Math.ceil(mergedConfig.pruneAfterHours);
    merkleTreeManager.pruneSnapshots(keepSnapshots);

    return snapshot;
  } finally {
    jobState.isRunning = false;
  }
}

/**
 * Start the snapshot job
 */
export function startSnapshotJob(config: Partial<SnapshotConfig> = {}): void {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  if (jobState.intervalId) {
    console.warn("[Snapshot] Job already running");
    return;
  }

  // P0-2: Snapshot 失败需要重试 + 报警（用户依赖 Merkle proof 提款）
  const MAX_SNAPSHOT_RETRIES = 3;
  const runWithRetry = async (config: typeof mergedConfig) => {
    for (let attempt = 1; attempt <= MAX_SNAPSHOT_RETRIES; attempt++) {
      try {
        await runSnapshotCycle(config);
        return;
      } catch (e) {
        console.error(`[Snapshot] Attempt ${attempt}/${MAX_SNAPSHOT_RETRIES} failed:`, e);
        if (attempt < MAX_SNAPSHOT_RETRIES) {
          await new Promise(r => setTimeout(r, 5000 * attempt)); // 退避重试
        }
      }
    }
    console.error("[Snapshot] 🚨 ALL RETRIES EXHAUSTED — users may be unable to verify withdrawals!");
  };

  // Run immediately
  runWithRetry(mergedConfig);

  // Schedule periodic runs
  jobState.intervalId = setInterval(() => {
    runWithRetry(mergedConfig);
  }, mergedConfig.intervalMs);

  console.log(`[Snapshot] Job started with ${mergedConfig.intervalMs}ms interval`);
}

/**
 * Stop the snapshot job
 */
export function stopSnapshotJob(): void {
  if (jobState.intervalId) {
    clearInterval(jobState.intervalId);
    jobState.intervalId = null;
    console.log("[Snapshot] Job stopped");
  }
}

/**
 * Get job status
 */
export function getSnapshotJobStatus(): {
  isRunning: boolean;
  lastSnapshotTime: number;
  lastSnapshotId: number | null;
  lastRootSubmitted: Hex | null;
  totalSnapshots: number;
  currentRoot: Hex | null;
} {
  return {
    ...jobState,
    currentRoot: merkleTreeManager.getCurrentRoot(),
  };
}

/**
 * Get proof for a user
 */
export function getUserProof(user: Address): MerkleProof | null {
  return merkleTreeManager.getProof(user);
}

/**
 * Get proof from a specific snapshot
 */
export function getUserProofFromSnapshot(user: Address, snapshotId: number): MerkleProof | null {
  return merkleTreeManager.getProofFromSnapshot(user, snapshotId);
}

/**
 * Verify a proof
 */
export function verifyProof(proof: MerkleProof): boolean {
  return merkleTreeManager.verifyUserProof(proof);
}

/**
 * Manual trigger for testing
 */
export async function triggerSnapshot(): Promise<SnapshotState | null> {
  return runSnapshotCycle({ submitToChain: false });
}
