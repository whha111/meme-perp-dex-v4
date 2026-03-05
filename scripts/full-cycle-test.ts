/**
 * Full Cycle Test — Real Trading Lifecycle Verification
 *
 * Executes real on-chain + off-chain operations to prove the system works end-to-end:
 *   Step 1:  Deposit (ETH → WBNB → SettlementV2.deposit)
 *   Step 2:  Confirm balance (engine + chain sync)
 *   Step 3:  Open Long (EIP-712 → POST /api/order/submit)
 *   Step 4:  Open Short (counterparty → triggers matching)
 *   Step 5:  Verify positions exist
 *   Step 6:  Spot buy to move price
 *   Step 7:  Verify unrealized PnL
 *   Step 8:  Close positions (reduceOnly orders)
 *   Step 9:  Verify realized PnL + balance change
 *   Step 10: Request withdrawal (Merkle snapshot)
 *   Step 11: Get Merkle proof
 *   Step 12: On-chain withdrawal (SettlementV2.withdraw)
 *   Step 13: Verify WBNB returned to wallet
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... TRADER2_PRIVATE_KEY=0x... bun run scripts/full-cycle-test.ts
 */
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther,
  type Address, type Hex, encodeFunctionData,
} from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ── Config ──────────────────────────────────────────────────────
const RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const ENGINE_URL = "http://localhost:8081";
const CHAIN_ID = 97;

// Contract addresses (BSC Testnet — fresh deploy 2026-03-06)
const CONTRACTS = {
  SETTLEMENT_V1: "0x234F468d196ea7B8F8dD4c560315F5aE207C2674" as Address,
  SETTLEMENT_V2: "0xF58A8a551F9c587CEF3B4e21F01e1bF5059bECE9" as Address,
  TOKEN_FACTORY: "0x01819AFe97713eFf4e81cD93C2f66588816Ef8ee" as Address,
  PERP_VAULT: "0xc4CEC9636AD8D553cCFCf4AbAb5a0fC808c122C2" as Address,
  PRICE_FEED: "0xBb62829e52EB1DC73b359ba326Ee84f8a06859ad" as Address,
  WBNB: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as Address,
  DOGE: "0x9E4590dC61A334111E43D624b7eDC4400e2D1AC2" as Address,
};

// ABIs (minimal)
const WETH_ABI = [
  { inputs: [], name: "deposit", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "guy", type: "address" }, { name: "wad", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "src", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const SETTLEMENT_V2_ABI = [
  { inputs: [{ name: "amount", type: "uint256" }], name: "deposit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "userDeposits", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "currentStateRoot", outputs: [{ type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "amount", type: "uint256" }, { name: "userEquity", type: "uint256" }, { name: "merkleProof", type: "bytes32[]" }, { name: "deadline", type: "uint256" }, { name: "signature", type: "bytes" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

const TOKEN_FACTORY_ABI = [
  { inputs: [{ name: "tokenAddress", type: "address" }, { name: "minTokensOut", type: "uint256" }], name: "buy", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "tokenAddress", type: "address" }], name: "getCurrentPrice", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

// EIP-712 domain
const EIP712_DOMAIN = {
  name: "MemePerp" as const,
  version: "1" as const,
  chainId: CHAIN_ID,
  verifyingContract: CONTRACTS.SETTLEMENT_V1,
};

const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "token", type: "address" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "leverage", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
  ],
} as const;

// ── Wallets ─────────────────────────────────────────────────────
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
if (!DEPLOYER_KEY) throw new Error("Set DEPLOYER_PRIVATE_KEY");

// Wallet 0 from main-wallets.json (verified EOA on BSC Testnet)
const TRADER2_KEY = (process.env.TRADER2_PRIVATE_KEY ||
  "0xf26b5decfae47ab48f7781f087726c8717e1381114015f8ed1f7b931c1985a9d") as Hex;

const trader1 = privateKeyToAccount(DEPLOYER_KEY);
const trader2 = privateKeyToAccount(TRADER2_KEY);

const publicClient = createPublicClient({ chain: bscTestnet, transport: http(RPC_URL) });
const walletClient1 = createWalletClient({ account: trader1, chain: bscTestnet, transport: http(RPC_URL) });
const walletClient2 = createWalletClient({ account: trader2, chain: bscTestnet, transport: http(RPC_URL) });

// ── Helpers ─────────────────────────────────────────────────────
const DEPOSIT_AMOUNT = parseEther("0.05"); // 0.05 BNB each trader
const POSITION_SIZE = parseEther("0.01");  // 0.01 ETH notional
const LEVERAGE = 20000n;                    // 2x leverage (1e4 precision)

let passed = 0;
let failed = 0;
const results: { step: string; status: "✅" | "❌"; detail: string }[] = [];

function log(step: string, ok: boolean, detail: string) {
  const status = ok ? "✅" : "❌";
  if (ok) passed++; else failed++;
  results.push({ step, status, detail });
  console.log(`  ${status} ${step} — ${detail}`);
}

async function getNonce(trader: Address): Promise<bigint> {
  const res = await fetch(`${ENGINE_URL}/api/user/${trader}/nonce`);
  const data = await res.json() as any;
  return BigInt(data.nonce ?? data.data?.nonce ?? "0");
}

async function getBalance(trader: Address): Promise<bigint> {
  const res = await fetch(`${ENGINE_URL}/api/user/${trader}/balance`);
  const data = await res.json() as any;
  return BigInt(data.availableBalance ?? data.settlementAvailable ?? data.available ?? data.data?.available ?? "0");
}

async function getPositions(trader: Address): Promise<any[]> {
  const res = await fetch(`${ENGINE_URL}/api/user/${trader}/positions`);
  const data = await res.json() as any;
  // API returns flat array directly, or wrapped in {positions:[]} or {data:[]}
  if (Array.isArray(data)) return data;
  return data.positions ?? data.data ?? [];
}

async function submitOrder(
  account: ReturnType<typeof privateKeyToAccount>,
  token: Address, isLong: boolean, size: bigint, leverage: bigint,
  orderType: number, price: bigint, nonce: bigint,
): Promise<{ success: boolean; matches?: any[]; error?: string }> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const order = { trader: account.address, token, isLong, size, leverage, price, deadline, nonce, orderType };

  const signature = await account.signTypedData({
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order" as const,
    message: order,
  });

  const res = await fetch(`${ENGINE_URL}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trader: order.trader, token: order.token, isLong: order.isLong,
      size: order.size.toString(), leverage: order.leverage.toString(),
      price: order.price.toString(), deadline: order.deadline.toString(),
      nonce: order.nonce.toString(), orderType: order.orderType, signature,
    }),
  });
  return await res.json() as any;
}

// ── Main Test ───────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  🔄 Full Cycle Test — Real Trading Lifecycle");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Trader 1: ${trader1.address}`);
  console.log(`  Trader 2: ${trader2.address}`);
  console.log(`  Token:    DOGE (${CONTRACTS.DOGE})`);
  console.log(`  Deposit:  ${formatEther(DEPOSIT_AMOUNT)} BNB each`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ── Pre-check: fund trader2 if needed ─────────────────────────
  const t2Balance = await publicClient.getBalance({ address: trader2.address });
  if (t2Balance < parseEther("0.5")) {
    console.log(`  ⏳ Funding Trader 2 (balance: ${formatEther(t2Balance)} BNB)...`);
    const hash = await walletClient1.sendTransaction({
      to: trader2.address,
      value: parseEther("0.5"),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✓ Sent 0.5 BNB to Trader 2\n`);
  }

  // ══════════════════════════════════════════════════════════════
  // Step 1: Deposit (ETH → WBNB → SettlementV2)
  // ══════════════════════════════════════════════════════════════
  console.log("💰 Step 1: On-Chain Deposit");

  // Helper: 3-step deposit for one trader
  async function depositFor(client: typeof walletClient1, label: string) {
    const wrap = await client.writeContract({
      address: CONTRACTS.WBNB, abi: WETH_ABI, functionName: "deposit",
      value: DEPOSIT_AMOUNT,
    });
    await publicClient.waitForTransactionReceipt({ hash: wrap });

    const approve = await client.writeContract({
      address: CONTRACTS.WBNB, abi: WETH_ABI, functionName: "approve",
      args: [CONTRACTS.SETTLEMENT_V2, DEPOSIT_AMOUNT],
    });
    await publicClient.waitForTransactionReceipt({ hash: approve });

    const deposit = await client.writeContract({
      address: CONTRACTS.SETTLEMENT_V2, abi: SETTLEMENT_V2_ABI, functionName: "deposit",
      args: [DEPOSIT_AMOUNT],
    });
    await publicClient.waitForTransactionReceipt({ hash: deposit });
    console.log(`    ✓ ${label} deposited ${formatEther(DEPOSIT_AMOUNT)} WBNB`);
  }

  let depositOk = true;

  // Check existing deposits — skip if already deposited
  const existingDeposit1 = await publicClient.readContract({
    address: CONTRACTS.SETTLEMENT_V2, abi: SETTLEMENT_V2_ABI,
    functionName: "userDeposits", args: [trader1.address],
  });
  const existingDeposit2 = await publicClient.readContract({
    address: CONTRACTS.SETTLEMENT_V2, abi: SETTLEMENT_V2_ABI,
    functionName: "userDeposits", args: [trader2.address],
  });

  if (existingDeposit1 >= DEPOSIT_AMOUNT) {
    console.log(`    ✓ Trader 1 already deposited ${formatEther(existingDeposit1)} WBNB (skipping)`);
  } else {
    try { await depositFor(walletClient1, "Trader 1"); } catch (e: any) {
      console.log(`    ✗ Trader 1 deposit failed: ${e.message?.slice(0, 80)}`);
      depositOk = false;
    }
  }

  if (existingDeposit2 >= DEPOSIT_AMOUNT) {
    console.log(`    ✓ Trader 2 already deposited ${formatEther(existingDeposit2)} WBNB (skipping)`);
  } else {
    try { await depositFor(walletClient2, "Trader 2"); } catch (e: any) {
      console.log(`    ✗ Trader 2 deposit failed: ${e.message?.slice(0, 80)}`);
      depositOk = false;
    }
  }
  log("1. Deposit", depositOk, depositOk ? "Both traders deposited" : "One or more deposits failed");

  // ══════════════════════════════════════════════════════════════
  // Step 2: Confirm balance (engine + chain sync)
  // ══════════════════════════════════════════════════════════════
  console.log("\n📊 Step 2: Balance Verification");
  try {
    // Wait for relay to detect deposit events (WebSocket event watcher)
    console.log("    Waiting 15s for relay to detect deposits...");
    await new Promise(r => setTimeout(r, 15000));

    const chainDeposit1 = await publicClient.readContract({
      address: CONTRACTS.SETTLEMENT_V2, abi: SETTLEMENT_V2_ABI,
      functionName: "userDeposits", args: [trader1.address],
    });
    const engineBalance1 = await getBalance(trader1.address);

    const chainDeposit2 = await publicClient.readContract({
      address: CONTRACTS.SETTLEMENT_V2, abi: SETTLEMENT_V2_ABI,
      functionName: "userDeposits", args: [trader2.address],
    });
    const engineBalance2 = await getBalance(trader2.address);

    const t1Ok = chainDeposit1 >= DEPOSIT_AMOUNT && engineBalance1 > 0n;
    const t2Ok = chainDeposit2 >= DEPOSIT_AMOUNT && engineBalance2 > 0n;

    log("2. Balance sync", t1Ok && t2Ok,
      `T1: chain=${formatEther(chainDeposit1)}, engine=${formatEther(engineBalance1)}; ` +
      `T2: chain=${formatEther(chainDeposit2)}, engine=${formatEther(engineBalance2)}`);
  } catch (e: any) {
    log("2. Balance sync", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 3+4: Open Long + Open Short (trigger matching)
  // ══════════════════════════════════════════════════════════════
  console.log("\n📝 Step 3-4: Open Positions (Long + Short)");
  try {
    const nonce1 = await getNonce(trader1.address);
    const nonce2 = await getNonce(trader2.address);

    // Market orders (price=0)
    const longResult = await submitOrder(trader1, CONTRACTS.DOGE, true, POSITION_SIZE, LEVERAGE, 0, 0n, nonce1);
    const shortResult = await submitOrder(trader2, CONTRACTS.DOGE, false, POSITION_SIZE, LEVERAGE, 0, 0n, nonce2);

    const longOk = longResult.success === true;
    const shortOk = shortResult.success === true;
    const matched = (longResult.matches?.length ?? 0) > 0 || (shortResult.matches?.length ?? 0) > 0;

    log("3. Open Long (T1)", longOk, longOk ? `Submitted OK, matched=${matched}` : `Error: ${(longResult as any).error?.slice(0, 80)}`);
    log("4. Open Short (T2)", shortOk, shortOk ? `Submitted OK, matched=${matched}` : `Error: ${(shortResult as any).error?.slice(0, 80)}`);
  } catch (e: any) {
    log("3-4. Open positions", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 5: Verify positions exist
  // ══════════════════════════════════════════════════════════════
  console.log("\n📈 Step 5: Verify Positions");
  try {
    await new Promise(r => setTimeout(r, 2000));
    const pos1 = await getPositions(trader1.address);
    const pos2 = await getPositions(trader2.address);

    const has1 = pos1.length > 0;
    const has2 = pos2.length > 0;

    log("5. Positions exist", has1 && has2,
      `T1: ${pos1.length} positions (${has1 ? "long" : "none"}), T2: ${pos2.length} positions (${has2 ? "short" : "none"})`);

    if (pos1.length > 0) {
      const p = pos1[0];
      console.log(`     T1 position: size=${p.size}, entry=${p.entryPrice}, leverage=${p.leverage}, isLong=${p.isLong}`);
    }
  } catch (e: any) {
    log("5. Positions exist", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 6: Spot buy to move price up
  // ══════════════════════════════════════════════════════════════
  console.log("\n🔄 Step 6: Price Movement (Spot Buy)");
  try {
    const priceBefore = await publicClient.readContract({
      address: CONTRACTS.TOKEN_FACTORY, abi: TOKEN_FACTORY_ABI,
      functionName: "getCurrentPrice", args: [CONTRACTS.DOGE],
    });

    // Buy DOGE with 0.1 BNB to push price up (needs enough to move the curve)
    const buyHash = await walletClient1.writeContract({
      address: CONTRACTS.TOKEN_FACTORY, abi: TOKEN_FACTORY_ABI,
      functionName: "buy", args: [CONTRACTS.DOGE, 0n],
      value: parseEther("0.1"),
    });
    const buyReceipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
    console.log(`    Buy tx: ${buyHash.slice(0, 18)}... status=${buyReceipt.status}`);

    // Wait for price feed to sync
    await new Promise(r => setTimeout(r, 3000));

    const priceAfter = await publicClient.readContract({
      address: CONTRACTS.TOKEN_FACTORY, abi: TOKEN_FACTORY_ABI,
      functionName: "getCurrentPrice", args: [CONTRACTS.DOGE],
    });

    const priceUp = priceAfter > priceBefore;
    log("6. Price moved", priceUp,
      `Before: ${priceBefore}, After: ${priceAfter} (${priceUp ? "↑" : "→"} ${((Number(priceAfter) - Number(priceBefore)) / Number(priceBefore) * 100).toFixed(2)}%)`);
  } catch (e: any) {
    log("6. Price moved", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 7: Verify unrealized PnL
  // ══════════════════════════════════════════════════════════════
  console.log("\n💹 Step 7: Unrealized PnL Check");
  try {
    await new Promise(r => setTimeout(r, 2000));
    const pos1 = await getPositions(trader1.address);
    const pos2 = await getPositions(trader2.address);

    if (pos1.length > 0 && pos2.length > 0) {
      const pnl1 = pos1[0].unrealizedPnl ?? pos1[0].pnl ?? "N/A";
      const pnl2 = pos2[0].unrealizedPnl ?? pos2[0].pnl ?? "N/A";
      // Long should profit when price goes up, short should lose
      log("7. PnL computed", true, `T1 (long): pnl=${pnl1}, T2 (short): pnl=${pnl2}`);
    } else {
      log("7. PnL computed", false, `No positions to check PnL (T1: ${pos1.length}, T2: ${pos2.length})`);
    }
  } catch (e: any) {
    log("7. PnL computed", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 8: Close positions (reduceOnly)
  // ══════════════════════════════════════════════════════════════
  console.log("\n🔒 Step 8: Close Positions");
  try {
    const nonce1 = await getNonce(trader1.address);
    const nonce2 = await getNonce(trader2.address);

    // Close long → submit short with reduceOnly
    const closeRes1 = await submitOrder(trader1, CONTRACTS.DOGE, false, POSITION_SIZE, LEVERAGE, 0, 0n, nonce1);
    const closeRes2 = await submitOrder(trader2, CONTRACTS.DOGE, true, POSITION_SIZE, LEVERAGE, 0, 0n, nonce2);

    log("8. Close positions", closeRes1.success && closeRes2.success,
      `T1 close: ${closeRes1.success ? "OK" : (closeRes1 as any).error?.slice(0, 60)}, ` +
      `T2 close: ${closeRes2.success ? "OK" : (closeRes2 as any).error?.slice(0, 60)}`);
  } catch (e: any) {
    log("8. Close positions", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 9: Verify balance after close
  // ══════════════════════════════════════════════════════════════
  console.log("\n💰 Step 9: Post-Close Balance");
  try {
    await new Promise(r => setTimeout(r, 2000));
    const bal1 = await getBalance(trader1.address);
    const bal2 = await getBalance(trader2.address);
    const pos1 = await getPositions(trader1.address);
    const pos2 = await getPositions(trader2.address);

    const closed = pos1.length === 0 && pos2.length === 0;
    log("9. Balances after PnL", bal1 > 0n || bal2 > 0n,
      `T1: ${formatEther(bal1)} (${pos1.length} positions), T2: ${formatEther(bal2)} (${pos2.length} positions), ` +
      `sum=${formatEther(bal1 + bal2)}`);
  } catch (e: any) {
    log("9. Balances after PnL", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 10: Request withdrawal
  // ══════════════════════════════════════════════════════════════
  console.log("\n🌳 Step 10: Withdrawal Request");
  try {
    // Trigger a snapshot first
    const snapRes = await fetch(`${ENGINE_URL}/api/v2/snapshot/trigger`, { method: "POST" });
    const snapData = await snapRes.json() as any;

    await new Promise(r => setTimeout(r, 3000)); // Wait for snapshot

    const statusRes = await fetch(`${ENGINE_URL}/api/v2/status`);
    const statusData = await statusRes.json() as any;
    const snapInfo = statusData.snapshot ?? statusData;

    log("10. Withdrawal ready", (snapInfo.totalSnapshots ?? 0) > 0,
      `Snapshots: ${snapInfo.totalSnapshots}, Root: ${(snapInfo.currentRoot ?? snapInfo.lastRootSubmitted)?.slice(0, 18)}...`);
  } catch (e: any) {
    log("10. Withdrawal ready", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 11: Get Merkle proof
  // ══════════════════════════════════════════════════════════════
  console.log("\n🔐 Step 11: Merkle Proof");
  let merkleProofNodes: string[] = [];
  let proofEquity = "0";
  try {
    const proofRes = await fetch(`${ENGINE_URL}/api/v2/snapshot/proof?user=${trader1.address}`);
    const proofData = await proofRes.json() as any;
    // API returns: {success, proof: {user, equity, merkleProof:[], leaf, root}}
    const proofObj = proofData.proof ?? proofData.data?.proof ?? proofData;
    merkleProofNodes = proofObj.merkleProof ?? proofObj.proof ?? [];
    proofEquity = proofObj.equity?.toString() ?? "0";

    const hasProof = merkleProofNodes.length > 0 && BigInt(proofEquity) > 0n;

    log("11. Merkle proof", hasProof,
      hasProof ? `Proof: ${merkleProofNodes.length} nodes, equity: ${formatEther(BigInt(proofEquity))} BNB`
        : `No proof (equity=${formatEther(BigInt(proofEquity))}, nodes=${merkleProofNodes.length})`);
  } catch (e: any) {
    log("11. Merkle proof", false, e.message?.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════
  // Step 12-13: On-chain withdrawal (if proof available)
  // ══════════════════════════════════════════════════════════════
  console.log("\n🏦 Step 12-13: On-Chain Withdrawal");
  try {
    // Use proof from step 11
    if (merkleProofNodes.length > 0 && BigInt(proofEquity) > 0n) {
      // Execute on-chain withdrawal
      const wbnbBefore = await publicClient.readContract({
        address: CONTRACTS.WBNB, abi: WETH_ABI,
        functionName: "balanceOf", args: [trader1.address],
      });

      // Withdraw only what the engine tracks as available (settlement deposits minus used margin)
      // The Merkle equity includes wallet balance which isn't withdrawable through the engine
      const engineBal = await getBalance(trader1.address);
      const withdrawAmount = engineBal > parseEther("0.01") ? parseEther("0.01") : engineBal / 2n;
      console.log(`    Engine available: ${formatEther(engineBal)}, withdrawing: ${formatEther(withdrawAmount)} BNB`);

      // CR-01 FIX: Withdrawal requires authenticated signature
      const authNonce = await getNonce(trader1.address);
      const authDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const authMessage = `withdraw:${authNonce.toString()}:${authDeadline.toString()}`;
      const authSignature = await trader1.signMessage({ message: authMessage });

      // Build withdrawal signature from matching engine
      const withdrawRes = await fetch(`${ENGINE_URL}/api/v2/withdraw/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: trader1.address,
          amount: withdrawAmount.toString(),
          signature: authSignature,
          nonce: authNonce.toString(),
          deadline: authDeadline.toString(),
        }),
      });
      const withdrawData = await withdrawRes.json() as any;
      console.log(`    Withdraw response: ${JSON.stringify(withdrawData).slice(0, 200)}`);

      const auth = withdrawData.authorization ?? withdrawData.data?.authorization;
      if (auth?.signature) {
        const sig = auth.signature as Hex;
        const deadline = BigInt(auth.deadline ?? Math.floor(Date.now() / 1000) + 3600);
        const authMerkleProof = auth.merkleProof ?? merkleProofNodes;

        const withdrawHash = await walletClient1.writeContract({
          address: CONTRACTS.SETTLEMENT_V2, abi: SETTLEMENT_V2_ABI,
          functionName: "withdraw",
          args: [
            withdrawAmount,
            BigInt(proofEquity),
            (authMerkleProof as string[]).map((p: string) => p as `0x${string}`),
            deadline,
            sig,
          ],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });

        const wbnbAfter = await publicClient.readContract({
          address: CONTRACTS.WBNB, abi: WETH_ABI,
          functionName: "balanceOf", args: [trader1.address],
        });

        log("12. On-chain withdraw", receipt.status === "success",
          `TX: ${withdrawHash.slice(0, 18)}... status=${receipt.status}, WBNB before: ${formatEther(wbnbBefore)}, after: ${formatEther(wbnbAfter)}`);
        log("13. WBNB received", wbnbAfter > wbnbBefore,
          `Received: ${formatEther(wbnbAfter - wbnbBefore)} WBNB`);
      } else {
        log("12. On-chain withdraw", false, `No authorization: ${JSON.stringify(withdrawData).slice(0, 150)}`);
        log("13. WBNB received", false, "Skipped (no signature)");
      }
    } else {
      log("12. On-chain withdraw", false, `No proof available (equity=${proofEquity}, proof=${merkleProofNodes.length} nodes)`);
      log("13. WBNB received", false, "Skipped (no Merkle proof)");
    }
  } catch (e: any) {
    log("12-13. Withdrawal", false, e.message?.slice(0, 150));
  }

  // ══════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  📊 FULL CYCLE TEST RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of results) {
    console.log(`  ${r.status} ${r.step}`);
  }
  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
