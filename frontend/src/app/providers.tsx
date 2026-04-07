"use client";

// Window 扩展 — WalletConnect 重复初始化警告抑制标记
declare global {
  interface Window {
    __walletconnect_warned?: boolean;
  }
}

import React, { useState, useEffect, Component, ErrorInfo, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { ToastProvider } from "@/components/shared/Toast";
import { config, configError } from "@/lib/wagmi";
import { useUnifiedWebSocket } from "@/hooks/common/useUnifiedWebSocket";
import { WebSocketStatusIndicator } from "@/components/debug/WebSocketStatusIndicator";
import { NavigationProgress } from "@/components/shared/NavigationProgress";
import { I18nProvider, useLocale } from "@/i18n";
import { useAppStore } from "@/lib/stores/appStore";
import { WalletBalanceProvider } from "@/contexts/WalletBalanceContext";
// Note: RainbowKit CSS is imported in layout.tsx (server component) to avoid 404 errors

// =====================================================
// Development Environment Detection
// =====================================================
const isDev = process.env.NODE_ENV === 'development';

// =====================================================
// Global Error Handlers for Development
// =====================================================
if (typeof window !== 'undefined') {
  // Global error handler for wallet and WebSocket errors
  const originalErrorHandler = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    const errorMessage = typeof message === 'string' ? message : String(message);
    
    // Suppress Next.js WebSocket URL errors
    if (errorMessage.includes('Invalid URL') && 
        (source?.includes('get-socket-url') || source?.includes('react-dev-overlay'))) {
      if (isDev) {
        console.warn('[Next.js Dev Overlay] WebSocket connection failed, safe to ignore in test environments');
      }
      return true;
    }
    
    // Suppress ethereum property redefinition errors (common with multiple wallet extensions)
    if (errorMessage.includes('Cannot redefine property: ethereum')) {
      if (isDev) {
        console.warn('[Wallet] Multiple wallet extensions detected, using first available');
      }
      return true;
    }

    // Suppress WalletConnect subscription errors (occurs with invalid project ID)
    if (errorMessage.includes('Connection interrupted') ||
        errorMessage.includes('while trying to subscribe')) {
      if (isDev) {
        console.warn('[WalletConnect] Subscription failed - this is expected without a valid Project ID');
      }
      return true;
    }
    
    if (originalErrorHandler) {
      return originalErrorHandler(message, source, lineno, colno, error);
    }
    return false;
  };
  
  // Handle unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason?.toString() || String(event.reason);
    const errorMessage = event.reason?.message || '';

    // TODO: 实现标准错误码系统
    // 临时保留字符串匹配，但应改为 error_code 判断
    const isWebSocketError = reason.includes('Invalid URL') || errorMessage.includes('Invalid URL');
    if (isWebSocketError) {
      if (isDev) {
        console.warn('[Next.js Dev Overlay] WebSocket connection failed, safe to ignore');
      }
      event.preventDefault();
      return;
    }

    // Suppress WalletConnect subscription errors
    const isWalletConnectError = reason.includes('Connection interrupted') ||
        errorMessage.includes('Connection interrupted') ||
        reason.includes('while trying to subscribe') ||
        errorMessage.includes('while trying to subscribe');
    if (isWalletConnectError) {
      if (isDev) {
        console.warn('[WalletConnect] Subscription failed - configure NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID for full functionality');
      }
      event.preventDefault();
      return;
    }
  });
}

// =====================================================
// Error Boundary Component
// =====================================================
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

// Error Fallback UI Component - NO hooks to avoid crashes
// Uses simple static text since I18n might not be available
function ErrorFallbackUI({ error, onRetry }: { error?: Error; onRetry: () => void }) {
  // Get locale from localStorage directly (no hooks)
  const getLocale = () => {
    if (typeof window === 'undefined') return 'zh';
    try {
      return localStorage.getItem('dexi-locale') || 'zh';
    } catch {
      return 'zh';
    }
  };

  const locale = getLocale();

  // Static translations for error fallback (no hooks)
  const errorTexts: Record<string, Record<string, string>> = {
    zh: {
      title: '应用加载失败',
      desc: '加载组件时出现错误',
      refresh: '刷新页面',
      retry: '重试',
    },
    en: {
      title: 'App Failed to Load',
      desc: 'An error occurred while loading components',
      refresh: 'Refresh Page',
      retry: 'Retry',
    },
    ja: {
      title: 'アプリの読み込みに失敗',
      desc: 'コンポーネントの読み込み中にエラーが発生しました',
      refresh: 'ページを更新',
      retry: '再試行',
    },
    ko: {
      title: '앱 로드 실패',
      desc: '컴포넌트 로딩 중 오류 발생',
      refresh: '페이지 새로고침',
      retry: '재시도',
    },
  };

  const t = errorTexts[locale] || errorTexts.zh;

  return (
    <div className="min-h-screen bg-okx-bg-primary flex items-center justify-center p-4">
      <div className="bg-okx-bg-card border border-okx-down rounded-xl p-8 max-w-md text-center">
        <h2 className="text-okx-text-primary text-xl font-bold mb-4">{t.title}</h2>
        <p className="text-okx-text-secondary text-sm mb-4">
          {t.desc}
        </p>
        <p className="text-okx-text-tertiary text-xs mb-4 font-mono bg-okx-bg-primary p-2 rounded break-all">
          {error?.message || 'Unknown error'}
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => window.location.reload()}
            className="bg-meme-lime text-black px-6 py-2 rounded-lg font-bold hover:opacity-90 transition-opacity"
          >
            {t.refresh}
          </button>
          <button
            onClick={onRetry}
            className="bg-okx-bg-hover text-okx-text-primary px-6 py-2 rounded-lg font-bold hover:opacity-90 transition-opacity"
          >
            {t.retry}
          </button>
        </div>
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[Providers] Error Boundary caught an error:", error.message);
    if (isDev) {
      console.error("Component Stack:", errorInfo.componentStack);
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <ErrorFallbackUI
          error={this.state.error}
          onRetry={() => this.setState({ hasError: false, error: undefined })}
        />
      );
    }

    return this.props.children;
  }
}

// =====================================================
// Loading Skeleton Component
// =====================================================
// Simple translation map for skeleton (before I18nProvider loads)
const skeletonTranslations: Record<string, Record<string, string>> = {
  zh: {
    market: "行情",
    createToken: "创建代币",
    connectWallet: "连接钱包",
    newPairs: "新币对",
    aboutToMigrate: "即将迁移",
    migrated: "已迁移",
    loading: "加载中...",
  },
  en: {
    market: "Market",
    createToken: "Create Token",
    connectWallet: "Connect Wallet",
    newPairs: "New Pairs",
    aboutToMigrate: "About to Migrate",
    migrated: "Migrated",
    loading: "Loading...",
  },
  ja: {
    market: "市場",
    createToken: "トークン作成",
    connectWallet: "ウォレット接続",
    newPairs: "新規ペア",
    aboutToMigrate: "移行予定",
    migrated: "移行済み",
    loading: "読み込み中...",
  },
  ko: {
    market: "시장",
    createToken: "토큰 생성",
    connectWallet: "지갑 연결",
    newPairs: "새 페어",
    aboutToMigrate: "이전 예정",
    migrated: "이전됨",
    loading: "로딩 중...",
  },
};

function LoadingSkeleton() {
  const [locale, setLocale] = useState('zh');

  useEffect(() => {
    try {
      const stored = localStorage.getItem('dexi-locale');
      if (stored && ['zh', 'en', 'ja', 'ko'].includes(stored)) {
        setLocale(stored);
      }
    } catch { /* localStorage unavailable */ }
  }, []);

  const t = skeletonTranslations[locale] || skeletonTranslations.zh;

  return (
    <main className="min-h-screen bg-okx-bg-primary">
      {/* Skeleton Navigation Bar */}
      <nav className="sticky top-0 z-30 bg-okx-bg-primary border-b border-okx-border-primary h-[64px]">
        <div className="max-w-[1440px] mx-auto px-4 h-full flex items-center justify-between">
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2 text-okx-text-primary font-bold text-xl tracking-tight">
              <span className="text-meme-lime">✦</span>
              DEXI
            </div>
          </div>
          <div
            data-testid="connect-wallet-btn"
            className="bg-okx-up text-black px-4 py-1.5 rounded-full text-sm font-bold opacity-50"
          >
            {t.connectWallet}
          </div>
        </div>
      </nav>

      {/* Loading indicator */}
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-okx-up border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="mt-4 text-okx-text-tertiary text-sm">{t.loading}</p>
        </div>
      </div>
    </main>
  );
}

// =====================================================
// WebSocket Auto-Connect Component
// =====================================================
function WebSocketAutoConnect({ children }: { children: ReactNode }) {
  useUnifiedWebSocket({ enabled: true });
  return <>{children}</>;
}

// =====================================================
// Main Providers Component
// =====================================================
export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  // Create QueryClient inside component to avoid SSR issues
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000, // 30秒，配合实时 WebSocket 更新
        refetchOnWindowFocus: true, // 切换标签页回来时自动刷新
        refetchOnReconnect: true, // 网络恢复时自动刷新
        retry: 1, // 只重试1次，避免长时间等待
        retryDelay: 500, // 快速重试
      },
    },
  }));

  // Apply theme to document at root level - subscribe to store changes
  useEffect(() => {
    if (!mounted) return;

    // Function to apply theme
    const applyTheme = (theme: 'light' | 'dark' | 'system') => {
      const root = document.documentElement;
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const actualTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

      root.classList.remove('light', 'dark');
      root.classList.add(actualTheme);
    };

    // Apply initial theme
    const currentTheme = useAppStore.getState().preferences.theme;
    applyTheme(currentTheme);

    // Subscribe to theme changes
    let prevTheme = currentTheme;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.preferences.theme !== prevTheme) {
        prevTheme = state.preferences.theme;
        applyTheme(state.preferences.theme);
      }
    });

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemChange = () => {
      const theme = useAppStore.getState().preferences.theme;
      if (theme === 'system') {
        applyTheme(theme);
      }
    };

    mediaQuery.addEventListener('change', handleSystemChange);

    return () => {
      unsubscribe();
      mediaQuery.removeEventListener('change', handleSystemChange);
    };
  }, [mounted]);

  // Set mounted on client to prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
    
    // Log config errors in development
    if (isDev && configError) {
      console.warn('[Providers] Wagmi config error:', configError.message);
    }

    // Suppress WalletConnect/AppKit initialization warnings in development
    if (isDev && typeof window !== 'undefined') {
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        const message = String(args[0] ?? '');
        // Suppress WalletConnect Core already initialized warnings
        if (message.includes('WalletConnect Core is already initialized') ||
            message.includes('Init() was called')) {
          // Only log once to avoid spam
          if (!window.__walletconnect_warned) {
            console.info('[WalletConnect] Multiple initialization detected (normal in React Strict Mode)');
            window.__walletconnect_warned = true;
          }
          return;
        }
        // TODO: 实现标准错误码系统
        // 临时保留字符串匹配，但应改为 error_code 判断
        const isConfigError = message.includes('Failed to fetch remote project configuration') ||
            message.includes('HTTP status code: 403');
        if (isConfigError) {
          // This is expected when using a fallback project ID
          return;
        }
        originalWarn.apply(console, args);
      };
    }
  }, []);

  // Show skeleton UI during SSR to prevent hydration mismatch while keeping nav visible
  if (!mounted) {
    return <LoadingSkeleton />;
  }

  return (
    <ErrorBoundary>
      <I18nProvider>
        <ErrorBoundary>
          <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
              <RainbowKitProvider
                initialChain={parseInt(process.env.NEXT_PUBLIC_TARGET_CHAIN_ID || "56")}
                modalSize="compact"
              >
                <ToastProvider>
                  <WalletBalanceProvider>
                    <WebSocketAutoConnect>
                      <NavigationProgress />
                      {children}
                      {/* WebSocket 状态指示器 (仅开发环境) */}
                      <WebSocketStatusIndicator />
                    </WebSocketAutoConnect>
                  </WalletBalanceProvider>
                </ToastProvider>
              </RainbowKitProvider>
            </QueryClientProvider>
          </WagmiProvider>
        </ErrorBoundary>
      </I18nProvider>
    </ErrorBoundary>
  );
}
