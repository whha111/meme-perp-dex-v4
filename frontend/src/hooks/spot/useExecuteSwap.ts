"use client";

/**
 * useExecuteSwap - 现货交易执行 Hook
 *
 * 架构说明：
 * - 报价计算：使用 useOnChainQuote (直接调用链上 previewBuy/previewSell)
 * - 交易执行：使用 useExecuteSwap (本文件)
 * - 交易历史：使用 WebSocket 获取历史数据
 */

import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWriteContract, useWaitForTransactionReceipt, useChainId, useAccount } from "wagmi";
import { parseUnits, type Address } from "viem";
import { useToast } from "@/components/shared/Toast";
import { CONTRACTS } from "@/lib/contracts";
import { isValidChainId, CHAIN_ID_BSC_MAINNET } from "@/lib/eip712";

// 请求锁管理器 (用于防止并发交易)
class RequestLockManager {
  private locks = new Map<string, { timestamp: number }>();

  acquire(key: string, timeoutMs: number): boolean {
    const now = Date.now();
    const existing = this.locks.get(key);

    // 如果锁存在且未超时，获取失败
    if (existing && now - existing.timestamp < timeoutMs) {
      return false;
    }

    this.locks.set(key, { timestamp: now });
    return true;
  }

  release(key: string): void {
    this.locks.delete(key);
  }
}

import { logError } from "@/lib/validators";
import { devLog } from "@/lib/debug-logger";
import { showGlobalError } from "@/components/shared/ErrorModal";
import { parseErrorCode, isUserCancelledError } from "@/lib/errors/errorDictionary";
import { tradeEventEmitter } from "@/lib/tradeEvents";

/**
 * 基点常量定义
 * BPS = Basis Points（基点）
 * 
 * 金融常识:
 * - 1 BPS = 0.01% = 1/10000
 * - 100 BPS = 1%
 * - 10000 BPS = 100%（最大值）
 */
const BPS_DENOMINATOR = 10000; // 基点分母（100% = 10000 BPS）
const MAX_SLIPPAGE_BPS = 10000; // 最大滑点 100%
const MIN_SLIPPAGE_BPS = 0;     // 最小滑点 0%

/**
 * 滑点基点转百分比
 * @param bps 基点 (100 BPS = 1%)
 * @returns 百分比小数 (e.g., 0.01 for 1%)
 * 
 * @example
 * bpsToPercent(100)  // => 0.01 (1%)
 * bpsToPercent(500)  // => 0.05 (5%)
 */
export function bpsToPercent(bps: number): number {
  return bps / BPS_DENOMINATOR;
}

/**
 * 计算最小接收数量（考虑滑点保护）
 * 
 * 公式: minAmount = amountOut * (1 - slippage)
 *       minAmount = amountOut * (10000 - slippageBps) / 10000
 * 
 * @param amountOut 预期输出金额 (Wei)
 * @param slippageBps 滑点基点 (100 = 1%, 500 = 5%)
 * @returns 最小接收数量 (Wei)
 * 
 * @example
 * // 5% 滑点保护
 * calculateMinAmountOut(1000000n, 500) // => 950000n
 */
export function calculateMinAmountOut(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`滑点必须在 ${MIN_SLIPPAGE_BPS}-${MAX_SLIPPAGE_BPS} 基点之间`);
  }
  // 最小接收 = amountOut * (10000 - slippageBps) / 10000
  const slippageFactor = BigInt(BPS_DENOMINATOR - slippageBps);
  return (amountOut * slippageFactor) / BigInt(BPS_DENOMINATOR);
}

/**
 * ETH 精度常量
 */
export const ETH_DECIMALS = 18;
export const ONE_ETH = parseUnits(process.env.NEXT_PUBLIC_ONE_ETH_AMOUNT || "1", ETH_DECIMALS);

/**
 * 交易状态枚举
 */
export enum SwapStatus {
  IDLE = "idle",
  QUOTING = "quoting",
  AWAITING_SIGNATURE = "awaiting_signature",
  TRANSACTION_PENDING = "transaction_pending",
  TRANSACTION_CONFIRMING = "transaction_confirming",
  SUCCESS = "success",
  FAILED = "failed",
}

/**
 * useExecuteSwap - 执行交易
 * 
 * 业务流程：
 * 1. 调用后端 TradeService.ExecuteSwap 获取 EIP-712 签名
 * 2. 如果后端返回 transactionHash，直接监听交易状态
 * 3. 否则，使用 wagmi 调用 PoolManager.swap
 * 
 * @example
 * ```tsx
 * const { executeSwap, status, transactionHash } = useExecuteSwap();
 * 
 * await executeSwap({
 *   domainName: "example.com",
 *   amountIn: parseUnits("0.1", 18),
 *   minimumAmountOut: quote.minimumReceived,
 *   isBuy: true,
 * });
 * ```
 */
// 全局交易锁管理器（防止并发交易）
const transactionLockManager = new RequestLockManager();
const TRANSACTION_LOCK_TIMEOUT = 30000; // 30秒超时

export function useExecuteSwap() {
  const { address, isConnected, chainId: accountChainId } = useAccount();
  const chainId = useChainId();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // Use account chainId if available, fallback to hook chainId
  const effectiveChainId = accountChainId || chainId;

  // 交易状态
  const [swapStatus, setSwapStatus] = React.useState<SwapStatus>(SwapStatus.IDLE);
  const [transactionHash, setTransactionHash] = React.useState<`0x${string}` | null>(null);
  const [tradedTokenAddress, setTradedTokenAddress] = React.useState<string | null>(null);

  // 合约地址
  const TOKEN_FACTORY_ADDRESS = CONTRACTS.TOKEN_FACTORY;

  // Validate chain ID on mount
  React.useEffect(() => {
    if (effectiveChainId && !isValidChainId(effectiveChainId)) {
      devLog.warn(
        `[useExecuteSwap] Invalid chain ID: ${effectiveChainId}. ` +
        `Please switch to BSC Mainnet (${CHAIN_ID_BSC_MAINNET}).`
      );
    }
  }, [effectiveChainId]);

  // Use writeContractAsync for async/await support
  const { 
    writeContractAsync: writeSwapAsync,
    isPending: isWriting,
    isError: isWriteError,
    error: writeError,
  } = useWriteContract();
  
  const [writeData, setWriteData] = React.useState<`0x${string}` | null>(null);

  // 监听交易确认
  const txHash = transactionHash || writeData || undefined;
  const {
    data: receipt,
    isLoading: isConfirming,
    isSuccess: isReceiptReceived,
    isError: isReceiptError,
  } = useWaitForTransactionReceipt({
    hash: txHash,
    query: {
      enabled: !!txHash,
      retry: 3,
    },
  });
  
  // 真正的交易成功状态：不仅收到 receipt，还要检查 receipt.status
  // receipt.status === 'success' 表示链上执行成功
  // receipt.status === 'reverted' 表示链上执行失败（revert）
  const isTransactionSuccess = isReceiptReceived && receipt?.status === 'success';
  const isTransactionFailed = isReceiptReceived && receipt?.status === 'reverted';
  const isTransactionError = isReceiptError || isTransactionFailed;
  
  // Track processed transactions to prevent duplicate event emission
  const processedTxRef = React.useRef<string | null>(null);

  // 处理交易成功/失败的回调
  React.useEffect(() => {
    if (isTransactionSuccess && receipt) {
      setSwapStatus(SwapStatus.SUCCESS);
      showToast("交易成功！", "success");

      // 刷新相关数据
      queryClient.invalidateQueries({ queryKey: ["poolInfo"] });
      queryClient.invalidateQueries({ queryKey: ["swapQuote"] });
      queryClient.invalidateQueries({ queryKey: ["tokenBalance"] });
      queryClient.invalidateQueries({ queryKey: ["bondingCurveState"] });
      queryClient.invalidateQueries({ queryKey: ["tokenAssets"] });
      queryClient.invalidateQueries({ queryKey: ["perpTokenAssets"] });

      // 发送交易完成事件，通知 K 线等组件刷新
      // Use receipt.transactionHash to ensure we have the correct hash
      const txHash = receipt.transactionHash || transactionHash;
      if (tradedTokenAddress && txHash && processedTxRef.current !== txHash) {
        processedTxRef.current = txHash;
        console.log(`[useExecuteSwap] Emitting trade event for ${tradedTokenAddress}, tx: ${txHash}`);
        tradeEventEmitter.emit(tradedTokenAddress, txHash);
      }
    } else if (isTransactionFailed) {
      setSwapStatus(SwapStatus.FAILED);
      showToast("交易执行失败，请检查参数后重试", "error");
    } else if (isReceiptError) {
      setSwapStatus(SwapStatus.FAILED);
      showToast("交易确认超时，请检查钱包或区块浏览器", "error");
    }
  }, [isTransactionSuccess, isTransactionFailed, isReceiptError, receipt, queryClient, showToast, tradedTokenAddress, transactionHash]);

  // 执行交易的主函数（带并发控制）
  const executeSwapMutation = useMutation({
    // 防止并发执行
    networkMode: 'always',
    retry: false,

    mutationFn: async (params: {
      instId?: string; // 交易对ID（deprecated，使用 tokenAddress）
      domainName?: string; // 域名（deprecated，使用 tokenAddress）
      tokenAddress?: Address; // 代币地址（推荐）
      amountIn: bigint;
      minimumAmountOut: bigint;
      isBuy: boolean;
      deadline?: bigint;
    }) => {
      // 优先使用 tokenAddress
      const effectiveTokenAddress = params.tokenAddress;
      if (!effectiveTokenAddress) {
        throw new Error("代币地址不能为空");
      }
      const lockKey = "global_swap_lock";
      // 检查交易锁
      if (!transactionLockManager.acquire(lockKey, TRANSACTION_LOCK_TIMEOUT)) {
        throw new Error("已有交易在处理中，请等待当前交易完成");
      }

      try {
        if (!address || !isConnected) {
          throw new Error("请先连接钱包");
        }

        if (!effectiveChainId || !isValidChainId(effectiveChainId)) {
          throw new Error(`请切换到 BSC Mainnet 网络 (Chain ID: ${CHAIN_ID_BSC_MAINNET})`);
        }

        devLog.log("[useExecuteSwap] Executing swap:", {
          tokenAddress: effectiveTokenAddress,
          amountIn: params.amountIn.toString(),
          minimumAmountOut: params.minimumAmountOut.toString(),
          isBuy: params.isBuy,
        });

        if (params.isBuy) {
          // 买入：调用 TokenFactory.buyExactTokens(tokenAddress, tokenAmount)
          // Pump.fun 模式：用户指定代币数量，合约只收所需 BNB，多余退回
          // tokenAmount = previewBuy 返回的数量 (已含 graduation cap)
          // msg.value = 用户输入的 BNB (作为 maxCost 上限)
          // tokenAmount = 0 表示 "买完所有剩余代币直到毕业"
          const hash = await writeSwapAsync({
            address: TOKEN_FACTORY_ADDRESS,
            abi: [
              {
                name: "buyExactTokens",
                type: "function",
                stateMutability: "payable",
                inputs: [
                  { name: "tokenAddress", type: "address" },
                  { name: "tokenAmount", type: "uint256" },
                ],
                outputs: [],
              },
            ],
            functionName: "buyExactTokens",
            args: [effectiveTokenAddress, params.minimumAmountOut],
            value: params.amountIn, // BNB as max cost, excess refunded
            chainId: effectiveChainId,
            gas: 4_000_000n, // M-008: High gas limit to support graduation
          });

          setTransactionHash(hash);
          setWriteData(hash);
          setTradedTokenAddress(effectiveTokenAddress);
          setSwapStatus(SwapStatus.TRANSACTION_PENDING);
          return { hash };
        } else {
          // 卖出：调用 TokenFactory.sell(tokenAddress, tokenAmount, minETHOut)
          // 注意：用户需要先批准代币给 TokenFactory 合约
          const hash = await writeSwapAsync({
            address: TOKEN_FACTORY_ADDRESS,
            abi: [
              {
                name: "sell",
                type: "function",
                stateMutability: "nonpayable",
                inputs: [
                  { name: "tokenAddress", type: "address" },
                  { name: "tokenAmount", type: "uint256" },
                  { name: "minETHOut", type: "uint256" },
                ],
                outputs: [{ name: "", type: "uint256" }],
              },
            ],
            functionName: "sell",
            args: [effectiveTokenAddress, params.amountIn, params.minimumAmountOut],
            chainId: effectiveChainId, // Explicitly pass chainId
          });

          setTransactionHash(hash);
          setWriteData(hash);
          setTradedTokenAddress(effectiveTokenAddress);
          setSwapStatus(SwapStatus.TRANSACTION_PENDING);
          return { hash };
        }
      } catch (error) {
        logError(error, 'useExecuteSwap:transaction');
        setSwapStatus(SwapStatus.FAILED);
        throw error;
      } finally {
        // 释放交易锁
        transactionLockManager.release(lockKey);
      }
    },
    onError: (error: unknown) => {
      logError(error, 'useExecuteSwap');
      const errorCode = parseErrorCode(error);
      // 用户取消操作不显示错误弹窗
      if (!isUserCancelledError(errorCode)) {
        showGlobalError(error);
      }
      setSwapStatus(SwapStatus.FAILED);
    },
  });

  // 更新交易状态（基于 wagmi hooks）
  React.useEffect(() => {
    if (isWriting) {
      setSwapStatus(SwapStatus.TRANSACTION_PENDING);
    } else if (isConfirming) {
      setSwapStatus(SwapStatus.TRANSACTION_CONFIRMING);
    } else if (isTransactionSuccess) {
      setSwapStatus(SwapStatus.SUCCESS);
    } else if (isTransactionError || isWriteError) {
      setSwapStatus(SwapStatus.FAILED);
    }
  }, [isWriting, isConfirming, isTransactionSuccess, isTransactionError, isWriteError]);

  return {
    // 执行交易
    executeSwap: executeSwapMutation.mutateAsync,
    
    // 状态
    status: swapStatus,
    isPending: executeSwapMutation.isPending || isWriting || isConfirming,
    isSuccess: isTransactionSuccess || swapStatus === SwapStatus.SUCCESS,
    isError: executeSwapMutation.isError || isWriteError || isTransactionError,
    
    // 交易信息
    transactionHash: transactionHash || writeData || null,
    receipt,
    
    // 错误
    error: executeSwapMutation.error || writeError,
    
    // 重置
    reset: () => {
      executeSwapMutation.reset();
      setSwapStatus(SwapStatus.IDLE);
      setTransactionHash(null);
      setTradedTokenAddress(null);
      processedTxRef.current = null;
    },
  };
}

