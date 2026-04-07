"use client";

import React, { useState, useMemo, useEffect } from "react";
import { useAppStore, type AppTheme } from "@/lib/stores/appStore";
import { Navbar } from "@/components/layout/Navbar";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/shared/Toast";
import { useAccount, useDisconnect } from "wagmi";
import { locales, localeNames, localeFlags, type Locale, changeLocale, useLocale } from "@/i18n";

type NavKey = "security" | "profile" | "api" | "notifications" | "fees" | "appearance";

// --- SVG Icon Components ---
const IconShield = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
  </svg>
);
const IconUser = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
  </svg>
);
const IconKey = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
  </svg>
);
const IconBell = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
  </svg>
);
const IconCurrency = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);
const IconGlobe = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 003 12c0-1.605.42-3.113 1.157-4.418" />
  </svg>
);
const IconLock = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
  </svg>
);
const IconPen = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
  </svg>
);
const IconClipboard = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
  </svg>
);
const IconDesktop = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
  </svg>
);
const IconPhone = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
  </svg>
);
const IconLink = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
  </svg>
);
const IconMoon = ({ className = "w-6 h-6" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
  </svg>
);
const IconSun = ({ className = "w-6 h-6" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
  </svg>
);
const IconWallet = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 110-6h5.25A2.25 2.25 0 0121 6v6zm0 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18V6a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 6" />
  </svg>
);

// Map nav items to icon components
const navIcons: Record<NavKey, React.ReactNode> = {
  security: <IconShield />,
  profile: <IconUser />,
  api: <IconKey />,
  notifications: <IconBell />,
  fees: <IconCurrency />,
  appearance: <IconGlobe />,
};

export default function SettingsPage() {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const { showToast } = useToast();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const preferences = useAppStore((state) => state.preferences);
  const setSlippageTolerance = useAppStore((state) => state.setSlippageTolerance);
  const setTransactionDeadline = useAppStore((state) => state.setTransactionDeadline);
  const setTheme = useAppStore((state) => state.setTheme);
  const currentLocale = useLocale();

  const navItems = useMemo(() => [
    { key: "security" as NavKey, label: t("navSecurity") },
    { key: "profile" as NavKey, label: t("navProfile") },
    { key: "api" as NavKey, label: t("navApi") },
    { key: "notifications" as NavKey, label: t("navNotifications") },
    { key: "fees" as NavKey, label: t("navFees") },
    { key: "appearance" as NavKey, label: t("navAppearance") },
  ], [t]);

  // User-generated API keys (persisted in localStorage)
  const [apiKeys, setApiKeys] = useState<{ name: string; key: string; permissions: string[]; created: string }[]>([]);

  // Load API keys from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("user_api_keys");
      if (saved) setApiKeys(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  const generateApiKey = () => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const rand = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const newKey = {
      name: `API Key ${apiKeys.length + 1}`,
      key: `pk_live_${rand(32)}`,
      permissions: [t("permRead"), t("permTrade")],
      created: new Date().toISOString().split("T")[0],
    };
    const updated = [...apiKeys, newKey];
    setApiKeys(updated);
    localStorage.setItem("user_api_keys", JSON.stringify(updated));
    showToast(t("apiKeyCreated"), "success");
  };

  const deleteApiKey = (idx: number) => {
    const updated = apiKeys.filter((_, i) => i !== idx);
    setApiKeys(updated);
    localStorage.setItem("user_api_keys", JSON.stringify(updated));
    showToast(t("apiKeyDeleted"), "success");
  };

  const mockSessions = useMemo(() => [
    { device: "Chrome · macOS", location: "Shanghai, CN", timeKey: "current", isCurrent: true },
    { device: "Safari · iOS iPhone", location: "Beijing, CN", timeKey: "2daysAgo", isCurrent: false },
  ], []);

  const [activeNav, setActiveNav] = useState<NavKey>("security");
  const [localSlippage, setLocalSlippage] = useState(preferences.slippageTolerance.toString());
  const [localDeadline, setLocalDeadline] = useState(preferences.transactionDeadline.toString());
  const [whitelistEnabled, setWhitelistEnabled] = useState(false);

  // Notification preferences (persisted in localStorage)
  const [notifTrade, setNotifTrade] = useState(true);
  const [notifPrice, setNotifPrice] = useState(true);
  const [notifLiquidation, setNotifLiquidation] = useState(true);
  const [notifSystem, setNotifSystem] = useState(false);
  const [notifEmail, setNotifEmail] = useState(false);

  // Profile
  const [nickname, setNickname] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Load notification prefs from localStorage
    try {
      const saved = localStorage.getItem("notif_prefs");
      if (saved) {
        const prefs = JSON.parse(saved);
        setNotifTrade(prefs.trade ?? true);
        setNotifPrice(prefs.price ?? true);
        setNotifLiquidation(prefs.liquidation ?? true);
        setNotifSystem(prefs.system ?? false);
        setNotifEmail(prefs.email ?? false);
      }
      const savedNick = localStorage.getItem("user_nickname");
      if (savedNick) setNickname(savedNick);
    } catch { /* ignore */ }
  }, []);

  const saveNotifPrefs = (key: string, val: boolean) => {
    const prefs = { trade: notifTrade, price: notifPrice, liquidation: notifLiquidation, system: notifSystem, email: notifEmail, [key]: val };
    localStorage.setItem("notif_prefs", JSON.stringify(prefs));
    showToast(t("saved"), "success");
  };

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

  // Toggle component
  const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) => (
    <button
      onClick={() => onChange(!enabled)}
      className={`w-11 h-6 rounded-full relative transition-colors ${
        enabled ? "bg-meme-lime" : "bg-okx-bg-hover border border-okx-border-primary"
      }`}
    >
      <div className={`w-5 h-5 rounded-full bg-white absolute top-0.5 transition-all ${enabled ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );

  // Section subtitle per tab
  const subtitles: Record<NavKey, string> = {
    security: t("securitySubtitle"),
    profile: t("profileSubtitle"),
    api: t("apiSubtitle"),
    notifications: t("notificationsSubtitle"),
    fees: t("feesSubtitle"),
    appearance: t("appearanceSubtitle"),
  };

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      <div className="max-w-[1440px] mx-auto px-4 md:px-8 lg:px-16 py-6 md:py-8">
        <div className="flex flex-col md:flex-row gap-6 md:gap-8">
          {/* Left Sidebar Navigation */}
          <div className="w-full md:w-[220px] md:shrink-0 flex md:flex-col gap-1 overflow-x-auto md:overflow-x-visible pb-2 md:pb-0">
            {navItems.map((item) => (
              <button
                key={item.key}
                onClick={() => setActiveNav(item.key)}
                className={`whitespace-nowrap md:w-full flex items-center gap-3 px-4 py-2.5 md:py-3 rounded-lg text-sm transition-all ${
                  activeNav === item.key
                    ? "bg-meme-lime/10 text-meme-lime font-bold border border-meme-lime/20"
                    : "text-okx-text-secondary hover:text-okx-text-primary hover:bg-okx-bg-hover"
                }`}
              >
                <span className="text-base">{navIcons[item.key]}</span>
                {item.label}
              </button>
            ))}
          </div>

          {/* Main Content Area */}
          <div className="flex-1 min-w-0 space-y-6">
            <div>
              <h1 className="text-2xl font-bold">
                {navItems.find((n) => n.key === activeNav)?.label}
              </h1>
              <p className="text-sm text-okx-text-tertiary mt-1">
                {subtitles[activeNav]}
              </p>
            </div>

            {/* SECURITY TAB */}
            {activeNav === "security" && (
              <>
                {/* Wallet Connection Card */}
                <div className="meme-card p-6 space-y-5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold">{t("walletConnection")}</h3>
                    <span className={`meme-badge ${isConnected ? "meme-badge-success" : "meme-badge-danger"}`}>
                      {isConnected ? t("connected") : t("notConnected")}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-orange-500/15 flex items-center justify-center">
                        <IconWallet className="w-5 h-5 text-orange-400" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">MetaMask</div>
                        <div className="text-xs text-okx-text-tertiary font-mono">
                          {isConnected && address ? formatAddress(address) : t("notConnected")} · BSC Testnet
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => { disconnect(); showToast(t("walletDisconnected"), "success"); }}
                      className="px-4 py-2 rounded-lg text-sm border border-okx-border-secondary text-okx-text-secondary hover:text-okx-down hover:border-okx-down/50 transition-colors"
                    >
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

                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center">
                        <IconLock className="w-4 h-4 text-okx-text-secondary" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{t("tradingPassword")}</div>
                        <div className="text-xs text-okx-text-tertiary">{t("tradingPasswordDesc")}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="meme-badge meme-badge-warning">{t("notSet")}</span>
                      <button
                        onClick={() => showToast(t("featureComingSoon"), "info")}
                        className="px-3 py-1.5 rounded-lg text-xs bg-okx-bg-hover border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary transition-colors"
                      >
                        {t("setup")}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center">
                        <IconPen className="w-4 h-4 text-okx-text-secondary" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{t("signatureVerification")}</div>
                        <div className="text-xs text-okx-text-tertiary">{t("signatureVerificationDesc")}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="meme-badge meme-badge-success">{t("enabled")}</span>
                      <button
                        onClick={() => showToast(t("featureComingSoon"), "info")}
                        className="px-3 py-1.5 rounded-lg text-xs bg-okx-bg-hover border border-okx-border-primary text-okx-text-secondary hover:text-okx-text-primary transition-colors"
                      >
                        {t("configure")}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center">
                        <IconClipboard className="w-4 h-4 text-okx-text-secondary" />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{t("withdrawWhitelist")}</div>
                        <div className="text-xs text-okx-text-tertiary">{t("withdrawWhitelistDesc")}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`meme-badge ${whitelistEnabled ? "meme-badge-success" : "meme-badge-danger"}`}>
                        {whitelistEnabled ? t("enabled") : t("disabled")}
                      </span>
                      <Toggle enabled={whitelistEnabled} onChange={setWhitelistEnabled} />
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
                    <button
                      onClick={generateApiKey}
                      className="px-4 py-2 rounded-lg text-xs font-bold bg-meme-lime text-black hover:opacity-90 transition-opacity"
                    >
                      + {t("createApiKey")}
                    </button>
                  </div>

                  {apiKeys.length === 0 ? (
                    <div className="flex flex-col items-center justify-center px-6 py-10 text-okx-text-tertiary">
                      <IconKey className="w-8 h-8 mb-3 opacity-40" />
                      <p className="text-sm">{t("noApiKeys")}</p>
                      <p className="text-xs mt-1 mb-4">{t("noApiKeysDesc")}</p>
                      <button
                        onClick={generateApiKey}
                        className="px-5 py-2 rounded-lg text-xs font-bold bg-meme-lime text-black hover:opacity-90 transition-opacity"
                      >
                        + {t("createApiKey")}
                      </button>
                    </div>
                  ) : (
                    apiKeys.map((api, idx) => (
                      <div key={idx} className={`flex items-center justify-between px-6 py-4 ${idx < apiKeys.length - 1 ? "border-b border-okx-border-primary" : ""}`}>
                        <div>
                          <div className="text-sm font-medium">{api.name}</div>
                          <div className="text-xs text-okx-text-tertiary font-mono">{api.key}</div>
                        </div>
                        <div className="flex items-center gap-3">
                          {api.permissions.map((perm) => (
                            <span key={perm} className="meme-badge meme-badge-lime">{perm}</span>
                          ))}
                          <button onClick={() => deleteApiKey(idx)} className="text-xs text-okx-down hover:opacity-80">{t("delete")}</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Login Activity */}
                <div className="meme-card overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div>
                      <h3 className="font-bold">{t("loginActivity")}</h3>
                      <p className="text-xs text-okx-text-tertiary mt-1">{t("loginActivityDesc")}</p>
                    </div>
                    <button
                      onClick={() => showToast(t("featureComingSoon"), "info")}
                      className="px-4 py-2 rounded-lg text-xs border border-okx-down/30 text-okx-down hover:bg-okx-down/10 transition-colors"
                    >
                      {t("logoutOthers")}
                    </button>
                  </div>

                  {mockSessions.map((session, idx) => (
                    <div key={idx} className={`flex items-center justify-between px-6 py-3.5 ${idx < mockSessions.length - 1 ? "border-b border-okx-border-primary" : ""}`}>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center">
                          {idx === 0 ? <IconDesktop className="w-4 h-4 text-okx-text-secondary" /> : <IconPhone className="w-4 h-4 text-okx-text-secondary" />}
                        </div>
                        <div>
                          <div className="text-sm font-medium">{session.device}</div>
                          <div className="text-xs text-okx-text-tertiary">{session.location} · {t(session.timeKey)}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {session.isCurrent && <span className="meme-badge meme-badge-success">{t("currentOnline")}</span>}
                        {!session.isCurrent && (
                          <button onClick={() => showToast(t("featureComingSoon"), "info")} className="text-xs text-okx-down hover:opacity-80">{t("logout")}</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* PROFILE TAB */}
            {activeNav === "profile" && (
              <>
                <div className="meme-card p-6 space-y-6">
                  <h3 className="font-bold">{t("basicInfo")}</h3>

                  {/* Avatar */}
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-gradient-to-br from-meme-lime/30 to-meme-lime/10 flex items-center justify-center text-2xl border-2 border-meme-lime/20">
                      {isConnected && address ? address.slice(2, 4).toUpperCase() : "?"}
                    </div>
                    <div>
                      <div className="text-sm font-medium">{t("avatar")}</div>
                      <div className="text-xs text-okx-text-tertiary">{t("avatarDesc")}</div>
                    </div>
                  </div>

                  {/* Nickname */}
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("nickname")}</label>
                    <div className="flex gap-3">
                      <input
                        type="text"
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value)}
                        placeholder={t("nicknamePlaceholder")}
                        className="flex-1 meme-input px-4 py-2.5"
                        maxLength={20}
                      />
                      <button
                        onClick={() => {
                          localStorage.setItem("user_nickname", nickname);
                          showToast(t("saved"), "success");
                        }}
                        className="meme-btn-primary px-6 py-2.5"
                      >
                        {t("save")}
                      </button>
                    </div>
                  </div>

                  {/* Wallet Address */}
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("walletAddress")}</label>
                    <div className="flex gap-3">
                      <div className="flex-1 meme-input px-4 py-2.5 text-okx-text-tertiary font-mono text-sm">
                        {isConnected && address ? address : t("notConnected")}
                      </div>
                      {isConnected && address && (
                        <button
                          onClick={() => { navigator.clipboard.writeText(address); showToast(t("copied"), "success"); }}
                          className="px-4 py-2.5 bg-okx-bg-hover border border-okx-border-primary rounded-xl text-sm hover:border-okx-border-hover transition-colors"
                        >
                          {tCommon("copyAddress")}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Chain */}
                  <div>
                    <label className="block text-sm font-medium mb-2">{t("currentChain")}</label>
                    <div className="meme-input px-4 py-2.5 text-sm flex items-center gap-2">
                      <IconLink className="w-4 h-4 text-yellow-500" />
                      BSC Testnet (Chain 97)
                    </div>
                  </div>
                </div>

                {/* Referral */}
                <div className="meme-card p-6 space-y-4">
                  <h3 className="font-bold">{t("referralInfo")}</h3>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 meme-input px-4 py-2.5 text-sm font-mono text-okx-text-tertiary">
                      {isConnected && address ? `REF-${address.slice(2, 8).toUpperCase()}` : "\u2014"}
                    </div>
                    <button
                      onClick={() => {
                        if (address) {
                          navigator.clipboard.writeText(`${window.location.origin}?ref=${address.slice(2, 8)}`);
                          showToast(t("copied"), "success");
                        }
                      }}
                      className="px-4 py-2.5 bg-okx-bg-hover border border-okx-border-primary rounded-xl text-sm hover:border-okx-border-hover transition-colors"
                    >
                      {t("copyLink")}
                    </button>
                  </div>
                  <p className="text-xs text-okx-text-tertiary">{t("referralDesc")}</p>
                </div>
              </>
            )}

            {/* API TAB */}
            {activeNav === "api" && (
              <>
                <div className="meme-card overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div>
                      <h3 className="font-bold">{t("apiKeyManagement")}</h3>
                      <p className="text-xs text-okx-text-tertiary mt-1">{t("apiKeyManagementDesc")}</p>
                    </div>
                    <button
                      onClick={generateApiKey}
                      className="px-4 py-2 rounded-lg text-xs font-bold bg-meme-lime text-black hover:opacity-90 transition-opacity"
                    >
                      + {t("createApiKey")}
                    </button>
                  </div>

                  {apiKeys.length === 0 ? (
                    <div className="flex flex-col items-center justify-center px-6 py-10 text-okx-text-tertiary">
                      <IconKey className="w-8 h-8 mb-3 opacity-40" />
                      <p className="text-sm">{t("noApiKeys")}</p>
                      <p className="text-xs mt-1 mb-4">{t("noApiKeysDesc")}</p>
                      <button
                        onClick={generateApiKey}
                        className="px-5 py-2 rounded-lg text-xs font-bold bg-meme-lime text-black hover:opacity-90 transition-opacity"
                      >
                        + {t("createApiKey")}
                      </button>
                    </div>
                  ) : (
                    apiKeys.map((api, idx) => (
                      <div key={idx} className={`flex items-center justify-between px-6 py-4 ${idx < apiKeys.length - 1 ? "border-b border-okx-border-primary" : ""}`}>
                        <div>
                          <div className="text-sm font-medium flex items-center gap-2">
                            {api.name}
                            <span className="text-xs text-okx-text-tertiary">{t("created")}: {api.created}</span>
                          </div>
                          <div className="text-xs text-okx-text-tertiary font-mono mt-1">{api.key}</div>
                        </div>
                        <div className="flex items-center gap-3">
                          {api.permissions.map((perm) => (
                            <span key={perm} className="meme-badge meme-badge-lime">{perm}</span>
                          ))}
                          <button onClick={() => deleteApiKey(idx)} className="text-xs text-okx-down hover:opacity-80">{t("delete")}</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="meme-card p-6 space-y-4">
                  <h3 className="font-bold">{t("apiDocs")}</h3>
                  <p className="text-sm text-okx-text-tertiary">{t("apiDocsDesc")}</p>
                  <div className="flex gap-3">
                    <div className="flex-1 meme-input px-4 py-3 text-xs font-mono text-okx-text-tertiary">
                      REST API: https://api.dexi.fun/v1
                    </div>
                    <div className="flex-1 meme-input px-4 py-3 text-xs font-mono text-okx-text-tertiary">
                      WebSocket: wss://ws.dexi.fun/v1
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* NOTIFICATIONS TAB */}
            {activeNav === "notifications" && (
              <>
                <div className="meme-card overflow-hidden">
                  <div className="px-6 py-4 border-b border-okx-border-primary">
                    <h3 className="font-bold">{t("tradeNotifications")}</h3>
                    <p className="text-xs text-okx-text-tertiary mt-1">{t("tradeNotificationsDesc")}</p>
                  </div>

                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div>
                      <div className="text-sm font-medium">{t("orderFillNotif")}</div>
                      <div className="text-xs text-okx-text-tertiary">{t("orderFillNotifDesc")}</div>
                    </div>
                    <Toggle enabled={notifTrade} onChange={(v) => { setNotifTrade(v); saveNotifPrefs("trade", v); }} />
                  </div>

                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div>
                      <div className="text-sm font-medium">{t("priceAlertNotif")}</div>
                      <div className="text-xs text-okx-text-tertiary">{t("priceAlertNotifDesc")}</div>
                    </div>
                    <Toggle enabled={notifPrice} onChange={(v) => { setNotifPrice(v); saveNotifPrefs("price", v); }} />
                  </div>

                  <div className="flex items-center justify-between px-6 py-4">
                    <div>
                      <div className="text-sm font-medium">{t("liquidationNotif")}</div>
                      <div className="text-xs text-okx-text-tertiary">{t("liquidationNotifDesc")}</div>
                    </div>
                    <Toggle enabled={notifLiquidation} onChange={(v) => { setNotifLiquidation(v); saveNotifPrefs("liquidation", v); }} />
                  </div>
                </div>

                <div className="meme-card overflow-hidden">
                  <div className="px-6 py-4 border-b border-okx-border-primary">
                    <h3 className="font-bold">{t("otherNotifications")}</h3>
                  </div>

                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div>
                      <div className="text-sm font-medium">{t("systemNotif")}</div>
                      <div className="text-xs text-okx-text-tertiary">{t("systemNotifDesc")}</div>
                    </div>
                    <Toggle enabled={notifSystem} onChange={(v) => { setNotifSystem(v); saveNotifPrefs("system", v); }} />
                  </div>

                  <div className="flex items-center justify-between px-6 py-4">
                    <div>
                      <div className="text-sm font-medium">{t("emailNotif")}</div>
                      <div className="text-xs text-okx-text-tertiary">{t("emailNotifDesc")}</div>
                    </div>
                    <Toggle enabled={notifEmail} onChange={(v) => { setNotifEmail(v); saveNotifPrefs("email", v); }} />
                  </div>
                </div>
              </>
            )}

            {/* FEES TAB */}
            {activeNav === "fees" && (
              <div className="meme-card p-6 space-y-6">
                <h3 className="font-bold">{t("tradeSettings")}</h3>

                <div>
                  <label className="block text-sm font-medium mb-2">{t("slippageTolerance")} (%)</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={localSlippage}
                      onChange={(e) => setLocalSlippage(e.target.value)}
                      className="flex-1 meme-input px-4 py-2"
                      step="0.1" min="0" max="50"
                    />
                    {["0.5", "1", "2"].map((v) => (
                      <button key={v} onClick={() => setLocalSlippage(v)} className="px-4 py-2 bg-okx-bg-hover border border-okx-border-primary rounded-xl text-sm hover:border-okx-border-hover transition-colors">
                        {v}%
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-okx-text-tertiary mt-2">{t("slippageHint")}: {preferences.slippageTolerance}%</p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">{t("transactionDeadline")} ({t("seconds")})</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={localDeadline}
                      onChange={(e) => setLocalDeadline(e.target.value)}
                      className="flex-1 meme-input px-4 py-2"
                      step="60" min="60" max="3600"
                    />
                    {[
                      { label: `10 ${t("minutes")}`, val: "600" },
                      { label: `20 ${t("minutes")}`, val: "1200" },
                      { label: `30 ${t("minutes")}`, val: "1800" },
                    ].map((d) => (
                      <button key={d.val} onClick={() => setLocalDeadline(d.val)} className="px-4 py-2 bg-okx-bg-hover border border-okx-border-primary rounded-xl text-sm hover:border-okx-border-hover transition-colors">
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-3">
                  <button onClick={handleSave} className="meme-btn-primary px-6 py-2.5">{t("save")}</button>
                  <button
                    onClick={() => { setLocalSlippage("1"); setLocalDeadline("1200"); setSlippageTolerance(1); setTransactionDeadline(1200); }}
                    className="px-6 py-2.5 bg-okx-bg-hover border border-okx-border-primary rounded-xl text-sm hover:border-okx-border-hover transition-colors"
                  >
                    {t("reset")}
                  </button>
                </div>
              </div>
            )}

            {/* APPEARANCE TAB */}
            {activeNav === "appearance" && mounted && (
              <>
                <div className="meme-card p-6 space-y-6">
                  <h3 className="font-bold">{t("themeSettings")}</h3>
                  <div className="grid grid-cols-3 gap-4">
                    {(["dark", "light", "system"] as AppTheme[]).map((themeOpt) => (
                      <button
                        key={themeOpt}
                        onClick={() => setTheme(themeOpt)}
                        className={`p-4 rounded-xl border-2 transition-all text-center ${
                          preferences.theme === themeOpt
                            ? "border-meme-lime bg-meme-lime/5"
                            : "border-okx-border-primary hover:border-okx-border-hover"
                        }`}
                      >
                        <div className="flex justify-center mb-2 text-okx-text-secondary">
                          {themeOpt === "dark" ? <IconMoon /> : themeOpt === "light" ? <IconSun /> : <IconDesktop className="w-6 h-6" />}
                        </div>
                        <div className="text-sm font-medium">{t(`theme_${themeOpt}`)}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="meme-card p-6 space-y-6">
                  <h3 className="font-bold">{t("languageSettings")}</h3>
                  <div className="grid grid-cols-2 gap-3">
                    {locales.map((locale) => (
                      <button
                        key={locale}
                        onClick={() => changeLocale(locale as Locale)}
                        className={`flex items-center gap-3 p-4 rounded-xl border-2 transition-all ${
                          currentLocale === locale
                            ? "border-meme-lime bg-meme-lime/5"
                            : "border-okx-border-primary hover:border-okx-border-hover"
                        }`}
                      >
                        <span className="text-2xl">{localeFlags[locale as Locale]}</span>
                        <div className="text-left">
                          <div className="text-sm font-medium">{localeNames[locale as Locale]}</div>
                          <div className="text-xs text-okx-text-tertiary">{locale.toUpperCase()}</div>
                        </div>
                        {currentLocale === locale && (
                          <svg className="w-5 h-5 ml-auto text-meme-lime" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
