"use client";

/**
 * usePerpVaultLP - PerpVault LP Pool Hook (GMX-style)
 *
 * Reads:
 * - Pool stats (value, shares, OI, utilization, fees)
 * - User LP position (shares, value, pending withdrawal)
 *
 * Writes:
 * - deposit() — deposit BNB as LP
 * - requestWithdrawal() — initiate 24h cooldown
 * - executeWithdrawal() — withdraw after cooldown
 * - cancelWithdrawal() — cancel pending withdrawal
 */

import { useMemo, useCallback } from "react";
import {
  useAccount,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
  useBalance,
} from "wagmi";
import { formatEther, parseEther, type Address } from "viem";
import { CONTRACTS } from "@/lib/contracts";

// ============================================================
// PerpVault ABI (LP functions only)
// ============================================================

const PERP_VAULT_LP_ABI = [
  // Read functions
  {
    name: "getPoolStats",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "poolValue", type: "uint256" },
      { name: "sharePrice", type: "uint256" },
      { name: "_totalShares", type: "uint256" },
      { name: "totalOI", type: "uint256" },
      { name: "maxOI", type: "uint256" },
      { name: "utilization", type: "uint256" },
      { name: "_totalFeesCollected", type: "uint256" },
      { name: "_totalProfitsPaid", type: "uint256" },
      { name: "_totalLossesReceived", type: "uint256" },
      { name: "_totalLiquidationReceived", type: "uint256" },
    ],
  },
  {
    name: "getExtendedStats",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_netPendingPnL", type: "int256" },
      { name: "rawBalance", type: "uint256" },
      { name: "_withdrawalCooldown", type: "uint256" },
      { name: "_maxPoolValue", type: "uint256" },
      { name: "_depositsPaused", type: "bool" },
      { name: "adlNeeded", type: "bool" },
      { name: "adlPnlBps", type: "uint256" },
    ],
  },
  {
    name: "shares",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getLPValue",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "lp", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getWithdrawalInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "lp", type: "address" }],
    outputs: [
      { name: "pendingShares", type: "uint256" },
      { name: "requestTime", type: "uint256" },
      { name: "executeAfter", type: "uint256" },
      { name: "estimatedETH", type: "uint256" },
    ],
  },
  {
    name: "getSharePrice",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "depositFeeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "withdrawalFeeBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "shouldADL",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "shouldTrigger", type: "bool" },
      { name: "pnlToPoolBps", type: "uint256" },
    ],
  },
  // Write functions
  {
    name: "deposit",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    name: "requestWithdrawal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "shareAmount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "executeWithdrawal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "cancelWithdrawal",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

const PERP_VAULT = CONTRACTS.PERP_VAULT;
const PRECISION = 10n ** 18n;
const FEE_PRECISION = 10000n;

// ============================================================
// Types
// ============================================================

export interface PoolStats {
  poolValue: bigint;
  sharePrice: bigint;
  totalShares: bigint;
  totalOI: bigint;
  maxOI: bigint;
  utilization: bigint;
  totalFeesCollected: bigint;
  totalProfitsPaid: bigint;
  totalLossesReceived: bigint;
  totalLiquidationReceived: bigint;
  // Formatted
  poolValueFormatted: string;
  sharePriceFormatted: string;
  utilizationPercent: string;
}

export interface ExtendedStats {
  netPendingPnL: bigint;
  rawBalance: bigint;
  withdrawalCooldown: bigint;
  maxPoolValue: bigint;
  depositsPaused: boolean;
  adlNeeded: boolean;
  adlPnlBps: bigint;
}

export interface WithdrawalInfo {
  pendingShares: bigint;
  requestTime: bigint;
  executeAfter: bigint;
  estimatedETH: bigint;
  canExecute: boolean;
  cooldownRemaining: number; // seconds
}

export interface UserLPPosition {
  shares: bigint;
  lpValue: bigint;
  sharesFormatted: string;
  lpValueFormatted: string;
  withdrawal: WithdrawalInfo;
}

// ============================================================
// Hook
// ============================================================

export function usePerpVaultLP() {
  const { address: userAddress, isConnected } = useAccount();
  const vaultAddress = PERP_VAULT;
  const enabled = !!vaultAddress && vaultAddress !== ("" as Address);

  // Native BNB balance for deposit max
  const { data: nativeBalance, refetch: refetchNative } = useBalance({
    address: userAddress,
    query: { enabled: isConnected },
  });

  // ── Multicall reads ────────────────────────────────────
  const contracts = useMemo(() => {
    if (!enabled) return [];
    const base = [
      {
        address: vaultAddress,
        abi: PERP_VAULT_LP_ABI,
        functionName: "getPoolStats" as const,
      },
      {
        address: vaultAddress,
        abi: PERP_VAULT_LP_ABI,
        functionName: "getExtendedStats" as const,
      },
      {
        address: vaultAddress,
        abi: PERP_VAULT_LP_ABI,
        functionName: "getSharePrice" as const,
      },
      {
        address: vaultAddress,
        abi: PERP_VAULT_LP_ABI,
        functionName: "depositFeeBps" as const,
      },
      {
        address: vaultAddress,
        abi: PERP_VAULT_LP_ABI,
        functionName: "withdrawalFeeBps" as const,
      },
    ];
    if (userAddress) {
      base.push(
        {
          address: vaultAddress,
          abi: PERP_VAULT_LP_ABI,
          functionName: "shares" as const,
          args: [userAddress],
        } as any,
        {
          address: vaultAddress,
          abi: PERP_VAULT_LP_ABI,
          functionName: "getLPValue" as const,
          args: [userAddress],
        } as any,
        {
          address: vaultAddress,
          abi: PERP_VAULT_LP_ABI,
          functionName: "getWithdrawalInfo" as const,
          args: [userAddress],
        } as any,
      );
    }
    return base;
  }, [vaultAddress, userAddress, enabled]);

  const {
    data: results,
    isLoading,
    refetch,
  } = useReadContracts({
    contracts: contracts as any,
    query: {
      enabled: enabled && contracts.length > 0,
      refetchInterval: 15_000,
    },
  });

  // ── Parse results ──────────────────────────────────────
  const poolStats = useMemo((): PoolStats | null => {
    if (!results?.[0]?.result) return null;
    const r = results[0].result as any[];
    const poolValue = BigInt(r[0] ?? 0);
    const sharePrice = BigInt(r[1] ?? 0);
    const utilization = BigInt(r[5] ?? 0);
    return {
      poolValue,
      sharePrice,
      totalShares: BigInt(r[2] ?? 0),
      totalOI: BigInt(r[3] ?? 0),
      maxOI: BigInt(r[4] ?? 0),
      utilization,
      totalFeesCollected: BigInt(r[6] ?? 0),
      totalProfitsPaid: BigInt(r[7] ?? 0),
      totalLossesReceived: BigInt(r[8] ?? 0),
      totalLiquidationReceived: BigInt(r[9] ?? 0),
      poolValueFormatted: formatBNB(poolValue),
      sharePriceFormatted: formatBNB(sharePrice),
      utilizationPercent: `${Number(utilization) / 100}%`,
    };
  }, [results]);

  const extendedStats = useMemo((): ExtendedStats | null => {
    if (!results?.[1]?.result) return null;
    const r = results[1].result as any[];
    return {
      netPendingPnL: BigInt(r[0] ?? 0),
      rawBalance: BigInt(r[1] ?? 0),
      withdrawalCooldown: BigInt(r[2] ?? 0),
      maxPoolValue: BigInt(r[3] ?? 0),
      depositsPaused: Boolean(r[4]),
      adlNeeded: Boolean(r[5]),
      adlPnlBps: BigInt(r[6] ?? 0),
    };
  }, [results]);

  const depositFeeBps = useMemo(() => {
    if (!results?.[3]?.result) return 50n;
    return BigInt(results[3].result as any);
  }, [results]);

  const withdrawalFeeBps = useMemo(() => {
    if (!results?.[4]?.result) return 50n;
    return BigInt(results[4].result as any);
  }, [results]);

  const userPosition = useMemo((): UserLPPosition | null => {
    if (!userAddress || !results?.[5]?.result) return null;
    const shares = BigInt((results[5].result as any) ?? 0);
    const lpValue = BigInt((results[6]?.result as any) ?? 0);
    const wInfo = results[7]?.result as any[];
    const now = Math.floor(Date.now() / 1000);
    const executeAfter = wInfo ? Number(BigInt(wInfo[2] ?? 0)) : 0;
    const cooldownRemaining = executeAfter > now ? executeAfter - now : 0;
    const pendingShares = wInfo ? BigInt(wInfo[0] ?? 0) : 0n;

    return {
      shares,
      lpValue,
      sharesFormatted: formatBNB(shares),
      lpValueFormatted: formatBNB(lpValue),
      withdrawal: {
        pendingShares,
        requestTime: wInfo ? BigInt(wInfo[1] ?? 0) : 0n,
        executeAfter: wInfo ? BigInt(wInfo[2] ?? 0) : 0n,
        estimatedETH: wInfo ? BigInt(wInfo[3] ?? 0) : 0n,
        canExecute: pendingShares > 0n && cooldownRemaining === 0,
        cooldownRemaining,
      },
    };
  }, [userAddress, results]);

  // ── Write functions ────────────────────────────────────
  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    reset: resetWrite,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({
      hash: txHash,
    });

  const deposit = useCallback(
    (amountWei: bigint) => {
      if (!enabled) return;
      writeContract({
        address: vaultAddress,
        abi: PERP_VAULT_LP_ABI,
        functionName: "deposit",
        value: amountWei,
      });
    },
    [writeContract, vaultAddress, enabled],
  );

  const requestWithdrawal = useCallback(
    (shareAmount: bigint) => {
      if (!enabled) return;
      writeContract({
        address: vaultAddress,
        abi: PERP_VAULT_LP_ABI,
        functionName: "requestWithdrawal",
        args: [shareAmount],
      });
    },
    [writeContract, vaultAddress, enabled],
  );

  const executeWithdrawal = useCallback(() => {
    if (!enabled) return;
    writeContract({
      address: vaultAddress,
      abi: PERP_VAULT_LP_ABI,
      functionName: "executeWithdrawal",
    });
  }, [writeContract, vaultAddress, enabled]);

  const cancelWithdrawal = useCallback(() => {
    if (!enabled) return;
    writeContract({
      address: vaultAddress,
      abi: PERP_VAULT_LP_ABI,
      functionName: "cancelWithdrawal",
    });
  }, [writeContract, vaultAddress, enabled]);

  // ── Helpers ────────────────────────────────────────────
  const estimateShares = useCallback(
    (depositAmountWei: bigint): bigint => {
      if (!poolStats || poolStats.totalShares === 0n || poolStats.poolValue === 0n) {
        // First depositor: 1:1 minus dead shares
        const fee = (depositAmountWei * depositFeeBps) / FEE_PRECISION;
        return depositAmountWei - fee - 1000n;
      }
      const fee = (depositAmountWei * depositFeeBps) / FEE_PRECISION;
      const net = depositAmountWei - fee;
      return (net * poolStats.totalShares) / poolStats.poolValue;
    },
    [poolStats, depositFeeBps],
  );

  const estimateWithdrawETH = useCallback(
    (shareAmount: bigint): bigint => {
      if (!poolStats || poolStats.sharePrice === 0n) return 0n;
      const gross = (shareAmount * poolStats.sharePrice) / PRECISION;
      const fee = (gross * withdrawalFeeBps) / FEE_PRECISION;
      return gross - fee;
    },
    [poolStats, withdrawalFeeBps],
  );

  return {
    // State
    poolStats,
    extendedStats,
    userPosition,
    depositFeeBps,
    withdrawalFeeBps,
    nativeBalance: nativeBalance?.value ?? 0n,
    isLoading,
    isWritePending,
    isConfirming,
    isConfirmed,
    isConnected,
    enabled,
    // Actions
    deposit,
    requestWithdrawal,
    executeWithdrawal,
    cancelWithdrawal,
    refetch,
    refetchNative,
    resetWrite,
    // Helpers
    estimateShares,
    estimateWithdrawETH,
  };
}

// ── Format helpers ───────────────────────────────────────

function formatBNB(wei: bigint): string {
  const val = Number(wei) / 1e18;
  if (val >= 1) return val.toFixed(4);
  if (val >= 0.0001) return val.toFixed(6);
  return val.toFixed(8);
}
