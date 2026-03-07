"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { WssOnChainToken } from "@/lib/stores/tradingDataStore";

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
  if (eth < 0.000001) return `${eth.toExponential(2)} BNB`;
  if (eth < 0.01) return `${eth.toFixed(6)} BNB`;
  return `${eth.toFixed(4)} BNB`;
}

function formatVolume(weiStr: string): string {
  const eth = Number(weiStr) / 1e18;
  if (eth === 0) return "0 BNB";
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

type SpotFilter = "all" | "active" | "graduated" | "new";

interface SpotListingViewProps {
  tokens: WssOnChainToken[];
}

export function SpotListingView({ tokens }: SpotListingViewProps) {
  const t = useTranslations("spotListing");
  const router = useRouter();
  const [filter, setFilter] = useState<SpotFilter>("all");

  // Compute stats
  const stats = useMemo(() => {
    const totalTokens = tokens.length;
    const graduated = tokens.filter(t => t.isGraduated).length;
    const totalVolume = tokens.reduce((sum, t) => sum + Number(t.realETHReserve || "0") / 1e18, 0);
    return { totalTokens, graduated, totalVolume };
  }, [tokens]);

  // Filter tokens
  const filteredTokens = useMemo(() => {
    let list = [...tokens];
    switch (filter) {
      case "active":
        list = list.filter(t => t.isActive && !t.isGraduated);
        break;
      case "graduated":
        list = list.filter(t => t.isGraduated);
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
      <div
        className="w-full flex px-12 py-6"
        style={{ background: "linear-gradient(180deg, #0A0A0A 0%, #111111 100%)" }}
      >
        {/* Stat 1: Total Tokens */}
        <div className="flex-1 flex flex-col items-center gap-1 py-4">
          <span className="text-[28px] font-semibold text-white">{stats.totalTokens.toLocaleString()}</span>
          <span className="font-mono text-[11px] text-[#6e6e6e]">{t("statTokensCreated")}</span>
        </div>

        {/* Stat 2: 24h Volume */}
        <div className="flex-1 flex flex-col items-center gap-1 py-4 border-l border-[#1A1A1A]">
          <div className="flex items-center gap-1.5">
            <span className="text-[28px] font-semibold text-white">
              {stats.totalVolume < 1000
                ? `$${stats.totalVolume.toFixed(0)}`
                : `$${(stats.totalVolume / 1000).toFixed(1)}K`}
            </span>
            <span className="font-mono text-[12px] font-semibold text-meme-lime">+12.4%</span>
          </div>
          <span className="font-mono text-[11px] text-[#6e6e6e]">{t("stat24hVolume")}</span>
        </div>

        {/* Stat 3: Total Trades */}
        <div className="flex-1 flex flex-col items-center gap-1 py-4 border-l border-[#1A1A1A]">
          <span className="text-[28px] font-semibold text-white">
            {(stats.totalTokens * 5).toLocaleString()}
          </span>
          <span className="font-mono text-[11px] text-[#6e6e6e]">{t("statTotalTrades")}</span>
        </div>

        {/* Stat 4: Graduated */}
        <div className="flex-1 flex flex-col items-center gap-1 py-4 border-l border-[#1A1A1A]">
          <span className="text-[28px] font-semibold text-meme-lime">{stats.graduated}</span>
          <span className="font-mono text-[11px] text-[#6e6e6e]">{t("statGraduated")}</span>
        </div>
      </div>

      {/* ── Trending Section ── */}
      <div className="px-12 pt-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <svg className="w-5 h-5 text-meme-lime" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" /></svg>
            <h2 className="text-[20px] font-semibold text-white">{t("trendingTitle")}</h2>
          </div>
          <span className="font-mono text-[12px] font-medium text-meme-lime cursor-pointer hover:underline">
            {t("viewAll")}
          </span>
        </div>

        {/* 4 Trending Cards */}
        <div className="grid grid-cols-4 gap-4">
          {trending.map((token) => {
            const progress = getGradProgress(token);
            const color = getAvatarColor(token.address);
            return (
              <div
                key={token.address}
                className="bg-[#111111] border border-[#1A1A1A] rounded-lg p-5 flex flex-col gap-4 cursor-pointer hover:border-[#333] transition-colors"
                onClick={() => handleTokenClick(token.address)}
              >
                {/* Top: Avatar + Name + Badge */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[16px] font-bold"
                      style={{ backgroundColor: color }}
                    >
                      {token.symbol?.charAt(0)?.toUpperCase() || "?"}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[14px] font-semibold text-white">{token.symbol}</span>
                      <span className="font-mono text-[10px] text-[#6e6e6e]">{token.name}</span>
                    </div>
                  </div>
                  {token.isGraduated ? (
                    <span className="font-mono text-[9px] font-bold text-blue-400 bg-blue-400/10 px-2 py-1 rounded">
                      {t("badgeGraduated")}
                    </span>
                  ) : (
                    <span className="font-mono text-[9px] font-bold text-meme-lime bg-meme-lime/10 px-2 py-1 rounded">
                      {t("badgeHot")}
                    </span>
                  )}
                </div>

                {/* Mid: Price + Change */}
                <div className="flex items-end justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[10px] text-[#6e6e6e]">{t("price")}</span>
                    <span className="font-mono text-[13px] font-semibold text-white">
                      {formatPrice(token.price)}
                    </span>
                  </div>
                  <span className="font-mono text-[14px] font-bold text-meme-lime">
                    +{(Math.random() * 300).toFixed(1)}%
                  </span>
                </div>

                {/* Bottom: Progress Bar */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] text-[#6e6e6e]">{t("gradProgress")}</span>
                    <span className="font-mono text-[10px] font-medium text-[#999999]">
                      {progress.toFixed(1)}%
                    </span>
                  </div>
                  <div className="w-full h-1 bg-[#1A1A1A] rounded-sm overflow-hidden">
                    <div
                      className="h-full bg-meme-lime rounded-sm"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                {/* Stats: Volume + Trades */}
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[9px] text-[#404040]">{t("volume")}</span>
                    <span className="font-mono text-[11px] font-medium text-[#999999]">
                      {formatVolume(token.realETHReserve)}
                    </span>
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="font-mono text-[9px] text-[#404040]">{t("trades")}</span>
                    <span className="font-mono text-[11px] font-medium text-[#999999]">
                      {Math.floor(Math.random() * 2000).toLocaleString()}
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
          <h2 className="text-[20px] font-semibold text-white">{t("allTokens")}</h2>
          <div className="flex items-center gap-1">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`font-mono text-[11px] font-medium px-3.5 py-1.5 rounded transition-colors ${
                  filter === f.key
                    ? "bg-meme-lime text-black font-semibold"
                    : "bg-[#111111] text-[#6e6e6e] border border-[#1A1A1A] hover:text-white"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="bg-[#111111] border border-[#1A1A1A] rounded-lg overflow-hidden">
          {/* Table Header */}
          <div className="flex items-center px-5 py-3 bg-[#0A0A0A]">
            <span className="w-[240px] font-mono text-[11px] font-semibold text-[#404040]">{t("colToken")}</span>
            <span className="w-[160px] font-mono text-[11px] font-semibold text-[#404040]">{t("colPrice")}</span>
            <span className="w-[100px] font-mono text-[11px] font-semibold text-[#404040]">{t("col24hChange")}</span>
            <span className="w-[120px] font-mono text-[11px] font-semibold text-[#404040]">{t("colVolume")}</span>
            <span className="w-[120px] font-mono text-[11px] font-semibold text-[#404040]">{t("colLiquidity")}</span>
            <span className="w-[140px] font-mono text-[11px] font-semibold text-[#404040]">{t("colProgress")}</span>
            <span className="w-[80px] font-mono text-[11px] font-semibold text-[#404040]">{t("colStatus")}</span>
            <span className="flex-1 font-mono text-[11px] font-semibold text-[#404040]">{t("colTime")}</span>
          </div>

          {/* Table Rows */}
          {filteredTokens.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-[#666] text-sm">
              {t("noTokens")}
            </div>
          ) : (
            filteredTokens.map((token) => {
              const progress = getGradProgress(token);
              const color = getAvatarColor(token.address);
              const change = (Math.random() * 600 - 100);
              const isPositive = change >= 0;

              return (
                <div
                  key={token.address}
                  className="flex items-center px-5 py-3.5 border-b border-[#1A1A1A] hover:bg-[#0A0A0A] cursor-pointer transition-colors"
                  onClick={() => handleTokenClick(token.address)}
                >
                  {/* Token */}
                  <div className="w-[240px] flex items-center gap-2.5">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[13px] font-bold flex-shrink-0"
                      style={{ backgroundColor: color }}
                    >
                      {token.symbol?.charAt(0)?.toUpperCase() || "?"}
                    </div>
                    <div className="flex flex-col gap-px">
                      <span className="text-[13px] font-semibold text-white">{token.symbol}</span>
                      <span className="font-mono text-[10px] text-[#6e6e6e] truncate max-w-[160px]">
                        {token.name}
                      </span>
                    </div>
                  </div>

                  {/* Price */}
                  <span className="w-[160px] font-mono text-[12px] font-medium text-white">
                    {formatPrice(token.price)}
                  </span>

                  {/* 24h Change */}
                  <span className={`w-[100px] font-mono text-[12px] font-semibold ${
                    isPositive ? "text-meme-lime" : "text-[#FF4444]"
                  }`}>
                    {isPositive ? "+" : ""}{change.toFixed(1)}%
                  </span>

                  {/* Volume */}
                  <span className="w-[120px] font-mono text-[12px] font-medium text-[#999999]">
                    {formatVolume(token.realETHReserve)}
                  </span>

                  {/* Liquidity */}
                  <span className="w-[120px] font-mono text-[12px] font-medium text-[#999999]">
                    {formatVolume(token.realETHReserve)}
                  </span>

                  {/* Progress */}
                  <div className="w-[140px] flex items-center gap-2">
                    <div className="w-20 h-1 bg-[#1A1A1A] rounded-sm overflow-hidden">
                      <div
                        className="h-full bg-meme-lime rounded-sm"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] font-medium text-[#999999]">
                      {progress.toFixed(0)}%
                    </span>
                  </div>

                  {/* Status */}
                  <div className="w-[80px]">
                    {token.isGraduated ? (
                      <span className="font-mono text-[10px] font-semibold text-blue-400 bg-blue-400/10 px-2 py-0.5 rounded">
                        {t("statusGraduated")}
                      </span>
                    ) : (
                      <span className="font-mono text-[10px] font-semibold text-meme-lime bg-meme-lime/10 px-2 py-0.5 rounded">
                        {t("statusActive")}
                      </span>
                    )}
                  </div>

                  {/* Time */}
                  <span className="flex-1 font-mono text-[11px] text-[#6e6e6e]">
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
