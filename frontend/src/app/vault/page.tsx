"use client";

import { useAccount } from "wagmi";
import { useTranslations } from "next-intl";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Navbar } from "@/components/layout/Navbar";
import { usePerpVaultLP } from "@/hooks/perpetual/usePerpVaultLP";
import { VaultDashboard } from "@/components/perpetual/VaultDashboard";
import { VaultActionPanel } from "@/components/perpetual/VaultActionPanel";
import { VaultPoolInfo } from "@/components/perpetual/VaultPoolInfo";

export default function VaultPage() {
  const t = useTranslations("vault");
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();

  const vault = usePerpVaultLP();

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
      <Navbar />

      <div className="max-w-[1200px] mx-auto px-4 py-6">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">{t("title")}</h1>
            <p className="text-okx-text-secondary text-sm mt-1">
              {t("subtitle")}
            </p>
          </div>
          {isConnected && (
            <button
              onClick={() => {
                vault.refetch();
                vault.refetchNative();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-okx-text-secondary border border-okx-border-primary hover:border-okx-border-secondary hover:text-okx-text-primary transition-colors"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Refresh
            </button>
          )}
        </div>

        {!isConnected ? (
          /* Not Connected */
          <div className="flex flex-col items-center justify-center py-20">
            <div className="max-w-md text-center">
              <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-okx-accent/20 to-okx-up/20 flex items-center justify-center">
                <svg
                  className="w-10 h-10 text-okx-accent"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-bold mb-2">{t("connectWallet")}</h2>
              <p className="text-okx-text-secondary text-sm mb-6 leading-relaxed">
                {t("connectWalletDesc")}
              </p>
              <button
                onClick={openConnectModal}
                className="bg-okx-accent text-black px-8 py-3 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity"
              >
                {t("connectWallet")}
              </button>
            </div>
          </div>
        ) : vault.isLoading ? (
          /* Loading skeleton */
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="bg-okx-bg-card border border-okx-border-primary rounded-xl p-4 animate-pulse"
                >
                  <div className="h-3 w-20 bg-okx-bg-hover rounded mb-3" />
                  <div className="h-6 w-24 bg-okx-bg-hover rounded" />
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Main Content */
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Left column: Dashboard + Pool Info */}
            <div className="lg:col-span-2 space-y-5">
              <VaultDashboard
                poolStats={vault.poolStats}
                userPosition={vault.userPosition}
                isConnected={isConnected}
              />
              <VaultPoolInfo
                poolStats={vault.poolStats}
                extendedStats={vault.extendedStats}
              />
            </div>

            {/* Right column: Action Panel */}
            <div className="lg:col-span-1">
              <VaultActionPanel vault={vault} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
