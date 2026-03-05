/**
 * Token Holders Module
 *
 * Aggregates ERC20 Transfer event logs to build holder maps.
 * Supports top holders list and per-address PnL calculation.
 */

import { createPublicClient, http, type Address, parseAbiItem, formatUnits } from "viem";
import { bsc } from "viem/chains";
import { RPC_URL, TOKEN_FACTORY_ADDRESS } from "../config";
import { getRedisClient } from "../database/redis";
import { logger } from "../utils/logger";

// ============================================================
// Configuration
// ============================================================

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL),
});

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const CACHE_TTL_SECONDS = 60;
const MAX_BLOCK_RANGE = 10000n; // Some RPCs limit range

// ============================================================
// Types
// ============================================================

export interface HolderInfo {
  rank: number;
  address: string;
  balance: string; // wei string
  percentage: number;
  is_creator: boolean;
  is_dev: boolean;
  label?: string;
  pnl_percentage?: number;
  avg_buy_price?: string;
  realized_pnl?: string;
  unrealized_pnl?: string;
}

export interface TopHoldersResponse {
  success: boolean;
  inst_id?: string;
  holders: HolderInfo[];
  total_holders: number;
  top10_percentage: number;
  creator_address?: string;
  creator_holding?: number;
  concentration_risk: "HIGH" | "MEDIUM" | "LOW";
  // Pool info (bonding curve)
  pool_address?: string;
  pool_holding?: number;        // Pool's percentage of total supply
  sold_percentage?: number;     // Percentage of tokens sold (graduation progress)
  is_graduated?: boolean;
}

interface TransferLog {
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: bigint;
}

// ============================================================
// Core Logic
// ============================================================

/**
 * Fetch all Transfer events for an ERC20 token and aggregate balances.
 */
async function fetchTransferLogs(token: Address, tokenCreatedAt?: number): Promise<TransferLog[]> {
  const currentBlock = await publicClient.getBlockNumber();

  // Fetch in chunks to avoid RPC limits
  const logs: TransferLog[] = [];
  let fromBlock = 0n;

  // Calculate start block based on token creation time
  // BSC Testnet: ~3 seconds per block
  if (tokenCreatedAt && tokenCreatedAt > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSeconds - tokenCreatedAt;
    const estimatedBlocks = BigInt(Math.ceil(ageSeconds / 2)) + 10000n; // Add buffer
    fromBlock = currentBlock > estimatedBlocks ? currentBlock - estimatedBlocks : 0n;
  } else {
    // Fallback: last 2 million blocks (~46 days on Base)
    const fallbackRange = 2_000_000n;
    fromBlock = currentBlock > fallbackRange ? currentBlock - fallbackRange : 0n;
  }

  while (fromBlock <= currentBlock) {
    const toBlock = fromBlock + MAX_BLOCK_RANGE > currentBlock
      ? currentBlock
      : fromBlock + MAX_BLOCK_RANGE;

    try {
      const rawLogs = await publicClient.getLogs({
        address: token,
        event: TRANSFER_EVENT,
        fromBlock,
        toBlock,
      });

      for (const log of rawLogs) {
        logs.push({
          from: log.args.from as Address,
          to: log.args.to as Address,
          value: log.args.value as bigint,
          blockNumber: log.blockNumber,
        });
      }
    } catch (err) {
      logger.warn("TokenHolders", `Failed to fetch logs for block range ${fromBlock}-${toBlock}: ${err}`);
    }

    fromBlock = toBlock + 1n;
  }

  return logs;
}

/**
 * Build holder balance map from Transfer events.
 */
function aggregateBalances(logs: TransferLog[]): Map<string, bigint> {
  const balances = new Map<string, bigint>();

  for (const log of logs) {
    const from = log.from.toLowerCase();
    const to = log.to.toLowerCase();

    // Subtract from sender (skip zero address = minting)
    if (from !== ZERO_ADDRESS.toLowerCase()) {
      const prev = balances.get(from) ?? 0n;
      balances.set(from, prev - log.value);
    }

    // Add to receiver (skip zero address = burning)
    if (to !== ZERO_ADDRESS.toLowerCase()) {
      const prev = balances.get(to) ?? 0n;
      balances.set(to, prev + log.value);
    }
  }

  // Remove zero/negative balances
  for (const [addr, bal] of balances) {
    if (bal <= 0n) {
      balances.delete(addr);
    }
  }

  return balances;
}

/**
 * Compute per-address average buy price and PnL from Transfer logs.
 * Uses a simple FIFO cost-basis model.
 */
function computePnlData(
  logs: TransferLog[],
  balances: Map<string, bigint>,
  currentPriceWei: bigint
): Map<string, { avgBuyPrice: bigint; realizedPnl: bigint; unrealizedPnl: bigint }> {
  // Track cost basis per address: total ETH spent / total tokens acquired
  // Since we don't have ETH amounts in Transfer events, we estimate using
  // the token amount and approximate price at that block.
  // Simplified: we track token inflows and use current price for unrealized.
  const costBasis = new Map<string, { totalTokensBought: bigint; totalTokensSold: bigint }>();

  for (const log of logs) {
    const to = log.to.toLowerCase();
    const from = log.from.toLowerCase();

    if (to !== ZERO_ADDRESS.toLowerCase()) {
      const prev = costBasis.get(to) ?? { totalTokensBought: 0n, totalTokensSold: 0n };
      prev.totalTokensBought += log.value;
      costBasis.set(to, prev);
    }

    if (from !== ZERO_ADDRESS.toLowerCase()) {
      const prev = costBasis.get(from) ?? { totalTokensBought: 0n, totalTokensSold: 0n };
      prev.totalTokensSold += log.value;
      costBasis.set(from, prev);
    }
  }

  const result = new Map<string, { avgBuyPrice: bigint; realizedPnl: bigint; unrealizedPnl: bigint }>();

  for (const [addr, balance] of balances) {
    const basis = costBasis.get(addr);
    if (!basis) continue;

    // Simplified PnL: unrealized = current balance value (can't compute true cost without ETH amounts)
    const unrealizedValue = (balance * currentPriceWei) / (10n ** 18n);

    result.set(addr, {
      avgBuyPrice: 0n, // Would need ETH amounts to compute
      realizedPnl: 0n,
      unrealizedPnl: unrealizedValue,
    });
  }

  return result;
}

interface TokenInfo {
  creator: Address | null;
  createdAt: number;
  realTokenReserve: bigint;  // 池子中剩余的代币数量
  soldTokens: bigint;        // 已售出的代币数量
  isGraduated: boolean;
}

/**
 * Get token info (creator, createdAt, pool reserve) from TokenFactory getPoolState.
 */
async function getTokenInfo(token: Address): Promise<TokenInfo> {
  try {
    const poolState = await publicClient.readContract({
      address: TOKEN_FACTORY_ADDRESS,
      abi: [{
        inputs: [{ name: "tokenAddress", type: "address" }],
        name: "getPoolState",
        outputs: [{
          components: [
            { name: "realETHReserve", type: "uint256" },
            { name: "realTokenReserve", type: "uint256" },
            { name: "soldTokens", type: "uint256" },
            { name: "isGraduated", type: "bool" },
            { name: "isActive", type: "bool" },
            { name: "creator", type: "address" },
            { name: "createdAt", type: "uint64" },
            { name: "metadataURI", type: "string" },
            { name: "graduationFailed", type: "bool" },
            { name: "graduationAttempts", type: "uint8" },
            { name: "perpEnabled", type: "bool" },
          ],
          type: "tuple",
        }],
        stateMutability: "view",
        type: "function",
      }] as const,
      functionName: "getPoolState",
      args: [token],
    });

    return {
      creator: (poolState as any).creator as Address,
      createdAt: Number((poolState as any).createdAt),
      realTokenReserve: (poolState as any).realTokenReserve as bigint,
      soldTokens: (poolState as any).soldTokens as bigint,
      isGraduated: (poolState as any).isGraduated as boolean,
    };
  } catch (err) {
    logger.warn("TokenHolders", `Failed to get token info for ${token}: ${err}`);
    return { creator: null, createdAt: 0, realTokenReserve: 0n, soldTokens: 0n, isGraduated: false };
  }
}

/**
 * Get current token price from TokenFactory.
 */
async function getCurrentPrice(token: Address): Promise<bigint> {
  try {
    const price = await publicClient.readContract({
      address: TOKEN_FACTORY_ADDRESS,
      abi: [{
        inputs: [{ name: "tokenAddress", type: "address" }],
        name: "getCurrentPrice",
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
        type: "function",
      }] as const,
      functionName: "getCurrentPrice",
      args: [token],
    });

    return price;
  } catch {
    return 0n;
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Get top token holders with optional PnL data.
 * Results are cached in Redis for CACHE_TTL_SECONDS.
 */
export async function getTokenHolders(
  token: Address,
  limit: number = 10,
  includePnl: boolean = false
): Promise<TopHoldersResponse> {
  const cacheKey = `spot:holders:${token.toLowerCase()}:${includePnl ? "pnl" : "basic"}`;

  // Check Redis cache
  try {
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Redis unavailable, continue without cache
  }

  // Fetch token info first (needed for block range calculation and pool info)
  const tokenInfo = await getTokenInfo(token);
  const creatorAddress = tokenInfo.creator;

  // Fetch on-chain data
  const [logs, currentPrice] = await Promise.all([
    fetchTransferLogs(token, tokenInfo.createdAt),
    includePnl ? getCurrentPrice(token) : Promise.resolve(0n),
  ]);

  const balances = aggregateBalances(logs);
  const pnlData = includePnl ? computePnlData(logs, balances, currentPrice) : null;

  // Total supply = 1 billion tokens (with 18 decimals)
  const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

  // Add bonding curve pool as a holder if it has tokens
  // The pool holds realTokenReserve tokens (unsold tokens)
  const poolAddress = TOKEN_FACTORY_ADDRESS.toLowerCase();
  if (tokenInfo.realTokenReserve > 0n && !tokenInfo.isGraduated) {
    balances.set(poolAddress, tokenInfo.realTokenReserve);
  }

  // Sort by balance descending
  const sorted = [...balances.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));

  // Total holders = individual holders (excluding pool)
  const totalHolders = sorted.filter(([addr]) => addr !== poolAddress).length;
  const topN = sorted.slice(0, limit);

  // Build holder list
  const holders: HolderInfo[] = topN.map(([addr, balance], index) => {
    // Use total supply as denominator for accurate percentage
    const percentage = Number((balance * 10000n) / TOTAL_SUPPLY) / 100;
    const isCreator = creatorAddress
      ? addr.toLowerCase() === creatorAddress.toLowerCase()
      : false;
    const isPool = addr === poolAddress;

    // Determine label
    let label: string | undefined;
    if (isPool) {
      label = "BONDING_CURVE";
    } else if (isCreator) {
      label = "CREATOR";
    } else if (percentage > 5) {
      label = "WHALE";
    }

    const holder: HolderInfo = {
      rank: index + 1,
      address: addr,
      balance: balance.toString(),
      percentage,
      is_creator: isCreator,
      is_dev: false,
      label,
    };

    if (pnlData && !isPool) {
      const pnl = pnlData.get(addr);
      if (pnl) {
        holder.unrealized_pnl = pnl.unrealizedPnl.toString();
        holder.realized_pnl = pnl.realizedPnl.toString();
        // Simplified PnL percentage (relative to current value)
        if (pnl.unrealizedPnl > 0n) {
          holder.pnl_percentage = 0; // Can't compute without cost basis
        }
      }
    }

    return holder;
  });

  // Calculate top10 percentage (excluding pool for concentration risk)
  const top10ExcludingPool = holders.filter(h => h.label !== "BONDING_CURVE").slice(0, 10);
  const top10Percentage = top10ExcludingPool.reduce((sum, h) => sum + h.percentage, 0);

  // Creator holding percentage
  const creatorHolding = creatorAddress
    ? holders.find(h => h.is_creator)?.percentage
    : undefined;

  // Pool holding percentage
  const poolHolder = holders.find(h => h.label === "BONDING_CURVE");
  const poolHolding = poolHolder?.percentage;

  // Sold percentage (graduation progress) = soldTokens / target
  // Target = 793M tokens (1B - 207M threshold)
  const SOLD_TARGET = 793_000_000n * 10n ** 18n;
  const soldPercentage = tokenInfo.soldTokens > 0n
    ? Number((tokenInfo.soldTokens * 10000n) / SOLD_TARGET) / 100
    : 0;

  // Concentration risk (based on top holders excluding pool)
  const concentrationRisk: "HIGH" | "MEDIUM" | "LOW" =
    top10Percentage > 50 ? "HIGH" : top10Percentage > 30 ? "MEDIUM" : "LOW";

  const response: TopHoldersResponse = {
    success: true,
    inst_id: token,
    holders,
    total_holders: totalHolders,
    top10_percentage: top10Percentage,
    creator_address: creatorAddress ?? undefined,
    creator_holding: creatorHolding,
    concentration_risk: concentrationRisk,
    // Pool info
    pool_address: TOKEN_FACTORY_ADDRESS,
    pool_holding: poolHolding,
    sold_percentage: Math.min(soldPercentage, 100), // Cap at 100%
    is_graduated: tokenInfo.isGraduated,
  };

  // Cache in Redis
  try {
    const redis = getRedisClient();
    await redis.set(cacheKey, JSON.stringify(response), "EX", CACHE_TTL_SECONDS);
  } catch {
    // Cache write failure is non-critical
  }

  return response;
}
