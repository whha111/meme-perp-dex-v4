"use client";

/**
 * Deposit/Withdraw Page — Real on-chain operations
 *
 * Deposit: Main wallet → Trading wallet (BNB) → TradingVault.depositBNB() (atomic wrap+deposit)
 * Withdraw: Fast withdrawal — backend EIP-712 sig → TradingVault.fastWithdraw()
 */

import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { Navbar } from "@/components/layout/Navbar";
import {
  useAccount,
  useBalance,
  useSendTransaction,
  usePublicClient,
} from "wagmi";
import { useTranslations } from "next-intl";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { useWalletBalance } from "@/contexts/WalletBalanceContext";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";
import { CONTRACTS, getExplorerUrl } from "@/lib/contracts";
import { parseEther, formatEther, isAddress } from "viem";
import { BnbIcon } from "@/components/common/BnbIcon";

export default function DepositPage() {
  const { address: mainWallet, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const t = useTranslations("depositPage");

  // Trading wallet (signature-derived EOA)
  const {
    address: tradingWallet,
    getSignature,
    wrapAndDeposit,
    withdrawToMainWallet,
    isWithdrawingToMain,
    depositBNBToSettlement,
    depositExistingWBNB,
    isDepositingBNB,
  } = useTradingWallet();

  const tradingWalletSignature = getSignature();

  // SettlementV2 deposit/withdraw
  const {
    deposit: settlementDeposit,
    withdraw: settlementWithdraw,
    balance,
    positions,
  } = usePerpetualV2({
    tradingWalletAddress: tradingWallet || undefined,
    tradingWalletSignature: tradingWalletSignature || undefined,
    mainWalletAddress: mainWallet || undefined,
  });

  // Global balance (Settlement + native BNB + WBNB)
  const {
    totalBalance,
    walletOnlyBalance,
    settlementBalance,
    wethBalance,
    nativeEthBalance,
    refreshBalance: refreshGlobalBalance,
  } = useWalletBalance();

  // Main wallet BNB balance
  const { data: mainWalletBalance, refetch: refetchMainBalance } = useBalance({
    address: mainWallet,
  });

  // Send BNB to trading wallet
  const { sendTransactionAsync } = useSendTransaction();

  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [withdrawAddress, setWithdrawAddress] = useState("");
  const [showAssetDropdown, setShowAssetDropdown] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Auto-fill withdraw address with main wallet on connect
  useEffect(() => {
    if (mainWallet && !withdrawAddress) {
      setWithdrawAddress(mainWallet);
    }
  }, [mainWallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowAssetDropdown(false);
        setAssetSearch("");
      }
    };
    if (showAssetDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showAssetDropdown]);

  // Multi-step progress tracking
  const [depositStep, setDepositStep] = useState(0); // 0=idle, 1-3=in-progress
  const [withdrawStep, setWithdrawStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [successTxHash, setSuccessTxHash] = useState<string | null>(null);
  const depositStepRef = useRef(0);

  const amountWei = useMemo(() => {
    try {
      return parseEther(amount || "0");
    } catch {
      return 0n;
    }
  }, [amount]);

  const [quickDepositLoading, setQuickDepositLoading] = useState(false);
  const isProcessing = depositStep > 0 || withdrawStep > 0 || isWithdrawingToMain || isDepositingBNB || quickDepositLoading;

  // Withdraw address validation
  const isValidWithdrawAddress = useMemo(() => {
    return withdrawAddress.length > 0 && isAddress(withdrawAddress);
  }, [withdrawAddress]);

  const isWithdrawToSelf = useMemo(() => {
    return mainWallet && withdrawAddress.toLowerCase() === mainWallet.toLowerCase();
  }, [withdrawAddress, mainWallet]);

  // Total withdrawable = engine available (includes chain + mode2 profits) + wallet
  // Engine availableBalance = (chainSettlement + mode2Adjustment) - positionMargin - pendingOrders
  // Falls back to on-chain only when engine data is not yet loaded
  const totalWithdrawable = useMemo(() => {
    const engineAvailable = balance?.available ?? 0n;
    if (engineAvailable > 0n) {
      return engineAvailable + walletOnlyBalance;
    }
    return settlementBalance + walletOnlyBalance;
  }, [balance?.available, walletOnlyBalance, settlementBalance]);

  // Format BNB balance
  const fmtETH = (val: bigint | undefined) => {
    if (!val) return "0.0000";
    const num = Number(formatEther(val));
    if (num >= 1) return num.toFixed(4);
    if (num >= 0.0001) return num.toFixed(6);
    return num.toFixed(8);
  };

  // ═══════════════════════════════════════════════════════════
  // 2-step on-chain deposit (native BNB → SettlementV2.depositBNB)
  // ═══════════════════════════════════════════════════════════
  const handleDeposit = useCallback(async () => {
    if (!tradingWallet || amountWei === 0n || !publicClient) return;
    setStepError(null);
    setSuccessMsg(null);
    setSuccessTxHash(null);

    try {
      // Step 1: Transfer BNB from main wallet to trading wallet (skip if already enough)
      setDepositStep(1);
      depositStepRef.current = 1;

      // Check if trading wallet already has enough BNB (e.g. from a previous failed deposit)
      const GAS_RESERVE_FOR_DEPOSIT = 3000000000000000n; // 0.003 BNB for wrap+approve+deposit gas
      const tradingWalletBNB = await publicClient.getBalance({ address: tradingWallet });
      const totalNeeded = amountWei + GAS_RESERVE_FOR_DEPOSIT;

      if (tradingWalletBNB < totalNeeded) {
        // Only transfer the shortfall from main wallet
        const shortfall = totalNeeded - tradingWalletBNB;
        console.log(`[Deposit] Trading wallet has ${tradingWalletBNB}, needs ${totalNeeded}, transferring shortfall ${shortfall}`);
        const txHash = await sendTransactionAsync({
          to: tradingWallet,
          value: shortfall,
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
      } else {
        console.log(`[Deposit] Trading wallet already has ${tradingWalletBNB} >= ${totalNeeded}, skipping Step 1`);
      }

      // Step 2: Wrap BNB → WBNB → Approve → Deposit to SettlementV2
      setDepositStep(2);
      depositStepRef.current = 2;
      const depositHash = await depositBNBToSettlement(amountWei);
      await publicClient.waitForTransactionReceipt({ hash: depositHash });

      // Success
      setDepositStep(0);
      depositStepRef.current = 0;
      setAmount("");
      setSuccessMsg(`${t("deposit")} ${amount} BNB ${t("confirmed")}!`);
      setSuccessTxHash(depositHash);
      refreshGlobalBalance();
      refetchMainBalance();
    } catch (e) {
      const failedStep = depositStepRef.current;
      console.error(`[Deposit] Failed at step ${failedStep}:`, e);
      const { isUserRejection, extractErrorMessage } = await import("@/lib/errors/errorDictionary");
      const msg = isUserRejection(e) ? t("userCancelled") : extractErrorMessage(e, `Step ${failedStep} ${t("failed")}`);
      setStepError(msg);
      setDepositStep(0);
      depositStepRef.current = 0;
    }
  }, [
    tradingWallet, amountWei, amount, publicClient,
    sendTransactionAsync, depositBNBToSettlement,
    refreshGlobalBalance, refetchMainBalance, t,
  ]);

  // ═══════════════════════════════════════════════════════════
  // On-chain withdrawal: wallet transfer + fastWithdraw
  // ═══════════════════════════════════════════════════════════
  const handleWithdraw = useCallback(async () => {
    if (!tradingWallet || !mainWallet || amountWei === 0n) return;
    if (!isAddress(withdrawAddress)) return;

    const destinationAddress = withdrawAddress as `0x${string}`;
    setStepError(null);
    setSuccessMsg(null);
    setSuccessTxHash(null);

    try {
      let remaining = amountWei;
      let lastTxHash: string | null = null;

      // Phase 1: Transfer from trading wallet (if it has funds)
      if (walletOnlyBalance > 0n && remaining > 0n) {
        const walletAmount = remaining > walletOnlyBalance ? walletOnlyBalance : remaining;

        // If trading wallet has WBNB but insufficient native BNB for gas,
        // auto-fund gas from main wallet first (0.001 BNB covers unwrap + transfer gas)
        const MIN_GAS_FOR_WITHDRAWAL = parseEther("0.001");
        if (wethBalance > 0n && nativeEthBalance < MIN_GAS_FOR_WITHDRAWAL) {
          setWithdrawStep(1); // "Funding gas for withdrawal"
          console.log(`[Withdraw] Trading wallet native BNB too low (${nativeEthBalance}), funding gas from main wallet`);
          const gasFundTx = await sendTransactionAsync({
            to: tradingWallet,
            value: MIN_GAS_FOR_WITHDRAWAL,
          });
          if (publicClient) {
            await publicClient.waitForTransactionReceipt({ hash: gasFundTx });
          }
        }

        setWithdrawStep(2); // "Transferring from trading wallet"
        const walletTxHash = await withdrawToMainWallet(destinationAddress, walletAmount, wethBalance);
        if (walletTxHash) lastTxHash = walletTxHash;
        remaining -= walletAmount;
      }

      // Phase 2: Fast withdrawal from TradingVault (if still need more)
      // Use engine available (includes mode2 trading profits), not just on-chain settlementBalance
      // The engine's /api/wallet/withdraw validates the actual available balance server-side
      const engineAvailable = balance?.available ?? 0n;
      const vaultCap = engineAvailable > settlementBalance ? engineAvailable : settlementBalance;
      if (remaining > 0n && vaultCap > 0n) {
        setWithdrawStep(3); // "Fast withdrawal from TradingVault"
        const vaultAmount = remaining > vaultCap ? vaultCap : remaining;
        const vaultStr = formatEther(vaultAmount);
        const vaultTxHash = await settlementWithdraw(CONTRACTS.WETH, vaultStr);
        if (vaultTxHash) lastTxHash = vaultTxHash;
        remaining -= vaultAmount;

        // Phase 2b: TradingVault.fastWithdraw sends WBNB to trading wallet,
        // so we need to unwrap WBNB and transfer BNB to destination
        setWithdrawStep(4); // "Transferring to destination"

        const MIN_GAS_FOR_TRANSFER = parseEther("0.001");
        if (publicClient && tradingWallet) {
          const currentNative = await publicClient.getBalance({ address: tradingWallet });
          if (currentNative < MIN_GAS_FOR_TRANSFER) {
            console.log(`[Withdraw] Phase 2b: Trading wallet gas low (${currentNative}), funding from main wallet`);
            const gasTx = await sendTransactionAsync({
              to: tradingWallet,
              value: MIN_GAS_FOR_TRANSFER,
            });
            await publicClient.waitForTransactionReceipt({ hash: gasTx });
          }
        }

        // After fast withdrawal, trading wallet now has WBNB
        // withdrawToMainWallet handles: unwrap WBNB → send BNB to destination address
        const transferTxHash = await withdrawToMainWallet(destinationAddress, vaultAmount, vaultAmount);
        if (transferTxHash) lastTxHash = transferTxHash;
      }

      // Success
      setWithdrawStep(0);
      setAmount("");
      const shortAddr = `${destinationAddress.slice(0, 6)}...${destinationAddress.slice(-4)}`;
      setSuccessMsg(`${t("withdraw")} ${amount} BNB → ${shortAddr} ${t("confirmed")}!`);
      setSuccessTxHash(lastTxHash);
      refreshGlobalBalance();
      refetchMainBalance();
    } catch (e) {
      console.error("[Withdraw] Failed:", e);
      const { isUserRejection, extractErrorMessage } = await import("@/lib/errors/errorDictionary");
      const msg = isUserRejection(e) ? t("userCancelled") : extractErrorMessage(e, t("withdrawFailed") || "Withdrawal failed");
      setStepError(msg);
      setWithdrawStep(0);
    }
  }, [
    tradingWallet, mainWallet, amountWei, amount, balance, withdrawAddress,
    walletOnlyBalance, wethBalance, nativeEthBalance, settlementBalance,
    withdrawToMainWallet, settlementWithdraw, sendTransactionAsync, publicClient,
    refreshGlobalBalance, refetchMainBalance, t,
  ]);

  // ═══════════════════════════════════════════════════════════
  // Quick deposit: one-click deposit trading wallet BNB/WBNB → SettlementV2
  // Handles both cases:
  //   1. WBNB already wrapped (from previous failed deposit) → approve + deposit
  //   2. Native BNB → wrap + approve + deposit
  // ═══════════════════════════════════════════════════════════
  const QUICK_GAS_RESERVE = 3000000000000000n; // 0.003 BNB for gas
  const tradingWalletHasUndeposited = walletOnlyBalance > QUICK_GAS_RESERVE && settlementBalance === 0n;
  const depositableFromWallet = walletOnlyBalance > QUICK_GAS_RESERVE ? walletOnlyBalance - QUICK_GAS_RESERVE : 0n;

  const handleQuickDeposit = useCallback(async () => {
    console.log(`[QuickDeposit] tradingWallet=${tradingWallet}, publicClient=${!!publicClient}, wethBalance=${wethBalance}, nativeEthBalance=${nativeEthBalance}`);
    if (!tradingWallet) {
      setStepError("请先连接钱包并激活交易钱包");
      return;
    }
    if (!publicClient) {
      setStepError("网络连接失败，请刷新页面");
      return;
    }
    setQuickDepositLoading(true);
    setStepError(null);
    setSuccessMsg(null);
    setSuccessTxHash(null);

    try {
      let depositHash: `0x${string}`;
      let depositedAmount: bigint;

      if (wethBalance > 0n) {
        // Case 1: WBNB exists (from previous failed deposit where wrap succeeded but deposit failed)
        // Skip wrap — just approve + deposit to SettlementV2
        console.log(`[QuickDeposit] WBNB path: ${wethBalance} WBNB → approve + deposit`);
        depositHash = await depositExistingWBNB(wethBalance);
        depositedAmount = wethBalance;
      } else if (nativeEthBalance > QUICK_GAS_RESERVE) {
        // Case 2: Only native BNB — wrap + approve + deposit
        const nativeDepositable = nativeEthBalance - QUICK_GAS_RESERVE;
        console.log(`[QuickDeposit] Native BNB path: ${nativeDepositable} BNB → wrap + approve + deposit`);
        depositHash = await depositBNBToSettlement(nativeDepositable);
        depositedAmount = nativeDepositable;
      } else {
        setStepError("交易钱包余额不足");
        return;
      }

      await publicClient.waitForTransactionReceipt({ hash: depositHash });
      setSuccessMsg(`一键充值 ${formatEther(depositedAmount)} BNB 成功!`);
      setSuccessTxHash(depositHash);
      refreshGlobalBalance();
      refetchMainBalance();
    } catch (e) {
      console.error("[QuickDeposit] Failed:", e);
      const { isUserRejection, extractErrorMessage } = await import("@/lib/errors/errorDictionary");
      const msg = isUserRejection(e) ? t("userCancelled") : extractErrorMessage(e, "充值失败");
      setStepError(msg);
    } finally {
      setQuickDepositLoading(false);
    }
  }, [tradingWallet, wethBalance, nativeEthBalance, publicClient, depositExistingWBNB, depositBNBToSettlement, refreshGlobalBalance, refetchMainBalance, t]);

  // Deposit step labels (2-step flow: send BNB → atomic depositBNB)
  const depositStepLabels: Record<number, { label: string; desc: string }> = {
    1: { label: t("step1RealLabel"), desc: t("step1RealDesc") },
    2: { label: t("depositBNBLabel"), desc: t("depositBNBDesc") },
  };

  // Computed real balances from usePerpetualV2 (matching engine data)
  const availableBalance = balance?.available ?? 0n;
  const lockedMargin = balance?.locked ?? 0n;
  const unrealizedPnL = balance?.unrealizedPnL ?? 0n;
  // Equity = available + usedMargin + unrealizedPnL (matching engine's full account value)
  const equity = balance?.equity ?? 0n;

  // 总资产 = 引擎 equity (包含 mode2 调整 + 仓位 + 未实现盈亏) + 钱包余额
  // 当引擎 equity > 0 时优先使用引擎数据，否则回退到链上余额
  const totalAssetsBigInt = useMemo(() => {
    if (equity && equity > 0n) {
      // equity already includes settlement + mode2 + margin + unrealizedPnL
      // Add wallet balance (native BNB/WBNB not in settlement)
      return equity + walletOnlyBalance;
    }
    // Fallback: on-chain only
    return totalBalance;
  }, [equity, walletOnlyBalance, totalBalance]);

  const formattedTotalAssets = useMemo(() => {
    const num = Number(totalAssetsBigInt) / 1e18;
    if (num >= 1) return num.toFixed(4);
    if (num >= 0.0001) return num.toFixed(6);
    return num === 0 ? "0.0000" : num.toFixed(8);
  }, [totalAssetsBigInt]);

  const fmtBalance = (val: string | bigint) => {
    const num = Number(val) / 1e18;
    if (num >= 1) return num.toFixed(4);
    if (num >= 0.0001) return num.toFixed(6);
    return num === 0 ? "0.0000" : num.toFixed(8);
  };

  const equityUsd = (Number(totalAssetsBigInt) / 1e18 * 558).toFixed(2); // BNB ~$558

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      <div className="max-w-[1440px] mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-8">
        <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start">
          {/* Left: Deposit/Withdraw Form */}
          <div className="w-full lg:w-[560px] lg:shrink-0 space-y-6">
            {/* Tab Switcher */}
            <div className="flex gap-2">
              <button
                onClick={() => { setActiveTab("deposit"); setAmount(""); setStepError(null); setSuccessMsg(null); }}
                className={`px-6 py-2.5 rounded-full text-sm font-medium transition-all ${
                  activeTab === "deposit"
                    ? "bg-meme-lime text-black font-bold"
                    : "bg-okx-bg-hover border border-okx-border-secondary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-hover"
                }`}
              >
                {t("deposit")}
              </button>
              <button
                onClick={() => { setActiveTab("withdraw"); setAmount(""); setStepError(null); setSuccessMsg(null); }}
                className={`px-6 py-2.5 rounded-full text-sm font-medium transition-all ${
                  activeTab === "withdraw"
                    ? "bg-meme-lime text-black font-bold"
                    : "bg-okx-bg-hover border border-okx-border-secondary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-hover"
                }`}
              >
                {t("withdraw")}
              </button>
            </div>

            {/* Quick Deposit Banner — trading wallet has BNB not yet in SettlementV2 */}
            {activeTab === "deposit" && tradingWalletHasUndeposited && (
              <div className="bg-[#F0B90B]/10 border border-[#F0B90B]/30 rounded-xl p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#F0B90B]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-[#F0B90B] text-sm">⚡</span>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-[#F0B90B]">
                      交易钱包有 {fmtETH(walletOnlyBalance)} BNB 未存入合约
                    </div>
                    <div className="text-xs text-okx-text-tertiary mt-1">
                      检测到交易钱包中有未存入合约的 BNB，点击一键充值存入 SettlementV2 合约开始交易
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleQuickDeposit}
                  disabled={quickDepositLoading}
                  className="w-full py-2.5 rounded-lg text-sm font-bold bg-[#F0B90B] text-black hover:opacity-90 disabled:opacity-50 transition-all"
                >
                  {quickDepositLoading ? "充值中..." : `一键充值 ${fmtETH(depositableFromWallet)} BNB 到合约`}
                </button>
              </div>
            )}

            {/* Form Card */}
            <div className="bg-okx-bg-secondary rounded-2xl p-6 md:p-8 space-y-5">
              <div>
                <h2 className="text-lg font-semibold mb-1">
                  {activeTab === "deposit" ? t("depositTitle") : t("withdrawTitle")}
                </h2>
                <p className="text-xs text-okx-text-tertiary">
                  {activeTab === "deposit" ? t("depositDesc") : t("withdrawDesc")}
                </p>
              </div>

              {/* ─── Withdraw: Destination Address ─── */}
              {activeTab === "withdraw" && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-okx-text-secondary">{t("withdrawAddress")}</label>
                  <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 transition-colors ${
                    withdrawAddress && !isValidWithdrawAddress
                      ? "border-okx-down/50 bg-okx-down/5"
                      : "border-okx-border-primary bg-okx-bg-primary hover:border-okx-border-hover"
                  }`}>
                    <input
                      type="text"
                      value={withdrawAddress}
                      onChange={(e) => setWithdrawAddress(e.target.value)}
                      placeholder="0x..."
                      disabled={isProcessing}
                      className="flex-1 bg-transparent text-sm font-mono text-okx-text-primary placeholder-okx-text-tertiary outline-none disabled:opacity-50"
                    />
                    {/* Paste button */}
                    <button
                      onClick={async () => {
                        try {
                          const text = await navigator.clipboard.readText();
                          if (text) setWithdrawAddress(text.trim());
                        } catch { /* clipboard access denied */ }
                      }}
                      className="text-xs text-meme-lime hover:opacity-80 font-medium flex-shrink-0"
                    >
                      {t("paste")}
                    </button>
                    {/* Use my wallet */}
                    {mainWallet && withdrawAddress.toLowerCase() !== mainWallet.toLowerCase() && (
                      <button
                        onClick={() => setWithdrawAddress(mainWallet)}
                        className="text-xs text-okx-text-tertiary hover:text-okx-text-secondary font-medium flex-shrink-0 border-l border-okx-border-primary pl-2"
                      >
                        {t("useMyWallet")}
                      </button>
                    )}
                  </div>
                  {/* Address validation hint */}
                  {withdrawAddress && !isValidWithdrawAddress && (
                    <p className="text-xs text-okx-down">{t("invalidAddress")}</p>
                  )}
                  {isValidWithdrawAddress && isWithdrawToSelf && (
                    <p className="text-xs text-okx-text-tertiary">↳ {t("withdrawToSelf")}</p>
                  )}
                  {isValidWithdrawAddress && !isWithdrawToSelf && (
                    <p className="text-xs text-[#F0B90B]">⚠ {t("withdrawToExternal")}</p>
                  )}
                </div>
              )}

              {/* ─── Network ─── */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-okx-text-secondary">{t("network")}</label>
                <div className="flex items-center gap-3 px-4 py-3 bg-okx-bg-primary rounded-xl border border-okx-border-primary">
                  <BnbIcon size={24} className="flex-shrink-0" />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-okx-text-primary">BSC Testnet</div>
                    <div className="text-[11px] text-okx-text-tertiary">BNB Smart Chain Testnet (Chain 97)</div>
                  </div>
                </div>
              </div>

              {/* ─── Select Asset ─── */}
              <div className="space-y-2 relative" ref={dropdownRef}>
                <label className="text-xs font-medium text-okx-text-secondary">{t("selectAsset")}</label>
                <div
                  onClick={() => setShowAssetDropdown(!showAssetDropdown)}
                  className="flex items-center gap-3 px-4 py-3 bg-okx-bg-primary rounded-xl border border-okx-border-primary cursor-pointer hover:border-okx-border-hover transition-colors"
                >
                  <BnbIcon size={24} className="flex-shrink-0" />
                  <div className="flex-1">
                    <div className="text-sm font-medium">BNB (WBNB)</div>
                  </div>
                  <svg className={`w-4 h-4 text-okx-text-tertiary transition-transform ${showAssetDropdown ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </div>

                {/* Dropdown Panel */}
                {showAssetDropdown && (
                  <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-okx-bg-secondary border border-okx-border-primary rounded-xl shadow-xl overflow-hidden">
                    <div className="p-3 border-b border-okx-border-primary">
                      <div className="flex items-center gap-2 bg-okx-bg-primary rounded-lg px-3 py-2">
                        <svg className="w-4 h-4 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
                        <input type="text" placeholder={t("searchAsset")} value={assetSearch} onChange={(e) => setAssetSearch(e.target.value)} className="flex-1 bg-transparent text-sm text-okx-text-primary placeholder-okx-text-tertiary outline-none" autoFocus />
                      </div>
                    </div>
                    <div className="max-h-[240px] overflow-y-auto">
                      {(!assetSearch || "bnb wbnb".includes(assetSearch.toLowerCase())) && (
                        <div onClick={() => { setShowAssetDropdown(false); setAssetSearch(""); }} className="flex items-center gap-3 px-4 py-3 hover:bg-okx-bg-hover cursor-pointer transition-colors">
                          <BnbIcon size={28} className="flex-shrink-0" />
                          <div className="flex-1">
                            <div className="text-sm font-medium text-okx-text-primary">BNB (WBNB)</div>
                            <div className="text-[11px] text-okx-text-tertiary">BSC Testnet</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-mono font-medium text-okx-text-primary">{mainWalletBalance ? parseFloat(mainWalletBalance.formatted).toFixed(4) : "0.0000"}</div>
                            <div className="text-[11px] text-okx-text-tertiary">BNB</div>
                          </div>
                        </div>
                      )}
                      {assetSearch && !"bnb wbnb".includes(assetSearch.toLowerCase()) && (
                        <div className="px-4 py-6 text-center text-sm text-okx-text-tertiary">{t("noAssetsFound")}</div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ─── Amount ─── */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <label className="font-medium text-okx-text-secondary">
                    {activeTab === "deposit" ? t("depositAmount") : t("withdrawAmount")}
                  </label>
                  <span className="text-okx-text-tertiary">
                    {activeTab === "deposit"
                      ? `${t("balance")}: ${mainWalletBalance ? parseFloat(mainWalletBalance.formatted).toFixed(4) : "0.0000"} BNB`
                      : `${t("balance")}: ${fmtETH(totalWithdrawable)} BNB`
                    }
                  </span>
                </div>
                <div className="flex items-center gap-2 px-4 py-3 bg-okx-bg-primary rounded-xl border border-okx-border-primary focus-within:border-okx-border-hover transition-colors">
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={isProcessing}
                    className="flex-1 bg-transparent text-lg font-mono text-okx-text-primary placeholder-okx-text-tertiary outline-none disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <span className="text-sm text-okx-text-secondary font-medium">BNB</span>
                  <div className="h-4 w-px bg-okx-border-primary" />
                  <button
                    onClick={() => {
                      if (activeTab === "deposit") {
                        if (mainWalletBalance) {
                          const GAS_RESERVE = 5000000000000000n; // 0.005 BNB
                          const maxDeposit = mainWalletBalance.value > GAS_RESERVE
                            ? mainWalletBalance.value - GAS_RESERVE : 0n;
                          setAmount(formatEther(maxDeposit));
                        }
                      } else {
                        if (totalWithdrawable > 0n) {
                          setAmount(formatEther(totalWithdrawable));
                        }
                      }
                    }}
                    disabled={isProcessing}
                    className="text-meme-lime text-sm font-semibold hover:opacity-80 disabled:opacity-50 flex-shrink-0"
                  >
                    MAX
                  </button>
                </div>
              </div>

              {/* Quick Amount Buttons */}
              <div className="flex gap-2">
                {["0.01", "0.05", "0.1", "0.5"].map((v) => (
                  <button
                    key={v}
                    onClick={() => setAmount(v)}
                    disabled={isProcessing}
                    className="flex-1 py-2 bg-okx-bg-hover text-okx-text-secondary text-xs font-medium rounded-lg border border-okx-border-secondary hover:text-okx-text-primary hover:border-okx-border-hover hover:bg-okx-bg-active disabled:opacity-50 transition-colors"
                  >
                    {v} BNB
                  </button>
                ))}
              </div>

              {/* ─── Withdraw Fee Info ─── */}
              {activeTab === "withdraw" && (
                <div className="bg-okx-bg-primary rounded-xl px-4 py-3 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-okx-text-tertiary">{t("networkFee")}</span>
                    <span className="text-okx-text-secondary font-mono">~0.001 BNB</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-okx-text-tertiary">{t("estimatedArrival")}</span>
                    <span className="text-okx-text-secondary">~15 {t("seconds")}</span>
                  </div>
                </div>
              )}

              {/* Deposit Progress Steps */}
              {depositStep > 0 && (
                <div className="space-y-3">
                  {[1, 2].map((stepNum) => {
                    const isActive = depositStep === stepNum;
                    const isDone = depositStep > stepNum;
                    const stepInfo = depositStepLabels[stepNum];
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
                            {stepInfo?.label}
                          </div>
                          <div className="text-xs text-okx-text-tertiary">{stepInfo?.desc}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Withdraw Progress */}
              {withdrawStep > 0 && (
                <div className="space-y-3">
                  {/* Step 1: Gas funding (only shown if needed) */}
                  {withdrawStep >= 1 && wethBalance > 0n && nativeEthBalance < parseEther("0.001") && (
                    <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                      withdrawStep > 1
                        ? "border-okx-up/30 bg-okx-up/5"
                        : "border-meme-lime/30 bg-meme-lime/5"
                    }`}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                        withdrawStep > 1
                          ? "bg-okx-up text-black"
                          : "bg-meme-lime text-black animate-pulse"
                      }`}>
                        {withdrawStep > 1 ? "✓" : "1"}
                      </div>
                      <div>
                        <div className={`text-sm font-medium ${withdrawStep > 1 ? "text-okx-up" : ""}`}>
                          {t("withdrawGasFunding")}
                        </div>
                        <div className="text-xs text-okx-text-tertiary">{t("withdrawGasFundingDesc")}</div>
                      </div>
                    </div>
                  )}
                  {/* Step 2: Wallet transfer */}
                  {withdrawStep >= 2 && walletOnlyBalance > 0n && (
                    <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                      withdrawStep > 2
                        ? "border-okx-up/30 bg-okx-up/5"
                        : "border-meme-lime/30 bg-meme-lime/5"
                    }`}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                        withdrawStep > 2
                          ? "bg-okx-up text-black"
                          : "bg-meme-lime text-black animate-pulse"
                      }`}>
                        {withdrawStep > 2 ? "✓" : "2"}
                      </div>
                      <div>
                        <div className={`text-sm font-medium ${withdrawStep > 2 ? "text-okx-up" : ""}`}>
                          {t("withdrawWalletTransfer")}
                        </div>
                        <div className="text-xs text-okx-text-tertiary">{t("withdrawWalletTransferDesc")}</div>
                      </div>
                    </div>
                  )}
                  {/* Step 3: Fast withdrawal from TradingVault */}
                  {withdrawStep >= 3 && (
                    <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                      withdrawStep > 3
                        ? "border-okx-up/30 bg-okx-up/5"
                        : "border-meme-lime/30 bg-meme-lime/5"
                    }`}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                        withdrawStep > 3
                          ? "bg-okx-up text-black"
                          : "bg-meme-lime text-black animate-pulse"
                      }`}>
                        {withdrawStep > 3 ? "✓" : "3"}
                      </div>
                      <div>
                        <div className={`text-sm font-medium ${withdrawStep > 3 ? "text-okx-up" : ""}`}>
                          {t("withdrawProcessing")}
                        </div>
                        <div className="text-xs text-okx-text-tertiary">{t("withdrawProcessingDesc")}</div>
                      </div>
                    </div>
                  )}
                  {/* Step 4: Transfer to main wallet after fast withdrawal */}
                  {withdrawStep >= 4 && (
                    <div className="flex items-center gap-3 p-3 rounded-lg border border-meme-lime/30 bg-meme-lime/5">
                      <div className="w-7 h-7 rounded-full bg-meme-lime text-black flex items-center justify-center text-xs font-bold animate-pulse">
                        4
                      </div>
                      <div>
                        <div className="text-sm font-medium">{t("withdrawWalletTransfer")}</div>
                        <div className="text-xs text-okx-text-tertiary">WBNB → BNB → {t("mainWallet")}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Error Message */}
              {stepError && (
                <div className="text-sm text-red-400 bg-red-900/20 rounded-lg px-4 py-3 border border-red-800/30">
                  {stepError}
                </div>
              )}

              {/* Success Message */}
              {successMsg && (
                <div className="text-sm text-okx-up bg-okx-up/10 rounded-lg px-4 py-3 border border-okx-up/30">
                  <div>{successMsg}</div>
                  {successTxHash && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="text-okx-text-tertiary font-mono text-xs">
                        Tx: {successTxHash.slice(0, 10)}...{successTxHash.slice(-8)}
                      </span>
                      <a
                        href={getExplorerUrl(successTxHash, "tx")}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-okx-up/80 transition-colors text-xs"
                      >
                        {t("viewOnExplorer")} ↗
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Submit Button */}
              {activeTab === "deposit" ? (
                <button
                  onClick={handleDeposit}
                  disabled={isProcessing || !isConnected || amountWei === 0n || !tradingWalletSignature}
                  className={`w-full py-3.5 rounded-xl text-sm font-bold transition-all ${
                    isProcessing || !isConnected || amountWei === 0n || !tradingWalletSignature
                      ? "bg-okx-bg-active text-okx-text-tertiary cursor-not-allowed border border-okx-border-secondary"
                      : "bg-meme-lime text-black hover:opacity-90"
                  }`}
                >
                  {!isConnected
                    ? t("connectWalletFirst")
                    : !tradingWalletSignature
                    ? t("activateWalletFirst")
                    : depositStep > 0
                    ? t("processingStep", { step: depositStep })
                    : t("deposit")
                  }
                </button>
              ) : (
                <button
                  onClick={handleWithdraw}
                  disabled={isProcessing || !tradingWallet || !mainWallet || amountWei === 0n || !tradingWalletSignature || !isValidWithdrawAddress}
                  className={`w-full py-3.5 rounded-xl text-sm font-bold transition-all ${
                    isProcessing || !tradingWallet || !mainWallet || amountWei === 0n || !tradingWalletSignature || !isValidWithdrawAddress
                      ? "bg-okx-bg-active text-okx-text-tertiary cursor-not-allowed border border-okx-border-secondary"
                      : "bg-okx-text-primary text-okx-bg-primary hover:opacity-90"
                  }`}
                >
                  {!isConnected
                    ? t("connectWalletFirst")
                    : !tradingWalletSignature
                    ? t("activateWalletFirst")
                    : !isValidWithdrawAddress && withdrawAddress.length > 0
                    ? t("invalidAddress")
                    : withdrawStep > 0
                    ? t("withdrawProcessing")
                    : t("withdraw")
                  }
                </button>
              )}

              {/* Info Hints */}
              {activeTab === "deposit" && !isProcessing && (
                <div className="text-[11px] text-okx-text-tertiary text-center leading-relaxed">
                  {t("depositHint")}
                </div>
              )}
              {activeTab === "withdraw" && !isProcessing && (
                <div className="text-[11px] text-okx-text-tertiary text-center leading-relaxed">
                  {t("withdrawHint")}
                </div>
              )}
            </div>
          </div>

          {/* Right: Real Balance Summary */}
          <div className="flex-1 min-w-0 space-y-5">
            {/* Account Balance Summary */}
            <div className="bg-okx-bg-secondary rounded-2xl p-6 space-y-5">
              <h3 className="text-sm font-semibold text-okx-text-primary">{t("balanceOverview")}</h3>

              {/* Total Balance — uses matching engine equity (not just on-chain) */}
              <div className="text-center py-4 border-b border-okx-border-primary">
                <div className="text-3xl font-bold font-mono text-okx-text-primary">
                  {formattedTotalAssets} <span className="text-base text-okx-text-secondary font-medium">BNB</span>
                </div>
                <div className="text-xs text-okx-text-tertiary mt-1">
                  {t("totalAssets")}
                </div>
              </div>

              <div className="space-y-3">
                {/* Settlement Balance (on-chain) */}
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("settlementBalance")}</span>
                  <span className="font-mono font-medium">{fmtETH(settlementBalance)} BNB</span>
                </div>

                {/* Available Balance */}
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("availableBalance")}</span>
                  <span className="font-mono font-medium">{fmtBalance(availableBalance)} BNB</span>
                </div>

                {/* Used Margin */}
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("usedMargin")}</span>
                  <span className="font-mono font-medium text-meme-lime">{fmtBalance(lockedMargin)} BNB</span>
                </div>

                {/* Unrealized PnL */}
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("unrealizedPnl")}</span>
                  <span className={`font-mono font-medium ${Number(unrealizedPnL) >= 0 ? "text-okx-up" : "text-okx-down"}`}>
                    {Number(unrealizedPnL) >= 0 ? "+" : ""}{fmtBalance(unrealizedPnL)} BNB
                  </span>
                </div>

                <div className="h-px bg-okx-border-primary" />

                {/* Main Wallet Balance */}
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("mainWalletBalance")}</span>
                  <span className="font-mono font-medium">
                    {mainWalletBalance ? parseFloat(mainWalletBalance.formatted).toFixed(4) : "0.0000"} BNB
                  </span>
                </div>

                {/* Trading Wallet Balance */}
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-secondary">{t("tradingWalletBalance")}</span>
                  <span className="font-mono font-medium">{fmtETH(walletOnlyBalance)} BNB</span>
                </div>
              </div>
            </div>

            {/* Open Positions Summary */}
            {positions && positions.length > 0 && (
              <div className="bg-okx-bg-secondary rounded-2xl p-6 space-y-4">
                <h4 className="text-sm font-semibold text-okx-text-primary">{t("openPositions")}</h4>
                <div className="space-y-2">
                  {positions.slice(0, 5).map((pos, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-3 bg-okx-bg-hover rounded-lg text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${pos.isLong ? "bg-okx-up/20 text-okx-up" : "bg-okx-down/20 text-okx-down"}`}>
                          {pos.isLong ? "LONG" : "SHORT"}
                        </span>
                        <span className="font-medium">{pos.token?.slice(0, 6)}...</span>
                      </div>
                      <div className="text-right font-mono">
                        <div>{fmtBalance(pos.size)} BNB</div>
                        <div className="text-xs text-okx-text-tertiary">{Number(pos.leverage) / 1e4}x</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trading Wallet Info */}
            {tradingWallet && (
              <div className="bg-okx-bg-secondary rounded-2xl p-6 space-y-3">
                <h4 className="text-sm font-semibold text-okx-text-primary">{t("tradingWallet")}</h4>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono bg-okx-bg-hover px-3 py-2 rounded-lg text-okx-text-secondary break-all">
                    {tradingWallet}
                  </code>
                </div>
                <div className="text-xs text-okx-text-tertiary">
                  {t("tradingWalletDesc")}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
