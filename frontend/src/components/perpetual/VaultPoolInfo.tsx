"use client";

import { useTranslations } from "next-intl";
import { formatEther } from "viem";
import type { PoolStats, ExtendedStats } from "@/hooks/perpetual/usePerpVaultLP";

interface VaultPoolInfoProps {
  poolStats: PoolStats | null;
  extendedStats: ExtendedStats | null;
}

function formatBNBDisplay(wei: bigint): string {
  const val = Number(wei) / 1e18;
  if (val >= 1) return val.toFixed(4);
  if (val >= 0.0001) return val.toFixed(6);
  return val.toFixed(8);
}

export function VaultPoolInfo({ poolStats, extendedStats }: VaultPoolInfoProps) {
  const t = useTranslations("vault");

  const totalOI = poolStats?.totalOI ?? 0n;
  const maxOI = poolStats?.maxOI ?? 0n;
  const oiPercent =
    maxOI > 0n ? Number((totalOI * 10000n) / maxOI) / 100 : 0;

  const oiBarColor =
    oiPercent >= 80
      ? "bg-okx-down"
      : oiPercent >= 50
        ? "bg-yellow-500"
        : "bg-okx-up";

  return (
    <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4 space-y-4">
      <h3 className="text-sm font-bold text-okx-text-primary">
        {t("poolInfo")}
      </h3>

      {/* OI Bar */}
      <div>
        <div className="flex justify-between text-xs mb-1.5">
          <span className="text-okx-text-tertiary">{t("totalOI")}</span>
          <span className="text-okx-text-secondary font-mono">
            {formatBNBDisplay(totalOI)} / {formatBNBDisplay(maxOI)} BNB
          </span>
        </div>
        <div className="w-full h-2 bg-okx-bg-hover rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${oiBarColor}`}
            style={{ width: `${Math.min(oiPercent, 100)}%` }}
          />
        </div>
        <p className="text-xs text-okx-text-tertiary mt-1 text-right">
          {oiPercent.toFixed(1)}%
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-okx-bg-hover rounded-lg p-3">
          <p className="text-xs text-okx-text-tertiary mb-1">
            {t("feesCollected")}
          </p>
          <p className="text-sm font-mono font-medium text-okx-up">
            {poolStats ? formatBNBDisplay(poolStats.totalFeesCollected) : "—"}
            <span className="text-xs text-okx-text-tertiary ml-1">BNB</span>
          </p>
        </div>

        <div className="bg-okx-bg-hover rounded-lg p-3">
          <p className="text-xs text-okx-text-tertiary mb-1">
            {t("profitsPaid")}
          </p>
          <p className="text-sm font-mono font-medium text-okx-down">
            {poolStats ? formatBNBDisplay(poolStats.totalProfitsPaid) : "—"}
            <span className="text-xs text-okx-text-tertiary ml-1">BNB</span>
          </p>
        </div>

        <div className="bg-okx-bg-hover rounded-lg p-3">
          <p className="text-xs text-okx-text-tertiary mb-1">
            {t("lossesReceived")}
          </p>
          <p className="text-sm font-mono font-medium text-okx-up">
            {poolStats ? formatBNBDisplay(poolStats.totalLossesReceived) : "—"}
            <span className="text-xs text-okx-text-tertiary ml-1">BNB</span>
          </p>
        </div>

        <div className="bg-okx-bg-hover rounded-lg p-3">
          <p className="text-xs text-okx-text-tertiary mb-1">
            {t("liquidationReceived")}
          </p>
          <p className="text-sm font-mono font-medium text-okx-up">
            {poolStats
              ? formatBNBDisplay(poolStats.totalLiquidationReceived)
              : "—"}
            <span className="text-xs text-okx-text-tertiary ml-1">BNB</span>
          </p>
        </div>
      </div>

      {/* ADL Warning */}
      {extendedStats?.adlNeeded && (
        <div className="bg-okx-down/10 border border-okx-down/30 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <svg
              className="w-4 h-4 text-okx-down flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            <span className="text-sm font-bold text-okx-down">
              {t("adlWarning")}
            </span>
          </div>
          <p className="text-xs text-okx-down/80">{t("adlWarningDesc")}</p>
        </div>
      )}
    </div>
  );
}
