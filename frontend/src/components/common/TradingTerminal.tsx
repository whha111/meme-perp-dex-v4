"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { PriceBoard } from "./PriceBoard";
import { SwapPanelOKX } from "@/components/spot/SwapPanelOKX";
import { TradeHistory, Trade } from "./TradeHistory";
import { SecurityStatus } from "./SecurityStatusBanner";
import { TopHolders } from "@/components/spot/TopHolders";
import { formatUnits, keccak256, toBytes } from "viem";
import { useInstrumentTradeStream, TradeEvent } from "@/hooks/common/streaming/useTradeStream";
import dynamic from 'next/dynamic';
import {
  getWebSocketServices,
  InstrumentAssetData,
} from "@/lib/websocket";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";
import { useAppStore } from "@/lib/stores/appStore";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { LiquidityPanel } from "@/components/spot/LiquidityPanel";
import { MyHoldings } from "@/components/spot/MyHoldings";
import { ProfitableAddresses } from "@/components/spot/ProfitableAddresses";
import { useTokenMetadata } from "@/hooks/common/useTokenMetadata";
import { useTokenInfo, getTokenDisplayName } from "@/hooks/common/useTokenInfo";
import { usePoolState, calculatePriceUsd, calculateMarketCapUsd } from "@/hooks/spot/usePoolState";
import { useOnChainTrades, OnChainTrade } from "@/hooks/perpetual/useOnChainTrades";
import { tradeEventEmitter } from "@/lib/tradeEvents";
import { TradingErrorBoundary } from "@/components/shared/TradingErrorBoundary";

// 格式化 USD 市值（紧凑格式：K/M 后缀）
function formatUsdCompact(usd: number): string {
  if (usd <= 0) return "0.00";
  if (usd >= 1_000_000) return (usd / 1_000_000).toFixed(2) + "M";
  if (usd >= 1_000) return (usd / 1_000).toFixed(2) + "K";
  if (usd >= 1) return usd.toFixed(2);
  if (usd >= 0.01) return usd.toFixed(4);
  return usd.toFixed(6);
}

// 格式化 ETH 本位价格，使用下标表示法 (e.g., 0.0₅62087 ETH)
function formatSmallPriceETH(priceEth: number): string {
  if (priceEth <= 0) return "0 ETH";
  if (priceEth >= 0.01) return priceEth.toFixed(4) + " ETH";
  if (priceEth >= 0.0001) return priceEth.toFixed(6) + " ETH";

  // 对于非常小的价格，使用下标表示法
  const priceStr = priceEth.toFixed(18);
  const match = priceStr.match(/^0\.(0*)([1-9]\d*)/);
  if (match) {
    const zeroCount = match[1].length;
    const significantDigits = match[2].slice(0, 5); // 保留5位有效数字
    const subscripts = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
    const subscriptNum = zeroCount.toString().split('').map(d => subscripts[parseInt(d)]).join('');
    return `0.0${subscriptNum}${significantDigits} ETH`;
  }

  return priceEth.toFixed(8) + " ETH";
}

// 测试代币常用的占位域名，跳过 fetch 避免 CORS 报错
const BLOCKED_METADATA_DOMAINS = ['example.com', 'example.org', 'example.net'];

// 模块级缓存 — 组件 remount 后不丢失，避免重复请求已失败的 URI
const failedMetadataURIs = new Set<string>();

// 格式化 ETH 金额为显示值
function formatETHValue(ethAmount: number): string {
  if (ethAmount <= 0) return "0 ETH";
  if (ethAmount >= 1) return ethAmount.toFixed(4) + " ETH";
  return ethAmount.toFixed(5) + " ETH";
}

// 动态导入图表组件以避免 SSR 问题并减小初始包体积
const TokenPriceChart = dynamic(
  () => import('@/components/spot/TokenPriceChart').then((mod) => mod.TokenPriceChart),
  {
    ssr: false,
    loading: () => <div className="w-full h-full bg-[#131722] animate-pulse" />
  }
);

interface TradingTerminalProps {
  symbol: string; // 交易对符号，如 "PEPE"
  className?: string;
  /** 可选: 顶部 Token 选择器插槽 (替换默认面包屑) */
  headerSlot?: React.ReactNode;
}

export function TradingTerminal({ symbol, className, headerSlot }: TradingTerminalProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("tradeActivity");
  const [realtimeTrades, setRealtimeTrades] = useState<Trade[]>([]);

  // 构造 instId (用于API调用)
  const instId = symbol;

  // 从 symbol 提取纯地址（去掉 -USDT 后缀 + 小写化）
  // symbol 格式可能是 "0x...-USDT" 或 "0x..." 或 "BTC-USDT"
  const isTokenAddress = symbol?.startsWith("0x");
  // ⚠️ 小写化！URL 中的 mixed-case 地址 checksum 可能不合法，viem 会拒绝
  const pureTokenAddress = isTokenAddress ? symbol.split("-")[0].toLowerCase() : null;
  const isValidTokenAddress = pureTokenAddress && pureTokenAddress.length === 42;

  // 从 matching engine 获取代币名称和符号
  // ⚠️ 必须用 pureTokenAddress（纯地址），不能用 symbol（含 -USDT 后缀 → length≠42 → 查找失败）
  const tokenInfo = useTokenInfo(pureTokenAddress || symbol);
  const displaySymbol = getTokenDisplayName(pureTokenAddress || symbol, tokenInfo);

  // 获取实时 ETH 价格
  const { price: ethPriceUsd } = useETHPrice();
  const poolData = usePoolState(isValidTokenAddress ? pureTokenAddress : undefined);

  // 获取链上交易记录
  const {
    trades: onChainTrades,
    refetch: refetchOnChainTrades,
  } = useOnChainTrades(isValidTokenAddress ? pureTokenAddress : null, {
    enabled: !!isValidTokenAddress,
    resolutionSeconds: 60,
  });

  // 订阅交易事件，实现交易活动的实时更新
  useEffect(() => {
    if (!symbol) return;

    const unsubscribe = tradeEventEmitter.subscribe((tradedToken, txHash) => {
      if (tradedToken.toLowerCase() === symbol.toLowerCase()) {
        // 刷新链上交易记录
        refetchOnChainTrades();
        // 刷新后端交易历史
        queryClient.invalidateQueries({ queryKey: ["tradeHistory", instId] });
      }
    });

    return unsubscribe;
  }, [symbol, instId, refetchOnChainTrades, queryClient]);

  // 获取 IPFS 内容的网关 URL
  const getIPFSGatewayUrl = (uri: string): string => {
    if (uri.startsWith('ipfs://')) {
      const hash = uri.replace('ipfs://', '');
      return `https://gateway.pinata.cloud/ipfs/${hash}`;
    }
    return uri;
  };

  // 验证 URI 是否为可获取的格式（排除占位域名）
  const isValidFetchableURI = (uri: string): boolean => {
    if (!uri) return false;
    if (uri.startsWith('data:')) return true;
    if (uri.startsWith('ipfs://')) return true;
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      try {
        const url = new URL(uri);
        if (BLOCKED_METADATA_DOMAINS.includes(url.hostname)) return false;
      } catch { return false; }
      return true;
    }
    // 有效的 IPFS CID (Qm... 或 bafy...)
    if (uri.startsWith('Qm') && uri.length === 46) return true;
    if (uri.startsWith('bafy')) return true;
    return false;
  };

  // 从 metadataURI 获取图片 URL
  // metadataURI 可能是：1. 直接的图片 URL/IPFS  2. JSON 元数据文件  3. base64 编码的 JSON
  const [tokenLogoUrl, setTokenLogoUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    const fetchMetadataImage = async (uri: string | undefined) => {
      if (!uri) {
        setTokenLogoUrl(undefined);
        return;
      }

      // 跳过无效 URI 格式（如 "test-pepe-metadata" 这种纯字符串）
      if (!isValidFetchableURI(uri)) {
        return;
      }

      // 跳过已失败的 URI
      if (failedMetadataURIs.has(uri)) {
        return;
      }

      try {
        // 如果是 data URI (base64 JSON)，直接解析
        if (uri.startsWith('data:application/json;base64,')) {
          const base64Data = uri.replace('data:application/json;base64,', '');
          const jsonStr = atob(base64Data);
          const metadata = JSON.parse(jsonStr);
          const imageUrl = metadata.image || metadata.logo;
          if (imageUrl) {
            setTokenLogoUrl(getIPFSGatewayUrl(imageUrl));
          }
          return;
        }

        // 如果是 IPFS 或 HTTP URL
        if (uri.startsWith('ipfs://') || uri.startsWith('http')) {
          const fetchUrl = getIPFSGatewayUrl(uri);

          // 先尝试 HEAD 请求检查内容类型
          try {
            const headResponse = await fetch(fetchUrl, { method: 'HEAD' });
            if (!headResponse.ok) {
              failedMetadataURIs.add(uri);
              return;
            }
            const contentType = headResponse.headers.get('content-type') || '';

            // 如果是图片，直接使用这个 URL
            if (contentType.startsWith('image/')) {
              setTokenLogoUrl(fetchUrl);
              return;
            }

            // 如果是 JSON，解析并提取 image 字段
            if (contentType.includes('json')) {
              const response = await fetch(fetchUrl);
              if (response.ok) {
                const metadata = await response.json();
                const imageUrl = metadata.image || metadata.logo;
                if (imageUrl) {
                  setTokenLogoUrl(getIPFSGatewayUrl(imageUrl));
                  return;
                }
              }
            }
          } catch {
            // HEAD 请求失败，记录并跳过
            failedMetadataURIs.add(uri);
            return;
          }
        }

        // 有效的 IPFS CID，构建 gateway URL
        if (uri.startsWith('Qm') || uri.startsWith('bafy')) {
          setTokenLogoUrl(`https://gateway.pinata.cloud/ipfs/${uri}`);
        }
      } catch (e) {
        console.warn('Failed to fetch metadata image:', uri);
        failedMetadataURIs.add(uri);
      }
    };

    fetchMetadataImage(poolData.poolState?.metadataURI);
  }, [poolData.poolState?.metadataURI]);

  // [DEBUG] 暂时移除 fetchMetadata
  // useEffect(() => {
  //   if (instId) {
  //     fetchMetadata(instId);
  //   }
  // }, [instId, fetchMetadata]);

  // 计算 instHash
  const instHash = useMemo(() => {
    if (!instId) return undefined;
    return keccak256(toBytes(instId));
  }, [instId]);

  // [DEBUG] 暂时移除 addRecentInstrument
  // const addRecentInstrument = useAppStore((state) => state.addRecentInstrument);
  // useEffect(() => {
  //   if (instId) {
  //     addRecentInstrument(instId);
  //   }
  // }, [instId, addRecentInstrument]);

  // [DEBUG] 使用 ref 来存储 displaySymbol 和 ethPriceUsd，避免 callback 重建
  const displaySymbolRef = React.useRef(displaySymbol);
  const ethPriceUsdRef = React.useRef(ethPriceUsd);

  React.useEffect(() => {
    displaySymbolRef.current = displaySymbol;
    ethPriceUsdRef.current = ethPriceUsd;
  }, [displaySymbol, ethPriceUsd]);

  // 实时交易流处理（带去重逻辑）- 使用 ref 避免重建
  const handleRealtimeTrade = useCallback((trade: TradeEvent) => {
    const currentDisplaySymbol = displaySymbolRef.current;

    const priceEth = parseFloat(trade.newPrice) / 1e18;
    const ethAmount = parseFloat(trade.ethAmount) / 1e18;

    const newTrade: Trade = {
      timestamp: trade.timestamp * 1000,
      type: trade.tradeType.toLowerCase() as "buy" | "sell",
      totalValue: formatETHValue(ethAmount),
      price: formatSmallPriceETH(priceEth),
      // AUDIT-FIX FC-C02: 与历史交易格式一致 — 先 /1e18 得到实际 token 数, 再 /1e6 + "M" 后缀
      quantity: (trade.tradeType === "BUY" ? "+" : "-") + (parseFloat(trade.tokenAmount) / 1e18 / 1e6).toFixed(2) + "M " + currentDisplaySymbol,
      quantitySol: (trade.tradeType === "BUY" ? "-" : "+") + ethAmount.toFixed(5) + " ETH",
      address: trade.traderAddress.slice(0, 6) + "..." + trade.traderAddress.slice(-4),
      txHash: trade.txHash,
      isNew: true,
    };

    setRealtimeTrades(prev => {
      if (prev.some(t => t.txHash === newTrade.txHash)) {
        return prev;
      }
      const updatedPrev = prev.map(t => ({ ...t, isNew: false }));
      return [newTrade, ...updatedPrev].slice(0, 50);
    });
  }, []); // 空依赖，使用 ref 获取最新值

  // [DEBUG] 暂时移除 WebSocket 资产更新订阅
  // useEffect(() => { ... }, [instId]);

  // [DEBUG] 暂时移除 useInstrumentTradeStream
  // const { latestTrade } = useInstrumentTradeStream(instId, { ... });
  const latestTrade = null;

  // 从 tradingDataStore 读取 WSS 推送的实时市场数据（由 useUnifiedWebSocket 填充）
  const tokenAddress = pureTokenAddress?.toLowerCase() as `0x${string}` | undefined;
  const tokenStats = useTradingDataStore(state => {
    return tokenAddress ? state.tokenStats.get(tokenAddress) : null;
  });

  // Fetch Trade History
  const { data: tradesData, isLoading: isTradesLoading, error: tradesError } = useQuery({
    queryKey: ["tradeHistory", instId],
    queryFn: async () => {
      const wsServices = getWebSocketServices();
      const response = await wsServices.getTradeHistory({
        inst_id: instId,
        page_size: 50,
      });

      if (!response.transactions) {
        return [];
      }

      return response.transactions.map((tx) => {
        const isBuy = tx.transaction_type === "BUY";
        const trader = isBuy ? tx.buyer_wallet : tx.seller_wallet;
        const priceEth = parseFloat(tx.price) / 1e18;
        const tokenAmount = parseFloat(tx.token_amount) / 1e18;
        const ethAmount = priceEth * tokenAmount;

        return {
          timestamp: Number(tx.transaction_timestamp) * 1000,
          type: isBuy ? "buy" : "sell",
          totalValue: formatETHValue(ethAmount),
          price: formatSmallPriceETH(priceEth),
          quantity: (isBuy ? "+" : "-") + (tokenAmount / 1e6).toFixed(2) + "M " + displaySymbol,
          quantitySol: (isBuy ? "-" : "+") + ethAmount.toFixed(5) + " ETH",
          address: (trader || "0x0000...0000").slice(0, 6) + "..." + (trader || "0x0000").slice(-4),
          txHash: tx.tx_hash,
        };
      }) as Trade[];
    },
    enabled: !!instId,
    staleTime: 5000,
    refetchOnWindowFocus: false, // [DEBUG] 禁用
    retry: 2,
  });

  // 安全地解析 securityStatus (默认 AUTHENTIC)
  const securityStatus = 'AUTHENTIC' as SecurityStatus;

  // 从合约数据获取供应量和状态（使用稳定的引用）
  const poolSoldSupply = poolData.poolState?.soldTokens?.toString();
  const poolCreator = poolData.poolState?.creator;
  const poolIsGraduated = poolData.poolState?.isGraduated;
  const poolIsActive = poolData.poolState?.isActive;

  // 构建 metadata 对象传给 PriceBoard
  const tokenMetadata = useMemo(() => {
    if (!tokenLogoUrl) return undefined;
    return {
      logoUrl: tokenLogoUrl,
    };
  }, [tokenLogoUrl]);

  // 从合约数据获取池子状态
  const isPoolGraduated = poolIsGraduated ?? false;
  const isPoolActive = poolIsActive ?? true;
  const poolTotalSupply = "1000000000000000000000000000"; // 1B tokens in wei

  // 构建 displayData — 合约数据 + WSS 数据合并
  const displayData = useMemo(() => {
    const tokenAddressFromSymbol = isTokenAddress ? symbol : undefined;
    return {
      instId,
      currentPrice: tokenStats?.lastPrice || "0",
      fdv: "0",
      volume24h: tokenStats?.volume24h || "0",
      priceChange24h: parseFloat(tokenStats?.priceChangePercent24h || "0"),
      securityStatus: 'AUTHENTIC' as SecurityStatus,
      tokenAddress: tokenAddressFromSymbol,
      creatorAddress: poolCreator,
      soldSupply: poolSoldSupply,
      totalSupply: poolTotalSupply,
    } as InstrumentAssetData;
  }, [tokenStats, instId, isTokenAddress, symbol, poolSoldSupply, poolCreator]);

  // 安全地将字符串转换为 BigInt
  const safeBigInt = (value: string | undefined): bigint => {
    if (!value || value === "") return 0n;
    const intPart = value.split('.')[0];
    try {
      return BigInt(intPart || "0");
    } catch {
      return 0n;
    }
  };

  // 价格优先级: WSS lastPrice > 合约 currentPrice
  const wssPrice = safeBigInt(tokenStats?.lastPrice);
  const currentPrice = wssPrice > 0n ? wssPrice
    : poolData.currentPrice > 0n ? poolData.currentPrice
    : 0n;
  // 市值优先级: 合约 marketCap（链上数据）
  const marketCap = poolData.marketCap > 0n ? poolData.marketCap : 0n;
  // 成交量: 仅从 WSS 获取（后端撮合引擎统计）
  const volume24h = safeBigInt(tokenStats?.volume24h);

  return (
    <div className={`flex flex-col bg-okx-bg-primary min-h-screen text-okx-text-primary ${className}`}>
      {/* 顶部面包屑与标题栏 — 支持外部 headerSlot 替换 */}
      {headerSlot ? (
        <div className="bg-okx-bg-primary border-b border-okx-border-primary flex items-center px-2">
          {headerSlot}
          <span className="ml-2 text-[11px] text-okx-text-secondary">
            ${formatUsdCompact(Number(formatUnits(marketCap, 18)) * ethPriceUsd)}
          </span>
        </div>
      ) : (
        <div className="h-8 bg-okx-bg-primary border-b border-okx-border-primary flex items-center px-4 gap-2 text-[11px] text-okx-text-secondary">
           <span>★</span>
           <span className="text-okx-text-primary font-bold">{displaySymbol}</span>
           <span className="mx-1">——</span>
           <span>
             ${formatUsdCompact(Number(formatUnits(marketCap, 18)) * ethPriceUsd)}
           </span>
        </div>
      )}

      {/* 核心指标头 */}
      <PriceBoard
        symbol={symbol}
        displaySymbol={displaySymbol}
        tokenAddress={displayData?.tokenAddress}
        currentPrice={currentPrice}
        price24hChange={displayData.priceChange24h || 0}
        marketCap={marketCap}
        volume24h={volume24h}
        securityStatus={securityStatus}
        metadata={tokenMetadata}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* 中间图表 + 底部列表 (75%) */}
        <div className="flex-[3] border-r border-okx-border-primary flex flex-col overflow-hidden">
           {/* K线图本体 - TradingView 官方 Lightweight Charts */}
           <div className="h-[400px] bg-[#131722]">
              <TradingErrorBoundary module="SpotChart">
                <TokenPriceChart symbol={symbol} displaySymbol={displaySymbol} latestTrade={latestTrade} />
              </TradingErrorBoundary>
           </div>

           {/* 底部详情选项卡 */}
           <div className="h-[400px] border-t border-okx-border-primary flex flex-col bg-okx-bg-primary">
              <div className="flex border-b border-okx-border-primary px-4">
                 {[
                   { key: "tradeActivity", label: t('trading.tradeActivity') },
                   { key: "about", label: t('trading.about') },
                   { key: "profitAddresses", label: t('trading.profitAddresses') },
                   { key: "holdingAddresses", label: t('trading.holdingAddresses') },
                   { key: "watchedAddresses", label: t('trading.watchedAddresses') },
                   { key: "liquidity", label: t('trading.liquidity') },
                   { key: "myPosition", label: t('trading.myPosition') }
                 ].map(tab => (
                    <button
                      key={tab.key}
                      onClick={() => setActiveTab(tab.key)}
                      className={`py-2 px-4 text-[12px] transition-colors relative ${activeTab === tab.key ? 'text-okx-text-primary font-bold' : 'text-okx-text-secondary'}`}
                    >
                      {tab.label}
                      {activeTab === tab.key && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#A3E635]"></div>}
                    </button>
                 ))}
              </div>
              <div className="flex-1 overflow-y-auto">
                 {activeTab === "tradeActivity" && (
                   <>
                     <div className="p-3 flex gap-3 text-[11px] border-b border-okx-border-primary">
                        <span className="bg-okx-bg-hover text-okx-text-primary px-2 py-0.5 rounded cursor-pointer">{t('common.all')}</span>
                        {[
                          { key: "kol", label: t('holders.kol') },
                          { key: "ratHole", label: t('holders.ratHole') },
                          { key: "whale", label: t('holders.whale') },
                          { key: "sniper", label: t('holders.sniper') },
                          { key: "smartMoney", label: t('holders.smartMoney') },
                          { key: "dev", label: t('holders.dev') }
                        ].map(f => (
                           <span key={f.key} className="text-okx-text-tertiary hover:text-okx-text-secondary cursor-pointer">{f.label}</span>
                        ))}
                     </div>
                     {/* 合并链上交易、实时交易和历史交易，按 txHash 去重 */}
                     <TradeHistory trades={(() => {
                       const seenTxHashes = new Set<string>();
                       const merged: Trade[] = [];

                       // 首先添加链上交易（最准确的数据源）
                       if (Array.isArray(onChainTrades) && onChainTrades.length > 0) {
                         // 按时间倒序排列
                         const sortedOnChain = [...onChainTrades].sort((a, b) => b.timestamp - a.timestamp);
                         for (const trade of sortedOnChain) {
                           if (trade.transactionHash && !seenTxHashes.has(trade.transactionHash)) {
                             seenTxHashes.add(trade.transactionHash);
                             const priceEth = trade.price; // TOKEN/ETH 价格
                             const ethAmount = Number(trade.ethAmount) / 1e18;
                             const tokenAmount = Number(trade.tokenAmount) / 1e18;
                             merged.push({
                               timestamp: trade.timestamp * 1000,
                               type: trade.isBuy ? "buy" : "sell",
                               totalValue: formatETHValue(ethAmount),
                               price: formatSmallPriceETH(priceEth),
                               quantity: (trade.isBuy ? "+" : "-") + (tokenAmount / 1e6).toFixed(2) + "M " + displaySymbol,
                               quantitySol: (trade.isBuy ? "-" : "+") + ethAmount.toFixed(5) + " ETH",
                               address: trade.trader.slice(0, 6) + "..." + trade.trader.slice(-4),
                               txHash: trade.transactionHash,
                               isNew: Date.now() - trade.timestamp * 1000 < 30000, // 30秒内的交易标记为新
                             });
                           }
                         }
                       }

                       // 添加实时交易
                       for (const trade of realtimeTrades) {
                         if (trade.txHash && !seenTxHashes.has(trade.txHash)) {
                           seenTxHashes.add(trade.txHash);
                           merged.push(trade);
                         }
                       }

                       // 添加后端历史交易
                       const historyTrades = Array.isArray(tradesData) ? tradesData : [];
                       for (const trade of historyTrades) {
                         if (trade.txHash && !seenTxHashes.has(trade.txHash)) {
                           seenTxHashes.add(trade.txHash);
                           merged.push(trade);
                         }
                       }

                       // 按时间排序并限制数量
                       return merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
                     })()} />
                   </>
                 )}
                 {activeTab === "about" && (
                   <div className="p-4">
                     <div className="text-center text-okx-text-tertiary">
                       <p>{t('trading.noDescription')}</p>
                     </div>
                   </div>
                 )}
                 {activeTab === "holdingAddresses" && (
                   <TopHolders
                     instId={instId}
                     creatorAddress={displayData?.creatorAddress}
                   />
                 )}
                 {activeTab === "profitAddresses" && (
                   <ProfitableAddresses
                     tokenAddress={pureTokenAddress ?? undefined}
                     ethPriceUsd={ethPriceUsd}
                   />
                 )}
                 {activeTab === "watchedAddresses" && (
                   <div className="p-4 text-center text-okx-text-tertiary">
                     <p>{t('trading.featureInDev')}</p>
                   </div>
                 )}
                 {activeTab === "liquidity" && (
                   <LiquidityPanel
                     poolState={poolData.poolState}
                     virtualETHReserve={poolData.virtualETHReserve}
                     virtualTokenReserve={poolData.virtualTokenReserve}
                     currentPrice={currentPrice}
                     ethPriceUsd={ethPriceUsd}
                   />
                 )}
                 {activeTab === "myPosition" && (
                   <MyHoldings
                     tokenAddress={pureTokenAddress ?? undefined}
                     currentPrice={currentPrice}
                     ethPriceUsd={ethPriceUsd}
                     displaySymbol={displaySymbol}
                   />
                 )}
              </div>
           </div>
        </div>

        {/* 右侧交易面板 (25%) */}
        <div className="flex-1 bg-okx-bg-primary p-2 overflow-y-auto">
          <TradingErrorBoundary module="SwapPanel">
            <SwapPanelOKX
              symbol={symbol}
              displaySymbol={displaySymbol}
              securityStatus={securityStatus}
              tokenAddress={displayData?.tokenAddress as `0x${string}` | undefined}
              soldSupply={displayData?.soldSupply}
              totalSupply={displayData?.totalSupply}
              isGraduated={isPoolGraduated}
              isPoolActive={isPoolActive}
            />
          </TradingErrorBoundary>
        </div>
      </div>

    </div>
  );
}
