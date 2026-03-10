/**
 * Stress Test Bootstrap — Pre-orchestrator setup
 *
 * Runs 4 phases to prepare the chain for stress testing:
 *   Phase 1: Sell all existing meme tokens from all wallets → reclaim ETH
 *   Phase 2: Distribute ETH from deployer to 300 wallets
 *   Phase 3: Create 3 new tokens (STALPHA, STBETA, STGAMMA)
 *   Phase 4: Market-make each token to 6 ETH (perp enable threshold)
 *
 * After Phase 4 completes, the one-click shell script launches the orchestrator.
 *
 * Usage:
 *   bun run stress-test/bootstrap.ts [--skip-sell] [--skip-distribute] [--tokens 3]
 */
import {
  parseEther,
  formatEther,
  erc20Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import {
  CONTRACTS,
  TOKEN_FACTORY_ABI,
  SETTLEMENT_ABI,
  RPC,
  RATE_LIMITS,
  WALLET_SOURCES,
} from "./config.js";
import { getRpcPool } from "./utils/rpc-pool.js";

// ── Configuration ──────────────────────────────────────────────

const DEPLOYER_KEY = (process.env.DEPLOYER_KEY ||
  process.env.MEMEPERP_BLOCKCHAIN_PRIVATE_KEY ||
  "") as Hex;

const PERP_THRESHOLD_ETH = 6; // TokenFactory.PERP_ENABLE_THRESHOLD
const ETH_PER_SPOT_WALLET = 0.035; // Enough for ~5-10 buys
const ETH_PER_PERP_WALLET = 0.05; // Enough for deposits + orders
const MARKET_MAKE_BUY_SIZE = 0.15; // ETH per market-make buy
const MARKET_MAKE_WALLETS = 20; // Spread buys across this many wallets
const TX_DELAY_MS = 200; // Delay between sequential txs

const TOKEN_NAMES = [
  { name: "StressAlpha", symbol: "STALPHA", uri: "ipfs://stress/alpha" },
  { name: "StressBeta", symbol: "STBETA", uri: "ipfs://stress/beta" },
  { name: "StressGamma", symbol: "STGAMMA", uri: "ipfs://stress/gamma" },
];

// ── CLI Args ───────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let skipSell = false;
  let skipDistribute = false;
  let tokenCount = 3;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--skip-sell") skipSell = true;
    if (args[i] === "--skip-distribute") skipDistribute = true;
    if (args[i] === "--tokens" && args[i + 1]) {
      tokenCount = parseInt(args[i + 1]);
      i++;
    }
  }

  return { skipSell, skipDistribute, tokenCount };
}

// ── Wallet Loading (simplified — no group assignment needed here) ──

interface SimpleWallet {
  address: Address;
  privateKey: Hex;
}

function loadAllWallets(): SimpleWallet[] {
  const wallets: SimpleWallet[] = [];

  // Load main-wallets.json (flat array)
  try {
    const raw = readFileSync(WALLET_SOURCES.main, "utf-8");
    const entries = JSON.parse(raw) as Array<{ address: string; privateKey: string }>;
    for (const e of entries) {
      wallets.push({ address: e.address as Address, privateKey: e.privateKey as Hex });
    }
  } catch (err: any) {
    console.warn(`[Bootstrap] Could not load main wallets: ${err.message}`);
  }

  // Load extended wallets ({wallets: [...]} format)
  try {
    const raw = readFileSync(WALLET_SOURCES.extended, "utf-8");
    const file = JSON.parse(raw) as { wallets: Array<{ address: string; privateKey: string }> };
    for (const e of file.wallets) {
      // Deduplicate by address
      if (!wallets.some(w => w.address.toLowerCase() === e.address.toLowerCase())) {
        wallets.push({ address: e.address as Address, privateKey: e.privateKey as Hex });
      }
    }
  } catch (err: any) {
    console.warn(`[Bootstrap] Could not load extended wallets: ${err.message}`);
  }

  return wallets;
}

// ── Helpers ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function log(phase: string, msg: string) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [${phase}] ${msg}`);
}

// ── Phase 1: Sell All Existing Tokens ──────────────────────────

async function phase1SellAll(wallets: SimpleWallet[]) {
  log("Phase1", "═══ Selling all existing meme tokens from wallets ═══");

  const pool = getRpcPool();

  // Get all tokens from TokenFactory
  let allTokens: Address[];
  try {
    allTokens = (await pool.call(() =>
      pool.httpClient.readContract({
        address: CONTRACTS.tokenFactory,
        abi: TOKEN_FACTORY_ABI,
        functionName: "getAllTokens",
      })
    )) as Address[];
  } catch {
    log("Phase1", "No tokens found on TokenFactory, skipping sell phase.");
    return;
  }

  if (allTokens.length === 0) {
    log("Phase1", "No tokens to sell. Skipping.");
    return;
  }

  log("Phase1", `Found ${allTokens.length} tokens. Checking balances across ${wallets.length} wallets...`);

  let totalSold = 0;
  let totalReclaimed = 0n;

  // Process wallets in batches of 10
  for (let wi = 0; wi < wallets.length; wi += 10) {
    const batch = wallets.slice(wi, wi + 10);

    for (const wallet of batch) {
      for (const token of allTokens) {
        try {
          const balance = (await pool.call(() =>
            pool.httpClient.readContract({
              address: token,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [wallet.address],
            })
          )) as bigint;

          if (balance === 0n) continue;

          const account = privateKeyToAccount(wallet.privateKey);
          const walletClient = pool.createWallet(wallet.privateKey);

          // Approve
          await pool.call(() =>
            walletClient.writeContract({
              chain: bscTestnet,
              address: token,
              abi: erc20Abi,
              functionName: "approve",
              args: [CONTRACTS.tokenFactory, balance],
              account,
            })
          );
          await sleep(TX_DELAY_MS);

          // Sell with 0 minETHOut (we just want to reclaim whatever we can)
          const ethBefore = await pool.call(() =>
            pool.httpClient.getBalance({ address: wallet.address })
          );

          const hash = await pool.call(() =>
            walletClient.writeContract({
              chain: bscTestnet,
              address: CONTRACTS.tokenFactory,
              abi: TOKEN_FACTORY_ABI,
              functionName: "sell",
              args: [token, balance, 0n],
              account,
            })
          );

          await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash }));

          const ethAfter = await pool.call(() =>
            pool.httpClient.getBalance({ address: wallet.address })
          );

          const reclaimed = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
          totalReclaimed += reclaimed;
          totalSold++;

          log("Phase1", `Sold ${formatEther(balance)} tokens from ${wallet.address.slice(0, 8)}... → +${formatEther(reclaimed)} ETH`);
          await sleep(TX_DELAY_MS);
        } catch {
          // Silently skip failed sells (token may be graduated, etc.)
        }
      }
    }

    if (wi % 50 === 0 && wi > 0) {
      log("Phase1", `Progress: ${wi}/${wallets.length} wallets processed, ${totalSold} sales`);
    }
  }

  log("Phase1", `✅ Complete. ${totalSold} token sales, ~${formatEther(totalReclaimed)} ETH reclaimed`);
}

// ── Phase 2: Distribute ETH ────────────────────────────────────

async function phase2Distribute(wallets: SimpleWallet[], spotCount: number, perpCount: number) {
  log("Phase2", "═══ Distributing ETH from deployer to wallets ═══");

  if (!DEPLOYER_KEY) {
    throw new Error("DEPLOYER_KEY / MEMEPERP_BLOCKCHAIN_PRIVATE_KEY not set!");
  }

  const pool = getRpcPool();
  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const deployerClient = pool.createWallet(DEPLOYER_KEY);

  const deployerBalance = await pool.call(() =>
    pool.httpClient.getBalance({ address: deployerAccount.address })
  );
  log("Phase2", `Deployer ${deployerAccount.address}: ${formatEther(deployerBalance)} ETH`);

  // Calculate total needed
  const totalSpotEth = parseEther((ETH_PER_SPOT_WALLET * spotCount).toFixed(4));
  const totalPerpEth = parseEther((ETH_PER_PERP_WALLET * perpCount).toFixed(4));
  const totalMarketMake = parseEther((PERP_THRESHOLD_ETH * TOKEN_NAMES.length).toFixed(4));
  const totalNeeded = totalSpotEth + totalPerpEth + totalMarketMake + parseEther("1"); // +1 ETH for gas

  log("Phase2", `Need: ${formatEther(totalSpotEth)} (spot) + ${formatEther(totalPerpEth)} (perp) + ${formatEther(totalMarketMake)} (market-make) + 1 ETH (gas)`);
  log("Phase2", `Total needed: ~${formatEther(totalNeeded)} ETH`);

  if (deployerBalance < totalNeeded) {
    log("Phase2", `⚠️  WARNING: Deployer only has ${formatEther(deployerBalance)} ETH, need ~${formatEther(totalNeeded)}`);
    log("Phase2", `Continuing with available funds — some wallets may be underfunded.`);
  }

  // Check each wallet and only send if below threshold
  let distributed = 0;
  const targetAll = wallets.slice(0, spotCount + perpCount);

  for (let i = 0; i < targetAll.length; i++) {
    const wallet = targetAll[i];
    const isPerp = i >= spotCount;
    const targetEth = parseEther(isPerp ? ETH_PER_PERP_WALLET.toFixed(4) : ETH_PER_SPOT_WALLET.toFixed(4));

    try {
      const balance = await pool.call(() =>
        pool.httpClient.getBalance({ address: wallet.address })
      );

      if (balance >= targetEth) {
        continue; // Already funded
      }

      const toSend = targetEth - balance;
      const hash = await pool.call(() =>
        deployerClient.sendTransaction({
          to: wallet.address,
          value: toSend,
          chain: bscTestnet,
          account: deployerAccount,
        })
      );

      await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash }));
      distributed++;

      if (distributed % 20 === 0) {
        log("Phase2", `Distributed to ${distributed} wallets...`);
      }
      await sleep(TX_DELAY_MS / 2); // Faster for simple transfers
    } catch (err: any) {
      log("Phase2", `Failed to fund wallet ${i}: ${err.message?.slice(0, 60)}`);
    }
  }

  log("Phase2", `✅ Complete. Distributed ETH to ${distributed} wallets.`);
}

// ── Phase 3: Create Tokens ─────────────────────────────────────

async function phase3CreateTokens(count: number): Promise<Address[]> {
  log("Phase3", "═══ Creating new stress test tokens ═══");

  if (!DEPLOYER_KEY) {
    throw new Error("DEPLOYER_KEY / MEMEPERP_BLOCKCHAIN_PRIVATE_KEY not set!");
  }

  const pool = getRpcPool();
  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const deployerClient = pool.createWallet(DEPLOYER_KEY);

  const createdTokens: Address[] = [];

  for (let i = 0; i < count && i < TOKEN_NAMES.length; i++) {
    const { name, symbol, uri } = TOKEN_NAMES[i];

    log("Phase3", `Creating token ${i + 1}/${count}: ${symbol} (${name})...`);

    try {
      // createToken(name, symbol, metadataURI, minTokensOut)
      // minTokensOut = 0 for no slippage protection during bootstrap
      const hash = await pool.call(() =>
        deployerClient.writeContract({
          chain: bscTestnet,
          address: CONTRACTS.tokenFactory,
          abi: TOKEN_FACTORY_ABI,
          functionName: "createToken",
          args: [name, symbol, uri, 0n],
          value: parseEther("0.01"), // Initial liquidity seed
          account: deployerAccount,
        })
      );

      const receipt = await pool.call(() =>
        pool.httpClient.waitForTransactionReceipt({ hash })
      );

      // Extract token address from logs (TokenCreated event)
      // The token address is usually the first topic of the first log
      let tokenAddress: Address | null = null;
      for (const l of receipt.logs) {
        // TokenCreated(address indexed tokenAddress, address indexed creator, ...)
        if (l.topics.length >= 2 && l.address.toLowerCase() === CONTRACTS.tokenFactory.toLowerCase()) {
          tokenAddress = `0x${l.topics[1]!.slice(26)}` as Address;
          break;
        }
      }

      if (!tokenAddress) {
        // Fallback: read getAllTokens and take the last one
        const allTokens = (await pool.call(() =>
          pool.httpClient.readContract({
            address: CONTRACTS.tokenFactory,
            abi: TOKEN_FACTORY_ABI,
            functionName: "getAllTokens",
          })
        )) as Address[];
        tokenAddress = allTokens[allTokens.length - 1];
      }

      createdTokens.push(tokenAddress);
      log("Phase3", `✅ ${symbol} created at ${tokenAddress}`);
      await sleep(TX_DELAY_MS * 2);
    } catch (err: any) {
      log("Phase3", `❌ Failed to create ${symbol}: ${err.message?.slice(0, 100)}`);
    }
  }

  log("Phase3", `✅ Phase 3 complete. Created ${createdTokens.length} tokens.`);
  return createdTokens;
}

// ── Phase 4: Market-Make to 6 ETH ──────────────────────────────

interface PoolState {
  realETHReserve: bigint;
  realTokenReserve: bigint;
  soldTokens: bigint;
  isGraduated: boolean;
  isActive: boolean;
  creator: Address;
  createdAt: bigint;
  metadataURI: string;
}

async function phase4MarketMake(tokens: Address[], wallets: SimpleWallet[]) {
  log("Phase4", "═══ Market-making tokens to 6 ETH perp threshold ═══");

  const pool = getRpcPool();
  const targetETH = parseEther(PERP_THRESHOLD_ETH.toFixed(4));
  const buySize = parseEther(MARKET_MAKE_BUY_SIZE.toFixed(6));

  // Use first N wallets for market making
  const mmWallets = wallets.slice(0, Math.min(MARKET_MAKE_WALLETS, wallets.length));

  for (const token of tokens) {
    log("Phase4", `\n── Market-making ${token.slice(0, 10)}... to ${PERP_THRESHOLD_ETH} ETH ──`);

    let poolState: PoolState;
    let roundCount = 0;
    const maxRounds = 200; // Safety limit

    while (roundCount < maxRounds) {
      // Check pool state
      try {
        poolState = (await pool.call(() =>
          pool.httpClient.readContract({
            address: CONTRACTS.tokenFactory,
            abi: TOKEN_FACTORY_ABI,
            functionName: "getPoolState",
            args: [token],
          })
        )) as unknown as PoolState;
      } catch (err: any) {
        log("Phase4", `Failed to read pool state: ${err.message?.slice(0, 60)}`);
        break;
      }

      const currentETH = poolState.realETHReserve;
      log("Phase4", `Pool: ${formatEther(currentETH)} / ${PERP_THRESHOLD_ETH} ETH (${(Number(formatEther(currentETH)) / PERP_THRESHOLD_ETH * 100).toFixed(1)}%)`);

      if (currentETH >= targetETH) {
        log("Phase4", `🎉 Token ${token.slice(0, 10)}... reached ${PERP_THRESHOLD_ETH} ETH — perp trading enabled!`);
        break;
      }

      if (poolState.isGraduated) {
        log("Phase4", `Token ${token.slice(0, 10)}... graduated (30 ETH). Skipping.`);
        break;
      }

      // Pick a random wallet for this buy
      const wallet = mmWallets[roundCount % mmWallets.length];
      const account = privateKeyToAccount(wallet.privateKey);
      const walletClient = pool.createWallet(wallet.privateKey);

      // Check wallet has enough ETH
      const walletBalance = await pool.call(() =>
        pool.httpClient.getBalance({ address: wallet.address })
      );

      if (walletBalance < buySize + parseEther("0.0005")) {
        // Try deployer as fallback
        if (DEPLOYER_KEY) {
          const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
          const deployerClient = pool.createWallet(DEPLOYER_KEY);

          try {
            const hash = await pool.call(() =>
              deployerClient.writeContract({
                chain: bscTestnet,
                address: CONTRACTS.tokenFactory,
                abi: TOKEN_FACTORY_ABI,
                functionName: "buy",
                args: [token, 0n],
                value: buySize,
                account: deployerAccount,
              })
            );
            await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash }));
            log("Phase4", `Deployer bought ${formatEther(buySize)} ETH of ${token.slice(0, 10)}...`);
            roundCount++;
            await sleep(TX_DELAY_MS * 3);
            continue;
          } catch (err: any) {
            log("Phase4", `Deployer buy failed: ${err.message?.slice(0, 60)}`);
          }
        }

        log("Phase4", `Wallet ${wallet.address.slice(0, 8)}... underfunded. Trying next...`);
        roundCount++;
        continue;
      }

      try {
        const hash = await pool.call(() =>
          walletClient.writeContract({
            chain: bscTestnet,
            address: CONTRACTS.tokenFactory,
            abi: TOKEN_FACTORY_ABI,
            functionName: "buy",
            args: [token, 0n],
            value: buySize,
            account,
          })
        );

        await pool.call(() => pool.httpClient.waitForTransactionReceipt({ hash }));
        roundCount++;
        log("Phase4", `W${roundCount} bought ${formatEther(buySize)} ETH of ${token.slice(0, 10)}...`);

        // Vary delay to simulate natural trading
        const delay = TX_DELAY_MS * 2 + Math.random() * TX_DELAY_MS * 3;
        await sleep(delay);
      } catch (err: any) {
        log("Phase4", `Buy failed: ${err.message?.slice(0, 80)}`);
        roundCount++;
        await sleep(TX_DELAY_MS * 5);
      }
    }

    if (roundCount >= maxRounds) {
      log("Phase4", `⚠️ Reached max rounds (${maxRounds}) for ${token.slice(0, 10)}...`);
    }
  }

  log("Phase4", "✅ Phase 4 complete. All tokens market-made.");
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const { skipSell, skipDistribute, tokenCount } = parseArgs();

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Stress Test Bootstrap                          ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Config: tokens=${tokenCount}, skipSell=${skipSell}, skipDistribute=${skipDistribute}`);
  console.log(`Deployer: ${DEPLOYER_KEY ? privateKeyToAccount(DEPLOYER_KEY).address : "NOT SET"}`);
  console.log(`TokenFactory: ${CONTRACTS.tokenFactory}`);
  console.log(`Settlement:   ${CONTRACTS.settlement}`);
  console.log();

  if (!DEPLOYER_KEY) {
    console.error("❌ ERROR: Set DEPLOYER_KEY or MEMEPERP_BLOCKCHAIN_PRIVATE_KEY");
    process.exit(1);
  }

  // Load all wallets
  const allWallets = loadAllWallets();
  console.log(`Loaded ${allWallets.length} wallets\n`);

  const SPOT_COUNT = 200;
  const PERP_COUNT = 100;

  // Phase 1: Sell existing tokens
  if (!skipSell) {
    await phase1SellAll(allWallets);
  } else {
    log("Phase1", "Skipped (--skip-sell)");
  }

  // Phase 2: Distribute ETH
  if (!skipDistribute) {
    await phase2Distribute(allWallets, SPOT_COUNT, PERP_COUNT);
  } else {
    log("Phase2", "Skipped (--skip-distribute)");
  }

  // Phase 3: Create tokens
  const createdTokens = await phase3CreateTokens(tokenCount);

  if (createdTokens.length === 0) {
    console.error("❌ No tokens created. Cannot proceed with market making.");
    process.exit(1);
  }

  // Phase 4: Market-make to threshold
  await phase4MarketMake(createdTokens, allWallets);

  // Done — the shell script will launch the orchestrator next
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   ✅ Bootstrap Complete — Ready for Orchestrator  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Created tokens: ${createdTokens.join(", ")}`);
  console.log("The orchestrator will now be launched by the shell script.\n");

  process.exit(0);
}

main().catch(err => {
  console.error("❌ Bootstrap fatal error:", err);
  process.exit(1);
});
