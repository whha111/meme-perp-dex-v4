/**
 * Custom Test Assertions
 * Reusable validation helpers for E2E tests
 */
import { expect } from "@playwright/test";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";

/**
 * Assert balance is within tolerance of expected value
 */
export function assertBalanceInRange(actual: number, expected: number, tolerancePct = 10): void {
  const tolerance = expected * tolerancePct / 100;
  expect(actual).toBeGreaterThanOrEqual(expected - tolerance);
  expect(actual).toBeLessThanOrEqual(expected + tolerance);
}

/**
 * Assert a position exists for a trader on a token
 */
export async function assertPositionExists(trader: string, token: string): Promise<any> {
  const resp = await fetch(`${ENGINE}/api/user/${trader}/positions`);
  expect(resp.ok).toBeTruthy();
  const data = await resp.json() as any;
  const positions = data.positions || data || [];
  const match = positions.find((p: any) =>
    (p.token || p.tokenAddress || "").toLowerCase() === token.toLowerCase()
  );
  expect(match).toBeDefined();
  return match;
}

/**
 * Assert no position exists (after close)
 */
export async function assertNoPosition(trader: string, token: string): Promise<void> {
  const resp = await fetch(`${ENGINE}/api/user/${trader}/positions`);
  expect(resp.ok).toBeTruthy();
  const data = await resp.json() as any;
  const positions = data.positions || data || [];
  const match = positions.find((p: any) =>
    (p.token || p.tokenAddress || "").toLowerCase() === token.toLowerCase()
  );
  expect(match).toBeUndefined();
}

/**
 * Assert engine is healthy
 */
export async function assertEngineHealthy(): Promise<any> {
  const resp = await fetch(`${ENGINE}/health`);
  expect(resp.ok).toBeTruthy();
  const health = await resp.json() as any;
  expect(health.status).toBe("ok");
  expect(health.services.redis).toBe("connected");
  expect(health.metrics.memoryMB).toBeLessThan(500);
  return health;
}

/**
 * Assert no negative balances in a list of wallet addresses
 */
export async function assertNoNegativeBalances(wallets: string[]): Promise<void> {
  for (const wallet of wallets) {
    const resp = await fetch(`${ENGINE}/api/user/${wallet}/balance`);
    if (resp.ok) {
      const data = await resp.json() as any;
      const balance = Number(data.availableBalance || data.totalBalance || 0);
      expect(balance).toBeGreaterThanOrEqual(0);
    }
  }
}

/**
 * Assert an order was accepted (returns orderId)
 */
export async function assertOrderAccepted(result: any): Promise<string> {
  expect(result.success || result.orderId || result.id).toBeTruthy();
  return result.orderId || result.id || "unknown";
}

/**
 * Wait for a condition to be true (polling)
 */
export async function waitUntil(
  condition: () => Promise<boolean>,
  timeout = 30000,
  interval = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`waitUntil timeout after ${timeout}ms`);
}
