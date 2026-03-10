"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Navbar } from "@/components/layout/Navbar";
import { useAccount, useBalance } from "wagmi";
import { useTranslations } from "next-intl";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { CONTRACTS } from "@/lib/contracts";
import { parseEther, formatEther } from "viem";

interface TxRecord {
  type: "deposit" | "withdraw";
  amount: string;
  status: "confirmed" | "pending" | "failed";
  timeKey: string;
  confirmations?: string;
}

export default function DepositPage() {
  const { address, isConnected } = useAccount();
  const { data: walletBalance } = useBalance({ address });
  const t = useTranslations("depositPage");

  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [depositStep, setDepositStep] = useState(0);
  const [txFilter, setTxFilter] = useState<"all" | "deposit" | "withdraw">("all");

  const depositSteps = [
    { label: t("step1Label"), desc: t("step1Desc") },
    { label: t("step2Label"), desc: t("step2Desc") },
    { label: t("step3Label"), desc: t("step3Desc") },
  ];

  // Mock transaction history
  const mockTxHistory: TxRecord[] = [
    { type: "deposit", amount: "+0.5000 ETH", status: "pending", timeKey: "2minAgo", confirmations: "2/12" },
    { type: "deposit", amount: "+1.0000 ETH", status: "confirmed", timeKey: "1hourAgo" },
    { type: "withdraw", amount: "-0.3000 ETH", status: "confirmed", timeKey: "3hoursAgo" },
    { type: "withdraw", amount: "-2.0000 ETH", status: "failed", timeKey: "yesterday" },
    { type: "deposit", amount: "+0.2500 ETH", status: "confirmed", timeKey: "2daysAgo" },
  ];

  const filteredTx = mockTxHistory.filter(
    (tx) => txFilter === "all" || tx.type === txFilter
  );

  const mockBalances = {
    available: "3.4500",
    margin: "1.2000",
    unrealizedPnl: "+0.0823",
    total: "4.7323",
    totalUsd: "2,638.42",
  };

  const handleDeposit = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    for (let i = 1; i <= 3; i++) {
      setDepositStep(i);
      await new Promise((r) => setTimeout(r, 1500));
    }
    setDepositStep(0);
    setAmount("");
  };

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      <div className="max-w-[1440px] mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-8">
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start">
          {/* Left: Deposit Form */}
          <div className="w-full lg:w-[560px] lg:shrink-0 space-y-6">
            {/* Tab Switcher */}
            <div className="flex gap-2">
              <button
                onClick={() => setActiveTab("deposit")}
                className={`px-6 py-2.5 rounded-full text-sm font-medium transition-all ${
                  activeTab === "deposit"
                    ? "bg-meme-lime text-black font-bold"
                    : "bg-okx-bg-card border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary"
                }`}
              >
                {t("deposit")}
              </button>
              <button
                onClick={() => setActiveTab("withdraw")}
                className={`px-6 py-2.5 rounded-full text-sm font-medium transition-all ${
                  activeTab === "withdraw"
                    ? "bg-meme-lime text-black font-bold"
                    : "bg-okx-bg-card border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary"
                }`}
              >
                {t("withdraw")}
              </button>
            </div>

            {/* Deposit Card */}
            <div className="meme-card p-8 space-y-6">
              <div>
                <h2 className="text-xl font-bold mb-1">
                  {activeTab === "deposit" ? t("depositTitle") : t("withdrawTitle")}
                </h2>
                <p className="text-sm text-okx-text-secondary">
                  {activeTab === "deposit" ? t("depositDesc") : t("withdrawDesc")}
                </p>
              </div>

              {/* Step 1: Select Asset */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-okx-text-secondary">{t("selectAsset")}</label>
                <div className="flex items-center gap-3 p-4 bg-okx-bg-hover rounded-xl border border-okx-border-primary">
                  <div className="w-8 h-8 rounded-full bg-okx-accent/20 flex items-center justify-center text-okx-text-primary font-bold text-sm">
                    E
                  </div>
                  <div className="flex-1">
                    <div className="font-medium">ETH (BNB)</div>
                    <div className="text-xs text-okx-text-tertiary">BSC Testnet</div>
                  </div>
                  <span className="text-xs text-okx-text-tertiary">▼</span>
                </div>
              </div>

              {/* Step 2: Amount */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <label className="font-medium text-okx-text-secondary">
                    {activeTab === "deposit" ? t("depositAmount") : t("withdrawAmount")}
                  </label>
                  <span className="text-okx-text-tertiary">
                    {t("balance")}: {walletBalance ? parseFloat(walletBalance.formatted).toFixed(4) : "0.0000"}{" "}
                    {walletBalance?.symbol || "BNB"}
                  </span>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full meme-input px-4 py-3.5 text-lg font-mono pr-20"
                  />
                  <button
                    onClick={() =>
                      setAmount(walletBalance ? parseFloat(walletBalance.formatted).toFixed(4) : "0")
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-meme-lime text-sm font-bold hover:opacity-80"
                  >
                    MAX
                  </button>
                </div>
              </div>

              {/* Step 3: Progress */}
              {depositStep > 0 && (
                <div className="space-y-3">
                  {depositSteps.map((step, idx) => {
                    const stepNum = idx + 1;
                    const isActive = depositStep === stepNum;
                    const isDone = depositStep > stepNum;
                    return (
                      <div
                        key={stepNum}
                        className={`flex items-center gap-3 p-3 rounded-lg border ${
                          isDone
                            ? "border-okx-up/30 bg-okx-up/5"
                            : isActive
                            ? "border-meme-lime/30 bg-meme-lime/5"
                            : "border-okx-border-primary bg-okx-bg-card opacity-50"
                        }`}
                      >
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                            isDone
                              ? "bg-okx-up text-black"
                              : isActive
                              ? "bg-meme-lime text-black animate-pulse"
                              : "bg-okx-bg-hover text-okx-text-tertiary"
                          }`}
                        >
                          {isDone ? "✓" : stepNum}
                        </div>
                        <div>
                          <div className={`text-sm font-medium ${isDone ? "text-okx-up" : ""}`}>
                            {step.label}
                          </div>
                          <div className="text-xs text-okx-text-tertiary">{step.desc}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Submit Button */}
              <button
                onClick={handleDeposit}
                disabled={!isConnected || depositStep > 0 || !amount}
                className={`w-full py-3.5 rounded-xl text-sm font-bold transition-all ${
                  !isConnected || depositStep > 0 || !amount
                    ? "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                    : "meme-btn-primary"
                }`}
              >
                {!isConnected
                  ? t("connectWalletFirst")
                  : depositStep > 0
                  ? t("processingStep", { step: depositStep })
                  : activeTab === "deposit"
                  ? t("deposit")
                  : t("withdraw")}
              </button>
            </div>
          </div>

          {/* Right: Transaction History + Balance Summary */}
          <div className="flex-1 min-w-0 space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">{t("txHistory")}</h3>
              <button className="text-sm text-meme-lime hover:opacity-80">{t("viewAll")}</button>
            </div>

            {/* Filter Pills */}
            <div className="flex gap-2">
              {(["all", "deposit", "withdraw"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setTxFilter(f)}
                  className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
                    txFilter === f
                      ? "bg-meme-lime text-black"
                      : "bg-okx-bg-card border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary"
                  }`}
                >
                  {f === "all" ? t("filterAll") : f === "deposit" ? t("deposit") : t("withdraw")}
                </button>
              ))}
            </div>

            {/* Transaction List */}
            <div className="space-y-2">
              {filteredTx.map((tx, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-3 p-3.5 bg-okx-bg-card border border-okx-border-primary rounded-xl hover:border-okx-border-hover transition-colors"
                >
                  {/* Direction Icon */}
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${
                      tx.type === "deposit" ? "bg-okx-up/15 text-okx-up" : "bg-okx-down/15 text-okx-down"
                    }`}
                  >
                    {tx.type === "deposit" ? "↓" : "↑"}
                  </div>

                  {/* Info */}
                  <div className="flex-1">
                    <div className="text-sm font-medium">
                      {tx.type === "deposit" ? t("deposit") : t("withdraw")} ETH
                    </div>
                    <div className="text-xs text-okx-text-tertiary">{t(tx.timeKey)}</div>
                  </div>

                  {/* Amount */}
                  <div className={`text-sm font-mono font-medium ${tx.type === "deposit" ? "text-okx-up" : "text-okx-down"}`}>
                    {tx.amount}
                  </div>

                  {/* Status */}
                  <div className="min-w-[80px] text-right">
                    {tx.status === "confirmed" && (
                      <span className="text-xs text-okx-up">✓ {t("confirmed")}</span>
                    )}
                    {tx.status === "pending" && (
                      <span className="text-xs text-meme-lime">
                        ⏳ {t("confirming")} ({tx.confirmations})
                      </span>
                    )}
                    {tx.status === "failed" && (
                      <div className="flex items-center gap-2 justify-end">
                        <span className="text-xs text-okx-down">✗ {t("failed")}</span>
                        <button className="text-xs text-meme-lime hover:opacity-80">{t("retry")}</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Account Balance Summary */}
            <div className="meme-card p-5 space-y-4">
              <h4 className="text-sm font-bold text-okx-text-secondary">{t("balanceOverview")}</h4>

              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("availableBalance")}</span>
                  <span className="font-mono font-medium">{mockBalances.available} ETH</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("usedMargin")}</span>
                  <span className="font-mono font-medium text-meme-lime">{mockBalances.margin} ETH</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("unrealizedPnl")}</span>
                  <span className="font-mono font-medium text-okx-up">{mockBalances.unrealizedPnl} ETH</span>
                </div>
                <div className="h-px bg-okx-border-primary" />
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("totalAssets")}</span>
                  <div className="text-right">
                    <div className="font-mono font-bold text-meme-lime">{mockBalances.total} ETH</div>
                    <div className="text-xs text-okx-text-tertiary">≈ ${mockBalances.totalUsd}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
