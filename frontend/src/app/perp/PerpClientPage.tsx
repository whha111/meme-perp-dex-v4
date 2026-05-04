"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { PerpetualTradingTerminal } from "@/components/perpetual/PerpetualTradingTerminal";
import { TradingErrorBoundary } from "@/components/shared/TradingErrorBoundary";
import { useTranslations } from "next-intl";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { trackRender } from "@/lib/debug-render";
import { useTradingDataStore, type WssOnChainToken } from "@/lib/stores/tradingDataStore";
import { useAppStore } from "@/lib/stores/appStore";
import { type Address } from "viem";
import { FALLBACK_MEME_MARKETS, fetchMemeMarkets, formatUsd, type MemePerpMarket } from "@/lib/memeMarkets";

// 甯傚満鍒嗙被
type MarketCategory = "all" | "hot" | "new" | "meme" | "layer2" | "favorites";
const DEFAULT_MARKET_ID = "PEPE-USDT-PERP";

// IPFS URL 杞?HTTP 缃戝叧 URL
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

// 瑙ｆ瀽 metadataURI 鑾峰彇 logo URL
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

// 鏍煎紡鍖栨暟鍊兼樉绀?
function formatValue(value: number, prefix: string = "$"): string {
  if (value >= 1_000_000) return prefix + (value / 1_000_000).toFixed(2) + "M";
  if (value >= 1_000) return prefix + (value / 1_000).toFixed(2) + "K";
  if (value > 0) return prefix + value.toFixed(2);
  return prefix + "0";
}

// 鏍煎紡鍖栦唬甯佷环鏍?鈥?price 鏄?1e18 绮惧害鐨?wei 瀛楃涓诧紝闇€鍏堣浆涓?ETH 鍗曚綅
function formatPrice(priceWei: string, ethPrice: number): string {
  const priceEth = (parseFloat(priceWei) / 1e18) || 0;
  const priceUsd = priceEth * ethPrice;
  if (priceUsd >= 1) return "$" + priceUsd.toFixed(4);
  if (priceUsd >= 0.001) return "$" + priceUsd.toFixed(6);
  return "$" + priceUsd.toFixed(8);
}

/**
 * Deterministic mini sparkline using token address as seed.
 * Generates unique-per-token paths 鈥?not real 7d data (no API yet),
 * but visually distinct per token. Color reflects real 24h direction.
 */
const MiniSparkline = React.memo(function MiniSparkline({
  address,
  isUp,
}: {
  address: string;
  isUp: boolean;
}) {
  // Simple hash from address chars to generate 8 pseudo-random y-values
  const points = useMemo(() => {
    const seed = address.slice(2, 18); // 16 hex chars
    const ys: number[] = [];
    for (let i = 0; i < 8; i++) {
      const hex = seed.slice(i * 2, i * 2 + 2);
      ys.push(4 + (parseInt(hex, 16) / 255) * 16); // y between 4-20
    }
    // If up trend, sort to generally go down (y decreases = line goes up)
    // If down trend, sort to generally go up
    if (isUp) {
      // Nudge: make later points lower (higher on screen = lower y)
      for (let i = 4; i < 8; i++) ys[i] = Math.max(4, ys[i] - 4);
    } else {
      for (let i = 4; i < 8; i++) ys[i] = Math.min(20, ys[i] + 4);
    }
    return ys.map((y, i) => `${i === 0 ? "M" : "L"}${i * 11.4} ${y.toFixed(1)}`).join(" ");
  }, [address, isUp]);

  return (
    <svg width="80" height="24" viewBox="0 0 80 24">
      <path
        d={points}
        stroke={isUp ? "var(--okx-up)" : "var(--okx-down)"}
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
});

function PerpContent() {
  trackRender("PerpContent");

  const searchParams = useSearchParams();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations();
  const tPerp = useTranslations("perp");

  const { price: bnbPrice } = useETHPrice();
  // useETHPrice (alias useBNBPrice) already provides $600 fallback 鈥?no need to override
  const BNB_PRICE_USD = bnbPrice;

  const allTokens = useTradingDataStore((state) => state.allTokens);
  const allTokensLoaded = useTradingDataStore((state) => state.allTokensLoaded);
  const tokenStatsMap = useTradingDataStore((state) => state.tokenStats);
  const fundingRatesMap = useTradingDataStore((state) => state.fundingRates);
  const insuranceFund = useTradingDataStore((state) => state.insuranceFund);

  const tokens = useMemo(() => {
    return [...allTokens].sort((a, b) => b.createdAt - a.createdAt);
  }, [allTokens]);

  const isLoading = !allTokensLoaded;
  const urlSymbol = searchParams.get("symbol");
  const urlMarketId = searchParams.get("marketId");
  const effectiveMarketId = urlMarketId || (!urlSymbol ? DEFAULT_MARKET_ID : null);
  const [memeMarkets, setMemeMarkets] = useState<MemePerpMarket[]>(FALLBACK_MEME_MARKETS);
  const [memeMarketsLoading, setMemeMarketsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchMemeMarkets()
      .then((markets) => {
        if (!cancelled) setMemeMarkets(markets.length ? markets : FALLBACK_MEME_MARKETS);
      })
      .catch(() => {
        if (!cancelled) setMemeMarkets(FALLBACK_MEME_MARKETS);
      })
      .finally(() => {
        if (!cancelled) setMemeMarketsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedMemeMarket = useMemo(() => {
    if (!effectiveMarketId) return undefined;
    return memeMarkets.find((market) => market.marketId === effectiveMarketId.toUpperCase());
  }, [memeMarkets, effectiveMarketId]);

  const [activeCategory, setActiveCategory] = useState<MarketCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const favoriteInstruments = useAppStore((s) => s.favoriteInstruments);
  const toggleFavorite = useAppStore((s) => s.toggleFavoriteInstrument);

  // 鍒嗙被閰嶇疆 (i18n) 鈥?涓庤璁＄ hjfIJ 涓€鑷? 甯?emoji 鍓嶇紑
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

  // 涓烘瘡涓唬甯佽绠椾氦鏄撶粺璁℃暟鎹?
  const tokensWithStats = useMemo(() => {
    return tokens.map((token) => {
      const marketCapFloat = (parseFloat(token.marketCap) / 1e18) || 0;
      const marketCapUsd = marketCapFloat * BNB_PRICE_USD;
      const stats = tokenStatsMap.get(token.address.toLowerCase() as Address);
      const priceChange24h = parseFloat(stats?.priceChangePercent24h || "0");
      // volume24h from matching engine is in BNB 鈥?convert to USD
      const volumeRaw = parseFloat(stats?.volume24h || "0");
      // Sanity check: if value looks like wei (>1e12), normalize
      const volumeBnb = volumeRaw > 1e12 ? volumeRaw / 1e18 : volumeRaw;
      const volume24h = volumeBnb * BNB_PRICE_USD;
      // OI from matching engine (BNB, 1e18 precision)
      const oiRaw = parseFloat(stats?.openInterest || "0");
      const oiBnb = oiRaw > 1e12 ? oiRaw / 1e18 : oiRaw;
      const openInterestUsd = oiBnb * BNB_PRICE_USD;
      // Funding rate from store
      const fr = fundingRatesMap.get(token.address.toLowerCase() as Address);
      const fundingRate = fr ? parseFloat(fr.rate) / 10000 : null; // rate is in basis points (1e4)
      const hotScore = marketCapUsd * 0.5 + volume24h * 0.3 + (token.isGraduated ? 1000 : 0);

      return {
        ...token,
        marketCapUsd,
        priceChange24h,
        volume24h,
        openInterestUsd,
        fundingRate,
        hotScore,
      };
    });
  }, [tokens, tokenStatsMap, fundingRatesMap, BNB_PRICE_USD]);

  // 鎸夊垎绫诲拰鎼滅储杩囨护
  const filteredTokens = useMemo(() => {
    let result = [...tokensWithStats];

    // 鎼滅储杩囨护
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.symbol.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.address.toLowerCase().includes(q)
      );
    }

    // 鍒嗙被杩囨护 + 鎺掑簭
    switch (activeCategory) {
      case "favorites":
        result = result.filter((t) => favoriteInstruments.has(t.symbol.toUpperCase()));
        break;
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
  }, [tokensWithStats, activeCategory, searchQuery, favoriteInstruments]);

  // 缁熻鏁版嵁
  const totalVolume24h = tokensWithStats.reduce((sum, t) => sum + t.volume24h, 0);
  const totalOI = tokensWithStats.reduce((sum, t) => sum + t.openInterestUsd, 0);
  const activeTokens = tokensWithStats.filter((t) => t.isActive !== false).length;
  // Insurance fund from PerpVault 鈥?prefer display.balance (pre-formatted), fallback to raw / 1e18
  const insuranceFundDisplay = useMemo(() => {
    if (!insuranceFund) return "-- BNB";
    if (insuranceFund.display?.balance) {
      const val = parseFloat(insuranceFund.display.balance);
      return val > 0 ? `${val.toFixed(2)} BNB` : "-- BNB";
    }
    const raw = parseFloat(insuranceFund.balance);
    const bnb = raw > 1e12 ? raw / 1e18 : raw; // Handle both wei and normal formats
    return bnb > 0 ? `${bnb.toFixed(2)} BNB` : "-- BNB";
  }, [insuranceFund]);

  if (!mounted || (urlSymbol && isLoading)) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-64px)]">
        <div className="w-8 h-8 border-4 border-okx-accent border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  // 濡傛灉鎸囧畾浜?symbol锛屾樉绀烘案缁悎绾︿氦鏄撶粓绔?
  const curatedMarketsView = (
    <div className="perp-theme min-h-[calc(100vh-48px)] bg-okx-bg-primary">
      <div className="dexi-page-shell">
        <section className="dexi-page-header">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-okx-text-tertiary">
              <span className="dexi-chip">BSC Mainnet</span>
              <span className="dexi-chip">BNB collateral</span>
              <span className="dexi-chip">Signed oracle</span>
            </div>
            <h1 className="text-2xl font-semibold text-okx-text-primary md:text-3xl">Markets</h1>
            <p className="mt-2 text-sm text-okx-text-secondary">
              {memeMarketsLoading ? "Refreshing oracle state" : `${memeMarkets.length} listed perpetual markets`}
            </p>
          </div>
        </section>

        <div className="dexi-card overflow-hidden">
          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[220px_140px_140px_150px_120px_1fr] bg-okx-bg-secondary px-4 py-3 text-xs font-semibold uppercase text-okx-text-tertiary">
                <div>Market</div>
                <div className="text-right">Price</div>
                <div className="text-right">OI cap</div>
                <div className="text-right">Max position</div>
                <div className="text-right">Leverage</div>
                <div className="text-right">Status</div>
              </div>
              {memeMarkets.map((market) => {
                const priceUsd = Number(market.price?.medianPriceUsd || 0);
                const status = market.price?.status || market.status;
                const isTradeable = status !== "paused";
                return (
                  <button
                    key={market.marketId}
                    onClick={() => isTradeable && router.push(`/perp?marketId=${market.marketId}`)}
                    disabled={!isTradeable}
                    className={`grid w-full grid-cols-[220px_140px_140px_150px_120px_1fr] items-center border-t border-okx-border-primary px-4 py-3.5 text-left transition-colors ${
                      isTradeable ? "cursor-pointer hover:bg-okx-bg-hover/50" : "cursor-not-allowed opacity-50"
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-okx-text-primary">{market.displaySymbol}/USDT</span>
                        {market.experimental && <span className="dexi-mini-badge">Alpha</span>}
                      </div>
                      <div className="font-mono text-xs text-okx-text-tertiary">{market.marketId}</div>
                    </div>
                    <div className="text-right font-mono text-sm text-okx-text-primary">
                      {priceUsd > 0 ? formatUsd(priceUsd) : "--"}
                    </div>
                    <div className="text-right font-mono text-sm text-okx-text-primary">{formatUsd(market.maxOiUsd)}</div>
                    <div className="text-right font-mono text-sm text-okx-text-primary">{formatUsd(market.maxPositionUsd)}</div>
                    <div className="text-right font-mono text-sm text-okx-text-primary">{market.maxLeverage}x</div>
                    <div className="text-right">
                      <span className={`rounded px-2 py-1 text-xs font-medium ${
                        status === "active" || status === "experimental"
                          ? "bg-okx-up/10 text-okx-up"
                          : status === "reduce_only"
                          ? "bg-okx-warning/10 text-okx-warning"
                          : "bg-okx-down/10 text-okx-down"
                      }`}>
                        {status.replace("_", " ")}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  if (effectiveMarketId) {
    if (!selectedMemeMarket) {
      return curatedMarketsView;
    }

    const oraclePriceUsd = Number(selectedMemeMarket.price?.medianPriceUsd || 0) || undefined;
    return (
      <div className="perp-theme">
        <TradingErrorBoundary module="PerpetualTradingTerminal">
          <PerpetualTradingTerminal
            symbol={selectedMemeMarket.displaySymbol}
            tokenAddress={selectedMemeMarket.indexToken}
            marketId={selectedMemeMarket.marketId}
            oraclePriceUsd={oraclePriceUsd}
            maxLeverage={selectedMemeMarket.maxLeverage}
          />
        </TradingErrorBoundary>
      </div>
    );
  }

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

  // 鏃犱唬甯佺姸鎬?
  if (tokens.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-64px)] gap-4">
        <p className="text-okx-text-secondary text-lg">{t("market.noTokens")}</p>
        <button
          onClick={() => router.push("/perp")}
          className="bg-okx-accent text-black px-6 py-2 rounded-lg font-bold hover:opacity-90 transition-opacity"
        >
          View markets
        </button>
      </div>
    );
  }

  return (
    <div className="perp-theme min-h-[calc(100vh-48px)] bg-okx-bg-primary">
      {/* Hero Section */}
      <div className="border-b border-okx-border-primary px-4 md:px-8 lg:px-12 py-4 md:py-6 space-y-4 md:space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-lg md:text-[22px] font-bold text-okx-text-primary">{tPerp("marketTitle")}</h1>
            <p className="text-xs md:text-sm text-okx-text-tertiary">{tPerp("marketSubtitle")}</p>
          </div>

          {/* Search */}
          <div className="flex items-center w-full sm:w-[280px] h-10 bg-okx-bg-card border border-okx-border-primary rounded-lg px-3.5 gap-2">
            <svg className="w-4 h-4 text-okx-text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
            <input
              type="text"
              placeholder={tPerp("searchPairs")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none"
            />
          </div>
        </div>

        {/* Stats Cards 鈥?responsive grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          {[
            { label: tPerp("totalVolume24h"), value: formatValue(totalVolume24h), color: "text-okx-text-primary" },
            { label: tPerp("totalOI"), value: formatValue(totalOI), color: "text-okx-text-primary" },
            { label: tPerp("activePairs"), value: `${activeTokens} ${tPerp("pairsUnit")}`, color: "text-okx-text-primary" },
            { label: tPerp("insuranceFund"), value: insuranceFundDisplay, color: "text-okx-up" },
          ].map((stat, idx) => (
            <div key={idx} className="bg-okx-bg-card rounded-lg py-3 px-4 md:py-4 md:px-5">
              <div className="text-xs md:text-xs text-okx-text-tertiary mb-1">{stat.label}</div>
              <div className={`text-[15px] md:text-[18px] font-bold font-mono ${stat.color}`}>{stat.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Table Section */}
      <div className="px-4 md:px-8 lg:px-12 pt-4">
        {/* Category Tabs 鈥?horizontally scrollable on mobile */}
        <div className="flex items-center gap-1.5 pb-3 overflow-x-auto">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`px-5 py-2 rounded-md text-sm font-medium transition-all ${
                activeCategory === cat.key
                  ? "bg-okx-accent text-black font-bold"
                  : "text-okx-text-secondary hover:text-okx-text-primary hover:bg-okx-bg-card"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Table 鈥?horizontally scrollable on mobile/tablet */}
        <div className="overflow-x-auto">
        <div className="min-w-[960px]">
        {/* Table Header */}
        <div className="flex items-center bg-okx-bg-card rounded-t-md px-4 py-3 text-xs font-semibold text-okx-text-tertiary">
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
            const priceStr = formatPrice(token.price || "0", BNB_PRICE_USD);
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
                  <svg
                    className={`w-4 h-4 cursor-pointer transition-colors ${
                      favoriteInstruments.has(token.symbol.toUpperCase())
                        ? "text-yellow-400 fill-yellow-400"
                        : "text-okx-text-tertiary hover:text-yellow-400"
                    }`}
                    onClick={(e) => { e.stopPropagation(); toggleFavorite(token.symbol); }}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
                  ><path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /></svg>
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
                        <span className="text-xs bg-okx-accent/20 text-okx-accent px-1.5 py-0.5 rounded font-bold">
                          NEW
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-okx-text-tertiary">{tPerp("perpetualLabel")}</div>
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
                    {token.openInterestUsd > 0 ? formatValue(token.openInterestUsd) : "--"}
                  </span>
                </div>

                {/* Funding Rate */}
                <div className="w-[100px] text-right">
                  {token.fundingRate !== null ? (
                    <span className={`text-sm font-mono ${token.fundingRate >= 0 ? "text-okx-up" : "text-okx-down"}`}>
                      {token.fundingRate >= 0 ? "+" : ""}{(token.fundingRate * 100).toFixed(4)}%
                    </span>
                  ) : (
                    <span className="text-sm font-mono text-okx-text-tertiary">--</span>
                  )}
                </div>

                {/* 7d Trend 鈥?deterministic sparkline from token address hash (no real 7d history API yet) */}
                <div className="w-[120px] flex justify-center">
                  <MiniSparkline address={token.address} isUp={token.priceChange24h >= 0} />
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
 * 姘哥画鍚堢害浜ゆ槗椤甸潰
 * - 鏃?symbol 鍙傛暟鏃舵樉绀哄競鍦哄垪琛?
 * - 鏈?symbol 鍙傛暟鏃舵樉绀烘案缁悎绾︿氦鏄撶粓绔?
 */
export default function PerpetualTradingPage() {
  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
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

