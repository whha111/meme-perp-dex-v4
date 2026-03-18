"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useTradeHistory, type SpotTradeRecord } from "@/hooks/common/useTradeHistory";
import { formatTokenPrice } from "@/utils/formatters";

interface TradeHistoryTableProps {
  token?: string;
  maxRows?: number;
  className?: string;
}

export function TradeHistoryTable({ token, maxRows = 10, className = "" }: TradeHistoryTableProps) {
  const { trades, isConnected, error } = useTradeHistory({ token, limit: maxRows });
  const t = useTranslations();

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatNumber = (value: string, decimals: number = 4) => {
    const num = parseFloat(value);
    if (isNaN(num)) return "0";
    if (num < 0.0001) return formatTokenPrice(num);
    return num.toFixed(decimals);
  };

  const shortenTxHash = (hash: string) => {
    if (!hash || hash.length <= 13) return hash || "-";
    return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
  };

  return (
    <div className={`bg-okx-bg-card border border-okx-border-primary rounded-xl p-4 ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold">{t('history.tradeHistory')}</h3>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              isConnected ? "bg-okx-up animate-pulse" : "bg-okx-down"
            }`}
          />
          <span className="text-okx-text-tertiary">
            {isConnected ? t('trading.realtime') : t('common.offline')}
          </span>
        </div>
      </div>

      {trades.length === 0 ? (
        <div className="text-center py-8 text-okx-text-tertiary">
          {isConnected ? t('history.waitingForTrades') : t('trading.connecting')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                <th className="text-left py-2">{t('history.time')}</th>
                <th className="text-left py-2">{t('history.pair')}</th>
                <th className="text-left py-2">{t('history.direction')}</th>
                <th className="text-right py-2">{t('history.quantity')}</th>
                <th className="text-right py-2">{t('history.price')}</th>
                <th className="text-right py-2">{t('history.total')}</th>
                <th className="text-right py-2">{t('history.txHash')}</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.id} className="border-b border-okx-border-secondary hover:bg-okx-bg-hover">
                  <td className="py-3 text-okx-text-secondary">{formatTime(trade.timestamp)}</td>
                  <td className="py-3 font-mono text-xs">{trade.token.slice(0, 8)}...</td>
                  <td className={`py-3 font-medium ${trade.side === "buy" ? "text-okx-up" : "text-okx-down"}`}>
                    {trade.side === "buy" ? t('token.buy') : t('token.sell')}
                  </td>
                  <td className="py-3 text-right">{formatNumber(trade.size, 2)}</td>
                  <td className="py-3 text-right">{formatNumber(trade.price, 6)}</td>
                  <td className="py-3 text-right">{formatNumber(trade.value)} BNB</td>
                  <td className="py-3 text-right">
                    {trade.txHash ? (
                      <a
                        href={`https://testnet.bscscan.com/tx/${trade.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-okx-accent hover:underline font-mono"
                      >
                        {shortenTxHash(trade.txHash)}
                      </a>
                    ) : (
                      <span className="text-okx-text-tertiary">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <p className="text-xs text-okx-down mt-2 text-center">
          {t('common.wsConnectionFailed')}: {error}
        </p>
      )}
    </div>
  );
}

export default TradeHistoryTable;
