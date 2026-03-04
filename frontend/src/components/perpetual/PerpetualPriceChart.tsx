"use client";

/**
 * 永续合约专用 K 线图 - 使用撮合引擎数据
 *
 * 特性：
 * - 从撮合引擎 API 获取 K 线数据
 * - 实时刷新（每秒更新最新 K 线）
 * - 支持多时间周期切换
 * - 显示当前价格、涨跌幅、24h 高低
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  createChart,
  ColorType,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  Time,
  MouseEventParams,
} from "lightweight-charts";
import { useAppStore } from "@/lib/stores/appStore";
import { useTranslations } from "next-intl";
import { MATCHING_ENGINE_URL } from "@/config/api";

// 导入 WebSocket K线 Hook
import { useWebSocketKlines } from "@/hooks/common/useWebSocketKlines";
import { usePoolState } from "@/hooks/spot/usePoolState";

interface PerpetualPriceChartProps {
  tokenAddress: string;
  displaySymbol?: string;
  className?: string;
  /** Real-time price from WebSocket (same source as order book), used for chart header display */
  currentPrice?: number;
}

type Resolution = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

const RESOLUTION_SECONDS: Record<Resolution, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

const RESOLUTION_KEYS: Record<Resolution, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "1h": "1hour",
  "4h": "4hour",
  "1d": "1day",
};

// 主题配色 - 参考 TradingView 专业风格
const CHART_THEMES = {
  dark: {
    upColor: '#26a69a',
    downColor: '#ef5350',
    background: '#131722',
    textColor: '#9CA3AF',
    gridColor: 'rgba(42, 46, 57, 0.5)',
    borderColor: '#2A2E39',
    toolbarBg: '#131722',
    hoverBg: '#2A2E39',
    accentColor: '#2962FF',
    volumeUpColor: 'rgba(38, 166, 154, 0.5)',
    volumeDownColor: 'rgba(239, 83, 80, 0.5)',
  },
  light: {
    upColor: '#089981',
    downColor: '#F23645',
    background: '#FFFFFF',
    textColor: '#131722',
    gridColor: 'rgba(42, 46, 57, 0.06)',
    borderColor: '#E0E3EB',
    toolbarBg: '#F8FAFD',
    hoverBg: '#F0F3F8',
    accentColor: '#2962FF',
    volumeUpColor: 'rgba(8, 153, 129, 0.3)',
    volumeDownColor: 'rgba(242, 54, 69, 0.3)',
  },
};

const getChartColors = (theme: 'light' | 'dark' | 'system') => {
  if (theme === 'system') {
    const prefersDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? CHART_THEMES.dark : CHART_THEMES.light;
  }
  return theme === 'light' ? CHART_THEMES.light : CHART_THEMES.dark;
};

interface OHLCDisplay {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  change: number;
  changePercent: number;
  isUp: boolean;
}

interface KlineData {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

// ETH 本位: 价格是 Token/ETH 比率，使用下标格式显示小数
// 例: 0.00000001016 → "0.0₈1016"
function formatPrice(price: number): string {
  if (price === 0) return "0";
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  if (price >= 0.0001) return price.toFixed(8);
  // 极小数使用下标格式: 0.0₈1016
  const priceStr = price.toFixed(18);
  const match = priceStr.match(/^0\.(0*)([1-9]\d*)/);
  if (match) {
    const zeroCount = match[1].length;
    const significantDigits = match[2].slice(0, 4);
    const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
    const subscriptNum = zeroCount.toString().split("").map((d) => subscripts[parseInt(d)]).join("");
    return `0.0${subscriptNum}${significantDigits}`;
  }
  return price.toFixed(10);
}

function formatVolume(vol: number): string {
  if (vol >= 1000000) return (vol / 1000000).toFixed(2) + "M";
  if (vol >= 1000) return (vol / 1000).toFixed(2) + "K";
  return vol.toFixed(2);
}

// 格式化 ETH 本位价格 (用于 Y 轴显示)
function formatPriceETH(price: number): string {
  if (price === 0) return "0";
  if (price < 0.0000000001) return price.toFixed(15);
  if (price < 0.000000001) return price.toFixed(12);
  if (price < 0.00000001) return price.toFixed(11);
  if (price < 0.0000001) return price.toFixed(10);
  if (price < 0.000001) return price.toFixed(9);
  if (price < 0.00001) return price.toFixed(8);
  if (price < 0.0001) return price.toFixed(7);
  if (price < 0.001) return price.toFixed(6);
  if (price < 0.01) return price.toFixed(5);
  if (price < 1) return price.toFixed(4);
  return price.toFixed(2);
}

export function PerpetualPriceChart({ tokenAddress, displaySymbol, className, currentPrice }: PerpetualPriceChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const scaleFactorRef = useRef(1); // 价格缩放因子，用于处理极小的价格

  const [resolution, setResolution] = useState<Resolution>("1m");
  const [ohlcDisplay, setOhlcDisplay] = useState<OHLCDisplay | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [isLogScale, setIsLogScale] = useState(false);
  const [currentTime, setCurrentTime] = useState("");
  const [klineCount, setKlineCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [latestOHLC, setLatestOHLC] = useState<OHLCDisplay | null>(null);

  // Get theme from store
  const theme = useAppStore((state) => state.preferences.theme);
  const chartColors = getChartColors(theme);

  // K线数据精度说明 (ETH 本位)：
  // - 后端 price: Token/ETH 比率 (如 0.00000001 = 1e-8 ETH per token)
  // - 后端 volume: ETH 数量浮点数
  // - 前端直接使用，无需精度转换

  // i18n
  const t = useTranslations("trading");
  const tc = useTranslations("chart");

  // ✅ 使用 WebSocket K线 Hook (实时推送)
  const { klines: wsKlines, loading: wsLoading, chartData: wsChartData } = useWebSocketKlines(
    tokenAddress,
    resolution,
    200
  );

  // 链上价格兜底：当 WS K 线数据为空时，用 on-chain 价格生成种子蜡烛
  const poolData = usePoolState(tokenAddress);

  // 合并数据源：优先 WS K线，fallback 用链上价格生成种子蜡烛
  const effectiveChartData = useMemo(() => {
    if (wsChartData && wsChartData.length > 0) return wsChartData;
    if (wsLoading) return [];
    if (poolData.currentPrice > 0n) {
      const priceETH = Number(poolData.currentPrice) / 1e18;
      const now = Math.floor(Date.now() / 1000);
      const bucket = Math.floor(now / RESOLUTION_SECONDS[resolution]) * RESOLUTION_SECONDS[resolution];
      return [{ time: bucket, open: priceETH, high: priceETH, low: priceETH, close: priceETH, volume: 0 }];
    }
    return [];
  }, [wsChartData, wsLoading, poolData.currentPrice, resolution]);

  // 派生 isLoading：仅当 WS 还在加载且没有任何可用数据时才为 true
  const isLoading = wsLoading && effectiveChartData.length === 0;

  // 处理 K线数据更新 (WS K线 + 链上种子蜡烛)
  useEffect(() => {
    if (!effectiveChartData || effectiveChartData.length === 0) {
      setKlineCount(0);
      return;
    }

    if (!candleSeriesRef.current || !volumeSeriesRef.current || !chartRef.current) {
      return;
    }

    // effectiveChartData 已经是 {time, open, high, low, close, volume} 数字格式
    const rawData = effectiveChartData;

    // ★ 修复1: 价格跨度过大时，只显示最近数据（与 TokenPriceChart 一致）
    const prices = rawData.map(c => c.close);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRatio = maxPrice / minPrice;

    let displayData = rawData;
    if (priceRatio > 100 && rawData.length > 50) {
      displayData = rawData.slice(-50);
    }

    // ★ 修复2: 极小价格缩放因子（与 TokenPriceChart 一致）
    // TradingView Lightweight Charts 在处理极小数值时有精度问题
    const refPrice = displayData[0]?.close || 1;
    let scaleFactor = 1;

    if (refPrice < 1e-6 && refPrice > 0) {
      const exponent = Math.floor(Math.log10(refPrice));
      scaleFactor = Math.pow(10, -exponent);
    }
    scaleFactorRef.current = scaleFactor;

    // 应用缩放因子
    const candles: CandlestickData<Time>[] = displayData.map(k => ({
      time: k.time as Time,
      open: k.open * scaleFactor,
      high: k.high * scaleFactor,
      low: k.low * scaleFactor,
      close: k.close * scaleFactor,
    }));

    const colors = getChartColors(useAppStore.getState().preferences.theme);
    const volumes: HistogramData<Time>[] = displayData.map((k, i) => {
      const prevClose = i > 0 ? displayData[i - 1].close : k.open;
      const isUp = k.close >= prevClose;
      return {
        time: k.time as Time,
        value: k.volume,
        color: isUp ? colors.volumeUpColor : colors.volumeDownColor,
      };
    });

    // 更新价格轴格式化以显示原始价格
    if (scaleFactor !== 1) {
      candleSeriesRef.current.applyOptions({
        priceFormat: {
          type: 'custom',
          formatter: (price: number) => formatPriceETH(price / scaleFactor),
          minMove: 0.000001,
        },
      });
    }

    // 更新图表
    candleSeriesRef.current.setData(candles);
    volumeSeriesRef.current.setData(volumes);

    // 缩放到合适范围
    chartRef.current.timeScale().fitContent();
    setTimeout(() => {
      chartRef.current?.timeScale().scrollToRealTime();
    }, 100);

    // 更新最新 OHLC (使用原始未缩放的数据)
    const latest = displayData[displayData.length - 1];
    const firstDisplayed = displayData[0];
    if (latest && firstDisplayed) {
      const change = latest.close - firstDisplayed.open;
      const changePercent = firstDisplayed.open > 0 ? (change / firstDisplayed.open) * 100 : 0;

      setLatestOHLC({
        open: firstDisplayed.open,
        high: Math.max(...displayData.map(c => c.high)),
        low: Math.min(...displayData.map(c => c.low)),
        close: latest.close,
        volume: displayData.reduce((sum, c) => sum + c.volume, 0),
        change,
        changePercent,
        isUp: change >= 0,
      });
    }

    setKlineCount(displayData.length);
  }, [effectiveChartData]);

  // ✅ WebSocket 自动更新，无需定时刷新

  // UTC 时间更新
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = now.getUTCHours().toString().padStart(2, '0');
      const minutes = now.getUTCMinutes().toString().padStart(2, '0');
      const seconds = now.getUTCSeconds().toString().padStart(2, '0');
      setCurrentTime(`${hours}:${minutes}:${seconds}`);
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // 初始化图表
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const colors = getChartColors(useAppStore.getState().preferences.theme);

    const chartOptions = {
      layout: {
        textColor: colors.textColor,
        background: {
          type: ColorType.Solid,
          color: colors.background,
        },
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight || 160,
      grid: {
        vertLines: { color: colors.gridColor, style: 0 },
        horzLines: { color: colors.gridColor, style: 0 },
      },
      rightPriceScale: { borderVisible: false, borderColor: 'transparent' },
      leftPriceScale: { visible: false, borderVisible: false },
      timeScale: {
        borderVisible: false,
        borderColor: 'transparent',
        rightOffset: 5,
        shiftVisibleRangeOnNewBar: true,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(128, 128, 128, 0.3)', style: 2, labelBackgroundColor: colors.background },
        horzLine: { color: 'rgba(128, 128, 128, 0.3)', style: 2, labelBackgroundColor: colors.background },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      kineticScroll: {
        mouse: true,
        touch: true,
      },
    };

    const chart = createChart(chartContainerRef.current, chartOptions);

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: colors.upColor,
      downColor: colors.downColor,
      borderVisible: false,
      wickUpColor: colors.upColor,
      wickDownColor: colors.downColor,
      priceFormat: { type: 'price', precision: 12, minMove: 0.000000000001 },
    });

    const histogramSeries = chart.addHistogramSeries({
      color: colors.upColor,
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });

    histogramSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candlestickSeries;
    volumeSeriesRef.current = histogramSeries;

    // 十字光标事件
    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      if (!param.time || param.point === undefined || !param.seriesData.size) {
        setIsHovering(false);
        return;
      }

      setIsHovering(true);

      const candleData = param.seriesData.get(candlestickSeries) as CandlestickData<Time> | undefined;
      const volumeData = param.seriesData.get(histogramSeries) as HistogramData<Time> | undefined;

      if (candleData && typeof candleData.open === 'number') {
        // ★ 重要：candleData 是缩放后的值，需要除以 scaleFactor 还原原始价格
        const sf = scaleFactorRef.current;
        const realOpen = candleData.open / sf;
        const realHigh = candleData.high / sf;
        const realLow = candleData.low / sf;
        const realClose = candleData.close / sf;

        const change = realClose - realOpen;
        const changePercent = realOpen > 0 ? (change / realOpen) * 100 : 0;

        setOhlcDisplay({
          open: realOpen,
          high: realHigh,
          low: realLow,
          close: realClose,
          volume: volumeData?.value || 0,
          change,
          changePercent,
          isUp: change >= 0,
        });
      }
    });

    const handleResize = () => {
      if (chartContainerRef.current && chart) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Update chart colors when theme changes
  useEffect(() => {
    if (!chartRef.current) return;

    chartRef.current.applyOptions({
      layout: {
        textColor: chartColors.textColor,
        background: {
          type: ColorType.Solid,
          color: chartColors.background,
        },
      },
      grid: {
        vertLines: { color: chartColors.gridColor },
        horzLines: { color: chartColors.gridColor },
      },
      crosshair: {
        vertLine: { labelBackgroundColor: chartColors.background },
        horzLine: { labelBackgroundColor: chartColors.background },
      },
    });
  }, [theme, chartColors]);

  // 切换对数刻度
  const toggleLogScale = () => {
    if (chartRef.current) {
      const newMode = !isLogScale;
      setIsLogScale(newMode);
      chartRef.current.priceScale('right').applyOptions({
        mode: newMode ? 1 : 0,
      });
    }
  };

  // 自动缩放
  const handleAutoScale = () => {
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  };

  // 当悬停在某根 K 线上时，显示那根 K 线的 OHLC；否则用最新 K 线数据
  const baseOHLC = isHovering && ohlcDisplay ? ohlcDisplay : latestOHLC;
  // 非悬停状态下，用实时价格 (和订单簿同源) 覆盖 close，确保价格一致
  const displayOHLC = useMemo(() => {
    if (!baseOHLC) return null;
    if (isHovering || !currentPrice || currentPrice <= 0) return baseOHLC;
    const change = currentPrice - baseOHLC.open;
    const changePercent = baseOHLC.open > 0 ? (change / baseOHLC.open) * 100 : 0;
    return {
      ...baseOHLC,
      close: currentPrice,
      high: Math.max(baseOHLC.high, currentPrice),
      low: Math.min(baseOHLC.low, currentPrice),
      change,
      changePercent,
      isUp: change >= 0,
    };
  }, [baseOHLC, currentPrice, isHovering]);
  const tokenSymbol = displaySymbol || `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;

  return (
    <div className={`flex flex-col w-full h-full ${className}`} style={{ backgroundColor: chartColors.background }}>
      {/* 顶部价格信息栏 */}
      <div className="h-[48px] flex items-center px-4" style={{ backgroundColor: chartColors.background, borderBottom: `1px solid ${chartColors.borderColor}` }}>
        {/* 左侧：交易对 */}
        <div className="flex items-center gap-2">
          <span className="text-okx-text-primary font-bold text-[16px]">{tokenSymbol}</span>
          <span className="text-[#787B86] text-[12px]">/BNB Perp</span>
        </div>

        {displayOHLC && (
          <>
            {/* 当前价格 - 大字显示 */}
            <div className="ml-6">
              <span className={`font-bold text-[20px] ${displayOHLC.isUp ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>
                {formatPrice(displayOHLC.close)}
              </span>
            </div>

            {/* 涨跌幅 */}
            <div className={`ml-3 px-2 py-1 rounded text-[13px] font-medium ${
              displayOHLC.isUp
                ? 'text-[#26a69a] bg-[#26a69a]/15'
                : 'text-[#ef5350] bg-[#ef5350]/15'
            }`}>
              {displayOHLC.isUp ? '+' : ''}{displayOHLC.changePercent.toFixed(2)}%
            </div>

            {/* 分隔线 */}
            <div className="mx-4 h-6 w-px bg-[#2A2E39]" />

            {/* High/Low */}
            <div className="flex items-center gap-4 text-[12px]">
              <div className="flex items-center gap-1.5">
                <span className="text-[#787B86]">{t("high")}</span>
                <span className="text-[#26a69a]">{formatPrice(displayOHLC.high)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[#787B86]">{t("low")}</span>
                <span className="text-[#ef5350]">{formatPrice(displayOHLC.low)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[#787B86]">{t("vol")}</span>
                <span className="text-[#9CA3AF]">BNB {formatVolume(displayOHLC.volume)}</span>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Toolbar */}
      <div className="h-[32px] flex items-center px-3 gap-2" style={{ backgroundColor: chartColors.toolbarBg }}>
        <div className="flex items-center gap-0.5">
          {(Object.keys(RESOLUTION_KEYS) as Resolution[]).map((key) => (
            <button
              key={key}
              onClick={() => setResolution(key)}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-all ${
                resolution === key
                  ? 'text-okx-text-primary bg-[#2962FF]'
                  : 'text-[#787B86] hover:text-okx-text-primary hover:bg-[#2A2E39]'
              }`}
            >
              {tc(RESOLUTION_KEYS[key])}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-3 text-[12px]">
          <span className="text-[#787B86]">{currentTime} UTC</span>
          <span className="text-[#363A45]">|</span>

          <button
            onClick={toggleLogScale}
            className={`px-2 py-1 rounded transition-all ${
              isLogScale
                ? 'text-okx-text-primary bg-[#2962FF]'
                : 'text-[#787B86] hover:text-okx-text-primary hover:bg-[#2A2E39]'
            }`}
          >
            log
          </button>

          <button
            onClick={handleAutoScale}
            className="px-2 py-1 rounded text-[#26a69a] hover:bg-[#2A2E39] transition-all"
          >
            {t("auto")}
          </button>

          <span className="text-[#363A45]">|</span>

          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            {klineCount > 0 ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-[#26a69a] animate-pulse" />
                <span className="text-[#26a69a]">Live ({klineCount})</span>
              </>
            ) : isLoading ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
                <span className="text-yellow-500">{t("connecting")}</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                <span className="text-red-500">No data</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 图表区域 */}
      <div className="relative flex-1 w-full min-h-0" style={{ backgroundColor: chartColors.background }}>
        <div ref={chartContainerRef} className="w-full h-full" />

        {/* 空数据/加载状态 */}
        {(klineCount === 0 && isLoading) && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ backgroundColor: chartColors.background }}>
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ backgroundColor: chartColors.hoverBg }}>
                {isLoading ? (
                  <div className="w-6 h-6 border-2 border-[#2962FF] border-t-transparent rounded-full animate-spin" />
                ) : error ? (
                  <svg className="w-6 h-6 text-[#ef5350]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-[#787B86]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                )}
              </div>
              <div>
                <p className="text-[#787B86] text-[13px]">
                  {isLoading
                    ? t("loadingKline")
                    : error
                      ? error
                      : t("noTradeData")}
                </p>
                {error && (
                  <button
                    onClick={() => window.location.reload()}
                    className="mt-2 px-3 py-1 text-xs text-[#2962FF] hover:bg-[#2962FF]/10 rounded"
                  >
                    {t("retry")}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
