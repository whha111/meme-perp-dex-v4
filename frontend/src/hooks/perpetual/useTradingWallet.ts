"use client";

/**
 * useTradingWallet - 签名派生交易钱包 Hook
 *
 * 原理 (类似 dYdX v3):
 * 1. 用户用主钱包签名一条固定消息
 * 2. 从签名派生出私钥 (keccak256)
 * 3. 得到一个真正的 EOA 钱包，可用于链下签名订单
 * 4. 钱包数据保存在 localStorage，主钱包签名即可恢复
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  formatEther,
  parseEther,
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useAccount, useChainId, useSignMessage } from "wagmi";
import { bscTestnet, bsc } from "viem/chains";
import {
  createTradingWallet,
  getWalletSigningMessage,
  saveTradingWallet,
  loadTradingWallet,
  clearTradingWallet,
  exportPrivateKey as exportPrivateKeyUtil,
} from "@/utils/tradingWallet";
import { MATCHING_ENGINE_URL } from "@/config/api";
import { NETWORK_CONFIG, CONTRACTS } from "@/lib/contracts";

/**
 * 向后端注册交易钱包 session，使平台可以代替用户执行 approve+deposit
 */
async function registerSessionWithBackend(signature: Hex, expiresInSeconds: number = 86400): Promise<void> {
  try {
    const res = await fetch(`${MATCHING_ENGINE_URL}/api/wallet/register-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature, expiresInSeconds }),
    });
    const data = await res.json();
    if (data.success) {
      console.log(`[TradingWallet] Session registered: ${data.data.tradingWalletAddress?.slice(0, 10)}, expires at ${data.data.expiresAt}`);
    } else {
      console.warn("[TradingWallet] Failed to register session:", data.error);
    }
  } catch (e) {
    console.warn("[TradingWallet] Failed to register session with backend:", e);
  }
}

// ============================================================
// Types
// ============================================================

export interface TradingWalletState {
  address: Address | null;
  /** @deprecated C-06 fix: 私钥不再通过 state 暴露，始终返回 null。使用 exportKey() 安全导出 */
  privateKey: null;
  ethBalance: bigint;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface UseTradingWalletReturn extends TradingWalletState {
  generateWallet: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  exportKey: () => { privateKey: Hex; warning: string } | null;
  disconnect: () => void;
  sendETH: (to: Address, amount: string) => Promise<Hex>;
  formattedEthBalance: string;
  signingMessage: string;
  getSignature: () => Hex | null;
  wrapAndDeposit: (amount: string) => Promise<Hex>;
  isWrappingAndDepositing: boolean;
}

// ============================================================
// Hook Implementation
// ============================================================

export function useTradingWallet(): UseTradingWalletReturn {
  const { address: mainWallet, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  const [state, setState] = useState<TradingWalletState>({
    address: null,
    privateKey: null, // C-06 fix: 始终为 null，私钥存在 ref 中不暴露给 React DevTools
    ethBalance: 0n,
    isInitialized: false,
    isLoading: false,
    error: null,
  });

  const [isWrappingAndDepositing, setIsWrappingAndDepositing] = useState(false);

  // 保存签名用于 getSignature 返回
  const signatureRef = useRef<Hex | null>(null);

  // C-06 fix: 私钥存在 ref 中，不通过 React state 暴露
  // React DevTools 无法读取 ref.current，只能通过 exportKey() 安全导出
  const privateKeyRef = useRef<Hex | null>(null);

  // 获取对应的 viem chain 对象
  const chain = chainId === 56 ? bsc : bscTestnet;

  // RPC URL: 使用配置的 RPC 而非默认的 sepolia.base.org (会 403)
  const rpcUrl = NETWORK_CONFIG.RPC_URL;

  // publicClient 用于读取余额
  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain,
        transport: http(rpcUrl),
      }),
    [chain, rpcUrl]
  );

  // ─── 刷新派生钱包 ETH 余额 ──────────────────────────
  const refreshBalance = useCallback(async () => {
    if (!state.address) return;
    try {
      const balance = await publicClient.getBalance({ address: state.address });
      setState((prev) => ({ ...prev, ethBalance: balance }));
    } catch (e) {
      console.warn("[useTradingWallet] refreshBalance failed:", e);
    }
  }, [state.address, publicClient]);

  // ─── 从 localStorage 恢复已有钱包 ──────────────────────
  useEffect(() => {
    if (!mainWallet || !isConnected) {
      // 主钱包断开时重置状态
      setState({
        address: null,
        privateKey: null,
        ethBalance: 0n,
        isInitialized: false,
        isLoading: false,
        error: null,
      });
      signatureRef.current = null;
      privateKeyRef.current = null; // C-06: 清理私钥 ref
      return;
    }

    const stored = loadTradingWallet(mainWallet);
    if (stored && stored.signature) {
      try {
        const wallet = createTradingWallet(stored.signature);
        signatureRef.current = stored.signature;
        privateKeyRef.current = wallet.privateKey; // C-06: 私钥存 ref 不存 state
        setState({
          address: wallet.address,
          privateKey: null, // C-06: 不暴露私钥到 React state
          ethBalance: 0n,
          isInitialized: true,
          isLoading: false,
          error: null,
        });
        // 恢复时也向后端注册 session (服务器可能重启过, 不阻塞恢复流程)
        registerSessionWithBackend(stored.signature).catch((err) =>
          console.warn("[TradingWallet] Session register failed:", err)
        );
      } catch {
        // 存储数据损坏，清除
        clearTradingWallet(mainWallet);
      }
    }
  }, [mainWallet, isConnected]);

  // ─── 钱包初始化后自动刷新余额 ──────────────────────────
  useEffect(() => {
    if (state.isInitialized && state.address) {
      refreshBalance();
    }
  }, [state.isInitialized, state.address, refreshBalance]);

  // ─── 签名消息 ─────────────────────────────────────────
  const signingMessage = useMemo(
    () => getWalletSigningMessage(chainId),
    [chainId]
  );

  // ─── 激活 / 生成派生钱包 ──────────────────────────────
  const generateWallet = useCallback(async () => {
    if (!mainWallet || !isConnected) {
      setState((prev) => ({ ...prev, error: "请先连接主钱包" }));
      return;
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      // 1. 请求用户签名
      const signature = await signMessageAsync({
        message: signingMessage,
      });

      // 2. 从签名派生交易钱包
      const wallet = createTradingWallet(signature as Hex);

      // 3. 保存到 localStorage
      saveTradingWallet(mainWallet, wallet.address, signature as Hex, chainId);
      signatureRef.current = signature as Hex;

      // 3.5 向后端注册 session (必须 await — 否则 autoDeposit 无法签名)
      await registerSessionWithBackend(signature as Hex);

      // 4. 读取余额
      const balance = await publicClient
        .getBalance({ address: wallet.address })
        .catch(() => 0n);

      privateKeyRef.current = wallet.privateKey; // C-06: 私钥存 ref 不存 state
      setState({
        address: wallet.address,
        privateKey: null, // C-06: 不暴露私钥到 React state
        ethBalance: balance,
        isInitialized: true,
        isLoading: false,
        error: null,
      });

      console.log(
        `[useTradingWallet] Wallet activated: ${wallet.address.slice(0, 10)}...`
      );
    } catch (e) {
      const { isUserRejection, extractErrorMessage } = await import("@/lib/errors/errorDictionary");
      const msg = isUserRejection(e) ? "用户取消签名" : extractErrorMessage(e, "激活失败");
      setState((prev) => ({ ...prev, isLoading: false, error: msg }));
    }
  }, [mainWallet, isConnected, signMessageAsync, signingMessage, chainId, publicClient]);

  // ─── 导出私钥 ────────────────────────────────────────
  const exportKey = useCallback(() => {
    if (!signatureRef.current) return null;
    return exportPrivateKeyUtil(signatureRef.current);
  }, []);

  // ─── 断开 / 清除交易钱包 ─────────────────────────────
  const disconnect = useCallback(() => {
    if (mainWallet) {
      clearTradingWallet(mainWallet);
    }
    signatureRef.current = null;
    privateKeyRef.current = null; // C-06: 同时清理私钥 ref
    setState({
      address: null,
      privateKey: null,
      ethBalance: 0n,
      isInitialized: false,
      isLoading: false,
      error: null,
    });
  }, [mainWallet]);

  // ─── 获取签名 (订单签名用) ───────────────────────────
  const getSignature = useCallback((): Hex | null => {
    return signatureRef.current;
  }, []);

  // ─── 发送 ETH ────────────────────────────────────────
  // C-06 fix: 使用 privateKeyRef 而非 state.privateKey
  const sendETH = useCallback(
    async (to: Address, amount: string): Promise<Hex> => {
      if (!privateKeyRef.current) {
        throw new Error("交易钱包未激活");
      }

      const account = privateKeyToAccount(privateKeyRef.current);
      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl),
      });

      const hash = await walletClient.sendTransaction({
        to,
        value: parseEther(amount),
      });

      // 发送后刷新余额
      setTimeout(() => refreshBalance(), 3000);
      return hash;
    },
    [chain, rpcUrl, refreshBalance]
  );

  // ─── Wrap ETH → WETH (调用 WETH 合约 deposit) ────────
  // C-06 fix: 使用 privateKeyRef 而非 state.privateKey
  const wrapAndDeposit = useCallback(
    async (amount: string): Promise<Hex> => {
      if (!privateKeyRef.current) {
        throw new Error("交易钱包未激活");
      }

      setIsWrappingAndDepositing(true);
      try {
        const account = privateKeyToAccount(privateKeyRef.current);
        const walletClient = createWalletClient({
          account,
          chain,
          transport: http(rpcUrl),
        });

        const wethAddress = CONTRACTS.WETH;
        const wrapAmount = parseEther(amount);

        // 调用 WETH 合约的 deposit() — 发送 ETH 获得等量 WETH
        const hash = await walletClient.writeContract({
          address: wethAddress,
          abi: [
            {
              name: "deposit",
              type: "function",
              stateMutability: "payable",
              inputs: [],
              outputs: [],
            },
          ] as const,
          functionName: "deposit",
          value: wrapAmount,
        });

        console.log(`[TradingWallet] Wrap ETH→WETH tx: ${hash}, amount: ${amount}`);
        setTimeout(() => refreshBalance(), 3000);
        return hash;
      } finally {
        setIsWrappingAndDepositing(false);
      }
    },
    [chain, rpcUrl, refreshBalance]
  );

  // ─── 格式化余额 ──────────────────────────────────────
  const formattedEthBalance = useMemo(
    () => formatEther(state.ethBalance),
    [state.ethBalance]
  );

  return {
    ...state,
    generateWallet,
    refreshBalance,
    exportKey,
    disconnect,
    sendETH,
    formattedEthBalance,
    signingMessage,
    getSignature,
    wrapAndDeposit,
    isWrappingAndDepositing,
  };
}

export default useTradingWallet;
