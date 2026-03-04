"use client";

import React from "react";
import { useTranslations } from "next-intl";

interface ReferralStatsProps {
  totalInvites: number;
  activeInvites: number;
  totalEarned: string;
  pendingReward: string;
}

export function ReferralStats({ totalInvites, activeInvites, totalEarned, pendingReward }: ReferralStatsProps) {
  const t = useTranslations("referral");

  const stats = [
    {
      label: t("totalInvites"),
      value: totalInvites.toString(),
      icon: "👥",
    },
    {
      label: t("activeInvites"),
      value: activeInvites.toString(),
      icon: "✅",
      sublabel: t("tradedOnce"),
    },
    {
      label: t("totalEarned"),
      value: `${totalEarned} BNB`,
      icon: "💰",
      valueClass: "text-okx-up",
    },
    {
      label: t("pendingReward"),
      value: `${pendingReward} BNB`,
      icon: "⏳",
      valueClass: "text-okx-accent",
      action: parseFloat(pendingReward) > 0 ? t("claim") : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((stat, idx) => (
        <div
          key={idx}
          className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-4"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xl">{stat.icon}</span>
            <span className="text-sm text-okx-text-secondary">{stat.label}</span>
          </div>
          <div className={`text-xl font-bold ${stat.valueClass || ""}`}>
            {stat.value}
          </div>
          {stat.sublabel && (
            <div className="text-xs text-okx-text-tertiary mt-1">{stat.sublabel}</div>
          )}
          {stat.action && (
            <button className="mt-2 w-full px-3 py-1.5 text-sm bg-okx-accent text-white rounded-lg hover:bg-okx-accent/80 transition-colors">
              {stat.action}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
