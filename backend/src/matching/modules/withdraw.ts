/**
 * Withdrawal Authorization Module for Mode 2 (Off-chain Execution + On-chain Attestation)
 *
 * Purpose:
 * - Generate EIP-712 withdrawal signatures
 * - Verify Merkle proofs before signing
 * - Track withdrawal nonces to prevent replay
 *
 * Withdrawal Flow:
 * 1. User requests withdrawal with amount
 * 2. Backend verifies: user equity >= amount (from latest snapshot)
 * 3. Backend generates: Merkle proof + EIP-712 signature
 * 4. User submits to SettlementV2.withdraw(amount, proof, signature)
 * 5. Contract verifies proof + signature, then transfers funds
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  keccak256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  hashTypedData,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { getUserProof, verifyProof as verifyMerkleProof } from "./snapshot";
import { type MerkleProof } from "./merkle";

/**
 * EIP-712 Domain for withdrawal authorization
 * Must match SettlementV2 contract's domain
 */
const EIP712_DOMAIN = {
  name: "SettlementV2",
  version: "1",
  chainId: parseInt(process.env.CHAIN_ID || "56"),
  verifyingContract: "0x0000000000000000000000000000000000000000" as Address, // Will be set on init
};

/**
 * EIP-712 Types for withdrawal authorization
 */
const EIP712_TYPES = {
  Withdrawal: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "merkleRoot", type: "bytes32" },
  ],
} as const;

/**
 * Withdrawal request
 */
export interface WithdrawalRequest {
  user: Address;
  amount: bigint;
  nonce: bigint;
  deadline: number;
}

/**
 * Withdrawal authorization (to be submitted on-chain)
 */
export interface WithdrawalAuthorization {
  user: Address;
  amount: bigint;
  nonce: bigint;
  deadline: number;
  merkleRoot: Hex;
  merkleProof: Hex[];
  signature: Hex;
}

/**
 * Withdrawal result
 */
export interface WithdrawalResult {
  success: boolean;
  authorization?: WithdrawalAuthorization;
  error?: string;
}

/**
 * Withdrawal module state
 */
interface WithdrawModuleState {
  signer: PrivateKeyAccount | null;
  contractAddress: Address | null;
  nonces: Map<string, bigint>; // user -> nonce
  pendingWithdrawals: Map<string, WithdrawalAuthorization>; // hash -> authorization
}

const state: WithdrawModuleState = {
  signer: null,
  contractAddress: null,
  nonces: new Map(),
  pendingWithdrawals: new Map(),
};

/**
 * Initialize withdrawal module
 */
export function initializeWithdrawModule(config: {
  signerPrivateKey: Hex;
  contractAddress: Address;
  chainId?: number;
}): void {
  state.signer = privateKeyToAccount(config.signerPrivateKey);
  state.contractAddress = config.contractAddress;
  EIP712_DOMAIN.verifyingContract = config.contractAddress;
  if (config.chainId) {
    EIP712_DOMAIN.chainId = config.chainId;
  }
  console.log(`[Withdraw] Module initialized, signer=${state.signer.address.slice(0, 10)}`);
}

/**
 * Sync withdrawal nonces from on-chain SettlementV2 contract.
 * Call this on engine restart to prevent nonce reuse / replay attacks.
 *
 * @param publicClient - viem PublicClient connected to the correct chain
 * @param users - list of known user addresses to sync
 */
export async function syncNoncesFromChain(
  publicClient: PublicClient,
  users: Address[],
): Promise<number> {
  if (!state.contractAddress) {
    console.warn("[Withdraw] Cannot sync nonces: module not initialized");
    return 0;
  }

  const NONCE_ABI = [
    {
      inputs: [{ name: "user", type: "address" }],
      name: "withdrawalNonces",
      outputs: [{ type: "uint256" }],
      stateMutability: "view",
      type: "function",
    },
  ] as const;

  let synced = 0;
  for (const user of users) {
    try {
      const nonce = await publicClient.readContract({
        address: state.contractAddress,
        abi: NONCE_ABI,
        functionName: "withdrawalNonces",
        args: [user],
      }) as bigint;

      if (nonce > 0n) {
        state.nonces.set(user.toLowerCase(), nonce);
        synced++;
      }
    } catch {
      // Skip users that fail (e.g., contract not deployed on this chain)
    }
  }

  console.log(`[Withdraw] Synced ${synced}/${users.length} nonces from chain`);
  return synced;
}

/**
 * Get current nonce for a user
 */
export function getUserNonce(user: Address): bigint {
  const normalizedUser = user.toLowerCase();
  return state.nonces.get(normalizedUser) ?? 0n;
}

/**
 * Increment nonce for a user (after successful withdrawal)
 */
export function incrementNonce(user: Address): bigint {
  const normalizedUser = user.toLowerCase();
  const currentNonce = getUserNonce(user as Address);
  const newNonce = currentNonce + 1n;
  state.nonces.set(normalizedUser, newNonce);
  return newNonce;
}

/**
 * Check if user can withdraw amount
 * M-07 FIX: 现在同时检查链上 totalWithdrawn，防止已提款金额超过存款
 */
export async function canWithdraw(user: Address, amount: bigint): Promise<{ canWithdraw: boolean; reason?: string; availableEquity?: bigint }> {
  // Get Merkle proof (contains user's equity)
  const proof = getUserProof(user);

  if (!proof) {
    return {
      canWithdraw: false,
      reason: "No equity snapshot available for user",
    };
  }

  if (proof.equity < amount) {
    return {
      canWithdraw: false,
      reason: `Insufficient equity: ${proof.equity.toString()} < ${amount.toString()}`,
      availableEquity: proof.equity,
    };
  }

  // Verify the proof is valid
  if (!verifyMerkleProof(proof)) {
    return {
      canWithdraw: false,
      reason: "Invalid Merkle proof",
    };
  }

  // M-07 FIX: 检查链上可用余额 (deposits - totalWithdrawn)
  try {
    const { getUserDeposits, getUserTotalWithdrawn } = await import("./relay");
    const deposits = await getUserDeposits(user);
    const totalWithdrawn = await getUserTotalWithdrawn(user);
    const onChainAvailable = deposits > totalWithdrawn ? deposits - totalWithdrawn : 0n;

    if (amount > onChainAvailable) {
      return {
        canWithdraw: false,
        reason: `On-chain available insufficient: deposits=${deposits}, withdrawn=${totalWithdrawn}, available=${onChainAvailable} < ${amount}`,
        availableEquity: onChainAvailable,
      };
    }
  } catch (e) {
    console.warn(`[Withdraw] Failed to check on-chain balance for ${user.slice(0, 10)}, proceeding with equity check only:`, e);
  }

  return {
    canWithdraw: true,
    availableEquity: proof.equity,
  };
}

/**
 * Generate withdrawal authorization
 */
export async function generateWithdrawalAuthorization(
  request: WithdrawalRequest
): Promise<WithdrawalResult> {
  if (!state.signer) {
    return {
      success: false,
      error: "Withdraw module not initialized",
    };
  }

  // 1. Check if user can withdraw (M-07: now async — checks on-chain totalWithdrawn)
  const checkResult = await canWithdraw(request.user, request.amount);
  if (!checkResult.canWithdraw) {
    return {
      success: false,
      error: checkResult.reason,
    };
  }

  // 2. Get Merkle proof
  const proof = getUserProof(request.user);
  if (!proof) {
    return {
      success: false,
      error: "Failed to generate Merkle proof",
    };
  }

  // 3. Verify nonce
  const expectedNonce = getUserNonce(request.user);
  if (request.nonce !== expectedNonce) {
    return {
      success: false,
      error: `Invalid nonce: expected ${expectedNonce}, got ${request.nonce}`,
    };
  }

  // 4. Check deadline
  // AUDIT-FIX ME-C02: deadline 是 Unix 秒 (L358 createWithdrawalRequest)，Date.now() 是毫秒
  // 旧代码 `deadline < Date.now()` 导致所有提款立即过期 (秒 ~1.7M < 毫秒 ~1.7T)
  if (request.deadline < Math.floor(Date.now() / 1000)) {
    return {
      success: false,
      error: "Withdrawal deadline has passed",
    };
  }

  // 5. Generate EIP-712 signature
  const typedData = {
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Withdrawal" as const,
    message: {
      user: request.user,
      amount: request.amount,
      nonce: request.nonce,
      deadline: BigInt(request.deadline),
      merkleRoot: proof.root,
    },
  };

  try {
    const signature = await state.signer.signTypedData(typedData);

    const authorization: WithdrawalAuthorization = {
      user: request.user,
      amount: request.amount,
      nonce: request.nonce,
      deadline: request.deadline,
      merkleRoot: proof.root,
      merkleProof: proof.proof,
      signature,
    };

    // Track pending withdrawal
    const hash = keccak256(
      encodePacked(
        ["address", "uint256", "uint256"],
        [request.user, request.amount, request.nonce]
      )
    );
    state.pendingWithdrawals.set(hash, authorization);

    // AUDIT-FIX H-04: Increment nonce IMMEDIATELY after signing to prevent
    // multiple authorizations with the same nonce. Previously, nonce was only
    // incremented in markWithdrawalCompleted() (after on-chain confirmation),
    // allowing users to request unlimited signatures with the same nonce.
    incrementNonce(request.user);

    console.log(`[Withdraw] Generated authorization for ${request.user.slice(0, 10)}, amount=$${Number(request.amount) / 1e6}, nonce=${request.nonce}→${getUserNonce(request.user)}`);

    return {
      success: true,
      authorization,
    };
  } catch (e) {
    console.error("[Withdraw] Failed to sign withdrawal:", e);
    return {
      success: false,
      error: `Signing failed: ${e instanceof Error ? e.message : "Unknown error"}`,
    };
  }
}

/**
 * Mark withdrawal as completed (after on-chain confirmation)
 */
export function markWithdrawalCompleted(user: Address, nonce: bigint): void {
  // AUDIT-FIX H-04: Nonce is now incremented in generateWithdrawalAuthorization() immediately
  // after signing. Do NOT increment again here — only clean up pending withdrawals.
  // Old code: incrementNonce(user); // caused double-increment
  // AUDIT-FIX ME-H01: 清理已完成的 pendingWithdrawals 条目（旧代码只 set 不 delete，导致内存泄漏）
  for (const [hash, auth] of state.pendingWithdrawals.entries()) {
    if (auth.user.toLowerCase() === user.toLowerCase() && auth.nonce === nonce) {
      state.pendingWithdrawals.delete(hash);
      break;
    }
  }
  console.log(`[Withdraw] Marked withdrawal completed for ${user.slice(0, 10)}, new nonce=${getUserNonce(user)}, pending=${state.pendingWithdrawals.size}`);
}

/**
 * Clean up expired pending withdrawals (call periodically from server.ts)
 * AUDIT-FIX ME-H01: 防止长期运行时 pendingWithdrawals Map 无限增长
 */
export function cleanupExpiredWithdrawals(): void {
  const now = Math.floor(Date.now() / 1000);
  let cleaned = 0;
  for (const [hash, auth] of state.pendingWithdrawals.entries()) {
    if (auth.deadline < now) {
      state.pendingWithdrawals.delete(hash);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Withdraw] Cleaned ${cleaned} expired pending withdrawals, remaining=${state.pendingWithdrawals.size}`);
  }
}

/**
 * Get pending withdrawal by hash
 */
export function getPendingWithdrawal(user: Address, amount: bigint, nonce: bigint): WithdrawalAuthorization | null {
  const hash = keccak256(
    encodePacked(
      ["address", "uint256", "uint256"],
      [user, amount, nonce]
    )
  );
  return state.pendingWithdrawals.get(hash) ?? null;
}

/**
 * Generate a withdrawal request with automatic parameters
 */
export function createWithdrawalRequest(
  user: Address,
  amount: bigint,
  deadlineMinutes: number = 30
): WithdrawalRequest {
  return {
    user,
    amount,
    nonce: getUserNonce(user),
    // AUDIT-FIX ME-C06: EIP-712 deadline 必须是 Unix 秒而非毫秒
    deadline: Math.floor(Date.now() / 1000) + deadlineMinutes * 60,
  };
}

/**
 * Full withdrawal flow: create request → generate authorization
 */
export async function requestWithdrawal(
  user: Address,
  amount: bigint,
  deadlineMinutes: number = 30
): Promise<WithdrawalResult> {
  const request = createWithdrawalRequest(user, amount, deadlineMinutes);
  return generateWithdrawalAuthorization(request);
}

/**
 * M-08 FIX: Get total pending withdrawal amount for a user
 * Used by snapshot.ts to deduct pending withdrawals from equity
 */
export function getPendingWithdrawalAmount(user: Address): bigint {
  const normalizedUser = user.toLowerCase();
  let total = 0n;
  for (const auth of state.pendingWithdrawals.values()) {
    if (auth.user.toLowerCase() === normalizedUser) {
      total += BigInt(auth.amount);
    }
  }
  return total;
}

/**
 * Get module status
 */
export function getWithdrawModuleStatus(): {
  initialized: boolean;
  signerAddress: Address | null;
  contractAddress: Address | null;
  pendingCount: number;
} {
  return {
    initialized: state.signer !== null,
    signerAddress: state.signer?.address ?? null,
    contractAddress: state.contractAddress,
    pendingCount: state.pendingWithdrawals.size,
  };
}
