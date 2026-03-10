"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * BNB 价格 Hook
 *
 * 通过 /api/bnb-price Route Handler 获取实时 BNB/USD 价格。
 * 服务端负责多源 fallback (Binance US → OKX → $600) 和 30s 内存缓存，
 * 客户端仅做一次 fetch，不再直接调用外部 API。
 *
 * 注意: 文件名保留为 useETHPrice.ts 以保持向后兼容，
 * 但内部已完全迁移到 BNB (BSC 链)
 */

const FALLBACK_BNB_PRICE = 600;
const STALE_TIME = 60_000;        // 60 秒
const REFETCH_INTERVAL = 5 * 60_000; // 5 分钟

interface BNBPriceAPIResponse {
  price: number;
  change24h: number;
  source: string;
  cached: boolean;
}

interface UseBNBPriceReturn {
  price: number;
  priceChange24h: number | null;
  isLoading: boolean;
  isError: boolean;
  lastUpdated: Date | null;
}

export function useBNBPrice(): UseBNBPriceReturn {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ["bnbPrice"],
    queryFn: async (): Promise<BNBPriceAPIResponse> => {
      const res = await fetch("/api/bnb-price");
      if (!res.ok) throw new Error(`BNB price API ${res.status}`);
      return res.json();
    },
    staleTime: STALE_TIME,
    refetchInterval: REFETCH_INTERVAL,
    retry: 2,
    enabled: typeof window !== "undefined",
  });

  return useMemo(() => ({
    price: data?.price ?? FALLBACK_BNB_PRICE,
    priceChange24h: data?.change24h ?? null,
    isLoading,
    isError,
    lastUpdated: dataUpdatedAt ? new Date(dataUpdatedAt) : null,
  }), [data?.price, data?.change24h, isLoading, isError, dataUpdatedAt]);
}

// ═══════════════════════════════════════════════════
// 向后兼容别名
// ═══════════════════════════════════════════════════
export const useETHPrice = useBNBPrice;

/** 非 hook 版本（一次性获取） */
export async function fetchBNBPrice(): Promise<number> {
  try {
    const res = await fetch("/api/bnb-price");
    if (res.ok) {
      const data: BNBPriceAPIResponse = await res.json();
      if (data.price > 0) return data.price;
    }
  } catch {
    // 静默降级
  }
  return FALLBACK_BNB_PRICE;
}

export const fetchETHPrice = fetchBNBPrice;
export const BNB_PRICE_FALLBACK = FALLBACK_BNB_PRICE;
export const ETH_PRICE_FALLBACK = FALLBACK_BNB_PRICE;
