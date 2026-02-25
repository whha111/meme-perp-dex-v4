"use client";

import { useReadContracts } from "wagmi";
import { useMemo, useRef, useEffect, useState } from "react";
import { tradeEventEmitter } from "@/lib/tradeEvents";

// TokenFactory contract address from env
const TOKEN_FACTORY_ADDRESS = process.env.NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS as `0x${string}` | undefined;

// Chain ID
const chainId = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "84532", 10);

// TokenFactory ABI for view functions
// ⚠️ ABI 必须与部署的 TokenFactory 合约完全一致
// 合约 getPoolState 返回 11 个字段（不含 lendingEnabled）
// 如果字段多了，viem 会把 metadataURI 的长度字节误读为 bool → InvalidBytesBooleanError
const TOKEN_FACTORY_ABI = [
  {
    inputs: [{ name: "tokenAddress", type: "address" }],
    name: "getPoolState",
    outputs: [
      {
        components: [
          { name: "realETHReserve", type: "uint256" },
          { name: "realTokenReserve", type: "uint256" },
          { name: "soldTokens", type: "uint256" },
          { name: "isGraduated", type: "bool" },
          { name: "isActive", type: "bool" },
          { name: "creator", type: "address" },
          { name: "createdAt", type: "uint64" },
          { name: "metadataURI", type: "string" },
          { name: "graduationFailed", type: "bool" },
          { name: "graduationAttempts", type: "uint8" },
          { name: "perpEnabled", type: "bool" },
        ],
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tokenAddress", type: "address" }],
    name: "getCurrentPrice",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Bonding curve constants (same as contract: 30 ETH graduation)
const VIRTUAL_ETH_RESERVE = 10_593_000_000_000_000_000n; // 10.593 ether
const VIRTUAL_TOKEN_RESERVE = 1_073_000_000_000_000_000_000_000_000n; // 1.073B tokens (in wei)
const REAL_TOKEN_SUPPLY = 1_000_000_000_000_000_000_000_000_000n; // 1B tokens (in wei)

export interface PoolState {
  realETHReserve: bigint;
  realTokenReserve: bigint;
  soldTokens: bigint;
  isGraduated: boolean;
  isActive: boolean;
  creator: string;
  createdAt: number;
  metadataURI: string;
  graduationFailed: boolean;
  graduationAttempts: number;
  perpEnabled: boolean;
}

export interface PoolData {
  poolState: PoolState | null;
  currentPrice: bigint;
  marketCap: bigint;
  virtualETHReserve: bigint;
  virtualTokenReserve: bigint;
  isLoading: boolean;
  error: Error | null;
}

// Default data to return when not enabled or loading
const DEFAULT_POOL_DATA: PoolData = {
  poolState: null,
  currentPrice: 0n,
  marketCap: 0n,
  virtualETHReserve: VIRTUAL_ETH_RESERVE,
  virtualTokenReserve: VIRTUAL_TOKEN_RESERVE,
  isLoading: false,
  error: null,
};

/**
 * Hook to fetch pool state and price from TokenFactory contract
 * @param tokenAddress - The token contract address
 * @returns Pool data including state, price, and market cap
 */
export function usePoolState(tokenAddress: string | undefined): PoolData {
  const isValidAddress = tokenAddress?.startsWith("0x") && tokenAddress.length === 42;
  const address = isValidAddress ? tokenAddress as `0x${string}` : undefined;
  const isEnabled = !!address && !!TOKEN_FACTORY_ADDRESS;

  // Use ref to store previous result to avoid unnecessary re-renders
  const prevResultRef = useRef<PoolData>(DEFAULT_POOL_DATA);

  // Refetch trigger - changes when trade events occur
  const [refetchKey, setRefetchKey] = useState(0);

  // Subscribe to trade events for immediate refresh
  useEffect(() => {
    if (!address) return;

    const unsubscribe = tradeEventEmitter.subscribe((tradedToken) => {
      if (tradedToken.toLowerCase() === address.toLowerCase()) {
        console.log(`[usePoolState] Trade completed for ${tradedToken}, triggering refetch...`);
        setRefetchKey(k => k + 1);
      }
    });

    return unsubscribe;
  }, [address]);

  // Create stable contract configs - only recreate when address changes or refetch triggered
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const contractConfigs = useMemo(() => {
    if (!isEnabled || !TOKEN_FACTORY_ADDRESS || !address) {
      return [];
    }
    return [
      {
        address: TOKEN_FACTORY_ADDRESS,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getPoolState" as const,
        args: [address] as const,
        chainId,
      },
      {
        address: TOKEN_FACTORY_ADDRESS,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getCurrentPrice" as const,
        args: [address] as const,
        chainId,
      },
    ];
  }, [isEnabled, address, refetchKey]);

  const { data, isLoading, error } = useReadContracts({
    contracts: contractConfigs.length > 0 ? contractConfigs : undefined,
    query: {
      enabled: isEnabled && contractConfigs.length > 0,
      staleTime: 10000, // Cache for 10 seconds
      gcTime: 30000, // Keep in cache for 30 seconds
      refetchInterval: 15000, // Auto-refresh every 15 seconds
      refetchOnWindowFocus: true,
      refetchOnMount: true,
      refetchOnReconnect: true,
    },
  });

  // Process the result with useMemo to maintain stable references
  const result = useMemo((): PoolData => {
    if (!isEnabled) {
      return DEFAULT_POOL_DATA;
    }

    if (isLoading) {
      return {
        ...DEFAULT_POOL_DATA,
        isLoading: true,
      };
    }

    if (error) {
      return {
        ...DEFAULT_POOL_DATA,
        error: error as Error,
      };
    }

    if (!data || data.length < 2) {
      return DEFAULT_POOL_DATA;
    }

    const poolStateResult = data[0];
    const priceResult = data[1];

    if (poolStateResult.status !== "success" || priceResult.status !== "success") {
      const errDetail = `getPoolState: ${poolStateResult.status}${poolStateResult.status === 'failure' ? ` (${(poolStateResult as any).error?.message || (poolStateResult as any).error || 'unknown'})` : ''}, getCurrentPrice: ${priceResult.status}${priceResult.status === 'failure' ? ` (${(priceResult as any).error?.message || (priceResult as any).error || 'unknown'})` : ''}`;
      console.error(`[usePoolState] ❌ Contract call failure:`, errDetail);
      return {
        ...DEFAULT_POOL_DATA,
        error: new Error(errDetail),
      };
    }

    // Cast through unknown since wagmi returns struct as object
    const rawState = poolStateResult.result as unknown as {
      realETHReserve: bigint;
      realTokenReserve: bigint;
      soldTokens: bigint;
      isGraduated: boolean;
      isActive: boolean;
      creator: string;
      createdAt: bigint;
      metadataURI: string;
      graduationFailed: boolean;
      graduationAttempts: number;
      perpEnabled: boolean;
    };

    const poolState: PoolState = {
      realETHReserve: rawState.realETHReserve,
      realTokenReserve: rawState.realTokenReserve,
      soldTokens: rawState.soldTokens,
      isGraduated: rawState.isGraduated,
      isActive: rawState.isActive,
      creator: rawState.creator,
      createdAt: Number(rawState.createdAt),
      metadataURI: rawState.metadataURI,
      graduationFailed: rawState.graduationFailed,
      graduationAttempts: rawState.graduationAttempts,
      perpEnabled: rawState.perpEnabled ?? false,
    };

    const currentPrice = priceResult.result as bigint;

    // Calculate virtual reserves
    const virtualETH = VIRTUAL_ETH_RESERVE + poolState.realETHReserve;
    const virtualToken = poolState.realTokenReserve + (VIRTUAL_TOKEN_RESERVE - REAL_TOKEN_SUPPLY);

    // Calculate market cap (FDV) = price * total supply / 1e18
    const marketCap = (currentPrice * REAL_TOKEN_SUPPLY) / (10n ** 18n);

    return {
      poolState,
      currentPrice,
      marketCap,
      virtualETHReserve: virtualETH,
      virtualTokenReserve: virtualToken,
      isLoading: false,
      error: null,
    };
  }, [isEnabled, data, isLoading, error]);

  // Only update the ref if the result has meaningful changes
  if (result.poolState !== prevResultRef.current.poolState ||
      result.currentPrice !== prevResultRef.current.currentPrice ||
      result.isLoading !== prevResultRef.current.isLoading) {
    prevResultRef.current = result;
  }

  return prevResultRef.current;
}

/**
 * Calculate price in USD from ETH price
 */
export function calculatePriceUsd(priceWei: bigint, ethPriceUsd: number): number {
  const priceEth = Number(priceWei) / 1e18;
  return priceEth * ethPriceUsd;
}

/**
 * Calculate market cap in USD
 */
export function calculateMarketCapUsd(marketCapWei: bigint, ethPriceUsd: number): number {
  const marketCapEth = Number(marketCapWei) / 1e18;
  return marketCapEth * ethPriceUsd;
}
