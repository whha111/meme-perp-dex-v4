/**
 * Seed Liquidity — Provide orderbook depth + LP pool liquidity
 *
 * 1. Market maker wallets place limit orders on both sides (orderbook depth)
 * 2. LP provider wallets add liquidity to PerpVault
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseEther, formatEther, type Address } from "viem";
import { ENV, CONTRACTS, ABI, TEST_PARAMS } from "../config/test-config";
import { getPublicClient, getWalletClient, waitForTx } from "../utils/rpc-client";
import { log } from "../utils/logger";

interface WalletEntry {
  index: number;
  address: string;
  privateKey: string;
  role: string;
}

async function main() {
  log.infra.info("═══ Seeding Liquidity ═══");

  const wallets: WalletEntry[] = JSON.parse(
    readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8")
  );
  const tokens = JSON.parse(
    readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8")
  );

  const mmWallets = wallets.filter((w) => w.role === "market-maker");
  const lpWallets = wallets.filter((w) => w.role === "lp-provider");
  const client = getPublicClient();

  // ─── 1. LP Providers → PerpVault ───
  log.infra.info({ count: lpWallets.length }, "Adding LP liquidity to PerpVault");

  for (const lp of lpWallets) {
    try {
      const wallet = getWalletClient(lp.privateKey as `0x${string}`);
      const balance = await client.getBalance({ address: lp.address as Address });
      const lpAmount = Number(formatEther(balance)) * 0.8; // Use 80% of balance

      if (lpAmount < 0.5) {
        log.infra.warn({ address: lp.address, balance: formatEther(balance) }, "LP wallet low balance");
        continue;
      }

      const hash = await wallet.writeContract({
        address: CONTRACTS.PerpVault,
        abi: ABI.PerpVault,
        functionName: "addLiquidity",
        value: parseEther(lpAmount.toFixed(4)),
      });
      await waitForTx(hash);
      log.infra.info({ address: lp.address.slice(0, 10), amount: lpAmount.toFixed(4) }, "LP added");
    } catch (err: any) {
      log.infra.error({ address: lp.address.slice(0, 10), error: err.message }, "LP add failed");
    }
  }

  // Check PerpVault value
  try {
    const poolValue = await client.readContract({
      address: CONTRACTS.PerpVault,
      abi: ABI.PerpVault,
      functionName: "getPoolValue",
    });
    log.infra.info({ poolValue: formatEther(poolValue as bigint) + " BNB" }, "PerpVault total");
  } catch {}

  // ─── 2. Market Makers → OrderBook depth ───
  log.infra.info({ count: mmWallets.length }, "Seeding orderbook with market maker orders");

  for (const mm of mmWallets) {
    try {
      // First deposit to engine
      const resp = await fetch(`${ENV.ENGINE_URL}/api/user/${mm.address}/deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: parseEther("0.5").toString(),
        }),
      });
      const data = await resp.json() as any;
      if (data.success) {
        log.infra.info({ mm: mm.address.slice(0, 10) }, "MM deposited to engine");
      }

      // Place spread orders on each token
      for (const [symbol, tokenInfo] of Object.entries(tokens)) {
        const info = tokenInfo as any;
        // Get current mark price
        try {
          const obResp = await fetch(`${ENV.ENGINE_URL}/api/orderbook/${info.address}`);
          const ob = await obResp.json() as any;
          const midPrice = ob.longs?.[0]?.price || ob.shorts?.[0]?.price;
          if (!midPrice) continue;

          const mid = BigInt(midPrice);

          // Place 5 levels on each side
          for (let level = 1; level <= 5; level++) {
            const bidPrice = (mid * BigInt(100 - level)) / 100n;
            const askPrice = (mid * BigInt(100 + level)) / 100n;
            const size = parseEther("0.05").toString();

            // Place buy limit
            await fetch(`${ENV.ENGINE_URL}/api/order/submit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                trader: mm.address,
                token: info.address,
                isLong: true,
                orderType: "limit",
                size,
                leverage: 20000,
                price: bidPrice.toString(),
                deadline: Math.floor(Date.now() / 1000) + 86400,
                nonce: level * 2 - 1,
                signature: "0x" + "0".repeat(130),
              }),
            });

            // Place sell limit
            await fetch(`${ENV.ENGINE_URL}/api/order/submit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                trader: mm.address,
                token: info.address,
                isLong: false,
                orderType: "limit",
                size,
                leverage: 20000,
                price: askPrice.toString(),
                deadline: Math.floor(Date.now() / 1000) + 86400,
                nonce: level * 2,
                signature: "0x" + "0".repeat(130),
              }),
            });
          }

          log.infra.info({ mm: mm.address.slice(0, 10), token: symbol }, "Spread orders placed");
        } catch {}
      }
    } catch (err: any) {
      log.infra.error({ mm: mm.address.slice(0, 10), error: err.message }, "MM setup failed");
    }
  }

  console.log("\n✅ Liquidity seeding complete");
}

main().catch(console.error);
