"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Navbar } from "@/components/layout/Navbar";
import { useTranslations } from "next-intl";
import { MATCHING_ENGINE_URL } from "@/config/api";

type LeaderboardTab = "pnl" | "volume" | "invites" | "past";

interface LeaderboardEntry {
  rank: number;
  address: string;
  pnl: string;
  roe: string;
  trades: number;
  reward: string;
  isCurrentUser?: boolean;
}

function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Mock data (real data will come from API)
const MOCK_LEADERBOARD: LeaderboardEntry[] = [
  { rank: 1, address: "0x2aEf...b32C", pnl: "+12.45 ETH", roe: "+324.5%", trades: 256, reward: "25 ETH" },
  { rank: 2, address: "0xc4B7...3f2A", pnl: "+8.72 ETH", roe: "+241.3%", trades: 189, reward: "12 ETH" },
  { rank: 3, address: "0x91cD...4e7F", pnl: "+6.31 ETH", roe: "+198.7%", trades: 167, reward: "8 ETH" },
  { rank: 4, address: "0xd8F1...5a9B", pnl: "+3.28 ETH", roe: "+185.4%", trades: 142, reward: "2.0 ETH" },
  { rank: 5, address: "0x7bC3...e21D", pnl: "+2.91 ETH", roe: "+156.2%", trades: 89, reward: "1.0 ETH" },
  { rank: 6, address: "0xa2E9...c87F", pnl: "+1.56 ETH", roe: "+98.7%", trades: 67, reward: "0.5 ETH" },
  { rank: 7, address: "0xf4D2...1a3B", pnl: "+1.23 ETH", roe: "+87.3%", trades: 54, reward: "0.5 ETH" },
  { rank: 8, address: "0x3eA8...d92C", pnl: "+0.98 ETH", roe: "+72.1%", trades: 48, reward: "0.5 ETH" },
  { rank: 9, address: "0x6cB1...7f4E", pnl: "+0.76 ETH", roe: "+61.4%", trades: 41, reward: "0.25 ETH" },
  { rank: 10, address: "0x8dF3...2c5A", pnl: "+0.52 ETH", roe: "+45.8%", trades: 35, reward: "0.25 ETH" },
];

const MOCK_CURRENT_USER: LeaderboardEntry = {
  rank: 28,
  address: "0xYour...Addr",
  pnl: "+0.34 ETH",
  roe: "+42.1%",
  trades: 31,
  reward: "--",
  isCurrentUser: true,
};

function useCountdown(targetDate: Date) {
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date().getTime();
      const distance = targetDate.getTime() - now;
      if (distance <= 0) {
        clearInterval(timer);
        return;
      }
      setTimeLeft({
        days: Math.floor(distance / (1000 * 60 * 60 * 24)),
        hours: Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
        minutes: Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60)),
        seconds: Math.floor((distance % (1000 * 60)) / 1000),
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [targetDate]);

  return timeLeft;
}

export default function LeaderboardPage() {
  const t = useTranslations("leaderboard");
  const [activeTab, setActiveTab] = useState<LeaderboardTab>("pnl");
  const [entries, setEntries] = useState<LeaderboardEntry[]>(MOCK_LEADERBOARD);
  const [currentUser, setCurrentUser] = useState<LeaderboardEntry | null>(MOCK_CURRENT_USER);

  const targetDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000);
  const countdown = useCountdown(targetDate);

  const tabs: { key: LeaderboardTab; label: string }[] = [
    { key: "pnl", label: t("tabPnl") },
    { key: "volume", label: t("tabVolume") },
    { key: "invites", label: t("tabInvites") },
    { key: "past", label: t("tabPast") },
  ];

  // Podium medal colors — these are semantic (gold/silver/bronze), kept as-is
  const podiumColors = [
    { border: "border-yellow-500/30", text: "text-yellow-500", rank: "#1", prize: "25 ETH" },
    { border: "border-gray-400/30", text: "text-gray-400", rank: "#2", prize: "12 ETH" },
    { border: "border-amber-600/30", text: "text-amber-600", rank: "#3", prize: "8 ETH" },
  ];

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      {/* Hero Section */}
      <div className="w-full bg-gradient-to-b from-meme-darker to-okx-bg-primary py-8 md:py-10 px-4 md:px-8 lg:px-16">
        <div className="max-w-[1440px] mx-auto">
          <div className="flex items-center gap-4 mb-4">
            <h1 className="text-3xl font-extrabold">{t("title")}</h1>
            <span className="bg-meme-lime text-black text-xs font-bold px-4 py-1.5 rounded-full">
              {t("seasonBadge")}
            </span>
          </div>

          <p className="text-okx-text-secondary text-[15px] mb-6">
            {t("description")}{" "}
            <span className="text-okx-text-primary font-mono">
              {countdown.days}{t("days")} {String(countdown.hours).padStart(2, "0")}:
              {String(countdown.minutes).padStart(2, "0")}:
              {String(countdown.seconds).padStart(2, "0")}
            </span>
          </p>

          {/* Tabs */}
          <div className="flex items-center gap-3 overflow-x-auto pb-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-2 rounded-full text-sm font-medium transition-all ${
                  activeTab === tab.key
                    ? "bg-meme-lime text-black font-bold"
                    : "border border-okx-border-secondary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-hover"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Podium (TOP 3) — responsive: stack on mobile, row on desktop */}
      <div className="max-w-[1440px] mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-8">
        <div className="flex flex-col md:flex-row justify-center items-center md:items-end gap-4 md:gap-6">
          {/* 2nd Place (shown first on mobile for natural 1-2-3 reading via order) */}
          <div
            className={`order-2 md:order-1 flex flex-col items-center gap-3 rounded-2xl p-5 md:p-6 w-full max-w-[320px] md:w-[280px] bg-okx-bg-card border ${podiumColors[1].border}`}
          >
            <span className={`text-2xl md:text-3xl font-black ${podiumColors[1].text}`}>{podiumColors[1].rank}</span>
            <span className="font-mono text-sm">{entries[1]?.address}</span>
            <div className="text-center">
              <div className="text-meme-lime font-mono font-bold text-base md:text-lg">{entries[1]?.pnl}</div>
              <div className="text-okx-text-secondary text-sm">ROE {entries[1]?.roe}</div>
            </div>
            <span className={`text-sm font-semibold ${podiumColors[1].text}`}>
              {t("reward")} {podiumColors[1].prize}
            </span>
          </div>

          {/* 1st Place */}
          <div
            className={`order-1 md:order-2 flex flex-col items-center gap-3 rounded-2xl p-6 md:p-8 w-full max-w-[320px] md:w-[320px] bg-okx-bg-card border-2 ${podiumColors[0].border}`}
          >
            <span className={`text-3xl md:text-4xl font-black ${podiumColors[0].text}`}>{podiumColors[0].rank}</span>
            <span className="font-mono text-sm font-semibold">{entries[0]?.address}</span>
            <div className="text-center">
              <div className="text-meme-lime font-mono font-bold text-lg md:text-xl">{entries[0]?.pnl}</div>
              <div className="text-okx-text-secondary text-sm">ROE {entries[0]?.roe}</div>
            </div>
            <span className={`text-sm font-bold ${podiumColors[0].text}`}>
              {t("reward")} {podiumColors[0].prize}
            </span>
          </div>

          {/* 3rd Place */}
          <div
            className={`order-3 flex flex-col items-center gap-3 rounded-2xl p-5 md:p-6 w-full max-w-[320px] md:w-[280px] bg-okx-bg-card border ${podiumColors[2].border}`}
          >
            <span className={`text-2xl md:text-3xl font-black ${podiumColors[2].text}`}>{podiumColors[2].rank}</span>
            <span className="font-mono text-sm">{entries[2]?.address}</span>
            <div className="text-center">
              <div className="text-meme-lime font-mono font-bold text-base md:text-lg">{entries[2]?.pnl}</div>
              <div className="text-okx-text-secondary text-sm">ROE {entries[2]?.roe}</div>
            </div>
            <span className={`text-sm font-semibold ${podiumColors[2].text}`}>
              {t("reward")} {podiumColors[2].prize}
            </span>
          </div>
        </div>
      </div>

      {/* Ranking Table */}
      <div className="max-w-[1440px] mx-auto px-4 md:px-8 lg:px-16 pb-12 overflow-x-auto">
        <div className="min-w-[640px]">
        {/* Table Header */}
        <div className="grid grid-cols-6 bg-meme-darker rounded-lg px-4 py-3 text-xs font-semibold text-okx-text-secondary">
          <span>{t("rank")}</span>
          <span>{t("trader")}</span>
          <span className="text-right">{t("pnl")}</span>
          <span className="text-right">ROE%</span>
          <span className="text-right">{t("trades")}</span>
          <span className="text-right">{t("reward")}</span>
        </div>

        {/* Table Rows (4-10) */}
        {entries.slice(3).map((entry) => (
          <div
            key={entry.rank}
            className="grid grid-cols-6 items-center px-4 py-3.5 border-b border-okx-border-primary hover:bg-okx-bg-hover transition-colors"
          >
            <span className={`font-mono text-sm font-bold ${entry.rank <= 3 ? "text-meme-lime" : "text-okx-text-secondary"}`}>
              {entry.rank}
            </span>
            <span className="font-mono text-sm">{entry.address}</span>
            <span className="font-mono text-sm text-meme-lime font-semibold text-right">{entry.pnl}</span>
            <span className="font-mono text-sm text-meme-lime text-right">{entry.roe}</span>
            <span className="font-mono text-sm text-right">{entry.trades}</span>
            <span className="font-mono text-sm text-okx-text-secondary text-right">{entry.reward}</span>
          </div>
        ))}

        {/* Current User Row (highlighted) */}
        {currentUser && (
          <div className="grid grid-cols-6 items-center px-4 py-3.5 mt-2 rounded-md border border-meme-lime/10 bg-meme-lime/[0.03]">
            <span className="font-mono text-sm font-bold text-meme-lime">{currentUser.rank}</span>
            <span className="font-mono text-sm flex items-center gap-2">
              {currentUser.address}
              <span className="text-[10px] bg-meme-lime/20 text-meme-lime px-2 py-0.5 rounded">{t("you")}</span>
            </span>
            <span className="font-mono text-sm text-meme-lime font-semibold text-right">{currentUser.pnl}</span>
            <span className="font-mono text-sm text-meme-lime text-right">{currentUser.roe}</span>
            <span className="font-mono text-sm text-right">{currentUser.trades}</span>
            <span className="font-mono text-sm text-okx-text-tertiary text-right">{currentUser.reward}</span>
          </div>
        )}
        </div>{/* close min-w-[640px] */}
      </div>
    </div>
  );
}
