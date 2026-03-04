"use client";

import React, { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { MATCHING_ENGINE_URL } from "@/config/api";

interface Invitee {
  address: string;
  registeredAt: string;
  totalVolume: string;
  rewardsGenerated: string;
  isActive: boolean;
}

interface InviteeListProps {
  address?: string;
}

/**
 * P2-1: 邀请人列表组件 — 从真实 API 获取数据
 *
 * API: GET /api/referral/referrer?address=0x...
 * 返回: referrer.level1Referrals (地址列表)
 *
 * 注意: 当前后端 API 返回的是邀请人数量 (number)，不是详细列表。
 * 如果后端扩展了详细列表 API，此组件会自动适配。
 * 当前降级为显示汇总信息。
 */
export function InviteeList({ address }: InviteeListProps) {
  const t = useTranslations("referral");
  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    if (!address) return;

    const fetchInvitees = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${MATCHING_ENGINE_URL}/api/referral/referrer?address=${address}`);
        const data = await res.json();

        if (data.isReferrer && data.referrer) {
          const r = data.referrer;
          // 后端返回的是数量，不是详细列表
          // 设置总数用于显示汇总
          setTotalCount(r.level1Referrals || 0);

          // 如果后端返回了详细列表 (未来扩展)
          if (Array.isArray(r.level1ReferralDetails)) {
            setInvitees(r.level1ReferralDetails.map((detail: { address?: string; joinedAt?: string; totalVolume?: string; commissionGenerated?: string; isActive?: boolean }) => ({
              address: detail.address ? `${detail.address.slice(0, 6)}...${detail.address.slice(-4)}` : "Unknown",
              registeredAt: detail.joinedAt ? new Date(detail.joinedAt).toLocaleDateString() : "-",
              totalVolume: detail.totalVolume ? (Number(detail.totalVolume) / 1e18).toFixed(4) : "0",
              rewardsGenerated: detail.commissionGenerated ? (Number(detail.commissionGenerated) / 1e18).toFixed(6) : "0",
              isActive: detail.isActive ?? true,
            })));
          }
        }
      } catch (e) {
        console.error("[InviteeList] Failed to fetch:", e);
      } finally {
        setLoading(false);
      }
    };

    fetchInvitees();
  }, [address]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-okx-accent"></div>
      </div>
    );
  }

  // 如果没有详细列表数据，显示汇总卡片
  if (invitees.length === 0) {
    return (
      <div className="text-center py-12">
        {totalCount > 0 ? (
          <>
            <div className="text-4xl mb-4">👥</div>
            <p className="text-lg font-medium mb-2">
              {totalCount} {totalCount === 1 ? "Invitee" : "Invitees"}
            </p>
            <p className="text-sm text-okx-text-secondary">
              {t("shareCodeHint")}
            </p>
          </>
        ) : (
          <>
            <div className="text-4xl mb-4">👥</div>
            <p className="text-okx-text-secondary">{t("noInvitees")}</p>
            <p className="text-sm text-okx-text-tertiary mt-2">{t("shareCodeHint")}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-okx-border-primary">
            <th className="text-left py-3 px-4 text-okx-text-secondary font-medium">
              {t("inviteeAddress")}
            </th>
            <th className="text-left py-3 px-4 text-okx-text-secondary font-medium">
              {t("joinedDate")}
            </th>
            <th className="text-right py-3 px-4 text-okx-text-secondary font-medium">
              {t("tradeVolume")}
            </th>
            <th className="text-right py-3 px-4 text-okx-text-secondary font-medium">
              {t("rewardsGenerated")}
            </th>
            <th className="text-center py-3 px-4 text-okx-text-secondary font-medium">
              {t("status")}
            </th>
          </tr>
        </thead>
        <tbody>
          {invitees.map((invitee, idx) => (
            <tr key={idx} className="border-b border-okx-border-primary hover:bg-okx-bg-hover">
              <td className="py-3 px-4 font-mono">{invitee.address}</td>
              <td className="py-3 px-4 text-okx-text-secondary">{invitee.registeredAt}</td>
              <td className="py-3 px-4 text-right">{invitee.totalVolume} BNB</td>
              <td className="py-3 px-4 text-right text-okx-up">{invitee.rewardsGenerated} BNB</td>
              <td className="py-3 px-4 text-center">
                <span
                  className={`inline-flex px-2 py-1 rounded-full text-xs ${
                    invitee.isActive
                      ? "bg-okx-up/20 text-okx-up"
                      : "bg-okx-text-tertiary/20 text-okx-text-tertiary"
                  }`}
                >
                  {invitee.isActive ? t("active") : t("inactive")}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
