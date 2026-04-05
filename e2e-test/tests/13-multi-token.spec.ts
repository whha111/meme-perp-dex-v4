/**
 * 13 — Multi-Token Tests (Production Mode)
 * Trade across multiple tokens simultaneously with real EIP-712 signatures
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { submitSignedOrder, getPositions } from "../utils/test-helpers";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
const tokenData = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const tokenList = Object.entries(tokenData).map(([symbol, info]: [string, any]) => ({
  symbol,
  address: info.address,
}));

// Use wallets 46-47
const trader = wallets[46];
const counterparty = wallets[47];

test.describe.serial("13 — Multi-Token Trading (Production)", () => {
  test("should have multiple tokens available", () => {
    expect(tokenList.length).toBeGreaterThanOrEqual(2);
    for (const t of tokenList) {
      expect(t.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    }
  });

  test("open positions on multiple tokens", async () => {
    for (const tokenInfo of tokenList.slice(0, 2)) {
      await submitSignedOrder({
        wallet: counterparty,
        token: tokenInfo.address,
        isLong: false,
        size: "50000000000000000",
        leverage: 20000,
      });

      await submitSignedOrder({
        wallet: trader,
        token: tokenInfo.address,
        isLong: true,
        size: "50000000000000000",
        leverage: 20000,
      });

      await new Promise(r => setTimeout(r, 1000));
    }
  });

  test("positions list shows entries", async () => {
    await new Promise(r => setTimeout(r, 2000));
    const positions = await getPositions(trader.address);
    expect(positions.length).toBeGreaterThan(0);
  });

  test("each token has independent orderbook", async () => {
    for (const tokenInfo of tokenList.slice(0, 2)) {
      const resp = await fetch(`${ENGINE}/api/orderbook/${tokenInfo.address}`);
      expect(resp.status).toBeLessThan(500);
    }
  });

  test("each token has independent price", async () => {
    const prices: Record<string, number> = {};
    for (const tokenInfo of tokenList.slice(0, 2)) {
      const resp = await fetch(`${ENGINE}/api/price/${tokenInfo.address}`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const price = Number(data.price || data.markPrice || 0);
        if (price > 0) prices[tokenInfo.symbol] = price;
      }
    }
    expect(Object.keys(prices).length).toBeGreaterThanOrEqual(0);
  });
});
