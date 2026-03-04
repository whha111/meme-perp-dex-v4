"use client";

/**
 * 全局钱包余额 Context (BNB 本位)
 *
 * 读取派生钱包的完整余额:
 * - WBNB 链上余额 (ERC20 balanceOf)
 * - Native BNB 余额 (用于显示未 wrap 的 BNB)
 * - Settlement 合约可用余额 (链上托管 + 链下盈亏调整)
 * 数据源: wagmi useReadContract/useBalance + backend balance API + WS "balance" 消息触发 refetch
 */

import React, {
  createContext,
  useContext,
  useMemo,
  useCallback,
  useState,
  useEffect,
} from "react";
import { formatEther, parseEther, type Address } from "viem";
import { useReadContract, useBalance } from "wagmi";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { useTradingDataStore } from "@/lib/stores/tradingDataStore";
import { MATCHING_ENGINE_URL } from "@/config/api";

// ============================================================
// Constants (BNB 本位)
// ============================================================

// BSC Testnet WBNB address
const WETH_ADDRESS = (process.env.NEXT_PUBLIC_WETH_ADDRESS || "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd") as Address;

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ============================================================
// Types
// ============================================================

interface WalletBalanceContextType {
  tradingWallet: Address | null;
  /** WETH balance on the trading wallet (already wrapped) */
  wethBalance: bigint;
  /** Native ETH balance on the trading wallet (not yet wrapped) */
  nativeEthBalance: bigint;
  /** Settlement 合约可用余额 (链上托管 + 链下盈亏调整) */
  settlementBalance: bigint;
  /** Total usable balance: Settlement available + WETH + native ETH (minus gas reserve) */
  totalBalance: bigint;
  /** 仅钱包余额 (不含 Settlement)，用于充值 MAX 按钮 */
  walletOnlyBalance: bigint;
  /** Formatted total balance string */
  formattedWethBalance: string;
  refreshBalance: () => void;
  isLoading: boolean;
  lastUpdated: number;
}

// ============================================================
// Context
// ============================================================

const WalletBalanceContext = createContext<WalletBalanceContextType | null>(
  null
);

// Gas reserve: 0.0005 BNB
const GAS_RESERVE = parseEther("0.0005");

export function WalletBalanceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { address: tradingWallet } = useTradingWallet();

  // WETH balance (ERC20)
  const {
    data: wethRaw,
    refetch: refetchWeth,
    isLoading: isLoadingWeth,
    dataUpdatedAt: wethUpdatedAt,
  } = useReadContract({
    address: WETH_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: tradingWallet ? [tradingWallet] : undefined,
    query: {
      enabled: !!tradingWallet,
    },
  });

  // Native ETH balance
  const {
    data: nativeBalanceData,
    refetch: refetchNative,
    isLoading: isLoadingNative,
  } = useBalance({
    address: tradingWallet ?? undefined,
  });

  const wethBalance = (wethRaw as bigint) ?? 0n;
  const nativeEthBalance = nativeBalanceData?.value ?? 0n;

  // Settlement balance from backend (includes mode2 PnL adjustments)
  const [settlementBalance, setSettlementBalance] = useState(0n);

  const fetchSettlementBalance = useCallback(async () => {
    if (!tradingWallet) return;
    try {
      const res = await fetch(
        `${MATCHING_ENGINE_URL}/api/user/${tradingWallet}/balance`
      );
      if (res.ok) {
        const data = await res.json();
        // availableBalance = effectiveAvailable - pendingOrdersLocked - positionMargin
        // For the "交易账户余额" display, we want the full available (including settlement)
        setSettlementBalance(BigInt(data.availableBalance || "0"));
      }
    } catch {
      // Ignore fetch errors
    }
  }, [tradingWallet]);

  // Fetch Settlement balance on mount and periodically
  useEffect(() => {
    fetchSettlementBalance();
    const interval = setInterval(fetchSettlementBalance, 60_000);
    return () => clearInterval(interval);
  }, [fetchSettlementBalance]);

  // Wallet-only balance: WETH + (native ETH - gas reserve)
  const walletOnlyBalance = useMemo(() => {
    const usableNative = nativeEthBalance > GAS_RESERVE ? nativeEthBalance - GAS_RESERVE : 0n;
    return wethBalance + usableNative;
  }, [wethBalance, nativeEthBalance]);

  // Total usable balance: Settlement available + wallet (for display as "交易账户余额")
  // Note: wallet balance is EXCLUDED from settlementBalance (backend separates them),
  // so we add them together here to get the full picture
  const totalBalance = useMemo(() => {
    return settlementBalance + walletOnlyBalance;
  }, [settlementBalance, walletOnlyBalance]);

  // Refresh all balances
  const refreshBalance = useCallback(() => {
    refetchWeth();
    refetchNative();
    fetchSettlementBalance();
  }, [refetchWeth, refetchNative, fetchSettlementBalance]);

  // System B (WebSocketManager) pushes balance → tradingDataStore
  // When store balance changes, refetch on-chain wallet balances
  const storeBalance = useTradingDataStore(state => state.balance);
  useEffect(() => {
    if (storeBalance) {
      refreshBalance();
    }
  }, [storeBalance, refreshBalance]);

  // Formatted total balance (18 decimals for BNB)
  const formattedWethBalance = useMemo(() => {
    const balance = Number(totalBalance) / 1e18;
    if (balance >= 1) {
      return balance.toLocaleString("en-US", {
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
      });
    }
    return balance.toLocaleString("en-US", {
      minimumFractionDigits: 6,
      maximumFractionDigits: 6,
    });
  }, [totalBalance]);

  const lastUpdated = wethUpdatedAt || 0;

  const value: WalletBalanceContextType = {
    tradingWallet: tradingWallet ?? null,
    wethBalance,
    nativeEthBalance,
    settlementBalance,
    totalBalance,
    walletOnlyBalance,
    formattedWethBalance,
    refreshBalance,
    isLoading: isLoadingWeth || isLoadingNative,
    lastUpdated,
  };

  return (
    <WalletBalanceContext.Provider value={value}>
      {children}
    </WalletBalanceContext.Provider>
  );
}

export function useWalletBalance() {
  const context = useContext(WalletBalanceContext);
  if (!context) {
    throw new Error(
      "useWalletBalance must be used within WalletBalanceProvider"
    );
  }
  return context;
}

export default WalletBalanceContext;
