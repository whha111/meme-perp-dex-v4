/**
 * DOGE/PEPE/SHIB Market Maker — Tight bid/ask liquidity for perpetual trading.
 *
 * Uses 4 stress-test wallets to place resting limit orders at 0.5%-3% spread.
 * Refreshes every 10 seconds.
 *
 * Usage:  bun run stress-test/scripts/doge-market-maker.ts
 */

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { Address, Hex } from "viem";

// ── Config ─────────────────────────────────────────────────────

const ME = "http://127.0.0.1:8081";

const TOKENS: { addr: Address; name: string }[] = [
  { addr: "0x1BC7c612e55b8CC8e24aA4041FAC3732d50C4C6F", name: "DOGE" },
  { addr: "0x0d0156063c5f805805d5324af69932FB790819D5", name: "PEPE" },
  { addr: "0x0724863BD88e1F4919c85294149ae87209E917Da", name: "SHIB" },
];

const DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: baseSepolia.id,
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

// Wallets with enough margin in matching engine (~0.04-0.06 ETH available)
const WALLETS = [
  { addr: "0x1d17fdbb1fda1e988a35ad815b618d35bf553122" as Address, key: "0x03c2f0b3c6b7f7fab4fe3be57050f5365a73bd3f72798cd1e55c6100fb49ca9b" as Hex },
  { addr: "0x013e5e89015fcab6043a64a6cb219cdd3b59a1f3" as Address, key: "0xfba84589214ffe5572bfb4840e14792825a9454d24006f2e0751a0643af0ed36" as Hex },
];

const SPREADS = [0.005, 0.01, 0.02, 0.03]; // 0.5%, 1%, 2%, 3%
const SIZES = [3000000000000000n, 4000000000000000n, 5000000000000000n, 3000000000000000n]; // 0.003-0.005 ETH
const LEV = 30000n; // 3x

// ── State ──────────────────────────────────────────────────────

const nonces: Map<string, bigint> = new Map();
const accounts: Map<string, PrivateKeyAccount> = new Map();
let placed = 0, matched = 0, fails = 0;

// Pre-create accounts
for (const w of WALLETS) {
  accounts.set(w.addr.toLowerCase(), privateKeyToAccount(w.key));
}

// ── Functions ──────────────────────────────────────────────────

async function fetchJson(url: string): Promise<any> {
  const r = await fetch(url);
  return r.json();
}

async function syncAllNonces(): Promise<void> {
  for (const w of WALLETS) {
    try {
      const d = await fetchJson(`${ME}/api/user/${w.addr}/nonce`);
      nonces.set(w.addr.toLowerCase(), BigInt(d.nonce ?? 0));
    } catch {}
  }
}

async function getMarkPrice(token: Address): Promise<bigint> {
  try {
    const d = await fetchJson(`${ME}/api/v1/market/trades?instId=${token}-PERP&limit=1`);
    return BigInt(d.data?.[0]?.px ?? "0");
  } catch {
    return 0n;
  }
}

async function submitOrder(
  wAddr: Address,
  token: Address,
  isLong: boolean,
  size: bigint,
  price: bigint,
): Promise<boolean> {
  const account = accounts.get(wAddr.toLowerCase())!;
  const nonce = nonces.get(wAddr.toLowerCase()) ?? 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const msg = { trader: wAddr, token, isLong, size, leverage: LEV, price, deadline, nonce, orderType: 1 };

  let sig: string;
  try {
    sig = await account.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Order" as const, message: msg });
  } catch (e: any) {
    console.error(`[MM] Sign error: ${e.message?.slice(0, 60)}`);
    return false;
  }

  try {
    const resp = await fetch(`${ME}/api/order/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...msg,
        size: msg.size.toString(),
        leverage: msg.leverage.toString(),
        price: msg.price.toString(),
        deadline: msg.deadline.toString(),
        nonce: msg.nonce.toString(),
        signature: sig,
      }),
    });

    const result = (await resp.json()) as { success: boolean; matches?: any[]; error?: string };

    if (result.success) {
      nonces.set(wAddr.toLowerCase(), nonce + 1n);
      placed++;
      if ((result.matches?.length ?? 0) > 0) matched++;
      return true;
    }

    fails++;
    if (result.error?.includes("nonce")) {
      // Re-sync this wallet's nonce
      try {
        const d = await fetchJson(`${ME}/api/user/${wAddr}/nonce`);
        nonces.set(wAddr.toLowerCase(), BigInt(d.nonce ?? 0));
      } catch {}
    }
    if (fails <= 15) console.error(`[MM] Reject: ${result.error?.slice(0, 80)}`);
    return false;
  } catch (e: any) {
    fails++;
    if (fails <= 5) console.error(`[MM] Fetch error: ${e.message?.slice(0, 60)}`);
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("=== Market Maker Started ===");
  console.log(`Tokens: ${TOKENS.map(t => t.name).join(", ")} | Wallets: ${WALLETS.length} | Spreads: ${SPREADS.map(s => s*100 + "%").join(",")}`);

  // Initial nonce sync
  await syncAllNonces();
  for (const w of WALLETS) {
    const n = nonces.get(w.addr.toLowerCase()) ?? 0n;
    console.log(`  ${w.addr.slice(0, 10)}: nonce=${n}`);
  }

  // Initial prices
  for (const t of TOKENS) {
    const p = await getMarkPrice(t.addr);
    console.log(`  ${t.name}: ${Number(p) / 1e18} ETH`);
  }

  console.log("\nLoop starting...\n");

  let round = 0;
  while (true) {
    round++;
    const t0 = Date.now();
    console.log(`[R${round}] BEGIN`);

    // Sync nonces every 5 rounds
    if (round % 5 === 1) {
      console.log(`[R${round}] syncing nonces...`);
      await syncAllNonces();
      console.log(`[R${round}] nonces synced`);
    }

    for (const token of TOKENS) {
      const mark = await getMarkPrice(token.addr);
      if (mark === 0n) continue;

      for (let i = 0; i < SPREADS.length; i++) {
        const w = WALLETS[i % WALLETS.length];
        const spread = SPREADS[i];
        const size = SIZES[i];

        const bidPx = (mark * BigInt(Math.floor((1 - spread) * 10000))) / 10000n;
        const askPx = (mark * BigInt(Math.floor((1 + spread) * 10000))) / 10000n;

        await submitOrder(w.addr, token.addr, true, size, bidPx);
        await submitOrder(w.addr, token.addr, false, size, askPx);
      }
    }

    const elapsed = Date.now() - t0;
    console.log(`[R${round}] DONE +${placed} orders, ${matched} matched, ${fails} fail (${elapsed}ms)\n`);

    // Wait 10 seconds between rounds
    await new Promise(r => setTimeout(r, 10000));
  }
}

main().catch(e => {
  console.error("FATAL:", e.message, e.stack);
  process.exit(1);
});
