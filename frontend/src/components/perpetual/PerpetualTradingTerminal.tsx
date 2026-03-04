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
    loading: () => <div className="w-full h-full bg-[#131722] animate-pulse" />,
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

  // 格式化账户余额 (ETH 本位)
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

  // 格式化统计数据 (ETH 本位: 价格为 ETH/Token, 1e18 精度)
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
  // volume24h 是 ETH 成交量 (ETH 本位: 1e18 精度)
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

  // 资金费率倒计时
  const [fundingCountdown, setFundingCountdown] = useState<string>("--:--");
  useEffect(() => {
    const FUNDING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const nextTime = fundingRateData?.nextFundingTime ||
      Math.ceil(Date.now() / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;

    const updateCountdown = () => {
      const diff = nextTime - Date.now();
      if (diff <= 0) {
        setFundingCountdown("00:00");
        return;
      }
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

  // 订单历史和成交记录状态
  const [orderHistoryData, setOrderHistoryData] = useState<HistoricalOrder[]>([]);
  const [tradeHistoryData, setTradeHistoryData] = useState<PerpTradeRecord[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // 错误处理
  const { withErrorHandling } = useApiError();

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

  // 当切换到历史 Tab 时加载数据
  useEffect(() => {
    if (activeBottomTab === "orderHistory" || activeBottomTab === "tradeHistory") {
      loadHistoryData();
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
  };

  const BILL_TYPE_FILTERS = [
    { value: "all",                  label: t("billFilterAll") },
    { value: "DEPOSIT",              label: t("billDeposit") },
    { value: "WITHDRAW",             label: t("billWithdraw") },
    { value: "SETTLE_PNL",           label: t("billSettlePnl") },
    { value: "LIQUIDATION",          label: t("billLiquidation") },
    { value: "FUNDING_FEE",          label: t("billFundingFee") },
    { value: "INSURANCE_INJECTION",  label: t("billInsurance") },
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
      showToast("请先创建交易钱包", "error");
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
        showToast("撤单成功", "success");
        // 刷新订单列表
        refreshOrders();
      } else {
        showToast(result.error || "撤单失败", "error");
      }
    } catch (error) {
      console.error("Cancel order error:", error);
      showToast("撤单失败", "error");
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
  // ETH 本位: 价格是 Token/ETH 比率，OI/Volume 用 ETH
  // ⚠️ 注意: fundingCountdown 每秒更新，不放入 marketInfo 避免整个对象每秒重建导致 K 线抖动
  const marketInfo = useMemo(
    () => ({
      fundingRate: fundingRateFormatted,
      openInterest: `BNB ${formattedOpenInterest}`,
      volume24h: `BNB ${formattedVolume24h}`,
      high24h: formattedHigh24h,    // Token/ETH 比率，无货币符号
      low24h: formattedLow24h,      // Token/ETH 比率，无货币符号
      currentPrice: formattedPrice !== "0.0000000000"
        ? formattedPrice                                    // 优先: 后端 WebSocket lastPrice (Token/ETH)
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
  // AUDIT-FIX FC-C03: chartPrice 应统一使用 ETH 计价
  // 之前 fallback 用 spotPriceUsd (USD)，但 chart 期望 ETH 计价 → 价格 inflated ~2000x
  const chartPrice = useMemo(() => {
    if (tokenStats?.lastPrice) {
      return Number(tokenStats.lastPrice) / 1e18;
    }
    // Fallback: 使用 spotPriceBigInt (ETH 计价, 1e18 精度)
    if (spotPriceBigInt) {
      return Number(spotPriceBigInt) / 1e18;
    }
    return undefined;
  }, [tokenStats?.lastPrice, spotPriceBigInt]);

  return (
    <div
      className={`flex flex-col bg-okx-bg-primary min-h-screen text-okx-text-primary ${className}`}
    >
      {/* Top Bar - Symbol Info */}
      <div className="h-14 bg-okx-bg-secondary border-b border-okx-border-primary flex items-center px-4 gap-6">
        {/* Symbol */}
        <div className="flex items-center gap-2">
          <span className="text-[18px] font-bold text-okx-text-primary">
            {displaySymbol.toUpperCase()}-PERP
          </span>
          <span className="text-[12px] px-2 py-0.5 rounded text-okx-up bg-okx-up/10">
            Perpetual
          </span>
        </div>

        {/* Market Stats */}
        <div className="flex items-center gap-6 text-[12px]">
          {/* 当前价格和涨跌幅 (TokenFactory 现货价格) */}
          <div className="flex items-center gap-2">
            {chartPrice ? (
              <AnimatedNumber
                value={chartPrice}
                format={formatMemePriceNum}
                className={`text-[16px] font-bold ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}
                showArrow={true}
                highlightChange={true}
              />
            ) : (
              <span className={`text-[16px] font-bold ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}>
                {marketInfo.currentPrice}
              </span>
            )}
            <span className={`text-[12px] ${marketInfo.isPriceUp ? "text-okx-up" : "text-okx-down"}`}>
              {marketInfo.isPriceUp ? "+" : ""}{marketInfo.priceChange}
            </span>
          </div>
          <div className="h-4 w-px bg-okx-border-primary" />
          {/* 市值 (FDV) - ETH 本位 */}
          <div>
            <span className="text-okx-text-tertiary mr-2">市值</span>
            <span className="text-okx-text-primary">
              {marketInfo.marketCap >= 1000000
                ? `BNB ${(marketInfo.marketCap / 1000000).toFixed(2)}M`
                : marketInfo.marketCap >= 1000
                ? `BNB ${(marketInfo.marketCap / 1000).toFixed(2)}K`
                : `BNB ${marketInfo.marketCap.toFixed(4)}`}
            </span>
          </div>
          <div>
            <span className="text-okx-text-tertiary mr-2">
              {t("fundingRate")}
            </span>
            <span className={isFundingPositive ? "text-okx-up" : "text-okx-down"}>{marketInfo.fundingRate}</span>
            <span className="text-okx-text-tertiary ml-1">/ {fundingCountdown}</span>
          </div>
          <div>
            <span className="text-okx-text-tertiary mr-2">
              {t("openInterest")}
            </span>
            <span className="text-okx-text-primary">
              {marketInfo.openInterest}
            </span>
          </div>
          <div>
            <span className="text-okx-text-tertiary mr-2">
              {t("volume24h")}
            </span>
            <span className="text-okx-text-primary">
              {marketInfo.volume24h}
            </span>
          </div>
          <div>
            <span className="text-okx-text-tertiary mr-2">{t("high24h")}</span>
            <span className="text-okx-up">{marketInfo.high24h}</span>
          </div>
          <div>
            <span className="text-okx-text-tertiary mr-2">{t("low24h")}</span>
            <span className="text-okx-down">{marketInfo.low24h}</span>
          </div>
          <div>
            <span className="text-okx-text-tertiary mr-2">24h Trades</span>
            <span className="text-okx-text-primary">{marketInfo.trades24h}</span>
          </div>
        </div>

        {/* Account Balance & Risk Indicator */}
        <div className="ml-auto flex items-center gap-3">
          {/* Risk Alert Badge */}
          {riskAlerts.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setActiveBottomTab("risk")}
                className="p-2 rounded-lg bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
                title={`${riskAlerts.length} risk alerts`}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
                </svg>
              </button>
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center animate-pulse">
                {riskAlerts.length > 9 ? "9+" : riskAlerts.length}
              </span>
            </div>
          )}

          {/* Risk Level Indicator */}
          {positionRisks.length > 0 && (
            <div className={`px-2 py-1 rounded text-[10px] font-medium ${
              overallRisk === "critical" ? "bg-red-900/50 text-red-400 animate-pulse" :
              overallRisk === "high" ? "bg-orange-900/50 text-orange-400" :
              overallRisk === "medium" ? "bg-yellow-900/50 text-yellow-400" :
              "bg-green-900/50 text-green-400"
            }`}>
              Risk: {overallRisk.toUpperCase()}
            </div>
          )}

          {/* Insurance Fund Mini Display */}
          {insuranceFund && (
            <div className="flex items-center gap-1 text-xs text-okx-text-tertiary">
              <svg className="w-3 h-3 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-green-400 font-medium">
                {insuranceFund.display?.balance || "BNB 0"}
              </span>
              <span>IF</span>
            </div>
          )}

          {/* Account Balance Button */}
          <button
            onClick={() => setShowAccountPanel(true)}
            className="flex items-center gap-2 px-4 py-2 bg-okx-brand/10 hover:bg-okx-brand/20 border border-okx-brand/30 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4 text-okx-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            <span className="text-okx-brand font-medium">{formattedAccountBalance}</span>
          </button>
        </div>
      </div>

      {/* Main Content - 三列布局 */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Order Book - 使用新的 OrderBook 组件 */}
        <div className="w-[240px] border-r border-okx-border-primary overflow-hidden">
          <TradingErrorBoundary module="OrderBook">
            <OrderBook
              data={wsOrderBook ? { ...wsOrderBook, recentTrades: wsRecentTrades } : undefined}
              onPriceClick={(price) => {
                // 点击价格可以填入下单面板
                console.log("Price clicked:", price);
              }}
              maxRows={12}
            />
          </TradingErrorBoundary>
        </div>

        {/* Center: Chart + Bottom Panel */}
        <div className="flex-1 border-r border-okx-border-primary flex flex-col overflow-hidden">
          {/* Chart Area - 使用撮合引擎 K 线数据 */}
          <div className="h-[400px] bg-[#131722]">
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
          <div className="h-[400px] border-t border-okx-border-primary flex flex-col bg-okx-bg-primary">
            {/* Tabs */}
            <div className="flex border-b border-okx-border-primary px-4">
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
                  className={`py-2 px-4 text-[12px] transition-colors relative flex items-center gap-1 ${
                    activeBottomTab === tab.key
                      ? "text-okx-text-primary font-bold"
                      : "text-okx-text-secondary"
                  }`}
                >
                  {tab.label}
                  {"badge" in tab && tab.badge && (
                    <span className="bg-red-500 text-white text-[10px] rounded-full px-1.5 min-w-[16px] h-4 flex items-center justify-center">
                      {tab.badge > 9 ? "9+" : tab.badge}
                    </span>
                  )}
                  {activeBottomTab === tab.key && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#A3E635]" />
                  )}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto">
              {/* Positions - 使用 WebSocket 实时推送数据 (行业标准 UI - 参考 OKX/Binance) */}
              {activeBottomTab === "positions" && (
                <div className="p-2 overflow-x-auto">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : currentPositionsForDisplay.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noPosition")}
                    </div>
                  ) : (
                    <table className="w-full text-[11px] min-w-[1000px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-2">交易对</th>
                          <th className="text-center py-2 px-1">方向</th>
                          <th className="text-right py-2 px-1">杠杆</th>
                          <th className="text-right py-2 px-1">仓位大小</th>
                          <th className="text-right py-2 px-1">开仓均价</th>
                          <th className="text-right py-2 px-1">标记价格</th>
                          <th className="text-right py-2 px-1">强平价格</th>
                          <th className="text-right py-2 px-1">保证金</th>
                          <th className="text-right py-2 px-1">保证金率</th>
                          <th className="text-right py-2 px-1">未实现盈亏</th>
                          <th className="text-right py-2 px-1">ROE%</th>
                          <th className="text-center py-2 px-1">止盈/止损</th>
                          <th className="text-right py-2 px-2">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentPositionsForDisplay.map((pos) => {
                          // ============================================================
                          // 直接使用后端推送的数据，不再前端计算！
                          // ETH 本位: size=ETH名义价值(1e18), price=Token/ETH(1e18), ETH=1e18, ratio/roe=基点
                          // ============================================================
                          const sizeETH = parseFloat(String(pos.size)) / 1e18;  // ETH 名义价值 (1e18 精度)
                          const entryPrice = parseFloat(String(pos.entryPrice)) / 1e18;  // Token/ETH 比率 (1e18 精度)
                          const markPrice = parseFloat(String(pos.markPrice || pos.entryPrice)) / 1e18;  // 后端推送的标记价 (Token/ETH)
                          const liqPrice = parseFloat(String(pos.liquidationPrice || "0")) / 1e18;  // 后端推送的强平价 (Token/ETH)
                          const marginETH = parseFloat(String(pos.collateral)) / 1e18;  // 保证金 (ETH)
                          const leverage = parseFloat(String(pos.leverage));  // 人类可读
                          const unrealizedPnlETH = parseFloat(String(pos.unrealizedPnL)) / 1e18;  // 后端推送的盈亏 (ETH)
                          const marginRatio = parseFloat(String(pos.marginRatio || "0")) / 100;  // 基点转百分比
                          const roe = parseFloat(String("roe" in pos ? pos.roe : "0") || "0") / 100;  // 基点转百分比
                          const mmr = parseFloat(String(pos.mmr || "200")) / 100;  // 基点转百分比
                          // size 就是 ETH 名义价值，反算代币数量用于辅助显示
                          const tokenAmount = markPrice > 0 ? sizeETH / markPrice : 0;

                          // 风险等级颜色 (使用后端计算的 riskLevel)
                          const riskLevel = pos.riskLevel || "low";
                          const riskColor = riskLevel === "critical" ? "text-red-500 animate-pulse" :
                                           riskLevel === "high" ? "text-red-400" :
                                           riskLevel === "medium" ? "text-yellow-400" : "text-green-400";

                          return (
                            <tr key={pos.pairId} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              {/* 交易对 */}
                              <td className="py-3 px-2">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-okx-text-primary">{instId}</span>
                                  <span className="text-[9px] text-purple-400 bg-purple-900/30 px-1.5 py-0.5 rounded">
                                    #{pos.pairId?.slice(0, 8) || "?"}
                                  </span>
                                </div>
                              </td>

                              {/* 方向 */}
                              <td className="py-3 px-1 text-center">
                                <span className={`px-2 py-1 rounded text-[10px] font-bold ${
                                  pos.isLong
                                    ? "bg-green-900/50 text-green-400"
                                    : "bg-red-900/50 text-red-400"
                                }`}>
                                  {pos.isLong ? "多" : "空"}
                                </span>
                              </td>

                              {/* 杠杆 */}
                              <td className="py-3 px-1 text-right">
                                <span className="text-yellow-400 font-medium">{leverage}x</span>
                              </td>

                              {/* 仓位大小 - ETH 名义价值 + 代币数量 */}
                              <td className="py-3 px-1 text-right">
                                <div className="text-okx-text-primary font-medium">
                                  BNB {sizeETH >= 1 ? sizeETH.toFixed(4) : sizeETH.toFixed(6)}
                                </div>
                                <div className="text-[9px] text-okx-text-tertiary">
                                  {tokenAmount >= 1000000000 ? `${(tokenAmount/1000000000).toFixed(1)}B` :
                                   tokenAmount >= 1000000 ? `${(tokenAmount/1000000).toFixed(1)}M` :
                                   tokenAmount >= 1000 ? `${(tokenAmount/1000).toFixed(1)}K` :
                                   tokenAmount.toFixed(0)} tokens
                                </div>
                              </td>

                              {/* 开仓均价 - Token/ETH 比率 (使用下标格式) */}
                              <td className="py-3 px-1 text-right font-mono text-okx-text-primary">
                                {formatSmallPrice(entryPrice)}
                              </td>

                              {/* 标记价格 - Token/ETH 比率 (使用下标格式) */}
                              <td className="py-3 px-1 text-right font-mono text-okx-text-secondary">
                                {formatSmallPrice(markPrice)}
                              </td>

                              {/* 强平价格 - Token/ETH 比率 (使用下标格式) */}
                              <td className={`py-3 px-1 text-right font-mono ${pos.isLong ? "text-red-400" : "text-green-400"}`}>
                                {formatSmallPrice(liqPrice)}
                              </td>

                              {/* 保证金 (ETH) */}
                              <td className="py-3 px-1 text-right">
                                <span className="text-okx-text-primary">BNB {marginETH >= 1 ? marginETH.toFixed(4) : marginETH.toFixed(6)}</span>
                                <div className="text-[9px] text-okx-text-tertiary">MMR: {mmr.toFixed(2)}%</div>
                              </td>

                              {/* 保证金率 - 后端实时推送 */}
                              <td className={`py-3 px-1 text-right font-medium ${riskColor}`}>
                                {marginRatio.toFixed(2)}%
                              </td>

                              {/* 未实现盈亏 - 后端实时推送 (ETH) */}
                              <td className={`py-3 px-1 text-right font-bold ${unrealizedPnlETH >= 0 ? "text-green-400" : "text-red-400"}`}>
                                {unrealizedPnlETH >= 0 ? "+" : ""}BNB {Math.abs(unrealizedPnlETH) >= 1 ? Math.abs(unrealizedPnlETH).toFixed(4) : Math.abs(unrealizedPnlETH).toFixed(6)}
                              </td>

                              {/* ROE% - 后端实时推送 */}
                              <td className={`py-3 px-1 text-right font-bold ${roe >= 0 ? "text-green-400" : "text-red-400"}`}>
                                {roe >= 0 ? "+" : ""}{roe.toFixed(2)}%
                              </td>

                              {/* 止盈/止损 */}
                              <td className="py-3 px-1 text-center">
                                <button className="text-[10px] text-okx-text-tertiary hover:text-okx-brand-primary">
                                  设置
                                </button>
                              </td>

                              {/* 操作 */}
                              <td className="py-3 px-2 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    onClick={async () => {
                                      showToast(t("closingPosition") || "Closing position...", "info");
                                      const result = await closePair(pos.pairId);
                                      if (result.success) {
                                        showToast("Position closed!", "success");
                                        refreshPositions();
                                        // ✅ 刷新历史委托 + 成交记录 + 账单
                                        loadHistoryData();
                                        fetchBills();
                                      } else {
                                        showToast(result.error || "Failed to close", "error");
                                      }
                                    }}
                                    className="px-2 py-1 bg-red-900/50 text-red-400 text-[10px] font-medium rounded hover:bg-red-800"
                                  >
                                    平仓
                                  </button>
                                  <button className="px-2 py-1 bg-okx-bg-tertiary text-okx-text-secondary text-[10px] rounded hover:bg-okx-bg-hover">
                                    调整
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Open Orders Table - V2 待处理订单 (行业标准 UI) */}
              {activeBottomTab === "openOrders" && (
                <div className="p-4 overflow-x-auto">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : v2PendingOrders.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noOrders")}
                    </div>
                  ) : (
                    <table className="w-full text-[11px] min-w-[900px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">订单号</th>
                          <th className="text-left py-2 px-1">时间</th>
                          <th className="text-left py-2 px-1">交易对</th>
                          <th className="text-left py-2 px-1">类型</th>
                          <th className="text-left py-2 px-1">方向</th>
                          <th className="text-right py-2 px-1">杠杆</th>
                          <th className="text-right py-2 px-1">委托价</th>
                          <th className="text-right py-2 px-1">委托量</th>
                          <th className="text-right py-2 px-1">成交均价</th>
                          <th className="text-right py-2 px-1">已成交/总量</th>
                          <th className="text-right py-2 px-1">保证金</th>
                          <th className="text-right py-2 px-1">手续费</th>
                          <th className="text-center py-2 px-1">状态</th>
                          <th className="text-right py-2 px-1">操作</th>
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
                          // price 是 1e18 精度 (ETH 本位: Token/ETH)
                          const priceRaw = Number(order.price) / 1e18;
                          const priceDisplay = order.price === "0" ? "市价" : formatSmallPrice(priceRaw);
                          const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                          const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0"
                            ? formatSmallPrice(avgPriceRaw)
                            : "--";
                          const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                          // margin 是 ETH (1e18 精度)
                          const marginETH = order.margin ? Number(order.margin) / 1e18 : 0;
                          const marginDisplay = order.margin
                            ? `BNB ${marginETH >= 1 ? marginETH.toFixed(4) : marginETH.toFixed(6)}`
                            : "--";
                          const feeETH = order.fee && order.fee !== "0" ? Number(order.fee) / 1e18 : 0;
                          const feeDisplay = feeETH > 0
                            ? `BNB ${feeETH >= 0.0001 ? feeETH.toFixed(6) : feeETH.toFixed(8)}`
                            : "--";
                          const orderTypeDisplay = order.orderType === "MARKET" ? "市价" : "限价";
                          const fillPercent = Number(order.size) > 0
                            ? ((Number(order.filledSize) / Number(order.size)) * 100).toFixed(1)
                            : "0";
                          const timeDisplay = new Date(order.createdAt).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          });

                          return (
                            <tr key={order.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              {/* 订单号 */}
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-[10px]">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors"
                                  title="点击复制订单号"
                                  onClick={() => {
                                    navigator.clipboard.writeText(order.id);
                                  }}
                                >
                                  {order.id} 📋
                                </span>
                              </td>

                              {/* 时间 */}
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>

                              {/* 交易对 */}
                              <td className="py-2 px-1 font-medium">
                                {instId}
                              </td>

                              {/* 订单类型 */}
                              <td className="py-2 px-1">
                                <span className="bg-okx-bg-secondary px-1.5 py-0.5 rounded text-[10px]">
                                  {orderTypeDisplay}
                                </span>
                              </td>

                              {/* 方向 */}
                              <td className={`py-2 px-1 font-medium ${order.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {order.isLong ? "多" : "空"}
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
                                  <span className="text-[9px] text-okx-text-tertiary">{fillPercent}%</span>
                                </div>
                              </td>

                              {/* 保证金 */}
                              <td className="py-2 px-1 text-right">{marginDisplay}</td>

                              {/* 手续费 */}
                              <td className="py-2 px-1 text-right text-okx-text-secondary">{feeDisplay}</td>

                              {/* 状态 */}
                              <td className="py-2 px-1 text-center">
                                <span className={`px-2 py-0.5 rounded text-[10px] ${
                                  order.status === "PARTIALLY_FILLED"
                                    ? "text-blue-400 bg-blue-900/30"
                                    : "text-yellow-400 bg-yellow-900/30"
                                }`}>
                                  {order.status === "PARTIALLY_FILLED" ? "部分成交" : "等待中"}
                                </span>
                              </td>

                              {/* 操作 */}
                              <td className="py-2 px-1 text-right">
                                <button
                                  className={`text-[11px] ${
                                    cancellingOrderId === order.id
                                      ? "text-okx-text-tertiary cursor-not-allowed"
                                      : "text-okx-down hover:underline"
                                  }`}
                                  disabled={cancellingOrderId === order.id}
                                  onClick={() => handleCancelOrder(order.id)}
                                >
                                  {cancellingOrderId === order.id ? "撤销中..." : "撤单"}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Order History - 使用新的 API 获取历史订单 */}
              {activeBottomTab === "orderHistory" && (
                <div className="p-4 overflow-x-auto">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : isLoadingHistory ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      <div className="animate-spin w-6 h-6 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                      加载中...
                    </div>
                  ) : orderHistoryData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {t("noOrders")}
                    </div>
                  ) : (
                    <table className="w-full text-[11px] min-w-[800px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">订单号</th>
                          <th className="text-left py-2 px-1">时间</th>
                          <th className="text-left py-2 px-1">交易对</th>
                          <th className="text-left py-2 px-1">类型</th>
                          <th className="text-left py-2 px-1">方向</th>
                          <th className="text-right py-2 px-1">杠杆</th>
                          <th className="text-right py-2 px-1">委托价</th>
                          <th className="text-right py-2 px-1">成交均价</th>
                          <th className="text-right py-2 px-1">委托量</th>
                          <th className="text-right py-2 px-1">成交量</th>
                          <th className="text-center py-2 px-1">状态</th>
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
                          // ETH 本位: price 是 1e18 精度 (Token/ETH)
                          const priceRaw = Number(order.price) / 1e18;
                          const priceDisplay = order.price === "0" ? "市价" : formatSmallPrice(priceRaw);
                          const avgPriceRaw = Number(order.avgFillPrice) / 1e18;
                          const avgPriceDisplay = order.avgFillPrice && order.avgFillPrice !== "0"
                            ? formatSmallPrice(avgPriceRaw)
                            : "--";
                          const leverageDisplay = order.leverage ? `${Number(order.leverage) / 10000}x` : "--";
                          const orderTypeDisplay = order.orderType === "MARKET" ? "市价" : "限价";
                          const statusDisplay = order.status === "FILLED" ? "已成交"
                            : order.status === "CANCELLED" ? "已取消"
                            : order.status === "EXPIRED" ? "已过期"
                            : order.status === "LIQUIDATED" ? "已强平"
                            : order.status === "ADL" ? "ADL减仓"
                            : order.status === "CLOSED" ? "已平仓"
                            : order.status;
                          const statusColor = order.status === "FILLED" ? "text-green-400 bg-green-900/30"
                            : order.status === "CANCELLED" ? "text-gray-400 bg-gray-900/30"
                            : order.status === "LIQUIDATED" ? "text-red-400 bg-red-900/30"
                            : order.status === "ADL" ? "text-orange-400 bg-orange-900/30"
                            : order.status === "CLOSED" ? "text-blue-400 bg-blue-900/30"
                            : "text-orange-400 bg-orange-900/30";
                          const timeDisplay = new Date(order.updatedAt).toLocaleString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          });

                          return (
                            <tr key={order.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-[10px]">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors"
                                  title="点击复制订单号"
                                  onClick={() => {
                                    navigator.clipboard.writeText(order.id);
                                  }}
                                >
                                  {order.id} 📋
                                </span>
                              </td>
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>
                              <td className="py-2 px-1 font-medium">{instId}</td>
                              <td className="py-2 px-1">
                                <span className="bg-okx-bg-secondary px-1.5 py-0.5 rounded text-[10px]">
                                  {orderTypeDisplay}
                                </span>
                              </td>
                              <td className={`py-2 px-1 font-medium ${order.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {order.isLong ? "多" : "空"}
                              </td>
                              <td className="py-2 px-1 text-right text-yellow-400">{leverageDisplay}</td>
                              <td className="py-2 px-1 text-right font-mono">{priceDisplay}</td>
                              <td className="py-2 px-1 text-right font-mono">{avgPriceDisplay}</td>
                              <td className="py-2 px-1 text-right">{sizeDisplay}</td>
                              <td className="py-2 px-1 text-right">{filledDisplay}</td>
                              <td className="py-2 px-1 text-center">
                                <span className={`px-2 py-0.5 rounded text-[10px] ${statusColor}`}>
                                  {statusDisplay}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Trade History - 使用新的 API 获取成交记录 */}
              {activeBottomTab === "tradeHistory" && (
                <div className="p-4 overflow-x-auto">
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : isLoadingHistory ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      <div className="animate-spin w-6 h-6 border-2 border-okx-brand border-t-transparent rounded-full mx-auto mb-2" />
                      加载中...
                    </div>
                  ) : tradeHistoryData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8">
                      暂无成交记录
                    </div>
                  ) : (
                    <table className="w-full text-[11px] min-w-[800px]">
                      <thead>
                        <tr className="text-okx-text-tertiary border-b border-okx-border-primary">
                          <th className="text-left py-2 px-1">订单号</th>
                          <th className="text-left py-2 px-1">时间</th>
                          <th className="text-left py-2 px-1">交易对</th>
                          <th className="text-left py-2 px-1">方向</th>
                          <th className="text-left py-2 px-1">角色</th>
                          <th className="text-right py-2 px-1">成交价</th>
                          <th className="text-right py-2 px-1">成交量</th>
                          <th className="text-right py-2 px-1">手续费</th>
                          <th className="text-right py-2 px-1">已实现盈亏</th>
                          <th className="text-center py-2 px-1">类型</th>
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
                          // ETH 本位: 1e18 精度
                          const priceRaw = Number(trade.price) / 1e18;
                          const priceDisplay = formatSmallPrice(priceRaw);
                          const feeETH = Number(trade.fee) / 1e18;
                          const feeDisplay = `BNB ${feeETH >= 0.0001 ? feeETH.toFixed(6) : feeETH.toFixed(8)}`;
                          const pnlETH = Number(trade.realizedPnL) / 1e18;
                          const pnlDisplay = pnlETH !== 0
                            ? `${pnlETH >= 0 ? "+" : ""}BNB ${Math.abs(pnlETH) >= 1 ? Math.abs(pnlETH).toFixed(4) : Math.abs(pnlETH).toFixed(6)}`
                            : "--";
                          const roleDisplay = trade.isMaker ? "Maker" : "Taker";
                          const typeDisplay = trade.type === "liquidation" ? "强平"
                            : trade.type === "adl" ? "ADL"
                            : trade.type === "close" ? "平仓" : "开仓";
                          const typeColor = trade.type === "liquidation" ? "text-red-400 bg-red-900/30"
                            : trade.type === "adl" ? "text-orange-400 bg-orange-900/30"
                            : trade.type === "close" ? "text-blue-400 bg-blue-900/30"
                            : "text-green-400 bg-green-900/30";
                          const timeDisplay = new Date(trade.timestamp).toLocaleString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          });

                          return (
                            <tr key={trade.id} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
                              <td className="py-2 px-1 text-okx-text-tertiary font-mono text-[10px]">
                                <span
                                  className="cursor-pointer hover:text-okx-text-primary transition-colors"
                                  title="点击复制订单号"
                                  onClick={() => {
                                    navigator.clipboard.writeText(trade.orderId || trade.id);
                                  }}
                                >
                                  {trade.orderId || trade.id} 📋
                                </span>
                              </td>
                              <td className="py-2 px-1 text-okx-text-secondary">{timeDisplay}</td>
                              <td className="py-2 px-1 font-medium">{instId}</td>
                              <td className={`py-2 px-1 font-medium ${trade.isLong ? "text-okx-up" : "text-okx-down"}`}>
                                {trade.isLong ? "多" : "空"}
                              </td>
                              <td className="py-2 px-1">
                                <span className={`text-[10px] ${trade.isMaker ? "text-purple-400" : "text-blue-400"}`}>
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
                                <span className={`px-2 py-0.5 rounded text-[10px] ${typeColor}`}>
                                  {typeDisplay}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {/* Hunting Arena - 猎杀场 */}
              {activeBottomTab === "hunting" && (
                <div className="p-2 h-full overflow-y-auto">
                  {/* 两列布局：左边热力图+排行榜，右边持仓列表 */}
                  <div className="flex gap-3 h-full">
                    {/* 左侧：热力图 + 猎手排行榜 */}
                    <div className="w-[420px] flex-shrink-0 flex flex-col gap-3">
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
                        className={`px-2.5 py-0.5 rounded-full text-[11px] transition-colors ${
                          billTypeFilter === f.value
                            ? "bg-[#A3E635]/20 text-[#A3E635] border border-[#A3E635]/40"
                            : "text-okx-text-tertiary border border-okx-border-primary hover:text-okx-text-secondary"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  {/* 列表 */}
                  {!isConnected ? (
                    <div className="text-center text-okx-text-tertiary py-8 text-[12px]">
                      {tc("connectWalletFirst")}
                    </div>
                  ) : billsLoading && billsData.length === 0 ? (
                    <div className="flex justify-center py-8">
                      <div className="w-5 h-5 border-2 border-[#A3E635] border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : billsData.length === 0 ? (
                    <div className="text-center text-okx-text-tertiary py-8 text-[12px]">
                      {t("billEmpty")}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {billsData.map((bill) => {
                        const typeMeta = BILL_TYPE_LABELS[bill.type] || { label: bill.type, color: "" };
                        // ETH 本位: 1e18 精度
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
                              <span className="text-okx-text-tertiary text-[10px]">{timeStr}</span>
                              <span className="text-okx-text-tertiary text-[10px]">
                                {t("billBalanceAfter")} BNB {balanceAfterETH >= 1 ? balanceAfterETH.toFixed(4) : balanceAfterETH.toFixed(6)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] font-medium text-okx-text-primary">BNB</span>
                              <span className={`text-[12px] font-bold ${amountColor}`}>{amountStr}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className={`text-[10px] ${typeMeta.color || "text-okx-text-secondary"}`}>
                                {typeMeta.label}
                              </span>
                              {bill.positionId && (
                                <span className="text-[10px] text-okx-text-tertiary">{t("billPerp")}</span>
                              )}
                              {bill.txHash && (
                                <span className="text-[10px] text-okx-text-tertiary font-mono">
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
                            className="text-okx-text-secondary text-[11px] hover:text-okx-text-primary transition-colors disabled:opacity-50"
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

        {/* Right: Order Panel (固定宽度) */}
        <div className="w-[320px] bg-okx-bg-primary overflow-y-auto">
          <TradingErrorBoundary module="OrderPanel">
            {/* V2: 使用 Settlement 合约 + 撮合引擎 */}
            <PerpetualOrderPanelV2
              symbol={symbol}
              displaySymbol={displaySymbol}
              tokenAddress={symbol.startsWith("0x") ? symbol as Address : undefined}
              isPerpEnabled={isPerpEnabled}
            />
          </TradingErrorBoundary>
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
    </div>
  );
}
