"use client";

import { useMemo } from "react";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";

export interface TokenInfo {
  name: string | null;
  symbol: string | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Hook to get token name and symbol from WSS (via tradingDataStore).
 *
 * Architecture: matching engine 启动时用 multicall 一次性读取所有代币的 name/symbol，
 * 前端通过 WSS `get_all_token_info` 消息获取，存入 tradingDataStore.tokenInfoMap。
 * 零 HTTP 调用，零 RPC 调用。
 *
 * @param addressOrSymbol - Token contract address (0x...) or symbol
 * @returns Token info with name and symbol
 */
export function useTokenInfo(addressOrSymbol: string): TokenInfo {
  const isAddress = addressOrSymbol?.startsWith("0x") && addressOrSymbol.length === 42;
  const normalizedAddress = isAddress ? addressOrSymbol.toLowerCase() : undefined;

  const tokenInfoMap = useTradingDataStore((s) => s.tokenInfoMap);
  const wsConnected = useTradingDataStore((s) => s.wsConnected);

  return useMemo(() => {
    if (!normalizedAddress) {
      return { name: null, symbol: null, isLoading: false, error: null };
    }

    // WSS not connected yet — still loading
    if (!wsConnected && Object.keys(tokenInfoMap).length === 0) {
      return { name: null, symbol: null, isLoading: true, error: null };
    }

    const info = tokenInfoMap[normalizedAddress];
    return {
      name: info?.name ?? null,
      symbol: info?.symbol ?? null,
      isLoading: false,
      error: null,
    };
  }, [normalizedAddress, tokenInfoMap, wsConnected]);
}

/**
 * Get display name for a token
 * Returns symbol if available, otherwise truncated address, otherwise the original input
 */
export function getTokenDisplayName(
  addressOrSymbol: string,
  tokenInfo?: TokenInfo
): string {
  // If we have token info with symbol, use it
  if (tokenInfo?.symbol) {
    return tokenInfo.symbol.toUpperCase();
  }

  // If it's not an address, return as-is (it's already a symbol)
  if (!addressOrSymbol?.startsWith("0x")) {
    return addressOrSymbol?.toUpperCase() || "";
  }

  // If still loading, show loading indicator
  if (tokenInfo?.isLoading) {
    return "...";
  }

  // Truncate address for display
  if (addressOrSymbol.length >= 10) {
    return `${addressOrSymbol.slice(0, 6)}...${addressOrSymbol.slice(-4)}`;
  }

  return addressOrSymbol;
}
