"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { parseEther, formatEther } from "viem";
import type { usePerpVaultLP } from "@/hooks/perpetual/usePerpVaultLP";

// Gas reserve: keep 0.01 BNB for gas
const GAS_RESERVE = parseEther("0.01");
const FEE_PRECISION = 10000n;

interface VaultActionPanelProps {
  vault: ReturnType<typeof usePerpVaultLP>;
}

export function VaultActionPanel({ vault }: VaultActionPanelProps) {
  const t = useTranslations("vault");
  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit");
  const [depositInput, setDepositInput] = useState("");
  const [withdrawInput, setWithdrawInput] = useState("");
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const {
    poolStats,
    extendedStats,
    userPosition,
    depositFeeBps,
    withdrawalFeeBps,
    nativeBalance,
    isConnected,
    isWritePending,
    isConfirming,
    isConfirmed,
    deposit,
    requestWithdrawal,
    executeWithdrawal,
    cancelWithdrawal,
    estimateShares,
    estimateWithdrawETH,
    refetch,
    refetchNative,
    resetWrite,
  } = vault;

  // Reset inputs on confirmed tx
  useEffect(() => {
    if (isConfirmed) {
      setDepositInput("");
      setWithdrawInput("");
      refetch();
      refetchNative();
      const timer = setTimeout(() => resetWrite(), 2000);
      return () => clearTimeout(timer);
    }
  }, [isConfirmed, refetch, refetchNative, resetWrite]);

  // Cooldown countdown timer
  useEffect(() => {
    const remaining = userPosition?.withdrawal.cooldownRemaining ?? 0;
    setCooldownSeconds(remaining);
    if (remaining <= 0) return;

    const interval = setInterval(() => {
      setCooldownSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [userPosition?.withdrawal.cooldownRemaining]);

  // Deposit amount as BigInt
  const depositAmountWei = useMemo(() => {
    if (!depositInput || isNaN(Number(depositInput)) || Number(depositInput) <= 0)
      return 0n;
    try {
      return parseEther(depositInput);
    } catch {
      return 0n;
    }
  }, [depositInput]);

  // Max deposit (native balance minus gas reserve)
  const maxDeposit = useMemo(() => {
    if (nativeBalance <= GAS_RESERVE) return 0n;
    return nativeBalance - GAS_RESERVE;
  }, [nativeBalance]);

  // Deposit fee preview
  const depositFeeWei = useMemo(() => {
    if (depositAmountWei === 0n) return 0n;
    return (depositAmountWei * depositFeeBps) / FEE_PRECISION;
  }, [depositAmountWei, depositFeeBps]);

  // Shares to receive
  const sharesToReceive = useMemo(() => {
    if (depositAmountWei === 0n) return 0n;
    return estimateShares(depositAmountWei);
  }, [depositAmountWei, estimateShares]);

  // Withdraw shares as BigInt
  const withdrawSharesWei = useMemo(() => {
    if (!withdrawInput || isNaN(Number(withdrawInput)) || Number(withdrawInput) <= 0)
      return 0n;
    try {
      return parseEther(withdrawInput);
    } catch {
      return 0n;
    }
  }, [withdrawInput]);

  // Withdraw estimated BNB
  const withdrawEstimatedETH = useMemo(() => {
    if (withdrawSharesWei === 0n) return 0n;
    return estimateWithdrawETH(withdrawSharesWei);
  }, [withdrawSharesWei, estimateWithdrawETH]);

  // Withdraw fee
  const withdrawFeeWei = useMemo(() => {
    if (withdrawSharesWei === 0n || !poolStats) return 0n;
    const gross =
      (withdrawSharesWei * poolStats.sharePrice) / (10n ** 18n);
    return (gross * withdrawalFeeBps) / FEE_PRECISION;
  }, [withdrawSharesWei, poolStats, withdrawalFeeBps]);

  const hasPendingWithdrawal =
    userPosition && userPosition.withdrawal.pendingShares > 0n;

  const canExecuteWithdrawal =
    hasPendingWithdrawal && cooldownSeconds === 0;

  const depositDisabled =
    !isConnected ||
    depositAmountWei === 0n ||
    depositAmountWei > maxDeposit ||
    isWritePending ||
    isConfirming ||
    extendedStats?.depositsPaused === true;

  const setDepositPercent = useCallback(
    (pct: number) => {
      if (maxDeposit <= 0n) return;
      const amount =
        pct === 100 ? maxDeposit : (maxDeposit * BigInt(pct)) / 100n;
      setDepositInput(formatEther(amount));
    },
    [maxDeposit]
  );

  const setWithdrawPercent = useCallback(
    (pct: number) => {
      const shares = userPosition?.shares ?? 0n;
      if (shares <= 0n) return;
      const amount =
        pct === 100 ? shares : (shares * BigInt(pct)) / 100n;
      setWithdrawInput(formatEther(amount));
    },
    [userPosition?.shares]
  );

  const handleDeposit = useCallback(() => {
    if (depositAmountWei <= 0n) return;
    deposit(depositAmountWei);
  }, [deposit, depositAmountWei]);

  const handleRequestWithdrawal = useCallback(() => {
    if (withdrawSharesWei <= 0n) return;
    requestWithdrawal(withdrawSharesWei);
  }, [requestWithdrawal, withdrawSharesWei]);

  const formatCooldown = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const busyLabel = isConfirming
    ? t("confirming")
    : isWritePending
      ? activeTab === "deposit"
        ? t("depositing")
        : t("requesting")
      : null;

  return (
    <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl overflow-hidden">
      {/* Tab header */}
      <div className="flex border-b border-okx-border-primary">
        <button
          onClick={() => setActiveTab("deposit")}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === "deposit"
              ? "text-okx-up border-b-2 border-okx-up"
              : "text-okx-text-tertiary hover:text-okx-text-secondary"
          }`}
        >
          {t("depositTab")}
        </button>
        <button
          onClick={() => setActiveTab("withdraw")}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            activeTab === "withdraw"
              ? "text-okx-down border-b-2 border-okx-down"
              : "text-okx-text-tertiary hover:text-okx-text-secondary"
          }`}
        >
          {t("withdrawTab")}
        </button>
      </div>

      <div className="p-4 space-y-4">
        {activeTab === "deposit" ? (
          <>
            {/* Deposits paused warning */}
            {extendedStats?.depositsPaused && (
              <div className="bg-okx-down/10 border border-okx-down/30 rounded-lg px-3 py-2 text-xs text-okx-down">
                {t("depositsPaused")}
              </div>
            )}

            {/* Deposit input */}
            <div>
              <label className="text-xs text-okx-text-tertiary mb-1 block">
                {t("depositAmount")}
              </label>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={depositInput}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (/^[0-9]*\.?[0-9]*$/.test(val)) {
                      setDepositInput(val);
                    }
                  }}
                  placeholder={t("enterAmount")}
                  className="w-full bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2.5 pr-14 text-sm font-mono text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-okx-text-tertiary font-medium">
                  BNB
                </span>
              </div>
            </div>

            {/* Quick percent buttons */}
            <div className="flex gap-2">
              {[25, 50, 75].map((pct) => (
                <button
                  key={pct}
                  onClick={() => setDepositPercent(pct)}
                  className="flex-1 py-1.5 text-xs rounded-md border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-secondary transition-colors"
                >
                  {pct}%
                </button>
              ))}
              <button
                onClick={() => setDepositPercent(100)}
                className="flex-1 py-1.5 text-xs rounded-md border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-secondary transition-colors"
              >
                {t("max")}
              </button>
            </div>

            {/* Available balance */}
            <div className="flex justify-between text-xs text-okx-text-tertiary">
              <span>{t("available")}</span>
              <span className="font-mono">
                {formatEther(nativeBalance)} BNB
              </span>
            </div>

            {/* Fee + shares preview */}
            {depositAmountWei > 0n && (
              <div className="space-y-2 bg-okx-bg-hover rounded-lg p-3">
                <div className="flex justify-between text-xs">
                  <span className="text-okx-text-tertiary">
                    {t("depositFee")} ({Number(depositFeeBps) / 100}%)
                  </span>
                  <span className="text-okx-text-secondary font-mono">
                    {formatEther(depositFeeWei)} BNB
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-okx-text-tertiary">
                    {t("sharesToReceive")}
                  </span>
                  <span className="text-okx-text-primary font-mono font-medium">
                    {formatEther(sharesToReceive)}
                  </span>
                </div>
              </div>
            )}

            {/* Deposit button */}
            <button
              onClick={handleDeposit}
              disabled={depositDisabled}
              className={`w-full py-3 rounded-lg text-sm font-bold transition-colors ${
                depositDisabled
                  ? "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                  : "bg-okx-up text-black hover:opacity-90"
              }`}
            >
              {busyLabel ??
                (depositAmountWei > maxDeposit && depositAmountWei > 0n
                  ? t("insufficientBalance")
                  : t("depositButton"))}
            </button>
          </>
        ) : (
          /* ── Withdraw Tab ── */
          <>
            {hasPendingWithdrawal ? (
              /* Pending withdrawal state */
              <div className="space-y-4">
                <div className="bg-okx-bg-hover rounded-lg p-3 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-okx-text-tertiary">
                      {t("pendingWithdrawal")}
                    </span>
                    <span className="text-okx-text-primary font-mono font-medium">
                      {formatEther(userPosition!.withdrawal.pendingShares)}{" "}
                      shares
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-okx-text-tertiary">
                      {t("estimatedETH")}
                    </span>
                    <span className="text-okx-text-primary font-mono">
                      {formatEther(userPosition!.withdrawal.estimatedETH)} BNB
                    </span>
                  </div>
                </div>

                {cooldownSeconds > 0 ? (
                  /* Cooldown active */
                  <div className="space-y-3">
                    <div className="text-center py-4">
                      <p className="text-xs text-okx-text-tertiary mb-2">
                        {t("cooldownRemaining")}
                      </p>
                      <p className="text-2xl font-bold font-mono text-okx-text-primary">
                        {formatCooldown(cooldownSeconds)}
                      </p>
                      <p className="text-xs text-okx-text-tertiary mt-1">
                        {t("cooldown24h")}
                      </p>
                    </div>
                    <button
                      onClick={cancelWithdrawal}
                      disabled={isWritePending || isConfirming}
                      className="w-full py-3 rounded-lg text-sm font-bold border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isWritePending || isConfirming
                        ? t("cancelling")
                        : t("cancelWithdrawal")}
                    </button>
                  </div>
                ) : (
                  /* Cooldown elapsed - can execute */
                  <div className="space-y-3">
                    <button
                      onClick={executeWithdrawal}
                      disabled={isWritePending || isConfirming}
                      className="w-full py-3 rounded-lg text-sm font-bold bg-okx-down text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isWritePending || isConfirming
                        ? t("executing")
                        : t("executeWithdrawal")}
                    </button>
                    <button
                      onClick={cancelWithdrawal}
                      disabled={isWritePending || isConfirming}
                      className="w-full py-2.5 rounded-lg text-sm font-medium border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t("cancelWithdrawal")}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              /* No pending withdrawal - show request form */
              <>
                {/* Shares input */}
                <div>
                  <label className="text-xs text-okx-text-tertiary mb-1 block">
                    {t("withdrawShares")}
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={withdrawInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (/^[0-9]*\.?[0-9]*$/.test(val)) {
                          setWithdrawInput(val);
                        }
                      }}
                      placeholder={t("enterAmount")}
                      className="w-full bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2.5 pr-20 text-sm font-mono text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-okx-text-tertiary font-medium">
                      shares
                    </span>
                  </div>
                </div>

                {/* Quick percent buttons */}
                <div className="flex gap-2">
                  {[25, 50, 75].map((pct) => (
                    <button
                      key={pct}
                      onClick={() => setWithdrawPercent(pct)}
                      className="flex-1 py-1.5 text-xs rounded-md border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-secondary transition-colors"
                    >
                      {pct}%
                    </button>
                  ))}
                  <button
                    onClick={() => setWithdrawPercent(100)}
                    className="flex-1 py-1.5 text-xs rounded-md border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-secondary transition-colors"
                  >
                    {t("max")}
                  </button>
                </div>

                {/* Your shares */}
                <div className="flex justify-between text-xs text-okx-text-tertiary">
                  <span>{t("yourShares")}</span>
                  <span className="font-mono">
                    {userPosition
                      ? userPosition.sharesFormatted
                      : "0"}
                  </span>
                </div>

                {/* Fee + estimated BNB preview */}
                {withdrawSharesWei > 0n && (
                  <div className="space-y-2 bg-okx-bg-hover rounded-lg p-3">
                    <div className="flex justify-between text-xs">
                      <span className="text-okx-text-tertiary">
                        {t("withdrawFee")} ({Number(withdrawalFeeBps) / 100}%)
                      </span>
                      <span className="text-okx-text-secondary font-mono">
                        {formatEther(withdrawFeeWei)} BNB
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-okx-text-tertiary">
                        {t("estimatedETH")}
                      </span>
                      <span className="text-okx-text-primary font-mono font-medium">
                        {formatEther(withdrawEstimatedETH)} BNB
                      </span>
                    </div>
                  </div>
                )}

                {/* Cooldown notice */}
                <p className="text-xs text-okx-text-tertiary text-center">
                  {t("cooldown24h")}
                </p>

                {/* Request button */}
                <button
                  onClick={handleRequestWithdrawal}
                  disabled={
                    !isConnected ||
                    withdrawSharesWei === 0n ||
                    withdrawSharesWei > (userPosition?.shares ?? 0n) ||
                    isWritePending ||
                    isConfirming
                  }
                  className={`w-full py-3 rounded-lg text-sm font-bold transition-colors ${
                    !isConnected ||
                    withdrawSharesWei === 0n ||
                    withdrawSharesWei > (userPosition?.shares ?? 0n) ||
                    isWritePending ||
                    isConfirming
                      ? "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                      : "bg-okx-down text-white hover:opacity-90"
                  }`}
                >
                  {isWritePending || isConfirming
                    ? t("requesting")
                    : userPosition?.shares === 0n || !userPosition
                      ? t("noShares")
                      : t("requestWithdrawal")}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
