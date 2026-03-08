"use client";

import React, { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useTranslations } from "next-intl";
import { Navbar } from "@/components/layout/Navbar";
import { MATCHING_ENGINE_URL } from "@/config/api";

export default function InviteLandingPage() {
  const t = useTranslations("referral");
  const params = useParams();
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inviteCode = params.code as string;

  const handleRegister = async () => {
    if (!isConnected || !address) return;

    setRegistering(true);
    setError(null);

    try {
      // C-1: 真正调用后端 bind API（替换原 TODO stub）
      const res = await fetch(`${MATCHING_ENGINE_URL}/api/referral/bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address,
          referralCode: inviteCode, // C-7: 后端期望 referralCode 而非 code
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server error: ${res.status}`);
      }

      setRegistered(true);

      // Redirect to trading page after 2 seconds
      setTimeout(() => {
        router.push("/");
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("registrationFailed"));
    } finally {
      setRegistering(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#000000] text-white">
      <Navbar />

      <div className="max-w-lg mx-auto px-4 py-16">
        <div className="bg-[#111111] border border-[#1a1a1a] rounded-lg p-8 text-center">
          {/* Welcome Icon */}
          <svg className="w-16 h-16 mb-6 text-meme-lime mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>

          {/* Title */}
          <h1 className="text-2xl font-bold mb-2">{t("welcomeTitle")}</h1>
          <p className="text-[#888888] mb-6">{t("welcomeSubtitle")}</p>

          {/* Benefits */}
          <div className="bg-[#0a0a0a] rounded-lg p-4 mb-6 text-left">
            <h3 className="font-medium mb-3">{t("yourBenefits")}</h3>
            <ul className="space-y-2 text-sm text-[#888888]">
              <li className="flex items-center gap-2">
                <span className="text-[#BFFF00]">✓</span>
                {t("benefit1")}
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[#BFFF00]">✓</span>
                {t("benefit2")}
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[#BFFF00]">✓</span>
                {t("benefit3")}
              </li>
            </ul>
          </div>

          {/* Invite Code Display */}
          <div className="mb-6">
            <span className="text-sm text-[#888888]">{t("inviteCode")}</span>
            <div className="font-mono text-lg bg-[#0a0a0a] rounded-lg px-4 py-2 mt-1 text-[#BFFF00]">
              {inviteCode}
            </div>
          </div>

          {/* Action Button */}
          {!isConnected ? (
            <div>
              <p className="text-sm text-[#888888] mb-4">{t("connectToActivate")}</p>
            </div>
          ) : registered ? (
            <div className="p-4 bg-[#BFFF00]/10 border border-[#BFFF00]/30 rounded-lg">
              <div className="text-[#BFFF00] font-bold">{t("registrationSuccess")}</div>
              <p className="text-sm text-[#888888] mt-1">{t("redirecting")}</p>
            </div>
          ) : (
            <button
              onClick={handleRegister}
              disabled={registering}
              className="w-full px-6 py-3 bg-[#BFFF00] text-black font-bold rounded-lg hover:bg-[#d4ff4d] transition-colors disabled:opacity-50"
            >
              {registering ? t("registering") : t("activateAccount")}
            </button>
          )}

          {error && (
            <div className="mt-4 p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Terms */}
          <p className="text-xs text-[#666666] mt-6">{t("termsHint")}</p>
        </div>
      </div>
    </div>
  );
}
