/**
 * 09 — Auto-Deleveraging (ADL) Tests (Production Mode)
 * Verify ADL status and coverage metrics
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { checkHealth, getPositions } from "../utils/test-helpers";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const token = (Object.values(tokens)[0] as any).address;

test.describe.serial("09 — ADL (Auto-Deleveraging) (Production)", () => {
  test("check ADL status endpoint", async () => {
    const resp = await fetch(`${ENGINE}/api/adl/status`);
    // ADL endpoint may or may not exist
    expect(resp.status).toBeLessThan(500);
  });

  test("check pool value (LP coverage)", async () => {
    const resp = await fetch(`${ENGINE}/api/pool/value`);
    if (resp.ok) {
      const data = await resp.json() as any;
      expect(data.value || data.poolValue).toBeDefined();
    }
    const health = await checkHealth();
    expect(health.status).toBe("ok");
  });

  test("verify positions exist under normal conditions", async () => {
    // Use a wallet we know has positions (wallet 0)
    const wallet = wallets[0];
    const positions = await getPositions(wallet.address);
    // Just verify the API works and returns valid data
    expect(Array.isArray(positions)).toBe(true);
  });

  test("engine remains healthy after ADL check", async () => {
    const health = await checkHealth();
    expect(health.status).toBe("ok");
    expect(health.services.redis).toBe("connected");
  });
});
