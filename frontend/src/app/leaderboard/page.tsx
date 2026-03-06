"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Navbar } from "@/components/layout/Navbar";
import { useTranslations } from "next-intl";
import { MATCHING_ENGINE_URL } from "@/config/api";

// 竞赛排行榜分类
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

// 格式化地址显示
function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// 模拟数据（真实数据将来自 API）
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

// 当前用户模拟排名
const MOCK_CURRENT_USER: LeaderboardEntry = {
  rank: 28,
  address: "0xYour...Addr",
  pnl: "+0.34 ETH",
  roe: "+42.1%",
  trades: 31,
  reward: "--",
  isCurrentUser: true,
};

// 倒计时 Hook
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

const TABS: { key: LeaderboardTab; label: string }[] = [
  { key: "pnl", label: "盈亏排行" },
  { key: "volume", label: "交易量排行" },
  { key: "invites", label: "邀请排行" },
  { key: "past", label: "往期竞赛" },
];

export default function LeaderboardPage() {
  const [activeTab, setActiveTab] = useState<LeaderboardTab>("pnl");
  const [entries, setEntries] = useState<LeaderboardEntry[]>(MOCK_LEADERBOARD);
  const [currentUser, setCurrentUser] = useState<LeaderboardEntry | null>(MOCK_CURRENT_USER);

  // 3 天后的倒计时
  const targetDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000);
  const countdown = useCountdown(targetDate);

  // TOP 3 颜色
  const podiumColors = [
    { border: "#FFD70050", text: "#FFD700", bg: "#FFD70008", emoji: "🥇", prize: "25 ETH" },
    { border: "#C0C0C030", text: "#C0C0C0", bg: "#C0C0C008", emoji: "🥈", prize: "12 ETH" },
    { border: "#CD7F3230", text: "#CD7F32", bg: "#CD7F3208", emoji: "🥉", prize: "8 ETH" },
  ];

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      {/* Hero Section */}
      <div className="w-full bg-gradient-to-b from-[#0d1000] to-black py-10 px-8 lg:px-16">
        <div className="max-w-[1440px] mx-auto">
          <div className="flex items-center gap-4 mb-4">
            <h1 className="text-3xl font-extrabold">交易竞赛排行榜</h1>
            <span className="bg-meme-lime text-black text-xs font-bold px-4 py-1.5 rounded-full">
              第 3 期 · 进行中
            </span>
          </div>

          <p className="text-okx-text-secondary text-[15px] mb-6">
            参与交易即可获得排名，TOP 10 瓜分 50 ETH 奖池 · 距离结束:{" "}
            <span className="text-white font-mono">
              {countdown.days}天 {String(countdown.hours).padStart(2, "0")}:
              {String(countdown.minutes).padStart(2, "0")}:
              {String(countdown.seconds).padStart(2, "0")}
            </span>
          </p>

          {/* Tabs */}
          <div className="flex items-center gap-3">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-2 rounded-full text-sm font-medium transition-all ${
                  activeTab === tab.key
                    ? "bg-meme-lime text-black font-bold"
                    : "border border-okx-border-secondary text-okx-text-secondary hover:text-white hover:border-okx-border-hover"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Podium (TOP 3) */}
      <div className="max-w-[1440px] mx-auto px-8 lg:px-16 py-8">
        <div className="flex justify-center items-end gap-6">
          {/* 2nd Place */}
          <div
            className="flex flex-col items-center gap-3 rounded-2xl p-6 w-[280px]"
            style={{
              backgroundColor: "#111111",
              border: `1px solid ${podiumColors[1].border}`,
            }}
          >
            <span className="text-4xl">{podiumColors[1].emoji}</span>
            <span className="font-mono text-sm">{entries[1]?.address}</span>
            <div className="text-center">
              <div className="text-meme-lime font-mono font-bold text-lg">{entries[1]?.pnl}</div>
              <div className="text-okx-text-secondary text-sm">ROE {entries[1]?.roe}</div>
            </div>
            <span className="text-sm font-semibold" style={{ color: podiumColors[1].text }}>
              🏆 奖励 {podiumColors[1].prize}
            </span>
          </div>

          {/* 1st Place */}
          <div
            className="flex flex-col items-center gap-3 rounded-2xl p-8 w-[320px]"
            style={{
              backgroundColor: "#111111",
              border: `2px solid ${podiumColors[0].border}`,
            }}
          >
            <span className="text-5xl">{podiumColors[0].emoji}</span>
            <span className="font-mono text-sm font-semibold">{entries[0]?.address}</span>
            <div className="text-center">
              <div className="text-meme-lime font-mono font-bold text-xl">{entries[0]?.pnl}</div>
              <div className="text-okx-text-secondary text-sm">ROE {entries[0]?.roe}</div>
            </div>
            <span className="text-sm font-bold" style={{ color: podiumColors[0].text }}>
              🏆 奖励 {podiumColors[0].prize}
            </span>
          </div>

          {/* 3rd Place */}
          <div
            className="flex flex-col items-center gap-3 rounded-2xl p-6 w-[280px]"
            style={{
              backgroundColor: "#111111",
              border: `1px solid ${podiumColors[2].border}`,
            }}
          >
            <span className="text-4xl">{podiumColors[2].emoji}</span>
            <span className="font-mono text-sm">{entries[2]?.address}</span>
            <div className="text-center">
              <div className="text-meme-lime font-mono font-bold text-lg">{entries[2]?.pnl}</div>
              <div className="text-okx-text-secondary text-sm">ROE {entries[2]?.roe}</div>
            </div>
            <span className="text-sm font-semibold" style={{ color: podiumColors[2].text }}>
              🏆 奖励 {podiumColors[2].prize}
            </span>
          </div>
        </div>
      </div>

      {/* Ranking Table */}
      <div className="max-w-[1440px] mx-auto px-8 lg:px-16 pb-12">
        {/* Table Header */}
        <div className="grid grid-cols-6 bg-meme-darker rounded-lg px-4 py-3 text-xs font-semibold text-okx-text-secondary">
          <span>排名</span>
          <span>交易者</span>
          <span className="text-right">盈亏</span>
          <span className="text-right">ROE%</span>
          <span className="text-right">交易次数</span>
          <span className="text-right">奖励</span>
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
              <span className="text-[10px] bg-meme-lime/20 text-meme-lime px-2 py-0.5 rounded">你</span>
            </span>
            <span className="font-mono text-sm text-meme-lime font-semibold text-right">{currentUser.pnl}</span>
            <span className="font-mono text-sm text-meme-lime text-right">{currentUser.roe}</span>
            <span className="font-mono text-sm text-right">{currentUser.trades}</span>
            <span className="font-mono text-sm text-okx-text-tertiary text-right">{currentUser.reward}</span>
          </div>
        )}
      </div>
    </div>
  );
}
