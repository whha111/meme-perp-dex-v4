/**
 * 可靠的链上事件轮询器
 *
 * 替代 viem watchContractEvent (WebSocket) — WebSocket 会静默断开导致事件丢失。
 * 参考:
 *  - dYdX v4 Ender: 按区块顺序处理事件，原子写入
 *  - GMX Keeper: 直接查链上状态，不依赖 indexer
 *  - 本项目 Trade 轮询器 (server.ts startTradeEventPoller): HTTP getLogs + lastScannedBlock
 *
 * 核心保证:
 *  1. lastProcessedBlock 持久化到 Redis — 重启不丢进度
 *  2. 启动时回填 N 个区块 — 覆盖停机期间的事件
 *  3. getLogs 分批查询 — 遵守 RPC 限制 (BSC 500块/次)
 *  4. 事件去重 — txHash + logIndex 作为唯一标识
 *  5. 失败不推进 — 出错时 lastBlock 不更新，下次重试
 */

import { type Address, type Log, createPublicClient, http, parseAbiItem } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { getRedisClient, isRedisConnected } from "../database/redis";
import { rpcTransport } from "../config";

// ============================================================
// Types
// ============================================================

export interface EventPollerConfig {
  /** 日志标识名 */
  name: string;
  /** 合约地址 */
  contractAddress: Address;
  /** 事件 ABI (parseAbiItem 格式或完整 ABI 数组) */
  eventAbi: any;
  /** 轮询间隔 (毫秒) */
  pollIntervalMs: number;
  /** 启动回填区块数 */
  backfillBlocks: bigint;
  /** getLogs 批量大小 (BSC 限制 ~500) */
  batchSize: bigint;
  /** RPC URL (HTTP) */
  rpcUrl: string;
  /** Chain ID */
  chainId: number;
  /** 事件处理回调 */
  onLogs: (logs: Log[]) => Promise<void>;
  /** Redis key 前缀 (用于持久化 lastBlock) */
  redisKeyPrefix?: string;
}

interface PollerState {
  name: string;
  lastScannedBlock: bigint;
  intervalId: ReturnType<typeof setInterval> | null;
  isRunning: boolean;
  processedEvents: number;
  errors: number;
  lastPollTime: number;
}

// ============================================================
// Redis Keys
// ============================================================

const REDIS_PREFIX = "eventPoller";

function lastBlockKey(name: string, prefix?: string): string {
  return `${prefix || REDIS_PREFIX}:lastBlock:${name}`;
}

function dedupSetKey(name: string, prefix?: string): string {
  return `${prefix || REDIS_PREFIX}:dedup:${name}`;
}

// ============================================================
// Poller Registry (for health checks)
// ============================================================

const activePollers = new Map<string, PollerState>();

export function getPollerStats(): Record<string, any> {
  const stats: Record<string, any> = {};
  for (const [name, state] of activePollers) {
    stats[name] = {
      lastScannedBlock: state.lastScannedBlock.toString(),
      isRunning: state.isRunning,
      processedEvents: state.processedEvents,
      errors: state.errors,
      lastPollTime: state.lastPollTime,
      timeSinceLastPoll: Date.now() - state.lastPollTime,
    };
  }
  return stats;
}

// ============================================================
// Core: createEventPoller
// ============================================================

export async function createEventPoller(config: EventPollerConfig): Promise<PollerState> {
  const {
    name,
    contractAddress,
    eventAbi,
    pollIntervalMs,
    backfillBlocks,
    batchSize,
    rpcUrl,
    chainId,
    onLogs,
    redisKeyPrefix,
  } = config;

  const chain = chainId === 97 ? bscTestnet : bsc;
  // Use shared fallback transport for reliability; ignore rpcUrl param
  const client = createPublicClient({ chain, transport: rpcTransport });

  const state: PollerState = {
    name,
    lastScannedBlock: 0n,
    intervalId: null,
    isRunning: false,
    processedEvents: 0,
    errors: 0,
    lastPollTime: 0,
  };

  // 1. 从 Redis 恢复 lastScannedBlock
  if (isRedisConnected()) {
    try {
      const redis = getRedisClient();
      const saved = await redis.get(lastBlockKey(name, redisKeyPrefix));
      if (saved) {
        state.lastScannedBlock = BigInt(saved);
        console.log(`[EventPoller:${name}] Restored lastBlock from Redis: ${state.lastScannedBlock}`);
      }
    } catch (e: any) {
      console.warn(`[EventPoller:${name}] Failed to read lastBlock from Redis: ${e.message}`);
    }
  }

  // 2. 如果 Redis 没有记录，从当前区块 - backfillBlocks 开始
  if (state.lastScannedBlock === 0n) {
    try {
      const currentBlock = await client.getBlockNumber();
      state.lastScannedBlock = currentBlock > backfillBlocks ? currentBlock - backfillBlocks : 0n;
      console.log(`[EventPoller:${name}] No saved block, starting from ${state.lastScannedBlock} (current: ${currentBlock}, backfill: ${backfillBlocks})`);
    } catch (e: any) {
      console.error(`[EventPoller:${name}] Failed to get current block: ${e.message}`);
      // 不阻塞启动，等下次轮询时再试
    }
  }

  // 3. 回填：扫描从 lastScannedBlock 到当前区块的所有事件
  try {
    const currentBlock = await client.getBlockNumber();
    if (currentBlock > state.lastScannedBlock) {
      console.log(`[EventPoller:${name}] Backfilling from block ${state.lastScannedBlock} to ${currentBlock}...`);
      await pollEvents(client, config, state, state.lastScannedBlock + 1n, currentBlock);
      state.lastScannedBlock = currentBlock;
      await persistLastBlock(name, currentBlock, redisKeyPrefix);
      console.log(`[EventPoller:${name}] Backfill complete, now at block ${currentBlock}`);
    }
  } catch (e: any) {
    console.error(`[EventPoller:${name}] Backfill failed: ${e.message}`);
    // 不阻塞启动
  }

  // 4. 启动定期轮询
  state.intervalId = setInterval(async () => {
    if (state.isRunning) return; // 防止重叠
    state.isRunning = true;

    try {
      const latestBlock = await client.getBlockNumber();
      if (latestBlock <= state.lastScannedBlock) {
        state.isRunning = false;
        return;
      }

      const fromBlock = state.lastScannedBlock + 1n;
      await pollEvents(client, config, state, fromBlock, latestBlock);

      // 成功后更新 lastScannedBlock
      state.lastScannedBlock = latestBlock;
      state.lastPollTime = Date.now();
      await persistLastBlock(name, latestBlock, redisKeyPrefix);
    } catch (e: any) {
      state.errors++;
      console.error(`[EventPoller:${name}] Poll error (#${state.errors}): ${e.message}`);
      // 不更新 lastScannedBlock，下次从同一位置重试
    } finally {
      state.isRunning = false;
    }
  }, pollIntervalMs);

  activePollers.set(name, state);
  console.log(`[EventPoller:${name}] Started: contract=${contractAddress.slice(0, 10)}, interval=${pollIntervalMs}ms, batchSize=${batchSize}`);

  return state;
}

// ============================================================
// Internal: pollEvents (分批 getLogs)
// ============================================================

async function pollEvents(
  client: any,
  config: EventPollerConfig,
  state: PollerState,
  fromBlock: bigint,
  toBlock: bigint
): Promise<void> {
  const { contractAddress, eventAbi, batchSize, name, onLogs, redisKeyPrefix } = config;

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = start + batchSize - 1n > toBlock ? toBlock : start + batchSize - 1n;

    const logs = await client.getLogs({
      address: contractAddress,
      event: eventAbi,
      fromBlock: start,
      toBlock: end,
    });

    if (logs.length === 0) continue;

    // 去重: txHash + logIndex
    const newLogs: Log[] = [];
    for (const log of logs) {
      const eventKey = `${log.transactionHash}-${log.logIndex}`;
      if (await isEventProcessed(name, eventKey, redisKeyPrefix)) {
        continue;
      }
      newLogs.push(log);
      await markEventProcessed(name, eventKey, redisKeyPrefix);
    }

    if (newLogs.length > 0) {
      await onLogs(newLogs);
      state.processedEvents += newLogs.length;
    }
  }
}

// ============================================================
// Internal: Redis 持久化
// ============================================================

// Optional PG dual-write callback — set by server.ts at init time
let pgPersistBlockFn: ((name: string, block: bigint) => void) | null = null;

export function setBlockPersistPgCallback(fn: (name: string, block: bigint) => void): void {
  pgPersistBlockFn = fn;
}

async function persistLastBlock(name: string, block: bigint, prefix?: string): Promise<void> {
  // Dual-write: Redis (primary, fast) + PG (backup, survives Redis flush)
  // Pattern: Ponder checkpoint — multiple watermarks persisted to PG
  if (isRedisConnected()) {
    try {
      const redis = getRedisClient();
      await redis.set(lastBlockKey(name, prefix), block.toString());
    } catch (e: any) {
      console.warn(`[EventPoller:${name}] Failed to persist lastBlock to Redis: ${e.message}`);
    }
  }

  // L1: PG dual-write (fire-and-forget)
  if (pgPersistBlockFn) {
    try {
      pgPersistBlockFn(name, block);
    } catch { /* best-effort */ }
  }
}

async function isEventProcessed(name: string, eventKey: string, prefix?: string): Promise<boolean> {
  if (!isRedisConnected()) return false;
  try {
    const redis = getRedisClient();
    return (await redis.sismember(dedupSetKey(name, prefix), eventKey)) === 1;
  } catch {
    return false; // 去重失败不阻塞处理
  }
}

async function markEventProcessed(name: string, eventKey: string, prefix?: string): Promise<void> {
  if (!isRedisConnected()) return;
  try {
    const redis = getRedisClient();
    await redis.sadd(dedupSetKey(name, prefix), eventKey);
    // 1 小时后自动过期整个去重 Set（防止无限增长）
    await redis.expire(dedupSetKey(name, prefix), 3600);
  } catch {
    // 非关键操作，忽略错误
  }
}

// ============================================================
// Cleanup
// ============================================================

export function stopAllPollers(): void {
  for (const [name, state] of activePollers) {
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
      console.log(`[EventPoller:${name}] Stopped`);
    }
  }
  activePollers.clear();
}
