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
            <div className="bg-[#A3E635] w-3 h-3 rounded-full flex items-center justify-center"><svg className="w-2 h-2 text-black" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" /></svg></div>
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
              <svg className="w-3.5 h-3.5 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.375a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
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
                <svg className="w-3.5 h-3.5 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" /></svg>
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
                <svg className="w-3.5 h-3.5 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
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
                <svg className="w-3.5 h-3.5 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>
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
           <button className="hover:text-okx-text-primary"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg></button>
        </div>
      </div>
    </div>
  );
}


