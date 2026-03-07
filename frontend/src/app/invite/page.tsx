"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useTranslations } from "next-intl";
import { Navbar } from "@/components/layout/Navbar";
import { MATCHING_ENGINE_URL } from "@/config/api";

interface ReferrerInfo {
  code: string;
  tier: number;
  totalInvites: number;
  totalEarned: string;
  monthlyEarned: string;
  currentRebatePercent: number;
  invitees: InviteeRow[];
}

interface InviteeRow {
  address: string;
  joinedDate: string;
  volume: string;
  rebate: string;
}

// VIP tier config matching design
const VIP_TIERS = [
  { level: "VIP 1", rangeKey: "vip1Range", rate: "10%", rewardKey: "noDataPlaceholder" },
  { level: "VIP 2", rangeKey: "vip2Range", rate: "25%", rewardKey: "vip2Reward" },
  { level: "VIP 3", rangeKey: "vip3Range", rate: "35%", rewardKey: "vip3Reward" },
  { level: "VIP 4", rangeKey: "vip4Range", rate: "50%", rewardKey: "vip4Reward" },
];

function calculateVipTier(totalInvites: number): number {
  if (totalInvites >= 100) return 3;
  if (totalInvites >= 30) return 2;
  if (totalInvites >= 10) return 1;
  return 0;
}

function getNextTierRequirement(currentTier: number): { count: number; level: string } | null {
  if (currentTier >= 3) return null;
  const next = VIP_TIERS[currentTier + 1];
  const counts = [10, 30, 100];
  return { count: counts[currentTier], level: next.level };
}

export default function InvitePage() {
  const t = useTranslations("referral");
  const { address, isConnected } = useAccount();
  const [info, setInfo] = useState<ReferrerInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const inviteLink = info?.code
    ? `https://memeperp.io/ref/${address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ""}`
    : "";

  const fetchReferrerInfo = useCallback(async (addr: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/referral/referrer?address=${addr}`);
      const data = await res.json();

      if (data.isReferrer && data.referrer) {
        const r = data.referrer;
        const totalInvites = (r.level1Referrals || 0) + (r.level2Referrals || 0);
        const tier = calculateVipTier(r.level1Referrals || 0);
        const rebatePercents = [10, 25, 35, 50];

        setInfo({
          code: r.code || "",
          tier,
          totalInvites,
          totalEarned: (Number(r.totalEarnings || "0") / 1e18).toFixed(4),
          monthlyEarned: (Number(r.pendingEarnings || "0") / 1e18).toFixed(4),
          currentRebatePercent: rebatePercents[tier],
          invitees: [],
        });
      } else {
        // Auto-register
        const registerRes = await fetch(`${MATCHING_ENGINE_URL}/api/referral/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: addr }),
        });
        const registerData = await registerRes.json();
        const code = registerData?.referrer?.code || "";

        setInfo({
          code,
          tier: 0,
          totalInvites: 0,
          totalEarned: "0",
          monthlyEarned: "0",
          currentRebatePercent: 10,
          invitees: [],
        });
      }
    } catch {
      setInfo({
        code: "",
        tier: 0,
        totalInvites: 0,
        totalEarned: "0",
        monthlyEarned: "0",
        currentRebatePercent: 10,
        invitees: [],
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isConnected && address) {
      fetchReferrerInfo(address);
    } else {
      setInfo(null);
    }
  }, [isConnected, address, fetchReferrerInfo]);

  const handleCopy = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const nextTier = info ? getNextTierRequirement(info.tier) : null;

  return (
    <div className="min-h-screen bg-[#000000] text-white">
      <Navbar />

      {!isConnected ? (
        /* Connect Wallet State */
        <div className="flex flex-col items-center justify-center py-32 px-4">
          <svg className="w-16 h-16 mb-6 text-meme-lime mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
          <h2 className="text-2xl font-bold mb-3">{t("connectWalletTitle")}</h2>
          <p className="text-[#888888] text-base">{t("connectWalletDesc")}</p>
        </div>
      ) : loading ? (
        <div className="flex justify-center items-center py-32">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#BFFF00]" />
        </div>
      ) : (
        <>
          {/* Hero Section — gradient bg */}
          <div
            className="px-16 py-12"
            style={{ background: "linear-gradient(180deg, #0a0f00 0%, #000000 100%)" }}
          >
            <h1 className="text-4xl font-extrabold text-white mb-6">
              {t("heroTitle")}
            </h1>
            <p className="text-base text-[#888888] mb-6">
              {t("heroSubtitle")}
            </p>

            {/* Link Row */}
            <div className="flex items-center gap-3">
              <div className="flex items-center px-5 py-3.5 bg-[#111111] border border-[#333333] rounded-lg w-[520px]">
                <span className="text-sm font-mono text-[#BFFF00] truncate">
                  {inviteLink || "https://memeperp.io/ref/..."}
                </span>
              </div>
              <button
                onClick={handleCopy}
                className="px-7 py-3.5 bg-[#BFFF00] text-black text-sm font-bold rounded-lg hover:bg-[#d4ff4d] transition-colors"
              >
                {copied ? t("copied") : t("copyLink")}
              </button>
              <button className="px-7 py-3.5 border border-[#BFFF00] text-[#BFFF00] text-sm font-semibold rounded-lg hover:bg-[#BFFF00]/10 transition-colors">
                {t("sharePoster")}
              </button>
            </div>
          </div>

          {/* Stats Row — 4 cards */}
          <div className="flex gap-5 px-16 py-6">
            {/* Card 1: Total Invited */}
            <div className="flex-1 bg-[#111111] border border-[#1a1a1a] rounded-xl p-6">
              <div className="text-[13px] text-[#888888] mb-2">{t("totalInvited")}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-extrabold font-mono text-[#BFFF00]">
                  {info?.totalInvites ?? 0}
                </span>
                <span className="text-sm text-[#666666]">{t("personUnit")}</span>
              </div>
            </div>

            {/* Card 2: Total Rebate */}
            <div className="flex-1 bg-[#111111] border border-[#1a1a1a] rounded-xl p-6">
              <div className="text-[13px] text-[#888888] mb-2">{t("totalRebate")}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-extrabold font-mono text-white">
                  {info?.totalEarned ?? "0"}
                </span>
                <span className="text-sm text-[#666666]">ETH</span>
              </div>
            </div>

            {/* Card 3: Monthly Rebate */}
            <div className="flex-1 bg-[#111111] border border-[#1a1a1a] rounded-xl p-6">
              <div className="text-[13px] text-[#888888] mb-2">{t("monthlyRebate")}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-extrabold font-mono text-white">
                  {info?.monthlyEarned ?? "0"}
                </span>
                <span className="text-sm text-[#666666]">ETH</span>
              </div>
            </div>

            {/* Card 4: Current Tier */}
            <div className="flex-1 bg-[#111111] border border-[#1a1a1a] rounded-xl p-6">
              <div className="text-[13px] text-[#888888] mb-2">{t("currentLevel")}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-extrabold font-mono text-[#BFFF00]">
                  VIP {(info?.tier ?? 0) + 1}
                </span>
                <span className="text-sm text-[#666666]">
                  / {info?.currentRebatePercent ?? 10}%{t("rebateSuffix")}
                </span>
              </div>
            </div>
          </div>

          {/* Body — Two Columns */}
          <div className="flex gap-8 px-16 pb-12">
            {/* Left Column: Tier Table */}
            <div className="flex-1 flex flex-col gap-4">
              {/* Title Row */}
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">{t("rebateTierTitle")}</h2>
                {nextTier && (
                  <span className="text-xs text-[#666666]">
                    {t("upgradeHint", { count: nextTier.count, level: nextTier.level })}
                  </span>
                )}
              </div>

              {/* Table Header */}
              <div className="flex items-center px-4 py-2.5 bg-[#0a0a0a] rounded-lg">
                <span className="flex-1 text-xs font-semibold text-[#888888]">{t("tierLevelCol")}</span>
                <span className="flex-1 text-xs font-semibold text-[#888888] text-center">{t("inviteCountCol")}</span>
                <span className="flex-1 text-xs font-semibold text-[#888888] text-center">{t("rebateRateCol")}</span>
                <span className="flex-1 text-xs font-semibold text-[#888888] text-right">{t("extraRewardCol")}</span>
              </div>

              {/* Tier Rows */}
              {VIP_TIERS.map((tier, idx) => {
                const isActive = idx === (info?.tier ?? 0);
                return (
                  <div
                    key={idx}
                    className={`flex items-center px-4 py-3 ${
                      isActive
                        ? "bg-[#BFFF00]/[0.03] border border-[#BFFF00]/[0.13] rounded-md"
                        : "border-b border-[#1a1a1a]"
                    }`}
                  >
                    <div className="flex-1 flex items-center gap-1.5">
                      <span
                        className={`text-[13px] font-mono font-semibold ${
                          isActive ? "text-[#BFFF00] font-bold" : "text-[#888888]"
                        }`}
                      >
                        {tier.level}
                      </span>
                      {isActive && (
                        <span className="text-[9px] font-bold text-black bg-[#BFFF00] px-1.5 py-0.5 rounded">
                          {t("currentBadge")}
                        </span>
                      )}
                    </div>
                    <span className="flex-1 text-[13px] font-mono text-white text-center">
                      {t(tier.rangeKey as any)}
                    </span>
                    <span
                      className={`flex-1 text-[13px] font-mono text-center ${
                        isActive ? "text-[#BFFF00] font-bold" : "text-[#BFFF00]"
                      }`}
                    >
                      {tier.rate}
                    </span>
                    <span
                      className={`flex-1 text-xs text-right ${
                        isActive ? "text-[#BFFF00]" : "text-[#888888]"
                      }`}
                    >
                      {idx === 0 ? t("noDataPlaceholder") : t(tier.rewardKey as any)}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Right Column: Invite History */}
            <div className="w-[480px] flex-shrink-0 flex flex-col gap-4">
              <h2 className="text-lg font-bold text-white">{t("inviteHistory")}</h2>

              {/* Table Header */}
              <div className="flex items-center px-3 py-2.5 bg-[#0a0a0a] rounded-lg">
                <span className="flex-1 text-xs font-semibold text-[#888888]">{t("userCol")}</span>
                <span className="flex-1 text-xs font-semibold text-[#888888] text-center">{t("registerTimeCol")}</span>
                <span className="flex-1 text-xs font-semibold text-[#888888] text-center">{t("tradeVolumeCol")}</span>
                <span className="flex-1 text-xs font-semibold text-[#888888] text-right">{t("rebateAmountCol")}</span>
              </div>

              {/* Invite Rows (from API or placeholder) */}
              {(info?.invitees && info.invitees.length > 0) ? (
                info.invitees.map((inv, idx) => (
                  <div
                    key={idx}
                    className="flex items-center px-3 py-2.5 border-b border-[#1a1a1a]"
                  >
                    <span className="flex-1 text-xs font-mono text-white">{inv.address}</span>
                    <span className="flex-1 text-xs font-mono text-[#888888] text-center">{inv.joinedDate}</span>
                    <span className="flex-1 text-xs font-mono text-white text-center">{inv.volume} ETH</span>
                    <span className="flex-1 text-xs font-mono text-[#BFFF00] text-right">+{inv.rebate}</span>
                  </div>
                ))
              ) : (
                <div className="flex items-center justify-center py-12 text-[#666666] text-sm">
                  {t("noInvitees")}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
