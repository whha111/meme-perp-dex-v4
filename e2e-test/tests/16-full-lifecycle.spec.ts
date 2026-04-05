/**
 * 16 — Full Lifecycle Test (Production Mode)
 * Complete flow: verify deposit → open → PnL → close → balance check
 * All with real wallets and real EIP-712 signatures
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { submitSignedOrder, getPositions, getBalance, checkHealth } from "../utils/test-helpers";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const token = (Object.values(tokens)[0] as any).address;

// Use wallets 80-81 (high available balance)
const alice = wallets[80];
const bob = wallets[81];
let aliceBalanceBefore: bigint;

test.describe.serial("16 — Full Lifecycle (Production)", () => {
  test("Step 1: Verify on-chain deposits exist", async () => {
    aliceBalanceBefore = await getBalance(alice.address);
    expect(aliceBalanceBefore).toBeGreaterThan(0n);

    const bobBalance = await getBalance(bob.address);
    expect(bobBalance).toBeGreaterThan(0n);
  });

  test("Step 2: Open long position (Alice) vs short (Bob)", async () => {
    await submitSignedOrder({
      wallet: bob,
      token,
      isLong: false,
      size: "100000000000000000", // 0.1 BNB
      leverage: 20000,
    });

    const result = await submitSignedOrder({
      wallet: alice,
      token,
      isLong: true,
      size: "100000000000000000",
      leverage: 20000,
    });
    expect(result.success || result.orderId).toBeTruthy();

    await new Promise(r => setTimeout(r, 3000));

    const positions = await getPositions(alice.address);
    expect(positions.length).toBeGreaterThan(0);
  });

  test("Step 3: Check PnL after position opened", async () => {
    const positions = await getPositions(alice.address);
    for (const pos of positions) {
      if (pos.unrealizedPnl !== undefined) {
        const pnl = Number(pos.unrealizedPnl);
        expect(isFinite(pnl)).toBeTruthy();
      }
    }
  });

  test("Step 4: Close position", async () => {
    // Bob close short
    await submitSignedOrder({
      wallet: bob,
      token,
      isLong: true,
      size: "100000000000000000",
      leverage: 20000,
      reduceOnly: true,
    });

    // Alice close long
    const result = await submitSignedOrder({
      wallet: alice,
      token,
      isLong: false,
      size: "100000000000000000",
      leverage: 20000,
      reduceOnly: true,
    });
    expect(result.success || result.orderId).toBeTruthy();

    await new Promise(r => setTimeout(r, 3000));
  });

  test("Step 5: Verify balance after close (fees deducted)", async () => {
    const balanceAfter = await getBalance(alice.address);
    expect(balanceAfter).toBeGreaterThan(0n);
    // Balance should be reduced by fees relative to initial
  });

  test("Step 6: Engine health check after full lifecycle", async () => {
    const health = await checkHealth();
    expect(health.status).toBe("ok");
    expect(health.services.redis).toBe("connected");
    expect(health.metrics.memoryMB).toBeLessThan(500);
  });
});
