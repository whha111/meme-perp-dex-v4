"use client";

import { useState, useEffect, useCallback } from "react";
import { formatUnits, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import TokenFactoryABIImport from "@/abis/TokenFactory.json";
const TokenFactoryABI = TokenFactoryABIImport.abi;

const TOKEN_FACTORY_ADDRESS = process.env.NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS as `0x${string}`;
const baseSepoliaRpcUrl = process.env.NEXT_PUBLIC_BASE_TESTNET_RPC_URL || "https://base-sepolia-rpc.publicnode.com";

// Create dedicated public client for Base Sepolia
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(baseSepoliaRpcUrl),
});

// ERC20 ABI for name() and symbol()
const ERC20_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface OnChainToken {
  address: `0x${string}`;
  name: string;
  symbol: string;
  creator: `0x${string}`;
  createdAt: number;
  isGraduated: boolean;
  isActive: boolean;
  price: string;
  marketCap: string;
  soldSupply: string;
  metadataURI: string;
  perpEnabled: boolean;
  realETHReserve: string; // ETH reserve for tracking trading activity
}

/**
 * Hook to fetch all tokens directly from TokenFactory contract
 * Uses dedicated Base Sepolia client (no wallet connection required)
 */
export function useOnChainTokenList() {
  const [tokens, setTokens] = useState<OnChainToken[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [tokenCount, setTokenCount] = useState(0);

  const fetchTokens = useCallback(async () => {
    if (!TOKEN_FACTORY_ADDRESS) {
      setError(new Error("TokenFactory address not configured"));
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);

      // Get all token addresses
      const tokenAddresses = await publicClient.readContract({
        address: TOKEN_FACTORY_ADDRESS,
        abi: TokenFactoryABI,
        functionName: "getAllTokens",
      }) as `0x${string}`[];

      if (!tokenAddresses || tokenAddresses.length === 0) {
        setTokens([]);
        setTokenCount(0);
        setIsLoading(false);
        return;
      }

      setTokenCount(tokenAddresses.length);

      // Fetch details for each token
      const tokenPromises = tokenAddresses.map(async (addr) => {
        try {
          const [poolState, price, name, symbol] = await Promise.all([
            publicClient.readContract({
              address: TOKEN_FACTORY_ADDRESS,
              abi: TokenFactoryABI,
              functionName: "getPoolState",
              args: [addr],
            }),
            publicClient.readContract({
              address: TOKEN_FACTORY_ADDRESS,
              abi: TokenFactoryABI,
              functionName: "getCurrentPrice",
              args: [addr],
            }),
            publicClient.readContract({
              address: addr,
              abi: ERC20_ABI,
              functionName: "name",
            }).catch(() => "Unknown"),
            publicClient.readContract({
              address: addr,
              abi: ERC20_ABI,
              functionName: "symbol",
            }).catch(() => "???"),
          ]);

          const pool = poolState as any;
          const priceValue = price as bigint;

          // Pool state structure (12 fields)
          // [0] realETHReserve, [1] realTokenReserve, [2] soldTokens, [3] isGraduated,
          // [4] isActive, [5] creator, [6] createdAt, [7] metadataURI,
          // [8] graduationFailed, [9] graduationAttempts, [10] perpEnabled
          const realETHReserve = pool.realETHReserve ?? pool[0] ?? 0n;
          const soldTokens = pool.soldTokens ?? pool[2] ?? 0n;
          const isGraduated = pool.isGraduated ?? pool[3] ?? false;
          const isActive = pool.isActive ?? pool[4] ?? false;
          const creator = pool.creator ?? pool[5] ?? "0x0";
          const createdAt = pool.createdAt ?? pool[6] ?? 0n;
          const metadataURI = pool.metadataURI ?? pool[7] ?? "";
          const perpEnabled = pool.perpEnabled ?? pool[10] ?? false;

          // Calculate market cap: price * total supply (1 billion tokens)
          const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
          const marketCapWei = priceValue > 0n ? (priceValue * TOTAL_SUPPLY) / 10n ** 18n : 0n;

          return {
            address: addr,
            name: name as string,
            symbol: symbol as string,
            creator: creator as `0x${string}`,
            createdAt: Number(createdAt),
            isGraduated,
            isActive,
            price: formatUnits(priceValue, 18),
            marketCap: formatUnits(marketCapWei, 18),
            soldSupply: soldTokens.toString(),
            metadataURI,
            perpEnabled,
            realETHReserve: formatUnits(realETHReserve as bigint, 18),
          } as OnChainToken;
        } catch (err) {
          console.warn(`Failed to fetch token ${addr}:`, err);
          return null;
        }
      });

      const results = await Promise.all(tokenPromises);
      const validTokens = results.filter((t): t is OnChainToken => t !== null);

      // Sort by creation time (newest first)
      validTokens.sort((a, b) => b.createdAt - a.createdAt);

      setTokens(validTokens);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch token list:", err);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只在 mount 时执行一次

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchTokens, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只设置一次定时器

  return {
    tokens,
    isLoading,
    error,
    tokenCount,
    refetch: fetchTokens,
  };
}
