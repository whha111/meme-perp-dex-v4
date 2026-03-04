"use client";

import React from "react";
import { SecurityStatus } from "./SecurityStatusBanner";
import { useTranslations } from "next-intl";

import { useToast } from "@/components/shared/Toast";
import { AnimatedNumber } from "@/components/shared/AnimatedNumber";
import { useETHPrice } from "@/hooks/common/useETHPrice";

// 格式化非常小的价格，使用下标表示法 (e.g., $0.0₅62087)
function formatSmallPrice(priceUsd: number): string {
  if (priceUsd <= 0) return "0.00";
  if (priceUsd >= 0.01) return priceUsd.toFixed(4);
  if (priceUsd >= 0.0001) return priceUsd.toFixed(6);

  // 对于非常小的价格，使用下标表示法
  const priceStr = priceUsd.toFixed(18);
  const match = priceStr.match(/^0\.(0*)([1-9]\d*)/);
  if (match) {
    const zeroCount = match[1].length;
    const significantDigits = match[2].slice(0, 5); // 保留5位有效数字
    const subscripts = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
    const subscriptNum = zeroCount.toString().split('').map(d => subscripts[parseInt(d)]).join('');
    return `0.0${subscriptNum}${significantDigits}`;
  }

  return priceUsd.toFixed(8);
}

interface TokenMetadataDisplay {
  logoUrl?: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
}

interface PriceBoardProps {
  symbol: string;  // 交易对符号或合约地址
  displaySymbol?: string;  // 显示用的符号名称
  tokenAddress?: string;
  currentPrice: bigint;
  price24hChange: number;
  marketCap: bigint;
  volume24h: bigint;
  securityStatus: SecurityStatus;
  metadata?: TokenMetadataDisplay;
  className?: string;
}

export function PriceBoard({
  symbol,
  displaySymbol,
  tokenAddress,
  currentPrice,
  price24hChange,
  marketCap,
  volume24h,
  securityStatus,
  metadata,
  className
}: PriceBoardProps) {
  // 使用 displaySymbol 或 symbol（截断长地址）
  const tokenSymbol = displaySymbol || (symbol.startsWith("0x") && symbol.length > 10
    ? `${symbol.slice(0, 6)}...${symbol.slice(-4)}`
    : symbol.toUpperCase());
  const { showToast } = useToast();
  const t = useTranslations("common");

  // ✅ 获取实时 ETH 价格
  const { price: ethPrice } = useETHPrice();

  // currentPrice 是 wei 单位，需要转换为 ETH
  // 对于非常小的价格（如 Gwei 级别），需要特殊处理
  const currentPriceFloat = Number(currentPrice);
  const currentPriceEth = currentPriceFloat / 1e18;
  const currentPriceUsd = currentPriceEth * ethPrice;

  // marketCap (FDV) 是 wei 单位
  const marketCapFloat = Number(marketCap);
  const mCapEth = marketCapFloat / 1e18;
  const mCapUsd = mCapEth * ethPrice;

  // volume24h 是 wei 单位
  const volumeFloat = Number(volume24h);
  const volumeEth = volumeFloat / 1e18;
  const volumeUsd = volumeEth * ethPrice;

  return (
    <div className={`bg-okx-bg-primary px-4 py-2 border-b border-okx-border-primary flex items-center justify-between ${className}`}>
      {/* 左侧：代币身份与社交 */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="w-9 h-9 rounded-full overflow-hidden border border-[#333]">
             <img
               src={metadata?.logoUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${symbol}`}
               alt=""
               className="w-full h-full object-cover"
               onError={(e) => {
                 (e.target as HTMLImageElement).src = `https://api.dicebear.com/7.x/identicon/svg?seed=${symbol}`;
               }}
             />
          </div>
          <div className="absolute -bottom-1 -right-1 bg-okx-bg-primary rounded-full p-0.5">
            <div className="bg-[#A3E635] w-3 h-3 rounded-full flex items-center justify-center text-[8px]">💊</div>
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-okx-text-primary font-bold text-[16px] uppercase tracking-tight">{tokenSymbol}</h1>
            <span className="text-okx-text-secondary text-[11px] uppercase">${tokenSymbol}</span>
            <span
              className="text-okx-text-tertiary text-[10px] cursor-pointer hover:text-okx-text-primary transition-colors"
              onClick={() => {
                if (tokenAddress) {
                  navigator.clipboard.writeText(tokenAddress);
                  showToast(t("contractCopied"), "success");
                } else {
                  showToast(t("addressUnknown"), "error");
                }
              }}
              title={tokenAddress || t("addressUnknown")}
            >
              📋
            </span>
            {/* 社交链接 */}
            {metadata?.website && (
              <a
                href={metadata.website.startsWith("http") ? metadata.website : `https://${metadata.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-okx-text-tertiary text-[12px] hover:text-okx-text-primary transition-colors"
                title={metadata.website}
              >
                🌐
              </a>
            )}
            {metadata?.twitter && (
              <a
                href={metadata.twitter.startsWith("http") ? metadata.twitter : `https://twitter.com/${metadata.twitter.replace("@", "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-okx-text-tertiary text-[12px] hover:text-[#1DA1F2] transition-colors"
                title={metadata.twitter}
              >
                𝕏
              </a>
            )}
            {metadata?.telegram && (
              <a
                href={metadata.telegram.startsWith("http") ? metadata.telegram : `https://t.me/${metadata.telegram.replace("@", "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-okx-text-tertiary text-[12px] hover:text-[#0088cc] transition-colors"
                title={metadata.telegram}
              >
                ✈️
              </a>
            )}
            {metadata?.discord && (
              <a
                href={metadata.discord.startsWith("http") ? metadata.discord : `https://discord.gg/${metadata.discord}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-okx-text-tertiary text-[12px] hover:text-[#5865F2] transition-colors"
                title={metadata.discord}
              >
                💬
              </a>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px]">
            <span className="text-[#FFB800]">★</span>
            <span className={`${price24hChange >= 0 ? "text-[#00D26A]" : "text-[#FF3B30]"} font-medium`}>
              {price24hChange >= 0 ? "+" : ""}{price24hChange.toFixed(2)}%
            </span>
            <span className="text-okx-text-secondary">BSC Testnet</span>
            <span className="bg-[#00D26A] text-black px-1 rounded-[2px] text-[9px] font-bold italic">{t("verified")}</span>
          </div>
        </div>
      </div>

      {/* 右侧：核心财务数据 */}
      <div className="flex items-center gap-8">
        <div className="flex flex-col items-end">
          <div className="flex items-baseline gap-2">
            <span className="text-okx-text-primary font-bold text-[20px]">
              $<AnimatedNumber 
                value={mCapUsd} 
                format={(val) => val >= 1000000 ? (val / 1000000).toFixed(2) + "M" : val >= 1000 ? (val / 1000).toFixed(2) + "K" : val.toFixed(2)} 
              />
            </span>
            <span className="text-okx-text-secondary text-[11px]">{t("marketCap")}</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-okx-text-secondary mt-1">
             <div className="flex gap-1">{t("price")} <b className="text-okx-text-primary">
               $<AnimatedNumber
                 value={currentPriceUsd}
                 format={formatSmallPrice}
               />
             </b></div>
             <div className="flex gap-1">{t("volume24h")} <b className="text-okx-text-primary">${volumeUsd >= 1000 ? (volumeUsd / 1000).toFixed(2) + "K" : volumeUsd.toFixed(2)}</b></div>
             <div className="flex gap-1">{t("security")} <b className={securityStatus === 'MISMATCH' || securityStatus === 'MISSING' ? "text-[#FF3B30]" : "text-[#00D26A]"}>
               {securityStatus === 'MISMATCH' || securityStatus === 'MISSING' ? t("risky") : t("safe")} ›
             </b></div>
          </div>
        </div>
        
        {/* 功能图标 */}
        <div className="flex items-center gap-4 text-okx-text-secondary">
           <button className="hover:text-okx-text-primary">⚙️</button>
        </div>
      </div>
    </div>
  );
}


