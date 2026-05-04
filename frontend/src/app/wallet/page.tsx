"use client";

/**
 * 钱包管理页面 (BNB 本位)
 *
 * BNB 本位永续合约:
 * - 所有余额以 ETH 计价 (1e18 精度)
 * - 充值: 发送 ETH 到派生钱包
 * - 提现: Settlement → 派生钱包 → 主钱包
 */

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useReadContract, useBalance } from "wagmi";
import { formatUnits, type Address } from "viem";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { useToast } from "@/components/shared/Toast";
import { CONTRACTS, SETTLEMENT_V2_ABI, ERC20_ABI } from "@/lib/contracts";

// BNB 本位: 使用 WBNB (BSC Mainnet)
const WETH_ADDRESS = (process.env.NEXT_PUBLIC_WETH_ADDRESS || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c") as Address;

export default function WalletPage() {
  const t = useTranslations("walletManagement");
  const { address, isConnected } = useAccount();
  const { address: tradingWalletAddr, getSignature } = useTradingWallet();
  const tradingWalletSignature = getSignature();

  const {
    walletBalance,
    balance,
    deposit,
    withdraw,
    isDepositing,
    isWithdrawing,
    error,
  } = usePerpetualV2({
    tradingWalletAddress: tradingWalletAddr || undefined,
    tradingWalletSignature: tradingWalletSignature || undefined,
    mainWalletAddress: address,
  });

  const { showToast } = useToast();

  // ── On-chain balance reads (fallback when backend is down) ──
  const { data: onChainWeth, refetch: refetchWeth } = useReadContract({
    address: WETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: tradingWalletAddr ? [tradingWalletAddr] : undefined,
    query: { enabled: !!tradingWalletAddr },
  });
  const { data: onChainSettlement, refetch: refetchSettlement } = useReadContract({
    address: CONTRACTS.SETTLEMENT_V2,
    abi: SETTLEMENT_V2_ABI,
    functionName: "userDeposits",
    args: tradingWalletAddr ? [tradingWalletAddr] : undefined,
    query: { enabled: !!tradingWalletAddr },
  });
  const { refetch: refetchNative } = useBalance({
    address: tradingWalletAddr ?? undefined,
  });

  // Refresh all on-chain reads after deposit/withdraw
  // Small delay ensures RPC node has indexed the latest block
  const refreshOnChain = useCallback(() => {
    refetchWeth();
    refetchSettlement();
    refetchNative();
    // Second refetch after 2s to catch any RPC propagation delay
    setTimeout(() => {
      refetchWeth();
      refetchSettlement();
      refetchNative();
    }, 2000);
  }, [refetchWeth, refetchSettlement, refetchNative]);

  // Extract balances: prefer backend, fallback to on-chain
  const derivedWalletBalance = balance?.walletBalance || (onChainWeth as bigint) || 0n;
  const settlementAvailable = balance?.settlementAvailable || (onChainSettlement as bigint) || 0n;
  const settlementLocked = balance?.settlementLocked || 0n;
  const availableBalance = balance?.available || settlementAvailable;
  const lockedMargin = balance?.locked || 0n;
  const vaultBalance = availableBalance + lockedMargin;

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit");
  const [actionError, setActionError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Format ETH balance for display (18 decimals)
  const formatBalance = (balance: bigint | null | undefined): string => {
    if (balance === null || balance === undefined) return "0.0000";
    const val = parseFloat(formatUnits(balance, 18));
    if (val >= 1000) return `${(val / 1000).toFixed(2)}K`;
    if (val >= 1) return val.toFixed(4);
    if (val >= 0.001) return val.toFixed(4);
    return val.toFixed(6);
  };

  // Handle deposit (BNB 本位: 存入 ETH/WETH)
  const handleDeposit = async () => {
    if (!depositAmount || parseFloat(depositAmount) <= 0) {
      setActionError(t("errors.invalidAmount"));
      return;
    }
    setActionError(null);
    setTxHash(null);
    try {
      const hash = await deposit(WETH_ADDRESS, depositAmount);
      setTxHash(hash);
      setDepositAmount("");
      refreshOnChain();
      showToast(t("depositSuccess"), "success");
    } catch (err) {
      setActionError((err as Error).message);
      showToast((err as Error).message, "error");
    }
  };

  // Handle withdraw (BNB 本位: Settlement → derived wallet → main wallet)
  const handleWithdraw = async () => {
    if (!withdrawAmount || parseFloat(withdrawAmount) <= 0) {
      setActionError(t("errors.invalidAmount"));
      return;
    }
    const withdrawAmountNum = parseFloat(withdrawAmount);
    const withdrawableNum = parseFloat(formatUnits(derivedWalletBalance + settlementAvailable, 18));
    if (withdrawAmountNum > withdrawableNum) {
      setActionError(t("errors.insufficientBalance"));
      return;
    }
    setActionError(null);
    setTxHash(null);
    try {
      const hash = await withdraw(WETH_ADDRESS, withdrawAmount);
      if (hash) setTxHash(hash);
      setWithdrawAmount("");
      refreshOnChain();
      showToast(t("withdrawSuccess"), "success");
    } catch (err) {
      setActionError((err as Error).message);
      showToast((err as Error).message, "error");
    }
  };

  // Set max deposit amount (derived wallet ETH balance)
  const handleMaxDeposit = () => {
    if (derivedWalletBalance) {
      setDepositAmount(formatUnits(derivedWalletBalance, 18));
    }
  };

  // Set max withdraw amount (wallet + settlement available)
  const handleMaxWithdraw = () => {
    // 可提现 = 派生钱包余额 + Settlement 可用（不含挂单锁定）
    const withdrawable = derivedWalletBalance + settlementAvailable;
    if (withdrawable > 0n) {
      setWithdrawAmount(formatUnits(withdrawable, 18));
    }
  };

  return (
    <div className="min-h-screen bg-okx-bg-primary">
      <div className="max-w-[800px] mx-auto px-4 py-8">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-okx-text-primary mb-2">
            {t("title")}
          </h1>
          <p className="text-okx-text-secondary">
            {t("subtitle")}
          </p>
        </div>

        {!isConnected ? (
          /* Not Connected State */
          <div className="bg-okx-bg-secondary rounded-2xl border border-okx-border-primary p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-okx-bg-hover flex items-center justify-center mx-auto mb-4">
              <WalletIcon className="w-8 h-8 text-okx-text-tertiary" />
            </div>
            <h2 className="text-xl font-bold text-okx-text-primary mb-2">
              {t("notConnected.title")}
            </h2>
            <p className="text-okx-text-secondary mb-4">
              {t("notConnected.description")}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Balance Overview */}
            <div className="grid md:grid-cols-2 gap-4">
              {/* Derived Wallet Balance Card */}
              <div className="bg-okx-bg-secondary rounded-2xl border border-okx-border-primary p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-okx-accent/20 flex items-center justify-center">
                    <EthIcon className="w-5 h-5 text-okx-accent" />
                  </div>
                  <div>
                    <div className="text-okx-text-tertiary text-sm">{t("walletBalance")}</div>
                    <div className="text-xl font-bold text-okx-text-primary">
                      BNB  {formatBalance(derivedWalletBalance)}
                    </div>
                  </div>
                </div>
                <div className="text-okx-text-tertiary text-xs font-mono truncate">
                  {tradingWalletAddr || address}
                </div>
              </div>

              {/* Settlement Balance Card */}
              <div className="bg-okx-bg-secondary rounded-2xl border border-okx-border-primary p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-okx-up/20 flex items-center justify-center">
                    <VaultIcon className="w-5 h-5 text-okx-up" />
                  </div>
                  <div>
                    <div className="text-okx-text-tertiary text-sm">{t("vaultBalance")}</div>
                    <div className="text-xl font-bold text-okx-text-primary">
                      BNB  {formatBalance(vaultBalance)}
                    </div>
                  </div>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-okx-text-tertiary">{t("available")}:</span>
                  <span className="text-okx-up">BNB  {formatBalance(availableBalance)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-okx-text-tertiary">Settlement:</span>
                  <span className="text-okx-accent">BNB  {formatBalance(settlementAvailable)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-okx-text-tertiary">{t("locked")}:</span>
                  <span className="text-meme-lime">BNB  {formatBalance(settlementLocked)}</span>
                </div>
              </div>
            </div>

            {/* Deposit/Withdraw Panel */}
            <div className="bg-okx-bg-secondary rounded-2xl border border-okx-border-primary overflow-hidden">
              {/* Tabs */}
              <div className="flex border-b border-okx-border-primary">
                <button
                  onClick={() => {
                    setActiveTab("deposit");
                    setActionError(null);
                  }}
                  className={`flex-1 py-4 text-center font-medium transition-colors ${
                    activeTab === "deposit"
                      ? "text-okx-up border-b-2 border-okx-up"
                      : "text-okx-text-tertiary hover:text-okx-text-secondary"
                  }`}
                >
                  {t("deposit")}
                </button>
                <button
                  onClick={() => {
                    setActiveTab("withdraw");
                    setActionError(null);
                  }}
                  className={`flex-1 py-4 text-center font-medium transition-colors ${
                    activeTab === "withdraw"
                      ? "text-okx-down border-b-2 border-okx-down"
                      : "text-okx-text-tertiary hover:text-okx-text-secondary"
                  }`}
                >
                  {t("withdraw")}
                </button>
              </div>

              {/* Tab Content */}
              <div className="p-6">
                {activeTab === "deposit" ? (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-okx-text-secondary text-sm mb-2">
                        {t("depositAmount")}
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          value={depositAmount}
                          onChange={(e) => setDepositAmount(e.target.value)}
                          placeholder="0.0"
                          className="w-full bg-okx-bg-primary border border-okx-border-primary rounded-xl px-4 py-3 text-okx-text-primary focus:outline-none focus:border-okx-up transition-colors"
                        />
                        <button
                          onClick={handleMaxDeposit}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-okx-up text-sm font-medium hover:opacity-80"
                        >
                          {t("max")}
                        </button>
                      </div>
                      <div className="text-okx-text-tertiary text-sm mt-2">
                        {t("walletBalance")}: BNB  {formatBalance(derivedWalletBalance)}
                      </div>
                    </div>

                    <button
                      onClick={handleDeposit}
                      disabled={isDepositing || !depositAmount}
                      className="w-full bg-okx-up text-black py-3 rounded-xl font-bold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isDepositing ? (
                        <span className="flex items-center justify-center gap-2">
                          <LoadingSpinner />
                          {t("processing")}
                        </span>
                      ) : (
                        t("depositButton")
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-okx-text-secondary text-sm mb-2">
                        {t("withdrawAmount")}
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          value={withdrawAmount}
                          onChange={(e) => setWithdrawAmount(e.target.value)}
                          placeholder="0.0"
                          className="w-full bg-okx-bg-primary border border-okx-border-primary rounded-xl px-4 py-3 text-okx-text-primary focus:outline-none focus:border-okx-down transition-colors"
                        />
                        <button
                          onClick={handleMaxWithdraw}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-okx-down text-sm font-medium hover:opacity-80"
                        >
                          {t("max")}
                        </button>
                      </div>
                      <div className="text-okx-text-tertiary text-sm mt-2">
                        {t("available")}: BNB  {formatBalance(availableBalance)}
                      </div>
                    </div>

                    <button
                      onClick={handleWithdraw}
                      disabled={isWithdrawing || !withdrawAmount}
                      className="w-full bg-okx-down text-white py-3 rounded-xl font-bold hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isWithdrawing ? (
                        <span className="flex items-center justify-center gap-2">
                          <LoadingSpinner />
                          {t("processing")}
                        </span>
                      ) : (
                        t("withdrawButton")
                      )}
                    </button>
                  </div>
                )}

                {/* Error Message */}
                {(actionError || error) && (
                  <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                    <p className="text-red-500 text-sm">
                      {actionError || (typeof error === 'string' ? error : (error as unknown as Error)?.message)}
                    </p>
                  </div>
                )}

                {/* Transaction Hash */}
                {txHash && (
                  <div className="mt-4 p-3 bg-okx-up/10 border border-okx-up/30 rounded-xl">
                    <p className="text-okx-text-secondary text-sm mb-1">{t("transactionSent")}</p>
                    <a
                      href={`https://testnet.bscscan.com/tx/${txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-okx-up text-sm font-mono hover:underline break-all"
                    >
                      {txHash}
                    </a>
                  </div>
                )}
              </div>
            </div>

            {/* Info Section */}
            <div className="bg-okx-bg-secondary rounded-2xl border border-okx-border-primary p-6">
              <h3 className="text-lg font-bold text-okx-text-primary mb-4">
                {t("info.title")}
              </h3>
              <div className="space-y-3">
                <InfoItem
                  icon={<DepositIcon className="w-4 h-4" />}
                  title={t("info.deposit.title")}
                  description={t("info.deposit.description")}
                />
                <InfoItem
                  icon={<WithdrawIcon className="w-4 h-4" />}
                  title={t("info.withdraw.title")}
                  description={t("info.withdraw.description")}
                />
                <InfoItem
                  icon={<LockIcon className="w-4 h-4" />}
                  title={t("info.locked.title")}
                  description={t("info.locked.description")}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Components

function InfoItem({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-okx-text-tertiary flex-shrink-0">
        {icon}
      </div>
      <div>
        <div className="text-okx-text-primary font-medium">{title}</div>
        <div className="text-okx-text-tertiary text-sm">{description}</div>
      </div>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
        fill="none"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

// Icons

function WalletIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z" />
    </svg>
  );
}

function EthIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1.5L4.5 12L12 16.5L19.5 12L12 1.5Z" opacity="0.6" />
      <path d="M12 16.5L4.5 12L12 22.5L19.5 12L12 16.5Z" opacity="0.9" />
    </svg>
  );
}

function VaultIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
}

function DepositIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v12" />
      <path d="M17 10l-5 5-5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function WithdrawIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
