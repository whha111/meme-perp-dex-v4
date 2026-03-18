"use client";

import React, { Component, type ErrorInfo, type ReactNode } from "react";

// =====================================================
// 静态翻译 (Error Boundary 不能使用 hooks → 手动读取 locale)
// =====================================================
const TEXTS: Record<string, { title: string; desc: string; retry: string; detail: string }> = {
  zh: {
    title: "模块加载异常",
    desc: "此区域遇到错误，其他功能不受影响。",
    retry: "重试",
    detail: "错误详情",
  },
  en: {
    title: "Module Error",
    desc: "This section encountered an error. Other features still work.",
    retry: "Retry",
    detail: "Error details",
  },
  ja: {
    title: "モジュールエラー",
    desc: "このセクションでエラーが発生しました。他の機能は正常です。",
    retry: "再試行",
    detail: "エラー詳細",
  },
  ko: {
    title: "모듈 오류",
    desc: "이 섹션에서 오류가 발생했습니다. 다른 기능은 정상입니다.",
    retry: "재시도",
    detail: "오류 상세",
  },
};

function getLocale(): string {
  if (typeof window === "undefined") return "en";
  try {
    return localStorage.getItem("locale") || "en";
  } catch {
    return "en";
  }
}

// =====================================================
// TradingErrorBoundary — 交易面板组件级错误边界
// =====================================================

interface Props {
  children: ReactNode;
  /** 模块名称 (用于日志标识) */
  module?: string;
  /** 自定义 fallback UI，优先于默认 UI */
  fallback?: ReactNode;
  /** 错误回调 — 接入外部日志/告警系统 */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error?: Error;
  showDetail: boolean;
}

/**
 * 交易面板组件级错误边界
 *
 * 与全局 ErrorBoundary (providers.tsx) 的区别:
 * - 全局 → 整页 fallback (全屏错误页)
 * - 组件级 → 内联 fallback (只替换崩溃的面板区域)
 *
 * 使用方式:
 * ```tsx
 * <TradingErrorBoundary module="PerpChart">
 *   <PerpetualPriceChart />
 * </TradingErrorBoundary>
 * ```
 */
export class TradingErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, showDetail: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const module = this.props.module || "Unknown";
    console.error(
      `[TradingErrorBoundary:${module}] Caught error:`,
      error.message
    );
    if (process.env.NODE_ENV === "development") {
      console.error("Component Stack:", errorInfo.componentStack);
    }
    // 通知外部回调 (可接入 Sentry / 自定义日志)
    this.props.onError?.(error, errorInfo);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: undefined, showDetail: false });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    // 如果提供了自定义 fallback，直接使用
    if (this.props.fallback) {
      return this.props.fallback;
    }

    // 默认内联 fallback — 紧凑设计，适配深色交易面板
    const locale = getLocale();
    const t = TEXTS[locale] || TEXTS.en;

    return (
      <div className="flex flex-col items-center justify-center w-full h-full min-h-[200px] bg-okx-bg-primary/50 border border-okx-border-primary rounded-lg p-6">
        <div className="flex justify-center mb-3"><svg className="w-7 h-7 text-okx-warning" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg></div>
        <h3 className="text-sm font-semibold text-okx-text-primary mb-1">
          {t.title}
        </h3>
        <p className="text-xs text-okx-text-tertiary mb-4 text-center max-w-[280px]">
          {t.desc}
        </p>

        <button
          onClick={this.handleRetry}
          className="bg-okx-up text-black text-xs font-bold px-5 py-1.5 rounded-md hover:opacity-90 transition-opacity mb-3"
        >
          {t.retry}
        </button>

        {/* 可展开的错误详情 (开发/调试用) */}
        {this.state.error && (
          <button
            onClick={() =>
              this.setState((prev) => ({ showDetail: !prev.showDetail }))
            }
            className="text-xs text-okx-text-tertiary hover:text-okx-text-secondary transition-colors"
          >
            {this.state.showDetail ? "▲" : "▼"} {t.detail}
          </button>
        )}

        {this.state.showDetail && this.state.error && (
          <pre className="mt-2 text-xs text-okx-down font-mono bg-okx-bg-secondary p-2 rounded max-w-full overflow-auto max-h-[80px]">
            {this.state.error.message}
          </pre>
        )}
      </div>
    );
  }
}
