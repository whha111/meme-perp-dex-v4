"use client";

import React, { useState, useMemo } from "react";
import { useAppStore } from "@/lib/stores/appStore";
import { Navbar } from "@/components/layout/Navbar";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/shared/Toast";
import { useAccount } from "wagmi";

type NavKey = "security" | "profile" | "api" | "notifications" | "fees" | "appearance";

export default function SettingsPage() {
  const t = useTranslations("settings");
  const { showToast } = useToast();
  const { address, isConnected } = useAccount();
  const preferences = useAppStore((state) => state.preferences);
  const setSlippageTolerance = useAppStore((state) => state.setSlippageTolerance);
  const setTransactionDeadline = useAppStore((state) => state.setTransactionDeadline);
  const recentInstruments = useAppStore((state) => state.recentInstruments);
  const clearRecentInstruments = () => useAppStore.setState({ recentInstruments: [] });

  const navItems = useMemo(() => [
    { key: "security" as NavKey, icon: "🔒", label: t("navSecurity") },
    { key: "profile" as NavKey, icon: "👤", label: t("navProfile") },
    { key: "api" as NavKey, icon: "🔑", label: t("navApi") },
    { key: "notifications" as NavKey, icon: "🔔", label: t("navNotifications") },
    { key: "fees" as NavKey, icon: "💰", label: t("navFees") },
    { key: "appearance" as NavKey, icon: "🌐", label: t("navAppearance") },
  ], [t]);

  // Mock API keys
  const mockApiKeys = useMemo(() => [
    { name: "Trading Bot v1", key: "pk_live_8x...4f2a", permissions: [t("permRead"), t("permTrade")], created: "2024-01-15" },
    { name: "Portfolio Tracker", key: "pk_live_3m...7c8d", permissions: [t("permReadOnly")], created: "2024-02-20" },
  ], [t]);

  // Mock sessions
  const mockSessions = useMemo(() => [
    { device: "Chrome · macOS", location: "Shanghai, CN", timeKey: "current", isCurrent: true },
    { device: "Safari · iOS iPhone", location: "Beijing, CN", timeKey: "2daysAgo", isCurrent: false },
  ], []);

  const [activeNav, setActiveNav] = useState<NavKey>("security");
  const [localSlippage, setLocalSlippage] = useState(preferences.slippageTolerance.toString());
  const [localDeadline, setLocalDeadline] = useState(preferences.transactionDeadline.toString());
  const [whitelistEnabled, setWhitelistEnabled] = useState(false);

  const handleSave = () => {
    const slippage = parseFloat(localSlippage);
    const deadline = parseInt(localDeadline);

    if (isNaN(slippage) || slippage < 0 || slippage > 50) {
      showToast(t("slippageRange"), "warning");
      return;
    }
    if (isNaN(deadline) || deadline < 60 || deadline > 3600) {
      showToast(t("deadlineRange"), "warning");
      return;
    }

    setSlippageTolerance(slippage);
    setTransactionDeadline(deadline);
    showToast(t("saved"), "success");
  };

  const formatAddress = (addr: string) =>
    addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "";

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      <div className="max-w-[1440px] mx-auto px-8 lg:px-16 py-8">
        <div className="flex gap-8">
          {/* Left Sidebar Navigation */}
          <div className="w-[220px] shrink-0 space-y-1">
            {navItems.map((item) => (
              <button
                key={item.key}
                onClick={() => setActiveNav(item.key)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-all ${
                  activeNav === item.key
                    ? "bg-meme-lime/10 text-meme-lime font-bold border border-meme-lime/20"
                    : "text-okx-text-secondary hover:text-okx-text-primary hover:bg-okx-bg-hover"
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>

          {/* Main Content Area */}
          <div className="flex-1 space-y-6">
            <div>
              <h1 className="text-2xl font-bold">
                {navItems.find((n) => n.key === activeNav)?.label}
              </h1>
              <p className="text-sm text-okx-text-tertiary mt-1">
                {t("securitySubtitle")}
              </p>
            </div>

            {activeNav === "security" && (
              <>
                {/* Wallet Connection Card */}
                <div className="meme-card p-6 space-y-5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold">{t("walletConnection")}</h3>
                    <span className="meme-badge meme-badge-success">{t("connected")}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-orange-500/15 flex items-center justify-center">
                        <span className="text-lg">🦊</span>
                      </div>
                      <div>
                        <div className="text-sm font-medium">MetaMask</div>
                        <div className="text-xs text-okx-text-tertiary font-mono">
                          {isConnected && address ? formatAddress(address) : t("notConnected")} · BSC Testnet
                        </div>
                      </div>
                    </div>
                    <button className="px-4 py-2 rounded-lg text-sm border border-okx-border-secondary text-okx-text-secondary hover:text-okx-text-primary hover:border-okx-border-hover transition-colors">
                      {t("disconnect")}
                    </button>
                  </div>
                </div>

                {/* Security Verification Card */}
                <div className="meme-card overflow-hidden">
                  <div className="px-6 py-4 border-b border-okx-border-primary">
                    <h3 className="font-bold">{t("securityVerification")}</h3>
                    <p className="text-xs text-okx-text-tertiary mt-1">{t("securityVerificationDesc")}</p>
                  </div>

                  {/* Row: Trading Password */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-sm">🔐</div>
                      <div>
                        <div className="text-sm font-medium">{t("tradingPassword")}</div>
                        <div className="text-xs text-okx-text-tertiary">{t("tradingPasswordDesc")}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="meme-badge meme-badge-warning">{t("notSet")}</span>
                      <button className="px-3 py-1.5 rounded-lg text-xs bg-okx-bg-hover border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary transition-colors">
                        {t("setup")}
                      </button>
                    </div>
                  </div>

                  {/* Row: EIP-712 Signature */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-sm">✍️</div>
                      <div>
                        <div className="text-sm font-medium">{t("signatureVerification")}</div>
                        <div className="text-xs text-okx-text-tertiary">{t("signatureVerificationDesc")}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="meme-badge meme-badge-success">{t("enabled")}</span>
                      <button className="px-3 py-1.5 rounded-lg text-xs bg-okx-bg-hover border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary transition-colors">
                        {t("configure")}
                      </button>
                    </div>
                  </div>

                  {/* Row: Withdrawal Whitelist */}
                  <div className="flex items-center justify-between px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-sm">📋</div>
                      <div>
                        <div className="text-sm font-medium">{t("withdrawWhitelist")}</div>
                        <div className="text-xs text-okx-text-tertiary">{t("withdrawWhitelistDesc")}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`meme-badge ${whitelistEnabled ? "meme-badge-success" : "meme-badge-danger"}`}>
                        {whitelistEnabled ? t("enabled") : t("disabled")}
                      </span>
                      <button
                        onClick={() => setWhitelistEnabled(!whitelistEnabled)}
                        className={`w-11 h-6 rounded-full relative transition-colors ${
                          whitelistEnabled ? "bg-meme-lime" : "bg-okx-bg-hover border border-okx-border-primary"
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-full bg-white absolute top-0.5 transition-all ${
                            whitelistEnabled ? "left-[22px]" : "left-0.5"
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                </div>

                {/* API Key Management */}
                <div className="meme-card overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div>
                      <h3 className="font-bold">{t("apiKeyManagement")}</h3>
                      <p className="text-xs text-okx-text-tertiary mt-1">{t("apiKeyManagementDesc")}</p>
                    </div>
                    <button className="px-4 py-2 rounded-lg text-xs font-bold bg-meme-lime text-black hover:opacity-90 transition-opacity">
                      + {t("createApiKey")}
                    </button>
                  </div>

                  {mockApiKeys.map((api, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center justify-between px-6 py-4 ${
                        idx < mockApiKeys.length - 1 ? "border-b border-okx-border-primary" : ""
                      }`}
                    >
                      <div>
                        <div className="text-sm font-medium">{api.name}</div>
                        <div className="text-xs text-okx-text-tertiary font-mono">{api.key}</div>
                      </div>
                      <div className="flex items-center gap-3">
                        {api.permissions.map((perm) => (
                          <span key={perm} className="meme-badge meme-badge-lime">
                            {perm}
                          </span>
                        ))}
                        <button className="text-xs text-okx-down hover:opacity-80">{t("delete")}</button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Login Activity */}
                <div className="meme-card overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div>
                      <h3 className="font-bold">{t("loginActivity")}</h3>
                      <p className="text-xs text-okx-text-tertiary mt-1">{t("loginActivityDesc")}</p>
                    </div>
                    <button className="px-4 py-2 rounded-lg text-xs border border-okx-down/30 text-okx-down hover:bg-okx-down/10 transition-colors">
                      {t("logoutOthers")}
                    </button>
                  </div>

                  {mockSessions.map((session, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center justify-between px-6 py-3.5 ${
                        idx < mockSessions.length - 1 ? "border-b border-okx-border-primary" : ""
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-sm">
                          {idx === 0 ? "💻" : "📱"}
                        </div>
                        <div>
                          <div className="text-sm font-medium">{session.device}</div>
                          <div className="text-xs text-okx-text-tertiary">{session.location} · {t(session.timeKey)}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {session.isCurrent && (
                          <span className="meme-badge meme-badge-success">{t("currentOnline")}</span>
                        )}
                        {!session.isCurrent && (
                          <button className="text-xs text-okx-down hover:opacity-80">{t("logout")}</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Trade Settings (fees tab) */}
            {activeNav === "fees" && (
              <div className="meme-card p-6 space-y-6">
                <h3 className="font-bold">{t("tradeSettings")}</h3>

                {/* Slippage */}
                <div>
                  <label className="block text-sm font-medium mb-2">
                    {t("slippageTolerance")} (%)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={localSlippage}
                      onChange={(e) => setLocalSlippage(e.target.value)}
                      className="flex-1 meme-input px-4 py-2"
                      step="0.1"
                      min="0"
                      max="50"
                    />
                    {["0.5", "1", "2"].map((v) => (
                      <button
                        key={v}
                        onClick={() => setLocalSlippage(v)}
                        className="px-4 py-2 bg-okx-bg-hover border border-okx-border-primary rounded-xl text-sm hover:border-okx-border-hover transition-colors"
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-okx-text-tertiary mt-2">
                    {t("slippageHint")}: {preferences.slippageTolerance}%
                  </p>
                </div>

                {/* Deadline */}
                <div>
                  <label className="block text-sm font-medium mb-2">
                    {t("transactionDeadline")} ({t("seconds")})
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={localDeadline}
                      onChange={(e) => setLocalDeadline(e.target.value)}
                      className="flex-1 meme-input px-4 py-2"
                      step="60"
                      min="60"
                      max="3600"
                    />
                    {[
                      { label: `10 ${t("minutes")}`, val: "600" },
                      { label: `20 ${t("minutes")}`, val: "1200" },
                      { label: `30 ${t("minutes")}`, val: "1800" },
                    ].map((d) => (
                      <button
                        key={d.val}
                        onClick={() => setLocalDeadline(d.val)}
                        className="px-4 py-2 bg-okx-bg-hover border border-okx-border-primary rounded-xl text-sm hover:border-okx-border-hover transition-colors"
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={handleSave}
                    className="meme-btn-primary px-6 py-2.5"
                  >
                    {t("save")}
                  </button>
                  <button
                    onClick={() => {
                      setLocalSlippage("1");
                      setLocalDeadline("1200");
                      setSlippageTolerance(1);
                      setTransactionDeadline(1200);
                    }}
                    className="px-6 py-2.5 bg-okx-bg-hover border border-okx-border-primary rounded-xl text-sm hover:border-okx-border-hover transition-colors"
                  >
                    {t("reset")}
                  </button>
                </div>
              </div>
            )}

            {/* Placeholder for other tabs */}
            {activeNav !== "security" && activeNav !== "fees" && (
              <div className="meme-card p-12 text-center text-okx-text-tertiary">
                <div className="text-4xl mb-4">🚧</div>
                <p className="text-sm">{t("featureInDev")}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
