"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useWriteContract, useWaitForTransactionReceipt, useAccount, useBalance, useReadContract, usePublicClient } from "wagmi";
import { parseUnits, formatUnits, type Address, erc20Abi } from "viem";
import { useExecuteSwap, ETH_DECIMALS } from "@/hooks/spot/useExecuteSwap";
import { useOnChainQuote } from "@/hooks/spot/useOnChainQuote";
import { useDexQuote, useDexSwap, useDexPoolInfo, useTokenAllowance } from "@/hooks/spot/useDexSwap";
// useWalletBalance 已删除 - 余额应通过 WebSocket 从后端推送
import { SecurityStatus } from "@/components/common/SecurityStatusBanner";
import { useToast } from "@/components/shared/Toast";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { CONTRACTS, getPancakeSwapUrl } from "@/lib/contracts";
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
import { BnbIcon } from "@/components/common/BnbIcon";
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
  
  // 检查交易是否被禁用 (毕业代币走 DEX，不禁用交易)
  const isTradingDisabled = !isPoolActive && !isGraduated;
  
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

  const publicClient = usePublicClient();

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

  // DEX 交易执行 (hooks 必须在顶层，不能有条件)
  const { buyTokens, sellTokens, isPending: isDexSwapping, isConfirmed: isDexConfirmed, txHash: dexTxHash, error: dexSwapError, reset: resetDexSwap } = useDexSwap();

  // DEX 流动性池信息
  const { poolInfo: dexPoolInfo } = useDexPoolInfo(isGraduated ? tokenAddress : undefined);

  // DEX 授权 (approve Router, 不是 TokenFactory)
  const { allowance: dexAllowance, approve: approveDexRouter, isApproving: isDexApproving, refetchAllowance: refetchDexAllowance } = useTokenAllowance(
    isGraduated ? tokenAddress : undefined,
    CONTRACTS.ROUTER
  );

  // ✅ 授权检查 - 查询用户对 TokenFactory 合约的授权额度
  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && TOKEN_FACTORY_ADDRESS
      ? [address, TOKEN_FACTORY_ADDRESS]
      : undefined,
    query: {
      enabled: !!address && !!tokenAddress && mode === "sell" && !isGraduated,
    },
  });
  const allowance = isGraduated ? dexAllowance : (allowanceData as bigint | undefined);

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
          if (isGraduated) {
            refetchDexAllowance();
            refetchDexQuote();
          }
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

  // DEX 报价 (PancakeSwap V2 Router getAmountsOut) — 放在 amountInBigInt 之后
  const { quote: dexQuote, isLoading: isDexQuoting, error: dexQuoteError, refetch: refetchDexQuote } = useDexQuote(
    isGraduated ? tokenAddress : undefined,
    amountInBigInt ?? 0n,
    mode === "buy"
  );

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
    if (!tokenAddress) return;
    try {
      if (isGraduated) {
        // 毕业代币: approve PancakeSwap V2 Router
        const MAX_UINT256 = 2n ** 256n - 1n;
        const hash = await approveDexRouter(MAX_UINT256);
        showToast(t("approvalSubmitted"), "success");
        // Wait for on-chain confirmation then refetch DEX allowance
        if (hash && publicClient) {
          await publicClient.waitForTransactionReceipt({ hash });
          showToast(t("approvalSuccess"), "success");
          refetchDexAllowance();
        }
      } else {
        // 内盘代币: approve TokenFactory
        if (!TOKEN_FACTORY_ADDRESS) return;
        const MAX_UINT256 = 2n ** 256n - 1n;
        await writeContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "approve",
          args: [TOKEN_FACTORY_ADDRESS, MAX_UINT256],
        });
        showToast(t("approvalSubmitted"), "success");
      }
    } catch (e) {
      logError(e, 'SwapPanelOKX:approve');
      const errorCode = parseErrorCode(e);
      if (!isUserCancelledError(errorCode)) {
        showGlobalError(e);
      }
    }
  };

  // ✅ Phase 2 重构：使用 TokenFactory 链上报价 (仅未毕业代币)
  const {
    amountOut: bondingAmountOut,
    minimumReceived: bondingMinReceived,
    executionPrice: bondingExecPrice,
    priceImpact: bondingPriceImpact,
    currentPrice,
    isLoading: isBondingQuoting,
    isError: isBondingQuoteError,
    error: bondingQuoteError,
  } = useOnChainQuote({
    tokenAddress,
    amountIn: amountInBigInt,
    isBuy: mode === "buy",
    slippageBps,
    enabled: !!tokenAddress && !!amountInBigInt && amountInBigInt > 0n && !isGraduated,
  });

  // 统一报价: 毕业代币用 DEX, 内盘用 Bonding Curve
  const isQuoting = isGraduated ? isDexQuoting : isBondingQuoting;
  const isQuoteError = isGraduated ? !!dexQuoteError : isBondingQuoteError;
  const quoteError = isGraduated ? dexQuoteError : bondingQuoteError;

  // 构造兼容的 quote 对象
  const quote = useMemo(() => {
    if (isGraduated) {
      // DEX 报价
      if (!dexQuote) return null;
      const slippageFactor = BigInt(10000 - slippageBps);
      const minReceived = (dexQuote.amountOut * slippageFactor) / 10000n;
      return {
        amountOut: dexQuote.amountOut,
        minimumReceived: minReceived,
        executionPrice: 0, // DEX 不需要
        priceImpact: dexQuote.priceImpact,
      };
    }
    // Bonding curve 报价
    if (!bondingAmountOut || bondingAmountOut === 0n) return null;
    return {
      amountOut: bondingAmountOut,
      minimumReceived: bondingMinReceived,
      executionPrice: bondingExecPrice,
      priceImpact: bondingPriceImpact,
    };
  }, [isGraduated, dexQuote, slippageBps, bondingAmountOut, bondingMinReceived, bondingExecPrice, bondingPriceImpact]);

  // ✅ 前置校验状态
  const validation: ValidationState = useMemo(() => {
    const tokenSymbol = tokenLabel;

    if (mode === "buy") {
      return validateBuyTransaction({
        isConnected: !!address,
        ethBalance: ethBalance?.value,
        amount,
        priceImpact: quote?.priceImpact ?? 0,
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
        priceImpact: quote?.priceImpact ?? 0,
        slippageBps,
        ethBalance: ethBalance?.value,
        isPoolActive,
        isGraduated,
        allowance,
      });
    }
  }, [mode, address, ethBalance?.value, amount, quote?.priceImpact, slippageBps, isPoolActive, isGraduated, effectiveBalance?.value, allowance, instId]);

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

  const isPending = isSwapping || isDexSwapping || isApprovalConfirming || isDexApproving;

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* 毕业 DEX 交易提示 */}
      {isGraduated && (
        <div className="bg-gradient-to-r from-okx-up/10 to-okx-accent/10 border border-okx-up/30 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">🥞</span>
            <span className="text-okx-up font-bold text-sm">
              {t("dexTrading") || "DEX Trading"}
            </span>
          </div>
          <p className="text-okx-text-secondary text-xs">
            {t("dexTradingDesc") || "This token has graduated! Trading via PancakeSwap V2."}
          </p>
          {dexPoolInfo && (
            <div className="flex gap-4 mt-2 text-xs text-okx-text-tertiary">
              <span>{t("liquidity") || "Liquidity"}: {(Number(dexPoolInfo.reserveBNB) / 1e18).toFixed(2)} BNB</span>
              <a
                href={getPancakeSwapUrl(tokenAddress!)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-okx-accent hover:underline"
              >
                PancakeSwap ↗
              </a>
            </div>
          )}
        </div>
      )}

      {/* 池子不活跃提示 */}
      {isTradingDisabled && (
        <div className="bg-gradient-to-r from-okx-warning/20 to-okx-warning/20 border border-okx-warning/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">⚠️</span>
            <span className="text-okx-warning font-bold text-sm">
              {t("poolPaused")}
            </span>
          </div>
          <p className="text-okx-text-secondary text-xs">
            {t("poolPausedDesc")}
          </p>
        </div>
      )}

      {/* 买入/卖出 切换 */}
      <div className="flex bg-okx-bg-card p-1 rounded-lg border border-okx-border-primary">
        <button
          onClick={() => setMode("buy")}
          className={`flex-1 py-1.5 text-sm font-bold rounded-md transition-all ${mode === 'buy' ? 'bg-okx-bg-hover text-okx-up' : 'text-okx-text-tertiary hover:text-okx-text-secondary'}`}
        >
          {t("buy")}
        </button>
        <button
          onClick={() => setMode("sell")}
          className={`flex-1 py-1.5 text-sm font-bold rounded-md transition-all ${mode === 'sell' ? 'bg-okx-bg-hover text-okx-down' : 'text-okx-text-tertiary hover:text-okx-text-secondary'}`}
        >
          {t("sell")}
        </button>
      </div>

      <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-3">
        {/* 市价/限价 切换 */}
        <div className="flex gap-4 border-b border-okx-border-primary mb-4">
          <button
            onClick={() => setOrderType("market")}
            className={`pb-2 text-sm font-bold relative ${orderType === 'market' ? 'text-okx-text-primary' : 'text-okx-text-tertiary'}`}
          >
            {t("market")}
            {orderType === 'market' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-okx-text-primary"></div>}
          </button>
          <button
            onClick={() => setOrderType("limit")}
            className={`pb-2 text-sm font-bold relative ${orderType === 'limit' ? 'text-okx-text-primary' : 'text-okx-text-tertiary'}`}
          >
            {t("limit")} <span className="text-xs ml-0.5">ⓘ</span>
            {orderType === 'limit' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-okx-text-primary"></div>}
          </button>
        </div>

        {/* 金额输入 */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-okx-text-secondary text-xs">{mode === "buy" ? t("pay") : t("sell")}</span>
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
              className="text-okx-text-tertiary text-xs hover:text-meme-lime transition-colors cursor-pointer"
            >
              {t("balance")}: <span className="text-okx-text-primary font-mono">
                {mode === "buy"
                  ? (ethBalance?.value ? parseFloat(formatUnits(ethBalance.value, 18)).toFixed(4) : "0.0000")
                  : (effectiveBalance?.value ? parseFloat(formatUnits(effectiveBalance.value, 18)).toFixed(2) : "0.00")
                }
              </span> {mode === "buy" ? "BNB" : tokenLabel}
            </button>
          </div>
          <div className="bg-okx-bg-primary border border-okx-border-primary rounded-lg p-3 flex items-center focus-within:border-meme-lime transition-colors">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="bg-transparent text-okx-text-primary font-bold text-[18px] outline-none flex-1 placeholder:text-okx-text-tertiary"
              placeholder="0.00"
            />
            <div className="flex items-center gap-2">
              <span className="text-okx-text-secondary text-sm font-bold">{mode === "buy" ? "BNB" : tokenLabel}</span>
              {mode === "buy" && <BnbIcon size={20} />}
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
                  className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-all ${
                    amount === val
                      ? "bg-okx-up/20 border-okx-up text-okx-up"
                      : "bg-okx-bg-hover border-okx-border-primary text-okx-text-primary hover:border-okx-border-secondary hover:bg-okx-bg-active"
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
                  className="flex-1 py-2 text-xs text-okx-text-primary font-bold rounded-lg border border-okx-border-primary bg-okx-bg-hover hover:border-okx-down hover:bg-okx-down/10 transition-all"
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
            className="mb-3"
            maxItems={2}
          />
        )}

        {/* 提交按钮 */}
        {!address ? (
          <button
            onClick={openConnectModal}
            className="w-full bg-meme-lime text-black font-bold py-3 rounded-lg text-[15px] hover:opacity-90 transition-opacity mb-4"
          >
            {t("connectWallet")}
          </button>
        ) : isApprovalRequired ? (
          <button
            disabled={isPending || isApprovalConfirming}
            onClick={handleApprove}
            className="w-full bg-okx-up text-okx-text-primary font-bold py-3 rounded-lg text-[15px] hover:opacity-90 transition-opacity mb-4 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
                if (isGraduated && tokenAddress) {
                  // ===== DEX 模式 (PancakeSwap V2 Router) =====
                  devLog.log("[SwapPanel] DEX swap via PancakeSwap V2 Router", {
                    mode,
                    amountOut: quote.amountOut.toString(),
                    minimumReceived: quote.minimumReceived.toString(),
                  });

                  let dexHash: string | undefined;
                  if (mode === "buy") {
                    dexHash = await buyTokens({
                      tokenAddress,
                      amountInBNB: amountInBigInt,
                      amountOutMin: quote.minimumReceived,
                    });
                  } else {
                    dexHash = await sellTokens({
                      tokenAddress,
                      amountIn: amountInBigInt,
                      amountOutMin: quote.minimumReceived,
                    });
                  }
                  // Emit trade event so TradingTerminal refreshes trade list
                  if (dexHash) {
                    tradeEventEmitter.emit(tokenAddress, dexHash);
                  }
                } else {
                  // ===== 内盘模式 (TokenFactory Bonding Curve) =====
                  devLog.log("[SwapPanel] Bonding curve swap via TokenFactory", {
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
                }
                devLog.log("[SwapPanel] Swap completed");
                setAmount("");
                showToast(mode === "buy" ? t("buySuccess") : t("sellSuccess"), "success");
                // 刷新余额
                setTimeout(() => {
                  refetchEthBalance();
                  refetchTokenBalance();
                  if (isGraduated) {
                    refetchDexQuote();
                    refetchDexAllowance();
                  }
                }, 2000);
              } catch (error) {
                logError(error, 'SwapPanelOKX');
                const errorCode = parseErrorCode(error);
                if (!isUserCancelledError(errorCode)) {
                  showGlobalError(error);
                }
              }
            }}
            className={`w-full font-bold py-3 rounded-lg text-[15px] hover:opacity-90 transition-opacity mb-4 flex items-center justify-center gap-2 ${
              mode === "buy" ? "bg-okx-up text-okx-text-primary" : "bg-okx-down text-okx-text-primary"
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
              <span className="text-okx-text-secondary text-xs">{t("slippageTolerance")}</span>
              <button
                onClick={() => setShowSlippageSettings(!showSlippageSettings)}
                className="text-okx-text-tertiary hover:text-okx-text-secondary text-xs"
              >
                ⚙️
              </button>
            </div>
            <span className="text-okx-text-primary text-xs font-bold">{(slippageBps / 100).toFixed(2)}%</span>
          </div>
          
          {showSlippageSettings && (
            <div className="bg-okx-bg-secondary border border-okx-border-primary rounded-lg p-3 mt-2">
              <div className="text-okx-text-secondary text-xs mb-2">{t("presetSlippage")}</div>
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
                    className={`py-1.5 text-xs font-bold rounded border transition-all ${
                      slippageBps === preset.value
                        ? "bg-okx-bg-hover border-meme-lime text-meme-lime"
                        : "bg-okx-bg-hover border-okx-border-primary text-okx-text-primary hover:border-okx-border-secondary"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              
              <div className="text-okx-text-secondary text-xs mb-1">{t("customSlippage")}</div>
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
                  className="bg-okx-bg-primary border border-okx-border-primary rounded px-2 py-1.5 text-okx-text-primary text-xs flex-1 outline-none focus:border-meme-lime"
                />
                <span className="text-okx-text-secondary text-xs">%</span>
              </div>
              {customSlippage && (isNaN(parseFloat(customSlippage)) || parseFloat(customSlippage) < 0 || parseFloat(customSlippage) > 100) && (
                <div className="text-okx-down text-xs mt-1">{t("slippageRange")}</div>
              )}
              <div className="flex items-center justify-between text-okx-text-tertiary text-xs mt-2">
                <span>{tc("currentSetting")}: {(slippageBps / 100).toFixed(2)}%</span>
                <button
                  onClick={() => {
                    setShowSlippageSettings(false);
                  }}
                  className="text-meme-lime hover:text-okx-up text-xs font-bold"
                >
                  {tc("done")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 报价信息 */}
        {quoteError && (
          <div className="text-okx-down text-xs mt-2">
            {t("quoteFailed")}: {quoteError instanceof Error ? quoteError.message : tc("loading")}
          </div>
        )}

        {/* 大额卖出警告 */}
        {quote && mode === "sell" && quote.priceImpact > 5 && (
          <div className={`mt-2 p-2 rounded-lg border text-xs ${
            quote.priceImpact > 20
              ? "bg-okx-down/20 border-okx-down/50 text-okx-down"
              : quote.priceImpact > 10
              ? "bg-okx-warning/20 border-okx-warning/50 text-okx-warning"
              : "bg-okx-warning/20 border-okx-warning/50 text-okx-warning"
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
          <div className="flex flex-col gap-1 mt-2 text-xs text-okx-text-secondary">
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
              <span className={quote.priceImpact > 5 ? "text-okx-down" : "text-okx-up"}>{quote.priceImpact.toFixed(2)}%</span>
            </div>
          </div>
        )}
      </div>

      {/* 内盘进度条 / DEX 流动性信息 */}
      {isGraduated ? (
        // DEX 流动性信息
        <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-3">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs text-okx-text-tertiary">{t("dexLiquidity") || "DEX Liquidity (PancakeSwap V2)"}</span>
            <span className="text-xs text-okx-up font-bold">🎓 {t("graduated") || "Graduated"}</span>
          </div>
          {dexPoolInfo ? (
            <div className="flex flex-col gap-1 text-xs">
              <div className="flex justify-between text-okx-text-secondary">
                <span>BNB</span>
                <span className="text-okx-text-primary font-mono">
                  {(Number(dexPoolInfo.reserveBNB) / 1e18).toFixed(4)}
                </span>
              </div>
              <div className="flex justify-between text-okx-text-secondary">
                <span>{tokenLabel}</span>
                <span className="text-okx-text-primary font-mono">
                  {(Number(dexPoolInfo.reserveToken) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </div>
              <div className="flex justify-between text-okx-text-secondary">
                <span>{t("price") || "Price"}</span>
                <span className="text-okx-text-primary font-mono">
                  {dexPoolInfo.price > 0 ? dexPoolInfo.price.toExponential(4) : "—"} BNB
                </span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-okx-text-tertiary text-center py-2">
              {t("loadingLiquidity") || "Loading liquidity..."}
            </div>
          )}
        </div>
      ) : (
        // Bonding Curve Progress
        <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-3">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs text-okx-text-tertiary">{t("bondingCurveProgress")}</span>
            <span className="text-xs text-okx-text-primary font-bold">{graduationProgress.toFixed(2)}%</span>
          </div>
          <div className="w-full h-2 bg-okx-bg-secondary rounded-full overflow-hidden relative">
            <div
              className="h-full bg-gradient-to-r from-okx-up to-okx-accent transition-all duration-300 ease-out relative"
              style={{width: `${graduationProgress}%`}}
            >
              <div className="absolute right-0 top-0 bottom-0 w-2 bg-white/50 blur-[2px] animate-pulse"></div>
            </div>
          </div>
          <div className="flex justify-between text-xs mt-2 text-okx-text-tertiary">
            <span>{t("sold")}: {soldTokensM.toFixed(2)}M</span>
            <span>{t("target")}: 793M ({t("graduation")})</span>
          </div>
        </div>
      )}
    </div>
  );
}
