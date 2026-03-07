"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { formatUnits } from "viem";
import type { PoolState } from "@/hooks/spot/usePoolState";
import { GRADUATION_THRESHOLD, REAL_TOKEN_SUPPLY, SOLD_TOKENS_TARGET } from "@/lib/protocol-constants";

interface LiquidityPanelProps {
  poolState: PoolState | null;
  virtualETHReserve: bigint;
  virtualTokenReserve: bigint;
  currentPrice: bigint;
  bnbPriceUsd: number;
  className?: string;
}

/**
 * 格式化大数字: 1234567890 → "1.23B"
 */
function fmtNum(n: number, decimals = 4): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(decimals);
  if (n > 0) return n.toFixed(Math.min(decimals + 4, 10));
  return "0";
}

/**
 * 格式化 ETH 价格，小价格用下标: 0.0₈1695 ETH
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

/**
 * 格式化美元价格
 */
function fmtUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd >= 1) return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(6)}`;

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

export function LiquidityPanel({
  poolState,
  virtualETHReserve,
  virtualTokenReserve,
  currentPrice,
  bnbPriceUsd,
  className,
}: LiquidityPanelProps) {
  const t = useTranslations();

  if (!poolState) {
    return (
      <div className={`p-4 text-center text-okx-text-tertiary ${className}`}>
        <p>{t("common.loading")}</p>
      </div>
    );
  }

  const realBNB = Number(formatUnits(poolState.realETHReserve, 18));
  const realToken = Number(formatUnits(poolState.realTokenReserve, 18));
  const vETH = Number(formatUnits(virtualETHReserve, 18));
  const vToken = Number(formatUnits(virtualTokenReserve, 18));
  const soldTokens = Number(formatUnits(poolState.soldTokens, 18));
  const totalSupply = Number(formatUnits(REAL_TOKEN_SUPPLY, 18));
  const graduationTarget = Number(formatUnits(SOLD_TOKENS_TARGET, 18));
  const priceEth = Number(formatUnits(currentPrice, 18));
  const priceUsdVal = priceEth * bnbPriceUsd;

  // Graduation progress percentage
  const progressPct = Math.min((soldTokens / graduationTarget) * 100, 100);

  return (
    <div className={`p-4 space-y-4 ${className}`}>
      {/* Status Badge */}
      <div className="flex items-center gap-2">
        <span
          className={`px-2 py-0.5 rounded text-[11px] font-medium ${
            poolState.isGraduated
              ? "bg-[#5856D6]/20 text-[#5856D6]"
              : poolState.isActive
                ? "bg-[#00D26A]/20 text-[#00D26A]"
                : "bg-[#FF3B30]/20 text-[#FF3B30]"
          }`}
        >
          {poolState.isGraduated
            ? t("swap.tokenGraduated")
            : poolState.isActive
              ? t("trading.active")
              : t("trading.paused")}
        </span>
        {poolState.creator && (
          <span className="text-okx-text-tertiary text-[10px]">
            {t("holders.creator")}: {poolState.creator.slice(0, 6)}...{poolState.creator.slice(-4)}
          </span>
        )}
      </div>

      {/* Graduation Progress Bar */}
      {!poolState.isGraduated && (
        <div>
          <div className="flex justify-between text-[11px] mb-1">
            <span className="text-okx-text-secondary">{t("trading.graduationProgress")}</span>
            <span className="text-okx-text-primary font-bold">{progressPct.toFixed(1)}%</span>
          </div>
          <div className="h-2 bg-[#1F1F1F] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#A3E635] to-[#22C55E] transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-okx-text-tertiary mt-1">
            <span>{fmtNum(soldTokens)} {t("swap.sold")}</span>
            <span>{fmtNum(graduationTarget)} {t("swap.graduationTarget")}</span>
          </div>
        </div>
      )}

      {/* Reserve Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          label={t("trading.ethReserve")}
          value={`${realBNB.toFixed(4)} BNB`}
          subValue={fmtUsd(realBNB * bnbPriceUsd)}
        />
        <StatCard
          label={t("trading.tokenReserve")}
          value={fmtNum(realToken)}
          subValue={`/ ${fmtNum(totalSupply)} ${t("trading.total")}`}
        />
        <StatCard
          label={t("trading.virtualBnb")}
          value={`${vETH.toFixed(4)} BNB`}
          subValue={fmtUsd(vETH * bnbPriceUsd)}
        />
        <StatCard
          label={t("trading.virtualToken")}
          value={fmtNum(vToken)}
        />
      </div>

      {/* Bonding Curve Info */}
      <div className="border-t border-okx-border-primary pt-3 space-y-2">
        <h4 className="text-[12px] text-okx-text-secondary font-medium">{t("trading.bondingCurve")}</h4>
        <div className="flex justify-between text-[11px]">
          <span className="text-okx-text-tertiary">{t("common.price")}</span>
          <span className="text-okx-text-primary">
            {fmtEthPrice(priceEth)}
            <span className="text-okx-text-tertiary ml-1.5 text-[10px]">{fmtUsd(priceUsdVal)}</span>
          </span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-okx-text-tertiary">{t("swap.sold")}</span>
          <span className="text-okx-text-primary">
            {((soldTokens / totalSupply) * 100).toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between text-[11px]">
          <span className="text-okx-text-tertiary">K</span>
          <span className="text-okx-text-primary">
            {fmtNum(vETH, 4)} × {fmtNum(vToken)}
          </span>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  subValue,
}: {
  label: string;
  value: string;
  subValue?: string;
}) {
  return (
    <div className="bg-okx-bg-hover rounded-lg p-3">
      <div className="text-[10px] text-okx-text-tertiary mb-1">{label}</div>
      <div className="text-[13px] text-okx-text-primary font-bold">{value}</div>
      {subValue && <div className="text-[10px] text-okx-text-secondary mt-0.5">{subValue}</div>}
    </div>
  );
}

export default LiquidityPanel;
