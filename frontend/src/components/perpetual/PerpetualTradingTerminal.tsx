"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatEther, formatUnits, type Address } from "viem";
import dynamic from "next/dynamic";
// V2 架构：使用 Settlement 合约 + 撮合引擎的用户对赌模式
import { PerpetualOrderPanelV2 } from "./PerpetualOrderPanelV2";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { AccountBalance } from "@/components/common/AccountBalance";
import { useUnifiedWebSocket } from "@/hooks/common/useUnifiedWebSocket";
import { OrderBook } from "@/components/common/OrderBook";
import { LiquidationHeatmap } from "./LiquidationHeatmap";
import { AllPositions } from "./AllPositions";
import { HunterLeaderboard } from "@/components/spot/HunterLeaderboard";
import { RiskPanel } from "./RiskPanel";
import { useTradingDataStore, useWsStatus, useCurrentOrderBook, useCurrentRecentTrades, type TokenStats, type FundingRateInfo } from "@/lib/stores/tradingDataStore";
import { useTokenInfo, getTokenDisplayName } from "@/hooks/common/useTokenInfo";
import { usePoolState, calculatePriceUsd, calculateMarketCapUsd } from "@/hooks/spot/usePoolState";
import { useToast } from "@/components/shared/Toast";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { cancelOrder, getOrderHistory, getTradeHistory, type HistoricalOrder, type PerpTradeRecord } from "@/utils/orderSigning";
import { useRiskControl } from "@/hooks/perpetual/useRiskControl";
import { useApiError } from "@/hooks/common/useApiError";
import { trackRender } from "@/lib/debug-render";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { AnimatedNumber } from "@/components/shared/AnimatedNumber";
import { TradingErrorBoundary } from "@/components/shared/TradingErrorBoundary";

// P003 修复: 统一使用 V2 架构（Settlement 合约 + 撮合引擎）
// 移除旧的 PositionManager 合约依赖，仓位数据统一从撮合引擎获取

// Dynamically import chart to avoid SSR issues
// 永续合约使用专用图表组件（从撮合引擎获取数据）
const PerpetualPriceChart = dynamic(
  () => import("./PerpetualPriceChart").then((mod) => mod.PerpetualPriceChart),
  {
    ssr: false,
    loading: () => <div className="w-full h-full bg-okx-bg-card animate-pulse" />,
  }
);

// 用 React.memo 包装图表组件，只在 props 真正变化时重新渲染
// 防止父组件因为倒计时等频繁状态更新导致图表闪烁
const MemoizedPriceChart = React.memo(PerpetualPriceChart);

interface PerpetualTradingTerminalProps {
  symbol: string;
  className?: string;
  tokenAddress?: Address; // Token contract address for multi-token support
}

export function PerpetualTradingTerminal({
  symbol,
  className,
  tokenAddress: propTokenAddress,
}: PerpetualTradingTerminalProps) {
  // 调试：追踪渲染次数 (仅 console 警告，不 throw)
  trackRender("PerpetualTradingTerminal");

  const t = useTranslations("perp");
  const tc = useTranslations("common");
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();

  // 获取交易钱包（派生钱包）信息
  const {
    address: tradingWalletAddress,
    getSignature,
    isInitialized: isTradingWalletInitialized,
    exportKey,
  } = useTradingWallet();

  // 获取交易钱包签名（用于派生私钥）
  const tradingWalletSignature = getSignature();

  // Get token address - use prop if provided, otherwise try to parse from symbol
  const tokenAddress = useMemo(() => {
    if (propTokenAddress) return propTokenAddress;
    if (symbol.startsWith("0x") && symbol.length === 42) return symbol as Address;
    return undefined;
  }, [propTokenAddress, symbol]);

  // Get ETH price for USD calculations
  const { price: ethPrice } = useETHPrice();

  // Get pool state to check if perpetual trading is enabled AND get spot price
  const { poolState, currentPrice: spotPriceBigInt, marketCap: marketCapBigInt, isLoading: isPoolLoading } = usePoolState(tokenAddress);
  const isPerpEnabled = poolState?.perpEnabled ?? false;

  // Calculate spot price in USD (from TokenFactory bonding curve)
  const spotPriceUsd = spotPriceBigInt ? calculatePriceUsd(spotPriceBigInt, ethPrice) : 0;
  const marketCapUsd = marketCapBigInt ? calculateMarketCapUsd(marketCapBigInt, ethPrice) : 0;

  // V2: 使用 Settlement 合约获取仓位和订单
  // 传递交易钱包地址和签名，确保查询正确的订单
  const {
    positions: v2Positions,
    pendingOrders: v2PendingOrders,
    balance: accountBalance,
    closePair,
    refreshPositions,
    refreshOrders,
    refreshBalance,
  } = usePerpetualV2({
    tradingWalletAddress: tradingWalletAddress || undefined,
    tradingWalletSignature: tradingWalletSignature || undefined,
  });

  // 格式化账户余额 (BNB 本位)
  // 显示: Settlement 可用 + 钱包可存入 (下单时自动存入 Settlement)
  const formattedAccountBalance = useMemo(() => {
    if (!accountBalance) return "BNB 0.00";
    const settlementAvailable = Number(accountBalance.available) / 1e18;
    const walletETH = accountBalance.walletBalance ? Number(accountBalance.walletBalance) / 1e18 : 0;
    const gasReserve = 0.001;
    const usableWalletETH = walletETH > gasReserve ? walletETH - gasReserve : 0;
    const totalAvailable = settlementAvailable + usableWalletETH;
    return `BNB ${totalAvailable.toFixed(4)}`;
  }, [accountBalance]);

  // WebSocket 实时订单簿和成交数据 - 从统一的 tradingDataStore 获取
  const wsOrderBook = useCurrentOrderBook();
  const wsRecentTrades = useCurrentRecentTrades();

  // 从 Store 获取实时统计数据 (WebSocket 推送)
  const tokenStats = useTradingDataStore((state) =>
    tokenAddress ? state.tokenStats.get(tokenAddress.toLowerCase() as Address) : null
  );

  // 从 Store 获取资金费率 (WebSocket 推送)
  const fundingRateData = useTradingDataStore((state) =>
    tokenAddress ? state.fundingRates.get(tokenAddress.toLowerCase() as Address) : null
  );

  // 格式化统计数据 (BNB 本位: 价格为 BNB/Token, 1e18 精度)
  const formatMemePrice = (priceStr: string | undefined) => {
    if (!priceStr) return "0.0000000000";
    const price = Number(priceStr) / 1e18;
    if (price === 0) return "0.0000000000";
    if (price < 0.000001) return price.toFixed(10);
    if (price < 0.0001) return price.toFixed(8);
    if (price < 0.01) return price.toFixed(6);
    return price.toFixed(4);
  };

  // Number-based format for AnimatedNumber (price already divided by 1e18)
  const formatMemePriceNum = useCallback((price: number) => {
    if (price === 0) return "0.0000000000";
    if (price < 0.000001) return price.toFixed(10);
    if (price < 0.0001) return price.toFixed(8);
    if (price < 0.01) return price.toFixed(6);
    return price.toFixed(4);
  }, []);

  const formattedPrice = formatMemePrice(tokenStats?.lastPrice);
  // ✅ 使用 priceChangePercent24h (后端已计算好的百分比)，而非 priceChange24h (原始 wei 差值)
  // 注意: JSX 模板 (L573) 自带 "+" 前缀，此处不重复添加
  const priceChangePercent = parseFloat(tokenStats?.priceChangePercent24h || "0");
  const formattedPriceChange = `${priceChangePercent.toFixed(2)}%`;
  const isPriceUp = priceChangePercent >= 0;
  // 24h 高低价：有 WS 数据用 WS，否则 fallback 到 spot 价格
  const formattedHigh24h = (tokenStats?.high24h && tokenStats.high24h !== "0")
    ? formatMemePrice(tokenStats.high24h)
    : spotPriceBigInt ? formatMemePrice(spotPriceBigInt.toString()) : "0.0000000000";
  const formattedLow24h = (tokenStats?.low24h && tokenStats.low24h !== "0")
    ? formatMemePrice(tokenStats.low24h)
    : spotPriceBigInt ? formatMemePrice(spotPriceBigInt.toString()) : "0.0000000000";
  // volume24h 是 BNB 成交量 (BNB 本位: 1e18 精度)
  // 后端计算: volume24h = Σ(trade.size * trade.price) / 1e18
  const formattedVolume24h = tokenStats?.volume24h
    ? (Number(tokenStats.volume24h) / 1e18).toFixed(4)
    : "0.0000";
  const formattedOpenInterest = tokenStats?.openInterest
    ? (Number(tokenStats.openInterest) / 1e18).toFixed(4)
    : "0.0000";
  const trades24h = tokenStats?.trades24h ?? 0;

  // 格式化资金费率 (使用 ref 防止微小变化导致频繁跳动)
  const lastDisplayedRate = React.useRef<string>("0.0000%");
  const lastRateValue = React.useRef<number>(0);

  const fundingRateFormatted = useMemo(() => {
    if (!fundingRateData?.rate) return lastDisplayedRate.current;
    const rate = Number(fundingRateData.rate) / 100;
    // 只有变化超过 0.0001% (1bp) 才更新显示，避免微小波动导致跳动
    if (Math.abs(rate - lastRateValue.current) < 0.0001) {
      return lastDisplayedRate.current;
    }
    lastRateValue.current = rate;
    const sign = rate >= 0 ? "+" : "";
    const formatted = `${sign}${rate.toFixed(4)}%`;
    lastDisplayedRate.current = formatted;
    return formatted;
  }, [fundingRateData?.rate]);

  const isFundingPositive = useMemo(() => {
    if (!fundingRateData?.rate) return true;
    return Number(fundingRateData.rate) >= 0;
  }, [fundingRateData?.rate]);

  // 资金费率倒计时 — 使用引擎推送的 nextFundingTime，到期后自动推进到下一个周期
  const [fundingCountdown, setFundingCountdown] = useState<string>("--:--");
  useEffect(() => {
    const FUNDING_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (match engine FUNDING.BASE_INTERVAL_MS)
    let nextTime = fundingRateData?.nextFundingTime ||
      Math.ceil(Date.now() / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;

    const updateCountdown = () => {
      const now = Date.now();
      // Auto-advance to next period when countdown expires
      while (nextTime <= now) {
        nextTime += FUNDING_INTERVAL_MS;
      }
      const diff = nextTime - now;
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      setFundingCountdown(`${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`);
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [fundingRateData?.nextFundingTime]);

  // 使用统一 WebSocket 进行实时数据推送
  // 不再使用轮询，由 WebSocket 推送仓位和订单变更
  const { isConnected: unifiedWsConnected } = useUnifiedWebSocket({
    token: tokenAddress,
    trader: tradingWalletAddress || address,
    enabled: !!tokenAddress,
  });

  // 仅在初始化时获取一次仓位和订单，后续由 WebSocket 推送
  useEffect(() => {
    const effectiveAddress = tradingWalletAddress || address;
    if (!effectiveAddress) return;

    // 初始加载
    refreshPositions();
    refreshOrders();
    // 不再设置定时器，依赖 WebSocket 实时推送
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradingWalletAddress, address]); // 只依赖地址变化，避免函数引用变化导致无限循环

  // Tab 状态 - 需要在使用它的 useEffect 之前声明
  const [activeBottomTab, setActiveBottomTab] = useState<
    "positions" | "openOrders" | "orderHistory" | "tradeHistory" | "hunting" | "risk" | "bills"
  >("positions");

  // Mobile responsive: section switcher for Chart/Book/Trade (only used < md breakpoint)
  const [mobileActiveSection, setMobileActiveSection] = useState<"chart" | "book" | "trade">("chart");
  const [orderBookSuggestedPrice, setOrderBookSuggestedPrice] = useState<string>("");

  // 订单历史和成交记录状态
  const [orderHistoryData, setOrderHistoryData] = useState<HistoricalOrder[]>([]);
  const [tradeHistoryData, setTradeHistoryData] = useState<PerpTradeRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // 错误处理
  const { withErrorHandling } = useApiError();

  // ── 保证金调整 (Add/Remove Margin) ──────────────────
  const [marginModal, setMarginModal] = useState<{
    pairId: string;
    action: "add" | "remove";
    collateral: number;
    size: number;
    entryPrice: number;
    isLong: boolean;
    leverage: number;
    mmr: number;
  } | null>(null);
  const [marginAmount, setMarginAmount] = useState("");
  const [isAdjustingMargin, setIsAdjustingMargin] = useState(false);
  const [marginInfo, setMarginInfo] = useState<{
    maxRemovable: number;
    minCollateral: number;
  } | null>(null);

  // 打开保证金调整弹窗时，获取最大可减额
  useEffect(() => {
    if (!marginModal) { setMarginInfo(null); return; }
    if (marginModal.action !== "remove") { setMarginInfo(null); return; }
    fetch(`${MATCHING_ENGINE_URL}/api/position/${marginModal.pairId}/margin`)
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setMarginInfo({
            maxRemovable: parseFloat(data.maxRemovable || "0") / 1e18,
            minCollateral: parseFloat(data.minCollateral || "0") / 1e18,
          });
        }
      })
      .catch(() => {});
  }, [marginModal?.pairId, marginModal?.action]);

  // 预览调整后的杠杆和强平价
  const marginPreview = useMemo(() => {
    if (!marginModal || !marginAmount || parseFloat(marginAmount) <= 0) return null;
    const amt = parseFloat(marginAmount);
    const newCollateral = marginModal.action === "add"
      ? marginModal.collateral + amt
      : Math.max(0, marginModal.collateral - amt);
    if (newCollateral <= 0) return null;
    const newLeverage = marginModal.size / newCollateral;
    const mmrDecimal = marginModal.mmr / 100;
    // Bybit 标准强平价
    const newLiqPrice = marginModal.isLong
      ? marginModal.entryPrice * (1 - 1/newLeverage + mmrDecimal/100)
      : marginModal.entryPrice * (1 + 1/newLeverage - mmrDecimal/100);
    return { newCollateral, newLeverage, newLiqPrice };
  }, [marginModal, marginAmount]);

  // 提交保证金调整
  const handleAdjustMargin = useCallback(async () => {
    if (!marginModal || !marginAmount || !tradingWalletAddress) return;
    // 使用 parseEther 避免 parseFloat 精度问题 (FE-C02)
    const { parseEther: toWei } = await import("viem");
    let amountWei: string;
    try {
      amountWei = toWei(marginAmount).toString();
    } catch {
      showToast(t("invalidAmount") || "Invalid amount", "error");
      return;
    }
    if (BigInt(amountWei) <= 0n) {
      showToast(t("invalidAmount") || "Invalid amount", "error");
      return;
    }

    setIsAdjustingMargin(true);
    try {
      const { pairId, action } = marginModal;
      const sigMsg = action === "add"
        ? `Add margin ${amountWei} to ${pairId} for ${tradingWalletAddress.toLowerCase()}`
        : `Remove margin ${amountWei} from ${pairId} for ${tradingWalletAddress.toLowerCase()}`;

      const keyData = exportKey?.();
      if (!keyData?.privateKey) {
        showToast(t("tradingWalletNotActive") || "Trading wallet not active", "error");
        return;
      }
      const { privateKeyToAccount } = await import("viem/accounts");
      const { createWalletClient, http } = await import("viem");
      const { bscTestnet } = await import("viem/chains");
      const signerAccount = privateKeyToAccount(keyData.privateKey);
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
        showToast(
          action === "add"
            ? (t("marginAdded") || "Margin added successfully")
            : (t("marginRemoved") || "Margin removed successfully"),
          "success"
        );
        setMarginModal(null);
        setMarginAmount("");
        refreshPositions();
        refreshBalance();
      } else {
        showToast(data.error || (t("operationFailed") || "Operation failed"), "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : (t("operationFailed") || "Operation failed"), "error");
    } finally {
      setIsAdjustingMargin(false);
    }
  }, [marginModal, marginAmount, tradingWalletAddress, exportKey, showToast, t, refreshPositions, refreshBalance]);

  // ── TP/SL 弹窗 (止盈止损) ──────────────────────────
  const [tpslModal, setTpslModal] = useState<{
    pairId: string;
    isLong: boolean;
    entryPrice: number;
    liqPrice: number;
  } | null>(null);
  const [tpInput, setTpInput] = useState("");
  const [slInput, setSlInput] = useState("");
  const [isSettingTpsl, setIsSettingTpsl] = useState(false);
  const [currentTpsl, setCurrentTpsl] = useState<{
    takeProfitPrice: string | null;
    stopLossPrice: string | null;
  } | null>(null);

  // 打开弹窗时获取当前 TP/SL
  useEffect(() => {
    if (!tpslModal) { setCurrentTpsl(null); setTpInput(""); setSlInput(""); return; }
    fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`)
      .then(r => r.json())
      .then(data => {
        if (data.hasTPSL) {
          setCurrentTpsl({
            takeProfitPrice: data.takeProfitPrice,
            stopLossPrice: data.stopLossPrice,
          });
          if (data.takeProfitPrice) setTpInput((Number(data.takeProfitPrice) / 1e18).toString());
          if (data.stopLossPrice) setSlInput((Number(data.stopLossPrice) / 1e18).toString());
        }
      })
      .catch(() => {});
  }, [tpslModal?.pairId]);

  // 提交 TP/SL
  const handleSetTpsl = useCallback(async () => {
    if (!tpslModal || !tradingWalletAddress) return;
    if (!tpInput && !slInput) {
      showToast(t("tpslRequired") || "Please set at least TP or SL", "error");
      return;
    }
    setIsSettingTpsl(true);
    try {
      const { parseEther: toWei } = await import("viem");
      const tpWei = tpInput ? toWei(tpInput).toString() : null;
      const slWei = slInput ? toWei(slInput).toString() : null;

      const sigMsg = `Set TPSL ${tpslModal.pairId} for ${tradingWalletAddress.toLowerCase()}`;
      const keyData = exportKey?.();
      if (!keyData?.privateKey) {
        showToast(t("tradingWalletNotActive") || "Trading wallet not active", "error");
        return;
      }
      const { privateKeyToAccount } = await import("viem/accounts");
      const { createWalletClient, http } = await import("viem");
      const { bscTestnet } = await import("viem/chains");
      const signerAccount = privateKeyToAccount(keyData.privateKey);
      const tempClient = createWalletClient({ account: signerAccount, chain: bscTestnet, transport: http() });
      const signature = await tempClient.signMessage({ account: signerAccount, message: sigMsg });

      const res = await fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trader: tradingWalletAddress,
          signature,
          takeProfitPrice: tpWei,
          stopLossPrice: slWei,
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(t("tpslSet") || "TP/SL set successfully", "success");
        setTpslModal(null);
        refreshPositions();
      } else {
        showToast(data.error || (t("operationFailed") || "Operation failed"), "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : (t("operationFailed") || "Operation failed"), "error");
    } finally {
      setIsSettingTpsl(false);
    }
  }, [tpslModal, tpInput, slInput, tradingWalletAddress, exportKey, showToast, t, refreshPositions]);

  // 取消 TP/SL
  const handleCancelTpsl = useCallback(async (cancelType: "tp" | "sl" | "both") => {
    if (!tpslModal) return;
    try {
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/position/${tpslModal.pairId}/tpsl`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancelType }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(t("tpslCancelled") || "TP/SL cancelled", "success");
        if (cancelType === "both") { setTpslModal(null); }
        else if (cancelType === "tp") { setTpInput(""); setCurrentTpsl(prev => prev ? { ...prev, takeProfitPrice: null } : null); }
        else { setSlInput(""); setCurrentTpsl(prev => prev ? { ...prev, stopLossPrice: null } : null); }
        refreshPositions();
      }
    } catch {}
  }, [tpslModal, showToast, t, refreshPositions]);

  // 加载订单历史和成交记录
  const loadHistoryData = useCallback(async () => {
    const effectiveAddress = tradingWalletAddress || address;
    if (!effectiveAddress) return;

    setIsLoadingHistory(true);
    try {
      const [orders, trades] = await Promise.all([
        withErrorHandling(
          () => getOrderHistory(effectiveAddress, 50),
          "获取订单历史失败",
          { fallback: [], showToast: false }
        ),
        withErrorHandling(
          () => getTradeHistory(effectiveAddress, 50),
          "获取成交记录失败",
          { fallback: [], showToast: false }
        ),
      ]);
      setOrderHistoryData(orders || []);
      setTradeHistoryData(trades || []);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [tradingWalletAddress, address, withErrorHandling]);

  // 当切换到历史 Tab 时加载数据 + 自动刷新
  useEffect(() => {
    if (activeBottomTab === "orderHistory" || activeBottomTab === "tradeHistory") {
      loadHistoryData();
      // Auto-refresh every 15s while tab is active
      const interval = setInterval(loadHistoryData, 15_000);
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBottomTab]); // 只依赖 activeBottomTab，避免 loadHistoryData 引用变化导致无限循环

  // ── Bills (账单) state ──
  interface BillRecord {
    id: string;
    txHash: string | null;
    type: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    onChainStatus: string;
    proofData: string;
    positionId?: string;
    orderId?: string;
    createdAt: number;
  }

  const BILL_TYPE_LABELS: Record<string, { label: string; color: string }> = {
    DEPOSIT:             { label: t("billDeposit"),          color: "text-okx-up" },
    WITHDRAW:            { label: t("billWithdraw"),         color: "text-okx-down" },
    SETTLE_PNL:          { label: t("billSettlePnl"),        color: "" },
    FUNDING_FEE:         { label: t("billFundingFee"),       color: "" },
    LIQUIDATION:         { label: t("billLiquidation"),      color: "text-okx-down" },
    MARGIN_ADD:          { label: t("billMarginAdd"),        color: "text-okx-down" },
    MARGIN_REMOVE:       { label: t("billMarginRemove"),     color: "text-okx-up" },
    DAILY_SETTLEMENT:    { label: t("billDailySettlement"),  color: "" },
    INSURANCE_INJECTION: { label: t("billInsurance"),        color: "text-okx-up" },
    TRADING_FEE:         { label: t("billTradingFee") || "Trading Fee", color: "text-okx-down" },
    ADL:                 { label: "ADL",                     color: "text-orange-400" },
  };

  const BILL_TYPE_FILTERS = [
    { value: "all",                  label: t("billFilterAll") },
    { value: "DEPOSIT",              label: t("billDeposit") },
    { value: "WITHDRAW",             label: t("billWithdraw") },
    { value: "SETTLE_PNL",           label: t("billSettlePnl") },
    { value: "LIQUIDATION",          label: t("billLiquidation") },
    { value: "FUNDING_FEE",          label: t("billFundingFee") },
    { value: "INSURANCE_INJECTION",  label: t("billInsurance") },
    { value: "TRADING_FEE",          label: t("billTradingFee") || "Trading Fee" },
    { value: "ADL",                  label: "ADL" },
    { value: "MARGIN_ADD",           label: t("billMarginAdd") || "Margin Add" },
    { value: "MARGIN_REMOVE",        label: t("billMarginRemove") || "Margin Remove" },
  ];

  const [billsData, setBillsData] = useState<BillRecord[]>([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [billTypeFilter, setBillTypeFilter] = useState("all");
  const [billsHasMore, setBillsHasMore] = useState(true);

  const fetchBills = useCallback(async (before?: number) => {
    const effectiveAddress = tradingWalletAddress || address;
    if (!effectiveAddress) return;
    setBillsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (billTypeFilter !== "all") params.set("type", billTypeFilter);
      if (before) params.set("before", before.toString());
      const res = await fetch(
        `${MATCHING_ENGINE_URL}/api/user/${effectiveAddress}/bills?${params}`
      );
      const data = await res.json();
      const newBills: BillRecord[] = Array.isArray(data) ? data : [];
      if (before) {
        setBillsData(prev => [...prev, ...newBills]);
      } else {
        setBillsData(newBills);
      }
      setBillsHasMore(newBills.length >= 50);
    } catch {
      if (!before) setBillsData([]);
    } finally {
      setBillsLoading(false);
    }
  }, [tradingWalletAddress, address, billTypeFilter]);

  // 切换到账单 Tab 或筛选变化时重新加载
  useEffect(() => {
    if (activeBottomTab === "bills") {
      setBillsData([]);
      setBillsHasMore(true);
      fetchBills();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBottomTab, billTypeFilter]);

  const loadMoreBills = useCallback(() => {
    if (billsData.length === 0 || !billsHasMore || billsLoading) return;
    fetchBills(billsData[billsData.length - 1].createdAt);
  }, [billsData, billsHasMore, billsLoading, fetchBills]);

  // 当前代币的 V2 仓位 (HTTP 轮询的数据 - 用于平仓等操作)
  const currentV2Positions = useMemo(() => {
    if (!tokenAddress) return [];
    return v2Positions.filter(
      (p) => p.token.toLowerCase() === tokenAddress.toLowerCase()
    );
  }, [v2Positions, tokenAddress]);

  // Contract write for closing position
  const { writeContract, data: txHash, isPending: isWritePending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // P003 修复: 移除旧的 PositionManager 合约调用
  // V2 架构使用 Settlement 合约 + 撮合引擎，仓位数据统一从 usePerpetualV2 获取

  // Handle close position success
  useEffect(() => {
    if (isConfirmed && txHash) {
      showToast(t("orderPlaced"), "success");
      refreshPositions(); // 使用 V2 的 refreshPositions
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfirmed, txHash]); // 只依赖交易状态，避免函数引用导致无限循环

  // 从链上获取代币名称和符号
  const tokenInfo = useTokenInfo(symbol);
  const displaySymbol = getTokenDisplayName(symbol, tokenInfo);

  // 使用 useMemo 避免 instId 因为 loading 状态变化而改变
  const instId = useMemo(() => {
    // 只在有实际符号时才创建 instId，避免加载状态导致的变化
    if (tokenInfo?.isLoading || !displaySymbol || displaySymbol === "...") {
      // 使用 symbol 作为 fallback，而不是 loading indicator
      return `${symbol.toUpperCase()}-PERP`;
    }
    return `${displaySymbol.toUpperCase()}-PERP`;
  }, [symbol, tokenInfo?.symbol]); // 只依赖实际的符号，不依赖 loading 状态

  // 风控数据
  const {
    alerts: riskAlerts,
    insuranceFund,
    positionRisks,
    clearAlerts: clearRiskAlerts,
  } = useRiskControl({
    trader: tradingWalletAddress || address,
    token: tokenAddress,
  });

  // 计算整体风险等级
  const overallRisk = positionRisks.reduce((worst, pos) => {
    const levels = ["low", "medium", "high", "critical"];
    return levels.indexOf(pos.riskLevel) > levels.indexOf(worst) ? pos.riskLevel : worst;
  }, "low" as "low" | "medium" | "high" | "critical");

  // ============================================================
  // 使用 useRiskControl 的实时推送仓位数据来渲染
  // 后端每100ms计算一次，通过 WebSocket 实时推送
  // ============================================================
  const currentPositionsForDisplay = useMemo(() => {
    if (!tokenAddress) return [];
    // 优先使用 WebSocket 推送的 positionRisks 数据
    // 这些数据包含了后端实时计算的 markPrice, unrealizedPnL, marginRatio, roe 等
    const wsPositions = positionRisks.filter(
      (p) => p.token.toLowerCase() === tokenAddress.toLowerCase()
    );
    if (wsPositions.length > 0) {
      return wsPositions;
    }
    // 如果 WebSocket 没有数据，回退到 HTTP 轮询数据
    return currentV2Positions;
  }, [tokenAddress, positionRisks, currentV2Positions]);

  // 账户余额面板状态
  const [showAccountPanel, setShowAccountPanel] = useState(false);

  // 撤单状态
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);

  // 撤单处理函数
  const handleCancelOrder = async (orderId: string) => {
    if (!tradingWalletAddress || !tradingWalletSignature) {
      showToast(t("connectWallet"), "error");
      return;
    }

    setCancellingOrderId(orderId);
    try {
      const result = await cancelOrder(
        orderId,
        tradingWalletAddress,
        tradingWalletSignature
      );

      if (result.success) {
        showToast(t("cancelOrder") + " ✓", "success");
        // 刷新订单列表
        refreshOrders();
      } else {
        showToast(result.error || t("orderFailed"), "error");
      }
    } catch (error) {
      console.error("Cancel order error:", error);
      showToast(t("orderFailed"), "error");
    } finally {
      setCancellingOrderId(null);
    }
  };

  // Helper function to format small prices
  const formatSmallPrice = (price: number): string => {
    if (price <= 0) return "0.00";
    if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 1 });
    if (price >= 0.01) return price.toFixed(4);
    if (price >= 0.0001) return price.toFixed(6);
    if (price >= 0.000001) return price.toFixed(8);
    // For very small numbers, use subscript notation
    const priceStr = price.toFixed(18);
    const match = priceStr.match(/^0\.(0*)([1-9]\d*)/);
    if (match) {
      const zeroCount = match[1].length;
      const significantDigits = match[2].slice(0, 5);
      const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
      const subscriptNum = zeroCount.toString().split("").map((d) => subscripts[parseInt(d)]).join("");
      return `0.0${subscriptNum}${significantDigits}`;
    }
    return price.toFixed(10);
  };

  // Market info — 优先使用后端 WebSocket 推送的 lastPrice (和订单簿同源，避免前后端 ETH/USD 汇率差异)
  // 只有在 WebSocket 数据不可用时才回退到前端直接读链上价格
  // BNB 本位: 价格是 Token/BNB 比率，OI/Volume 用 BNB
  // ⚠️ 注意: fundingCountdown 每秒更新，不放入 marketInfo 避免整个对象每秒重建导致 K 线抖动
  const marketInfo = useMemo(
    () => ({
      fundingRate: fundingRateFormatted,
      openInterest: `BNB ${formattedOpenInterest}`,
      volume24h: `BNB ${formattedVolume24h}`,
      high24h: formattedHigh24h,    // Token/BNB 比率，无货币符号
      low24h: formattedLow24h,      // Token/BNB 比率，无货币符号
      currentPrice: formattedPrice !== "0.0000000000"
        ? formattedPrice                                    // 优先: 后端 WebSocket lastPrice (Token/BNB)
        : spotPriceUsd > 0
        ? formatSmallPrice(spotPriceUsd)                    // 回退: 前端直读链上价格
        : formattedPrice,
      spotPrice: spotPriceUsd,
      marketCap: marketCapUsd,
      priceChange: formattedPriceChange,
      isPriceUp,
      trades24h,
    }),
    [fundingRateFormatted, formattedOpenInterest, formattedVolume24h, formattedHigh24h, formattedLow24h, formattedPrice, formattedPriceChange, isPriceUp, trades24h, spotPriceUsd, marketCapUsd]
  );

  // K 线图表的价格 prop — 单独 memoize，避免随父组件其他状态变化重建
  // AUDIT-FIX FC-C03: chartPrice 应统一使用 BNB 计价
  // 之前 fallback 用 spotPriceUsd (USD)，但 chart 期望 BNB 计价 → 价格 inflated ~600x
  const chartPrice = useMemo(() => {
    if (tokenStats?.lastPrice) {
      return Number(tokenStats.lastPrice) / 1e18;
    }
    // Fallback: 使用 spotPriceBigInt (BNB 计价, 1e18 精度)
    if (spotPriceBigInt) {
      return Number(spotPriceBigInt) / 1e18;
    }
    return undefined;
  }, [tokenStats?.lastPrice, spotPriceBigInt]);

  return (
    <div
      className={`flex flex-col bg-okx-bg-primary min-h-screen text-okx-text-primary ${className}`}
    >
      {/* Top Bar — Responsive: Row 1 always visible, Row 2 (stats) scrollable on mobile */}
      <div className="bg-okx-bg-secondary border-b border-okx-border-primary">
        {/* Row 1: Symbol + Price + Change + Account */}
        <div className="h-12 md:h-14 flex items-center px-3 md:px-4 gap-2 md:gap-6">
          {/* Symbol */}
          <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">
            <span className="text-sm md:text-[16px] font-bold font-mono text-okx-text-primary">
              {displaySymbol.toUpperCase()}/BNB
            </span>
            <span className="text-xs font-medium px-1.5 py-0.5 rounded-sm bg-okx-bg-hover text-okx-text-secondary">
              {t("perpetualLabel")}
            </span>
            <span className="text-xs font-bold font-mono px-1.5 py-0.5 rounded-sm bg-okx-accent/[0.13] text-okx-accent">
              2.5x
            </span>
          </div>

          {/* Mark Price + 24h Change — always visible (compact on mobile) */}
          <div className="flex items-center gap-2 md:gap-4 flex-shrink-0">
            <div className="flex flex-col gap-0.5">
              {chartPrice ? (
                <AnimatedNumber
                  value={chartPrice}
                  format={formatMemePriceNum}
                  className={`text-sm md:text-[16px] font-bold font-mono ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}
                  showArrow={true}
                  highlightChange={true}
                />
              ) : (
                <span className={`text-sm md:text-[16px] font-bold font-mono ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}>
                  {marketInfo.currentPrice}
                </span>
              )}
              <span className="text-xs text-okx-text-secondary">{t("markPrice")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className={`text-xs md:text-xs font-semibold font-mono ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}>
                {marketInfo.isPriceUp ? "+" : ""}{marketInfo.priceChange}
              </span>
              <span className="text-xs text-okx-text-secondary">{t("change24h")}</span>
            </div>
          </div>

          {/* Desktop-only stats (hidden on mobile, shown in Row 2) */}
          <div className="hidden md:flex items-center gap-6">
            <div className="h-6 w-px bg-okx-border-primary" />
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.high24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("high24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.low24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("low24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.volume24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("volume24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.openInterest}</span>
              <span className="text-xs text-okx-text-secondary">{t("openInterest")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className={`text-xs font-mono ${isFundingPositive ? "text-okx-up" : "text-okx-down"}`}>
                {marketInfo.fundingRate}
              </span>
              <span className="text-xs text-okx-text-secondary">
                {t("fundingRate")} / {fundingCountdown}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">
                {marketInfo.marketCap >= 1000000
                  ? `$${(marketInfo.marketCap / 1000000).toFixed(2)}M`
                  : marketInfo.marketCap >= 1000
                  ? `$${(marketInfo.marketCap / 1000).toFixed(2)}K`
                  : `$${marketInfo.marketCap.toFixed(2)}`}
              </span>
              <span className="text-xs text-okx-text-secondary">{t("marketCap")}</span>
            </div>
          </div>

          {/* Account Balance & Risk (right side) */}
          <div className="ml-auto flex items-center gap-1.5 md:gap-3">
            {/* Risk Alert Badge */}
            {riskAlerts.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setActiveBottomTab("risk")}
                  className="p-1.5 md:p-2 rounded-lg bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
                  title={`${riskAlerts.length} risk alerts`}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                  </svg>
                </button>
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center animate-pulse">
                  {riskAlerts.length > 9 ? "9+" : riskAlerts.length}
                </span>
              </div>
            )}

            {/* Risk Level Indicator — hide on smallest screens */}
            {positionRisks.length > 0 && (
              <div className={`hidden sm:block px-2 py-1 rounded text-xs font-medium ${
                overallRisk === "critical" ? "bg-red-900/50 text-red-400 animate-pulse" :
                overallRisk === "high" ? "bg-orange-900/50 text-orange-400" :
                overallRisk === "medium" ? "bg-yellow-900/50 text-yellow-400" :
                "bg-green-900/50 text-green-400"
              }`}>
                Risk: {overallRisk.toUpperCase()}
              </div>
            )}

            {/* Insurance Fund — hide on mobile */}
            {insuranceFund && (
              <div className="hidden sm:flex items-center gap-1 text-xs text-okx-text-tertiary">
                <svg className="w-3 h-3 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-green-400 font-medium">
                  {insuranceFund.display?.balance || "BNB 0"}
                </span>
                <span>IF</span>
              </div>
            )}

          </div>
        </div>

        {/* Row 2: Mobile-only scrollable stats strip */}
        <div className="md:hidden overflow-x-auto border-t border-okx-border-primary/50">
          <div className="flex items-center gap-4 px-3 py-1.5 min-w-max">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.high24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("high24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.low24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("low24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.volume24h}</span>
              <span className="text-xs text-okx-text-secondary">{t("volume24h")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">{marketInfo.openInterest}</span>
              <span className="text-xs text-okx-text-secondary">{t("openInterest")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className={`text-xs font-mono ${isFundingPositive ? "text-okx-up" : "text-okx-down"}`}>
                {marketInfo.fundingRate}
              </span>
              <span className="text-xs text-okx-text-secondary">{t("fundingRate")}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-mono text-okx-text-primary">
                {marketInfo.marketCap >= 1000000
                  ? `$${(marketInfo.marketCap / 1000000).toFixed(2)}M`
                  : marketInfo.marketCap >= 1000
                  ? `$${(marketInfo.marketCap / 1000).toFixed(2)}K`
                  : `$${marketInfo.marketCap.toFixed(2)}`}
              </span>
              <span className="text-xs text-okx-text-secondary">{t("marketCap")}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content - Responsive: mobile=tabs, tablet=2col, desktop=3col */}
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* Mobile Section Tabs (< md only) */}
        <div className="md:hidden flex border-b border-okx-border-primary bg-okx-bg-secondary">
          {([
            { key: "chart" as const, label: t("mobileChart") },
            { key: "book" as const, label: t("mobileBook") },
            { key: "trade" as const, label: t("mobileTrade") },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMobileActiveSection(tab.key)}
              className={`flex-1 py-2.5 text-xs font-medium transition-colors relative ${
                mobileActiveSection === tab.key
                  ? "text-okx-accent"
                  : "text-okx-text-secondary"
              }`}
            >
              {tab.label}
              {mobileActiveSection === tab.key && (
                <div className="absolute bottom-0 left-1/4 right-1/4 h-[2px] bg-okx-accent" />
              )}
            </button>
          ))}
        </div>

        {/* ═══ DESKTOP / TABLET LAYOUT (≥ md) ═══ */}
        <div className="hidden md:flex flex-1 overflow-hidden">
          {/* Left: Order Book — desktop only (≥ lg) */}
          <div className="hidden lg:block w-[240px] border-r border-okx-border-primary overflow-hidden">
            <TradingErrorBoundary module="OrderBook">
              <OrderBook
                data={wsOrderBook ? { ...wsOrderBook, recentTrades: wsRecentTrades } : undefined}
                onPriceClick={(price) => {
                  setOrderBookSuggestedPrice(String(price));
                }}
                maxRows={12}
              />
            </TradingErrorBoundary>
          </div>

          {/* Center: Chart + Bottom Panel */}
          <div className="flex-1 border-r border-okx-border-primary flex flex-col overflow-hidden">
            {/* Chart Area */}
            <div className="h-[300px] lg:h-[400px] bg-okx-bg-card">
            <TradingErrorBoundary module="PerpChart">
              {tokenAddress && (
                <MemoizedPriceChart
                  tokenAddress={tokenAddress}
                  displaySymbol={displaySymbol}
                  currentPrice={chartPrice}
                />
              )}
            </TradingErrorBoundary>
          </div>

          {/* Bottom Panel - Positions, Orders, History */}
          <div className="h-[300px] lg:h-[400px] border-t border-okx-border-primary flex flex-col bg-okx-bg-primary">
            {/* Tabs — horizontally scrollable on narrow viewports */}
            <div className="overflow-x-auto border-b border-okx-border-primary">
              <div className="flex px-2 md:px-4 min-w-max">
              {[
                { key: "positions", label: t("positions") },
                { key: "openOrders", label: t("openOrders") },
                { key: "orderHistory", label: t("orderHistory") },
                { key: "tradeHistory", label: t("tradeHistory") },
                { key: "hunting", label: t("huntingArena") },
                { key: "risk", label: t("riskControl"), badge: riskAlerts.length > 0 ? riskAlerts.length : undefined },
                { key: "bills", label: t("bills") },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveBottomTab(tab.key as typeof activeBottomTab)}
                  className={`py-2 px-3 md:px-4 text-xs md:text-xs transition-colors relative flex items-center gap-1 whitespace-nowrap flex-shrink-0 ${
                    activeBottomTab === tab.key
                      ? "text-okx-text-primary font-bold"
                      : "text-okx-text-secondary"
                  }`}
                >
                  {tab.label}
                  {"badge" in tab && tab.badge && (
                    <span className="bg-red-500 text-white text-xs rounded-full px-1.5 min-w-[16px] h-4 flex items-center justify-center">
                      {tab.badge > 9 ? "9+" : tab.badge}
                    </span>
                  )}
                  {activeBottomTab === tab.key && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-okx-accent" />
                  )}
                </button>
              ))}
              </div>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto">
              {/* Positions - 使用 WebSocket 实时推送数据 (行业标准 UI - 参考 OKX/Binance) */}
              {activeBottomTab === "positions" && (
                <div className="px-0">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : currentPositionsForDisplay.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noPosition")}
                    </div>
                  ) : (
                    <>
                    {/* ═══════════════════════════════════════════════════════════════
                        Desktop Position Table (Binance Futures-grade layout)
                        ═══════════════════════════════════════════════════════════════ */}
                    <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs min-w-[1100px]">
                      <thead>
                        <tr className="text-okx-text-tertiary text-[11px]">
                          <th className="text-left py-2 px-4 font-normal">{t("pair") || "Symbol"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("size") || "Size"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("entryAvg") || "Entry Price"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("markPrice") || "Mark Price"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("liqPrice") || "Liq. Price"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("margin") || "Margin"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("marginRatio") || "Margin Ratio"}</th>
                          <th className="text-left py-2 px-3 font-normal">{t("unrealizedPnl") || "PnL (ROE%)"}</th>
                          <th className="text-left py-2 px-4 font-normal">{t("action") || "Close Position"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentPositionsForDisplay.map((pos) => {
                          const sizeETH = parseFloat(String(pos.size)) / 1e18;
                          const entryPrice = parseFloat(String(pos.entryPrice)) / 1e18;
                          const serverMarkPrice = parseFloat(String(pos.markPrice || pos.entryPrice)) / 1e18;
                          const markPrice = chartPrice && chartPrice > 0 ? chartPrice : serverMarkPrice;
                          const liqPrice = parseFloat(String(pos.liquidationPrice || "0")) / 1e18;
                          const marginETH = parseFloat(String(pos.collateral)) / 1e18;
                          const leverage = parseFloat(String(pos.leverage));
                          const mmr = parseFloat(String(pos.mmr || "200")) / 100;
                          const pnlDelta = entryPrice > 0 ? sizeETH * Math.abs(markPrice - entryPrice) / entryPrice : 0;
                          const hasProfit = pos.isLong ? (markPrice > entryPrice) : (entryPrice > markPrice);
                          const unrealizedPnlETH = hasProfit ? pnlDelta : -pnlDelta;
                          const equity = marginETH + unrealizedPnlETH;
                          const maintenanceMargin = sizeETH * (mmr / 100);
                          const marginRatio = equity > 0 ? (maintenanceMargin / equity) * 100 : 999;
                          const roe = marginETH > 0 ? (unrealizedPnlETH / marginETH) * 100 : 0;
                          const tokenAmount = markPrice > 0 ? sizeETH / markPrice : 0;
                          const riskLevel = marginRatio > 50 ? 3 : marginRatio > 30 ? 2 : marginRatio > 15 ? 1 : 0;
                          const riskBarColor = riskLevel >= 3 ? "bg-red-500" : riskLevel >= 2 ? "bg-orange-500" : riskLevel >= 1 ? "bg-yellow-500" : "bg-green-500";
                          const riskBarWidth = Math.min(marginRatio, 100);

                          return (
                            <tr key={pos.pairId} className="border-b border-[#1E2329] hover:bg-white/[0.02] transition-colors h-16">
                              {/* ── Symbol: 币对名 + 方向/模式/杠杆 标签组 ── */}
                              <td className="py-3 px-4">
                                <div className="flex flex-col gap-1.5">
                                  <span className="text-[#EAECEF] font-semibold text-[13px]">{instId} Perpetual</span>
                                  <div className="flex items-center gap-1.5">
                                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-bold ${
                                      pos.isLong
                                        ? "bg-[#0ECB81]/[0.13] text-[#0ECB81]"
                                        : "bg-[#F6465D]/[0.13] text-[#F6465D]"
                                    }`}>
                                      {pos.isLong ? t("long") || "Long" : t("short") || "Short"}
                                    </span>
                                    <span className="text-[10px] text-[#888888] px-1.5 py-0.5 rounded-sm border border-[#474D57]">
                                      Isolated
                                    </span>
                                    <span className="text-[10px] text-[#F0B90B] px-1.5 py-0.5 rounded-sm border border-[#474D57]">
                                      {leverage}x
                                    </span>
                                  </div>
                                </div>
                              </td>

                              {/* ── Size: BNB 名义值 + USD 等价 ── */}
                              <td className="py-3 px-3">
                                <div className="text-[#EAECEF] text-[13px]">
                                  {sizeETH >= 1 ? sizeETH.toFixed(4) : sizeETH.toFixed(6)} BNB
                                </div>
                                <div className="text-[11px] text-[#555555] mt-0.5">
                                  ≈ ${(sizeETH * 250).toFixed(2)}
                                </div>
                              </td>

                              {/* ── Entry Price ── */}
                              <td className="py-3 px-3 font-mono text-[#EAECEF] text-[13px]">
                                {formatSmallPrice(entryPrice)}
                              </td>

                              {/* ── Mark Price ── */}
                              <td className="py-3 px-3 font-mono text-[#888888] text-[13px]">
                                {formatSmallPrice(markPrice)}
                              </td>

                              {/* ── Liq. Price (警告黄色) ── */}
                              <td className="py-3 px-3 font-mono text-[#F0B90B] text-[13px]">
                                {formatSmallPrice(liqPrice)}
                              </td>

                              {/* ── Margin + 编辑按钮 ── */}
                              <td className="py-3 px-3">
                                <div className="flex items-center gap-2">
                                  <span className="text-[#EAECEF] text-[13px]">
                                    {marginETH >= 1 ? marginETH.toFixed(4) : marginETH.toFixed(5)} BNB
                                  </span>
                                  <button
                                    onClick={() => setMarginModal({
                                      pairId: pos.pairId, action: "add", collateral: marginETH,
                                      size: sizeETH, entryPrice, isLong: pos.isLong, leverage, mmr,
                                    })}
                                    className="w-[22px] h-[22px] flex items-center justify-center rounded border border-[#363C45] hover:border-[#474D57] hover:bg-white/[0.04] transition-colors group"
                                    title={t("adjustMargin") || "Adjust Margin"}
                                  >
                                    <svg className="w-3 h-3 text-[#555555] group-hover:text-[#EAECEF] transition-colors" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
                                    </svg>
                                  </button>
                                </div>
                              </td>

                              {/* ── Margin Ratio + 进度条 ── */}
                              <td className="py-3 px-3">
                                <div className="flex flex-col gap-1.5">
                                  <span className={`text-[13px] font-semibold ${
                                    riskLevel >= 3 ? "text-[#F6465D]" : riskLevel >= 2 ? "text-orange-400" : "text-[#0ECB81]"
                                  }`}>
                                    {marginRatio.toFixed(1)}%
                                  </span>
                                  <div className="w-[70px] h-[5px] bg-[#1E2329] rounded-sm overflow-hidden">
                                    <div className={`h-full rounded-sm transition-all ${riskBarColor}`} style={{ width: `${riskBarWidth}%` }} />
                                  </div>
                                </div>
                              </td>

                              {/* ── PnL (ROE%) ── */}
                              <td className="py-3 px-3">
                                <div className={`text-[14px] font-bold ${unrealizedPnlETH >= 0 ? "text-[#0ECB81]" : "text-[#F6465D]"}`}>
                                  {unrealizedPnlETH >= 0 ? "+" : ""}{Math.abs(unrealizedPnlETH) >= 1 ? unrealizedPnlETH.toFixed(4) : unrealizedPnlETH.toFixed(6)} BNB
                                </div>
                                <div className={`text-[11px] mt-0.5 ${roe >= 0 ? "text-[#0ECB81]/70" : "text-[#F6465D]/70"}`}>
                                  {roe >= 0 ? "+" : ""}{roe.toFixed(2)}%
                                </div>
                              </td>

                              {/* ── Close Position: Market + Limit 按钮 ── */}
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2.5">
                                  <button
                                    onClick={async () => {
                                      showToast(t("closingPosition") || "Closing position...", "info");
                                      const result = await closePair(pos.pairId);
                                      if (result.success) {
                                        showToast("Position closed!", "success");
                                        refreshPositions();
                                        loadHistoryData();
                                        fetchBills();
                                      } else {
                                        showToast(result.error || "Failed to close", "error");
                                      }
                                    }}
                                    className="h-8 px-4 text-[12px] font-semibold text-[#EAECEF] bg-[#2B3139] border border-[#474D57] hover:bg-[#363C45] rounded transition-colors"
                                  >
                                    Market
                                  </button>
                                  <button
                                    onClick={() => setTpslModal({
                                      pairId: pos.pairId, isLong: pos.isLong, entryPrice, liqPrice,
                                    })}
                                    className="h-8 px-4 text-[12px] text-[#888888] border border-[#363C45] hover:border-[#474D57] hover:text-[#EAECEF] rounded transition-colors"
                                  >
                                    Limit
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>

                    {/* ═══════════════════════════════════════════════════════════════
                        Mobile Position Cards
                        ═══════════════════════════════════════════════════════════════ */}
                    <div className="md:hidden space-y-2 p-2">
                      {currentPositionsForDisplay.map((pos) => {
                        const sizeETH = parseFloat(String(pos.size)) / 1e18;
                        const entryPrice = parseFloat(String(pos.entryPrice)) / 1e18;
                        const serverMarkPrice = parseFloat(String(pos.markPrice || pos.entryPrice)) / 1e18;
                        const markPrice = chartPrice && chartPrice > 0 ? chartPrice : serverMarkPrice;
                        const liqPrice = parseFloat(String(pos.liquidationPrice || "0")) / 1e18;
                        const marginETH = parseFloat(String(pos.collateral)) / 1e18;
                        const leverage = parseFloat(String(pos.leverage));
                        const mmr = parseFloat(String(pos.mmr || "200")) / 100;
                        const pnlDelta = entryPrice > 0 ? sizeETH * Math.abs(markPrice - entryPrice) / entryPrice : 0;
                        const hasProfit = pos.isLong ? (markPrice > entryPrice) : (entryPrice > markPrice);
                        const unrealizedPnlETH = hasProfit ? pnlDelta : -pnlDelta;
                        const equity = marginETH + unrealizedPnlETH;
                        const maintenanceMargin = sizeETH * (mmr / 100);
                        const marginRatio = equity > 0 ? (maintenanceMargin / equity) * 100 : 999;
                        const roe = marginETH > 0 ? (unrealizedPnlETH / marginETH) * 100 : 0;
                        const riskLevel = marginRatio > 50 ? 3 : marginRatio > 30 ? 2 : marginRatio > 15 ? 1 : 0;
                        const riskBarColor = riskLevel >= 3 ? "bg-red-500" : riskLevel >= 2 ? "bg-orange-500" : riskLevel >= 1 ? "bg-yellow-500" : "bg-green-500";

                        return (
                          <div key={pos.pairId} className="bg-okx-bg-secondary/50 rounded-lg p-3 border border-okx-border-primary/50">
                            {/* Header: Direction + Symbol + Leverage */}
                            <div className="flex items-center justify-between mb-2.5">
                              <div className="flex items-center gap-1.5">
                                <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  pos.isLong
                                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                    : "bg-rose-500/15 text-rose-400 border border-rose-500/20"
                                }`}>
                                  {pos.isLong ? "▲" : "▼"} {pos.isLong ? t("long") : t("short")}
                                </span>
                                <span className="text-okx-text-primary text-xs font-medium">{instId}</span>
                                <span className="text-[10px] text-amber-400/80 font-medium">{leverage}x</span>
                              </div>
                              {/* PnL badge */}
                              <div className={`text-xs font-semibold ${unrealizedPnlETH >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                {unrealizedPnlETH >= 0 ? "+" : ""}{Math.abs(unrealizedPnlETH).toFixed(6)} BNB
                                <span className="text-[10px] ml-1 opacity-70">({roe >= 0 ? "+" : ""}{roe.toFixed(2)}%)</span>
                              </div>
                            </div>
                            {/* Data Grid */}
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                              <div className="flex justify-between">
                                <span className="text-okx-text-tertiary">{t("size")}</span>
                                <span className="text-okx-text-primary font-medium">{sizeETH >= 1 ? sizeETH.toFixed(4) : sizeETH.toFixed(6)}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-okx-text-tertiary">{t("margin")}</span>
                                <div className="flex items-center gap-1">
                                  <span className="text-okx-text-primary">{marginETH >= 1 ? marginETH.toFixed(4) : marginETH.toFixed(5)}</span>
                                  <button
                                    onClick={() => setMarginModal({
                                      pairId: pos.pairId, action: "add", collateral: marginETH, size: sizeETH,
                                      entryPrice, isLong: pos.isLong, leverage, mmr,
                                    })}
                                    className="p-0.5 rounded hover:bg-white/[0.06] transition-colors"
                                  >
                                    <svg className="w-2.5 h-2.5 text-okx-text-tertiary hover:text-okx-brand-primary" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-okx-text-tertiary">{t("entryAvg")}</span>
                                <span className="text-okx-text-primary font-mono">{formatSmallPrice(entryPrice)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-okx-text-tertiary">{t("markPrice")}</span>
                                <span className="text-okx-text-secondary font-mono">{formatSmallPrice(markPrice)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-okx-text-tertiary">{t("liqPrice")}</span>
                                <span className={`font-mono ${pos.isLong ? "text-rose-400/80" : "text-emerald-400/80"}`}>{formatSmallPrice(liqPrice)}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-okx-text-tertiary">{t("marginRatio")}</span>
                                <div className="flex items-center gap-1">
                                  <div className="w-8 h-1 bg-okx-bg-tertiary rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full ${riskBarColor}`} style={{ width: `${Math.min(marginRatio, 100)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-okx-text-secondary">{marginRatio.toFixed(1)}%</span>
                                </div>
                              </div>
                            </div>
                            {/* Action buttons */}
                            <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-okx-border-primary/30">
                              <button
                                onClick={async () => {
                                  showToast(t("closingPosition") || "Closing position...", "info");
                                  const result = await closePair(pos.pairId);
                                  if (result.success) { showToast("Position closed!", "success"); refreshPositions(); loadHistoryData(); fetchBills(); }
                                  else { showToast(result.error || "Failed to close", "error"); }
                                }}
                                className="flex-1 py-1.5 text-[10px] font-medium text-rose-400 border border-rose-500/30 rounded hover:bg-rose-500/10 transition-colors"
                              >{t("closePosition")}</button>
                              <button
                                onClick={() => setTpslModal({
                                  pairId: pos.pairId, isLong: pos.isLong, entryPrice, liqPrice,
                                })}
                                className="py-1.5 px-2.5 text-[10px] text-okx-text-tertiary border border-okx-border-primary/50 rounded hover:text-amber-400 hover:border-amber-500/30 transition-colors"
                              >
                                TP/SL
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* Open Orders Table - V2 待处理订单 (行业标准 UI) */}
              {activeBottomTab === "openOrders" && (
                <div className="p-2 md:p-4">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : v2PendingOrders.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noOrders")}
                    </div>
                  ) : (
                    <>
                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs min-w-[900px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">{t("orderId")}</th>
                          <th className="text-left py-2 px-1">{t("time")}</th>
                          <th className="text-left py-2 px-1">{t("pair")}</th>
                          <th className="text-left py-2 px-1">{t("type")}</th>
                          <th className="text-left py-2 px-1">{t("direction")}</th>
                          <th className="text-right py-2 px-1">{t("leverage")}</th>
                          <th className="text-right py-2 px-1">{t("orderPrice")}</th>
                          <th className="text-right py-2 px-1">{t("orderQty")}</th>
                          <th className="text-right py-2 px-1">{t("avgFillPrice")}</th>
                          <th className="text-right py-2 px-1">{t("filledTotal")}</th>
                          <th className="text-right py-2 px-1">{t("margin")}</th>
                          <th className="text-right py-2 px-1">{t("fee")}</th>
                          <th className="text-center py-2 px-1">{t("statusLabel")}</th>
                          <th className="text-right py-2 px-1">{t("action")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {v2PendingOrders.map((order) => {
                          // 格式化显示数据
                          // size 是 Meme 代币数量 (1e18 精度)
                          const sizeTokenRaw = Number(order.size) / 1e18;
                          const sizeDisplay = sizeTokenRaw >= 1000000
                            ? `${(sizeTokenRaw / 1000000).toFixed(2)}M`
                            : sizeTokenRaw >= 1000
                            ? `${(sizeTokenRaw / 1000).toFixed(2)}K`
                            : sizeTokenRaw.toFixed(2);
                          const filledTokenRaw = Number(order.filledSize) / 1e18;
                          const filledDisplay = filledTokenRaw >= 1000000
                            ? `${(filledTokenRaw / 1000000).toFixed(2)}M`
                            : filledTokenRaw >= 1000
                            ? `${(filledTokenRaw / 1000).toFixed(2)}K`
                            : filledTokenRaw.toFixed(2);
                          // price 是 1e18 精度 (BNB 本位: Token/BNB)
                          const priceRaw = Number(order.price) / 1e18;
                          const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                          const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                          const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0"
                            ? formatSmallPrice(avgPriceRaw)
                            : "--";
                          const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                          // margin (BNB, 1e18 precision)
                          const marginBnb = order.margin ? Number(order.margin) / 1e18 : 0;
                          const marginDisplay = order.margin
                            ? `BNB ${marginBnb >= 1 ? marginBnb.toFixed(4) : marginBnb.toFixed(6)}`
                            : "--";
                          const feeBnb = order.fee && order.fee !== "0" ? Number(order.fee) / 1e18 : 0;
                          const feeDisplay = feeBnb > 0
                            ? `BNB ${feeBnb >= 0.0001 ? feeBnb.toFixed(6) : feeBnb.toFixed(8)}`
                            : "--";
                          const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                          const fillPercent = Number(order.size) > 0
                            ? ((Number(order.filledSize) / Number(order.size)) * 100).toFixed(1)
                            : "0";
                          const timeDisplay = new Date(order.createdAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          });

                          return (
                            <tr key={order.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              {/* 订单号 */}
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-xs">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors"
                                  title={t("copyOrderId")}
                                  onClick={() => {
                                    navigator.clipboard.writeText(order.id);
                                  }}
                                >
                                  {order.id} <svg className="w-3 h-3 inline-block ml-1" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.375a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                                </span>
                              </td>

                              {/* Time */}
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>

                              {/* Pair */}
                              <td className="py-2 px-1 font-medium">
                                {instId}
                              </td>

                              {/* 订单类型 */}
                              <td className="py-2 px-1">
                                <span className="bg-okx-bg-secondary px-1.5 py-0.5 rounded text-xs">
                                  {orderTypeDisplay}
                                </span>
                              </td>

                              {/* 方向 */}
                              <td className={`py-2 px-1 font-medium ${order.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {order.isLong ? t("long") : t("short")}
                              </td>

                              {/* 杠杆 */}
                              <td className="py-2 px-1 text-right text-yellow-400">{leverageDisplay}</td>

                              {/* 委托价 */}
                              <td className="py-2 px-1 text-right font-mono">{priceDisplay}</td>

                              {/* 委托量 (代币数量) */}
                              <td className="py-2 px-1 text-right">{sizeDisplay}</td>

                              {/* 成交均价 */}
                              <td className="py-2 px-1 text-right font-mono">{avgPriceDisplay}</td>

                              {/* 已成交/总量 + 进度 */}
                              <td className="py-2 px-1 text-right">
                                <div className="flex flex-col items-end">
                                  <span>{filledDisplay}/{sizeDisplay}</span>
                                  <span className="text-xs text-okx-text-tertiary">{fillPercent}%</span>
                                </div>
                              </td>

                              {/* 保证金 */}
                              <td className="py-2 px-1 text-right">{marginDisplay}</td>

                              {/* 手续费 */}
                              <td className="py-2 px-1 text-right text-okx-text-secondary">{feeDisplay}</td>

                              {/* 状态 */}
                              <td className="py-2 px-1 text-center">
                                <span className={`px-2 py-0.5 rounded text-xs ${
                                  order.status === "PARTIALLY_FILLED"
                                    ? "text-blue-400 bg-blue-900/30"
                                    : "text-yellow-400 bg-yellow-900/30"
                                }`}>
                                  {order.status === "PARTIALLY_FILLED" ? t("partialFilledStatus") : t("waitingStatus")}
                                </span>
                              </td>

                              {/* 操作 */}
                              <td className="py-2 px-1 text-right">
                                <button
                                  className={`text-xs ${
                                    cancellingOrderId === order.id
                                      ? "text-okx-text-tertiary cursor-not-allowed"
                                      : "text-okx-down hover:underline"
                                  }`}
                                  disabled={cancellingOrderId === order.id}
                                  onClick={() => handleCancelOrder(order.id)}
                                >
                                  {cancellingOrderId === order.id ? t("cancelling") : t("cancelOrder")}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                    {/* Mobile Open Order Cards */}
                    <div className="md:hidden space-y-2">
                      {v2PendingOrders.map((order) => {
                        const sizeTokenRaw = Number(order.size) / 1e18;
                        const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                        const priceRaw = Number(order.price) / 1e18;
                        const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                        const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                        const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0" ? formatSmallPrice(avgPriceRaw) : "--";
                        const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                        const marginBnb = order.margin ? Number(order.margin) / 1e18 : 0;
                        const marginDisplay = order.margin ? `BNB ${marginBnb >= 1 ? marginBnb.toFixed(4) : marginBnb.toFixed(6)}` : "--";
                        const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                        const fillPercent = Number(order.size) > 0 ? ((Number(order.filledSize) / Number(order.size)) * 100).toFixed(1) : "0";
                        const timeDisplay = new Date(order.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                        return (
                          <div key={order.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${order.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                  {order.isLong ? t("long") : t("short")}
                                </span>
                                <span className="bg-okx-bg-tertiary px-1.5 py-0.5 rounded text-xs text-okx-text-secondary">{orderTypeDisplay}</span>
                                <span className="text-yellow-400 text-xs">{leverageDisplay}</span>
                              </div>
                              <button
                                className={`text-xs px-2.5 py-1 rounded ${cancellingOrderId === order.id ? "text-okx-text-tertiary bg-okx-bg-tertiary cursor-not-allowed" : "text-red-400 bg-red-900/50"}`}
                                disabled={cancellingOrderId === order.id}
                                onClick={() => handleCancelOrder(order.id)}
                              >{cancellingOrderId === order.id ? t("cancelling") : t("cancelOrder")}</button>
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("orderPrice")}</span><span className="text-okx-text-primary font-mono">{priceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("avgPrice")}</span><span className="text-okx-text-secondary font-mono">{avgPriceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span className="text-okx-text-primary">{sizeDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("margin")}</span><span className="text-okx-text-primary">{marginDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("filled")}</span><span className="text-okx-text-secondary">{fillPercent}%</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("time")}</span><span className="text-okx-text-secondary">{timeDisplay}</span></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* Order History - 使用新的 API 获取历史订单 */}
              {activeBottomTab === "orderHistory" && (
                <div className="p-2 md:p-4">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : isLoadingHistory ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      <div className="animate-spin w-6 h-6 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                      {t("billLoading")}
                    </div>
                  ) : orderHistoryData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noOrders")}
                    </div>
                  ) : (
                    <>
                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs min-w-[800px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">{t("orderId")}</th>
                          <th className="text-left py-2 px-1">{t("time")}</th>
                          <th className="text-left py-2 px-1">{t("pair")}</th>
                          <th className="text-left py-2 px-1">{t("type")}</th>
                          <th className="text-left py-2 px-1">{t("direction")}</th>
                          <th className="text-right py-2 px-1">{t("leverage")}</th>
                          <th className="text-right py-2 px-1">{t("orderPrice")}</th>
                          <th className="text-right py-2 px-1">{t("avgFillPrice")}</th>
                          <th className="text-right py-2 px-1">{t("orderQty")}</th>
                          <th className="text-right py-2 px-1">{t("filledQty")}</th>
                          <th className="text-center py-2 px-1">{t("statusLabel")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orderHistoryData.map((order) => {
                          const sizeTokenRaw = Number(order.size) / 1e18;
                          const sizeDisplay = sizeTokenRaw >= 1000000
                            ? `${(sizeTokenRaw / 1000000).toFixed(2)}M`
                            : sizeTokenRaw >= 1000
                            ? `${(sizeTokenRaw / 1000).toFixed(2)}K`
                            : sizeTokenRaw.toFixed(2);
                          const filledTokenRaw = Number(order.filledSize) / 1e18;
                          const filledDisplay = filledTokenRaw >= 1000000
                            ? `${(filledTokenRaw / 1000000).toFixed(2)}M`
                            : filledTokenRaw >= 1000
                            ? `${(filledTokenRaw / 1000).toFixed(2)}K`
                            : filledTokenRaw.toFixed(2);
                          // BNB denomination: price in 1e18 precision (Token/BNB)
                          const priceRaw = Number(order.price) / 1e18;
                          const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                          const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                          const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0"
                            ? formatSmallPrice(avgPriceRaw)
                            : "--";
                          const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                          const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                          const statusDisplay = order.status === "FILLED" ? t("statusFilled")
                            : order.status === "CANCELLED" ? t("statusCancelled")
                            : order.status === "EXPIRED" ? t("statusExpired")
                            : order.status === "LIQUIDATED" ? t("statusLiquidated")
                            : order.status === "ADL" ? t("statusAdl")
                            : order.status === "CLOSED" ? t("statusClosed")
                            : order.status;
                          const statusColor = order.status === "FILLED" ? "text-green-400 bg-green-900/30"
                            : order.status === "CANCELLED" ? "text-gray-400 bg-gray-900/30"
                            : order.status === "LIQUIDATED" ? "text-red-400 bg-red-900/30"
                            : order.status === "ADL" ? "text-orange-400 bg-orange-900/30"
                            : order.status === "CLOSED" ? "text-blue-400 bg-blue-900/30"
                            : "text-orange-400 bg-orange-900/30";
                          const timeDisplay = new Date(order.updatedAt).toLocaleString(undefined, {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          });

                          return (
                            <tr key={order.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-xs">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors"
                                  title={t("copyOrderId")}
                                  onClick={() => {
                                    navigator.clipboard.writeText(order.id);
                                  }}
                                >
                                  {order.id} <svg className="w-3 h-3 inline-block ml-1" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.375a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                                </span>
                              </td>
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>
                              <td className="py-2 px-1 font-medium">{instId}</td>
                              <td className="py-2 px-1">
                                <span className="bg-okx-bg-secondary px-1.5 py-0.5 rounded text-xs">
                                  {orderTypeDisplay}
                                </span>
                              </td>
                              <td className={`py-2 px-1 font-medium ${order.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {order.isLong ? t("long") : t("short")}
                              </td>
                              <td className="py-2 px-1 text-right text-yellow-400">{leverageDisplay}</td>
                              <td className="py-2 px-1 text-right font-mono">{priceDisplay}</td>
                              <td className="py-2 px-1 text-right font-mono">{avgPriceDisplay}</td>
                              <td className="py-2 px-1 text-right">{sizeDisplay}</td>
                              <td className="py-2 px-1 text-right">{filledDisplay}</td>
                              <td className="py-2 px-1 text-center">
                                <span className={`px-2 py-0.5 rounded text-xs ${statusColor}`}>
                                  {statusDisplay}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                    {/* Mobile Order History Cards */}
                    <div className="md:hidden space-y-2">
                      {orderHistoryData.map((order) => {
                        const sizeTokenRaw = Number(order.size) / 1e18;
                        const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                        const filledTokenRaw = Number(order.filledSize) / 1e18;
                        const filledDisplay = filledTokenRaw >= 1000000 ? `${(filledTokenRaw / 1000000).toFixed(2)}M` : filledTokenRaw >= 1000 ? `${(filledTokenRaw / 1000).toFixed(2)}K` : filledTokenRaw.toFixed(2);
                        const priceRaw = Number(order.price) / 1e18;
                        const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                        const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                        const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0" ? formatSmallPrice(avgPriceRaw) : "--";
                        const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                        const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                        const statusDisplay = order.status === "FILLED" ? t("statusFilled") : order.status === "CANCELLED" ? t("statusCancelled") : order.status === "EXPIRED" ? t("statusExpired") : order.status === "LIQUIDATED" ? t("statusLiquidated") : order.status === "ADL" ? t("statusAdl") : order.status === "CLOSED" ? t("statusClosed") : order.status;
                        const statusColor = order.status === "FILLED" ? "text-green-400 bg-green-900/30" : order.status === "CANCELLED" ? "text-gray-400 bg-gray-900/30" : order.status === "LIQUIDATED" ? "text-red-400 bg-red-900/30" : order.status === "ADL" ? "text-orange-400 bg-orange-900/30" : order.status === "CLOSED" ? "text-blue-400 bg-blue-900/30" : "text-orange-400 bg-orange-900/30";
                        const timeDisplay = new Date(order.updatedAt).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
                        return (
                          <div key={order.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${order.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                  {order.isLong ? t("long") : t("short")}
                                </span>
                                <span className="bg-okx-bg-tertiary px-1.5 py-0.5 rounded text-xs text-okx-text-secondary">{orderTypeDisplay}</span>
                                <span className="text-yellow-400 text-xs">{leverageDisplay}</span>
                              </div>
                              <span className={`px-2 py-0.5 rounded text-xs ${statusColor}`}>{statusDisplay}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("orderPrice")}</span><span className="text-okx-text-primary font-mono">{priceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("avgPrice")}</span><span className="text-okx-text-secondary font-mono">{avgPriceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span className="text-okx-text-primary">{filledDisplay}/{sizeDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("time")}</span><span className="text-okx-text-secondary">{timeDisplay}</span></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* Trade History - 使用新的 API 获取成交记录 */}
              {activeBottomTab === "tradeHistory" && (
                <div className="p-2 md:p-4">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : isLoadingHistory ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      <div className="animate-spin w-6 h-6 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                      {t("billLoading")}
                    </div>
                  ) : tradeHistoryData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noTradeRecords")}
                    </div>
                  ) : (
                    <>
                    {/* Desktop Table */}
                    <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs min-w-[800px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">{t("orderId")}</th>
                          <th className="text-left py-2 px-1">{t("time")}</th>
                          <th className="text-left py-2 px-1">{t("pair")}</th>
                          <th className="text-left py-2 px-1">{t("direction")}</th>
                          <th className="text-left py-2 px-1">{t("roleLabel")}</th>
                          <th className="text-right py-2 px-1">{t("fillPrice")}</th>
                          <th className="text-right py-2 px-1">{t("filledQty")}</th>
                          <th className="text-right py-2 px-1">{t("fee")}</th>
                          <th className="text-right py-2 px-1">{t("realizedPnl")}</th>
                          <th className="text-center py-2 px-1">{t("type")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tradeHistoryData.map((trade) => {
                          const sizeTokenRaw = Number(trade.size) / 1e18;
                          const sizeDisplay = sizeTokenRaw >= 1000000
                            ? `${(sizeTokenRaw / 1000000).toFixed(2)}M`
                            : sizeTokenRaw >= 1000
                            ? `${(sizeTokenRaw / 1000).toFixed(2)}K`
                            : sizeTokenRaw.toFixed(2);
                          // BNB 本位: 1e18 精度
                          const priceRaw = Number(trade.price) / 1e18;
                          const priceDisplay = formatSmallPrice(priceRaw);
                          const feeETH = Number(trade.fee) / 1e18;
                          const feeDisplay = `BNB ${feeETH >= 0.0001 ? feeETH.toFixed(6) : feeETH.toFixed(8)}`;
                          const pnlETH = Number(trade.realizedPnL) / 1e18;
                          const pnlDisplay = pnlETH !== 0
                            ? `${pnlETH >= 0 ? "+" : ""}BNB ${Math.abs(pnlETH) >= 1 ? Math.abs(pnlETH).toFixed(4) : Math.abs(pnlETH).toFixed(6)}`
                            : "--";
                          const roleDisplay = trade.isMaker ? "Maker" : "Taker";
                          const typeDisplay = trade.type === "liquidation" ? t("liquidationLabel")
                            : trade.type === "adl" ? "ADL"
                            : trade.type === "close" ? t("closeTrade") : t("openTrade");
                          const typeColor = trade.type === "liquidation" ? "text-red-400 bg-red-900/30"
                            : trade.type === "adl" ? "text-orange-400 bg-orange-900/30"
                            : trade.type === "close" ? "text-blue-400 bg-blue-900/30"
                            : "text-green-400 bg-green-900/30";
                          const timeDisplay = new Date(trade.timestamp).toLocaleString(undefined, {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          });

                          return (
                            <tr key={trade.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-xs max-w-[160px]">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors truncate block"
                                  title={trade.orderId || trade.id}
                                  onClick={() => {
                                    navigator.clipboard.writeText(trade.orderId || trade.id);
                                  }}
                                >
                                  {(trade.orderId || trade.id).length > 24 ? `${(trade.orderId || trade.id).slice(0, 20)}...` : (trade.orderId || trade.id)} <svg className="w-3 h-3 inline-block ml-1" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.375a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                                </span>
                              </td>
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>
                              <td className="py-2 px-1 font-medium">{instId}</td>
                              <td className={`py-2 px-1 font-medium ${trade.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {trade.isLong ? t("long") : t("short")}
                              </td>
                              <td className="py-2 px-1">
                                <span className={`text-xs ${trade.isMaker ? "text-purple-400" : "text-blue-400"}`}>
                                  {roleDisplay}
                                </span>
                              </td>
                              <td className="py-2 px-1 text-right font-mono">{priceDisplay}</td>
                              <td className="py-2 px-1 text-right">{sizeDisplay}</td>
                              <td className="py-2 px-1 text-right text-okx-text-secondary">{feeDisplay}</td>
                              <td className={`py-2 px-1 text-right font-medium ${pnlETH >= 0 ? "text-green-400" : "text-red-400"}`}>
                                {pnlDisplay}
                              </td>
                              <td className="py-2 px-1 text-center">
                                <span className={`px-2 py-0.5 rounded text-xs ${typeColor}`}>
                                  {typeDisplay}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                    {/* Mobile Trade History Cards */}
                    <div className="md:hidden space-y-2">
                      {tradeHistoryData.map((trade) => {
                        const sizeTokenRaw = Number(trade.size) / 1e18;
                        const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                        const priceRaw = Number(trade.price) / 1e18;
                        const priceDisplay = formatSmallPrice(priceRaw);
                        const feeETH = Number(trade.fee) / 1e18;
                        const feeDisplay = `BNB ${feeETH >= 0.0001 ? feeETH.toFixed(6) : feeETH.toFixed(8)}`;
                        const pnlETH = Number(trade.realizedPnL) / 1e18;
                        const pnlDisplay = pnlETH !== 0 ? `${pnlETH >= 0 ? "+" : ""}BNB ${Math.abs(pnlETH) >= 1 ? Math.abs(pnlETH).toFixed(4) : Math.abs(pnlETH).toFixed(6)}` : "--";
                        const typeDisplay = trade.type === "liquidation" ? t("liquidationLabel") : trade.type === "adl" ? "ADL" : trade.type === "close" ? t("closeTrade") : t("openTrade");
                        const typeColor = trade.type === "liquidation" ? "text-red-400 bg-red-900/30" : trade.type === "adl" ? "text-orange-400 bg-orange-900/30" : trade.type === "close" ? "text-blue-400 bg-blue-900/30" : "text-green-400 bg-green-900/30";
                        const timeDisplay = new Date(trade.timestamp).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
                        return (
                          <div key={trade.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${trade.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                  {trade.isLong ? t("long") : t("short")}
                                </span>
                                <span className={`px-2 py-0.5 rounded text-xs ${typeColor}`}>{typeDisplay}</span>
                                <span className={`text-xs ${trade.isMaker ? "text-purple-400" : "text-blue-400"}`}>{trade.isMaker ? "Maker" : "Taker"}</span>
                              </div>
                              <span className="text-okx-text-tertiary text-xs">{timeDisplay}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fillPrice")}</span><span className="text-okx-text-primary font-mono">{priceDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span className="text-okx-text-primary">{sizeDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fee")}</span><span className="text-okx-text-secondary">{feeDisplay}</span></div>
                              <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("pnl")}</span><span className={`font-medium ${pnlETH >= 0 ? "text-green-400" : "text-red-400"}`}>{pnlDisplay}</span></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )}

              {/* Hunting Arena - 猎杀场 */}
              {activeBottomTab === "hunting" && (
                <div className="p-2 h-full overflow-y-auto">
                  {/* 两列布局：左边热力图+排行榜，右边持仓列表 (mobile: stacked) */}
                  <div className="flex flex-col lg:flex-row gap-3 h-full">
                    {/* 左侧：热力图 + 猎手排行榜 */}
                    <div className="w-full lg:w-[420px] flex-shrink-0 flex flex-col gap-3">
                      {/* 清算热力图 */}
                      <div className="flex-shrink-0">
                        <LiquidationHeatmap token={symbol} />
                      </div>
                      {/* 猎杀排行榜 */}
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <HunterLeaderboard token={symbol} />
                      </div>
                    </div>
                    {/* 右侧：全局持仓列表 (占据剩余空间) */}
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <AllPositions token={symbol} />
                    </div>
                  </div>
                </div>
              )}

              {/* Risk Control Panel - 风险控制 */}
              {activeBottomTab === "risk" && (
                <div className="p-4 h-full overflow-y-auto">
                  <RiskPanel
                    trader={tradingWalletAddress || address}
                    token={tokenAddress}
                  />
                </div>
              )}

              {/* Bills - 账单 */}
              {activeBottomTab === "bills" && (
                <div className="p-2 h-full overflow-y-auto">
                  {/* 类型筛选 */}
                  <div className="flex items-center gap-1.5 mb-3 flex-wrap px-1">
                    {BILL_TYPE_FILTERS.map((f) => (
                      <button
                        key={f.value}
                        onClick={() => setBillTypeFilter(f.value)}
                        className={`px-2.5 py-0.5 rounded-full text-xs transition-colors ${
                          billTypeFilter === f.value
                            ? "bg-meme-lime/20 text-meme-lime border border-meme-lime/40"
                            : "text-okx-text-tertiary border border-okx-border-primary hover:text-okx-text-secondary"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  {/* 列表 */}
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8 text-xs">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : billsLoading && billsData.length === 0 ? (
                    <div className="flex justify-center py-8">
                      <div className="w-5 h-5 border-2 border-meme-lime border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : billsData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8 text-xs">
                      {t("billEmpty")}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {billsData.map((bill) => {
                        const typeMeta = BILL_TYPE_LABELS[bill.type] || { label: bill.type, color: "" };
                        // BNB 本位: 1e18 精度
                        const balanceAfterETH = parseFloat(formatUnits(BigInt(bill.balanceAfter), 18));
                        const rawValueETH = parseFloat(formatUnits(BigInt(bill.amount), 18));
                        // 根据金额符号决定颜色 (SETTLE_PNL/FUNDING_FEE 的 amount 是有符号的)
                        const isPositive = rawValueETH > 0
                          || bill.type === "DEPOSIT"
                          || bill.type === "INSURANCE_INJECTION"
                          || bill.type === "MARGIN_REMOVE";
                        const amountStr = `${rawValueETH >= 0 ? "+" : ""}BNB ${rawValueETH >= 1 ? rawValueETH.toFixed(4) : rawValueETH >= 0 ? rawValueETH.toFixed(6) : (Math.abs(rawValueETH) >= 1 ? rawValueETH.toFixed(4) : rawValueETH.toFixed(6))}`;
                        const amountColor = typeMeta.color || (rawValueETH >= 0 ? "text-okx-up" : "text-okx-down");
                        const ts = new Date(bill.createdAt);
                        const pad = (n: number) => n.toString().padStart(2, "0");
                        const timeStr = `${ts.getFullYear()}/${pad(ts.getMonth() + 1)}/${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

                        return (
                          <div key={bill.id} className="bg-okx-bg-card border border-okx-border-primary rounded-lg px-3 py-2">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-okx-text-tertiary text-xs">{timeStr}</span>
                              <span className="text-okx-text-tertiary text-xs">
                                {t("billBalanceAfter")} BNB {balanceAfterETH >= 1 ? balanceAfterETH.toFixed(4) : balanceAfterETH.toFixed(6)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium text-okx-text-primary">BNB</span>
                              <span className={`text-xs font-bold ${amountColor}`}>{amountStr}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className={`text-xs ${typeMeta.color || "text-okx-text-secondary"}`}>
                                {typeMeta.label}
                              </span>
                              {bill.positionId && (
                                <span className="text-xs text-okx-text-tertiary">{t("billPerp")}</span>
                              )}
                              {bill.txHash && (
                                <span className="text-xs text-okx-text-tertiary font-mono">
                                  {bill.txHash.slice(0, 10)}...
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {billsHasMore && (
                        <div className="text-center py-2">
                          <button
                            onClick={loadMoreBills}
                            disabled={billsLoading}
                            className="text-okx-text-secondary text-xs hover:text-okx-text-primary transition-colors disabled:opacity-50"
                          >
                            {billsLoading ? t("billLoading") : t("billLoadMore")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

          {/* Right: Order Panel (tablet: 280px, desktop: 320px) */}
          <div className="w-[280px] lg:w-[320px] bg-okx-bg-primary overflow-y-auto">
            <TradingErrorBoundary module="OrderPanel">
              <PerpetualOrderPanelV2
                symbol={symbol}
                displaySymbol={displaySymbol}
                tokenAddress={symbol.startsWith("0x") ? symbol as Address : undefined}
                isPerpEnabled={isPerpEnabled}
                suggestedPrice={orderBookSuggestedPrice}
              />
            </TradingErrorBoundary>
          </div>
        </div>

        {/* ═══ MOBILE LAYOUT (< md) ═══ */}
        <div className="md:hidden flex-1 flex flex-col overflow-hidden">
          {/* Chart section */}
          {mobileActiveSection === "chart" && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="h-[300px] bg-okx-bg-card flex-shrink-0">
                <TradingErrorBoundary module="PerpChart">
                  {tokenAddress && (
                    <MemoizedPriceChart
                      tokenAddress={tokenAddress}
                      displaySymbol={displaySymbol}
                      currentPrice={chartPrice}
                    />
                  )}
                </TradingErrorBoundary>
              </div>
              {/* Mobile bottom panel (positions/orders) */}
              <div className="flex-1 min-h-[200px] border-t border-okx-border-primary flex flex-col bg-okx-bg-primary">
                {/* Scrollable tabs */}
                <div className="overflow-x-auto border-b border-okx-border-primary">
                  <div className="flex px-2 min-w-max">
                    {[
                      { key: "positions", label: t("positions") },
                      { key: "openOrders", label: t("openOrders") },
                      { key: "orderHistory", label: t("orderHistory") },
                      { key: "tradeHistory", label: t("tradeHistory") },
                      { key: "hunting", label: t("huntingArena") },
                      { key: "risk", label: t("riskControl"), badge: riskAlerts.length > 0 ? riskAlerts.length : undefined },
                      { key: "bills", label: t("bills") },
                    ].map((tab) => (
                      <button
                        key={tab.key}
                        onClick={() => setActiveBottomTab(tab.key as typeof activeBottomTab)}
                        className={`py-2 px-3 text-xs transition-colors relative flex items-center gap-1 whitespace-nowrap flex-shrink-0 ${
                          activeBottomTab === tab.key
                            ? "text-okx-text-primary font-bold"
                            : "text-okx-text-secondary"
                        }`}
                      >
                        {tab.label}
                        {"badge" in tab && tab.badge && (
                          <span className="bg-red-500 text-white text-xs rounded-full px-1.5 min-w-[16px] h-4 flex items-center justify-center">
                            {tab.badge > 9 ? "9+" : tab.badge}
                          </span>
                        )}
                        {activeBottomTab === tab.key && (
                          <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-okx-accent" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Tab Content (shared with desktop — rendered inline) */}
                <div className="flex-1 overflow-y-auto">
                  {/* Mobile: simplified positions view (cards rendered in Step 5) */}
                  {activeBottomTab === "positions" && (
                    <div className="p-2">
                      {!isConnected ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{tc("connectWalletFirst")}</div>
                      ) : currentPositionsForDisplay.length === 0 ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{t("noPosition")}</div>
                      ) : (
                        <div className="text-center text-okx-text-tertiary py-4 text-xs">
                          {currentPositionsForDisplay.length} {t("positions")} — {t("openOrders")}
                        </div>
                      )}
                    </div>
                  )}
                  {activeBottomTab === "openOrders" && (
                    <div className="p-2 text-center text-okx-text-tertiary py-8 text-xs">
                      {!isConnected ? tc("connectWalletFirst") : t("noOpenOrder")}
                    </div>
                  )}
                  {activeBottomTab === "orderHistory" && (
                    <div className="p-2">
                      {!isConnected ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{tc("connectWalletFirst")}</div>
                      ) : isLoadingHistory ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">
                          <div className="animate-spin w-5 h-5 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                        </div>
                      ) : orderHistoryData.length === 0 ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{t("noOrderHistory")}</div>
                      ) : (
                        <div className="space-y-2">
                          {orderHistoryData.map((order) => {
                            const sizeTokenRaw = Number(order.size) / 1e18;
                            const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                            const priceRaw = Number(order.price) / 1e18;
                            const priceDisplay = order.price === "0" ? t("marketOrder") : formatSmallPrice(priceRaw);
                            const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                            const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0" ? formatSmallPrice(avgPriceRaw) : "--";
                            const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                            const orderTypeDisplay = order.orderType === "MARKET" ? t("marketOrder") : t("limitOrder");
                            const statusColor = order.status === "FILLED" ? "text-green-400" : order.status === "CANCELLED" ? "text-red-400" : "text-yellow-400";
                            const timeDisplay = new Date(order.createdAt).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
                            return (
                              <div key={order.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${order.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                      {order.isLong ? t("long") : t("short")}
                                    </span>
                                    <span className="text-okx-text-tertiary text-xs">{orderTypeDisplay} {leverageDisplay}</span>
                                  </div>
                                  <span className={`text-xs ${statusColor}`}>{order.status}</span>
                                </div>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("orderPrice")}</span><span className="font-mono">{priceDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fillPrice")}</span><span className="font-mono">{avgPriceDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span>{sizeDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("time")}</span><span className="text-okx-text-secondary">{timeDisplay}</span></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {activeBottomTab === "tradeHistory" && (
                    <div className="p-2">
                      {!isConnected ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{tc("connectWalletFirst")}</div>
                      ) : isLoadingHistory ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">
                          <div className="animate-spin w-5 h-5 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                        </div>
                      ) : tradeHistoryData.length === 0 ? (
                        <div className="text-center text-okx-text-tertiary py-8 text-xs">{t("noTradeHistory")}</div>
                      ) : (
                        <div className="space-y-2">
                          {tradeHistoryData.map((trade) => {
                            const sizeTokenRaw = Number(trade.size) / 1e18;
                            const sizeDisplay = sizeTokenRaw >= 1000000 ? `${(sizeTokenRaw / 1000000).toFixed(2)}M` : sizeTokenRaw >= 1000 ? `${(sizeTokenRaw / 1000).toFixed(2)}K` : sizeTokenRaw.toFixed(2);
                            const priceRaw = Number(trade.price) / 1e18;
                            const priceDisplay = formatSmallPrice(priceRaw);
                            const feeETH = Number(trade.fee) / 1e18;
                            const feeDisplay = `BNB ${feeETH >= 0.0001 ? feeETH.toFixed(6) : feeETH.toFixed(8)}`;
                            const pnlETH = Number(trade.realizedPnL) / 1e18;
                            const pnlDisplay = pnlETH !== 0 ? `${pnlETH >= 0 ? "+" : ""}BNB ${Math.abs(pnlETH) >= 1 ? Math.abs(pnlETH).toFixed(4) : Math.abs(pnlETH).toFixed(6)}` : "--";
                            const typeDisplay = trade.type === "liquidation" ? t("liquidationLabel") : trade.type === "adl" ? "ADL" : trade.type === "close" ? t("closeTrade") : t("openTrade");
                            const typeColor = trade.type === "liquidation" ? "text-red-400 bg-red-900/30" : trade.type === "adl" ? "text-orange-400 bg-orange-900/30" : trade.type === "close" ? "text-blue-400 bg-blue-900/30" : "text-green-400 bg-green-900/30";
                            const timeDisplay = new Date(trade.timestamp).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
                            return (
                              <div key={trade.id} className="bg-okx-bg-secondary rounded-lg p-3 border border-okx-border-primary">
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${trade.isLong ? "bg-green-900/50 text-green-400" : "bg-red-900/50 text-red-400"}`}>
                                      {trade.isLong ? t("long") : t("short")}
                                    </span>
                                    <span className={`px-2 py-0.5 rounded text-xs ${typeColor}`}>{typeDisplay}</span>
                                    <span className={`text-xs ${trade.isMaker ? "text-purple-400" : "text-blue-400"}`}>{trade.isMaker ? "Maker" : "Taker"}</span>
                                  </div>
                                  <span className="text-okx-text-tertiary text-xs">{timeDisplay}</span>
                                </div>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fillPrice")}</span><span className="text-okx-text-primary font-mono">{priceDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("quantity")}</span><span className="text-okx-text-primary">{sizeDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("fee")}</span><span className="text-okx-text-secondary">{feeDisplay}</span></div>
                                  <div className="flex justify-between"><span className="text-okx-text-tertiary">{t("pnl")}</span><span className={`font-medium ${pnlETH >= 0 ? "text-green-400" : "text-red-400"}`}>{pnlDisplay}</span></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {activeBottomTab === "hunting" && (
                    <div className="p-2">
                      <div className="flex flex-col gap-3">
                        <LiquidationHeatmap token={symbol} />
                        <HunterLeaderboard token={symbol} />
                        <AllPositions token={symbol} />
                      </div>
                    </div>
                  )}
                  {activeBottomTab === "risk" && (
                    <div className="p-4">
                      <RiskPanel trader={tradingWalletAddress || address} token={tokenAddress} />
                    </div>
                  )}
                  {activeBottomTab === "bills" && (
                    <div className="p-2 text-center text-okx-text-tertiary py-8 text-xs">
                      {!isConnected ? tc("connectWalletFirst") : t("billEmpty")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* OrderBook section (full screen on mobile) */}
          {mobileActiveSection === "book" && (
            <div className="flex-1 overflow-hidden">
              <TradingErrorBoundary module="OrderBook">
                <OrderBook
                  data={wsOrderBook ? { ...wsOrderBook, recentTrades: wsRecentTrades } : undefined}
                  onPriceClick={(price) => {
                    setMobileActiveSection("trade");
                    setOrderBookSuggestedPrice(String(price));
                  }}
                  maxRows={15}
                />
              </TradingErrorBoundary>
            </div>
          )}

          {/* Trade / Order Panel section (full width on mobile) */}
          {mobileActiveSection === "trade" && (
            <div className="flex-1 overflow-y-auto">
              <TradingErrorBoundary module="OrderPanel">
                <PerpetualOrderPanelV2
                  symbol={symbol}
                  displaySymbol={displaySymbol}
                  tokenAddress={symbol.startsWith("0x") ? symbol as Address : undefined}
                  isPerpEnabled={isPerpEnabled}
                  suggestedPrice={orderBookSuggestedPrice}
                />
              </TradingErrorBoundary>
            </div>
          )}
        </div>
      </div>

      {/* Account Balance Modal */}
      {showAccountPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowAccountPanel(false)}
          />
          {/* Modal */}
          <div className="relative z-10 w-full max-w-md mx-4">
            <AccountBalance onClose={() => setShowAccountPanel(false)} />
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          Margin Adjustment Modal (Professional — OKX/Bybit style)
          ═══════════════════════════════════════════════════════════════ */}
      {marginModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => { setMarginModal(null); setMarginAmount(""); }}>
          <div className="bg-[#1b1d28] rounded-xl w-[380px] max-w-[92vw] shadow-2xl border border-white/[0.06]" onClick={e => e.stopPropagation()}>
            {/* Header with tabs */}
            <div className="flex border-b border-white/[0.06]">
              <button
                onClick={() => setMarginModal({ ...marginModal, action: "add" })}
                className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
                  marginModal.action === "add"
                    ? "text-emerald-400"
                    : "text-okx-text-tertiary hover:text-okx-text-secondary"
                }`}
              >
                {t("addMargin") || "Add Margin"}
                {marginModal.action === "add" && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-emerald-400 rounded-full" />}
              </button>
              <button
                onClick={() => setMarginModal({ ...marginModal, action: "remove" })}
                className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
                  marginModal.action === "remove"
                    ? "text-rose-400"
                    : "text-okx-text-tertiary hover:text-okx-text-secondary"
                }`}
              >
                {t("removeMargin") || "Remove Margin"}
                {marginModal.action === "remove" && <div className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-rose-400 rounded-full" />}
              </button>
            </div>

            <div className="p-5">
              {/* Current position info */}
              <div className="grid grid-cols-3 gap-2 mb-4 text-xs">
                <div className="bg-white/[0.03] rounded-lg p-2.5">
                  <div className="text-okx-text-tertiary mb-0.5">{t("margin") || "Margin"}</div>
                  <div className="text-okx-text-primary font-medium">{marginModal.collateral.toFixed(5)}</div>
                </div>
                <div className="bg-white/[0.03] rounded-lg p-2.5">
                  <div className="text-okx-text-tertiary mb-0.5">{t("leverage") || "Leverage"}</div>
                  <div className="text-okx-text-primary font-medium">{marginModal.leverage.toFixed(1)}x</div>
                </div>
                <div className="bg-white/[0.03] rounded-lg p-2.5">
                  <div className="text-okx-text-tertiary mb-0.5">{t("available") || "Available"}</div>
                  <div className="text-emerald-400 font-medium">{formattedAccountBalance}</div>
                </div>
              </div>

              {/* Amount input */}
              <div className="mb-3">
                <div className="flex items-center bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 focus-within:border-okx-brand/50 transition-colors">
                  <input
                    type="number"
                    value={marginAmount}
                    onChange={e => setMarginAmount(e.target.value)}
                    placeholder={t("enterAmount") || "Enter amount"}
                    step="0.001"
                    min="0"
                    className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary"
                  />
                  <span className="text-xs text-okx-text-tertiary ml-2">BNB</span>
                  {marginModal.action === "remove" && marginInfo && (
                    <button
                      onClick={() => setMarginAmount(marginInfo.maxRemovable.toFixed(6))}
                      className="ml-2 text-[10px] text-okx-brand-primary hover:text-okx-brand-primary/80 font-medium"
                    >
                      MAX
                    </button>
                  )}
                </div>
                {marginModal.action === "remove" && marginInfo && (
                  <div className="text-[10px] text-okx-text-tertiary mt-1.5 px-1">
                    {t("maxRemovable") || "Max removable"}: {marginInfo.maxRemovable.toFixed(6)} BNB
                  </div>
                )}
              </div>

              {/* Quick amount buttons */}
              <div className="flex gap-1.5 mb-4">
                {[0.005, 0.01, 0.05, 0.1].map(v => (
                  <button
                    key={v}
                    onClick={() => setMarginAmount(v.toString())}
                    className={`flex-1 py-1.5 text-[10px] rounded border transition-colors ${
                      marginAmount === v.toString()
                        ? "border-okx-brand/50 text-okx-brand-primary bg-okx-brand/5"
                        : "border-white/[0.06] text-okx-text-tertiary hover:border-white/[0.12] hover:text-okx-text-secondary"
                    }`}
                  >
                    {v} BNB
                  </button>
                ))}
              </div>

              {/* Preview: new leverage + liq price */}
              {marginPreview && (
                <div className="bg-white/[0.02] rounded-lg p-3 mb-4 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-okx-text-tertiary">{t("leverage") || "Leverage"}</span>
                    <span className="text-okx-text-secondary">
                      {marginModal.leverage.toFixed(1)}x
                      <span className="text-okx-text-tertiary mx-1">→</span>
                      <span className={`font-medium ${marginPreview.newLeverage > marginModal.leverage ? "text-rose-400" : "text-emerald-400"}`}>
                        {marginPreview.newLeverage.toFixed(1)}x
                      </span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-okx-text-tertiary">{t("margin") || "Margin"}</span>
                    <span className="text-okx-text-secondary">
                      {marginModal.collateral.toFixed(5)}
                      <span className="text-okx-text-tertiary mx-1">→</span>
                      <span className="text-okx-text-primary font-medium">{marginPreview.newCollateral.toFixed(5)}</span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-okx-text-tertiary">{t("liqPrice") || "Liq. Price"}</span>
                    <span className="text-okx-text-secondary font-mono">
                      {formatSmallPrice(marginPreview.newLiqPrice)}
                    </span>
                  </div>
                </div>
              )}

              {/* Action button */}
              <button
                onClick={handleAdjustMargin}
                disabled={isAdjustingMargin || !marginAmount || parseFloat(marginAmount) <= 0}
                className={`w-full py-2.5 text-sm font-medium rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                  marginModal.action === "add"
                    ? "bg-emerald-500 hover:bg-emerald-400 text-white"
                    : "bg-rose-500 hover:bg-rose-400 text-white"
                }`}
              >
                {isAdjustingMargin
                  ? (t("processing") || "Processing...")
                  : marginModal.action === "add"
                    ? (t("addMargin") || "Add Margin")
                    : (t("removeMargin") || "Remove Margin")
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          TP/SL Modal (止盈止损)
          ═══════════════════════════════════════════════════════════════ */}
      {tpslModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => setTpslModal(null)}>
          <div className="bg-[#1b1d28] rounded-xl w-[380px] max-w-[92vw] shadow-2xl border border-white/[0.06]" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06]">
              <h3 className="text-sm font-medium text-okx-text-primary">{t("takeProfitStopLoss") || "TP/SL"}</h3>
              <button onClick={() => setTpslModal(null)} className="text-okx-text-tertiary hover:text-okx-text-primary text-lg">×</button>
            </div>

            <div className="p-5 space-y-4">
              {/* Take Profit */}
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
                  <input
                    type="number"
                    value={tpInput}
                    onChange={e => setTpInput(e.target.value)}
                    placeholder={tpslModal.isLong ? `> ${formatSmallPrice(tpslModal.entryPrice)}` : `< ${formatSmallPrice(tpslModal.entryPrice)}`}
                    step="any"
                    className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary/50"
                  />
                  <span className="text-[10px] text-okx-text-tertiary ml-2">BNB</span>
                </div>
                <div className="text-[10px] text-okx-text-tertiary mt-1 px-1">
                  {tpslModal.isLong ? t("tpHintLong") || "Trigger when price rises above" : t("tpHintShort") || "Trigger when price falls below"}
                </div>
              </div>

              {/* Stop Loss */}
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
                  <input
                    type="number"
                    value={slInput}
                    onChange={e => setSlInput(e.target.value)}
                    placeholder={tpslModal.isLong ? `< ${formatSmallPrice(tpslModal.entryPrice)}` : `> ${formatSmallPrice(tpslModal.entryPrice)}`}
                    step="any"
                    className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary/50"
                  />
                  <span className="text-[10px] text-okx-text-tertiary ml-2">BNB</span>
                </div>
                <div className="text-[10px] text-okx-text-tertiary mt-1 px-1">
                  {tpslModal.isLong ? t("slHintLong") || "Trigger when price falls below" : t("slHintShort") || "Trigger when price rises above"}
                </div>
              </div>

              {/* Info */}
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

              {/* Buttons */}
              <div className="flex gap-2">
                {currentTpsl?.takeProfitPrice || currentTpsl?.stopLossPrice ? (
                  <button
                    onClick={() => handleCancelTpsl("both")}
                    className="flex-1 py-2.5 text-sm font-medium rounded-lg border border-white/[0.08] text-okx-text-secondary hover:bg-white/[0.04] transition-colors"
                  >
                    {t("cancelAll") || "Cancel All"}
                  </button>
                ) : null}
                <button
                  onClick={handleSetTpsl}
                  disabled={isSettingTpsl || (!tpInput && !slInput)}
                  className="flex-1 py-2.5 text-sm font-medium rounded-lg bg-amber-500 hover:bg-amber-400 text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
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
