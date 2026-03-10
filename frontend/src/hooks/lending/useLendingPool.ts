"use client";

/**
 * useLendingPool - LendingPool Multi-Token Lending Hook
 *
 * Reads from LendingPool contract:
 * - Enabled tokens list + pool info (TVL, utilization, APY)
 * - User positions (deposits, shares, pending interest)
 *
 * Write actions:
 * - deposit(token, amount) — deposit meme tokens
 * - withdraw(token, shares) — withdraw by shares
 * - claimInterest(token) — claim accrued interest
 * - approve(token) — ERC20 approve for LendingPool
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
import { formatUnits, parseUnits, maxUint256, type Address } from "viem";
import { CONTRACTS, ERC20_ABI } from "@/lib/contracts";
import { useToast } from "@/components/shared/Toast";
import { extractErrorMessage } from "@/lib/errors/errorDictionary";
import LendingPoolABIImport from "@/abis/LendingPool.json";

const LendingPoolABI = LendingPoolABIImport.abi;
const LENDING_POOL = CONTRACTS.LENDING_POOL;
const PRECISION = 10n ** 18n;

// ============================================================
// Types
// ============================================================

export interface PoolInfo {
  token: Address;
  tokenName: string;
  tokenSymbol: string;
  enabled: boolean;
  totalDeposits: bigint;
  totalBorrowed: bigint;
  totalShares: bigint;
  utilization: bigint;
  borrowRate: bigint;
  supplyRate: bigint;
  reserves: bigint;
  availableLiquidity: bigint;
  // Formatted display values
  totalDepositsFormatted: string;
  totalBorrowedFormatted: string;
  availableLiquidityFormatted: string;
  utilizationPercent: string;
  borrowAPY: string;
  supplyAPY: string;
}

export interface UserLendingPosition {
  token: Address;
  tokenName: string;
  tokenSymbol: string;
  depositAmount: bigint;
  shares: bigint;
  pendingInterest: bigint;
  depositAmountFormatted: string;
  pendingInterestFormatted: string;
}

// ============================================================
// Helpers
// ============================================================

/** Format rate from 1e18 scale to percentage string (e.g. "3.80") */
function formatRate(rate: bigint): string {
  // rate: 1e18 = 100%
  const percent = Number(rate) / 1e16; // Convert to percentage
  return percent.toFixed(2);
}

/** Format token amount (18 decimals) to display string */
function formatTokenAmount(amount: bigint): string {
  const formatted = formatUnits(amount, 18);
  const num = parseFloat(formatted);
  if (num === 0) return "0";
  if (num < 0.0001) return "<0.0001";
  if (num < 1) return num.toFixed(4);
  if (num < 1000) return num.toFixed(2);
  if (num < 1_000_000) return (num / 1000).toFixed(2) + "K";
  return (num / 1_000_000).toFixed(2) + "M";
}

// ============================================================
// Main Hook
// ============================================================

export function useLendingPool() {
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();

  // ── State ──────────────────────────────────────────────────
  const [selectedToken, setSelectedToken] = useState<Address | null>(null);

  // ── Step 1: Get enabled tokens list ────────────────────────
  const {
    data: enabledTokensRaw,
    isLoading: isLoadingTokenList,
    refetch: refetchTokenList,
  } = useReadContract({
    address: LENDING_POOL,
    abi: LendingPoolABI,
    functionName: "getEnabledTokens",
    query: {
      staleTime: 15_000,
      refetchInterval: 30_000,
    },
  });

  const enabledTokens = useMemo(
    () => (enabledTokensRaw as Address[]) || [],
    [enabledTokensRaw]
  );

  // ── Step 2: Batch read pool info + token metadata ──────────
  const poolInfoCalls = useMemo(() => {
    if (enabledTokens.length === 0) return [];
    // wagmi useReadContracts 的泛型要求精确 ABI 元组类型
    // 动态构建时无法满足，定义结构化数组后在 useReadContracts 处断言
    const calls: { address: Address; abi: typeof LendingPoolABI | typeof ERC20_ABI; functionName: string; args?: Address[] }[] = [];
    for (const token of enabledTokens) {
      // getPoolInfo(token)
      calls.push({
        address: LENDING_POOL,
        abi: LendingPoolABI,
        functionName: "getPoolInfo",
        args: [token],
      });
      // getAvailableLiquidity(token)
      calls.push({
        address: LENDING_POOL,
        abi: LendingPoolABI,
        functionName: "getAvailableLiquidity",
        args: [token],
      });
      // ERC20 name()
      calls.push({
        address: token,
        abi: ERC20_ABI,
        functionName: "name",
      });
      // ERC20 symbol()
      calls.push({
        address: token,
        abi: ERC20_ABI,
        functionName: "symbol",
      });
    }
    return calls;
  }, [enabledTokens]);

  const {
    data: poolInfoResults,
    isLoading: isLoadingPoolInfo,
    refetch: refetchPoolInfo,
  } = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wagmi multicall 要求精确 ABI 元组类型，动态数组无法满足
    contracts: poolInfoCalls as UseReadContractsParameters["contracts"],
    query: {
      enabled: poolInfoCalls.length > 0,
      staleTime: 15_000,
      refetchInterval: 15_000,
    },
  });

  // Parse pool info results
  const pools: PoolInfo[] = useMemo(() => {
    if (!poolInfoResults || enabledTokens.length === 0) return [];
    const result: PoolInfo[] = [];

    for (let i = 0; i < enabledTokens.length; i++) {
      const base = i * 4; // 4 calls per token
      const poolInfoData = poolInfoResults[base];
      const liquidityData = poolInfoResults[base + 1];
      const nameData = poolInfoResults[base + 2];
      const symbolData = poolInfoResults[base + 3];

      if (poolInfoData?.status !== "success") continue;

      const [enabled, totalDeposits, totalBorrowed, totalShares, utilization, borrowRate, supplyRate, reserves] =
        poolInfoData.result as [boolean, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

      const availableLiquidity = (liquidityData?.status === "success" ? liquidityData.result : 0n) as bigint;
      const tokenName = (nameData?.status === "success" ? nameData.result : "Unknown") as string;
      const tokenSymbol = (symbolData?.status === "success" ? symbolData.result : "???") as string;

      result.push({
        token: enabledTokens[i],
        tokenName,
        tokenSymbol,
        enabled,
        totalDeposits,
        totalBorrowed,
        totalShares,
        utilization,
        borrowRate,
        supplyRate,
        reserves,
        availableLiquidity,
        totalDepositsFormatted: formatTokenAmount(totalDeposits),
        totalBorrowedFormatted: formatTokenAmount(totalBorrowed),
        availableLiquidityFormatted: formatTokenAmount(availableLiquidity),
        utilizationPercent: formatRate(utilization),
        borrowAPY: formatRate(borrowRate),
        supplyAPY: formatRate(supplyRate),
      });
    }

    return result;
  }, [poolInfoResults, enabledTokens]);

  // ── Step 3: Batch read user positions ──────────────────────
  const userCalls = useMemo(() => {
    if (!address || enabledTokens.length === 0) return [];
    const calls: { address: Address; abi: typeof LendingPoolABI; functionName: string; args: readonly [Address, Address] }[] = [];
    for (const token of enabledTokens) {
      calls.push({
        address: LENDING_POOL,
        abi: LendingPoolABI,
        functionName: "getUserDeposit",
        args: [token, address],
      });
      calls.push({
        address: LENDING_POOL,
        abi: LendingPoolABI,
        functionName: "getUserShares",
        args: [token, address],
      });
      calls.push({
        address: LENDING_POOL,
        abi: LendingPoolABI,
        functionName: "getUserPendingInterest",
        args: [token, address],
      });
    }
    return calls;
  }, [address, enabledTokens]);

  const {
    data: userResults,
    isLoading: isLoadingUserData,
    refetch: refetchUserData,
  } = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wagmi multicall 同上
    contracts: userCalls as UseReadContractsParameters["contracts"],
    query: {
      enabled: userCalls.length > 0,
      staleTime: 15_000,
      refetchInterval: 15_000,
    },
  });

  // Parse user positions
  const positions: UserLendingPosition[] = useMemo(() => {
    if (!userResults || enabledTokens.length === 0) return [];
    const result: UserLendingPosition[] = [];

    for (let i = 0; i < enabledTokens.length; i++) {
      const base = i * 3;
      const depositData = userResults[base];
      const sharesData = userResults[base + 1];
      const interestData = userResults[base + 2];

      const depositAmount = (depositData?.status === "success" ? depositData.result : 0n) as bigint;
      const shares = (sharesData?.status === "success" ? sharesData.result : 0n) as bigint;
      const pendingInterest = (interestData?.status === "success" ? interestData.result : 0n) as bigint;

      // Only include tokens where user has deposits or interest
      if (depositAmount === 0n && pendingInterest === 0n) continue;

      // Find pool info for name/symbol
      const pool = pools.find((p) => p.token === enabledTokens[i]);

      result.push({
        token: enabledTokens[i],
        tokenName: pool?.tokenName || "Unknown",
        tokenSymbol: pool?.tokenSymbol || "???",
        depositAmount,
        shares,
        pendingInterest,
        depositAmountFormatted: formatTokenAmount(depositAmount),
        pendingInterestFormatted: formatTokenAmount(pendingInterest),
      });
    }

    return result;
  }, [userResults, enabledTokens, pools]);

  // ── Step 4: Selected token data ────────────────────────────

  // ERC20 balance
  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: selectedToken ?? undefined,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!selectedToken },
  });

  // ERC20 allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: selectedToken ?? undefined,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, LENDING_POOL] : undefined,
    query: { enabled: !!address && !!selectedToken },
  });

  const needsApproval = useCallback(
    (amount: bigint) => {
      if (!allowance) return true;
      return (allowance as bigint) < amount;
    },
    [allowance]
  );

  // ── Step 5: Write actions ──────────────────────────────────

  // --- Approve ---
  const {
    writeContractAsync: writeApprove,
    isPending: isApprovePending,
    data: approveHash,
  } = useWriteContract();

  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } =
    useWaitForTransactionReceipt({
      hash: approveHash,
      query: { enabled: !!approveHash },
    });

  const approve = useCallback(
    async (token: Address) => {
      try {
        await writeApprove({
          address: token,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [LENDING_POOL, maxUint256],
        });
        showToast("Approval submitted...", "info");
      } catch (err) {
        showToast(extractErrorMessage(err, "Approval failed"), "error");
        throw err;
      }
    },
    [writeApprove, showToast]
  );

  useEffect(() => {
    if (isApproveSuccess) {
      showToast("Approval confirmed!", "success");
      refetchAllowance();
    }
  }, [isApproveSuccess, showToast, refetchAllowance]);

  // --- Deposit ---
  const {
    writeContractAsync: writeDeposit,
    isPending: isDepositPending,
    data: depositHash,
  } = useWriteContract();

  const { isLoading: isDepositConfirming, isSuccess: isDepositSuccess } =
    useWaitForTransactionReceipt({
      hash: depositHash,
      query: { enabled: !!depositHash },
    });

  const deposit = useCallback(
    async (token: Address, amount: bigint) => {
      try {
        await writeDeposit({
          address: LENDING_POOL,
          abi: LendingPoolABI,
          functionName: "deposit",
          args: [token, amount],
        });
        showToast("Deposit submitted...", "info");
      } catch (err) {
        showToast(extractErrorMessage(err, "Deposit failed"), "error");
        throw err;
      }
    },
    [writeDeposit, showToast]
  );

  useEffect(() => {
    if (isDepositSuccess) {
      showToast("Deposit successful!", "success");
      refetchAll();
    }
  }, [isDepositSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Withdraw ---
  const {
    writeContractAsync: writeWithdraw,
    isPending: isWithdrawPending,
    data: withdrawHash,
  } = useWriteContract();

  const { isLoading: isWithdrawConfirming, isSuccess: isWithdrawSuccess } =
    useWaitForTransactionReceipt({
      hash: withdrawHash,
      query: { enabled: !!withdrawHash },
    });

  const withdraw = useCallback(
    async (token: Address, shares: bigint) => {
      try {
        await writeWithdraw({
          address: LENDING_POOL,
          abi: LendingPoolABI,
          functionName: "withdraw",
          args: [token, shares],
        });
        showToast("Withdrawal submitted...", "info");
      } catch (err) {
        showToast(extractErrorMessage(err, "Withdrawal failed"), "error");
        throw err;
      }
    },
    [writeWithdraw, showToast]
  );

  useEffect(() => {
    if (isWithdrawSuccess) {
      showToast("Withdrawal successful!", "success");
      refetchAll();
    }
  }, [isWithdrawSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Claim Interest ---
  const {
    writeContractAsync: writeClaim,
    isPending: isClaimPending,
    data: claimHash,
  } = useWriteContract();

  const { isLoading: isClaimConfirming, isSuccess: isClaimSuccess } =
    useWaitForTransactionReceipt({
      hash: claimHash,
      query: { enabled: !!claimHash },
    });

  const claimInterest = useCallback(
    async (token: Address) => {
      try {
        await writeClaim({
          address: LENDING_POOL,
          abi: LendingPoolABI,
          functionName: "claimInterest",
          args: [token],
        });
        showToast("Claim submitted...", "info");
      } catch (err) {
        showToast(extractErrorMessage(err, "Claim failed"), "error");
        throw err;
      }
    },
    [writeClaim, showToast]
  );

  useEffect(() => {
    if (isClaimSuccess) {
      showToast("Interest claimed!", "success");
      refetchAll();
    }
  }, [isClaimSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Refetch all ────────────────────────────────────────────
  const refetchAll = useCallback(() => {
    refetchTokenList();
    refetchPoolInfo();
    refetchUserData();
    refetchBalance();
    refetchAllowance();
  }, [refetchTokenList, refetchPoolInfo, refetchUserData, refetchBalance, refetchAllowance]);

  // ── Return ─────────────────────────────────────────────────
  return {
    // Pool data
    pools,
    isLoadingPools: isLoadingTokenList || isLoadingPoolInfo,

    // User positions
    positions,
    isLoadingPositions: isLoadingUserData,

    // Selected token
    selectedToken,
    setSelectedToken,

    // Token balance & allowance for selected token
    tokenBalance: (tokenBalance as bigint) ?? 0n,
    allowance: (allowance as bigint) ?? 0n,
    needsApproval,

    // Actions
    approve,
    isApproving: isApprovePending || isApproveConfirming,

    deposit,
    isDepositing: isDepositPending || isDepositConfirming,

    withdraw,
    isWithdrawing: isWithdrawPending || isWithdrawConfirming,

    claimInterest,
    isClaiming: isClaimPending || isClaimConfirming,

    // Refetch
    refetch: refetchAll,
  };
}
