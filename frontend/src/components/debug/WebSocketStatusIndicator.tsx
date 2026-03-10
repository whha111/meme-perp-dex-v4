/**
 * WebSocket Connection Status Indicator
 * Only displayed in development environment for debugging WebSocket connection status
 *
 * Reads from tradingDataStore.wsConnected (the real source of truth)
 * which is set by WebSocketManager in useUnifiedWebSocket.ts
 */

"use client";

import { useState } from "react";
import { ConnectionStatus } from "@/lib/websocket/types";
import { useTranslations } from "next-intl";
import { WS_URL } from "@/config/api";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";

const isDev = process.env.NODE_ENV === "development";

export function WebSocketStatusIndicator() {
  const wsConnected = useTradingDataStore((s) => s.wsConnected);
  const wsError = useTradingDataStore((s) => s.wsError);
  const status: ConnectionStatus = wsError
    ? ConnectionStatus.ERROR
    : wsConnected
      ? ConnectionStatus.CONNECTED
      : ConnectionStatus.DISCONNECTED;
  const [isVisible, setIsVisible] = useState(false);
  const t = useTranslations("debug");

  // Only display in development environment
  if (!isDev) return null;

  // Get status style
  const getStatusStyle = () => {
    switch (status) {
      case ConnectionStatus.CONNECTED:
        return {
          bg: "bg-green-500",
          text: t("connected"),
          icon: "✓",
        };
      case ConnectionStatus.DISCONNECTED:
        return {
          bg: "bg-gray-500",
          text: t("disconnected"),
          icon: "○",
        };
      case ConnectionStatus.ERROR:
        return {
          bg: "bg-red-500",
          text: t("error"),
          icon: "✕",
        };
      default:
        return {
          bg: "bg-gray-500",
          text: t("unknown"),
          icon: "?",
        };
    }
  };

  const statusStyle = getStatusStyle();

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {/* Toggle button */}
      <button
        onClick={() => setIsVisible(!isVisible)}
        className={`${statusStyle.bg} text-white px-3 py-2 rounded-lg shadow-lg text-xs font-mono flex items-center gap-2 hover:opacity-90 transition-opacity`}
        title="WebSocket Status"
      >
        <span className="font-bold">{statusStyle.icon}</span>
        {isVisible && <span>WS: {statusStyle.text}</span>}
      </button>

      {/* Details panel */}
      {isVisible && (
        <div className="absolute bottom-12 right-0 bg-black border border-[#333] rounded-lg p-3 shadow-xl min-w-[200px]">
          <div className="text-white text-xs font-mono space-y-2">
            <div className="flex justify-between items-center pb-2 border-b border-[#333]">
              <span className="text-[#8E8E93]">WebSocket Status</span>
              <span className={`px-2 py-0.5 rounded ${statusStyle.bg} text-white`}>
                {statusStyle.text}
              </span>
            </div>
            <div className="text-[#636366] text-[10px] space-y-1">
              <div>URL: {WS_URL}</div>
              <div className="pt-2 border-t border-[#222]">
                <span className="text-[#8E8E93]">Note:</span> Dev only
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
