import type { Address } from "viem";

export type MarketStatus = "active" | "reduce_only" | "paused" | "experimental";
export type CollateralSymbol = "BNB" | "WBNB" | "USDT";
export type PriceSourceTag = "binance_spot" | "binance_futures" | "binance_alpha" | "dex_twap" | "reference";

export interface MemePerpMarket {
  marketId: string;
  displaySymbol: string;
  baseAsset: string;
  quoteAsset: "USDT";
  indexToken: Address;
  collateralTokens: CollateralSymbol[];
  sourceTags: PriceSourceTag[];
  maxLeverage: number;
  maxOiUsd: number;
  maxPositionUsd: number;
  status: MarketStatus;
  experimental: boolean;
  binanceSpotSymbol?: string;
  binanceFuturesSymbol?: string;
  binanceAlphaSymbol?: string;
  dexTwapSymbol?: string;
  referencePriceUsd: number;
}

const synthetic = (suffix: string) =>
  (`0x000000000000000000000000000000000000${suffix}`) as Address;
const alphaSymbol = (symbol: string) => process.env[`BINANCE_ALPHA_SYMBOL_${symbol}`];

const DEFAULT_MARKETS: MemePerpMarket[] = [
  {
    marketId: "DOGE-USDT-PERP",
    displaySymbol: "DOGE",
    baseAsset: "DOGE",
    quoteAsset: "USDT",
    indexToken: synthetic("D06E"),
    collateralTokens: ["BNB", "WBNB"],
    sourceTags: ["binance_spot", "binance_futures", "reference"],
    maxLeverage: 3,
    maxOiUsd: 250_000,
    maxPositionUsd: 10_000,
    status: "active",
    experimental: false,
    binanceSpotSymbol: "DOGEUSDT",
    binanceFuturesSymbol: "DOGEUSDT",
    referencePriceUsd: 0.16,
  },
  {
    marketId: "SHIB-USDT-PERP",
    displaySymbol: "SHIB",
    baseAsset: "SHIB",
    quoteAsset: "USDT",
    indexToken: synthetic("5148"),
    collateralTokens: ["BNB", "WBNB"],
    sourceTags: ["binance_spot", "binance_futures", "reference"],
    maxLeverage: 3,
    maxOiUsd: 150_000,
    maxPositionUsd: 7_500,
    status: "active",
    experimental: false,
    binanceSpotSymbol: "SHIBUSDT",
    binanceFuturesSymbol: "1000SHIBUSDT",
    referencePriceUsd: 0.00001,
  },
  {
    marketId: "PEPE-USDT-PERP",
    displaySymbol: "PEPE",
    baseAsset: "PEPE",
    quoteAsset: "USDT",
    indexToken: synthetic("733E"),
    collateralTokens: ["BNB", "WBNB"],
    sourceTags: ["binance_spot", "binance_futures", "reference"],
    maxLeverage: 3,
    maxOiUsd: 150_000,
    maxPositionUsd: 7_500,
    status: "active",
    experimental: false,
    binanceSpotSymbol: "PEPEUSDT",
    binanceFuturesSymbol: "1000PEPEUSDT",
    referencePriceUsd: 0.000009,
  },
  {
    marketId: "FLOKI-USDT-PERP",
    displaySymbol: "FLOKI",
    baseAsset: "FLOKI",
    quoteAsset: "USDT",
    indexToken: synthetic("F10F"),
    collateralTokens: ["BNB", "WBNB"],
    sourceTags: ["binance_spot", "binance_futures", "reference"],
    maxLeverage: 2,
    maxOiUsd: 100_000,
    maxPositionUsd: 5_000,
    status: "active",
    experimental: false,
    binanceSpotSymbol: "FLOKIUSDT",
    binanceFuturesSymbol: "1000FLOKIUSDT",
    referencePriceUsd: 0.00009,
  },
  {
    marketId: "BONK-USDT-PERP",
    displaySymbol: "BONK",
    baseAsset: "BONK",
    quoteAsset: "USDT",
    indexToken: synthetic("B0A1"),
    collateralTokens: ["BNB", "WBNB"],
    sourceTags: ["binance_spot", "binance_futures", "reference"],
    maxLeverage: 2,
    maxOiUsd: 100_000,
    maxPositionUsd: 5_000,
    status: "active",
    experimental: false,
    binanceSpotSymbol: "BONKUSDT",
    binanceFuturesSymbol: "1000BONKUSDT",
    referencePriceUsd: 0.00002,
  },
  {
    marketId: "WIF-USDT-PERP",
    displaySymbol: "WIF",
    baseAsset: "WIF",
    quoteAsset: "USDT",
    indexToken: synthetic("A11F"),
    collateralTokens: ["BNB", "WBNB"],
    sourceTags: ["binance_spot", "binance_futures", "reference"],
    maxLeverage: 2,
    maxOiUsd: 75_000,
    maxPositionUsd: 4_000,
    status: "active",
    experimental: false,
    binanceSpotSymbol: "WIFUSDT",
    binanceFuturesSymbol: "WIFUSDT",
    referencePriceUsd: 0.8,
  },
  {
    marketId: "POPCAT-USDT-PERP",
    displaySymbol: "POPCAT",
    baseAsset: "POPCAT",
    quoteAsset: "USDT",
    indexToken: synthetic("C47A"),
    collateralTokens: ["BNB", "WBNB"],
    sourceTags: ["binance_spot", "binance_alpha", "reference"],
    maxLeverage: 2,
    maxOiUsd: 25_000,
    maxPositionUsd: 1_500,
    status: "experimental",
    experimental: true,
    binanceSpotSymbol: "POPCATUSDT",
    binanceAlphaSymbol: alphaSymbol("POPCAT"),
    referencePriceUsd: 0.25,
  },
  {
    marketId: "MOG-USDT-PERP",
    displaySymbol: "MOG",
    baseAsset: "MOG",
    quoteAsset: "USDT",
    indexToken: synthetic("D0AC"),
    collateralTokens: ["BNB", "WBNB"],
    sourceTags: ["binance_spot", "binance_alpha", "reference"],
    maxLeverage: 2,
    maxOiUsd: 25_000,
    maxPositionUsd: 1_500,
    status: "experimental",
    experimental: true,
    binanceSpotSymbol: "MOGUSDT",
    binanceAlphaSymbol: alphaSymbol("MOG"),
    referencePriceUsd: 0.000001,
  },
];

const marketMap = new Map<string, MemePerpMarket>(
  DEFAULT_MARKETS.map((market) => [market.marketId, market])
);

const marketByIndexToken = new Map<string, MemePerpMarket>(
  DEFAULT_MARKETS.map((market) => [market.indexToken.toLowerCase(), market])
);

function cloneMarket(market: MemePerpMarket): MemePerpMarket {
  return {
    ...market,
    collateralTokens: [...market.collateralTokens],
    sourceTags: [...market.sourceTags],
  };
}

export function getMarkets(): MemePerpMarket[] {
  return Array.from(marketMap.values()).map(cloneMarket);
}

export function getMarket(marketId: string): MemePerpMarket | undefined {
  const normalized = marketId.trim().toUpperCase();
  const market = marketMap.get(normalized);
  return market ? cloneMarket(market) : undefined;
}

export function getMarketByIndexToken(indexToken: string): MemePerpMarket | undefined {
  const market = marketByIndexToken.get(indexToken.trim().toLowerCase());
  return market ? cloneMarket(market) : undefined;
}

export function getMarketToken(marketId: string): Address | undefined {
  return getMarket(marketId)?.indexToken;
}

export function getMarketIdByToken(indexToken: string): string | undefined {
  return getMarketByIndexToken(indexToken)?.marketId;
}

export function getPublicMarkets(): MemePerpMarket[] {
  return getMarkets().filter((market) => market.status !== "paused");
}

export function isSupportedMarket(marketId: string): boolean {
  return marketMap.has(marketId.trim().toUpperCase());
}
