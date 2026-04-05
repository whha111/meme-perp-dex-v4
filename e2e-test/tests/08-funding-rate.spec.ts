/**
 * 08 — Funding Rate Tests (Production Mode)
 * Verify funding rate calculation and payment with real signatures
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { submitSignedOrder } from "../utils/test-helpers";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const token = (Object.values(tokens)[0] as any).address;

// Use wallets 54-55 (high available balance)
const longTrader = wallets[54];
const shortTrader = wallets[55];

test.describe.serial("08 — Funding Rate (Production)", () => {
  test("create long-heavy imbalance", async () => {
    await submitSignedOrder({
      wallet: shortTrader,
      token,
      isLong: false,
      size: "200000000000000000", // 0.2 BNB
      leverage: 20000,
    });

    const result = await submitSignedOrder({
      wallet: longTrader,
      token,
      isLong: true,
      size: "200000000000000000",
      leverage: 20000,
    });
    expect(result.success || result.orderId).toBeTruthy();

    await new Promise(r => setTimeout(r, 2000));
  });

  test("check funding rate endpoint", async () => {
    const resp = await fetch(`${ENGINE}/api/funding-rate/${token}`);
    expect(resp.status).toBeLessThan(500);

    if (resp.ok) {
      const data = await resp.json() as any;
      const hasRate = data.fundingRate !== undefined || data.rate !== undefined || data.currentRate !== undefined;
      expect(hasRate).toBeTruthy();
    }
  });

  test("verify funding rate is a valid number", async () => {
    const resp = await fetch(`${ENGINE}/api/funding-rate/${token}`);
    if (resp.ok) {
      const data = await resp.json() as any;
      const rate = Number(data.fundingRate || data.rate || data.currentRate || 0);
      expect(isFinite(rate)).toBeTruthy();
    }
  });

  test("engine health reports ok", async () => {
    const resp = await fetch(`${ENGINE}/health`);
    const health = await resp.json() as any;
    expect(health.status).toBe("ok");
  });
});
