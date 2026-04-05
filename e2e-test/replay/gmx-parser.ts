/**
 * GMX Data Parser — Parse real GMX position changes into normalized format
 */
import { readFileSync } from "fs";
import { resolve } from "path";

export interface GmxTrade {
  timestamp: number;
  account: string;
  market: string;         // GMX market address
  tokenSymbol: string;    // DOGE, SHIB, PEPE, FLOKI
  type: "increase" | "decrease";
  isLong: boolean;
  sizeDeltaUsd: bigint;
  executionPrice: bigint;
}

export interface NormalizedTrade {
  timestamp: number;          // Original GMX timestamp
  replayTimestamp: number;    // Compressed timestamp for replay
  gmxAccount: string;
  testWalletIndex: number;   // Mapped test wallet index (0-99)
  tokenSymbol: string;       // DOGE, SHIB, PEPE, FLOKI
  action: "open" | "close";
  isLong: boolean;
  marginBnb: number;         // Scaled BNB amount
  leverage: number;           // 1-2.5
  priceBnb: string;           // Price for limit orders (empty for market)
  orderType: "market" | "limit";
}

const GMX_MARKET_TO_SYMBOL: Record<string, string> = {
  "0x47c031236e19d024b42f8AE6780E44A573170703": "DOGE",
  "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336": "SHIB",
  "0x970b730b5dD18de53A230eE8F4af088dBC3a6F8d": "PEPE",
  "0x7f1fa204bb700853D36994DA19F830b6Ad18455C": "FLOKI",
};

export function parseGmxData(filePath?: string): GmxTrade[] {
  const path = filePath || resolve(__dirname, "../data/gmx-trades.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));

  return raw
    .map((r: any) => ({
      timestamp: r.timestamp,
      account: r.account,
      market: r.market,
      tokenSymbol: GMX_MARKET_TO_SYMBOL[r.market] || r.token_name || "UNKNOWN",
      type: r.type as "increase" | "decrease",
      isLong: r.isLong,
      sizeDeltaUsd: BigInt(r.sizeDeltaUsd),
      executionPrice: BigInt(r.executionPrice || "0"),
    }))
    .filter((t: GmxTrade) => t.tokenSymbol !== "UNKNOWN")
    .sort((a: GmxTrade, b: GmxTrade) => a.timestamp - b.timestamp);
}

export function getTradeStats(trades: GmxTrade[]) {
  const byToken: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const accounts = new Set<string>();

  for (const t of trades) {
    byToken[t.tokenSymbol] = (byToken[t.tokenSymbol] || 0) + 1;
    byType[t.type] = (byType[t.type] || 0) + 1;
    accounts.add(t.account);
  }

  return {
    total: trades.length,
    byToken,
    byType,
    uniqueAccounts: accounts.size,
    timeRange: {
      start: trades[0]?.timestamp,
      end: trades[trades.length - 1]?.timestamp,
      durationHours: trades.length > 0
        ? (trades[trades.length - 1].timestamp - trades[0].timestamp) / 3600
        : 0,
    },
  };
}
