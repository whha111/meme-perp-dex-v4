"use client";

import React from "react";
import { useTranslations } from "next-intl";

interface TierConfig {
  name: string;
  minInvites: number;
  minVolume: string;
  rebateBps: number;
  level2Bps: number;
}

interface TierProgressProps {
  currentTier: number;
  activeInvites: number;
  totalVolume: string;
  tierConfig: TierConfig[];
}

export function TierProgress({ currentTier, activeInvites, totalVolume, tierConfig }: TierProgressProps) {
  const t = useTranslations("referral");

  const tierColors = [
    "bg-[#CD7F32]", // Bronze
    "bg-[#C0C0C0]", // Silver
    "bg-[#FFD700]", // Gold
    "bg-[#B9F2FF]", // Diamond
  ];

  const tierTextColors = [
    "text-[#CD7F32]",
    "text-[#C0C0C0]",
    "text-[#FFD700]",
    "text-[#B9F2FF]",
  ];

  const nextTier = currentTier < 3 ? tierConfig[currentTier + 1] : null;
  const currentTierConfig = tierConfig[currentTier];

  // Calculate progress to next tier
  const inviteProgress = nextTier
    ? Math.min((activeInvites / nextTier.minInvites) * 100, 100)
    : 100;
  const volumeProgress = nextTier
    ? Math.min((parseFloat(totalVolume) / parseFloat(nextTier.minVolume)) * 100, 100)
    : 100;

  return (
    <div className="bg-okx-bg-card border border-okx-border-primary rounded-lg p-6">
      {/* Current Tier Display */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <span className="text-sm text-okx-text-secondary">{t("currentTier")}</span>
          <div className={`text-2xl font-bold ${tierTextColors[currentTier]}`}>
            {currentTierConfig.name}
          </div>
        </div>
        <div className="text-right">
          <span className="text-sm text-okx-text-secondary">{t("rebateRate")}</span>
          <div className="text-2xl font-bold text-okx-up">
            {(currentTierConfig.rebateBps / 100).toFixed(0)}%
          </div>
        </div>
      </div>

      {/* Tier Progress Bar */}
      <div className="flex items-center gap-1 mb-6">
        {tierConfig.map((tier, idx) => (
          <React.Fragment key={idx}>
            <div
              className={`flex-1 h-2 rounded-full ${
                idx <= currentTier ? tierColors[idx] : "bg-okx-bg-hover"
              }`}
            />
            {idx < tierConfig.length - 1 && <div className="w-1" />}
          </React.Fragment>
        ))}
      </div>

      {/* Tier Labels */}
      <div className="flex justify-between mb-6">
        {tierConfig.map((tier, idx) => (
          <div
            key={idx}
            className={`text-xs ${
              idx === currentTier ? tierTextColors[idx] + " font-bold" : "text-okx-text-tertiary"
            }`}
          >
            {tier.name}
          </div>
        ))}
      </div>

      {/* Progress to Next Tier */}
      {nextTier && (
        <div className="border-t border-okx-border-primary pt-4">
          <h4 className="text-sm font-medium mb-3">
            {t("progressToNextTier")}: <span className={tierTextColors[currentTier + 1]}>{nextTier.name}</span>
          </h4>

          <div className="grid grid-cols-2 gap-4">
            {/* Invite Progress */}
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-okx-text-secondary">{t("activeInvites")}</span>
                <span>{activeInvites} / {nextTier.minInvites}</span>
              </div>
              <div className="h-2 bg-okx-bg-hover rounded-full overflow-hidden">
                <div
                  className="h-full bg-okx-accent rounded-full transition-all"
                  style={{ width: `${inviteProgress}%` }}
                />
              </div>
            </div>

            {/* Volume Progress */}
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-okx-text-secondary">{t("tradeVolume")}</span>
                <span>{totalVolume} / {nextTier.minVolume} BNB</span>
              </div>
              <div className="h-2 bg-okx-bg-hover rounded-full overflow-hidden">
                <div
                  className="h-full bg-okx-accent rounded-full transition-all"
                  style={{ width: `${volumeProgress}%` }}
                />
              </div>
            </div>
          </div>

          <p className="text-xs text-okx-text-tertiary mt-2">
            {t("nextTierHint")}
          </p>
        </div>
      )}

      {currentTier === 3 && (
        <div className="border-t border-okx-border-primary pt-4 text-center">
          <div className="text-okx-up font-bold">{t("maxTierReached")}</div>
          <p className="text-xs text-okx-text-tertiary mt-1">{t("maxTierDesc")}</p>
        </div>
      )}
    </div>
  );
}
