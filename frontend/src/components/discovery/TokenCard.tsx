"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface TokenCardProps {
  id: string;
  name: string;
  ticker: string;
  symbol: string;
  logo?: string;
  timeAgo: string;
  address: string;
  marketCap: string;
  volume: string; // USD 格式的成交量
  traders: number; // 交易人数（唯一地址数）
  progress: number; // 0-100 的进度百分比
  priceChange24h?: number; // 24h涨跌幅
  onClick?: () => void;
}

/**
 * TokenCard - 紧凑型代币卡片
 * 显示：头像、名称、市值、24h涨跌、成交量、进度条、交易数
 */
export function TokenCard({
  id,
  name,
  ticker,
  symbol,
  logo,
  timeAgo,
  address,
  marketCap,
  volume,
  traders,
  progress,
  priceChange24h = 0,
  onClick,
}: TokenCardProps) {
  const router = useRouter();
  const t = useTranslations();

  const isPositive = priceChange24h >= 0;
  const changeColor = isPositive ? 'text-okx-up' : 'text-okx-down';
  const changeSign = isPositive ? '+' : '';

  return (
    <div
      onClick={() => router.push(`/trade/${symbol}`)}
      className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-2.5 hover:border-okx-border-hover hover:bg-okx-bg-hover transition-all cursor-pointer mb-2"
    >
      <div className="flex items-center gap-2.5">
        {/* 头像 */}
        <div className="w-10 h-10 rounded-lg overflow-hidden border border-okx-border-secondary flex-shrink-0">
          <img
            src={logo || `https://api.dicebear.com/7.x/identicon/svg?seed=${id}`}
            alt={name}
            className="w-full h-full object-cover"
            onError={(e) => {
              e.currentTarget.src = `https://api.dicebear.com/7.x/identicon/svg?seed=${id}`;
            }}
          />
        </div>

        {/* 名称和基本信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-okx-text-primary font-bold text-sm truncate">{name}</span>
            <span className="text-okx-text-tertiary text-xs">{ticker}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-okx-text-tertiary text-xs">{timeAgo}</span>
            <span className="text-okx-border-secondary">|</span>
            <span className="text-okx-text-tertiary text-xs font-mono">{address}</span>
          </div>
        </div>

        {/* 市值和涨跌 */}
        <div className="text-right flex-shrink-0">
          <div className="text-okx-text-primary font-bold text-sm">{marketCap}</div>
          <div className={`text-xs ${changeColor}`}>
            {changeSign}{priceChange24h.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* 底部信息栏 */}
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-okx-border-primary">
        <div className="flex items-center gap-3 text-xs text-okx-text-tertiary">
          <span>{t('token.volume')} <span className="text-okx-text-primary">{volume}</span></span>
          <span>{t('token.traders')} <span className="text-okx-text-primary">{traders >= 1000 ? (traders/1000).toFixed(1)+'K' : traders}</span></span>
        </div>

        {/* 进度条 */}
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-okx-bg-hover rounded-full overflow-hidden">
            <div
              className="h-full bg-meme-lime rounded-full transition-all"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
          <span className="text-xs text-meme-lime font-bold">{progress.toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
}

