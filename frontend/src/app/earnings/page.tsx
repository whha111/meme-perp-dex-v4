"use client";

import React, { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Navbar } from "@/components/layout/Navbar";
import { useEarnings, LeaderboardEntry } from "@/hooks/perpetual/useEarnings";
import { usePerpReferral } from "@/hooks/perpetual/usePerpReferral";

// Leaderboard Component
function Leaderboard({
  title,
  icon,
  entries,
  isLoading,
  type,
  currentAddress,
}: {
  title: string;
  icon: string;
  entries: LeaderboardEntry[];
  isLoading: boolean;
  type: "creator" | "referral";
  currentAddress?: string;
}) {
  const t = useTranslations("earnings");

  const formatAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg overflow-hidden h-fit">
      <div className="px-4 py-3 border-b border-okx-border-primary flex items-center gap-2">
        <span className="text-xl">{icon}</span>
        <h3 className="font-bold text-sm">{title}</h3>
      </div>

      <div className="p-2">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-okx-accent"></div>
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-8 text-okx-text-tertiary text-sm">
            {t("noLeaderboardData")}
          </div>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => {
              const isCurrentUser = currentAddress?.toLowerCase() === entry.address.toLowerCase();
              return (
                <div
                  key={entry.address}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                    isCurrentUser ? "bg-okx-accent/10 border border-okx-accent/30" : "hover:bg-okx-bg-hover"
                  }`}
                >
                  {/* Rank */}
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    entry.rank === 1 ? "bg-yellow-500 text-black" :
                    entry.rank === 2 ? "bg-gray-400 text-black" :
                    entry.rank === 3 ? "bg-amber-600 text-white" :
                    "bg-okx-bg-hover text-okx-text-secondary"
                  }`}>
                    {entry.rank}
                  </div>

                  {/* Address */}
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs truncate">
                      {formatAddress(entry.address)}
                      {isCurrentUser && <span className="ml-1 text-okx-accent">(You)</span>}
                    </div>
                    <div className="text-[10px] text-okx-text-tertiary">
                      {type === "creator" && entry.tokenCount !== undefined && (
                        <span>{entry.tokenCount} {t("tokens")}</span>
                      )}
                      {type === "referral" && entry.inviteCount !== undefined && (
                        <span>{entry.inviteCount} {t("invites")}</span>
                      )}
                    </div>
                  </div>

                  {/* Earnings */}
                  <div className="text-right">
                    <div className="text-xs font-bold text-okx-up">
                      {parseFloat(entry.earnings).toFixed(4)}
                    </div>
                    <div className="text-[10px] text-okx-text-tertiary">BNB</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function EarningsPage() {
  const t = useTranslations("earnings");
  const tCommon = useTranslations("common");
  const { address, isConnected } = useAccount();
  const searchParams = useSearchParams();
  const refParam = searchParams.get("ref");

  const {
    earnings,
    isLoading,
    refetch,
    creatorLeaderboard,
    referralLeaderboard,
    isLoadingLeaderboard,
    claimCreatorEarnings,
    isClaimingCreator,
    claimReferrerEarnings,
    isClaimingReferrer,
    setReferrer,
    isSetReferrerSuccess,
  } = useEarnings();

  // Perpetual referral data from backend
  const {
    perpEarnings,
    isReferrer: isPerpReferrer,
    perpReferrer,
    perpReferralCode,
    commissions,
    perpReferralLeaderboard,
    isLoadingLeaderboard: isLoadingPerpLeaderboard,
    registerAsReferrer,
    isRegistering,
    bindReferralCode,
    isBinding,
    withdrawCommission,
    isWithdrawing,
    isLoading: isLoadingPerp,
    refetch: refetchPerp,
  } = usePerpReferral();

  const [activeTab, setActiveTab] = useState<"creator" | "referral" | "perp">("creator");
  const [copied, setCopied] = useState(false);
  const [showRefBindSuccess, setShowRefBindSuccess] = useState(false);
  const [perpBindCode, setPerpBindCode] = useState("");

  // Handle referral code from URL
  useEffect(() => {
    if (refParam && isConnected && address && !earnings.referrer) {
      const isValidRef = refParam.startsWith("0x") && refParam.length === 42;
      const isNotSelf = refParam.toLowerCase() !== address.toLowerCase();
      if (isValidRef && isNotSelf) {
        setReferrer(refParam);
      }
    }
  }, [refParam, isConnected, address, earnings.referrer, setReferrer]);

  useEffect(() => {
    if (isSetReferrerSuccess) {
      setShowRefBindSuccess(true);
      setTimeout(() => setShowRefBindSuccess(false), 3000);
    }
  }, [isSetReferrerSuccess]);

  const inviteLink = address
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/earnings?ref=${address}`
    : "";

  const copyInviteLink = () => {
    if (inviteLink) {
      navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const copyPerpCode = () => {
    if (perpEarnings.referralCode) {
      navigator.clipboard.writeText(perpEarnings.referralCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const hasCreatorEarnings = parseFloat(earnings.creatorEarnings) > 0;
  const hasReferrerEarnings = parseFloat(earnings.referrerEarnings) > 0;
  const hasPerpPendingEarnings = parseFloat(perpEarnings.pendingEarnings) > 0;

  const handleRefetchAll = () => {
    refetch();
    refetchPerp();
  };

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      {/* Referral bind success toast */}
      {showRefBindSuccess && (
        <div className="fixed top-20 right-4 bg-okx-up text-black px-6 py-3 rounded-lg shadow-lg z-50 animate-fade-in">
          {t("referrerBindSuccess")}
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold mb-2">{t("title")}</h1>
          <p className="text-okx-text-secondary">{t("subtitle")}</p>
        </div>

        {!isConnected ? (
          <div className="max-w-md mx-auto bg-okx-bg-card border border-okx-border-primary rounded-lg p-12 text-center">
            <div className="text-6xl mb-4">💰</div>
            <h2 className="text-xl font-bold mb-2">{t("connectWalletTitle")}</h2>
            <p className="text-okx-text-secondary">{t("connectWalletDesc")}</p>
          </div>
        ) : (isLoading || isLoadingPerp) ? (
          <div className="flex justify-center items-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-okx-accent"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Left Sidebar - Creator Leaderboard */}
            <div className="lg:col-span-1 order-2 lg:order-1">
              <Leaderboard
                title={t("creatorLeaderboard")}
                icon="🏆"
                entries={creatorLeaderboard}
                isLoading={isLoadingLeaderboard}
                type="creator"
                currentAddress={address}
              />
            </div>

            {/* Main Content */}
            <div className="lg:col-span-2 order-1 lg:order-2 space-y-6">
              {/* Stats Overview - 3 cards */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-3">
                  <div className="text-okx-text-secondary text-[10px] mb-1">{t("creatorEarningsLabel")}</div>
                  <div className="text-lg font-bold text-okx-up">{parseFloat(earnings.creatorEarnings).toFixed(4)} BNB</div>
                  <div className="text-[10px] text-okx-text-tertiary mt-1">
                    {t("createdTokensCount", { count: earnings.createdTokens.length })}
                  </div>
                </div>
                <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-3">
                  <div className="text-okx-text-secondary text-[10px] mb-1">{t("referralEarningsLabel")}</div>
                  <div className="text-lg font-bold text-okx-up">{parseFloat(earnings.referrerEarnings).toFixed(4)} BNB</div>
                  {earnings.referrer && (
                    <div className="text-[10px] text-okx-text-tertiary mt-1">
                      {t("yourReferrer")}: {formatAddress(earnings.referrer)}
                    </div>
                  )}
                </div>
                <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-3">
                  <div className="text-okx-text-secondary text-[10px] mb-1">{t("perpEarningsLabel")}</div>
                  <div className="text-lg font-bold text-okx-up">{parseFloat(perpEarnings.pendingEarnings).toFixed(4)} BNB</div>
                  <div className="text-[10px] text-okx-text-tertiary mt-1">
                    {t("perpTotalEarnings")}: {parseFloat(perpEarnings.totalEarnings).toFixed(4)} BNB
                  </div>
                </div>
              </div>

              {/* Tabs - now 3 tabs */}
              <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg overflow-hidden">
                <div className="flex border-b border-okx-border-primary">
                  <button
                    onClick={() => setActiveTab("creator")}
                    className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                      activeTab === "creator"
                        ? "text-okx-accent border-b-2 border-okx-accent bg-okx-bg-hover"
                        : "text-okx-text-secondary hover:text-okx-text-primary"
                    }`}
                  >
                    {t("tabCreator")}
                  </button>
                  <button
                    onClick={() => setActiveTab("referral")}
                    className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                      activeTab === "referral"
                        ? "text-okx-accent border-b-2 border-okx-accent bg-okx-bg-hover"
                        : "text-okx-text-secondary hover:text-okx-text-primary"
                    }`}
                  >
                    {t("tabReferral")}
                  </button>
                  <button
                    onClick={() => setActiveTab("perp")}
                    className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                      activeTab === "perp"
                        ? "text-okx-accent border-b-2 border-okx-accent bg-okx-bg-hover"
                        : "text-okx-text-secondary hover:text-okx-text-primary"
                    }`}
                  >
                    {t("tabPerp")}
                  </button>
                </div>

                <div className="p-4">
                  {/* Creator Tab */}
                  {activeTab === "creator" && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-bold mb-1">{t("creatorRewardsTitle")}</h3>
                          <p className="text-xs text-okx-text-secondary">{t("creatorRewardsDesc")}</p>
                        </div>
                        <button
                          onClick={claimCreatorEarnings}
                          disabled={!hasCreatorEarnings || isClaimingCreator}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            hasCreatorEarnings && !isClaimingCreator
                              ? "bg-okx-up text-black hover:opacity-90"
                              : "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                          }`}
                        >
                          {isClaimingCreator ? t("claiming") : t("claim")}
                        </button>
                      </div>

                      {/* Fee breakdown */}
                      <div className="bg-okx-bg-hover rounded-lg p-3">
                        <h4 className="font-medium text-sm mb-2">{t("feeBreakdown")}</h4>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("spotTradingFee")}</span>
                            <span>1%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("creatorShare")}</span>
                            <span className="text-okx-up">25%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("effectiveRate")}</span>
                            <span className="text-okx-up">0.25%</span>
                          </div>
                        </div>
                      </div>

                      {/* Created tokens list */}
                      {earnings.createdTokens.length > 0 ? (
                        <div>
                          <h4 className="font-medium text-sm mb-2">{t("yourTokens")}</h4>
                          <div className="space-y-1 max-h-32 overflow-y-auto">
                            {earnings.createdTokens.map((token) => (
                              <div
                                key={token}
                                className="flex items-center justify-between bg-okx-bg-hover rounded-lg p-2"
                              >
                                <span className="font-mono text-xs">{formatAddress(token)}</span>
                                <a
                                  href={`/trade/${token}`}
                                  className="text-okx-accent text-xs hover:underline"
                                >
                                  {t("viewToken")}
                                </a>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-6 text-okx-text-secondary">
                          <div className="text-3xl mb-2">🪙</div>
                          <p className="text-sm">{t("noTokensCreated")}</p>
                          <a
                            href="/create"
                            className="inline-block mt-3 px-4 py-2 bg-okx-accent text-black rounded-lg text-sm font-medium hover:opacity-90"
                          >
                            {t("createTokenNow")}
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Referral Tab */}
                  {activeTab === "referral" && (
                    <div className="space-y-4">
                      {/* Invite link section */}
                      <div className="bg-okx-bg-hover rounded-lg p-3">
                        <h4 className="font-medium text-sm mb-2">{t("yourInviteLink")}</h4>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            readOnly
                            value={inviteLink}
                            className="flex-1 bg-okx-bg-primary border border-okx-border-primary rounded-lg px-3 py-2 text-xs font-mono"
                          />
                          <button
                            onClick={copyInviteLink}
                            className="px-3 py-2 bg-okx-accent text-black rounded-lg text-xs font-medium hover:opacity-90 whitespace-nowrap"
                          >
                            {copied ? tCommon("copied") : t("copy")}
                          </button>
                        </div>
                        <p className="text-[10px] text-okx-text-tertiary mt-2">
                          {t("inviteLinkDesc")}
                        </p>
                      </div>

                      {/* Referral earnings claim */}
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-bold mb-1">{t("referralRewardsTitle")}</h3>
                          <p className="text-xs text-okx-text-secondary">{t("referralRewardsDesc")}</p>
                        </div>
                        <button
                          onClick={claimReferrerEarnings}
                          disabled={!hasReferrerEarnings || isClaimingReferrer}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            hasReferrerEarnings && !isClaimingReferrer
                              ? "bg-okx-up text-black hover:opacity-90"
                              : "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                          }`}
                        >
                          {isClaimingReferrer ? t("claiming") : t("claim")}
                        </button>
                      </div>

                      {/* Fee breakdown */}
                      <div className="bg-okx-bg-hover rounded-lg p-3">
                        <h4 className="font-medium text-sm mb-2">{t("referralFeeBreakdown")}</h4>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("spotTradingFee")}</span>
                            <span>1%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("referrerShare")}</span>
                            <span className="text-okx-up">10%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("effectiveRate")}</span>
                            <span className="text-okx-up">0.1%</span>
                          </div>
                        </div>
                      </div>

                      {/* How it works */}
                      <div>
                        <h4 className="font-medium text-sm mb-2">{t("howItWorks")}</h4>
                        <div className="grid grid-cols-3 gap-2">
                          <div className="bg-okx-bg-hover rounded-lg p-2 text-center">
                            <div className="text-lg mb-1">1</div>
                            <h5 className="font-medium text-xs mb-1">{t("step1Title")}</h5>
                            <p className="text-[10px] text-okx-text-secondary">{t("step1Desc")}</p>
                          </div>
                          <div className="bg-okx-bg-hover rounded-lg p-2 text-center">
                            <div className="text-lg mb-1">2</div>
                            <h5 className="font-medium text-xs mb-1">{t("step2Title")}</h5>
                            <p className="text-[10px] text-okx-text-secondary">{t("step2Desc")}</p>
                          </div>
                          <div className="bg-okx-bg-hover rounded-lg p-2 text-center">
                            <div className="text-lg mb-1">3</div>
                            <h5 className="font-medium text-xs mb-1">{t("step3Title")}</h5>
                            <p className="text-[10px] text-okx-text-secondary">{t("step3Desc")}</p>
                          </div>
                        </div>
                      </div>

                      {/* Your referrer info */}
                      {earnings.referrer && (
                        <div className="bg-okx-bg-hover rounded-lg p-3">
                          <h4 className="font-medium text-sm mb-1">{t("yourReferrerTitle")}</h4>
                          <p className="text-[10px] text-okx-text-secondary mb-2">{t("yourReferrerDesc")}</p>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs">{formatAddress(earnings.referrer)}</span>
                            <a
                              href={`${process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL}/address/${earnings.referrer}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-okx-accent text-[10px] hover:underline"
                            >
                              {t("viewOnExplorer")}
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Perpetual Commission Tab */}
                  {activeTab === "perp" && (
                    <div className="space-y-4">
                      {/* Header + Withdraw button */}
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-bold mb-1">{t("perpRewardsTitle")}</h3>
                          <p className="text-xs text-okx-text-secondary">{t("perpRewardsDesc")}</p>
                        </div>
                        {isPerpReferrer && (
                          <button
                            onClick={() => withdrawCommission(undefined)}
                            disabled={!hasPerpPendingEarnings || isWithdrawing}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                              hasPerpPendingEarnings && !isWithdrawing
                                ? "bg-okx-up text-black hover:opacity-90"
                                : "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                            }`}
                          >
                            {isWithdrawing ? t("perpWithdrawing") : t("perpWithdraw")}
                          </button>
                        )}
                      </div>

                      {/* Perp earnings stats */}
                      {isPerpReferrer && (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="bg-okx-bg-hover rounded-lg p-3">
                            <div className="text-[10px] text-okx-text-tertiary mb-1">{t("perpPendingEarnings")}</div>
                            <div className="text-sm font-bold text-okx-up">{parseFloat(perpEarnings.pendingEarnings).toFixed(6)} BNB</div>
                          </div>
                          <div className="bg-okx-bg-hover rounded-lg p-3">
                            <div className="text-[10px] text-okx-text-tertiary mb-1">{t("perpWithdrawnEarnings")}</div>
                            <div className="text-sm font-bold">{parseFloat(perpEarnings.withdrawnEarnings).toFixed(6)} BNB</div>
                          </div>
                          <div className="bg-okx-bg-hover rounded-lg p-3">
                            <div className="text-[10px] text-okx-text-tertiary mb-1">{t("perpLevel1Earnings")}</div>
                            <div className="text-sm font-bold text-okx-up">{parseFloat(perpEarnings.level1Earnings).toFixed(6)} BNB</div>
                          </div>
                          <div className="bg-okx-bg-hover rounded-lg p-3">
                            <div className="text-[10px] text-okx-text-tertiary mb-1">{t("perpLevel2Earnings")}</div>
                            <div className="text-sm font-bold text-okx-up">{parseFloat(perpEarnings.level2Earnings).toFixed(6)} BNB</div>
                          </div>
                        </div>
                      )}

                      {/* Register / Invite Code section */}
                      {isPerpReferrer ? (
                        <div className="bg-okx-bg-hover rounded-lg p-3">
                          <h4 className="font-medium text-sm mb-2">{t("perpYourCode")}</h4>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              readOnly
                              value={perpEarnings.referralCode}
                              className="flex-1 bg-okx-bg-primary border border-okx-border-primary rounded-lg px-3 py-2 text-sm font-mono tracking-widest text-center"
                            />
                            <button
                              onClick={copyPerpCode}
                              className="px-3 py-2 bg-okx-accent text-black rounded-lg text-xs font-medium hover:opacity-90 whitespace-nowrap"
                            >
                              {copied ? tCommon("copied") : t("copy")}
                            </button>
                          </div>
                          <div className="flex items-center gap-4 mt-2 text-[10px] text-okx-text-tertiary">
                            <span>{t("perpReferralCount")}: {perpEarnings.referralCount}</span>
                            <span>{t("perpTradesReferred")}: {perpEarnings.totalTradesReferred}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="bg-okx-bg-hover rounded-lg p-3 text-center">
                          <p className="text-sm text-okx-text-secondary mb-3">{t("perpRegisterFirst")}</p>
                          <button
                            onClick={() => registerAsReferrer()}
                            disabled={isRegistering}
                            className={`px-6 py-2 rounded-lg text-sm font-medium transition-colors ${
                              !isRegistering
                                ? "bg-okx-accent text-black hover:opacity-90"
                                : "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                            }`}
                          >
                            {isRegistering ? t("perpRegistering") : t("perpRegister")}
                          </button>
                        </div>
                      )}

                      {/* Bind referral code (if not already referred) */}
                      {!perpReferrer && (
                        <div className="bg-okx-bg-hover rounded-lg p-3">
                          <h4 className="font-medium text-sm mb-2">{t("perpBindCode")}</h4>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={perpBindCode}
                              onChange={(e) => setPerpBindCode(e.target.value)}
                              placeholder={t("perpBindCodePlaceholder")}
                              className="flex-1 bg-okx-bg-primary border border-okx-border-primary rounded-lg px-3 py-2 text-xs font-mono"
                            />
                            <button
                              onClick={() => {
                                if (perpBindCode.trim()) {
                                  bindReferralCode(perpBindCode.trim());
                                  setPerpBindCode("");
                                }
                              }}
                              disabled={!perpBindCode.trim() || isBinding}
                              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                                perpBindCode.trim() && !isBinding
                                  ? "bg-okx-accent text-black hover:opacity-90"
                                  : "bg-okx-bg-hover text-okx-text-tertiary cursor-not-allowed"
                              }`}
                            >
                              {isBinding ? t("perpBinding") : t("perpBind")}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Fee breakdown */}
                      <div className="bg-okx-bg-hover rounded-lg p-3">
                        <h4 className="font-medium text-sm mb-2">{t("perpFeeBreakdown")}</h4>
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("perpTradingFee")}</span>
                            <span>0.05%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("perpLevel1Share")}</span>
                            <span className="text-okx-up">30%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("perpLevel2Share")}</span>
                            <span className="text-okx-up">10%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("perpEffectiveL1")}</span>
                            <span className="text-okx-up">0.015%</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-okx-text-secondary">{t("perpEffectiveL2")}</span>
                            <span className="text-okx-up">0.005%</span>
                          </div>
                        </div>
                      </div>

                      {/* Commission history */}
                      {isPerpReferrer && (
                        <div>
                          <h4 className="font-medium text-sm mb-2">{t("perpCommissionHistory")}</h4>
                          {commissions.length === 0 ? (
                            <div className="text-center py-4 text-okx-text-tertiary text-sm">
                              {t("perpNoCommissions")}
                            </div>
                          ) : (
                            <div className="space-y-1 max-h-48 overflow-y-auto">
                              {commissions.map((c) => (
                                <div
                                  key={c.id}
                                  className="flex items-center justify-between bg-okx-bg-hover rounded-lg p-2"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                        c.level === 1
                                          ? "bg-okx-up/20 text-okx-up"
                                          : "bg-blue-500/20 text-blue-400"
                                      }`}>
                                        L{c.level}
                                      </span>
                                      <span className="font-mono text-[10px] text-okx-text-secondary">
                                        {formatAddress(c.referee)}
                                      </span>
                                    </div>
                                    <div className="text-[10px] text-okx-text-tertiary mt-0.5">
                                      {new Date(c.timestamp).toLocaleString()}
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <div className="text-xs font-bold text-okx-up">
                                      {c.display.commissionAmount}
                                    </div>
                                    <div className="text-[10px] text-okx-text-tertiary">
                                      {c.display.commissionRate}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Perp referrer info */}
                      {perpReferrer && (
                        <div className="bg-okx-bg-hover rounded-lg p-3">
                          <h4 className="font-medium text-sm mb-1">{t("yourReferrerTitle")}</h4>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs">{formatAddress(perpReferrer)}</span>
                            {perpReferralCode && (
                              <span className="text-[10px] text-okx-text-tertiary">
                                ({t("perpYourCode")}: {perpReferralCode})
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Refresh button */}
              <div className="text-center">
                <button
                  onClick={handleRefetchAll}
                  className="text-okx-text-secondary text-xs hover:text-okx-text-primary"
                >
                  {t("refreshData")}
                </button>
              </div>
            </div>

            {/* Right Sidebar - Referral Leaderboard */}
            <div className="lg:col-span-1 order-3 space-y-6">
              <Leaderboard
                title={t("referralLeaderboard")}
                icon="🎯"
                entries={referralLeaderboard}
                isLoading={isLoadingLeaderboard}
                type="referral"
                currentAddress={address}
              />
              {/* Perp Referral Leaderboard */}
              <Leaderboard
                title={t("perpReferralLeaderboard")}
                icon="📊"
                entries={perpReferralLeaderboard}
                isLoading={isLoadingPerpLeaderboard}
                type="referral"
                currentAddress={address}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
