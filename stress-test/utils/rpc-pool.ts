/**
 * RPC Connection Pool with Token Bucket Rate Limiter
 *
 * Shared HTTP/WSS connections for 300 wallets.
 * Token bucket algorithm limits to 90% of tested RPC maximums.
 */
import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { RPC, RATE_LIMITS } from "../config.js";

// ── Token Bucket Rate Limiter ──────────────────────────────────

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillRate: number, // tokens per second
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire(count: number = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      // Wait for enough tokens to accumulate
      const waitMs = ((count - this.tokens) / this.refillRate) * 1000;
      await new Promise(r => setTimeout(r, Math.max(10, waitMs)));
    }
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

// ── Request Queue with Retry ───────────────────────────────────

interface QueuedRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retries: number;
}

// ── RPC Pool ───────────────────────────────────────────────────

export class RpcPool {
  readonly httpClient: PublicClient;
  private readonly httpBucket: TokenBucket;
  private stats = { totalRequests: 0, retries: 0, failures: 0 };

  constructor() {
    this.httpClient = createPublicClient({
      chain: bscTestnet,
      transport: http(RPC.http, {
        batch: { batchSize: RATE_LIMITS.batchSize },
        retryCount: 0, // We handle retries ourselves
      }),
    }) as PublicClient;

    this.httpBucket = new TokenBucket(
      RATE_LIMITS.httpReqPerSec * 2, // Burst capacity = 2x sustained rate
      RATE_LIMITS.httpReqPerSec,
    );
  }

  /** Rate-limited RPC call with retry */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= RATE_LIMITS.maxRetries; attempt++) {
      await this.httpBucket.acquire();
      this.stats.totalRequests++;

      try {
        return await fn();
      } catch (error: any) {
        const is429 = error?.message?.includes("429") || error?.status === 429;
        const isTimeout = error?.message?.includes("timeout");

        if ((is429 || isTimeout) && attempt < RATE_LIMITS.maxRetries) {
          this.stats.retries++;
          const delay = RATE_LIMITS.retryBaseDelayMs * Math.pow(2, attempt);
          console.warn(`[RPC] Retry ${attempt + 1}/${RATE_LIMITS.maxRetries} after ${delay}ms (${is429 ? "429" : "timeout"})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        this.stats.failures++;
        throw error;
      }
    }
    throw new Error("Max retries exceeded");
  }

  /** Batch read multiple contract values (saves RPC quota) */
  async batchRead<T>(
    calls: Array<() => Promise<T>>,
  ): Promise<Array<{ success: boolean; result?: T; error?: Error }>> {
    const results: Array<{ success: boolean; result?: T; error?: Error }> = [];

    // Process in batches to respect rate limits
    for (let i = 0; i < calls.length; i += RATE_LIMITS.batchSize) {
      const batch = calls.slice(i, i + RATE_LIMITS.batchSize);

      // Execute batch concurrently (viem batches these into one JSON-RPC request)
      const batchResults = await Promise.allSettled(
        batch.map(fn => this.call(fn))
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push({ success: true, result: result.value });
        } else {
          results.push({ success: false, error: result.reason });
        }
      }
    }

    return results;
  }

  /** Create a wallet client for a specific private key (reuses shared transport) */
  createWallet(privateKey: `0x${string}`): WalletClient {
    const account = privateKeyToAccount(privateKey);
    return createWalletClient({
      account,
      chain: bscTestnet,
      transport: http(RPC.http),
    });
  }

  getStats() {
    return {
      ...this.stats,
      availableTokens: this.httpBucket.available,
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────
let _pool: RpcPool | null = null;

export function getRpcPool(): RpcPool {
  if (!_pool) {
    _pool = new RpcPool();
  }
  return _pool;
}
