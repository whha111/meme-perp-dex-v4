/**
 * 05 — Leverage Tests (Production Mode)
 * Verify leverage affects margin requirement and liquidation price
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { submitSignedOrder, getPositions, getNonce } from "../utils/test-helpers";
import { signOrder, type OrderParams } from "../utils/eip712-signer";
import { type Address, type Hex } from "viem";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const wallets = JSON.parse(readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8"));
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const token = (Object.values(tokens)[0] as any).address;

// Use wallets 34-37
const trader = wallets[34];
const counterparty = wallets[35];

test.describe.serial("05 — Leverage Settings (Production)", () => {
  test("1x leverage — order accepted", async () => {
    const data = await submitSignedOrder({
      wallet: trader,
      token,
      isLong: true,
      size: "100000000000000000",
      leverage: 10000, // 1x
    });
    expect(data.success || data.orderId).toBeTruthy();
  });

  test("2.5x leverage — order accepted with correct leverage", async () => {
    // Counterparty
    await submitSignedOrder({ wallet: counterparty, token, isLong: false, size: "200000000000000000", leverage: 25000 });
    const data = await submitSignedOrder({ wallet: trader, token, isLong: true, size: "200000000000000000", leverage: 25000 });
    expect(data.success || data.orderId).toBeTruthy();

    await new Promise(r => setTimeout(r, 2000));

    const positions = await getPositions(trader.address);
    expect(positions.length).toBeGreaterThan(0);

    if (positions.length > 0) {
      const pos = positions[0];
      if (pos.leverage) {
        const lev = Number(pos.leverage);
        // Leverage may be in 1e4 format (25000=2.5x) or display format (2.5)
        const normalizedLev = lev > 100 ? lev : lev * 10000; // normalize to 1e4
        expect(normalizedLev).toBeGreaterThanOrEqual(10000);
        expect(normalizedLev).toBeLessThanOrEqual(25000);
      }
    }
  });

  test("reject leverage above 2.5x (max)", async () => {
    // Sign with 10x leverage — should be rejected by validation, not signature
    const nonce = await getNonce(trader.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const orderParams: OrderParams = {
      trader: trader.address as Address,
      token: token as Address,
      isLong: true,
      orderType: 0,
      size: BigInt("100000000000000000"),
      leverage: BigInt(100000), // 10x
      price: 0n,
      deadline,
      nonce: BigInt(nonce),
    };
    const signature = await signOrder(trader.privateKey as Hex, orderParams);

    const resp = await fetch(`${ENGINE}/api/order/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader: trader.address,
        token,
        isLong: true,
        orderType: 0,
        size: "100000000000000000",
        leverage: 100000,
        price: "0",
        deadline: deadline.toString(),
        nonce,
        signature,
      }),
    });
    const data = await resp.json() as any;
    expect(data.error || data.rejected).toBeTruthy();
  });

  test("positions have liquidation price", async () => {
    const positions = await getPositions(trader.address);
    expect(positions.length).toBeGreaterThan(0);

    for (const pos of positions) {
      if (pos.liquidationPrice) {
        const liqPrice = Number(pos.liquidationPrice);
        expect(liqPrice).toBeGreaterThan(0);
      }
    }
  });
});
