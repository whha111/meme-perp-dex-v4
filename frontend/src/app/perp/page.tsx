"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";
import { PerpetualTradingTerminal } from "@/components/perpetual/PerpetualTradingTerminal";
import { TradingErrorBoundary } from "@/components/shared/TradingErrorBoundary";
import { useTranslations } from "next-intl";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { trackRender } from "@/lib/debug-render";
import { useTradingDataStore, type WssOnChainToken } from "@/lib/stores/tradingDataStore";
import { useUnifiedWebSocket } from "@/hooks/common/useUnifiedWebSocket";
import { type Address } from "viem";

// 市场分类
type MarketCategory = "all" | "hot" | "new" | "meme" | "layer2" | "favorites";

// IPFS URL 转 HTTP 网关 URL
function ipfsToHttp(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    return uri.replace("ipfs://", "https://gateway.pinata.cloud/ipfs/");
  }
  if (uri.startsWith("https://") || uri.startsWith("http://")) {
    return uri;
  }
  if (uri.startsWith("Qm") && uri.length === 46) {
    return `https://gateway.pinata.cloud/ipfs/${uri}`;
  }
  if (uri.startsWith("bafy")) {
    return `https://gateway.pinata.cloud/ipfs/${uri}`;
  }
  return "";
}

// 解析 metadataURI 获取 logo URL
function parseMetadataURI(uri: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("data:application/json;base64,")) {
    try {
      const base64Data = uri.replace("data:application/json;base64,", "");
      const jsonStr = atob(base64Data);
      const metadata = JSON.parse(jsonStr);
      const imageUrl = metadata.image || metadata.logo;
      if (imageUrl) return ipfsToHttp(imageUrl);
    } catch (e) {
      console.warn("Failed to parse metadataURI:", e);
    }
    return undefined;
  }
  if (uri.startsWith("ipfs://")) return ipfsToHttp(uri);
  if (uri.startsWith("http")) return uri;
  if (uri.startsWith("Qm") || uri.startsWith("bafy")) return ipfsToHttp(uri);
  return undefined;
}

// 格式化数值显示
function formatValue(value: number, prefix: string = "$"): string {
  if (value >= 1_000_000) return prefix + (value / 1_000_000).toFixed(2) + "M";
  if (value >= 1_000) return prefix + (value / 1_000).toFixed(2) + "K";
  if (value > 0) return prefix + value.toFixed(2);
  return prefix + "0";
}

// 格式化代币价格
function formatPrice(priceWei: string, ethPrice: number): string {
  const priceEth = parseFloat(priceWei) || 0;
  const priceUsd = priceEth * ethPrice;
  if (priceUsd >= 1) return "$" + priceUsd.toFixed(4);
  if (priceUsd >= 0.001) return "$" + priceUsd.toFixed(6);
  return "$" + priceUsd.toFixed(8);
}

function PerpContent() {
  trackRender("PerpContent");

  const searchParams = useSearchParams();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations();
  const tPerp = useTranslations("perp");

  const { price: ethPrice } = useETHPrice();
  const ETH_PRICE_USD = ethPrice || 2000;

  const { isConnected: wsConnected } = useUnifiedWebSocket({ enabled: true });

  const allTokens = useTradingDataStore((state) => state.allTokens);
  const allTokensLoaded = useTradingDataStore((state) => state.allTokensLoaded);
  const tokenStatsMap = useTradingDataStore((state) => state.tokenStats);

  const tokens = useMemo(() => {
    return [...allTokens].sort((a, b) => b.createdAt - a.createdAt);
  }, [allTokens]);

  const isLoading = !allTokensLoaded;
  const urlSymbol = searchParams.get("symbol");

  const [activeCategory, setActiveCategory] = useState<MarketCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // 分类配置 (i18n) — 与设计稿 hjfIJ 一致: 带 emoji 前缀
  const CATEGORIES: { key: MarketCategory; label: string }[] = useMemo(() => [
    { key: "all", label: tPerp("catAll") },
    { key: "hot", label: tPerp("catHot") },
    { key: "new", label: tPerp("catNew") },
    { key: "meme", label: "Meme" },
    { key: "layer2", label: "Layer2" },
    { key: "favorites", label: tPerp("catFavorites") },
  ], [tPerp]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 为每个代币计算交易统计数据
  const tokensWithStats = useMemo(() => {
    return tokens.map((token) => {
      const marketCapFloat = parseFloat(token.marketCap) || 0;
      const marketCapUsd = marketCapFloat * ETH_PRICE_USD;
      const stats = tokenStatsMap.get(token.address.toLowerCase() as Address);
      const priceChange24h = parseFloat(stats?.priceChangePercent24h || "0");
      // volume24h from matching engine is in ETH — convert to USD
      const volumeRaw = parseFloat(stats?.volume24h || "0");
      // Sanity check: if value looks like wei (>1e12), normalize
      const volumeEth = volumeRaw > 1e12 ? volumeRaw / 1e18 : volumeRaw;
      const volume24h = volumeEth * ETH_PRICE_USD;
      const hotScore = marketCapUsd * 0.5 + volume24h * 0.3 + (token.isGraduated ? 1000 : 0);

      return {
        ...token,
        marketCapUsd,
        priceChange24h,
        volume24h,
        hotScore,
      };
    });
  }, [tokens, tokenStatsMap, ETH_PRICE_USD]);

  // 按分类和搜索过滤
  const filteredTokens = useMemo(() => {
    let result = [...tokensWithStats];

    // 搜索过滤
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q)
      );
    }

    // 分类排序
    switch (activeCategory) {
      case "hot":
        result.sort((a, b) => b.hotScore - a.hotScore);
        break;
      case "new":
        result.sort((a, b) => b.createdAt - a.createdAt);
        break;
      default:
        result.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    }

    return result;
  }, [tokensWithStats, activeCategory, searchQuery]);

  // 统计数据
  const totalVolume24h = tokensWithStats.reduce((sum, t) => sum + t.volume24h, 0);
  const totalMarketCap = tokensWithStats.reduce((sum, t) => sum + t.marketCapUsd, 0);
  const activeTokens = tokensWithStats.filter((t) => t.isActive !== false).length;

  if (!mounted || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-64px)]">
        <div className="w-8 h-8 border-4 border-okx-accent border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  // 如果指定了 symbol，显示永续合约交易终端
  if (urlSymbol) {
    const isTokenAddress = urlSymbol.startsWith("0x") && urlSymbol.length === 42;
    return (
      <div className="perp-theme">
        <TradingErrorBoundary module="PerpetualTradingTerminal">
          <PerpetualTradingTerminal
            symbol={urlSymbol}
            tokenAddress={isTokenAddress ? (urlSymbol as `0x${string}`) : undefined}
          />
        </TradingErrorBoundary>
      </div>
    );
  }

  // 无代币状态
  if (tokens.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-64px)] gap-4">
        <p className="text-okx-text-secondary text-lg">{t("market.noTokens")}</p>
        <button
          onClick={() => router.push("/create")}
          className="bg-okx-accent text-black px-6 py-2 rounded-lg font-bold hover:opacity-90 transition-opacity"
        >
          {t("nav.createToken")}
        </button>
      </div>
    );
  }

  return (
    <div className="perp-theme min-h-[calc(100vh-64px)] bg-okx-bg-primary">
      {/* Hero Section */}
      <div className="border-b border-okx-border-primary px-4 md:px-8 lg:px-12 py-4 md:py-6 space-y-4 md:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-lg md:text-[22px] font-bold text-okx-text-primary">{tPerp("marketTitle")}</h1>
            <p className="text-[12px] md:text-[13px] text-okx-text-tertiary">{tPerp("marketSubtitle")}</p>
          </div>

          {/* Search */}
          <div className="flex items-center w-full sm:w-[280px] h-10 bg-okx-bg-card border border-okx-border-primary rounded-lg px-3.5 gap-2">
            <svg className="w-4 h-4 text-okx-text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
            <input
              type="text"
              placeholder={tPerp("searchPairs")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-[13px] text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none"
            />
          </div>
        </div>

        {/* Stats Cards — responsive grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          {[
            { label: tPerp("totalVolume24h"), value: formatValue(totalVolume24h), color: "text-okx-text-primary" },
            { label: tPerp("totalOI"), value: formatValue(totalMarketCap), color: "text-okx-text-primary" },
            { label: tPerp("activePairs"), value: `${activeTokens} ${tPerp("pairsUnit")}`, color: "text-okx-text-primary" },
            { label: tPerp("insuranceFund"), value: "2.00 ETH", color: "text-okx-up" },
          ].map((stat, idx) => (
            <div key={idx} className="bg-okx-bg-card rounded-lg py-3 px-4 md:py-4 md:px-5">
              <div className="text-[11px] md:text-[12px] text-okx-text-tertiary mb-1">{stat.label}</div>
              <div className={`text-[15px] md:text-[18px] font-bold font-mono ${stat.color}`}>{stat.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Table Section */}
      <div className="px-4 md:px-8 lg:px-12 pt-4">
        {/* Category Tabs — horizontally scrollable on mobile */}
        <div className="flex items-center gap-1.5 pb-3 overflow-x-auto">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`px-5 py-2 rounded-md text-[13px] font-medium transition-all ${
                activeCategory === cat.key
                  ? "bg-okx-accent text-black font-bold"
                  : "text-okx-text-secondary hover:text-okx-text-primary hover:bg-okx-bg-card"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Table — horizontally scrollable on mobile/tablet */}
        <div className="overflow-x-auto">
        <div className="min-w-[960px]">
        {/* Table Header */}
        <div className="flex items-center bg-okx-bg-card rounded-t-md px-4 py-3 text-[12px] font-semibold text-okx-text-tertiary">
          <div className="w-[200px]">{tPerp("pair")}</div>
          <div className="w-[130px] text-right">{tPerp("latestPrice")}</div>
          <div className="w-[100px] text-right">{tPerp("change24h")}</div>
          <div className="w-[140px] text-right">{tPerp("volume24h")}</div>
          <div className="w-[140px] text-right">{tPerp("openInterest")}</div>
          <div className="w-[100px] text-right">{tPerp("fundingRate")}</div>
          <div className="w-[120px] text-center">{tPerp("trend7d")}</div>
          <div className="flex-1 text-right">{tPerp("action")}</div>
        </div>

        {/* Table Rows */}
        <div>
          {filteredTokens.map((token) => {
            const isOnChain = token.isActive !== false;
            const priceStr = formatPrice(token.price || "0", ETH_PRICE_USD);
            const changeClass = token.priceChange24h >= 0 ? "text-okx-up" : "text-okx-down";
            const changeSign = token.priceChange24h >= 0 ? "+" : "";
            const isNew = Date.now() / 1000 - token.createdAt < 86400 * 3; // 3 days

            return (
              <div
                key={token.address}
                onClick={() => isOnChain && router.push(`/perp?symbol=${token.address}`)}
                className={`flex items-center px-4 py-3.5 border-b border-okx-border-primary transition-colors ${
                  isOnChain ? "hover:bg-okx-bg-hover/50 cursor-pointer" : "opacity-50 cursor-not-allowed"
                }`}
              >
                {/* Pair Name */}
                <div className="w-[200px] flex items-center gap-3">
                  <svg className="w-4 h-4 text-okx-text-tertiary cursor-pointer hover:text-okx-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /></svg>
                  <div className="w-7 h-7 rounded-full overflow-hidden bg-okx-bg-hover flex-shrink-0">
                    <img
                      src={parseMetadataURI(token.metadataURI) || `https://api.dicebear.com/7.x/identicon/svg?seed=${token.address}`}
                      alt={token.symbol}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = `https://api.dicebear.com/7.x/identicon/svg?seed=${token.address}`;
                      }}
                    />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-okx-text-primary">{token.symbol}/USDT</span>
                      {isNew && (
                        <span className="text-[10px] bg-okx-accent/20 text-okx-accent px-1.5 py-0.5 rounded font-bold">
                          NEW
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-okx-text-tertiary">{tPerp("perpetualLabel")}</div>
                  </div>
                </div>

                {/* Price */}
                <div className="w-[130px] text-right">
                  <span className="text-sm font-mono font-medium text-okx-text-primary">{priceStr}</span>
                </div>

                {/* 24h Change */}
                <div className="w-[100px] text-right">
                  <span className={`text-sm font-mono font-medium px-2 py-1 rounded ${changeClass} ${
                    token.priceChange24h >= 0 ? "bg-okx-up/10" : "bg-okx-down/10"
                  }`}>
                    {changeSign}{token.priceChange24h.toFixed(2)}%
                  </span>
                </div>

                {/* 24h Volume */}
                <div className="w-[140px] text-right">
                  <span className="text-sm font-mono text-okx-text-primary">
                    {formatValue(token.volume24h)}
                  </span>
                </div>

                {/* Open Interest */}
                <div className="w-[140px] text-right">
                  <span className="text-sm font-mono text-okx-text-primary">
                    {formatValue(token.marketCapUsd)}
                  </span>
                </div>

                {/* Funding Rate */}
                <div className="w-[100px] text-right">
                  <span className="text-sm font-mono text-okx-up">+0.01%</span>
                </div>

                {/* 7d Trend (simple placeholder) */}
                <div className="w-[120px] flex justify-center">
                  <svg width="80" height="24" viewBox="0 0 80 24">
                    <path
                      d={token.priceChange24h >= 0
                        ? "M0 20 L10 16 L20 18 L30 12 L40 14 L50 8 L60 10 L70 4 L80 6"
                        : "M0 4 L10 8 L20 6 L30 12 L40 10 L50 16 L60 14 L70 20 L80 18"}
                      stroke={token.priceChange24h >= 0 ? "var(--okx-up)" : "var(--okx-down)"}
                      strokeWidth="1.5"
                      fill="none"
                    />
                  </svg>
                </div>

                {/* Trade Button */}
                <div className="flex-1 text-right">
                  <button
                    className="px-4 py-1.5 bg-okx-accent text-black text-xs font-bold rounded hover:opacity-90 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/perp?symbol=${token.address}`);
                    }}
                  >
                    {tPerp("trade")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {filteredTokens.length === 0 && (
          <div className="py-12 text-center text-okx-text-tertiary text-sm">
            {searchQuery ? tPerp("noMatchingPairs") : t("market.noTokens")}
          </div>
        )}
        </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 永续合约交易页面
 * - 无 symbol 参数时显示市场列表
 * - 有 symbol 参数时显示永续合约交易终端
 */
export default function PerpetualTradingPage() {
  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />
      <Suspense
        fallback={
          <div className="flex items-center justify-center min-h-[calc(100vh-64px)]">
            <div className="w-8 h-8 border-4 border-okx-accent border-t-transparent rounded-full animate-spin"></div>
          </div>
        }
      >
        <PerpContent />
      </Suspense>
    </main>
  );
}
