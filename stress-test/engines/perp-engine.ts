/**
 * Perpetual Trading Engine — 100 wallets continuous perp trading
 *
 * Strategies: 30% open long+pair short, 30% open short+pair long,
 *            25% close, 10% add margin, 5% high leverage (liquidation bait)
 * Uses EIP-712 signatures → POST to matching engine (off-chain, no RPC cost).
 * Only on-chain: deposit to Settlement, nonce reads.
 */
import { parseEther, formatEther, type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getRpcPool } from "../utils/rpc-pool.js";
import { type StressWallet, pickRandom, randInt, randBigInt } from "../utils/wallet-manager.js";
import {
  CONTRACTS, SETTLEMENT_V2_ABI, PERP_CONFIG, MATCHING_ENGINE,
  EIP712_DOMAIN, ORDER_TYPES, TOKEN_FACTORY_ABI, PERP_VAULT_ABI,
  WETH_ADDRESS, WETH_ABI,
} from "../config.js";

// ── Types ──────────────────────────────────────────────────────

export interface PerpStats {
  totalRounds: number;
  ordersSubmitted: number;
  ordersMatched: number;
  deposits: number;
  withdrawals: number;
  withdrawalFailures: number;
  lifecycleChecks: number;
  lifecycleFailures: number;
  failures: number;
  startTime: number;
}

// ── Perp Engine ────────────────────────────────────────────────

export class PerpEngine {
  private running = false;
  private wallets: StressWallet[] = [];
  private tradableTokens: Address[] = [];
  private localNonces: Map<Address, bigint> = new Map();
  readonly stats: PerpStats = { totalRounds: 0, ordersSubmitted: 0, ordersMatched: 0, deposits: 0, withdrawals: 0, withdrawalFailures: 0, lifecycleChecks: 0, lifecycleFailures: 0, failures: 0, startTime: 0 };

  constructor(wallets: StressWallet[]) {
    this.wallets = wallets;
  }

  async start(): Promise<void> {
    this.running = true;
    this.stats.startTime = Date.now();

    // Load tradable tokens + sync nonces
    await this.refreshTokenList();
    await this.syncAllNonces();

    // Clean up any positions left over from previous test runs.
    // Old positions lock up margin, starving new orders of collateral.
    await this.closeAllExistingPositions();

    // Bulk deposit: move most of each wallet's ETH into Settlement upfront
    // This prevents the matching engine from trying to auto-deposit (it doesn't have our keys)
    await this.bulkDepositAll();

    // Explicitly sync all wallet balances with the matching engine.
    // Event listeners may miss deposits during rapid parallel execution.
    await this.syncEngineBalances();

    console.log(`[PerpEngine] Started with ${this.wallets.length} wallets, ${this.tradableTokens.length} tokens`);

    while (this.running) {
      try {
        await this.executeRound();
      } catch (err: any) {
        console.error(`[PerpEngine] Round error: ${err.message}`);
        this.stats.failures++;
      }

      const delay = randInt(PERP_CONFIG.roundIntervalMs[0], PERP_CONFIG.roundIntervalMs[1]);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  stop(): void {
    this.running = false;
    console.log(`[PerpEngine] Stopping...`);
  }

  private async executeRound(): Promise<void> {
    if (this.tradableTokens.length === 0) {
      await this.refreshTokenList();
      if (this.tradableTokens.length === 0) return;
    }

    this.stats.totalRounds++;

    // ── Every round: place limit orders on 1-3 random tokens for book depth ──
    const tokensForLimits = randInt(1, Math.min(3, this.tradableTokens.length));
    for (let t = 0; t < tokensForLimits; t++) {
      const token = this.tradableTokens[randInt(0, this.tradableTokens.length - 1)];
      try {
        await this.placeLimitOrders(this.wallets, token);
      } catch (err: any) {
        if (this.stats.failures < 20) {
          console.error(`[PerpEngine] Limit order error: ${err.message?.slice(0, 100)}`);
        }
        this.stats.failures++;
      }
    }

    // ── Then: paired limit orders at current price for actual fills ────
    const count = randInt(PERP_CONFIG.walletsPerRound[0], PERP_CONFIG.walletsPerRound[1]);
    const selected = pickRandom(this.wallets, count);

    // Pair wallets for counterparty matching
    for (let i = 0; i < selected.length - 1; i += 2) {
      if (!this.running) break;

      const walletA = selected[i];
      const walletB = selected[i + 1];
      const token = this.tradableTokens[randInt(0, this.tradableTokens.length - 1)];

      const roll = Math.random();
      try {
        // Close probability is higher (40%) to free up margin for new orders
        const closeProbability = 0.40;
        if (roll < closeProbability) {
          // Close positions for both wallets to free margin
          await this.submitCloseOrder(walletA, token);
          await this.submitCloseOrder(walletB, token);
        } else if (roll < closeProbability + PERP_CONFIG.highLeverageProbability) {
          // High leverage pair (liquidation bait)
          await this.submitPair(walletA, walletB, token, true);
        } else if (roll < closeProbability + PERP_CONFIG.highLeverageProbability + 0.25) {
          // Normal open long + counterparty short
          await this.submitPair(walletA, walletB, token, false);
        } else {
          // Open short + counterparty long (reversed)
          await this.submitPair(walletB, walletA, token, false);
        }
      } catch (err: any) {
        this.stats.failures++;
        console.error(`[PerpEngine] W${walletA.index}/W${walletB.index} error: ${err.message?.slice(0, 100)}`);
        // Re-sync nonce on nonce errors
        if (err.message?.includes("nonce")) {
          await this.syncNonce(walletA);
          await this.syncNonce(walletB);
        }
      }
    }

    // Withdrawal test: every 10 rounds, 20% chance (was: every 50 rounds, 5%)
    // Lowered threshold so it triggers in short 15-20 min tests (~9-30 rounds)
    if (this.stats.totalRounds % 10 === 0 && Math.random() < 0.20) {
      try {
        await this.executeWithdrawalTest();
      } catch (err: any) {
        console.error(`[PerpEngine] Withdrawal test error: ${err.message?.slice(0, 100)}`);
        this.stats.withdrawalFailures++;
      }
    }

    // Full lifecycle verification: every 20 rounds (was: 100 — too slow for short tests)
    if (this.stats.totalRounds % 20 === 0) {
      try {
        await this.verifyFullCycle();
      } catch (err: any) {
        console.error(`[PerpEngine] Lifecycle check error: ${err.message?.slice(0, 100)}`);
        this.stats.lifecycleFailures++;
      }
    }

    // Refresh tokens every 30 rounds (was 100 — too slow for short tests)
    if (this.stats.totalRounds % 30 === 0) {
      await this.refreshTokenList();
    }

    // Re-sync nonces every 20 rounds (was 50)
    if (this.stats.totalRounds % 20 === 0) {
      await this.syncAllNonces();
    }
  }

  /** Check available balance from matching engine API */
  private async getAvailableBalance(wallet: StressWallet): Promise<bigint> {
    try {
      const resp = await fetch(`${MATCHING_ENGINE.url}/api/user/${wallet.address}/balance`);
      const data = await resp.json() as { availableBalance?: string };
      return BigInt(data.availableBalance ?? "0");
    } catch {
      return 0n;
    }
  }

  /**
   * Submit a long/short pair — walletA goes long, walletB goes short.
   *
   * IMPORTANT: Uses LIMIT orders at current price (not market orders).
   * Market orders (price=0) match against ANY resting order regardless of price,
   * which instantly consumes our book-depth limit orders. By using limit orders
   * at current price, the pair still crosses (matches each other), but wider-spread
   * book orders are preserved because limit-vs-limit matching requires price crossing.
   */
  private async submitPair(
    longWallet: StressWallet,
    shortWallet: StressWallet,
    token: Address,
    highLeverage: boolean,
  ): Promise<void> {
    const size = parseEther(
      (PERP_CONFIG.minSizeEth + Math.random() * (PERP_CONFIG.maxSizeEth - PERP_CONFIG.minSizeEth)).toFixed(6)
    );

    const leverageMultiplier = highLeverage
      ? BigInt(randInt(PERP_CONFIG.highLeverageRange[0], PERP_CONFIG.highLeverageRange[1]))
      : BigInt(randInt(PERP_CONFIG.leverageRange[0], PERP_CONFIG.leverageRange[1]));
    const leverage = leverageMultiplier * PERP_CONFIG.leveragePrecision;

    // Check available balance from matching engine before submitting
    const requiredMargin = size / leverageMultiplier + parseEther("0.0001"); // margin + fee buffer
    const [longAvail, shortAvail] = await Promise.all([
      this.getAvailableBalance(longWallet),
      this.getAvailableBalance(shortWallet),
    ]);

    if (longAvail < requiredMargin || shortAvail < requiredMargin) {
      if (longAvail < requiredMargin) await this.ensureDeposit(longWallet, requiredMargin);
      if (shortAvail < requiredMargin) await this.ensureDeposit(shortWallet, requiredMargin);

      const [newLong, newShort] = await Promise.all([
        this.getAvailableBalance(longWallet),
        this.getAvailableBalance(shortWallet),
      ]);
      if (newLong < requiredMargin || newShort < requiredMargin) return;
    }

    // Get current price for limit order pricing
    const currentPrice = await this.getTokenPrice(token);

    // If no price available, fall back to market orders (they'll match each other)
    const orderType = currentPrice > 0n ? 1 : 0;

    // Paired limit orders: both at current price so they cross and match each other,
    // but they won't eat resting book orders at wider spreads (limit-vs-limit price check)
    const longResult = await this.submitOrder(longWallet, token, true, size, leverage, orderType, currentPrice);
    if (longResult.success) {
      this.stats.ordersSubmitted++;
      if (longResult.matched) this.stats.ordersMatched++;
    }

    const shortResult = await this.submitOrder(shortWallet, token, false, size, leverage, orderType, currentPrice);
    if (shortResult.success) {
      this.stats.ordersSubmitted++;
      if (shortResult.matched) this.stats.ordersMatched++;
    }

    const lev = `${leverageMultiplier}x${highLeverage ? " ⚠HIGH" : ""}`;
    console.log(`[Perp] W${longWallet.index}↑ W${shortWallet.index}↓ ${formatEther(size)}ETH ${lev} → ${token.slice(0, 10)}...`);
  }

  /**
   * Close a position using the direct close API (POST /api/position/:pairId/close).
   *
   * This does NOT require new margin — the engine directly settles the PnL
   * and releases collateral. Much better for stress testing with limited funds.
   *
   * Reads positions from the matching engine HTTP API (off-chain source of truth),
   * NOT from the on-chain PositionManager.
   */
  private async submitCloseOrder(wallet: StressWallet, token: Address): Promise<void> {
    try {
      const resp = await fetch(`${MATCHING_ENGINE.url}/api/user/${wallet.address}/positions`);
      const positions = await resp.json() as Array<{
        pairId: string;
        token: string;
        isLong: boolean;
        size: string;
        collateral: string;
        entryPrice: string;
      }>;

      if (!Array.isArray(positions)) return;

      // Find position for this specific token
      const position = positions.find(
        p => p.token.toLowerCase() === token.toLowerCase() && BigInt(p.size || "0") > 0n
      );

      if (!position || !position.pairId) return;

      // Use direct close API (no margin required!)
      const account = privateKeyToAccount(wallet.privateKey);
      const closeMessage = `Close pair ${position.pairId} for ${wallet.address.toLowerCase()}`;
      const signature = await account.signMessage({ message: closeMessage });

      const closeResp = await fetch(`${MATCHING_ENGINE.url}/api/position/${position.pairId}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trader: wallet.address,
          closeRatio: 1,
          signature,
        }),
      });

      const result = await closeResp.json() as { success?: boolean; error?: string };
      if (result.success) {
        this.stats.ordersMatched++;
        console.log(`[Perp] W${wallet.index} CLOSE ${position.isLong ? "LONG" : "SHORT"} ${formatEther(BigInt(position.size))}ETH via close API`);
      } else if (result.error) {
        if (this.stats.failures < 20) {
          console.error(`[PerpEngine] W${wallet.index} close failed: ${result.error?.slice(0, 80)}`);
        }
        this.stats.failures++;
      }
    } catch {
      // Position might not exist or engine unreachable, skip
    }
  }

  /**
   * Close ALL existing positions at startup to free margin for new orders.
   * Called once before the main trading loop begins.
   */
  async closeAllExistingPositions(): Promise<void> {
    console.log("[PerpEngine] Closing all existing positions to free margin...");
    let closed = 0;

    for (const wallet of this.wallets) {
      try {
        const resp = await fetch(`${MATCHING_ENGINE.url}/api/user/${wallet.address}/positions`);
        const positions = await resp.json() as Array<{
          pairId: string;
          token: string;
          isLong: boolean;
          size: string;
        }>;

        if (!Array.isArray(positions)) continue;

        for (const pos of positions) {
          if (BigInt(pos.size || "0") === 0n || !pos.pairId) continue;

          try {
            const account = privateKeyToAccount(wallet.privateKey);
            const closeMessage = `Close pair ${pos.pairId} for ${wallet.address.toLowerCase()}`;
            const signature = await account.signMessage({ message: closeMessage });

            const closeResp = await fetch(`${MATCHING_ENGINE.url}/api/position/${pos.pairId}/close`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trader: wallet.address, closeRatio: 1, signature }),
            });

            const result = await closeResp.json() as { success?: boolean; error?: string };
            if (result.success) {
              closed++;
              console.log(`[PerpEngine] Closed W${wallet.index} ${pos.isLong ? "LONG" : "SHORT"} ${formatEther(BigInt(pos.size))}ETH ${pos.token.slice(0, 10)}`);
            } else {
              console.warn(`[PerpEngine] Failed to close W${wallet.index}: ${result.error?.slice(0, 60)}`);
            }
          } catch {}
        }
      } catch {}
    }

    console.log(`[PerpEngine] Closed ${closed} existing positions`);
  }

  /** Sign and submit an order to the matching engine */
  private async submitOrder(
    wallet: StressWallet,
    token: Address,
    isLong: boolean,
    size: bigint,
    leverage: bigint,
    orderType: number,
    price: bigint = 0n,
  ): Promise<{ success: boolean; matched: boolean }> {
    const account = privateKeyToAccount(wallet.privateKey);
    const nonce = this.getLocalNonce(wallet);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const order = {
      trader: wallet.address,
      token,
      isLong,
      size,
      leverage,
      price,
      deadline,
      nonce,
      orderType,
    };

    const signature = await account.signTypedData({
      domain: EIP712_DOMAIN,
      types: ORDER_TYPES,
      primaryType: "Order" as const,
      message: order,
    });

    let result: { success: boolean; matches?: any[]; error?: string };
    try {
      const response = await fetch(`${MATCHING_ENGINE.url}${MATCHING_ENGINE.submitEndpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trader: order.trader,
          token: order.token,
          isLong: order.isLong,
          size: order.size.toString(),
          leverage: order.leverage.toString(),
          price: order.price.toString(),
          deadline: order.deadline.toString(),
          nonce: order.nonce.toString(),
          orderType: order.orderType,
          signature,
        }),
      });
      result = await response.json() as { success: boolean; matches?: any[]; error?: string };
    } catch (fetchErr: any) {
      // Matching engine unreachable
      if (this.stats.failures % 50 === 0) {
        console.error(`[PerpEngine] Matching engine unreachable: ${fetchErr.message?.slice(0, 60)}`);
      }
      return { success: false, matched: false };
    }

    if (result.success) {
      this.incrementNonce(wallet);
      return { success: true, matched: (result.matches?.length ?? 0) > 0 };
    }

    // Log first few errors for debugging
    if (this.stats.failures < 20) {
      console.error(`[PerpEngine] W${wallet.index} order rejected: ${result.error?.slice(0, 100)}`);
    }

    if (result.error?.includes("nonce")) {
      await this.syncNonce(wallet);
    }

    this.stats.failures++;
    return { success: false, matched: false };
  }

  /**
   * Ensure wallet has enough margin in SettlementV2 contract.
   *
   * V2 deposit flow (3-step):
   *   1. ETH → WETH (wrap via WETH.deposit{value})
   *   2. WETH.approve(SettlementV2, amount)
   *   3. SettlementV2.deposit(amount)  — WETH transferred from wallet to contract
   *
   * SettlementV2 stores balances in 1e18 precision (same as WETH, no conversion needed).
   */
  private async ensureDeposit(wallet: StressWallet, requiredMargin: bigint): Promise<void> {
    const pool = getRpcPool();

    // Read existing SettlementV2 deposit (1e18 precision, no conversion needed)
    let available = 0n;
    try {
      const deposits = await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.settlementV2,
          abi: SETTLEMENT_V2_ABI,
          functionName: "userDeposits",
          args: [wallet.address],
        })
      );
      available = deposits as bigint;
    } catch {}

    // Also check matching engine balance (may include PnL adjustments)
    const engineBalance = await this.getAvailableBalance(wallet);
    if (engineBalance >= requiredMargin) return;

    // Need to deposit (keep amounts low — wallets have ~0.003 ETH)
    // Use BigInt-native comparison (Math.min doesn't work with BigInt)
    const minAvail = available < engineBalance ? available : engineBalance;
    const depositAmount = requiredMargin > minAvail
      ? requiredMargin + parseEther("0.0003")
      : parseEther("0.0005"); // Minimum deposit

    const walletClient = pool.createWallet(wallet.privateKey);
    const account = privateKeyToAccount(wallet.privateKey);

    // Check ETH balance (need deposit + gas for 3 txns)
    const ethBalance = await pool.call(() =>
      pool.httpClient.getBalance({ address: wallet.address })
    );

    const gasBuffer = parseEther("0.0003"); // ~0.0003 ETH for 3 txns gas (BSC Testnet gas is cheap)
    if (ethBalance < depositAmount + gasBuffer) {
      if (this.stats.totalRounds <= 2) {
        console.log(`[Perp] W${wallet.index} skip deposit: ethBalance=${formatEther(ethBalance)} < need=${formatEther(depositAmount + gasBuffer)}`);
      }
      return;
    }

    // Step 1: Wrap ETH → WETH
    const wrapHash = await pool.call(() =>
      walletClient.writeContract({
        chain: bscTestnet,
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "deposit",
        args: [],
        value: depositAmount,
        account,
      })
    );
    await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash: wrapHash }));

    // Step 2: Approve WETH for SettlementV2
    const approveHash = await pool.call(() =>
      walletClient.writeContract({
        chain: bscTestnet,
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "approve",
        args: [CONTRACTS.settlementV2, depositAmount],
        account,
      })
    );
    await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash: approveHash }));

    // Step 3: Deposit WETH into SettlementV2
    const depositHash = await pool.call(() =>
      walletClient.writeContract({
        chain: bscTestnet,
        address: CONTRACTS.settlementV2,
        abi: SETTLEMENT_V2_ABI,
        functionName: "deposit",
        args: [depositAmount],
        account,
      })
    );
    await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash: depositHash }));

    this.stats.deposits++;
    console.log(`[Perp] W${wallet.index} DEPOSIT ${formatEther(depositAmount)} ETH to SettlementV2 (3-step)`);

    // Explicitly sync with matching engine — event listener may lag
    try {
      await fetch(`${MATCHING_ENGINE.url}/api/balance/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trader: wallet.address }),
      });
    } catch {}

    // Brief wait for engine to process the sync
    await new Promise(r => setTimeout(r, 1000));
  }

  /**
   * Bulk deposit: move ~80% of each wallet's ETH into SettlementV2 at startup.
   *
   * V2 flow for each wallet:
   *   1. Check existing SettlementV2 userDeposits (1e18, no conversion)
   *   2. Skip if already has enough deposited
   *   3. Otherwise: wrap ETH → approve WETH → deposit to SettlementV2
   *
   * Processes wallets in PARALLEL batches of CONCURRENT_DEPOSITS to reduce
   * startup time from ~30 min (serial) to ~2-3 min for 200 wallets.
   */
  private async bulkDepositAll(): Promise<void> {
    const pool = getRpcPool();
    const GAS_RESERVE = parseEther("0.0005"); // Keep 0.0005 ETH for gas (BSC Testnet gas is cheap)
    const CONCURRENT_DEPOSITS = 10; // Process 10 wallets in parallel per batch

    let deposited = 0;
    let skipped = 0;
    let lowBalance = 0;

    // Split wallets into batches of CONCURRENT_DEPOSITS
    const batches: StressWallet[][] = [];
    for (let i = 0; i < this.wallets.length; i += CONCURRENT_DEPOSITS) {
      batches.push(this.wallets.slice(i, i + CONCURRENT_DEPOSITS));
    }

    console.log(`[PerpEngine] Bulk deposit: ${this.wallets.length} wallets in ${batches.length} batches (${CONCURRENT_DEPOSITS} concurrent)`);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      if (!this.running) break;

      const batch = batches[batchIdx];

      // Process entire batch concurrently
      const results = await Promise.allSettled(
        batch.map(wallet => this.depositSingleWallet(pool, wallet, GAS_RESERVE))
      );

      // Tally results
      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value === "deposited") deposited++;
          else if (r.value === "skipped") { deposited++; skipped++; }
          else if (r.value === "low_balance") lowBalance++;
        }
        // "rejected" = error already logged inside depositSingleWallet
      }

      const done = Math.min((batchIdx + 1) * CONCURRENT_DEPOSITS, this.wallets.length);
      console.log(`[Perp] Bulk deposit batch ${batchIdx + 1}/${batches.length} done (${done}/${this.wallets.length} wallets processed)`);

      // Small delay between batches for RPC rate limit + event processing
      if (batchIdx < batches.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log(`[PerpEngine] Bulk deposit complete: ${deposited} deposited (${skipped} already had funds), ${lowBalance} low balance, out of ${this.wallets.length} wallets`);
  }

  /**
   * Sync all wallet balances with the matching engine after bulk deposits.
   *
   * The engine detects deposits via SettlementV2 `Deposited` event listeners,
   * but rapid parallel deposits (200 wallets × 3 txns) can overwhelm the WSS
   * event processor. This explicit sync ensures every wallet's on-chain deposit
   * is reflected in the engine's in-memory balance before trading begins.
   *
   * Uses POST /api/balance/sync { trader } — calls syncUserBalanceFromChain()
   * inside the matching engine, which reads SettlementV2.userDeposits(trader)
   * and reconciles with the engine's Redis balance.
   */
  private async syncEngineBalances(): Promise<void> {
    const BATCH_SIZE = 20; // 20 concurrent sync calls per batch
    let synced = 0;
    let failed = 0;

    console.log(`[PerpEngine] Syncing ${this.wallets.length} wallet balances with matching engine...`);

    for (let i = 0; i < this.wallets.length; i += BATCH_SIZE) {
      if (!this.running) break;

      const batch = this.wallets.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (wallet) => {
          const resp = await fetch(`${MATCHING_ENGINE.url}/api/balance/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trader: wallet.address }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.json();
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") synced++;
        else failed++;
      }

      // Brief pause between batches to avoid overwhelming the engine
      if (i + BATCH_SIZE < this.wallets.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    console.log(`[PerpEngine] Engine balance sync complete: ${synced} synced, ${failed} failed out of ${this.wallets.length} wallets`);
  }

  /** Deposit a single wallet's ETH into SettlementV2 (3-step on-chain flow). */
  private async depositSingleWallet(
    pool: ReturnType<typeof getRpcPool>,
    wallet: StressWallet,
    gasReserve: bigint,
  ): Promise<"deposited" | "skipped" | "low_balance"> {
    const ethBalance = await pool.call(() =>
      pool.httpClient.getBalance({ address: wallet.address })
    );

    // Check existing SettlementV2 deposit (1e18 precision, no conversion needed)
    let existingDeposit = 0n;
    try {
      existingDeposit = await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.settlementV2,
          abi: SETTLEMENT_V2_ABI,
          functionName: "userDeposits",
          args: [wallet.address],
        })
      ) as bigint;
    } catch {}

    // Skip if already has any meaningful deposit (>= minSizeEth from config)
    const minDeposit = parseEther(PERP_CONFIG.minSizeEth.toString());
    if (existingDeposit >= minDeposit) {
      // Trigger engine to sync chain balance
      try {
        await fetch(`${MATCHING_ENGINE.url}/api/user/${wallet.address}/balance`).catch(() => {});
      } catch {}
      return "skipped";
    }

    // Need enough ETH for deposit + 3 txns gas
    if (ethBalance <= gasReserve) {
      return "low_balance";
    }

    const depositAmount = ethBalance - gasReserve;
    const walletClient = pool.createWallet(wallet.privateKey);
    const account = privateKeyToAccount(wallet.privateKey);

    // Step 1: Wrap ETH → WETH
    const wrapHash = await pool.call(() =>
      walletClient.writeContract({
        chain: bscTestnet,
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "deposit",
        args: [],
        value: depositAmount,
        account,
      })
    );
    await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash: wrapHash }));

    // Step 2: Approve WETH for SettlementV2
    const approveHash = await pool.call(() =>
      walletClient.writeContract({
        chain: bscTestnet,
        address: WETH_ADDRESS,
        abi: WETH_ABI,
        functionName: "approve",
        args: [CONTRACTS.settlementV2, depositAmount],
        account,
      })
    );
    await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash: approveHash }));

    // Step 3: Deposit WETH into SettlementV2
    const depositHash = await pool.call(() =>
      walletClient.writeContract({
        chain: bscTestnet,
        address: CONTRACTS.settlementV2,
        abi: SETTLEMENT_V2_ABI,
        functionName: "deposit",
        args: [depositAmount],
        account,
      })
    );
    await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash: depositHash }));

    this.stats.deposits++;
    console.log(`[Perp] W${wallet.index} BULK DEPOSIT ${formatEther(depositAmount)} ETH to SettlementV2`);
    return "deposited";
  }

  // ── Limit Order Placement (Order Book Depth) ──────────────

  /** Get current price of a token — uses TokenFactory bonding curve as source of truth */
  private async getTokenPrice(token: Address): Promise<bigint> {
    // Primary: TokenFactory bonding curve (always has a price)
    try {
      const pool = getRpcPool();
      const price = await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.tokenFactory,
          abi: TOKEN_FACTORY_ABI,
          functionName: "getCurrentPrice",
          args: [token],
        })
      );
      if ((price as bigint) > 0n) return price as bigint;
    } catch {}

    // Fallback: matching engine stats API
    try {
      const resp = await fetch(`${MATCHING_ENGINE.url}/api/stats/${token}`);
      const data = await resp.json() as { lastPrice?: string; price?: string };
      const priceStr = data.lastPrice || data.price || "0";
      const p = BigInt(priceStr);
      if (p > 0n) return p;
    } catch {}

    return 0n;
  }

  /**
   * Place limit orders around the current price to create visible order book depth.
   *
   * Strategy: Place orders at multiple price levels with WIDE spreads (5-30%).
   * Since paired trading now uses limit orders at current price, these wider-spread
   * orders won't be consumed (limit-vs-limit matching requires price crossing).
   *
   * Each call places 6-12 orders: half bids, half asks, across 5 spread tiers.
   */
  private async placeLimitOrders(wallets: StressWallet[], token: Address): Promise<void> {
    const currentPrice = await this.getTokenPrice(token);
    if (currentPrice === 0n) return;

    // More orders per round for denser book
    const orderCount = randInt(6, 12);
    const candidates = pickRandom(wallets, orderCount);

    // Spread tiers: 5%, 10%, 15%, 20%, 25% — creates visible depth at multiple levels
    const spreadTiersBps = [500, 1000, 1500, 2000, 2500];

    for (const wallet of candidates) {
      if (!this.running) break;

      const available = await this.getAvailableBalance(wallet);
      if (available < parseEther("0.002")) continue;

      const isLong = Math.random() > 0.5;
      // Pick a random spread tier + some jitter (±2%)
      const tierIdx = randInt(0, spreadTiersBps.length - 1);
      const jitterBps = randInt(-200, 200);
      const spreadBps = Math.max(300, spreadTiersBps[tierIdx] + jitterBps); // minimum 3%
      let price: bigint;

      if (isLong) {
        price = currentPrice * BigInt(10000 - spreadBps) / 10000n;
      } else {
        price = currentPrice * BigInt(10000 + spreadBps) / 10000n;
      }

      if (price === 0n) continue;

      const size = parseEther(
        (PERP_CONFIG.minSizeEth + Math.random() * (PERP_CONFIG.maxSizeEth - PERP_CONFIG.minSizeEth) * 0.5).toFixed(6)
      );
      const leverageMultiplier = BigInt(randInt(2, 15));
      const leverage = leverageMultiplier * PERP_CONFIG.leveragePrecision;

      const result = await this.submitOrder(wallet, token, isLong, size, leverage, 1, price);
      if (result.success) {
        this.stats.ordersSubmitted++;
        const side = isLong ? "BID" : "ASK";
        const spreadPct = (spreadBps / 100).toFixed(1);
        console.log(`[Perp] W${wallet.index} ${side} ${formatEther(size)}ETH @${spreadPct}% ${isLong ? "below" : "above"} → ${token.slice(0, 10)}...`);
      }
    }
  }

  // ── Nonce Management ───────────────────────────────────────

  private getLocalNonce(wallet: StressWallet): bigint {
    return this.localNonces.get(wallet.address) ?? 0n;
  }

  private incrementNonce(wallet: StressWallet): void {
    const current = this.getLocalNonce(wallet);
    this.localNonces.set(wallet.address, current + 1n);
  }

  private async syncNonce(wallet: StressWallet): Promise<void> {
    // Primary: matching engine API (has the latest nonce including off-chain orders)
    try {
      const resp = await fetch(`${MATCHING_ENGINE.url}/api/user/${wallet.address}/nonce`);
      const data = await resp.json() as { nonce?: string | number };
      if (data.nonce != null) {
        this.localNonces.set(wallet.address, BigInt(data.nonce));
        return;
      }
    } catch {}

    // Fallback: on-chain SettlementV2 withdrawal nonces (not order nonces — those are engine-only)
    // Order nonces are managed entirely by the matching engine, not on-chain.
    // If engine API fails, default to 0 (engine will reject and we'll re-sync)
    console.warn(`[PerpEngine] W${wallet.index} nonce sync: engine API failed, defaulting to 0`);
  }

  private async syncAllNonces(): Promise<void> {
    // Try matching engine API first (batch via concurrent fetches)
    let apiSynced = 0;
    const batchSize = 10;
    for (let i = 0; i < this.wallets.length; i += batchSize) {
      const batch = this.wallets.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (w) => {
          const resp = await fetch(`${MATCHING_ENGINE.url}/api/user/${w.address}/nonce`);
          const data = await resp.json() as { nonce?: string | number };
          if (data.nonce != null) {
            this.localNonces.set(w.address, BigInt(data.nonce));
            apiSynced++;
          }
        })
      );
    }

    if (apiSynced > 0) {
      console.log(`[PerpEngine] Synced ${apiSynced}/${this.wallets.length} nonces from matching engine`);
      return;
    }

    // Fallback: order nonces are engine-only (not on-chain), initialize unsynced wallets to 0
    // The engine will reject stale nonces and we'll re-sync from the API on failure
    let initialized = 0;
    for (const w of this.wallets) {
      if (!this.localNonces.has(w.address)) {
        this.localNonces.set(w.address, 0n);
        initialized++;
      }
    }
    console.log(`[PerpEngine] Engine API synced ${apiSynced}, initialized ${initialized} wallets to nonce 0`);
  }

  private async refreshTokenList(): Promise<void> {
    try {
      const pool = getRpcPool();
      // Use perpTokenFactory — the one the matching engine knows about
      const tokens = await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.perpTokenFactory,
          abi: TOKEN_FACTORY_ABI,
          functionName: "getAllTokens",
        })
      );
      this.tradableTokens = tokens as Address[];
    } catch {}
  }

  // ── Withdrawal Testing ──────────────────────────────────────

  /**
   * Test Merkle proof withdrawal flow:
   *   1. Pick a random wallet with engine balance > 0.005 ETH
   *   2. POST /api/wallet/withdraw → get Merkle proof + EIP-712 sig
   *   3. Call SettlementV2.withdraw() on-chain with proof
   *   4. Verify WETH arrived in wallet
   */
  private async executeWithdrawalTest(): Promise<void> {
    // Find a wallet with enough balance
    const candidates = [];
    for (const wallet of pickRandom(this.wallets, Math.min(10, this.wallets.length))) {
      const balance = await this.getAvailableBalance(wallet);
      if (balance > parseEther("0.005")) {
        candidates.push({ wallet, balance });
      }
    }

    if (candidates.length === 0) {
      console.log("[PerpEngine] No wallets with sufficient balance for withdrawal test");
      return;
    }

    const { wallet, balance } = candidates[0];
    const withdrawAmount = parseEther("0.002"); // Small test withdrawal

    console.log(`[PerpEngine] 🔄 Withdrawal test: W${wallet.index} withdrawing ${formatEther(withdrawAmount)} ETH...`);

    // Step 1: Request withdrawal from matching engine (gets Merkle proof + sig)
    try {
      const account = privateKeyToAccount(wallet.privateKey);
      const message = `Withdraw ${withdrawAmount.toString()} for ${wallet.address.toLowerCase()}`;
      const traderSig = await account.signMessage({ message });

      const resp = await fetch(`${MATCHING_ENGINE.url}/api/wallet/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trader: wallet.address,
          amount: withdrawAmount.toString(),
          token: WETH_ADDRESS,
          signature: traderSig,
        }),
      });

      const result = await resp.json() as {
        success?: boolean;
        authorization?: {
          merkleProof: string[];
          signature: string;
          deadline: string;
          userEquity: string;
        };
        error?: string;
      };

      if (!result.success || !result.authorization) {
        console.log(`[PerpEngine] Withdrawal request rejected: ${result.error || "no authorization"}`);
        // This is expected if no Merkle snapshot has been submitted yet
        return;
      }

      // Step 2: Submit withdrawal on-chain
      const pool = getRpcPool();
      const walletClient = pool.createWallet(wallet.privateKey);

      const wethBefore = await pool.call(() =>
        pool.httpClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [wallet.address],
        })
      ) as bigint;

      const txHash = await pool.call(() =>
        walletClient.writeContract({
          chain: bscTestnet,
          address: CONTRACTS.settlementV2,
          abi: SETTLEMENT_V2_ABI,
          functionName: "withdraw",
          args: [
            withdrawAmount,
            BigInt(result.authorization!.userEquity),
            result.authorization!.merkleProof as `0x${string}`[],
            BigInt(result.authorization!.deadline),
            result.authorization!.signature as `0x${string}`,
          ],
          account,
        })
      );

      await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash: txHash }));

      // Step 3: Verify WETH arrived
      const wethAfter = await pool.call(() =>
        pool.httpClient.readContract({
          address: WETH_ADDRESS,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [wallet.address],
        })
      ) as bigint;

      const received = wethAfter - wethBefore;
      if (received >= withdrawAmount) {
        this.stats.withdrawals++;
        console.log(`[PerpEngine] ✅ Withdrawal SUCCESS: W${wallet.index} received ${formatEther(received)} WETH`);
      } else {
        this.stats.withdrawalFailures++;
        console.error(`[PerpEngine] ⚠️ Withdrawal MISMATCH: expected ${formatEther(withdrawAmount)}, got ${formatEther(received)}`);
      }
    } catch (err: any) {
      this.stats.withdrawalFailures++;
      console.error(`[PerpEngine] ❌ Withdrawal test failed: ${err.message?.slice(0, 120)}`);
    }
  }

  // ── Full Lifecycle Verification ─────────────────────────────

  /**
   * Verify on-chain state matches engine state:
   *   1. SettlementV2.userDeposits(wallet) — total deposited on-chain
   *   2. Matching engine balance — available + locked
   *   3. PerpVault.getPoolValue() — LP pool health
   *   4. PerpVault.getTotalOI() — OI consistency
   */
  private async verifyFullCycle(): Promise<void> {
    const pool = getRpcPool();
    this.stats.lifecycleChecks++;

    // Sample 5 random wallets for state verification
    const sample = pickRandom(this.wallets, Math.min(5, this.wallets.length));
    let mismatches = 0;

    for (const wallet of sample) {
      try {
        // On-chain deposits
        const chainDeposit = await pool.call(() =>
          pool.httpClient.readContract({
            address: CONTRACTS.settlementV2,
            abi: SETTLEMENT_V2_ABI,
            functionName: "userDeposits",
            args: [wallet.address],
          })
        ) as bigint;

        // Engine balance
        const engineBalance = await this.getAvailableBalance(wallet);

        // Drift check: engine balance can be higher (PnL gains via mode2Adj) or lower (open positions, losses)
        // But should never be wildly different from chain deposits
        const drift = engineBalance > chainDeposit
          ? engineBalance - chainDeposit
          : chainDeposit - engineBalance;

        // Allow up to 50% drift (mode2Adj for PnL is expected)
        const maxDrift = chainDeposit > 0n ? chainDeposit / 2n : parseEther("0.5");
        if (drift > maxDrift && chainDeposit > parseEther("0.001")) {
          mismatches++;
          console.warn(`[PerpEngine] ⚠️ W${wallet.index} drift: chain=${formatEther(chainDeposit)} engine=${formatEther(engineBalance)} drift=${formatEther(drift)}`);
        }
      } catch {}
    }

    // PerpVault health check
    try {
      const poolValue = await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.perpVault,
          abi: PERP_VAULT_ABI,
          functionName: "getPoolValue",
        })
      ) as bigint;

      const totalOI = await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.perpVault,
          abi: PERP_VAULT_ABI,
          functionName: "getTotalOI",
        })
      ) as bigint;

      if (poolValue === 0n) {
        console.error(`[PerpEngine] 🚨 CRITICAL: PerpVault poolValue is ZERO!`);
        mismatches++;
      }

      console.log(`[PerpEngine] 📊 Lifecycle check: PerpVault poolValue=${formatEther(poolValue)} totalOI=${formatEther(totalOI)} mismatches=${mismatches}`);
    } catch (err: any) {
      console.error(`[PerpEngine] PerpVault check failed: ${err.message?.slice(0, 80)}`);
    }

    if (mismatches > 0) {
      this.stats.lifecycleFailures++;
    }
  }
}
