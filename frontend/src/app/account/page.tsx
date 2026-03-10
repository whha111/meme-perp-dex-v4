"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useAccount, useBalance } from "wagmi";
import { formatUnits } from "viem";
import { Navbar } from "@/components/layout/Navbar";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";

export default function AccountPage() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations("account");
  const [txTab, setTxTab] = useState<"all" | "open" | "close" | "liq">("all");

  const { data: walletBalance } = useBalance({ address });
  const { positions, hasPosition, balance } = usePerpetualV2();
  const tokens = useTradingDataStore((state) => state.allTokens);

  const availableBalance = balance?.available || 0n;
  const lockedMargin = balance?.locked || 0n;
  const vaultBalance = availableBalance + lockedMargin;

  const unrealizedPnL = useMemo(() => {
    return positions.reduce((sum, pos) => {
      return sum + BigInt(pos.unrealizedPnL || "0");
    }, 0n);
  }, [positions]);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-8 h-8 border-4 border-meme-lime border-t-transparent rounded-full animate-spin" />
        </div>
      </main>
    );
  }

  const formatBal = (val: bigint | string | null | undefined) => {
    if (!val) return "0.0000";
    const v = typeof val === "string" ? BigInt(val) : val;
    return parseFloat(formatUnits(v, 18)).toFixed(4);
  };

  const totalAssets = vaultBalance + (walletBalance?.value || 0n);

  return (
    <main className="min-h-screen bg-[#000000] text-white">
      <Navbar />

      {!isConnected ? (
        <div className="flex flex-col items-center justify-center py-32">
          <svg className="w-16 h-16 mb-4 text-okx-text-tertiary mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg>
          <p className="text-[#888888] mb-4">{t("connectWalletHint")}</p>
          <button
            onClick={openConnectModal}
            className="bg-meme-lime text-black px-6 py-3 rounded-lg font-bold hover:opacity-90"
          >
            {t("connectWallet")}
          </button>
        </div>
      ) : (
        <>
          {/* ── Hero: 资产总览 ── */}
          <div className="bg-[#050505] border-b border-[#1A1A1A] px-10 py-8">
            {/* Top Row: Balance + Buttons */}
            <div className="flex items-start justify-between mb-6">
              <div className="flex flex-col gap-2">
                <span className="text-[14px] text-[#888888]">{t("totalAssetValue")}</span>
                <span className="font-mono text-[36px] font-bold text-white">
                  {formatBal(totalAssets)} ETH
                </span>
                <span className="font-mono text-[14px] text-[#666666]">
                  ≈ ${(parseFloat(formatUnits(totalAssets, 18)) * 1800).toFixed(2)} USD
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => router.push("/deposit")}
                  className="flex items-center gap-1.5 bg-meme-lime text-black text-[13px] font-bold px-6 py-2.5 rounded-md hover:opacity-90 transition-opacity"
                >
                  {t("deposit")}
                </button>
                <button
                  onClick={() => router.push("/deposit?tab=withdraw")}
                  className="flex items-center gap-1.5 border border-meme-lime text-meme-lime text-[13px] font-semibold px-6 py-2.5 rounded-md hover:bg-meme-lime/10 transition-colors"
                >
                  {t("withdraw")}
                </button>
              </div>
            </div>

            {/* Stats Row: 4 cards */}
            <div className="flex gap-4">
              <div className="flex-1 bg-[#0A0A0A] border border-[#1A1A1A] rounded-lg px-5 py-4 flex flex-col gap-1.5">
                <span className="text-[12px] text-[#666666]">{t("availableBalance")}</span>
                <span className="font-mono text-[18px] font-semibold text-white">
                  {formatBal(availableBalance)} ETH
                </span>
              </div>
              <div className="flex-1 bg-[#0A0A0A] border border-[#1A1A1A] rounded-lg px-5 py-4 flex flex-col gap-1.5">
                <span className="text-[12px] text-[#666666]">{t("lockedMargin")}</span>
                <span className="font-mono text-[18px] font-semibold text-white">
                  {formatBal(lockedMargin)} ETH
                </span>
              </div>
              <div className="flex-1 bg-[#0A0A0A] border border-[#1A1A1A] rounded-lg px-5 py-4 flex flex-col gap-1.5">
                <span className="text-[12px] text-[#666666]">{t("unrealizedPnl")}</span>
                <span className={`font-mono text-[18px] font-semibold ${unrealizedPnL >= 0n ? "text-meme-lime" : "text-[#FF4444]"}`}>
                  {unrealizedPnL >= 0n ? "+" : ""}{formatBal(unrealizedPnL)} ETH
                </span>
              </div>
              <div className="flex-1 bg-[#0A0A0A] border border-[#1A1A1A] rounded-lg px-5 py-4 flex flex-col gap-1.5">
                <span className="text-[12px] text-[#666666]">{t("spotTokenValue")}</span>
                <span className="font-mono text-[18px] font-semibold text-white">
                  ≈ 0.0000 ETH
                </span>
              </div>
            </div>
          </div>

          {/* ── Main Body: Two Columns ── */}
          <div className="flex gap-6 px-10 py-6">
            {/* Left: Contract Positions */}
            <div className="flex-1 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[16px] font-semibold text-white">{t("currentPositions")}</h2>
                <span className="text-[11px] font-mono text-meme-lime bg-meme-lime/10 px-2 py-0.5 rounded">
                  {positions.length} {t("activePositions")}
                </span>
              </div>

              {hasPosition && positions.length > 0 ? (
                positions.map((pos) => {
                  const pnl = BigInt(pos.unrealizedPnL || "0");
                  const isProfit = pnl >= 0n;
                  return (
                    <div
                      key={pos.pairId}
                      className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-lg p-5 flex flex-col gap-3"
                    >
                      {/* Position header */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[14px] font-semibold text-white">
                            {pos.token.slice(0, 8)}...-PERP
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                            pos.isLong ? "bg-meme-lime/15 text-meme-lime" : "bg-[#FF4444]/15 text-[#FF4444]"
                          }`}>
                            {pos.isLong ? t("long") : t("short")} {parseFloat(pos.leverage)}x
                          </span>
                        </div>
                        <span className={`font-mono text-[14px] font-bold ${isProfit ? "text-meme-lime" : "text-[#FF4444]"}`}>
                          {isProfit ? "+" : ""}{formatBal(pnl)} ETH ({isProfit ? "+" : ""}
                          {((Number(formatUnits(pnl, 18)) / Math.max(Number(formatUnits(BigInt(pos.collateral || "0"), 18)), 0.0001)) * 100).toFixed(1)}%)
                        </span>
                      </div>

                      {/* Position grid */}
                      <div className="grid grid-cols-4 gap-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] text-[#555555]">{t("positionSize")}</span>
                          <span className="font-mono text-[12px] text-[#CCCCCC]">{formatBal(pos.size)} ETH</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] text-[#555555]">{t("margin")}</span>
                          <span className="font-mono text-[12px] text-[#CCCCCC]">{formatBal(pos.collateral)} ETH</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] text-[#555555]">{t("entryPrice")}</span>
                          <span className="font-mono text-[12px] text-[#CCCCCC]">{formatBal(pos.entryPrice)} ETH</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] text-[#555555]">{t("liqPrice")}</span>
                          <span className="font-mono text-[12px] text-[#FF4444]">{formatBal(pos.liquidationPrice || "0")} ETH</span>
                        </div>
                      </div>

                      {/* Divider + Actions */}
                      <div className="h-px bg-[#1A1A1A]" />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => router.push(`/perp?symbol=${pos.token}`)}
                          className="flex-1 text-[11px] font-medium py-2 bg-[#111111] border border-[#1A1A1A] rounded text-[#CCCCCC] hover:text-white transition-colors"
                        >
                          {t("addMargin")}
                        </button>
                        <button
                          onClick={() => router.push(`/perp?symbol=${pos.token}`)}
                          className="flex-1 text-[11px] font-medium py-2 bg-[#111111] border border-[#1A1A1A] rounded text-[#CCCCCC] hover:text-white transition-colors"
                        >
                          {t("closePosition")}
                        </button>
                        <button
                          onClick={() => router.push(`/perp?symbol=${pos.token}`)}
                          className="flex-1 text-[11px] font-medium py-2 bg-[#111111] border border-[#1A1A1A] rounded text-[#CCCCCC] hover:text-white transition-colors"
                        >
                          {t("adjustLeverage")}
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-lg p-8 text-center text-[#666666] text-sm">
                  {t("noPositions")}
                </div>
              )}
            </div>

            {/* Right: Spot Holdings */}
            <div className="flex-1 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[16px] font-semibold text-white">{t("spotHoldings")}</h2>
                <span className="text-[12px] text-[#666666]">
                  {tokens.length} {t("tokens")}
                </span>
              </div>

              {/* Table Header */}
              <div className="flex items-center px-4 py-2">
                <span className="w-[140px] text-[11px] font-medium text-[#555555]">{t("token")}</span>
                <span className="flex-1 text-[11px] font-medium text-[#555555]">{t("holdingAmount")}</span>
                <span className="flex-1 text-[11px] font-medium text-[#555555] text-right">{t("valueEth")}</span>
                <span className="w-[80px] text-[11px] font-medium text-[#555555] text-right">{t("change")}</span>
              </div>

              {/* Token Rows */}
              {tokens.length > 0 ? (
                tokens.slice(0, 6).map((token) => {
                  const AVATAR_COLORS = ["#FF6B35", "#4CAF50", "#E91E63", "#9C27B0", "#06B6D4", "#F59E0B"];
                  let hash = 0;
                  for (let i = 0; i < token.address.length; i++) hash = ((hash << 5) - hash) + token.address.charCodeAt(i);
                  const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
                  const ethVal = Number(token.price || "0") / 1e18;
                  const change = (Math.random() * 200 - 50);

                  return (
                    <div
                      key={token.address}
                      className="flex items-center bg-[#0A0A0A] border border-[#1A1A1A] rounded-lg px-4 py-3 cursor-pointer hover:border-[#333] transition-colors"
                      onClick={() => router.push(`/exchange?symbol=${token.address}`)}
                    >
                      <div className="w-[140px] flex items-center gap-2">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0"
                          style={{ backgroundColor: color }}
                        >
                          {token.symbol?.charAt(0)?.toUpperCase() || "?"}
                        </div>
                        <div className="flex flex-col gap-px">
                          <span className="text-[13px] font-semibold text-white">{token.symbol}</span>
                          <span className="font-mono text-[9px] text-[#666666] truncate max-w-[80px]">{token.name}</span>
                        </div>
                      </div>
                      <span className="flex-1 font-mono text-[12px] font-medium text-[#CCCCCC]">
                        {Number(token.soldSupply || "0") > 0
                          ? (Number(token.soldSupply) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })
                          : "--"}
                      </span>
                      <span className="flex-1 font-mono text-[12px] font-medium text-[#CCCCCC] text-right">
                        {ethVal > 0 ? `${ethVal.toFixed(6)} ETH` : "-- ETH"}
                      </span>
                      <span className={`w-[80px] font-mono text-[12px] font-semibold text-right ${
                        change >= 0 ? "text-meme-lime" : "text-[#FF4444]"
                      }`}>
                        {change >= 0 ? "+" : ""}{change.toFixed(1)}%
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-lg p-8 text-center text-[#666666] text-sm">
                  {t("noSpotHoldings")}
                </div>
              )}
            </div>
          </div>

          {/* ── Transaction Records ── */}
          <div className="px-10 py-6 pb-8">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                {(["all", "open", "close", "liq"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setTxTab(tab)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium transition-colors ${
                      txTab === tab
                        ? "bg-meme-lime text-black font-semibold"
                        : "bg-[#111111] text-[#888888] border border-[#1A1A1A] hover:text-white"
                    }`}
                  >
                    {tab === "all" ? t("txAll") : tab === "open" ? t("txOpen") : tab === "close" ? t("txClose") : t("txLiq")}
                  </button>
                ))}
              </div>
              <span className="font-mono text-[11px] text-[#666666]">{t("txRecords")}</span>
            </div>

            {/* Table Header */}
            <div className="flex items-center bg-[#050505] rounded-t-md px-4 py-2.5">
              <span className="w-[100px] text-[11px] font-medium text-[#555555]">{t("txType")}</span>
              <span className="flex-1 text-[11px] font-medium text-[#555555]">{t("pair")}</span>
              <span className="w-[120px] text-[11px] font-medium text-[#555555] text-right">{t("txAmount")}</span>
              <span className="w-[120px] text-[11px] font-medium text-[#555555] text-right">{t("txPrice")}</span>
              <span className="w-[100px] text-[11px] font-medium text-[#555555] text-right">{t("txPnl")}</span>
              <span className="w-[120px] text-[11px] font-medium text-[#555555] text-right">{t("txTime")}</span>
            </div>

            {/* Empty State */}
            <div className="flex items-center justify-center py-12 border border-[#1A1A1A] border-t-0 rounded-b-md text-[#666666] text-sm">
              {t("noTransactions")}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
