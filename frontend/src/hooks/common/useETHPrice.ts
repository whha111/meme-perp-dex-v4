"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * ETH 价格 Hook
 * 从 CoinGecko API 获取实时 ETH/USD 价格
 *
 * 特性：
 * - 60秒缓存，避免频繁请求
 * - 失败时使用 fallback 价格
 * - 支持 SSR（服务端返回默认值）
 */

// 默认 fallback 价格（当 API 不可用时使用）
// 重要：此值必须与后端 server.ts 中的 currentEthPriceUsd 保持一致
const FALLBACK_ETH_PRICE = 2500;

// 缓存时间：60秒
const STALE_TIME = 60 * 1000;

// 重新获取间隔：5分钟
const REFETCH_INTERVAL = 5 * 60 * 1000;

interface ETHPriceResponse {
  ethereum: {
    usd: number;
    usd_24h_change?: number;
  };
}

interface UseETHPriceReturn {
  price: number;
  priceChange24h: number | null;
  isLoading: boolean;
  isError: boolean;
  lastUpdated: Date | null;
}

/**
 * 获取实时 ETH 价格
 * @returns ETH 价格（USD）和相关状态
 *
 * @example
 * ```tsx
 * const { price, isLoading } = useETHPrice();
 * console.log(`ETH Price: $${price}`);
 * ```
 */
export function useETHPrice(): UseETHPriceReturn {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ["ethPrice"],
    queryFn: async (): Promise<ETHPriceResponse> => {
      try {
        // 通过 Next.js rewrites 代理请求 Binance API (避免浏览器 CORS)
        const response = await fetch("/api/proxy/binance/v3/ticker/24hr?symbol=ETHUSDT");
        if (response.ok) {
          const data = await response.json();
          const price = parseFloat(data.lastPrice);
          const change24h = parseFloat(data.priceChangePercent);
          if (price > 0) {
            return {
              ethereum: {
                usd: price,
                usd_24h_change: change24h,
              },
            };
          }
        }
      } catch (err) {
        console.warn("[useETHPrice] Failed to fetch from Binance:", err);
      }
      // Fallback
      return {
        ethereum: {
          usd: FALLBACK_ETH_PRICE,
          usd_24h_change: 0,
        },
      };
    },
    staleTime: STALE_TIME,
    refetchInterval: REFETCH_INTERVAL,
    retry: 2,
    // 在 SSR 时不执行
    enabled: typeof window !== "undefined",
  });

  // ✅ 使用 useMemo 避免每次渲染都创建新对象
  return useMemo(() => ({
    price: data?.ethereum?.usd ?? FALLBACK_ETH_PRICE,
    priceChange24h: data?.ethereum?.usd_24h_change ?? null,
    isLoading,
    isError,
    lastUpdated: dataUpdatedAt ? new Date(dataUpdatedAt) : null,
  }), [data?.ethereum?.usd, data?.ethereum?.usd_24h_change, isLoading, isError, dataUpdatedAt]);
}

/**
 * 获取 ETH 价格（非 hook 版本，用于非组件场景）
 * 注意：这是一次性获取，不会自动更新
 */
export async function fetchETHPrice(): Promise<number> {
  try {
    const response = await fetch("/api/proxy/binance/v3/ticker/price?symbol=ETHUSDT");
    if (response.ok) {
      const data = await response.json();
      const price = parseFloat(data.price);
      if (price > 0) return price;
    }
  } catch (err) {
    console.warn("[fetchETHPrice] Failed:", err);
  }
  return FALLBACK_ETH_PRICE;
}

/**
 * ETH 价格 fallback 常量（当无法获取实时价格时使用）
 */
export const ETH_PRICE_FALLBACK = FALLBACK_ETH_PRICE;
