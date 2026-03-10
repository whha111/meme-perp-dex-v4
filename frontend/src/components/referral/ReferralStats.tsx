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
      icon: <svg className="w-5 h-5 text-okx-text-secondary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>,
    },
    {
      label: t("activeInvites"),
      value: activeInvites.toString(),
      icon: <svg className="w-5 h-5 text-okx-up" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
      sublabel: t("tradedOnce"),
    },
    {
      label: t("totalEarned"),
      value: `${totalEarned} BNB`,
      icon: <svg className="w-5 h-5 text-okx-up" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
      valueClass: "text-okx-up",
    },
    {
      label: t("pendingReward"),
      value: `${pendingReward} BNB`,
      icon: <svg className="w-5 h-5 text-okx-accent" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
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
            {stat.icon}
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
