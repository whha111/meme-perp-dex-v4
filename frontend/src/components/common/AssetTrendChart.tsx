"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  AreaChart,
  Area,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Types ──────────────────────────────────────
interface PortfolioSnapshot {
  timestamp: number; // Unix ms
  valueBnb: number;
  valueUsd: number;
}

interface AssetTrendChartProps {
  /** Current total portfolio value in BNB */
  currentValueBnb: number;
  /** Current BNB price in USD */
  bnbPriceUsd: number;
  /** Wallet address – used to namespace snapshots in localStorage */
  walletAddress: string;
  /** Render as a compact sparkline (OKX hero-inline style) */
  compact?: boolean;
  /** Height in px (default: 60 for compact, 160 for full) */
  height?: number;
  /** Called with today's change data for parent to display */
  onChangeData?: (data: { amount: number; percent: number }) => void;
}

// ── Timeframe (only used in full mode) ─────────
type Timeframe = "1D" | "1W" | "1M" | "ALL";
const TIMEFRAME_MS: Record<Exclude<Timeframe, "ALL">, number> = {
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

// ── Snapshot config ────────────────────────────
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS = 2000;

// ── localStorage helpers ───────────────────────
function getStorageKey(address: string) {
  return `meme_perp_portfolio_${address.toLowerCase()}`;
}

function loadSnapshots(address: string): PortfolioSnapshot[] {
  try {
    const raw = localStorage.getItem(getStorageKey(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveSnapshots(address: string, snapshots: PortfolioSnapshot[]) {
  try {
    const trimmed = snapshots.slice(-MAX_SNAPSHOTS);
    localStorage.setItem(getStorageKey(address), JSON.stringify(trimmed));
  } catch {
    // silently ignore
  }
}

// ── Tooltip (only for full mode) ───────────────
function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { time: string; valueUsd: number; valueBnb: number } }>;
}) {
  if (!active || !payload?.[0]) return null;
  const data = payload[0].payload;
  return (
    <div className="bg-[#1a1a1a] border border-[#333] rounded-lg px-3 py-2 shadow-xl">
      <p className="text-[10px] text-[#8e8e93] mb-1">{data.time}</p>
      <p className="text-xs font-mono font-semibold text-white">
        ${data.valueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
      <p className="text-[10px] font-mono text-[#8e8e93]">
        {data.valueBnb.toFixed(4)} BNB
      </p>
    </div>
  );
}

// ── Main Component ─────────────────────────────
export function AssetTrendChart({
  currentValueBnb,
  bnbPriceUsd,
  walletAddress,
  compact = false,
  height,
  onChangeData,
}: AssetTrendChartProps) {
  const chartHeight = height ?? (compact ? 60 : 160);
  const [timeframe, setTimeframe] = useState<Timeframe>("1D");
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);

  // Load existing snapshots on mount
  useEffect(() => {
    if (!walletAddress) return;
    setSnapshots(loadSnapshots(walletAddress));
  }, [walletAddress]);

  // Record a new snapshot (throttled)
  useEffect(() => {
    if (!walletAddress || currentValueBnb <= 0) return;

    const existing = loadSnapshots(walletAddress);
    const now = Date.now();
    const last = existing[existing.length - 1];

    if (last && now - last.timestamp < SNAPSHOT_INTERVAL_MS) return;

    const newSnapshot: PortfolioSnapshot = {
      timestamp: now,
      valueBnb: currentValueBnb,
      valueUsd: currentValueBnb * bnbPriceUsd,
    };

    const updated = [...existing, newSnapshot];
    saveSnapshots(walletAddress, updated);
    setSnapshots(updated);
  }, [walletAddress, currentValueBnb, bnbPriceUsd]);

  // Filter by timeframe (compact always uses 1D)
  const activeTimeframe = compact ? "1D" : timeframe;

  const filteredData = useMemo(() => {
    if (snapshots.length === 0) return [];
    const now = Date.now();
    const cutoff = activeTimeframe === "ALL" ? 0 : now - TIMEFRAME_MS[activeTimeframe];
    const filtered = snapshots.filter((s) => s.timestamp >= cutoff);
    return filtered.map((s) => ({
      timestamp: s.timestamp,
      time: formatTime(s.timestamp, activeTimeframe),
      valueBnb: s.valueBnb,
      valueUsd: s.valueUsd,
    }));
  }, [snapshots, activeTimeframe]);

  // Change calculation
  const valueChange = useMemo(() => {
    if (filteredData.length < 2) return { amount: 0, percent: 0 };
    const first = filteredData[0].valueUsd;
    const last = filteredData[filteredData.length - 1].valueUsd;
    const amount = last - first;
    const percent = first > 0 ? (amount / first) * 100 : 0;
    return { amount, percent };
  }, [filteredData]);

  // Notify parent of change data
  useEffect(() => {
    onChangeData?.(valueChange);
  }, [valueChange.amount, valueChange.percent]); // eslint-disable-line react-hooks/exhaustive-deps

  const isPositive = valueChange.amount >= 0;
  const chartColor = isPositive ? "#BFFF00" : "#FF3B30";

  // Chart data with fallback flat line
  const chartData = useMemo(() => {
    if (filteredData.length === 0 && currentValueBnb > 0) {
      const now = Date.now();
      const currentUsd = currentValueBnb * bnbPriceUsd;
      return [
        { timestamp: now - 3600000, time: "", valueBnb: currentValueBnb, valueUsd: currentUsd },
        { timestamp: now, time: "", valueBnb: currentValueBnb, valueUsd: currentUsd },
      ];
    }
    return filteredData;
  }, [filteredData, currentValueBnb, bnbPriceUsd]);

  // ── Compact sparkline mode (OKX hero inline) ──
  if (compact) {
    if (chartData.length === 0) return null;
    return (
      <div style={{ width: "100%", height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
            <defs>
              <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartColor} stopOpacity={0.2} />
                <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="valueUsd"
              stroke={chartColor}
              strokeWidth={1.5}
              fill="url(#sparkGrad)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── Full chart mode ───────────────────────────
  const tabs: { key: Timeframe; label: string }[] = [
    { key: "1D", label: "1D" },
    { key: "1W", label: "1W" },
    { key: "1M", label: "1M" },
    { key: "ALL", label: "All" },
  ];

  return (
    <div>
      {/* Timeframe tabs */}
      <div className="flex items-center gap-1 mb-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setTimeframe(tab.key)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              timeframe === tab.key
                ? "bg-meme-lime/15 text-meme-lime"
                : "text-okx-text-tertiary hover:text-okx-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Chart area */}
      <div style={{ height: chartHeight }}>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="fullGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chartColor} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={chartColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ stroke: "#555", strokeDasharray: "3 3" }}
              />
              <Area
                type="monotone"
                dataKey="valueUsd"
                stroke={chartColor}
                strokeWidth={1.5}
                fill="url(#fullGrad)"
                dot={false}
                activeDot={{ r: 3, fill: chartColor, stroke: "#000", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full text-okx-text-tertiary text-xs">
            --
          </div>
        )}
      </div>
    </div>
  );
}

// ── Time formatting ────────────────────────────
function formatTime(ts: number, timeframe: Timeframe): string {
  const d = new Date(ts);
  if (timeframe === "1D") {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
