"use client";

/**
 * usePerpReferral - 永续合约返佣数据 Hook
 *
 * 从后端撮合引擎 API 获取合约交易的推荐返佣数据:
 * - 推荐人信息: /api/referral/referrer?address=
 * - 被邀请人信息: /api/referral/referee?address=
 * - 返佣记录: /api/referral/commissions?address=
 * - 推荐排行榜: /api/referral/leaderboard
 * - 注册推荐人: POST /api/referral/register
 * - 绑定邀请码: POST /api/referral/bind
 * - 提取返佣: POST /api/referral/withdraw
 *
 * 注意: 后端数据以 wei 单位的 bigint 字符串返回, display 字段为 USD 格式化
 */

import { useState, useCallback, useMemo } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { useToast } from "@/components/shared/Toast";

// ============================================================
// Types
// ============================================================

export interface PerpReferrerInfo {
  isReferrer: boolean;
  code: string;
  level1Referrals: number;
  level2Referrals: number;
  totalEarnings: string;       // wei string
  pendingEarnings: string;     // wei string
  withdrawnEarnings: string;   // wei string
  level1Earnings: string;      // wei string
  level2Earnings: string;      // wei string
  totalTradesReferred: number;
  totalVolumeReferred: string; // wei string
}

export interface PerpRefereeInfo {
  isReferred: boolean;
  referrer: string;
  referralCode: string;
  level2Referrer: string | null;
  totalFeesPaid: string;
  totalCommissionGenerated: string;
}

export interface PerpCommission {
  id: string;
  referee: string;
  level: 1 | 2;
  tradeId: string;
  tradeFee: string;
  commissionAmount: string;
  commissionRate: number;
  timestamp: number;
  status: "pending" | "credited" | "withdrawn";
  display: {
    tradeFee: string;
    commissionAmount: string;
    commissionRate: string;
  };
}

export interface PerpReferralLeaderboardEntry {
  rank: number;
  address: string;
  code: string;
  referralCount: number;
  totalEarnings: string;
  displayEarnings: string;
}

// ============================================================
// API Helpers
// ============================================================

async function fetchJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function postJSON(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ============================================================
// Main Hook
// ============================================================

export function usePerpReferral() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // ---- Fetch referrer info ----
  const {
    data: referrerData,
    isLoading: isLoadingReferrer,
    refetch: refetchReferrer,
  } = useQuery({
    queryKey: ["perpReferrer", address],
    queryFn: async () => {
      const data = await fetchJSON(
        `${MATCHING_ENGINE_URL}/api/referral/referrer?address=${address}`
      );
      if (!data.isReferrer) {
        return null;
      }
      return data.referrer as PerpReferrerInfo & { address: string };
    },
    enabled: !!address && isConnected,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // ---- Fetch referee info (who referred me) ----
  const {
    data: refereeData,
    isLoading: isLoadingReferee,
    refetch: refetchReferee,
  } = useQuery({
    queryKey: ["perpReferee", address],
    queryFn: async () => {
      const data = await fetchJSON(
        `${MATCHING_ENGINE_URL}/api/referral/referee?address=${address}`
      );
      if (!data.isReferred) return null;
      return data.referee as PerpRefereeInfo;
    },
    enabled: !!address && isConnected,
    staleTime: 30_000,
  });

  // ---- Fetch commission records ----
  const {
    data: commissionsData,
    isLoading: isLoadingCommissions,
    refetch: refetchCommissions,
  } = useQuery({
    queryKey: ["perpCommissions", address],
    queryFn: async () => {
      const data = await fetchJSON(
        `${MATCHING_ENGINE_URL}/api/referral/commissions?address=${address}&limit=20`
      );
      return (data.commissions || []) as PerpCommission[];
    },
    enabled: !!address && isConnected && !!referrerData,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // ---- Fetch referral leaderboard ----
  const {
    data: leaderboardData,
    isLoading: isLoadingLeaderboard,
    refetch: refetchLeaderboard,
  } = useQuery({
    queryKey: ["perpReferralLeaderboard"],
    queryFn: async () => {
      const data = await fetchJSON(
        `${MATCHING_ENGINE_URL}/api/referral/leaderboard?limit=10`
      );
      return ((data.leaderboard || []) as Array<{
        rank: number;
        address: string;
        code: string;
        referralCount: number;
        totalEarnings: string;
        display: { totalEarnings: string };
      }>).map((entry) => ({
        rank: entry.rank,
        address: entry.address,
        code: entry.code,
        referralCount: entry.referralCount,
        totalEarnings: entry.totalEarnings,
        displayEarnings: entry.display.totalEarnings,
      }));
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // ---- Register as referrer (get invite code) ----
  const registerMutation = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("No address");
      return postJSON(`${MATCHING_ENGINE_URL}/api/referral/register`, {
        address,
      });
    },
    onSuccess: () => {
      showToast("注册推荐人成功！", "success");
      refetchReferrer();
    },
    onError: (err: Error) => {
      showToast(err.message || "注册失败", "error");
    },
  });

  // ---- Bind referral code ----
  const bindMutation = useMutation({
    mutationFn: async (code: string) => {
      if (!address) throw new Error("No address");
      return postJSON(`${MATCHING_ENGINE_URL}/api/referral/bind`, {
        address,
        referralCode: code, // C-7: 后端期望 referralCode 而非 code
      });
    },
    onSuccess: () => {
      showToast("绑定邀请码成功！", "success");
      refetchReferee();
    },
    onError: (err: Error) => {
      showToast(err.message || "绑定失败", "error");
    },
  });

  // ---- Withdraw commission ----
  // C-3: 后端要求钱包签名鉴权，防止未授权提现
  const withdrawMutation = useMutation({
    mutationFn: async (amount: string | undefined) => {
      if (!address) throw new Error("No address");
      const normalizedAddr = address.toLowerCase();
      const withdrawMessage = `Withdraw commission${amount ? ` ${amount}` : ""} for ${normalizedAddr}`;
      const signature = await signMessageAsync({ message: withdrawMessage });
      return postJSON(`${MATCHING_ENGINE_URL}/api/referral/withdraw`, {
        address,
        amount,
        signature,
      });
    },
    onSuccess: (data) => {
      showToast(
        `提取返佣成功！金额: ${data.display?.withdrawnAmount || ""}`,
        "success"
      );
      refetchReferrer();
      refetchCommissions();
    },
    onError: (err: Error) => {
      showToast(err.message || "提取失败", "error");
    },
  });

  // ---- Computed values ----
  const perpEarnings = useMemo(() => {
    if (!referrerData) {
      return {
        totalEarnings: "0",
        pendingEarnings: "0",
        withdrawnEarnings: "0",
        level1Earnings: "0",
        level2Earnings: "0",
        referralCode: "",
        referralCount: 0,
        totalTradesReferred: 0,
      };
    }
    // Convert from wei string to ETH string (18 decimals)
    const toEth = (weiStr: string) => {
      try {
        const n = Number(weiStr) / 1e18;
        return n.toFixed(6);
      } catch {
        return "0";
      }
    };
    return {
      totalEarnings: toEth(referrerData.totalEarnings),
      pendingEarnings: toEth(referrerData.pendingEarnings),
      withdrawnEarnings: toEth(referrerData.withdrawnEarnings),
      level1Earnings: toEth(referrerData.level1Earnings),
      level2Earnings: toEth(referrerData.level2Earnings),
      referralCode: referrerData.code || "",
      referralCount:
        (referrerData.level1Referrals || 0) +
        (referrerData.level2Referrals || 0),
      totalTradesReferred: referrerData.totalTradesReferred || 0,
    };
  }, [referrerData]);

  // ---- Referral leaderboard formatted for the Leaderboard component ----
  const perpReferralLeaderboard = useMemo(() => {
    if (!leaderboardData) return [];
    return leaderboardData.map((entry) => ({
      rank: entry.rank,
      address: entry.address,
      // Convert wei to ETH
      earnings: (Number(entry.totalEarnings) / 1e18).toFixed(6),
      inviteCount: entry.referralCount,
    }));
  }, [leaderboardData]);

  // ---- Combined refetch ----
  const refetch = useCallback(() => {
    refetchReferrer();
    refetchReferee();
    refetchCommissions();
    refetchLeaderboard();
  }, [refetchReferrer, refetchReferee, refetchCommissions, refetchLeaderboard]);

  const isLoading =
    isLoadingReferrer || isLoadingReferee;

  return {
    // Referrer data
    perpEarnings,
    isReferrer: !!referrerData,
    referrerData,

    // Referee data (who referred me for perp trading)
    perpReferrer: refereeData?.referrer || null,
    perpReferralCode: refereeData?.referralCode || null,

    // Commissions
    commissions: commissionsData || [],
    isLoadingCommissions,

    // Leaderboard
    perpReferralLeaderboard,
    isLoadingLeaderboard,

    // Actions
    registerAsReferrer: registerMutation.mutateAsync,
    isRegistering: registerMutation.isPending,

    bindReferralCode: bindMutation.mutateAsync,
    isBinding: bindMutation.isPending,

    withdrawCommission: withdrawMutation.mutateAsync,
    isWithdrawing: withdrawMutation.isPending,

    // State
    isLoading,
    refetch,
  };
}
