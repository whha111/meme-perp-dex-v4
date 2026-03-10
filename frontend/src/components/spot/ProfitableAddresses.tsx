"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { formatUnits } from "viem";

interface ProfitableAddressesProps {
  tokenAddress?: string;
  bnbPriceUsd: number;
  className?: string;
}

interface HolderWithPnl {
  rank: number;
  address: string;
  balance: string;
  percentage: number;
  is_creator: boolean;
  label?: string;
  pnl_percentage?: number;
  unrealized_pnl?: string;
  realized_pnl?: string;
}

interface HoldersResponse {
  success: boolean;
  holders: HolderWithPnl[];
  total_holders: number;
  top10_percentage: number;
  creator_address?: string;
  concentration_risk: string;
}

export function ProfitableAddresses({
  tokenAddress,
  bnbPriceUsd,
  className,
}: ProfitableAddressesProps) {
  const t = useTranslations();

  const isValidToken = tokenAddress?.startsWith("0x") && tokenAddress.length === 42;
  const token = isValidToken && tokenAddress ? tokenAddress.split("-")[0] : null;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["profitableAddresses", token],
    queryFn: async (): Promise<HoldersResponse> => {
      const res = await fetch(
        `${MATCHING_ENGINE_URL}/api/v1/spot/holders/${token}?limit=20&includePnl=true`
      );
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!token,
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const formatAddress = (address: string) => {
    if (!address || address.length < 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

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

  const formatPnlValue = (pnlWei: string | undefined) => {
    if (!pnlWei) return "$0.00";
    try {
      const ethValue = Number(formatUnits(BigInt(pnlWei), 18));
      const usdValue = ethValue * bnbPriceUsd;
      if (Math.abs(usdValue) >= 1000) return `$${(usdValue / 1000).toFixed(1)}K`;
      return `$${usdValue.toFixed(2)}`;
    } catch {
      return "$0.00";
    }
  };

  if (isLoading) {
    return (
      <div className={`p-4 ${className}`}>
        <div className="animate-pulse space-y-3">
          <div className="h-5 bg-[#1F1F1F] rounded w-1/3" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-10 bg-[#1F1F1F] rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data?.holders?.length) {
    return (
      <div className={`p-4 text-center text-okx-text-tertiary ${className}`}>
        <p>{t("holders.noHolders")}</p>
      </div>
    );
  }

  // Sort holders by unrealized PnL value descending
  const sorted = [...data.holders].sort((a, b) => {
    const aVal = BigInt(a.unrealized_pnl || "0");
    const bVal = BigInt(b.unrealized_pnl || "0");
    return bVal > aVal ? 1 : bVal < aVal ? -1 : 0;
  });

  return (
    <div className={`${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-okx-border-primary">
        <span className="text-okx-text-primary font-bold text-[14px]">
          {t("trading.profitAddresses")}
        </span>
        <span className="text-okx-text-tertiary text-[11px]">
          {data.total_holders} {t("holders.holderCount").toLowerCase()}
        </span>
      </div>

      {/* Table Header */}
      <div className="grid grid-cols-[auto_1fr_100px_100px] gap-2 px-4 py-2 text-[10px] text-okx-text-tertiary border-b border-okx-border-primary">
        <span>#</span>
        <span>{t("holders.address")}</span>
        <span className="text-right">{t("holders.amount")}</span>
        <span className="text-right">{t("trading.unrealizedPnl")}</span>
      </div>

      {/* Holder rows */}
      <div className="overflow-y-auto max-h-[280px]">
        {sorted.map((holder, index) => {
          const pnlValue = BigInt(holder.unrealized_pnl || "0");
          const isProfit = pnlValue > 0n;

          return (
            <div
              key={holder.address}
              className="grid grid-cols-[auto_1fr_100px_100px] gap-2 px-4 py-2 text-[11px] hover:bg-okx-bg-hover transition-colors items-center"
            >
              {/* Rank */}
              <span className={`w-5 text-center font-bold ${
                index < 3 ? "text-[#FFD700]" : "text-okx-text-tertiary"
              }`}>
                {index + 1}
              </span>

              {/* Address + Label */}
              <div className="flex items-center gap-1.5 min-w-0">
                <a
                  href={`https://sepolia.basescan.org/address/${holder.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-okx-text-primary font-mono hover:text-[#007AFF] transition-colors"
                >
                  {formatAddress(holder.address)}
                </a>
                {holder.label && (
                  <span className={`px-1 py-0.5 rounded text-[8px] font-medium ${
                    holder.is_creator
                      ? "bg-[#007AFF]/20 text-[#007AFF]"
                      : "bg-[#5856D6]/20 text-[#5856D6]"
                  }`}>
                    {holder.label}
                  </span>
                )}
              </div>

              {/* Balance */}
              <span className="text-right text-okx-text-secondary">
                {formatBalance(holder.balance)}
              </span>

              {/* Unrealized PnL */}
              <span className={`text-right font-medium ${
                isProfit ? "text-[#00D26A]" : "text-okx-text-tertiary"
              }`}>
                {formatPnlValue(holder.unrealized_pnl)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ProfitableAddresses;
