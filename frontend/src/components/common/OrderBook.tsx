"use client";

import React, { useState, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
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

interface OrderBookProps {
  data?: OrderBookData;
  onPriceClick?: (price: string) => void;
  maxRows?: number;
  className?: string;
}

export function OrderBook({
  data,
  onPriceClick,
  maxRows = 12,
  className = "",
}: OrderBookProps) {
  const t = useTranslations("orderBook");

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
  const recentTrades = data?.recentTrades || [];

  return (
    <div className={`flex flex-col bg-okx-bg-primary h-full ${className}`}>
      {/* ===== 头部: 订单簿标题 + 精度选择 ===== */}
      <div className="px-3 py-2 border-b border-okx-border-primary flex items-center justify-between shrink-0">
        <span className="text-[12px] font-medium text-okx-text-primary">
          {t("title")}
        </span>
        {/* 精度选择器 */}
        <div className="relative">
          <button
            onClick={() => setShowPrecisionDropdown(!showPrecisionDropdown)}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-okx-text-secondary bg-okx-bg-hover rounded hover:bg-okx-bg-tertiary transition-colors"
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
              <div className="absolute right-0 top-full mt-1 bg-okx-bg-hover border border-okx-border-primary rounded shadow-lg z-20 min-w-[110px]">
                {PRECISION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => {
                      setPrecision(option.value);
                      setShowPrecisionDropdown(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-okx-bg-tertiary transition-colors ${
                      precision === option.value ? "text-okx-brand" : "text-okx-text-secondary"
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

      {/* ===== 订单簿列标题 ===== */}
      <div className="px-3 py-1 flex text-[10px] text-okx-text-tertiary border-b border-okx-border-primary/50 shrink-0">
        <span className="flex-1">{t("priceUsdt")}</span>
        <span className="w-[60px] text-right">{t("sizeContracts")}</span>
        <span className="w-[55px] text-right">{t("totalContracts")}</span>
      </div>

      {/* ===== 卖单 (asks) - 固定高度，底部对齐 ===== */}
      <div
        className="overflow-hidden flex flex-col justify-end shrink-0"
        style={{ height: `${maxRows * 20}px` }}
      >
        {asks.length === 0 ? (
          <div className="text-center text-okx-text-tertiary text-[11px] py-4">
            {t("noAsks")}
          </div>
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
                  className="relative flex items-center text-[11px] h-[20px] px-3 hover:bg-okx-bg-hover cursor-pointer"
                  onClick={() => onPriceClick?.(price)}
                >
                  <div
                    className="absolute right-0 top-0 bottom-0 bg-okx-down/10"
                    style={{ width: `${cumulativePercent}%`, transition: 'width 150ms ease-out', willChange: 'width' }}
                  />
                  <span className="flex-1 text-okx-down font-mono z-10 tabular-nums">{price}</span>
                  <span className="w-[60px] text-right text-okx-text-secondary font-mono z-10 tabular-nums">{size}</span>
                  <span className="w-[55px] text-right text-okx-text-tertiary font-mono z-10 tabular-nums">{total}</span>
                </div>
              );
            });
            return rows.reverse();
          })()
        )}
      </div>

      {/* ===== 中间价格 ===== */}
      <div className="py-1.5 px-3 bg-okx-bg-hover/50 border-y border-okx-border-primary/30 shrink-0">
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
          <span className="text-[10px] text-okx-text-tertiary">BNB</span>
        </div>
      </div>

      {/* ===== 买单 (bids) - 固定高度 ===== */}
      <div
        className="overflow-hidden shrink-0"
        style={{ height: `${maxRows * 20}px` }}
      >
        {bids.length === 0 ? (
          <div className="text-center text-okx-text-tertiary text-[11px] py-4">
            {t("noBids")}
          </div>
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
                  className="relative flex items-center text-[11px] h-[20px] px-3 hover:bg-okx-bg-hover cursor-pointer"
                  onClick={() => onPriceClick?.(price)}
                >
                  <div
                    className="absolute right-0 top-0 bottom-0 bg-okx-up/10"
                    style={{ width: `${cumulativePercent}%`, transition: 'width 150ms ease-out', willChange: 'width' }}
                  />
                  <span className="flex-1 text-okx-up font-mono z-10 tabular-nums">{price}</span>
                  <span className="w-[60px] text-right text-okx-text-secondary font-mono z-10 tabular-nums">{size}</span>
                  <span className="w-[55px] text-right text-okx-text-tertiary font-mono z-10 tabular-nums">{total}</span>
                </div>
              );
            });
          })()
        )}
      </div>

      {/* ===== 买卖力量比例条 ===== */}
      <div className="px-3 py-1.5 border-t border-okx-border-primary shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-okx-up font-medium w-[45px]">
            {t("buyRatio")} {buyRatio.toFixed(1)}%
          </span>
          <div className="flex-1 h-[3px] bg-okx-border-primary rounded overflow-hidden flex">
            <div className="h-full bg-okx-up" style={{ width: `${buyRatio}%` }} />
            <div className="h-full bg-okx-down" style={{ width: `${sellRatio}%` }} />
          </div>
          <span className="text-[10px] text-okx-down font-medium w-[45px] text-right">
            {sellRatio.toFixed(1)}% {t("sellRatio")}
          </span>
        </div>
      </div>

      {/* ===== 最新成交区域 - 占据剩余空间 ===== */}
      <div className="flex-1 flex flex-col min-h-0 border-t border-okx-border-primary">
        {/* 最新成交标题 */}
        <div className="px-3 py-1.5 flex text-[10px] text-okx-text-tertiary border-b border-okx-border-primary/50 shrink-0">
          <span className="flex-1">{t("recentTrades")}</span>
          <span className="w-[55px] text-right">{t("sizeContracts")}</span>
          <span className="w-[50px] text-right">{t("time")}</span>
        </div>

        {/* 成交列表 - 滚动 */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {recentTrades.length === 0 ? (
            <div className="text-center text-okx-text-tertiary text-[11px] py-4">
              --
            </div>
          ) : (
            recentTrades.map((trade, index) => {
              const price = formatPrice(trade.price);
              const size = formatSize(trade.size);
              const time = formatTime(trade.timestamp);
              const isBuy = trade.side === "buy";
              return (
                <div
                  key={`trade-${trade.timestamp}-${index}`}
                  className="flex items-center text-[11px] h-[20px] px-3 hover:bg-okx-bg-hover animate-trade-flash"
                >
                  <span className={`flex-1 font-mono tabular-nums ${isBuy ? "text-okx-up" : "text-okx-down"}`}>
                    {price}
                  </span>
                  <span className="w-[55px] text-right text-okx-text-secondary font-mono tabular-nums">
                    {size}
                  </span>
                  <span className="w-[50px] text-right text-okx-text-tertiary font-mono tabular-nums text-[10px]">
                    {time}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
