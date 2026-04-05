/**
 * Test 02: Market Order Trading (Production Mode)
 * Verifies: place market order with real EIP-712 signature → match → position created
 * NO fake deposits, NO skipped signatures
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { type Address, type Hex } from "viem";
import { signOrder, type OrderParams } from "../utils/eip712-signer";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const traderA = wallets[10]; // Use wallets that have on-chain deposits
const traderB = wallets[11];
const testToken = (Object.values(tokens)[0] as any).address;

async function getNonce(trader: string): Promise<number> {
  const resp = await fetch(`${ENGINE}/api/user/${trader}/nonce`);
  const data = await resp.json() as any;
  return parseInt(data.nonce || "0", 10);
}

async function submitSignedOrder(
  wallet: { address: string; privateKey: string },
  token: string,
  isLong: boolean,
  size: string,
  leverage: number,
): Promise<any> {
  const nonce = await getNonce(wallet.address);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const orderParams: OrderParams = {
    trader: wallet.address as Address,
    token: token as Address,
    isLong,
    orderType: 0, // MARKET
    size: BigInt(size),
    leverage: BigInt(leverage),
    price: 0n,
    deadline,
    nonce: BigInt(nonce),
  };

  const signature = await signOrder(wallet.privateKey as Hex, orderParams);

  const resp = await fetch(`${ENGINE}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trader: wallet.address,
      token,
      isLong,
      orderType: 0,
      size,
      leverage,
      price: "0",
      deadline: deadline.toString(),
      nonce,
      signature,
    }),
  });
  return resp.json();
}

test.describe.serial("02 — Market Order Trading (Production)", () => {
  test("should accept long market order with valid EIP-712 signature", async () => {
    const data = await submitSignedOrder(traderA, testToken, true, "100000000000000000", 20000);
    expect(data.success).toBe(true);
    expect(data.orderId).toBeTruthy();
  });

  test("should accept short market order (counterparty)", async () => {
    const data = await submitSignedOrder(traderB, testToken, false, "100000000000000000", 20000);
    expect(data.success).toBe(true);
  });

  test("should create position after match", async () => {
    await new Promise(r => setTimeout(r, 2000));
    const resp = await fetch(`${ENGINE}/api/user/${traderA.address}/positions`);
    const data = await resp.json() as any;
    const positions = data.positions || data || [];
    expect(positions.length).toBeGreaterThan(0);
  });

  test("position should have correct token", async () => {
    const resp = await fetch(`${ENGINE}/api/user/${traderA.address}/positions`);
    const data = await resp.json() as any;
    const positions = data.positions || data || [];
    expect(positions.length).toBeGreaterThan(0);
    // Check that at least one position has the correct token
    const hasCorrectToken = positions.some((pos: any) => {
      const posToken = (pos.token || pos.tokenAddress || "").toLowerCase();
      return posToken === testToken.toLowerCase();
    });
    expect(hasCorrectToken).toBe(true);
  });

  test("should reject order with invalid signature", async () => {
    const nonce = await getNonce(traderA.address);
    const resp = await fetch(`${ENGINE}/api/order/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader: traderA.address,
        token: testToken,
        isLong: true,
        orderType: 0,
        size: "100000000000000000",
        leverage: 20000,
        price: "0",
        deadline: Math.floor(Date.now() / 1000) + 3600,
        nonce,
        signature: "0x" + "0".repeat(130), // Invalid dummy signature
      }),
    });
    const data = await resp.json() as any;
    // Should reject with invalid signature in production mode
    expect(data.error || data.success === false).toBeTruthy();
  });
});
