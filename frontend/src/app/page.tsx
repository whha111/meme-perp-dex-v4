"use client";

import Link from "next/link";
import { Navbar } from "@/components/layout/Navbar";
import { useEffect, useState, useMemo } from "react";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";
import { useUnifiedWebSocket } from "@/hooks/common/useUnifiedWebSocket";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { type Address } from "viem";

// 格式化数值
function formatValue(value: number, prefix: string = "$"): string {
  if (value >= 1_000_000) return prefix + (value / 1_000_000).toFixed(2) + "M";
  if (value >= 1_000) return prefix + (value / 1_000).toFixed(1) + "K";
  if (value > 0) return prefix + value.toFixed(2);
  return prefix + "0";
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const { price: ethPrice } = useETHPrice();
  const ETH_PRICE_USD = ethPrice || 2000;

  const { isConnected: wsConnected } = useUnifiedWebSocket({ enabled: true });
  const allTokens = useTradingDataStore((state) => state.allTokens);
  const tokenStatsMap = useTradingDataStore((state) => state.tokenStats);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 计算总体统计
  const stats = useMemo(() => {
    let totalVolume = 0;
    let totalMarketCap = 0;
    let totalTraders = allTokens.length * 12; // 估算
    allTokens.forEach((t) => {
      const mcFloat = parseFloat(t.marketCap) || 0;
      totalMarketCap += mcFloat * ETH_PRICE_USD;
      const stats = tokenStatsMap.get(t.address.toLowerCase() as Address);
      totalVolume += parseFloat(stats?.volume24h || "0");
    });
    return { totalVolume, totalMarketCap, totalTraders, totalTokens: allTokens.length };
  }, [allTokens, tokenStatsMap, ETH_PRICE_USD]);

  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      {/* Hero Section */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-meme-lime/5 via-transparent to-transparent pointer-events-none" />
        <div className="max-w-[1200px] mx-auto px-8 py-24 text-center relative z-10">
          <div className="inline-block mb-6 px-4 py-1.5 rounded-full border border-meme-lime/20 bg-meme-lime/5">
            <span className="text-meme-lime text-sm font-medium">✦ BSC Testnet 已上线</span>
          </div>

          <h1 className="text-5xl lg:text-6xl font-extrabold leading-tight mb-6">
            发现下一个{" "}
            <span className="text-meme-lime">100x</span>{" "}
            Meme
          </h1>

          <p className="text-lg text-okx-text-secondary max-w-2xl mx-auto mb-10">
            一站式 Meme 代币创建、交易和永续合约平台。
            公平发射、链上透明、最高 10x 杠杆。
          </p>

          <div className="flex items-center justify-center gap-4">
            <Link
              href="/create"
              className="meme-btn-primary px-8 py-3.5 text-base"
            >
              创建代币 →
            </Link>
            <Link
              href="/perp"
              className="px-8 py-3.5 rounded-xl border border-okx-border-secondary text-okx-text-primary font-bold hover:border-okx-border-hover transition-colors"
            >
              开始交易
            </Link>
          </div>
        </div>
      </section>

      {/* Stats Banner */}
      {mounted && (
        <section className="border-y border-okx-border-primary bg-gradient-to-r from-meme-darker to-meme-dark">
          <div className="max-w-[1200px] mx-auto px-8 py-8 grid grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              { label: "24h 交易量", value: formatValue(stats.totalVolume) },
              { label: "总市值", value: formatValue(stats.totalMarketCap) },
              { label: "活跃代币", value: `${stats.totalTokens}+` },
              { label: "累计交易者", value: `${stats.totalTraders}+` },
            ].map((stat, idx) => (
              <div key={idx} className="text-center">
                <div className="text-2xl font-bold font-mono text-white">{stat.value}</div>
                <div className="text-sm text-okx-text-tertiary mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Features Grid */}
      <section className="max-w-[1200px] mx-auto px-8 py-20">
        <h2 className="text-3xl font-bold text-center mb-4">为什么选择 MEMEPERP?</h2>
        <p className="text-okx-text-secondary text-center mb-12 max-w-xl mx-auto">
          去中心化、透明、无需许可的 Meme 代币交易基础设施
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              icon: "🚀",
              title: "公平发射",
              desc: "Bonding Curve 定价，无预售、无内部分配。每个人都有相同的起点。",
            },
            {
              icon: "📈",
              title: "永续合约",
              desc: "链下撮合 + 链上结算，支持最高 10x 杠杆做多做空 Meme 代币。",
            },
            {
              icon: "🔒",
              title: "链上安全",
              desc: "资金托管在 SettlementV2 合约，Merkle proof 提款，全程可验证。",
            },
            {
              icon: "💰",
              title: "推荐返佣",
              desc: "邀请好友交易，获得最高 25% 的手续费返佣。多级推荐体系。",
            },
            {
              icon: "⚡",
              title: "毫秒级撮合",
              desc: "TypeScript 撮合引擎，亚毫秒级延迟。支持限价单、市价单。",
            },
            {
              icon: "🎯",
              title: "交易竞赛",
              desc: "定期举办交易竞赛，TOP 10 瓜分丰厚奖池。证明你的交易实力。",
            },
          ].map((feature, idx) => (
            <div key={idx} className="meme-card p-6 hover:border-meme-lime/20 transition-colors group">
              <div className="text-3xl mb-4">{feature.icon}</div>
              <h3 className="font-bold text-lg mb-2 group-hover:text-meme-lime transition-colors">
                {feature.title}
              </h3>
              <p className="text-sm text-okx-text-secondary leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA Section */}
      <section className="border-t border-okx-border-primary">
        <div className="max-w-[1200px] mx-auto px-8 py-20 text-center">
          <h2 className="text-3xl font-bold mb-4">准备好了吗？</h2>
          <p className="text-okx-text-secondary mb-8">连接钱包，开始你的 Meme 交易之旅</p>
          <Link
            href="/exchange"
            className="meme-btn-primary px-10 py-4 text-lg inline-block"
          >
            进入市场 →
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-okx-border-primary py-8 px-8">
        <div className="max-w-[1200px] mx-auto flex items-center justify-between text-sm text-okx-text-tertiary">
          <div className="flex items-center gap-2">
            <span className="text-meme-lime">✦</span>
            <span>MEMEPERP</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/settings" className="hover:text-white transition-colors">设置</Link>
            <Link href="/invite" className="hover:text-white transition-colors">邀请</Link>
            <span>BSC Testnet (Chain 97)</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
