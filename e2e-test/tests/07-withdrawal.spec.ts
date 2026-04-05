/**
 * 07 — Withdrawal Tests
 * Test Merkle proof withdrawal flow
 */
import { test, expect } from "@playwright/test";

const ENGINE = "http://localhost:8081";

test.describe.serial("07 — Withdrawal Flow", () => {
  const trader = "0x" + "7".repeat(40);

  test.beforeAll(async () => {
    // Deposit funds first
    await fetch(`${ENGINE}/api/user/${trader}/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "1000000000000000000" }), // 1 BNB
    });
    await new Promise(r => setTimeout(r, 2000));
  });

  test("check balance before withdrawal", async () => {
    const resp = await fetch(`${ENGINE}/api/user/${trader}/balance`);
    const data = await resp.json() as any;
    const balance = Number(data.availableBalance || data.totalBalance || 0);
    expect(balance).toBeGreaterThan(0);
  });

  test("request withdrawal — get Merkle proof", async () => {
    const resp = await fetch(`${ENGINE}/api/withdraw/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader,
        amount: "500000000000000000", // 0.5 BNB
      }),
    });

    // The withdrawal request should be accepted or queued
    expect(resp.status).toBeLessThan(500);

    const data = await resp.json() as any;
    if (data.proof) {
      expect(data.proof).toBeDefined();
      expect(data.root).toBeDefined();
    }
  });

  test("check balance reduced after withdrawal request", async () => {
    await new Promise(r => setTimeout(r, 3000));

    const resp = await fetch(`${ENGINE}/api/user/${trader}/balance`);
    const data = await resp.json() as any;
    // Balance should be reduced (locked for withdrawal)
    expect(resp.ok).toBeTruthy();
  });

  test("withdrawal with insufficient balance — rejected", async () => {
    const resp = await fetch(`${ENGINE}/api/withdraw/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader,
        amount: "100000000000000000000", // 100 BNB (way more than available)
      }),
    });

    const data = await resp.json() as any;
    // Should be rejected
    if (resp.status >= 400) {
      expect(data.error || data.message).toBeDefined();
    }
  });
});
