"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { Navbar } from "@/components/layout/Navbar";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { AssetTrendChart } from "@/components/common/AssetTrendChart";
import { BnbIcon } from "@/components/common/BnbIcon";

// ERC20 balanceOf ABI fragment
const erc20BalanceOfAbi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// OKX-style tab definitions
type AccountTab = "overview" | "trading" | "spot";

export default function AccountPage() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations("account");
  const [activeTab, setActiveTab] = useState<AccountTab>("overview");
  const [showChart, setShowChart] = useState(false);
  const [todayChange, setTodayChange] = useState({ amount: 0, percent: 0 });

  const { data: walletBalance } = useBalance({ address });
  const { positions, hasPosition, balance } = usePerpetualV2();
  const tokens = useTradingDataStore((state) => state.allTokens);
  const { price: bnbPriceUsd } = useETHPrice();

  const availableBalance = balance?.available || 0n;
  const lockedMargin = balance?.locked || 0n;
  const vaultBalance = availableBalance + lockedMargin;

  const unrealizedPnL = useMemo(() => {
    return positions.reduce((sum, pos) => {
      return sum + BigInt(pos.unrealizedPnL || "0");
    }, 0n);
  }, [positions]);

  // Batch fetch ERC20 balanceOf for all tokens (multicall)
  const tokenContracts = useMemo(() => {
    if (!address || tokens.length === 0) return [];
    return tokens.slice(0, 10).map((token) => ({
      address: token.address as `0x${string}`,
      abi: erc20BalanceOfAbi,
      functionName: "balanceOf" as const,
      args: [address] as const,
    }));
  }, [address, tokens]);

  const { data: tokenBalancesRaw } = useReadContracts({
    contracts: tokenContracts,
    query: { enabled: tokenContracts.length > 0 },
  });

  const tokenBalances = useMemo(() => {
    const map = new Map<string, bigint>();
    if (!tokenBalancesRaw) return map;
    tokens.slice(0, 10).forEach((token, i) => {
      const result = tokenBalancesRaw[i];
      if (result?.status === "success" && result.result) {
        map.set(token.address.toLowerCase(), result.result as bigint);
      }
    });
    return map;
  }, [tokenBalancesRaw, tokens]);

  const userTokens = useMemo(() => {
    return tokens.slice(0, 10).filter((token) => {
      const bal = tokenBalances.get(token.address.toLowerCase());
      return bal && bal > 0n;
    });
  }, [tokens, tokenBalances]);

  const totalSpotValue = useMemo(() => {
    let total = 0;
    for (const token of userTokens) {
      const bal = tokenBalances.get(token.address.toLowerCase()) || 0n;
      const tokenPrice = Number(token.price || "0") / 1e18;
      const balNum = Number(formatUnits(bal, 18));
      total += balNum * tokenPrice;
    }
    return total;
  }, [userTokens, tokenBalances]);

  const totalAssets = vaultBalance + (walletBalance?.value || 0n);

  // IMPORTANT: All hooks must be called before any conditional return
  const totalPortfolioBnb = useMemo(() => {
    return parseFloat(formatUnits(totalAssets, 18)) + totalSpotValue;
  }, [totalAssets, totalSpotValue]);

  const handleChangeData = useCallback((data: { amount: number; percent: number }) => {
    setTodayChange(data);
  }, []);

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

  const totalUsd = parseFloat(formatUnits(totalAssets, 18)) * bnbPriceUsd;
  const vaultUsd = parseFloat(formatUnits(vaultBalance, 18)) * bnbPriceUsd;
  const spotUsd = totalSpotValue * bnbPriceUsd;
  const totalCombinedUsd = vaultUsd + spotUsd;

  // Distribution percentages
  const tradingPct = totalCombinedUsd > 0 ? (vaultUsd / totalCombinedUsd * 100) : 0;
  const spotPct = totalCombinedUsd > 0 ? (spotUsd / totalCombinedUsd * 100) : 0;

  // OKX tabs
  const tabs: { key: AccountTab; label: string }[] = [
    { key: "overview", label: t("tabOverview") },
    { key: "trading", label: t("tabTrading") },
    { key: "spot", label: t("tabSpot") },
  ];

  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      {!isConnected ? (
        <div className="flex flex-col items-center justify-center py-32">
          <svg className="w-16 h-16 mb-4 text-okx-text-tertiary mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg>
          <p className="text-okx-text-secondary mb-4">{t("connectWalletHint")}</p>
          <button
            onClick={openConnectModal}
            className="bg-meme-lime text-black px-6 py-3 rounded-lg font-bold hover:opacity-90"
          >
            {t("connectWallet")}
          </button>
        </div>
      ) : (
        <div className="max-w-[1400px] mx-auto">
          {/* ── OKX Tab Navigation ── */}
          <div className="border-b border-okx-border-primary px-6">
            <div className="flex items-center gap-6">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`relative py-3.5 text-sm font-medium transition-colors ${
                    activeTab === tab.key
                      ? "text-okx-text-primary"
                      : "text-okx-text-tertiary hover:text-okx-text-secondary"
                  }`}
                >
                  {tab.label}
                  {activeTab === tab.key && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-okx-text-primary" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* ══════════════════════════════════════
               TAB: 资产总览 (Overview)
              ══════════════════════════════════════ */}
          {activeTab === "overview" && (
            <>
              {/* Hero: Two-column */}
              <div className="flex gap-5 px-6 pt-6 pb-4">
                {/* Left: Total value card */}
                <div className="flex-[2] bg-okx-bg-secondary rounded-2xl p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm text-okx-text-secondary">{t("totalAssetValue")}</span>
                    <svg className="w-4 h-4 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-mono text-[36px] font-bold text-okx-text-primary leading-none">
                      {totalCombinedUsd < 0.01 && totalCombinedUsd > 0 ? "<0.01" : totalCombinedUsd.toFixed(2)}
                    </span>
                    <span className="text-sm text-okx-text-secondary">USD</span>
                    <svg className="w-3.5 h-3.5 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </div>
                  {todayChange.amount !== 0 && (
                    <div className="mb-4">
                      <span className="text-xs text-okx-text-tertiary">{t("todayPnl")} </span>
                      <span className={`text-xs font-mono font-semibold ${todayChange.amount >= 0 ? "text-meme-lime" : "text-okx-down"}`}>
                        {todayChange.amount >= 0 ? "+" : ""}${Math.abs(todayChange.amount).toFixed(2)} ({todayChange.amount >= 0 ? "+" : ""}{todayChange.percent.toFixed(2)}%)
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-2.5 mb-5">
                    <button onClick={() => router.push("/deposit")} className="bg-okx-text-primary text-okx-bg-primary text-sm font-medium px-5 py-2 rounded-full hover:opacity-90 transition-opacity">{t("deposit")}</button>
                    <button onClick={() => router.push("/deposit?tab=withdraw")} className="border border-okx-border-secondary text-okx-text-primary text-sm font-medium px-5 py-2 rounded-full hover:bg-okx-bg-hover transition-colors">{t("withdraw")}</button>
                  </div>
                  <AssetTrendChart currentValueBnb={totalPortfolioBnb} bnbPriceUsd={bnbPriceUsd} walletAddress={address || ""} compact height={56} onChangeData={handleChangeData} />
                  <div className="flex justify-center mt-3">
                    <button onClick={() => setShowChart(!showChart)} className="text-okx-text-tertiary hover:text-okx-text-secondary transition-colors">
                      <svg className={`w-5 h-5 transition-transform ${showChart ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                    </button>
                  </div>
                  {showChart && (
                    <div className="mt-4 pt-4 border-t border-okx-border-primary">
                      <AssetTrendChart currentValueBnb={totalPortfolioBnb} bnbPriceUsd={bnbPriceUsd} walletAddress={address || ""} height={200} />
                    </div>
                  )}
                </div>

                {/* Right: Distribution */}
                <div className="flex-[1] bg-okx-bg-secondary rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-5">
                    <span className="text-sm font-semibold text-okx-text-primary">{t("distribution")}</span>
                  </div>
                  <div className="flex w-full h-2 rounded-full overflow-hidden mb-6 bg-okx-bg-primary">
                    {tradingPct > 0 && <div className="h-full bg-[#7B61FF]" style={{ width: `${Math.max(tradingPct, 2)}%` }} />}
                    {spotPct > 0 && <div className="h-full bg-[#F0B90B]" style={{ width: `${Math.max(spotPct, 2)}%` }} />}
                    {tradingPct === 0 && spotPct === 0 && <div className="h-full w-full bg-okx-bg-hover" />}
                  </div>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between cursor-pointer group" onClick={() => setActiveTab("trading")}>
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-[#7B61FF]" />
                        <span className="text-sm text-okx-text-primary group-hover:text-meme-lime transition-colors">{t("tabTrading")}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <div className="font-mono text-sm text-okx-text-primary">${vaultUsd < 0.01 && vaultUsd > 0 ? "<0.01" : vaultUsd.toFixed(2)}</div>
                          <div className="text-xs text-okx-text-tertiary">{tradingPct.toFixed(2)}%</div>
                        </div>
                        <svg className="w-4 h-4 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                      </div>
                    </div>
                    <div className="flex items-center justify-between cursor-pointer group" onClick={() => setActiveTab("spot")}>
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-[#F0B90B]" />
                        <span className="text-sm text-okx-text-primary group-hover:text-meme-lime transition-colors">{t("tabSpot")}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <div className="font-mono text-sm text-okx-text-primary">${spotUsd < 0.01 && spotUsd > 0 ? "<0.01" : spotUsd.toFixed(2)}</div>
                          <div className="text-xs text-okx-text-tertiary">{spotPct.toFixed(2)}%</div>
                        </div>
                        <svg className="w-4 h-4 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="h-px bg-okx-border-primary mx-6" />

              {/* All assets table */}
              <div className="px-6 py-6">
                <h2 className="text-lg font-semibold text-okx-text-primary mb-5">{t("assets")}</h2>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 bg-okx-bg-secondary rounded-lg px-3 py-2 w-[280px]">
                    <svg className="w-4 h-4 text-okx-text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
                    <span className="text-sm text-okx-text-tertiary">{t("search")}</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" className="w-3.5 h-3.5 rounded border-okx-border-primary accent-meme-lime" />
                    <span className="text-xs text-okx-text-secondary">{t("hideSmall")}</span>
                  </label>
                </div>
                <div>
                  <div className="grid grid-cols-4 gap-4 py-2.5 border-b border-okx-border-primary">
                    <span className="text-xs text-okx-text-tertiary">{t("assetName")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("holdingAmount")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("assetValue")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("assetRatio")}</span>
                  </div>
                  {/* BNB row */}
                  <div className="grid grid-cols-4 gap-4 py-4 border-b border-okx-border-primary hover:bg-okx-bg-hover transition-colors">
                    <div className="flex items-center gap-3">
                      <BnbIcon size={32} className="flex-shrink-0" />
                      <div className="flex flex-col"><span className="text-sm font-semibold text-okx-text-primary">BNB</span><span className="text-[11px] text-okx-text-tertiary">BNB</span></div>
                    </div>
                    <div className="text-right self-center"><div className="font-mono text-sm text-okx-text-primary">{formatBal(totalAssets)}</div><div className="font-mono text-[11px] text-okx-text-tertiary">${totalUsd < 0.01 && totalUsd > 0 ? "<0.01" : totalUsd.toFixed(2)}</div></div>
                    <div className="font-mono text-sm text-okx-text-primary text-right self-center">${totalUsd < 0.01 && totalUsd > 0 ? "<0.01" : totalUsd.toFixed(2)}</div>
                    <div className="text-right self-center">
                      <div className="font-mono text-sm text-okx-text-primary">{totalCombinedUsd > 0 ? `${tradingPct.toFixed(2)}%` : "--"}</div>
                      <div className="w-16 h-1 rounded-full bg-okx-bg-hover ml-auto mt-1"><div className="h-full rounded-full bg-[#7B61FF]" style={{ width: `${tradingPct}%` }} /></div>
                    </div>
                  </div>
                  {/* Token rows */}
                  {userTokens.map((token) => {
                    const AVATAR_COLORS = ["#FF6B35", "#4CAF50", "#E91E63", "#9C27B0", "#06B6D4", "#F59E0B"];
                    let hash = 0; for (let i = 0; i < token.address.length; i++) hash = ((hash << 5) - hash) + token.address.charCodeAt(i);
                    const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
                    const userBal = tokenBalances.get(token.address.toLowerCase()) || 0n;
                    const userBalNum = Number(formatUnits(userBal, 18));
                    const tokenPrice = Number(token.price || "0") / 1e18;
                    const valueInBnb = userBalNum * tokenPrice;
                    const valueInUsd = valueInBnb * bnbPriceUsd;
                    const ratio = totalCombinedUsd > 0 ? (valueInUsd / totalCombinedUsd * 100) : 0;
                    return (
                      <div key={token.address} className="grid grid-cols-4 gap-4 py-4 border-b border-okx-border-primary hover:bg-okx-bg-hover transition-colors cursor-pointer" onClick={() => router.push(`/exchange?symbol=${token.address}`)}>
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style={{ backgroundColor: color }}>{token.symbol?.charAt(0)?.toUpperCase() || "?"}</div>
                          <div className="flex flex-col"><span className="text-sm font-semibold text-okx-text-primary">{token.symbol}</span><span className="text-[11px] text-okx-text-tertiary truncate max-w-[120px]">{token.name}</span></div>
                        </div>
                        <div className="text-right self-center"><div className="font-mono text-sm text-okx-text-primary">{userBalNum > 0 ? userBalNum.toFixed(4) : "<0.0001"}</div><div className="font-mono text-[11px] text-okx-text-tertiary">${valueInUsd < 0.01 && valueInUsd > 0 ? "<0.01" : valueInUsd.toFixed(2)}</div></div>
                        <div className="font-mono text-sm text-okx-text-primary text-right self-center">${valueInUsd < 0.01 && valueInUsd > 0 ? "<0.01" : valueInUsd.toFixed(2)}</div>
                        <div className="text-right self-center">
                          <div className="font-mono text-sm text-okx-text-primary">{ratio > 0 ? `${ratio.toFixed(2)}%` : "--"}</div>
                          <div className="w-16 h-1 rounded-full bg-okx-bg-hover ml-auto mt-1"><div className="h-full rounded-full bg-[#F0B90B]" style={{ width: `${Math.min(ratio, 100)}%` }} /></div>
                        </div>
                      </div>
                    );
                  })}
                  {userTokens.length === 0 && totalAssets === 0n && (
                    <div className="py-14 text-center text-okx-text-tertiary text-sm">{t("noSpotHoldings")}</div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ══════════════════════════════════════
               TAB: 合约账户 (Trading)
              ══════════════════════════════════════ */}
          {activeTab === "trading" && (
            <>
              {/* Hero: Two-column */}
              <div className="flex gap-5 px-6 pt-6 pb-4">
                <div className="flex-[2] bg-okx-bg-secondary rounded-2xl p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm text-okx-text-secondary">{t("totalAssetValue")}</span>
                  </div>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-mono text-[36px] font-bold text-okx-text-primary leading-none">
                      {vaultUsd < 0.01 && vaultUsd > 0 ? "<0.01" : vaultUsd.toFixed(2)}
                    </span>
                    <span className="text-sm text-okx-text-secondary">USD</span>
                  </div>
                  <div className="flex items-center gap-2.5 mt-5">
                    <button onClick={() => router.push("/perp")} className="bg-okx-text-primary text-okx-bg-primary text-sm font-medium px-5 py-2 rounded-full hover:opacity-90 transition-opacity">{t("tradeBtnLabel")}</button>
                    <button onClick={() => router.push("/deposit")} className="border border-okx-border-secondary text-okx-text-primary text-sm font-medium px-5 py-2 rounded-full hover:bg-okx-bg-hover transition-colors">{t("deposit")}</button>
                    <button onClick={() => router.push("/deposit?tab=withdraw")} className="border border-okx-border-secondary text-okx-text-primary text-sm font-medium px-5 py-2 rounded-full hover:bg-okx-bg-hover transition-colors">{t("withdraw")}</button>
                  </div>
                </div>
                {/* Right: Recent trades */}
                <div className="flex-[1] bg-okx-bg-secondary rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-5">
                    <span className="text-sm font-semibold text-okx-text-primary">{t("recentTrades")}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center py-8 text-okx-text-tertiary">
                    <svg className="w-12 h-12 mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="text-sm">{t("noTransactions")}</span>
                    <span className="text-xs mt-1">{t("startTrading")}</span>
                  </div>
                </div>
              </div>

              <div className="h-px bg-okx-border-primary mx-6" />

              {/* Positions + Balance table */}
              <div className="px-6 py-6">
                <h2 className="text-lg font-semibold text-okx-text-primary mb-5">{t("assets")}</h2>
                {/* Trading balance cards */}
                <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="bg-okx-bg-secondary rounded-xl px-5 py-4">
                    <div className="text-xs text-okx-text-tertiary mb-2">{t("availableBalance")}</div>
                    <div className="font-mono text-base font-semibold text-okx-text-primary">{formatBal(availableBalance)} <span className="text-xs text-okx-text-tertiary font-normal">BNB</span></div>
                    <div className="font-mono text-xs text-okx-text-tertiary mt-1">≈ ${(parseFloat(formatUnits(availableBalance, 18)) * bnbPriceUsd).toFixed(2)}</div>
                  </div>
                  <div className="bg-okx-bg-secondary rounded-xl px-5 py-4">
                    <div className="text-xs text-okx-text-tertiary mb-2">{t("lockedMargin")}</div>
                    <div className="font-mono text-base font-semibold text-okx-text-primary">{formatBal(lockedMargin)} <span className="text-xs text-okx-text-tertiary font-normal">BNB</span></div>
                    <div className="font-mono text-xs text-okx-text-tertiary mt-1">≈ ${(parseFloat(formatUnits(lockedMargin, 18)) * bnbPriceUsd).toFixed(2)}</div>
                  </div>
                  <div className="bg-okx-bg-secondary rounded-xl px-5 py-4">
                    <div className="text-xs text-okx-text-tertiary mb-2">{t("unrealizedPnl")}</div>
                    <div className={`font-mono text-base font-semibold ${unrealizedPnL >= 0n ? "text-meme-lime" : "text-okx-down"}`}>{unrealizedPnL >= 0n ? "+" : ""}{formatBal(unrealizedPnL)} <span className="text-xs font-normal">BNB</span></div>
                    <div className="font-mono text-xs text-okx-text-tertiary mt-1">≈ ${(Math.abs(parseFloat(formatUnits(unrealizedPnL, 18))) * bnbPriceUsd).toFixed(2)}</div>
                  </div>
                </div>

                {/* Positions table */}
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-semibold text-okx-text-primary">{t("currentPositions")}</h3>
                  <span className="text-xs font-mono text-meme-lime bg-meme-lime/10 px-2.5 py-1 rounded-full">{positions.length} {t("activePositions")}</span>
                </div>
                {hasPosition && positions.length > 0 ? (
                  <div>
                    <div className="grid grid-cols-7 gap-2 py-2.5 border-b border-okx-border-primary">
                      <span className="text-xs text-okx-text-tertiary">{t("pair")}</span>
                      <span className="text-xs text-okx-text-tertiary">{t("direction")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("positionSize")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("margin")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("entryPrice")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("liqPrice")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("unrealizedPnl")}</span>
                    </div>
                    {positions.map((pos) => {
                      const pnl = BigInt(pos.unrealizedPnL || "0");
                      const isProfit = pnl >= 0n;
                      const pnlPct = ((Number(formatUnits(pnl, 18)) / Math.max(Number(formatUnits(BigInt(pos.collateral || "0"), 18)), 0.0001)) * 100).toFixed(1);
                      return (
                        <div key={pos.pairId} className="grid grid-cols-7 gap-2 py-3.5 border-b border-okx-border-primary hover:bg-okx-bg-hover transition-colors cursor-pointer" onClick={() => router.push(`/perp?symbol=${pos.token}`)}>
                          <span className="font-mono text-sm font-medium text-okx-text-primary truncate">{pos.token.slice(0, 8)}...-PERP</span>
                          <span><span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded ${pos.isLong ? "bg-meme-lime/15 text-meme-lime" : "bg-okx-down/15 text-okx-down"}`}>{pos.isLong ? t("long") : t("short")} {parseFloat(pos.leverage)}x</span></span>
                          <span className="font-mono text-sm text-okx-text-secondary text-right">{formatBal(pos.size)}</span>
                          <span className="font-mono text-sm text-okx-text-secondary text-right">{formatBal(pos.collateral)}</span>
                          <span className="font-mono text-sm text-okx-text-secondary text-right">{formatBal(pos.entryPrice)}</span>
                          <span className="font-mono text-sm text-okx-down text-right">{formatBal(pos.liquidationPrice || "0")}</span>
                          <span className={`font-mono text-sm font-semibold text-right ${isProfit ? "text-meme-lime" : "text-okx-down"}`}>{isProfit ? "+" : ""}{formatBal(pnl)} ({isProfit ? "+" : ""}{pnlPct}%)</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="bg-okx-bg-secondary rounded-xl p-10 text-center text-okx-text-tertiary text-sm">{t("noPositions")}</div>
                )}
              </div>
            </>
          )}

          {/* ══════════════════════════════════════
               TAB: 现货持仓 (Spot)
              ══════════════════════════════════════ */}
          {activeTab === "spot" && (
            <>
              {/* Hero */}
              <div className="flex gap-5 px-6 pt-6 pb-4">
                <div className="flex-[2] bg-okx-bg-secondary rounded-2xl p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm text-okx-text-secondary">{t("totalAssetValue")}</span>
                  </div>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-mono text-[36px] font-bold text-okx-text-primary leading-none">
                      {spotUsd < 0.01 && spotUsd > 0 ? "<0.01" : spotUsd.toFixed(2)}
                    </span>
                    <span className="text-sm text-okx-text-secondary">USD</span>
                  </div>
                  <div className="flex items-center gap-2.5 mt-5">
                    <button onClick={() => router.push("/exchange")} className="bg-okx-text-primary text-okx-bg-primary text-sm font-medium px-5 py-2 rounded-full hover:opacity-90 transition-opacity">{t("buyTokens")}</button>
                  </div>
                </div>
                {/* Right: Recent records */}
                <div className="flex-[1] bg-okx-bg-secondary rounded-2xl p-6">
                  <div className="flex items-center justify-between mb-5">
                    <span className="text-sm font-semibold text-okx-text-primary">{t("recentRecords")}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center py-8 text-okx-text-tertiary">
                    <svg className="w-12 h-12 mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="text-sm">{t("noTransactions")}</span>
                  </div>
                </div>
              </div>

              <div className="h-px bg-okx-border-primary mx-6" />

              {/* Spot token table */}
              <div className="px-6 py-6">
                <h2 className="text-lg font-semibold text-okx-text-primary mb-5">{t("assets")}</h2>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 bg-okx-bg-secondary rounded-lg px-3 py-2 w-[280px]">
                    <svg className="w-4 h-4 text-okx-text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
                    <span className="text-sm text-okx-text-tertiary">{t("search")}</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" className="w-3.5 h-3.5 rounded border-okx-border-primary accent-meme-lime" />
                    <span className="text-xs text-okx-text-secondary">{t("hideSmall")}</span>
                  </label>
                </div>
                <div>
                  <div className="grid grid-cols-4 gap-4 py-2.5 border-b border-okx-border-primary">
                    <span className="text-xs text-okx-text-tertiary">{t("assetName")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("holdingAmount")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("assetRatio")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("change")}</span>
                  </div>
                  {userTokens.length > 0 ? userTokens.map((token) => {
                    const AVATAR_COLORS = ["#FF6B35", "#4CAF50", "#E91E63", "#9C27B0", "#06B6D4", "#F59E0B"];
                    let hash = 0; for (let i = 0; i < token.address.length; i++) hash = ((hash << 5) - hash) + token.address.charCodeAt(i);
                    const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
                    const userBal = tokenBalances.get(token.address.toLowerCase()) || 0n;
                    const userBalNum = Number(formatUnits(userBal, 18));
                    const tokenPrice = Number(token.price || "0") / 1e18;
                    const valueInUsd = userBalNum * tokenPrice * bnbPriceUsd;
                    const change24h = parseFloat(token.priceChangePercent24h || "0");
                    const ratio = spotUsd > 0 ? (valueInUsd / spotUsd * 100) : 0;
                    return (
                      <div key={token.address} className="grid grid-cols-4 gap-4 py-4 border-b border-okx-border-primary hover:bg-okx-bg-hover transition-colors cursor-pointer" onClick={() => router.push(`/exchange?symbol=${token.address}`)}>
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style={{ backgroundColor: color }}>{token.symbol?.charAt(0)?.toUpperCase() || "?"}</div>
                          <div className="flex flex-col"><span className="text-sm font-semibold text-okx-text-primary">{token.symbol}</span><span className="text-[11px] text-okx-text-tertiary truncate max-w-[120px]">{token.name}</span></div>
                        </div>
                        <div className="text-right self-center">
                          <div className="font-mono text-sm text-okx-text-primary">{userBalNum.toFixed(4)}</div>
                          <div className="font-mono text-[11px] text-okx-text-tertiary">${valueInUsd < 0.01 ? "<0.01" : valueInUsd.toFixed(2)}</div>
                        </div>
                        <div className="text-right self-center">
                          <div className="font-mono text-sm text-okx-text-primary">{ratio.toFixed(2)}%</div>
                          <div className="w-16 h-1 rounded-full bg-okx-bg-hover ml-auto mt-1"><div className="h-full rounded-full bg-[#F0B90B]" style={{ width: `${Math.min(ratio, 100)}%` }} /></div>
                        </div>
                        <span className={`font-mono text-sm font-semibold text-right self-center ${change24h >= 0 ? "text-meme-lime" : "text-okx-down"}`}>
                          {change24h !== 0 ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%` : "--"}
                        </span>
                      </div>
                    );
                  }) : (
                    <div className="py-14 text-center text-okx-text-tertiary text-sm">{t("noSpotHoldings")}</div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Bottom spacing */}
          <div className="h-10" />
        </div>
      )}
    </main>
  );
}
