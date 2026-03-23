"use client";

import { useTranslations } from "next-intl";
import type { PoolStats, UserLPPosition } from "@/hooks/perpetual/usePerpVaultLP";

interface VaultDashboardProps {
  poolStats: PoolStats | null;
  userPosition: UserLPPosition | null;
  isConnected: boolean;
}

export function VaultDashboard({
  poolStats,
  userPosition,
  isConnected,
}: VaultDashboardProps) {
  const t = useTranslations("vault");

  const utilizationNum = poolStats
    ? Number(poolStats.utilization) / 100
    : 0;

  const utilizationColor =
    utilizationNum >= 80
      ? "text-okx-down"
      : utilizationNum >= 50
        ? "text-yellow-500"
        : "text-okx-up";

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {/* Pool Value */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
        <p className="text-xs text-okx-text-tertiary mb-1">
          {t("dashPoolValue")}
        </p>
        <p
          className={`text-lg font-bold font-mono ${
            poolStats && poolStats.poolValue > 0n
              ? "text-okx-up"
              : "text-okx-text-primary"
          }`}
        >
          {poolStats ? poolStats.poolValueFormatted : "—"}
          <span className="text-xs text-okx-text-tertiary ml-1">BNB</span>
        </p>
      </div>

      {/* Share Price */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
        <p className="text-xs text-okx-text-tertiary mb-1">
          {t("dashSharePrice")}
        </p>
        <p className="text-lg font-bold font-mono text-okx-text-primary">
          {poolStats ? poolStats.sharePriceFormatted : "—"}
          <span className="text-xs text-okx-text-tertiary ml-1">BNB</span>
        </p>
      </div>

      {/* Your LP Value */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
        <p className="text-xs text-okx-text-tertiary mb-1">
          {t("dashYourValue")}
        </p>
        <p className="text-lg font-bold font-mono text-okx-text-primary">
          {isConnected && userPosition
            ? userPosition.lpValueFormatted
            : "—"}
          {isConnected && userPosition && (
            <span className="text-xs text-okx-text-tertiary ml-1">BNB</span>
          )}
        </p>
      </div>

      {/* Utilization */}
      <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4">
        <p className="text-xs text-okx-text-tertiary mb-1">
          {t("dashUtilization")}
        </p>
        <p className={`text-lg font-bold font-mono ${utilizationColor}`}>
          {poolStats ? poolStats.utilizationPercent : "—"}
        </p>
      </div>
    </div>
  );
}
