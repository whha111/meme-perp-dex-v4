import { NextResponse } from "next/server";
import { PANCAKE_V2_ROUTER, SWAP_TOKENS, WBNB_ADDRESS } from "@/lib/swapTokens";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    chainId: 56,
    router: PANCAKE_V2_ROUTER,
    wrappedNative: WBNB_ADDRESS,
    feeBps: 0,
    tokens: SWAP_TOKENS,
  });
}
