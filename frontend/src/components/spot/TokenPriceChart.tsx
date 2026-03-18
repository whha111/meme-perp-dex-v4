"use client";

/**
 * TradingView Lightweight Charts™ - 实时 K 线图
 *
 * 特性：
 * - 首次加载从后端获取历史 K 线数据
 * - 实时交易流更新最新 K 线
 * - 毫秒级响应，类似 pump.fun 的实时体验
 * - 支持多时间周期切换
 * - 支持明暗主题切换
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
  AutoscaleInfo,
} from "lightweight-charts";
import { TradeEvent, useInstrumentTradeStream } from "@/hooks/common/streaming/useTradeStream";
import { useAppStore } from "@/lib/stores/appStore";
import { useTranslations } from "next-intl";
import { useWebSocketKlines } from "@/hooks/common/useWebSocketKlines"; // ✅ 唯一数据源
import { usePoolState } from "@/hooks/spot/usePoolState"; // 链上价格兜底

interface TokenPriceChartProps {
  symbol: string;  // 交易对符号或合约地址
  displaySymbol?: string;  // 显示用的代币符号
  className?: string;
  latestTrade?: TradeEvent | null;
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

// ETH 价格使用 useETHPrice hook 获取实时价格
import { useETHPrice, ETH_PRICE_FALLBACK } from "@/hooks/common/useETHPrice";

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

// Helper to get chart colors based on theme
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

// K 线数据结构
interface KlineBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 客户端 K 线聚合器
class KlineAggregator {
  private bars: Map<number, KlineBar> = new Map();
  private resolution: number;

  constructor(resolutionSeconds: number) {
    this.resolution = resolutionSeconds;
  }

  // 设置历史 K 线数据（从后端加载）
  setBar(bar: KlineBar): void {
    this.bars.set(bar.time, bar);
  }

  // 根据交易更新 K 线 (保持 ETH 本位价格，与历史K线一致)
  addTrade(trade: TradeEvent, _ethPrice: number = ETH_PRICE_FALLBACK): KlineBar {
    const price = parseFloat(trade.newPrice) / 1e18; // TOKEN/ETH 价格
    const volume = parseFloat(trade.ethAmount) / 1e18;
    const timestamp = trade.timestamp;

    // 计算该交易所属的 K 线时间桶
    const bucketTime = Math.floor(timestamp / this.resolution) * this.resolution;

    let bar = this.bars.get(bucketTime);

    if (!bar) {
      // 创建新 K 线，但需要继承上一根的收盘价作为开盘价
      const prevBar = this.getLatestBar();
      const openPrice = prevBar ? prevBar.close : price;

      bar = {
        time: bucketTime,
        open: openPrice,
        high: Math.max(openPrice, price),
        low: Math.min(openPrice, price),
        close: price,
        volume: volume,
      };
    } else {
      // 更新现有 K 线
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      bar.close = price;
      bar.volume += volume;
    }

    this.bars.set(bucketTime, bar);
    return bar;
  }

  // 获取最新的 K 线
  getLatestBar(): KlineBar | null {
    if (this.bars.size === 0) return null;
    const times = Array.from(this.bars.keys()).sort((a, b) => b - a);
    return this.bars.get(times[0]) || null;
  }

  // 获取所有 K 线（按时间排序）
  getBars(): KlineBar[] {
    return Array.from(this.bars.values()).sort((a, b) => a.time - b.time);
  }

  // 清空数据
  clear(): void {
    this.bars.clear();
  }

  // 获取 K 线数量
  get size(): number {
    return this.bars.size;
  }
}

// 格式化 ETH 本位价格 (用于现货 TOKEN/WETH 交易对)
// 使用固定小数位显示，避免科学计数法，更易读
function formatPriceETH(price: number): string {
  if (price === 0) return "0";
  // 对于极小的价格，显示足够的小数位，不用科学计数法
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

// 保留 USD 格式化函数供需要时使用
function formatPrice(price: number): string {
  if (price === 0) return "$0";
  if (price < 0.000001) return "$" + price.toFixed(10);
  if (price < 0.0001) return "$" + price.toFixed(8);
  if (price < 0.01) return "$" + price.toFixed(6);
  if (price < 1) return "$" + price.toFixed(4);
  if (price < 100) return "$" + price.toFixed(2);
  return "$" + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatVolume(vol: number): string {
  if (vol >= 1000000) return (vol / 1000000).toFixed(2) + "M BNB";
  if (vol >= 1000) return (vol / 1000).toFixed(2) + "K BNB";
  if (vol >= 1) return vol.toFixed(2) + " BNB";
  return vol.toFixed(4) + " BNB";
}

// 注意: 后端现已统一返回小数格式，不再需要精度转换
// 参考: backend/src/matching/server.ts handleGetKlines() 和 handlers.ts broadcastKline()

export function TokenPriceChart({ symbol, displaySymbol, className, latestTrade }: TokenPriceChartProps) {
  // 使用 symbol 作为 instId
  const instId = symbol;
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const aggregatorRef = useRef<KlineAggregator | null>(null);

  const [resolution, setResolution] = useState<Resolution>("1m");
  const [ohlcDisplay, setOhlcDisplay] = useState<OHLCDisplay | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [isLogScale, setIsLogScale] = useState(false);
  const [currentTime, setCurrentTime] = useState("");
  const [tradeCount, setTradeCount] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [latestOHLCFromWs, setLatestOHLCFromWs] = useState<OHLCDisplay | null>(null);
  const historicalDataLoadedRef = useRef(false);
  const [chartReady, setChartReady] = useState(false); // 图表是否已初始化
  const scaleFactorRef = useRef(1); // 价格缩放因子，用于处理极小的价格

  // Get theme from store
  const theme = useAppStore((state) => state.preferences.theme);

  // ✅ 获取实时 ETH 价格
  const { price: bnbPriceUsd } = useETHPrice();

  // i18n
  const t = useTranslations("trading");
  const tc = useTranslations("chart");

  // ✅ 使用 useMemo 缓存 chartColors，避免每次渲染都创建新对象导致无限循环
  const chartColors = useMemo(() => getChartColors(theme), [theme]);

  // ✅ 使用 WebSocket K线推送 (实时更新，符合 DATA-ARCHITECTURE-STANDARD.md)
  // instId 格式可能是 "0x...-USDT"，需要提取纯地址
  const isTokenAddress = instId.startsWith("0x");
  const pureTokenAddress = isTokenAddress ? instId.split("-")[0] : null;
  const isValidTokenAddress = pureTokenAddress && pureTokenAddress.length === 42;

  // pureTokenAddress 和 isValidTokenAddress 用于判断是否可以调用链上合约和订阅 WS

  // ✅ 使用 WebSocket K线推送代替链上事件监听
  const {
    klines: wsKlines,
    loading: wsLoading,
    chartData: wsChartData,
    refresh: refreshKlines,
  } = useWebSocketKlines(
    isValidTokenAddress ? pureTokenAddress : undefined,
    resolution,
    200
  );

  // wsChartData: WS K线数据，wsLoading: K线加载状态

  // ✅ 链上价格兜底：当 WS K 线数据为空时，用 on-chain 价格生成种子蜡烛
  const poolData = usePoolState(isValidTokenAddress ? pureTokenAddress! : undefined);

  // 合并数据源：优先 WS K线，fallback 用链上价格生成种子蜡烛
  const effectiveChartData = useMemo(() => {
    // WS 有数据，直接用
    if (wsChartData && wsChartData.length > 0) return wsChartData;

    // WS 无数据 + 还在加载，返回空
    if (wsLoading) return [];

    // WS 无数据 + 不加载了，看链上价格
    if (poolData.currentPrice > 0n) {
      const priceETH = Number(poolData.currentPrice) / 1e18;
      const now = Math.floor(Date.now() / 1000);
      const bucket = Math.floor(now / RESOLUTION_SECONDS[resolution]) * RESOLUTION_SECONDS[resolution];

      return [{
        time: bucket,
        open: priceETH,
        high: priceETH,
        low: priceETH,
        close: priceETH,
        volume: 0,
      }];
    }

    return [];
  }, [wsChartData, wsLoading, poolData.currentPrice, resolution]);

  // 是否自动滚动到最新K线
  const autoScrollRef = useRef(true);
  // 当前K线数据条数（用于判断是否 fitContent）
  const candleCountRef = useRef(0);
  // 当前 resolution 下是否已完成首次 fitContent（防止 WS 更新时重复 fitContent 覆盖用户缩放）
  const fitContentDoneRef = useRef(false);
  const lastResolutionRef = useRef<Resolution>(resolution);

  // 订阅实时交易流
  const { trades, latestTrade: streamLatestTrade, isConnected } = useInstrumentTradeStream(instId, {
    enabled: !!instId,
    onTrade: (trade) => {
      // 实时更新 K 线
      if (aggregatorRef.current && candleSeriesRef.current && volumeSeriesRef.current && chartRef.current) {
        const bar = aggregatorRef.current.addTrade(trade, bnbPriceUsd);
        setTradeCount(aggregatorRef.current.size);

        // 应用与历史数据相同的缩放因子
        const sf = scaleFactorRef.current;

        // 更新图表
        const candleData: CandlestickData<Time> = {
          time: bar.time as Time,
          open: bar.open * sf,
          high: bar.high * sf,
          low: bar.low * sf,
          close: bar.close * sf,
        };

        const isUp = bar.close >= bar.open;
        const volumeData: HistogramData<Time> = {
          time: bar.time as Time,
          value: bar.volume,
          color: isUp ? 'rgba(38, 166, 154, 0.5)' : 'rgba(239, 83, 80, 0.5)',
        };

        candleSeriesRef.current.update(candleData);
        if (bar.volume > 0) {
          volumeSeriesRef.current.update(volumeData);
        }

        // 自动滚动到最新K线（如果用户没有手动滚动过）
        if (autoScrollRef.current) {
          chartRef.current.timeScale().scrollToRealTime();
        }
      }
    },
  });

  // 计算最新 OHLC
  const latestOHLC = useMemo<OHLCDisplay | null>(() => {
    if (!aggregatorRef.current) return null;
    const bars = aggregatorRef.current.getBars();
    if (bars.length === 0) return null;

    const latest = bars[bars.length - 1];
    // 涨跌幅：当前K线收盘价相对于开盘价的变化
    const change = latest.close - latest.open;
    const changePercent = latest.open > 0 ? (change / latest.open) * 100 : 0;

    return {
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      volume: latest.volume,
      change,
      changePercent,
      isUp: change >= 0,
    };
  }, [tradeCount]);

  // ✅ 使用 ref 存储 isHovering 和 chartColors，避免它们触发 effect 重新运行
  const isHoveringRef = useRef(isHovering);
  const chartColorsRef = useRef(chartColors);
  useEffect(() => { isHoveringRef.current = isHovering; }, [isHovering]);
  useEffect(() => { chartColorsRef.current = chartColors; }, [chartColors]);

  // ✅ K线数据渲染 (优先 WS 数据，fallback 用链上种子蜡烛)
  // 使用 effectiveChartData，符合 TradingView Lightweight Charts 官方规范:
  // - time: UTCTimestamp (秒)
  // - open/high/low/close: number
  // 参考: https://tradingview.github.io/lightweight-charts/docs/api/interfaces/CandlestickData
  useEffect(() => {
    if (!effectiveChartData || effectiveChartData.length === 0) {
      return;
    }

    // 检测分辨率是否切换，如果切换了需要重新 fitContent
    if (lastResolutionRef.current !== resolution) {
      lastResolutionRef.current = resolution;
      fitContentDoneRef.current = false;
    }

    // 如果图表还没初始化，延迟重试
    if (!candleSeriesRef.current || !volumeSeriesRef.current || !chartRef.current) {
      // 延迟 100ms 后重试（通过更新状态触发 re-render）
      const timer = setTimeout(() => {
        setIsLoadingHistory(prev => prev); // 触发 re-render
      }, 100);
      return () => clearTimeout(timer);
    }

    // 检查价格范围，如果跨度太大则只显示最近的数据
    const prices = effectiveChartData.map(c => c.close);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const priceRatio = maxPrice / minPrice;

    // 选择要显示的数据
    let displayData = effectiveChartData;
    if (priceRatio > 100 && effectiveChartData.length > 50) {
      displayData = effectiveChartData.slice(-50);
    }

    // ★ 关键：对于极小的价格（如 1e-9），需要缩放以避免浮点精度问题
    // TradingView Lightweight Charts 在处理极小数值时可能出现渲染问题
    // 解决方案：将价格缩放到合理范围（接近 1），然后在 Y 轴上用自定义格式显示原始值
    const refPrice = displayData[0]?.close || 1;
    let scaleFactor = 1;

    // 如果参考价格小于 1e-6，计算缩放因子使价格接近 1
    if (refPrice < 1e-6 && refPrice > 0) {
      // 找到合适的缩放因子（10 的幂次）
      const exponent = Math.floor(Math.log10(refPrice));
      scaleFactor = Math.pow(10, -exponent); // 例如 refPrice=2e-9 => exponent=-9 => scaleFactor=1e9
    }

    // 存储缩放因子到 ref，供 crosshair handler 使用
    scaleFactorRef.current = scaleFactor;

    // 后端已返回 ETH 本位价格，应用缩放因子 (TOKEN/WETH 交易对)
    const candles: CandlestickData<Time>[] = displayData.map(k => ({
      time: k.time as Time,
      open: k.open * scaleFactor,
      high: k.high * scaleFactor,
      low: k.low * scaleFactor,
      close: k.close * scaleFactor,
    }));

    // 检查是否有实际成交量数据
    const hasVolume = displayData.some(k => k.volume > 0);
    const colors = chartColorsRef.current;

    const volumes: HistogramData<Time>[] = hasVolume
      ? displayData
          .filter(k => k.volume > 0) // 过滤掉 volume=0 的数据，避免右下角出现 "0" 标签
          .map((k, i, arr) => {
            const prevClose = i > 0 ? arr[i - 1].close : k.open;
            const isUp = k.close >= prevClose;
            return {
              time: k.time as Time,
              value: k.volume,
              color: isUp ? colors.volumeUpColor : colors.volumeDownColor,
            };
          })
      : [];

    // 更新价格轴格式化以显示原始价格（除以缩放因子）
    if (scaleFactor !== 1) {
      candleSeriesRef.current.applyOptions({
        priceFormat: {
          type: 'custom',
          formatter: (price: number) => formatPriceETH(price / scaleFactor),
          minMove: 0.000001, // 缩放后的最小变动
        },
      });
    }

    candleSeriesRef.current.setData(candles);
    candleCountRef.current = candles.length;
    if (volumes.length > 0) {
      volumeSeriesRef.current.setData(volumes);
    }
    // 每次设置数据后强制关闭 volume 的标签，防止被 setData 重置
    volumeSeriesRef.current.applyOptions({
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // 设置可见范围（仅首次加载 / 切换分辨率时执行一次）：
    // 行业标准 (DexScreener/GeckoTerminal/GMGN): 最新蜡烛靠右，左侧留空，正常宽度
    // ⚠️ WS 实时更新时不再重复执行，避免覆盖用户手动缩放
    if (!fitContentDoneRef.current) {
      const timeScale = chartRef.current.timeScale();
      if (candles.length >= 30) {
        // 数据充足时铺满宽度
        timeScale.fitContent();
      } else {
        // 数据少时：正常宽度蜡烛靠右对齐，左侧留空（同 DexScreener）
        timeScale.scrollToRealTime();
      }
      fitContentDoneRef.current = true;
    }

    // 更新顶部价格显示 (使用原始数据，不是缩放后的数据)
    const latest = displayData[displayData.length - 1];
    const firstDisplayed = displayData[0];
    if (latest && firstDisplayed) {
      const change = latest.close - firstDisplayed.open;
      const changePercent = firstDisplayed.open > 0 ? (change / firstDisplayed.open) * 100 : 0;

      setLatestOHLCFromWs({
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

    setTradeCount(candles.length);
    setIsLoadingHistory(false);
    // ✅ 标记首次数据加载成功，后续切换分辨率时不再显示全屏遮罩
    historicalDataLoadedRef.current = true;
  }, [effectiveChartData, resolution]); // 依赖 effectiveChartData + resolution（分辨率切换时重置）

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
    if (!chartContainerRef.current) {
      return;
    }

    const containerWidth = chartContainerRef.current.clientWidth;
    const containerHeight = chartContainerRef.current.clientHeight;
    // 如果容器尺寸为0，等待下一帧
    if (containerWidth === 0 || containerHeight === 0) {
      const timer = requestAnimationFrame(() => {
        // 强制重新渲染
        setIsLoadingHistory(prev => prev);
      });
      return () => cancelAnimationFrame(timer);
    }

    // 初始化聚合器
    aggregatorRef.current = new KlineAggregator(RESOLUTION_SECONDS[resolution]);

    // Get initial colors
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
      rightPriceScale: {
        visible: true,
        borderVisible: false,
        borderColor: 'transparent',
        // 自定义价格标签格式化 - 使用 scaleFactorRef 还原原始价格
        tickMarkFormatter: (price: number) => {
          const realPrice = price / scaleFactorRef.current;
          return formatPriceETH(realPrice);
        },
      },
      leftPriceScale: { visible: false, borderVisible: false },
      timeScale: {
        borderVisible: false,
        borderColor: 'transparent',
        rightOffset: 5, // 右侧留出空间显示最新K线
        barSpacing: 8, // 固定蜡烛间距（像素），防止少量数据时蜡烛过宽
        minBarSpacing: 2, // 最小间距，缩放时不会太窄
        shiftVisibleRangeOnNewBar: true, // 新K线时自动滚动
        timeVisible: true, // 显示时间 (小时:分钟)
        secondsVisible: false, // 不显示秒
      },
      crosshair: {
        vertLine: { color: 'rgba(128, 128, 128, 0.3)', style: 2, labelBackgroundColor: colors.background },
        horzLine: {
          color: 'rgba(128, 128, 128, 0.3)',
          style: 2,
          labelBackgroundColor: colors.background,
          // 自定义十字光标价格标签格式化 - 使用 scaleFactorRef 还原原始价格
          labelFormatter: (price: number) => {
            const realPrice = price / scaleFactorRef.current;
            return formatPriceETH(realPrice);
          },
        },
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
      priceLineVisible: false, // 关掉横穿图表的当前价格虚线
      priceFormat: { type: 'price', precision: 12, minMove: 0.000000000001 }, // ETH 本位价格精度（支持极小值）
      // ★ 当价格无波动时，给 Y 轴添加上下边距使价格居中显示
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        if (!res || !res.priceRange) return res;
        const { minValue, maxValue } = res.priceRange;
        const range = maxValue - minValue;
        // 当波动 < 1% 时，强制以价格为中心 ±5%
        if (maxValue > 0 && (range < 0.01 * maxValue)) {
          const mid = (minValue + maxValue) / 2;
          const pad = mid * 0.05;
          return {
            priceRange: { minValue: mid - pad, maxValue: mid + pad },
          };
        }
        return res;
      },
    });

    const histogramSeries = chart.addHistogramSeries({
      color: colors.upColor,
      priceFormat: {
        type: 'custom',
        formatter: () => '',
      },
      priceScaleId: '',
      lastValueVisible: false,        // 关掉右侧当前值标签 (那个 "0")
      priceLineVisible: false,         // 关掉价格水平线
    });

    histogramSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      visible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candlestickSeries;
    volumeSeriesRef.current = histogramSeries;
    setChartReady(true);
    // 监听时间轴滚动 - 检测用户是否手动滚动
    chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      // 检查是否滚动到了最右边（最新数据）
      const timeScale = chart.timeScale();
      const visibleRange = timeScale.getVisibleLogicalRange();
      if (visibleRange) {
        // 如果可见范围的右边界接近最新数据，启用自动滚动
        // scrollToRealTime 会将视图滚动到最右边
        const scrolledToEnd = visibleRange.to >= timeScale.scrollPosition() + (visibleRange.to - visibleRange.from) * 0.9;
        autoScrollRef.current = scrolledToEnd;
      }
    });

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

  // 自动缩放 — 用户主动点击时始终 fitContent 铺满宽度
  const handleAutoScale = () => {
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  };

  const displayOHLC = isHovering && ohlcDisplay
    ? ohlcDisplay
    : latestOHLCFromWs || latestOHLC;
  // 使用 displaySymbol 或从 instId 提取 token symbol
  const tokenSymbol = displaySymbol || (
    instId.startsWith('0x')
      ? `${instId.slice(0, 6)}...${instId.slice(-4)}`
      : instId.split('-')[0].toUpperCase()
  );

  return (
    <div className={`flex flex-col w-full h-full ${className}`} style={{ backgroundColor: chartColors.background }}>
      {/* 顶部价格信息栏 */}
      <div className="h-[48px] flex items-center px-4" style={{ backgroundColor: chartColors.background, borderBottom: `1px solid ${chartColors.borderColor}` }}>
        {/* 左侧：交易对 - TOKEN/WBNB 格式，大小一致 */}
        <div className="flex items-center">
          <span className="text-okx-text-primary font-bold text-sm">{tokenSymbol}</span>
          <span className="text-okx-text-primary font-bold text-sm">/WBNB</span>
        </div>

        {displayOHLC && (
          <>
            {/* 当前价格 - 大字显示 (ETH 本位) */}
            <div className="ml-6">
              <span className={`font-bold text-[20px] ${displayOHLC.isUp ? 'text-okx-up' : 'text-okx-down'}`}>
                {formatPriceETH(displayOHLC.close)}
              </span>
            </div>

            {/* 涨跌幅 */}
            <div className={`ml-3 px-2 py-1 rounded text-sm font-medium ${
              displayOHLC.isUp
                ? 'text-okx-up bg-okx-up/15'
                : 'text-okx-down bg-okx-down/15'
            }`}>
              {displayOHLC.isUp ? '+' : ''}{displayOHLC.changePercent.toFixed(2)}%
            </div>

            {/* 分隔线 */}
            <div className="mx-4 h-6 w-px bg-okx-border-secondary" />

            {/* High/Low (ETH 本位) */}
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-okx-text-secondary">{t("high")}</span>
                <span className="text-okx-up">{formatPriceETH(displayOHLC.high)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-okx-text-secondary">{t("low")}</span>
                <span className="text-okx-down">{formatPriceETH(displayOHLC.low)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-okx-text-secondary">{t("vol")}</span>
                <span className="text-okx-text-tertiary">{formatVolume(displayOHLC.volume)}</span>
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
              className={`px-2 py-0.5 text-xs font-medium rounded transition-all ${
                resolution === key
                  ? 'text-okx-text-primary bg-blue-500'
                  : 'text-okx-text-secondary hover:text-okx-text-primary hover:bg-okx-bg-hover'
              }`}
            >
              {tc(RESOLUTION_KEYS[key])}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-3 text-xs">
          <span className="text-okx-text-secondary">{currentTime} UTC</span>
          <span className="text-okx-text-tertiary">|</span>

          <button
            onClick={toggleLogScale}
            className={`px-2 py-1 rounded transition-all ${
              isLogScale
                ? 'text-okx-text-primary bg-blue-500'
                : 'text-okx-text-secondary hover:text-okx-text-primary hover:bg-okx-bg-hover'
            }`}
          >
            log
          </button>

          <button
            onClick={handleAutoScale}
            className="px-2 py-1 rounded text-okx-up hover:bg-okx-bg-hover transition-all"
          >
            {t("auto")}
          </button>

          <span className="text-okx-text-tertiary">|</span>

          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            {tradeCount > 0 ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-okx-up animate-pulse" />
                <span className="text-okx-up">{t("realtime")} ({tradeCount})</span>
              </>
            ) : wsLoading ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
                <span className="text-yellow-500">{t("connecting")}</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-okx-text-secondary" />
                <span className="text-okx-text-secondary">{t("noTradeData")}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 图表区域 */}
      <div className="relative flex-1 w-full min-h-0" style={{ backgroundColor: chartColors.background }}>
        <div ref={chartContainerRef} className="w-full h-full" />

        {/* 空数据/加载状态 - 只在首次加载时显示全屏遮罩 */}
        {/* ✅ 修复: 使用 historicalDataLoadedRef 避免切换分辨率时闪烁 */}
        {(!historicalDataLoadedRef.current && (tradeCount === 0 || isLoadingHistory || wsLoading)) && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ backgroundColor: chartColors.background }}>
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ backgroundColor: chartColors.hoverBg }}>
                {isLoadingHistory || wsLoading ? (
                  <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                ) : historyError ? (
                  <svg className="w-6 h-6 text-okx-down" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6 text-okx-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                )}
              </div>
              <div>
                <p className="text-okx-text-secondary text-sm">
                  {wsLoading || isLoadingHistory
                    ? t("loadingKline")
                    : historyError
                      ? historyError
                      : t("noTradeData")}
                </p>
                {historyError && (
                  <button
                    onClick={() => refreshKlines()}
                    className="mt-2 px-3 py-1 text-xs text-blue-500 hover:bg-blue-500/10 rounded"
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
