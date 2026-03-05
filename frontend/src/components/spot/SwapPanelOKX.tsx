"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useBalance, useReadContract } from "wagmi";
import { parseUnits, formatUnits, type Address, erc20Abi } from "viem";
import { useExecuteSwap, ETH_DECIMALS } from "@/hooks/spot/useExecuteSwap";
import { useOnChainQuote } from "@/hooks/spot/useOnChainQuote";
// useWalletBalance 已删除 - 余额应通过 WebSocket 从后端推送
import { SecurityStatus } from "@/components/common/SecurityStatusBanner";
import { useToast } from "@/components/shared/Toast";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { CONTRACTS } from "@/lib/contracts";
import { tradeEventEmitter } from "@/lib/tradeEvents";
import { GRADUATION_THRESHOLD, REAL_TOKEN_SUPPLY } from "@/lib/protocol-constants";

// 毕业需要卖出的代币数量 = 总供应量 - 剩余代币阈值 = 1B - 207M = 793M
const SOLD_TOKENS_TARGET = REAL_TOKEN_SUPPLY - GRADUATION_THRESHOLD;
import { useSlippageTolerance, useTransactionDeadline, useAppStore } from "@/lib/stores/appStore";
import { useTradeStore } from "@/lib/stores/tradeStore";
import { logError } from "@/lib/validators";
import { showGlobalError } from "@/components/shared/ErrorModal";
import { parseErrorCode, isUserCancelledError } from "@/lib/errors/errorDictionary";
import { devLog } from "@/lib/debug-logger";
import { useTranslations } from "next-intl";
import { validateBuyTransaction, validateSellTransaction, ValidationState } from "@/lib/validation/preValidation";
import { PreValidationWarning, InlineValidation } from "@/components/shared/PreValidationWarning";

interface SwapPanelOKXProps {
  symbol: string;  // 交易对符号，如 "PEPE"
  displaySymbol?: string; // 人类可读的代币名称 (从链上 ERC20 name/symbol 获取)
  securityStatus: SecurityStatus;
  tokenAddress?: Address;
  soldSupply?: string; // 已售出代币数量
  totalSupply?: string; // 总供应量 (8亿可售)
  isGraduated?: boolean; // 是否已毕业（迁移到 Uniswap）
  isPoolActive?: boolean; // 池子是否活跃
  className?: string;
}

const TOKEN_FACTORY_ADDRESS = CONTRACTS.TOKEN_FACTORY;

export function SwapPanelOKX({ symbol, displaySymbol, securityStatus, tokenAddress, soldSupply, totalSupply, isGraduated = false, isPoolActive = true, className }: SwapPanelOKXProps) {
  // 钱包地址从 RainbowKit 获取
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { showToast } = useToast();
  const t = useTranslations("swap");
  const tc = useTranslations("common");

  // 使用 symbol 作为 instId
  const instId = symbol;

  // 人类可读的代币标签：优先用 displaySymbol，否则截取地址
  const tokenLabel = displaySymbol || (instId.startsWith("0x") ? `${instId.slice(0, 6)}...${instId.slice(-4)}` : instId.toUpperCase());

  // ✅ 从全局 store 获取配置
  const globalSlippageTolerance = useSlippageTolerance();
  const transactionDeadline = useTransactionDeadline();
  const addRecentInstrument = useAppStore((state) => state.addRecentInstrument);
  const addTransaction = useAppStore((state) => state.addTransaction);
  
  // ✅ 从交易 store 获取状态
  const { updateForm, setCurrentQuote, addToQuoteHistory } = useTradeStore();
  
  // 本地 UI 状态
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("");
  const [showSlippageSettings, setShowSlippageSettings] = useState(false);
  const [customSlippage, setCustomSlippage] = useState("");
  
  // 滑点设置：优先使用自定义值，否则使用全局配置
  const slippageBps = useMemo(() => {
    if (customSlippage && !isNaN(parseFloat(customSlippage))) {
      return Math.round(parseFloat(customSlippage) * 100); // 转换为基点
    }
    return Math.round(globalSlippageTolerance * 100); // 使用全局配置
  }, [customSlippage, globalSlippageTolerance]);
  
  // 检查交易是否被禁用
  const isTradingDisabled = isGraduated || !isPoolActive;
  
  // 计算内盘进度 (已售出/毕业目标)
  // 毕业目标 = 793M (需要卖出的代币数量，不是剩余代币阈值207M)
  const targetProgress = useMemo(() => {
    const sold = BigInt(soldSupply || "0");
    if (sold <= 0n) return 0;
    // 进度百分比 = 已售 / 毕业目标(793M) * 100
    const progress = Number((sold * 10000n) / SOLD_TOKENS_TARGET) / 100; // 保留2位小数
    return Math.min(progress, 100);
  }, [soldSupply]);

  // 毕业进度（用于底部进度条显示）
  const graduationProgress = targetProgress;

  // 已售代币数量（单位：百万）
  const soldTokensM = useMemo(() => {
    const sold = BigInt(soldSupply || "0");
    // 转换 wei 到代币数量，再转为百万
    return Number(formatUnits(sold, 18)) / 1_000_000;
  }, [soldSupply]);

  // ✅ 记录访问的交易对
  useEffect(() => {
    if (instId) {
      addRecentInstrument(instId);
    }
  }, [instId, addRecentInstrument]);

  // 使用 state 实现丝滑动画效果
  const [animatedProgress, setAnimatedProgress] = useState(0);

  useEffect(() => {
    // 简单的动画逻辑：逐步接近目标值
    let rafId: number;
    let currentProgress = animatedProgress;

    const animate = () => {
      const diff = targetProgress - currentProgress;
      if (Math.abs(diff) < 0.1) {
        setAnimatedProgress(targetProgress);
        return;
      }
      currentProgress = currentProgress + diff * 0.1;
      setAnimatedProgress(currentProgress);
      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetProgress]); // 只依赖 targetProgress，不依赖 animatedProgress

  const bondingCurveProgress = animatedProgress;

  // 余额从链上查询
  const { data: ethBalanceData, refetch: refetchEthBalance } = useBalance({ address });
  // 临时使用 0 作为占位符
  const ethBalance = ethBalanceData ?? { value: 0n };

  const { data: tokenBalanceData, refetch: refetchTokenBalance } = useBalance({ address, token: tokenAddress });
  const tokenBalance = tokenBalanceData ?? { value: 0n };
  const internalBalance = tokenBalance.value;

  // 根据模式选择正确的余额
  const effectiveBalance = mode === "sell" && internalBalance !== undefined
    ? { value: internalBalance, decimals: 18, symbol: tokenLabel, formatted: formatUnits(internalBalance, 18) }
    : tokenBalance;

  // ✅ 授权检查 - 查询用户对 TokenFactory 合约的授权额度
  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && TOKEN_FACTORY_ADDRESS
      ? [address, TOKEN_FACTORY_ADDRESS]
      : undefined,
    query: {
      enabled: !!address && !!tokenAddress && mode === "sell",
    },
  });
  const allowance = allowanceData as bigint | undefined;

  // 订阅交易事件，交易完成后立即刷新余额
  useEffect(() => {
    if (!tokenAddress || !address) return;

    const unsubscribe = tradeEventEmitter.subscribe((tradedToken, txHash) => {
      if (tradedToken.toLowerCase() === tokenAddress.toLowerCase()) {
        console.log(`[SwapPanelOKX] Trade completed, refreshing balances...`);
        // 延迟一点以确保链上状态已更新
        setTimeout(() => {
          refetchEthBalance();
          refetchTokenBalance();
          refetchAllowance();
        }, 1000);
      }
    });

    return unsubscribe;
  }, [tokenAddress, address, refetchEthBalance, refetchTokenBalance, refetchAllowance]);

  const amountInBigInt = useMemo(() => {
    if (!amount || amount === "") return null;
    try {
      // 买入用 18 位 (ETH)，卖出用 18 位 (Token)
      return parseUnits(amount, 18);
    } catch {
      return null;
    }
  }, [amount]);

  // 是否需要授权
  const isApprovalRequired = useMemo(() => {
    if (mode === "buy") return false;
    if (!amountInBigInt || amountInBigInt === 0n) return false;
    if (allowance === undefined) return false;
    return allowance < amountInBigInt;
  }, [mode, amountInBigInt, allowance]);

  const { writeContractAsync: writeContract, data: approvalTxHash, reset: resetApproval } = useWriteContract();

  const { isLoading: isApprovalConfirming, isSuccess: isApprovalSuccess } = useWaitForTransactionReceipt({
    hash: approvalTxHash,
    query: {
      enabled: !!approvalTxHash,
    },
  });

  // Track processed approvals to prevent duplicate handling
  const processedApprovalRef = React.useRef<string | null>(null);

  // 监听授权成功 - use isSuccess instead of isLoading === false
  useEffect(() => {
    if (isApprovalSuccess && approvalTxHash && processedApprovalRef.current !== approvalTxHash) {
       processedApprovalRef.current = approvalTxHash;
       showToast(t("approvalSuccess"), "success");
       // Refetch allowance after a small delay to ensure chain state is updated
       setTimeout(() => {
         refetchAllowance();
       }, 500);
    }
  }, [isApprovalSuccess, approvalTxHash, refetchAllowance, showToast, t]);

  // Reset processed approval when starting a new approval
  useEffect(() => {
    if (!approvalTxHash) {
      processedApprovalRef.current = null;
    }
  }, [approvalTxHash]);

  const handleApprove = async () => {
    if (!tokenAddress || !TOKEN_FACTORY_ADDRESS) return;
    try {
      // 无限授权，用户只需授权一次
      const MAX_UINT256 = 2n ** 256n - 1n;
      await writeContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [TOKEN_FACTORY_ADDRESS, MAX_UINT256],
      });
      showToast(t("approvalSubmitted"), "success");
    } catch (e) {
      logError(e, 'SwapPanelOKX:approve');
      const errorCode = parseErrorCode(e);
      if (!isUserCancelledError(errorCode)) {
        showGlobalError(e);
      }
    }
  };

  // ✅ Phase 2 重构：使用 TokenFactory 链上报价
  const {
    amountOut,
    minimumReceived,
    executionPrice,
    priceImpact,
    currentPrice,
    isLoading: isQuoting,
    isError: isQuoteError,
    error: quoteError,
  } = useOnChainQuote({
    tokenAddress,
    amountIn: amountInBigInt,
    isBuy: mode === "buy",
    slippageBps,
    enabled: !!tokenAddress && !!amountInBigInt && amountInBigInt > 0n,
  });

  // 构造兼容的 quote 对象
  const quote = useMemo(() => {
    if (!amountOut || amountOut === 0n) return null;
    return {
      amountOut,
      minimumReceived,
      executionPrice,
      priceImpact,
    };
  }, [amountOut, minimumReceived, executionPrice, priceImpact]);

  // ✅ 前置校验状态
  const validation: ValidationState = useMemo(() => {
    const tokenSymbol = tokenLabel;

    if (mode === "buy") {
      return validateBuyTransaction({
        isConnected: !!address,
        ethBalance: ethBalance?.value,
        amount,
        priceImpact: priceImpact,
        slippageBps,
        isPoolActive,
        isGraduated,
        minAmount: undefined, // 暂无最小限制
      });
    } else {
      return validateSellTransaction({
        isConnected: !!address,
        tokenBalance: effectiveBalance?.value,
        tokenSymbol,
        amount,
        priceImpact: priceImpact,
        slippageBps,
        ethBalance: ethBalance?.value,
        isPoolActive,
        isGraduated,
        allowance,
      });
    }
  }, [mode, address, ethBalance?.value, amount, priceImpact, slippageBps, isPoolActive, isGraduated, effectiveBalance?.value, allowance, instId]);

  // ✅ 保存报价到 store
  useEffect(() => {
    if (quote && amountInBigInt && amountInBigInt > 0n) {
      const quoteData = {
        domain: instId,
        amountIn: amountInBigInt.toString(),
        amountOut: quote.amountOut?.toString() || "0",
        minimumReceived: quote.minimumReceived?.toString() || "0",
        priceImpact: quote.priceImpact ?? 0,
        slippage: slippageBps / 100, // 转换为百分比
        timestamp: Date.now(),
      };

      setCurrentQuote(quoteData);
      addToQuoteHistory(quoteData);

      devLog.log("[SwapPanel] 链上报价已保存:", quoteData);
    }

    if (isQuoteError && quoteError) {
      devLog.error("[SwapPanel] 链上报价错误:", quoteError);
    }
  }, [quote, isQuoteError, quoteError, amountInBigInt, instId, slippageBps, setCurrentQuote, addToQuoteHistory]);

  const { executeSwap, isPending: isSwapping } = useExecuteSwap();

  const isPending = isSwapping || isApprovalConfirming;

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* 毕业/不活跃提示 */}
      {isTradingDisabled && (
        <div className="bg-gradient-to-r from-[#FFB800]/20 to-[#FF9500]/20 border border-[#FFB800]/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">🎓</span>
            <span className="text-[#FFB800] font-bold text-[13px]">
              {isGraduated ? t("tokenGraduated") : t("poolPaused")}
            </span>
          </div>
          <p className="text-okx-text-secondary text-[11px]">
            {isGraduated
              ? t("graduatedDesc")
              : t("poolPausedDesc")}
          </p>
          {isGraduated && (
            <a
              href={`https://pancakeswap.finance/swap?chain=bsc&inputCurrency=BNB&outputCurrency=${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block bg-[#1FC7D4] text-okx-text-primary px-3 py-1.5 rounded-lg text-[12px] font-bold hover:opacity-90"
            >
              🥞 {t("tradeOnUniswap")}
            </a>
          )}
        </div>
      )}

      {/* 买入/卖出 切换 */}
      <div className="flex bg-okx-bg-card p-1 rounded-lg border border-okx-border-primary">
        <button
          onClick={() => setMode("buy")}
          className={`flex-1 py-1.5 text-[13px] font-bold rounded-md transition-all ${mode === 'buy' ? 'bg-[#1C1C1C] text-[#00D26A]' : 'text-okx-text-tertiary hover:text-okx-text-secondary'}`}
        >
          {t("buy")}
        </button>
        <button
          onClick={() => setMode("sell")}
          className={`flex-1 py-1.5 text-[13px] font-bold rounded-md transition-all ${mode === 'sell' ? 'bg-[#1C1C1C] text-[#FF3B30]' : 'text-okx-text-tertiary hover:text-okx-text-secondary'}`}
        >
          {t("sell")}
        </button>
      </div>

      <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-3">
        {/* 市价/限价 切换 */}
        <div className="flex gap-4 border-b border-okx-border-primary mb-4">
          <button
            onClick={() => setOrderType("market")}
            className={`pb-2 text-[13px] font-bold relative ${orderType === 'market' ? 'text-okx-text-primary' : 'text-okx-text-tertiary'}`}
          >
            {t("market")}
            {orderType === 'market' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white"></div>}
          </button>
          <button
            onClick={() => setOrderType("limit")}
            className={`pb-2 text-[13px] font-bold relative ${orderType === 'limit' ? 'text-okx-text-primary' : 'text-okx-text-tertiary'}`}
          >
            {t("limit")} <span className="text-[10px] ml-0.5">ⓘ</span>
            {orderType === 'limit' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white"></div>}
          </button>
        </div>

        {/* 金额输入 */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-okx-text-secondary text-[12px]">{mode === "buy" ? t("pay") : t("sell")}</span>
            <button
              onClick={() => {
                // 点击余额快速填入
                if (mode === "buy" && ethBalance?.value) {
                  const gasReserve = parseUnits("0.005", 18); // 预留 0.005 ETH gas
                  const maxAmount = ethBalance.value > gasReserve ? ethBalance.value - gasReserve : 0n;
                  setAmount(formatUnits(maxAmount, 18));
                } else if (mode === "sell" && effectiveBalance?.value) {
                  setAmount(formatUnits(effectiveBalance.value, 18));
                }
              }}
              className="text-okx-text-tertiary text-[11px] hover:text-[#A3E635] transition-colors cursor-pointer"
            >
              {t("balance")}: <span className="text-okx-text-primary font-mono">
                {mode === "buy"
                  ? (ethBalance?.value ? parseFloat(formatUnits(ethBalance.value, 18)).toFixed(4) : "0.0000")
                  : (effectiveBalance?.value ? parseFloat(formatUnits(effectiveBalance.value, 18)).toFixed(2) : "0.00")
                }
              </span> {mode === "buy" ? "BNB" : tokenLabel}
            </button>
          </div>
          <div className="bg-okx-bg-primary border border-okx-border-primary rounded-lg p-3 flex items-center focus-within:border-[#A3E635] transition-colors">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bg-transparent text-okx-text-primary font-bold text-[18px] outline-none flex-1 placeholder:text-okx-text-tertiary"
              placeholder="0.00"
            />
            <div className="flex items-center gap-2">
              <span className="text-okx-text-secondary text-[14px] font-bold">{mode === "buy" ? "BNB" : tokenLabel}</span>
              {mode === "buy" && (
                <div className="w-5 h-5 rounded-full bg-[#F3BA2F] flex items-center justify-center">
                  <span className="text-[10px] font-bold text-black">B</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 快捷按钮 - pump.fun 风格 */}
        <div className="flex gap-2 mb-4">
          {mode === "buy" ? (
            // 买入模式: ETH 金额快捷按钮
            <>
              {["0.01", "0.05", "0.1", "0.5", "1"].map(val => (
                <button
                  key={val}
                  onClick={() => setAmount(val)}
                  className={`flex-1 py-2 text-[12px] font-bold rounded-lg border transition-all ${
                    amount === val
                      ? "bg-[#00D26A]/20 border-[#00D26A] text-[#00D26A]"
                      : "bg-okx-bg-hover border-okx-border-primary text-okx-text-primary hover:border-[#333] hover:bg-[#222]"
                  }`}
                >
                  {val}
                </button>
              ))}
            </>
          ) : (
            // 卖出模式: 百分比快捷按钮
            <>
              {[
                { label: "25%", value: 0.25 },
                { label: "50%", value: 0.5 },
                { label: "75%", value: 0.75 },
                { label: "100%", value: 1 },
              ].map(({ label, value }) => (
                <button
                  key={label}
                  onClick={() => {
                    if (effectiveBalance?.value) {
                      const sellAmount = (effectiveBalance.value * BigInt(Math.floor(value * 100))) / 100n;
                      setAmount(formatUnits(sellAmount, 18));
                    }
                  }}
                  className="flex-1 py-2 text-[12px] text-okx-text-primary font-bold rounded-lg border border-okx-border-primary bg-okx-bg-hover hover:border-[#FF3B30] hover:bg-[#FF3B30]/10 transition-all"
                >
                  {label}
                </button>
              ))}
            </>
          )}
        </div>

        {/* 前置校验警告 */}
        {address && validation.results.length > 0 && (
          <PreValidationWarning
            validation={validation}
            locale="zh"
            className="mb-3"
            maxItems={2}
          />
        )}

        {/* 提交按钮 */}
        {!address ? (
          <button
            onClick={openConnectModal}
            className="w-full bg-[#A3E635] text-black font-bold py-3 rounded-lg text-[15px] hover:opacity-90 transition-opacity mb-4"
          >
            {t("connectWallet")}
          </button>
        ) : isApprovalRequired ? (
          <button
            disabled={isPending || isApprovalConfirming}
            onClick={handleApprove}
            className="w-full bg-[#00D26A] text-okx-text-primary font-bold py-3 rounded-lg text-[15px] hover:opacity-90 transition-opacity mb-4 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {(isPending || isApprovalConfirming) && <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>}
            {isApprovalConfirming ? t("approving") : t("approveSell")}
          </button>
        ) : (
          <button
            disabled={isPending || !amount || !quote || isTradingDisabled || !validation.canSubmit}
            onClick={async () => {
              devLog.log("[SwapPanel] Button clicked!", {
                amount,
                amountInBigInt: amountInBigInt?.toString(),
                quote: quote ? {
                  amountOut: quote.amountOut.toString(),
                  minimumReceived: quote.minimumReceived.toString(),
                  priceImpact: quote.priceImpact
                } : null,
                mode,
                isPending
              });

              if (!quote?.amountOut || !amountInBigInt) {
                devLog.warn("[SwapPanel] Missing quote or amount!", { quote, amountInBigInt });
                showToast(t("waitQuoteLoading"), "warning");
                return;
              }
              try {
                devLog.log("[SwapPanel] Calling executeSwap...");

                // minimumAmountOut 直接使用合约 previewBuy/previewSell 返回值 + 用户滑点
                // quote.minimumReceived = previewResult * (10000 - slippageBps) / 10000
                // 不做额外计算，合约已经给出精确报价
                devLog.log("[SwapPanel] Swap params:", {
                  mode,
                  amountOut: quote.amountOut.toString(),
                  minimumReceived: quote.minimumReceived.toString(),
                  slippageBps,
                });

                await executeSwap({
                  tokenAddress,
                  amountIn: amountInBigInt,
                  minimumAmountOut: quote.minimumReceived,
                  isBuy: mode === "buy",
                });
                devLog.log("[SwapPanel] executeSwap completed");
                setAmount("");
                showToast(mode === "buy" ? t("buySuccess") : t("sellSuccess"), "success");
              } catch (error) {
                logError(error, 'SwapPanelOKX');
                const errorCode = parseErrorCode(error);
                if (!isUserCancelledError(errorCode)) {
                  showGlobalError(error);
                }
              }
            }}
            className={`w-full font-bold py-3 rounded-lg text-[15px] hover:opacity-90 transition-opacity mb-4 flex items-center justify-center gap-2 ${
              mode === "buy" ? "bg-[#00D26A] text-okx-text-primary" : "bg-[#FF3B30] text-okx-text-primary"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {(isPending || isQuoting) && <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>}
            {isQuoting ? t("getQuoting") : mode === "buy" ? t("confirmBuy") : t("confirmSell")}
          </button>
        )}

        {/* 滑点设置 */}
        <div className="border-t border-okx-border-primary pt-3 mt-2">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-okx-text-secondary text-[11px]">{t("slippageTolerance")}</span>
              <button
                onClick={() => setShowSlippageSettings(!showSlippageSettings)}
                className="text-okx-text-tertiary hover:text-okx-text-secondary text-[10px]"
              >
                ⚙️
              </button>
            </div>
            <span className="text-okx-text-primary text-[11px] font-bold">{(slippageBps / 100).toFixed(2)}%</span>
          </div>
          
          {showSlippageSettings && (
            <div className="bg-okx-bg-secondary border border-okx-border-primary rounded-lg p-3 mt-2">
              <div className="text-okx-text-secondary text-[10px] mb-2">{t("presetSlippage")}</div>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {[
                  { label: "0.5%", value: 50 },
                  { label: "1%", value: 100 },
                  { label: "3%", value: 300 },
                  { label: "5%", value: 500 },
                ].map((preset) => (
                  <button
                    key={preset.value}
                    onClick={() => {
                      // 将 bps 转换为百分比字符串设置到 customSlippage
                      setCustomSlippage((preset.value / 100).toString());
                      setShowSlippageSettings(false);
                    }}
                    className={`py-1.5 text-[11px] font-bold rounded border transition-all ${
                      slippageBps === preset.value
                        ? "bg-[#1C1C1C] border-[#A3E635] text-[#A3E635]"
                        : "bg-okx-bg-hover border-okx-border-primary text-okx-text-primary hover:border-[#333]"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              
              <div className="text-okx-text-secondary text-[10px] mb-1">{t("customSlippage")}</div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={customSlippage}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCustomSlippage(value);
                    // slippageBps 会通过 useMemo 自动更新
                  }}
                  onBlur={() => {
                    // 如果输入无效，恢复默认值（清空 customSlippage 将使用 globalSlippageTolerance）
                    if (customSlippage && (isNaN(parseFloat(customSlippage)) || parseFloat(customSlippage) < 0 || parseFloat(customSlippage) > 100)) {
                      setCustomSlippage("");
                    }
                  }}
                  placeholder={t("enterPercentage")}
                  min="0"
                  max="100"
                  step="0.1"
                  className="bg-okx-bg-primary border border-okx-border-primary rounded px-2 py-1.5 text-okx-text-primary text-[11px] flex-1 outline-none focus:border-[#A3E635]"
                />
                <span className="text-okx-text-secondary text-[11px]">%</span>
              </div>
              {customSlippage && (isNaN(parseFloat(customSlippage)) || parseFloat(customSlippage) < 0 || parseFloat(customSlippage) > 100) && (
                <div className="text-[#FF3B30] text-[9px] mt-1">{t("slippageRange")}</div>
              )}
              <div className="flex items-center justify-between text-okx-text-tertiary text-[9px] mt-2">
                <span>{tc("currentSetting")}: {(slippageBps / 100).toFixed(2)}%</span>
                <button
                  onClick={() => {
                    setShowSlippageSettings(false);
                  }}
                  className="text-[#A3E635] hover:text-[#00D26A] text-[10px] font-bold"
                >
                  {tc("done")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 报价信息 */}
        {quoteError && (
          <div className="text-[#FF3B30] text-[11px] mt-2">
            {t("quoteFailed")}: {quoteError instanceof Error ? quoteError.message : tc("loading")}
          </div>
        )}

        {/* 大额卖出警告 */}
        {quote && mode === "sell" && quote.priceImpact > 5 && (
          <div className={`mt-2 p-2 rounded-lg border text-[11px] ${
            quote.priceImpact > 20
              ? "bg-[#FF3B30]/20 border-[#FF3B30]/50 text-[#FF3B30]"
              : quote.priceImpact > 10
              ? "bg-[#FF9500]/20 border-[#FF9500]/50 text-[#FF9500]"
              : "bg-[#FFB800]/20 border-[#FFB800]/50 text-[#FFB800]"
          }`}>
            <div className="flex items-center gap-1.5">
              <span>{quote.priceImpact > 20 ? "⚠️" : quote.priceImpact > 10 ? "🔸" : "💡"}</span>
              <span className="font-bold">
                {quote.priceImpact > 20
                  ? t("highPriceImpact")
                  : quote.priceImpact > 10
                  ? t("largePriceImpact")
                  : t("priceImpactWarning")}
              </span>
            </div>
            <p className="mt-1 opacity-90">
              {t("autoAdjustedSlippage", { impact: quote.priceImpact.toFixed(1) })}
              {quote.priceImpact > 10 && ` ${t("suggestSellBatches")}`}
            </p>
          </div>
        )}

        {quote && (
          <div className="flex flex-col gap-1 mt-2 text-[11px] text-okx-text-secondary">
            <div className="flex justify-between">
              <span>{t("expectedReceive")}</span>
              <span className="text-okx-text-primary font-mono">
                {formatUnits(quote.amountOut, 18)} {mode === "buy" ? tokenLabel : "BNB"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{t("minReceiveSlippage")}</span>
              <span className="text-okx-text-primary font-mono">
                {formatUnits(quote.minimumReceived, 18)} {mode === "buy" ? tokenLabel : "BNB"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{t("priceImpact")}</span>
              <span className={quote.priceImpact > 5 ? "text-[#FF3B30]" : "text-[#00D26A]"}>{quote.priceImpact.toFixed(2)}%</span>
            </div>
          </div>
        )}
      </div>

      {/* 内盘进度条 - Bonding Curve Progress */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-3">
        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] text-okx-text-tertiary">{t("bondingCurveProgress") || "bonding curve progress"}</span>
          <span className="text-[10px] text-okx-text-primary font-bold">{graduationProgress.toFixed(2)}%</span>
        </div>
        <div className="w-full h-2 bg-okx-bg-secondary rounded-full overflow-hidden relative">
          <div
            className="h-full bg-gradient-to-r from-okx-up to-okx-accent transition-all duration-300 ease-out relative"
            style={{width: `${graduationProgress}%`}}
          >
            {/* Add pulse effect at the tip of the progress bar */}
            <div className="absolute right-0 top-0 bottom-0 w-2 bg-white/50 blur-[2px] animate-pulse"></div>
          </div>
        </div>
        <div className="flex justify-between text-[9px] mt-2 text-okx-text-tertiary">
          <span>{t("sold") || "已售"}: {soldTokensM.toFixed(2)}M</span>
          <span>{t("target") || "目标"}: 793M ({t("graduation") || "毕业"})</span>
        </div>
        {(graduationProgress >= 100 || isGraduated) && (
          <div className="mt-2 text-center text-[10px] text-[#FFB800] font-bold">
            🎓 {t("graduatedMessage") || "已毕业！代币已上线 Uniswap"}
          </div>
        )}
      </div>
    </div>
  );
}
