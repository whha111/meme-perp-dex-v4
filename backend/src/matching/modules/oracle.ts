import { getMarkets, type MemePerpMarket, type MarketStatus, type PriceSourceTag } from "./marketRegistry";

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

const ORACLE_CACHE_MS = Number(process.env.ORACLE_CACHE_MS || 10_000);
const PRICE_TIMEOUT_MS = Number(process.env.ORACLE_SOURCE_TIMEOUT_MS || 3_500);
const OUTLIER_BPS = Number(process.env.ORACLE_OUTLIER_BPS || 250);
const REDUCE_ONLY_AFTER_MS = Number(process.env.ORACLE_REDUCE_ONLY_AFTER_MS || 30_000);
const PAUSE_AFTER_MS = Number(process.env.ORACLE_PAUSE_AFTER_MS || 90_000);
const SIGNER_SET_VERSION = Number(process.env.ORACLE_SIGNER_SET_VERSION || 1);
const ORACLE_SIGNERS = (process.env.ORACLE_SIGNERS || "")
  .split(",")
  .map((signer) => signer.trim())
  .filter(Boolean);
const ORACLE_QUORUM = Number(process.env.ORACLE_QUORUM || 2);

let cache: { timestamp: number; snapshots: OraclePriceSnapshot[] } | null = null;

function toPriceString(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1) return value.toFixed(8).replace(/\.?0+$/, "");
  return value.toPrecision(10).replace(/\.?0+$/, "");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseTickerPrice(payload: any): number | null {
  const raw =
    payload?.lastPrice ??
    payload?.price ??
    payload?.data?.lastPrice ??
    payload?.data?.price ??
    payload?.data?.c;
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function readBinanceSpot(market: MemePerpMarket): Promise<PriceSourceSnapshot | null> {
  if (!market.binanceSpotSymbol) return null;
  const symbol = market.binanceSpotSymbol.toUpperCase();
  try {
    const payload = await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    return { source: "binance_spot", symbol, priceUsd: parseTickerPrice(payload), ok: true, timestamp: Date.now() };
  } catch (primaryError) {
    try {
      const payload = await fetchJson(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`);
      return { source: "binance_spot", symbol, priceUsd: parseTickerPrice(payload), ok: true, timestamp: Date.now() };
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      return { source: "binance_spot", symbol, priceUsd: null, ok: false, error: `${primaryMessage}; fallback ${fallbackMessage}`, timestamp: Date.now() };
    }
  }
}

async function readBinanceFutures(market: MemePerpMarket): Promise<PriceSourceSnapshot | null> {
  if (!market.binanceFuturesSymbol) return null;
  const symbol = market.binanceFuturesSymbol.toUpperCase();
  try {
    const payload = await fetchJson(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`);
    const rawPrice = parseTickerPrice(payload);
    const priceUsd = symbol.startsWith("1000") && rawPrice ? rawPrice / 1000 : rawPrice;
    return { source: "binance_futures", symbol, priceUsd, ok: true, timestamp: Date.now() };
  } catch (e) {
    return { source: "binance_futures", symbol, priceUsd: null, ok: false, error: e instanceof Error ? e.message : String(e), timestamp: Date.now() };
  }
}

async function readBinanceAlpha(market: MemePerpMarket): Promise<PriceSourceSnapshot | null> {
  if (!market.binanceAlphaSymbol) return null;
  const symbol = market.binanceAlphaSymbol;
  try {
    const payload = await fetchJson(`https://www.binance.com/bapi/defi/v1/public/alpha-trade/ticker?symbol=${encodeURIComponent(symbol)}`);
    return { source: "binance_alpha", symbol, priceUsd: parseTickerPrice(payload), ok: true, timestamp: Date.now() };
  } catch (e) {
    return { source: "binance_alpha", symbol, priceUsd: null, ok: false, error: e instanceof Error ? e.message : String(e), timestamp: Date.now() };
  }
}

function readReference(market: MemePerpMarket): PriceSourceSnapshot {
  return {
    source: "reference",
    symbol: market.displaySymbol,
    priceUsd: market.referencePriceUsd,
    ok: true,
    timestamp: Date.now(),
  };
}

function deriveStatus(market: MemePerpMarket, liveSources: PriceSourceSnapshot[], timestamp: number): { status: MarketStatus; reason?: string } {
  if (market.status === "paused") return { status: "paused", reason: "market disabled by registry" };
  if (liveSources.length < 2) return { status: "reduce_only", reason: "fewer than two live oracle sources" };
  const newest = Math.max(...liveSources.map((source) => source.timestamp));
  const age = timestamp - newest;
  if (age > PAUSE_AFTER_MS) return { status: "paused", reason: "oracle price stale" };
  if (age > REDUCE_ONLY_AFTER_MS) return { status: "reduce_only", reason: "oracle price aging" };
  return { status: market.status };
}

async function buildSnapshot(market: MemePerpMarket): Promise<OraclePriceSnapshot> {
  const sourceResults = await Promise.all([
    readBinanceSpot(market),
    readBinanceFutures(market),
    readBinanceAlpha(market),
  ]);
  const sources = sourceResults.filter(Boolean) as PriceSourceSnapshot[];
  sources.push(readReference(market));

  const liveSources = sources.filter((source) => source.ok && source.source !== "reference" && source.priceUsd && source.priceUsd > 0);
  const liveMedian = liveSources.length > 0 ? median(liveSources.map((source) => source.priceUsd as number)) : market.referencePriceUsd;
  const maxDeviation = liveMedian * OUTLIER_BPS / 10_000;
  const acceptedLiveSources = liveSources.filter((source) => Math.abs((source.priceUsd as number) - liveMedian) <= maxDeviation);
  const acceptedPrices = acceptedLiveSources.length > 0
    ? acceptedLiveSources.map((source) => source.priceUsd as number)
    : [market.referencePriceUsd];
  const timestamp = Date.now();
  const { status, reason } = deriveStatus(market, acceptedLiveSources, timestamp);

  return {
    marketId: market.marketId,
    medianPriceUsd: toPriceString(median(acceptedPrices)),
    minPriceUsd: toPriceString(Math.min(...acceptedPrices)),
    maxPriceUsd: toPriceString(Math.max(...acceptedPrices)),
    sources,
    timestamp,
    signerSetVersion: SIGNER_SET_VERSION,
    signatures: [],
    status,
    reason,
  };
}

export async function getLatestOracleSnapshots(force = false): Promise<OraclePriceSnapshot[]> {
  const now = Date.now();
  if (!force && cache && now - cache.timestamp < ORACLE_CACHE_MS) {
    return cache.snapshots;
  }
  const snapshots = await Promise.all(getMarkets().map(buildSnapshot));
  cache = { timestamp: Date.now(), snapshots };
  return snapshots;
}

export async function getLatestOracleSnapshot(marketId: string): Promise<OraclePriceSnapshot | undefined> {
  const snapshots = await getLatestOracleSnapshots();
  return snapshots.find((snapshot) => snapshot.marketId === marketId.toUpperCase());
}

export async function getOracleStatus(): Promise<{
  signerSetVersion: number;
  quorum: string;
  stalePolicy: { reduceOnlyAfterMs: number; pauseAfterMs: number };
  markets: Array<{ marketId: string; status: MarketStatus; reason?: string; liveSources: number; totalSources: number; timestamp: number }>;
}> {
  const snapshots = await getLatestOracleSnapshots();
  return {
    signerSetVersion: SIGNER_SET_VERSION,
    quorum: `${ORACLE_QUORUM}-of-${Math.max(ORACLE_SIGNERS.length, 3)}`,
    stalePolicy: { reduceOnlyAfterMs: REDUCE_ONLY_AFTER_MS, pauseAfterMs: PAUSE_AFTER_MS },
    markets: snapshots.map((snapshot) => ({
      marketId: snapshot.marketId,
      status: snapshot.status,
      reason: snapshot.reason,
      liveSources: snapshot.sources.filter((source) => source.ok && source.source !== "reference").length,
      totalSources: snapshot.sources.length,
      timestamp: snapshot.timestamp,
    })),
  };
}
