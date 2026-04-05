/**
 * Shared test helpers for production-grade E2E tests
 * All order submission uses real EIP-712 signatures — NO shortcuts
 */
import { type Address, type Hex } from "viem";
import { signOrder, type OrderParams } from "./eip712-signer";

const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";

/**
 * Get current nonce for a trader from the engine
 */
export async function getNonce(trader: string): Promise<number> {
  const resp = await fetch(`${ENGINE}/api/user/${trader}/nonce`);
  const data = await resp.json() as any;
  return parseInt(data.nonce || "0", 10);
}

/**
 * Submit a signed order to the matching engine
 * Uses real EIP-712 signature (production-grade)
 */
export async function submitSignedOrder(params: {
  wallet: { address: string; privateKey: string };
  token: string;
  isLong: boolean;
  size: string;
  leverage: number;
  orderType?: number;   // 0=market, 1=limit (default: 0)
  price?: string;       // limit price (default: "0" for market)
  reduceOnly?: boolean;
}): Promise<any> {
  const {
    wallet,
    token,
    isLong,
    size,
    leverage,
    orderType = 0,
    price = "0",
    reduceOnly = false,
  } = params;

  const nonce = await getNonce(wallet.address);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const orderParams: OrderParams = {
    trader: wallet.address as Address,
    token: token as Address,
    isLong,
    orderType,
    size: BigInt(size),
    leverage: BigInt(leverage),
    price: BigInt(price),
    deadline,
    nonce: BigInt(nonce),
  };

  const signature = await signOrder(wallet.privateKey as Hex, orderParams);

  const resp = await fetch(`${ENGINE}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trader: wallet.address,
      token,
      isLong,
      orderType,
      size,
      leverage,
      price,
      reduceOnly,
      deadline: deadline.toString(),
      nonce,
      signature,
    }),
  });

  return resp.json();
}

/**
 * Get positions for a trader
 */
export async function getPositions(trader: string): Promise<any[]> {
  const resp = await fetch(`${ENGINE}/api/user/${trader}/positions`);
  if (!resp.ok) return [];
  const data = await resp.json() as any;
  return data.positions || data || [];
}

/**
 * Get balance for a trader
 */
export async function getBalance(trader: string): Promise<bigint> {
  const resp = await fetch(`${ENGINE}/api/user/${trader}/balance`);
  if (!resp.ok) return 0n;
  const data = await resp.json() as any;
  return BigInt(data.totalBalance || data.available || data.balance || "0");
}

/**
 * Check engine health
 */
export async function checkHealth(): Promise<any> {
  const resp = await fetch(`${ENGINE}/health`);
  return resp.json();
}
