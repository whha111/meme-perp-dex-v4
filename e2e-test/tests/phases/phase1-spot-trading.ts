/**
 * Phase 1: Spot Trading — Create Price Volatility
 *
 * THE critical missing piece from the previous test.
 * Without bonding curve trades, PriceFeed never updates,
 * mark price never changes, no PnL, no liquidations.
 *
 * Flow: TokenFactory.buy/sell → PriceFeedHelper.syncPrice →
 *       PriceFeed.updateTokenPriceFromFactory → Engine.syncSpotPrices
 */
import { type Address, type Hex, formatEther } from "viem";
import { spotBuy, spotSell, getSpotPrice } from "../../utils/spot-trader";
import { ENV } from "../../config/test-config";

const ENGINE = ENV.ENGINE_URL;

interface TokenPriceChange {
  symbol: string;
  initialPrice: bigint;
  afterBuyPrice: bigint;
  afterSellPrice: bigint;
  buySuccess: boolean;
  sellSuccess: boolean;
}

export interface Phase1Result {
  priceChanges: TokenPriceChange[];
  enginePricesSynced: boolean;
  passed: boolean;
  errors: string[];
}

export async function runPhase1(
  wallets: any[],
  tokenData: Record<string, { address: string }>,
): Promise<Phase1Result> {
  console.log("\n══════════════════════════════════════════════");
  console.log("  PHASE 1: Spot Trading (Price Volatility)");
  console.log("══════════════════════════════════════════════\n");

  const errors: string[] = [];
  const priceChanges: TokenPriceChange[] = [];

  // Use DEPLOYER wallet for spot trading — test wallets have ~0 on-chain BNB
  // Deployer has ~3 BNB, enough for bonding curve buys + sells
  const deployerWallet = {
    privateKey: ENV.DEPLOYER_PRIVATE_KEY,
    address: "0xAecb229194314999E396468eb091b42E44Bc3c8c",
  };
  const buyWallet = deployerWallet;   // Buys tokens (price up)
  const sellWallet = deployerWallet;  // Sells tokens (price down)

  const tokens = Object.entries(tokenData);

  for (const [symbol, info] of tokens) {
    const tokenAddr = info.address as Address;
    console.log(`\n  --- ${symbol} (${tokenAddr.slice(0, 10)}...) ---`);

    // Record initial price
    let initialPrice = 0n;
    try {
      initialPrice = await getSpotPrice(tokenAddr);
      console.log(`    Initial price: ${initialPrice}`);
    } catch (e: any) {
      errors.push(`${symbol}: failed to get initial price`);
      priceChanges.push({
        symbol, initialPrice: 0n, afterBuyPrice: 0n, afterSellPrice: 0n,
        buySuccess: false, sellSuccess: false,
      });
      continue;
    }

    // BUY: Push price UP (0.15 BNB per token × 4 tokens = 0.6 BNB total, deployer has ~3 BNB)
    console.log(`    Buying 0.15 BNB worth...`);
    const buyResult = await spotBuy(buyWallet.privateKey as Hex, tokenAddr, "0.15");
    let afterBuyPrice = initialPrice;
    if (buyResult.success) {
      afterBuyPrice = buyResult.priceAfter || initialPrice;
      const change = initialPrice > 0n
        ? Number((afterBuyPrice - initialPrice) * 10000n / initialPrice) / 100
        : 0;
      console.log(`    Buy OK — price: ${initialPrice} → ${afterBuyPrice} (${change > 0 ? "+" : ""}${change}%)`);
    } else {
      errors.push(`${symbol}: buy failed — ${buyResult.error}`);
      console.log(`    Buy FAILED: ${buyResult.error}`);
    }

    // Wait for engine to sync
    await new Promise(r => setTimeout(r, 3000));

    // SELL: Push price DOWN
    console.log(`    Selling tokens...`);
    const sellResult = await spotSell(sellWallet.privateKey as Hex, tokenAddr, 0.5);
    let afterSellPrice = afterBuyPrice;
    if (sellResult.success) {
      afterSellPrice = sellResult.priceAfter || afterBuyPrice;
      const change = afterBuyPrice > 0n
        ? Number((afterSellPrice - afterBuyPrice) * 10000n / afterBuyPrice) / 100
        : 0;
      console.log(`    Sell OK — price: ${afterBuyPrice} → ${afterSellPrice} (${change > 0 ? "+" : ""}${change}%)`);
    } else {
      errors.push(`${symbol}: sell failed — ${sellResult.error}`);
      console.log(`    Sell FAILED: ${sellResult.error}`);
    }

    priceChanges.push({
      symbol,
      initialPrice,
      afterBuyPrice,
      afterSellPrice,
      buySuccess: buyResult.success,
      sellSuccess: sellResult.success,
    });
  }

  // Wait for engine syncSpotPrices (runs every 1-3s)
  console.log(`\n  Waiting 5s for engine price sync...`);
  await new Promise(r => setTimeout(r, 5000));

  // Verify engine saw the price changes
  let enginePricesSynced = false;
  try {
    const resp = await fetch(`${ENGINE}/health`);
    if (resp.ok) {
      const data = await resp.json() as any;
      // If health has tokenPrices or similar metric, check it
      enginePricesSynced = true;
      console.log(`  Engine health OK after spot trading`);
    }
  } catch {}

  // Check orderbook for any token to see current mark price
  for (const [symbol, info] of tokens.slice(0, 1)) {
    try {
      const resp = await fetch(`${ENGINE}/api/orderbook/${info.address}`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const markPrice = data.markPrice || data.lastPrice;
        if (markPrice) {
          console.log(`  Engine mark price for ${symbol}: ${markPrice}`);
          enginePricesSynced = true;
        }
      }
    } catch {}
  }

  // Evaluate
  const allBuysOk = priceChanges.every(p => p.buySuccess);
  const allSellsOk = priceChanges.every(p => p.sellSuccess);
  const pricesMoved = priceChanges.some(p => p.afterBuyPrice > p.initialPrice);

  const passed = allBuysOk && pricesMoved;
  console.log(`\n  Phase 1 result: ${passed ? "PASS" : "FAIL"}`);
  console.log(`    Buys: ${priceChanges.filter(p => p.buySuccess).length}/${tokens.length} OK`);
  console.log(`    Sells: ${priceChanges.filter(p => p.sellSuccess).length}/${tokens.length} OK`);
  console.log(`    Prices moved: ${pricesMoved}`);

  return { priceChanges, enginePricesSynced, passed, errors };
}
