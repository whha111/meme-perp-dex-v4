import { parseUnits, type Address } from "viem";
import type { MemePerpMarket } from "./marketRegistry";

export function normalizeV3Path(path: string): string {
  if (path === "/api/v3") return "/v3";
  if (path.startsWith("/api/v3/")) return path.replace(/^\/api\/v3/, "/v3");
  return path;
}

export function buildV3MarketAliasMap(markets: MemePerpMarket[]): Map<string, MemePerpMarket> {
  const aliases = new Map<string, MemePerpMarket>();

  for (const market of markets) {
    const base = market.baseAsset.toUpperCase();
    const symbol = market.displaySymbol.toUpperCase();
    const canonical = market.marketId.toUpperCase();
    const marketAliases = [
      canonical,
      canonical.replace("-USDT-PERP", "-USDT"),
      base,
      symbol,
      `${base}-BNB`,
      `${base}/BNB`,
      `${symbol}-BNB`,
      `${symbol}/BNB`,
      `${base}-USDT`,
      `${base}/USDT`,
      `${symbol}-USDT`,
      `${symbol}/USDT`,
      market.indexToken.toLowerCase(),
    ];

    for (const alias of marketAliases) {
      aliases.set(alias.toUpperCase(), market);
    }
  }

  return aliases;
}

export function resolveV3Market(
  marketOrAlias: string | null | undefined,
  markets: MemePerpMarket[],
): { market?: MemePerpMarket; error?: string } {
  const raw = String(marketOrAlias || "").trim();
  if (!raw) return { error: "Missing market" };

  const aliases = buildV3MarketAliasMap(markets);
  const normalized = raw.startsWith("0x") ? raw.toLowerCase().toUpperCase() : raw.toUpperCase();
  const market = aliases.get(normalized);
  if (!market) return { error: `Unsupported market: ${raw}` };
  return { market };
}

export function parseV3AmountToWei(value: unknown, field: string): bigint {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`Missing ${field}`);
  if (raw.startsWith("-")) throw new Error(`${field} must be positive`);
  if (raw.toLowerCase().includes("e")) throw new Error(`${field} must be a decimal string, not scientific notation`);
  if (raw.includes(".")) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`${field} must be a valid number`);
    return parseUnits(raw, 18);
  }
  return BigInt(raw);
}

export function parseV3Leverage(value: unknown, fallback = 1n): bigint {
  if (value === undefined || value === null || value === "") return fallback * 10000n;
  const raw = String(value).trim();
  if (raw.toLowerCase().includes("e")) throw new Error("leverage must be a decimal string, not scientific notation");
  if (raw.includes(".")) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("leverage must be positive");
    return BigInt(Math.round(parsed * 10000));
  }
  const integer = BigInt(raw);
  if (integer <= 0n) throw new Error("leverage must be positive");
  return integer <= 1000n ? integer * 10000n : integer;
}

export function canonicalV3Market(market: MemePerpMarket): string {
  return market.marketId.toUpperCase();
}

export function v3CollateralToken(value: unknown): "BNB" | "WBNB" | "USDT" {
  const normalized = String(value || "BNB").toUpperCase();
  if (normalized === "BNB" || normalized === "WBNB" || normalized === "USDT") return normalized;
  throw new Error(`Unsupported collateralToken: ${String(value)}`);
}
