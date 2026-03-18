"use client";

import { useTranslations } from "next-intl";
import type { Address } from "viem";
import type { PoolInfo, UserLendingPosition } from "@/hooks/lending/useLendingPool";

interface LendingMarketTableProps {
  pools: PoolInfo[];
  positions: UserLendingPosition[];
  selectedToken: Address | null;
  onSelect: (token: Address) => void;
}

/**
 * Aave-style market table — professional data table with sortable columns
 * replacing the old card grid layout.
 */
export function LendingMarketTable({
  pools,
  positions,
  selectedToken,
  onSelect,
}: LendingMarketTableProps) {
  const t = useTranslations("lending");

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        {/* Table Head */}
        <thead>
          <tr className="text-xs text-okx-text-tertiary uppercase tracking-wider">
            <th className="text-left px-5 py-3 font-medium">{t("colAsset")}</th>
            <th className="text-right px-3 py-3 font-medium hidden md:table-cell">{t("colTotalSupply")}</th>
            <th className="text-right px-3 py-3 font-medium">{t("colSupplyAPY")}</th>
            <th className="text-right px-3 py-3 font-medium hidden lg:table-cell">{t("colTotalBorrowed")}</th>
            <th className="text-right px-3 py-3 font-medium hidden lg:table-cell">{t("colBorrowAPY")}</th>
            <th className="text-right px-3 py-3 font-medium hidden sm:table-cell">{t("colUtilization")}</th>
            <th className="text-right px-3 py-3 font-medium">{t("colYourDeposit")}</th>
            <th className="text-right px-5 py-3 font-medium">{t("colAction")}</th>
          </tr>
        </thead>

        {/* Table Body */}
        <tbody>
          {pools.map((pool) => {
            const userPos = positions.find((p) => p.token === pool.token);
            const isSelected = selectedToken === pool.token;
            const utilNum = parseFloat(pool.utilizationPercent);

            return (
              <tr
                key={pool.token}
                onClick={() => onSelect(pool.token)}
                className={`border-t border-okx-border-primary cursor-pointer transition-colors group ${
                  isSelected
                    ? "bg-okx-accent/5"
                    : "hover:bg-okx-bg-hover"
                }`}
              >
                {/* Asset */}
                <td className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    {/* Token Avatar */}
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-okx-bg-hover to-okx-border-primary flex items-center justify-center text-xs font-bold text-okx-text-secondary shrink-0">
                      {pool.tokenSymbol.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-sm leading-tight">{pool.tokenSymbol}</div>
                      <div className="text-xs text-okx-text-tertiary truncate max-w-[120px]">
                        {pool.tokenName}
                      </div>
                    </div>
                    {/* Active badge */}
                    {userPos && (
                      <span className="ml-1 w-2 h-2 rounded-full bg-okx-up shrink-0" title={t("deposited")} />
                    )}
                  </div>
                </td>

                {/* Total Supply */}
                <td className="text-right px-3 py-4 hidden md:table-cell">
                  <span className="text-sm font-medium">{pool.totalDepositsFormatted}</span>
                </td>

                {/* Supply APY */}
                <td className="text-right px-3 py-4">
                  <span className="text-sm font-bold text-okx-up">{pool.supplyAPY}%</span>
                </td>

                {/* Total Borrowed */}
                <td className="text-right px-3 py-4 hidden lg:table-cell">
                  <span className="text-sm font-medium">{pool.totalBorrowedFormatted}</span>
                </td>

                {/* Borrow APY */}
                <td className="text-right px-3 py-4 hidden lg:table-cell">
                  <span className="text-sm font-medium">{pool.borrowAPY}%</span>
                </td>

                {/* Utilization */}
                <td className="text-right px-3 py-4 hidden sm:table-cell">
                  <div className="flex flex-col items-end gap-1">
                    <span className={`text-xs font-medium ${
                      utilNum >= 90 ? "text-okx-down" : utilNum >= 80 ? "text-yellow-500" : "text-okx-text-primary"
                    }`}>
                      {pool.utilizationPercent}%
                    </span>
                    {/* Mini utilization bar */}
                    <div className="w-14 h-1 bg-okx-bg-hover rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          utilNum >= 90 ? "bg-okx-down" : utilNum >= 80 ? "bg-yellow-500" : "bg-okx-up"
                        }`}
                        style={{ width: `${Math.min(utilNum, 100)}%` }}
                      />
                    </div>
                  </div>
                </td>

                {/* Your Deposit */}
                <td className="text-right px-3 py-4">
                  {userPos ? (
                    <div>
                      <div className="text-sm font-medium">{userPos.depositAmountFormatted}</div>
                      {userPos.pendingInterest > 0n && (
                        <div className="text-xs text-okx-up">+{userPos.pendingInterestFormatted}</div>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-okx-text-tertiary">—</span>
                  )}
                </td>

                {/* Action */}
                <td className="text-right px-5 py-4">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(pool.token);
                    }}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      isSelected
                        ? "bg-okx-accent text-black"
                        : "bg-okx-bg-hover text-okx-text-primary hover:bg-okx-accent hover:text-black"
                    }`}
                  >
                    {userPos ? t("manage") : t("supply")}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
