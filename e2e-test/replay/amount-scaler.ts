/**
 * Amount Scaler — Scale GMX USD amounts to BNB for our platform
 */
import { TEST_PARAMS } from "../config/test-config";

const BNB_PRICE_USD = 600; // Approximate BNB price for scaling

/**
 * Scale GMX sizeDeltaUsd (1e30 precision) to BNB margin amount
 * Applies: USD→BNB conversion, leverage adjustment, min/max clamping
 */
export function scaleToMarginBnb(
  sizeDeltaUsd: bigint,
  gmxLeverage = 10 // Typical GMX leverage
): { marginBnb: number; leverage: number; sizeBnb: number } {
  // Convert from 1e30 USD to actual USD
  const usd = Number(sizeDeltaUsd) / 1e30;

  // Convert to BNB
  const sizeBnb = usd / BNB_PRICE_USD;

  // Our max leverage is 2.5x (inner market)
  // Scale GMX leverage down: if GMX was 10x with $10k, we use 2x with proportionally less
  const ourLeverage = Math.min(
    Math.max(1, gmxLeverage > 5 ? 2 : 1.5),
    TEST_PARAMS.MAX_LEVERAGE / 10000
  );

  // Margin = size / leverage
  let marginBnb = sizeBnb / ourLeverage;

  // Clamp to reasonable range
  marginBnb = Math.max(0.01, Math.min(marginBnb, 5)); // 0.01 to 5 BNB per trade

  return {
    marginBnb: Math.round(marginBnb * 10000) / 10000, // 4 decimal places
    leverage: ourLeverage,
    sizeBnb: marginBnb * ourLeverage,
  };
}

/**
 * Scale execution price to our token's price range
 * GMX prices are in USD (1e30), our tokens have their own bonding curve prices
 */
export function scalePrice(
  gmxPriceUsd: bigint,
  tokenMarkPrice: bigint, // Our token's current mark price (1e18)
  spreadPercent = 5 // ±5% from mark
): string {
  // Instead of converting GMX price, use our mark price with slight spread
  const spread = 1 + (Math.random() * 2 - 1) * (spreadPercent / 100);
  const price = BigInt(Math.floor(Number(tokenMarkPrice) * spread));
  return price.toString();
}
