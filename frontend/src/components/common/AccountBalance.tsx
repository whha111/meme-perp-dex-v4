"use client";

import { useCallback, useMemo, useState } from "react";
import {
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from "viem";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useSendTransaction,
  useWriteContract,
} from "wagmi";
import { useWalletBalance } from "@/contexts/WalletBalanceContext";
import { useTradingWallet } from "@/hooks/perpetual/useTradingWallet";
import { CONTRACTS, NETWORK_CONFIG } from "@/lib/contracts";

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

type Asset = "BNB" | "USDT";
type Action = "deposit" | "withdraw";

function formatAsset(value: bigint | undefined, decimals: number, max = 6) {
  if (!value) return "0";
  const numeric = Number(formatUnits(value, decimals));
  if (!Number.isFinite(numeric)) return "0";
  if (numeric >= 1) return numeric.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return numeric.toLocaleString("en-US", { maximumFractionDigits: max });
}

export function AccountBalance({ onClose }: { onClose?: () => void }) {
  const { address: mainWallet, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const usdtAddress = CONTRACTS.USDT || undefined;
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();

  const {
    address: tradingWallet,
    getSignature,
    sendETH,
    ethBalance: tradingWalletNativeBalance,
    refreshBalance: refreshTradingWalletBalance,
    exportKey,
  } = useTradingWallet();

  const { nativeEthBalance, lockedMargin, refreshBalance: refreshGlobalBalance } = useWalletBalance();
  const tradingWalletSignature = getSignature();

  const [asset, setAsset] = useState<Asset>("BNB");
  const [action, setAction] = useState<Action>("deposit");
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: mainBnb, refetch: refetchMainBnb } = useBalance({ address: mainWallet });
  const { data: mainUsdt, refetch: refetchMainUsdt } = useBalance({
    address: mainWallet,
    token: usdtAddress,
    query: { enabled: !!mainWallet && !!usdtAddress },
  });
  const { data: tradingUsdt, refetch: refetchTradingUsdt } = useBalance({
    address: tradingWallet ?? undefined,
    token: usdtAddress,
    query: { enabled: !!tradingWallet && !!usdtAddress },
  });

  const usdtDecimals = mainUsdt?.decimals ?? tradingUsdt?.decimals ?? 18;
  const amountUnits = useMemo(() => {
    try {
      return asset === "BNB" ? parseEther(amount || "0") : parseUnits(amount || "0", usdtDecimals);
    } catch {
      return 0n;
    }
  }, [amount, asset, usdtDecimals]);

  const refreshAll = useCallback(() => {
    refreshGlobalBalance();
    refreshTradingWalletBalance();
    refetchMainBnb();
    refetchMainUsdt();
    refetchTradingUsdt();
  }, [refreshGlobalBalance, refreshTradingWalletBalance, refetchMainBnb, refetchMainUsdt, refetchTradingUsdt]);

  const setMaxAmount = useCallback(() => {
    if (asset === "BNB") {
      if (action === "deposit") {
        const reserve = parseEther("0.005");
        const available = mainBnb?.value && mainBnb.value > reserve ? mainBnb.value - reserve : 0n;
        setAmount(formatEther(available));
      } else {
        const reserve = parseEther("0.001");
        const available = tradingWalletNativeBalance > reserve ? tradingWalletNativeBalance - reserve : 0n;
        setAmount(formatEther(available));
      }
      return;
    }

    const balance = action === "deposit" ? mainUsdt?.value : tradingUsdt?.value;
    setAmount(formatUnits(balance ?? 0n, usdtDecimals));
  }, [asset, action, mainBnb?.value, tradingWalletNativeBalance, mainUsdt?.value, tradingUsdt?.value, usdtDecimals]);

  const handleDeposit = useCallback(async () => {
    if (!tradingWallet || amountUnits === 0n) return;
    setError(null);
    setIsProcessing(true);
    try {
      if (asset === "BNB") {
        const txHash = await sendTransactionAsync({ to: tradingWallet, value: amountUnits });
        await publicClient?.waitForTransactionReceipt({ hash: txHash });
      } else {
        if (!usdtAddress) throw new Error("USDT contract is not configured");
        const txHash = await writeContractAsync({
          address: usdtAddress,
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [tradingWallet, amountUnits],
        });
        await publicClient?.waitForTransactionReceipt({ hash: txHash });
      }
      setAmount("");
      refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Deposit failed");
    } finally {
      setIsProcessing(false);
    }
  }, [tradingWallet, amountUnits, asset, sendTransactionAsync, publicClient, usdtAddress, writeContractAsync, refreshAll]);

  const handleWithdraw = useCallback(async () => {
    if (!tradingWallet || !mainWallet || amountUnits === 0n) return;
    setError(null);
    setIsProcessing(true);
    try {
      if (asset === "BNB") {
        const reserve = parseEther("0.001");
        const maxSend = tradingWalletNativeBalance > reserve ? tradingWalletNativeBalance - reserve : 0n;
        if (amountUnits > maxSend) throw new Error("Insufficient BNB after gas reserve");
        await sendETH(mainWallet, amount);
      } else {
        if (!usdtAddress) throw new Error("USDT contract is not configured");
        const keyData = exportKey?.();
        if (!keyData?.privateKey) throw new Error("Trading wallet is not active");
        const [{ createWalletClient, http }, { privateKeyToAccount }, { bsc }] = await Promise.all([
          import("viem"),
          import("viem/accounts"),
          import("viem/chains"),
        ]);
        const account = privateKeyToAccount(keyData.privateKey);
        const walletClient = createWalletClient({
          account,
          chain: bsc,
          transport: http(NETWORK_CONFIG.RPC_URL),
        });
        const txHash = await walletClient.writeContract({
          address: usdtAddress,
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [mainWallet, amountUnits],
        });
        await publicClient?.waitForTransactionReceipt({ hash: txHash });
      }
      setAmount("");
      refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Withdrawal failed");
    } finally {
      setIsProcessing(false);
    }
  }, [
    tradingWallet,
    mainWallet,
    amountUnits,
    asset,
    tradingWalletNativeBalance,
    sendETH,
    amount,
    usdtAddress,
    exportKey,
    publicClient,
    refreshAll,
  ]);

  const copyTradingWallet = useCallback(() => {
    if (!tradingWallet) return;
    navigator.clipboard.writeText(tradingWallet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [tradingWallet]);

  const presets = asset === "BNB" ? ["0.01", "0.05", "0.1", "0.5"] : ["25", "100", "500", "1000"];
  const currentWalletLabel = action === "deposit" ? "主钱包" : "交易钱包";
  const currentBalance = asset === "BNB"
    ? action === "deposit"
      ? formatAsset(mainBnb?.value, 18)
      : formatAsset(tradingWalletNativeBalance, 18)
    : action === "deposit"
      ? formatAsset(mainUsdt?.value, usdtDecimals, 4)
      : formatAsset(tradingUsdt?.value, usdtDecimals, 4);

  return (
    <div className="overflow-hidden rounded-[0.5rem] border border-[#3A3B44] bg-[#202126] text-[#F4F4F6] shadow-2xl">
      <div className="flex items-center justify-between border-b border-[#3A3B44] px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-[#F4F4F6]">资金划转</div>
          <div className="text-xs text-[#8E90A0]">交易钱包保证金</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-xl leading-none text-[#8E90A0] hover:text-[#F4F4F6]">
            &times;
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-[#3A3B44] bg-[#3A3B44]">
        <div className="bg-[#222328] p-4">
          <div className="text-xs text-[#8E90A0]">可用 BNB</div>
          <div className="mt-1 text-xl font-semibold text-[#F4F4F6]">{formatAsset(nativeEthBalance, 18)}</div>
        </div>
        <div className="bg-[#222328] p-4">
          <div className="text-xs text-[#8E90A0]">锁定保证金</div>
          <div className="mt-1 text-xl font-semibold text-[#F4F4F6]">{formatAsset(lockedMargin, 18)}</div>
        </div>
      </div>

      <div className="border-b border-[#3A3B44] p-4">
        <div className="mb-2 flex items-center justify-between text-xs text-[#8E90A0]">
          <span>交易钱包</span>
          <button onClick={copyTradingWallet} className="text-[#7774FF] hover:text-[#9A97FF]">
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <input
          value={tradingWallet || ""}
          readOnly
          placeholder="请先激活交易钱包"
          className="w-full rounded-[0.375rem] border border-[#454650] bg-[#30313A] px-3 py-2 text-xs font-mono text-[#B7B8C3] outline-none"
        />
      </div>

      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-2 rounded-[0.375rem] bg-[#30313A] p-1">
          {(["deposit", "withdraw"] as Action[]).map((item) => (
            <button
              key={item}
              onClick={() => {
                setAction(item);
                setAmount("");
                setError(null);
              }}
              className={`rounded px-3 py-2 text-sm font-medium transition-colors ${
                action === item ? "bg-[#F4F4F6] text-[#202126]" : "text-[#8E90A0] hover:text-[#F4F4F6]"
              }`}
            >
              {item === "deposit" ? "充值" : "提现"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {(["BNB", "USDT"] as Asset[]).map((item) => (
            <button
              key={item}
              onClick={() => {
                setAsset(item);
                setAmount("");
                setError(null);
              }}
              className={`rounded-md border px-3 py-2 text-sm font-semibold transition-colors ${
                asset === item
                  ? "border-[#7774FF] bg-[#2C2A55] text-[#D9D8FF]"
                  : "border-[#3A3B44] text-[#B7B8C3] hover:text-[#F4F4F6]"
              }`}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-[#8E90A0]">{currentWalletLabel}</span>
          <span className="font-mono text-[#F4F4F6]">
            {currentBalance} {asset}
          </span>
        </div>

        <div className="relative">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            disabled={isProcessing}
            className="w-full rounded-[0.375rem] border border-[#454650] bg-[#30313A] px-3 py-3 pr-20 text-base text-[#F4F4F6] outline-none focus:border-[#7774FF] disabled:opacity-50"
          />
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
            <span className="text-xs text-[#8E90A0]">{asset}</span>
            <button onClick={setMaxAmount} disabled={isProcessing} className="text-xs font-semibold text-[#7774FF] disabled:opacity-50">
              MAX
            </button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {presets.map((preset) => (
            <button
              key={preset}
              onClick={() => setAmount(preset)}
              disabled={isProcessing}
              className="rounded-[0.375rem] bg-[#30313A] py-2 text-xs text-[#8E90A0] hover:text-[#F4F4F6] disabled:opacity-50"
            >
              {preset}
            </button>
          ))}
        </div>

        {asset === "USDT" && (
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
            USDT 可用于交易钱包充值；当前下单保证金仍按 BNB 结算，多抵押结算启用后切换。
          </div>
        )}

        {error && (
          <div className="rounded-md border border-okx-down/30 bg-okx-down/10 px-3 py-2 text-xs text-okx-down">
            {error}
          </div>
        )}

        <button
          onClick={action === "deposit" ? handleDeposit : handleWithdraw}
          disabled={
            isProcessing ||
            !isConnected ||
            !tradingWallet ||
            amountUnits === 0n ||
            !tradingWalletSignature ||
            (asset === "USDT" && !usdtAddress)
          }
          className="w-full rounded-[0.375rem] bg-[#7774FF] py-3 text-sm font-semibold text-white transition-colors hover:bg-[#8D8AFF] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isProcessing
            ? "处理中..."
            : action === "deposit"
              ? `充值 ${asset}`
              : `提现 ${asset}`}
        </button>
      </div>
    </div>
  );
}
