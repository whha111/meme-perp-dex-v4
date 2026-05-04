"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatEther, formatUnits, type Address } from "viem";
import dynamic from "next/dynamic";
// V2 鏋舵瀯锛氫娇鐢?Settlement 鍚堢害 + 鎾悎寮曟搸鐨勭敤鎴峰璧屾ā寮?
import { PerpetualOrderPanelV2 } from "./PerpetualOrderPanelV2";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { AccountBalance } from "@/components/common/AccountBalance";
import { useUnifiedWebSocket } from "@/hooks/common/useUnifiedWebSocket";
import { OrderBook, type OrderBookData } from "@/components/common/OrderBook";
import { LiquidationHeatmap } from "./LiquidationHeatmap";
import { AllPositions } from "./AllPositions";
import { HunterLeaderboard } from "@/components/spot/HunterLeaderboard";
import { RiskPanel } from "./RiskPanel";
import { useTradingDataStore, useWsStatus, useCurrentOrderBook, useCurrentRecentTrades, type TokenStats, type FundingRateInfo } from "@/lib/stores/tradingDataStore";
import { useTokenInfo, getTokenDisplayName } from "@/hooks/common/useTokenInfo";
import { usePoolState, calculatePriceUsd, calculateMarketCapUsd } from "@/hooks/spot/usePoolState";
import { useToast } from "@/components/shared/Toast";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { getOrderHistory, getTradeHistory, type HistoricalOrder, type PerpTradeRecord } from "@/utils/orderSigning";
import { useRiskControl } from "@/hooks/perpetual/useRiskControl";
import { useApiError } from "@/hooks/common/useApiError";
import { trackRender } from "@/lib/debug-render";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { AnimatedNumber } from "@/components/shared/AnimatedNumber";
import { TradingErrorBoundary } from "@/components/shared/TradingErrorBoundary";

// P003 淇: 缁熶竴浣跨敤 V2 鏋舵瀯锛圫ettlement 鍚堢害 + 鎾悎寮曟搸锛?
// 绉婚櫎鏃х殑 PositionManager 鍚堢害渚濊禆锛屼粨浣嶆暟鎹粺涓€浠庢挳鍚堝紩鎿庤幏鍙?

// Dynamically import chart to avoid SSR issues
// 姘哥画鍚堢害浣跨敤涓撶敤鍥捐〃缁勪欢锛堜粠鎾悎寮曟搸鑾峰彇鏁版嵁锛?
const PerpetualPriceChart = dynamic(
  () => import("./PerpetualPriceChart").then((mod) => mod.PerpetualPriceChart),
  {
    ssr: false,
    loading: () => <div className="w-full h-full bg-okx-bg-card animate-pulse" />,
  }
);

// 鐢?React.memo 鍖呰鍥捐〃缁勪欢锛屽彧鍦?props 鐪熸鍙樺寲鏃堕噸鏂版覆鏌?
// 闃叉鐖剁粍浠跺洜涓哄€掕鏃剁瓑棰戠箒鐘舵€佹洿鏂板鑷村浘琛ㄩ棯鐑?
const MemoizedPriceChart = React.memo(PerpetualPriceChart);

const CHART_PLACEHOLDER_CANDLES = [
  { x: 8, y: 48, h: 62, up: true },
  { x: 14, y: 66, h: 42, up: false },
  { x: 20, y: 52, h: 76, up: true },
  { x: 26, y: 44, h: 54, up: true },
  { x: 32, y: 58, h: 88, up: false },
  { x: 38, y: 38, h: 72, up: true },
  { x: 44, y: 56, h: 50, up: false },
  { x: 50, y: 36, h: 98, up: true },
  { x: 56, y: 46, h: 66, up: true },
  { x: 62, y: 62, h: 44, up: false },
  { x: 68, y: 34, h: 82, up: true },
  { x: 74, y: 50, h: 58, up: false },
] as const;

const REFERENCE_PRICE_USD: Record<string, number> = {
  DOGE: 0.1842,
  SHIB: 0.0000129,
  PEPE: 0.00000986,
  FLOKI: 0.0000874,
  BONK: 0.0000186,
  WIF: 2.18,
  POPCAT: 0.318,
  MOG: 0.00000112,
};

const REFERENCE_MARKET_STATS: Record<string, { change: number; volume: string; openInterest: string; funding: string }> = {
  DOGE: { change: 2.14, volume: "$342.6M", openInterest: "$86.4M", funding: "0.0041%" },
  SHIB: { change: -1.28, volume: "$118.2M", openInterest: "$34.8M", funding: "-0.0018%" },
  PEPE: { change: 4.62, volume: "$186.9M", openInterest: "$42.7M", funding: "0.0063%" },
  FLOKI: { change: 1.17, volume: "$72.4M", openInterest: "$19.6M", funding: "0.0027%" },
  BONK: { change: -0.82, volume: "$94.1M", openInterest: "$22.3M", funding: "-0.0009%" },
  WIF: { change: 3.41, volume: "$156.8M", openInterest: "$37.9M", funding: "0.0054%" },
  POPCAT: { change: 6.28, volume: "$31.5M", openInterest: "$8.2M", funding: "0.0081%" },
  MOG: { change: -2.35, volume: "$24.8M", openInterest: "$6.1M", funding: "-0.0032%" },
};

function formatTerminalUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "--";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  if (value >= 0.0001) return value.toFixed(7);
  return value.toFixed(9);
}

function toWeiString(value: number): string {
  const scaled = Math.max(1, Math.round(Math.max(value, 0) * 1e8));
  return `${scaled}0000000000`;
}

function hashSymbol(symbol: string): number {
  return symbol.split("").reduce((sum, char, index) => sum + char.charCodeAt(0) * (index + 7), 0);
}

function buildIndicativeOrderBook(symbol: string, priceUsd: number): OrderBookData {
  const seed = hashSymbol(symbol);
  const spread = Math.max(priceUsd * 0.0009, priceUsd >= 1 ? 0.001 : priceUsd * 0.0004);
  const step = Math.max(priceUsd * 0.00065, priceUsd >= 1 ? 0.002 : priceUsd * 0.0003);
  const baseSize = priceUsd >= 1 ? 220 : priceUsd >= 0.001 ? 4200 : 760000;

  const shorts = Array.from({ length: 16 }).map((_, index) => {
    const variance = 1 + (((seed + index * 17) % 23) - 9) / 100;
    const price = priceUsd + spread + step * index;
    const size = baseSize * variance * (1 + index * 0.055);
    return {
      price: toWeiString(price),
      size: toWeiString(size),
      count: 1 + ((seed + index) % 5),
    };
  });

  const longs = Array.from({ length: 16 }).map((_, index) => {
    const variance = 1 + (((seed + index * 13) % 19) - 8) / 100;
    const price = Math.max(priceUsd - spread - step * index, priceUsd * 0.6);
    const size = baseSize * variance * (1 + index * 0.048);
    return {
      price: toWeiString(price),
      size: toWeiString(size),
      count: 1 + ((seed + index * 2) % 5),
    };
  });

  const recentTrades = Array.from({ length: 12 }).map((_, index) => {
    const side = (seed + index) % 3 === 0 ? "sell" : "buy";
    const drift = ((index % 6) - 2.5) * step * 0.45;
    return {
      price: toWeiString(Math.max(priceUsd + drift, priceUsd * 0.7)),
      size: toWeiString(baseSize * (0.18 + ((seed + index * 11) % 17) / 35)),
      side: side as "buy" | "sell",
      timestamp: Date.now() - index * 2800,
    };
  });

  return {
    longs,
    shorts,
    lastPrice: toWeiString(priceUsd),
    recentTrades,
  };
}

function buildChartCandles(symbol: string, priceUsd: number) {
  const seed = hashSymbol(symbol);
  const statChange = REFERENCE_MARKET_STATS[symbol]?.change ?? ((seed % 9) - 3);
  const trend = (statChange / 100) / 118;
  let drift = priceUsd * (1 - Math.abs(statChange) / 100 - 0.012);
  const candles = Array.from({ length: 118 }).map((_, index) => {
    const pseudoA = Math.sin((seed + index * 37.31) * 0.137);
    const pseudoB = Math.cos((seed + index * 19.17) * 0.173);
    const shock = (pseudoA * 0.0038 + pseudoB * 0.0022 + trend) * priceUsd;
    const open = drift;
    const close = Math.max(priceUsd * 0.72, open + shock);
    drift = close;
    const wick = priceUsd * (0.0018 + Math.abs(pseudoA) * 0.0042);
    const high = Math.max(open, close) + wick;
    const low = Math.max(priceUsd * 0.62, Math.min(open, close) - wick * (0.55 + Math.abs(pseudoB) * 0.75));
    const volume = 12 + Math.abs(Math.round((pseudoA + pseudoB) * 24)) + ((seed + index * 19) % 26);
    return { open, high, low, close, volume };
  });
  const min = Math.min(...candles.map((candle) => candle.low));
  const max = Math.max(...candles.map((candle) => candle.high));
  return { candles, min, max };
}

function ChartFallback({ displaySymbol }: { displaySymbol: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 dexi-chart-grid" />
      <div className="absolute left-4 top-3 flex items-center gap-2 text-xs text-okx-text-tertiary">
        <span className="font-mono text-okx-text-secondary">{displaySymbol.toUpperCase()}</span>
        <span>1m</span>
        <span>Oracle sync</span>
      </div>
      <svg className="absolute inset-x-5 bottom-8 top-12 h-[calc(100%-5rem)] w-[calc(100%-2.5rem)]" viewBox="0 0 100 160" preserveAspectRatio="none">
        <path
          d="M0 118 C10 104 18 112 28 86 C38 62 48 72 58 48 C68 26 78 40 88 22 C94 14 98 18 100 12"
          fill="none"
          stroke="rgba(68,227,199,0.22)"
          strokeWidth="1.2"
        />
        {CHART_PLACEHOLDER_CANDLES.map((candle) => (
          <g key={`${candle.x}-${candle.y}`}>
            <line
              x1={candle.x}
              x2={candle.x}
              y1={Math.max(10, candle.y - 14)}
              y2={Math.min(150, candle.y + candle.h)}
              stroke={candle.up ? "rgba(14,203,129,0.42)" : "rgba(246,70,93,0.42)"}
              strokeWidth="0.45"
            />
            <rect
              x={candle.x - 1.4}
              y={candle.y}
              width="2.8"
              height={Math.max(8, candle.h * 0.46)}
              rx="0.3"
              fill={candle.up ? "rgba(14,203,129,0.62)" : "rgba(246,70,93,0.62)"}
            />
          </g>
        ))}
      </svg>
      <div className="absolute left-1/2 top-1/2 w-[220px] -translate-x-1/2 -translate-y-1/2 rounded-[4px] border border-okx-border-primary bg-okx-bg-secondary/88 px-4 py-3 text-center shadow-2xl">
        <div className="text-sm font-semibold text-okx-text-primary">Market data syncing</div>
        <div className="mt-1 text-xs text-okx-text-tertiary">Waiting for signed oracle and book updates</div>
      </div>
    </div>
  );
}

function TerminalEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-full min-h-[188px] flex-col items-center justify-center gap-3 text-center">
      <div className="relative h-12 w-12 text-[#7D7F8B]">
        <span className="absolute left-1/2 top-0 h-5 w-8 -translate-x-1/2 rotate-45 border border-current bg-[#11161E]" />
        <span className="absolute left-1/2 top-3 h-5 w-8 -translate-x-1/2 rotate-45 border border-current bg-[#11161E]" />
        <span className="absolute left-1/2 top-6 h-5 w-8 -translate-x-1/2 rotate-45 border border-current bg-[#11161E]" />
      </div>
      <div className="text-[13px] font-medium text-[#A7B2BE]">{title}</div>
      {detail && <div className="text-[12px] text-[#77838F]">{detail}</div>}
    </div>
  );
}

function ReferenceMarketChart({
  displaySymbol,
  priceUsd,
  isReference,
}: {
  displaySymbol: string;
  priceUsd: number;
  isReference: boolean;
}) {
  const chart = useMemo(() => buildChartCandles(displaySymbol, priceUsd), [displaySymbol, priceUsd]);
  const range = Math.max(chart.max - chart.min, priceUsd * 0.02);
  const yFor = useCallback((price: number) => 318 - ((price - chart.min) / range) * 266, [chart.min, range]);
  const last = chart.candles[chart.candles.length - 1]?.close || priceUsd;
  const lastY = yFor(last);
  const axisPrices = [chart.max, chart.min + range * 0.68, chart.min + range * 0.36, chart.min];

  return (
    <div className="relative flex h-full min-h-[300px] flex-col overflow-hidden bg-[#151A22]">
      <div className="flex h-[2.625rem] shrink-0 items-center justify-between border-b border-[#2B3542] bg-[#11161E] px-3">
        <div className="flex h-full items-center gap-1">
          {["价格", "深度", "资金", "详情"].map((tab, index) => (
            <span
              key={tab}
              className={`relative flex h-full items-center px-3 text-[13px] font-medium ${
                index === 0 ? "text-[#F3F7F9]" : "text-[#9EA0AD]"
              }`}
            >
              {tab}
              {index === 0 && <span className="absolute bottom-0 left-3 right-3 h-[2px] bg-[#5EEAD4]" />}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-4 text-[12px] text-[#9EA0AD]">
          <span>盘口</span>
          <span>订单簿</span>
          <span>成交</span>
        </div>
      </div>

      <div className="flex h-[2.625rem] shrink-0 items-center justify-between border-b border-[#2B3542] bg-[#151A22] px-3 text-[13px] text-[#AEB0BA]">
        <div className="flex items-center gap-3">
          <span className="font-medium text-[#D7D8DE]">天</span>
          <span className="h-5 w-px bg-[#2B3542]" />
          <span className="font-mono">▮</span>
          <span className="font-mono">ƒx</span>
          <span>指标</span>
          <span className="h-5 w-px bg-[#2B3542]" />
          <span>订单行</span>
          <span className="h-4 w-8 rounded-full bg-[#5EEAD4]" />
          <span>买入/卖出</span>
          <span className="h-4 w-8 rounded-full bg-[#5EEAD4]" />
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <div className="hidden min-w-[132px] text-right text-[12px] font-semibold text-[#D7D8DE] xl:block">
            {displaySymbol.toUpperCase()}-USDT · 1D · DEXI
          </div>
          {["1m", "5m", "15m", "1h", "4h", "1D"].map((interval, index) => (
            <span
              key={interval}
              className={index === 5 ? "rounded-[0.25rem] bg-[#343547] px-2 py-0.5 font-semibold text-[#F3F7F9]" : "px-1 py-0.5"}
            >
              {interval}
            </span>
          ))}
          <span className={isReference ? "text-[#F5B544]" : "text-[#00D395]"}>
            {isReference ? "Reference oracle" : "Oracle composite"}
          </span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 dexi-chart-grid opacity-60" />
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 360" preserveAspectRatio="none">
          {[64, 128, 192, 256, 320].map((y) => (
            <line key={y} x1="0" x2="1000" y1={y} y2={y} stroke="rgba(208,231,235,0.045)" strokeWidth="1" />
          ))}
          {chart.candles.map((candle, index) => {
            const x = 24 + index * (900 / Math.max(1, chart.candles.length - 1));
            const openY = yFor(candle.open);
            const closeY = yFor(candle.close);
            const highY = yFor(candle.high);
            const lowY = yFor(candle.low);
            const up = candle.close >= candle.open;
            const bodyY = Math.min(openY, closeY);
            const bodyHeight = Math.max(1.8, Math.abs(closeY - openY));
            const color = up ? "rgba(0,211,149,0.92)" : "rgba(255,83,93,0.92)";
            return (
              <g key={`chart-${index}`}>
                <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth="0.9" />
                <rect x={x - 2.1} y={bodyY} width="4.2" height={bodyHeight} rx="0.35" fill={color} />
                <rect
                  x={x - 2.1}
                  y={334 - candle.volume * 0.34}
                  width="4.2"
                  height={Math.max(3, candle.volume * 0.34)}
                  fill={up ? "rgba(0,211,149,0.28)" : "rgba(255,83,93,0.28)"}
                />
              </g>
            );
          })}
          <line x1="0" x2="1000" y1={lastY} y2={lastY} stroke="rgba(119,116,255,0.5)" strokeDasharray="3 5" strokeWidth="1" />
        </svg>

        <div className="absolute right-3 top-4 flex flex-col items-end gap-[42px] text-[10px] text-[#77838F]">
          {axisPrices.map((price, index) => (
            <span key={`axis-${index}`} className="font-mono">{formatTerminalUsd(price)}</span>
          ))}
        </div>

        <div className="absolute right-3 rounded-[0.375rem] bg-[#5EEAD4] px-2 py-1 font-mono text-[11px] font-bold text-[#061215]" style={{ top: `calc(${(lastY / 360) * 100}% - 12px)` }}>
          {formatTerminalUsd(last)}
        </div>

        <div className="absolute bottom-2 left-3 right-14 flex justify-between font-mono text-[10px] text-[#77838F]">
          {["14:00", "15:00", "16:00", "17:00", "18:00", "19:00"].map((time) => (
            <span key={time}>{time}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

interface PerpetualTradingTerminalProps {
  symbol: string;
  className?: string;
  tokenAddress?: Address; // Token contract address for multi-token support
  marketId?: string;
  oraclePriceUsd?: number;
  maxLeverage?: number;
}

export function PerpetualTradingTerminal({
  symbol,
  className,
  tokenAddress: propTokenAddress,
  marketId,
  oraclePriceUsd,
  maxLeverage,
}: PerpetualTradingTerminalProps) {
  // 璋冭瘯锛氳拷韪覆鏌撴鏁?(浠?console 璀﹀憡锛屼笉 throw)
  trackRender("PerpetualTradingTerminal");

  const t = useTranslations("perp");
  const tc = useTranslations("common");
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();

  // 鑾峰彇浜ゆ槗閽卞寘锛堟淳鐢熼挶鍖咃級淇℃伅
  const {
    address: tradingWalletAddress,
    getSignature,
    isInitialized: isTradingWalletInitialized,
    exportKey,
  } = useTradingWallet();

  // 鑾峰彇浜ゆ槗閽卞寘绛惧悕锛堢敤浜庢淳鐢熺閽ワ級
  const tradingWalletSignature = getSignature();

  // Get token address - use prop if provided, otherwise try to parse from symbol
  const tokenAddress = useMemo(() => {
    if (propTokenAddress) return propTokenAddress;
    if (symbol.startsWith("0x") && symbol.length === 42) return symbol as Address;
    return undefined;
  }, [propTokenAddress, symbol]);

  // Get ETH price for USD calculations
  const { price: ethPrice } = useETHPrice();

  // Get pool state to check if perpetual trading is enabled AND get spot price
  const { poolState, currentPrice: spotPriceBigInt, marketCap: marketCapBigInt, isLoading: isPoolLoading } = usePoolState(tokenAddress);
  const isPerpEnabled = marketId ? true : (poolState?.perpEnabled ?? false);

  // Calculate spot price in USD (from TokenFactory bonding curve)
  const oraclePriceBnb = oraclePriceUsd && ethPrice ? oraclePriceUsd / ethPrice : 0;
  const spotPriceUsd = oraclePriceUsd || (spotPriceBigInt ? calculatePriceUsd(spotPriceBigInt, ethPrice) : 0);
  const marketCapUsd = marketCapBigInt ? calculateMarketCapUsd(marketCapBigInt, ethPrice) : 0;

  // V2: 浣跨敤 Settlement 鍚堢害鑾峰彇浠撲綅鍜岃鍗?
  // 浼犻€掍氦鏄撻挶鍖呭湴鍧€鍜岀鍚嶏紝纭繚鏌ヨ姝ｇ‘鐨勮鍗?
  const {
    positions: v2Positions,
    pendingOrders: v2PendingOrders,
    balance: accountBalance,
    closePair,
    cancelPendingOrder,
    refreshPositions,
    refreshOrders,
    refreshBalance,
  } = usePerpetualV2({
    tradingWalletAddress: tradingWalletAddress || undefined,
    tradingWalletSignature: tradingWalletSignature || undefined,
  });

  // 鏍煎紡鍖栬处鎴蜂綑棰?(BNB 鏈綅)
  // 鏄剧ず: Settlement 鍙敤 + 閽卞寘鍙瓨鍏?(涓嬪崟鏃惰嚜鍔ㄥ瓨鍏?Settlement)
  const formattedAccountBalance = useMemo(() => {
    if (!accountBalance) return "BNB 0.00";
    const settlementAvailable = Number(accountBalance.available) / 1e18;
    const walletETH = accountBalance.walletBalance ? Number(accountBalance.walletBalance) / 1e18 : 0;
    const gasReserve = 0.001;
    const usableWalletETH = walletETH > gasReserve ? walletETH - gasReserve : 0;
    const totalAvailable = settlementAvailable + usableWalletETH;
    return `BNB ${totalAvailable.toFixed(4)}`;
  }, [accountBalance]);

  // WebSocket 瀹炴椂璁㈠崟绨垮拰鎴愪氦鏁版嵁 - 浠庣粺涓€鐨?tradingDataStore 鑾峰彇
  const wsOrderBook = useCurrentOrderBook();
  const wsRecentTrades = useCurrentRecentTrades();

  // 浠?Store 鑾峰彇瀹炴椂缁熻鏁版嵁 (WebSocket 鎺ㄩ€?
  const tokenStats = useTradingDataStore((state) =>
    tokenAddress ? state.tokenStats.get(tokenAddress.toLowerCase() as Address) : null
  );

  // 浠?Store 鑾峰彇璧勯噾璐圭巼 (WebSocket 鎺ㄩ€?
  const fundingRateData = useTradingDataStore((state) =>
    tokenAddress ? state.fundingRates.get(tokenAddress.toLowerCase() as Address) : null
  );

  // 鏍煎紡鍖栫粺璁℃暟鎹?(BNB 鏈綅: 浠锋牸涓?BNB/Token, 1e18 绮惧害)
  const formatMemePrice = (priceStr: string | undefined) => {
    if (!priceStr) return "0.0000000000";
    const price = Number(priceStr) / 1e18;
    if (price === 0) return "0.0000000000";
    if (price < 0.000001) return price.toFixed(10);
    if (price < 0.0001) return price.toFixed(8);
    if (price < 0.01) return price.toFixed(6);
    return price.toFixed(4);
  };

  // Number-based format for AnimatedNumber (price already divided by 1e18)
  const formatMemePriceNum = useCallback((price: number) => {
    if (price === 0) return "0.0000000000";
    if (price < 0.000001) return price.toFixed(10);
    if (price < 0.0001) return price.toFixed(8);
    if (price < 0.01) return price.toFixed(6);
    return price.toFixed(4);
  }, []);

  const formattedPrice = formatMemePrice(tokenStats?.lastPrice);
  // 鉁?浣跨敤 priceChangePercent24h (鍚庣宸茶绠楀ソ鐨勭櫨鍒嗘瘮)锛岃€岄潪 priceChange24h (鍘熷 wei 宸€?
  // 娉ㄦ剰: JSX 妯℃澘 (L573) 鑷甫 "+" 鍓嶇紑锛屾澶勪笉閲嶅娣诲姞
  const priceChangePercent = parseFloat(tokenStats?.priceChangePercent24h || "0");
  const formattedPriceChange = `${priceChangePercent.toFixed(2)}%`;
  const isPriceUp = priceChangePercent >= 0;
  // 24h 楂樹綆浠凤細鏈?WS 鏁版嵁鐢?WS锛屽惁鍒?fallback 鍒?spot 浠锋牸
  const formattedHigh24h = (tokenStats?.high24h && tokenStats.high24h !== "0")
    ? formatMemePrice(tokenStats.high24h)
    : spotPriceBigInt ? formatMemePrice(spotPriceBigInt.toString()) : "0.0000000000";
  const formattedLow24h = (tokenStats?.low24h && tokenStats.low24h !== "0")
    ? formatMemePrice(tokenStats.low24h)
    : spotPriceBigInt ? formatMemePrice(spotPriceBigInt.toString()) : "0.0000000000";
  // volume24h 鏄?BNB 鎴愪氦閲?(BNB 鏈綅: 1e18 绮惧害)
  // 鍚庣璁＄畻: volume24h = 危(trade.size * trade.price) / 1e18
  const formattedVolume24h = tokenStats?.volume24h
    ? (Number(tokenStats.volume24h) / 1e18).toFixed(4)
    : "0.0000";
  const formattedOpenInterest = tokenStats?.openInterest
    ? (Number(tokenStats.openInterest) / 1e18).toFixed(4)
    : "0.0000";
  const trades24h = tokenStats?.trades24h ?? 0;

  // 鏍煎紡鍖栬祫閲戣垂鐜?(浣跨敤 ref 闃叉寰皬鍙樺寲瀵艰嚧棰戠箒璺冲姩)
  const lastDisplayedRate = React.useRef<string>("0.0000%");
  const lastRateValue = React.useRef<number>(0);

  const fundingRateFormatted = useMemo(() => {
    if (!fundingRateData?.rate) return lastDisplayedRate.current;
    const rate = Number(fundingRateData.rate) / 100;
    // 鍙湁鍙樺寲瓒呰繃 0.0001% (1bp) 鎵嶆洿鏂版樉绀猴紝閬垮厤寰皬娉㈠姩瀵艰嚧璺冲姩
    if (Math.abs(rate - lastRateValue.current) < 0.0001) {
      return lastDisplayedRate.current;
    }
    lastRateValue.current = rate;
    const sign = rate >= 0 ? "+" : "";
    const formatted = `${sign}${rate.toFixed(4)}%`;
    lastDisplayedRate.current = formatted;
    return formatted;
  }, [fundingRateData?.rate]);

  const isFundingPositive = useMemo(() => {
    if (!fundingRateData?.rate) return true;
    return Number(fundingRateData.rate) >= 0;
  }, [fundingRateData?.rate]);

  // 璧勯噾璐圭巼鍊掕鏃?鈥?浣跨敤寮曟搸鎺ㄩ€佺殑 nextFundingTime锛屽埌鏈熷悗鑷姩鎺ㄨ繘鍒颁笅涓€涓懆鏈?
  const [fundingCountdown, setFundingCountdown] = useState<string>("--:--");
  useEffect(() => {
    const FUNDING_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (match engine FUNDING.BASE_INTERVAL_MS)
    let nextTime = fundingRateData?.nextFundingTime ||
      Math.ceil(Date.now() / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;

    const updateCountdown = () => {
      const now = Date.now();
      // Auto-advance to next period when countdown expires
      while (nextTime <= now) {
        nextTime += FUNDING_INTERVAL_MS;
      }
      const diff = nextTime - now;
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setFundingCountdown(`${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [fundingRateData?.nextFundingTime]);

  // 浣跨敤缁熶竴 WebSocket 杩涜瀹炴椂鏁版嵁鎺ㄩ€?
  // 涓嶅啀浣跨敤杞锛岀敱 WebSocket 鎺ㄩ€佷粨浣嶅拰璁㈠崟鍙樻洿
  const { isConnected: unifiedWsConnected } = useUnifiedWebSocket({
    token: tokenAddress,
    trader: tradingWalletAddress || address,
    enabled: !!tokenAddress,
  });

  // 浠呭湪鍒濆鍖栨椂鑾峰彇涓€娆′粨浣嶅拰璁㈠崟锛屽悗缁敱 WebSocket 鎺ㄩ€?
  useEffect(() => {
    const effectiveAddress = tradingWalletAddress || address;
    if (!effectiveAddress) return;

    // 鍒濆鍔犺浇
    refreshPositions();
    refreshOrders();
    // 涓嶅啀璁剧疆瀹氭椂鍣紝渚濊禆 WebSocket 瀹炴椂鎺ㄩ€?
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradingWalletAddress, address]); // 鍙緷璧栧湴鍧€鍙樺寲锛岄伩鍏嶅嚱鏁板紩鐢ㄥ彉鍖栧鑷存棤闄愬惊鐜?

  // Tab 鐘舵€?- 闇€瑕佸湪浣跨敤瀹冪殑 useEffect 涔嬪墠澹版槑
  const [activeBottomTab, setActiveBottomTab] = useState<
    "positions" | "openOrders" | "orderHistory" | "tradeHistory" | "hunting" | "risk" | "bills"
  >("positions");

  // Mobile responsive: section switcher for Chart/Book/Trade (only used < md breakpoint)
  const [mobileActiveSection, setMobileActiveSection] = useState<"chart" | "book" | "trade">("chart");
  const [orderBookSuggestedPrice, setOrderBookSuggestedPrice] = useState<string>("");

  // 璁㈠崟鍘嗗彶鍜屾垚浜よ褰曠姸鎬?
  const [orderHistoryData, setOrderHistoryData] = useState<HistoricalOrder[]>([]);
  const [tradeHistoryData, setTradeHistoryData] = useState<PerpTradeRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // 閿欒澶勭悊
  const { withErrorHandling } = useApiError();

  // 鈹€鈹€ 淇濊瘉閲戣皟鏁?(Add/Remove Margin) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const [marginModal, setMarginModal] = useState<{
    pairId: string;
    action: "add" | "remove";
    collateral: number;
    size: number;
    entryPrice: number;
    isLong: boolean;
    leverage: number;
    mmr: number;
  } | null>(null);
  const [marginAmount, setMarginAmount] = useState("");
  const [isAdjustingMargin, setIsAdjustingMargin] = useState(false);
  const [marginInfo, setMarginInfo] = useState<{
    maxRemovable: number;
    minCollateral: number;
  } | null>(null);

  // 鎵撳紑淇濊瘉閲戣皟鏁村脊绐楁椂锛岃幏鍙栨渶澶у彲鍑忛
  useEffect(() => {
    if (!marginModal) { setMarginInfo(null); return; }
    if (marginModal.action !== "remove") { setMarginInfo(null); return; }
    fetch(`${MATCHING_ENGINE_URL}/api/position/${marginModal.pairId}/margin`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setMarginInfo({
            maxRemovable: parseFloat(data.maxRemovable || "0") / 1e18,
            minCollateral: parseFloat(data.minCollateral || "0") / 1e18,
          });
        }
      })
      .catch(() => {});
  }, [marginModal?.pairId, marginModal?.action]);

  // 棰勮璋冩暣鍚庣殑鏉犳潌鍜屽己骞充环
  const marginPreview = useMemo(() => {
    if (!marginModal || !marginAmount || parseFloat(marginAmount) <= 0) return null;
    const amt = parseFloat(marginAmount);
    const newCollateral = marginModal.action === "add"
      ? marginModal.collateral + amt
      : Math.max(0, marginModal.collateral - amt);
    if (newCollateral <= 0) return null;
    const newLeverage = marginModal.size / newCollateral;
    const mmrDecimal = marginModal.mmr / 100;
    // Bybit 鏍囧噯寮哄钩浠?
    const newLiqPrice = marginModal.isLong
      ? marginModal.entryPrice * (1 - 1/newLeverage + mmrDecimal/100)
      : marginModal.entryPrice * (1 + 1/newLeverage - mmrDecimal/100);
    return { newCollateral, newLeverage, newLiqPrice };
  }, [marginModal, marginAmount]);

  // 鎻愪氦淇濊瘉閲戣皟鏁?
  const handleAdjustMargin = useCallback(async () => {
    if (!marginModal || !marginAmount || !tradingWalletAddress) return;
    // 浣跨敤 parseEther 閬垮厤 parseFloat 绮惧害闂 (FE-C02)
    const { parseEther: toWei } = await import("viem");
    let amountWei: string;
    try {
      amountWei = toWei(marginAmount).toString();
    } catch {
      showToast(t("invalidAmount") || "Invalid amount", "error");
      return;
    }
    if (BigInt(amountWei) <= 0n) {
      showToast(t("invalidAmount") || "Invalid amount", "error");
      return;
    }

    setIsAdjustingMargin(true);
    try {
      const { pairId, action } = marginModal;
      const sigMsg = action === "add"
        ? `Add margin ${amountWei} to ${pairId} for ${tradingWalletAddress.toLowerCase()}`
        : `Remove margin ${amountWei} from ${pairId} for ${tradingWalletAddress.toLowerCase()}`;

      const keyData = exportKey?.();
      if (!keyData?.privateKey) {
        showToast(t("tradingWalletNotActive") || "Trading wallet not active", "error");
        return;
      }
      const { privateKeyToAccount } = await import("viem/accounts");
      const { createWalletClient, http } = await import("viem");
      const { bsc } = await import("viem/chains");
      const signerAccount = privateKeyToAccount(keyData.privateKey);
      const tempClient = createWalletClient({
        account: signerAccount,
        chain: bsc,
        transport: http(),
      });
      const signature = await tempClient.signMessage({ account: signerAccount, message: sigMsg });

      const endpoint = action === "add" ? "margin/add" : "margin/remove";
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/position/${pairId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amountWei, trader: tradingWalletAddress, signature }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(
          action === "add"
            ? (t("marginAdded") || "Margin added successfully")
            : (t("marginRemoved") || "Margin removed successfully"),
          "success"
        );
        setMarginModal(null);
        setMarginAmount("");
        refreshPositions();
        refreshBalance();
      } else {
        showToast(data.error || (t("operationFailed") || "Operation failed"), "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : (t("operationFailed") || "Operation failed"), "error");
    } finally {
      setIsAdjustingMargin(false);
    }
  }, [marginModal, marginAmount, tradingWalletAddress, exportKey, showToast, t, refreshPositions, refreshBalance]);

  // 鈹€鈹€ TP/SL 寮圭獥 (姝㈢泩姝㈡崯) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const [tpslModal, setTpslModal] = useState<{
    pairId: string;
    isLong: boolean;
    entryPrice: number;
    liqPrice: number;
  } | null>(null);
  const [tpInput, setTpInput] = useState("");
  const [slInput, setSlInput] = useState("");
  const [isSettingTpsl, setIsSettingTpsl] = useState(false);
  const [currentTpsl, setCurrentTpsl] = useState<{
    takeProfitPrice: string | null;
    stopLossPrice: string | null;
  } | null>(null);

  // 鎵撳紑寮圭獥鏃惰幏鍙栧綋鍓?TP/SL
  useEffect(() => {
    if (!tpslModal) { setCurrentTpsl(null); setTpInput(""); setSlInput(""); return; }
    fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`)
      .then(r => r.json())
      .then(data => {
        if (data.hasTPSL) {
          setCurrentTpsl({
            takeProfitPrice: data.takeProfitPrice,
            stopLossPrice: data.stopLossPrice,
          });
          if (data.takeProfitPrice) setTpInput((Number(data.takeProfitPrice) / 1e18).toString());
          if (data.stopLossPrice) setSlInput((Number(data.stopLossPrice) / 1e18).toString());
        }
      })
      .catch(() => {});
  }, [tpslModal?.pairId]);

  // 鎻愪氦 TP/SL
  const handleSetTpsl = useCallback(async () => {
    if (!tpslModal || !tradingWalletAddress) return;
    if (!tpInput && !slInput) {
      showToast(t("tpslRequired") || "Please set at least TP or SL", "error");
      return;
    }
    setIsSettingTpsl(true);
    try {
      const { parseEther: toWei } = await import("viem");
      const tpWei = tpInput ? toWei(tpInput).toString() : null;
      const slWei = slInput ? toWei(slInput).toString() : null;

      const sigMsg = `Set TPSL ${tpslModal.pairId} for ${tradingWalletAddress.toLowerCase()}`;
      const keyData = exportKey?.();
      if (!keyData?.privateKey) {
        showToast(t("tradingWalletNotActive") || "Trading wallet not active", "error");
        return;
      }
      const { privateKeyToAccount } = await import("viem/accounts");
      const { createWalletClient, http } = await import("viem");
      const { bsc } = await import("viem/chains");
      const signerAccount = privateKeyToAccount(keyData.privateKey);
      const tempClient = createWalletClient({ account: signerAccount, chain: bsc, transport: http() });
      const signature = await tempClient.signMessage({ account: signerAccount, message: sigMsg });

      const res = await fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trader: tradingWalletAddress,
          signature,
          takeProfitPrice: tpWei,
          stopLossPrice: slWei,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(t("tpslSet") || "TP/SL set successfully", "success");
        setTpslModal(null);
        refreshPositions();
      } else {
        showToast(data.error || (t("operationFailed") || "Operation failed"), "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : (t("operationFailed") || "Operation failed"), "error");
    } finally {
      setIsSettingTpsl(false);
    }
  }, [tpslModal, tpInput, slInput, tradingWalletAddress, exportKey, showToast, t, refreshPositions]);

  // 鍙栨秷 TP/SL
  const handleCancelTpsl = useCallback(async (cancelType: "tp" | "sl" | "both") => {
    if (!tpslModal) return;
    try {
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancelType }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(t("tpslCancelled") || "TP/SL cancelled", "success");
        if (cancelType === "both") { setTpslModal(null); }
        else if (cancelType === "tp") { setTpInput(""); setCurrentTpsl(prev => prev ? { ...prev, takeProfitPrice: null } : null); }
        else { setSlInput(""); setCurrentTpsl(prev => prev ? { ...prev, stopLossPrice: null } : null); }
        refreshPositions();
      }
    } catch {}
  }, [tpslModal, showToast, t, refreshPositions]);

  // 鍔犺浇璁㈠崟鍘嗗彶鍜屾垚浜よ褰?
  const loadHistoryData = useCallback(async () => {
    const effectiveAddress = tradingWalletAddress || address;
    if (!effectiveAddress) return;

    setIsLoadingHistory(true);
    try {
      const [orders, trades] = await Promise.all([
        withErrorHandling(
          () => getOrderHistory(effectiveAddress, 50),
          "鑾峰彇璁㈠崟鍘嗗彶澶辫触",
          { fallback: [], showToast: false }
        ),
        withErrorHandling(
          () => getTradeHistory(effectiveAddress, 50),
          "鑾峰彇鎴愪氦璁板綍澶辫触",
          { fallback: [], showToast: false }
        ),
      ]);
      setOrderHistoryData(orders || []);
      setTradeHistoryData(trades || []);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [tradingWalletAddress, address, withErrorHandling]);

  // 褰撳垏鎹㈠埌鍘嗗彶 Tab 鏃跺姞杞芥暟鎹?+ 鑷姩鍒锋柊
  useEffect(() => {
    if (activeBottomTab === "orderHistory" || activeBottomTab === "tradeHistory") {
      loadHistoryData();
      // Auto-refresh every 15s while tab is active
      const interval = setInterval(loadHistoryData, 15_000);
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBottomTab]); // 鍙緷璧?activeBottomTab锛岄伩鍏?loadHistoryData 寮曠敤鍙樺寲瀵艰嚧鏃犻檺寰幆

  // 鈹€鈹€ Bills (璐﹀崟) state 鈹€鈹€
  interface BillRecord {
    id: string;
    txHash: string | null;
    type: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    onChainStatus: string;
    proofData: string;
    positionId?: string;
    orderId?: string;
    createdAt: number;
  }

  const billTradingFeeLabel = t.has("billTradingFee") ? t("billTradingFee") : "Trading Fee";

  const BILL_TYPE_LABELS: Record<string, { label: string; color: string }> = {
    DEPOSIT:             { label: t("billDeposit"),          color: "text-okx-up" },
    WITHDRAW:            { label: t("billWithdraw"),         color: "text-okx-down" },
    SETTLE_PNL:          { label: t("billSettlePnl"),        color: "" },
    FUNDING_FEE:         { label: t("billFundingFee"),       color: "" },
    LIQUIDATION:         { label: t("billLiquidation"),      color: "text-okx-down" },
    MARGIN_ADD:          { label: t("billMarginAdd"),        color: "text-okx-down" },
    MARGIN_REMOVE:       { label: t("billMarginRemove"),     color: "text-okx-up" },
    DAILY_SETTLEMENT:    { label: t("billDailySettlement"),  color: "" },
    INSURANCE_INJECTION: { label: t("billInsurance"),        color: "text-okx-up" },
    TRADING_FEE:         { label: billTradingFeeLabel, color: "text-okx-down" },
    ADL:                 { label: "ADL",                     color: "text-orange-400" },
  };

  const BILL_TYPE_FILTERS = [
    { value: "all",                  label: t("billFilterAll") },
    { value: "DEPOSIT",              label: t("billDeposit") },
    { value: "WITHDRAW",             label: t("billWithdraw") },
    { value: "SETTLE_PNL",           label: t("billSettlePnl") },
    { value: "LIQUIDATION",          label: t("billLiquidation") },
    { value: "FUNDING_FEE",          label: t("billFundingFee") },
    { value: "INSURANCE_INJECTION",  label: t("billInsurance") },
    { value: "TRADING_FEE",          label: billTradingFeeLabel },
    { value: "ADL",                  label: "ADL" },
    { value: "MARGIN_ADD",           label: t("billMarginAdd") || "Margin Add" },
    { value: "MARGIN_REMOVE",        label: t("billMarginRemove") || "Margin Remove" },
  ];

  const [billsData, setBillsData] = useState<BillRecord[]>([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [billTypeFilter, setBillTypeFilter] = useState("all");
  const [billsHasMore, setBillsHasMore] = useState(true);

  const fetchBills = useCallback(async (before?: number) => {
    const effectiveAddress = tradingWalletAddress || address;
    if (!effectiveAddress) return;
    setBillsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (billTypeFilter !== "all") params.set("type", billTypeFilter);
      if (before) params.set("before", before.toString());
      const res = await fetch(
        `${MATCHING_ENGINE_URL}/api/user/${effectiveAddress}/bills?${params}`
      );
      const data = await res.json();
      const newBills: BillRecord[] = Array.isArray(data) ? data : [];
      if (before) {
        setBillsData(prev => [...prev, ...newBills]);
      } else {
        setBillsData(newBills);
      }
      setBillsHasMore(newBills.length >= 50);
    } catch {
      if (!before) setBillsData([]);
    } finally {
      setBillsLoading(false);
    }
  }, [tradingWalletAddress, address, billTypeFilter]);

  // 鍒囨崲鍒拌处鍗?Tab 鎴栫瓫閫夊彉鍖栨椂閲嶆柊鍔犺浇
  useEffect(() => {
    if (activeBottomTab === "bills") {
      setBillsData([]);
      setBillsHasMore(true);
      fetchBills();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBottomTab, billTypeFilter]);

  const loadMoreBills = useCallback(() => {
    if (billsData.length === 0 || !billsHasMore || billsLoading) return;
    fetchBills(billsData[billsData.length - 1].createdAt);
  }, [billsData, billsHasMore, billsLoading, fetchBills]);

  // 褰撳墠浠ｅ竵鐨?V2 浠撲綅 (HTTP 杞鐨勬暟鎹?- 鐢ㄤ簬骞充粨绛夋搷浣?
  const currentV2Positions = useMemo(() => {
    if (!tokenAddress) return [];
    return v2Positions.filter(
      (p) => p.token.toLowerCase() === tokenAddress.toLowerCase()
    );
  }, [v2Positions, tokenAddress]);

  // Contract write for closing position
  const { writeContract, data: txHash, isPending: isWritePending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // P003 淇: 绉婚櫎鏃х殑 PositionManager 鍚堢害璋冪敤
  // V2 鏋舵瀯浣跨敤 Settlement 鍚堢害 + 鎾悎寮曟搸锛屼粨浣嶆暟鎹粺涓€浠?usePerpetualV2 鑾峰彇

  // Handle close position success
  useEffect(() => {
    if (isConfirmed && txHash) {
      showToast(t("orderPlaced"), "success");
      refreshPositions(); // 浣跨敤 V2 鐨?refreshPositions
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfirmed, txHash]); // 鍙緷璧栦氦鏄撶姸鎬侊紝閬垮厤鍑芥暟寮曠敤瀵艰嚧鏃犻檺寰幆

  // 浠庨摼涓婅幏鍙栦唬甯佸悕绉板拰绗﹀彿
  const tokenInfo = useTokenInfo(symbol);
  const displaySymbol = getTokenDisplayName(symbol, tokenInfo);

  // 浣跨敤 useMemo 閬垮厤 instId 鍥犱负 loading 鐘舵€佸彉鍖栬€屾敼鍙?
  const instId = useMemo(() => {
    // 鍙湪鏈夊疄闄呯鍙锋椂鎵嶅垱寤?instId锛岄伩鍏嶅姞杞界姸鎬佸鑷寸殑鍙樺寲
    if (tokenInfo?.isLoading || !displaySymbol || displaySymbol === "...") {
      // 浣跨敤 symbol 浣滀负 fallback锛岃€屼笉鏄?loading indicator
      return `${symbol.toUpperCase()}-PERP`;
    }
    return `${displaySymbol.toUpperCase()}-PERP`;
  }, [symbol, tokenInfo?.symbol]); // 鍙緷璧栧疄闄呯殑绗﹀彿锛屼笉渚濊禆 loading 鐘舵€?

  // 椋庢帶鏁版嵁
  const displayPair = marketId ? `${displaySymbol.toUpperCase()}/USDT` : `${displaySymbol.toUpperCase()}/BNB`;
  const marketSymbol = displaySymbol.toUpperCase();
  const referenceStats = REFERENCE_MARKET_STATS[marketSymbol] || {
    change: 0,
    volume: "--",
    openInterest: "--",
    funding: "0.0000%",
  };
  const referencePriceUsd = useMemo(() => {
    if (oraclePriceUsd && oraclePriceUsd > 0) return oraclePriceUsd;
    if (!marketId) return spotPriceUsd;
    return REFERENCE_PRICE_USD[marketSymbol] || spotPriceUsd || 0;
  }, [marketId, marketSymbol, oraclePriceUsd, spotPriceUsd]);
  const hasLiveMarketPrice = Boolean(oraclePriceUsd && oraclePriceUsd > 0);
  const indicativeOrderBook = useMemo(
    () => (marketId && referencePriceUsd > 0 ? buildIndicativeOrderBook(marketSymbol, referencePriceUsd) : undefined),
    [marketId, marketSymbol, referencePriceUsd]
  );

  const {
    alerts: riskAlerts,
    insuranceFund,
    positionRisks,
    clearAlerts: clearRiskAlerts,
  } = useRiskControl({
    trader: tradingWalletAddress || address,
    token: tokenAddress,
  });

  // 璁＄畻鏁翠綋椋庨櫓绛夌骇
  const overallRisk = positionRisks.reduce((worst, pos) => {
    const levels = ["low", "medium", "high", "critical"];
    return levels.indexOf(pos.riskLevel) > levels.indexOf(worst) ? pos.riskLevel : worst;
  }, "low" as "low" | "medium" | "high" | "critical");

  // ============================================================
  // 浣跨敤 useRiskControl 鐨勫疄鏃舵帹閫佷粨浣嶆暟鎹潵娓叉煋
  // 鍚庣姣?00ms璁＄畻涓€娆★紝閫氳繃 WebSocket 瀹炴椂鎺ㄩ€?
  // ============================================================
  const currentPositionsForDisplay = useMemo(() => {
    if (!tokenAddress) return [];
    // 浼樺厛浣跨敤 WebSocket 鎺ㄩ€佺殑 positionRisks 鏁版嵁
    // 杩欎簺鏁版嵁鍖呭惈浜嗗悗绔疄鏃惰绠楃殑 markPrice, unrealizedPnL, marginRatio, roe 绛?
    const wsPositions = positionRisks.filter(
      (p) => p.token.toLowerCase() === tokenAddress.toLowerCase()
    );
    if (wsPositions.length > 0) {
      return wsPositions;
    }
    // 濡傛灉 WebSocket 娌℃湁鏁版嵁锛屽洖閫€鍒?HTTP 杞鏁版嵁
    return currentV2Positions;
  }, [tokenAddress, positionRisks, currentV2Positions]);

  // 璐︽埛浣欓闈㈡澘鐘舵€?
  const [showAccountPanel, setShowAccountPanel] = useState(false);

  // 鎾ゅ崟鐘舵€?
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);

  // 鎾ゅ崟澶勭悊鍑芥暟
  const handleCancelOrder = async (orderId: string) => {
    if (!tradingWalletAddress || !tradingWalletSignature) {
      showToast(t("connectWallet"), "error");
      return;
    }

    setCancellingOrderId(orderId);
    try {
      const result = await cancelPendingOrder(orderId);

      if (result.success) {
        showToast(`${t("cancelOrder")} success`, "success");
        // 鍒锋柊璁㈠崟鍒楄〃
        refreshOrders();
      } else {
        showToast(result.error || t("orderFailed"), "error");
      }
    } catch (error) {
      console.error("Cancel order error:", error);
      showToast(t("orderFailed"), "error");
    } finally {
      setCancellingOrderId(null);
    }
  };

  // Helper function to format small prices
  const formatSmallPrice = (price: number): string => {
    if (price <= 0) return "0.00";
    if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 1 });
    if (price >= 0.01) return price.toFixed(4);
    if (price >= 0.0001) return price.toFixed(6);
    if (price >= 0.000001) return price.toFixed(8);
    // For very small numbers, use subscript notation
    const priceStr = price.toFixed(18);
    const match = priceStr.match(/^0\.(0*)([1-9]\d*)/);
    if (match) {
      const zeroCount = match[1].length;
      const significantDigits = match[2].slice(0, 5);
      const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
      const subscriptNum = zeroCount.toString().split("").map((d) => subscripts[parseInt(d)]).join("");
      return `0.0${subscriptNum}${significantDigits}`;
    }
    return price.toFixed(10);
  };

  // Market info 鈥?浼樺厛浣跨敤鍚庣 WebSocket 鎺ㄩ€佺殑 lastPrice (鍜岃鍗曠翱鍚屾簮锛岄伩鍏嶅墠鍚庣 ETH/USD 姹囩巼宸紓)
  // 鍙湁鍦?WebSocket 鏁版嵁涓嶅彲鐢ㄦ椂鎵嶅洖閫€鍒板墠绔洿鎺ヨ閾句笂浠锋牸
  // BNB 鏈綅: 浠锋牸鏄?Token/BNB 姣旂巼锛孫I/Volume 鐢?BNB
  // 鈿狅笍 娉ㄦ剰: fundingCountdown 姣忕鏇存柊锛屼笉鏀惧叆 marketInfo 閬垮厤鏁翠釜瀵硅薄姣忕閲嶅缓瀵艰嚧 K 绾挎姈鍔?
  const marketInfo = useMemo(
    () => ({
      fundingRate: marketId ? referenceStats.funding : fundingRateFormatted,
      openInterest: marketId ? referenceStats.openInterest : `BNB ${formattedOpenInterest}`,
      volume24h: marketId ? referenceStats.volume : `BNB ${formattedVolume24h}`,
      high24h: formattedHigh24h,    // Token/BNB 姣旂巼锛屾棤璐у竵绗﹀彿
      low24h: formattedLow24h,      // Token/BNB 姣旂巼锛屾棤璐у竵绗﹀彿
      ...(marketId ? {
        high24h: referencePriceUsd > 0
          ? formatTerminalUsd(referencePriceUsd * (1 + Math.abs(referenceStats.change) / 100 + 0.018))
          : "--",
        low24h: referencePriceUsd > 0
          ? formatTerminalUsd(referencePriceUsd * Math.max(0.2, 1 - Math.abs(referenceStats.change) / 100 - 0.022))
          : "--",
      } : {}),
      currentPrice: marketId && referencePriceUsd > 0
        ? `$${formatTerminalUsd(referencePriceUsd).replace(/\s+/g, "")}`
        : formattedPrice !== "0.0000000000"
        ? formattedPrice                                    // 浼樺厛: 鍚庣 WebSocket lastPrice (Token/BNB)
        : spotPriceUsd > 0
        ? formatSmallPrice(spotPriceUsd)                    // 鍥為€€: 鍓嶇鐩磋閾句笂浠锋牸
        : formattedPrice,
      spotPrice: marketId ? referencePriceUsd : spotPriceUsd,
      marketCap: marketCapUsd,
      priceChange: marketId ? `${referenceStats.change.toFixed(2)}%` : formattedPriceChange,
      isPriceUp: marketId ? referenceStats.change >= 0 : isPriceUp,
      trades24h,
    }),
    [marketId, referenceStats.funding, referenceStats.openInterest, referenceStats.volume, referenceStats.change, referencePriceUsd, fundingRateFormatted, formattedOpenInterest, formattedVolume24h, formattedHigh24h, formattedLow24h, formattedPrice, formattedPriceChange, isPriceUp, trades24h, spotPriceUsd, marketCapUsd]
  );

  // K 绾垮浘琛ㄧ殑浠锋牸 prop 鈥?鍗曠嫭 memoize锛岄伩鍏嶉殢鐖剁粍浠跺叾浠栫姸鎬佸彉鍖栭噸寤?
  // AUDIT-FIX FC-C03: chartPrice 搴旂粺涓€浣跨敤 BNB 璁′环
  // 涔嬪墠 fallback 鐢?spotPriceUsd (USD)锛屼絾 chart 鏈熸湜 BNB 璁′环 鈫?浠锋牸 inflated ~600x
  const chartPrice = useMemo(() => {
    if (tokenStats?.lastPrice) {
      return Number(tokenStats.lastPrice) / 1e18;
    }
    if (oraclePriceBnb > 0) {
      return oraclePriceBnb;
    }
    // Fallback: 浣跨敤 spotPriceBigInt (BNB 璁′环, 1e18 绮惧害)
    if (spotPriceBigInt) {
      return Number(spotPriceBigInt) / 1e18;
    }
    return undefined;
  }, [tokenStats?.lastPrice, oraclePriceBnb, spotPriceBigInt]);

  return (
    <div
      className={`dydx-terminal flex h-[calc(100vh-2.75rem)] min-h-0 flex-col overflow-hidden bg-[#0A0C11] text-okx-text-primary ${className}`}
    >
      {/* Top Bar 鈥?Responsive: Row 1 always visible, Row 2 (stats) scrollable on mobile */}
      <div className="dydx-risk-banner hidden items-center border-b border-[#3C2A30] bg-[#2B1E22] px-4 text-[12px] font-medium text-[#FF8088] md:flex">
        在您所在的国家或地区不能使用永续合约。现货交易仍可进行。请注意，根据使用条款，禁止来自某些司法管辖区的访问。
      </div>
      <div className="dydx-market-strip border-b border-[#2B3542] bg-[#11161E]">
        {/* Row 1: Symbol + Price + Change + Account */}
        <div className="flex h-[var(--market-info-row-height)] items-stretch gap-0 px-0">
          {/* Symbol */}
          <div className="flex min-w-[160px] flex-shrink-0 items-center gap-2 border-r border-[#2B3542] px-3">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#F7931A] text-[12px] font-bold text-white">
              {displaySymbol.slice(0, 1).toUpperCase()}
            </span>
            <span className="text-[16px] font-semibold text-[#F3F7F9]">
              {displayPair.replace("/", "-")}
            </span>
            <span className="text-[#77838F]">⌄</span>
          </div>

          {/* Mark Price + 24h Change 鈥?always visible (compact on mobile) */}
          <div className="flex flex-shrink-0 items-center border-r border-[#2B3542] px-3">
            <div className="flex flex-col gap-0.5 pr-4">
              {marketId ? (
                <span className="whitespace-nowrap font-sans text-[20px] font-semibold tabular-nums text-[#F3F7F9]">
                  {marketInfo.currentPrice}
                </span>
              ) : chartPrice ? (
                <AnimatedNumber
                  value={chartPrice}
                  format={formatMemePriceNum}
                  className={`font-mono text-sm font-bold md:text-[15px] ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}
                  showArrow={true}
                  highlightChange={true}
                />
              ) : (
                <span className={`font-mono text-sm font-bold md:text-[15px] ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}>
                  {marketInfo.currentPrice}
                </span>
              )}
              <span className="text-[11px] text-[#77838F]">标记价格</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className={`font-mono text-[13px] font-semibold ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}>
                {marketInfo.isPriceUp ? "+" : ""}{marketInfo.priceChange}
              </span>
              <span className="text-[11px] text-[#77838F]">24小时波动</span>
            </div>
          </div>

          {/* Desktop-only stats (hidden on mobile, shown in Row 2) */}
          <div className="hidden min-w-0 items-stretch md:flex">
            <div className="flex min-w-[98px] flex-col justify-center gap-0.5 border-r border-[#2B3542] px-3">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.high24h}</span>
              <span className="text-[11px] text-[#77838F]">24H最高价</span>
            </div>
            <div className="flex min-w-[98px] flex-col justify-center gap-0.5 border-r border-[#2B3542] px-3">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.low24h}</span>
              <span className="text-[11px] text-[#77838F]">24H最低价</span>
            </div>
            <div className="flex min-w-[112px] flex-col justify-center gap-0.5 border-r border-[#2B3542] px-3">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.volume24h}</span>
              <span className="text-[11px] text-[#77838F]">24H成交量</span>
            </div>
            <div className="flex min-w-[104px] flex-col justify-center gap-0.5 border-r border-[#2B3542] px-3">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.openInterest}</span>
              <span className="text-[11px] text-[#77838F]">持仓量</span>
            </div>
            <div className="flex min-w-[112px] flex-col justify-center gap-0.5 border-r border-[#2B3542] px-3">
              <span className={`text-xs font-mono ${isFundingPositive ? "text-okx-up" : "text-okx-down"}`}>
                {marketInfo.fundingRate}
              </span>
              <span className="text-[11px] text-[#77838F]">
                资金费率 / {fundingCountdown}
              </span>
            </div>
            <div className="flex min-w-[96px] flex-col justify-center gap-0.5 px-3">
              <span className={`text-xs font-mono ${marketId ? (hasLiveMarketPrice ? "text-okx-up" : "text-okx-warning") : "text-okx-text-primary"}`}>
                {marketId
                  ? hasLiveMarketPrice ? "Live" : "Reference"
                  : marketInfo.marketCap >= 1000000
                  ? `$${(marketInfo.marketCap / 1000000).toFixed(2)}M`
                  : marketInfo.marketCap >= 1000
                  ? `$${(marketInfo.marketCap / 1000).toFixed(2)}K`
                  : `$${marketInfo.marketCap.toFixed(2)}`}
              </span>
              <span className="text-[11px] text-[#77838F]">{marketId ? "ORACLE" : t("marketCap")}</span>
            </div>
          </div>

          {/* Account Balance & Risk (right side) */}
          <div className="ml-auto flex items-center gap-1.5 md:gap-2">
            {/* Risk Alert Badge */}
            {riskAlerts.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setActiveBottomTab("risk")}
                  className="rounded-[4px] bg-red-900/30 p-1.5 text-red-400 transition-colors hover:bg-red-900/50 md:p-2"
                  title={`${riskAlerts.length} risk alerts`}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                  </svg>
                </button>
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center animate-pulse">
                  {riskAlerts.length > 9 ? "9+" : riskAlerts.length}
                </span>
              </div>
            )}

            {/* Risk Level Indicator 鈥?hide on smallest screens */}
            {positionRisks.length > 0 && (
              <div className={`hidden rounded-[4px] px-2 py-1 text-xs font-medium sm:block ${
                overallRisk === "critical" ? "bg-red-900/50 text-red-400 animate-pulse" :
                overallRisk === "high" ? "bg-orange-900/50 text-orange-400" :
                overallRisk === "medium" ? "bg-yellow-900/50 text-yellow-400" :
                "bg-green-900/50 text-green-400"
              }`}>
                Risk: {overallRisk.toUpperCase()}
              </div>
            )}

            {/* Insurance Fund 鈥?hide on mobile */}
            {insuranceFund && (
              <div className="hidden items-center gap-1 rounded-[4px] border border-okx-border-primary px-2 py-1 text-xs text-okx-text-tertiary sm:flex">
                <svg className="w-3 h-3 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-green-400 font-medium">
                  {insuranceFund.display?.balance || "BNB 0"}
                </span>
                <span>IF</span>
              </div>
            )}

          </div>
        </div>

        {/* Row 2: Mobile-only scrollable stats strip */}
        <div className="overflow-x-auto border-t border-okx-border-primary/50 md:hidden">
          <div className="flex items-center gap-4 px-3 py-1.5 min-w-max">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.high24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("high24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.low24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("low24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.volume24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("volume24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.openInterest}</span>
              <span className="text-xs text-okx-text-secondary">{t("openInterest")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className={`text-xs font-mono ${isFundingPositive ? "text-okx-up" : "text-okx-down"}`}>
                {marketInfo.fundingRate}
              </span>
              <span className="text-xs text-okx-text-secondary">{t("fundingRate")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className={`text-xs font-mono ${marketId ? (hasLiveMarketPrice ? "text-okx-up" : "text-okx-warning") : "text-okx-text-primary"}`}>
                {marketId
                  ? hasLiveMarketPrice ? "Live" : "Reference"
                  : marketInfo.marketCap >= 1000000
                  ? `$${(marketInfo.marketCap / 1000000).toFixed(2)}M`
                  : marketInfo.marketCap >= 1000
                  ? `$${(marketInfo.marketCap / 1000).toFixed(2)}K`
                  : `$${marketInfo.marketCap.toFixed(2)}`}
              </span>
              <span className="text-xs text-okx-text-secondary">{marketId ? "Oracle" : t("marketCap")}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content - Responsive: mobile=tabs, tablet=2col, desktop=3col */}
      <div className="dydx-main-content flex flex-col flex-1 overflow-hidden">

        {/* Mobile Section Tabs (< md only) */}
        <div className="md:hidden flex border-b border-okx-border-primary bg-okx-bg-secondary">
          {([
            { key: "chart" as const, label: t("mobileChart") },
            { key: "book" as const, label: t("mobileBook") },
            { key: "trade" as const, label: t("mobileTrade") },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMobileActiveSection(tab.key)}
              className={`flex-1 py-2.5 text-xs font-medium transition-colors relative ${
                mobileActiveSection === tab.key
                  ? "text-okx-accent"
                  : "text-okx-text-secondary"
              }`}
            >
              {tab.label}
              {mobileActiveSection === tab.key && (
                <div className="absolute bottom-0 left-1/4 right-1/4 h-[2px] bg-okx-accent" />
              )}
            </button>
          ))}
        </div>

        {/* Desktop terminal: dYdX-style trade grid */}
        <div className="dydx-trade-grid hidden min-h-0 flex-1 overflow-hidden md:grid">
          <div className="dydx-side-region grid min-h-0 grid-rows-[var(--account-info-section-height)_minmax(0,1fr)] gap-px">
            <div className="dydx-panel order-2 min-h-0 overflow-y-auto">
              <TradingErrorBoundary module="OrderPanel">
                <PerpetualOrderPanelV2
                  symbol={symbol}
                  displaySymbol={displaySymbol}
                  tokenAddress={tokenAddress}
                  marketId={marketId}
                  oraclePriceUsd={oraclePriceUsd}
                  maxLeverage={maxLeverage}
                  isPerpEnabled={isPerpEnabled}
                  suggestedPrice={orderBookSuggestedPrice}
                />
              </TradingErrorBoundary>
            </div>

            <div className="dydx-panel order-1 flex min-h-0 flex-col px-4 py-3">
              <div className="grid flex-1 grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[11px]">
                <span className="text-[#9EA0AD]">资产组合价值</span>
                <span className="font-mono text-[#F7FAFC]">{isConnected ? formattedAccountBalance : "--"}</span>
                <span className="text-[#9EA0AD]">可用余额</span>
                <span className="font-mono text-[#F7FAFC]">{isConnected ? formattedAccountBalance : "--"}</span>
                <span className="text-[#9EA0AD]">使用的保证金</span>
                <span className="font-mono text-[#F7FAFC]">{currentPositionsForDisplay.length > 0 ? "Active" : "0.00%"}</span>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAccountPanel(true)}
                  className="h-8 flex-1 rounded-[0.375rem] bg-[#3B3C42] text-xs font-semibold text-[#F3F7F9] transition-colors hover:bg-[#46474E]"
                >
                  提现 ↻
                </button>
                <button
                  type="button"
                  onClick={() => setShowAccountPanel(true)}
                  className="h-8 w-9 rounded-[0.375rem] border border-[#2B3542] bg-[#11161E] text-xs font-semibold text-[#A7B2BE] transition-colors hover:border-[#4D4E57] hover:text-[#F7FAFC]"
                >
                  W
                </button>
              </div>
            </div>
          </div>

          <div className="dydx-panel dydx-inner-region relative min-h-0 overflow-hidden">
              {marketId && referencePriceUsd > 0 ? (
                <ReferenceMarketChart
                  displaySymbol={displaySymbol}
                  priceUsd={referencePriceUsd}
                  isReference={!hasLiveMarketPrice}
                />
              ) : (
                <>
                  <TradingErrorBoundary module="PerpChart">
                    {tokenAddress && (
                      <MemoizedPriceChart
                        tokenAddress={tokenAddress}
                        displaySymbol={displaySymbol}
                        currentPrice={chartPrice}
                      />
                    )}
                  </TradingErrorBoundary>
                  {!chartPrice && <ChartFallback displaySymbol={displaySymbol} />}
                </>
              )}
          </div>

          <div className="dydx-panel dydx-vertical-region min-h-0 overflow-hidden">
              <TradingErrorBoundary module="OrderBook">
                <OrderBook
                  data={wsOrderBook ? { ...wsOrderBook, recentTrades: wsRecentTrades } : indicativeOrderBook}
                  onPriceClick={(price) => {
                    setOrderBookSuggestedPrice(String(price));
                  }}
                  maxRows={14}
                  quoteLabel={marketId ? "USDT" : "BNB"}
                  baseLabel={displaySymbol.toUpperCase()}
                  modeLabel={wsOrderBook ? "Live" : marketId ? "Oracle" : undefined}
                  isIndicative={!wsOrderBook && Boolean(marketId)}
                />
              </TradingErrorBoundary>
          </div>

          {/* Bottom Panel - Positions, Orders, History */}
          <div className="dydx-panel dydx-horizontal-region flex h-full min-h-0 flex-col overflow-hidden bg-[#10141B]">
            {/* Tabs 鈥?horizontally scrollable on narrow viewports */}
            <div className="overflow-x-auto border-b border-[#2B3542]">
              <div className="flex min-w-max px-2 md:px-3">
              {[
                { key: "positions", label: "头寸" },
                { key: "openOrders", label: "未平仓订单" },
                { key: "tradeHistory", label: "成交" },
                { key: "orderHistory", label: "订单历史" },
                { key: "bills", label: "资金支付" },
                { key: "risk", label: "风险", badge: riskAlerts.length > 0 ? riskAlerts.length : undefined },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveBottomTab(tab.key as typeof activeBottomTab)}
                  className={`relative flex shrink-0 items-center gap-1 whitespace-nowrap px-3 py-2 text-xs transition-colors ${
                    activeBottomTab === tab.key
                      ? "font-semibold text-[#F7FAFC]"
                      : "text-[#77838F] hover:text-[#A7B2BE]"
                  }`}
                >
                  {tab.label}
                  {"badge" in tab && tab.badge && (
                    <span className="bg-red-500 text-white text-xs rounded-full px-1.5 min-w-[16px] h-4 flex items-center justify-center">
                      {tab.badge > 9 ? "9+" : tab.badge}
                    </span>
                  )}
                  {activeBottomTab === tab.key && (
                    <div className="absolute bottom-0 left-2 right-2 h-px bg-[#5EEAD4]" />
                  )}
                </button>
              ))}
              </div>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto">
              {/* Positions - 娴ｈ法鏁?WebSocket 鐎圭偞妞傞幒銊┾偓浣规殶閹?(鐞涘奔绗熼弽鍥у櫙 UI - 閸欏倽鈧?OKX/Binance) */}
              {activeBottomTab === "positions" && (
                <div className="px-0">
                  {!isConnected ? (
                    <TerminalEmptyState title="您没有敞口头寸。" detail="" />
                  ) : currentPositionsForDisplay.length === 0 ? (
                    <TerminalEmptyState title="您没有敞口头寸。" detail="" />
                  ) : (
                    <>
                    {/* Desktop Position Table */}
                    {/* 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?                        Desktop Position Table (Binance Futures-grade layout)
                        鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?*/}
                    <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs min-w-[1100px]">
                      <thead>
                        <tr className="text-okx-text-tertiary text-[11px]">
                          <th className="text-left py-2 px-4 font-normal">{t("pair") || "Symbol"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("size") || "Size"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("entryAvg") || "Entry Price"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("markPrice") || "Mark Price"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("liqPrice") || "Liq. Price"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("margin") || "Margin"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("marginRatio") || "Margin Ratio"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("unrealizedPnl") || "PnL (ROE%)"}</th>
                          <th className="text-left py-2 px-4 font-normal">{t("action") || "Close Position"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentPositionsForDisplay.map((pos) => {
                          const sizeETH = parseFloat(String(pos.size)) / 1e18;
                          const entryPrice = parseFloat(String(pos.entryPrice)) / 1e18;
                          const serverMarkPrice = parseFloat(String(pos.markPrice || pos.entryPrice)) / 1e18;
                          const markPrice = chartPrice && chartPrice > 0 ? chartPrice : serverMarkPrice;
                          const liqPrice = parseFloat(String(pos.liquidationPrice || "0")) / 1e18;
                          const marginETH = parseFloat(String(pos.collateral)) / 1e18;
                          const leverage = parseFloat(String(pos.leverage));
                          const mmr = parseFloat(String(pos.mmr || "200")) / 100;
                          const pnlDelta = entryPrice > 0 ? sizeETH * Math.abs(markPrice - entryPrice) / entryPrice : 0;
                          const hasProfit = pos.isLong ? (markPrice > entryPrice) : (entryPrice > markPrice);
                          const unrealizedPnlETH = hasProfit ? pnlDelta : -pnlDelta;
                          const equity = marginETH + unrealizedPnlETH;
                          const maintenanceMargin = sizeETH * (mmr / 100);
                          const marginRatio = equity > 0 ? (maintenanceMargin / equity) * 100 : 999;
                          const roe = marginETH > 0 ? (unrealizedPnlETH / marginETH) * 100 : 0;
                          const tokenAmount = markPrice > 0 ? sizeETH / markPrice : 0;
                          const riskLevel = marginRatio > 50 ? 3 : marginRatio > 30 ? 2 : marginRatio > 15 ? 1 : 0;
                          const riskBarColor = riskLevel >= 3 ? "bg-red-500" : riskLevel >= 2 ? "bg-orange-500" : riskLevel >= 1 ? "bg-yellow-500" : "bg-green-500";
                          const riskBarWidth = Math.min(marginRatio, 100);

                          return (
                            <tr key={pos.pairId} className="border-b border-[#1E2329] hover:bg-white/[0.02] transition-colors h-16">
                              {/* 鈹€鈹€ Symbol: 甯佸鍚?+ 鏂瑰悜/妯″紡/鏉犳潌 鏍囩缁?鈹€鈹€ */}
                              <td className="py-3 px-4">
                                <div className="flex flex-col gap-1.5">
                                  <span className="text-[#EAECEF] font-semibold text-[13px]">{instId} Perpetual</span>
                                  <div className="flex items-center gap-1.5">
                                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-bold ${
                                      pos.isLong
                                        ? "bg-[#0ECB81]/[0.13] text-[#0ECB81]"
                                        : "bg-[#F6465D]/[0.13] text-[#F6465D]"
                                    }`}>
                                      {pos.isLong ? t("long") || "Long" : t("short") || "Short"}
                                    </span>
                                    <span className="text-[10px] text-[#888888] px-1.5 py-0.5 rounded-sm border border-[#474D57]">
                                      Isolated
                                    </span>
                                    <span className="text-[10px] text-[#F0B90B] px-1.5 py-0.5 rounded-sm border border-[#474D57]">
                                      {leverage}x
                                    </span>
                                  </div>
                                </div>
                              </td>

                              {/* 鈹€鈹€ Size: BNB 鍚嶄箟鍊?+ USD 绛変环 鈹€鈹€ */}
                              <td className="py-3 px-3">
                                <div className="text-[#EAECEF] text-[13px]">
                                  {sizeETH >= 1 ? sizeETH.toFixed(4) : sizeETH.toFixed(6)} BNB
                                </div>
                                <div className="text-[11px] text-[#555555] mt-0.5">
                                  鈮?${(sizeETH * 250).toFixed(2)}
                                </div>
                              </td>

                              {/* 鈹€鈹€ Entry Price 鈹€鈹€ */}
                              <td className="py-3 px-3 font-mono text-[#EAECEF] text-[13px]">
                                {formatSmallPrice(entryPrice)}
                              </td>

                              {/* 鈹€鈹€ Mark Price 鈹€鈹€ */}
                              <td className="py-3 px-3 font-mono text-[#888888] text-[13px]">
                                {formatSmallPrice(markPrice)}
                              </td>

                              {/* 鈹€鈹€ Liq. Price (璀﹀憡榛勮壊) 鈹€鈹€ */}
                              <td className="py-3 px-3 font-mono text-[#F0B90B] text-[13px]">
                                {formatSmallPrice(liqPrice)}
                              </td>

                              {/* 鈹€鈹€ Margin + 缂栬緫鎸夐挳 鈹€鈹€ */}
                              <td className="py-3 px-3">
                                <div className="flex items-center gap-2">
                                  <span className="text-[#EAECEF] text-[13px]">
                                    {marginETH >= 1 ? marginETH.toFixed(4) : marginETH.toFixed(5)} BNB
                                  </span>
                                  <button
                                    onClick={() => setMarginModal({
                                      pairId: pos.pairId, action: "add", collateral: marginETH,
                                      size: sizeETH, entryPrice, isLong: pos.isLong, leverage, mmr,
                                    })}
                                    className="w-[22px] h-[22px] flex items-center justify-center rounded border border-[#363C45] hover:border-[#474D57] hover:bg-white/[0.04] transition-colors group"
                                    title={t("adjustMargin") || "Adjust Margin"}
                                  >
                                    <svg className="w-3 h-3 text-[#555555] group-hover:text-[#EAECEF] transition-colors" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
                                    </svg>
                                  </button>
                                </div>
                              </td>

                              {/* 鈹€鈹€ Margin Ratio + 杩涘害鏉?鈹€鈹€ */}
                              <td className="py-3 px-3">
                                <div className="flex flex-col gap-1.5">
                                  <span className={`text-[13px] font-semibold ${
                                    riskLevel >= 3 ? "text-[#F6465D]" : riskLevel >= 2 ? "text-orange-400" : "text-[#0ECB81]"
                                  }`}>
                                    {marginRatio.toFixed(1)}%
                                  </span>
                                  <div className="w-[70px] h-[5px] bg-[#1E2329] rounded-sm overflow-hidden">
                                    <div className={`h-full rounded-sm transition-all ${riskBarColor}`} style={{ width: `${riskBarWidth}%` }} />
                                  </div>
                                </div>
                              </td>

                              {/* 鈹€鈹€ PnL (ROE%) 鈹€鈹€ */}
                              <td className="py-3 px-3">
                                <div className={`text-[14px] font-bold ${unrealizedPnlETH >= 0 ? "text-[#0ECB81]" : "text-[#F6465D]"}`}>
                                  {unrealizedPnlETH >= 0 ? "+" : ""}{Math.abs(unrealizedPnlETH) >= 1 ? unrealizedPnlETH.toFixed(4) : unrealizedPnlETH.toFixed(6)} BNB
                                </div>
                                <div className={`text-[11px] mt-0.5 ${roe >= 0 ? "text-[#0ECB81]/70" : "text-[#F6465D]/70"}`}>
                                  {roe >= 0 ? "+" : ""}{roe.toFixed(2)}%
                                </div>
                              </td>

                              {/* 鈹€鈹€ Close Position: Market + Limit 鎸夐挳 鈹€鈹€ */}
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2.5">
                                  <button
                                    onClick={async () => {
                                      showToast(t("closingPosition") || "Closing position...", "info");
                                      const result = await closePair(pos.pairId);
                                      if (result.success) {
                                        showToast("Position closed!", "success");
                                        refreshPositions();
                                        loadHistoryData();
                                        fetchBills();
                                      } else {
                                        showToast(result.error || "Failed to close", "error");
                                      }
                                    }}
                                    className="h-8 px-4 text-[12px] font-semibold text-[#EAECEF] bg-[#2B3139] border border-[#474D57] hover:bg-[#363C45] rounded transition-colors"
                                  >
                                    Market
                                  </button>
                                  <button
                                    onClick={() => setTpslModal({
                                      pairId: pos.pairId, isLong: pos.isLong, entryPrice, liqPrice,
                                    })}
                                    className="h-8 px-4 text-[12px] text-[#888888] border border-[#363C45] hover:border-[#474D57] hover:text-[#EAECEF] rounded transition-colors"
                                  >
                                    Limit
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>

                    {/* 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
                        Mobile Position Cards
                        鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?*/}
                    <div className="md:hidden space-y-2 p-2">
                      {currentPositionsForDisplay.map((pos) => {
                        const sizeETH = parseFloat(String(pos.size)) / 1e18;
                        const entryPrice = parseFloat(String(pos.entryPrice)) / 1e18;
                        const serverMarkPrice = parseFloat(String(pos.markPrice || pos.entryPrice)) / 1e18;
                        const markPrice = chartPrice && chartPrice > 0 ? chartPrice : serverMarkPrice;
                        const liqPrice = parseFloat(String(pos.liquidationPrice || "0")) / 1e18;
                        const marginETH = parseFloat(String(pos.collateral)) / 1e18;
                        const leverage = parseFloat(String(pos.leverage));
                        const mmr = parseFloat(String(pos.mmr || "200")) / 100;
                        const pnlDelta = entryPrice > 0 ? sizeETH * Math.abs(markPrice - entryPrice) / entryPrice : 0;
                        const hasProfit = pos.isLong ? (markPrice > entryPrice) : (entryPrice > markPrice);
                        const unrealizedPnlETH = hasProfit ? pnlDelta : -pnlDelta;
                        const equity = marginETH + unrealizedPnlETH;
                        const maintenanceMargin = sizeETH * (mmr / 100);
                        const marginRatio = equity > 0 ? (maintenanceMargin / equity) * 100 : 999;
                        const roe = marginETH > 0 ? (unrealizedPnlETH / marginETH) * 100 : 0;
                        const riskLevel = marginRatio > 50 ? 3 : marginRatio > 30 ? 2 : marginRatio > 15 ? 1 : 0;
                        const riskBarColor = riskLevel >= 3 ? "bg-red-500" : riskLevel >= 2 ? "bg-orange-500" : riskLevel >= 1 ? "bg-yellow-500" : "bg-green-500";

                        return (
                          <div key={pos.pairId} className="bg-okx-bg-secondary/50 rounded-lg p-3 border border-okx-border-primary/50">
                            {/* Header: Direction + Symbol + Leverage */}
                            <div className="flex items-center justify-between mb-2.5">
                              <div className="flex items-center gap-1.5">
                                <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  pos.isLong
                                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                    : "bg-rose-500/15 text-rose-400 border border-rose-500/20"
                                }`}>
                                  {pos.isLong ? "▲" : "▼"} {pos.isLong ? t("long") : t("short")}
                                </span>
                                <span className="text-okx-text-primary text-xs font-medium">{instId}</span>
                                <span className="text-[10px] text-amber-400/80 font-medium">{leverage}x</span>
                              </div>
                              {/* PnL badge */}
                              <div className={`text-xs font-semibold ${unrealizedPnlETH >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                {unrealizedPnlETH >= 0 ? "+" : ""}{Math.abs(unrealizedPnlETH).toFixed(6)} BNB
                                <span className="text-[10px] ml-1 opacity-70">({roe >= 0 ? "+" : ""}{roe.toFixed(2)}%)</span>
                              </div>
                            </div>
                            {/* Data Grid */}
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                              <div className="flex justify-between">
                                <span className="text-okx-text-tertiary">{t("size")}</span>
                                <span className="text-okx-text-primary font-medium">{sizeETH >= 1 ? sizeETH.toFixed(4) : sizeETH.toFixed(6)}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-okx-text-tertiary">{t("margin")}</span>
                                <div className="flex items-center gap-1">
                                  <span className="text-okx-text-primary">{marginETH >= 1 ? marginETH.toFixed(4) : marginETH.toFixed(5)}</span>
                                  <button
                                    onClick={() => setMarginModal({
                                      pairId: pos.pairId, action: "add", collateral: marginETH, size: sizeETH,
                                      entryPrice, isLong: pos.isLong, leverage, mmr,
                                    })}
                                    className="p-0.5 rounded hover:bg-white/[0.06] transition-colors"
                                  >
                                    <svg className="w-2.5 h-2.5 text-okx-text-tertiary hover:text-okx-brand-primary" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-okx-text-tertiary">{t("entryAvg")}</span>
                                <span className="text-okx-text-primary font-mono">{formatSmallPrice(entryPrice)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-okx-text-tertiary">{t("markPrice")}</span>
                                <span className="text-okx-text-secondary font-mono">{formatSmallPrice(markPrice)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-okx-text-tertiary">{t("liqPrice")}</span>
                                <span className={`font-mono ${pos.isLong ? "text-rose-400/80" : "text-emerald-400/80"}`}>{formatSmallPrice(liqPrice)}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-okx-text-tertiary">{t("marginRatio")}</span>
                                <div className="flex items-center gap-1">
                                  <div className="w-8 h-1 bg-okx-bg-tertiary rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full ${riskBarColor}`} style={{ width: `${Math.min(marginRatio, 100)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-okx-text-secondary">{marginRatio.toFixed(1)}%</span>
                                </div>
                              </div>
                            </div>
                            {/* Action buttons */}
                            <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-okx-border-primary/30">
                              <button
                                onClick={async () => {
                                  showToast(t("closingPosition") || "Closing position...", "info");
                                  const result = await closePair(pos.pairId);
                                  if (result.success) { showToast("Position closed!", "success"); refreshPositions(); loadHistoryData(); fetchBills(); }
                                  else { showToast(result.error || "Failed to close", "error"); }
                                }}
                                className="flex-1 py-1.5 text-[10px] font-medium text-rose-400 border border-rose-500/30 rounded hover:bg-rose-500/10 transition-colors"
                              >{t("closePosition")}</button>
                              <button
                                onClick={() => setTpslModal({
                                  pairId: pos.pairId, isLong: pos.isLong, entryPrice, liqPrice,
                                })}
                                className="py-1.5 px-2.5 text-[10px] text-okx-text-tertiary border border-okx-border-primary/50 rounded hover:text-amber-400 hover:border-amber-500/30 transition-colors"
                              >
                                TP/SL
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* Open Orders Table - V2 寰呭鐞嗚鍗?(琛屼笟鏍囧噯 UI) */}
              {activeBottomTab === "openOrders" && (
                <div className="p-2 md:p-4">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : v2PendingOrders.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noOrders")}
                    </div>
                  ) : (
                    <>
                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs min-w-[900px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">{t("orderId")}</th>
                          <th className="text-left py-2 px-1">{t("time")}</th>
                          <th className="text-left py-2 px-1">{t("pair")}</th>
                          <th className="text-left py-2 px-1">{t("type")}</th>
                          <th className="text-left py-2 px-1">{t("direction")}</th>
                          <th className="text-right py-2 px-1">{t("leverage")}</th>
                          <th className="text-right py-2 px-1">{t("orderPrice")}</th>
                          <th className="text-right py-2 px-1">{t("orderQty")}</th>
                          <th className="text-right py-2 px-1">{t("avgFillPrice")}</th>
                          <th className="text-right py-2 px-1">{t("filledTotal")}</th>
                          <th className="text-right py-2 px-1">{t("margin")}</th>
                          <th className="text-right py-2 px-1">{t("fee")}</th>
                          <th className="text-center py-2 px-1">{t("statusLabel")}</th>
                          <th className="text-right py-2 px-1">{t("action")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v2PendingOrders.map((order) => {
                          // 鏍煎紡鍖栨樉绀烘暟鎹?
                          // size 鏄?Meme 浠ｅ竵鏁伴噺 (1e18 绮惧害)
                          const sizeTokenRaw = Number(order.size) / 1e18;
                          const sizeDisplay = sizeTokenRaw >= 1000000
                            ? `${(sizeTokenRaw / 1000000).toFixed(2)}M`
                            : sizeTokenRaw >= 1000
                            ? `${(sizeTokenRaw / 1000).toFixed(2)}K`
                            : sizeTokenRaw.toFixed(2);
                          const filledTokenRaw = Number(order.filledSize) / 1e18;
                          const filledDisplay = filledTokenRaw >= 1000000
                            ? `${(filledTokenRaw / 1000000).toFixed(2)}M`
                            : filledTokenRaw >= 1000
                            ? `${(filledTokenRaw / 1000).toFixed(2)}K`
                            : filledTokenRaw.toFixed(2);
                          // price 鏄?1e18 绮惧害 (BNB 鏈綅: Token/BNB)
                          const priceRaw = Number(order.price) / 1e18;
                          const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                          const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                          const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0"
                            ? formatSmallPrice(avgPriceRaw)
                            : "--";
                          const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                          // margin (BNB, 1e18 precision)
                          const marginBnb = order.margin ? Number(order.margin) / 1e18 : 0;
                          const marginDisplay = order.margin
                            ? `BNB ${marginBnb >= 1 ? marginBnb.toFixed(4) : marginBnb.toFixed(6)}`
                            : "--";
                          const feeBnb = order.fee && order.fee !== "0" ? Number(order.fee) / 1e18 : 0;
                          const feeDisplay = feeBnb > 0
                            ? `BNB ${feeBnb >= 0.0001 ? feeBnb.toFixed(6) : feeBnb.toFixed(8)}`
                            : "--";
                          const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                          const fillPercent = Number(order.size) > 0
                            ? ((Number(order.filledSize) / Number(order.size)) * 100).toFixed(1)
                            : "0";
                          const timeDisplay = new Date(order.createdAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          });

                          return (
                            <tr key={order.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              {/* 璁㈠崟鍙?*/}
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-xs">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors"
                                  title={t("copyOrderId")}
                                  onClick={() => {
                                    navigator.clipboard.writeText(order.id);
                                  }}
                                >
                                  {order.id} <svg className="w-3 h-3 inline-block ml-1" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.375a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                                </span>
                              </td>

                              {/* Time */}
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>

                              {/* Pair */}
                              <td className="py-2 px-1 font-medium">
                                {instId}
                              </td>

                              {/* 璁㈠崟绫诲瀷 */}
                              <td className="py-2 px-1">
                                <span className="bg-okx-bg-secondary px-1.5 py-0.5 rounded text-xs">
                                  {orderTypeDisplay}
                                </span>
                              </td>

                              {/* 鏂瑰悜 */}
                              <td className={`py-2 px-1 font-medium ${order.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {order.isLong ? t("long") : t("short")}
                              </td>

                              {/* 鏉犳潌 */}
                              <td className="py-2 px-1 text-right text-yellow-400">{leverageDisplay}</td>

                              {/* 濮旀墭浠?*/}
                              <td className="py-2 px-1 text-right font-mono">{priceDisplay}</td>

                              {/* 濮旀墭閲?(浠ｅ竵鏁伴噺) */}
                              <td className="py-2 px-1 text-right">{sizeDisplay}</td>

                              {/* 鎴愪氦鍧囦环 */}
                              <td className="py-2 px-1 text-right font-mono">{avgPriceDisplay}</td>

                              {/* 宸叉垚浜?鎬婚噺 + 杩涘害 */}
                              <td className="py-2 px-1 text-right">
                                <div className="flex flex-col items-end">
                                  <span>{filledDisplay}/{sizeDisplay}</span>
                                  <span className="text-xs text-okx-text-tertiary">{fillPercent}%</span>
                                </div>
                              </td>

                              {/* 淇濊瘉閲?*/}
                              <td className="py-2 px-1 text-right">{marginDisplay}</td>

                              {/* 鎵嬬画璐?*/}
                              <td className="py-2 px-1 text-right text-okx-text-secondary">{feeDisplay}</td>

                              {/* 鐘舵€?*/}
                              <td className="py-2 px-1 text-center">
                                <span className={`px-2 py-0.5 rounded text-xs ${
                                  order.status === "PARTIALLY_FILLED"
                                    ? "text-blue-400 bg-blue-900/30"
                                    : "text-yellow-400 bg-yellow-900/30"
                                }`}>
                                  {order.status === "PARTIALLY_FILLED" ? t("partialFilledStatus") : t("waitingStatus")}
                                </span>
                              </td>

                              {/* 鎿嶄綔 */}
                              <td className="py-2 px-1 text-right">
                                <button
                                  className={`text-xs ${
                                    cancellingOrderId === order.id
                                      ? "text-okx-text-tertiary cursor-not-allowed"
                                      : "text-okx-down hover:underline"
                                  }`}
                                  disabled={cancellingOrderId === order.id}
                                  onClick={() => handleCancelOrder(order.id)}
                                >
                                  {cancellingOrderId === order.id ? t("cancelling") : t("cancelOrder")}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                    {/* Mobile Open Order Cards */}
                    <div className="md:hidden space-y-2">
                      {v2PendingOrders.map((order) => {
                        const sizeTokenRaw = Number(order.size) / 1e18;
                        const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                        const priceRaw = Number(order.price) / 1e18;
                        const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                        const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                        const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0" ? formatSmallPrice(avgPriceRaw) : "--";
                        const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                        const marginBnb = order.margin ? Number(order.margin) / 1e18 : 0;
                        const marginDisplay = order.margin ? `BNB ${marginBnb >= 1 ? marginBnb.toFixed(4) : marginBnb.toFixed(6)}` : "--";
                        const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                        const fillPercent = Number(order.size) > 0 ? ((Number(order.filledSize) / Number(order.size)) * 100).toFixed(1) : "0";
                        const timeDisplay = new Date(order.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                        return (
                          <div key={order.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${order.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                  {order.isLong ? t("long") : t("short")}
                                </span>
                                <span className="bg-okx-bg-tertiary px-1.5 py-0.5 rounded text-xs text-okx-text-secondary">{orderTypeDisplay}</span>
                                <span className="text-yellow-400 text-xs">{leverageDisplay}</span>
                              </div>
                              <button
                                className={`text-xs px-2.5 py-1 rounded ${cancellingOrderId === order.id ? "text-okx-text-tertiary bg-okx-bg-tertiary cursor-not-allowed" : "text-red-400 bg-red-900/50"}`}
                                disabled={cancellingOrderId === order.id}
                                onClick={() => handleCancelOrder(order.id)}
                              >{cancellingOrderId === order.id ? t("cancelling") : t("cancelOrder")}</button>
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("orderPrice")}</span><span className="text-okx-text-primary font-mono">{priceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("avgPrice")}</span><span className="text-okx-text-secondary font-mono">{avgPriceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span className="text-okx-text-primary">{sizeDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("margin")}</span><span className="text-okx-text-primary">{marginDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("filled")}</span><span className="text-okx-text-secondary">{fillPercent}%</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("time")}</span><span className="text-okx-text-secondary">{timeDisplay}</span></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* Order History - 浣跨敤鏂扮殑 API 鑾峰彇鍘嗗彶璁㈠崟 */}
              {activeBottomTab === "orderHistory" && (
                <div className="p-2 md:p-4">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : isLoadingHistory ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      <div className="animate-spin w-6 h-6 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                      {t("billLoading")}
                    </div>
                  ) : orderHistoryData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noOrders")}
                    </div>
                  ) : (
                    <>
                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs min-w-[800px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">{t("orderId")}</th>
                          <th className="text-left py-2 px-1">{t("time")}</th>
                          <th className="text-left py-2 px-1">{t("pair")}</th>
                          <th className="text-left py-2 px-1">{t("type")}</th>
                          <th className="text-left py-2 px-1">{t("direction")}</th>
                          <th className="text-right py-2 px-1">{t("leverage")}</th>
                          <th className="text-right py-2 px-1">{t("orderPrice")}</th>
                          <th className="text-right py-2 px-1">{t("avgFillPrice")}</th>
                          <th className="text-right py-2 px-1">{t("orderQty")}</th>
                          <th className="text-right py-2 px-1">{t("filledQty")}</th>
                          <th className="text-center py-2 px-1">{t("statusLabel")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orderHistoryData.map((order) => {
                          const sizeTokenRaw = Number(order.size) / 1e18;
                          const sizeDisplay = sizeTokenRaw >= 1000000
                            ? `${(sizeTokenRaw / 1000000).toFixed(2)}M`
                            : sizeTokenRaw >= 1000
                            ? `${(sizeTokenRaw / 1000).toFixed(2)}K`
                            : sizeTokenRaw.toFixed(2);
                          const filledTokenRaw = Number(order.filledSize) / 1e18;
                          const filledDisplay = filledTokenRaw >= 1000000
                            ? `${(filledTokenRaw / 1000000).toFixed(2)}M`
                            : filledTokenRaw >= 1000
                            ? `${(filledTokenRaw / 1000).toFixed(2)}K`
                            : filledTokenRaw.toFixed(2);
                          // BNB denomination: price in 1e18 precision (Token/BNB)
                          const priceRaw = Number(order.price) / 1e18;
                          const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                          const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                          const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0"
                            ? formatSmallPrice(avgPriceRaw)
                            : "--";
                          const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                          const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                          const statusDisplay = order.status === "FILLED" ? t("statusFilled")
                            : order.status === "CANCELLED" ? t("statusCancelled")
                            : order.status === "EXPIRED" ? t("statusExpired")
                            : order.status === "LIQUIDATED" ? t("statusLiquidated")
                            : order.status === "ADL" ? t("statusAdl")
                            : order.status === "CLOSED" ? t("statusClosed")
                            : order.status;
                          const statusColor = order.status === "FILLED" ? "text-green-400 bg-green-900/30"
                            : order.status === "CANCELLED" ? "text-gray-400 bg-gray-900/30"
                            : order.status === "LIQUIDATED" ? "text-red-400 bg-red-900/30"
                            : order.status === "ADL" ? "text-orange-400 bg-orange-900/30"
                            : order.status === "CLOSED" ? "text-blue-400 bg-blue-900/30"
                            : "text-orange-400 bg-orange-900/30";
                          const timeDisplay = new Date(order.updatedAt).toLocaleString(undefined, {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          });

                          return (
                            <tr key={order.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-xs">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors"
                                  title={t("copyOrderId")}
                                  onClick={() => {
                                    navigator.clipboard.writeText(order.id);
                                  }}
                                >
                                  {order.id} <svg className="w-3 h-3 inline-block ml-1" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.375a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                                </span>
                              </td>
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>
                              <td className="py-2 px-1 font-medium">{instId}</td>
                              <td className="py-2 px-1">
                                <span className="bg-okx-bg-secondary px-1.5 py-0.5 rounded text-xs">
                                  {orderTypeDisplay}
                                </span>
                              </td>
                              <td className={`py-2 px-1 font-medium ${order.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {order.isLong ? t("long") : t("short")}
                              </td>
                              <td className="py-2 px-1 text-right text-yellow-400">{leverageDisplay}</td>
                              <td className="py-2 px-1 text-right font-mono">{priceDisplay}</td>
                              <td className="py-2 px-1 text-right font-mono">{avgPriceDisplay}</td>
                              <td className="py-2 px-1 text-right">{sizeDisplay}</td>
                              <td className="py-2 px-1 text-right">{filledDisplay}</td>
                              <td className="py-2 px-1 text-center">
                                <span className={`px-2 py-0.5 rounded text-xs ${statusColor}`}>
                                  {statusDisplay}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                    {/* Mobile Order History Cards */}
                    <div className="md:hidden space-y-2">
                      {orderHistoryData.map((order) => {
                        const sizeTokenRaw = Number(order.size) / 1e18;
                        const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                        const filledTokenRaw = Number(order.filledSize) / 1e18;
                        const filledDisplay = filledTokenRaw >= 1000000 ? `${(filledTokenRaw / 1000000).toFixed(2)}M` : filledTokenRaw >= 1000 ? `${(filledTokenRaw / 1000).toFixed(2)}K` : filledTokenRaw.toFixed(2);
                        const priceRaw = Number(order.price) / 1e18;
                        const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                        const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                        const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0" ? formatSmallPrice(avgPriceRaw) : "--";
                        const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                        const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                        const statusDisplay = order.status === "FILLED" ? t("statusFilled") : order.status === "CANCELLED" ? t("statusCancelled") : order.status === "EXPIRED" ? t("statusExpired") : order.status === "LIQUIDATED" ? t("statusLiquidated") : order.status === "ADL" ? t("statusAdl") : order.status === "CLOSED" ? t("statusClosed") : order.status;
                        const statusColor = order.status === "FILLED" ? "text-green-400 bg-green-900/30" : order.status === "CANCELLED" ? "text-gray-400 bg-gray-900/30" : order.status === "LIQUIDATED" ? "text-red-400 bg-red-900/30" : order.status === "ADL" ? "text-orange-400 bg-orange-900/30" : order.status === "CLOSED" ? "text-blue-400 bg-blue-900/30" : "text-orange-400 bg-orange-900/30";
                        const timeDisplay = new Date(order.updatedAt).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
                        return (
                          <div key={order.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${order.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                  {order.isLong ? t("long") : t("short")}
                                </span>
                                <span className="bg-okx-bg-tertiary px-1.5 py-0.5 rounded text-xs text-okx-text-secondary">{orderTypeDisplay}</span>
                                <span className="text-yellow-400 text-xs">{leverageDisplay}</span>
                              </div>
                              <span className={`px-2 py-0.5 rounded text-xs ${statusColor}`}>{statusDisplay}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("orderPrice")}</span><span className="text-okx-text-primary font-mono">{priceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("avgPrice")}</span><span className="text-okx-text-secondary font-mono">{avgPriceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span className="text-okx-text-primary">{filledDisplay}/{sizeDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("time")}</span><span className="text-okx-text-secondary">{timeDisplay}</span></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* Trade History - 浣跨敤鏂扮殑 API 鑾峰彇鎴愪氦璁板綍 */}
              {activeBottomTab === "tradeHistory" && (
                <div className="p-2 md:p-4">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : isLoadingHistory ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      <div className="animate-spin w-6 h-6 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                      {t("billLoading")}
                    </div>
                  ) : tradeHistoryData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noTradeRecords")}
                    </div>
                  ) : (
                    <>
                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs min-w-[800px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">{t("orderId")}</th>
                          <th className="text-left py-2 px-1">{t("time")}</th>
                          <th className="text-left py-2 px-1">{t("pair")}</th>
                          <th className="text-left py-2 px-1">{t("direction")}</th>
                          <th className="text-left py-2 px-1">{t("roleLabel")}</th>
                          <th className="text-right py-2 px-1">{t("fillPrice")}</th>
                          <th className="text-right py-2 px-1">{t("filledQty")}</th>
                          <th className="text-right py-2 px-1">{t("fee")}</th>
                          <th className="text-right py-2 px-1">{t("realizedPnl")}</th>
                          <th className="text-center py-2 px-1">{t("type")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tradeHistoryData.map((trade) => {
                          const sizeTokenRaw = Number(trade.size) / 1e18;
                          const sizeDisplay = sizeTokenRaw >= 1000000
                            ? `${(sizeTokenRaw / 1000000).toFixed(2)}M`
                            : sizeTokenRaw >= 1000
                            ? `${(sizeTokenRaw / 1000).toFixed(2)}K`
                            : sizeTokenRaw.toFixed(2);
                          // BNB 鏈綅: 1e18 绮惧害
                          const priceRaw = Number(trade.price) / 1e18;
                          const priceDisplay = formatSmallPrice(priceRaw);
                          const feeETH = Number(trade.fee) / 1e18;
                          const feeDisplay = `BNB ${feeETH >= 0.0001 ? feeETH.toFixed(6) : feeETH.toFixed(8)}`;
                          const pnlETH = Number(trade.realizedPnL) / 1e18;
                          const pnlDisplay = pnlETH !== 0
                            ? `${pnlETH >= 0 ? "+" : ""}BNB ${Math.abs(pnlETH) >= 1 ? Math.abs(pnlETH).toFixed(4) : Math.abs(pnlETH).toFixed(6)}`
                            : "--";
                          const roleDisplay = trade.isMaker ? "Maker" : "Taker";
                          const typeDisplay = trade.type === "liquidation" ? t("liquidationLabel")
                            : trade.type === "adl" ? "ADL"
                            : trade.type === "close" ? t("closeTrade") : t("openTrade");
                          const typeColor = trade.type === "liquidation" ? "text-red-400 bg-red-900/30"
                            : trade.type === "adl" ? "text-orange-400 bg-orange-900/30"
                            : trade.type === "close" ? "text-blue-400 bg-blue-900/30"
                            : "text-green-400 bg-green-900/30";
                          const timeDisplay = new Date(trade.timestamp).toLocaleString(undefined, {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          });

                          return (
                            <tr key={trade.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-xs max-w-[160px]">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors truncate block"
                                  title={trade.orderId || trade.id}
                                  onClick={() => {
                                    navigator.clipboard.writeText(trade.orderId || trade.id);
                                  }}
                                >
                                  {(trade.orderId || trade.id).length > 24 ? `${(trade.orderId || trade.id).slice(0, 20)}...` : (trade.orderId || trade.id)} <svg className="w-3 h-3 inline-block ml-1" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.375a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                                </span>
                              </td>
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>
                              <td className="py-2 px-1 font-medium">{instId}</td>
                              <td className={`py-2 px-1 font-medium ${trade.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {trade.isLong ? t("long") : t("short")}
                              </td>
                              <td className="py-2 px-1">
                                <span className={`text-xs ${trade.isMaker ? "text-purple-400" : "text-blue-400"}`}>
                                  {roleDisplay}
                                </span>
                              </td>
                              <td className="py-2 px-1 text-right font-mono">{priceDisplay}</td>
                              <td className="py-2 px-1 text-right">{sizeDisplay}</td>
                              <td className="py-2 px-1 text-right text-okx-text-secondary">{feeDisplay}</td>
                              <td className={`py-2 px-1 text-right font-medium ${pnlETH >= 0 ? "text-green-400" : "text-red-400"}`}>
                                {pnlDisplay}
                              </td>
                              <td className="py-2 px-1 text-center">
                                <span className={`px-2 py-0.5 rounded text-xs ${typeColor}`}>
                                  {typeDisplay}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                    {/* Mobile Trade History Cards */}
                    <div className="md:hidden space-y-2">
                      {tradeHistoryData.map((trade) => {
                        const sizeTokenRaw = Number(trade.size) / 1e18;
                        const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                        const priceRaw = Number(trade.price) / 1e18;
                        const priceDisplay = formatSmallPrice(priceRaw);
                        const feeETH = Number(trade.fee) / 1e18;
                        const feeDisplay = `BNB ${feeETH >= 0.0001 ? feeETH.toFixed(6) : feeETH.toFixed(8)}`;
                        const pnlETH = Number(trade.realizedPnL) / 1e18;
                        const pnlDisplay = pnlETH !== 0 ? `${pnlETH >= 0 ? "+" : ""}BNB ${Math.abs(pnlETH) >= 1 ? Math.abs(pnlETH).toFixed(4) : Math.abs(pnlETH).toFixed(6)}` : "--";
                        const typeDisplay = trade.type === "liquidation" ? t("liquidationLabel") : trade.type === "adl" ? "ADL" : trade.type === "close" ? t("closeTrade") : t("openTrade");
                        const typeColor = trade.type === "liquidation" ? "text-red-400 bg-red-900/30" : trade.type === "adl" ? "text-orange-400 bg-orange-900/30" : trade.type === "close" ? "text-blue-400 bg-blue-900/30" : "text-green-400 bg-green-900/30";
                        const timeDisplay = new Date(trade.timestamp).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
                        return (
                          <div key={trade.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${trade.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                  {trade.isLong ? t("long") : t("short")}
                                </span>
                                <span className={`px-2 py-0.5 rounded text-xs ${typeColor}`}>{typeDisplay}</span>
                                <span className={`text-xs ${trade.isMaker ? "text-purple-400" : "text-blue-400"}`}>{trade.isMaker ? "Maker" : "Taker"}</span>
                              </div>
                              <span className="text-okx-text-tertiary text-xs">{timeDisplay}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fillPrice")}</span><span className="text-okx-text-primary font-mono">{priceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span className="text-okx-text-primary">{sizeDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fee")}</span><span className="text-okx-text-secondary">{feeDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("pnl")}</span><span className={`font-medium ${pnlETH >= 0 ? "text-green-400" : "text-red-400"}`}>{pnlDisplay}</span></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* Hunting Arena - 鐚庢潃鍦?*/}
              {activeBottomTab === "hunting" && (
                <div className="p-2 h-full overflow-y-auto">
                  {/* 涓ゅ垪甯冨眬锛氬乏杈圭儹鍔涘浘+鎺掕姒滐紝鍙宠竟鎸佷粨鍒楄〃 (mobile: stacked) */}
                  <div className="flex flex-col lg:flex-row gap-3 h-full">
                    {/* 宸︿晶锛氱儹鍔涘浘 + 鐚庢墜鎺掕姒?*/}
                    <div className="w-full lg:w-[420px] flex-shrink-0 flex flex-col gap-3">
                      {/* 娓呯畻鐑姏鍥?*/}
                      <div className="flex-shrink-0">
                        <LiquidationHeatmap token={symbol} />
                      </div>
                      {/* 鐚庢潃鎺掕姒?*/}
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <HunterLeaderboard token={symbol} />
                      </div>
                    </div>
                    {/* 鍙充晶锛氬叏灞€鎸佷粨鍒楄〃 (鍗犳嵁鍓╀綑绌洪棿) */}
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <AllPositions token={symbol} />
                    </div>
                  </div>
                </div>
              )}

              {/* Risk Control Panel - 椋庨櫓鎺у埗 */}
              {activeBottomTab === "risk" && (
                <div className="p-4 h-full overflow-y-auto">
                  <RiskPanel
                    trader={tradingWalletAddress || address}
                    token={tokenAddress}
                  />
                </div>
              )}

              {/* Bills - 璐﹀崟 */}
              {activeBottomTab === "bills" && (
                <div className="p-2 h-full overflow-y-auto">
                  {/* 绫诲瀷绛涢€?*/}
                  <div className="flex items-center gap-1.5 mb-3 flex-wrap px-1">
                    {BILL_TYPE_FILTERS.map((f) => (
                      <button
                        key={f.value}
                        onClick={() => setBillTypeFilter(f.value)}
                        className={`px-2.5 py-0.5 rounded-full text-xs transition-colors ${
                          billTypeFilter === f.value
                            ? "bg-meme-lime/20 text-meme-lime border border-meme-lime/40"
                            : "text-okx-text-tertiary border border-okx-border-primary hover:text-okx-text-secondary"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  {/* 鍒楄〃 */}
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8 text-xs">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : billsLoading && billsData.length === 0 ? (
                    <div className="flex justify-center py-8">
                      <div className="w-5 h-5 border-2 border-meme-lime border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : billsData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8 text-xs">
                      {t("billEmpty")}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {billsData.map((bill) => {
                        const typeMeta = BILL_TYPE_LABELS[bill.type] || { label: bill.type, color: "" };
                        // BNB 鏈綅: 1e18 绮惧害
                        const balanceAfterETH = parseFloat(formatUnits(BigInt(bill.balanceAfter), 18));
                        const rawValueETH = parseFloat(formatUnits(BigInt(bill.amount), 18));
                        // 鏍规嵁閲戦绗﹀彿鍐冲畾棰滆壊 (SETTLE_PNL/FUNDING_FEE 鐨?amount 鏄湁绗﹀彿鐨?
                        const isPositive = rawValueETH > 0
                          || bill.type === "DEPOSIT"
                          || bill.type === "INSURANCE_INJECTION"
                          || bill.type === "MARGIN_REMOVE";
                        const amountStr = `${rawValueETH >= 0 ? "+" : ""}BNB ${rawValueETH >= 1 ? rawValueETH.toFixed(4) : rawValueETH >= 0 ? rawValueETH.toFixed(6) : (Math.abs(rawValueETH) >= 1 ? rawValueETH.toFixed(4) : rawValueETH.toFixed(6))}`;
                        const amountColor = typeMeta.color || (rawValueETH >= 0 ? "text-okx-up" : "text-okx-down");
                        const ts = new Date(bill.createdAt);
                        const pad = (n: number) => n.toString().padStart(2, "0");
                        const timeStr = `${ts.getFullYear()}/${pad(ts.getMonth() + 1)}/${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

                        return (
                          <div key={bill.id} className="bg-okx-bg-card border border-okx-border-primary rounded-lg px-3 py-2">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-okx-text-tertiary text-xs">{timeStr}</span>
                              <span className="text-okx-text-tertiary text-xs">
                                {t("billBalanceAfter")} BNB {balanceAfterETH >= 1 ? balanceAfterETH.toFixed(4) : balanceAfterETH.toFixed(6)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-okx-text-primary">BNB</span>
                              <span className={`text-xs font-bold ${amountColor}`}>{amountStr}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className={`text-xs ${typeMeta.color || "text-okx-text-secondary"}`}>
                                {typeMeta.label}
                              </span>
                              {bill.positionId && (
                                <span className="text-xs text-okx-text-tertiary">{t("billPerp")}</span>
                              )}
                              {bill.txHash && (
                                <span className="text-xs text-okx-text-tertiary font-mono">
                                  {bill.txHash.slice(0, 10)}...
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {billsHasMore && (
                        <div className="text-center py-2">
                          <button
                            onClick={loadMoreBills}
                            disabled={billsLoading}
                            className="text-okx-text-secondary text-xs hover:text-okx-text-primary transition-colors disabled:opacity-50"
                          >
                            {billsLoading ? t("billLoading") : t("billLoadMore")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 鈺愨晲鈺?MOBILE LAYOUT (< md) 鈺愨晲鈺?*/}
        <div className="md:hidden flex-1 flex flex-col overflow-hidden">
          {/* Chart section */}
          {mobileActiveSection === "chart" && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="relative h-[300px] flex-shrink-0 bg-okx-bg-card">
                {marketId && referencePriceUsd > 0 ? (
                  <ReferenceMarketChart
                    displaySymbol={displaySymbol}
                    priceUsd={referencePriceUsd}
                    isReference={!hasLiveMarketPrice}
                  />
                ) : (
                  <>
                    <TradingErrorBoundary module="PerpChart">
                      {tokenAddress && (
                        <MemoizedPriceChart
                          tokenAddress={tokenAddress}
                          displaySymbol={displaySymbol}
                          currentPrice={chartPrice}
                        />
                      )}
                    </TradingErrorBoundary>
                    {!chartPrice && <ChartFallback displaySymbol={displaySymbol} />}
                  </>
                )}
              </div>
              {/* Mobile bottom panel (positions/orders) */}
              <div className="flex-1 min-h-[200px] border-t border-okx-border-primary flex flex-col bg-okx-bg-primary">
                {/* Scrollable tabs */}
                <div className="overflow-x-auto border-b border-okx-border-primary">
                  <div className="flex px-2 min-w-max">
                    {[
                      { key: "positions", label: t("positions") },
                      { key: "openOrders", label: t("openOrders") },
                      { key: "orderHistory", label: t("orderHistory") },
                      { key: "tradeHistory", label: t("tradeHistory") },
                      { key: "hunting", label: t("huntingArena") },
                      { key: "risk", label: t("riskControl"), badge: riskAlerts.length > 0 ? riskAlerts.length : undefined },
                      { key: "bills", label: t("bills") },
                    ].map((tab) => (
                      <button
                        key={tab.key}
                        onClick={() => setActiveBottomTab(tab.key as typeof activeBottomTab)}
                        className={`py-2 px-3 text-xs transition-colors relative flex items-center gap-1 whitespace-nowrap flex-shrink-0 ${
                          activeBottomTab === tab.key
                            ? "text-okx-text-primary font-bold"
                            : "text-okx-text-secondary"
                        }`}
                      >
                        {tab.label}
                        {"badge" in tab && tab.badge && (
                          <span className="bg-red-500 text-white text-xs rounded-full px-1.5 min-w-[16px] h-4 flex items-center justify-center">
                            {tab.badge > 9 ? "9+" : tab.badge}
                          </span>
                        )}
                        {activeBottomTab === tab.key && (
                          <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-okx-accent" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Tab Content (shared with desktop 鈥?rendered inline) */}
                <div className="flex-1 overflow-y-auto">
                  {/* Mobile: simplified positions view (cards rendered in Step 5) */}
                  {activeBottomTab === "positions" && (
                    <div className="p-2">
                      {!isConnected ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{tc("connectWalletFirst")}</div>
                      ) : currentPositionsForDisplay.length === 0 ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{t("noPosition")}</div>
                      ) : (
                        <div className="text-center text-okx-text-tertiary py-4 text-xs">
                          {currentPositionsForDisplay.length} {t("positions")} - {t("openOrders")}
                        </div>
                      )}
                    </div>
                  )}
                  {activeBottomTab === "openOrders" && (
                    <div className="p-2 text-center text-okx-text-tertiary py-8 text-xs">
                      {!isConnected ? tc("connectWalletFirst") : t("noOpenOrder")}
                    </div>
                  )}
                  {activeBottomTab === "orderHistory" && (
                    <div className="p-2">
                      {!isConnected ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{tc("connectWalletFirst")}</div>
                      ) : isLoadingHistory ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">
                          <div className="animate-spin w-5 h-5 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                        </div>
                      ) : orderHistoryData.length === 0 ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{t("noOrderHistory")}</div>
                      ) : (
                        <div className="space-y-2">
                          {orderHistoryData.map((order) => {
                            const sizeTokenRaw = Number(order.size) / 1e18;
                            const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                            const priceRaw = Number(order.price) / 1e18;
                            const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                            const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                            const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0" ? formatSmallPrice(avgPriceRaw) : "--";
                            const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                            const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                            const statusColor = order.status === "FILLED" ? "text-green-400" : order.status === "CANCELLED" ? "text-red-400" : "text-yellow-400";
                            const timeDisplay = new Date(order.createdAt).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
                            return (
                              <div key={order.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${order.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                      {order.isLong ? t("long") : t("short")}
                                    </span>
                                    <span className="text-okx-text-tertiary text-xs">{orderTypeDisplay} {leverageDisplay}</span>
                                  </div>
                                  <span className={`text-xs ${statusColor}`}>{order.status}</span>
                                </div>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("orderPrice")}</span><span className="font-mono">{priceDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fillPrice")}</span><span className="font-mono">{avgPriceDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span>{sizeDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("time")}</span><span className="text-okx-text-secondary">{timeDisplay}</span></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {activeBottomTab === "tradeHistory" && (
                    <div className="p-2">
                      {!isConnected ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{tc("connectWalletFirst")}</div>
                      ) : isLoadingHistory ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">
                          <div className="animate-spin w-5 h-5 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                        </div>
                      ) : tradeHistoryData.length === 0 ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{t("noTradeHistory")}</div>
                      ) : (
                        <div className="space-y-2">
                          {tradeHistoryData.map((trade) => {
                            const sizeTokenRaw = Number(trade.size) / 1e18;
                            const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                            const priceRaw = Number(trade.price) / 1e18;
                            const priceDisplay = formatSmallPrice(priceRaw);
                            const feeETH = Number(trade.fee) / 1e18;
                            const feeDisplay = `BNB ${feeETH >= 0.0001 ? feeETH.toFixed(6) : feeETH.toFixed(8)}`;
                            const pnlETH = Number(trade.realizedPnL) / 1e18;
                            const pnlDisplay = pnlETH !== 0 ? `${pnlETH >= 0 ? "+" : ""}BNB ${Math.abs(pnlETH) >= 1 ? Math.abs(pnlETH).toFixed(4) : Math.abs(pnlETH).toFixed(6)}` : "--";
                            const typeDisplay = trade.type === "liquidation" ? t("liquidationLabel") : trade.type === "adl" ? "ADL" : trade.type === "close" ? t("closeTrade") : t("openTrade");
                            const typeColor = trade.type === "liquidation" ? "text-red-400 bg-red-900/30" : trade.type === "adl" ? "text-orange-400 bg-orange-900/30" : trade.type === "close" ? "text-blue-400 bg-blue-900/30" : "text-green-400 bg-green-900/30";
                            const timeDisplay = new Date(trade.timestamp).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
                            return (
                              <div key={trade.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${trade.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                      {trade.isLong ? t("long") : t("short")}
                                    </span>
                                    <span className={`px-2 py-0.5 rounded text-xs ${typeColor}`}>{typeDisplay}</span>
                                    <span className={`text-xs ${trade.isMaker ? "text-purple-400" : "text-blue-400"}`}>{trade.isMaker ? "Maker" : "Taker"}</span>
                                  </div>
                                  <span className="text-okx-text-tertiary text-xs">{timeDisplay}</span>
                                </div>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fillPrice")}</span><span className="text-okx-text-primary font-mono">{priceDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span className="text-okx-text-primary">{sizeDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fee")}</span><span className="text-okx-text-secondary">{feeDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("pnl")}</span><span className={`font-medium ${pnlETH >= 0 ? "text-green-400" : "text-red-400"}`}>{pnlDisplay}</span></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {activeBottomTab === "hunting" && (
                    <div className="p-2">
                      <div className="flex flex-col gap-3">
                        <LiquidationHeatmap token={symbol} />
                        <HunterLeaderboard token={symbol} />
                        <AllPositions token={symbol} />
                      </div>
                    </div>
                  )}
                  {activeBottomTab === "risk" && (
                    <div className="p-4">
                      <RiskPanel trader={tradingWalletAddress || address} token={tokenAddress} />
                    </div>
                  )}
                  {activeBottomTab === "bills" && (
                    <div className="p-2 text-center text-okx-text-tertiary py-8 text-xs">
                      {!isConnected ? tc("connectWalletFirst") : t("billEmpty")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* OrderBook section (full screen on mobile) */}
          {mobileActiveSection === "book" && (
            <div className="flex-1 overflow-hidden">
              <TradingErrorBoundary module="OrderBook">
                <OrderBook
                  data={wsOrderBook ? { ...wsOrderBook, recentTrades: wsRecentTrades } : indicativeOrderBook}
                  onPriceClick={(price) => {
                    setMobileActiveSection("trade");
                    setOrderBookSuggestedPrice(String(price));
                  }}
                  maxRows={15}
                  quoteLabel={marketId ? "USDT" : "BNB"}
                  modeLabel={wsOrderBook ? "Live" : marketId ? "Reference" : undefined}
                  isIndicative={!wsOrderBook && Boolean(marketId)}
                />
              </TradingErrorBoundary>
            </div>
          )}

          {/* Trade / Order Panel section (full width on mobile) */}
          {mobileActiveSection === "trade" && (
            <div className="flex-1 overflow-y-auto">
              <TradingErrorBoundary module="OrderPanel">
                <PerpetualOrderPanelV2
                  symbol={symbol}
                  displaySymbol={displaySymbol}
                  tokenAddress={tokenAddress}
                  marketId={marketId}
                  oraclePriceUsd={oraclePriceUsd}
                  maxLeverage={maxLeverage}
                  isPerpEnabled={isPerpEnabled}
                  suggestedPrice={orderBookSuggestedPrice}
                />
              </TradingErrorBoundary>
            </div>
          )}
        </div>
      </div>

      {/* Account Balance Modal */}
      {showAccountPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowAccountPanel(false)}
          />
          {/* Modal */}
          <div className="relative z-10 w-full max-w-md mx-4">
            <AccountBalance onClose={() => setShowAccountPanel(false)} />
          </div>
        </div>
      )}

      {/* 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
          Margin Adjustment Modal (Professional 鈥?OKX/Bybit style)
          鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?*/}
      {marginModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => { setMarginModal(null); setMarginAmount(""); }}>
          <div className="bg-[#1b1d28] rounded-xl w-[380px] max-w-[92vw] shadow-2xl border border-white/[0.06]" onClick={e => e.stopPropagation()}>
            {/* Header with tabs */}
            <div className="flex border-b border-white/[0.06]">
              <button
                onClick={() => setMarginModal({ ...marginModal, action: "add" })}
                className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
                  marginModal.action === "add"
                    ? "text-emerald-400"
                    : "text-okx-text-tertiary hover:text-okx-text-secondary"
                }`}
              >
                {t("addMargin") || "Add Margin"}
                {marginModal.action === "add" && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-emerald-400 rounded-full" />}
              </button>
              <button
                onClick={() => setMarginModal({ ...marginModal, action: "remove" })}
                className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
                  marginModal.action === "remove"
                    ? "text-rose-400"
                    : "text-okx-text-tertiary hover:text-okx-text-secondary"
                }`}
              >
                {t("removeMargin") || "Remove Margin"}
                {marginModal.action === "remove" && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-rose-400 rounded-full" />}
              </button>
            </div>

            <div className="p-5">
              {/* Current position info */}
              <div className="grid grid-cols-3 gap-2 mb-4 text-xs">
                <div className="bg-white/[0.03] rounded-lg p-2.5">
                  <div className="text-okx-text-tertiary mb-0.5">{t("margin") || "Margin"}</div>
                  <div className="text-okx-text-primary font-medium">{marginModal.collateral.toFixed(5)}</div>
                </div>
                <div className="bg-white/[0.03] rounded-lg p-2.5">
                  <div className="text-okx-text-tertiary mb-0.5">{t("leverage") || "Leverage"}</div>
                  <div className="text-okx-text-primary font-medium">{marginModal.leverage.toFixed(1)}x</div>
                </div>
                <div className="bg-white/[0.03] rounded-lg p-2.5">
                  <div className="text-okx-text-tertiary mb-0.5">{t("available") || "Available"}</div>
                  <div className="text-emerald-400 font-medium">{formattedAccountBalance}</div>
                </div>
              </div>

              {/* Amount input */}
              <div className="mb-3">
                <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 focus-within:border-okx-brand/50 transition-colors">
                  <input
                    type="number"
                    value={marginAmount}
                    onChange={e => setMarginAmount(e.target.value)}
                    placeholder={t("enterAmount") || "Enter amount"}
                    step="0.001"
                    min="0"
                    className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary"
                  />
                  <span className="text-xs text-okx-text-tertiary ml-2">BNB</span>
                  {marginModal.action === "remove" && marginInfo && (
                    <button
                      onClick={() => setMarginAmount(marginInfo.maxRemovable.toFixed(6))}
                      className="ml-2 text-[10px] text-okx-brand-primary hover:text-okx-brand-primary/80 font-medium"
                    >
                      MAX
                    </button>
                  )}
                </div>
                {marginModal.action === "remove" && marginInfo && (
                  <div className="text-[10px] text-okx-text-tertiary mt-1.5 px-1">
                    {t("maxRemovable") || "Max removable"}: {marginInfo.maxRemovable.toFixed(6)} BNB
                  </div>
                )}
              </div>

              {/* Quick amount buttons */}
              <div className="flex gap-1.5 mb-4">
                {[0.005, 0.01, 0.05, 0.1].map(v => (
                  <button
                    key={v}
                    onClick={() => setMarginAmount(v.toString())}
                    className={`flex-1 py-1.5 text-[10px] rounded border transition-colors ${
                      marginAmount === v.toString()
                        ? "border-okx-brand/50 text-okx-brand-primary bg-okx-brand/5"
                        : "border-white/[0.06] text-okx-text-tertiary hover:border-white/[0.12] hover:text-okx-text-secondary"
                    }`}
                  >
                    {v} BNB
                  </button>
                ))}
              </div>

              {/* Preview: new leverage + liq price */}
              {marginPreview && (
                <div className="bg-white/[0.02] rounded-lg p-3 mb-4 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-okx-text-tertiary">{t("leverage") || "Leverage"}</span>
                    <span className="text-okx-text-secondary">
                      {marginModal.leverage.toFixed(1)}x
                      <span className="text-okx-text-tertiary mx-1">→</span>
                      <span className={`font-medium ${marginPreview.newLeverage > marginModal.leverage ? "text-rose-400" : "text-emerald-400"}`}>
                        {marginPreview.newLeverage.toFixed(1)}x
                      </span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-okx-text-tertiary">{t("margin") || "Margin"}</span>
                    <span className="text-okx-text-secondary">
                      {marginModal.collateral.toFixed(5)}
                      <span className="text-okx-text-tertiary mx-1">→</span>
                      <span className="text-okx-text-primary font-medium">{marginPreview.newCollateral.toFixed(5)}</span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-okx-text-tertiary">{t("liqPrice") || "Liq. Price"}</span>
                    <span className="text-okx-text-secondary font-mono">
                      {formatSmallPrice(marginPreview.newLiqPrice)}
                    </span>
                  </div>
                </div>
              )}

              {/* Action button */}
              <button
                onClick={handleAdjustMargin}
                disabled={isAdjustingMargin || !marginAmount || parseFloat(marginAmount) <= 0}
                className={`w-full py-2.5 text-sm font-medium rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  marginModal.action === "add"
                    ? "bg-emerald-500 hover:bg-emerald-400 text-white"
                    : "bg-rose-500 hover:bg-rose-400 text-white"
                }`}
              >
                {isAdjustingMargin
                  ? (t("processing") || "Processing...")
                  : marginModal.action === "add"
                    ? (t("addMargin") || "Add Margin")
                    : (t("removeMargin") || "Remove Margin")
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
          TP/SL Modal (姝㈢泩姝㈡崯)
          鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?*/}
      {tpslModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => setTpslModal(null)}>
          <div className="bg-[#1b1d28] rounded-xl w-[380px] max-w-[92vw] shadow-2xl border border-white/[0.06]" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06]">
              <h3 className="text-sm font-medium text-okx-text-primary">{t("takeProfitStopLoss") || "TP/SL"}</h3>
              <button onClick={() => setTpslModal(null)} className="text-okx-text-tertiary hover:text-okx-text-primary text-lg">×</button>
            </div>

            <div className="p-5 space-y-4">
              {/* Take Profit */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-emerald-400 font-medium">{t("takeProfit") || "Take Profit"}</span>
                  {currentTpsl?.takeProfitPrice && (
                    <button onClick={() => handleCancelTpsl("tp")} className="text-[10px] text-okx-text-tertiary hover:text-rose-400 transition-colors">
                      {t("cancel") || "Cancel"}
                    </button>
                  )}
                </div>
                <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 focus-within:border-emerald-500/40 transition-colors">
                  <input
                    type="number"
                    value={tpInput}
                    onChange={e => setTpInput(e.target.value)}
                    placeholder={tpslModal.isLong ? `> ${formatSmallPrice(tpslModal.entryPrice)}` : `< ${formatSmallPrice(tpslModal.entryPrice)}`}
                    step="any"
                    className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary/50"
                  />
                  <span className="text-[10px] text-okx-text-tertiary ml-2">BNB</span>
                </div>
                <div className="text-[10px] text-okx-text-tertiary mt-1 px-1">
                  {tpslModal.isLong ? t("tpHintLong") || "Trigger when price rises above" : t("tpHintShort") || "Trigger when price falls below"}
                </div>
              </div>

              {/* Stop Loss */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-rose-400 font-medium">{t("stopLoss") || "Stop Loss"}</span>
                  {currentTpsl?.stopLossPrice && (
                    <button onClick={() => handleCancelTpsl("sl")} className="text-[10px] text-okx-text-tertiary hover:text-rose-400 transition-colors">
                      {t("cancel") || "Cancel"}
                    </button>
                  )}
                </div>
                <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 focus-within:border-rose-500/40 transition-colors">
                  <input
                    type="number"
                    value={slInput}
                    onChange={e => setSlInput(e.target.value)}
                    placeholder={tpslModal.isLong ? `< ${formatSmallPrice(tpslModal.entryPrice)}` : `> ${formatSmallPrice(tpslModal.entryPrice)}`}
                    step="any"
                    className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary/50"
                  />
                  <span className="text-[10px] text-okx-text-tertiary ml-2">BNB</span>
                </div>
                <div className="text-[10px] text-okx-text-tertiary mt-1 px-1">
                  {tpslModal.isLong ? t("slHintLong") || "Trigger when price falls below" : t("slHintShort") || "Trigger when price rises above"}
                </div>
              </div>

              {/* Info */}
              <div className="bg-white/[0.02] rounded-lg p-3 text-[10px] text-okx-text-tertiary space-y-1">
                <div className="flex justify-between">
                  <span>{t("entryAvg") || "Entry Price"}</span>
                  <span className="text-okx-text-secondary font-mono">{formatSmallPrice(tpslModal.entryPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t("liqPrice") || "Liq. Price"}</span>
                  <span className="text-rose-400/70 font-mono">{formatSmallPrice(tpslModal.liqPrice)}</span>
                </div>
              </div>

              {/* Buttons */}
              <div className="flex gap-2">
                {currentTpsl?.takeProfitPrice || currentTpsl?.stopLossPrice ? (
                  <button
                    onClick={() => handleCancelTpsl("both")}
                    className="flex-1 py-2.5 text-sm font-medium rounded-lg border border-white/[0.08] text-okx-text-secondary hover:bg-white/[0.04] transition-colors"
                  >
                    {t("cancelAll") || "Cancel All"}
                  </button>
                ) : null}
                <button
                  onClick={handleSetTpsl}
                  disabled={isSettingTpsl || (!tpInput && !slInput)}
                  className="flex-1 py-2.5 text-sm font-medium rounded-lg bg-amber-500 hover:bg-amber-400 text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSettingTpsl ? (t("processing") || "Processing...") : (t("confirm") || "Confirm")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

