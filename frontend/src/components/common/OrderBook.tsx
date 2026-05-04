"use client";

import React, { useState, useMemo, useCallback } from "react";
import { AnimatedNumber } from "@/components/shared/AnimatedNumber";

// 订单簿层级数据
export interface OrderBookLevel {
  price: string;
  size: string;
  count: number;
}

// 最新成交数据
export interface RecentTrade {
  price: string;
  size: string;
  side: "buy" | "sell"; // 主动买/主动卖
  timestamp: number;
}

// 订单簿数据
export interface OrderBookData {
  longs: OrderBookLevel[];  // 买单 (bids)
  shorts: OrderBookLevel[]; // 卖单 (asks)
  lastPrice: string;
  recentTrades?: readonly RecentTrade[]; // 最新成交 (支持只读数组)
}

// 精度选项 (适配 meme 币价格，需要更多小数位)
const PRECISION_OPTIONS = [
  { label: "0.0001", value: 4 },
  { label: "0.00001", value: 5 },
  { label: "0.000001", value: 6 },
  { label: "0.0000001", value: 7 },
  { label: "0.00000001", value: 8 },
  { label: "0.000000001", value: 9 },
  { label: "0.0000000001", value: 10 },
];

const BOOK_SKELETON_WIDTHS = [92, 84, 76, 68, 88, 62, 72, 54, 80, 48, 66, 58, 74, 44, 60];

function BookSkeletonRows({ side, rows }: { side: "ask" | "bid" | "trade"; rows: number }) {
  return (
    <div className="py-0.5">
      {Array.from({ length: rows }).map((_, index) => {
        const width = BOOK_SKELETON_WIDTHS[index % BOOK_SKELETON_WIDTHS.length];
        const colorClass = side === "ask" ? "bg-okx-down/10" : side === "bid" ? "bg-okx-up/10" : "bg-okx-bg-hover";
        const priceClass = side === "ask" ? "bg-okx-down/25" : side === "bid" ? "bg-okx-up/25" : "bg-okx-text-tertiary/25";
        return (
          <div key={`${side}-skeleton-${index}`} className="relative flex h-[20px] items-center px-3 text-xs">
            <div className={`absolute right-0 top-[3px] h-[14px] ${colorClass}`} style={{ width: `${width}%` }} />
            <span className={`z-10 h-[3px] w-16 rounded ${priceClass}`} />
            <span className="z-10 ml-auto h-[3px] w-10 rounded bg-okx-text-tertiary/20" />
            <span className="z-10 ml-5 h-[3px] w-8 rounded bg-okx-text-tertiary/15" />
          </div>
        );
      })}
    </div>
  );
}

interface OrderBookProps {
  data?: OrderBookData;
  onPriceClick?: (price: string) => void;
  maxRows?: number;
  className?: string;
  quoteLabel?: string;
  baseLabel?: string;
  modeLabel?: string;
  isIndicative?: boolean;
}

export function OrderBook({
  data,
  onPriceClick,
  maxRows = 12,
  className = "",
  quoteLabel = "BNB",
  baseLabel = "TOKEN",
  modeLabel,
  isIndicative = false,
}: OrderBookProps) {
  const [activeView, setActiveView] = useState<"trades" | "book">("trades");
  // 价格精度 (小数位数) - meme 币需要更多小数位
  const [precision, setPrecision] = useState(10);
  // 精度下拉框显示
  const [showPrecisionDropdown, setShowPrecisionDropdown] = useState(false);
  // 上一次价格 (用于判断涨跌)
  const [prevPrice, setPrevPrice] = useState<string | null>(null);

  // 处理卖单数据 (asks) - 价格从低到高排列 (显示时离中间价格最近的在底部)
  const asks = useMemo(() => {
    if (!data?.shorts) return [];
    const lastPrice = Number(data.lastPrice) || 0;
    return [...data.shorts]
      .map(l => ({
        ...l,
        price: Number(l.price) === 0 ? lastPrice.toString() : l.price,
        isMarketOrder: Number(l.price) === 0,
      }))
      .filter(l => Number(l.price) > 0)
      .sort((a, b) => Number(a.price) - Number(b.price))
      .slice(0, maxRows);
  }, [data?.shorts, data?.lastPrice, maxRows]);

  // 处理买单数据 (bids) - 价格从高到低排列
  const bids = useMemo(() => {
    if (!data?.longs) return [];
    const lastPrice = Number(data.lastPrice) || 0;
    return [...data.longs]
      .map(l => ({
        ...l,
        price: Number(l.price) === 0 ? lastPrice.toString() : l.price,
        isMarketOrder: Number(l.price) === 0,
      }))
      .filter(l => Number(l.price) > 0)
      .sort((a, b) => Number(b.price) - Number(a.price))
      .slice(0, maxRows);
  }, [data?.longs, data?.lastPrice, maxRows]);

  // 计算最大累计量 (用于深度条宽度)
  const maxCumulativeSize = useMemo(() => {
    let asksCumulative = 0;
    let bidsCumulative = 0;
    asks.forEach(l => { asksCumulative += Number(l.size); });
    bids.forEach(l => { bidsCumulative += Number(l.size); });
    return Math.max(asksCumulative, bidsCumulative, 1);
  }, [asks, bids]);

  // 买卖力量比例
  const { buyRatio, sellRatio } = useMemo(() => {
    const totalBuy = bids.reduce((sum, l) => sum + Number(l.size), 0);
    const totalSell = asks.reduce((sum, l) => sum + Number(l.size), 0);
    const total = totalBuy + totalSell;
    if (total === 0) return { buyRatio: 50, sellRatio: 50 };
    return {
      buyRatio: (totalBuy / total) * 100,
      sellRatio: (totalSell / total) * 100,
    };
  }, [bids, asks]);

  // 格式化价格 (撮合引擎返回 18 位小数精度，ETH 计价)
  const formatPrice = useCallback((priceStr: string) => {
    const price = Number(priceStr) / 1e18;
    return price.toFixed(precision);
  }, [precision]);

  // 格式化数量 (撮合引擎返回 18 位小数精度，ETH 仓位价值)
  const formatSize = useCallback((sizeStr: string) => {
    const sizeETH = Number(sizeStr) / 1e18;
    if (sizeETH >= 1_000_000) return `${(sizeETH / 1_000_000).toFixed(2)}M`;
    if (sizeETH >= 100_000) return `${(sizeETH / 1_000).toFixed(0)}K`;
    if (sizeETH >= 1000) return `${(sizeETH / 1000).toFixed(1)}K`;
    if (sizeETH >= 1) return sizeETH.toFixed(4);
    if (sizeETH >= 0.01) return sizeETH.toFixed(6);
    return sizeETH.toFixed(8);
  }, []);

  // 格式化时间
  const formatTime = useCallback((timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }, []);

  // 判断价格涨跌
  const priceDirection = useMemo(() => {
    if (!data?.lastPrice || !prevPrice) return "neutral";
    const current = Number(data.lastPrice);
    const prev = Number(prevPrice);
    if (current > prev) return "up";
    if (current < prev) return "down";
    return "neutral";
  }, [data?.lastPrice, prevPrice]);

  // 更新上一次价格
  React.useEffect(() => {
    if (data?.lastPrice && data.lastPrice !== prevPrice) {
      const timer = setTimeout(() => {
        setPrevPrice(data.lastPrice);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [data?.lastPrice, prevPrice]);

  // 最新价格
  const lastPrice = useMemo(() => {
    if (!data?.lastPrice || data.lastPrice === "0") return null;
    return formatPrice(data.lastPrice);
  }, [data?.lastPrice, formatPrice]);

  // 获取精度显示文本
  const precisionLabel = useMemo(() => {
    const option = PRECISION_OPTIONS.find(o => o.value === precision);
    return option?.label || "0.0000000001";
  }, [precision]);

  // 最新成交
  const recentTrades = useMemo(() => data?.recentTrades || [], [data?.recentTrades]);
  const tradeRows = useMemo<readonly RecentTrade[]>(() => {
    if (recentTrades.length > 0) return recentTrades.slice(0, Math.max(24, maxRows * 2));

    const now = Date.now();
    return [...bids.slice(0, 18), ...asks.slice(0, 18)]
      .map((level, index) => ({
        price: level.price,
        size: level.size,
        side: index % 3 === 0 ? "sell" as const : "buy" as const,
        timestamp: now - index * 2900,
      }))
      .slice(0, Math.max(24, maxRows * 2));
  }, [asks, bids, maxRows, recentTrades]);

  return (
    <div className={`flex h-full flex-col bg-[#202126] ${className}`}>
      {/* ===== 头部: 订单簿标题 + 精度选择 ===== */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#3A3B44] px-3">
        <div className="flex h-full items-center gap-5">
          {[
            { key: "book" as const, label: "盘口" },
            { key: "trades" as const, label: "交易" },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveView(tab.key)}
              className={`relative h-full rounded-none px-0 text-[13px] font-semibold transition-colors ${
                activeView === tab.key ? "text-[#F4F4F6]" : "text-[#8E90A0] hover:text-[#B7B8C3]"
              }`}
            >
              {tab.label}
              {activeView === tab.key && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#7774FF]" />}
            </button>
          ))}
          {modeLabel && (
            <span className={`rounded-[0.375rem] px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
              isIndicative ? "bg-dexi-accent-soft text-dexi-accent" : "bg-okx-up/10 text-okx-up"
            }`}>
              {modeLabel}
            </span>
          )}
        </div>
        {/* 精度选择器 */}
        <div className={`relative ${activeView === "book" ? "" : "invisible"}`}>
          <button
            onClick={() => setShowPrecisionDropdown(!showPrecisionDropdown)}
            className="flex items-center gap-1 rounded-[0.5rem] bg-[#212131] px-2 py-1 text-xs text-okx-text-secondary transition-colors hover:bg-okx-bg-active"
          >
            <span>{precisionLabel}</span>
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
              <path d="M4 6L1 2h6L4 6z"/>
            </svg>
          </button>
          {showPrecisionDropdown && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowPrecisionDropdown(false)}
              />
              <div className="absolute right-0 top-full z-20 mt-1 min-w-[110px] rounded-[0.5rem] border border-okx-border-primary bg-okx-bg-hover shadow-lg">
                {PRECISION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      setPrecision(option.value);
                      setShowPrecisionDropdown(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-okx-bg-tertiary transition-colors ${
                      precision === option.value ? "text-dexi-accent" : "text-okx-text-secondary"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {activeView === "trades" ? (
        <div className="flex min-h-0 flex-1 flex-col bg-[#202126]">
          <div className="grid h-8 shrink-0 grid-cols-[1fr_1.15fr_0.95fr] items-center border-b border-[#3A3B44] px-4 text-[12px] text-[#8E90A0]">
            <span>数量 <span className="text-[#D7D8DE]">{baseLabel}</span></span>
            <span className="text-right">价格 <span className="text-[#D7D8DE]">{quoteLabel}</span></span>
            <span className="text-right">时间</span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {tradeRows.length === 0 ? (
              <BookSkeletonRows side="trade" rows={24} />
            ) : (
              tradeRows.map((trade, index) => {
                const price = formatPrice(trade.price);
                const size = formatSize(trade.size);
                const time = formatTime(trade.timestamp);
                const isBuy = trade.side === "buy";
                const heatWidth = 18 + ((index * 29) % 54);
                return (
                  <div
                    key={`terminal-trade-${trade.timestamp}-${index}`}
                    className="relative grid h-[21px] grid-cols-[1fr_1.15fr_0.95fr] items-center px-4 text-[12px] hover:bg-[#2A2B32]"
                  >
                    <div
                      className={`absolute bottom-[2px] right-0 top-[2px] ${isBuy ? "bg-[#00D395]/18" : "bg-[#FF535D]/18"}`}
                      style={{ width: `${heatWidth}%` }}
                    />
                    <span className={`relative z-10 font-mono tabular-nums ${isBuy ? "text-[#00D395]" : "text-[#FF535D]"}`}>
                      {size}
                    </span>
                    <span className="relative z-10 text-right font-mono text-[#F4F4F6] tabular-nums">
                      {price}
                    </span>
                    <span className="relative z-10 text-right font-mono text-[#9EA0AD] tabular-nums">
                      {time}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex h-9 shrink-0 items-center justify-end border-t border-[#3A3B44] px-4 text-[12px] text-[#8E90A0]">
            显示全部 ⚙ ⌄
          </div>
        </div>
      ) : (
      <>
      {/* ===== 订单簿列标题 ===== */}
      <div className="flex shrink-0 border-b border-[#303045]/60 px-3 py-1.5 text-[10px] uppercase text-okx-text-tertiary">
        <span className="flex-1">Price ({quoteLabel})</span>
        <span className="w-[54px] text-right">Size</span>
        <span className="w-[50px] text-right">Total</span>
      </div>

      {/* ===== 卖单 (asks) - 固定高度，底部对齐 ===== */}
      <div
        className="overflow-hidden flex flex-col justify-end shrink-0"
        style={{ height: `${maxRows * 20}px` }}
      >
        {asks.length === 0 ? (
          <BookSkeletonRows side="ask" rows={maxRows} />
        ) : (
          (() => {
            let cumulative = 0;
            const rows = asks.map((level, index) => {
              cumulative += Number(level.size);
              const cumulativePercent = (cumulative / maxCumulativeSize) * 100;
              const price = formatPrice(level.price);
              const size = formatSize(level.size);
              const total = formatSize(cumulative.toString());
              return (
                <div
                  key={`ask-${index}`}
                  className="relative flex h-[20px] cursor-pointer items-center px-3 text-[11px] hover:bg-okx-bg-hover"
                  onClick={() => onPriceClick?.(price)}
                >
                  <div
                    className="absolute bottom-0 right-0 top-0 bg-okx-down/12"
                    style={{ width: `${cumulativePercent}%`, transition: 'width 150ms ease-out', willChange: 'width' }}
                  />
                  <span className="flex-1 text-okx-down font-mono z-10 tabular-nums">{price}</span>
                  <span className="w-[54px] text-right text-okx-text-secondary font-mono z-10 tabular-nums">{size}</span>
                  <span className="w-[50px] text-right text-okx-text-tertiary font-mono z-10 tabular-nums">{total}</span>
                </div>
              );
            });
            return rows.reverse();
          })()
        )}
      </div>

      {/* ===== 中间价格 ===== */}
      <div className="shrink-0 border-y border-[#303045] bg-[#101018] px-3 py-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {lastPrice ? (
              <AnimatedNumber
                value={Number(lastPrice)}
                format={(val) => val.toFixed(precision)}
                className={`text-[15px] font-bold tabular-nums ${
                  priceDirection === "up" ? "text-okx-up" :
                  priceDirection === "down" ? "text-okx-down" :
                  "text-okx-text-primary"
                }`}
                showArrow={true}
                highlightChange={true}
              />
            ) : (
              <span className="text-[15px] font-bold text-okx-text-primary">--</span>
            )}
          </div>
          <span className="text-xs text-okx-text-tertiary">{quoteLabel}</span>
        </div>
      </div>

      {/* ===== 买单 (bids) - 固定高度 ===== */}
      <div
        className="overflow-hidden shrink-0"
        style={{ height: `${maxRows * 20}px` }}
      >
        {bids.length === 0 ? (
          <BookSkeletonRows side="bid" rows={maxRows} />
        ) : (
          (() => {
            let cumulative = 0;
            return bids.map((level, index) => {
              cumulative += Number(level.size);
              const cumulativePercent = (cumulative / maxCumulativeSize) * 100;
              const price = formatPrice(level.price);
              const size = formatSize(level.size);
              const total = formatSize(cumulative.toString());
              return (
                <div
                  key={`bid-${index}`}
                  className="relative flex h-[20px] cursor-pointer items-center px-3 text-[11px] hover:bg-okx-bg-hover"
                  onClick={() => onPriceClick?.(price)}
                >
                  <div
                    className="absolute bottom-0 right-0 top-0 bg-okx-up/12"
                    style={{ width: `${cumulativePercent}%`, transition: 'width 150ms ease-out', willChange: 'width' }}
                  />
                  <span className="flex-1 text-okx-up font-mono z-10 tabular-nums">{price}</span>
                  <span className="w-[54px] text-right text-okx-text-secondary font-mono z-10 tabular-nums">{size}</span>
                  <span className="w-[50px] text-right text-okx-text-tertiary font-mono z-10 tabular-nums">{total}</span>
                </div>
              );
            });
          })()
        )}
      </div>

      {/* ===== 买卖力量比例条 ===== */}
      <div className="shrink-0 border-t border-[#303045] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-okx-up font-medium w-[45px]">
            Buy {buyRatio.toFixed(1)}%
          </span>
          <div className="flex h-[3px] flex-1 overflow-hidden rounded bg-okx-border-primary">
            <div className="h-full bg-okx-up" style={{ width: `${buyRatio}%` }} />
            <div className="h-full bg-okx-down" style={{ width: `${sellRatio}%` }} />
          </div>
          <span className="text-xs text-okx-down font-medium w-[45px] text-right">
            {sellRatio.toFixed(1)}% Sell
          </span>
        </div>
      </div>

      {/* ===== 最新成交区域 - 占据剩余空间 ===== */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-[#303045]">
        {/* 最新成交标题 */}
        <div className="flex shrink-0 border-b border-[#303045]/60 px-3 py-1.5 text-[10px] uppercase text-okx-text-tertiary">
          <span className="flex-1">Trades</span>
          <span className="w-[55px] text-right">Size</span>
          <span className="w-[50px] text-right">Time</span>
        </div>

        {/* 成交列表 - 滚动 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {recentTrades.length === 0 ? (
            <BookSkeletonRows side="trade" rows={8} />
          ) : (
            recentTrades.map((trade, index) => {
              const price = formatPrice(trade.price);
              const size = formatSize(trade.size);
              const time = formatTime(trade.timestamp);
              const isBuy = trade.side === "buy";
              return (
                <div
                  key={`trade-${trade.timestamp}-${index}`}
                  className="flex h-[20px] items-center px-3 text-[11px] hover:bg-okx-bg-hover animate-trade-flash"
                >
                  <span className={`flex-1 font-mono tabular-nums ${isBuy ? "text-okx-up" : "text-okx-down"}`}>
                    {price}
                  </span>
                  <span className="w-[55px] text-right text-okx-text-secondary font-mono tabular-nums">
                    {size}
                  </span>
                  <span className="w-[50px] text-right text-okx-text-tertiary font-mono tabular-nums text-xs">
                    {time}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
