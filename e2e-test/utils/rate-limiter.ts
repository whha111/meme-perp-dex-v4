/**
 * Token Bucket Rate Limiter
 *
 * Used to respect the matching engine's 5 orders/s per IP limit.
 * Set to 4/s to leave 1/s headroom.
 */

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly tokensPerSecond: number = 4,
    private readonly maxTokens: number = 4,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.tokensPerSecond);
    this.lastRefill = now;
  }

  /** Wait until a token is available, then consume it */
  async acquire(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Wait until next token is available
      const waitMs = Math.ceil((1 - this.tokens) / this.tokensPerSecond * 1000);
      await new Promise(r => setTimeout(r, Math.max(10, waitMs)));
    }
  }
}
