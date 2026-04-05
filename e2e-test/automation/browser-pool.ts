/**
 * Browser Pool — Manages N concurrent Playwright browser contexts
 *
 * Each context has a unique wallet injected. For 100 wallets with 10 concurrent
 * browsers, contexts rotate: after wallet A finishes, the context switches to wallet B.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { injectWallet, type InjectedWallet } from "./wallet-injector";
import { ENV, TEST_PARAMS } from "../config/test-config";
import { log } from "../utils/logger";

interface PoolEntry {
  context: BrowserContext;
  page: Page;
  currentWallet: InjectedWallet | null;
  busy: boolean;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private pool: PoolEntry[] = [];
  private maxSize: number;
  private waitQueue: Array<{
    resolve: (entry: PoolEntry) => void;
    wallet: InjectedWallet;
  }> = [];

  constructor(maxSize = TEST_PARAMS.MAX_CONCURRENT_BROWSERS) {
    this.maxSize = maxSize;
  }

  async init(): Promise<void> {
    log.browser.info({ maxSize: this.maxSize }, "Initializing browser pool");
    this.browser = await chromium.launch({
      headless: true,  // Set to false for debugging
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    // Pre-create browser contexts
    for (let i = 0; i < this.maxSize; i++) {
      const context = await this.browser.newContext({
        viewport: { width: 1440, height: 900 },
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      this.pool.push({
        context,
        page,
        currentWallet: null,
        busy: false,
      });
    }

    log.browser.info({ poolSize: this.pool.length }, "Browser pool ready");
  }

  /**
   * Acquire a browser page with a specific wallet injected.
   * If all browsers are busy, waits until one is released.
   */
  async acquire(wallet: InjectedWallet): Promise<{ page: Page; release: () => void }> {
    // Find a free entry (prefer one already loaded with this wallet)
    let entry = this.pool.find(
      (e) => !e.busy && e.currentWallet?.address === wallet.address
    );

    if (!entry) {
      entry = this.pool.find((e) => !e.busy);
    }

    if (!entry) {
      // All busy — wait
      return new Promise((resolve) => {
        this.waitQueue.push({
          resolve: (entry: PoolEntry) => {
            resolve({
              page: entry.page,
              release: () => this.release(entry),
            });
          },
          wallet,
        });
      });
    }

    entry.busy = true;

    // Re-inject wallet if different from current
    if (entry.currentWallet?.address !== wallet.address) {
      // Create new page with injected wallet
      await entry.page.close();
      entry.page = await entry.context.newPage();
      await injectWallet(entry.page, wallet);
      entry.currentWallet = wallet;
    }

    return {
      page: entry.page,
      release: () => this.release(entry!),
    };
  }

  private release(entry: PoolEntry): void {
    entry.busy = false;

    // Process wait queue
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      entry.busy = true;
      // Re-inject wallet if needed
      if (entry.currentWallet?.address !== waiter.wallet.address) {
        entry.page.close().then(async () => {
          entry.page = await entry.context.newPage();
          await injectWallet(entry.page, waiter.wallet);
          entry.currentWallet = waiter.wallet;
          waiter.resolve(entry);
        });
      } else {
        waiter.resolve(entry);
      }
    }
  }

  async destroy(): Promise<void> {
    for (const entry of this.pool) {
      await entry.page.close().catch(() => {});
      await entry.context.close().catch(() => {});
    }
    if (this.browser) {
      await this.browser.close();
    }
    this.pool = [];
    log.browser.info("Browser pool destroyed");
  }

  get stats() {
    return {
      total: this.pool.length,
      busy: this.pool.filter((e) => e.busy).length,
      free: this.pool.filter((e) => !e.busy).length,
      waiting: this.waitQueue.length,
    };
  }
}

// Singleton
let _pool: BrowserPool | null = null;
export async function getBrowserPool(): Promise<BrowserPool> {
  if (!_pool) {
    _pool = new BrowserPool();
    await _pool.init();
  }
  return _pool;
}
