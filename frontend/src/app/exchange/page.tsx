"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";
import { TradingTerminal } from "@/components/common/TradingTerminal";
import { TradingErrorBoundary } from "@/components/shared/TradingErrorBoundary";
import { TokenSelector } from "@/components/spot/TokenSelector";
import { useTranslations } from "next-intl";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";
import { useUnifiedWebSocket } from "@/hooks/common/useUnifiedWebSocket";

function ExchangeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations();

  // WSS 连接 (触发 get_all_tokens)
  useUnifiedWebSocket({ enabled: true });

  // 从 WSS 获取代币列表 (替代 useOnChainTokenList 的 400+ RPC 调用)
  const tokens = useTradingDataStore(state => state.allTokens);
  const isLoading = !useTradingDataStore(state => state.allTokensLoaded);

  // 从 URL 参数获取交易对符号
  const urlSymbol = searchParams.get("symbol");

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-64px)]">
        <div className="w-8 h-8 border-4 border-okx-up border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  // 获取要交易的代币: URL参数 > 第一个可用代币
  const symbol = urlSymbol || (tokens.length > 0 ? tokens[0].address : null);

  // Token 选择回调 — 更新 URL (replace 不污染浏览历史)
  const handleTokenSelect = (tokenAddress: string) => {
    router.replace(`/exchange?symbol=${tokenAddress}`, { scroll: false });
  };

  // 如果没有代币可交易，提示用户
  if (!symbol) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-64px)] gap-4">
        <p className="text-okx-text-secondary text-lg">{t("market.noTokens")}</p>
        <button
          onClick={() => router.push("/create")}
          className="bg-meme-lime text-black px-6 py-2 rounded-lg font-bold hover:opacity-90 transition-opacity"
        >
          {t("nav.createToken")}
        </button>
        <button
          onClick={() => router.push("/")}
          className="text-okx-text-tertiary hover:text-okx-text-primary transition-colors"
        >
          {t("nav.market")}
        </button>
      </div>
    );
  }

  // 把 TokenSelector 作为 headerSlot 注入到 TradingTerminal 顶栏
  return (
    <TradingErrorBoundary module="SpotTradingTerminal">
      <TradingTerminal
        symbol={symbol}
        headerSlot={
          <TokenSelector
            tokens={tokens}
            isLoading={isLoading}
            selectedAddress={symbol}
            onSelect={handleTokenSelect}
          />
        }
      />
    </TradingErrorBoundary>
  );
}

/**
 * 兑换/交易页面
 * Exchange page for swapping tokens
 */
export default function ExchangePage() {
  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />
      <Suspense
        fallback={
          <div className="flex items-center justify-center min-h-[calc(100vh-64px)]">
            <div className="w-8 h-8 border-4 border-okx-up border-t-transparent rounded-full animate-spin"></div>
          </div>
        }
      >
        <ExchangeContent />
      </Suspense>
    </main>
  );
}
