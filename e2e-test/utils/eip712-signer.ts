/**
 * EIP-712 Signer for Order Submission
 *
 * CRITICAL: Domain + ORDER_TYPES must EXACTLY match the matching engine's
 * definition in backend/src/matching/server.ts (lines 222-241).
 *
 * Engine uses: version "1", verifyingContract = SETTLEMENT_ADDRESS (V1),
 * field order: trader, token, isLong, size, leverage, price, deadline, nonce, orderType
 */
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { ENV } from "../config/test-config";

// ⚠️ Must match engine's EIP712_DOMAIN exactly (server.ts:222-227)
// Engine uses SETTLEMENT_ADDRESS (V1), NOT SettlementV2
const SETTLEMENT_V1_ADDRESS = "0x32de01f0E464521583E52d50f125492D10EfDBB3" as Address;

const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "token", type: "address" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "leverage", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
  ],
} as const;

const DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: 97,
  verifyingContract: SETTLEMENT_V1_ADDRESS,
} as const;

export interface OrderParams {
  trader: Address;
  token: Address;
  isLong: boolean;
  orderType: number; // 0=market, 1=limit
  size: bigint;
  leverage: bigint;
  price: bigint;
  deadline: bigint;
  nonce: bigint;
}

export async function signOrder(privateKey: Hex, order: OrderParams): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain: bscTestnet,
    transport: http(ENV.RPC_URL),
  });

  // ⚠️ Message field order must match ORDER_TYPES definition above
  // Engine verifies with: trader, token, isLong, size, leverage, price, deadline, nonce, orderType
  const signature = await client.signTypedData({
    domain: DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      trader: order.trader,
      token: order.token,
      isLong: order.isLong,
      size: order.size,
      leverage: order.leverage,
      price: order.price,
      deadline: order.deadline,
      nonce: order.nonce,
      orderType: order.orderType,
    },
  });

  return signature;
}

/**
 * Sign a personal message (for trading wallet derivation)
 */
export async function signPersonalMessage(privateKey: Hex, message: string): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain: bscTestnet,
    transport: http(ENV.RPC_URL),
  });

  return client.signMessage({ message });
}
