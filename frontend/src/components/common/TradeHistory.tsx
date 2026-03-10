"use client";

import React from "react";
import { formatUnits } from "viem";
import { formatDate } from "@/utils/formatters";
import { useTranslations } from "next-intl";

export interface Trade {
  timestamp: number;
  type: "buy" | "sell";
  totalValue: string; // e.g., "0.0099 BNB"
  price: string; // e.g., "0.0₉21100 BNB"
  quantity: string; // e.g., "-1.88M TOKEN"
  quantitySol: string; // e.g., "+0.00990 BNB"
  address: string; // e.g., "9VXWLE...C3YX"
  txHash: string;
  isDev?: boolean; // 是否为开发者钱包
  isCreator?: boolean; // 是否为创建者钱包
  label?: string; // 标签: DEV, CREATOR, WHALE, SNIPER 等
  isNew?: boolean; // 是否为新交易（用于高亮动画）
}

interface TradeHistoryProps {
  trades: Trade[];
  className?: string;
}

/**
 * TradeHistory - 1:1 复刻 OKX 风格的交易活动表格
 */
export function TradeHistory({ trades, className }: TradeHistoryProps) {
  const t = useTranslations();
  // 确保 trades 是数组
  const safeTrades = Array.isArray(trades) ? trades : [];

  // 使用统一的格式化函数，但调整分隔符为 OKX 风格
  const formatTradeDate = (timestamp: number) => {
    return formatDate(timestamp).replace(/-/g, '/').replace(' ', ' ');
  };

  return (
    <div className={`w-full overflow-x-auto ${className}`}>
      <table className="w-full text-[12px] text-left border-collapse">
        <thead>
          <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
            <th className="py-2 px-3 font-normal">{t('history.timeSort')} ⇅ ▽</th>
            <th className="py-2 px-3 font-normal">{t('history.type')} ▽</th>
            <th className="py-2 px-3 font-normal text-right">{t('history.totalValue')} ▽</th>
            <th className="py-2 px-3 font-normal text-right">{t('history.price')} ⇅ ▽</th>
            <th className="py-2 px-3 font-normal text-right">{t('history.quantity')} ▽</th>
            <th className="py-2 px-3 font-normal">{t('holders.address')} ▽</th>
            <th className="py-2 px-3 font-normal">{t('history.pool')}</th>
            <th className="py-2 px-3 font-normal">{t('history.details')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#1F1F1F]/50">
          {safeTrades.map((trade, index) => {
            const isBuy = trade.type === "buy";
            return (
              <tr
              key={`${trade.txHash}-${index}`}
              className={`hover:bg-okx-bg-hover transition-colors group ${
                trade.isNew ? "trade-new" : ""
              } ${
                (trade.isDev || trade.label === "DEV") && trade.type === "sell"
                  ? "bg-[#FF3B30]/5"
                  : ""
              }`}
            >
                {/* 时间 */}
                <td className="py-3 px-3 text-okx-text-secondary whitespace-nowrap">
                  {formatTradeDate(trade.timestamp)}
                </td>
                
                {/* 类型 */}
                <td className="py-3 px-3">
                  <div className="flex items-center gap-1.5">
                    <span className={`px-2 py-0.5 rounded-[4px] font-bold text-[11px] ${
                      isBuy ? "bg-[#00D26A]/10 text-[#00D26A]" : "bg-[#FF2D55]/10 text-[#FF2D55]"
                    }`}>
                      {isBuy ? t('token.buy') : t('token.sell')}
                    </span>
                    {/* Dev Sold 警告标识 */}
                    {!isBuy && (trade.isDev || trade.label === "DEV") && (
                      <span className="px-1.5 py-0.5 rounded bg-[#FF3B30]/20 text-[#FF3B30] text-[9px] font-bold border border-[#FF3B30]/30 animate-pulse">
                        {t('history.devSold')}
                      </span>
                    )}
                    {/* Creator Sold 警告标识 */}
                    {!isBuy && (trade.isCreator || trade.label === "CREATOR") && (
                      <span className="px-1.5 py-0.5 rounded bg-[#FF9500]/20 text-[#FF9500] text-[9px] font-bold border border-[#FF9500]/30">
                        {t('holders.creator')}
                      </span>
                    )}
                  </div>
                </td>

                {/* 总价值 */}
                <td className={`py-3 px-3 text-right font-bold ${isBuy ? "text-[#00D26A]" : "text-[#FF2D55]"}`}>
                  {trade.totalValue}
                </td>

                {/* 价格 */}
                <td className="py-3 px-3 text-right text-okx-text-primary font-medium">
                  {trade.price}
                </td>

                {/* 数量 */}
                <td className="py-3 px-3 text-right">
                  <div className={`font-bold ${isBuy ? "text-[#00D26A]" : "text-[#FF2D55]"}`}>
                    {trade.quantity}
                  </div>
                  <div className="text-okx-text-tertiary text-[10px]">
                    {trade.quantitySol}
                  </div>
                </td>

                {/* 地址 */}
                <td className="py-3 px-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-okx-text-primary font-mono">{trade.address}</span>
                    {/* 地址标签 */}
                    {trade.label && !["DEV", "CREATOR"].includes(trade.label) && (
                      <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                        trade.label === "WHALE" ? "bg-[#5856D6]/20 text-[#5856D6] border border-[#5856D6]/30" :
                        trade.label === "SNIPER" ? "bg-[#FF2D55]/20 text-[#FF2D55] border border-[#FF2D55]/30" :
                        trade.label === "KOL" ? "bg-[#007AFF]/20 text-[#007AFF] border border-[#007AFF]/30" :
                        trade.label === "SMART_MONEY" ? "bg-[#00D26A]/20 text-[#00D26A] border border-[#00D26A]/30" :
                        "bg-[#636366]/20 text-okx-text-tertiary"
                      }`}>
                        {trade.label === "WHALE" ? t('holders.whale') :
                         trade.label === "SNIPER" ? t('holders.sniper') :
                         trade.label === "KOL" ? t('holders.kol') :
                         trade.label === "SMART_MONEY" ? t('holders.smartMoney') :
                         trade.label}
                      </span>
                    )}
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="text-okx-text-tertiary cursor-pointer hover:text-okx-text-primary">✎</span>
                      <span className="text-okx-text-tertiary cursor-pointer hover:text-okx-text-primary"><svg className="w-3.5 h-3.5 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.375a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg></span>
                      <span className="text-okx-text-tertiary cursor-pointer hover:text-okx-text-primary"><svg className="w-3.5 h-3.5 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg></span>
                      <span className="text-okx-text-tertiary cursor-pointer hover:text-okx-text-primary">♡</span>
                    </div>
                  </div>
                  {/* DEV/Creator 标识在地址下方 */}
                  {(trade.isDev || trade.isCreator || trade.label === "DEV" || trade.label === "CREATOR") && (
                    <div className="flex gap-1 mt-0.5">
                      {(trade.isDev || trade.label === "DEV") && (
                        <span className="text-[10px] text-[#FF9500] flex items-center gap-0.5"><svg className="w-3 h-3 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" /></svg> {t('holders.dev')}</span>
                      )}
                      {(trade.isCreator || trade.label === "CREATOR") && (
                        <span className="text-[10px] text-[#007AFF] flex items-center gap-0.5"><svg className="w-3 h-3 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /></svg> {t('holders.creator')}</span>
                      )}
                    </div>
                  )}
                </td>

                {/* 资金池 */}
                <td className="py-3 px-3 text-center">
                  <div className="bg-[#A3E635] w-4 h-4 rounded-full flex items-center justify-center mx-auto"><svg className="w-2.5 h-2.5 text-black" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" /></svg></div>
                </td>

                {/* 详情 */}
                <td className="py-3 px-3 text-center">
                  <a 
                    href={`https://sepolia.basescan.org/tx/${trade.txHash}`}
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-okx-text-tertiary hover:text-okx-text-primary"
                  >
                    <svg className="w-3.5 h-3.5 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
