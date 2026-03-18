"use client";

import React, { useState, useMemo } from "react";
import { useAccount } from "wagmi";
import { useTranslations } from "next-intl";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatUnits } from "viem";
import { Navbar } from "@/components/layout/Navbar";
import { useLendingPool } from "@/hooks/lending/useLendingPool";
import { LendingMarketTable } from "@/components/lending/LendingMarketTable";
import { LendingActionPanel } from "@/components/lending/LendingActionPanel";
import { LendingDashboard } from "@/components/lending/LendingDashboard";

export default function LendPage() {
  const t = useTranslations("lending");
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();

  const {
    pools,
    isLoadingPools,
    positions,
    isLoadingPositions,
    selectedToken,
    setSelectedToken,
    tokenBalance,
    allowance,
    needsApproval,
    approve,
    isApproving,
    deposit,
    isDepositing,
    withdraw,
    isWithdrawing,
    claimInterest,
    isClaiming,
    refetch,
  } = useLendingPool();

  // View mode: "markets" shows all pools, "positions" filters to user positions only
  const [viewMode, setViewMode] = useState<"markets" | "positions">("markets");

  const selectedPool = pools.find((p) => p.token === selectedToken);
  const selectedPosition = positions.find((p) => p.token === selectedToken);

  // Aggregate stats for dashboard
  const totalSupplied = useMemo(
    () => positions.reduce((acc, p) => acc + p.depositAmount, 0n),
    [positions]
  );
  const totalPendingInterest = useMemo(
    () => positions.reduce((acc, p) => acc + p.pendingInterest, 0n),
    [positions]
  );

  // Weighted average APY across user's positions
  const weightedAPY = useMemo(() => {
    if (totalSupplied === 0n || positions.length === 0) return "0.00";
    let weightedSum = 0;
    const totalNum = Number(formatUnits(totalSupplied, 18));
    for (const pos of positions) {
      const pool = pools.find((p) => p.token === pos.token);
      if (!pool) continue;
      const posAmount = Number(formatUnits(pos.depositAmount, 18));
      const apy = parseFloat(pool.supplyAPY);
      weightedSum += posAmount * apy;
    }
    return (weightedSum / totalNum).toFixed(2);
  }, [totalSupplied, positions, pools]);

  // Filtered pools for display
  const displayPools = useMemo(() => {
    if (viewMode === "positions") {
      return pools.filter((p) =>
        positions.some((pos) => pos.token === p.token)
      );
    }
    return pools;
  }, [pools, positions, viewMode]);

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      <div className="max-w-[1200px] mx-auto px-4 py-6">
        {/* ── Page Header ── */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">{t("title")}</h1>
            <p className="text-okx-text-secondary text-sm mt-1">
              {t("subtitle")}
            </p>
          </div>
          {isConnected && (
            <button
              onClick={refetch}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-okx-text-secondary border border-okx-border-primary hover:border-okx-border-secondary hover:text-okx-text-primary transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {t("refreshData")}
            </button>
          )}
        </div>

        {!isConnected ? (
          /* ── Not Connected ── */
          <div className="flex flex-col items-center justify-center py-20">
            <div className="max-w-md text-center">
              {/* Vault Icon */}
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-okx-accent/20 to-okx-up/20 flex items-center justify-center">
                <svg className="w-10 h-10 text-okx-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h2 className="text-xl font-bold mb-2">{t("connectWalletTitle")}</h2>
              <p className="text-okx-text-secondary text-sm mb-6 leading-relaxed">
                {t("connectWalletDesc")}
              </p>
              <button
                onClick={openConnectModal}
                className="bg-okx-accent text-black px-8 py-3 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity"
              >
                {t("connectWallet")}
              </button>

              {/* Feature highlights */}
              <div className="grid grid-cols-3 gap-4 mt-10">
                <div className="text-center">
                  <div className="text-lg font-bold text-okx-up mb-1">{t("featureEarn")}</div>
                  <div className="text-xs text-okx-text-tertiary">{t("featureEarnDesc")}</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold text-okx-accent mb-1">{t("featureFlexible")}</div>
                  <div className="text-xs text-okx-text-tertiary">{t("featureFlexibleDesc")}</div>
                </div>
                <div className="text-center">
                  <div className="text-lg font-bold text-okx-text-primary mb-1">{t("featureSecure")}</div>
                  <div className="text-xs text-okx-text-tertiary">{t("featureSecureDesc")}</div>
                </div>
              </div>
            </div>
          </div>
        ) : isLoadingPools ? (
          /* ── Loading ── */
          <div className="space-y-4">
            {/* Skeleton dashboard */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4 animate-pulse">
                  <div className="h-3 w-20 bg-okx-bg-hover rounded mb-3"></div>
                  <div className="h-6 w-24 bg-okx-bg-hover rounded"></div>
                </div>
              ))}
            </div>
            {/* Skeleton table */}
            <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4 animate-pulse">
              <div className="h-4 w-40 bg-okx-bg-hover rounded mb-6"></div>
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-4 border-b border-okx-border-primary last:border-0">
                  <div className="h-8 w-8 bg-okx-bg-hover rounded-full"></div>
                  <div className="h-4 w-20 bg-okx-bg-hover rounded"></div>
                  <div className="flex-1"></div>
                  <div className="h-4 w-16 bg-okx-bg-hover rounded"></div>
                  <div className="h-4 w-16 bg-okx-bg-hover rounded"></div>
                  <div className="h-4 w-16 bg-okx-bg-hover rounded"></div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* ── Main Content ── */
          <div className="space-y-5">
            {/* ── User Dashboard (only if has positions) ── */}
            {positions.length > 0 && (
              <LendingDashboard
                totalSupplied={totalSupplied}
                totalPendingInterest={totalPendingInterest}
                weightedAPY={weightedAPY}
                positionCount={positions.length}
              />
            )}

            {/* ── Market Table Section ── */}
            <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl overflow-hidden">
              {/* Table Header with view toggle */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-okx-border-primary">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setViewMode("markets")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      viewMode === "markets"
                        ? "bg-okx-bg-hover text-okx-text-primary"
                        : "text-okx-text-tertiary hover:text-okx-text-secondary"
                    }`}
                  >
                    {t("allMarkets")} ({pools.length})
                  </button>
                  {positions.length > 0 && (
                    <button
                      onClick={() => setViewMode("positions")}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        viewMode === "positions"
                          ? "bg-okx-bg-hover text-okx-text-primary"
                          : "text-okx-text-tertiary hover:text-okx-text-secondary"
                      }`}
                    >
                      {t("yourPositions")} ({positions.length})
                    </button>
                  )}
                </div>
                <div className="text-xs text-okx-text-tertiary">
                  {t("autoRefresh")}
                </div>
              </div>

              {/* Table */}
              {displayPools.length > 0 ? (
                <LendingMarketTable
                  pools={displayPools}
                  positions={positions}
                  selectedToken={selectedToken}
                  onSelect={setSelectedToken}
                />
              ) : (
                <div className="py-16 text-center">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-okx-bg-hover flex items-center justify-center">
                    <svg className="w-8 h-8 text-okx-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                    </svg>
                  </div>
                  <p className="text-okx-text-secondary text-sm mb-1">{t("noPools")}</p>
                </div>
              )}
            </div>

            {/* ── Action Panel (shows when token selected) ── */}
            {selectedPool && (
              <LendingActionPanel
                pool={selectedPool}
                userPosition={selectedPosition}
                tokenBalance={tokenBalance}
                allowance={allowance}
                needsApproval={needsApproval}
                onApprove={approve}
                onDeposit={deposit}
                onWithdraw={withdraw}
                onClaimInterest={claimInterest}
                isApproving={isApproving}
                isDepositing={isDepositing}
                isWithdrawing={isWithdrawing}
                isClaiming={isClaiming}
                onClose={() => setSelectedToken(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
