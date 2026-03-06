"use client";

import React, { useState } from "react";
import { useAppStore } from "@/lib/stores/appStore";
import { Navbar } from "@/components/layout/Navbar";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/shared/Toast";
import { useAccount } from "wagmi";

// 侧边栏导航项
const NAV_ITEMS = [
  { key: "security", icon: "🔒", label: "安全设置" },
  { key: "profile", icon: "👤", label: "个人资料" },
  { key: "api", icon: "🔑", label: "API 管理" },
  { key: "notifications", icon: "🔔", label: "通知设置" },
  { key: "fees", icon: "💰", label: "费率等级" },
  { key: "appearance", icon: "🌐", label: "语言/外观" },
] as const;

type NavKey = (typeof NAV_ITEMS)[number]["key"];

// 模拟 API 密钥
const MOCK_API_KEYS = [
  { name: "Trading Bot v1", key: "pk_live_8x...4f2a", permissions: ["读取", "交易"], created: "2024-01-15" },
  { name: "Portfolio Tracker", key: "pk_live_3m...7c8d", permissions: ["只读"], created: "2024-02-20" },
];

// 模拟登录活动
const MOCK_SESSIONS = [
  { device: "Chrome · macOS", location: "Shanghai, CN", time: "当前", isCurrent: true },
  { device: "Safari · iOS iPhone", location: "Beijing, CN", time: "2 天前", isCurrent: false },
];

export default function SettingsPage() {
  const t = useTranslations("settings");
  const { showToast } = useToast();
  const { address, isConnected } = useAccount();
  const preferences = useAppStore((state) => state.preferences);
  const setSlippageTolerance = useAppStore((state) => state.setSlippageTolerance);
  const setTransactionDeadline = useAppStore((state) => state.setTransactionDeadline);
  const recentInstruments = useAppStore((state) => state.recentInstruments);
  const clearRecentInstruments = () => useAppStore.setState({ recentInstruments: [] });

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
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                onClick={() => setActiveNav(item.key)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm transition-all ${
                  activeNav === item.key
                    ? "bg-meme-lime/10 text-meme-lime font-bold border border-meme-lime/20"
                    : "text-okx-text-secondary hover:text-white hover:bg-okx-bg-hover"
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
                {NAV_ITEMS.find((n) => n.key === activeNav)?.label}
              </h1>
              <p className="text-sm text-okx-text-tertiary mt-1">
                管理您的账户安全选项，保护资产安全
              </p>
            </div>

            {activeNav === "security" && (
              <>
                {/* Wallet Connection Card */}
                <div className="meme-card p-6 space-y-5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold">钱包连接</h3>
                    <span className="meme-badge meme-badge-success">已连接</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-[#F5841F]/15 flex items-center justify-center">
                        <span className="text-lg">🦊</span>
                      </div>
                      <div>
                        <div className="text-sm font-medium">MetaMask</div>
                        <div className="text-xs text-okx-text-tertiary font-mono">
                          {isConnected && address ? formatAddress(address) : "未连接"} · BSC Testnet
                        </div>
                      </div>
                    </div>
                    <button className="px-4 py-2 rounded-lg text-sm border border-okx-border-secondary text-okx-text-secondary hover:text-white hover:border-okx-border-hover transition-colors">
                      断开连接
                    </button>
                  </div>
                </div>

                {/* Security Verification Card */}
                <div className="meme-card overflow-hidden">
                  <div className="px-6 py-4 border-b border-okx-border-primary">
                    <h3 className="font-bold">安全验证</h3>
                    <p className="text-xs text-okx-text-tertiary mt-1">配置交易和提款的安全验证方式</p>
                  </div>

                  {/* Row: 交易密码 */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-sm">🔐</div>
                      <div>
                        <div className="text-sm font-medium">交易密码</div>
                        <div className="text-xs text-okx-text-tertiary">大额交易需要验证</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="meme-badge meme-badge-warning">未设置</span>
                      <button className="px-3 py-1.5 rounded-lg text-xs bg-okx-bg-hover border border-okx-border-primary text-okx-text-secondary hover:text-white transition-colors">
                        设置
                      </button>
                    </div>
                  </div>

                  {/* Row: EIP-712 签名 */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-sm">✍️</div>
                      <div>
                        <div className="text-sm font-medium">签名验证 EIP-712</div>
                        <div className="text-xs text-okx-text-tertiary">所有订单需要钱包签名确认</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="meme-badge meme-badge-success">已启用</span>
                      <button className="px-3 py-1.5 rounded-lg text-xs bg-okx-bg-hover border border-okx-border-primary text-okx-text-secondary hover:text-white transition-colors">
                        配置
                      </button>
                    </div>
                  </div>

                  {/* Row: 提款白名单 */}
                  <div className="flex items-center justify-between px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-sm">📋</div>
                      <div>
                        <div className="text-sm font-medium">提款白名单</div>
                        <div className="text-xs text-okx-text-tertiary">仅允许向白名单地址提款</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`meme-badge ${whitelistEnabled ? "meme-badge-success" : "meme-badge-danger"}`}>
                        {whitelistEnabled ? "已启用" : "未启用"}
                      </span>
                      {/* Toggle */}
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
                      <h3 className="font-bold">API 密钥管理</h3>
                      <p className="text-xs text-okx-text-tertiary mt-1">管理程序化交易 API 访问</p>
                    </div>
                    <button className="px-4 py-2 rounded-lg text-xs font-bold bg-meme-lime text-black hover:opacity-90 transition-opacity">
                      + 创建 API Key
                    </button>
                  </div>

                  {MOCK_API_KEYS.map((api, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center justify-between px-6 py-4 ${
                        idx < MOCK_API_KEYS.length - 1 ? "border-b border-okx-border-primary" : ""
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
                        <button className="text-xs text-[#F6465D] hover:opacity-80">删除</button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Login Activity */}
                <div className="meme-card overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-okx-border-primary">
                    <div>
                      <h3 className="font-bold">登录活动</h3>
                      <p className="text-xs text-okx-text-tertiary mt-1">查看和管理登录设备</p>
                    </div>
                    <button className="px-4 py-2 rounded-lg text-xs border border-[#F6465D]/30 text-[#F6465D] hover:bg-[#F6465D]/10 transition-colors">
                      登出其他设备
                    </button>
                  </div>

                  {MOCK_SESSIONS.map((session, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center justify-between px-6 py-3.5 ${
                        idx < MOCK_SESSIONS.length - 1 ? "border-b border-okx-border-primary" : ""
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-okx-bg-hover flex items-center justify-center text-sm">
                          {idx === 0 ? "💻" : "📱"}
                        </div>
                        <div>
                          <div className="text-sm font-medium">{session.device}</div>
                          <div className="text-xs text-okx-text-tertiary">{session.location} · {session.time}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {session.isCurrent && (
                          <span className="meme-badge meme-badge-success">当前在线</span>
                        )}
                        {!session.isCurrent && (
                          <button className="text-xs text-[#F6465D] hover:opacity-80">登出</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Trade Settings (for "费率等级" or other tabs, keep legacy content) */}
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
                <p className="text-sm">此功能正在开发中</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
