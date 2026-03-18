"use client";

/**
 * useDexSwap - PancakeSwap V2 Router DEX 交易 Hook
 *
 * 用于毕业后代币在 DEX 上的交易:
 * - getAmountsOut() 获取报价
 * - swapExactETHForTokens() 用 BNB 买入代币
 * - swapExactTokensForETH() 卖出代币获取 BNB
 */

import { useState, useCallback, useMemo } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { type Address, erc20Abi, formatUnits, parseUnits } from "viem";
import { CONTRACTS } from "@/lib/contracts";
import { devLog } from "@/lib/debug-logger";

// PancakeSwap V2 Router address (from env: NEXT_PUBLIC_ROUTER_ADDRESS)
const PANCAKE_ROUTER = CONTRACTS.ROUTER;
const WBNB = CONTRACTS.WETH;

// PancakeSwap V2 Router ABI (minimal — only functions we need)
const PANCAKE_V2_ROUTER_ABI = [
  {
    name: "swapExactETHForTokens",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "swapExactTokensForETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "WETH",
    type: "function",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "factory",
    type: "function",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

// PancakeSwap V2 Factory ABI (minimal)
const PANCAKE_V2_FACTORY_ABI = [
  {
    name: "getPair",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
    ],
    outputs: [{ name: "pair", type: "address" }],
  },
] as const;

// V2 Pair ABI (minimal)
const V2_PAIR_ABI = [
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "token1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export interface DexQuote {
  amountOut: bigint;
  amountOutFormatted: string;
  priceImpact: number;
  path: Address[];
}

export interface DexPoolInfo {
  pairAddress: Address;
  reserveToken: bigint;
  reserveBNB: bigint;
  price: number; // token price in BNB
  hasLiquidity: boolean;
}

/**
 * useDexQuote — 获取 DEX 报价 (read-only)
 */
export function useDexQuote(
  tokenAddress: Address | undefined,
  amountIn: bigint,
  isBuy: boolean
) {
  const path = useMemo(() => {
    if (!tokenAddress || !WBNB) return undefined;
    return isBuy
      ? [WBNB, tokenAddress] // BNB → Token
      : [tokenAddress, WBNB]; // Token → BNB
  }, [tokenAddress, isBuy]);

  const { data: amountsOut, isLoading, error, refetch } = useReadContract({
    address: PANCAKE_ROUTER,
    abi: PANCAKE_V2_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: path && amountIn > 0n ? [amountIn, path] : undefined,
    query: {
      enabled: !!path && amountIn > 0n && !!PANCAKE_ROUTER,
      refetchInterval: 10_000, // refresh every 10s
    },
  });

  const quote = useMemo((): DexQuote | null => {
    if (!amountsOut || !path || amountsOut.length < 2) return null;
    const amountOut = amountsOut[1];
    const decimals = isBuy ? 18 : 18; // both Token and BNB are 18 decimals
    return {
      amountOut,
      amountOutFormatted: formatUnits(amountOut, decimals),
      priceImpact: 0, // simplified — could compute from reserves
      path: path as Address[],
    };
  }, [amountsOut, path, isBuy]);

  return { quote, isLoading, error, refetch };
}

/**
 * useDexPoolInfo — 获取 DEX 流动性池信息
 */
export function useDexPoolInfo(tokenAddress: Address | undefined) {
  // Get factory address from router
  const { data: factoryAddress } = useReadContract({
    address: PANCAKE_ROUTER,
    abi: PANCAKE_V2_ROUTER_ABI,
    functionName: "factory",
    query: { enabled: !!PANCAKE_ROUTER },
  });

  // Get pair address from factory
  const { data: pairAddress } = useReadContract({
    address: factoryAddress as Address,
    abi: PANCAKE_V2_FACTORY_ABI,
    functionName: "getPair",
    args: tokenAddress && WBNB ? [tokenAddress, WBNB] : undefined,
    query: { enabled: !!factoryAddress && !!tokenAddress && !!WBNB },
  });

  // Get pair's token0
  const validPair = pairAddress && pairAddress !== ZERO_ADDRESS;
  const { data: token0 } = useReadContract({
    address: validPair ? (pairAddress as Address) : undefined,
    abi: V2_PAIR_ABI,
    functionName: "token0",
    query: { enabled: !!validPair },
  });

  // Get reserves
  const { data: reserves, isLoading } = useReadContract({
    address: validPair ? (pairAddress as Address) : undefined,
    abi: V2_PAIR_ABI,
    functionName: "getReserves",
    query: {
      enabled: !!validPair,
      refetchInterval: 15_000,
    },
  });

  const poolInfo = useMemo((): DexPoolInfo | null => {
    if (!validPair || !reserves || !token0 || !tokenAddress) return null;

    const [reserve0, reserve1] = reserves;
    const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
    const reserveToken = isToken0 ? reserve0 : reserve1;
    const reserveBNB = isToken0 ? reserve1 : reserve0;

    // price = reserveBNB / reserveToken
    const price =
      reserveToken > 0n
        ? Number(reserveBNB) / Number(reserveToken)
        : 0;

    return {
      pairAddress: pairAddress as Address,
      reserveToken,
      reserveBNB,
      price,
      hasLiquidity: reserveToken > 0n && reserveBNB > 0n,
    };
  }, [validPair, reserves, token0, tokenAddress, pairAddress]);

  return { poolInfo, isLoading };
}

/**
 * useDexSwap — 执行 DEX 交易
 */
export function useDexSwap() {
  const { address } = useAccount();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const {
    writeContractAsync,
    isPending: isWritePending,
    error: writeError,
    reset: resetWrite,
  } = useWriteContract();

  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    error: confirmError,
  } = useWaitForTransactionReceipt({ hash: txHash });

  const isPending = isWritePending || isConfirming;

  // Buy tokens with BNB
  const buyTokens = useCallback(
    async (params: {
      tokenAddress: Address;
      amountInBNB: bigint;
      amountOutMin: bigint;
      deadlineSeconds?: number;
    }) => {
      if (!address || !PANCAKE_ROUTER || !WBNB) {
        throw new Error("Wallet not connected or router not configured");
      }

      const deadline = BigInt(
        Math.floor(Date.now() / 1000) + (params.deadlineSeconds || 1200)
      );
      const path = [WBNB, params.tokenAddress] as const;

      devLog.info("[DexSwap] Buying tokens", {
        amountIn: formatUnits(params.amountInBNB, 18),
        amountOutMin: formatUnits(params.amountOutMin, 18),
        path,
      });

      const hash = await writeContractAsync({
        address: PANCAKE_ROUTER,
        abi: PANCAKE_V2_ROUTER_ABI,
        functionName: "swapExactETHForTokens",
        args: [params.amountOutMin, [...path], address, deadline],
        value: params.amountInBNB,
      });

      setTxHash(hash);
      return hash;
    },
    [address, writeContractAsync]
  );

  // Sell tokens for BNB
  const sellTokens = useCallback(
    async (params: {
      tokenAddress: Address;
      amountIn: bigint;
      amountOutMin: bigint;
      deadlineSeconds?: number;
    }) => {
      if (!address || !PANCAKE_ROUTER || !WBNB) {
        throw new Error("Wallet not connected or router not configured");
      }

      const deadline = BigInt(
        Math.floor(Date.now() / 1000) + (params.deadlineSeconds || 1200)
      );
      const path = [params.tokenAddress, WBNB] as const;

      devLog.info("[DexSwap] Selling tokens", {
        amountIn: formatUnits(params.amountIn, 18),
        amountOutMin: formatUnits(params.amountOutMin, 18),
        path,
      });

      const hash = await writeContractAsync({
        address: PANCAKE_ROUTER,
        abi: PANCAKE_V2_ROUTER_ABI,
        functionName: "swapExactTokensForETH",
        args: [params.amountIn, params.amountOutMin, [...path], address, deadline],
      });

      setTxHash(hash);
      return hash;
    },
    [address, writeContractAsync]
  );

  const reset = useCallback(() => {
    setTxHash(undefined);
    resetWrite();
  }, [resetWrite]);

  return {
    buyTokens,
    sellTokens,
    isPending,
    isConfirming,
    isConfirmed,
    txHash,
    error: writeError || confirmError,
    reset,
  };
}

/**
 * useTokenAllowance — 检查 ERC20 approve 状态
 */
export function useTokenAllowance(
  tokenAddress: Address | undefined,
  spender: Address | undefined
) {
  const { address } = useAccount();

  const { data: allowance, refetch } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && spender ? [address, spender] : undefined,
    query: { enabled: !!address && !!tokenAddress && !!spender },
  });

  const {
    writeContractAsync: approveAsync,
    isPending: isApproving,
  } = useWriteContract();

  const approve = useCallback(
    async (amount: bigint) => {
      if (!tokenAddress || !spender) throw new Error("Missing token or spender");
      const hash = await approveAsync({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, amount],
      });
      return hash;
    },
    [tokenAddress, spender, approveAsync]
  );

  return {
    allowance: allowance ?? 0n,
    approve,
    isApproving,
    refetchAllowance: refetch,
  };
}
