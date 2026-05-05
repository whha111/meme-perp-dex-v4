"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  ArrowDownUp,
  ChevronDown,
  ExternalLink,
  RefreshCw,
  Search,
  Wallet,
} from "lucide-react";
import { erc20Abi, parseUnits, type Address } from "viem";
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
const marketTokens = SWAP_TOKENS.filter((token) => token.enabled && !["BNB", "USDT"].includes(token.symbol));
const allTokens = SWAP_TOKENS;

const tokenMetrics: Record<string, {
  price: string;
  cap: string;
  fdv: string;
  liquidity: string;
  supply: string;
  change: string;
  volume: string;
  buys: string;
  sells: string;
  holders: string;
  age: string;
}> = {
  DOGE: {
    price: "$0.18420",
    cap: "$26.4B",
    fdv: "$26.4B",
    liquidity: "$42.1M",
    supply: "146.3B / 146.3B",
    change: "+2.14%",
    volume: "$842.6M",
    buys: "$12.8M",
    sells: "$11.9M",
    holders: "5.2M",
    age: "11y",
  },
  SHIB: {
    price: "$0.0000142",
    cap: "$8.4B",
    fdv: "$8.4B",
    liquidity: "$18.7M",
    supply: "589T / 589T",
    change: "+1.06%",
    volume: "$214.5M",
    buys: "$4.9M",
    sells: "$4.4M",
    holders: "1.4M",
    age: "5y",
  },
  PEPE: {
    price: "$0.00000972",
    cap: "$4.1B",
    fdv: "$4.1B",
    liquidity: "$27.8M",
    supply: "420.6T / 420.6T",
    change: "+3.88%",
    volume: "$356.1M",
    buys: "$8.6M",
    sells: "$7.1M",
    holders: "438K",
    age: "3y",
  },
  FLOKI: {
    price: "$0.000112",
    cap: "$1.1B",
    fdv: "$1.1B",
    liquidity: "$9.9M",
    supply: "9.7T / 10T",
    change: "-0.64%",
    volume: "$75.2M",
    buys: "$1.8M",
    sells: "$2.2M",
    holders: "473K",
    age: "5y",
  },
};

const fallbackMetrics = tokenMetrics.PEPE;

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

function cleanDecimalInput(value: string) {
  const normalized = value.replace(/[^\d.]/g, "");
  const parts = normalized.split(".");
  if (parts.length <= 2) return normalized;
  return `${parts[0]}.${parts.slice(1).join("")}`;
}

function tokenInitial(symbol: string) {
  return symbol.slice(0, 1).toUpperCase();
}

function generateCandles(symbol: string) {
  const seed = symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return Array.from({ length: 74 }, (_, index) => {
    const trend = index * 1.38;
    const wave = Math.sin((index + seed) / 5) * 28 + Math.cos((index + seed) / 11) * 18;
    const close = 238 - trend + wave + (index > 45 ? (index - 45) * 2.8 : 0);
    const open = close + Math.sin((index + seed) / 3) * 22;
    const high = Math.min(open, close) - 22 - Math.abs(Math.cos(index / 4) * 18);
    const low = Math.max(open, close) + 20 + Math.abs(Math.sin(index / 6) * 22);
    const volume = 20 + Math.abs(Math.sin((index + seed) / 4)) * 64 + (index % 13 === 0 ? 60 : 0);
    return { open, close, high, low, volume };
  });
}

function MarketHeader({
  marketSymbol,
  onMarketChange,
}: {
  marketSymbol: string;
  onMarketChange: (symbol: string) => void;
}) {
  const metrics = tokenMetrics[marketSymbol] || fallbackMetrics;
  const positive = metrics.change.startsWith("+");

  const stats = [
    ["Market Cap", metrics.cap],
    ["Price", metrics.price],
    ["FDV", metrics.fdv],
    ["Liquidity", metrics.liquidity],
    ["Circulating/Total", metrics.supply],
    ["24h Change", metrics.change],
    ["24h Volume", metrics.volume],
    ["Buys 24h", metrics.buys],
    ["Sells 24h", metrics.sells],
  ];

  return (
    <header className="flex min-h-[52px] items-stretch border-b border-[#30343B] bg-[#1F2024]">
      <div className="flex min-w-[220px] items-center gap-3 border-r border-[#30343B] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#5EEAD4] text-[14px] font-black text-[#071215]">
          {tokenInitial(marketSymbol)}
        </span>
        <label className="relative">
          <select
            value={marketSymbol}
            onChange={(event) => onMarketChange(event.target.value)}
            className="appearance-none bg-transparent pr-6 text-[18px] font-semibold text-white outline-none"
          >
            {marketTokens.map((token) => (
              <option key={token.symbol} value={token.symbol}>
                {token.symbol}/USD
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9AA3AD]" />
        </label>
      </div>
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {stats.map(([label, value]) => (
          <div key={label} className="flex min-w-[132px] flex-col justify-center border-r border-[#30343B] px-4">
            <span className="text-[12px] text-[#9AA3AD]">{label}</span>
            <span
              className={`mt-0.5 font-mono text-[14px] font-semibold ${
                label.includes("Change") ? (positive ? "text-[#20D7A1]" : "text-[#F45B69]") : "text-[#F3F7F9]"
              }`}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </header>
  );
}

function TerminalChart({ marketSymbol }: { marketSymbol: string }) {
  const candles = useMemo(() => generateCandles(marketSymbol), [marketSymbol]);
  const metrics = tokenMetrics[marketSymbol] || fallbackMetrics;

  return (
    <section className="flex min-h-0 flex-1 flex-col border-r border-[#30343B] bg-[#202124]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#30343B] px-3 text-[13px] text-[#B6BDC7]">
        <div className="flex items-center gap-3">
          {["1D", "5D", "1M", "6M", "YTD", "1Y"].map((item, index) => (
            <button
              key={item}
              className={`h-7 rounded-[4px] px-2 ${index === 0 ? "bg-[#333844] text-white" : "hover:bg-[#2B2E36]"}`}
            >
              {item}
            </button>
          ))}
          <span className="h-5 w-px bg-[#3A3F48]" />
          <button className="text-[#B6BDC7] hover:text-white">Indicators</button>
          <button className="text-[#B6BDC7] hover:text-white">Order line</button>
        </div>
        <div className="hidden items-center gap-4 md:flex">
          <span className="font-semibold text-white">{marketSymbol}/USD - 1D - Spot</span>
          <span className={metrics.change.startsWith("+") ? "text-[#20D7A1]" : "text-[#F45B69]"}>
            {metrics.change}
          </span>
        </div>
      </div>

      <div className="relative min-h-[420px] flex-1 overflow-hidden bg-[#202124]">
        <div className="absolute left-4 top-4 z-10 rounded-[4px] bg-[#202124]/85 px-2 py-1 text-[13px]">
          <span className="font-semibold text-white">{marketSymbol}/USD - 1D - DEXI</span>
          <span className="ml-3 text-[#20D7A1]">O {metrics.price}</span>
          <span className="ml-2 text-[#F45B69]">H {metrics.price}</span>
          <span className="ml-2 text-[#9AA3AD]">L {metrics.price}</span>
          <span className="ml-2 text-[#20D7A1]">C {metrics.price}</span>
        </div>
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1120 520" preserveAspectRatio="none">
          <defs>
            <pattern id="spotGrid" width="72" height="48" patternUnits="userSpaceOnUse">
              <path d="M 72 0 L 0 0 0 48" fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="1120" height="520" fill="url(#spotGrid)" />
          <line x1="0" x2="1120" y1="295" y2="295" stroke="#5EEAD4" strokeDasharray="3 5" strokeOpacity="0.75" />
          <rect x="1036" y="283" width="70" height="24" rx="4" fill="#5EEAD4" />
          <text x="1071" y="300" textAnchor="middle" fill="#071215" fontSize="13" fontWeight="700">
            {metrics.price.replace("$", "")}
          </text>
          {candles.map((candle, index) => {
            const x = 24 + index * 14.4;
            const yOpen = Math.max(70, Math.min(370, candle.open));
            const yClose = Math.max(70, Math.min(370, candle.close));
            const yHigh = Math.max(54, Math.min(390, candle.high));
            const yLow = Math.max(54, Math.min(390, candle.low));
            const up = yClose <= yOpen;
            const y = Math.min(yOpen, yClose);
            const height = Math.max(3, Math.abs(yOpen - yClose));
            const color = up ? "#20D7A1" : "#F45B69";
            return (
              <g key={`${marketSymbol}-${index}`}>
                <line x1={x + 4} x2={x + 4} y1={yHigh} y2={yLow} stroke={color} strokeWidth="1.6" />
                <rect x={x} y={y} width="8" height={height} fill={color} rx="1" />
                <rect
                  x={x}
                  y={456 - candle.volume}
                  width="8"
                  height={candle.volume}
                  fill={color}
                  opacity="0.38"
                />
              </g>
            );
          })}
          {[0, 1, 2, 3, 4].map((tick) => (
            <text key={tick} x="1086" y={88 + tick * 72} fill="#C8CED6" fontSize="13" textAnchor="end">
              {(Number(metrics.price.replace("$", "")) * (1 + (2 - tick) * 0.08)).toPrecision(5)}
            </text>
          ))}
          <text x="40" y="492" fill="#9AA3AD" fontSize="13">Sep</text>
          <text x="260" y="492" fill="#9AA3AD" fontSize="13">Nov</text>
          <text x="500" y="492" fill="#9AA3AD" fontSize="13">Jan</text>
          <text x="760" y="492" fill="#9AA3AD" fontSize="13">Mar</text>
          <text x="996" y="492" fill="#9AA3AD" fontSize="13">May</text>
        </svg>
      </div>
    </section>
  );
}

function TokenSelect({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (symbol: string) => void;
  compact?: boolean;
}) {
  return (
    <label className="relative block">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full appearance-none rounded-[8px] border border-[#3A3F48] bg-[#2A2C31] pr-9 text-[14px] font-semibold text-white outline-none transition-colors focus:border-[#5EEAD4] ${
          compact ? "h-9 pl-3" : "h-11 pl-3"
        }`}
      >
        {allTokens.map((token) => (
          <option key={token.symbol} value={token.symbol} disabled={!token.enabled}>
            {token.symbol} {token.enabled ? "" : "(pending)"}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9AA3AD]" />
    </label>
  );
}

function OrderFeed({ marketSymbol }: { marketSymbol: string }) {
  const metrics = tokenMetrics[marketSymbol] || fallbackMetrics;
  const base = Number(metrics.price.replace("$", "")) || 0.00001;
  const rows = Array.from({ length: 18 }, (_, index) => {
    const sell = index < 9;
    const drift = sell ? 1 + (9 - index) * 0.0018 : 1 - (index - 8) * 0.0016;
    return {
      sell,
      amount: sell ? `${(0.12 + index * 0.09).toFixed(4)}` : `${(0.18 + index * 0.07).toFixed(4)}`,
      price: base * drift,
      time: `02:${String(45 + index).padStart(2, "0")}:08`,
    };
  });

  return (
    <section className="hidden w-[300px] shrink-0 flex-col border-r border-[#30343B] bg-[#202124] xl:flex">
      <div className="grid h-10 grid-cols-3 items-center border-b border-[#30343B] px-3 text-[12px] text-[#9AA3AD]">
        <span>Amount {marketSymbol}</span>
        <span className="text-right">Price USD</span>
        <span className="text-right">Time</span>
      </div>
      <div className="flex-1 overflow-hidden px-3 py-2">
        {rows.map((row, index) => (
          <div key={index} className="grid h-6 grid-cols-3 items-center font-mono text-[12px]">
            <span className={row.sell ? "text-[#F45B69]" : "text-[#20D7A1]"}>{row.amount}</span>
            <span className="text-right text-white">{row.price < 0.001 ? row.price.toFixed(10) : row.price.toFixed(5)}</span>
            <span className="text-right text-[#9AA3AD]">{row.time}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function BottomPanel({ marketSymbol }: { marketSymbol: string }) {
  return (
    <section className="h-[246px] shrink-0 border-t border-[#30343B] bg-[#202124]">
      <div className="flex h-10 items-center justify-between border-b border-[#30343B] px-4">
        <div className="flex h-full items-center gap-6 text-[13px]">
          {["Holdings", "Trades", "Orders", "History"].map((tab, index) => (
            <button key={tab} className={`h-full border-b-2 ${index === 0 ? "border-[#5EEAD4] text-white" : "border-transparent text-[#9AA3AD]"}`}>
              {tab}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-[#9AA3AD]">Wallet required</span>
      </div>
      <div className="flex h-[205px] items-center justify-center text-center">
        <div>
          <div className="mx-auto mb-3 h-10 w-10 rounded-[8px] border border-[#444A56] bg-[#272A31]" />
          <div className="text-[14px] text-[#C8CED6]">Holdings are empty</div>
          <div className="mt-1 text-[12px] text-[#828B96]">Connect wallet to view {marketSymbol} spot balances and fills.</div>
        </div>
      </div>
    </section>
  );
}

export function SwapClientPage() {
  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync: writeApproveAsync, isPending: isApprovePending } = useWriteContract();
  const { writeContractAsync: writeSwapAsync, isPending: isSwapPending } = useWriteContract();

  const [marketSymbol, setMarketSymbol] = useState("PEPE");
  const [side, setSide] = useState<"buy" | "sell">("buy");
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
  const metrics = tokenMetrics[marketSymbol] || fallbackMetrics;
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
    }, 200);

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

  const setTradeSide = (nextSide: "buy" | "sell") => {
    setSide(nextSide);
    setAmount("");
    setQuote(null);
    setQuoteError(null);
    if (nextSide === "buy") {
      setFromSymbol("BNB");
      setToSymbol(marketSymbol);
    } else {
      setFromSymbol(marketSymbol);
      setToSymbol("BNB");
    }
  };

  const selectMarket = (symbol: string) => {
    setMarketSymbol(symbol);
    setQuote(null);
    setQuoteError(null);
    if (side === "buy") {
      setToSymbol(symbol);
      if (fromSymbol === symbol) setFromSymbol("BNB");
    } else {
      setFromSymbol(symbol);
      if (toSymbol === symbol) setToSymbol("BNB");
    }
  };

  const flipTokens = () => {
    setFromSymbol(toSymbol);
    setToSymbol(fromSymbol);
    setSide(side === "buy" ? "sell" : "buy");
    setQuote(null);
    setQuoteError(null);
  };

  const handlePreset = (usdAmount: number) => {
    if (fromSymbol === "USDT") {
      setAmount(String(usdAmount));
      return;
    }
    if (fromSymbol === "BNB") {
      setAmount((usdAmount / 620).toFixed(4));
      return;
    }
    const approxTokenPrice = Number(metrics.price.replace("$", "")) || 1;
    setAmount(formatAmount(usdAmount / approxTokenPrice, 4).replace(/,/g, ""));
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
          ? "Confirming"
          : side === "buy"
            ? `Buy ${marketSymbol}`
            : `Sell ${marketSymbol}`;

  const primaryDisabled =
    isBusy ||
    (!!isConnected && !isWrongNetwork && !needsApproval && !quote) ||
    !parsedAmount ||
    fromSymbol === toSymbol;

  return (
    <main className="min-h-[calc(100vh-44px)] bg-[#202124] text-white">
      <span className="sr-only" data-testid="swap-client-ready" data-ready={clientReady ? "true" : "false"} />
      <div className="border-b border-[#30343B] bg-[#15171C] px-4 py-2 text-[13px] text-[#5EEAD4]">
        DEXI fee 0 bps. Spot trades route directly through PancakeSwap V2 on BSC.
      </div>

      <MarketHeader marketSymbol={marketSymbol} onMarketChange={selectMarket} />

      <div className="grid min-h-[calc(100vh-137px)] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_370px]">
        <div className="flex min-h-[720px] min-w-0 flex-col">
          <div className="flex min-h-0 flex-1">
            <TerminalChart marketSymbol={marketSymbol} />
            <OrderFeed marketSymbol={marketSymbol} />
          </div>
          <BottomPanel marketSymbol={marketSymbol} />
        </div>

        <aside className="border-l border-[#30343B] bg-[#25262A]">
          <section className="border-b border-[#30343B] p-4">
            <div className="grid grid-cols-2 gap-2 rounded-[8px] bg-[#1B1C20] p-1">
              <button
                onClick={() => setTradeSide("buy")}
                className={`h-10 rounded-[7px] text-[15px] font-semibold ${
                  side === "buy" ? "bg-[#155E4D] text-[#5EEAD4]" : "text-[#AEB6C0] hover:bg-[#2C2F36]"
                }`}
              >
                Buy
              </button>
              <button
                onClick={() => setTradeSide("sell")}
                className={`h-10 rounded-[7px] text-[15px] font-semibold ${
                  side === "sell" ? "bg-[#6E202B] text-[#FF7D8B]" : "text-[#AEB6C0] hover:bg-[#2C2F36]"
                }`}
              >
                Sell
              </button>
            </div>

            <div className="mt-4 rounded-[8px] bg-[#303136] p-4">
              <div className="mb-2 flex items-center justify-between text-[13px] text-[#AEB6C0]">
                <span>Amount</span>
                <span>{balanceLabel}</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-2">
                <input
                  value={amount}
                  onChange={(event) => setAmount(cleanDecimalInput(event.target.value))}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="h-14 min-w-0 rounded-[8px] border border-[#424650] bg-[#24262B] px-4 font-mono text-[28px] text-white outline-none placeholder:text-[#6E7480] focus:border-[#5EEAD4]"
                />
                <TokenSelect value={fromSymbol} onChange={setFromSymbol} />
              </div>
              <div className="mt-2 flex items-center justify-between text-[12px] text-[#9AA3AD]">
                <button onClick={setMaxAmount} className="font-semibold text-[#5EEAD4] hover:text-[#8FF7E8]">
                  MAX
                </button>
                <button
                  onClick={flipTokens}
                  className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 hover:bg-[#3A3D45]"
                >
                  <ArrowDownUp className="h-3.5 w-3.5" />
                  Flip
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              {[50, 100, 250, 500].map((preset) => (
                <button
                  key={preset}
                  onClick={() => handlePreset(preset)}
                  className="h-10 rounded-[8px] border border-[#3A3F48] bg-[#2C2E34] text-[14px] font-semibold text-[#DDE3EA] hover:border-[#5EEAD4]"
                >
                  ${preset}
                </button>
              ))}
            </div>

            <div className="mt-4 rounded-[8px] border border-[#363B45] bg-[#1F2024] p-3">
              <div className="mb-3 flex items-center justify-between text-[12px] text-[#9AA3AD]">
                <span>You receive</span>
                <TokenSelect value={toSymbol} onChange={setToSymbol} compact />
              </div>
              <div className="font-mono text-[24px] text-white" data-testid="swap-output-amount">
                {isQuoting ? "..." : quote ? formatAmount(quote.amountOutFormatted, 8) : "0.00"}
              </div>
              <div className="mt-2 text-[12px] text-[#9AA3AD]" data-testid="swap-min-received">
                Min received: {quote ? `${formatAmount(quote.minAmountOutFormatted, 8)} ${toSymbol}` : "--"}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between gap-2 text-[12px]">
              <span className="text-[#9AA3AD]">Slippage</span>
              <div className="flex gap-1">
                {[30, 50, 100].map((value) => (
                  <button
                    key={value}
                    onClick={() => setSlippageBps(value)}
                    className={`h-7 rounded-[6px] px-2 font-semibold ${
                      slippageBps === value ? "bg-[#5EEAD4] text-[#071215]" : "bg-[#303136] text-[#DDE3EA]"
                    }`}
                  >
                    {(value / 100).toFixed(value % 100 === 0 ? 0 : 1)}%
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handlePrimaryAction}
              disabled={primaryDisabled}
              className={`mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-[8px] text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:border disabled:border-[#444852] disabled:bg-transparent disabled:text-[#8D96A2] ${
                side === "buy"
                  ? "bg-[#5EEAD4] text-[#071215] hover:bg-[#8FF7E8]"
                  : "bg-[#F45B69] text-white hover:bg-[#FF7D8B]"
              }`}
            >
              {!isConnected ? <Wallet className="h-4 w-4" /> : isBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
              {primaryLabel}
            </button>

            <div className="mt-4 rounded-[8px] border border-[#363B45] bg-[#1F2024] p-3 text-[12px]">
              <div className="flex justify-between gap-3 border-b border-[#30343B] pb-2">
                <span className="text-[#9AA3AD]">Route</span>
                <span className="font-mono text-white" data-testid="swap-route">
                  {quote?.routeSymbols?.join(" > ") || "--"}
                </span>
              </div>
              <div className="flex justify-between gap-3 border-b border-[#30343B] py-2">
                <span className="text-[#9AA3AD]">Platform fee</span>
                <span className="font-mono text-[#5EEAD4]">0 bps</span>
              </div>
              <div className="flex justify-between gap-3 pt-2">
                <span className="text-[#9AA3AD]">Router</span>
                <span className="font-mono text-white">Pancake V2</span>
              </div>
            </div>

            {(quoteError || actionError) && (
              <div className="mt-3 rounded-[8px] border border-[#6E202B] bg-[#33161B] p-3 text-[12px] leading-5 text-[#FF9AA8]">
                {actionError || quoteError}
              </div>
            )}

            {swapHash && (
              <a
                href={`https://bscscan.com/tx/${swapHash}`}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-[#5EEAD4] hover:text-[#8FF7E8]"
              >
                View transaction
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {isSwapConfirmed && (
              <div className="mt-3 rounded-[8px] border border-[#155E4D] bg-[#0F2A24] p-3 text-[12px] text-[#5EEAD4]">
                Swap confirmed on BSC.
              </div>
            )}
          </section>

          <section className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <Search className="h-4 w-4 text-[#9AA3AD]" />
              <span className="text-[15px] font-semibold">Token Info</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                ["Holders", metrics.holders],
                ["Top 10", "0.00%"],
                ["Age", metrics.age],
                ["Snipers", "--"],
                ["Bundles", "--"],
                ["Insiders", "--"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-[8px] border border-[#363B45] bg-[#1F2024] p-3 text-center">
                  <div className="font-mono text-[15px] font-semibold text-white">{value}</div>
                  <div className="mt-1 text-[11px] text-[#9AA3AD]">{label}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-[8px] border border-[#363B45] bg-[#1F2024] p-3 text-[12px] text-[#9AA3AD]">
              <div className="flex justify-between">
                <span>DEXI whitelist</span>
                <span className="font-mono text-[#5EEAD4]">{enabledTokens.length} enabled</span>
              </div>
              <div className="mt-2 flex justify-between">
                <span>Custody</span>
                <span className="font-mono text-white">Wallet direct</span>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
