"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { ArrowDownUp, ExternalLink, RefreshCw, ShieldCheck, Wallet } from "lucide-react";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import {
  useAccount,
  useBalance,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import {
  BSC_CHAIN_ID,
  PANCAKE_V2_ROUTER,
  PANCAKE_V2_ROUTER_ABI,
  SWAP_TOKENS,
  type SwapToken,
} from "@/lib/swapTokens";

interface QuotePayload {
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  minAmountOutFormatted: string;
  feeBps: number;
  protocol: string;
  path: Address[];
  routeSymbols: string[];
  validUntil: number;
}

const enabledTokens = SWAP_TOKENS.filter((token) => token.enabled);
const allTokens = SWAP_TOKENS;

function formatAmount(value: string | number, maxDigits = 6) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "--";
  if (numeric === 0) return "0";
  if (Math.abs(numeric) >= 1) return numeric.toLocaleString(undefined, { maximumFractionDigits: maxDigits });
  return numeric.toLocaleString(undefined, { maximumSignificantDigits: maxDigits });
}

function tokenBySymbol(symbol: string): SwapToken {
  return allTokens.find((token) => token.symbol === symbol) || enabledTokens[0];
}

function TokenSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (symbol: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[12px] uppercase tracking-normal text-[#7D8A96]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full rounded-[8px] border border-[#2B3542] bg-[#101820] px-3 text-[14px] font-semibold text-white outline-none transition-colors focus:border-[#5EEAD4]"
      >
        {allTokens.map((token) => (
          <option key={token.symbol} value={token.symbol} disabled={!token.enabled}>
            {token.symbol} {token.enabled ? "" : "(pending)"}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SwapClientPage() {
  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync: writeApproveAsync, isPending: isApprovePending } = useWriteContract();
  const { writeContractAsync: writeSwapAsync, isPending: isSwapPending } = useWriteContract();

  const [fromSymbol, setFromSymbol] = useState("BNB");
  const [toSymbol, setToSymbol] = useState("PEPE");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(50);
  const [quote, setQuote] = useState<QuotePayload | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [approveHash, setApproveHash] = useState<`0x${string}` | undefined>();
  const [swapHash, setSwapHash] = useState<`0x${string}` | undefined>();
  const [clientReady, setClientReady] = useState(false);

  const fromToken = tokenBySymbol(fromSymbol);
  const toToken = tokenBySymbol(toSymbol);
  const isWrongNetwork = isConnected && chainId !== BSC_CHAIN_ID;

  useEffect(() => {
    setClientReady(true);
  }, []);

  const parsedAmount = useMemo(() => {
    if (!amount || Number(amount) <= 0) return null;
    try {
      return parseUnits(amount, fromToken.decimals);
    } catch {
      return null;
    }
  }, [amount, fromToken.decimals]);

  const balanceToken = fromToken.native ? undefined : fromToken.address || undefined;
  const { data: fromBalance } = useBalance({
    address,
    token: balanceToken,
    query: { enabled: !!address },
  });

  const {
    data: allowance,
    refetch: refetchAllowance,
  } = useReadContract({
    address: fromToken.native ? undefined : fromToken.address || undefined,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && !fromToken.native ? [address, PANCAKE_V2_ROUTER] : undefined,
    query: {
      enabled: !!address && !!parsedAmount && !fromToken.native,
    },
  });

  const { isSuccess: isApproveConfirmed } = useWaitForTransactionReceipt({
    hash: approveHash,
    query: { enabled: !!approveHash },
  });

  const {
    isLoading: isSwapConfirming,
    isSuccess: isSwapConfirmed,
  } = useWaitForTransactionReceipt({
    hash: swapHash,
    query: { enabled: !!swapHash },
  });

  useEffect(() => {
    if (isApproveConfirmed) {
      refetchAllowance();
    }
  }, [isApproveConfirmed, refetchAllowance]);

  useEffect(() => {
    setQuote(null);
    setQuoteError(null);

    if (!amount || !parsedAmount || fromSymbol === toSymbol) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsQuoting(true);
      try {
        const params = new URLSearchParams({
          from: fromSymbol,
          to: toSymbol,
          amount,
          slippageBps: String(slippageBps),
        });
        const response = await fetch(`/api/swap/quote?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Quote unavailable");
        }
        setQuote(payload);
      } catch (error) {
        if (!controller.signal.aborted) {
          setQuoteError(error instanceof Error ? error.message : "Quote unavailable");
        }
      } finally {
        if (!controller.signal.aborted) setIsQuoting(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [amount, fromSymbol, parsedAmount, slippageBps, toSymbol]);

  const needsApproval = useMemo(() => {
    if (fromToken.native || !parsedAmount) return false;
    return (allowance ?? 0n) < parsedAmount;
  }, [allowance, fromToken.native, parsedAmount]);

  const balanceLabel = fromBalance
    ? `${formatAmount(fromBalance.formatted, 6)} ${fromBalance.symbol}`
    : `0 ${fromToken.symbol}`;

  const setMaxAmount = () => {
    if (!fromBalance) return;
    setAmount(fromBalance.formatted);
  };

  const flipTokens = () => {
    setFromSymbol(toSymbol);
    setToSymbol(fromSymbol);
    setQuote(null);
    setQuoteError(null);
  };

  const handleTokenChange = (side: "from" | "to", symbol: string) => {
    if (side === "from") {
      setFromSymbol(symbol);
      if (symbol === toSymbol) setToSymbol(fromSymbol);
    } else {
      setToSymbol(symbol);
      if (symbol === fromSymbol) setFromSymbol(toSymbol);
    }
  };

  const handleApprove = async () => {
    if (!parsedAmount || !fromToken.address) return;
    setActionError(null);
    try {
      const hash = await writeApproveAsync({
        address: fromToken.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [PANCAKE_V2_ROUTER, parsedAmount],
        chainId: BSC_CHAIN_ID,
      });
      setApproveHash(hash);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Approve failed");
    }
  };

  const handleSwap = async () => {
    if (!quote || !address || !parsedAmount) return;
    setActionError(null);
    try {
      const path = quote.path;
      const minAmountOut = BigInt(quote.minAmountOut);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

      let hash: `0x${string}`;
      if (fromToken.native) {
        hash = await writeSwapAsync({
          address: PANCAKE_V2_ROUTER,
          abi: PANCAKE_V2_ROUTER_ABI,
          functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
          args: [minAmountOut, path, address, deadline],
          value: parsedAmount,
          chainId: BSC_CHAIN_ID,
        });
      } else if (toToken.native) {
        hash = await writeSwapAsync({
          address: PANCAKE_V2_ROUTER,
          abi: PANCAKE_V2_ROUTER_ABI,
          functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
          args: [parsedAmount, minAmountOut, path, address, deadline],
          chainId: BSC_CHAIN_ID,
        });
      } else {
        hash = await writeSwapAsync({
          address: PANCAKE_V2_ROUTER,
          abi: PANCAKE_V2_ROUTER_ABI,
          functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
          args: [parsedAmount, minAmountOut, path, address, deadline],
          chainId: BSC_CHAIN_ID,
        });
      }
      setSwapHash(hash);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Swap failed");
    }
  };

  const handlePrimaryAction = async () => {
    if (!isConnected) {
      openConnectModal?.();
      return;
    }
    if (isWrongNetwork) {
      switchChain({ chainId: BSC_CHAIN_ID });
      return;
    }
    if (needsApproval) {
      await handleApprove();
      return;
    }
    await handleSwap();
  };

  const isBusy = isApprovePending || isSwapPending || isSwapConfirming;
  const primaryLabel = !isConnected
    ? "Connect wallet"
    : isWrongNetwork
      ? "Switch to BSC Mainnet"
      : needsApproval
        ? `Approve ${fromToken.symbol}`
        : isSwapConfirming
          ? "Confirming swap"
          : "Swap";

  const primaryDisabled =
    isBusy ||
    (!!isConnected && !isWrongNetwork && !needsApproval && !quote) ||
    !parsedAmount ||
    fromSymbol === toSymbol;

  return (
    <main className="min-h-screen bg-[#071117] text-white">
      <span className="sr-only" data-testid="swap-client-ready" data-ready={clientReady ? "true" : "false"} />
      <div className="border-b border-[#1D3440] bg-[#0C161D] px-4 py-3 text-[13px] text-[#8FF7E8]">
        DEXI Swap is zero platform fee. Trades route directly through PancakeSwap on BSC.
      </div>

      <div className="mx-auto grid max-w-[1320px] gap-5 px-5 py-8 lg:grid-cols-[260px_minmax(0,1fr)_360px]">
        <aside className="rounded-[10px] border border-[#22313A] bg-[#0E171F]">
          <div className="border-b border-[#22313A] px-4 py-3">
            <div className="text-[15px] font-semibold">Spot Markets</div>
            <div className="mt-1 text-[12px] text-[#7D8A96]">Whitelisted BSC assets</div>
          </div>
          <div className="divide-y divide-[#1D2A34]">
            {allTokens.map((token) => (
              <button
                key={token.symbol}
                disabled={!token.enabled}
                onClick={() => handleTokenChange("to", token.symbol)}
                className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors ${
                  token.enabled ? "hover:bg-[#13222B]" : "cursor-not-allowed opacity-45"
                } ${toSymbol === token.symbol ? "bg-[#132A2E]" : ""}`}
              >
                <span>
                  <span className="block text-[14px] font-semibold">{token.symbol}</span>
                  <span className="block text-[12px] text-[#7D8A96]">{token.name}</span>
                </span>
                <span className="rounded-[5px] border border-[#2B3542] px-2 py-1 text-[11px] text-[#9BB0BF]">
                  {token.enabled ? token.tags[0] : "pending"}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="min-w-0 rounded-[10px] border border-[#22313A] bg-[#0E171F]">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#22313A] px-5 py-4">
            <div>
              <h1 className="text-[28px] font-semibold leading-tight">Swap</h1>
              <p className="mt-1 text-[13px] text-[#8B9AA6]">
                Non-custodial BSC spot swap for curated meme assets.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-[12px]">
              <span className="rounded-[6px] border border-[#244C47] bg-[#102721] px-3 py-1.5 text-[#8FF7E8]">
                DEXI fee 0 bps
              </span>
              <span className="rounded-[6px] border border-[#2B3542] bg-[#111A22] px-3 py-1.5 text-[#A7B2BE]">
                BSC Mainnet
              </span>
              <span className="rounded-[6px] border border-[#2B3542] bg-[#111A22] px-3 py-1.5 text-[#A7B2BE]">
                Pancake V2
              </span>
            </div>
          </div>

          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="p-5">
              <div className="rounded-[10px] border border-[#22313A] bg-[#0A1118] p-4">
                <div className="grid gap-4 md:grid-cols-[1fr_180px]">
                  <div>
                    <label className="mb-2 block text-[12px] uppercase tracking-normal text-[#7D8A96]">
                      You pay
                    </label>
                    <input
                      value={amount}
                      onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ""))}
                      placeholder="0.00"
                      inputMode="decimal"
                      className="h-14 w-full rounded-[8px] border border-[#2B3542] bg-[#101820] px-4 font-mono text-[24px] text-white outline-none transition-colors placeholder:text-[#52606A] focus:border-[#5EEAD4]"
                    />
                    <div className="mt-2 flex items-center justify-between text-[12px] text-[#7D8A96]">
                      <span>Balance: {balanceLabel}</span>
                      <button onClick={setMaxAmount} className="font-semibold text-[#5EEAD4] hover:text-[#8FF7E8]">
                        MAX
                      </button>
                    </div>
                  </div>
                  <TokenSelect
                    label="From"
                    value={fromSymbol}
                    onChange={(symbol) => handleTokenChange("from", symbol)}
                  />
                </div>

                <div className="my-4 flex justify-center">
                  <button
                    onClick={flipTokens}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-[#2B3542] bg-[#101820] text-[#A7B2BE] transition-colors hover:border-[#5EEAD4] hover:text-[#5EEAD4]"
                    aria-label="Flip tokens"
                  >
                    <ArrowDownUp className="h-4 w-4" />
                  </button>
                </div>

                <div className="grid gap-4 md:grid-cols-[1fr_180px]">
                  <div>
                    <label className="mb-2 block text-[12px] uppercase tracking-normal text-[#7D8A96]">
                      You receive
                    </label>
                    <div className="flex h-14 items-center rounded-[8px] border border-[#2B3542] bg-[#101820] px-4 font-mono text-[24px] text-white">
                      <span data-testid="swap-output-amount">
                        {isQuoting ? "..." : quote ? formatAmount(quote.amountOutFormatted, 8) : "0.00"}
                      </span>
                    </div>
                    <div className="mt-2 text-[12px] text-[#7D8A96]" data-testid="swap-min-received">
                      Minimum received: {quote ? `${formatAmount(quote.minAmountOutFormatted, 8)} ${toSymbol}` : "--"}
                    </div>
                  </div>
                  <TokenSelect label="To" value={toSymbol} onChange={(symbol) => handleTokenChange("to", symbol)} />
                </div>

                <div className="mt-4 rounded-[8px] border border-[#1E2B35] bg-[#0D151D] p-3">
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-[#8B9AA6]">Slippage</span>
                    <div className="flex gap-2">
                      {[30, 50, 100, 300].map((value) => (
                        <button
                          key={value}
                          onClick={() => setSlippageBps(value)}
                          className={`h-8 rounded-[6px] border px-3 text-[12px] font-semibold ${
                            slippageBps === value
                              ? "border-[#5EEAD4] bg-[#15332F] text-[#8FF7E8]"
                              : "border-[#2B3542] bg-[#101820] text-[#A7B2BE] hover:border-[#465565]"
                          }`}
                        >
                          {(value / 100).toFixed(value % 100 === 0 ? 0 : 1)}%
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-[12px] text-[#8B9AA6] md:grid-cols-3">
                    <div className="rounded-[6px] bg-[#101820] p-2">
                      <span className="block">Route</span>
                      <span className="mt-1 block font-mono text-white" data-testid="swap-route">
                        {quote?.routeSymbols?.join(" > ") || "--"}
                      </span>
                    </div>
                    <div className="rounded-[6px] bg-[#101820] p-2">
                      <span className="block">DEXI fee</span>
                      <span className="mt-1 block font-mono text-[#8FF7E8]">0.00%</span>
                    </div>
                    <div className="rounded-[6px] bg-[#101820] p-2">
                      <span className="block">Router</span>
                      <span className="mt-1 block font-mono text-white">Pancake V2</span>
                    </div>
                  </div>
                </div>

                {(quoteError || actionError) && (
                  <div className="mt-4 rounded-[8px] border border-[#5D2630] bg-[#241015] p-3 text-[12px] leading-5 text-[#FF9AA8]">
                    {actionError || quoteError}
                  </div>
                )}

                <button
                  onClick={handlePrimaryAction}
                  disabled={primaryDisabled}
                  className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-[#5EEAD4] text-[15px] font-semibold text-[#061215] transition-colors hover:bg-[#8FF7E8] disabled:cursor-not-allowed disabled:bg-[#24313A] disabled:text-[#687784]"
                >
                  {!isConnected ? <Wallet className="h-4 w-4" /> : isBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                  {primaryLabel}
                </button>

                {swapHash && (
                  <a
                    href={`https://bscscan.com/tx/${swapHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-[#5EEAD4] hover:text-[#8FF7E8]"
                  >
                    View swap transaction
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {isSwapConfirmed && (
                  <div className="mt-3 rounded-[8px] border border-[#244C47] bg-[#102721] p-3 text-[12px] text-[#8FF7E8]">
                    Swap confirmed on BSC.
                  </div>
                )}
              </div>
            </div>

            <aside className="border-t border-[#22313A] p-5 lg:border-l lg:border-t-0">
              <div className="rounded-[10px] border border-[#22313A] bg-[#0A1118] p-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-[#5EEAD4]" />
                  <div className="text-[15px] font-semibold">Execution policy</div>
                </div>
                <div className="mt-4 space-y-3 text-[13px] leading-5 text-[#A7B2BE]">
                  <div className="flex justify-between gap-3 border-b border-[#1E2B35] pb-3">
                    <span>Platform fee</span>
                    <span className="font-mono text-[#8FF7E8]">0 bps</span>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-[#1E2B35] pb-3">
                    <span>Custody</span>
                    <span className="font-mono text-white">Wallet direct</span>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-[#1E2B35] pb-3">
                    <span>Router</span>
                    <span className="font-mono text-white">Pancake V2</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Whitelist</span>
                    <span className="font-mono text-white">{enabledTokens.length} enabled</span>
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-[10px] border border-[#22313A] bg-[#0A1118] p-4">
                <div className="text-[15px] font-semibold">Token status</div>
                <div className="mt-3 space-y-2">
                  {allTokens.map((token) => (
                    <div key={token.symbol} className="flex items-center justify-between text-[12px]">
                      <span className="font-semibold text-white">{token.symbol}</span>
                      <span className={token.enabled ? "text-[#8FF7E8]" : "text-[#F5B544]"}>
                        {token.enabled ? "enabled" : "pending BSC address"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}
