"use client";

import { useTranslations } from "next-intl";
import { formatUnits } from "viem";

interface LendingDashboardProps {
  totalSupplied: bigint;
  totalPendingInterest: bigint;
  weightedAPY: string;
  positionCount: number;
}

/** Format bigint to human-readable string with units (K, M) */
function formatAmount(amount: bigint): string {
  const num = parseFloat(formatUnits(amount, 18));
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  if (num < 1) return num.toFixed(4);
  if (num < 1000) return num.toFixed(2);
  if (num < 1_000_000) return (num / 1000).toFixed(2) + "K";
  return (num / 1_000_000).toFixed(2) + "M";
}

export function LendingDashboard({
  totalSupplied,
  totalPendingInterest,
  weightedAPY,
  positionCount,
}: LendingDashboardProps) {
  const t = useTranslations("lending");

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {/* Total Supplied */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-lg bg-okx-up/10 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-okx-up" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <span className="text-xs text-okx-text-tertiary font-medium">{t("dashTotalSupplied")}</span>
        </div>
        <div className="text-xl font-bold">{formatAmount(totalSupplied)}</div>
      </div>

      {/* Net APY */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-lg bg-okx-accent/10 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-okx-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <span className="text-xs text-okx-text-tertiary font-medium">{t("dashNetAPY")}</span>
        </div>
        <div className="text-xl font-bold text-okx-up">{weightedAPY}%</div>
      </div>

      {/* Pending Interest */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-lg bg-yellow-500/10 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <span className="text-xs text-okx-text-tertiary font-medium">{t("dashPendingInterest")}</span>
        </div>
        <div className="text-xl font-bold text-okx-up">
          {totalPendingInterest > 0n ? "+" : ""}{formatAmount(totalPendingInterest)}
        </div>
      </div>

      {/* Active Positions */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <span className="text-xs text-okx-text-tertiary font-medium">{t("dashActivePositions")}</span>
        </div>
        <div className="text-xl font-bold">{positionCount}</div>
      </div>
    </div>
  );
}
