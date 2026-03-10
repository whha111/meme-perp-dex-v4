"use client";

/**
 * useEarnings - 收益管理 Hook (真实链上数据版本)
 *
 * 从 TokenFactory 合约读取:
 * - 创建者收益: creatorEarnings(token) — 遍历用户创建的所有代币
 * - 推荐返佣: referrerEarnings(address)
 * - 排行榜: 从 getAllTokens + getTokenCreator + creatorEarnings 聚合
 * - 领取: claimCreatorEarnings(token) / claimReferrerEarnings()
 * - 绑定推荐人: setReferrer(address)
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  type UseReadContractsParameters,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatEther, type Address } from "viem";
import { CONTRACTS, TOKEN_FACTORY_ABI } from "@/lib/contracts";
import { extractErrorMessage } from "@/lib/errors/errorDictionary";
import { useToast } from "@/components/shared/Toast";

export interface EarningsData {
  creatorEarnings: string;       // ETH string
  referrerEarnings: string;      // ETH string
  platformEarnings: string;      // ETH string
  referrer: string | null;       // referrer address or null
  createdTokens: string[];       // token addresses created by user
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  earnings: string;
  tokenCount?: number;
  inviteCount?: number;
}

// ============================================================
// Internal: Read all tokens and their creators/earnings
// ============================================================

/**
 * useAllTokensEarnings - 批量读取所有代币的创建者和收益
 * 用于构建排行榜和判断用户创建了哪些代币
 */
function useAllTokensEarnings() {
  // Step 1: 获取所有代币地址
  const {
    data: allTokens,
    isLoading: isLoadingTokens,
    refetch: refetchTokens,
  } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "getAllTokens",
    query: {
      staleTime: 30_000,
    },
  });

  const tokenList = (allTokens as Address[]) || [];

  // Step 2: 批量读取每个代币的 creator 和 earnings
  // 构建 multicall 合约调用数组
  const contracts = useMemo(() => {
    if (tokenList.length === 0) return [];
    const calls: Array<{
      address: Address;
      abi: typeof TOKEN_FACTORY_ABI;
      functionName: string;
      args: [Address];
    }> = [];

    for (const token of tokenList) {
      // getTokenCreator(token)
      calls.push({
        address: CONTRACTS.TOKEN_FACTORY,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getTokenCreator",
        args: [token],
      });
      // creatorEarnings(token)
      calls.push({
        address: CONTRACTS.TOKEN_FACTORY,
        abi: TOKEN_FACTORY_ABI,
        functionName: "creatorEarnings",
        args: [token],
      });
    }
    return calls;
  }, [tokenList]);

  const {
    data: batchData,
    isLoading: isLoadingBatch,
    refetch: refetchBatch,
  } = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wagmi multicall 要求精确 ABI 元组类型，动态数组无法满足
    contracts: contracts as UseReadContractsParameters["contracts"],
    query: {
      enabled: contracts.length > 0,
      staleTime: 15_000,
    },
  });

  // Step 3: 解析结果 — 构建 tokenCreators 和 tokenEarnings maps
  const parsed = useMemo(() => {
    const tokenCreators = new Map<string, string>(); // token -> creator
    const tokenEarnings = new Map<string, bigint>(); // token -> earnings (wei)

    if (!batchData || batchData.length === 0) {
      return { tokenCreators, tokenEarnings, tokenList };
    }

    for (let i = 0; i < tokenList.length; i++) {
      const token = tokenList[i].toLowerCase();
      const creatorResult = batchData[i * 2];
      const earningsResult = batchData[i * 2 + 1];

      if (creatorResult?.status === "success" && creatorResult.result) {
        tokenCreators.set(token, (creatorResult.result as string).toLowerCase());
      }
      if (earningsResult?.status === "success" && earningsResult.result !== undefined) {
        tokenEarnings.set(token, earningsResult.result as bigint);
      }
    }

    return { tokenCreators, tokenEarnings, tokenList };
  }, [batchData, tokenList]);

  const refetch = useCallback(() => {
    refetchTokens();
    refetchBatch();
  }, [refetchTokens, refetchBatch]);

  return {
    ...parsed,
    isLoading: isLoadingTokens || isLoadingBatch,
    refetch,
  };
}

// ============================================================
// Main Hook
// ============================================================

export function useEarnings() {
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();
  const userAddr = address?.toLowerCase() || "";

  // ---- All tokens data (for leaderboard + user tokens) ----
  const {
    tokenCreators,
    tokenEarnings,
    tokenList,
    isLoading: isLoadingTokenData,
    refetch: refetchTokenData,
  } = useAllTokensEarnings();

  // ---- User's referrer earnings ----
  const {
    data: rawReferrerEarnings,
    isLoading: isLoadingReferrer,
    refetch: refetchReferrerEarnings,
  } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "referrerEarnings",
    args: address ? [address] : undefined,
    query: {
      enabled: !!address,
      staleTime: 15_000,
    },
  });

  // ---- User's referrer (who referred them) ----
  const {
    data: rawUserReferrer,
    isLoading: isLoadingUserReferrer,
    refetch: refetchUserReferrer,
  } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "userReferrer",
    args: address ? [address] : undefined,
    query: {
      enabled: !!address,
      staleTime: 60_000,
    },
  });

  // ---- Compute earnings data ----
  const earnings: EarningsData = useMemo(() => {
    // Find tokens created by current user and sum their earnings
    const createdTokens: string[] = [];
    let totalCreatorEarningsWei = 0n;

    if (userAddr) {
      for (const [token, creator] of tokenCreators.entries()) {
        if (creator === userAddr) {
          createdTokens.push(token);
          const earning = tokenEarnings.get(token) || 0n;
          totalCreatorEarningsWei += earning;
        }
      }
    }

    const referrerEarningsWei = (rawReferrerEarnings as bigint) || 0n;
    const referrerAddr = rawUserReferrer as string | undefined;
    const isZeroAddr = !referrerAddr || referrerAddr === "0x0000000000000000000000000000000000000000";

    return {
      creatorEarnings: formatEther(totalCreatorEarningsWei),
      referrerEarnings: formatEther(referrerEarningsWei),
      platformEarnings: "0",
      referrer: isZeroAddr ? null : referrerAddr,
      createdTokens,
    };
  }, [userAddr, tokenCreators, tokenEarnings, rawReferrerEarnings, rawUserReferrer]);

  // ---- Build leaderboards ----
  const creatorLeaderboard: LeaderboardEntry[] = useMemo(() => {
    // Aggregate earnings by creator address
    const creatorAggregated = new Map<string, { earnings: bigint; tokenCount: number }>();

    for (const [token, creator] of tokenCreators.entries()) {
      const earning = tokenEarnings.get(token) || 0n;
      const existing = creatorAggregated.get(creator) || { earnings: 0n, tokenCount: 0 };
      creatorAggregated.set(creator, {
        earnings: existing.earnings + earning,
        tokenCount: existing.tokenCount + 1,
      });
    }

    // Sort by earnings descending and take top 10
    const sorted = Array.from(creatorAggregated.entries())
      .filter(([_, data]) => data.earnings > 0n || data.tokenCount > 0)
      .sort((a, b) => {
        if (b[1].earnings > a[1].earnings) return 1;
        if (b[1].earnings < a[1].earnings) return -1;
        return b[1].tokenCount - a[1].tokenCount;
      })
      .slice(0, 10);

    return sorted.map(([addr, data], i) => ({
      rank: i + 1,
      address: addr,
      earnings: formatEther(data.earnings),
      tokenCount: data.tokenCount,
    }));
  }, [tokenCreators, tokenEarnings]);

  // Referral leaderboard - spot referral data from on-chain
  // NOTE: Full referral leaderboard (including perpetual) is fetched via usePerpReferral hook
  // On-chain has no way to enumerate all referrers, so this stays empty
  const referralLeaderboard: LeaderboardEntry[] = [];

  // ---- Claim creator earnings ----
  const {
    writeContractAsync: writeClaimCreator,
    isPending: isClaimingCreatorWrite,
  } = useWriteContract();
  const [claimCreatorTxHash, setClaimCreatorTxHash] = useState<`0x${string}` | null>(null);
  const { isLoading: isClaimCreatorConfirming, isSuccess: isClaimCreatorSuccess } =
    useWaitForTransactionReceipt({
      hash: claimCreatorTxHash ?? undefined,
      query: { enabled: !!claimCreatorTxHash },
    });

  const isClaimingCreator = isClaimingCreatorWrite || isClaimCreatorConfirming;

  // Claim creator earnings for ALL created tokens
  const claimCreatorEarnings = useCallback(async () => {
    if (!address || earnings.createdTokens.length === 0) return;

    try {
      // Claim each token's earnings
      for (const token of earnings.createdTokens) {
        const tokenEarning = tokenEarnings.get(token.toLowerCase()) || 0n;
        if (tokenEarning === 0n) continue; // Skip tokens with no earnings

        const hash = await writeClaimCreator({
          address: CONTRACTS.TOKEN_FACTORY,
          abi: TOKEN_FACTORY_ABI,
          functionName: "claimCreatorEarnings",
          args: [token as Address],
        });
        setClaimCreatorTxHash(hash);
        showToast(`领取创建者收益已提交`, "info");
      }
    } catch (e) {
      console.error("[useEarnings] claimCreatorEarnings error:", e);
      showToast(extractErrorMessage(e, "领取失败"), "error");
    }
  }, [address, earnings.createdTokens, tokenEarnings, writeClaimCreator, showToast]);

  // ---- Claim referrer earnings ----
  const {
    writeContractAsync: writeClaimReferrer,
    isPending: isClaimingReferrerWrite,
  } = useWriteContract();
  const [claimReferrerTxHash, setClaimReferrerTxHash] = useState<`0x${string}` | null>(null);
  const { isLoading: isClaimReferrerConfirming, isSuccess: isClaimReferrerSuccess } =
    useWaitForTransactionReceipt({
      hash: claimReferrerTxHash ?? undefined,
      query: { enabled: !!claimReferrerTxHash },
    });

  const isClaimingReferrer = isClaimingReferrerWrite || isClaimReferrerConfirming;

  const claimReferrerEarnings = useCallback(async () => {
    if (!address) return;
    try {
      const hash = await writeClaimReferrer({
        address: CONTRACTS.TOKEN_FACTORY,
        abi: TOKEN_FACTORY_ABI,
        functionName: "claimReferrerEarnings",
        args: [],
      });
      setClaimReferrerTxHash(hash);
      showToast("领取返佣收益已提交", "info");
    } catch (e) {
      console.error("[useEarnings] claimReferrerEarnings error:", e);
      showToast(extractErrorMessage(e, "领取失败"), "error");
    }
  }, [address, writeClaimReferrer, showToast]);

  // ---- Set referrer ----
  const {
    writeContractAsync: writeSetReferrer,
    isPending: isSettingReferrer,
  } = useWriteContract();
  const [setReferrerTxHash, setSetReferrerTxHash] = useState<`0x${string}` | null>(null);
  const { isSuccess: isSetReferrerSuccess } = useWaitForTransactionReceipt({
    hash: setReferrerTxHash ?? undefined,
    query: { enabled: !!setReferrerTxHash },
  });

  const setReferrer = useCallback(
    async (referrerAddress: string) => {
      if (!address) return;
      try {
        const hash = await writeSetReferrer({
          address: CONTRACTS.TOKEN_FACTORY,
          abi: TOKEN_FACTORY_ABI,
          functionName: "setReferrer",
          args: [referrerAddress as Address],
        });
        setSetReferrerTxHash(hash);
        showToast("绑定推荐人已提交", "info");
      } catch (e) {
        console.error("[useEarnings] setReferrer error:", e);
        showToast(extractErrorMessage(e, "绑定失败"), "error");
      }
    },
    [address, writeSetReferrer, showToast]
  );

  // ---- Refetch success callbacks ----
  useEffect(() => {
    if (isClaimCreatorSuccess) {
      showToast("创建者收益领取成功！", "success");
      refetchTokenData();
    }
  }, [isClaimCreatorSuccess, showToast, refetchTokenData]);

  useEffect(() => {
    if (isClaimReferrerSuccess) {
      showToast("返佣收益领取成功！", "success");
      refetchReferrerEarnings();
    }
  }, [isClaimReferrerSuccess, showToast, refetchReferrerEarnings]);

  useEffect(() => {
    if (isSetReferrerSuccess) {
      showToast("推荐人绑定成功！", "success");
      refetchUserReferrer();
    }
  }, [isSetReferrerSuccess, showToast, refetchUserReferrer]);

  // ---- Combined refetch ----
  const refetch = useCallback(() => {
    refetchTokenData();
    refetchReferrerEarnings();
    refetchUserReferrer();
  }, [refetchTokenData, refetchReferrerEarnings, refetchUserReferrer]);

  const isLoading = !isConnected ? false : (isLoadingTokenData || isLoadingReferrer || isLoadingUserReferrer);

  return {
    earnings,
    isLoading,
    error: null as Error | null,
    refetch,
    // Leaderboards
    creatorLeaderboard,
    referralLeaderboard,
    isLoadingLeaderboard: isLoadingTokenData,
    refetchLeaderboards: refetchTokenData,
    // Creator earnings
    claimCreatorEarnings,
    isClaimingCreator,
    isClaimCreatorSuccess,
    // Referrer earnings
    claimReferrerEarnings,
    isClaimingReferrer,
    isClaimReferrerSuccess,
    // Set referrer
    setReferrer,
    isSettingReferrer,
    isSetReferrerSuccess,
  };
}
