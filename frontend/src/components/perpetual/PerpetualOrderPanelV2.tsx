"use client";

/**
 * PerpetualOrderPanelV2 - 閻劍鍩涚€电绁靛Ο鈥崇础娴溿倖妲楅棃銏℃緲 (BNB 閺堫兛缍?
 *
 * 閺傜増鐏﹂弸鍕ウ缁嬪绱?
 * 1. 閻劍鍩涚粵鎯ф倳 EIP-712 鐠併垹宕熼敍鍫ユ懠娑撳绱濇稉宥堝С Gas閿?
 * 2. 閹绢喖鎮庡鏇熸惛闁板秴顕径姘扁敄鐠併垹宕熼敍鍫ユ懠娑撳绱?
 * 3. 閹绢喖鎮庡鏇熸惛閹靛綊鍣洪幓鎰唉闁板秴顕紒鎾寸亯閿涘牓鎽兼稉濠忕礆
 * 4. Settlement 閸氬牏瀹虫宀冪槈缁涙儳鎮曢獮鑸靛⒔鐞?BNB 缂佹挾鐣?
 * 5. 閻╁牅绨惄瀛樺复閸︺劌顦跨粚杞扮闂傜娴嗙粔浼欑礉娣囨繈娅撻崺娲櫨娴犲懐鏁ゆ禍搴ｂ敍娴?
 *
 * BNB 閺堫兛缍?
 * - 娣囨繆鐦夐柌?PnL 娴?BNB 鐠佲€茬幆 (1e18 缁儳瀹?
 * - 娴犻攱鐗告稉?Token/BNB (娴?Bonding Curve 閻╁瓨甯撮懢宄板絿)
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
// 閸愬懐娲忛梼鑸殿唽閺堚偓婢?2.5x 閺夌姵娼?
const LEVERAGE_OPTIONS = [1, 1.5, 2, 2.5];

// formatSmallPrice imported from @/components/common/PositionRow

interface PerpetualOrderPanelV2Props {
  symbol: string;
  displaySymbol?: string;
  tokenAddress?: Address;
  marketId?: string;
  oraclePriceUsd?: number;
  maxLeverage?: number;
  className?: string;
  isPerpEnabled?: boolean;
  suggestedPrice?: string; // 娴?OrderBook 閻愮懓鍤导鐘插弳閻ㄥ嫪鐜弽?
}

export function PerpetualOrderPanelV2({
  symbol,
  displaySymbol,
  tokenAddress,
  marketId,
  oraclePriceUsd,
  maxLeverage,
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

  // ETH 娴犻攱鐗?
  const { price: ethPrice } = useETHPrice();

  // 娴?TokenFactory 閼惧嘲褰囬悳鎷屾彛娴犻攱鐗?(bonding curve 娴犻攱鐗? - ETH 閺堫兛缍? Token/ETH
  const { currentPrice: spotPriceBigInt } = usePoolState(tokenAddress);

  // Trading Wallet Hook - 缁涙儳鎮曞ú鍓ф晸闁藉崬瀵?
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

  // 閼惧嘲褰囨禍銈嗘闁藉崬瀵樼粵鎯ф倳閿涘牏鏁ゆ禍搴ゎ吂閸楁洜顒烽崥宥忕礆
  const tradingWalletSignature = getSignature();

  // Deposit Modal 閻樿埖鈧?
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [privateKeyData, setPrivateKeyData] = useState<{ privateKey: string; warning: string } | null>(null);

  // Wrap and Deposit 閻樿埖鈧?
  const [wrapAmount, setWrapAmount] = useState("");

  // 婢х偛鍣烘穱婵婄槈闁?Modal 閻樿埖鈧?
  const [marginModal, setMarginModal] = useState<{ pairId: string; action: "add" | "remove"; collateral: number } | null>(null);
  const [marginAmount, setMarginAmount] = useState("");
  const [isAdjustingMargin, setIsAdjustingMargin] = useState(false);

  // TP/SL Modal 閻樿埖鈧?
  const [tpslModal, setTpslModal] = useState<{
    pairId: string; isLong: boolean; entryPrice: number; liqPrice: number;
  } | null>(null);
  const [tpInput, setTpInput] = useState("");
  const [slInput, setSlInput] = useState("");
  const [isSettingTpsl, setIsSettingTpsl] = useState(false);
  const [currentTpsl, setCurrentTpsl] = useState<{
    takeProfitPrice: string | null; stopLossPrice: string | null;
  } | null>(null);

  // V2 Hook - 娴ｈ法鏁?Settlement 閸氬牏瀹?+ 閹绢喖鎮庡鏇熸惛
  // 娴肩姴鍙嗘禍銈嗘闁藉崬瀵樻穱鈩冧紖閻劋绨粵鎯ф倳鐠併垹宕?
  const {
    balance,
    positions,
    pendingOrders,
    submitMarketOrder,
    submitLimitOrder,
    closePair,
    // refreshBalance no longer needed here 閳?usePerpetualV2 handles WS balance internally
    // orderBook / refreshOrderBook removed 閳?dead code, data flows via WebSocket 閳?tradingDataStore
    isSigningOrder,
    isSubmittingOrder,
    isPending,
    isConfirming,
  } = usePerpetualV2({
    tradingWalletAddress: tradingWalletAddress || undefined,
    tradingWalletSignature: tradingWalletSignature || undefined,
  });

  // Global wallet balance context (on-chain balances 閳?fallback when WS balance unavailable)
  const walletBalanceCtx = useWalletBalance();
  const { refreshBalance: refreshWalletBalance, totalBalance: onChainBalance } = walletBalanceCtx;

  // 閳光偓閳光偓 Balance 鐎圭偞妞傞弴瀛樻煀: System B (WebSocketManager) 閳?tradingDataStore 閳光偓閳光偓
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
  const [manualAmountPercent, setManualAmountPercent] = useState(0);

  // 閸楁洑缍呴柅澶嬪: BNB / 娴狅絽绔?(BNB 閺堫兛缍?
  const [amountUnit, setAmountUnit] = useState<"BNB" | "TOKEN">("BNB");

  // Order type state (鐢倷鐜?闂勬劒鐜?
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState("");

  // 閳?OrderBook 閻愮懓鍤禒閿嬬壐 閳?閼奉亜濮╅崚鍥ㄥ床闂勬劒鐜崡鏇炶嫙婵夘偄鍙嗘禒閿嬬壐
  useEffect(() => {
    if (suggestedPrice) {
      setOrderType("limit");
      setLimitPrice(suggestedPrice);
    }
  }, [suggestedPrice]);

  // TP/SL state (濮濄垻娉╁銏″疮)
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
  const effectiveMaxLeverage = maxLeverage && maxLeverage > 0 ? maxLeverage : LEVERAGE_OPTIONS[LEVERAGE_OPTIONS.length - 1];
  const leverageOptions = useMemo(() => {
    const base = LEVERAGE_OPTIONS.filter((lev) => lev <= effectiveMaxLeverage);
    if (!base.includes(effectiveMaxLeverage)) base.push(effectiveMaxLeverage);
    return [...new Set(base)].sort((a, b) => a - b);
  }, [effectiveMaxLeverage]);

  useEffect(() => {
    if (leverage > effectiveMaxLeverage) {
      setLeverage(effectiveMaxLeverage);
    }
  }, [leverage, effectiveMaxLeverage]);

  const setAmount = useCallback((val: string) => {
    if (!val) {
      setManualAmountPercent(0);
    }
    updateOrderForm({ size: val });
    if (val && !/^\d*\.?\d*$/.test(val)) {
      setAmountError("请输入有效数量");
    } else {
      setAmountError(null);
    }
  }, [updateOrderForm]);

  // 娴狅絽绔垫禒閿嬬壐 - ETH 閺堫兛缍?
  // tokenPriceETH: Token/ETH 濮ｆ梻宸?(娴?Bonding Curve)
  // tokenPriceUSD: 娴犲懐鏁ゆ禍?UI 閸欏倽鈧啯妯夌粈?
  const { tokenPriceETH, tokenPriceUSD } = useMemo(() => {
    if (oraclePriceUsd && oraclePriceUsd > 0) {
      const priceETH = ethPrice ? oraclePriceUsd / ethPrice : 0;
      return { tokenPriceETH: priceETH, tokenPriceUSD: oraclePriceUsd };
    }
    // 娴ｈ法鏁?TokenFactory 閻?bonding curve 娴犻攱鐗?(Token/ETH)
    if (spotPriceBigInt) {
      const priceETH = Number(spotPriceBigInt) / 1e18;  // Token/ETH ratio
      const priceUSD = priceETH * (ethPrice || 0);      // 娴犲懎寮懓?
      return { tokenPriceETH: priceETH, tokenPriceUSD: priceUSD };
    }
    return { tokenPriceETH: 0, tokenPriceUSD: 0 };
  }, [spotPriceBigInt, ethPrice, oraclePriceUsd]);

  // 閺嶈宓侀悽銊﹀煕闁瀚ㄩ惃鍕礋娴ｅ稄绱濈紒鐔剁閹广垻鐣婚幋鎰波娴ｅ秳鐜崐?(ETH 閺堫兛缍? 閸?Meme 鐢焦鏆熼柌?
  // ETH 閺堫兛缍? 娑撴槒顩︽担璺ㄦ暏 ETH 鐠佲€茬幆閿涘SD 娴犲懐鏁ゆ禍搴″棘閼板啯妯夌粈?
  const { positionValueETH, positionValueUSD, positionSizeToken } = useMemo(() => {
    const inputAmount = parseFloat(amount) || 0;
    if (inputAmount <= 0 || tokenPriceUSD <= 0) {
      return { positionValueETH: 0, positionValueUSD: 0, positionSizeToken: 0 };
    }

    let valueETH = 0;
    let valueUSD = 0;  // 娴犲懐鏁ゆ禍?UI 閸欏倽鈧啯妯夌粈?
    let tokenAmount = 0;

    if (amountUnit === "BNB") {
      valueETH = inputAmount;
      valueUSD = inputAmount * (ethPrice || 0);  // 娴犲懎寮懓?
      tokenAmount = valueUSD / tokenPriceUSD;
    } else if (amountUnit === "TOKEN") {
      tokenAmount = inputAmount;
      valueUSD = inputAmount * tokenPriceUSD;  // 娴犲懎寮懓?
      valueETH = ethPrice ? valueUSD / ethPrice : 0;
    }

    return { positionValueETH: valueETH, positionValueUSD: valueUSD, positionSizeToken: tokenAmount };
  }, [amount, amountUnit, ethPrice, tokenPriceUSD]);

  // 鐠侊紕鐣婚幍鈧棁鈧穱婵婄槈闁?(ETH 閺堫兛缍? 閻╁瓨甯撮悽?ETH)
  const requiredMarginETH = useMemo(() => {
    if (positionValueETH <= 0) return 0;
    const marginETH = positionValueETH / leverage;
    const feeETH = positionValueETH * 0.0005; // 0.05% taker fee (5bp)
    return marginETH + feeETH;
  }, [positionValueETH, leverage]);

  // 閺嶇厧绱￠崠鏍︾箽鐠囦線鍣鹃弰鍓с仛 (ETH 閺堫兛缍?
  const requiredMarginDisplay = useMemo(() => {
    if (requiredMarginETH <= 0) return "BNB 0.0000";
    return `BNB ${requiredMarginETH >= 1 ? requiredMarginETH.toFixed(4) : requiredMarginETH.toFixed(6)}`;
  }, [requiredMarginETH]);

  // Check if balance is sufficient
  // 閺佺増宓佸┃鎰喘閸忓牏楠囬敍?
  //   1. 瀵洘鎼?API balance (閸栧懎鎯?settlement 鐎涙ɑ顑?+ mode2 鐠嬪啯鏆?+ 闁藉崬瀵樻担娆擃杺)
  //   2. 濞插墽鏁撻柦鍗炲瘶闁惧彞绗?BNB (useTradingWallet.ethBalance閿涘本娓堕崣顖炴浆)
  //   3. WalletBalanceContext (useWalletBalance閿涘瘍agmi useBalance)
  const { hasSufficientBalance, availableBalanceETH } = useMemo(() => {
    if (balance) {
      // 閳?FIX: 瀵洘鎼搁惃?availableBalance 閺勵垰鏁稉鈧锝団€橀惃鍕讲閻劋缍戞０婵囨降濠?
      // 鐎瑰啫鍑＄紒蹇氼吀缁犳ぞ绨? walletBalance + settlementAvailable + mode2Adj - positionMargin - pendingOrders
      // 娑撳秷顩﹂崘宥呭 walletBalance閿涘苯鎯侀崚娆忓蓟闁插秷顓哥粻?
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

  const maxOrderAmountForUnit = useMemo(() => {
    const usableCollateral = Math.max(0, availableBalanceETH || 0);
    if (usableCollateral <= 0 || leverage <= 0) return 0;

    const maxPositionValueETH = usableCollateral / (1 / leverage + 0.0005);
    if (amountUnit === "BNB") return maxPositionValueETH;

    const maxPositionValueUSD = maxPositionValueETH * (ethPrice || 0);
    if (tokenPriceUSD <= 0) return 0;
    return maxPositionValueUSD / tokenPriceUSD;
  }, [amountUnit, availableBalanceETH, ethPrice, leverage, tokenPriceUSD]);

  const amountPercent = useMemo(() => {
    const inputAmount = parseFloat(amount) || 0;
    if (inputAmount <= 0 || maxOrderAmountForUnit <= 0) return 0;
    return Math.min(100, Math.max(0, (inputAmount / maxOrderAmountForUnit) * 100));
  }, [amount, maxOrderAmountForUnit]);

  const displayedAmountPercent = maxOrderAmountForUnit > 0 ? amountPercent : manualAmountPercent;

  const setAmountByPercent = useCallback((percent: number) => {
    const clampedPercent = Math.min(100, Math.max(0, percent));
    setManualAmountPercent(clampedPercent);
    if (clampedPercent <= 0 || maxOrderAmountForUnit <= 0) {
      if (clampedPercent <= 0) setAmount("");
      return;
    }

    const nextAmount = (maxOrderAmountForUnit * clampedPercent) / 100;
    const formatted = amountUnit === "BNB"
      ? nextAmount >= 1
        ? nextAmount.toFixed(4)
        : nextAmount.toFixed(6)
      : nextAmount >= 1000
        ? nextAmount.toFixed(0)
        : nextAmount >= 1
          ? nextAmount.toFixed(2)
          : nextAmount.toFixed(4);

    setAmount(formatted.replace(/\.?0+$/, ""));
  }, [amountUnit, maxOrderAmountForUnit, setAmount]);

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
      showToast("鐠囩柉绶崗銉︽箒閺佸牏娈戦弫浼村櫤", "error");
      return;
    }

    if (positionSizeToken <= 0 || !isFinite(positionSizeToken)) {
      showToast("閺冪姵纭剁拋锛勭暬娴犳挷缍呮径褍鐨敍宀冾嚞濡偓閺屻儰鐜弽纭风礄娴犻攱鐗搁弫鐗堝祦閸旂姾娴囨稉顓ㄧ礆", "error");
      return;
    }

    // Validate limit price for limit orders
    if (orderType === "limit" && (!limitPrice || parseFloat(limitPrice) <= 0)) {
      showToast(t("enterLimitPrice") || "Enter a valid limit price", "error");
      return;
    }

    if (!hasSufficientBalance) {
      showToast("Insufficient balance. Deposit collateral first.", "error");
      return;
    }

    if (!isTradingWalletInitialized) {
      showToast("鐠囧嘲鍘涢崚娑樼紦娴溿倖妲楅柦鍗炲瘶", "error");
      return;
    }

    try {
      const isLong = side === "long";
      // ETH 閺堫兛缍呴敍姘炊 ETH 閸氬秳绠熸禒宄扳偓纭风礄1e18 缁儳瀹抽敍?
      // 閸氬牏瀹?Settlement 鐠侊紕鐣绘穱婵婄槈闁叉埊绱癱ollateral = size / leverage
      // 閹碘偓娴?size 韫囧懘銆忛弰?ETH 娴犲嘲鈧》绱?e18 缁儳瀹抽敍?
      // AUDIT-FIX FE-C02: 瑜版挸宕熸担宥勮礋 ETH 閺冨墎娲块幒銉ょ炊閸樼喎顫愮€涙顑佹稉璇х礉闁灝鍘?parseFloat 缁儳瀹虫稉銏犮亼
      const sizeEthString = amountUnit === "BNB"
        ? amount  // 閻╁瓨甯撮悽銊ф暏閹寸柉绶崗銉ョ摟缁楋缚瑕嗛敍灞肩瑝缂佸繗绻?float 瀵扳偓鏉?
        : positionValueETH.toFixed(18);

      console.log(`[Order] Unit: ${amountUnit}, Input: ${amount}, Value: BNB ${positionValueETH.toFixed(4)} (~$${positionValueUSD.toFixed(2)}), Token Amount: ${positionSizeToken.toLocaleString()}, Size for contract: ${sizeEthString} BNB`);

      showToast(
        `Submitting ${isLong ? "long" : "short"} BNB ${positionValueETH.toFixed(4)} (~$${positionValueUSD.toFixed(2)})...`,
        "info"
      );

      // P2-2: 娴肩娀鈧帗顒涢惄鍫燁剾閹圭喎寮弫?
      const tpslOptions = (showTpSl && (takeProfit || stopLoss))
        ? { takeProfit: takeProfit || undefined, stopLoss: stopLoss || undefined }
        : undefined;
      const orderOptions = marketId
        ? { ...(tpslOptions || {}), marketId, collateralToken: "BNB" as const }
        : tpslOptions;

      let result;
      if (orderType === "market") {
        result = await submitMarketOrder(tokenAddress, isLong, sizeEthString, leverage, orderOptions);
      } else {
        result = await submitLimitOrder(tokenAddress, isLong, sizeEthString, leverage, limitPrice, orderOptions);
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
    marketId,
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
    setAmount,
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

  // 婢х偛鍣烘穱婵婄槈闁叉垵顦╅悶?
  const handleAdjustMargin = useCallback(async () => {
    if (!marginModal || !marginAmount || !tradingWalletAddress) return;
    const amountWei = parseEther(marginAmount).toString();
    if (BigInt(amountWei) <= 0n) {
      showToast("Enter a valid amount", "error");
      return;
    }

    setIsAdjustingMargin(true);
    try {
      // 缁涙儳鎮曟宀冪槈濞戝牊浼?
      const { pairId, action } = marginModal;
      const sigMsg = action === "add"
        ? `Add margin ${amountWei} to ${pairId} for ${tradingWalletAddress.toLowerCase()}`
        : `Remove margin ${amountWei} from ${pairId} for ${tradingWalletAddress.toLowerCase()}`;

      // 娴ｈ法鏁?useTradingWallet 鐎电厧鍤粔渚€鎸滅粵鎯ф倳
      const keyData = exportKey?.();
      if (!keyData?.privateKey) {
        showToast("Trading wallet is not active", "error");
        return;
      }
      const signerAccount = privateKeyToAccount(keyData.privateKey);
      const { createWalletClient, http } = await import("viem");
      const { bsc } = await import("viem/chains");
      const tempClient = createWalletClient({
        account: signerAccount,
        chain: bsc,
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
        showToast(action === "add" ? "Margin added" : "Margin removed", "success");
        setMarginModal(null);
        setMarginAmount("");
        refreshWalletBalance();
      } else {
        showToast(data.error || "Operation failed", "error");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "閹垮秳缍旀径杈Е", "error");
    } finally {
      setIsAdjustingMargin(false);
    }
  }, [marginModal, marginAmount, tradingWalletAddress, exportKey, showToast, refreshWalletBalance]);

  // 閳光偓閳光偓 TP/SL: 閹垫挸绱戝鍦崶閺冩儼骞忛崣鏍х秼閸撳秴鈧?閳光偓閳光偓
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

  // 閳光偓閳光偓 TP/SL: 閹绘劒姘?閳光偓閳光偓
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
      const { bsc } = await import("viem/chains");
      const tempClient = createWalletClient({ account: signerAccount, chain: bsc, transport: http() });
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

  // 閳光偓閳光偓 TP/SL: 閸欐牗绉?(with signature auth) 閳光偓閳光偓
  const handleCancelTpsl = useCallback(async (cancelType: "tp" | "sl" | "both") => {
    if (!tpslModal || !tradingWalletAddress) return;
    try {
      const keyData = exportKey?.();
      if (!keyData?.privateKey) {
        showToast("Trading wallet is not active", "error");
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
    <div className={`dydx-tradebox flex h-full flex-col bg-[#11161E] text-[12px] text-okx-text-primary ${className}`}>
      <div className="hidden border-b border-[#2B3542] px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-okx-text-primary">Trade</span>
          <span className="rounded-[0.375rem] bg-dexi-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-dexi-accent">
            {marketId ? "PERP" : "SPOT"}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-okx-text-tertiary">
          {marketId || `${tokenSymbol.toUpperCase()}-PERP`}
        </div>
      </div>

      {/* Account Section */}
      {false && isConnected && (
        <div className="border-b border-[#2B3542] px-4 py-2.5">
          {!isTradingWalletInitialized ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-okx-text-secondary">{tw("account")}</span>
                <span className="text-xs text-okx-text-tertiary">{tw("notActivated")}</span>
              </div>
              {tradingWalletError && (
                <p className="mb-2 text-xs text-red-400">{tradingWalletError}</p>
              )}
              <button
                onClick={generateWallet}
                disabled={isTradingWalletLoading}
                className="w-full rounded-[0.5rem] border border-dexi-accent/40 bg-dexi-accent-soft py-2 text-xs font-semibold text-dexi-accent transition-colors hover:bg-dexi-accent hover:text-white disabled:bg-gray-600"
              >
                {isTradingWalletLoading ? tw("activating") : tw("activateAccount")}
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-xs text-okx-text-secondary">{tw("account")}</span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-okx-text-primary">
                  BNB {availableBalanceETH.toFixed(4)}
                </span>
                <button
                  onClick={() => setShowDepositModal(true)}
                  className="rounded-[0.5rem] border border-okx-border-secondary px-2.5 py-0.5 text-xs font-medium text-okx-text-primary transition-colors hover:border-okx-border-hover hover:bg-okx-bg-hover"
                >
                  {tw("deposit")}
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  className="p-1 text-okx-text-tertiary transition-colors hover:text-okx-text-primary"
                  title={tw("accountSettings")}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Deposit Modal - 閻╁瓨甯撮梿鍡樺灇 AccountBalance 缂佸嫪娆?*/}
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

              {/* 缁変線鎸滅€电懓绨查惃鍕勾閸р偓 閳?閻劋绨宀冪槈 */}
              <div className="bg-okx-bg-primary rounded-lg p-3 border border-okx-border-primary">
                <p className="text-xs text-okx-text-tertiary mb-1">Trading wallet address (derived from private key):</p>
                <p className="text-xs text-okx-text-primary font-mono break-all">
                  {(() => {
                    try {
                      return privateKeyToAccount(privateKeyData.privateKey as `0x${string}`).address;
                    } catch {
                      return "Invalid private key";
                    }
                  })()}
                </p>
                {tradingWalletAddress && (() => {
                  try {
                    const derived = privateKeyToAccount(privateKeyData.privateKey as `0x${string}`).address;
                    const match = derived.toLowerCase() === tradingWalletAddress.toLowerCase();
                    return (
                      <p className={`text-xs mt-1 ${match ? "text-green-400" : "text-red-400"}`}>
                        {match ? "Address matches" : "Address mismatch"}
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
      <div className="flex h-[2.625rem] shrink-0 items-center gap-2 border-b border-[#2B3542] px-4">
        <div className="grid h-9 flex-1 grid-cols-2 gap-1 rounded-[0.375rem] bg-[#18191E] p-0.5">
          <button
            disabled
            className="relative flex-1 cursor-not-allowed rounded-[0.25rem] text-[11px] text-okx-text-tertiary opacity-50 transition-colors"
            title="Coming Soon"
          >
            全仓
          </button>
          <button
            onClick={() => setMarginMode("isolated")}
            className="flex-1 rounded-[0.25rem] bg-[#222A35] text-[11px] text-okx-text-primary transition-colors"
          >
            逐仓
          </button>
        </div>

        <button
          onClick={() => setShowLeverageSlider(!showLeverageSlider)}
          className="flex h-9 min-w-[72px] items-center justify-center gap-1 rounded-[0.375rem] border border-[#2B3542] bg-[#18191E] text-xs font-semibold text-okx-text-primary transition-colors hover:border-[#4D4E57] hover:text-dexi-accent"
        >
          {leverage}x
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

        {/* Leverage Slider */}
        {showLeverageSlider && (
          <div className="border-b border-[#2B3542] px-4 py-3 space-y-2">
            <input
              type="range"
              min="1"
              max="2.5"
              step="0.5"
              value={leverage}
              onChange={(e) => setLeverage(parseFloat(e.target.value))}
              className="h-1 w-full cursor-pointer appearance-none rounded-lg bg-okx-bg-hover accent-[#5EEAD4]"
            />
            <div className="flex justify-between text-xs text-okx-text-tertiary">
              {leverageOptions.map((lev) => (
                <button
                  key={lev}
                  onClick={() => setLeverage(lev)}
                  className={`px-1 py-0.5 rounded ${
                    leverage === lev
                      ? "text-dexi-accent"
                      : "hover:text-okx-text-secondary"
                  }`}
                >
                  {lev}x
                </button>
              ))}
            </div>
          </div>
        )}

      {/* Long/Short Tabs */}
      <div className="border-b border-[#2B3542]">
          <div className="grid h-[2.625rem] grid-cols-2">
        <button
          onClick={() => setSide("long")}
          className={`relative flex-1 rounded-none text-xs font-semibold transition-colors ${
            side === "long"
              ? "text-[#20D7A1]"
              : "text-okx-text-tertiary hover:text-okx-text-secondary"
          }`}
        >
          买入 | 做多
          {side === "long" && <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#20D7A1]" />}
        </button>
        <button
          onClick={() => setSide("short")}
          className={`relative flex-1 rounded-none text-xs font-semibold transition-colors ${
            side === "short"
              ? "text-[#F45B69]"
              : "text-okx-text-tertiary hover:text-okx-text-secondary"
          }`}
        >
          卖出 | 做空
          {side === "short" && <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#F45B69]" />}
        </button>
          </div>
      </div>

      {/* Order Form */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {/* Order Type Tabs - 鐢倷鐜?闂勬劒鐜?*/}
        <div className="-mx-4 -mt-3 mb-1 grid h-[2.625rem] grid-cols-3 border-b border-[#2B3542]">
          <button
            onClick={() => setOrderType("limit")}
            className={`relative rounded-none text-xs transition-colors ${
              orderType === "limit"
                ? "text-okx-text-primary font-medium"
                : "text-okx-text-tertiary hover:text-okx-text-secondary"
            }`}
          >
            限价
            {orderType === "limit" && <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#5EEAD4]" />}
          </button>
          <button
            onClick={() => setOrderType("market")}
            className={`relative rounded-none text-xs transition-colors ${
              orderType === "market"
                ? "text-okx-text-primary font-medium"
                : "text-okx-text-tertiary hover:text-okx-text-secondary"
            }`}
          >
            市场
            {orderType === "market" && <span className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#5EEAD4]" />}
          </button>
          <button
            disabled
            className="relative rounded-none text-xs text-okx-text-tertiary transition-colors"
          >
            高级⌄
          </button>
        </div>

        {/* Limit Price Input - 闂勬劒鐜崡鏇氱幆閺?*/}
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
              className="w-full rounded-[0.5rem] border border-okx-border-primary bg-[#10141B] px-3 py-1.5 text-xs text-okx-text-primary outline-none placeholder:text-okx-text-tertiary focus:border-dexi-accent"
            />
          </div>
        )}

        {/* Amount Input - 閻劍鍩涢崣顖炩偓澶嬪閸楁洑缍?*/}
        <div>
          <div className="flex justify-between items-center text-xs mb-1">
            <span className="text-okx-text-tertiary">金额</span>
            {/* 閸楁洑缍呴崚鍥ㄥ床閹稿鎸?(ETH 閺堫兛缍? */}
            <div className="flex gap-1 rounded-[0.5rem] bg-[#10141B] p-0.5">
              {(["BNB", "TOKEN"] as const).map((unit) => (
                <button
                  key={unit}
                  onClick={() => {
                    setAmountUnit(unit);
                    setAmount(""); // 閸掑洦宕查弮鑸电缁岄缚绶崗?
                  }}
                  className={`rounded-[0.375rem] px-2 py-0.5 text-xs transition-colors ${
                    amountUnit === unit
                       ? "bg-dexi-accent text-[#061215] font-medium"
                      : "text-okx-text-tertiary hover:text-okx-text-secondary"
                  }`}
                >
                  {unit === "TOKEN" ? tokenSymbol : unit}
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
                `输入 ${tokenSymbol} 数量`
              }
                className={`w-full rounded-[0.5rem] border bg-[#10141B] px-3 py-1.5 pr-16 text-xs text-okx-text-primary outline-none placeholder:text-okx-text-tertiary ${
                amountError
                  ? "border-okx-down focus:border-okx-down"
                  : "border-okx-border-primary focus:border-dexi-accent"
              }`}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-dexi-accent font-medium">
              {amountUnit === "TOKEN" ? tokenSymbol : amountUnit}
            </span>
          </div>
          {amountError && (
            <div className="text-xs text-okx-down mt-1">{amountError}</div>
          )}
          {/* 韫囶偅宓庨幐澶愭尦 - 閺嶈宓侀崡鏇氱秴閺勫墽銇氭稉宥呮倱闁銆?(ETH 閺堫兛缍? */}
          <div className="mt-3">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(displayedAmountPercent)}
                onChange={(event) => setAmountByPercent(Number(event.target.value))}
                aria-label="订单金额比例"
                className="dexi-size-slider flex-1"
                style={{ "--dexi-slider-progress": `${displayedAmountPercent}%` } as React.CSSProperties}
              />
              <button
                type="button"
                onClick={() => setAmountByPercent(0)}
                className="h-8 min-w-[48px] rounded-[0.375rem] bg-[#222A35] px-2 text-xs font-semibold tabular-nums text-[#A7B2BE] transition-colors hover:bg-[#2B3542] hover:text-[#F3F7F9]"
              >
                {Math.round(displayedAmountPercent)}%
              </button>
            </div>
            <div className="mt-1.5 grid grid-cols-5 text-[10px] text-[#77838F]">
              {[0, 25, 50, 75, 100].map((percent) => (
                <button
                  key={percent}
                  type="button"
                  onClick={() => setAmountByPercent(percent)}
                  className={`tabular-nums transition-colors hover:text-[#A7B2BE] ${
                    percent === 0 ? "text-left" : percent === 100 ? "text-right" : "text-center"
                  } ${Math.round(displayedAmountPercent) === percent ? "text-[#5EEAD4]" : ""}`}
                >
                  {percent}%
                </button>
              ))}
            </div>
          </div>
          <div className="mt-1.5 hidden gap-1.5">
            {amountUnit === "BNB" && [0.01, 0.05, 0.1, 0.5].map((val) => (
              <button
                key={val}
                onClick={() => setAmount(val.toString())}
                 className="flex-1 rounded-[0.5rem] bg-[#1D2430] py-1 text-[11px] text-okx-text-tertiary transition-colors hover:text-okx-text-secondary"
              >
                {val}
              </button>
            ))}
            {amountUnit === "TOKEN" && ["1K", "10K", "100K", "1M"].map((label, idx) => (
              <button
                key={label}
                onClick={() => setAmount([1000, 10000, 100000, 1000000][idx].toString())}
                 className="flex-1 rounded-[0.5rem] bg-[#1D2430] py-1 text-[11px] text-okx-text-tertiary transition-colors hover:text-okx-text-secondary"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* TP/SL Toggle - 濮濄垻娉╁銏″疮 */}
        <div>
          <button
            onClick={() => setShowTpSl(!showTpSl)}
            className="flex items-center gap-2 text-xs text-okx-text-secondary hover:text-okx-text-primary transition-colors"
          >
              <div className={`flex h-4 w-4 items-center justify-center rounded-[0.375rem] border transition-colors ${
              showTpSl ? "bg-dexi-accent border-dexi-accent" : "border-okx-border-primary"
            }`}>
              {showTpSl && (
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
            <span>TP/SL</span>
          </button>

          {showTpSl && (
            <div className="mt-2 space-y-2 rounded-[0.5rem] border border-okx-border-primary bg-okx-bg-hover/50 p-3">
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
                  className="w-full rounded-[0.5rem] border border-okx-border-primary bg-okx-bg-primary px-3 py-1.5 text-sm text-okx-text-primary outline-none placeholder:text-okx-text-tertiary focus:border-okx-up"
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
                  className="w-full rounded-[0.5rem] border border-okx-border-primary bg-okx-bg-primary px-3 py-1.5 text-sm text-okx-text-primary outline-none placeholder:text-okx-text-tertiary focus:border-okx-down"
                />
              </div>
            </div>
          )}
        </div>

        {/* Order Summary - 娴犲懎婀悽銊﹀煕鏉堟挸鍙嗘禍鍡樻殶闁插繐鎮楅弰鍓с仛 (閸欏倽鈧?OKX) */}
        {parseFloat(amount) > 0 && positionValueETH > 0 && (
          <div className="space-y-2 rounded-[0.5rem] bg-okx-bg-hover p-3 text-xs">
            {/* 娴犳挷缍呮禒宄扳偓?(ETH 閺堫兛缍? */}
            <div className="flex justify-between">
              <span className="text-okx-text-tertiary">Position value</span>
              <span className="text-okx-text-primary">
                閳?BNB {positionValueETH.toFixed(4)} (~${positionValueUSD.toFixed(2)})
              </span>
            </div>
            {/* 婵梹澧柌?(娴狅絽绔甸弫浼村櫤) */}
            <div className="flex justify-between">
              <span className="text-okx-text-tertiary">Order quantity</span>
              <span className="text-okx-text-primary">
                {positionSizeToken >= 1000000
                  ? `${(positionSizeToken / 1000000).toFixed(2)}M`
                  : positionSizeToken >= 1000
                  ? `${(positionSizeToken / 1000).toFixed(2)}K`
                  : positionSizeToken.toFixed(2)} {tokenSymbol}
              </span>
            </div>
            {/* 閹碘偓闂団偓娣囨繆鐦夐柌?(ETH 閺堫兛缍? */}
            <div className="flex justify-between">
              <span className="text-okx-text-tertiary">Required margin</span>
              <span className="text-okx-text-primary">
                {requiredMarginDisplay}
              </span>
            </div>
            {/* 閹靛鐢荤拹?(ETH 閺堫兛缍? 閳?Taker 0.05%, Maker 0.03% */}
            <div className="flex justify-between">
              <span className="text-okx-text-tertiary">{orderType === "limit" ? `${t("fee")} (Maker 0.03%)` : `${t("fee")} (Taker 0.05%)`}</span>
              <span className="text-okx-text-primary">
                BNB {(positionValueETH * (orderType === "limit" ? 0.0003 : 0.0005)).toFixed(6)}
              </span>
            </div>
            {/* 閸氬牐顓搁幍鈧棁鈧?*/}
            <div className="flex justify-between border-t border-okx-border-primary pt-2">
              <span className="text-okx-text-secondary font-medium">Total required</span>
              <span className="text-okx-text-primary font-medium">
                {requiredMarginDisplay}
              </span>
            </div>
          </div>
        )}

        {/* Insufficient Balance Warning */}
        {!hasSufficientBalance && parseFloat(amount) > 0 && (
          <div className="bg-okx-down/10 border border-okx-down/30 rounded p-2 text-xs text-okx-down">
            {tw("insufficientBalance")}
          </div>
        )}

        {/* Trading Wallet Not Initialized Warning */}
        {isConnected && !isTradingWalletInitialized && (
          <div className="rounded-lg border border-yellow-500/25 bg-yellow-500/10 p-2 text-xs text-yellow-200">
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
        {!isConnected ? (
          <button
            type="button"
            onClick={() => openConnectModal?.()}
            disabled={!isPerpEnabled}
            className="hidden"
          >
            {!isPerpEnabled
              ? t("perpNotEnabled") || "Perp trading not enabled"
              : tc("connectWallet") || "Connect Wallet"}
          </button>
        ) : (
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
            className={`w-full rounded-[0.625rem] py-2.5 text-xs font-semibold transition-all ${
              !isPerpEnabled
                ? "bg-gray-600 text-gray-400"
                : side === "long"
                ? "bg-[#2C5254] text-[#20D7A1] hover:bg-[#356265] disabled:bg-[#2C5254]/50"
                : "bg-[#462C2E] text-[#F45B69] hover:bg-[#523538] disabled:bg-[#462C2E]/50"
            } disabled:cursor-not-allowed`}
          >
            {!isPerpEnabled
              ? t("perpNotEnabled") || "Perp trading not enabled"
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
        )}

        <div className="mt-4 space-y-3 rounded-[0.5rem] border border-[#2B3542] bg-[#11161E] p-3 text-xs">
          {[
            ["预期价格", amount ? marketId ? `$${oraclePriceUsd?.toFixed(6) || "--"}` : "--" : "--"],
            ["清算价格", amount ? "--" : "--"],
            ["头寸保证金", amount ? requiredMarginDisplay : "--"],
            ["费用", amount ? (orderType === "limit" ? "Maker 0.03%" : "Taker 0.05%") : "--"],
            ["奖励", "--"],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <span className="text-[#77838F]">{label}</span>
              <span className="font-mono text-[#D7D8DE]">{value}</span>
            </div>
          ))}
          <button
            disabled
            className="mt-2 flex h-11 w-full items-center justify-center rounded-[0.5rem] border border-[#374555] bg-[#11161E] text-xs font-semibold text-[#AEB0BA]"
          >
            ⚠ 不能使用
          </button>
        </div>
      </div>

      {/* Positions Section - 瑜版挸澧犳禒鎾茬秴 */}
      {currentTokenPositions.length > 0 && (
        <div className="border-t border-[#2B3542] bg-[#10141B]/45 p-3">
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
                        className="rounded-md border border-[#20D7A1]/25 bg-[#20D7A1]/10 px-2 py-1.5 text-xs text-[#20D7A1] transition-colors hover:bg-[#20D7A1]/15"
                        title={t("adjustMargin") || "Add Margin"}
                      >
                        <Plus size={12} />
                      </button>
                      <button
                        onClick={() => setMarginModal({ pairId: p.pairId, action: "remove", collateral: computed.collateralETH })}
                        className="rounded-md border border-[#F45B69]/25 bg-[#F45B69]/10 px-2 py-1.5 text-xs text-[#F45B69] transition-colors hover:bg-[#F45B69]/15"
                        title={t("adjustMargin") || "Remove Margin"}
                      >
                        <Minus size={12} />
                      </button>
                      <button
                        onClick={() => setTpslModal({ pairId: p.pairId, isLong: p.isLong, entryPrice: computed.entryPrice, liqPrice: computed.liqPrice })}
                        className="rounded-md border border-[#2B3542] px-2 py-1.5 text-[10px] text-[#77838F] transition-colors hover:border-[#5EEAD4]/35 hover:text-[#8FF7E8]"
                      >
                        TP/SL
                      </button>
                      <button
                        onClick={() => handleClosePosition(p.pairId)}
                        disabled={isSubmittingOrder || isPending}
                        className="flex-1 rounded-md bg-[#462C2E] py-1.5 text-xs text-[#F45B69] transition-colors hover:bg-[#523538] disabled:opacity-50"
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
      <div className="border-t border-[#2B3542] bg-[#10141B] p-3">
        <div className="flex justify-between text-xs">
          <div className="flex items-center gap-2">
            <span className="text-okx-text-tertiary">Positions:</span>
            <span className={currentTokenPositions.length > 0 ? "text-okx-text-primary" : "text-okx-text-tertiary"}>
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

      {/* 婢х偛鍣烘穱婵婄槈闁?Modal */}
      {marginModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setMarginModal(null)}>
          <div className="w-80 max-w-[90vw] rounded-xl border border-[#2B3542] bg-[#151A22] p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-okx-text-primary mb-3">
              {marginModal.action === "add" ? "Add margin" : "Remove margin"}
            </h3>
            <div className="text-xs text-okx-text-secondary mb-3">
              Current margin: BNB {marginModal.collateral.toFixed(4)}
            </div>
            <input
              type="number"
              value={marginAmount}
              onChange={e => setMarginAmount(e.target.value)}
              placeholder="Enter BNB amount"
              step="0.001"
              min="0"
              className="mb-3 w-full rounded-lg border border-[#2B3542] bg-[#10141B] px-3 py-2 text-sm text-okx-text-primary outline-none focus:border-[#5EEAD4]"
            />
            <div className="flex gap-2 mb-3">
              {[0.005, 0.01, 0.05, 0.1].map(v => (
                <button
                  key={v}
                  onClick={() => setMarginAmount(v.toString())}
                  className="flex-1 rounded-md border border-[#2B3542] py-1 text-xs text-[#A7B2BE] hover:bg-[#1D2430]"
                >
                  {v}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setMarginModal(null); setMarginAmount(""); }}
                className="flex-1 rounded-lg border border-[#2B3542] py-2 text-xs text-[#A7B2BE] hover:bg-[#1D2430]"
              >
                Cancel
              </button>
              <button
                onClick={handleAdjustMargin}
                disabled={isAdjustingMargin || !marginAmount}
                className={`flex-1 rounded-lg py-2 text-xs disabled:opacity-50 ${
                  marginModal.action === "add" ? "bg-[#2C5254] text-[#20D7A1] hover:bg-[#356265]" : "bg-[#462C2E] text-[#F45B69] hover:bg-[#523538]"
                }`}
              >
                {isAdjustingMargin ? "Processing..." : marginModal.action === "add" ? "Add" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TP/SL Modal */}
      {tpslModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => setTpslModal(null)}>
          <div className="w-[380px] max-w-[92vw] rounded-xl border border-[#2B3542] bg-[#151A22] shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[#2B3542] px-5 py-3.5">
              <h3 className="text-sm font-medium text-okx-text-primary">{t("takeProfitStopLoss") || "TP/SL"}</h3>
              <button onClick={() => setTpslModal(null)} className="text-lg text-okx-text-tertiary hover:text-okx-text-primary">x</button>
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
                <div className="flex items-center rounded-lg border border-[#2B3542] bg-[#10141B] px-3 py-2.5 transition-colors focus-within:border-[#20D7A1]/45">
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
                <div className="flex items-center rounded-lg border border-[#2B3542] bg-[#10141B] px-3 py-2.5 transition-colors focus-within:border-[#F45B69]/45">
                  <input type="number" value={slInput} onChange={e => setSlInput(e.target.value)}
                    placeholder={tpslModal.isLong ? `< ${formatSmallPrice(tpslModal.entryPrice)}` : `> ${formatSmallPrice(tpslModal.entryPrice)}`}
                    step="any" className="flex-1 bg-transparent text-sm text-okx-text-primary outline-none placeholder-okx-text-tertiary/50" />
                  <span className="text-[10px] text-okx-text-tertiary ml-2">BNB</span>
                </div>
                <div className="text-[10px] text-okx-text-tertiary mt-1 px-1">
                  {tpslModal.isLong ? t("slHintLong") || "Trigger when price falls below" : t("slHintShort") || "Trigger when price rises above"}
                </div>
              </div>
              <div className="space-y-1 rounded-lg border border-[#2B3542] bg-[#10141B] p-3 text-[10px] text-okx-text-tertiary">
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
                    className="flex-1 rounded-lg border border-[#2B3542] py-2.5 text-sm font-medium text-okx-text-secondary transition-colors hover:bg-[#1D2430]">
                    {t("cancelAll") || "Cancel All"}
                  </button>
                )}
                <button onClick={handleSetTpsl} disabled={isSettingTpsl || (!tpInput && !slInput)}
            className="flex-1 rounded-lg bg-[#5EEAD4] py-2.5 text-sm font-semibold text-[#061215] transition-all hover:bg-[#8FF7E8] disabled:cursor-not-allowed disabled:opacity-40">
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

