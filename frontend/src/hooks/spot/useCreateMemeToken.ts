"use client";

import { useState, useCallback } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from "wagmi";
import { parseEther, type Hash, type Address, decodeEventLog } from "viem";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/shared/Toast";
import { CONTRACTS, TOKEN_FACTORY_ABI } from "@/lib/contracts";

/**
 * Pool State 结构
 */
export interface PoolState {
  realETHReserve: bigint;
  realTokenReserve: bigint;
  soldTokens: bigint;
  isGraduated: boolean;
  isActive: boolean;
  creator: Address;
  createdAt: bigint;
  metadataURI: string;
}

/**
 * 创建代币参数
 */
export interface CreateTokenParams {
  name: string;
  symbol: string;
  metadataURI: string;
  initialBuyEth?: string; // 可选的初始购买金额
}

/**
 * 默认服务费 (ETH)
 */
const DEFAULT_SERVICE_FEE = "0.001";

/**
 * Hook for creating meme tokens via TokenFactory
 *
 * @example
 * ```tsx
 * const { createToken, isPending, txHash, error } = useCreateMemeToken();
 *
 * const handleCreate = async () => {
 *   await createToken({
 *     name: "My Meme Token",
 *     symbol: "MEME",
 *     metadataURI: "ipfs://...",
 *     initialBuyEth: "0.1", // 可选
 *   });
 * };
 * ```
 */
export function useCreateMemeToken() {
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();
  const t = useTranslations("hooks");

  const [txHash, setTxHash] = useState<Hash | undefined>();
  const [step, setStep] = useState<"idle" | "creating" | "confirming" | "done">("idle");
  const [createdTokenAddress, setCreatedTokenAddress] = useState<Address | undefined>();

  // 检查合约是否已配置
  const isContractConfigured = CONTRACTS.TOKEN_FACTORY !== "0x0000000000000000000000000000000000000000";

  // 读取服务费（仅在合约已配置时）
  const { data: serviceFeeData } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "serviceFee",
    query: {
      enabled: isContractConfigured,
    },
  });

  const serviceFee = serviceFeeData ? serviceFeeData as bigint : parseEther(DEFAULT_SERVICE_FEE);

  // 写入合约 hook
  const {
    writeContractAsync,
    isPending: isWritePending,
    error: writeError,
  } = useWriteContract();

  // 等待交易确认
  const {
    isLoading: isConfirming,
    isSuccess: isReceiptReceived,
    data: receipt,
  } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // 交易成功状态
  const isConfirmed = isReceiptReceived && receipt?.status === "success";
  const isTransactionFailed = isReceiptReceived && receipt?.status === "reverted";

  // 从 receipt 中解析创建的代币地址
  const parseCreatedTokenAddress = useCallback((txReceipt: { logs: readonly { data: `0x${string}`; topics: readonly `0x${string}`[]; address: `0x${string}` }[] } | null) => {
    if (!txReceipt?.logs) return undefined;

    for (const log of txReceipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: TOKEN_FACTORY_ABI,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });

        if (decoded.eventName === "TokenCreated") {
          const args = decoded.args as unknown as { tokenAddress: Address };
          return args.tokenAddress;
        }
      } catch {
        // 忽略解析失败的日志
      }
    }
    return undefined;
  }, []);

  /**
   * 创建代币
   */
  const createToken = useCallback(async (params: CreateTokenParams): Promise<{ hash: Hash; tokenAddress?: Address }> => {
    if (!address) {
      throw new Error(t("connectWalletFirst"));
    }

    if (!isConnected) {
      throw new Error(t("walletNotConnected"));
    }

    if (CONTRACTS.TOKEN_FACTORY === "0x0000000000000000000000000000000000000000") {
      throw new Error(t("tokenFactoryNotConfigured"));
    }

    setStep("creating");
    setCreatedTokenAddress(undefined);

    try {
      // 计算总价值：服务费 + 初始购买金额
      const initialBuy = params.initialBuyEth ? parseEther(params.initialBuyEth) : 0n;
      const totalValue = serviceFee + initialBuy;

      console.log("Creating token with params:", {
        name: params.name,
        symbol: params.symbol,
        metadataURI: params.metadataURI,
        serviceFee: serviceFee.toString(),
        initialBuy: initialBuy.toString(),
        totalValue: totalValue.toString(),
      });

      // 调用合约
      const hash = await writeContractAsync({
        address: CONTRACTS.TOKEN_FACTORY,
        abi: TOKEN_FACTORY_ABI,
        functionName: "createToken",
        args: [
          params.name,
          params.symbol,
          params.metadataURI,
          0n, // minTokensOut - 可以根据需要添加滑点保护
        ],
        value: totalValue,
      });

      setTxHash(hash);
      setStep("confirming");

      showToast(t("txSubmittedWaiting"), "info");

      return { hash };
    } catch (error) {
      setStep("idle");
      console.error("Create token error:", error);
      throw error;
    }
  }, [address, isConnected, serviceFee, writeContractAsync, showToast, t]);

  // 当 receipt 更新时解析代币地址
  if (receipt && isConfirmed && !createdTokenAddress) {
    const tokenAddress = parseCreatedTokenAddress(receipt);
    if (tokenAddress) {
      setCreatedTokenAddress(tokenAddress);
      setStep("done");
    }
  }

  // 重置状态
  const reset = useCallback(() => {
    setTxHash(undefined);
    setStep("idle");
    setCreatedTokenAddress(undefined);
  }, []);

  return {
    // 主要方法
    createToken,

    // 状态
    isPending: isWritePending,
    isConfirming,
    isConfirmed,
    isTransactionFailed,
    step,
    txHash,
    createdTokenAddress,
    receipt,
    error: writeError,

    // 重置
    reset,

    // 费用信息
    serviceFee,
    serviceFeeEth: DEFAULT_SERVICE_FEE,
  };
}

/**
 * Hook for buying tokens from bonding curve
 */
export function useBuyToken() {
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();
  const t = useTranslations("hooks");

  const [txHash, setTxHash] = useState<Hash | undefined>();

  const {
    writeContractAsync,
    isPending,
    error,
  } = useWriteContract();

  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    data: receipt,
  } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const buy = useCallback(async (tokenAddress: Address, ethAmount: string, minTokensOut: bigint = 0n) => {
    if (!address || !isConnected) {
      throw new Error(t("connectWalletFirst"));
    }

    const value = parseEther(ethAmount);

    const hash = await writeContractAsync({
      address: CONTRACTS.TOKEN_FACTORY,
      abi: TOKEN_FACTORY_ABI,
      functionName: "buy",
      args: [tokenAddress, minTokensOut],
      value,
    });

    setTxHash(hash);
    showToast(t("buyTxSubmitted"), "info");

    return hash;
  }, [address, isConnected, writeContractAsync, showToast, t]);

  const reset = useCallback(() => {
    setTxHash(undefined);
  }, []);

  return {
    buy,
    isPending,
    isConfirming,
    isConfirmed,
    txHash,
    receipt,
    error,
    reset,
  };
}

/**
 * Hook for selling tokens on bonding curve
 */
export function useSellToken() {
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();
  const t = useTranslations("hooks");

  const [txHash, setTxHash] = useState<Hash | undefined>();

  const {
    writeContractAsync,
    isPending,
    error,
  } = useWriteContract();

  const {
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    data: receipt,
  } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const sell = useCallback(async (tokenAddress: Address, tokenAmount: bigint, minETHOut: bigint = 0n) => {
    if (!address || !isConnected) {
      throw new Error(t("connectWalletFirst"));
    }

    const hash = await writeContractAsync({
      address: CONTRACTS.TOKEN_FACTORY,
      abi: TOKEN_FACTORY_ABI,
      functionName: "sell",
      args: [tokenAddress, tokenAmount, minETHOut],
    });

    setTxHash(hash);
    showToast(t("sellTxSubmitted"), "info");

    return hash;
  }, [address, isConnected, writeContractAsync, showToast, t]);

  const reset = useCallback(() => {
    setTxHash(undefined);
  }, []);

  return {
    sell,
    isPending,
    isConfirming,
    isConfirmed,
    txHash,
    receipt,
    error,
    reset,
  };
}

/**
 * Hook for reading pool state
 */
export function usePoolState(tokenAddress: Address | undefined) {
  const { data, isLoading, error, refetch } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "getPoolState",
    args: tokenAddress ? [tokenAddress] : undefined,
    query: {
      enabled: !!tokenAddress,
    },
  });

  return {
    poolState: data as PoolState | undefined,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Hook for getting current token price
 */
export function useTokenPrice(tokenAddress: Address | undefined) {
  const { data, isLoading, error, refetch } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "getCurrentPrice",
    args: tokenAddress ? [tokenAddress] : undefined,
    query: {
      enabled: !!tokenAddress,
    },
  });

  return {
    price: data as bigint | undefined,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Hook for previewing buy amount
 */
export function usePreviewBuy(tokenAddress: Address | undefined, ethIn: bigint) {
  const { data, isLoading, error } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "previewBuy",
    args: tokenAddress ? [tokenAddress, ethIn] : undefined,
    query: {
      enabled: !!tokenAddress && ethIn > 0n,
    },
  });

  return {
    tokensOut: data as bigint | undefined,
    isLoading,
    error,
  };
}

/**
 * Hook for previewing sell amount
 */
export function usePreviewSell(tokenAddress: Address | undefined, tokensIn: bigint) {
  const { data, isLoading, error } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "previewSell",
    args: tokenAddress ? [tokenAddress, tokensIn] : undefined,
    query: {
      enabled: !!tokenAddress && tokensIn > 0n,
    },
  });

  return {
    ethOut: data as bigint | undefined,
    isLoading,
    error,
  };
}

/**
 * Hook for getting all tokens
 */
export function useAllTokens() {
  const { data, isLoading, error, refetch } = useReadContract({
    address: CONTRACTS.TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "getAllTokens",
  });

  return {
    tokens: data as Address[] | undefined,
    isLoading,
    error,
    refetch,
  };
}
