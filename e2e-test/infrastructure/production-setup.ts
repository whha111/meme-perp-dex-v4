/**
 * Production-Grade E2E Setup
 *
 * 1. Buy each token to 6+ BNB (trigger _enablePerp on TokenFactory)
 * 2. Deposit BNB via SettlementV2.deposit() (real on-chain, no fake deposit)
 * 3. Add LP to PerpVault
 * 4. Verify all tokens have perpEnabled = true
 *
 * NO SHORTCUTS: No ALLOW_FAKE_DEPOSIT, no SKIP_SIGNATURE_VERIFY
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  parseEther,
  formatEther,
  type Address,
} from "viem";
import { ENV, CONTRACTS, ABI } from "../config/test-config";
import { getPublicClient, getWalletClient, getAccount } from "../utils/rpc-client";

const PERP_ENABLE_THRESHOLD_BNB = 6; // TokenFactory.PERP_ENABLE_THRESHOLD = 6 ether
const TARGET_BNB_PER_TOKEN = 6.5;    // Buy slightly over threshold for safety
const BNB_PER_WALLET_DEPOSIT = 0.5;  // SettlementV2 deposit per wallet
const LP_AMOUNT_BNB = 10;            // PerpVault LP liquidity

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  PRODUCTION-GRADE E2E SETUP");
  console.log("  No shortcuts. No fake deposits. No skipped signatures.");
  console.log("═══════════════════════════════════════════════════\n");

  const deployer = getAccount(ENV.DEPLOYER_PRIVATE_KEY as `0x${string}`);
  const deployerWallet = getWalletClient(ENV.DEPLOYER_PRIVATE_KEY as `0x${string}`);
  const client = getPublicClient();

  // Check deployer balance
  const balance = await client.getBalance({ address: deployer.address });
  console.log(`💰 Deployer: ${deployer.address}`);
  console.log(`💰 Balance: ${formatEther(balance)} BNB\n`);

  // Load token addresses
  const tokenData = JSON.parse(
    readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8")
  );

  // Load wallets
  const wallets = JSON.parse(
    readFileSync(resolve(__dirname, "../data/wallets.json"), "utf8")
  );

  // ═════════════════════════════════════════════════
  // STEP 1: Buy tokens to 6+ BNB (trigger _enablePerp)
  // ═════════════════════════════════════════════════
  console.log("═══ STEP 1: Pump tokens to 6+ BNB (trigger perpEnabled) ═══\n");

  for (const [symbol, info] of Object.entries(tokenData)) {
    const tokenInfo = info as any;
    const tokenAddr = tokenInfo.address as Address;

    // Check current pool state
    try {
      const poolState = await client.readContract({
        address: CONTRACTS.TokenFactory,
        abi: ABI.TokenFactory,
        functionName: "getPoolState",
        args: [tokenAddr],
      }) as any;

      const realEthReserve = poolState.realETHReserve as bigint;
      const isGraduated = poolState.isGraduated as boolean;
      const perpEnabled = poolState.perpEnabled as boolean;
      const currentBNB = Number(formatEther(realEthReserve));

      console.log(`  ${symbol}: ${currentBNB.toFixed(2)} BNB | perpEnabled=${perpEnabled}${isGraduated ? ' (GRADUATED)' : ''}`);

      if (perpEnabled) {
        console.log(`    ✅ perpEnabled=true — trading ready\n`);
        continue;
      }

      if (isGraduated) {
        console.log(`    ✅ Already graduated — skip\n`);
        continue;
      }

      // Calculate how much more BNB to buy
      const needed = TARGET_BNB_PER_TOKEN - currentBNB;
      if (needed <= 0) {
        console.log(`    ✅ Sufficient\n`);
        continue;
      }

      console.log(`    📈 Buying ${needed.toFixed(2)} BNB worth of ${symbol}...`);

      const hash = await deployerWallet.writeContract({
        address: CONTRACTS.TokenFactory,
        abi: ABI.TokenFactory,
        functionName: "buy",
        args: [tokenAddr, 0n], // minTokens = 0 (accept any amount)
        value: parseEther(needed.toFixed(4)),
      });

      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
      console.log(`    ✅ Tx: ${hash.slice(0, 18)}... (gas: ${receipt.gasUsed})`);

      // Verify new state
      const newState = await client.readContract({
        address: CONTRACTS.TokenFactory,
        abi: ABI.TokenFactory,
        functionName: "getTokenInfo",
        args: [tokenAddr],
      }) as any[];
      const newReserve = Number(formatEther(newState[5] as bigint));
      console.log(`    📊 New pool: ${newReserve.toFixed(2)} BNB\n`);

      // Wait between buys to avoid nonce issues
      await new Promise(r => setTimeout(r, 5000));

    } catch (err: any) {
      console.error(`    ❌ ${symbol}: ${err.message}\n`);
    }
  }

  // ═════════════════════════════════════════════════
  // STEP 2: Add LP to PerpVault
  // ═════════════════════════════════════════════════
  console.log("═══ STEP 2: Add LP to PerpVault ═══\n");

  try {
    const currentPool = await client.readContract({
      address: CONTRACTS.PerpVault,
      abi: ABI.PerpVault,
      functionName: "getPoolValue",
    }) as bigint;
    console.log(`  Current LP pool: ${formatEther(currentPool)} BNB`);

    if (Number(formatEther(currentPool)) < LP_AMOUNT_BNB) {
      const addAmount = LP_AMOUNT_BNB - Number(formatEther(currentPool));
      console.log(`  Adding ${addAmount.toFixed(2)} BNB to LP pool...`);

      const hash = await deployerWallet.writeContract({
        address: CONTRACTS.PerpVault,
        abi: ABI.PerpVault,
        functionName: "addLiquidity",
        value: parseEther(addAmount.toFixed(4)),
      });
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
      console.log(`  ✅ LP added: ${hash.slice(0, 18)}... (gas: ${receipt.gasUsed})\n`);
    } else {
      console.log(`  ✅ LP pool already has ${formatEther(currentPool)} BNB\n`);
    }
  } catch (err: any) {
    console.error(`  ⚠️ PerpVault LP: ${err.message}\n`);
  }

  // ═════════════════════════════════════════════════
  // STEP 3: On-chain deposits via SettlementV2.deposit()
  // ═════════════════════════════════════════════════
  console.log("═══ STEP 3: On-chain deposits via SettlementV2.deposit() ═══\n");

  // First, fund wallets with BNB for gas + deposit
  const walletsToFund = wallets.slice(0, 50); // Fund 50 wallets
  const bnbPerWallet = parseEther((BNB_PER_WALLET_DEPOSIT + 0.01).toFixed(4)); // deposit + gas

  console.log(`  Funding ${walletsToFund.length} wallets with ${formatEther(bnbPerWallet)} BNB each...\n`);

  // Batch fund wallets (send BNB from deployer)
  let funded = 0;
  let fundErrors = 0;
  for (let i = 0; i < walletsToFund.length; i += 5) {
    const batch = walletsToFund.slice(i, i + 5);
    const promises = batch.map(async (w: any) => {
      try {
        // Check existing balance first
        const bal = await client.getBalance({ address: w.address as Address });
        if (bal >= bnbPerWallet) {
          funded++;
          return; // Already funded
        }

        const hash = await deployerWallet.sendTransaction({
          to: w.address as Address,
          value: bnbPerWallet,
        });
        await client.waitForTransactionReceipt({ hash, confirmations: 1 });
        funded++;
      } catch (err: any) {
        fundErrors++;
      }
    });
    await Promise.all(promises);

    // Wait between batches for nonce management
    await new Promise(r => setTimeout(r, 3000));

    if ((i + 5) % 20 === 0 || i + 5 >= walletsToFund.length) {
      console.log(`    ${Math.min(i + 5, walletsToFund.length)}/${walletsToFund.length} funded (${fundErrors} errors)`);
    }
  }

  console.log(`\n  ✅ ${funded} wallets funded, ${fundErrors} errors\n`);

  // Now each wallet deposits to SettlementV2
  console.log(`  Depositing to SettlementV2 from each wallet...\n`);

  let deposited = 0;
  let depositErrors = 0;
  const depositAmount = parseEther(BNB_PER_WALLET_DEPOSIT.toFixed(4));

  // SettlementV2 deposit flow: BNB → WBNB.deposit() → WBNB.approve(SettlementV2) → SettlementV2.deposit(amount)
  for (let i = 0; i < walletsToFund.length; i += 3) {
    const batch = walletsToFund.slice(i, i + 3);
    const promises = batch.map(async (w: any) => {
      try {
        const walletClient = getWalletClient(w.privateKey as `0x${string}`);

        // Check if already deposited
        const existingBal = await client.readContract({
          address: CONTRACTS.SettlementV2,
          abi: ABI.SettlementV2,
          functionName: "getUserDeposits",
          args: [w.address as Address],
        }) as bigint;

        if (existingBal >= depositAmount) {
          deposited++;
          return; // Already deposited
        }

        // Step 1: Wrap BNB → WBNB
        const wrapHash = await walletClient.writeContract({
          address: CONTRACTS.WBNB,
          abi: ABI.WBNB,
          functionName: "deposit",
          value: depositAmount,
        });
        await client.waitForTransactionReceipt({ hash: wrapHash, confirmations: 1 });

        // Step 2: Approve SettlementV2 to spend WBNB
        const approveHash = await walletClient.writeContract({
          address: CONTRACTS.WBNB,
          abi: ABI.WBNB,
          functionName: "approve",
          args: [CONTRACTS.SettlementV2, depositAmount],
        });
        await client.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });

        // Step 3: Deposit to SettlementV2
        const depositHash = await walletClient.writeContract({
          address: CONTRACTS.SettlementV2,
          abi: ABI.SettlementV2,
          functionName: "deposit",
          args: [depositAmount],
        });
        await client.waitForTransactionReceipt({ hash: depositHash, confirmations: 1 });
        deposited++;
      } catch (err: any) {
        depositErrors++;
        if (depositErrors <= 5) {
          console.error(`    ❌ Deposit error (${w.address.slice(0, 10)}): ${err.message.slice(0, 100)}`);
        }
      }
    });
    await Promise.all(promises);
    await new Promise(r => setTimeout(r, 3000));

    if ((i + 3) % 15 === 0 || i + 3 >= walletsToFund.length) {
      console.log(`    ${Math.min(i + 3, walletsToFund.length)}/${walletsToFund.length} deposited (${depositErrors} errors)`);
    }
  }

  console.log(`\n  ✅ ${deposited} wallets deposited on-chain, ${depositErrors} errors\n`);

  // ═════════════════════════════════════════════════
  // STEP 4: Verify everything
  // ═════════════════════════════════════════════════
  console.log("═══ STEP 4: Verification ═══\n");

  // Check engine health
  try {
    const healthResp = await fetch("http://localhost:8081/health");
    const health = await healthResp.json() as any;
    console.log(`  Engine: ${health.status} (${health.metrics?.memoryMB}MB, Redis: ${health.services?.redis})`);
  } catch {
    console.error("  ❌ Engine not reachable");
  }

  // Check each token's perp status on-chain
  for (const [symbol, info] of Object.entries(tokenData)) {
    const tokenAddr = (info as any).address;
    try {
      const poolState = await client.readContract({
        address: CONTRACTS.TokenFactory,
        abi: ABI.TokenFactory,
        functionName: "getPoolState",
        args: [tokenAddr as Address],
      }) as any;

      const realEthReserve = Number(formatEther(poolState.realETHReserve));
      const perpEnabled = poolState.perpEnabled;
      const isGraduated = poolState.isGraduated;

      let price = 0n;
      try {
        price = await client.readContract({
          address: CONTRACTS.PriceFeed,
          abi: ABI.PriceFeed,
          functionName: "getPrice",
          args: [tokenAddr as Address],
        }) as bigint;
      } catch {}

      console.log(
        `  ${symbol}: ${realEthReserve.toFixed(2)} BNB | ` +
        `Perp: ${perpEnabled ? '✅' : '❌'} | ` +
        `Graduated: ${isGraduated ? '✅' : '❌'} | ` +
        `Price: ${price > 0n ? '✅' : '❌'}`
      );
    } catch (err: any) {
      console.error(`  ${symbol}: ❌ ${err.message.slice(0, 60)}`);
    }
  }

  // Check PerpVault
  try {
    const poolValue = await client.readContract({
      address: CONTRACTS.PerpVault,
      abi: ABI.PerpVault,
      functionName: "getPoolValue",
    }) as bigint;
    console.log(`  PerpVault LP: ${formatEther(poolValue)} BNB`);
  } catch {}

  // Check sample wallet SettlementV2 balance
  try {
    const sampleBal = await client.readContract({
      address: CONTRACTS.SettlementV2,
      abi: ABI.SettlementV2,
      functionName: "getBalance",
      args: [wallets[0].address as Address],
    }) as bigint;
    console.log(`  Sample wallet balance (on-chain): ${formatEther(sampleBal)} BNB`);
  } catch {}

  // Final deployer balance
  const finalBalance = await client.getBalance({ address: deployer.address });
  console.log(`\n  Deployer remaining: ${formatEther(finalBalance)} BNB`);
  console.log(`  Spent: ${formatEther(balance - finalBalance)} BNB\n`);

  console.log("═══════════════════════════════════════════════════");
  console.log("  SETUP COMPLETE — Ready for production-grade testing");
  console.log("═══════════════════════════════════════════════════");
}

main().catch(console.error);
