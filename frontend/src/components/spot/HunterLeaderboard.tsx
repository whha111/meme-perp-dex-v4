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

  // 格式化利润 (BNB 本位: 1e18 精度)
  const formatProfit = (profit: string) => {
    const p = Number(profit) / 1e18;
    return `BNB ${p >= 1 ? p.toFixed(4) : p.toFixed(6)}`;
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
    if (rank === 1) return <span className="text-yellow-400 font-bold">#1</span>;
    if (rank === 2) return <span className="text-okx-text-tertiary font-bold">#2</span>;
    if (rank === 3) return <span className="text-amber-600 font-bold">#3</span>;
    return `#${rank}`;
  };

  return (
    <div className="bg-okx-bg-secondary rounded-lg p-3 h-full flex flex-col">
      {/* 标题和统计 */}
      <div className="flex justify-between items-center mb-2 flex-shrink-0">
        <h3 className="text-sm font-bold text-okx-text-primary flex items-center gap-1.5"><svg className="w-4 h-4 text-okx-down" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> {t("hunterLeaderboard")}</h3>
        <span className="text-xs text-okx-down font-bold">
          {leaderboard?.totalLiquidations || 0} kills
        </span>
      </div>

      {/* 时间段选择器 */}
      <div className="flex gap-1 mb-2 flex-shrink-0">
        {(["24h", "7d", "all"] as const).map(p => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-2 py-0.5 rounded text-xs ${
              period === p
                ? "bg-red-600 text-okx-text-primary"
                : "bg-okx-bg-hover text-okx-text-tertiary hover:bg-okx-bg-active"
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
              <div key={i} className="h-8 bg-okx-bg-hover rounded" />
            ))}
          </div>
        ) : leaderboard?.hunters.length === 0 ? (
          <div className="text-center text-okx-text-tertiary py-4 text-xs">
            <div className="flex justify-center mb-1"><svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M18.75 4.236c.982.143 1.954.317 2.916.52A6.003 6.003 0 0016.27 9.728M18.75 4.236V4.5c0 2.108-.966 3.99-2.48 5.228m0 0a6.003 6.003 0 01-2.52.952m0 0a23.65 23.65 0 01-3.5 0m0 0a6.003 6.003 0 01-2.52-.952" /></svg></div>
            <p>{t("noHuntersYet")}</p>
          </div>
        ) : (
          leaderboard?.hunters.slice(0, 8).map((hunter, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 p-2 rounded ${
                hunter.rank <= 3
                  ? "bg-gradient-to-r from-yellow-900/30 to-transparent border border-yellow-600/20"
                  : "bg-okx-bg-hover/50"
              }`}
            >
              {/* 排名 */}
              <div className="w-6 text-center text-sm">
                {getRankIcon(hunter.rank)}
              </div>

              {/* 地址 */}
              <div className="flex-1 min-w-0">
                <div className="font-mono text-okx-text-primary text-xs truncate">
                  {formatAddress(hunter.address)}
                </div>
              </div>

              {/* 统计 */}
              <div className="text-right flex-shrink-0">
                <div className="text-okx-down font-bold text-xs">
                  {hunter.kills}
                </div>
                <div className="text-okx-up text-xs">
                  {formatProfit(hunter.profit)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 实时清算通知 - 紧凑版 */}
      {recentLiquidations.length > 0 && (
        <div className="border-t border-okx-border-primary pt-2 mt-2 flex-shrink-0">
          <h4 className="text-xs font-bold text-okx-text-tertiary mb-1">{t("recentLiquidations")}</h4>
          <div className="space-y-1 max-h-20 overflow-y-auto">
            {recentLiquidations.slice(0, 3).map((liq, i) => (
              <div
                key={liq.id}
                className={`px-2 py-1 rounded bg-red-900/20 text-xs ${
                  i === 0 ? "animate-pulse border border-red-500/30" : ""
                }`}
              >
                <span className="text-okx-down">{formatAddress(liq.liquidatedTrader)}</span>
                <span className="text-okx-text-tertiary"> → </span>
                <span className="text-okx-text-tertiary">BNB {(Number(liq.collateralLost) / 1e18).toFixed(4)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 提示信息 - 极简版 */}
      <div className="mt-2 pt-2 border-t border-okx-border-primary text-xs text-okx-text-tertiary flex-shrink-0">
        <svg className="w-3 h-3 inline-block mr-1 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" /></svg>{t("huntStep1")}
      </div>
    </div>
  );
}

export default HunterLeaderboard;
