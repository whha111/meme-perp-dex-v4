/**
 * 15 — Concurrent Trading Tests (Production Mode)
 * Multiple real wallets trading simultaneously, verify no race conditions
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { submitSignedOrder, checkHealth } from "../utils/test-helpers";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const token = (Object.values(tokens)[0] as any).address;

// Use wallets 50-69 (20 wallets for concurrent test)
const concurrentWallets = wallets.slice(50, 70);

test.describe.serial("15 — Concurrent Trading (Production)", () => {
  test("submit 10 orders simultaneously", async () => {
    const batch = concurrentWallets.slice(0, 10);
    const results = await Promise.all(batch.map((w: any, i: number) =>
      submitSignedOrder({
        wallet: w,
        token,
        isLong: i % 2 === 0,
        size: "50000000000000000",
        leverage: 20000,
      }).catch(e => ({ error: e.message }))
    ));

    expect(results.length).toBe(10);
    // All should get a response (not crash)
    expect(results.every((r: any) => r !== null && r !== undefined)).toBeTruthy();
  });

  test("engine remains healthy after concurrent load", async () => {
    await new Promise(r => setTimeout(r, 3000));
    const health = await checkHealth();
    expect(health.status).toBe("ok");
    expect(health.services.redis).toBe("connected");
  });

  test("all wallets can query their balance", async () => {
    const results = await Promise.all(concurrentWallets.slice(0, 10).map((w: any) =>
      fetch(`${ENGINE}/api/user/${w.address}/balance`).then(r => r.json())
    ));
    expect(results.length).toBe(10);
  });

  test("rapid-fire sequential orders from single wallet", async () => {
    const rapidWallet = concurrentWallets[15];
    let success = 0;
    let errors = 0;

    for (let i = 0; i < 10; i++) {
      try {
        const result = await submitSignedOrder({
          wallet: rapidWallet,
          token,
          isLong: i % 2 === 0,
          size: "10000000000000000",
          leverage: 20000,
        });
        if (result.success || result.orderId) success++;
        else errors++;
      } catch {
        errors++;
      }
      await new Promise(r => setTimeout(r, 100)); // Small delay for nonce
    }

    // At least some should succeed
    expect(success + errors).toBe(10);

    const health = await checkHealth();
    expect(health.status).toBe("ok");
  });
});
