/**
 * Spot Blast — 集中火力对 2 个 token 大批量并发交易
 *
 * 与 orchestrator 不同：
 *   - 只交易 2 个指定 token（不分散到 66+）
 *   - 每轮所有钱包同时并发发送交易（不是 3-5 个）
 *   - 买卖比例 70/30，无创建新 token
 *   - 每轮间隔更短（0.5-1.5s）
 *
 * Usage:
 *   bun run spot-blast.ts
 *   bun run spot-blast.ts --wallets 30 --duration 10m
 */
import { parseEther, formatEther, erc20Abi, type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { loadWallets, type StressWallet } from "./utils/wallet-manager.js";
import { getRpcPool } from "./utils/rpc-pool.js";
import { CONTRACTS, TOKEN_FACTORY_ABI } from "./config.js";

// ── Config ──────────────────────────────────────────────────────

const TARGET_TOKENS: Address[] = [
  "0x512b5ce1e9696c41219d55e6cb1d24b38827fc9c", // TEST
  "0x6a3d1ea001cfcdfb48e2b65b414752bbb9cb0a21", // STALPHA
];

const BUY_PROBABILITY = 0.70;
const MIN_BUY_ETH = 0.001;
const MAX_BUY_ETH = 0.008;
const SELL_PERCENT_RANGE = [0.1, 0.4] as const;
const ROUND_INTERVAL_MS = [500, 1500] as const;
const CONCURRENCY = 10; // max concurrent txs per round

// ── CLI Args ────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let walletCount = 20;
  let durationMs = 30 * 60 * 1000; // 30 min default

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wallets" && args[i + 1]) {
      walletCount = parseInt(args[i + 1]); i++;
    } else if (args[i] === "--duration" && args[i + 1]) {
      const val = args[i + 1];
      if (val.endsWith("h")) durationMs = parseFloat(val) * 3600 * 1000;
      else if (val.endsWith("m")) durationMs = parseFloat(val) * 60 * 1000;
      else durationMs = parseFloat(val) * 1000;
      i++;
    }
  }
  return { walletCount, durationMs };
}

// ── Stats ───────────────────────────────────────────────────────

const stats = {
  rounds: 0,
  buys: 0,
  sells: 0,
  failures: 0,
  totalEthSpent: 0,
  startTime: Date.now(),
};

// ── Execute Buy ─────────────────────────────────────────────────

async function executeBuy(wallet: StressWallet, token: Address): Promise<void> {
  const pool = getRpcPool();
  const ethAmount = parseEther(
    (MIN_BUY_ETH + Math.random() * (MAX_BUY_ETH - MIN_BUY_ETH)).toFixed(6)
  );

  const balance = await pool.call(() =>
    pool.httpClient.getBalance({ address: wallet.address })
  );

  if (balance < ethAmount + parseEther("0.0005")) return;

  const walletClient = pool.createWallet(wallet.privateKey);
  const account = privateKeyToAccount(wallet.privateKey);

  const hash = await pool.call(() =>
    walletClient.writeContract({
      chain: bscTestnet,
      address: CONTRACTS.tokenFactory,
      abi: TOKEN_FACTORY_ABI,
      functionName: "buy",
      args: [token, 0n],
      value: ethAmount,
      account,
    })
  );

  await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash, timeout: 30_000 }));
  stats.buys++;
  stats.totalEthSpent += Number(formatEther(ethAmount));
  const sym = token === TARGET_TOKENS[0] ? "TEST" : "STALPHA";
  console.log(`[BUY]  W${wallet.index} ${formatEther(ethAmount)} ETH → ${sym} tx:${hash.slice(0, 12)}...`);
}

// ── Execute Sell ────────────────────────────────────────────────

async function executeSell(wallet: StressWallet, token: Address): Promise<void> {
  const pool = getRpcPool();

  const tokenBalance = await pool.call(() =>
    pool.httpClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet.address],
    })
  ) as bigint;

  if (tokenBalance === 0n) return;

  const sellPct = SELL_PERCENT_RANGE[0] +
    Math.random() * (SELL_PERCENT_RANGE[1] - SELL_PERCENT_RANGE[0]);
  const sellAmount = BigInt(Math.floor(Number(tokenBalance) * sellPct));

  if (sellAmount < parseEther("0.0001")) return;

  const walletClient = pool.createWallet(wallet.privateKey);
  const account = privateKeyToAccount(wallet.privateKey);

  // Approve
  await pool.call(() =>
    walletClient.writeContract({
      chain: bscTestnet,
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [CONTRACTS.tokenFactory, sellAmount * 2n],
      account,
    })
  );

  // Sell
  const hash = await pool.call(() =>
    walletClient.writeContract({
      chain: bscTestnet,
      address: CONTRACTS.tokenFactory,
      abi: TOKEN_FACTORY_ABI,
      functionName: "sell",
      args: [token, sellAmount, 0n],
      account,
    })
  );

  await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash, timeout: 30_000 }));
  stats.sells++;
  const sym = token === TARGET_TOKENS[0] ? "TEST" : "STALPHA";
  console.log(`[SELL] W${wallet.index} ${formatEther(sellAmount)} tokens ${sym} tx:${hash.slice(0, 12)}...`);
}

// ── Execute Round ───────────────────────────────────────────────

const busyWallets = new Set<Address>();

async function executeRound(wallets: StressWallet[]): Promise<void> {
  stats.rounds++;

  // All available wallets participate
  const available = wallets.filter(w => !busyWallets.has(w.address));
  if (available.length === 0) return;

  // Split into chunks of CONCURRENCY for parallel execution
  const chunks: StressWallet[][] = [];
  for (let i = 0; i < available.length; i += CONCURRENCY) {
    chunks.push(available.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    // Fire all transactions in this chunk concurrently
    const promises = chunk.map(async (wallet) => {
      busyWallets.add(wallet.address);
      try {
        // Pick random token from the 2 targets
        const token = TARGET_TOKENS[Math.random() < 0.5 ? 0 : 1];
        const roll = Math.random();

        if (roll < BUY_PROBABILITY) {
          await executeBuy(wallet, token);
        } else {
          await executeSell(wallet, token);
        }
      } catch (err: any) {
        stats.failures++;
        const msg = err.message?.slice(0, 60) || "unknown";
        if (!msg.includes("Nonce")) {
          console.error(`[ERR]  W${wallet.index}: ${msg}`);
        }
      } finally {
        busyWallets.delete(wallet.address);
      }
    });

    await Promise.allSettled(promises);
  }
}

// ── Summary ─────────────────────────────────────────────────────

function printSummary(): void {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const tps = (stats.buys + stats.sells) / elapsed;
  console.log(`\n═══ Round ${stats.rounds} | ${elapsed.toFixed(0)}s ═══`);
  console.log(`  BUY: ${stats.buys} | SELL: ${stats.sells} | FAIL: ${stats.failures} | TPS: ${tps.toFixed(2)}`);
  console.log(`  ETH spent: ${stats.totalEthSpent.toFixed(4)}`);
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const { walletCount, durationMs } = parseArgs();
  const endTime = Date.now() + durationMs;
  const durationMin = durationMs / 60000;

  console.log("╔═══════════════════════════════════════════╗");
  console.log("║   Spot Blast — 2 Token Concentrated Fire  ║");
  console.log("╚═══════════════════════════════════════════╝");
  console.log(`Tokens: TEST + STALPHA`);
  console.log(`Wallets: ${walletCount} | Duration: ${durationMin}m | Concurrency: ${CONCURRENCY}`);
  console.log(`Buy/Sell: ${BUY_PROBABILITY * 100}% / ${(1 - BUY_PROBABILITY) * 100}%`);
  console.log("");

  // Load wallets (spot group only)
  const allWallets = loadWallets(walletCount, 0);
  const spotWallets = allWallets.filter(w => w.group === "spot");
  console.log(`[Init] ${spotWallets.length} wallets loaded\n`);

  let summaryCounter = 0;

  while (Date.now() < endTime) {
    await executeRound(spotWallets);

    summaryCounter++;
    if (summaryCounter % 10 === 0) {
      printSummary();
    }

    // Short interval between rounds
    const delay = ROUND_INTERVAL_MS[0] +
      Math.random() * (ROUND_INTERVAL_MS[1] - ROUND_INTERVAL_MS[0]);
    await new Promise(r => setTimeout(r, delay));
  }

  console.log("\n╔═══════════════════════════════════════════╗");
  console.log("║              BLAST COMPLETE                ║");
  console.log("╚═══════════════════════════════════════════╝");
  printSummary();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
