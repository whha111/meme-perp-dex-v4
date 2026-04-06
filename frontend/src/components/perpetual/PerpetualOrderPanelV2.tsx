"use client";

/**
 * PerpetualOrderPanelV2 - 用户对赌模式交易面板 (BNB 本位)
 *
 * 新架构流程：
 * 1. 用户签名 EIP-712 订单（链下，不花 Gas）
 * 2. 撮合引擎配对多空订单（链下）
 * 3. 撮合引擎批量提交配对结果（链上）
 * 4. Settlement 合约验证签名并执行 BNB 结算
 * 5. 盈亏直接在多空之间转移，保险基金仅用于穿仓
 *
 * BNB 本位:
 * - 保证金/PnL 以 BNB 计价 (1e18 精度)
 * - 价格为 Token/BNB (从 Bonding Curve 直接获取)
 */

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useTranslations } from "next-intl";
import { formatEther, parseEther, type Address } from "viem";
import { formatTokenPrice } from "@/utils/formatters";
import { privateKeyToAccount } from "viem/accounts";
import { useToast } from "@/components/shared/Toast";
import { AccountBalance } from "@/components/common/AccountBalance";
import {
  useTradingDataStore,
  useLeverageSettings,
  useOrderForm,
  type PositionSide,
  type MarginMode,
} from "@/lib/stores/tradingDataStore";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { usePoolState } from "@/hooks/spot/usePoolState";
import { useWalletBalance } from "@/contexts/WalletBalanceContext";
import { Copy, Check, Key, RefreshCw, ExternalLink, Plus, Minus } from "lucide-react";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { PositionRow, computePosition, formatSmallPrice, type PositionRowData } from "@/components/common/PositionRow";

// AUDIT-FIX H-06: Leverage options must match engine MAX_LEVERAGE (10x).
// Previously allowed up to 100x which caused confusing UX failures when engine rejected >10x.
// 内盘阶段最大 2.5x 杠杆
const LEVERAGE_OPTIONS = [1, 1.5, 2, 2.5];

// formatSmallPrice imported from @/components/common/PositionRow

interface PerpetualOrderPanelV2Props {
  symbol: string;
  displaySymbol?: string;
  tokenAddress?: Address;
  className?: string;
  isPerpEnabled?: boolean;
  suggestedPrice?: string; // 从 OrderBook 点击传入的价格
}

export function PerpetualOrderPanelV2({
  symbol,
  displaySymbol,
  tokenAddress,
  className,
  isPerpEnabled = true,
  suggestedPrice,
}: PerpetualOrderPanelV2Props) {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { showToast } = useToast();
  const t = useTranslations("perp");
  const tc = useTranslations("common");
  const tw = useTranslations("tradingWallet");

  const tokenSymbol = displaySymbol || symbol;

  // ETH 价格
  const { price: ethPrice } = useETHPrice();

  // 从 TokenFactory 获取现货价格 (bonding curve 价格) - ETH 本位: Token/ETH
  const { currentPrice: spotPriceBigInt } = usePoolState(tokenAddress);

  // Trading Wallet Hook - 签名派生钱包
  const {
    address: tradingWalletAddress,
    ethBalance: tradingWalletBalance,
    formattedEthBalance: formattedTradingWalletBalance,
    isInitialized: isTradingWalletInitialized,
    isLoading: isTradingWalletLoading,
    error: tradingWalletError,
    generateWallet,
    refreshBalance: refreshTradingWalletBalance,
    exportKey,
    disconnect: disconnectTradingWallet,
    getSignature,
    wrapAndDeposit,
    isWrappingAndDepositing,
  } = useTradingWallet();

  // 获取交易钱包签名（用于订单签名）
  const tradingWalletSignature = getSignature();

  // Deposit Modal 状态
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [privateKeyData, setPrivateKeyData] = useState<{ privateKey: string; warning: string } | null>(null);

  // Wrap and Deposit 状态
  const [wrapAmount, setWrapAmount] = useState("");

  // 增减保证金 Modal 状态
  const [marginModal, setMarginModal] = useState<{ pairId: string; action: "add" | "remove"; collateral: number } | null>(null);
  const [marginAmount, setMarginAmount] = useState("");
  const [isAdjustingMargin, setIsAdjustingMargin] = useState(false);

  // TP/SL Modal 状态
  const [tpslModal, setTpslModal] = useState<{
    pairId: string; isLong: boolean; entryPrice: number; liqPrice: number;
  } | null>(null);
  const [tpInput, setTpInput] = useState("");
  const [slInput, setSlInput] = useState("");
  const [isSettingTpsl, setIsSettingTpsl] = useState(false);
  const [currentTpsl, setCurrentTpsl] = useState<{
    takeProfitPrice: string | null; stopLossPrice: string | null;
  } | null>(null);

  // V2 Hook - 使用 Settlement 合约 + 撮合引擎
  // 传入交易钱包信息用于签名订单
  const {
    balance,
    positions,
    pendingOrders,
    submitMarketOrder,
    submitLimitOrder,
    closePair,
    // refreshBalance no longer needed here — usePerpetualV2 handles WS balance internally
    // orderBook / refreshOrderBook removed — dead code, data flows via WebSocket → tradingDataStore
    isSigningOrder,
    isSubmittingOrder,
    isPending,
    isConfirming,
  } = usePerpetualV2({
    tradingWalletAddress: tradingWalletAddress || undefined,
    tradingWalletSignature: tradingWalletSignature || undefined,
  });

  // Global wallet balance context (on-chain balances — fallback when WS balance unavailable)
  const walletBalanceCtx = useWalletBalance();
  const { refreshBalance: refreshWalletBalance, totalBalance: onChainBalance } = walletBalanceCtx;

  // ── Balance 实时更新: System B (WebSocketManager) → tradingDataStore ──
  const storeBalance = useTradingDataStore(state => state.balance);
  useEffect(() => {
    if (storeBalance) {
      refreshWalletBalance();
      refreshTradingWalletBalance();
    }
  }, [storeBalance, refreshWalletBalance, refreshTradingWalletBalance]);

  // Store state
  const instId = `${tokenSymbol.toUpperCase()}-PERP`;
  const leverageSettings = useLeverageSettings(instId);
  const orderForm = useOrderForm();

  // Local UI state
  const [showLeverageSlider, setShowLeverageSlider] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);

  // 单位选择: BNB / 代币 (BNB 本位)
  const [amountUnit, setAmountUnit] = useState<"BNB" | "TOKEN">("BNB");

  // Order type state (市价/限价)
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState("");

  // ★ OrderBook 点击价格 → 自动切换限价单并填入价格
  useEffect(() => {
    if (suggestedPrice) {
      setOrderType("limit");
      setLimitPrice(suggestedPrice);
    }
  }, [suggestedPrice]);

  // TP/SL state (止盈止损)
  const [showTpSl, setShowTpSl] = useState(false);
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");

  // Get store actions
  const updateOrderForm = useTradingDataStore.getState().updateOrderForm;
  const updateLeverage = useTradingDataStore.getState().updateLeverage;
  const updateMarginMode = useTradingDataStore.getState().updateMarginMode;

  // Derive state from store
  const side = orderForm.side;
  const marginMode = orderForm.marginMode;
  const leverage = orderForm.leverage;
  const amount = orderForm.size;

  // Handlers
  const setSide = (newSide: PositionSide) => updateOrderForm({ side: newSide });
  const setMarginMode = (mode: MarginMode) => updateMarginMode(instId, mode);
  const setLeverage = (lev: number) => updateLeverage(instId, lev);

  const setAmount = (val: string) => {
    updateOrderForm({ size: val });
    if (val && !/^\d*\.?\d*$/.test(val)) {
      setAmountError("Please enter a valid number");
    } else {
      setAmountError(null);
    }
  };

  // 代币价格 - ETH 本位
  // tokenPriceETH: Token/ETH 比率 (从 Bonding Curve)
  // tokenPriceUSD: 仅用于 UI 参考显示
  const { tokenPriceETH, tokenPriceUSD } = useMemo(() => {
    // 使用 TokenFactory 的 bonding curve 价格 (Token/ETH)
    if (spotPriceBigInt) {
      const priceETH = Number(spotPriceBigInt) / 1e18;  // Token/ETH ratio
      const priceUSD = priceETH * (ethPrice || 0);      // 仅参考
      return { tokenPriceETH: priceETH, tokenPriceUSD: priceUSD };
    }
    return { tokenPriceETH: 0, tokenPriceUSD: 0 };
  }, [spotPriceBigInt, ethPrice]);

  // 根据用户选择的单位，统一换算成仓位价值 (ETH 本位) 和 Meme 币数量
  // ETH 本位: 主要使用 ETH 计价，USD 仅用于参考显示
  const { positionValueETH, positionValueUSD, positionSizeToken } = useMemo(() => {
    const inputAmount = parseFloat(amount) || 0;
    if (inputAmount <= 0 || tokenPriceUSD <= 0) {
      return { positionValueETH: 0, positionValueUSD: 0, positionSizeToken: 0 };
    }

    let valueETH = 0;
    let valueUSD = 0;  // 仅用于 UI 参考显示
    let tokenAmount = 0;

    if (amountUnit === "BNB") {
      valueETH = inputAmount;
      valueUSD = inputAmount * (ethPrice || 0);  // 仅参考
      tokenAmount = valueUSD / tokenPriceUSD;
    } else if (amountUnit === "TOKEN") {
      tokenAmount = inputAmount;
      valueUSD = inputAmount * tokenPriceUSD;  // 仅参考
      valueETH = ethPrice ? valueUSD / ethPrice : 0;
    }

    return { positionValueETH: valueETH, positionValueUSD: valueUSD, positionSizeToken: tokenAmount };
  }, [amount, amountUnit, ethPrice, tokenPriceUSD]);

  // 计算所需保证金 (ETH 本位: 直接用 ETH)
  const requiredMarginETH = useMemo(() => {
    if (positionValueETH <= 0) return 0;
    const marginETH = positionValueETH / leverage;
    const feeETH = positionValueETH * 0.0005; // 0.05% taker fee (5bp)
    return marginETH + feeETH;
  }, [positionValueETH, leverage]);

  // 格式化保证金显示 (ETH 本位)
  const requiredMarginDisplay = useMemo(() => {
    if (requiredMarginETH <= 0) return "BNB 0.0000";
    return `BNB ${requiredMarginETH >= 1 ? requiredMarginETH.toFixed(4) : requiredMarginETH.toFixed(6)}`;
  }, [requiredMarginETH]);

  // Check if balance is sufficient
  // 数据源优先级：
  //   1. 引擎 API balance (包含 settlement 存款 + mode2 调整 + 钱包余额)
  //   2. 派生钱包链上 BNB (useTradingWallet.ethBalance，最可靠)
  //   3. WalletBalanceContext (useWalletBalance，wagmi useBalance)
  const { hasSufficientBalance, availableBalanceETH } = useMemo(() => {
    if (balance) {
      // ★ FIX: 引擎的 availableBalance 是唯一正确的可用余额来源
      // 它已经计算了: walletBalance + settlementAvailable + mode2Adj - positionMargin - pendingOrders
      // 不要再加 walletBalance，否则双重计算!
      const availableETH = Number(balance.available) / 1e18;
      return {
        hasSufficientBalance: availableETH >= requiredMarginETH,
        availableBalanceETH: availableETH,
      };
    }
    // Fallback: use on-chain wallet balance (NOT totalBalance which includes locked margin)
    const { nativeEthBalance: walletAvailable } = walletBalanceCtx;
    const onChainETH = Number(walletAvailable) / 1e18;
    return {
      hasSufficientBalance: onChainETH >= requiredMarginETH,
      availableBalanceETH: onChainETH,
    };
  }, [balance, walletBalanceCtx, requiredMarginETH]);

  // Find positions for current token
  const currentTokenPositions = useMemo(() => {
    if (!tokenAddress) return [];
    return positions.filter(
      (p) => p.token.toLowerCase() === tokenAddress.toLowerCase()
    );
  }, [positions, tokenAddress]);

  // Place order handler
  const handlePlaceOrder = useCallback(async () => {
    if (!isConnected) {
      openConnectModal?.();
      return;
    }

    if (!tokenAddress) {
      showToast("Token address not available", "error");
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      showToast("请输入有效的数量", "error");
      return;
    }

    if (positionSizeToken <= 0 || !isFinite(positionSizeToken)) {
      showToast("无法计算仓位大小，请检查价格（价格数据加载中）", "error");
      return;
    }

    // Validate limit price for limit orders
    if (orderType === "limit" && (!limitPrice || parseFloat(limitPrice) <= 0)) {
      showToast(t("enterLimitPrice") || "请输入限价", "error");
      return;
    }

    if (!hasSufficientBalance) {
      showToast("余额不足，请先充值", "error");
      return;
    }

    if (!isTradingWalletInitialized) {
      showToast("请先创建交易钱包", "error");
      return;
    }

    try {
      const isLong = side === "long";
      // ETH 本位：传 ETH 名义价值（1e18 精度）
      // 合约 Settlement 计算保证金：collateral = size / leverage
      // 所以 size 必须是 ETH 价值（1e18 精度）
      // AUDIT-FIX FE-C02: 当单位为 ETH 时直接传原始字符串，避免 parseFloat 精度丢失
      const sizeEthString = amountUnit === "BNB"
        ? amount  // 直接用用户输入字符串，不经过 float 往返
        : positionValueETH.toFixed(18);

      console.log(`[Order] Unit: ${amountUnit}, Input: ${amount}, Value: BNB ${positionValueETH.toFixed(4)} (~$${positionValueUSD.toFixed(2)}), Token Amount: ${positionSizeToken.toLocaleString()}, Size for contract: ${sizeEthString} BNB`);

      showToast(
        `正在签名 ${isLong ? "做多" : "做空"} BNB ${positionValueETH.toFixed(4)} (~$${positionValueUSD.toFixed(2)})...`,
        "info"
      );

      // P2-2: 传递止盈止损参数
      const tpslOptions = (showTpSl && (takeProfit || stopLoss))
        ? { takeProfit: takeProfit || undefined, stopLoss: stopLoss || undefined }
        : undefined;

      let result;
      if (orderType === "market") {
        result = await submitMarketOrder(tokenAddress, isLong, sizeEthString, leverage, tpslOptions);
      } else {
        result = await submitLimitOrder(tokenAddress, isLong, sizeEthString, leverage, limitPrice, tpslOptions);
      }

      if (result.success) {
        showToast(
          `${orderType === "limit" ? "Limit" : "Market"} order submitted! ${result.orderId ? `ID: ${result.orderId}` : ""}`,
          "success"
        );
        updateOrderForm({ size: "" });
        setAmount("");
        if (orderType === "limit") setLimitPrice("");
      } else {
        showToast(result.error || "Order submission failed", "error");
      }
    } catch (error) {
      console.error("[Order Error]", error);
      showToast(
        error instanceof Error ? error.message : "Order failed",
        "error"
      );
    }
  }, [
    isConnected,
    openConnectModal,
    tokenAddress,
    amount,
    orderType,
    limitPrice,
    hasSufficientBalance,
    isTradingWalletInitialized,
    positionSizeToken,
    positionValueETH,
    positionValueUSD,
    amountUnit,
    tokenSymbol,
    side,
    leverage,
    submitMarketOrder,
    submitLimitOrder,
    updateOrderForm,
    showToast,
    showTpSl,
    takeProfit,
    stopLoss,
    t,
  ]);

  // Close position handler
  const handleClosePosition = useCallback(
    async (pairId: string) => {
      if (!isConnected) {
        openConnectModal?.();
        return;
      }

      try {
        showToast("Closing position...", "info");
        const result = await closePair(pairId);

        if (result.success) {
          showToast("Position closed successfully!", "success");
        } else {
          showToast(result.error || "Failed to close position", "error");
        }
      } catch (error) {
        console.error("[Close Position Error]", error);
        showToast(
          error instanceof Error ? error.message : "Close failed",
          "error"
        );
      }
    },
    [isConnected, openConnectModal, closePair, showToast]
  );

  // 增减保证金处理
  const handleAdjustMargin = useCallback(async () => {
    if (!marginModal || !marginAmount || !tradingWalletAddress) return;
    const amountWei = parseEther(marginAmount).toString();
    if (BigInt(amountWei) <= 0n) {
      showToast("请输入有效金额", "error");
      return;
    }

    setIsAdjustingMargin(true);
    try {
      // 签名验证消息
      const { pairId, action } = marginModal;
      const sigMsg = action === "add"
        ? `Add margin ${amountWei} to ${pairId} for ${tradingWalletAddress.toLowerCase()}`
        : `Remove margin ${amountWei} from ${pairId} for ${tradingWalletAddress.toLowerCase()}`;

      // 使用 useTradingWallet 导出私钥签名
      const keyData = exportKey?.();
      if (!keyData?.privateKey) {
        showToast("交易钱包未激活", "error");
        return;
      }
      const signerAccount = privateKeyToAccount(keyData.privateKey);
      const { createWalletClient, http } = await import("viem");
      const { bscTestnet } = await import("viem/chains");
      const tempClient = createWalletClient({
        account: signerAccount,
        chain: bscTestnet,
        transport: http(),
      });
      const signature = await tempClient.signMessage({ account: signerAccount, message: sigMsg });

      const endpoint = action === "add" ? "margin/add" : "margin/remove";
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/position/${pairId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amountWei, trader: tradingWalletAddress, signature }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(`保证金${action === "add" ? "追加" : "减少"}成功`, "success");
        setMarginModal(null);
        setMarginAmount("");
        refreshWalletBalance();
      } else {
        showToast(data.error || "操作失败", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "操作失败", "error");
    } finally {
      setIsAdjustingMargin(false);
    }
  }, [marginModal, marginAmount, tradingWalletAddress, exportKey, showToast, refreshWalletBalance]);

  // ── TP/SL: 打开弹窗时获取当前值 ──
  useEffect(() => {
    if (!tpslModal) { setCurrentTpsl(null); setTpInput(""); setSlInput(""); return; }
    fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`)
      .then(r => r.json())
      .then(data => {
        if (data.hasTPSL) {
          setCurrentTpsl({ takeProfitPrice: data.takeProfitPrice, stopLossPrice: data.stopLossPrice });
          if (data.takeProfitPrice) setTpInput((Number(data.takeProfitPrice) / 1e18).toString());
          if (data.stopLossPrice) setSlInput((Number(data.stopLossPrice) / 1e18).toString());
        }
      })
      .catch(() => {});
  }, [tpslModal?.pairId]);

  // ── TP/SL: 提交 ──
  const handleSetTpsl = useCallback(async () => {
    if (!tpslModal || !tradingWalletAddress) return;
    if (!tpInput && !slInput) { showToast(t("tpslRequired") || "Please set at least TP or SL", "error"); return; }
    setIsSettingTpsl(true);
    try {
      const { parseEther: toWei } = await import("viem");
      const tpWei = tpInput ? toWei(tpInput).toString() : null;
      const slWei = slInput ? toWei(slInput).toString() : null;
      const sigMsg = `Set TPSL ${tpslModal.pairId} for ${tradingWalletAddress.toLowerCase()}`;
      const keyData = exportKey?.();
      if (!keyData?.privateKey) { showToast(t("tradingWalletNotActive") || "Trading wallet not active", "error"); return; }
      const signerAccount = privateKeyToAccount(keyData.privateKey);
      const { createWalletClient, http } = await import("viem");
      const { bscTestnet } = await import("viem/chains");
      const tempClient = createWalletClient({ account: signerAccount, chain: bscTestnet, transport: http() });
      const signature = await tempClient.signMessage({ account: signerAccount, message: sigMsg });
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trader: tradingWalletAddress, signature, takeProfitPrice: tpWei, stopLossPrice: slWei }),
      });
      const data = await res.json();
      if (data.success) { showToast(t("tpslSet") || "TP/SL set successfully", "success"); setTpslModal(null); }
      else { showToast(data.error || (t("operationFailed") || "Operation failed"), "error"); }
    } catch (err) {
      showToast(err instanceof Error ? err.message : (t("operationFailed") || "Operation failed"), "error");
    } finally { setIsSettingTpsl(false); }
  }, [tpslModal, tpInput, slInput, tradingWalletAddress, exportKey, showToast, t]);

  // ── TP/SL: 取消 (with signature auth) ──
  const handleCancelTpsl = useCallback(async (cancelType: "tp" | "sl" | "both") => {
    if (!tpslModal || !tradingWalletAddress) return;
    try {
      const keyData = exportKey?.();
      if (!keyData?.privateKey) {
        showToast("交易钱包未激活", "error");
        return;
      }
      const signerAccount = privateKeyToAccount(keyData.privateKey);
      const cancelMessage = `Cancel TPSL ${tpslModal.pairId} for ${tradingWalletAddress.toLowerCase()}`;
      const signature = await signerAccount.signMessage({ message: cancelMessage });

      const res = await fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancelType, trader: tradingWalletAddress, signature }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(t("tpslCancelled") || "TP/SL cancelled", "success");
        if (cancelType === "both") setTpslModal(null);
        else if (cancelType === "tp") { setTpInput(""); setCurrentTpsl(prev => prev ? { ...prev, takeProfitPrice: null } : null); }
        else { setSlInput(""); setCurrentTpsl(prev => prev ? { ...prev, stopLossPrice: null } : null); }
      }
    } catch {}
  }, [tpslModal, tradingWalletAddress, exportKey, showToast, t]);

  return (
    <div className={`bg-okx-bg-secondary rounded-lg ${className}`}>
      {/* V2 Architecture Badge */}
      <div className="p-2 bg-gradient-to-r from-purple-900/30 to-blue-900/30 border-b border-purple-500/30">
        <div className="flex items-center justify-center gap-2 text-xs text-purple-300">
          <span className="w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
          <span>Peer-to-Peer Trading (V2)</span>
        </div>
      </div>

      {/* Account Section - 简洁版 */}
      <div className="p-3 border-b border-okx-border-primary">
        {!isConnected ? (
          // 未连接钱包
          <button
            onClick={() => openConnectModal?.()}
            className="w-full py-2.5 text-sm font-medium bg-meme-lime hover:brightness-110 text-black rounded transition-colors"
          >
            {tc("connectWallet") || "Connect Wallet"}
          </button>
        ) : !isTradingWalletInitialized ? (
          // 未创建交易钱包 - 简洁的初始化按钮
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-okx-text-secondary text-xs">{tw("account")}</span>
              <span className="text-okx-text-tertiary text-xs">{tw("notActivated")}</span>
            </div>
            {tradingWalletError && (
              <p className="text-red-400 text-xs mb-2">{tradingWalletError}</p>
            )}
            <button
              onClick={generateWallet}
              disabled={isTradingWalletLoading}
              className="w-full py-2 text-xs font-medium bg-meme-lime hover:brightness-110 disabled:bg-gray-600 text-black rounded transition-colors"
            >
              {isTradingWalletLoading ? tw("activating") : tw("activateAccount")}
            </button>
          </div>
        ) : (
          // 已激活 - 显示 BNB 余额 + 充值按钮 + 设置
          <div>
            <div className="flex items-center justify-between">
              <span className="text-okx-text-secondary text-xs">{tw("account")}</span>
              <div className="flex items-center gap-2">
                <span className="text-okx-text-primary text-sm font-semibold">
                  BNB {availableBalanceETH.toFixed(4)}
                </span>
                <button
                  onClick={() => setShowDepositModal(true)}
                  className="px-2.5 py-0.5 text-xs font-medium text-okx-brand border border-okx-brand rounded hover:bg-okx-brand hover:text-white transition-colors"
                >
                  {tw("deposit")}
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  className="p-1 text-okx-text-tertiary hover:text-okx-text-primary transition-colors"
                  title={tw("accountSettings")}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Deposit Modal - 直接集成 AccountBalance 组件 */}
      {showDepositModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md">
            <AccountBalance onClose={() => setShowDepositModal(false)} />
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-okx-bg-secondary rounded-xl w-full max-w-sm border border-okx-border-primary">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-okx-border-primary">
              <h3 className="text-[16px] font-semibold text-okx-text-primary">{tw("accountSettings")}</h3>
              <button
                onClick={() => setShowSettings(false)}
                className="p-1 text-okx-text-tertiary hover:text-okx-text-primary transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-3">
              {/* Wallet Address */}
              <div className="bg-okx-bg-primary rounded-lg p-3 border border-okx-border-primary">
                <p className="text-xs text-okx-text-tertiary mb-1">{tw("walletAddress")}</p>
                <p className="text-xs text-okx-text-primary font-mono truncate">{tradingWalletAddress}</p>
              </div>

              {/* Export Private Key */}
              <button
                onClick={() => {
                  const data = exportKey();
                  if (data) {
                    setPrivateKeyData(data);
                    setShowPrivateKey(true);
                    setShowSettings(false);
                  }
                }}
                className="w-full flex items-center justify-between p-3 bg-okx-bg-primary rounded-lg border border-okx-border-primary hover:border-okx-border-secondary transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Key className="w-4 h-4 text-yellow-500" />
                  <span className="text-sm text-okx-text-primary">{tw("exportPrivateKey")}</span>
                </div>
                <svg className="w-4 h-4 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>

              {/* Disconnect */}
              <button
                onClick={() => {
                  disconnectTradingWallet();
                  setShowSettings(false);
                }}
                className="w-full py-2.5 text-sm font-medium text-okx-down hover:text-okx-down/80 border border-okx-down/50 hover:border-okx-down/70 rounded-lg transition-colors"
              >
                {tw("disconnectAccount")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Private Key Modal */}
      {showPrivateKey && privateKeyData && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-okx-bg-secondary rounded-xl w-full max-w-sm border border-okx-border-primary">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-okx-border-primary">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-yellow-500" />
                <h3 className="text-[16px] font-semibold text-okx-text-primary">{tw("privateKey")}</h3>
              </div>
              <button
                onClick={() => {
                  setShowPrivateKey(false);
                  setPrivateKeyData(null);
                }}
                className="p-1 text-okx-text-tertiary hover:text-okx-text-primary transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {/* Warning */}
              <div className="bg-red-900/20 border border-red-700/30 rounded-lg p-3">
                <p className="text-red-400 text-xs flex items-start gap-1"><svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg> {tw("privateKeyWarning")}</p>
              </div>

              {/* Private Key */}
              <div className="bg-okx-bg-primary rounded-lg p-3 border border-okx-border-primary">
                <p className="text-okx-text-primary font-mono text-xs break-all select-all">
                  {privateKeyData.privateKey}
                </p>
              </div>

              {/* 私钥对应的地址 — 用于验证 */}
              <div className="bg-okx-bg-primary rounded-lg p-3 border border-okx-border-primary">
                <p className="text-xs text-okx-text-tertiary mb-1">对应地址 (应与交易钱包一致):</p>
                <p className="text-xs text-okx-text-primary font-mono break-all">
                  {(() => {
                    try {
                      return privateKeyToAccount(privateKeyData.privateKey as `0x${string}`).address;
                    } catch {
                      return "无法解析";
                    }
                  })()}
                </p>
                {tradingWalletAddress && (() => {
                  try {
                    const derived = privateKeyToAccount(privateKeyData.privateKey as `0x${string}`).address;
                    const match = derived.toLowerCase() === tradingWalletAddress.toLowerCase();
                    return (
                      <p className={`text-xs mt-1 ${match ? "text-green-400" : "text-red-400"}`}>
                        {match ? "✓ 地址匹配" : "✗ 地址不匹配 — 请检查"}
                      </p>
                    );
                  } catch {
                    return null;
                  }
                })()}
              </div>

              {/* Copy Button */}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(privateKeyData.privateKey);
                  showToast(tc("copied"), "success");
                }}
                className="w-full py-2.5 text-sm font-medium bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition-colors"
              >
                {tw("copyPrivateKey")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Margin Mode & Leverage */}
      <div className="p-4 border-b border-okx-border-primary">
        <div className="flex gap-2 mb-3">
          <button
            disabled
            className="flex-1 py-1.5 text-xs rounded transition-colors text-okx-text-tertiary opacity-50 cursor-not-allowed relative"
            title="Coming Soon"
          >
            {t("cross") || "Cross"}
            <span className="absolute -top-1 -right-1 text-[9px] bg-okx-accent/20 text-okx-accent px-1 rounded">Soon</span>
          </button>
          <button
            onClick={() => setMarginMode("isolated")}
            className="flex-1 py-1.5 text-xs rounded transition-colors bg-okx-bg-hover text-okx-text-primary"
          >
            {t("isolated") || "Isolated"}
          </button>
        </div>

        {/* Leverage */}
        <div className="flex items-center justify-between">
          <span className="text-okx-text-secondary text-xs">
            {t("leverage") || "Leverage"}
          </span>
          <button
            onClick={() => setShowLeverageSlider(!showLeverageSlider)}
            className="flex items-center gap-1 text-sm text-okx-text-primary font-medium hover:text-meme-lime transition-colors"
          >
            {leverage}x
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>

        {/* Leverage Slider */}
        {showLeverageSlider && (
          <div className="mt-3 space-y-2">
            <input
              type="range"
              min="1"
              max="2.5"
              step="0.5"
              value={leverage}
              onChange={(e) => setLeverage(parseFloat(e.target.value))}
              className="w-full h-1 bg-okx-bg-hover rounded-lg appearance-none cursor-pointer accent-[#A3E635]"
            />
            <div className="flex justify-between text-xs text-okx-text-tertiary">
              {LEVERAGE_OPTIONS.map((lev) => (
                <button
                  key={lev}
                  onClick={() => setLeverage(lev)}
                  className={`px-1 py-0.5 rounded ${
                    leverage === lev
                      ? "text-meme-lime"
                      : "hover:text-okx-text-secondary"
                  }`}
                >
                  {lev}x
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Long/Short Tabs */}
      <div className="flex border-b border-okx-border-primary">
        <button
          onClick={() => setSide("long")}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            side === "long"
              ? "text-okx-up border-b-2 border-okx-up bg-okx-up/10"
              : "text-okx-text-tertiary hover:text-okx-text-secondary"
          }`}
        >
          {t("openLong") || "Open Long"}
        </button>
        <button
          onClick={() => setSide("short")}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            side === "short"
              ? "text-okx-down border-b-2 border-okx-down bg-okx-down/10"
              : "text-okx-text-tertiary hover:text-okx-text-secondary"
          }`}
        >
          {t("openShort") || "Open Short"}
        </button>
      </div>

      {/* Order Form */}
      <div className="p-4 space-y-3">
        {/* Order Type Tabs - 市价/限价 */}
        <div className="flex gap-1 bg-okx-bg-hover rounded p-0.5">
          <button
            onClick={() => setOrderType("market")}
            className={`flex-1 py-1.5 text-xs rounded transition-colors ${
              orderType === "market"
                ? "bg-okx-bg-primary text-okx-text-primary font-medium"
                : "text-okx-text-tertiary hover:text-okx-text-secondary"
            }`}
          >
            {t("market") || "Market"}
          </button>
          <button
            onClick={() => setOrderType("limit")}
            className={`flex-1 py-1.5 text-xs rounded transition-colors ${
              orderType === "limit"
                ? "bg-okx-bg-primary text-okx-text-primary font-medium"
                : "text-okx-text-tertiary hover:text-okx-text-secondary"
            }`}
          >
            {t("limit") || "Limit"}
          </button>
        </div>

        {/* Limit Price Input - 限价单价格 */}
        {orderType === "limit" && (
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-okx-text-tertiary">
                {t("price") || "Price"}
              </span>
              <span className="text-okx-text-tertiary">BNB</span>
            </div>
            <input
              type="text"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder="0.00"
              className="w-full bg-okx-bg-hover border border-okx-border-primary rounded px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary outline-none focus:border-meme-lime"
            />
          </div>
        )}

        {/* Amount Input - 用户可选择单位 */}
        <div>
          <div className="flex justify-between items-center text-xs mb-1">
            <span className="text-okx-text-tertiary">开仓数量</span>
            {/* 单位切换按钮 (ETH 本位) */}
            <div className="flex gap-1 bg-okx-bg-tertiary rounded p-0.5">
              {(["BNB", "TOKEN"] as const).map((unit) => (
                <button
                  key={unit}
                  onClick={() => {
                    setAmountUnit(unit);
                    setAmount(""); // 切换时清空输入
                  }}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    amountUnit === unit
                      ? "bg-meme-lime text-black font-medium"
                      : "text-okx-text-tertiary hover:text-okx-text-secondary"
                  }`}
                >
                  {unit === "TOKEN" ? "代币" : unit}
                </button>
              ))}
            </div>
          </div>
          <div className="relative">
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={
                amountUnit === "BNB" ? "输入 BNB 数量" :
                "输入代币数量"
              }
              className={`w-full bg-okx-bg-hover border rounded px-3 py-2 pr-20 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary outline-none ${
                amountError
                  ? "border-okx-down focus:border-okx-down"
                  : "border-okx-border-primary focus:border-meme-lime"
              }`}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-meme-lime font-medium">
              {amountUnit === "TOKEN" ? "代币" : amountUnit}
            </span>
          </div>
          {amountError && (
            <div className="text-xs text-okx-down mt-1">{amountError}</div>
          )}
          {/* 快捷按钮 - 根据单位显示不同选项 (ETH 本位) */}
          <div className="flex gap-2 mt-2">
            {amountUnit === "BNB" && [0.01, 0.05, 0.1, 0.5].map((val) => (
              <button
                key={val}
                onClick={() => setAmount(val.toString())}
                className="flex-1 py-1 text-xs text-okx-text-tertiary bg-okx-bg-hover rounded hover:text-okx-text-secondary transition-colors"
              >
                {val}
              </button>
            ))}
            {amountUnit === "TOKEN" && ["1K", "10K", "100K", "1M"].map((label, idx) => (
              <button
                key={label}
                onClick={() => setAmount([1000, 10000, 100000, 1000000][idx].toString())}
                className="flex-1 py-1 text-xs text-okx-text-tertiary bg-okx-bg-hover rounded hover:text-okx-text-secondary transition-colors"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* TP/SL Toggle - 止盈止损 */}
        <div>
          <button
            onClick={() => setShowTpSl(!showTpSl)}
            className="flex items-center gap-2 text-xs text-okx-text-secondary hover:text-okx-text-primary transition-colors"
          >
            <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              showTpSl ? "bg-meme-lime border-meme-lime" : "border-okx-border-primary"
            }`}>
              {showTpSl && (
                <svg className="w-3 h-3 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
            <span>TP/SL</span>
            <span className="text-xs text-okx-text-tertiary">({t("takeProfitStopLoss") || "Take Profit / Stop Loss"})</span>
          </button>

          {showTpSl && (
            <div className="mt-2 space-y-2 p-3 bg-okx-bg-hover/50 rounded border border-okx-border-primary">
              {/* Take Profit */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-okx-up">{t("takeProfit") || "Take Profit"}</span>
                  <span className="text-okx-text-tertiary">BNB</span>
                </div>
                <input
                  type="text"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  placeholder={t("tpPrice") || "TP Price"}
                  className="w-full bg-okx-bg-primary border border-okx-border-primary rounded px-3 py-1.5 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary outline-none focus:border-okx-up"
                />
              </div>
              {/* Stop Loss */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-okx-down">{t("stopLoss") || "Stop Loss"}</span>
                  <span className="text-okx-text-tertiary">BNB</span>
                </div>
                <input
                  type="text"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  placeholder={t("slPrice") || "SL Price"}
                  className="w-full bg-okx-bg-primary border border-okx-border-primary rounded px-3 py-1.5 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary outline-none focus:border-okx-down"
                />
              </div>
            </div>
          )}
        </div>

        {/* Order Summary - 仅在用户输入了数量后显示 (参考 OKX) */}
        {parseFloat(amount) > 0 && positionValueETH > 0 && (
          <div className="bg-okx-bg-hover rounded p-3 space-y-2 text-xs">
            {/* 仓位价值 (ETH 本位) */}
            <div className="flex justify-between">
              <span className="text-okx-text-tertiary">仓位价值</span>
              <span className="text-okx-text-primary">
                ≈ BNB {positionValueETH.toFixed(4)} (~${positionValueUSD.toFixed(2)})
              </span>
            </div>
            {/* 委托量 (代币数量) */}
            <div className="flex justify-between">
              <span className="text-okx-text-tertiary">委托量</span>
              <span className="text-okx-text-primary">
                {positionSizeToken >= 1000000
                  ? `${(positionSizeToken / 1000000).toFixed(2)}M`
                  : positionSizeToken >= 1000
                  ? `${(positionSizeToken / 1000).toFixed(2)}K`
                  : positionSizeToken.toFixed(2)} {tokenSymbol}
              </span>
            </div>
            {/* 所需保证金 (ETH 本位) */}
            <div className="flex justify-between">
              <span className="text-okx-text-tertiary">所需保证金</span>
              <span className="text-okx-text-primary">
                {requiredMarginDisplay}
              </span>
            </div>
            {/* 手续费 (ETH 本位) — Taker 0.05%, Maker 0.03% */}
            <div className="flex justify-between">
              <span className="text-okx-text-tertiary">{orderType === "limit" ? `${t("fee")} (Maker 0.03%)` : `${t("fee")} (Taker 0.05%)`}</span>
              <span className="text-okx-text-primary">
                BNB {(positionValueETH * (orderType === "limit" ? 0.0003 : 0.0005)).toFixed(6)}
              </span>
            </div>
            {/* 合计所需 */}
            <div className="flex justify-between border-t border-okx-border-primary pt-2">
              <span className="text-okx-text-secondary font-medium">合计所需</span>
              <span className="text-okx-text-primary font-medium">
                {requiredMarginDisplay}
              </span>
            </div>
          </div>
        )}

        {/* Info Banner */}
        <div className="bg-purple-900/20 border border-purple-500/30 rounded p-2 text-xs text-purple-300">
          {tw("p2pInfo")}
        </div>

        {/* Insufficient Balance Warning */}
        {!hasSufficientBalance && parseFloat(amount) > 0 && (
          <div className="bg-okx-down/10 border border-okx-down/30 rounded p-2 text-xs text-okx-down">
            {tw("insufficientBalance")}
          </div>
        )}

        {/* Trading Wallet Not Initialized Warning */}
        {!isTradingWalletInitialized && (
          <div className="bg-yellow-900/30 border border-yellow-500/30 rounded p-2 text-xs text-yellow-300">
            {tw("createTradingWalletFirst")}
          </div>
        )}

        {/* Perp Not Enabled Warning */}
        {!isPerpEnabled && (
          <div className="bg-yellow-900/20 border border-yellow-500/30 rounded p-2 text-xs text-yellow-400">
            {t("perpNotEnabled")}
          </div>
        )}

        {/* Submit Button */}
        <button
          onClick={handlePlaceOrder}
          disabled={
            !isPerpEnabled ||
            !amount ||
            parseFloat(amount) <= 0 ||
            isSigningOrder ||
            isSubmittingOrder ||
            isPending ||
            isConfirming ||
            (!hasSufficientBalance && parseFloat(amount) > 0) ||
            !!amountError
          }
          className={`w-full py-3 rounded font-medium text-sm transition-all ${
            !isPerpEnabled
              ? "bg-gray-600 text-gray-400"
              : side === "long"
              ? "bg-okx-up hover:bg-okx-up/90 text-white disabled:bg-okx-up/50"
              : "bg-okx-down hover:bg-okx-down/90 text-white disabled:bg-okx-down/50"
          } disabled:cursor-not-allowed`}
        >
          {!isPerpEnabled
            ? t("perpNotEnabled") || "Perp trading not enabled"
            : !isConnected
            ? tc("connectWallet") || "Connect Wallet"
            : !hasSufficientBalance && parseFloat(amount) > 0
            ? t("depositFirst") || "Deposit First"
            : isSigningOrder
            ? "Signing..."
            : isSubmittingOrder
            ? "Submitting..."
            : isPending
            ? "Pending..."
            : isConfirming
            ? "Confirming..."
            : side === "long"
            ? `${orderType === "limit" ? "Limit " : ""}${t("openLong") || "Open Long"}`
            : `${orderType === "limit" ? "Limit " : ""}${t("openShort") || "Open Short"}`}
        </button>
      </div>

      {/* Positions Section - 当前仓位 */}
      {currentTokenPositions.length > 0 && (
        <div className="p-3 border-t border-okx-border-primary">
          <div className="text-xs font-medium text-okx-text-primary mb-2">
            {t("myPositions") || "My Positions"}
          </div>
          <div className="space-y-2">
            {currentTokenPositions.map((pos) => {
              // Compute realtime price for live PnL (use spot feed if available)
              const livePrice = spotPriceBigInt ? Number(spotPriceBigInt) / 1e18 : undefined;

              return (
                <PositionRow
                  key={pos.pairId}
                  position={pos as PositionRowData}
                  variant="card"
                  realtimePrice={livePrice}
                  t={t}
                  renderActions={(p, computed) => (
                    <>
                      <button
                        onClick={() => setMarginModal({ pairId: p.pairId, action: "add", collateral: computed.collateralETH })}
                        className="py-1.5 px-2 text-xs bg-okx-bg-tertiary hover:bg-okx-up/20 text-okx-up border border-okx-up/30 rounded transition-colors"
                        title={t("adjustMargin") || "Add Margin"}
                      >
                        <Plus size={12} />
                      </button>
                      <button
                        onClick={() => setMarginModal({ pairId: p.pairId, action: "remove", collateral: computed.collateralETH })}
                        className="py-1.5 px-2 text-xs bg-okx-bg-tertiary hover:bg-okx-down/20 text-okx-down border border-okx-down/30 rounded transition-colors"
                        title={t("adjustMargin") || "Remove Margin"}
                      >
                        <Minus size={12} />
                      </button>
                      <button
                        onClick={() => setTpslModal({ pairId: p.pairId, isLong: p.isLong, entryPrice: computed.entryPrice, liqPrice: computed.liqPrice })}
                        className="py-1.5 px-2 text-[10px] text-okx-text-tertiary border border-white/[0.06] hover:text-amber-400 hover:border-amber-500/30 rounded transition-colors"
                      >
                        TP/SL
                      </button>
                      <button
                        onClick={() => handleClosePosition(p.pairId)}
                        disabled={isSubmittingOrder || isPending}
                        className="flex-1 py-1.5 text-xs bg-okx-down/80 hover:bg-okx-down text-white rounded disabled:opacity-50 transition-colors"
                      >
                        {t("marketClose") || "Close"}
                      </button>
                    </>
                  )}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Status Summary */}
      <div className="p-3 border-t border-okx-border-primary bg-okx-bg-hover/30">
        <div className="flex justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="text-okx-text-tertiary">Positions:</span>
            <span className={currentTokenPositions.length > 0 ? "text-purple-300" : "text-okx-text-tertiary"}>
              {currentTokenPositions.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-okx-text-tertiary">Pending:</span>
            <span className={pendingOrders.length > 0 ? "text-yellow-300" : "text-okx-text-tertiary"}>
              {pendingOrders.length}
            </span>
          </div>
        </div>
      </div>

      {/* 增减保证金 Modal */}
      {marginModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setMarginModal(null)}>
          <div className="bg-okx-bg-secondary rounded-lg p-5 w-80 max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-okx-text-primary mb-3">
              {marginModal.action === "add" ? "追加保证金" : "减少保证金"}
            </h3>
            <div className="text-xs text-okx-text-secondary mb-3">
              当前保证金: BNB {marginModal.collateral.toFixed(4)}
            </div>
            <input
              type="number"
              value={marginAmount}
              onChange={e => setMarginAmount(e.target.value)}
              placeholder="输入 BNB 数量"
              step="0.001"
              min="0"
              className="w-full px-3 py-2 mb-3 bg-okx-bg-primary border border-okx-border-primary rounded text-sm text-okx-text-primary outline-none focus:border-okx-brand"
            />
            <div className="flex gap-2 mb-3">
              {[0.005, 0.01, 0.05, 0.1].map(v => (
                <button
                  key={v}
                  onClick={() => setMarginAmount(v.toString())}
                  className="flex-1 py-1 text-xs border border-okx-border-primary rounded hover:bg-okx-bg-hover text-okx-text-secondary"
                >
                  {v}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setMarginModal(null); setMarginAmount(""); }}
                className="flex-1 py-2 text-xs border border-okx-border-primary rounded text-okx-text-secondary hover:bg-okx-bg-hover"
              >
                取消
              </button>
              <button
                onClick={handleAdjustMargin}
                disabled={isAdjustingMargin || !marginAmount}
                className={`flex-1 py-2 text-xs text-white rounded disabled:opacity-50 ${
                  marginModal.action === "add" ? "bg-okx-up hover:bg-okx-up/80" : "bg-okx-down hover:bg-okx-down/80"
                }`}
              >
                {isAdjustingMargin ? "处理中..." : marginModal.action === "add" ? "追加" : "减少"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TP/SL Modal */}
      {tpslModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => setTpslModal(null)}>
          <div className="bg-[#1b1d28] rounded-xl w-[380px] max-w-[92vw] shadow-2xl border border-white/[0.06]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06]">
              <h3 className="text-sm font-medium text-okx-text-primary">{t("takeProfitStopLoss") || "TP/SL"}</h3>
              <button onClick={() => setTpslModal(null)} className="text-okx-text-tertiary hover:text-okx-text-primary text-lg">×</button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-emerald-400 font-medium">{t("takeProfit") || "Take Profit"}</span>
                  {currentTpsl?.takeProfitPrice && (
                    <button onClick={() => handleCancelTpsl("tp")} className="text-[10px] text-okx-text-tertiary hover:text-rose-400 transition-colors">
                      {t("cancel") || "Cancel"}
                    </button>
                  )}
                </div>
                <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 focus-within:border-emerald-500/40 transition-colors">
                  <input type="number" value={tpInput} onChange={e => setTpInput(e.target.value)}
                    placeholder={tpslModal.isLong ? `> ${formatSmallPrice(tpslModal.entryPrice)}` : `< ${formatSmallPrice(tpslModal.entryPrice)}`}
                    step="any" className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary/50" />
                  <span className="text-[10px] text-okx-text-tertiary ml-2">BNB</span>
                </div>
                <div className="text-[10px] text-okx-text-tertiary mt-1 px-1">
                  {tpslModal.isLong ? t("tpHintLong") || "Trigger when price rises above" : t("tpHintShort") || "Trigger when price falls below"}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-rose-400 font-medium">{t("stopLoss") || "Stop Loss"}</span>
                  {currentTpsl?.stopLossPrice && (
                    <button onClick={() => handleCancelTpsl("sl")} className="text-[10px] text-okx-text-tertiary hover:text-rose-400 transition-colors">
                      {t("cancel") || "Cancel"}
                    </button>
                  )}
                </div>
                <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 focus-within:border-rose-500/40 transition-colors">
                  <input type="number" value={slInput} onChange={e => setSlInput(e.target.value)}
                    placeholder={tpslModal.isLong ? `< ${formatSmallPrice(tpslModal.entryPrice)}` : `> ${formatSmallPrice(tpslModal.entryPrice)}`}
                    step="any" className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary/50" />
                  <span className="text-[10px] text-okx-text-tertiary ml-2">BNB</span>
                </div>
                <div className="text-[10px] text-okx-text-tertiary mt-1 px-1">
                  {tpslModal.isLong ? t("slHintLong") || "Trigger when price falls below" : t("slHintShort") || "Trigger when price rises above"}
                </div>
              </div>
              <div className="bg-white/[0.02] rounded-lg p-3 text-[10px] text-okx-text-tertiary space-y-1">
                <div className="flex justify-between">
                  <span>{t("entryAvg") || "Entry Price"}</span>
                  <span className="text-okx-text-secondary font-mono">{formatSmallPrice(tpslModal.entryPrice)}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t("liqPrice") || "Liq. Price"}</span>
                  <span className="text-rose-400/70 font-mono">{formatSmallPrice(tpslModal.liqPrice)}</span>
                </div>
              </div>
              <div className="flex gap-2">
                {(currentTpsl?.takeProfitPrice || currentTpsl?.stopLossPrice) && (
                  <button onClick={() => handleCancelTpsl("both")}
                    className="flex-1 py-2.5 text-sm font-medium rounded-lg border border-white/[0.08] text-okx-text-secondary hover:bg-white/[0.04] transition-colors">
                    {t("cancelAll") || "Cancel All"}
                  </button>
                )}
                <button onClick={handleSetTpsl} disabled={isSettingTpsl || (!tpInput && !slInput)}
                  className="flex-1 py-2.5 text-sm font-medium rounded-lg bg-amber-500 hover:bg-amber-400 text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  {isSettingTpsl ? (t("processing") || "Processing...") : (t("confirm") || "Confirm")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
