"use client";

import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { getWebSocketServices, HolderInfo, TopHoldersResp } from "@/lib/websocket";
import { formatUnits } from "viem";

interface TopHoldersProps {
  instId: string;  // 交易对ID，如 "PEPE"
  creatorAddress?: string;
  className?: string;
}

/**
 * TopHolders - 持仓分布组件
 * 参考 pump.fun 风格，显示前10大持有者及其占比
 */
export function TopHolders({ instId, creatorAddress, className }: TopHoldersProps) {
  const t = useTranslations();
  // 获取持仓数据
  const { data: holdersData, isLoading, isError } = useQuery({
    queryKey: ["topHolders", instId],
    queryFn: async (): Promise<TopHoldersResp> => {
      try {
        const wsServices = getWebSocketServices();
        return await wsServices.getTopHolders({
          inst_id: instId,
          limit: 10,
        });
      } catch (error) {
        console.warn("获取持仓数据失败，使用模拟数据:", error);
        // 返回模拟数据用于开发
        return generateMockData(instId, creatorAddress);
      }
    },
    enabled: !!instId,
    staleTime: 30000, // 30秒缓存
    refetchInterval: 60000, // 1分钟刷新
  });

  // 计算集中度风险等级颜色
  const riskColor = useMemo(() => {
    const risk = holdersData?.concentration_risk;
    switch (risk) {
      case "HIGH":
        return "text-[#FF3B30]";
      case "MEDIUM":
        return "text-[#FF9500]";
      case "LOW":
        return "text-[#00D26A]";
      default:
        return "text-okx-text-secondary";
    }
  }, [holdersData?.concentration_risk]);

  // 格式化地址
  const formatAddress = (address: string) => {
    if (!address || address.length < 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  // 格式化持有数量
  const formatBalance = (balance: string) => {
    try {
      const value = parseFloat(formatUnits(BigInt(balance || "0"), 18));
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
      return value.toFixed(2);
    } catch {
      return "0";
    }
  };

  // 获取标签样式
  const getLabelStyle = (holder: HolderInfo) => {
    if (holder.label === "BONDING_CURVE") {
      return "bg-[#34C759]/20 text-[#34C759] border border-[#34C759]/30";
    }
    if (holder.is_creator || holder.label === "CREATOR") {
      return "bg-[#007AFF]/20 text-[#007AFF] border border-[#007AFF]/30";
    }
    if (holder.is_dev || holder.label === "DEV") {
      return "bg-[#FF9500]/20 text-[#FF9500] border border-[#FF9500]/30";
    }
    if (holder.label === "WHALE") {
      return "bg-[#5856D6]/20 text-[#5856D6] border border-[#5856D6]/30";
    }
    if (holder.label === "SNIPER") {
      return "bg-[#FF2D55]/20 text-[#FF2D55] border border-[#FF2D55]/30";
    }
    return "";
  };

  // 获取标签文本
  const getLabelText = (holder: HolderInfo) => {
    if (holder.label === "BONDING_CURVE") return t('holders.bondingCurve');
    if (holder.is_creator || holder.label === "CREATOR") return t('holders.creator');
    if (holder.is_dev || holder.label === "DEV") return t('holders.dev');
    if (holder.label === "WHALE") return t('holders.whale');
    if (holder.label === "SNIPER") return t('holders.sniper');
    return holder.label || "";
  };

  // 进度条颜色
  const getProgressColor = (percentage: number, isCreator: boolean, isDev: boolean) => {
    if (isCreator) return "bg-[#007AFF]";
    if (isDev) return "bg-[#FF9500]";
    if (percentage > 10) return "bg-[#FF3B30]";
    if (percentage > 5) return "bg-[#FF9500]";
    return "bg-[#00D26A]";
  };

  if (isLoading) {
    return (
      <div className={`bg-okx-bg-secondary rounded-lg p-4 ${className}`}>
        <div className="animate-pulse space-y-3">
          <div className="h-5 bg-[#1F1F1F] rounded w-1/3"></div>
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-[#1F1F1F] rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (isError || !holdersData) {
    return (
      <div className={`bg-okx-bg-secondary rounded-lg p-4 ${className}`}>
        <p className="text-okx-text-secondary text-sm">{t('holders.unableLoadHolders')}</p>
      </div>
    );
  }

  return (
    <div className={`bg-okx-bg-secondary rounded-lg ${className}`}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-okx-border-primary">
        <div className="flex items-center gap-2">
          <span className="text-okx-text-primary font-bold text-[14px]">{t('holders.distribution')}</span>
          <span className="text-okx-text-tertiary text-[12px]">{t('holders.top10')}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-okx-text-secondary">
            {t('holders.holderCount')}: <span className="text-okx-text-primary">{holdersData.total_holders?.toLocaleString() || 0}</span>
          </span>
          <span className={`${riskColor}`}>
            {t('holders.concentration')}: {holdersData.concentration_risk === "HIGH" ? t('holders.highRisk') :
                    holdersData.concentration_risk === "MEDIUM" ? t('holders.medium') : t('holders.low')}
          </span>
        </div>
      </div>

      {/* 集中度警告 */}
      {holdersData.concentration_risk === "HIGH" && (
        <div className="mx-4 mt-3 px-3 py-2 bg-[#FF3B30]/10 border border-[#FF3B30]/30 rounded-lg">
          <div className="flex items-center gap-2">
            <span className="text-[#FF3B30]">⚠️</span>
            <span className="text-[#FF3B30] text-[11px]">
              {t('holders.top10Warning', { percent: holdersData.top10_percentage?.toFixed(1) })}
            </span>
          </div>
        </div>
      )}

      {/* 创建者持仓提示 */}
      {holdersData.creator_holding && holdersData.creator_holding > 5 && (
        <div className="mx-4 mt-2 px-3 py-2 bg-[#FF9500]/10 border border-[#FF9500]/30 rounded-lg">
          <div className="flex items-center gap-2">
            <span className="text-[#FF9500]">👤</span>
            <span className="text-[#FF9500] text-[11px]">
              {t('holders.creatorHolding', { percent: holdersData.creator_holding?.toFixed(2) })}
            </span>
          </div>
        </div>
      )}

      {/* 持有者列表 */}
      <div className="px-4 py-3 space-y-2">
        {holdersData.holders?.map((holder, index) => (
          <div
            key={holder.address}
            className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-okx-bg-hover transition-colors group"
          >
            {/* 排名 */}
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
              index < 3 ? "bg-[#FFD700]/20 text-[#FFD700]" : "bg-[#1F1F1F] text-okx-text-tertiary"
            }`}>
              {holder.rank || index + 1}
            </div>

            {/* 地址 + 标签 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <a
                  href={`https://sepolia.basescan.org/address/${holder.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-okx-text-primary font-mono text-[12px] hover:text-[#007AFF] transition-colors"
                >
                  {formatAddress(holder.address)}
                </a>
                {(holder.is_creator || holder.is_dev || holder.label) && (
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${getLabelStyle(holder)}`}>
                    {getLabelText(holder)}
                  </span>
                )}
                {/* 操作按钮 - hover 显示 */}
                <div className="hidden group-hover:flex items-center gap-1 ml-1">
                  <button className="text-okx-text-tertiary hover:text-okx-text-primary text-[10px]" title={t('holders.copyAddress')}>
                    📋
                  </button>
                  <button className="text-okx-text-tertiary hover:text-okx-text-primary text-[10px]" title={t('holders.trackWallet')}>
                    👁️
                  </button>
                </div>
              </div>
              {/* 持仓数量 */}
              <div className="text-okx-text-tertiary text-[10px] mt-0.5">
                {formatBalance(holder.balance)} {instId.toUpperCase()}
              </div>
            </div>

            {/* 百分比进度条 */}
            <div className="w-24">
              <div className="flex items-center justify-between mb-1">
                <span className={`text-[11px] font-bold ${
                  holder.percentage > 10 ? "text-[#FF3B30]" :
                  holder.percentage > 5 ? "text-[#FF9500]" : "text-okx-text-primary"
                }`}>
                  {holder.percentage?.toFixed(2)}%
                </span>
              </div>
              <div className="h-1.5 bg-[#1F1F1F] rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${getProgressColor(
                    holder.percentage,
                    holder.is_creator,
                    holder.is_dev
                  )}`}
                  style={{ width: `${Math.min(holder.percentage, 100)}%` }}
                />
              </div>
            </div>

            {/* PnL 显示 */}
            {holder.pnl_percentage !== undefined && (
              <div className={`text-[11px] font-medium w-16 text-right ${
                holder.pnl_percentage >= 0 ? "text-[#00D26A]" : "text-[#FF3B30]"
              }`}>
                {holder.pnl_percentage >= 0 ? "+" : ""}{holder.pnl_percentage.toFixed(1)}%
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 底部统计 */}
      <div className="px-4 py-3 border-t border-okx-border-primary flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-4">
          <span className="text-okx-text-tertiary">
            {t('holders.top10Share')}: <span className={`font-bold ${
              (holdersData.top10_percentage || 0) > 50 ? "text-[#FF3B30]" :
              (holdersData.top10_percentage || 0) > 30 ? "text-[#FF9500]" : "text-[#00D26A]"
            }`}>
              {holdersData.top10_percentage?.toFixed(1)}%
            </span>
          </span>
        </div>
        <button className="text-[#007AFF] hover:text-[#0056b3] transition-colors flex items-center gap-1">
          <span>{t('holders.generateBubble')}</span>
          <span>→</span>
        </button>
      </div>
    </div>
  );
}

/**
 * 生成模拟数据（开发用）
 */
function generateMockData(instId: string, creatorAddress?: string): TopHoldersResp {
  const mockHolders: HolderInfo[] = [
    {
      rank: 1,
      address: creatorAddress || "0x1234567890abcdef1234567890abcdef12345678",
      balance: "150000000000000000000000000", // 150M
      percentage: 15.0,
      is_creator: true,
      is_dev: false,
      label: "CREATOR",
      pnl_percentage: 0,
    },
    {
      rank: 2,
      address: "0xabcdef1234567890abcdef1234567890abcdef12",
      balance: "80000000000000000000000000", // 80M
      percentage: 8.0,
      is_creator: false,
      is_dev: false,
      label: "WHALE",
      pnl_percentage: 125.5,
    },
    {
      rank: 3,
      address: "0x9876543210fedcba9876543210fedcba98765432",
      balance: "50000000000000000000000000", // 50M
      percentage: 5.0,
      is_creator: false,
      is_dev: true,
      label: "DEV",
      pnl_percentage: 89.2,
    },
    {
      rank: 4,
      address: "0xfedcba9876543210fedcba9876543210fedcba98",
      balance: "35000000000000000000000000", // 35M
      percentage: 3.5,
      is_creator: false,
      is_dev: false,
      label: "SNIPER",
      pnl_percentage: 234.8,
    },
    {
      rank: 5,
      address: "0x5555555555555555555555555555555555555555",
      balance: "25000000000000000000000000", // 25M
      percentage: 2.5,
      is_creator: false,
      is_dev: false,
      pnl_percentage: 45.3,
    },
    {
      rank: 6,
      address: "0x6666666666666666666666666666666666666666",
      balance: "20000000000000000000000000", // 20M
      percentage: 2.0,
      is_creator: false,
      is_dev: false,
      pnl_percentage: -12.5,
    },
    {
      rank: 7,
      address: "0x7777777777777777777777777777777777777777",
      balance: "18000000000000000000000000", // 18M
      percentage: 1.8,
      is_creator: false,
      is_dev: false,
      pnl_percentage: 67.8,
    },
    {
      rank: 8,
      address: "0x8888888888888888888888888888888888888888",
      balance: "15000000000000000000000000", // 15M
      percentage: 1.5,
      is_creator: false,
      is_dev: false,
      pnl_percentage: 23.1,
    },
    {
      rank: 9,
      address: "0x9999999999999999999999999999999999999999",
      balance: "12000000000000000000000000", // 12M
      percentage: 1.2,
      is_creator: false,
      is_dev: false,
      pnl_percentage: -5.2,
    },
    {
      rank: 10,
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      balance: "10000000000000000000000000", // 10M
      percentage: 1.0,
      is_creator: false,
      is_dev: false,
      pnl_percentage: 15.9,
    },
  ];

  const top10Percentage = mockHolders.reduce((sum, h) => sum + h.percentage, 0);

  return {
    success: true,
    inst_id: instId,
    holders: mockHolders,
    total_holders: 1234,
    top10_percentage: top10Percentage,
    creator_address: creatorAddress || mockHolders[0].address,
    creator_holding: 15.0,
    concentration_risk: top10Percentage > 50 ? "HIGH" : top10Percentage > 30 ? "MEDIUM" : "LOW",
  };
}

export default TopHolders;
