"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Navbar } from "@/components/layout/Navbar";
import { useAccount, useBalance } from "wagmi";
import { useTranslations } from "next-intl";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { useTradingWallet } from "@/hooks/common/useTradingWallet";
import { CONTRACTS } from "@/config/contracts";
import { parseEther, formatEther } from "viem";

// 充值步骤配置
const DEPOSIT_STEPS = [
  { label: "转入 BNB", desc: "从主钱包转入 BNB 到交易钱包" },
  { label: "包装 WBNB", desc: "将 BNB 包装为 WBNB (WBNB.deposit)" },
  { label: "存入合约", desc: "授权 + 存入 SettlementV2 合约" },
];

// 模拟交易记录
interface TxRecord {
  type: "deposit" | "withdraw";
  amount: string;
  status: "confirmed" | "pending" | "failed";
  time: string;
  confirmations?: string;
}

const MOCK_TX_HISTORY: TxRecord[] = [
  { type: "deposit", amount: "+0.5000 ETH", status: "pending", time: "2 分钟前", confirmations: "2/12" },
  { type: "deposit", amount: "+1.0000 ETH", status: "confirmed", time: "1 小时前" },
  { type: "withdraw", amount: "-0.3000 ETH", status: "confirmed", time: "3 小时前" },
  { type: "withdraw", amount: "-2.0000 ETH", status: "failed", time: "昨天" },
  { type: "deposit", amount: "+0.2500 ETH", status: "confirmed", time: "2 天前" },
];

export default function DepositPage() {
  const { address, isConnected } = useAccount();
  const { data: walletBalance } = useBalance({ address });

  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [depositStep, setDepositStep] = useState(0);
  const [txFilter, setTxFilter] = useState<"all" | "deposit" | "withdraw">("all");

  const filteredTx = MOCK_TX_HISTORY.filter(
    (tx) => txFilter === "all" || tx.type === txFilter
  );

  // 模拟余额
  const mockBalances = {
    available: "3.4500",
    margin: "1.2000",
    unrealizedPnl: "+0.0823",
    total: "4.7323",
    totalUsd: "2,638.42",
  };

  const handleDeposit = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    // 模拟 3 步充值
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

      <div className="max-w-[1440px] mx-auto px-8 lg:px-16 py-8">
        <div className="flex gap-8 items-start">
          {/* Left: Deposit Form */}
          <div className="w-[560px] shrink-0 space-y-6">
            {/* Tab Switcher */}
            <div className="flex gap-2">
              <button
                onClick={() => setActiveTab("deposit")}
                className={`px-6 py-2.5 rounded-full text-sm font-medium transition-all ${
                  activeTab === "deposit"
                    ? "bg-meme-lime text-black font-bold"
                    : "bg-okx-bg-card border border-okx-border-primary text-okx-text-secondary hover:text-white"
                }`}
              >
                充值
              </button>
              <button
                onClick={() => setActiveTab("withdraw")}
                className={`px-6 py-2.5 rounded-full text-sm font-medium transition-all ${
                  activeTab === "withdraw"
                    ? "bg-meme-lime text-black font-bold"
                    : "bg-okx-bg-card border border-okx-border-primary text-okx-text-secondary hover:text-white"
                }`}
              >
                提款
              </button>
            </div>

            {/* Deposit Card */}
            <div className="meme-card p-8 space-y-6">
              <div>
                <h2 className="text-xl font-bold mb-1">
                  {activeTab === "deposit" ? "充值到交易账户" : "从交易账户提款"}
                </h2>
                <p className="text-sm text-okx-text-secondary">
                  {activeTab === "deposit"
                    ? "将资产从钱包转入 SettlementV2 合约，开始交易"
                    : "通过 Merkle proof 从 SettlementV2 合约提取资产"}
                </p>
              </div>

              {/* Step 1: Select Asset */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-okx-text-secondary">选择资产</label>
                <div className="flex items-center gap-3 p-4 bg-okx-bg-hover rounded-xl border border-okx-border-primary">
                  <div className="w-8 h-8 rounded-full bg-[#627EEA] flex items-center justify-center text-white font-bold text-sm">
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
                    {activeTab === "deposit" ? "充值金额" : "提款金额"}
                  </label>
                  <span className="text-okx-text-tertiary">
                    余额: {walletBalance ? parseFloat(walletBalance.formatted).toFixed(4) : "0.0000"}{" "}
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
                  {DEPOSIT_STEPS.map((step, idx) => {
                    const stepNum = idx + 1;
                    const isActive = depositStep === stepNum;
                    const isDone = depositStep > stepNum;
                    return (
                      <div
                        key={stepNum}
                        className={`flex items-center gap-3 p-3 rounded-lg border ${
                          isDone
                            ? "border-[#0ECB81]/30 bg-[#0ECB81]/5"
                            : isActive
                            ? "border-meme-lime/30 bg-meme-lime/5"
                            : "border-okx-border-primary bg-okx-bg-card opacity-50"
                        }`}
                      >
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                            isDone
                              ? "bg-[#0ECB81] text-black"
                              : isActive
                              ? "bg-meme-lime text-black animate-pulse"
                              : "bg-okx-bg-hover text-okx-text-tertiary"
                          }`}
                        >
                          {isDone ? "✓" : stepNum}
                        </div>
                        <div>
                          <div className={`text-sm font-medium ${isDone ? "text-[#0ECB81]" : ""}`}>
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
                  ? "请先连接钱包"
                  : depositStep > 0
                  ? `步骤 ${depositStep}/3 处理中...`
                  : activeTab === "deposit"
                  ? "充值"
                  : "提款"}
              </button>
            </div>
          </div>

          {/* Right: Transaction History + Balance Summary */}
          <div className="flex-1 space-y-5">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold">充值/提款记录</h3>
              <button className="text-sm text-meme-lime hover:opacity-80">查看全部 →</button>
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
                      : "bg-okx-bg-card border border-okx-border-primary text-okx-text-secondary hover:text-white"
                  }`}
                >
                  {f === "all" ? "全部" : f === "deposit" ? "充值" : "提款"}
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
                      tx.type === "deposit" ? "bg-[#0ECB81]/15 text-[#0ECB81]" : "bg-[#F6465D]/15 text-[#F6465D]"
                    }`}
                  >
                    {tx.type === "deposit" ? "↓" : "↑"}
                  </div>

                  {/* Info */}
                  <div className="flex-1">
                    <div className="text-sm font-medium">
                      {tx.type === "deposit" ? "充值" : "提款"} ETH
                    </div>
                    <div className="text-xs text-okx-text-tertiary">{tx.time}</div>
                  </div>

                  {/* Amount */}
                  <div className={`text-sm font-mono font-medium ${tx.type === "deposit" ? "text-[#0ECB81]" : "text-[#F6465D]"}`}>
                    {tx.amount}
                  </div>

                  {/* Status */}
                  <div className="min-w-[80px] text-right">
                    {tx.status === "confirmed" && (
                      <span className="text-xs text-[#0ECB81]">✓ 已完成</span>
                    )}
                    {tx.status === "pending" && (
                      <span className="text-xs text-[#F0B90B]">
                        ⏳ 确认中 ({tx.confirmations})
                      </span>
                    )}
                    {tx.status === "failed" && (
                      <div className="flex items-center gap-2 justify-end">
                        <span className="text-xs text-[#F6465D]">✗ 失败</span>
                        <button className="text-xs text-meme-lime hover:opacity-80">重试 ↻</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Account Balance Summary */}
            <div className="meme-card p-5 space-y-4">
              <h4 className="text-sm font-bold text-okx-text-secondary">账户余额概览</h4>

              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">可用余额</span>
                  <span className="font-mono font-medium">{mockBalances.available} ETH</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">已用保证金</span>
                  <span className="font-mono font-medium text-[#F0B90B]">{mockBalances.margin} ETH</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">未实现盈亏</span>
                  <span className="font-mono font-medium text-[#0ECB81]">{mockBalances.unrealizedPnl} ETH</span>
                </div>
                <div className="h-px bg-okx-border-primary" />
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">总资产估值</span>
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
