"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useAccount, useBalance } from "wagmi";
import { formatUnits } from "viem";
import { Navbar } from "@/components/layout/Navbar";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { TradeHistoryTable } from "@/components/common/TradeHistoryTable";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useTranslations } from "next-intl";

export default function AccountPage() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations("account");

  const { data: walletBalance } = useBalance({ address });
  const {
    positions,
    hasPosition,
    balance,
  } = usePerpetualV2();

  // Calculate balances from V2 hook (BNB, 18 decimals)
  const availableBalance = balance?.available || 0n;
  const lockedMargin = balance?.locked || 0n;
  const vaultBalance = availableBalance + lockedMargin;

  // Calculate total unrealized PnL from all positions
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
          <div className="w-8 h-8 border-4 border-okx-up border-t-transparent rounded-full animate-spin" />
        </div>
      </main>
    );
  }

  // Format BNB balance (18 decimals) for Settlement contract
  const formatBalance = (balance: bigint | string | null | undefined) => {
    if (!balance) return "0.0000";
    const value = typeof balance === "string" ? BigInt(balance) : balance;
    return parseFloat(formatUnits(value, 18)).toFixed(4);
  };

  // Format BNB balance (18 decimals) for wallet
  const formatEthBalance = (balance: bigint | null | undefined) => {
    if (!balance) return "0.0000";
    return parseFloat(formatUnits(balance, 18)).toFixed(4);
  };

  const totalPnL = unrealizedPnL || 0n;

  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-6">{t("title")}</h1>

        {!isConnected ? (
          <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-8 text-center">
            <p className="text-6xl mb-4">🔒</p>
            <p className="text-okx-text-secondary mb-4">{t("connectWalletHint")}</p>
            <button
              onClick={openConnectModal}
              className="bg-okx-up text-black px-6 py-3 rounded-lg font-bold hover:opacity-90"
            >
              {t("connectWallet")}
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Balance overview cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
                <p className="text-okx-text-tertiary text-sm mb-1">{t("walletBalance")}</p>
                <p className="text-xl font-bold">{formatEthBalance(walletBalance?.value)} BNB</p>
              </div>
              <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
                <p className="text-okx-text-tertiary text-sm mb-1">{t("contractAccount")}</p>
                <p className="text-xl font-bold">BNB {formatBalance(vaultBalance)}</p>
              </div>
              <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
                <p className="text-okx-text-tertiary text-sm mb-1">{t("availableBalance")}</p>
                <p className="text-xl font-bold text-okx-up">BNB {formatBalance(availableBalance)}</p>
              </div>
              <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
                <p className="text-okx-text-tertiary text-sm mb-1">{t("lockedMargin")}</p>
                <p className="text-xl font-bold">BNB {formatBalance(lockedMargin)}</p>
              </div>
            </div>

            {/* Current positions */}
            <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
              <h2 className="font-bold mb-4">{t("currentPositions")} ({positions.length})</h2>
              {hasPosition && positions.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                        <th className="text-left py-2">{t("pair")}</th>
                        <th className="text-left py-2">{t("direction")}</th>
                        <th className="text-right py-2">{t("positionSize")}</th>
                        <th className="text-right py-2">{t("margin")}</th>
                        <th className="text-right py-2">{t("leverage")}</th>
                        <th className="text-right py-2">{t("entryPrice")}</th>
                        <th className="text-right py-2">{t("unrealizedPnl")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((pos) => {
                        const positionPnL = BigInt(pos.unrealizedPnL || "0");
                        return (
                          <tr key={pos.pairId}>
                            <td className="py-3">{pos.token.slice(0, 8)}... {t("perpetual")}</td>
                            <td className={`py-3 ${pos.isLong ? "text-okx-up" : "text-okx-down"}`}>
                              {pos.isLong ? t("long") : t("short")}
                            </td>
                            <td className="text-right py-3">{formatBalance(pos.size)}</td>
                            <td className="text-right py-3">BNB {formatBalance(pos.collateral)}</td>
                            <td className="text-right py-3">{parseFloat(pos.leverage)}x</td>
                            <td className="text-right py-3">{formatBalance(pos.entryPrice)} BNB</td>
                            <td className={`text-right py-3 ${positionPnL >= 0n ? "text-okx-up" : "text-okx-down"}`}>
                              {positionPnL >= 0n ? "+" : ""}BNB {formatBalance(positionPnL)}
                            </td>
                          </tr>
                        );
                      })}
                      {/* Total row */}
                      <tr className="border-t border-okx-border-primary font-bold">
                        <td colSpan={6} className="text-right py-3">{t("totalPnl")}:</td>
                        <td className={`text-right py-3 ${totalPnL >= 0n ? "text-okx-up" : "text-okx-down"}`}>
                          {totalPnL >= 0n ? "+" : ""}BNB {formatBalance(totalPnL)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-8 text-okx-text-tertiary">
                  {t("noPositions")}
                </div>
              )}
            </div>

            {/* Trade history */}
            <TradeHistoryTable maxRows={20} />

            {/* Account address */}
            <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
              <h2 className="font-bold mb-3">{t("accountInfo")}</h2>
              <div className="flex items-center justify-between">
                <span className="text-okx-text-tertiary text-sm">{t("walletAddress")}</span>
                <span className="font-mono text-sm">{address}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
