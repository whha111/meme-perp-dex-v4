"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";
import { MATCHING_ENGINE_URL } from "@/config/api";

interface ReferrerInfo {
  code: string;
  totalInvites: number;
  totalEarned: string;
  monthlyEarned: string;
  invitees: InviteeRow[];
}

interface InviteeRow {
  address: string;
  joinedDate: string;
  volume: string;
  rebate: string;
}

// 固定返佣费率 (与后端 REFERRAL_CONFIG 一致)
const COMMISSION_RATES = {
  level1: 30,  // 直推返佣 30%
  level2: 10,  // 二级返佣 10%
};

export default function InvitePage() {
  const t = useTranslations("referral");
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [info, setInfo] = useState<ReferrerInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawSuccess, setWithdrawSuccess] = useState(false);
  const router = useRouter();

  // C-2: 邀请链接指向 /invite/[code] (Next.js 路由真实存在)
  const inviteLink = info?.code
    ? `${typeof window !== "undefined" ? window.location.origin : "https://memeperp.io"}/invite/${info.code}`
    : "";

  const fetchReferrerInfo = useCallback(async (addr: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/referral/referrer?address=${addr}`);
      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }
      const data = await res.json();

      if (data.isReferrer && data.referrer) {
        const r = data.referrer;
        const totalInvites = (r.level1Referrals || 0) + (r.level2Referrals || 0);

        setInfo({
          code: r.code || "",
          totalInvites,
          totalEarned: (Number(r.totalEarnings || "0") / 1e18).toFixed(4),
          monthlyEarned: (Number(r.pendingEarnings || "0") / 1e18).toFixed(4),
          invitees: [],
        });
      } else {
        // Auto-register
        const registerRes = await fetch(`${MATCHING_ENGINE_URL}/api/referral/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: addr }),
        });
        if (!registerRes.ok) {
          throw new Error(`Registration failed: ${registerRes.status}`);
        }
        const registerData = await registerRes.json();
        const code = registerData?.referrer?.code || "";

        setInfo({
          code,
          totalInvites: 0,
          totalEarned: "0",
          monthlyEarned: "0",
          invitees: [],
        });
      }
    } catch (e) {
      console.error("[Invite] Failed to fetch referrer info:", e);
      setError(e instanceof Error ? e.message : "Failed to load referral data");
      setInfo({
        code: "",
        totalInvites: 0,
        totalEarned: "0",
        monthlyEarned: "0",
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

  // C-4: 提现全部待领取佣金
  const handleWithdraw = async () => {
    if (!address || !info) return;
    const pendingWei = info.monthlyEarned; // already in ETH display string
    if (pendingWei === "0" || pendingWei === "0.0000") return;

    setWithdrawing(true);
    setError(null);
    try {
      const normalizedAddr = address.toLowerCase();
      const withdrawMessage = `Withdraw commission for ${normalizedAddr}`;
      const signature = await signMessageAsync({ message: withdrawMessage });
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/referral/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Withdraw failed: ${res.status}`);
      }
      setWithdrawSuccess(true);
      // Refresh data
      fetchReferrerInfo(address);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Withdraw failed");
    } finally {
      setWithdrawing(false);
    }
  };

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      {!isConnected ? (
        /* Connect Wallet State */
        <div className="flex flex-col items-center justify-center py-32 px-4">
          <svg className="w-16 h-16 mb-6 text-meme-lime mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
          <h2 className="text-2xl font-bold mb-3">{t("connectWalletTitle")}</h2>
          <p className="text-okx-text-secondary text-base">{t("connectWalletDesc")}</p>
        </div>
      ) : loading ? (
        <div className="flex justify-center items-center py-32">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-meme-lime" />
        </div>
      ) : (
        <>
          {/* H-7: Error banner */}
          {error && (
            <div className="mx-16 mt-4 px-4 py-3 bg-red-900/30 border border-red-500/50 rounded-lg flex items-center justify-between">
              <span className="text-sm text-red-400">{error}</span>
              <button
                onClick={() => address && fetchReferrerInfo(address)}
                className="text-xs text-red-300 hover:text-okx-text-primary underline ml-4"
              >
                {t("retry") || "Retry"}
              </button>
            </div>
          )}

          {/* Hero Section — gradient bg */}
          <div
            className="px-16 py-12"
            style={{ background: "linear-gradient(180deg, var(--okx-bg-secondary) 0%, var(--okx-bg-primary) 100%)" }}
          >
            <h1 className="text-4xl font-extrabold text-okx-text-primary mb-6">
              {t("heroTitle")}
            </h1>
            <p className="text-base text-okx-text-secondary mb-6">
              {t("heroSubtitle")}
            </p>

            {/* Link Row */}
            <div className="flex items-center gap-3">
              <div className="flex items-center px-5 py-3.5 bg-okx-bg-card border border-okx-border-secondary rounded-lg w-[520px]">
                <span className="text-sm font-mono text-meme-lime truncate">
                  {inviteLink || "https://memeperp.io/invite/..."}
                </span>
              </div>
              <button
                onClick={handleCopy}
                className="px-7 py-3.5 bg-meme-lime text-black text-sm font-bold rounded-lg hover:brightness-110 transition-colors"
              >
                {copied ? t("copied") : t("copyLink")}
              </button>
              <button className="px-7 py-3.5 border border-meme-lime text-meme-lime text-sm font-semibold rounded-lg hover:bg-meme-lime/10 transition-colors">
                {t("sharePoster")}
              </button>
            </div>
          </div>

          {/* Stats Row — 4 cards */}
          <div className="flex gap-5 px-16 py-6">
            {/* Card 1: Total Invited */}
            <div className="flex-1 bg-okx-bg-card border border-okx-border-primary rounded-xl p-6">
              <div className="text-sm text-okx-text-secondary mb-2">{t("totalInvited")}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-extrabold font-mono text-meme-lime">
                  {info?.totalInvites ?? 0}
                </span>
                <span className="text-sm text-okx-text-tertiary">{t("personUnit")}</span>
              </div>
            </div>

            {/* Card 2: Total Rebate */}
            <div className="flex-1 bg-okx-bg-card border border-okx-border-primary rounded-xl p-6">
              <div className="text-sm text-okx-text-secondary mb-2">{t("totalRebate")}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-extrabold font-mono text-okx-text-primary">
                  {info?.totalEarned ?? "0"}
                </span>
                <span className="text-sm text-okx-text-tertiary">BNB</span>
              </div>
            </div>

            {/* Card 3: Pending Rebate + Withdraw */}
            <div className="flex-1 bg-okx-bg-card border border-okx-border-primary rounded-xl p-6">
              <div className="text-sm text-okx-text-secondary mb-2">{t("monthlyRebate")}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-extrabold font-mono text-okx-text-primary">
                  {info?.monthlyEarned ?? "0"}
                </span>
                <span className="text-sm text-okx-text-tertiary">BNB</span>
              </div>
              {/* C-4: Withdraw button */}
              {withdrawSuccess ? (
                <div className="mt-3 space-y-2">
                  <div className="w-full px-3 py-2 bg-okx-up/20 border border-okx-up/40 text-okx-up text-xs font-bold rounded-lg text-center">
                    {t("withdrawToAccountSuccess") || "佣金已转入交易账户"}
                  </div>
                  <button
                    onClick={() => router.push("/deposit")}
                    className="w-full px-3 py-2 bg-meme-lime text-black text-xs font-bold rounded-lg hover:brightness-110 transition-colors"
                  >
                    {t("goToWithdraw") || "去提现到钱包 →"}
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleWithdraw}
                  disabled={withdrawing || !info?.monthlyEarned || info.monthlyEarned === "0" || info.monthlyEarned === "0.0000"}
                  className="mt-3 w-full px-3 py-2 bg-meme-lime text-black text-xs font-bold rounded-lg hover:brightness-110 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {withdrawing ? (t("withdrawing") || "Withdrawing...") : (t("withdrawToAccount") || "提取到交易账户")}
                </button>
              )}
            </div>

            {/* Card 4: Commission Rate */}
            <div className="flex-1 bg-okx-bg-card border border-okx-border-primary rounded-xl p-6">
              <div className="text-sm text-okx-text-secondary mb-2">{t("currentLevel")}</div>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-extrabold font-mono text-meme-lime">
                  {COMMISSION_RATES.level1}%
                </span>
                <span className="text-sm text-okx-text-tertiary">
                  {t("rebateSuffix")}
                </span>
              </div>
            </div>
          </div>

          {/* Body — Two Columns */}
          <div className="flex gap-8 px-16 pb-12">
            {/* Left Column: Commission Rates */}
            <div className="flex-1 flex flex-col gap-4">
              <h2 className="text-lg font-bold text-okx-text-primary">{t("rebateTierTitle")}</h2>

              {/* Commission Rate Cards */}
              <div className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-6 flex flex-col gap-5">
                {/* Level 1: Direct Referral */}
                <div className="flex items-center justify-between py-4 border-b border-okx-border-primary">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-okx-text-primary">{t("level1Label")}</span>
                      <span className="text-xs font-bold text-black bg-meme-lime px-1.5 py-0.5 rounded">
                        L1
                      </span>
                    </div>
                    <span className="text-xs text-okx-text-secondary">{t("level1Desc")}</span>
                  </div>
                  <span className="text-3xl font-extrabold font-mono text-meme-lime">
                    {COMMISSION_RATES.level1}%
                  </span>
                </div>

                {/* Level 2: Indirect Referral */}
                <div className="flex items-center justify-between py-4">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-okx-text-primary">{t("level2Label")}</span>
                      <span className="text-xs font-bold text-meme-lime border border-meme-lime px-1.5 py-0.5 rounded">
                        L2
                      </span>
                    </div>
                    <span className="text-xs text-okx-text-secondary">{t("level2Desc")}</span>
                  </div>
                  <span className="text-3xl font-extrabold font-mono text-meme-lime">
                    {COMMISSION_RATES.level2}%
                  </span>
                </div>
              </div>

              {/* How it works */}
              <div className="bg-okx-bg-secondary rounded-lg p-4">
                <p className="text-xs text-okx-text-tertiary leading-relaxed">
                  {t("commissionExplainer")}
                </p>
              </div>
            </div>

            {/* Right Column: Invite History */}
            <div className="w-[480px] flex-shrink-0 flex flex-col gap-4">
              <h2 className="text-lg font-bold text-okx-text-primary">{t("inviteHistory")}</h2>

              {/* Table Header */}
              <div className="flex items-center px-3 py-2.5 bg-okx-bg-secondary rounded-lg">
                <span className="flex-1 text-xs font-semibold text-okx-text-secondary">{t("userCol")}</span>
                <span className="flex-1 text-xs font-semibold text-okx-text-secondary text-center">{t("registerTimeCol")}</span>
                <span className="flex-1 text-xs font-semibold text-okx-text-secondary text-center">{t("tradeVolumeCol")}</span>
                <span className="flex-1 text-xs font-semibold text-okx-text-secondary text-right">{t("rebateAmountCol")}</span>
              </div>

              {/* Invite Rows (from API or placeholder) */}
              {(info?.invitees && info.invitees.length > 0) ? (
                info.invitees.map((inv, idx) => (
                  <div
                    key={idx}
                    className="flex items-center px-3 py-2.5 border-b border-okx-border-primary"
                  >
                    <span className="flex-1 text-xs font-mono text-okx-text-primary">{inv.address}</span>
                    <span className="flex-1 text-xs font-mono text-okx-text-secondary text-center">{inv.joinedDate}</span>
                    <span className="flex-1 text-xs font-mono text-okx-text-primary text-center">{inv.volume} BNB</span>
                    <span className="flex-1 text-xs font-mono text-meme-lime text-right">+{inv.rebate}</span>
                  </div>
                ))
              ) : (
                <div className="flex items-center justify-center py-12 text-okx-text-tertiary text-sm">
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
