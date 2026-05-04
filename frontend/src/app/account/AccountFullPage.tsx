"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { usePerpetualV2 } from "@/hooks/perpetual/usePerpetualV2";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTradingDataStore, type PerpTradeRecord } from "@/lib/stores/tradingDataStore";
import { useETHPrice } from "@/hooks/common/useETHPrice";
import { AssetTrendChart } from "@/components/common/AssetTrendChart";
import { BnbIcon } from "@/components/common/BnbIcon";
import { getOrderHistory, getTradeHistory, type HistoricalOrder } from "@/utils/orderSigning";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { PositionRow } from "@/components/common/PositionRow";

// Bill record from matching engine /api/user/:trader/bills
interface BillRecord {
  id: string;
  txHash: string | null;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  onChainStatus: string;
  proofData: string;
  positionId?: string;
  orderId?: string;
  createdAt: number;
}

// ERC20 balanceOf ABI fragment
const erc20BalanceOfAbi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// OKX-style tab definitions
type AccountTab = "overview" | "trading" | "spot" | "history";
type HistorySubTab = "trades" | "orders" | "bills" | "funding";

export default function AccountPage() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const t = useTranslations("account");
  const [activeTab, setActiveTab] = useState<AccountTab>("overview");
  const [showChart, setShowChart] = useState(false);
  const [todayChange, setTodayChange] = useState({ amount: 0, percent: 0 });

  const { data: walletBalance } = useBalance({ address });
  const { positions, hasPosition, balance } = usePerpetualV2();
  const tokens = useTradingDataStore((state) => state.allTokens);
  const { price: bnbPriceUsd } = useETHPrice();

  // History tab state
  const [historySubTab, setHistorySubTab] = useState<HistorySubTab>("trades");
  const [tradeHistory, setTradeHistory] = useState<PerpTradeRecord[]>([]);
  const [orderHistory, setOrderHistory] = useState<HistoricalOrder[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [bills, setBills] = useState<BillRecord[]>([]);
  const [fundingBills, setFundingBills] = useState<BillRecord[]>([]);

  const availableBalance = balance?.available || 0n;
  const lockedMargin = balance?.locked || 0n;
  const vaultBalance = availableBalance + lockedMargin;

  const unrealizedPnL = useMemo(() => {
    return positions.reduce((sum, pos) => {
      return sum + BigInt(pos.unrealizedPnL || "0");
    }, 0n);
  }, [positions]);

  // Batch fetch ERC20 balanceOf for all tokens (multicall)
  const tokenContracts = useMemo(() => {
    if (!address || tokens.length === 0) return [];
    return tokens.slice(0, 10).map((token) => ({
      address: token.address as `0x${string}`,
      abi: erc20BalanceOfAbi,
      functionName: "balanceOf" as const,
      args: [address] as const,
    }));
  }, [address, tokens]);

  const { data: tokenBalancesRaw } = useReadContracts({
    contracts: tokenContracts,
    query: { enabled: tokenContracts.length > 0 },
  });

  const tokenBalances = useMemo(() => {
    const map = new Map<string, bigint>();
    if (!tokenBalancesRaw) return map;
    tokens.slice(0, 10).forEach((token, i) => {
      const result = tokenBalancesRaw[i];
      if (result?.status === "success" && result.result) {
        map.set(token.address.toLowerCase(), result.result as bigint);
      }
    });
    return map;
  }, [tokenBalancesRaw, tokens]);

  const userTokens = useMemo(() => {
    return tokens.slice(0, 10).filter((token) => {
      const bal = tokenBalances.get(token.address.toLowerCase());
      return bal && bal > 0n;
    });
  }, [tokens, tokenBalances]);

  const totalSpotValue = useMemo(() => {
    let total = 0;
    for (const token of userTokens) {
      const bal = tokenBalances.get(token.address.toLowerCase()) || 0n;
      const tokenPrice = Number(token.price || "0") / 1e18;
      const balNum = Number(formatUnits(bal, 18));
      total += balNum * tokenPrice;
    }
    return total;
  }, [userTokens, tokenBalances]);

  const totalAssets = vaultBalance + (walletBalance?.value || 0n);

  // IMPORTANT: All hooks must be called before any conditional return
  const totalPortfolioBnb = useMemo(() => {
    return parseFloat(formatUnits(totalAssets, 18)) + totalSpotValue;
  }, [totalAssets, totalSpotValue]);

  const handleChangeData = useCallback((data: { amount: number; percent: number }) => {
    setTodayChange(data);
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Fetch history data when History tab is active
  // Derive trading wallet address from positions (the trader field), fall back to connected wallet
  const tradingWalletAddr = useMemo(() => {
    const posWithTrader = positions.find(p => p.trader);
    return posWithTrader?.trader || null;
  }, [positions]);

  // Token address to symbol lookup (must be before conditional return)
  const tokenSymbolMap = useMemo(() => {
    const map = new Map<string, string>();
    tokens.forEach(tk => map.set(tk.address.toLowerCase(), tk.symbol || tk.address.slice(0, 8)));
    return map;
  }, [tokens]);

  useEffect(() => {
    if (activeTab !== "history") return;
    const trader = tradingWalletAddr || address;
    if (!trader) return;
    setIsLoadingHistory(true);
    Promise.all([
      getTradeHistory(trader as `0x${string}`),
      getOrderHistory(trader as `0x${string}`),
      // P2-1: Fetch bills from matching engine
      fetch(`${MATCHING_ENGINE_URL}/api/user/${trader}/bills?limit=100`)
        .then(r => r.ok ? r.json() : []).catch(() => []),
      // P2-3: Fetch funding fee bills
      fetch(`${MATCHING_ENGINE_URL}/api/user/${trader}/bills?type=FUNDING_FEE&limit=100`)
        .then(r => r.ok ? r.json() : []).catch(() => []),
    ])
      .then(([trades, orders, allBills, fundingOnly]) => {
        setTradeHistory(trades);
        setOrderHistory(orders);
        setBills(allBills as BillRecord[]);
        setFundingBills(fundingOnly as BillRecord[]);
      })
      .catch(() => {})
      .finally(() => setIsLoadingHistory(false));
  }, [activeTab, tradingWalletAddr, address]);

  if (!mounted) {
    return (
      <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-8 h-8 border-4 border-dexi-accent border-t-transparent rounded-full animate-spin" />
        </div>
      </main>
    );
  }

  const formatBal = (val: bigint | string | null | undefined) => {
    if (!val) return "0.0000";
    const v = typeof val === "string" ? BigInt(val) : val;
    return parseFloat(formatUnits(v, 18)).toFixed(4);
  };

  const totalUsd = parseFloat(formatUnits(totalAssets, 18)) * bnbPriceUsd;
  const vaultUsd = parseFloat(formatUnits(vaultBalance, 18)) * bnbPriceUsd;
  const spotUsd = totalSpotValue * bnbPriceUsd;
  const totalCombinedUsd = vaultUsd + spotUsd;

  // Distribution percentages
  const tradingPct = totalCombinedUsd > 0 ? (vaultUsd / totalCombinedUsd * 100) : 0;
  const spotPct = totalCombinedUsd > 0 ? (spotUsd / totalCombinedUsd * 100) : 0;

  const tabs: { key: AccountTab; label: string }[] = [
    { key: "overview", label: t("tabOverview") },
    { key: "trading", label: t("tabTrading") },
    { key: "spot", label: t("tabSpot") },
    { key: "history", label: t("tabHistory") || "History" },
  ];

  return (
    <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      {!isConnected ? (
        <div className="dexi-terminal-shell">
          <section className="dexi-terminal-bar">
            <span className="text-sm font-semibold text-okx-text-primary">Account</span>
            <span className="dexi-chip">Portfolio</span>
            <span className="dexi-chip">Trading wallet</span>
            <span className="dexi-chip">BSC Mainnet</span>
            <span className="ml-auto hidden text-xs text-okx-text-tertiary md:inline">Read-only until wallet is connected</span>
          </section>

          <section className="dexi-terminal-grid min-h-[calc(100vh-91px)] grid-cols-1 xl:grid-cols-[250px_minmax(0,1fr)_360px]">
            <aside className="dexi-terminal-panel">
              <div className="dexi-terminal-titlebar">
                <div>
                  <div className="text-sm font-semibold text-okx-text-primary">Account Modules</div>
                  <div className="text-xs text-okx-text-tertiary">Margin, orders, ledger</div>
                </div>
              </div>
              {[
                ["Overview", "Equity and available balance"],
                ["Positions", "Open meme perp exposure"],
                ["Orders", "Working and historical orders"],
                ["Ledger", "Deposits, withdrawals, funding"],
              ].map(([label, copy]) => (
                <div key={label} className="dexi-terminal-row items-start">
                  <span>
                    <span className="block text-sm font-semibold text-okx-text-primary">{label}</span>
                    <span className="mt-1 block text-xs text-okx-text-tertiary">{copy}</span>
                  </span>
                  <span className="font-mono text-xs text-okx-text-tertiary">--</span>
                </div>
              ))}
            </aside>

            <main className="dexi-terminal-panel overflow-hidden">
              <div className="dexi-terminal-titlebar">
                <div>
                  <div className="text-lg font-semibold text-okx-text-primary">Portfolio Overview</div>
                  <div className="text-xs text-okx-text-tertiary">Balances, margin, positions and account ledger</div>
                </div>
                <span className="dexi-mini-badge">Disconnected</span>
              </div>

              <div className="grid grid-cols-2 gap-px bg-okx-border-primary lg:grid-cols-4">
                {[
                  ["Equity", "--"],
                  ["Available margin", "--"],
                  ["Open positions", "0"],
                  ["Pending orders", "0"],
                ].map(([label, value]) => (
                  <div key={label} className="bg-okx-bg-card p-4">
                    <div className="dexi-terminal-label">{label}</div>
                    <div className="mt-2 dexi-terminal-value text-lg">{value}</div>
                  </div>
                ))}
              </div>

              <div className="grid min-h-[240px] gap-px bg-okx-border-primary lg:grid-cols-[minmax(0,1fr)_300px]">
                <section className="bg-okx-bg-card">
                  <div className="dexi-terminal-titlebar">
                    <div className="text-sm font-semibold text-okx-text-primary">Assets</div>
                    <span className="text-xs text-okx-text-tertiary">Wallet / Trading / Locked</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="dexi-table min-w-[720px]">
                      <thead>
                        <tr>
                          <th>Asset</th>
                          <th className="text-right">Wallet</th>
                          <th className="text-right">Trading</th>
                          <th className="text-right">Locked</th>
                          <th className="text-right">USD value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {["BNB", "USDT", "Meme collateral", "Unrealized PnL"].map((asset) => (
                          <tr key={asset}>
                            <td className="font-semibold text-okx-text-primary">{asset}</td>
                            <td className="text-right font-mono">--</td>
                            <td className="text-right font-mono">--</td>
                            <td className="text-right font-mono">--</td>
                            <td className="text-right font-mono">--</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="bg-okx-bg-card">
                  <div className="dexi-terminal-titlebar">
                    <div className="text-sm font-semibold text-okx-text-primary">Risk State</div>
                  </div>
                  {[
                    ["Custody", "SettlementV2"],
                    ["Collateral", "BNB / USDT"],
                    ["Withdrawal", "Proof required"],
                    ["Liquidation", "Engine monitored"],
                  ].map(([label, value]) => (
                    <div key={label} className="dexi-terminal-row">
                      <span className="text-xs text-okx-text-tertiary">{label}</span>
                      <span className="font-mono text-xs text-okx-text-primary">{value}</span>
                    </div>
                  ))}
                </section>
              </div>

              <div className="bg-okx-bg-card">
                <div className="dexi-terminal-titlebar">
                  <div className="text-sm font-semibold text-okx-text-primary">Recent Activity</div>
                  <span className="text-xs text-okx-text-tertiary">No wallet connected</span>
                </div>
                <div className="grid grid-cols-5 border-b border-okx-border-primary px-4 py-2 text-xs text-okx-text-tertiary">
                  <span>Time</span>
                  <span>Type</span>
                  <span>Market</span>
                  <span className="text-right">Amount</span>
                  <span className="text-right">Status</span>
                </div>
                <div className="px-4 py-8 text-center text-xs text-okx-text-tertiary">Connect wallet to load account activity.</div>
              </div>
            </main>

            <aside className="dexi-terminal-panel">
              <div className="dexi-terminal-titlebar">
                <div>
                  <div className="text-sm font-semibold text-okx-text-primary">{t("connectWallet")}</div>
                  <div className="text-xs text-okx-text-tertiary">Unlock account data</div>
                </div>
                <span className="h-2 w-2 rounded-full bg-okx-warning" />
              </div>
              <div className="p-4">
                <p className="text-sm leading-6 text-okx-text-secondary">{t("connectWalletHint")}</p>
                <button
                  onClick={() => openConnectModal?.()}
                  className="mt-5 w-full rounded-[4px] bg-dexi-accent px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-dexi-accent-strong"
                >
                  {t("connectWallet")}
                </button>
              </div>
              {[
                ["Network", "BSC Mainnet"],
                ["Custody", "SettlementV2"],
                ["Collateral", "BNB / USDT"],
              ].map(([label, value]) => (
                <div key={label} className="dexi-terminal-row">
                  <span className="text-xs text-okx-text-tertiary">{label}</span>
                  <span className="font-mono text-xs text-okx-text-primary">{value}</span>
                </div>
              ))}
            </aside>
          </section>
        </div>
      ) : (
        <div className="max-w-[1400px] mx-auto">
          {/* Account tab navigation */}
          <div className="border-b border-okx-border-primary px-6">
            <div className="flex items-center gap-6">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`relative py-3.5 text-sm font-medium transition-colors ${
                    activeTab === tab.key
                      ? "text-okx-text-primary"
                      : "text-okx-text-tertiary hover:text-okx-text-secondary"
                  }`}
                >
                  {tab.label}
                  {activeTab === tab.key && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-okx-text-primary" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Overview tab */}
          {activeTab === "overview" && (
            <>
              {/* Hero: Two-column */}
              <div className="flex gap-5 px-6 pt-6 pb-4">
                {/* Left: Total value card */}
                <div className="flex-[2] bg-okx-bg-secondary rounded-[6px] p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm text-okx-text-secondary">{t("totalAssetValue")}</span>
                    <svg className="w-4 h-4 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-mono text-[30px] font-semibold leading-none text-okx-text-primary">
                      {totalCombinedUsd < 0.01 && totalCombinedUsd > 0 ? "<0.01" : totalCombinedUsd.toFixed(2)}
                    </span>
                    <span className="text-sm text-okx-text-secondary">USD</span>
                    <svg className="w-3.5 h-3.5 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                  </div>
                  {todayChange.amount !== 0 && (
                    <div className="mb-4">
                      <span className="text-xs text-okx-text-tertiary">{t("todayPnl")} </span>
                      <span className={`text-xs font-mono font-semibold ${todayChange.amount >= 0 ? "text-dexi-accent" : "text-okx-down"}`}>
                        {todayChange.amount >= 0 ? "+" : ""}${Math.abs(todayChange.amount).toFixed(2)} ({todayChange.amount >= 0 ? "+" : ""}{todayChange.percent.toFixed(2)}%)
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-2.5 mb-5">
                    <button onClick={() => router.push("/deposit")} className="rounded-[4px] bg-dexi-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-dexi-accent-strong">{t("deposit")}</button>
                    <button onClick={() => router.push("/deposit?tab=withdraw")} className="rounded-[4px] border border-okx-border-secondary px-5 py-2 text-sm font-medium text-okx-text-primary transition-colors hover:bg-okx-bg-hover">{t("withdraw")}</button>
                  </div>
                  <AssetTrendChart currentValueBnb={totalPortfolioBnb} bnbPriceUsd={bnbPriceUsd} walletAddress={address || ""} compact height={56} onChangeData={handleChangeData} />
                  <div className="flex justify-center mt-3">
                    <button onClick={() => setShowChart(!showChart)} className="text-okx-text-tertiary hover:text-okx-text-secondary transition-colors">
                      <svg className={`w-5 h-5 transition-transform ${showChart ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                    </button>
                  </div>
                  {showChart && (
                    <div className="mt-4 pt-4 border-t border-okx-border-primary">
                      <AssetTrendChart currentValueBnb={totalPortfolioBnb} bnbPriceUsd={bnbPriceUsd} walletAddress={address || ""} height={200} />
                    </div>
                  )}
                </div>

                {/* Right: Distribution */}
                <div className="flex-[1] bg-okx-bg-secondary rounded-[6px] p-6">
                  <div className="flex items-center justify-between mb-5">
                    <span className="text-sm font-semibold text-okx-text-primary">{t("distribution")}</span>
                  </div>
                  <div className="flex w-full h-2 rounded-full overflow-hidden mb-6 bg-okx-bg-primary">
                    {tradingPct > 0 && <div className="h-full bg-[#7B61FF]" style={{ width: `${Math.max(tradingPct, 2)}%` }} />}
                    {spotPct > 0 && <div className="h-full bg-[#F0B90B]" style={{ width: `${Math.max(spotPct, 2)}%` }} />}
                    {tradingPct === 0 && spotPct === 0 && <div className="h-full w-full bg-okx-bg-hover" />}
                  </div>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between cursor-pointer group" onClick={() => setActiveTab("trading")}>
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-[#7B61FF]" />
                        <span className="text-sm text-okx-text-primary group-hover:text-dexi-accent transition-colors">{t("tabTrading")}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <div className="font-mono text-sm text-okx-text-primary">${vaultUsd < 0.01 && vaultUsd > 0 ? "<0.01" : vaultUsd.toFixed(2)}</div>
                          <div className="text-xs text-okx-text-tertiary">{tradingPct.toFixed(2)}%</div>
                        </div>
                        <svg className="w-4 h-4 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                      </div>
                    </div>
                    <div className="flex items-center justify-between cursor-pointer group" onClick={() => setActiveTab("spot")}>
                      <div className="flex items-center gap-2.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-[#F0B90B]" />
                        <span className="text-sm text-okx-text-primary group-hover:text-dexi-accent transition-colors">{t("tabSpot")}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-right">
                          <div className="font-mono text-sm text-okx-text-primary">${spotUsd < 0.01 && spotUsd > 0 ? "<0.01" : spotUsd.toFixed(2)}</div>
                          <div className="text-xs text-okx-text-tertiary">{spotPct.toFixed(2)}%</div>
                        </div>
                        <svg className="w-4 h-4 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="h-px bg-okx-border-primary mx-6" />

              {/* All assets table */}
              <div className="px-6 py-6">
                <h2 className="text-lg font-semibold text-okx-text-primary mb-5">{t("assets")}</h2>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex w-[280px] items-center gap-2 rounded-[6px] bg-okx-bg-secondary px-3 py-2">
                    <svg className="w-4 h-4 text-okx-text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
                    <span className="text-sm text-okx-text-tertiary">{t("search")}</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" className="w-3.5 h-3.5 rounded border-okx-border-primary accent-[#44E3C7]" />
                    <span className="text-xs text-okx-text-secondary">{t("hideSmall")}</span>
                  </label>
                </div>
                <div>
                  <div className="grid grid-cols-4 gap-4 py-2.5 border-b border-okx-border-primary">
                    <span className="text-xs text-okx-text-tertiary">{t("assetName")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("holdingAmount")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("assetValue")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("assetRatio")}</span>
                  </div>
                  {/* BNB row */}
                  <div className="grid grid-cols-4 gap-4 py-4 border-b border-okx-border-primary hover:bg-okx-bg-hover transition-colors">
                    <div className="flex items-center gap-3">
                      <BnbIcon size={32} className="flex-shrink-0" />
                      <div className="flex flex-col"><span className="text-sm font-semibold text-okx-text-primary">BNB</span><span className="text-[11px] text-okx-text-tertiary">BNB</span></div>
                    </div>
                    <div className="text-right self-center"><div className="font-mono text-sm text-okx-text-primary">{formatBal(totalAssets)}</div><div className="font-mono text-[11px] text-okx-text-tertiary">${totalUsd < 0.01 && totalUsd > 0 ? "<0.01" : totalUsd.toFixed(2)}</div></div>
                    <div className="font-mono text-sm text-okx-text-primary text-right self-center">${totalUsd < 0.01 && totalUsd > 0 ? "<0.01" : totalUsd.toFixed(2)}</div>
                    <div className="text-right self-center">
                      <div className="font-mono text-sm text-okx-text-primary">{totalCombinedUsd > 0 ? `${tradingPct.toFixed(2)}%` : "--"}</div>
                      <div className="w-16 h-1 rounded-full bg-okx-bg-hover ml-auto mt-1"><div className="h-full rounded-full bg-[#7B61FF]" style={{ width: `${tradingPct}%` }} /></div>
                    </div>
                  </div>
                  {/* Token rows */}
                  {userTokens.map((token) => {
                    const AVATAR_COLORS = ["#FF6B35", "#4CAF50", "#E91E63", "#9C27B0", "#06B6D4", "#F59E0B"];
                    let hash = 0; for (let i = 0; i < token.address.length; i++) hash = ((hash << 5) - hash) + token.address.charCodeAt(i);
                    const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
                    const userBal = tokenBalances.get(token.address.toLowerCase()) || 0n;
                    const userBalNum = Number(formatUnits(userBal, 18));
                    const tokenPrice = Number(token.price || "0") / 1e18;
                    const valueInBnb = userBalNum * tokenPrice;
                    const valueInUsd = valueInBnb * bnbPriceUsd;
                    const ratio = totalCombinedUsd > 0 ? (valueInUsd / totalCombinedUsd * 100) : 0;
                    return (
                      <div key={token.address} className="grid grid-cols-4 gap-4 py-4 border-b border-okx-border-primary hover:bg-okx-bg-hover transition-colors cursor-pointer" onClick={() => router.push(`/exchange?symbol=${token.address}`)}>
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ backgroundColor: color }}>{token.symbol?.charAt(0)?.toUpperCase() || "?"}</div>
                          <div className="flex flex-col"><span className="text-sm font-semibold text-okx-text-primary">{token.symbol}</span><span className="text-[11px] text-okx-text-tertiary truncate max-w-[120px]">{token.name}</span></div>
                        </div>
                        <div className="text-right self-center"><div className="font-mono text-sm text-okx-text-primary">{userBalNum > 0 ? userBalNum.toFixed(4) : "<0.0001"}</div><div className="font-mono text-[11px] text-okx-text-tertiary">${valueInUsd < 0.01 && valueInUsd > 0 ? "<0.01" : valueInUsd.toFixed(2)}</div></div>
                        <div className="font-mono text-sm text-okx-text-primary text-right self-center">${valueInUsd < 0.01 && valueInUsd > 0 ? "<0.01" : valueInUsd.toFixed(2)}</div>
                        <div className="text-right self-center">
                          <div className="font-mono text-sm text-okx-text-primary">{ratio > 0 ? `${ratio.toFixed(2)}%` : "--"}</div>
                          <div className="w-16 h-1 rounded-full bg-okx-bg-hover ml-auto mt-1"><div className="h-full rounded-full bg-[#F0B90B]" style={{ width: `${Math.min(ratio, 100)}%` }} /></div>
                        </div>
                      </div>
                    );
                  })}
                  {userTokens.length === 0 && totalAssets === 0n && (
                    <div className="py-14 text-center text-okx-text-tertiary text-sm">{t("noSpotHoldings")}</div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Trading tab */}
          {activeTab === "trading" && (
            <>
              {/* Hero: Two-column */}
              <div className="flex gap-5 px-6 pt-6 pb-4">
                <div className="flex-[2] bg-okx-bg-secondary rounded-[6px] p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm text-okx-text-secondary">{t("totalAssetValue")}</span>
                  </div>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-mono text-[30px] font-semibold leading-none text-okx-text-primary">
                      {vaultUsd < 0.01 && vaultUsd > 0 ? "<0.01" : vaultUsd.toFixed(2)}
                    </span>
                    <span className="text-sm text-okx-text-secondary">USD</span>
                  </div>
                  <div className="flex items-center gap-2.5 mt-5">
                    <button onClick={() => router.push("/perp")} className="rounded-[4px] bg-dexi-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-dexi-accent-strong">{t("tradeBtnLabel")}</button>
                    <button onClick={() => router.push("/deposit")} className="rounded-[4px] border border-okx-border-secondary px-5 py-2 text-sm font-medium text-okx-text-primary transition-colors hover:bg-okx-bg-hover">{t("deposit")}</button>
                    <button onClick={() => router.push("/deposit?tab=withdraw")} className="rounded-[4px] border border-okx-border-secondary px-5 py-2 text-sm font-medium text-okx-text-primary transition-colors hover:bg-okx-bg-hover">{t("withdraw")}</button>
                  </div>
                </div>
                {/* Right: Recent trades */}
                <div className="flex-[1] bg-okx-bg-secondary rounded-[6px] p-6">
                  <div className="flex items-center justify-between mb-5">
                    <span className="text-sm font-semibold text-okx-text-primary">{t("recentTrades")}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center py-8 text-okx-text-tertiary">
                    <svg className="w-12 h-12 mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="text-sm">{t("noTransactions")}</span>
                    <span className="text-xs mt-1">{t("startTrading")}</span>
                  </div>
                </div>
              </div>

              <div className="h-px bg-okx-border-primary mx-6" />

              {/* Positions + Balance table */}
              <div className="px-6 py-6">
                <h2 className="text-lg font-semibold text-okx-text-primary mb-5">{t("assets")}</h2>
                {/* Trading balance cards */}
                <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="rounded-[6px] border border-okx-border-primary bg-okx-bg-secondary px-5 py-4">
                    <div className="text-xs text-okx-text-tertiary mb-2">{t("availableBalance")}</div>
                    <div className="font-mono text-base font-semibold text-okx-text-primary">{formatBal(availableBalance)} <span className="text-xs text-okx-text-tertiary font-normal">BNB</span></div>
                    <div className="font-mono text-xs text-okx-text-tertiary mt-1">~${(parseFloat(formatUnits(availableBalance, 18)) * bnbPriceUsd).toFixed(2)}</div>
                  </div>
                  <div className="rounded-[6px] border border-okx-border-primary bg-okx-bg-secondary px-5 py-4">
                    <div className="text-xs text-okx-text-tertiary mb-2">{t("lockedMargin")}</div>
                    <div className="font-mono text-base font-semibold text-okx-text-primary">{formatBal(lockedMargin)} <span className="text-xs text-okx-text-tertiary font-normal">BNB</span></div>
                    <div className="font-mono text-xs text-okx-text-tertiary mt-1">~${(parseFloat(formatUnits(lockedMargin, 18)) * bnbPriceUsd).toFixed(2)}</div>
                  </div>
                  <div className="rounded-[6px] border border-okx-border-primary bg-okx-bg-secondary px-5 py-4">
                    <div className="text-xs text-okx-text-tertiary mb-2">{t("unrealizedPnl")}</div>
                    <div className={`font-mono text-base font-semibold ${unrealizedPnL >= 0n ? "text-dexi-accent" : "text-okx-down"}`}>{unrealizedPnL >= 0n ? "+" : ""}{formatBal(unrealizedPnL)} <span className="text-xs font-normal">BNB</span></div>
                    <div className="font-mono text-xs text-okx-text-tertiary mt-1">~${(Math.abs(parseFloat(formatUnits(unrealizedPnL, 18))) * bnbPriceUsd).toFixed(2)}</div>
                  </div>
                </div>

                {/* Positions table */}
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-semibold text-okx-text-primary">{t("currentPositions")}</h3>
                  <span className="rounded-[4px] bg-dexi-accent-soft px-2.5 py-1 font-mono text-xs text-dexi-accent">{positions.length} {t("activePositions")}</span>
                </div>
                {hasPosition && positions.length > 0 ? (
                  <div>
                    <div className="grid grid-cols-7 gap-2 py-2.5 border-b border-okx-border-primary">
                      <span className="text-xs text-okx-text-tertiary">{t("pair")}</span>
                      <span className="text-xs text-okx-text-tertiary">{t("direction")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("positionSize")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("margin")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("entryPrice")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("liqPrice")}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("unrealizedPnl")}</span>
                    </div>
                    {positions.map((pos) => (
                      <PositionRow
                        key={pos.pairId}
                        position={pos}
                        variant="grid-row"
                        onClick={() => router.push(`/perp?symbol=${pos.token}`)}
                        t={t}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[6px] border border-okx-border-primary bg-okx-bg-secondary p-10 text-center text-sm text-okx-text-tertiary">{t("noPositions")}</div>
                )}
              </div>
            </>
          )}

          {/* Spot tab */}
          {activeTab === "spot" && (
            <>
              {/* Hero */}
              <div className="flex gap-5 px-6 pt-6 pb-4">
                <div className="flex-[2] bg-okx-bg-secondary rounded-[6px] p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm text-okx-text-secondary">{t("totalAssetValue")}</span>
                  </div>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-mono text-[30px] font-semibold leading-none text-okx-text-primary">
                      {spotUsd < 0.01 && spotUsd > 0 ? "<0.01" : spotUsd.toFixed(2)}
                    </span>
                    <span className="text-sm text-okx-text-secondary">USD</span>
                  </div>
                  <div className="flex items-center gap-2.5 mt-5">
                    <button onClick={() => router.push("/exchange")} className="rounded-[4px] bg-dexi-accent px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-dexi-accent-strong">{t("buyTokens")}</button>
                  </div>
                </div>
                {/* Right: Recent records */}
                <div className="flex-[1] bg-okx-bg-secondary rounded-[6px] p-6">
                  <div className="flex items-center justify-between mb-5">
                    <span className="text-sm font-semibold text-okx-text-primary">{t("recentRecords")}</span>
                  </div>
                  <div className="flex flex-col items-center justify-center py-8 text-okx-text-tertiary">
                    <svg className="w-12 h-12 mb-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="text-sm">{t("noTransactions")}</span>
                  </div>
                </div>
              </div>

              <div className="h-px bg-okx-border-primary mx-6" />

              {/* Spot token table */}
              <div className="px-6 py-6">
                <h2 className="text-lg font-semibold text-okx-text-primary mb-5">{t("assets")}</h2>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex w-[280px] items-center gap-2 rounded-[6px] bg-okx-bg-secondary px-3 py-2">
                    <svg className="w-4 h-4 text-okx-text-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
                    <span className="text-sm text-okx-text-tertiary">{t("search")}</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" className="w-3.5 h-3.5 rounded border-okx-border-primary accent-[#44E3C7]" />
                    <span className="text-xs text-okx-text-secondary">{t("hideSmall")}</span>
                  </label>
                </div>
                <div>
                  <div className="grid grid-cols-4 gap-4 py-2.5 border-b border-okx-border-primary">
                    <span className="text-xs text-okx-text-tertiary">{t("assetName")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("holdingAmount")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("assetRatio")}</span>
                    <span className="text-xs text-okx-text-tertiary text-right">{t("change")}</span>
                  </div>
                  {userTokens.length > 0 ? userTokens.map((token) => {
                    const AVATAR_COLORS = ["#FF6B35", "#4CAF50", "#E91E63", "#9C27B0", "#06B6D4", "#F59E0B"];
                    let hash = 0; for (let i = 0; i < token.address.length; i++) hash = ((hash << 5) - hash) + token.address.charCodeAt(i);
                    const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
                    const userBal = tokenBalances.get(token.address.toLowerCase()) || 0n;
                    const userBalNum = Number(formatUnits(userBal, 18));
                    const tokenPrice = Number(token.price || "0") / 1e18;
                    const valueInUsd = userBalNum * tokenPrice * bnbPriceUsd;
                    const change24h = parseFloat(token.priceChangePercent24h || "0");
                    const ratio = spotUsd > 0 ? (valueInUsd / spotUsd * 100) : 0;
                    return (
                      <div key={token.address} className="grid grid-cols-4 gap-4 py-4 border-b border-okx-border-primary hover:bg-okx-bg-hover transition-colors cursor-pointer" onClick={() => router.push(`/exchange?symbol=${token.address}`)}>
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ backgroundColor: color }}>{token.symbol?.charAt(0)?.toUpperCase() || "?"}</div>
                          <div className="flex flex-col"><span className="text-sm font-semibold text-okx-text-primary">{token.symbol}</span><span className="text-[11px] text-okx-text-tertiary truncate max-w-[120px]">{token.name}</span></div>
                        </div>
                        <div className="text-right self-center">
                          <div className="font-mono text-sm text-okx-text-primary">{userBalNum.toFixed(4)}</div>
                          <div className="font-mono text-[11px] text-okx-text-tertiary">${valueInUsd < 0.01 ? "<0.01" : valueInUsd.toFixed(2)}</div>
                        </div>
                        <div className="text-right self-center">
                          <div className="font-mono text-sm text-okx-text-primary">{ratio.toFixed(2)}%</div>
                          <div className="w-16 h-1 rounded-full bg-okx-bg-hover ml-auto mt-1"><div className="h-full rounded-full bg-[#F0B90B]" style={{ width: `${Math.min(ratio, 100)}%` }} /></div>
                        </div>
                        <span className={`font-mono text-sm font-semibold text-right self-center ${change24h >= 0 ? "text-dexi-accent" : "text-okx-down"}`}>
                          {change24h !== 0 ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%` : "--"}
                        </span>
                      </div>
                    );
                  }) : (
                    <div className="py-14 text-center text-okx-text-tertiary text-sm">{t("noSpotHoldings")}</div>
                  )}
                </div>
              </div>
            </>
          )}

          {activeTab === "history" && (
            <div className="px-6 py-6">
              {/* Sub-tab bar */}
              <div className="flex items-center gap-4 mb-6 border-b border-okx-border-primary">
                {([
                  { key: "trades" as const, label: t("tradeHistory") || "Trade History" },
                  { key: "orders" as const, label: t("orderHistory") || "Order History" },
                  { key: "bills" as const, label: "Bills" },
                  { key: "funding" as const, label: "Funding" },
                ]).map((sub) => (
                  <button
                    key={sub.key}
                    onClick={() => setHistorySubTab(sub.key)}
                    className={`relative pb-2.5 text-sm font-medium transition-colors ${
                      historySubTab === sub.key
                        ? "text-okx-text-primary"
                        : "text-okx-text-tertiary hover:text-okx-text-secondary"
                    }`}
                  >
                    {sub.label}
                    {historySubTab === sub.key && (
                      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-okx-text-primary" />
                    )}
                  </button>
                ))}
              </div>

              {isLoadingHistory ? (
                <div className="flex items-center justify-center py-20">
                  <div className="w-6 h-6 border-2 border-dexi-accent border-t-transparent rounded-full animate-spin" />
                </div>
              ) : historySubTab === "trades" ? (
                tradeHistory.length > 0 ? (
                  <div>
                    <div className="grid grid-cols-7 gap-2 py-2.5 border-b border-okx-border-primary">
                      <span className="text-xs text-okx-text-tertiary">{t("time") || "Time"}</span>
                      <span className="text-xs text-okx-text-tertiary">{t("pair") || "Pair"}</span>
                      <span className="text-xs text-okx-text-tertiary">{t("direction") || "Direction"}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("fillPrice") || "Fill Price"}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("positionSize") || "Size"}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("fee") || "Fee"}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("realizedPnl") || "PnL"}</span>
                    </div>
                    {tradeHistory.map((trade) => {
                      const sizeETH = Number(trade.size) / 1e18;
                      const price = Number(trade.price) / 1e18;
                      const fee = Number(trade.fee || "0") / 1e18;
                      const pnl = Number(trade.realizedPnL || "0") / 1e18;
                      const symbol = tokenSymbolMap.get(trade.token.toLowerCase()) || trade.token.slice(0, 8);
                      const time = new Date(trade.timestamp).toLocaleString();
                      return (
                        <div key={trade.id} className="grid grid-cols-7 gap-2 py-3 border-b border-okx-border-primary/50 hover:bg-okx-bg-hover transition-colors text-sm">
                          <span className="text-okx-text-tertiary text-xs self-center">{time}</span>
                          <span className="font-mono text-okx-text-primary self-center">{symbol}/BNB</span>
                          <span className="self-center">
                            <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded ${
                              trade.isLong ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"
                            }`}>
                              {trade.isLong ? t("long") || "Long" : t("short") || "Short"}
                            </span>
                          </span>
                          <span className="font-mono text-okx-text-secondary text-right self-center">
                            {price >= 0.01 ? price.toFixed(6) : price.toFixed(10)}
                          </span>
                          <span className="font-mono text-okx-text-secondary text-right self-center">
                            {sizeETH >= 1 ? sizeETH.toFixed(4) : sizeETH.toFixed(6)} BNB
                          </span>
                          <span className="font-mono text-okx-text-tertiary text-right self-center">
                            {fee > 0 ? fee.toFixed(6) : "\u2014"}
                          </span>
                          <span className={`font-mono font-semibold text-right self-center ${
                            pnl >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}>
                            {pnl !== 0 ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(6)}` : "\u2014"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-20 text-center text-okx-text-tertiary text-sm">
                    <svg className="w-12 h-12 mb-3 opacity-30 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    {t("noTransactions") || "No trade history"}
                  </div>
                )
              ) : historySubTab === "orders" ? (
                orderHistory.length > 0 ? (
                  <div>
                    <div className="grid grid-cols-7 gap-2 py-2.5 border-b border-okx-border-primary">
                      <span className="text-xs text-okx-text-tertiary">{t("time") || "Time"}</span>
                      <span className="text-xs text-okx-text-tertiary">{t("pair") || "Pair"}</span>
                      <span className="text-xs text-okx-text-tertiary">{t("direction") || "Direction"}</span>
                      <span className="text-xs text-okx-text-tertiary">{t("orderType") || "Type"}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("positionSize") || "Size"}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("entryPrice") || "Price"}</span>
                      <span className="text-xs text-okx-text-tertiary text-right">{t("status") || "Status"}</span>
                    </div>
                    {orderHistory.map((order) => {
                      const sizeETH = Number(order.size) / 1e18;
                      const price = Number(order.price) / 1e18;
                      const symbol = tokenSymbolMap.get(order.token.toLowerCase()) || order.token.slice(0, 8);
                      const statusColor = order.closeReason === "filled" ? "text-emerald-400" :
                        order.closeReason === "cancelled" ? "text-okx-text-tertiary" :
                        order.closeReason === "liquidated" ? "text-rose-400" : "text-amber-400";
                      return (
                        <div key={order.id} className="grid grid-cols-7 gap-2 py-3 border-b border-okx-border-primary/50 hover:bg-okx-bg-hover transition-colors text-sm">
                          <span className="text-okx-text-tertiary text-xs self-center">
                            {order.clientOrderId ? new Date(parseInt(order.clientOrderId)).toLocaleString() : "\u2014"}
                          </span>
                          <span className="font-mono text-okx-text-primary self-center">{symbol}/BNB</span>
                          <span className="self-center">
                            <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded ${
                              order.isLong ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"
                            }`}>
                              {order.isLong ? t("long") || "Long" : t("short") || "Short"}
                            </span>
                          </span>
                          <span className="text-okx-text-secondary self-center text-xs">{order.orderType}</span>
                          <span className="font-mono text-okx-text-secondary text-right self-center">
                            {sizeETH >= 1 ? sizeETH.toFixed(4) : sizeETH.toFixed(6)} BNB
                          </span>
                          <span className="font-mono text-okx-text-secondary text-right self-center">
                            {price >= 0.01 ? price.toFixed(6) : price.toFixed(10)}
                          </span>
                          <span className={`text-xs font-medium text-right self-center ${statusColor}`}>
                            {order.closeReason || "\u2014"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-20 text-center text-okx-text-tertiary text-sm">
                    <svg className="w-12 h-12 mb-3 opacity-30 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    {t("noTransactions") || "No order history"}
                  </div>
                )
              ) : historySubTab === "bills" ? (
                /* Bills / ledger table */
                bills.length > 0 ? (
                  <div>
                    <div className="grid grid-cols-6 gap-2 py-2.5 border-b border-okx-border-primary">
                      <span className="text-xs text-okx-text-tertiary">Time</span>
                      <span className="text-xs text-okx-text-tertiary">Type</span>
                      <span className="text-xs text-okx-text-tertiary text-right">Amount</span>
                      <span className="text-xs text-okx-text-tertiary text-right">Before</span>
                      <span className="text-xs text-okx-text-tertiary text-right">After</span>
                      <span className="text-xs text-okx-text-tertiary text-right">Status</span>
                    </div>
                    {bills.map((bill) => {
                      const amt = Number(bill.amount) / 1e18;
                      const before = Number(bill.balanceBefore) / 1e18;
                      const after = Number(bill.balanceAfter) / 1e18;
                      const typeLabel: Record<string, string> = {
                        DEPOSIT: "Deposit", WITHDRAW: "Withdraw",
                        SETTLE_PNL: "PnL Settlement", FUNDING_FEE: "Funding Fee",
                        LIQUIDATION: "Liquidation", MARGIN_ADD: "Add Margin",
                        MARGIN_REMOVE: "Remove Margin",
                      };
                      const typeColor: Record<string, string> = {
                        DEPOSIT: "text-emerald-400", WITHDRAW: "text-amber-400",
                        SETTLE_PNL: amt >= 0 ? "text-emerald-400" : "text-rose-400",
                        FUNDING_FEE: amt >= 0 ? "text-emerald-400" : "text-rose-400",
                        LIQUIDATION: "text-rose-400",
                      };
                      return (
                        <div key={bill.id} className="grid grid-cols-6 gap-2 py-3 border-b border-okx-border-primary/50 hover:bg-okx-bg-hover transition-colors text-sm">
                          <span className="text-okx-text-tertiary text-xs self-center">
                            {new Date(bill.createdAt).toLocaleString()}
                          </span>
                          <span className={`text-xs font-medium self-center ${typeColor[bill.type] || "text-okx-text-secondary"}`}>
                            {typeLabel[bill.type] || bill.type}
                          </span>
                          <span className={`font-mono font-semibold text-right self-center ${
                            amt >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}>
                            {amt >= 0 ? "+" : ""}{amt.toFixed(6)} BNB
                          </span>
                          <span className="font-mono text-okx-text-tertiary text-right self-center text-xs">
                            {before.toFixed(4)}
                          </span>
                          <span className="font-mono text-okx-text-secondary text-right self-center text-xs">
                            {after.toFixed(4)}
                          </span>
                          <span className="text-xs text-okx-text-tertiary text-right self-center">
                            {bill.onChainStatus === "ENGINE_SETTLED" ? "Settled" : bill.onChainStatus}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-20 text-center text-okx-text-tertiary text-sm">
                    <svg className="w-12 h-12 mb-3 opacity-30 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" /></svg>
                    No bills yet
                  </div>
                )
              ) : historySubTab === "funding" ? (
                fundingBills.length > 0 ? (
                  <div>
                    <div className="grid grid-cols-6 gap-2 py-2.5 border-b border-okx-border-primary">
                      <span className="text-xs text-okx-text-tertiary">Time</span>
                      <span className="text-xs text-okx-text-tertiary">Token</span>
                      <span className="text-xs text-okx-text-tertiary">Direction</span>
                      <span className="text-xs text-okx-text-tertiary text-right">Rate</span>
                      <span className="text-xs text-okx-text-tertiary text-right">Amount</span>
                      <span className="text-xs text-okx-text-tertiary text-right">Position Size</span>
                    </div>
                    {fundingBills.map((bill) => {
                      const amt = Number(bill.amount) / 1e18;
                      let proof: any = {};
                      try { proof = JSON.parse(bill.proofData || "{}"); } catch {}
                      const tokenAddr = (proof.token || "").toLowerCase();
                      const symbol = tokenSymbolMap.get(tokenAddr) || (tokenAddr ? tokenAddr.slice(0, 8) : "\u2014");
                      const isLong = proof.isLong;
                      const rate = proof.appliedRate ? (Number(proof.appliedRate) / 1e18 * 100).toFixed(4) + "%" : "\u2014";
                      const posSize = proof.positionSize ? (Number(proof.positionSize) / 1e18).toFixed(4) : "\u2014";
                      return (
                        <div key={bill.id} className="grid grid-cols-6 gap-2 py-3 border-b border-okx-border-primary/50 hover:bg-okx-bg-hover transition-colors text-sm">
                          <span className="text-okx-text-tertiary text-xs self-center">
                            {new Date(bill.createdAt).toLocaleString()}
                          </span>
                          <span className="font-mono text-okx-text-primary self-center">{symbol}/BNB</span>
                          <span className="self-center">
                            {isLong !== undefined ? (
                              <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded ${
                                isLong ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"
                              }`}>
                                {isLong ? "Long" : "Short"}
                              </span>
                            ) : "\u2014"}
                          </span>
                          <span className="font-mono text-okx-text-secondary text-right self-center text-xs">
                            {rate}
                          </span>
                          <span className={`font-mono font-semibold text-right self-center ${
                            amt >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}>
                            {amt >= 0 ? "+" : ""}{amt.toFixed(6)} BNB
                          </span>
                          <span className="font-mono text-okx-text-tertiary text-right self-center text-xs">
                            {posSize} BNB
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-20 text-center text-okx-text-tertiary text-sm">
                    <svg className="w-12 h-12 mb-3 opacity-30 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    No funding fee history
                  </div>
                )
              ) : null}
            </div>
          )}

          {/* Bottom spacing */}
          <div className="h-10" />
        </div>
      )}
    </main>
  );
}



