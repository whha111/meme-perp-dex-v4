/**
 * API Handlers — thin wrappers around spotHistory repos.
 *
 * Several routes in server.ts `await import("./api/handlers")` to read
 * kline / trade data that lives in Redis (via the spotHistory module).
 * This file was missing, causing silent import failures and empty responses.
 */

import type { Address } from "viem";
import {
  KlineRepo,
  SpotTradeRepo,
  SpotStatsRepo,
  type KlineResolution,
} from "../../spot/spotHistory";

// ─── Kline Handlers ───────────────────────────────────────

/**
 * Get latest klines for a token (used by /api/kline/:token and /api/v1/spot/klines/latest/:token)
 */
export async function handleGetLatestKlines(
  token: Address,
  resolution: string,
  limit: number
): Promise<{ success: boolean; data: Array<Record<string, unknown>> }> {
  const normalizedToken = token.toLowerCase() as Address;
  const res = (resolution || "1m") as KlineResolution;

  const bars = await KlineRepo.getLatest(normalizedToken, res, limit);

  return {
    success: true,
    data: bars.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      trades: b.trades,
    })),
  };
}

/**
 * Get klines within a time range (used by /api/v1/spot/klines/:token)
 */
export async function handleGetKlines(
  token: Address,
  resolution: string,
  from: number,
  to: number
): Promise<{ success: boolean; data: Array<Record<string, unknown>> }> {
  const normalizedToken = token.toLowerCase() as Address;
  const res = (resolution || "1m") as KlineResolution;

  const bars = await KlineRepo.get(normalizedToken, res, from, to);

  return {
    success: true,
    data: bars.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      trades: b.trades,
    })),
  };
}

// ─── Trade Handlers ───────────────────────────────────────

/**
 * Get spot trades for a token (used by /api/v1/spot/trades/:token)
 */
/**
 * Get spot price and 24h stats for a token (used by /api/v1/spot/price/:token)
 */
export async function handleGetSpotPrice(
  token: Address
): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
  const normalizedToken = token.toLowerCase() as Address;

  const price = await SpotStatsRepo.getPrice(normalizedToken);
  const stats = await SpotStatsRepo.get24hStats(normalizedToken);

  if (!price) {
    return { success: false, error: "Price not found" };
  }

  return {
    success: true,
    data: {
      token: normalizedToken,
      price: price.price,
      priceUsd: price.priceUsd,
      ...(stats ? {
        volume24h: stats.volume24h,
        high24h: stats.high24h,
        low24h: stats.low24h,
        change24h: stats.change24h,
        trades24h: stats.trades24h,
      } : {}),
    },
  };
}

/**
 * Get spot trades for a token (used by /api/v1/spot/trades/:token)
 */
export async function handleGetSpotTrades(
  token: Address,
  limit: number,
  before?: number
): Promise<{ success: boolean; data: Array<Record<string, unknown>> }> {
  const normalizedToken = token.toLowerCase() as Address;
  const trades = await SpotTradeRepo.getByToken(normalizedToken, limit, before);

  return {
    success: true,
    data: trades.map((t) => ({
      id: t.id,
      token: t.token,
      trader: t.trader,
      isBuy: t.isBuy,
      ethAmount: t.ethAmount,
      tokenAmount: t.tokenAmount,
      price: t.price,
      priceUsd: t.priceUsd,
      txHash: t.txHash,
      timestamp: t.timestamp,
    })),
  };
}
