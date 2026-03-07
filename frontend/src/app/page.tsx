"use client";

import Link from "next/link";
import { Navbar } from "@/components/layout/Navbar";
import { useEffect, useState, useMemo } from "react";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";
import { useUnifiedWebSocket } from "@/hooks/common/useUnifiedWebSocket";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("home");

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
            <span className="text-meme-lime text-sm font-medium">{t("badge")}</span>
          </div>

          <h1 className="text-5xl lg:text-6xl font-extrabold leading-tight mb-6">
            {t("heroTitle")}{" "}
            <span className="text-meme-lime">100x</span>{" "}
            Meme
          </h1>

          <p className="text-lg text-okx-text-secondary max-w-2xl mx-auto mb-10">
            {t("heroSubtitle")}
          </p>

          <div className="flex items-center justify-center gap-4">
            <Link
              href="/create"
              className="meme-btn-primary px-8 py-3.5 text-base"
            >
              {t("createToken")}
            </Link>
            <Link
              href="/perp"
              className="px-8 py-3.5 rounded-xl border border-okx-border-secondary text-okx-text-primary font-bold hover:border-okx-border-hover transition-colors"
            >
              {t("startTrading")}
            </Link>
          </div>
        </div>
      </section>

      {/* Stats Banner */}
      {mounted && (
        <section className="border-y border-okx-border-primary bg-gradient-to-r from-meme-darker to-meme-dark">
          <div className="max-w-[1200px] mx-auto px-8 py-8 grid grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              { label: t("stats.volume24h"), value: formatValue(stats.totalVolume) },
              { label: t("stats.marketCap"), value: formatValue(stats.totalMarketCap) },
              { label: t("stats.activeTokens"), value: `${stats.totalTokens}+` },
              { label: t("stats.totalTraders"), value: `${stats.totalTraders}+` },
            ].map((stat, idx) => (
              <div key={idx} className="text-center">
                <div className="text-2xl font-bold font-mono text-okx-text-primary">{stat.value}</div>
                <div className="text-sm text-okx-text-tertiary mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Features Grid */}
      <section className="max-w-[1200px] mx-auto px-8 py-20">
        <h2 className="text-3xl font-bold text-center mb-4">{t("whyTitle")}</h2>
        <p className="text-okx-text-secondary text-center mb-12 max-w-xl mx-auto">
          {t("whySubtitle")}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {([
            { icon: <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" /></svg>, title: t("features.fairLaunch.title"), desc: t("features.fairLaunch.desc") },
            { icon: <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" /></svg>, title: t("features.perpetual.title"), desc: t("features.perpetual.desc") },
            { icon: <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" /></svg>, title: t("features.security.title"), desc: t("features.security.desc") },
            { icon: <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>, title: t("features.referral.title"), desc: t("features.referral.desc") },
            { icon: <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>, title: t("features.matching.title"), desc: t("features.matching.desc") },
            { icon: <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" /></svg>, title: t("features.competition.title"), desc: t("features.competition.desc") },
          ]).map((feature, idx) => (
            <div key={idx} className="meme-card p-6 hover:border-meme-lime/20 transition-colors group">
              <div className="mb-4 text-okx-text-secondary group-hover:text-meme-lime transition-colors">{feature.icon}</div>
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
          <h2 className="text-3xl font-bold mb-4">{t("ctaTitle")}</h2>
          <p className="text-okx-text-secondary mb-8">{t("ctaSubtitle")}</p>
          <Link
            href="/exchange"
            className="meme-btn-primary px-10 py-4 text-lg inline-block"
          >
            {t("ctaButton")}
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-okx-border-primary py-8 px-8">
        <div className="max-w-[1200px] mx-auto flex items-center justify-between text-sm text-okx-text-tertiary">
          <div className="flex items-center gap-2">
            <span className="text-meme-lime font-bold">*</span>
            <span>MEMEPERP</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/settings" className="hover:text-okx-text-primary transition-colors">{t("footer.settings")}</Link>
            <Link href="/invite" className="hover:text-okx-text-primary transition-colors">{t("footer.invite")}</Link>
            <span>BSC Testnet (Chain 97)</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
