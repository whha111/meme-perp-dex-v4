"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { parseUnits, formatUnits, type Address } from "viem";
import type { PoolInfo, UserLendingPosition } from "@/hooks/lending/useLendingPool";

interface LendingActionPanelProps {
  pool: PoolInfo;
  userPosition?: UserLendingPosition;
  tokenBalance: bigint;
  allowance: bigint;
  needsApproval: (amount: bigint) => boolean;
  onApprove: (token: Address) => Promise<void>;
  onDeposit: (token: Address, amount: bigint) => Promise<void>;
  onWithdraw: (token: Address, shares: bigint) => Promise<void>;
  onClaimInterest: (token: Address) => Promise<void>;
  isApproving: boolean;
  isDepositing: boolean;
  isWithdrawing: boolean;
  isClaiming: boolean;
  onClose: () => void;
}

type Tab = "deposit" | "withdraw";

export function LendingActionPanel({
  pool,
  userPosition,
  tokenBalance,
  needsApproval,
  onApprove,
  onDeposit,
  onWithdraw,
  onClaimInterest,
  isApproving,
  isDepositing,
  isWithdrawing,
  isClaiming,
  onClose,
}: LendingActionPanelProps) {
  const t = useTranslations("lending");
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();

  const [activeTab, setActiveTab] = useState<Tab>("deposit");
  const [depositInput, setDepositInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");

  // Parse input amounts
  const depositAmount = useMemo(() => {
    try {
      return depositInput ? parseUnits(depositInput, 18) : 0n;
    } catch {
      return 0n;
    }
  }, [depositInput]);

  const withdrawAmount = useMemo(() => {
    try {
      return withdrawInput ? parseUnits(withdrawInput, 18) : 0n;
    } catch {
      return 0n;
    }
  }, [withdrawInput]);

  // Convert withdraw amount to shares
  const withdrawShares = useMemo(() => {
    if (withdrawAmount === 0n || pool.totalDeposits === 0n || pool.totalShares === 0n) return 0n;
    return (withdrawAmount * pool.totalShares) / pool.totalDeposits;
  }, [withdrawAmount, pool.totalShares, pool.totalDeposits]);

  // Validation
  const depositError = useMemo(() => {
    if (!depositInput) return null;
    if (depositAmount === 0n) return t("enterAmount");
    if (depositAmount > tokenBalance) return t("insufficientBalance");
    return null;
  }, [depositInput, depositAmount, tokenBalance, t]);

  const withdrawError = useMemo(() => {
    if (!withdrawInput) return null;
    if (withdrawAmount === 0n) return t("enterAmount");
    if (userPosition && withdrawAmount > userPosition.depositAmount) return t("insufficientBalance");
    return null;
  }, [withdrawInput, withdrawAmount, userPosition, t]);

  // Quick amount helpers
  const setWithdrawPercent = (pct: number) => {
    if (!userPosition || userPosition.depositAmount === 0n) return;
    const amount = (userPosition.depositAmount * BigInt(pct)) / 100n;
    setWithdrawInput(formatUnits(amount, 18));
  };

  const setDepositPercent = (pct: number) => {
    if (tokenBalance === 0n) return;
    const amount = (tokenBalance * BigInt(pct)) / 100n;
    setDepositInput(formatUnits(amount, 18));
  };

  // Handlers
  const handleDeposit = async () => {
    if (!isConnected) { openConnectModal?.(); return; }
    if (depositAmount === 0n || depositError) return;
    if (needsApproval(depositAmount)) {
      await onApprove(pool.token);
      return;
    }
    await onDeposit(pool.token, depositAmount);
    setDepositInput("");
  };

  const handleWithdraw = async () => {
    if (!isConnected) { openConnectModal?.(); return; }
    if (withdrawShares === 0n || withdrawError) return;
    await onWithdraw(pool.token, withdrawShares);
    setWithdrawInput("");
  };

  const handleClaim = async () => {
    if (!isConnected) { openConnectModal?.(); return; }
    await onClaimInterest(pool.token);
  };

  const isDepositButtonApprove = depositAmount > 0n && needsApproval(depositAmount);
  const utilNum = parseFloat(pool.utilizationPercent);

  return (
    <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl overflow-hidden">
      {/* ── Panel Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-okx-border-primary">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-okx-bg-hover to-okx-border-primary flex items-center justify-center text-xs font-bold">
            {pool.tokenSymbol.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <span className="font-bold text-sm">{pool.tokenSymbol}</span>
            <span className="text-okx-text-tertiary text-xs ml-2">{pool.tokenName}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-okx-text-tertiary hover:text-okx-text-primary hover:bg-okx-bg-hover transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-okx-border-primary">
        {/* ── Left: Market Info (5 cols) ── */}
        <div className="lg:col-span-5 p-5 space-y-4">
          {/* Market Overview */}
          <div>
            <h3 className="text-xs text-okx-text-tertiary font-medium uppercase tracking-wider mb-3">
              {t("marketOverview")}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-okx-bg-primary rounded-lg p-3">
                <div className="text-xs text-okx-text-tertiary mb-1">{t("supplyAPY")}</div>
                <div className="text-lg font-bold text-okx-up">{pool.supplyAPY}%</div>
              </div>
              <div className="bg-okx-bg-primary rounded-lg p-3">
                <div className="text-xs text-okx-text-tertiary mb-1">{t("borrowAPY")}</div>
                <div className="text-lg font-bold">{pool.borrowAPY}%</div>
              </div>
            </div>
          </div>

          {/* Pool Stats */}
          <div className="space-y-2.5">
            <div className="flex justify-between items-center text-xs">
              <span className="text-okx-text-tertiary">{t("tvl")}</span>
              <span className="font-medium">{pool.totalDepositsFormatted} {pool.tokenSymbol}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-okx-text-tertiary">{t("colTotalBorrowed")}</span>
              <span className="font-medium">{pool.totalBorrowedFormatted} {pool.tokenSymbol}</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-okx-text-tertiary">{t("availableLiquidity")}</span>
              <span className="font-medium">{pool.availableLiquidityFormatted} {pool.tokenSymbol}</span>
            </div>

            {/* Utilization Bar — prominent */}
            <div>
              <div className="flex justify-between items-center text-xs mb-1.5">
                <span className="text-okx-text-tertiary">{t("utilization")}</span>
                <span className={`font-bold ${
                  utilNum >= 90 ? "text-okx-down" : utilNum >= 80 ? "text-yellow-500" : "text-okx-up"
                }`}>
                  {pool.utilizationPercent}%
                </span>
              </div>
              <div className="w-full h-2 bg-okx-bg-primary rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    utilNum >= 90 ? "bg-okx-down" : utilNum >= 80 ? "bg-yellow-500" : "bg-okx-up"
                  }`}
                  style={{ width: `${Math.min(utilNum, 100)}%` }}
                />
              </div>
              {/* Optimal marker */}
              <div className="relative mt-0.5">
                <div className="absolute left-[80%] -translate-x-1/2 text-xs text-okx-text-tertiary">
                  80%
                </div>
              </div>
            </div>
          </div>

          {/* Interest Rate Model */}
          <details className="group">
            <summary className="text-xs text-okx-text-tertiary cursor-pointer hover:text-okx-text-secondary flex items-center gap-1">
              <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {t("rateModel")}
            </summary>
            <div className="mt-2 bg-okx-bg-primary rounded-lg p-3 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-okx-text-tertiary">{t("baseRate")}</span>
                <span>2%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-okx-text-tertiary">{t("optimalUtil")}</span>
                <span>80%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-okx-text-tertiary">{t("slopeBelow")}</span>
                <span>4%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-okx-text-tertiary">{t("slopeAbove")}</span>
                <span>75%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-okx-text-tertiary">{t("maxUtil")}</span>
                <span>90%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-okx-text-tertiary">{t("reserveFactor")}</span>
                <span>10%</span>
              </div>
            </div>
          </details>
        </div>

        {/* ── Middle: Your Position (3 cols) ── */}
        <div className="lg:col-span-3 p-5 space-y-4">
          <h3 className="text-xs text-okx-text-tertiary font-medium uppercase tracking-wider mb-3">
            {t("yourPosition")}
          </h3>

          {userPosition ? (
            <>
              <div className="bg-okx-bg-primary rounded-lg p-4 text-center">
                <div className="text-xs text-okx-text-tertiary mb-1">{t("currentDeposit")}</div>
                <div className="text-xl font-bold">{userPosition.depositAmountFormatted}</div>
                <div className="text-xs text-okx-text-secondary">{pool.tokenSymbol}</div>
              </div>

              {/* Pending Interest — claimable */}
              <div className="bg-okx-bg-primary rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-xs text-okx-text-tertiary">{t("claimableInterest")}</div>
                    <div className="text-lg font-bold text-okx-up">
                      +{userPosition.pendingInterestFormatted}
                      <span className="text-xs text-okx-text-secondary ml-1">{pool.tokenSymbol}</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleClaim}
                  disabled={
                    !isConnected
                      ? false
                      : userPosition.pendingInterest === 0n || isClaiming
                  }
                  className={`w-full py-2 rounded-lg text-xs font-bold transition-colors ${
                    userPosition.pendingInterest > 0n && !isClaiming
                      ? "bg-okx-up text-black hover:opacity-90"
                      : "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                  }`}
                >
                  {isClaiming ? t("claiming") : userPosition.pendingInterest > 0n ? t("claim") : t("noInterest")}
                </button>
              </div>

              {/* Position stats */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-okx-text-tertiary">{t("supplyAPY")}</span>
                  <span className="text-okx-up font-medium">{pool.supplyAPY}%</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-okx-text-tertiary">{t("walletBalance")}</span>
                  <span className="font-medium">{formatUnits(tokenBalance, 18).slice(0, 10)} {pool.tokenSymbol}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-okx-bg-primary rounded-lg p-6 text-center">
              <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-okx-bg-hover flex items-center justify-center">
                <svg className="w-6 h-6 text-okx-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
              </div>
              <p className="text-okx-text-secondary text-xs mb-1">{t("noPosition")}</p>
              <p className="text-okx-text-tertiary text-xs">{t("noPositionDesc")}</p>
            </div>
          )}
        </div>

        {/* ── Right: Action Form (4 cols) ── */}
        <div className="lg:col-span-4 p-5">
          {/* Tab Switcher */}
          <div className="flex bg-okx-bg-primary rounded-lg p-0.5 mb-4">
            {(["deposit", "withdraw"] as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-2 rounded-md text-xs font-medium transition-all ${
                  activeTab === tab
                    ? "bg-okx-bg-card text-okx-text-primary shadow-sm"
                    : "text-okx-text-tertiary hover:text-okx-text-secondary"
                }`}
              >
                {t(`tab${tab.charAt(0).toUpperCase() + tab.slice(1)}`)}
              </button>
            ))}
          </div>

          {/* ── Deposit Form ── */}
          {activeTab === "deposit" && (
            <div className="space-y-3">
              {/* Amount Input */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-xs text-okx-text-tertiary">{t("depositAmount")}</span>
                  <span className="text-xs text-okx-text-tertiary">
                    {t("walletBalance")}: {parseFloat(formatUnits(tokenBalance, 18)).toFixed(4)}
                  </span>
                </div>
                <div className="bg-okx-bg-primary border border-okx-border-primary rounded-lg p-3 focus-within:border-okx-accent transition-colors">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={depositInput}
                      onChange={(e) => setDepositInput(e.target.value)}
                      placeholder="0.00"
                      className="bg-transparent text-[16px] font-bold outline-none w-full text-okx-text-primary placeholder:text-okx-text-tertiary"
                    />
                    <span className="text-xs text-okx-text-secondary font-medium shrink-0">{pool.tokenSymbol}</span>
                  </div>
                </div>
                {depositError && (
                  <p className="text-xs text-okx-down mt-1">{depositError}</p>
                )}
              </div>

              {/* Quick amount buttons */}
              <div className="flex gap-1.5">
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => setDepositPercent(pct)}
                    className="flex-1 py-1.5 text-xs font-medium bg-okx-bg-primary border border-okx-border-primary rounded-lg hover:border-okx-border-secondary transition-colors text-okx-text-secondary"
                  >
                    {pct === 100 ? "MAX" : `${pct}%`}
                  </button>
                ))}
              </div>

              {/* Estimated return */}
              {depositAmount > 0n && !depositError && (
                <div className="bg-okx-bg-primary rounded-lg p-2.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-okx-text-tertiary">{t("estAnnualReturn")}</span>
                    <span className="text-okx-up font-medium">
                      +{(parseFloat(formatUnits(depositAmount, 18)) * parseFloat(pool.supplyAPY) / 100).toFixed(4)} {pool.tokenSymbol}
                    </span>
                  </div>
                </div>
              )}

              {/* Deposit Button */}
              <button
                onClick={handleDeposit}
                disabled={
                  !isConnected ? false : depositAmount === 0n || !!depositError || isDepositing || isApproving
                }
                className={`w-full py-3 rounded-lg text-sm font-bold transition-all ${
                  !isConnected || (depositAmount > 0n && !depositError && !isDepositing && !isApproving)
                    ? "bg-okx-accent text-black hover:opacity-90"
                    : "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                }`}
              >
                {!isConnected
                  ? t("connectWallet")
                  : isApproving
                  ? t("approving")
                  : isDepositing
                  ? t("depositing")
                  : isDepositButtonApprove
                  ? `${t("approve")} ${pool.tokenSymbol}`
                  : t("deposit")}
              </button>
            </div>
          )}

          {/* ── Withdraw Form ── */}
          {activeTab === "withdraw" && (
            <div className="space-y-3">
              {/* Current position reminder */}
              {userPosition && (
                <div className="bg-okx-bg-primary rounded-lg p-2.5 flex justify-between text-xs">
                  <span className="text-okx-text-tertiary">{t("currentDeposit")}</span>
                  <span className="font-medium">{userPosition.depositAmountFormatted} {pool.tokenSymbol}</span>
                </div>
              )}

              {/* Amount Input */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-xs text-okx-text-tertiary">{t("withdrawAmount")}</span>
                </div>
                <div className="bg-okx-bg-primary border border-okx-border-primary rounded-lg p-3 focus-within:border-okx-accent transition-colors">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={withdrawInput}
                      onChange={(e) => setWithdrawInput(e.target.value)}
                      placeholder="0.00"
                      className="bg-transparent text-[16px] font-bold outline-none w-full text-okx-text-primary placeholder:text-okx-text-tertiary"
                    />
                    <span className="text-xs text-okx-text-secondary font-medium shrink-0">{pool.tokenSymbol}</span>
                  </div>
                </div>
                {withdrawError && (
                  <p className="text-xs text-okx-down mt-1">{withdrawError}</p>
                )}
              </div>

              {/* Quick amount buttons */}
              <div className="flex gap-1.5">
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    onClick={() => setWithdrawPercent(pct)}
                    className="flex-1 py-1.5 text-xs font-medium bg-okx-bg-primary border border-okx-border-primary rounded-lg hover:border-okx-border-secondary transition-colors text-okx-text-secondary"
                  >
                    {pct === 100 ? "MAX" : `${pct}%`}
                  </button>
                ))}
              </div>

              {/* Withdraw Button */}
              <button
                onClick={handleWithdraw}
                disabled={
                  !isConnected ? false : withdrawShares === 0n || !!withdrawError || isWithdrawing
                }
                className={`w-full py-3 rounded-lg text-sm font-bold transition-all ${
                  !isConnected || (withdrawShares > 0n && !withdrawError && !isWithdrawing)
                    ? "bg-okx-down text-white hover:opacity-90"
                    : "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                }`}
              >
                {!isConnected
                  ? t("connectWallet")
                  : isWithdrawing
                  ? t("withdrawing")
                  : t("withdraw")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
