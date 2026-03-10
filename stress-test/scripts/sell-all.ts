/**
 * Sell-All Script — dump all meme tokens from test wallets to recover ETH
 *
 * Usage: bun run stress-test/scripts/sell-all.ts
 *
 * Optimized: batch-reads all balances first, then only processes wallets
 * that actually hold tokens. Uses concurrent selling for speed.
 */
import { formatEther, erc20Abi, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getRpcPool } from "../utils/rpc-pool.js";
import { CONTRACTS, TOKEN_FACTORY_ABI } from "../config.js";
import { loadWallets } from "../utils/wallet-manager.js";

async function main() {
  const pool = getRpcPool();

  // 1. Load all tokens
  console.log("[SellAll] Loading tokens...");
  const allTokens = await pool.call(() =>
    pool.httpClient.readContract({
      address: CONTRACTS.tokenFactory,
      abi: TOKEN_FACTORY_ABI,
      functionName: "getAllTokens",
    })
  ) as Address[];
  console.log(`[SellAll] Found ${allTokens.length} tokens: ${allTokens.map(t => t.slice(0, 10)).join(", ")}`);

  // Check which tokens are still active (not graduated)
  const activeTokens: Address[] = [];
  for (const token of allTokens) {
    try {
      const poolState = await pool.call(() =>
        pool.httpClient.readContract({
          address: CONTRACTS.tokenFactory,
          abi: TOKEN_FACTORY_ABI,
          functionName: "getPoolState",
          args: [token],
        })
      ) as { isGraduated: boolean; isActive: boolean };
      if (!poolState.isGraduated && poolState.isActive) {
        activeTokens.push(token);
        console.log(`[SellAll]   ${token.slice(0, 10)} — active ✓`);
      } else {
        console.log(`[SellAll]   ${token.slice(0, 10)} — graduated/inactive, skipping`);
      }
    } catch {
      activeTokens.push(token); // Try anyway if we can't read state
    }
  }

  if (activeTokens.length === 0) {
    console.log("[SellAll] No active tokens to sell!");
    return;
  }

  // 2. Load wallets
  const wallets = loadWallets(200, 100);
  console.log(`[SellAll] Loaded ${wallets.length} wallets`);

  // 3. Batch scan: find wallets that hold tokens
  console.log("[SellAll] Scanning balances (batch)...");
  type TokenHolding = { walletIdx: number; token: Address; balance: bigint };
  const holdings: TokenHolding[] = [];

  // Process in chunks of 20 wallets at a time
  const CHUNK = 20;
  for (let i = 0; i < wallets.length; i += CHUNK) {
    const chunk = wallets.slice(i, i + CHUNK);

    // Build batch calls for all wallets × all active tokens in this chunk
    const calls = chunk.flatMap(w =>
      activeTokens.map(token => ({
        walletIdx: w.index,
        token,
        call: () => pool.httpClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [w.address],
        }),
      }))
    );

    // Execute all balance checks concurrently (viem will batch them)
    const results = await pool.batchRead(calls.map(c => c.call));

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.success && (r.result as bigint) > 0n) {
        holdings.push({
          walletIdx: calls[j].walletIdx,
          token: calls[j].token,
          balance: r.result as bigint,
        });
      }
    }

    // Progress every 100 wallets
    if ((i + CHUNK) % 100 === 0 || i + CHUNK >= wallets.length) {
      console.log(`[SellAll] Scanned ${Math.min(i + CHUNK, wallets.length)}/${wallets.length} wallets — found ${holdings.length} holdings so far`);
    }
  }

  console.log(`[SellAll] Found ${holdings.length} token holdings across all wallets`);
  if (holdings.length === 0) {
    console.log("[SellAll] No tokens to sell! Wallets are empty.");
    // Show sample balances
    await showBalances(wallets.slice(0, 10));
    return;
  }

  // 4. Sell all holdings
  let totalSold = 0;
  let totalETHRecovered = 0;
  let errors = 0;

  for (const holding of holdings) {
    const wallet = wallets.find(w => w.index === holding.walletIdx)!;
    const account = privateKeyToAccount(wallet.privateKey);

    try {
      // Check gas
      const ethBal = await pool.call(() =>
        pool.httpClient.getBalance({ address: wallet.address })
      );
      if (ethBal < 50_000_000_000_000n) {
        console.log(`[SellAll] W${wallet.index} skip: only ${formatEther(ethBal)} ETH (need gas)`);
        continue;
      }

      // Approve if needed
      const allowance = await pool.call(() =>
        pool.httpClient.readContract({
          address: holding.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [wallet.address, CONTRACTS.tokenFactory],
        })
      ) as bigint;

      if (allowance < holding.balance) {
        const wc = pool.createWallet(wallet.privateKey);
        const approveTx = await pool.call(() =>
          wc.writeContract({
            chain: bscTestnet,
            address: holding.token,
            abi: erc20Abi,
            functionName: "approve",
            args: [CONTRACTS.tokenFactory, holding.balance * 2n],
            account,
          })
        );
        await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash: approveTx }));
        console.log(`[SellAll] W${wallet.index} approved ${holding.token.slice(0, 10)}`);
      }

      // Get ETH balance before
      const ethBefore = await pool.call(() =>
        pool.httpClient.getBalance({ address: wallet.address })
      );

      // SELL with minETHOut = 0 (don't care about slippage)
      const wc = pool.createWallet(wallet.privateKey);
      const hash = await pool.call(() =>
        wc.writeContract({
          chain: bscTestnet,
          address: CONTRACTS.tokenFactory,
          abi: TOKEN_FACTORY_ABI,
          functionName: "sell",
          args: [holding.token, holding.balance, 0n],
          account,
        })
      );
      await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash }));

      // Get ETH balance after
      const ethAfter = await pool.call(() =>
        pool.httpClient.getBalance({ address: wallet.address })
      );
      const ethGained = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;

      totalSold++;
      totalETHRecovered += Number(formatEther(ethGained));
      console.log(
        `[SellAll] ✓ W${wallet.index} sold ${formatEther(holding.balance)} of ${holding.token.slice(0, 10)} → +${formatEther(ethGained)} ETH (bal: ${formatEther(ethAfter)})`
      );
    } catch (err: any) {
      errors++;
      console.error(`[SellAll] ✗ W${wallet.index} ${holding.token.slice(0, 10)}: ${err.message?.slice(0, 80)}`);
    }
  }

  console.log(`\n[SellAll] ═══════════════════════════════════════`);
  console.log(`[SellAll] Sold: ${totalSold}/${holdings.length} positions`);
  console.log(`[SellAll] ETH recovered: ~${totalETHRecovered.toFixed(6)} ETH`);
  console.log(`[SellAll] Errors: ${errors}`);
  console.log(`[SellAll] ═══════════════════════════════════════\n`);

  // 5. Final balances
  await showBalances(wallets.slice(0, 20));
}

async function showBalances(wallets: ReturnType<typeof loadWallets>) {
  const pool = getRpcPool();
  console.log("[SellAll] Sample wallet balances:");
  let total = 0;
  for (const w of wallets) {
    try {
      const bal = await pool.call(() =>
        pool.httpClient.getBalance({ address: w.address })
      );
      total += Number(formatEther(bal));
      console.log(`  W${w.index} (${w.group}): ${formatEther(bal)} ETH`);
    } catch {}
  }
  console.log(`  Total (${wallets.length} sampled): ~${total.toFixed(6)} ETH`);
}

main().catch(console.error);
