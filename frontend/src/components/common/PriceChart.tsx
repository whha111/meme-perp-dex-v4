"use client";

import React, { useEffect, useRef } from "react";

interface PriceChartProps {
  className?: string;
  symbol?: string;
}

declare global {
  interface Window {
    TradingView?: { widget: new (config: Record<string, unknown>) => unknown };
  }
}

export function PriceChart({ className, symbol = "BINANCE:ETHUSDT" }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scriptId = "tradingview-widget-script";
    let script = document.getElementById(scriptId) as HTMLScriptElement;

    const createWidget = () => {
      if (containerRef.current && window.TradingView) {
        new window.TradingView.widget({
          container_id: containerRef.current.id,
          width: "100%",
          height: "100%",
          symbol: symbol,
          interval: "1",
          timezone: "Etc/UTC",
          theme: "dark",
          style: "1",
          locale: "zh_CN",
          toolbar_bg: "#000000",
          enable_publishing: false,
          allow_symbol_change: true,
          save_image: false,
          backgroundColor: "#000000",
          gridColor: "rgba(31, 31, 31, 0.5)",
          details: false,
          hotlist: false,
          calendar: false,
          hide_side_toolbar: false, // 显示左侧工具栏 (OKX 风格)
          hide_top_toolbar: false,
          studies: ["Volume@tv-basicstudies"], // 显示成交量
          loading_screen: { backgroundColor: "#000000" },
          overrides: {
            "mainSeriesProperties.candleStyle.upColor": "#00D26A",
            "mainSeriesProperties.candleStyle.downColor": "#FF3B30",
            "mainSeriesProperties.candleStyle.drawWick": true,
            "mainSeriesProperties.candleStyle.drawBorder": true,
            "mainSeriesProperties.candleStyle.borderColor": "#378658",
            "mainSeriesProperties.candleStyle.borderUpColor": "#00D26A",
            "mainSeriesProperties.candleStyle.borderDownColor": "#FF3B30",
            "mainSeriesProperties.candleStyle.wickUpColor": "#00D26A",
            "mainSeriesProperties.candleStyle.wickDownColor": "#FF3B30",
            "paneProperties.background": "#000000",
            "paneProperties.vertGridProperties.color": "#1F1F1F",
            "paneProperties.horzGridProperties.color": "#1F1F1F",
            "scalesProperties.textColor": "#8E8E93",
          },
        });
      }
    };

    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://s3.tradingview.com/tv.js";
      script.type = "text/javascript";
      script.onload = createWidget;
      document.head.appendChild(script);
    } else if (window.TradingView) {
      createWidget();
    }

    return () => {
      // 这里的清理逻辑可以根据需要添加，由于是 iframe 注入，通常只需清空 container
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [symbol]);

  return (
    <div className={`w-full h-full min-h-[160px] bg-okx-bg-primary ${className}`}>
      <div
        id="tradingview_widget_container"
        ref={containerRef}
        className="w-full h-full"
      />
    </div>
  );
}
