"use client";

import React, { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { MATCHING_ENGINE_URL } from "@/config/api";

interface RewardRecord {
  id: string;
  type: "level1" | "level2" | "claim";
  traderAddress: string;
  domainName: string;
  tradeType: "buy" | "sell";
  feeAmount: string;
  rewardAmount: string;
  txHash: string;
  timestamp: string;
}

interface RewardHistoryProps {
  address?: string;
}

/**
 * P2-1: 奖励历史组件 — 从真实 API 获取数据
 *
 * API: GET /api/referral/commissions?address=0x...&limit=50
 */
export function RewardHistory({ address }: RewardHistoryProps) {
  const t = useTranslations("referral");
  const [rewards, setRewards] = useState<RewardRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) return;

    const fetchRewards = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${MATCHING_ENGINE_URL}/api/referral/commissions?address=${address}&limit=50`);
        const data = await res.json();

        if (data.commissions && Array.isArray(data.commissions)) {
          setRewards(data.commissions.map((c: { id?: string; level?: number; status?: string; referee?: string; tradeFee?: string; commissionAmount?: string; tradeId?: string; timestamp?: string }) => ({
            id: c.id || String(Math.random()),
            type: c.level === 2 ? "level2" : c.status === "withdrawn" ? "claim" : "level1",
            traderAddress: c.referee ? `${c.referee.slice(0, 6)}...${c.referee.slice(-4)}` : "",
            domainName: "",
            tradeType: "buy" as const,
            feeAmount: (Number(c.tradeFee || "0") / 1e18).toFixed(6),
            rewardAmount: (Number(c.commissionAmount || "0") / 1e18).toFixed(6),
            txHash: c.tradeId || "",
            timestamp: c.timestamp ? new Date(c.timestamp).toLocaleString() : "-",
          })));
        }
      } catch (e) {
        console.error("[RewardHistory] Failed to fetch:", e);
      } finally {
        setLoading(false);
      }
    };

    fetchRewards();
  }, [address]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-okx-accent"></div>
      </div>
    );
  }

  if (rewards.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-4">📊</div>
        <p className="text-okx-text-secondary">{t("noRewards")}</p>
        <p className="text-sm text-okx-text-tertiary mt-2">{t("inviteToEarn")}</p>
      </div>
    );
  }

  const getTypeLabel = (type: string) => {
    switch (type) {
      case "level1":
        return t("level1Reward");
      case "level2":
        return t("level2Reward");
      case "claim":
        return t("claimed");
      default:
        return type;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "level1":
        return "bg-okx-up/20 text-okx-up";
      case "level2":
        return "bg-blue-500/20 text-blue-500";
      case "claim":
        return "bg-purple-500/20 text-purple-500";
      default:
        return "bg-gray-500/20 text-gray-500";
    }
  };

  return (
    <div className="space-y-3">
      {rewards.map((reward) => (
        <div
          key={reward.id}
          className="p-4 bg-okx-bg-hover rounded-lg border border-okx-border-secondary"
        >
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className={`px-2 py-1 rounded text-xs font-medium ${getTypeColor(reward.type)}`}>
                {getTypeLabel(reward.type)}
              </span>
              <div>
                {reward.type !== "claim" ? (
                  <>
                    <div className="text-sm">
                      <span className="text-okx-text-secondary">{t("from")}: </span>
                      <span className="font-mono">{reward.traderAddress}</span>
                    </div>
                    {reward.feeAmount !== "0.000000" && (
                      <div className="text-xs text-okx-text-tertiary mt-1">
                        Fee: {reward.feeAmount} BNB
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-okx-text-secondary">{t("claimedToWallet")}</div>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className={`font-bold ${reward.type === "claim" ? "text-purple-500" : "text-okx-up"}`}>
                +{reward.rewardAmount} BNB
              </div>
              <div className="text-xs text-okx-text-tertiary">{reward.timestamp}</div>
            </div>
          </div>
          {reward.txHash && (
            <div className="mt-2 pt-2 border-t border-okx-border-primary">
              <a
                href={`https://sepolia.basescan.org/tx/${reward.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-okx-accent hover:underline"
              >
                {t("viewOnExplorer")} →
              </a>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
