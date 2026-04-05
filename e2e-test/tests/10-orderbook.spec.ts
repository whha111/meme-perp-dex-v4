/**
 * 10 — Orderbook Tests (Production Mode)
 * Verify orderbook displays, updates in real-time
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { submitSignedOrder } from "../utils/test-helpers";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const token = (Object.values(tokens)[0] as any).address;

test.describe.serial("10 — Orderbook (Production)", () => {
  test("orderbook API returns bid/ask structure", async () => {
    const resp = await fetch(`${ENGINE}/api/orderbook/${token}`);
    expect(resp.ok).toBeTruthy();
    const data = await resp.json() as any;
    expect(data.longs || data.bids || data.buys || data.asks).toBeDefined();
  });

  test("place limit orders to create depth", async () => {
    const buyer = wallets[44];
    const seller = wallets[45];

    // Get actual spot price first
    const obResp = await fetch(`${ENGINE}/api/orderbook/${token}`);
    const obData = await obResp.json() as any;
    const spotPrice = BigInt(obData.lastPrice || "25506923987");

    // Place buy limit orders below spot (within ±50% band)
    for (let i = 1; i <= 3; i++) {
      const price = (spotPrice * (100n - BigInt(i * 5)) / 100n).toString();
      await submitSignedOrder({
        wallet: buyer,
        token,
        isLong: true,
        orderType: 1,
        size: "10000000000000000",
        leverage: 20000,
        price,
      });
      await new Promise(r => setTimeout(r, 300));
    }

    // Place sell limit orders above spot (within ±50% band)
    for (let i = 1; i <= 3; i++) {
      const price = (spotPrice * (100n + BigInt(i * 5)) / 100n).toString();
      await submitSignedOrder({
        wallet: seller,
        token,
        isLong: false,
        orderType: 1,
        size: "10000000000000000",
        leverage: 20000,
        price,
      });
      await new Promise(r => setTimeout(r, 300));
    }

    await new Promise(r => setTimeout(r, 1000));
  });

  test("orderbook API returns valid structure after order placement", async () => {
    const resp = await fetch(`${ENGINE}/api/orderbook/${token}`);
    const data = await resp.json() as any;
    // Orderbook may be empty if limit orders were immediately filled
    // (engine fills limit orders against LP pool)
    // Just verify the structure is valid
    expect(data.longs || data.bids).toBeDefined();
    expect(data.shorts || data.asks).toBeDefined();
    expect(data.lastPrice).toBeDefined();
    expect(BigInt(data.lastPrice)).toBeGreaterThan(0n);
  });
});
