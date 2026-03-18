"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits, erc20Abi } from "viem";

interface MyHoldingsProps {
  tokenAddress?: string;
  currentPrice: bigint; // price in ETH (wei)
  bnbPriceUsd: number;
  displaySymbol: string;
  className?: string;
}

/**
 * 格式化人类可读的大数字: 1234567890 → "1.23B"
 */
function fmtAmount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  if (n > 0) return n.toFixed(4);
  return "0";
}

/**
 * 格式化美元价格，小价格用下标表示法: $0.0₅62087
 */
function fmtUsdPrice(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd >= 1) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(6)}`;

  // 下标表示法
  const s = usd.toFixed(18);
  const m = s.match(/^0\.(0*)([1-9]\d*)/);
  if (m) {
    const zeros = m[1].length;
    const digits = m[2].slice(0, 5);
    const subs = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
    const sub = zeros.toString().split("").map(d => subs[parseInt(d)]).join("");
    return `$0.0${sub}${digits}`;
  }
  return `$${usd.toFixed(8)}`;
}

/**
 * 格式化 BNB 价格，小价格用下标: 0.0₈1695 BNB
 */
function fmtEthPrice(eth: number): string {
  if (eth <= 0) return "0 BNB";
  if (eth >= 0.001) return `${eth.toFixed(6)} BNB`;
  if (eth >= 0.0001) return `${eth.toFixed(8)} BNB`;

  const s = eth.toFixed(18);
  const m = s.match(/^0\.(0*)([1-9]\d*)/);
  if (m) {
    const zeros = m[1].length;
    const digits = m[2].slice(0, 5);
    const subs = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
    const sub = zeros.toString().split("").map(d => subs[parseInt(d)]).join("");
    return `0.0${sub}${digits} BNB`;
  }
  return `${eth.toFixed(10)} BNB`;
}

export function MyHoldings({
  tokenAddress,
  currentPrice,
  bnbPriceUsd,
  displaySymbol,
  className,
}: MyHoldingsProps) {
  const t = useTranslations();
  const { address: userAddress, isConnected } = useAccount();

  const isValidToken = tokenAddress?.startsWith("0x") && tokenAddress.length === 42;

  const { data: balance, isLoading } = useReadContract({
    address: isValidToken ? (tokenAddress as `0x${string}`) : undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: userAddress ? [userAddress] : undefined,
    query: {
      enabled: isConnected && !!userAddress && isValidToken,
      staleTime: 15000,
      refetchInterval: 30000,
    },
  });

  // 未连接钱包
  if (!isConnected) {
    return (
      <div className={`flex flex-col items-center justify-center py-10 ${className}`}>
        <div className="text-okx-text-tertiary text-sm mb-3">{t("trading.connectWalletToView")}</div>
      </div>
    );
  }

  if (!isValidToken || isLoading) {
    return (
      <div className={`p-4 ${className}`}>
        <div className="animate-pulse space-y-2">
          <div className="h-12 bg-okx-bg-hover rounded" />
          <div className="h-12 bg-okx-bg-hover rounded" />
        </div>
      </div>
    );
  }

  const tokenBalance = balance ?? 0n;
  const balNum = Number(formatUnits(tokenBalance, 18));
  const priceEth = Number(formatUnits(currentPrice, 18));
  const priceUsd = priceEth * bnbPriceUsd;
  const valueUsd = balNum * priceUsd;
  const valueEth = balNum * priceEth;
  const hasBalance = tokenBalance > 0n;

  // 持仓占比(假设总供应 1B)
  const supplyPct = (balNum / 1e9) * 100;

  return (
    <div className={`${className}`}>
      {/* 资产概览行 */}
      <div className="px-4 py-3 border-b border-okx-border-primary">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-okx-text-tertiary">{t("trading.myBalance")}</div>
            <div className="text-[18px] font-bold text-okx-text-primary mt-0.5">
              {hasBalance ? fmtAmount(balNum) : "0"}{" "}
              <span className="text-xs text-okx-text-secondary">{displaySymbol}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-okx-text-tertiary">{t("trading.totalValue")}</div>
            <div className="text-[16px] font-bold text-okx-text-primary mt-0.5">
              {fmtUsdPrice(valueUsd)}
            </div>
          </div>
        </div>
      </div>

      {hasBalance ? (
        <div className="px-4 py-3 space-y-3">
          {/* 详细数据行 */}
          <InfoRow label={t("common.price")} value={fmtEthPrice(priceEth)} sub={fmtUsdPrice(priceUsd)} />
          <InfoRow label="BNB" value={fmtEthPrice(valueEth)} />
          <InfoRow label={t("holders.percentage")} value={supplyPct >= 0.01 ? `${supplyPct.toFixed(2)}%` : "< 0.01%"} />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8 px-4">
          <div className="text-okx-text-tertiary text-xs text-center">
            {t("holders.noHolders")}
          </div>
          <div className="text-okx-text-secondary text-xs mt-2 text-center">
            {t("common.price")}: {fmtUsdPrice(priceUsd)}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-okx-text-tertiary">{label}</span>
      <div className="text-right">
        <span className="text-okx-text-primary">{value}</span>
        {sub && <span className="text-okx-text-tertiary text-xs ml-1.5">{sub}</span>}
      </div>
    </div>
  );
}

export default MyHoldings;
