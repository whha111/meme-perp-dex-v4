/**
 * Relay Service Module — SettlementV2 Compatible
 *
 * Implements relay service for gasless deposits on SettlementV2.
 * SettlementV2 is a dYdX-style contract: off-chain execution + on-chain attestation.
 *
 * Supported operations:
 * - depositFor(user, amount) — ERC-20 collateral deposit on behalf of user
 * - userDeposits(user) — Read user's on-chain deposit total
 * - withdrawalNonces(user) — Read user's withdrawal nonce
 *
 * Withdrawal flow is user-initiated via SettlementV2.withdraw() with Merkle proof.
 * See withdraw.ts for the full withdrawal authorization flow.
 */

import { createWalletClient, createPublicClient, http, fallback, defineChain, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet } from "viem/chains";
import { SETTLEMENT_V2_ADDRESS as SETTLEMENT_ADDRESS, COLLATERAL_TOKEN_ADDRESS, RPC_URL as CONFIG_RPC_URL, CHAIN_ID } from "../config";

// ============================================================
// Configuration
// ============================================================

const RELAY_RPC_URL = CONFIG_RPC_URL;
const RPC_FALLBACK_URLS = (process.env.RPC_FALLBACK_URLS || "").split(",").filter(Boolean);
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY as Hex;

if (!RELAYER_PRIVATE_KEY) {
  console.warn("[Relay] ⚠️  RELAYER_PRIVATE_KEY not set - relay service disabled");
}

if (!SETTLEMENT_ADDRESS) {
  console.warn("[Relay] ⚠️  SETTLEMENT_ADDRESS not set - relay service disabled");
}

// Select chain based on CHAIN_ID from config (synced with .env)
const activeChain = CHAIN_ID === 97 ? bscTestnet : bsc;

// Create relayer account
const relayerAccount = RELAYER_PRIVATE_KEY ? privateKeyToAccount(RELAYER_PRIVATE_KEY) : null;

// RPC transport with fallback
const rpcTransport = RPC_FALLBACK_URLS.length > 0
  ? fallback([http(RELAY_RPC_URL), ...RPC_FALLBACK_URLS.map((url) => http(url))])
  : http(RELAY_RPC_URL);

// Create clients
const publicClient = createPublicClient({
  chain: activeChain,
  transport: rpcTransport,
});

const walletClient = relayerAccount
  ? createWalletClient({
      account: relayerAccount,
      chain: activeChain,
      transport: rpcTransport,
    })
  : null;

// ============================================================
// SettlementV2 ABI (only the functions relay needs)
// ============================================================

const SETTLEMENT_V2_ABI = [
  {
    name: "depositFor",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "userDeposits",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "withdrawalNonces",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalWithdrawn",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ERC-20 ABI (for approve + allowance)
const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ============================================================
// Types
// ============================================================

export interface DepositRequest {
  user: Address;
  amount: string; // wei string
}

export interface RelayResult {
  success: boolean;
  txHash?: Hex;
  error?: string;
}

export interface RelayerStatus {
  enabled: boolean;
  address?: Address;
  balance?: string;
  collateralBalance?: string;
  settlementAddress?: Address;
}

// ============================================================
// Constants
// ============================================================

const MIN_RELAYER_BALANCE = BigInt(1e16); // 0.01 ETH minimum for gas
const MAX_APPROVAL = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"); // type(uint256).max

// M-11 FIX: 充值去重 — 防止同一笔 deposit 被重放
const processedDeposits = new Set<string>();
const MAX_PROCESSED_CACHE = 10000; // 防止内存无限增长

// ============================================================
// Relayer Service Functions
// ============================================================

/**
 * Check if relay service is enabled
 */
export function isRelayEnabled(): boolean {
  return !!(RELAYER_PRIVATE_KEY && SETTLEMENT_ADDRESS && walletClient);
}

/**
 * Get relayer status
 */
export async function getRelayerStatus(): Promise<RelayerStatus> {
  if (!isRelayEnabled() || !relayerAccount) {
    return { enabled: false };
  }

  try {
    const [ethBalance, collateralBalance] = await Promise.all([
      publicClient.getBalance({ address: relayerAccount.address }),
      COLLATERAL_TOKEN_ADDRESS
        ? publicClient.readContract({
            address: COLLATERAL_TOKEN_ADDRESS,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [relayerAccount.address],
          })
        : 0n,
    ]);

    return {
      enabled: true,
      address: relayerAccount.address,
      balance: ethBalance.toString(),
      collateralBalance: collateralBalance.toString(),
      settlementAddress: SETTLEMENT_ADDRESS,
    };
  } catch (error) {
    console.error("[Relay] Failed to get relayer status:", error);
    return {
      enabled: true,
      address: relayerAccount.address,
      balance: "0",
      collateralBalance: "0",
      settlementAddress: SETTLEMENT_ADDRESS,
    };
  }
}

/**
 * Get user's withdrawal nonce from SettlementV2
 */
export async function getWithdrawalNonce(user: Address): Promise<bigint> {
  if (!SETTLEMENT_ADDRESS) {
    throw new Error("Settlement address not configured");
  }

  const nonce = await publicClient.readContract({
    address: SETTLEMENT_ADDRESS,
    abi: SETTLEMENT_V2_ABI,
    functionName: "withdrawalNonces",
    args: [user],
  });

  return nonce;
}

/**
 * Get user's on-chain deposit total from SettlementV2
 */
export async function getUserDeposits(user: Address): Promise<bigint> {
  if (!SETTLEMENT_ADDRESS) {
    throw new Error("Settlement address not configured");
  }

  const deposits = await publicClient.readContract({
    address: SETTLEMENT_ADDRESS,
    abi: SETTLEMENT_V2_ABI,
    functionName: "userDeposits",
    args: [user],
  });

  return deposits;
}

/**
 * Get user's total withdrawn amount from SettlementV2
 */
export async function getUserTotalWithdrawn(user: Address): Promise<bigint> {
  if (!SETTLEMENT_ADDRESS) {
    throw new Error("Settlement address not configured");
  }

  const withdrawn = await publicClient.readContract({
    address: SETTLEMENT_ADDRESS,
    abi: SETTLEMENT_V2_ABI,
    functionName: "totalWithdrawn",
    args: [user],
  });

  return withdrawn;
}

/**
 * Ensure relayer has approved SettlementV2 to spend collateral tokens.
 * Uses max approval to avoid repeated approve txs.
 */
async function ensureApproval(): Promise<void> {
  if (!walletClient || !relayerAccount || !COLLATERAL_TOKEN_ADDRESS || !SETTLEMENT_ADDRESS) return;

  const allowance = await publicClient.readContract({
    address: COLLATERAL_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [relayerAccount.address, SETTLEMENT_ADDRESS],
  });

  // Re-approve if allowance is below 1000 ETH (arbitrary threshold)
  if (allowance < BigInt(1000e18)) {
    console.log("[Relay] Approving SettlementV2 to spend collateral tokens...");
    const hash = await walletClient.writeContract({
      address: COLLATERAL_TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [SETTLEMENT_ADDRESS, MAX_APPROVAL],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`[Relay] ✅ Approval tx confirmed: ${hash}`);
  }
}

/**
 * Execute depositFor on SettlementV2.
 *
 * Prerequisites:
 * - Relayer must hold sufficient collateral tokens
 * - Relayer must have approved SettlementV2 (handled by ensureApproval)
 *
 * SettlementV2.depositFor(user, amount) does:
 *   collateralToken.safeTransferFrom(msg.sender=relayer, this=settlement, amount)
 *   userDeposits[user] += amount
 */
export async function relayDeposit(request: DepositRequest): Promise<RelayResult> {
  if (!isRelayEnabled() || !walletClient) {
    return { success: false, error: "Relay service not enabled" };
  }

  try {
    const amount = BigInt(request.amount);

    // M-11 FIX: 充值去重 — 使用 user+amount 组合作为去重键
    const deduKey = `${request.user.toLowerCase()}-${request.amount}`;
    if (processedDeposits.has(deduKey)) {
      console.warn(`[Relay] Duplicate deposit rejected: ${deduKey}`);
      return { success: false, error: "Duplicate deposit" };
    }
    // 添加到已处理集合 (防止重放)
    processedDeposits.add(deduKey);
    // 防止内存泄漏：超过限制时清理最老的条目
    if (processedDeposits.size > MAX_PROCESSED_CACHE) {
      const firstKey = processedDeposits.values().next().value;
      if (firstKey) processedDeposits.delete(firstKey);
    }

    // Check relayer has enough ETH for gas
    const ethBalance = await publicClient.getBalance({
      address: relayerAccount!.address,
    });
    if (ethBalance < MIN_RELAYER_BALANCE) {
      return { success: false, error: "Relayer insufficient ETH for gas" };
    }

    // Ensure ERC-20 approval
    await ensureApproval();

    console.log(`[Relay] Depositing ${request.amount} collateral for ${request.user}`);

    const hash = await walletClient.writeContract({
      address: SETTLEMENT_ADDRESS!,
      abi: SETTLEMENT_V2_ABI,
      functionName: "depositFor",
      args: [request.user, amount],
    });

    console.log(`[Relay] ✅ Deposit tx submitted: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === "success") {
      console.log(`[Relay] ✅ Deposit confirmed: ${hash}`);
      return { success: true, txHash: hash };
    } else {
      console.error(`[Relay] ❌ Deposit failed: ${hash}`);
      return { success: false, error: "Transaction reverted" };
    }
  } catch (error) {
    console.error("[Relay] Deposit error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Format ETH amount for display
 */
export function formatETH(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  return eth.toFixed(4);
}

/**
 * Log relay service status on startup
 */
export function logRelayStatus(): void {
  if (isRelayEnabled() && relayerAccount) {
    console.log("[Relay] ✅ Relay service enabled (SettlementV2 mode)");
    console.log(`[Relay] Relayer address: ${relayerAccount.address}`);
    console.log(`[Relay] Settlement address: ${SETTLEMENT_ADDRESS}`);
    if (COLLATERAL_TOKEN_ADDRESS) {
      console.log(`[Relay] Collateral token: ${COLLATERAL_TOKEN_ADDRESS}`);
    }
  } else {
    console.log("[Relay] ⚠️  Relay service disabled (missing configuration)");
  }
}

// ============================================================
// Legacy Aliases (for gradual migration of server.ts handlers)
// ============================================================

/** @deprecated Use getWithdrawalNonce instead */
export const getMetaTxNonce = getWithdrawalNonce;

/** @deprecated Use getUserDeposits instead */
export async function getUserBalance(
  user: Address
): Promise<{ available: bigint; reserved: bigint }> {
  const deposits = await getUserDeposits(user);
  const withdrawn = await getUserTotalWithdrawn(user);
  // In V2, "available" approximation = deposits - withdrawn (actual equity is off-chain via Merkle tree)
  return {
    available: deposits > withdrawn ? deposits - withdrawn : 0n,
    reserved: 0n, // V2 doesn't track reserved on-chain
  };
}
