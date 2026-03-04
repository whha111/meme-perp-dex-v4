"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useTranslations } from "next-intl";
import { Navbar } from "@/components/layout/Navbar";
import { InviteCard } from "@/components/referral/InviteCard";
import { TierProgress } from "@/components/referral/TierProgress";
import { ReferralStats } from "@/components/referral/ReferralStats";
import { InviteeList } from "@/components/referral/InviteeList";
import { RewardHistory } from "@/components/referral/RewardHistory";
import { MATCHING_ENGINE_URL } from "@/config/api";

interface ReferrerInfo {
  code: string;
  codeReadable: string;
  tier: number;
  totalInvites: number;
  activeInvites: number;
  totalVolume: string;
  totalEarned: string;
  pendingReward: string;
  currentRebateBps: number;
  currentLevel2Bps: number;
}

/**
 * P2-1: /invite 页面接入真实 API
 *
 * 调用撮合引擎 Referral API:
 *  - GET /api/referral/referrer?address=0x... — 获取推荐信息
 *  - POST /api/referral/register — 如果用户还不是推荐人，自动注册
 */

// 根据邀请人数和交易量计算当前等级
function calculateTier(totalInvites: number, totalVolume: string): number {
  const vol = parseFloat(totalVolume);
  if (totalInvites >= 100 || vol >= 50) return 3; // Diamond
  if (totalInvites >= 20 || vol >= 10) return 2;  // Gold
  if (totalInvites >= 5 || vol >= 1) return 1;    // Silver
  return 0; // Bronze
}

// 根据等级获取返佣比例
function getTierRebateBps(tier: number): { rebate: number; level2: number } {
  switch (tier) {
    case 3: return { rebate: 2500, level2: 500 };
    case 2: return { rebate: 2000, level2: 400 };
    case 1: return { rebate: 1500, level2: 300 };
    default: return { rebate: 1000, level2: 200 };
  }
}

export default function InvitePage() {
  const t = useTranslations("referral");
  const { address, isConnected } = useAccount();
  const [referrerInfo, setReferrerInfo] = useState<ReferrerInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "invitees" | "rewards">("overview");

  // P2-1: 从真实 API 获取推荐信息
  const fetchReferrerInfo = useCallback(async (addr: string) => {
    setLoading(true);
    setError(null);

    try {
      // 1. 尝试获取推荐人信息
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/referral/referrer?address=${addr}`);
      const data = await res.json();

      if (data.isReferrer && data.referrer) {
        const r = data.referrer;
        const totalInvites = (r.level1Referrals || 0) + (r.level2Referrals || 0);
        const totalVolumeEth = (Number(r.totalVolumeReferred || "0") / 1e18).toFixed(4);
        const totalEarnedEth = (Number(r.totalEarnings || "0") / 1e18).toFixed(6);
        const pendingEth = (Number(r.pendingEarnings || "0") / 1e18).toFixed(6);
        const tier = calculateTier(r.level1Referrals || 0, totalVolumeEth);
        const bps = getTierRebateBps(tier);

        setReferrerInfo({
          code: r.code || "",
          codeReadable: r.code || "",
          tier,
          totalInvites,
          activeInvites: r.level1Referrals || 0,
          totalVolume: totalVolumeEth,
          totalEarned: totalEarnedEth,
          pendingReward: pendingEth,
          currentRebateBps: bps.rebate,
          currentLevel2Bps: bps.level2,
        });
      } else {
        // 2. 不是推荐人，自动注册
        const registerRes = await fetch(`${MATCHING_ENGINE_URL}/api/referral/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: addr }),
        });
        const registerData = await registerRes.json();

        if (registerData.success && registerData.referrer) {
          const r = registerData.referrer;
          setReferrerInfo({
            code: r.code || "",
            codeReadable: r.code || "",
            tier: 0,
            totalInvites: 0,
            activeInvites: 0,
            totalVolume: "0",
            totalEarned: "0",
            pendingReward: "0",
            currentRebateBps: 1000,
            currentLevel2Bps: 200,
          });
        } else {
          // 注册也失败，显示默认空状态
          setReferrerInfo({
            code: "",
            codeReadable: "",
            tier: 0,
            totalInvites: 0,
            activeInvites: 0,
            totalVolume: "0",
            totalEarned: "0",
            pendingReward: "0",
            currentRebateBps: 1000,
            currentLevel2Bps: 200,
          });
        }
      }
    } catch (e) {
      console.error("[Invite] Failed to fetch referrer info:", e);
      setError("Failed to load referral data. Please try again later.");
      // 降级到空状态（不显示假数据）
      setReferrerInfo({
        code: "",
        codeReadable: "",
        tier: 0,
        totalInvites: 0,
        activeInvites: 0,
        totalVolume: "0",
        totalEarned: "0",
        pendingReward: "0",
        currentRebateBps: 1000,
        currentLevel2Bps: 200,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isConnected && address) {
      fetchReferrerInfo(address);
    } else {
      setReferrerInfo(null);
    }
  }, [isConnected, address, fetchReferrerInfo]);

  const tierConfig = [
    { name: t("tierBronze"), minInvites: 0, minVolume: "0", rebateBps: 1000, level2Bps: 200 },
    { name: t("tierSilver"), minInvites: 5, minVolume: "1", rebateBps: 1500, level2Bps: 300 },
    { name: t("tierGold"), minInvites: 20, minVolume: "10", rebateBps: 2000, level2Bps: 400 },
    { name: t("tierDiamond"), minInvites: 100, minVolume: "50", rebateBps: 2500, level2Bps: 500 },
  ];

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">{t("title")}</h1>
          <p className="text-okx-text-secondary">{t("subtitle")}</p>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-4 p-3 bg-okx-down/10 border border-okx-down/20 rounded-lg text-sm text-okx-down">
            {error}
          </div>
        )}

        {!isConnected ? (
          <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-12 text-center">
            <div className="text-6xl mb-4">🎁</div>
            <h2 className="text-xl font-bold mb-2">{t("connectWalletTitle")}</h2>
            <p className="text-okx-text-secondary mb-4">{t("connectWalletDesc")}</p>
          </div>
        ) : loading ? (
          <div className="flex justify-center items-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-okx-accent"></div>
          </div>
        ) : (
          <>
            {/* Tier Progress */}
            <TierProgress
              currentTier={referrerInfo?.tier ?? 0}
              activeInvites={referrerInfo?.activeInvites ?? 0}
              totalVolume={referrerInfo?.totalVolume ?? "0"}
              tierConfig={tierConfig}
            />

            {/* Main Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
              {/* Left Column - Invite Card */}
              <div className="lg:col-span-1">
                <InviteCard
                  code={referrerInfo?.code ?? ""}
                  codeReadable={referrerInfo?.codeReadable}
                  address={address ?? ""}
                  currentRebateBps={referrerInfo?.currentRebateBps ?? 1000}
                />
              </div>

              {/* Right Column - Stats & Tabs */}
              <div className="lg:col-span-2 space-y-6">
                {/* Stats Cards */}
                <ReferralStats
                  totalInvites={referrerInfo?.totalInvites ?? 0}
                  activeInvites={referrerInfo?.activeInvites ?? 0}
                  totalEarned={referrerInfo?.totalEarned ?? "0"}
                  pendingReward={referrerInfo?.pendingReward ?? "0"}
                />

                {/* Tabs */}
                <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg overflow-hidden">
                  <div className="flex border-b border-okx-border-primary">
                    <button
                      onClick={() => setActiveTab("overview")}
                      className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                        activeTab === "overview"
                          ? "text-okx-accent border-b-2 border-okx-accent bg-okx-bg-hover"
                          : "text-okx-text-secondary hover:text-okx-text-primary"
                      }`}
                    >
                      {t("tabOverview")}
                    </button>
                    <button
                      onClick={() => setActiveTab("invitees")}
                      className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                        activeTab === "invitees"
                          ? "text-okx-accent border-b-2 border-okx-accent bg-okx-bg-hover"
                          : "text-okx-text-secondary hover:text-okx-text-primary"
                      }`}
                    >
                      {t("tabInvitees")}
                    </button>
                    <button
                      onClick={() => setActiveTab("rewards")}
                      className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                        activeTab === "rewards"
                          ? "text-okx-accent border-b-2 border-okx-accent bg-okx-bg-hover"
                          : "text-okx-text-secondary hover:text-okx-text-primary"
                      }`}
                    >
                      {t("tabRewards")}
                    </button>
                  </div>

                  <div className="p-4">
                    {activeTab === "overview" && (
                      <div className="space-y-4">
                        <h3 className="font-medium">{t("howItWorks")}</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div className="p-4 bg-okx-bg-hover rounded-lg">
                            <div className="text-2xl mb-2">1</div>
                            <h4 className="font-medium mb-1">{t("step1Title")}</h4>
                            <p className="text-sm text-okx-text-secondary">{t("step1Desc")}</p>
                          </div>
                          <div className="p-4 bg-okx-bg-hover rounded-lg">
                            <div className="text-2xl mb-2">2</div>
                            <h4 className="font-medium mb-1">{t("step2Title")}</h4>
                            <p className="text-sm text-okx-text-secondary">{t("step2Desc")}</p>
                          </div>
                          <div className="p-4 bg-okx-bg-hover rounded-lg">
                            <div className="text-2xl mb-2">3</div>
                            <h4 className="font-medium mb-1">{t("step3Title")}</h4>
                            <p className="text-sm text-okx-text-secondary">{t("step3Desc")}</p>
                          </div>
                        </div>

                        {/* Tier Table */}
                        <h3 className="font-medium mt-6">{t("tierBenefits")}</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-okx-border-primary">
                                <th className="text-left py-3 px-4">{t("tier")}</th>
                                <th className="text-left py-3 px-4">{t("requirements")}</th>
                                <th className="text-right py-3 px-4">{t("level1Rebate")}</th>
                                <th className="text-right py-3 px-4">{t("level2Rebate")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tierConfig.map((tier, idx) => (
                                <tr
                                  key={idx}
                                  className={`border-b border-okx-border-primary ${
                                    idx === referrerInfo?.tier ? "bg-okx-accent/10" : ""
                                  }`}
                                >
                                  <td className="py-3 px-4">
                                    <span className={`tier-${["bronze", "silver", "gold", "diamond"][idx]}`}>
                                      {tier.name}
                                    </span>
                                  </td>
                                  <td className="py-3 px-4 text-okx-text-secondary">
                                    {idx === 0
                                      ? t("noRequirements")
                                      : `${tier.minInvites} ${t("inviteesOr")} ${tier.minVolume} BNB`}
                                  </td>
                                  <td className="py-3 px-4 text-right text-okx-up">
                                    {(tier.rebateBps / 100).toFixed(0)}%
                                  </td>
                                  <td className="py-3 px-4 text-right text-okx-up">
                                    {(tier.level2Bps / 100).toFixed(0)}%
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {activeTab === "invitees" && <InviteeList address={address} />}
                    {activeTab === "rewards" && <RewardHistory address={address} />}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
