"use client";

import { useState, useEffect, useCallback } from "react";
import { apiClient, Instrument, Ticker } from "@/lib/api/client";

/**
 * 合并后的市场数据类型
 */
export interface MarketData {
  instrument: Instrument;
  ticker?: Ticker;
  // 计算属性
  price: string;
  priceChange24h: number;
  volume24h: string;
  high24h: string;
  low24h: string;
}

/**
 * useInstruments - 获取所有可交易合约
 */
export function useInstruments() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchInstruments = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiClient.getInstruments();
      setInstruments(data || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "获取合约列表失败";
      setError(message);
      console.error("[useInstruments]", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInstruments();
  }, [fetchInstruments]);

  return { instruments, isLoading, error, refetch: fetchInstruments };
}

/**
 * useTickers - 获取所有行情
 */
export function useTickers(autoRefresh: boolean = false, interval: number = 30000) {
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTickers = useCallback(async () => {
    try {
      const data = await apiClient.getTickers();
      setTickers(data || []);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "获取行情失败";
      setError(message);
      console.error("[useTickers]", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTickers();

    if (autoRefresh) {
      const timer = setInterval(fetchTickers, interval);
      return () => clearInterval(timer);
    }
  }, [fetchTickers, autoRefresh, interval]);

  return { tickers, isLoading, error, refetch: fetchTickers };
}

/**
 * useMarketList - 获取合并的市场列表数据
 */
export function useMarketList() {
  const { instruments, isLoading: loadingInst, error: instError } = useInstruments();
  const { tickers, isLoading: loadingTickers, error: tickerError } = useTickers();

  const isLoading = loadingInst || loadingTickers;
  const error = instError || tickerError;

  // 合并数据
  const marketList: MarketData[] = instruments.map((inst) => {
    const ticker = tickers.find((t) => t.instId === inst.instId);

    // 计算 24h 涨跌幅
    let priceChange24h = 0;
    if (ticker && ticker.open24h && ticker.last) {
      const open = parseFloat(ticker.open24h);
      const last = parseFloat(ticker.last);
      if (open > 0) {
        priceChange24h = ((last - open) / open) * 100;
      }
    }

    return {
      instrument: inst,
      ticker,
      price: ticker?.last || "0",
      priceChange24h,
      volume24h: ticker?.volCcy24h || "0",
      high24h: ticker?.high24h || "0",
      low24h: ticker?.low24h || "0",
    };
  });

  return { marketList, isLoading, error };
}

export default useMarketList;
