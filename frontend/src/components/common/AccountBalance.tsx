"use client";

/**
 * AccountBalance - 账户余额管理组件 (BNB 本位)
 *
 * 资金流向 (链上真实托管):
 * 1. 充值: 主钱包 → 派生钱包 (BNB) → WETH.deposit() → SettlementV2.deposit()
 * 2. 提款: SettlementV2.withdraw(Merkle proof) → 解包 WETH → 转回主钱包
 * 3. 引擎自动监听 SettlementV2 事件，实时更新余额
 */

import { useState, useCallback, useMemo, useRef } from "react";
import { formatEther, parseEther, type Address } from "viem";
import {
  useAccount,
  useBalance,
  useSendTransaction,
  usePublicClient,
} from "wagmi";
import { useWalletBalance } from "@/contexts/WalletBalanceContext";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { CONTRACTS } from "@/lib/contracts";

/** Deposit step labels for 3-step on-chain flow */
const DEPOSIT_STEPS: Record<number, string> = {
  1: "Step 1/3: 转账 BNB 到交易钱包...",
  2: "Step 2/3: 包装 WBNB...",
  3: "Step 3/3: 存入合约...",
};

/** Withdraw step labels */
const WITHDRAW_STEPS: Record<number, string> = {
  1: "提款中: 生成证明并提交链上...",
};

export function AccountBalance({ onClose }: { onClose?: () => void }) {
  const { address: mainWallet, isConnected } = useAccount();
  const publicClient = usePublicClient();

  // Trading wallet (signature-derived EOA)
  const {
    address: tradingWallet,
    getSignature,
    wrapAndDeposit,
    sendETH,
    ethBalance: tradingWalletNativeBalance,
    refreshBalance: refreshTradingWalletBalance,
  } = useTradingWallet();

  // SettlementV2 deposit/withdraw via usePerpetualV2
  const tradingWalletSignature = getSignature();
  const {
    deposit: settlementDeposit,
    withdraw: settlementWithdraw,
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
    formattedWethBalance,
    refreshBalance: refreshGlobalBalance,
  } = useWalletBalance();

  const [amount, setAmount] = useState("");
  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit");
  const [copied, setCopied] = useState(false);

  // Multi-step progress tracking
  const [depositStep, setDepositStep] = useState(0); // 0=idle, 1-3=in-progress
  const [withdrawStep, setWithdrawStep] = useState(0); // 0=idle, 1=in-progress
  const [stepError, setStepError] = useState<string | null>(null);
  const depositStepRef = useRef(0); // For accurate logging in async closures
  // Total withdrawable = settlement + trading wallet native BNB
  const totalWithdrawable = (settlementBalance ?? 0n) + tradingWalletNativeBalance;

  // Main wallet BNB balance
  const { data: mainWalletBalance, refetch: refetchMainBalance } = useBalance({
    address: mainWallet,
  });

  // Send BNB to trading wallet (wagmi)
  const { sendTransactionAsync, isPending: isSendPending } =
    useSendTransaction();

  const amountWei = useMemo(() => {
    try {
      return parseEther(amount || "0");
    } catch {
      return 0n;
    }
  }, [amount]);

  // ═══════════════════════════════════════════════════════════
  // 3-step on-chain deposit:
  //   1. Main wallet → Trading wallet (native BNB)
  //   2. Trading wallet: BNB → WBNB (WBNB.deposit)
  //   3. Trading wallet: approve WBNB + SettlementV2.deposit
  // ═══════════════════════════════════════════════════════════
  const GAS_BUFFER = parseEther("0.005"); // 0.005 BNB for Step 2 & 3 gas

  const handleDeposit = useCallback(async () => {
    if (!tradingWallet || amountWei === 0n || !publicClient) return;
    setStepError(null);

    try {
      // Actual deposit = user amount - gas buffer (for Step 2 & 3)
      const depositAmount = amountWei - GAS_BUFFER;
      if (depositAmount <= 0n) return;
      const depositAmountStr = formatEther(depositAmount);

      // Step 1: Transfer full amount to trading wallet (includes gas reserve)
      setDepositStep(1);
      depositStepRef.current = 1;
      const txHash = await sendTransactionAsync({
        to: tradingWallet,
        value: amountWei,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Step 2: Wrap (amount - gas) BNB → WBNB, keep gas for Step 3
      setDepositStep(2);
      depositStepRef.current = 2;
      const wrapHash = await wrapAndDeposit(depositAmountStr);
      await publicClient.waitForTransactionReceipt({ hash: wrapHash });

      // Step 3: Approve WBNB + deposit to SettlementV2
      setDepositStep(3);
      depositStepRef.current = 3;
      await settlementDeposit(CONTRACTS.WETH, depositAmountStr);

      // Success — engine event listener auto-syncs balance
      setDepositStep(0);
      depositStepRef.current = 0;
      setAmount("");
      refreshGlobalBalance();
      refetchMainBalance();
    } catch (e) {
      const failedStep = depositStepRef.current;
      console.error(`[Deposit] Failed at step ${failedStep}:`, e);
      setStepError(
        `Step ${failedStep} 失败: ${e instanceof Error ? e.message : "未知错误"}`
      );
      setDepositStep(0);
      depositStepRef.current = 0;
    }
  }, [
    tradingWallet,
    amountWei,
    amount,
    publicClient,
    sendTransactionAsync,
    wrapAndDeposit,
    settlementDeposit,
    refreshGlobalBalance,
    refetchMainBalance,
  ]);

  // ═══════════════════════════════════════════════════════════
  // Withdraw: supports both sources
  //   A. SettlementV2 contract → Merkle proof withdrawal
  //   B. Trading wallet native BNB → direct sendETH to main wallet
  // ═══════════════════════════════════════════════════════════
  const handleWithdraw = useCallback(async () => {
    if (!tradingWallet || !mainWallet || amountWei === 0n) return;
    setStepError(null);

    try {
      setWithdrawStep(1);
      const sBalance = settlementBalance ?? 0n;

      if (sBalance > 0n && amountWei <= sBalance) {
        // Case A: settlement contract has enough → Merkle proof withdrawal
        await settlementWithdraw(CONTRACTS.WETH, amount);
      } else {
        // Case B: use trading wallet native BNB → direct transfer
        const gasReserve = parseEther("0.001");
        const maxSend = tradingWalletNativeBalance > gasReserve
          ? tradingWalletNativeBalance - gasReserve : 0n;
        if (amountWei > maxSend) {
          setStepError("余额不足");
          setWithdrawStep(0);
          return;
        }
        await sendETH(mainWallet, amount);
      }

      setWithdrawStep(0);
      setAmount("");
      refreshGlobalBalance();
      refetchMainBalance();
      refreshTradingWalletBalance();
    } catch (e) {
      console.error("[Withdraw] Failed:", e);
      setStepError(
        `提款失败: ${e instanceof Error ? e.message : "未知错误"}`
      );
      setWithdrawStep(0);
    }
  }, [
    tradingWallet, mainWallet, amountWei, amount, settlementBalance,
    tradingWalletNativeBalance, settlementWithdraw, sendETH,
    refreshGlobalBalance, refetchMainBalance, refreshTradingWalletBalance,
  ]);

  const copy = () => {
    if (tradingWallet) {
      navigator.clipboard.writeText(tradingWallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Format BNB balance
  const fmtETH = (val: bigint | undefined) => {
    if (!val) return "0.0000";
    const num = Number(formatEther(val));
    if (num >= 1) return num.toFixed(4);
    if (num >= 0.0001) return num.toFixed(6);
    return num.toFixed(8);
  };

  const isProcessing = depositStep > 0 || withdrawStep > 0;

  // Current step label for button text
  const depositButtonText = depositStep > 0
    ? DEPOSIT_STEPS[depositStep] ?? "处理中..."
    : "充值 BNB 到交易账户";
  const withdrawButtonText = withdrawStep > 0
    ? WITHDRAW_STEPS[withdrawStep] ?? "处理中..."
    : "提现到主钱包";

  return (
    <div className="bg-okx-bg-card rounded-xl border border-gray-800">
      {/* 标题 */}
      <div className="flex justify-between items-center p-4 border-b border-gray-800">
        <span className="text-okx-text-primary font-semibold">账户</span>
        {onClose && (
          <button onClick={onClose} className="text-gray-500 hover:text-okx-text-primary">
            &times;
          </button>
        )}
      </div>

      {/* 交易账户余额 */}
      <div className="p-4 text-center border-b border-gray-800">
        <div className="text-3xl font-bold text-okx-text-primary">
          BNB {formattedWethBalance}
        </div>
        <div className="text-gray-500 text-sm mb-2">交易账户总余额</div>
        {/* 余额明细 */}
        <div className="flex justify-center gap-4 text-xs">
          <div>
            <span className="text-gray-500">合约托管: </span>
            <span className="text-gray-300">BNB {fmtETH(settlementBalance)}</span>
          </div>
          <div>
            <span className="text-gray-500">钱包: </span>
            <span className="text-gray-300">BNB {fmtETH(walletOnlyBalance)}</span>
          </div>
        </div>
      </div>

      {/* 交易账户地址 */}
      <div className="p-4 border-b border-gray-800">
        <div className="text-gray-500 text-xs mb-2">交易账户</div>
        <div className="flex gap-2">
          <input
            value={tradingWallet || ""}
            readOnly
            className="flex-1 bg-okx-bg-secondary text-gray-300 text-xs px-3 py-2 rounded font-mono"
          />
          <button
            onClick={copy}
            className="px-3 py-2 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>

      {/* 充值/提现 */}
      <div className="p-4 space-y-4">
        {/* Tab 切换 */}
        <div className="flex gap-2 bg-okx-bg-secondary rounded-lg p-1">
          <button
            onClick={() => {
              setActiveTab("deposit");
              setAmount("");
              setStepError(null);
            }}
            className={`flex-1 py-2 rounded text-sm font-medium transition-colors ${
              activeTab === "deposit"
                ? "bg-blue-600 text-white"
                : "text-gray-400 hover:text-okx-text-primary"
            }`}
          >
            充值
          </button>
          <button
            onClick={() => {
              setActiveTab("withdraw");
              setAmount("");
              setStepError(null);
            }}
            className={`flex-1 py-2 rounded text-sm font-medium transition-colors ${
              activeTab === "withdraw"
                ? "bg-blue-600 text-white"
                : "text-gray-400 hover:text-okx-text-primary"
            }`}
          >
            提现
          </button>
        </div>

        {/* 余额显示 */}
        <div className="flex justify-between items-center text-sm">
          <span className="text-gray-500">
            {activeTab === "deposit" ? "钱包余额" : "可提现余额"}
          </span>
          <span className="text-okx-text-primary">
            BNB {activeTab === "deposit"
              ? fmtETH(mainWalletBalance?.value)
              : fmtETH(totalWithdrawable)}
          </span>
        </div>

        {/* 金额输入 */}
        <div className="relative">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            disabled={isProcessing}
            className="w-full bg-okx-bg-secondary text-okx-text-primary text-lg px-4 py-3 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
            <span className="text-gray-400 text-sm">BNB</span>
            <button
              onClick={() => {
                if (activeTab === "deposit") {
                  // AUDIT-FIX FE-C01: 预留 Gas 费用，避免用户存入全部余额后无法执行交易
                  if (mainWalletBalance) {
                    const GAS_RESERVE = 5000000000000000n; // 0.005 BNB
                    const maxDeposit = mainWalletBalance.value > GAS_RESERVE
                      ? mainWalletBalance.value - GAS_RESERVE
                      : 0n;
                    setAmount(formatEther(maxDeposit));
                  }
                } else {
                  // Withdraw MAX: total withdrawable minus gas reserve
                  const gasReserve = parseEther("0.001");
                  const maxW = totalWithdrawable > gasReserve ? totalWithdrawable - gasReserve : 0n;
                  if (maxW > 0n) setAmount(formatEther(maxW));
                }
              }}
              disabled={isProcessing}
              className="text-blue-500 text-sm disabled:opacity-50"
            >
              MAX
            </button>
          </div>
        </div>

        {/* 快捷金额 (BNB) */}
        <div className="flex gap-2">
          {["0.01", "0.05", "0.1", "0.5"].map((v) => (
            <button
              key={v}
              onClick={() => setAmount(v)}
              disabled={isProcessing}
              className="flex-1 py-2 bg-okx-bg-secondary text-gray-400 text-sm rounded hover:text-okx-text-primary disabled:opacity-50"
            >
              BNB {v}
            </button>
          ))}
        </div>

        {/* 进度条 (deposit only) */}
        {depositStep > 0 && (
          <div className="space-y-2">
            <div className="flex gap-1">
              {[1, 2, 3].map((step) => (
                <div
                  key={step}
                  className={`flex-1 h-1.5 rounded-full transition-colors ${
                    step < depositStep
                      ? "bg-green-500"
                      : step === depositStep
                        ? "bg-blue-500 animate-pulse"
                        : "bg-gray-700"
                  }`}
                />
              ))}
            </div>
            <div className="text-xs text-blue-400 text-center">
              {DEPOSIT_STEPS[depositStep]}
            </div>
          </div>
        )}

        {/* 错误提示 */}
        {stepError && (
          <div className="text-xs text-red-400 bg-red-900/20 rounded-lg px-3 py-2">
            {stepError}
          </div>
        )}

        {/* 操作按钮 */}
        {activeTab === "deposit" ? (
          <button
            onClick={handleDeposit}
            disabled={isProcessing || !isConnected || amountWei === 0n || !tradingWalletSignature}
            className="w-full py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {depositButtonText}
          </button>
        ) : (
          <button
            onClick={handleWithdraw}
            disabled={
              isProcessing || !tradingWallet || !mainWallet || amountWei === 0n || !tradingWalletSignature
            }
            className="w-full py-3 bg-orange-600 text-white font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {withdrawButtonText}
          </button>
        )}

        {/* 充值提示 */}
        {activeTab === "deposit" && !isProcessing && (
          <div className="text-xs text-gray-500 text-center">
            BNB 将通过 SettlementV2 合约链上托管，安全可验证
          </div>
        )}

        {/* 提现提示 */}
        {activeTab === "withdraw" && !isProcessing && (
          <div className="text-xs text-gray-500 text-center">
            提款通过 Merkle 证明验证，资金从合约直接释放
          </div>
        )}

        {/* 未激活交易钱包提示 */}
        {!tradingWalletSignature && isConnected && (
          <div className="text-xs text-yellow-500 text-center">
            请先在交易面板激活交易钱包
          </div>
        )}

      </div>
    </div>
  );
}
