"use client";

/**
 * 猎杀排行榜组件
 *
 * 显示清算排行榜和实时清算通知
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { MATCHING_ENGINE_URL, WS_URL } from "@/config/api";

interface Hunter {
  rank: number;
  address: string;
  kills: number;
  profit: string;
  lastKill: number;
}

interface LeaderboardData {
  period: string;
  hunters: Hunter[];
  totalHunters: number;
  totalLiquidations: number;
}

interface LiquidationEvent {
  id: string;
  token: string;
  liquidatedTrader: string;
  liquidator: string;
  isLong: boolean;
  size: string;
  liquidationPrice: string;
  collateralLost: string;
  timestamp: number;
}

interface Props {
  token?: string;
  apiUrl?: string;
  wsUrl?: string;
}

export function HunterLeaderboard({
  token,
  apiUrl = MATCHING_ENGINE_URL,
  wsUrl = WS_URL,
}: Props) {
  const t = useTranslations("perp");
  const [leaderboard, setLeaderboard] = useState<LeaderboardData | null>(null);
  const [recentLiquidations, setRecentLiquidations] = useState<LiquidationEvent[]>([]);
  const [period, setPeriod] = useState<"24h" | "7d" | "all">("all");
  const [loading, setLoading] = useState(true);

  // 获取排行榜数据
  useEffect(() => {
    const fetchLeaderboard = async () => {
      try {
        const res = await fetch(`${apiUrl}/api/hunters?period=${period}`);

        // 检查响应状态
        if (!res.ok) {
          console.warn(`[HunterLeaderboard] API returned ${res.status}, using empty data`);
          setLeaderboard({ period, hunters: [], totalHunters: 0, totalLiquidations: 0 });
          setLoading(false);
          return;
        }

        const json = await res.json();
        setLeaderboard(json);
      } catch (err) {
        console.error('[HunterLeaderboard] Fetch error:', err);
        // 设置空数据而不是让组件处于错误状态
        setLeaderboard({ period, hunters: [], totalHunters: 0, totalLiquidations: 0 });
      } finally {
        setLoading(false);
      }
    };

    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, 30000); // 30秒刷新，减少频率
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]); // 移除 apiUrl 依赖，因为它是常量

  // WebSocket 连接接收实时清算事件
  useEffect(() => {
    if (!token) return;

    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log('[HunterLeaderboard] WebSocket connected');
          // 订阅清算频道
          ws?.send(JSON.stringify({
            type: "subscribe",
            channel: "liquidation",
            token,
          }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "liquidation") {
              const liquidation = msg.data as LiquidationEvent;
              setRecentLiquidations(prev => [liquidation, ...prev.slice(0, 9)]);

              // 显示通知
              showLiquidationNotification(liquidation);
            }
          } catch (err) {
            console.error('[HunterLeaderboard] Message parse error:', err);
          }
        };

        ws.onerror = (err) => {
          console.warn('[HunterLeaderboard] WebSocket error:', err);
        };

        ws.onclose = () => {
          console.log('[HunterLeaderboard] WebSocket closed');
          // 不要自动重连，避免无限循环
        };
      } catch (err) {
        console.error('[HunterLeaderboard] WebSocket connection error:', err);
      }
    };

    connect();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.close();
        ws = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]); // 移除 wsUrl 依赖，因为它是常量

  // 显示清算通知
  const showLiquidationNotification = useCallback((liq: LiquidationEvent) => {
    // 可以集成 toast 通知库
    console.log(`[LIQUIDATION] ${liq.liquidatedTrader.slice(0, 10)} was hunted!`);
  }, []);

  // 格式化地址
  const formatAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  // 格式化利润 (ETH 本位: 1e18 精度)
  const formatProfit = (profit: string) => {
    const p = Number(profit) / 1e18;
    return `Ξ${p >= 1 ? p.toFixed(4) : p.toFixed(6)}`;
  };

  // 格式化时间
  const formatTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return t("justNow");
    if (diff < 3600000) return `${Math.floor(diff / 60000)}${t("minutesAgo")}`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}${t("hoursAgo")}`;
    return `${Math.floor(diff / 86400000)}${t("daysAgo")}`;
  };

  // 获取排名图标
  const getRankIcon = (rank: number) => {
    if (rank === 1) return "🥇";
    if (rank === 2) return "🥈";
    if (rank === 3) return "🥉";
    return `#${rank}`;
  };

  return (
    <div className="bg-gray-900 rounded-lg p-3 h-full flex flex-col">
      {/* 标题和统计 */}
      <div className="flex justify-between items-center mb-2 flex-shrink-0">
        <h3 className="text-sm font-bold text-white">🎯 {t("hunterLeaderboard")}</h3>
        <span className="text-[10px] text-red-400 font-bold">
          {leaderboard?.totalLiquidations || 0} kills
        </span>
      </div>

      {/* 时间段选择器 */}
      <div className="flex gap-1 mb-2 flex-shrink-0">
        {(["24h", "7d", "all"] as const).map(p => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-2 py-0.5 rounded text-[10px] ${
              period === p
                ? "bg-red-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            {p === "all" ? t("allTime") : p.toUpperCase()}
          </button>
        ))}
      </div>

      {/* 排行榜 - 紧凑版 */}
      <div className="flex-1 overflow-auto min-h-0 space-y-1">
        {loading ? (
          <div className="animate-pulse space-y-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-8 bg-gray-800 rounded" />
            ))}
          </div>
        ) : leaderboard?.hunters.length === 0 ? (
          <div className="text-center text-gray-500 py-4 text-xs">
            <p className="text-lg mb-1">🏆</p>
            <p>{t("noHuntersYet")}</p>
          </div>
        ) : (
          leaderboard?.hunters.slice(0, 8).map((hunter, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 p-2 rounded ${
                hunter.rank <= 3
                  ? "bg-gradient-to-r from-yellow-900/30 to-transparent border border-yellow-600/20"
                  : "bg-gray-800/50"
              }`}
            >
              {/* 排名 */}
              <div className="w-6 text-center text-sm">
                {getRankIcon(hunter.rank)}
              </div>

              {/* 地址 */}
              <div className="flex-1 min-w-0">
                <div className="font-mono text-white text-[11px] truncate">
                  {formatAddress(hunter.address)}
                </div>
              </div>

              {/* 统计 */}
              <div className="text-right flex-shrink-0">
                <div className="text-red-400 font-bold text-[11px]">
                  {hunter.kills}
                </div>
                <div className="text-green-400 text-[9px]">
                  {formatProfit(hunter.profit)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 实时清算通知 - 紧凑版 */}
      {recentLiquidations.length > 0 && (
        <div className="border-t border-gray-700 pt-2 mt-2 flex-shrink-0">
          <h4 className="text-[10px] font-bold text-gray-400 mb-1">{t("recentLiquidations")}</h4>
          <div className="space-y-1 max-h-20 overflow-y-auto">
            {recentLiquidations.slice(0, 3).map((liq, i) => (
              <div
                key={liq.id}
                className={`px-2 py-1 rounded bg-red-900/20 text-[10px] ${
                  i === 0 ? "animate-pulse border border-red-500/30" : ""
                }`}
              >
                <span className="text-red-400">{formatAddress(liq.liquidatedTrader)}</span>
                <span className="text-gray-500"> → </span>
                <span className="text-gray-400">Ξ{(Number(liq.collateralLost) / 1e18).toFixed(4)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 提示信息 - 极简版 */}
      <div className="mt-2 pt-2 border-t border-gray-700 text-[9px] text-gray-500 flex-shrink-0">
        💡 {t("huntStep1")}
      </div>
    </div>
  );
}

export default HunterLeaderboard;
