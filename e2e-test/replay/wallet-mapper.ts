/**
 * Wallet Mapper — Maps 542 GMX wallets to 100 test wallets
 * Uses consistent hashing so the same GMX account always maps to the same test wallet
 */
import { keccak256, toHex } from "viem";
import { TEST_PARAMS } from "../config/test-config";

const mappingCache = new Map<string, number>();

/**
 * Map a GMX account to a test wallet index (0-99)
 * Consistent: same GMX account always returns same index
 */
export function mapGmxToTestWallet(gmxAccount: string): number {
  if (mappingCache.has(gmxAccount)) {
    return mappingCache.get(gmxAccount)!;
  }

  // Consistent hash: keccak256(address) mod walletCount
  const hash = keccak256(toHex(gmxAccount.toLowerCase()));
  const index = Number(BigInt(hash) % BigInt(TEST_PARAMS.WALLET_COUNT));

  mappingCache.set(gmxAccount, index);
  return index;
}

/**
 * Get all unique GMX accounts and their mapped test wallets
 */
export function getWalletMapping(gmxAccounts: string[]): Map<string, number> {
  const mapping = new Map<string, number>();
  for (const acc of gmxAccounts) {
    mapping.set(acc, mapGmxToTestWallet(acc));
  }
  return mapping;
}

/**
 * Get per-wallet trade count distribution
 */
export function getWalletLoadDistribution(
  gmxAccounts: string[]
): { index: number; tradeCount: number }[] {
  const counts = new Map<number, number>();

  for (const acc of gmxAccounts) {
    const idx = mapGmxToTestWallet(acc);
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([index, tradeCount]) => ({ index, tradeCount }))
    .sort((a, b) => b.tradeCount - a.tradeCount);
}
