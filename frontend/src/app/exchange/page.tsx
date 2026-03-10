"use client";

import React, { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";
import { TradingTerminal } from "@/components/common/TradingTerminal";
import { TradingErrorBoundary } from "@/components/shared/TradingErrorBoundary";
import { TokenSelector } from "@/components/spot/TokenSelector";
import { SpotListingView } from "@/components/spot/SpotListingView";
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
        <div className="w-8 h-8 border-4 border-meme-lime border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  // Token 选择回调 — 更新 URL (replace 不污染浏览历史)
  const handleTokenSelect = (tokenAddress: string) => {
    router.replace(`/exchange?symbol=${tokenAddress}`, { scroll: false });
  };

  // No symbol in URL → show spot listing overview (matching e5mP7 design)
  if (!urlSymbol) {
    return <SpotListingView tokens={tokens} />;
  }

  // Symbol selected → show trading terminal
  return (
    <TradingErrorBoundary module="SpotTradingTerminal">
      <TradingTerminal
        symbol={urlSymbol}
        headerSlot={
          <TokenSelector
            tokens={tokens}
            isLoading={isLoading}
            selectedAddress={urlSymbol}
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
