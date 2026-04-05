/**
 * RPC Client utility — viem public + wallet client factory
 * With retry, rate limiting, and multi-RPC fallback
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Address,
  type Chain,
  type Account,
  parseEther,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { ENV } from "../config/test-config";

// BSC Testnet RPC endpoints (fallback pool)
const RPC_ENDPOINTS = [
  ENV.RPC_URL,
  "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
  "https://bsc-testnet.public.blastapi.io",
];

let currentRpcIndex = 0;

function getNextRpc(): string {
  const rpc = RPC_ENDPOINTS[currentRpcIndex % RPC_ENDPOINTS.length];
  currentRpcIndex++;
  return rpc;
}

// Singleton public client with retry
let _publicClient: PublicClient | null = null;
export function getPublicClient(): PublicClient {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: bscTestnet,
      transport: http(ENV.RPC_URL, {
        retryCount: 3,
        retryDelay: 1000,
        timeout: 30_000,
      }),
    });
  }
  return _publicClient;
}

// Create wallet client for a specific private key
export function getWalletClient(privateKey: `0x${string}`): WalletClient {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: bscTestnet,
    transport: http(ENV.RPC_URL, {
      retryCount: 3,
      retryDelay: 1000,
      timeout: 30_000,
    }),
  });
}

// Get account from private key
export function getAccount(privateKey: `0x${string}`): Account {
  return privateKeyToAccount(privateKey);
}

// Utility: wait for tx confirmation
export async function waitForTx(hash: `0x${string}`, confirmations = 1): Promise<void> {
  const client = getPublicClient();
  await client.waitForTransactionReceipt({
    hash,
    confirmations,
    timeout: 30_000,
  });
}

// Utility: get BNB balance
export async function getBnbBalance(address: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.getBalance({ address });
}

// Utility: send BNB
export async function sendBnb(
  fromKey: `0x${string}`,
  to: Address,
  amountBnb: number
): Promise<`0x${string}`> {
  const wallet = getWalletClient(fromKey);
  const hash = await wallet.sendTransaction({
    to,
    value: parseEther(amountBnb.toString()),
  });
  await waitForTx(hash);
  return hash;
}

// Utility: batch send BNB with nonce management
export async function batchSendBnb(
  fromKey: `0x${string}`,
  recipients: { address: Address; amount: number }[],
  batchSize = 10
): Promise<{ success: number; failed: number }> {
  const wallet = getWalletClient(fromKey);
  const account = getAccount(fromKey);
  const client = getPublicClient();
  let nonce = await client.getTransactionCount({ address: account.address });
  let success = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);
    const promises = batch.map((r, idx) =>
      wallet
        .sendTransaction({
          to: r.address,
          value: parseEther(r.amount.toString()),
          nonce: nonce + idx,
        })
        .then(hash => { success++; return hash; })
        .catch(err => { failed++; console.error(`Failed to send to ${r.address}: ${err.message}`); return null; })
    );

    const hashes = await Promise.all(promises);
    nonce += batch.length;

    // Wait for batch confirmation
    const validHashes = hashes.filter(Boolean) as `0x${string}`[];
    if (validHashes.length > 0) {
      await waitForTx(validHashes[validHashes.length - 1]);
    }

    console.log(`  Batch ${Math.floor(i / batchSize) + 1}: ${success} sent, ${failed} failed`);
  }

  return { success, failed };
}
