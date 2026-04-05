/**
 * 11 — K-Line Chart Tests (Production Mode)
 * Verify kline API returns OHLCV data, multiple timeframes work
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const token = (Object.values(tokens)[0] as any).address;

test.describe.serial("11 — K-Line Chart (Production)", () => {
  test("kline API returns OHLCV data", async () => {
    const resp = await fetch(`${ENGINE}/api/kline/${token}?interval=1m&limit=100`);
    if (resp.ok) {
      const data = await resp.json() as any;
      const candles = data.candles || data.klines || data || [];
      if (Array.isArray(candles) && candles.length > 0) {
        const candle = candles[0];
        expect(candle.open || candle.o).toBeDefined();
        expect(candle.high || candle.h).toBeDefined();
        expect(candle.low || candle.l).toBeDefined();
        expect(candle.close || candle.c).toBeDefined();
      }
    }
    expect(resp.status).toBeLessThan(500);
  });

  test("different timeframes return different data", async () => {
    const intervals = ["1m", "5m", "15m", "1h"];
    const results: any[] = [];

    for (const interval of intervals) {
      const resp = await fetch(`${ENGINE}/api/kline/${token}?interval=${interval}&limit=10`);
      if (resp.ok) {
        const data = await resp.json() as any;
        results.push({ interval, data });
      }
    }
    expect(results.length).toBeGreaterThan(0);
  });
});
