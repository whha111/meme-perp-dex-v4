import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, formatUnits, http, parseUnits } from "viem";
import { bsc } from "viem/chains";
import {
  PANCAKE_V2_ROUTER,
  PANCAKE_V2_ROUTER_ABI,
  getSwapPath,
  getSwapToken,
} from "@/lib/swapTokens";

export const dynamic = "force-dynamic";

const rpcUrl =
  process.env.NEXT_PUBLIC_BSC_MAINNET_RPC_URL ||
  process.env.NEXT_PUBLIC_BSC_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://bsc-dataseed.bnbchain.org/";

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(rpcUrl, { timeout: 4500 }),
});

function error(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const fromSymbol = searchParams.get("from") || "";
  const toSymbol = searchParams.get("to") || "";
  const amount = searchParams.get("amount") || "";
  const slippageBps = Number(searchParams.get("slippageBps") || "50");

  const from = getSwapToken(fromSymbol);
  const to = getSwapToken(toSymbol);

  if (!from || !to) return error("Unsupported swap token");
  if (!from.enabled || !to.enabled) return error("Token is not enabled for BSC swap");
  if (from.symbol === to.symbol) return error("Choose two different tokens");
  if (!amount || Number(amount) <= 0) return error("Enter a valid amount");
  if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > 300) {
    return error("Slippage must be between 0.01% and 3%");
  }

  const path = getSwapPath(from, to);
  if (path.length < 2) return error("Invalid swap path");

  let amountIn: bigint;
  try {
    amountIn = parseUnits(amount, from.decimals);
  } catch {
    return error("Invalid amount precision");
  }

  try {
    const amounts = await publicClient.readContract({
      address: PANCAKE_V2_ROUTER,
      abi: PANCAKE_V2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, path],
    });

    const amountOut = amounts[amounts.length - 1];
    const minAmountOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

    return NextResponse.json({
      chainId: 56,
      router: PANCAKE_V2_ROUTER,
      feeBps: 0,
      protocol: "PancakeSwap V2",
      from,
      to,
      amountIn: amountIn.toString(),
      amountInFormatted: formatUnits(amountIn, from.decimals),
      amountOut: amountOut.toString(),
      amountOutFormatted: formatUnits(amountOut, to.decimals),
      minAmountOut: minAmountOut.toString(),
      minAmountOutFormatted: formatUnits(minAmountOut, to.decimals),
      slippageBps,
      path,
      routeSymbols: path.map((address) => {
        const matched = [from, to].find(
          (token) => token.wrappedAddress.toLowerCase() === address.toLowerCase()
        );
        return matched?.symbol || "WBNB";
      }),
      validUntil: Date.now() + 15_000,
    });
  } catch (quoteError) {
    const detail = quoteError instanceof Error ? quoteError.message : "Quote failed";
    return error(`No Pancake route for this amount: ${detail}`, 422);
  }
}
