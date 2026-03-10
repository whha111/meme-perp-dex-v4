"use client";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";
import dynamic from "next/dynamic";
import { TradingErrorBoundary } from "@/components/shared/TradingErrorBoundary";

// 动态导入 TradingTerminal，禁用 SSR
const TradingTerminal = dynamic(
  () => import("@/components/common/TradingTerminal").then((mod) => mod.TradingTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-col items-center justify-center min-h-[600px] bg-okx-bg-primary text-okx-text-primary">
        <div className="w-8 h-8 border-2 border-okx-up border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 text-okx-text-secondary">Loading trading terminal...</p>
      </div>
    ),
  }
);

/**
 * 现货交易页面
 */
export default function TokenTradePage() {
  const params = useParams();
  const addressOrSymbol = params.address as string;

  const [mounted, setMounted] = useState(false);

  // 使用符号格式 - 如果是合约地址，转换为符号；如果已经是符号，直接使用
  const symbol = addressOrSymbol?.startsWith("0x")
    ? addressOrSymbol
    : addressOrSymbol?.toUpperCase() || "";

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
        <Navbar />
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-8 h-8 border-4 border-okx-up border-t-transparent rounded-full animate-spin"></div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />
      <TradingErrorBoundary module="SpotTradingTerminal">
        <TradingTerminal symbol={symbol} />
      </TradingErrorBoundary>
    </main>
  );
}
