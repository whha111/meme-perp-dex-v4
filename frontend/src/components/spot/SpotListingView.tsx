"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { WssOnChainToken, useTradingDataStore } from "@/lib/stores/tradingDataStore";
import { formatTokenPrice } from "@/utils/formatters";
import { getAllTokenMetadata } from "@/lib/api/tokenMetadata";
import type { Address } from "viem";

// Avatar color palette for deterministic token colors
const AVATAR_COLORS = [
  "#FF6B35", "#8B5CF6", "#EC4899", "#06B6D4",
  "#F59E0B", "#10B981", "#EF4444", "#3B82F6",
  "#14B8A6", "#F97316", "#A855F7", "#6366F1",
];

function getAvatarColor(address: string): string {
  let hash = 0;
  for (let i = 0; i < address.length; i++) {
    hash = ((hash << 5) - hash) + address.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatPrice(weiStr: string): string {
  const eth = Number(weiStr) / 1e18;
  if (eth === 0) return "0 BNB";
  return `${formatTokenPrice(eth)} BNB`;
}

function formatVolume(valueStr: string): string {
  // realETHReserve is already in ETH format (not wei) from the matching engine
  const eth = Number(valueStr);
  if (!eth || eth === 0) return "0 BNB";
  if (eth < 0.01) return `${eth.toFixed(4)} BNB`;
  if (eth < 1) return `${eth.toFixed(2)} BNB`;
  if (eth < 1000) return `${eth.toFixed(1)} BNB`;
  return `${(eth / 1000).toFixed(1)}K BNB`;
}

function formatMarketCap(weiStr: string): string {
  const usd = Number(weiStr) / 1e18;
  if (usd < 1000) return `$${usd.toFixed(0)}`;
  if (usd < 1e6) return `$${(usd / 1000).toFixed(1)}K`;
  return `$${(usd / 1e6).toFixed(2)}M`;
}

function timeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// Graduation progress: soldSupply / totalSupply (bonding curve fills at ~800M of 1B)
function getGradProgress(token: WssOnChainToken): number {
  const sold = Number(token.soldSupply || "0");
  const threshold = 800_000_000 * 1e18; // 800M tokens
  if (sold <= 0) return 0;
  const pct = (sold / threshold) * 100;
  return Math.min(pct, 100);
}

// Parse metadataURI to extract logo URL
function parseMetadataURI(uri: string | undefined): string | undefined {
  if (!uri) return undefined;

  if (uri.startsWith("ipfs://")) {
    return `https://gateway.pinata.cloud/ipfs/${uri.replace("ipfs://", "")}`;
  }

  if (uri.startsWith("data:application/json;base64,")) {
    try {
      const jsonStr = atob(uri.replace("data:application/json;base64,", ""));
      const metadata = JSON.parse(jsonStr);
      const imageUrl = metadata.image || metadata.logo;
      if (imageUrl?.startsWith("ipfs://"))
        return `https://gateway.pinata.cloud/ipfs/${imageUrl.replace("ipfs://", "")}`;
      if (imageUrl?.startsWith("http")) return imageUrl;
    } catch { /* ignore */ }
  }

  if (uri.startsWith("http")) return uri;
  if ((uri.startsWith("Qm") && uri.length === 46) || uri.startsWith("bafy"))
    return `https://gateway.pinata.cloud/ipfs/${uri}`;

  return undefined;
}

// Token avatar: shows logo image when available, falls back to letter avatar
function TokenAvatar({ token, size = 36, redisLogoMap }: { token: WssOnChainToken; size?: number; redisLogoMap?: Map<string, string> }) {
  // Try metadataURI first, then fallback to Redis metadata logoUrl
  const logoUrl = parseMetadataURI(token.metadataURI) || redisLogoMap?.get(token.address.toLowerCase());
  const color = getAvatarColor(token.address);
  const fontSize = size < 36 ? 13 : 16;

  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={token.symbol}
        width={size}
        height={size}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
        onError={(e) => {
          // Fallback to letter avatar on image load error
          const el = e.currentTarget;
          el.style.display = "none";
          const parent = el.parentElement;
          if (parent) {
            const fallback = document.createElement("div");
            fallback.className = `rounded-full flex items-center justify-center text-white font-bold flex-shrink-0`;
            fallback.style.cssText = `width:${size}px;height:${size}px;background-color:${color};font-size:${fontSize}px;display:flex;align-items:center;justify-content:center`;
            fallback.textContent = token.symbol?.charAt(0)?.toUpperCase() || "?";
            parent.appendChild(fallback);
          }
        }}
      />
    );
  }

  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
      style={{ width: size, height: size, backgroundColor: color, fontSize }}
    >
      {token.symbol?.charAt(0)?.toUpperCase() || "?"}
    </div>
  );
}

// Filter out stress test tokens (ST + 4-6 alphanumeric chars, e.g. STL397, STEQ6V)
function isStressTestToken(symbol: string): boolean {
  return /^ST[0-9A-Z]{4,6}$/i.test(symbol);
}

type SpotFilter = "all" | "active" | "graduated" | "new";

interface SpotListingViewProps {
  tokens: WssOnChainToken[];
}

export function SpotListingView({ tokens: rawTokens }: SpotListingViewProps) {
  const t = useTranslations("spotListing");
  const router = useRouter();
  const [filter, setFilter] = useState<SpotFilter>("all");
  const tokenStatsMap = useTradingDataStore(state => state.tokenStats);

  // Load Redis metadata logoUrl as fallback when metadataURI has no image
  const [redisLogoMap, setRedisLogoMap] = useState<Map<string, string>>(new Map());
  const logoMapLoaded = useRef(false);
  useEffect(() => {
    if (logoMapLoaded.current) return;
    logoMapLoaded.current = true;
    getAllTokenMetadata().then((metas) => {
      const map = new Map<string, string>();
      for (const m of metas) {
        const url = m.logoUrl || m.imageUrl;
        if (url && m.tokenAddress) {
          map.set(m.tokenAddress.toLowerCase(), url);
        }
      }
      if (map.size > 0) setRedisLogoMap(map);
    }).catch(() => {});
  }, []);

  // Exclude stress test tokens
  const tokens = useMemo(() => {
    return rawTokens.filter(tk => !isStressTestToken(tk.symbol));
  }, [rawTokens]);

  // Helper: get real stats for a token
  const getStats = (address: string) => {
    return tokenStatsMap.get(address.toLowerCase() as Address);
  };

  // Compute stats from real data
  const stats = useMemo(() => {
    const totalTokens = tokens.length;
    const graduated = tokens.filter(tk => tk.isGraduated).length;
    let totalVolumeWei = 0;
    let totalTrades = 0;
    for (const tk of tokens) {
      const s = tokenStatsMap.get(tk.address.toLowerCase() as Address);
      if (s) {
        totalVolumeWei += Number(s.volume24h || "0") / 1e18;
        totalTrades += s.trades24h || 0;
      }
    }
    const totalVolume = totalVolumeWei;
    return { totalTokens, graduated, totalVolume, totalTrades };
  }, [tokens, tokenStatsMap]);

  // Filter tokens
  const filteredTokens = useMemo(() => {
    let list = [...tokens];
    switch (filter) {
      case "active":
        list = list.filter(tk => tk.isActive && !tk.isGraduated);
        break;
      case "graduated":
        list = list.filter(tk => tk.isGraduated);
        break;
      case "new":
        list = list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        break;
      default:
        break;
    }
    return list;
  }, [tokens, filter]);

  // Trending: top 4 by marketCap
  const trending = useMemo(() => {
    return [...tokens]
      .sort((a, b) => Number(b.marketCap || "0") - Number(a.marketCap || "0"))
      .slice(0, 4);
  }, [tokens]);

  const handleTokenClick = (address: string) => {
    router.push(`/exchange?symbol=${address}`);
  };

  const filters: { key: SpotFilter; label: string }[] = [
    { key: "all", label: t("filterAll") },
    { key: "active", label: t("filterActive") },
    { key: "graduated", label: t("filterGraduated") },
    { key: "new", label: t("filterNew") },
  ];

  return (
    <div className="w-full">
      {/* ── Stats Banner ── */}
      <div className="w-full flex px-12 py-6 bg-okx-bg-secondary">
        {/* Stat 1: Total Tokens */}
        <div className="flex-1 flex flex-col items-center gap-1 py-4">
          <span className="text-[28px] font-semibold text-okx-text-primary">{stats.totalTokens.toLocaleString()}</span>
          <span className="font-mono text-xs text-okx-text-secondary">{t("statTokensCreated")}</span>
        </div>

        {/* Stat 2: 24h Volume */}
        <div className="flex-1 flex flex-col items-center gap-1 py-4 border-l border-okx-border-primary">
          <span className="text-[28px] font-semibold text-okx-text-primary">
            {stats.totalVolume < 0.01
              ? "0"
              : stats.totalVolume < 1
                ? `${stats.totalVolume.toFixed(2)} BNB`
                : stats.totalVolume < 1000
                  ? `${stats.totalVolume.toFixed(1)} BNB`
                  : `${(stats.totalVolume / 1000).toFixed(1)}K BNB`}
          </span>
          <span className="font-mono text-xs text-okx-text-secondary">{t("stat24hVolume")}</span>
        </div>

        {/* Stat 3: Total Trades */}
        <div className="flex-1 flex flex-col items-center gap-1 py-4 border-l border-okx-border-primary">
          <span className="text-[28px] font-semibold text-okx-text-primary">
            {stats.totalTrades.toLocaleString()}
          </span>
          <span className="font-mono text-xs text-okx-text-secondary">{t("statTotalTrades")}</span>
        </div>

        {/* Stat 4: Graduated */}
        <div className="flex-1 flex flex-col items-center gap-1 py-4 border-l border-okx-border-primary">
          <span className="text-[28px] font-semibold text-meme-lime">{stats.graduated}</span>
          <span className="font-mono text-xs text-okx-text-secondary">{t("statGraduated")}</span>
        </div>
      </div>

      {/* ── Trending Section ── */}
      <div className="px-12 pt-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <svg className="w-5 h-5 text-meme-lime" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" /></svg>
            <h2 className="text-[20px] font-semibold text-okx-text-primary">{t("trendingTitle")}</h2>
          </div>
          <span className="font-mono text-xs font-medium text-meme-lime cursor-pointer hover:underline">
            {t("viewAll")}
          </span>
        </div>

        {/* 4 Trending Cards */}
        <div className="grid grid-cols-4 gap-4">
          {trending.map((token) => {
            const progress = getGradProgress(token);
            return (
              <div
                key={token.address}
                className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-5 flex flex-col gap-4 cursor-pointer hover:border-okx-border-secondary transition-colors"
                onClick={() => handleTokenClick(token.address)}
              >
                {/* Top: Avatar + Name + Badge */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <TokenAvatar token={token} size={36} redisLogoMap={redisLogoMap} />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-semibold text-okx-text-primary">{token.symbol}</span>
                      <span className="font-mono text-xs text-okx-text-secondary">{token.name}</span>
                    </div>
                  </div>
                  {token.isGraduated ? (
                    <span className="font-mono text-xs font-bold text-blue-400 bg-blue-400/10 px-2 py-1 rounded flex items-center gap-1">
                      <span>DEX</span>
                      {t("badgeGraduated")}
                    </span>
                  ) : (
                    <span className="font-mono text-xs font-bold text-meme-lime bg-meme-lime/10 px-2 py-1 rounded">
                      {t("badgeHot")}
                    </span>
                  )}
                </div>

                {/* Mid: Price + Change */}
                <div className="flex items-end justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs text-okx-text-secondary">{t("price")}</span>
                    <span className="font-mono text-sm font-semibold text-okx-text-primary">
                      {formatPrice(token.price)}
                    </span>
                  </div>
                  {(() => {
                    const s = getStats(token.address);
                    const pct = Number(s?.priceChangePercent24h || "0");
                    const isPos = pct >= 0;
                    return (
                      <span className={`font-mono text-sm font-bold ${isPos ? "text-meme-lime" : "text-okx-down"}`}>
                        {isPos ? "+" : ""}{pct.toFixed(1)}%
                      </span>
                    );
                  })()}
                </div>

                {/* Bottom: Progress Bar */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs text-okx-text-secondary">{t("gradProgress")}</span>
                    <span className="font-mono text-xs font-medium text-okx-text-tertiary">
                      {progress.toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full h-1 bg-okx-bg-hover rounded-sm overflow-hidden">
                    <div
                      className="h-full bg-meme-lime rounded-sm"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                {/* Stats: Volume + Trades */}
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs text-okx-text-tertiary">{t("volume")}</span>
                    <span className="font-mono text-xs font-medium text-okx-text-tertiary">
                      {formatVolume(getStats(token.address)?.volume24h || "0")}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-mono text-xs text-okx-text-tertiary">{t("trades")}</span>
                    <span className="font-mono text-xs font-medium text-okx-text-tertiary">
                      {(getStats(token.address)?.trades24h || 0).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Token Table Section ── */}
      <div className="px-12 py-8">
        {/* Title + Filter Tabs */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-[20px] font-semibold text-okx-text-primary">{t("allTokens")}</h2>
          <div className="flex items-center gap-1">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`font-mono text-xs font-medium px-3.5 py-1.5 rounded transition-colors ${
                  filter === f.key
                    ? "bg-meme-lime text-black font-semibold"
                    : "bg-okx-bg-card text-okx-text-secondary border border-okx-border-primary hover:text-okx-text-primary"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg overflow-hidden">
          {/* Table Header */}
          <div className="flex items-center px-5 py-3 bg-okx-bg-secondary">
            <span className="w-[240px] font-mono text-xs font-semibold text-okx-text-tertiary">{t("colToken")}</span>
            <span className="w-[160px] font-mono text-xs font-semibold text-okx-text-tertiary">{t("colPrice")}</span>
            <span className="w-[100px] font-mono text-xs font-semibold text-okx-text-tertiary">{t("col24hChange")}</span>
            <span className="w-[120px] font-mono text-xs font-semibold text-okx-text-tertiary">{t("colVolume")}</span>
            <span className="w-[120px] font-mono text-xs font-semibold text-okx-text-tertiary">{t("colLiquidity")}</span>
            <span className="w-[140px] font-mono text-xs font-semibold text-okx-text-tertiary">{t("colProgress")}</span>
            <span className="w-[80px] font-mono text-xs font-semibold text-okx-text-tertiary">{t("colStatus")}</span>
            <span className="flex-1 font-mono text-xs font-semibold text-okx-text-tertiary">{t("colTime")}</span>
          </div>

          {/* Table Rows */}
          {filteredTokens.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-okx-text-secondary text-sm">
              {t("noTokens")}
            </div>
          ) : (
            filteredTokens.map((token) => {
              const progress = getGradProgress(token);
              const color = getAvatarColor(token.address);
              const tokenStat = getStats(token.address);
              const change = Number(tokenStat?.priceChangePercent24h || "0");
              const isPositive = change >= 0;

              return (
                <div
                  key={token.address}
                  className="flex items-center px-5 py-3.5 border-b border-okx-border-primary hover:bg-okx-bg-secondary cursor-pointer transition-colors"
                  onClick={() => handleTokenClick(token.address)}
                >
                  {/* Token */}
                  <div className="w-[240px] flex items-center gap-2.5">
                    <TokenAvatar token={token} size={32} redisLogoMap={redisLogoMap} />
                    <div className="flex flex-col gap-px">
                      <span className="text-sm font-semibold text-okx-text-primary">{token.symbol}</span>
                      <span className="font-mono text-xs text-okx-text-secondary truncate max-w-[160px]">
                        {token.name}
                      </span>
                    </div>
                  </div>

                  {/* Price */}
                  <span className="w-[160px] font-mono text-xs font-medium text-okx-text-primary">
                    {formatPrice(token.price)}
                  </span>

                  {/* 24h Change */}
                  <span className={`w-[100px] font-mono text-xs font-semibold ${
                    isPositive ? "text-meme-lime" : "text-okx-down"
                  }`}>
                    {isPositive ? "+" : ""}{change.toFixed(1)}%
                  </span>

                  {/* Volume */}
                  <span className="w-[120px] font-mono text-xs font-medium text-okx-text-tertiary">
                    {formatVolume(tokenStat?.volume24h || "0")}
                  </span>

                  {/* Liquidity */}
                  <span className="w-[120px] font-mono text-xs font-medium text-okx-text-tertiary">
                    {formatVolume(token.realETHReserve)}
                  </span>

                  {/* Progress */}
                  <div className="w-[140px] flex items-center gap-2">
                    <div className="w-20 h-1 bg-okx-bg-hover rounded-sm overflow-hidden">
                      <div
                        className="h-full bg-meme-lime rounded-sm"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <span className="font-mono text-xs font-medium text-okx-text-tertiary">
                      {progress.toFixed(0)}%
                    </span>
                  </div>

                  {/* Status */}
                  <div className="w-[80px]">
                    {token.isGraduated ? (
                      <span className="font-mono text-xs font-semibold text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">
                        {t("statusGraduated")}
                      </span>
                    ) : (
                      <span className="font-mono text-xs font-semibold text-meme-lime bg-meme-lime/10 px-2 py-0.5 rounded">
                        {t("statusActive")}
                      </span>
                    )}
                  </div>

                  {/* Time */}
                  <span className="flex-1 font-mono text-xs text-okx-text-secondary">
                    {token.createdAt ? timeAgo(token.createdAt) : "--"}
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
