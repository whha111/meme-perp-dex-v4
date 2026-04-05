/**
 * Teardown — Clean up after tests
 * Close positions, cancel orders, save final state
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { ENV } from "../config/test-config";
import { log } from "../utils/logger";

interface TeardownSummary {
  positionsClosed: number;
  ordersCancelled: number;
  errors: string[];
}

async function main() {
  log.infra.info("═══ Teardown: Cleaning up test state ═══");

  const summary: TeardownSummary = {
    positionsClosed: 0,
    ordersCancelled: 0,
    errors: [],
  };

  const walletsPath = resolve(__dirname, "../data/wallets.json");
  if (!existsSync(walletsPath)) {
    log.infra.warn("No wallets.json found — nothing to teardown");
    return;
  }

  const wallets = JSON.parse(readFileSync(walletsPath, "utf8"));

  for (const wallet of wallets) {
    try {
      // Cancel all pending orders
      const ordersResp = await fetch(`${ENV.ENGINE_URL}/api/user/${wallet.address}/orders`);
      if (ordersResp.ok) {
        const ordersData = await ordersResp.json() as any;
        const orders = ordersData.orders || ordersData || [];
        for (const order of orders) {
          try {
            await fetch(`${ENV.ENGINE_URL}/api/order/cancel`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                trader: wallet.address,
                orderId: order.id || order.orderId,
                signature: "0x" + "0".repeat(130),
              }),
            });
            summary.ordersCancelled++;
          } catch {}
        }
      }

      // Close all positions
      const posResp = await fetch(`${ENV.ENGINE_URL}/api/user/${wallet.address}/positions`);
      if (posResp.ok) {
        const posData = await posResp.json() as any;
        const positions = posData.positions || posData || [];
        for (const pos of positions) {
          try {
            await fetch(`${ENV.ENGINE_URL}/api/order/submit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                trader: wallet.address,
                token: pos.token || pos.tokenAddress,
                isLong: !pos.isLong, // opposite side to close
                orderType: "market",
                size: pos.size || pos.sizeInTokens,
                leverage: pos.leverage || 20000,
                price: "0",
                reduceOnly: true,
                deadline: Math.floor(Date.now() / 1000) + 3600,
                nonce: Date.now(),
                signature: "0x" + "0".repeat(130),
              }),
            });
            summary.positionsClosed++;
          } catch (err: any) {
            summary.errors.push(`Close position failed: ${wallet.address.slice(0, 10)} - ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      summary.errors.push(`${wallet.address.slice(0, 10)}: ${err.message}`);
    }
  }

  // Save summary
  const summaryPath = resolve(__dirname, "../reports/teardown-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  log.infra.info({
    positionsClosed: summary.positionsClosed,
    ordersCancelled: summary.ordersCancelled,
    errors: summary.errors.length,
  }, "Teardown complete");

  console.log(`\n✅ Teardown: ${summary.positionsClosed} positions closed, ${summary.ordersCancelled} orders cancelled`);
}

main().catch(console.error);
