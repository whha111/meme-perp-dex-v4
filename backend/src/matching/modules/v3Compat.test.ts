import { describe, expect, it } from "bun:test";
import type { Address } from "viem";
import type { MemePerpMarket } from "./marketRegistry";
import {
  canonicalV3Market,
  normalizeV3Path,
  parseV3AmountToWei,
  parseV3Leverage,
  resolveV3Market,
  v3CollateralToken,
} from "./v3Compat";

const DOGE_TOKEN = "0x000000000000000000000000000000000000D06E" as Address;

const markets: MemePerpMarket[] = [
  {
    marketId: "DOGE-USDT-PERP",
    displaySymbol: "DOGE",
    baseAsset: "DOGE",
    quoteAsset: "USDT",
    indexToken: DOGE_TOKEN,
    collateralTokens: ["BNB", "WBNB", "USDT"],
    sourceTags: ["binance_spot", "binance_futures", "reference"],
    maxLeverage: 3,
    maxOiUsd: 250000,
    maxPositionUsd: 10000,
    status: "active",
    experimental: false,
    referencePriceUsd: 0.16,
  },
];

describe("v3 compatibility helpers", () => {
  it("normalizes /api/v3 paths onto the same handler namespace", () => {
    expect(normalizeV3Path("/api/v3")).toBe("/v3");
    expect(normalizeV3Path("/api/v3/orders")).toBe("/v3/orders");
    expect(normalizeV3Path("/v3/orders")).toBe("/v3/orders");
  });

  it("resolves dYdX-style aliases to the canonical market", () => {
    for (const alias of ["DOGE-USDT-PERP", "DOGE-BNB", "DOGE/BNB", "DOGE", DOGE_TOKEN.toLowerCase()]) {
      const resolved = resolveV3Market(alias, markets);
      expect(resolved.error).toBeUndefined();
      expect(canonicalV3Market(resolved.market!)).toBe("DOGE-USDT-PERP");
    }
  });

  it("rejects unsupported markets with a readable error", () => {
    const resolved = resolveV3Market("UNKNOWN-BNB", markets);
    expect(resolved.market).toBeUndefined();
    expect(resolved.error).toContain("Unsupported market");
  });

  it("parses decimal and wei-sized v3 order amounts", () => {
    expect(parseV3AmountToWei("1.5", "size")).toBe(1500000000000000000n);
    expect(parseV3AmountToWei("42", "size")).toBe(42n);
    expect(() => parseV3AmountToWei("1e18", "size")).toThrow("scientific notation");
  });

  it("parses v3 leverage into the existing 1e4 fixed point format", () => {
    expect(parseV3Leverage(undefined, 2n)).toBe(20000n);
    expect(parseV3Leverage("3")).toBe(30000n);
    expect(parseV3Leverage("2.5")).toBe(25000n);
    expect(parseV3Leverage("30000")).toBe(30000n);
  });

  it("normalizes supported collateral tokens", () => {
    expect(v3CollateralToken(undefined)).toBe("BNB");
    expect(v3CollateralToken("wbnb")).toBe("WBNB");
    expect(v3CollateralToken("usdt")).toBe("USDT");
    expect(() => v3CollateralToken("ETH")).toThrow("Unsupported collateralToken");
  });
});
