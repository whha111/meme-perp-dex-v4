"use client";

declare global {
  interface Window {
    __walletconnect_warned?: boolean;
  }
}

import React, { Component, ErrorInfo, ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { WagmiProvider } from "wagmi";
import { ToastProvider } from "@/components/shared/Toast";
import { WalletBalanceProvider } from "@/contexts/WalletBalanceContext";
import { useUnifiedWebSocket } from "@/hooks/common/useUnifiedWebSocket";
import { useAppStore } from "@/lib/stores/appStore";
import { config, configError } from "@/lib/wagmi";
import { WebSocketStatusIndicator } from "@/components/debug/WebSocketStatusIndicator";
import { NavigationProgress } from "@/components/shared/NavigationProgress";
import { Navbar } from "@/components/layout/Navbar";
import { I18nProvider } from "@/i18n";

const isDev = process.env.NODE_ENV === "development";

if (typeof window !== "undefined") {
  const originalErrorHandler = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    const errorMessage = typeof message === "string" ? message : String(message);

    if (
      errorMessage.includes("Invalid URL") &&
      (source?.includes("get-socket-url") || source?.includes("react-dev-overlay"))
    ) {
      if (isDev) console.warn("[Next.js] Dev overlay socket unavailable in this environment");
      return true;
    }

    if (errorMessage.includes("Cannot redefine property: ethereum")) {
      if (isDev) console.warn("[Wallet] Multiple wallet extensions detected");
      return true;
    }

    if (errorMessage.includes("Connection interrupted") || errorMessage.includes("while trying to subscribe")) {
      if (isDev) console.warn("[WalletConnect] Subscription failed without a valid project id");
      return true;
    }

    return originalErrorHandler ? originalErrorHandler(message, source, lineno, colno, error) : false;
  };

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason?.toString() || String(event.reason);
    const message = event.reason?.message || "";

    const safeToSuppress =
      reason.includes("Invalid URL") ||
      message.includes("Invalid URL") ||
      reason.includes("Connection interrupted") ||
      message.includes("Connection interrupted") ||
      reason.includes("while trying to subscribe") ||
      message.includes("while trying to subscribe");

    if (safeToSuppress) {
      if (isDev) console.warn("[Providers] Suppressed expected local dev connection warning");
      event.preventDefault();
    }
  });
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

function ErrorFallbackUI({ error, onRetry }: { error?: Error; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-okx-bg-primary p-4">
      <div className="max-w-md rounded-xl border border-okx-down bg-okx-bg-card p-8 text-center">
        <h2 className="mb-4 text-xl font-bold text-okx-text-primary">App failed to load</h2>
        <p className="mb-4 text-sm text-okx-text-secondary">
          A local component failed while loading. Refresh or retry after the current change finishes compiling.
        </p>
        <p className="mb-4 break-all rounded bg-okx-bg-primary p-2 font-mono text-xs text-okx-text-tertiary">
          {error?.message || "Unknown error"}
        </p>
        <div className="flex justify-center gap-3">
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-meme-lime px-6 py-2 font-bold text-black transition-opacity hover:opacity-90"
          >
            Refresh
          </button>
          <button
            onClick={onRetry}
            className="rounded-lg bg-okx-bg-hover px-6 py-2 font-bold text-okx-text-primary transition-opacity hover:opacity-90"
          >
            Retry
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
    console.error("[Providers] Error boundary caught:", error.message);
    if (isDev) console.error("Component stack:", errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <ErrorFallbackUI error={this.state.error} onRetry={() => this.setState({ hasError: false })} />
        )
      );
    }

    return this.props.children;
  }
}

function LoadingSkeleton() {
  return (
    <main className="min-h-screen bg-okx-bg-primary">
      <nav className="sticky top-0 z-30 h-[44px] border-b border-okx-border-primary bg-okx-bg-primary">
        <div className="flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2 text-sm font-bold text-okx-text-primary">
            <span className="dexi-logo-mark rounded-[4px]">D</span>
            DEXI
          </div>
          <div className="rounded-[8px] bg-dexi-accent px-4 py-1.5 text-sm font-bold text-[#061215] opacity-60">
            Connect wallet
          </div>
        </div>
      </nav>
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-okx-up border-t-transparent" />
          <p className="mt-4 text-sm text-okx-text-tertiary">Loading...</p>
        </div>
      </div>
    </main>
  );
}

function WebSocketAutoConnect({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const realtimeEnabled = pathname === "/" || pathname.startsWith("/perp") || pathname.startsWith("/trade");

  useUnifiedWebSocket({ enabled: realtimeEnabled });
  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
            retry: 1,
            retryDelay: 500,
          },
        },
      })
  );

  useEffect(() => {
    setMounted(true);

    if (isDev && configError) {
      console.warn("[Providers] Wagmi config warning:", configError.message);
    }

    if (!isDev || typeof window === "undefined") return;

    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const message = String(args[0] ?? "");

      if (message.includes("WalletConnect Core is already initialized") || message.includes("Init() was called")) {
        if (!window.__walletconnect_warned) {
          console.info("[WalletConnect] Duplicate initialization detected in local dev");
          window.__walletconnect_warned = true;
        }
        return;
      }

      if (
        message.includes("Failed to fetch remote project configuration") ||
        message.includes("HTTP status code: 403")
      ) {
        return;
      }

      originalWarn.apply(console, args);
    };

    return () => {
      console.warn = originalWarn;
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const applyTheme = (theme: "light" | "dark" | "system") => {
      const root = document.documentElement;
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const actualTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

      root.classList.remove("light", "dark");
      root.classList.add(actualTheme);
    };

    const currentTheme = useAppStore.getState().preferences.theme;
    applyTheme(currentTheme);

    let prevTheme = currentTheme;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.preferences.theme !== prevTheme) {
        prevTheme = state.preferences.theme;
        applyTheme(state.preferences.theme);
      }
    });

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemChange = () => {
      const theme = useAppStore.getState().preferences.theme;
      if (theme === "system") applyTheme(theme);
    };

    mediaQuery.addEventListener("change", handleSystemChange);

    return () => {
      unsubscribe();
      mediaQuery.removeEventListener("change", handleSystemChange);
    };
  }, [mounted]);

  if (!mounted) return <LoadingSkeleton />;

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
                      <Navbar />
                      {children}
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
