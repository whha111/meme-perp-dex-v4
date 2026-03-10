/**
 * Place SHORT DOGE orders to fill user's pending LONG 0.5 ETH market order.
 * Uses stress test wallets with available balance.
 */

import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import type { Address, Hex } from "viem";

const ME = "http://127.0.0.1:8081";
const DOGE = "0x1BC7c612e55b8CC8e24aA4041FAC3732d50C4C6F" as Address;

const DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: bscTestnet.id,
  verifyingContract: "0x1660b3571fB04f16F70aea40ac0E908607061DBE" as Address,
} as const;

const TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "token", type: "address" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "leverage", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
  ],
} as const;

// Read wallet data from file
import { readFileSync } from "fs";

const extFile = JSON.parse(readFileSync("/Users/qinlinqiu/Desktop/Namespace/scripts/market-maker/wallets.json", "utf-8"));
const extWallets = extFile.wallets as Array<{ address: string; privateKey: string; index: number }>;

// Pick wallets 150-199 (these are likely to have balance)
const candidates = extWallets.slice(150, 200);

async function getAvailableBalance(addr: string): Promise<bigint> {
  try {
    const resp = await fetch(`${ME}/api/user/${addr}/balance`);
    const data = (await resp.json()) as { availableBalance?: string };
    return BigInt(data.availableBalance ?? "0");
  } catch {
    return 0n;
  }
}

async function placeOrder(
  addr: Address,
  key: Hex,
  token: Address,
  isLong: boolean,
  size: bigint,
): Promise<{ success: boolean; matched: boolean }> {
  const account = privateKeyToAccount(key);

  // Verify address
  if (account.address.toLowerCase() !== addr.toLowerCase()) {
    console.error(`Key mismatch: expected ${addr}, got ${account.address}`);
    return { success: false, matched: false };
  }

  // Get nonce
  const nonceResp = await fetch(`${ME}/api/user/${addr}/nonce`);
  const nonceData = (await nonceResp.json()) as { nonce?: number | string };
  const nonce = BigInt(nonceData.nonce ?? 0);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const msg = {
    trader: addr,
    token,
    isLong,
    size,
    leverage: 30000n, // 3x
    price: 0n, // MARKET order
    deadline,
    nonce,
    orderType: 0, // MARKET
  };

  const sig = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "Order" as const,
    message: msg,
  });

  const resp = await fetch(`${ME}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trader: msg.trader,
      token: msg.token,
      isLong: msg.isLong,
      size: msg.size.toString(),
      leverage: msg.leverage.toString(),
      price: msg.price.toString(),
      deadline: msg.deadline.toString(),
      nonce: msg.nonce.toString(),
      orderType: msg.orderType,
      signature: sig,
    }),
  });

  const result = (await resp.json()) as { success: boolean; matches?: any[]; error?: string };
  const matched = (result.matches?.length ?? 0) > 0;

  if (result.success) {
    return { success: true, matched };
  }
  console.error(`  ❌ ${result.error?.slice(0, 80)}`);
  return { success: false, matched: false };
}

async function main() {
  console.log("=== Fill User's LONG 0.5 ETH DOGE Order ===\n");

  // Step 1: Find wallets with enough balance
  console.log("Scanning wallets for available balance...");
  const funded: Array<{ addr: Address; key: Hex; balance: bigint }> = [];

  for (const w of candidates) {
    const bal = await getAvailableBalance(w.address);
    if (bal > 5000000000000000n) {
      // > 0.005 ETH
      funded.push({
        addr: w.address as Address,
        key: w.privateKey as Hex,
        balance: bal,
      });
    }
    if (funded.length >= 10) break; // enough wallets
  }

  console.log(`Found ${funded.length} wallets with balance:`);
  let totalAvail = 0n;
  for (const f of funded) {
    console.log(`  ${f.addr.slice(0, 14)}... ${Number(f.balance) / 1e18} ETH`);
    totalAvail += f.balance;
  }
  console.log(`Total available: ${Number(totalAvail) / 1e18} ETH\n`);

  // Step 2: Place SHORT orders to fill user's LONG
  // User wants 0.5 ETH. Each wallet at 3x leverage can handle ~0.087*3 = 0.26 ETH position size
  // But to be safe, use 0.06 ETH size per wallet (needs ~0.02 ETH margin at 3x)
  const sizePerOrder = 60000000000000000n; // 0.06 ETH
  const targetFill = 500000000000000000n; // 0.5 ETH

  let totalFilled = 0n;
  let ordersPlaced = 0;
  let ordersMatched = 0;

  console.log("Placing SHORT orders on DOGE...\n");

  for (const w of funded) {
    if (totalFilled >= targetFill) break;

    const result = await placeOrder(w.addr, w.key, DOGE, false, sizePerOrder);

    if (result.success) {
      ordersPlaced++;
      totalFilled += sizePerOrder;
      const status = result.matched ? "✅ MATCHED" : "⏳ PENDING";
      console.log(`  ${w.addr.slice(0, 14)}... SHORT 0.06 ETH → ${status}`);
    }

    // Small delay between orders
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Orders placed: ${ordersPlaced}`);
  console.log(`Orders matched: ${ordersMatched}`);
  console.log(`Total short size: ${Number(totalFilled) / 1e18} ETH`);
  console.log(`(User's pending LONG: 0.5 ETH)`);

  // Check user's position after
  console.log(`\n--- User position check ---`);
  const userResp = await fetch(
    `${ME}/api/user/0xe4df9f4bbefa59d9b233961feceacdedf1ae2e5d/balance`
  );
  const userData = (await userResp.json()) as any;
  console.log(`User available: ${Number(BigInt(userData.availableBalance ?? "0")) / 1e18} ETH`);
  console.log(`User positions: ${userData.positionCount}`);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
