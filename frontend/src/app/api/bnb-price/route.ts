import { NextResponse } from "next/server";

/**
 * GET /api/bnb-price
 *
 * 服务端 BNB 价格聚合接口 — 多数据源 fallback + 服务端缓存
 *
 * 数据源优先级:
 *   1. Binance US  (api.binance.us — 中国可访问，格式与 .com 相同)
 *   2. OKX         (www.okx.com — 中国友好)
 *   3. 固定 fallback ($600)
 *
 * 缓存策略:
 *   - 成功响应: Cache-Control 60s (ISR 风格)
 *   - 服务端内存缓存: 30s TTL，防止上游限流
 *   - 失败响应: 不缓存
 */

// ─── 服务端内存缓存 ─────────────────────────────
interface PriceCache {
  price: number;
  change24h: number;
  source: string;
  timestamp: number;
}

let cache: PriceCache | null = null;
const CACHE_TTL_MS = 30_000; // 30 秒

const FALLBACK_PRICE = 600;
const FETCH_TIMEOUT_MS = 5_000;

// ─── 数据源 fetchers ────────────────────────────

async function fetchBinanceUS(): Promise<PriceCache | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(
      "https://api.binance.us/api/v3/ticker/24hr?symbol=BNBUSDT",
      { signal: controller.signal }
    );
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();
    const price = parseFloat(data.lastPrice);
    const change24h = parseFloat(data.priceChangePercent);

    if (price > 0) {
      return { price, change24h, source: "binance_us", timestamp: Date.now() };
    }
  } catch {
    // Binance US 不可用，静默降级
  }
  return null;
}

async function fetchOKX(): Promise<PriceCache | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(
      "https://www.okx.com/api/v5/market/ticker?instId=BNB-USDT",
      { signal: controller.signal }
    );
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json();
    if (data.code === "0" && data.data?.[0]) {
      const ticker = data.data[0];
      const price = parseFloat(ticker.last);
      const open24h = parseFloat(ticker.open24h);

      if (price > 0) {
        const change24h = open24h > 0 ? ((price - open24h) / open24h) * 100 : 0;
        return { price, change24h, source: "okx", timestamp: Date.now() };
      }
    }
  } catch {
    // OKX 不可用，静默降级
  }
  return null;
}

// ─── Route Handler ──────────────────────────────

export async function GET() {
  // 1. 检查内存缓存
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(
      {
        price: cache.price,
        change24h: cache.change24h,
        source: cache.source,
        cached: true,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  }

  // 2. 依次尝试数据源
  const result =
    (await fetchBinanceUS()) ??
    (await fetchOKX()) ??
    { price: FALLBACK_PRICE, change24h: 0, source: "fallback", timestamp: Date.now() };

  // 3. 写入缓存（仅缓存真实数据）
  if (result.source !== "fallback") {
    cache = result;
  }

  return NextResponse.json(
    {
      price: result.price,
      change24h: result.change24h,
      source: result.source,
      cached: false,
    },
    {
      headers: {
        "Cache-Control":
          result.source !== "fallback"
            ? "public, s-maxage=60, stale-while-revalidate=300"
            : "no-cache",
      },
    }
  );
}
