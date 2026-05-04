import { API_BASE_URL } from "@/config/api";

export type MarketStatus = "active" | "reduce_only" | "paused" | "experimental";
export type CollateralSymbol = "BNB" | "WBNB" | "USDT";
export type PriceSourceTag = "binance_spot" | "binance_futures" | "binance_alpha" | "dex_twap" | "reference";

export interface PriceSourceSnapshot {
  source: PriceSourceTag;
  symbol: string;
  priceUsd: number | null;
  ok: boolean;
  error?: string;
  timestamp: number;
}

export interface OraclePriceSnapshot {
  marketId: string;
  medianPriceUsd: string;
  minPriceUsd: string;
  maxPriceUsd: string;
  sources: PriceSourceSnapshot[];
  timestamp: number;
  signerSetVersion: number;
  signatures: string[];
  status: MarketStatus;
  reason?: string;
}

export interface MemePerpMarket {
  marketId: string;
  displaySymbol: string;
  baseAsset: string;
  quoteAsset: "USDT";
  indexToken: `0x${string}`;
  collateralTokens: CollateralSymbol[];
  sourceTags: PriceSourceTag[];
  maxLeverage: number;
  maxOiUsd: number;
  maxPositionUsd: number;
  status: MarketStatus;
  experimental: boolean;
  price?: OraclePriceSnapshot | null;
}

export const FALLBACK_MEME_MARKETS: MemePerpMarket[] = [
  { marketId: "DOGE-USDT-PERP", displaySymbol: "DOGE", baseAsset: "DOGE", quoteAsset: "USDT", indexToken: "0x000000000000000000000000000000000000D06E", collateralTokens: ["BNB", "WBNB"], sourceTags: ["binance_spot", "binance_futures", "reference"], maxLeverage: 3, maxOiUsd: 250000, maxPositionUsd: 10000, status: "active", experimental: false },
  { marketId: "SHIB-USDT-PERP", displaySymbol: "SHIB", baseAsset: "SHIB", quoteAsset: "USDT", indexToken: "0x0000000000000000000000000000000000005148", collateralTokens: ["BNB", "WBNB"], sourceTags: ["binance_spot", "binance_futures", "reference"], maxLeverage: 3, maxOiUsd: 150000, maxPositionUsd: 7500, status: "active", experimental: false },
  { marketId: "PEPE-USDT-PERP", displaySymbol: "PEPE", baseAsset: "PEPE", quoteAsset: "USDT", indexToken: "0x000000000000000000000000000000000000733E", collateralTokens: ["BNB", "WBNB"], sourceTags: ["binance_spot", "binance_futures", "reference"], maxLeverage: 3, maxOiUsd: 150000, maxPositionUsd: 7500, status: "active", experimental: false },
  { marketId: "FLOKI-USDT-PERP", displaySymbol: "FLOKI", baseAsset: "FLOKI", quoteAsset: "USDT", indexToken: "0x000000000000000000000000000000000000F10F", collateralTokens: ["BNB", "WBNB"], sourceTags: ["binance_spot", "binance_futures", "reference"], maxLeverage: 2, maxOiUsd: 100000, maxPositionUsd: 5000, status: "active", experimental: false },
  { marketId: "BONK-USDT-PERP", displaySymbol: "BONK", baseAsset: "BONK", quoteAsset: "USDT", indexToken: "0x000000000000000000000000000000000000B0A1", collateralTokens: ["BNB", "WBNB"], sourceTags: ["binance_spot", "binance_futures", "reference"], maxLeverage: 2, maxOiUsd: 100000, maxPositionUsd: 5000, status: "active", experimental: false },
  { marketId: "WIF-USDT-PERP", displaySymbol: "WIF", baseAsset: "WIF", quoteAsset: "USDT", indexToken: "0x000000000000000000000000000000000000A11F", collateralTokens: ["BNB", "WBNB"], sourceTags: ["binance_spot", "binance_futures", "reference"], maxLeverage: 2, maxOiUsd: 75000, maxPositionUsd: 4000, status: "active", experimental: false },
  { marketId: "POPCAT-USDT-PERP", displaySymbol: "POPCAT", baseAsset: "POPCAT", quoteAsset: "USDT", indexToken: "0x000000000000000000000000000000000000C47A", collateralTokens: ["BNB", "WBNB"], sourceTags: ["binance_spot", "binance_alpha", "reference"], maxLeverage: 2, maxOiUsd: 25000, maxPositionUsd: 1500, status: "experimental", experimental: true },
  { marketId: "MOG-USDT-PERP", displaySymbol: "MOG", baseAsset: "MOG", quoteAsset: "USDT", indexToken: "0x000000000000000000000000000000000000D0AC", collateralTokens: ["BNB", "WBNB"], sourceTags: ["binance_spot", "binance_alpha", "reference"], maxLeverage: 2, maxOiUsd: 25000, maxPositionUsd: 1500, status: "experimental", experimental: true },
];

export function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toPrecision(4)}`;
  return "$0";
}

export async function fetchMemeMarkets(): Promise<MemePerpMarket[]> {
  const base = API_BASE_URL || "";
  const response = await fetch(`${base}/api/markets`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to fetch markets: ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload.data) ? payload.data : FALLBACK_MEME_MARKETS;
}
