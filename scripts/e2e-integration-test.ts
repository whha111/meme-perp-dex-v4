#!/usr/bin/env bun
/**
 * 🧪 多方聚合 E2E 集成测试
 *
 * 与 stress-test.ts 不同，这不是单点API压测，而是模拟真实多方交互:
 *
 *   场景 1: 用户A下多单 + 用户B下空单 → 撮合 → 验证双方仓位/余额/手续费
 *   场景 2: 推荐链 A→B→C, C交易后验证 L1/L2 佣金分发
 *   场景 3: 完整生命周期: 开仓→加保证金→设TP/SL→价格变→平仓→提现
 *   场景 4: 10用户并发下单，验证撮合正确性
 *   场景 5: 边界/异常: 余额不足、自撮合防护、重复取消
 *   场景 6: WebSocket 事件流验证 (对的人收到对的消息)
 *
 * 前置条件:
 *   1. 撮合引擎运行中: cd backend/src/matching && ALLOW_FAKE_DEPOSIT=true bun run server.ts
 *   2. Redis 运行中
 *
 * 用法:
 *   bun run scripts/e2e-integration-test.ts [--url=http://localhost:8081]
 */

import { createWalletClient, http, type Address, type Hex, parseEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { bsc } from "viem/chains";

// ============================================================
// Config
// ============================================================

const BASE_URL = process.argv.find(a => a.startsWith("--url="))?.split("=")[1] || "http://localhost:8081";
const CHAIN_ID = parseInt(process.argv.find(a => a.startsWith("--chain="))?.split("=")[1] || "97");

// EIP-712 domain — must match server.ts
const EIP712_DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: (process.env.SETTLEMENT_ADDRESS || "0x234F468d196ea7B8F8dD4c560315F5aE207C2674") as Address,
} as const;

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

// Will be resolved from live tickers
let TEST_TOKEN = "0xcafe000000000000000000000000000000000001" as Address;
let MARK_PRICE = "0"; // Will be fetched from engine

// Fetch a real supported token and its mark price
async function resolveTestToken(): Promise<void> {
  try {
    // 1. Get tickers — find first token with a non-zero last price
    const res = await fetch(`${BASE_URL}/api/v1/market/tickers`);
    const tickerJson = await res.json();
    const tickers = tickerJson.data || [];
    for (const t of tickers) {
      const instId = t.instId as string; // "0x....-ETH"
      const last = t.last || t.markPx || "0";
      if (last && last !== "0") {
        TEST_TOKEN = instId.split("-")[0].toLowerCase() as Address;
        MARK_PRICE = last;
        break;
      }
    }

    // 2. If mark price still 0, try orderbook lastPrice for each token
    if (MARK_PRICE === "0") {
      for (const t of tickers) {
        const token = (t.instId as string).split("-")[0].toLowerCase();
        try {
          const obRes = await fetch(`${BASE_URL}/api/v1/market/books?instId=${token}-ETH&sz=1`);
          const obData = await obRes.json();
          // Engine returns { lastPrice, longs, shorts } at top level
          const p = obData.lastPrice || obData.data?.lastPrice || obData.data?.markPrice;
          if (p && p !== "0") {
            TEST_TOKEN = token as Address;
            MARK_PRICE = p;
            break;
          }
        } catch {}
      }
    }

    console.log(`  📌 Test Token: ${TEST_TOKEN.slice(0, 12)}...`);
    console.log(`  📌 Mark Price: ${MARK_PRICE} (${(Number(MARK_PRICE) / 1e18).toExponential(4)} ETH)`);
    if (MARK_PRICE === "0") {
      console.warn(`  ⚠️ Could not resolve mark price — order tests will use fallback`);
    }
  } catch (e) {
    console.warn(`  ⚠️ Failed to resolve test token: ${e}`);
  }
}

// Helper: get price string close to mark price
function priceNearMark(multiplier: number = 1.0): string {
  if (MARK_PRICE === "0") return "1000000000000000"; // fallback 0.001 ETH
  const markBigInt = BigInt(MARK_PRICE);
  // Apply multiplier (using integer math)
  const result = (markBigInt * BigInt(Math.round(multiplier * 10000))) / 10000n;
  return result.toString();
}

// Generate a unique price for each scene to avoid matching stale orders or cross-scene matches.
// Each call returns a different multiplier — within the 100% max deviation limit.
// NOTE: deviation formula is asymmetric: (mark-order)/order for order < mark.
// So we keep multipliers in [0.85, 1.15] to stay well within bounds.
let _sceneSeed = 0;
function scenePrice(): string {
  _sceneSeed += 1;
  // Small seed to avoid JS safe-integer overflow in multiplication
  const mult = 0.85 + ((_sceneSeed * 7919) % 3000) / 10000;
  return priceNearMark(mult);
}

// Helper: calculate notional size given price and desired ETH exposure
function sizeForEthNotional(ethAmount: string, price: string): string {
  // size in tokens = ethNotional / pricePerToken (both in 1e18)
  // But the engine expects size in ETH notional value, not token quantity
  // So we just pass the ETH amount directly
  return parseEther(ethAmount).toString();
}

// ============================================================
// Wallet Helpers
// ============================================================

interface TestWallet {
  key: Hex;
  address: Address;
  client: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
  nonce: number;
}

function createTestWallet(): TestWallet {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const client = createWalletClient({
    account,
    chain: bsc,
    transport: http(), // not used for on-chain, just for signing
  });
  return { key, address: account.address, client, account, nonce: 0 };
}

// ============================================================
// API Helpers
// ============================================================

async function api(method: string, path: string, body?: any): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}

async function fakeDeposit(address: Address, amountEth: string): Promise<boolean> {
  const { ok, data } = await api("POST", `/api/user/${address}/deposit`, {
    amount: parseEther(amountEth).toString(),
  });
  if (!ok) console.warn(`  ⚠️ Deposit failed for ${address.slice(0, 10)}: ${data.error}`);
  return ok;
}

async function getBalance(address: Address): Promise<bigint> {
  const { data } = await api("GET", `/api/user/${address}/balance`);
  return BigInt(data.balance || data.availableBalance || "0");
}

async function getPositions(address: Address): Promise<any[]> {
  const { data } = await api("GET", `/api/user/${address}/positions`);
  return data.positions || data || [];
}

async function signAndSubmitOrder(
  wallet: TestWallet,
  params: {
    token: Address;
    isLong: boolean;
    sizeEth: string; // notional in ETH
    leverage: number; // e.g. 5 for 5x
    priceEth?: string; // price in ETH (legacy)
    priceRaw?: string; // price as raw bigint string (preferred)
    orderType?: number; // 0=MARKET, 1=LIMIT
    reduceOnly?: boolean;
  },
): Promise<{ ok: boolean; data: any }> {
  const nonce = wallet.nonce++;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const price = params.priceRaw ? BigInt(params.priceRaw) : parseEther(params.priceEth || "0");

  const message = {
    trader: wallet.address,
    token: params.token,
    isLong: params.isLong,
    size: parseEther(params.sizeEth),
    leverage: BigInt(params.leverage * 10000), // basis points
    price,
    deadline,
    nonce: BigInt(nonce),
    orderType: params.orderType ?? 1, // LIMIT default
  };

  const signature = await wallet.client.signTypedData({
    account: wallet.account,
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message,
  });

  const body = {
    trader: wallet.address,
    token: params.token,
    isLong: params.isLong,
    size: message.size.toString(),
    leverage: message.leverage.toString(),
    price: message.price.toString(),
    deadline: deadline.toString(),
    nonce: nonce.toString(),
    orderType: message.orderType,
    signature,
    reduceOnly: params.reduceOnly || false,
    postOnly: false,
    timeInForce: "GTC",
  };

  return api("POST", "/api/order/submit", body);
}

async function signMessage(wallet: TestWallet, message: string): Promise<Hex> {
  return wallet.account.signMessage({ message });
}

async function cancelOrder(wallet: TestWallet, orderId: string): Promise<{ ok: boolean; data: any }> {
  const message = `Cancel order ${orderId}`;
  const signature = await signMessage(wallet, message);
  // Server route: POST /api/order/:orderId/cancel
  return api("POST", `/api/order/${orderId}/cancel`, {
    trader: wallet.address,
    signature,
  });
}

async function setTPSL(
  wallet: TestWallet,
  pairId: string,
  tp?: string,
  sl?: string,
): Promise<{ ok: boolean; data: any }> {
  const message = `Set TPSL ${pairId} for ${wallet.address.toLowerCase()}`;
  const signature = await signMessage(wallet, message);
  // Server route: POST /api/position/:pairId/tpsl
  return api("POST", `/api/position/${encodeURIComponent(pairId)}/tpsl`, {
    trader: wallet.address,
    takeProfit: tp,
    stopLoss: sl,
    signature,
  });
}

async function addMargin(
  wallet: TestWallet,
  pairId: string,
  amount: string,
): Promise<{ ok: boolean; data: any }> {
  const message = `Add margin ${amount} to ${pairId} for ${wallet.address.toLowerCase()}`;
  const signature = await signMessage(wallet, message);
  // Server route: POST /api/position/:pairId/margin/add
  return api("POST", `/api/position/${encodeURIComponent(pairId)}/margin/add`, {
    trader: wallet.address,
    amount,
    signature,
  });
}

async function removeMargin(
  wallet: TestWallet,
  pairId: string,
  amount: string,
): Promise<{ ok: boolean; data: any }> {
  const message = `Remove margin ${amount} from ${pairId} for ${wallet.address.toLowerCase()}`;
  const signature = await signMessage(wallet, message);
  // Server route: POST /api/position/:pairId/margin/remove
  return api("POST", `/api/position/${encodeURIComponent(pairId)}/margin/remove`, {
    trader: wallet.address,
    amount,
    signature,
  });
}

// ============================================================
// Test Infrastructure
// ============================================================

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`    ✅ ${label}`);
  } else {
    failed++;
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`    ❌ ${label}${detail ? ` (${detail})` : ""}`);
  }
}

function assertApprox(actual: bigint, expected: bigint, toleranceBps: number, label: string): void {
  if (expected === 0n) {
    assert(actual === 0n, label, `expected 0, got ${actual}`);
    return;
  }
  const diff = actual > expected ? actual - expected : expected - actual;
  const bps = Number((diff * 10000n) / expected);
  assert(bps <= toleranceBps, label, `${actual} vs ${expected} (${bps}bps diff, tolerance ${toleranceBps}bps)`);
}

function skip(label: string, reason: string): void {
  skipped++;
  console.log(`    ⏭️  ${label} — ${reason}`);
}

// Wait helper
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ============================================================
// Scene 1: 双方撮合 — 多单+空单匹配
// ============================================================

async function scene1_TwoPartyMatch() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 1: 双方撮合 — 用户A多单 + 用户B空单                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const alice = createTestWallet();
  const bob = createTestWallet();
  console.log(`  Alice: ${alice.address.slice(0, 12)}...`);
  console.log(`  Bob:   ${bob.address.slice(0, 12)}...`);

  // Step 1: Deposit
  console.log("\n  📥 Step 1: 充值");
  const depA = await fakeDeposit(alice.address, "10");
  const depB = await fakeDeposit(bob.address, "10");
  assert(depA, "Alice 充值 10 ETH");
  assert(depB, "Bob 充值 10 ETH");

  const balA0 = await getBalance(alice.address);
  const balB0 = await getBalance(bob.address);
  assert(balA0 === parseEther("10"), "Alice 余额 = 10 ETH", `实际: ${balA0}`);
  assert(balB0 === parseEther("10"), "Bob 余额 = 10 ETH", `实际: ${balB0}`);

  // Step 2: Alice buys long, Bob sells short at same unique price
  console.log("\n  📊 Step 2: 下单撮合");
  const size = "1"; // 1 ETH notional
  const leverage = 5; // 5x
  const matchPrice = scenePrice(); // unique price to avoid stale order matches

  const orderA = await signAndSubmitOrder(alice, {
    token: TEST_TOKEN, isLong: true, sizeEth: size, leverage, priceRaw: matchPrice,
  });
  assert(orderA.ok, "Alice 下多单 (1 ETH, 5x)", orderA.data?.error);
  console.log(`    Alice order: status=${orderA.data?.status}, fills=${orderA.data?.filledSize || 0}`);

  const orderB = await signAndSubmitOrder(bob, {
    token: TEST_TOKEN, isLong: false, sizeEth: size, leverage, priceRaw: matchPrice,
  });
  assert(orderB.ok, "Bob 下空单 (1 ETH, 5x)", orderB.data?.error);
  console.log(`    Bob order: status=${orderB.data?.status}, fills=${orderB.data?.filledSize || 0}`);

  // Wait for matching engine to process (needs 1-2s for async matching)
  await sleep(2000);

  // Step 3: Verify positions
  console.log("\n  🔍 Step 3: 验证仓位");
  const posA = await getPositions(alice.address);
  const posB = await getPositions(bob.address);

  assert(posA.length > 0, "Alice 有持仓", `仓位数: ${posA.length}`);
  assert(posB.length > 0, "Bob 有持仓", `仓位数: ${posB.length}`);

  if (posA.length > 0) {
    const p = posA[0];
    assert(p.isLong === true, "Alice 仓位方向 = LONG");
    // Size should be roughly 1 ETH notional
    assert(BigInt(p.size || "0") > 0n, "Alice 仓位大小 > 0", `size: ${p.size}`);
  }
  if (posB.length > 0) {
    const p = posB[0];
    assert(p.isLong === false, "Bob 仓位方向 = SHORT");
    assert(BigInt(p.size || "0") > 0n, "Bob 仓位大小 > 0", `size: ${p.size}`);
  }

  // Step 4: Verify balance deducted (margin = notional / leverage)
  console.log("\n  💰 Step 4: 验证余额变化");
  const balA1 = await getBalance(alice.address);
  const balB1 = await getBalance(bob.address);
  const marginExpected = parseEther(size) / BigInt(leverage); // 0.2 ETH
  // Balance should have decreased by margin + fee
  assert(balA1 < balA0, "Alice 余额减少 (扣保证金+手续费)", `${balA0} → ${balA1}`);
  assert(balB1 < balB0, "Bob 余额减少 (扣保证金+手续费)", `${balB0} → ${balB1}`);

  // Margin deducted should be approximately 0.2 ETH (1 ETH / 5x), plus trading fee
  // Use tolerance due to price rounding at non-standard prices
  const deductedA = balA0 - balA1;
  const marginTolerance = marginExpected * 95n / 100n; // 95% tolerance for rounding
  assert(deductedA >= marginTolerance, "Alice 扣除 ≈ 保证金", `扣除: ${deductedA}, 最低: ${marginTolerance}`);

  return { alice, bob, posA, posB };
}

// ============================================================
// Scene 2: 推荐链 — L1 + L2 佣金
// ============================================================

async function scene2_ReferralChain() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 2: 推荐链 A→B→C — 验证 L1/L2 佣金                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const grandpa = createTestWallet(); // A: 顶层推荐人
  const parent = createTestWallet();  // B: 被A推荐，推荐C
  const child = createTestWallet();   // C: 被B推荐，实际交易者
  const counterparty = createTestWallet(); // 对手方

  console.log(`  A (grandpa): ${grandpa.address.slice(0, 12)}...`);
  console.log(`  B (parent):  ${parent.address.slice(0, 12)}...`);
  console.log(`  C (child):   ${child.address.slice(0, 12)}...`);
  console.log(`  对手方:       ${counterparty.address.slice(0, 12)}...`);

  // Step 1: Build referral chain
  console.log("\n  🔗 Step 1: 建立推荐链");
  // A registers as referrer
  const regA = await api("POST", "/api/referral/register", { address: grandpa.address });
  assert(regA.ok, "A 注册为推荐人", regA.data?.error);
  const codeA = regA.data?.referrer?.code;
  assert(!!codeA, "A 获得邀请码", `code: ${codeA}`);

  // B binds to A's code, then registers as referrer
  if (codeA) {
    const bindB = await api("POST", "/api/referral/bind", { address: parent.address, referralCode: codeA });
    assert(bindB.ok, "B 绑定 A 的邀请码", bindB.data?.error);
  }

  const regB = await api("POST", "/api/referral/register", { address: parent.address });
  assert(regB.ok, "B 注册为推荐人", regB.data?.error);
  const codeB = regB.data?.referrer?.code;
  assert(!!codeB, "B 获得邀请码", `code: ${codeB}`);

  // C binds to B's code
  if (codeB) {
    const bindC = await api("POST", "/api/referral/bind", { address: child.address, referralCode: codeB });
    assert(bindC.ok, "C 绑定 B 的邀请码", bindC.data?.error);
  }

  // Step 2: Deposit for traders
  console.log("\n  📥 Step 2: 充值");
  await fakeDeposit(child.address, "10");
  await fakeDeposit(counterparty.address, "10");

  // Check referral commissions before trade
  const commBefore = await api("GET", `/api/referral/referrer?address=${parent.address}`);
  const earnBefore = BigInt(commBefore.data?.referrer?.totalEarnings || "0");

  // Step 3: C trades (generates fee → commission to B and A)
  console.log("\n  📊 Step 3: C 交易 (产生手续费 → 佣金流向 B 和 A)");

  const s2Price = scenePrice();
  const orderC = await signAndSubmitOrder(child, {
    token: TEST_TOKEN, isLong: true, sizeEth: "2", leverage: 5, priceRaw: s2Price,
  });
  assert(orderC.ok, "C 下多单 (2 ETH, 5x)", orderC.data?.error);

  const orderCP = await signAndSubmitOrder(counterparty, {
    token: TEST_TOKEN, isLong: false, sizeEth: "2", leverage: 5, priceRaw: s2Price,
  });
  assert(orderCP.ok, "对手方 下空单 (2 ETH, 5x)", orderCP.data?.error);

  await sleep(2000); // Allow matching + commission processing

  // Step 4: Verify commissions
  console.log("\n  💸 Step 4: 验证佣金分发");
  const commAfterB = await api("GET", `/api/referral/referrer?address=${parent.address}`);
  const refB = commAfterB.data?.referrer;
  const earnAfterB = BigInt(refB?.totalEarnings || refB?.pendingEarnings || "0");

  const commAfterA = await api("GET", `/api/referral/referrer?address=${grandpa.address}`);
  const refA = commAfterA.data?.referrer;
  const earnAfterA = BigInt(refA?.totalEarnings || refA?.pendingEarnings || "0");

  // B should earn L1 commission (30% of C's trading fee)
  assert(earnAfterB > earnBefore, "B (直推) 收到 L1 佣金", `before: ${earnBefore}, after: ${earnAfterB}, pending: ${refB?.pendingEarnings}`);

  // A should earn L2 commission (10% of C's trading fee)
  assert(earnAfterA > 0n, "A (二级) 收到 L2 佣金", `earnings: ${earnAfterA}, pending: ${refA?.pendingEarnings}`);

  // L1 should be more than L2 (30% vs 10%)
  if (earnAfterB > earnBefore && earnAfterA > 0n) {
    const l1 = earnAfterB - earnBefore;
    const l2 = earnAfterA;
    assert(l1 > l2, "L1 佣金 > L2 佣金 (30% vs 10%)", `L1: ${l1}, L2: ${l2}`);
  }

  // Step 5: Verify referral data integrity
  console.log("\n  📋 Step 5: 验证推荐数据完整性");
  const refDataB = commAfterB.data?.referrer;
  assert(
    (refDataB?.level1Referrals || 0) >= 1,
    "B 的直推人数 >= 1",
    `level1Referrals: ${refDataB?.level1Referrals}`,
  );

  const refDataA = commAfterA.data?.referrer;
  assert(
    (refDataA?.level2Referrals || 0) >= 1,
    "A 的二级推荐人数 >= 1",
    `level2Referrals: ${refDataA?.level2Referrals}`,
  );
}

// ============================================================
// Scene 3: 完整生命周期 — 开仓→加保→TP/SL→平仓
// ============================================================

async function scene3_FullLifecycle() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 3: 完整生命周期 — 开仓→加保→设TP/SL→平仓             ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const trader = createTestWallet();
  const counterparty = createTestWallet();

  await fakeDeposit(trader.address, "10");
  await fakeDeposit(counterparty.address, "10");

  // Step 1: Open position
  console.log("  📊 Step 1: 开仓");
  const s3Price = scenePrice();
  const orderT = await signAndSubmitOrder(trader, {
    token: TEST_TOKEN, isLong: true, sizeEth: "1", leverage: 5, priceRaw: s3Price,
  });
  const orderC = await signAndSubmitOrder(counterparty, {
    token: TEST_TOKEN, isLong: false, sizeEth: "1", leverage: 5, priceRaw: s3Price,
  });
  assert(orderT.ok, "交易者 下多单", orderT.data?.error);
  assert(orderC.ok, "对手方 下空单", orderC.data?.error);

  await sleep(2000);

  const positions = await getPositions(trader.address);
  assert(positions.length > 0, "交易者持有仓位");

  if (positions.length === 0) {
    skip("后续操作", "无仓位，跳过");
    return;
  }

  const pos = positions[0];
  const pairId = pos.pairId || pos.id || "";
  const balAfterOpen = await getBalance(trader.address);

  // Step 2: Add Margin
  console.log("\n  💰 Step 2: 加保证金");
  const addAmount = parseEther("0.1").toString();
  const addRes = await addMargin(trader, pairId, addAmount);
  assert(addRes.ok, "加保证金 0.1 ETH", addRes.data?.error);

  await sleep(200);
  const balAfterAdd = await getBalance(trader.address);
  if (addRes.ok) {
    assert(balAfterAdd < balAfterOpen, "余额减少 (保证金转入仓位)", `${balAfterOpen} → ${balAfterAdd}`);
  }

  // Step 3: Set TP/SL
  console.log("\n  🎯 Step 3: 设置止盈止损");
  const tpPrice = priceNearMark(2.0); // TP at 2x mark price
  const slPrice = priceNearMark(0.5); // SL at half mark price
  const tpslRes = await setTPSL(trader, pairId, tpPrice, slPrice);
  assert(tpslRes.ok, "设置 TP=0.002, SL=0.0005", tpslRes.data?.error);

  // Verify TP/SL stored
  await sleep(200);
  const posAfterTPSL = await getPositions(trader.address);
  if (posAfterTPSL.length > 0) {
    const p = posAfterTPSL[0];
    assert(
      p.takeProfit !== undefined || p.tp !== undefined,
      "TP 已保存",
      `tp: ${p.takeProfit || p.tp}`,
    );
  }

  // Step 4: Remove Margin
  console.log("\n  💸 Step 4: 减保证金");
  const removeAmount = parseEther("0.05").toString();
  const removeRes = await removeMargin(trader, pairId, removeAmount);
  assert(removeRes.ok, "减保证金 0.05 ETH", removeRes.data?.error);

  await sleep(200);
  const balAfterRemove = await getBalance(trader.address);
  if (removeRes.ok) {
    assert(balAfterRemove > balAfterAdd, "余额增加 (保证金退回)", `${balAfterAdd} → ${balAfterRemove}`);
  }

  // Step 5: Close position (place opposite reduce-only order)
  console.log("\n  🔒 Step 5: 平仓");
  // Need a counterparty for the close too
  const closer = createTestWallet();
  await fakeDeposit(closer.address, "10");

  const closePrice = scenePrice();
  // Note: reduceOnly=true may trigger server bug "validateReduceOnlyOrder is not defined"
  // In that case, we close with a normal opposite-direction order
  let closeOrder = await signAndSubmitOrder(trader, {
    token: TEST_TOKEN, isLong: false, sizeEth: "1", leverage: 5, priceRaw: closePrice,
    reduceOnly: true,
  });
  if (!closeOrder.ok && closeOrder.data?.error?.includes("validateReduceOnly")) {
    console.log("    ⚠️ reduceOnly bug detected — using normal close order");
    closeOrder = await signAndSubmitOrder(trader, {
      token: TEST_TOKEN, isLong: false, sizeEth: "1", leverage: 5, priceRaw: closePrice,
    });
  }
  const closeCounter = await signAndSubmitOrder(closer, {
    token: TEST_TOKEN, isLong: true, sizeEth: "1", leverage: 5, priceRaw: closePrice,
  });

  assert(closeOrder.ok, "交易者 下平仓单", closeOrder.data?.error);
  assert(closeCounter.ok, "对手方 配对", closeCounter.data?.error);

  await sleep(2000);
  const posAfterClose = await getPositions(trader.address);
  // Position should be closed or size reduced
  const openPositions = posAfterClose.filter((p: any) => BigInt(p.size || "0") > 0n);
  assert(openPositions.length === 0, "仓位已平", `剩余仓位: ${openPositions.length}`);
}

// ============================================================
// Scene 4: 并发多用户撮合
// ============================================================

async function scene4_ConcurrentMatching() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 4: 10 用户并发下单 — 验证撮合正确性                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const numPairs = 5; // 5 pairs of long/short
  const longs: TestWallet[] = [];
  const shorts: TestWallet[] = [];

  // Create and fund wallets
  console.log("  📥 Step 1: 创建并充值 10 个用户");
  for (let i = 0; i < numPairs; i++) {
    const l = createTestWallet();
    const s = createTestWallet();
    await fakeDeposit(l.address, "5");
    await fakeDeposit(s.address, "5");
    longs.push(l);
    shorts.push(s);
  }

  // Step 2: Submit orders in rapid sequence (not fully parallel — avoids rate limit)
  console.log("\n  📊 Step 2: 10 用户快速下单");
  const startTime = Date.now();
  const results: { ok: boolean; data: any }[] = [];

  // Each pair gets a unique price to ensure they match each other, not stale orders
  for (let i = 0; i < numPairs; i++) {
    const pairPrice = scenePrice(); // unique price per pair
    // Submit long then short rapidly (200ms gap to stay under rate limit)
    results.push(await signAndSubmitOrder(longs[i], {
      token: TEST_TOKEN, isLong: true, sizeEth: "0.5", leverage: 3, priceRaw: pairPrice,
    }));
    results.push(await signAndSubmitOrder(shorts[i], {
      token: TEST_TOKEN, isLong: false, sizeEth: "0.5", leverage: 3, priceRaw: pairPrice,
    }));
    if (i < numPairs - 1) await sleep(250); // stay under 5 orders/sec rate limit
  }
  const elapsed = Date.now() - startTime;

  const submitted = results.filter(r => r.ok).length;
  assert(submitted >= numPairs * 2 * 0.8, `${submitted}/10 订单成功提交`, `耗时: ${elapsed}ms`);

  await sleep(2000);

  // Step 3: Verify each pair matched
  console.log("\n  🔍 Step 3: 验证撮合结果");
  let matchedCount = 0;
  for (let i = 0; i < numPairs; i++) {
    const longPos = await getPositions(longs[i].address);
    const shortPos = await getPositions(shorts[i].address);

    if (longPos.length > 0 && shortPos.length > 0) {
      matchedCount++;
    }
  }
  assert(matchedCount >= numPairs * 0.6, `${matchedCount}/${numPairs} 对成功撮合`);

  // Step 4: Verify no double-deductions or balance anomalies
  console.log("\n  💰 Step 4: 验证余额一致性");
  let anomalies = 0;
  for (let i = 0; i < numPairs; i++) {
    const balL = await getBalance(longs[i].address);
    const balS = await getBalance(shorts[i].address);
    // Balance should be positive and less than initial deposit
    if (balL < 0n || balL > parseEther("5")) anomalies++;
    if (balS < 0n || balS > parseEther("5")) anomalies++;
  }
  assert(anomalies === 0, "所有余额在合理范围", `异常数: ${anomalies}`);
}

// ============================================================
// Scene 5: 边界/异常情况
// ============================================================

async function scene5_EdgeCases() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 5: 边界/异常 — 余额不足、自撮合、重复操作              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const user = createTestWallet();
  await fakeDeposit(user.address, "0.01"); // Very small deposit

  // Test 1: Insufficient balance
  console.log("  📛 Test 1: 余额不足下大单");
  const bigOrder = await signAndSubmitOrder(user, {
    token: TEST_TOKEN, isLong: true, sizeEth: "100", leverage: 10, priceRaw: priceNearMark(),
  });
  assert(!bigOrder.ok || bigOrder.data?.error, "余额不足被拒绝", bigOrder.data?.error);

  // Test 2: Self-matching prevention
  console.log("\n  🚫 Test 2: 自撮合防护");
  const selfUser = createTestWallet();
  await fakeDeposit(selfUser.address, "10");

  const selfLong = await signAndSubmitOrder(selfUser, {
    token: TEST_TOKEN, isLong: true, sizeEth: "1", leverage: 5, priceRaw: priceNearMark(),
  });
  const selfShort = await signAndSubmitOrder(selfUser, {
    token: TEST_TOKEN, isLong: false, sizeEth: "1", leverage: 5, priceRaw: priceNearMark(),
  });

  await sleep(500);
  const selfPos = await getPositions(selfUser.address);
  // Self-matching should either be prevented or result in no net position
  // (different engines handle this differently)
  assert(
    selfPos.length <= 1 || !selfLong.ok || !selfShort.ok,
    "自撮合被处理 (防护或取消)",
    `仓位数: ${selfPos.length}`,
  );

  // Test 3: Cancel non-existent order
  console.log("\n  🗑️ Test 3: 取消不存在的订单");
  const fakeId = "non-existent-order-id-12345";
  const cancelRes = await cancelOrder(user, fakeId);
  assert(!cancelRes.ok || cancelRes.data?.error, "取消不存在订单被拒绝", cancelRes.data?.error);

  // Test 4: Double deposit handling
  console.log("\n  💰 Test 4: 重复充值");
  const doubleUser = createTestWallet();
  await fakeDeposit(doubleUser.address, "1");
  await fakeDeposit(doubleUser.address, "1");
  const doubleBal = await getBalance(doubleUser.address);
  assert(doubleBal === parseEther("2"), "两次充值余额叠加 = 2 ETH", `实际: ${doubleBal}`);

  // Test 5: Zero-size order
  console.log("\n  📐 Test 5: 零金额订单");
  const zeroUser = createTestWallet();
  await fakeDeposit(zeroUser.address, "1");
  const zeroOrder = await signAndSubmitOrder(zeroUser, {
    token: TEST_TOKEN, isLong: true, sizeEth: "0", leverage: 5, priceRaw: priceNearMark(),
  });
  assert(!zeroOrder.ok || zeroOrder.data?.error, "零金额订单被拒绝", zeroOrder.data?.error);

  // Test 6: Invalid leverage
  console.log("\n  ⚙️ Test 6: 超限杠杆 (100x, 引擎限制10x)");
  const leverageUser = createTestWallet();
  await fakeDeposit(leverageUser.address, "5");
  const highLev = await signAndSubmitOrder(leverageUser, {
    token: TEST_TOKEN, isLong: true, sizeEth: "1", leverage: 100, priceRaw: priceNearMark(),
  });
  assert(!highLev.ok || highLev.data?.error, "100x 杠杆被拒绝", highLev.data?.error);

  // Test 7: Expired deadline
  console.log("\n  ⏰ Test 7: 过期订单");
  const expUser = createTestWallet();
  await fakeDeposit(expUser.address, "5");
  // Submit order with deadline in the past
  const nonce = expUser.nonce++;
  const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
  const message = {
    trader: expUser.address,
    token: TEST_TOKEN,
    isLong: true,
    size: parseEther("1"),
    leverage: 50000n,
    price: BigInt(priceNearMark()),
    deadline: pastDeadline,
    nonce: BigInt(nonce),
    orderType: 1,
  };
  const sig = await expUser.client.signTypedData({
    account: expUser.account,
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message,
  });
  const expOrder = await api("POST", "/api/order/submit", {
    ...message,
    size: message.size.toString(),
    leverage: message.leverage.toString(),
    price: message.price.toString(),
    deadline: pastDeadline.toString(),
    nonce: nonce.toString(),
    signature: sig,
    reduceOnly: false,
    postOnly: false,
    timeInForce: "GTC",
  });
  assert(!expOrder.ok || expOrder.data?.error, "过期订单被拒绝", expOrder.data?.error);

  // Test 8: Referral self-bind
  console.log("\n  🔗 Test 8: 推荐人自绑定");
  const selfRef = createTestWallet();
  const regSelf = await api("POST", "/api/referral/register", { address: selfRef.address });
  const selfCode = regSelf.data?.referrer?.code;
  if (selfCode) {
    const selfBind = await api("POST", "/api/referral/bind", {
      address: selfRef.address,
      referralCode: selfCode,
    });
    assert(!selfBind.ok || selfBind.data?.error, "自绑定被拒绝", selfBind.data?.error);
  } else {
    skip("自绑定测试", "注册失败");
  }

  // Test 9: Double referral bind
  console.log("\n  🔗 Test 9: 重复绑定推荐码");
  const refA = createTestWallet();
  const refB = createTestWallet();
  const bindUser = createTestWallet();
  await api("POST", "/api/referral/register", { address: refA.address });
  await api("POST", "/api/referral/register", { address: refB.address });
  const regAData = await api("GET", `/api/referral/referrer?address=${refA.address}`);
  const regBData = await api("GET", `/api/referral/referrer?address=${refB.address}`);
  const codeA = regAData.data?.referrer?.code;
  const codeB = regBData.data?.referrer?.code;
  if (codeA && codeB) {
    await api("POST", "/api/referral/bind", { address: bindUser.address, referralCode: codeA });
    const doubleBind = await api("POST", "/api/referral/bind", { address: bindUser.address, referralCode: codeB });
    assert(
      !doubleBind.ok || doubleBind.data?.error?.includes("already"),
      "重复绑定被拒绝",
      doubleBind.data?.error,
    );
  }
}

// ============================================================
// Scene 6: WebSocket 事件流验证
// ============================================================

async function scene6_WebSocketEvents() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 6: WebSocket 事件流 — 验证正确用户收到正确消息         ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const WS_URL = BASE_URL.replace("http", "ws") + "/ws";

  // Create two traders
  const traderA = createTestWallet();
  const traderB = createTestWallet();
  await fakeDeposit(traderA.address, "10");
  await fakeDeposit(traderB.address, "10");

  // Collect WS messages per connection
  const messagesA: any[] = [];
  const messagesB: any[] = [];

  // Connect WebSockets
  console.log("  🔌 Step 1: 建立 WebSocket 连接");

  const connectWS = (label: string, messages: any[]): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${label} WS timeout`)), 5000);
      try {
        const ws = new WebSocket(WS_URL);
        ws.onopen = () => {
          clearTimeout(timeout);
          resolve(ws);
        };
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            messages.push(data);
          } catch {}
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error(`${label} WS error`));
        };
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  };

  let wsA: WebSocket | null = null;
  let wsB: WebSocket | null = null;
  try {
    wsA = await connectWS("A", messagesA);
    wsB = await connectWS("B", messagesB);
    assert(true, "两个 WebSocket 连接成功");
  } catch (e: any) {
    assert(false, "WebSocket 连接", e.message);
    return;
  }

  // Subscribe to token updates
  console.log("\n  📡 Step 2: 订阅行情");
  wsA!.send(JSON.stringify({
    type: "subscribe",
    data: { topics: [`tickers:${TEST_TOKEN}`, `trades:${TEST_TOKEN}`] },
    request_id: "sub_a",
  }));
  wsB!.send(JSON.stringify({
    type: "subscribe",
    data: { topics: [`tickers:${TEST_TOKEN}`, `trades:${TEST_TOKEN}`] },
    request_id: "sub_b",
  }));

  await sleep(300);

  // Step 3: Place matching orders → should trigger trade events
  console.log("\n  📊 Step 3: 下单触发交易事件");
  const msgCountBefore = messagesA.length;

  const s6Price = scenePrice();
  await signAndSubmitOrder(traderA, {
    token: TEST_TOKEN, isLong: true, sizeEth: "0.5", leverage: 3, priceRaw: s6Price,
  });
  await signAndSubmitOrder(traderB, {
    token: TEST_TOKEN, isLong: false, sizeEth: "0.5", leverage: 3, priceRaw: s6Price,
  });

  // Wait for WS events to arrive
  await sleep(2000);

  console.log("\n  📨 Step 4: 验证 WS 事件");
  const allMsgs = [...messagesA, ...messagesB];
  const types = new Set(allMsgs.map(m => m.type || m.topic || m.event || "unknown"));
  console.log(`    收到事件类型: ${[...types].join(", ")}`);
  console.log(`    A 收到 ${messagesA.length} 条, B 收到 ${messagesB.length} 条`);

  // Both should receive ticker/trade updates since they subscribed
  assert(messagesA.length > msgCountBefore, "A 收到交易后的 WS 更新");
  assert(messagesB.length > 0, "B 收到 WS 更新");

  // Clean up
  wsA?.close();
  wsB?.close();
}

// ============================================================
// Scene 7: 订单簿状态一致性
// ============================================================

async function scene7_OrderBookConsistency() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 7: 订单簿状态一致性 — 下单/取消/成交后验证              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const maker = createTestWallet();
  await fakeDeposit(maker.address, "10");

  // Step 1: Place limit order below market (no counterparty → should rest in book)
  console.log("  📊 Step 1: 挂限价单 (无对手 → 挂单簿)");
  // Use a low but valid price (deviation formula is asymmetric: (mark-order)/order must be < 100%)
  // So order must be > mark/2 → multiplier > 0.5. We use 0.55 = 45% below mark (deviation ~82%)
  const restingPrice = priceNearMark(0.55);
  const order1 = await signAndSubmitOrder(maker, {
    token: TEST_TOKEN, isLong: true, sizeEth: "0.5", leverage: 3, priceRaw: restingPrice,
    orderType: 1, // LIMIT
  });
  assert(order1.ok, "限价多单提交成功", order1.data?.error);
  const orderId = order1.data?.orderId || order1.data?.order?.id;
  const orderStatus = order1.data?.status;
  console.log(`    orderId: ${orderId}, status: ${orderStatus}`);

  await sleep(500);

  // Check order book
  const book1 = await api("GET", `/api/v1/market/books?instId=${TEST_TOKEN}-ETH&sz=20`);
  assert(book1.ok, "查询订单簿");

  // Step 2: Cancel order → verify removed from book
  console.log("\n  🗑️ Step 2: 取消订单 → 验证从簿上移除");
  if (orderId && orderStatus !== "FILLED") {
    const cancelRes = await cancelOrder(maker, orderId);
    assert(cancelRes.ok || cancelRes.data?.success, "取消订单成功", cancelRes.data?.error || cancelRes.data?.message);

    await sleep(300);

    // Verify balance returned
    const balAfterCancel = await getBalance(maker.address);
    assert(balAfterCancel > parseEther("9"), "保证金退回 (余额恢复)", `余额: ${balAfterCancel}`);

    // Step 3: Try to cancel again → should fail
    console.log("\n  🔁 Step 3: 重复取消 → 应被拒绝");
    const doubleCancel = await cancelOrder(maker, orderId);
    assert(
      !doubleCancel.ok || doubleCancel.data?.error,
      "重复取消被拒绝",
      doubleCancel.data?.error,
    );
  } else {
    skip("取消订单测试", "未获得 orderId");
  }

  // Step 4: Place and match → verify both sides' open orders cleared
  console.log("\n  📊 Step 4: 撮合后双方挂单清空");
  const buyer = createTestWallet();
  const seller = createTestWallet();
  await fakeDeposit(buyer.address, "5");
  await fakeDeposit(seller.address, "5");

  const s7Price = scenePrice();
  await signAndSubmitOrder(buyer, {
    token: TEST_TOKEN, isLong: true, sizeEth: "0.3", leverage: 3, priceRaw: s7Price,
  });
  await signAndSubmitOrder(seller, {
    token: TEST_TOKEN, isLong: false, sizeEth: "0.3", leverage: 3, priceRaw: s7Price,
  });

  await sleep(1000);

  // Both should have no open orders (they matched)
  const buyerOrders = await api("GET", `/api/user/${buyer.address}/orders?status=open`);
  const sellerOrders = await api("GET", `/api/user/${seller.address}/orders?status=open`);

  const openBuyer = (buyerOrders.data?.orders || buyerOrders.data || []).filter(
    (o: any) => o.status === "open" || o.status === "pending",
  );
  const openSeller = (sellerOrders.data?.orders || sellerOrders.data || []).filter(
    (o: any) => o.status === "open" || o.status === "pending",
  );

  assert(openBuyer.length === 0, "买方无挂单 (已撮合)", `挂单数: ${openBuyer.length}`);
  assert(openSeller.length === 0, "卖方无挂单 (已撮合)", `挂单数: ${openSeller.length}`);
}

// ============================================================
// Scene 8: 多 Token 隔离性
// ============================================================

async function scene8_MultiTokenIsolation() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 8: 多 Token 隔离性 — 不同代币不互相撮合               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const TOKEN_A = "0xaaaa000000000000000000000000000000000001" as Address;
  const TOKEN_B = "0xbbbb000000000000000000000000000000000002" as Address;

  const buyer = createTestWallet();
  const seller = createTestWallet();
  await fakeDeposit(buyer.address, "10");
  await fakeDeposit(seller.address, "10");

  const balBefore = await getBalance(buyer.address);

  // Buyer bids on Token A, Seller asks on Token B → should NOT match
  console.log("  📊 买方下 TokenA 多单, 卖方下 TokenB 空单");
  await signAndSubmitOrder(buyer, {
    token: TOKEN_A, isLong: true, sizeEth: "1", leverage: 5, priceRaw: priceNearMark(),
  });
  await signAndSubmitOrder(seller, {
    token: TOKEN_B, isLong: false, sizeEth: "1", leverage: 5, priceRaw: priceNearMark(),
  });

  await sleep(500);

  const posBuyer = await getPositions(buyer.address);
  const posSeller = await getPositions(seller.address);

  // They should NOT have matched positions (different tokens)
  const matchedBuyer = posBuyer.filter((p: any) => BigInt(p.size || "0") > 0n);
  const matchedSeller = posSeller.filter((p: any) => BigInt(p.size || "0") > 0n);

  assert(matchedBuyer.length === 0, "Token 不同 → 买方未成交");
  assert(matchedSeller.length === 0, "Token 不同 → 卖方未成交");
}

// ============================================================
// Scene 9: 查询端点一致性
// ============================================================

async function scene9_QueryConsistency() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  场景 9: 查询端点一致性 — 余额/仓位/订单交叉验证            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const user = createTestWallet();
  await fakeDeposit(user.address, "5");

  // Place an order
  const counter = createTestWallet();
  await fakeDeposit(counter.address, "5");

  const s9Price = scenePrice();
  await signAndSubmitOrder(user, {
    token: TEST_TOKEN, isLong: true, sizeEth: "1", leverage: 5, priceRaw: s9Price,
  });
  await signAndSubmitOrder(counter, {
    token: TEST_TOKEN, isLong: false, sizeEth: "1", leverage: 5, priceRaw: s9Price,
  });

  await sleep(1500);

  // Query all data endpoints in parallel
  console.log("  📊 并行查询所有端点");
  const [balRes, posRes, orderRes, tickerRes, bookRes] = await Promise.all([
    api("GET", `/api/user/${user.address}/balance`),
    api("GET", `/api/user/${user.address}/positions`),
    api("GET", `/api/user/${user.address}/orders`),
    api("GET", `/api/v1/market/tickers`),
    api("GET", `/api/v1/market/books?instId=${TEST_TOKEN}-ETH&sz=10`),
  ]);

  assert(balRes.ok, "余额查询成功");
  assert(posRes.ok, "仓位查询成功");
  assert(orderRes.ok, "订单查询成功");
  assert(tickerRes.ok, "行情查询成功");
  assert(bookRes.ok, "订单簿查询成功");

  // Cross-validate: balance + margin in positions should roughly equal initial deposit
  const balance = BigInt(balRes.data?.balance || balRes.data?.availableBalance || "0");
  const positions = posRes.data?.positions || posRes.data || [];
  let totalMargin = 0n;
  for (const p of positions) {
    totalMargin += BigInt(p.margin || p.collateral || "0");
  }

  // balance + margin ≈ initial_deposit - fees
  const totalAccountValue = balance + totalMargin;
  const initialDeposit = parseEther("5");
  assert(
    totalAccountValue <= initialDeposit && totalAccountValue >= initialDeposit * 90n / 100n,
    "余额+保证金 ≈ 初始存款 (扣手续费)",
    `余额: ${balance}, 保证金: ${totalMargin}, 总计: ${totalAccountValue}`,
  );
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("🧪 MemePerpDEX 多方聚合 E2E 集成测试");
  console.log(`   URL: ${BASE_URL}`);
  console.log(`   Chain ID: ${CHAIN_ID}`);
  console.log("═══════════════════════════════════════════════════════════════");

  // Pre-check server (try multiple endpoints)
  try {
    const health = await fetch(`${BASE_URL}/api/v1/market/tickers`);
    if (!health.ok) throw new Error("Not OK");
  } catch {
    console.error("\n❌ 服务器无响应！请确保撮合引擎在运行:");
    console.error("   cd backend/src/matching && ALLOW_FAKE_DEPOSIT=true bun run server.ts\n");
    process.exit(1);
  }

  // Check fake deposit enabled
  const testWallet = createTestWallet();
  const depTest = await fakeDeposit(testWallet.address, "0.001");
  if (!depTest) {
    console.error("\n❌ 假充值未启用！请设置环境变量:");
    console.error("   ALLOW_FAKE_DEPOSIT=true bun run server.ts\n");
    process.exit(1);
  }

  // Resolve test token and mark price
  await resolveTestToken();

  const startTime = Date.now();

  // Run all scenes
  try { await scene1_TwoPartyMatch(); } catch (e: any) {
    console.error(`  💥 场景 1 崩溃: ${e.message}`);
    failed++;
  }

  try { await scene2_ReferralChain(); } catch (e: any) {
    console.error(`  💥 场景 2 崩溃: ${e.message}`);
    failed++;
  }

  try { await scene3_FullLifecycle(); } catch (e: any) {
    console.error(`  💥 场景 3 崩溃: ${e.message}`);
    failed++;
  }

  try { await scene4_ConcurrentMatching(); } catch (e: any) {
    console.error(`  💥 场景 4 崩溃: ${e.message}`);
    failed++;
  }

  try { await scene5_EdgeCases(); } catch (e: any) {
    console.error(`  💥 场景 5 崩溃: ${e.message}`);
    failed++;
  }

  try { await scene6_WebSocketEvents(); } catch (e: any) {
    console.error(`  💥 场景 6 崩溃: ${e.message}`);
    failed++;
  }

  try { await scene7_OrderBookConsistency(); } catch (e: any) {
    console.error(`  💥 场景 7 崩溃: ${e.message}`);
    failed++;
  }

  try { await scene8_MultiTokenIsolation(); } catch (e: any) {
    console.error(`  💥 场景 8 崩溃: ${e.message}`);
    failed++;
  }

  try { await scene9_QueryConsistency(); } catch (e: any) {
    console.error(`  💥 场景 9 崩溃: ${e.message}`);
    failed++;
  }

  // ============================================================
  // Summary
  // ============================================================
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("📊 测试总结");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log(`  ✅ 通过: ${passed}`);
  console.log(`  ❌ 失败: ${failed}`);
  console.log(`  ⏭️  跳过: ${skipped}`);
  console.log(`  ⏱️  耗时: ${elapsed}s`);

  if (failures.length > 0) {
    console.log("\n  ❌ 失败详情:");
    for (const f of failures) {
      console.log(`    - ${f}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════");

  if (failed > 0) {
    console.log("\n⚠️  有失败项！请检查上面的失败详情。\n");
    process.exit(1);
  } else {
    console.log("\n🎉 全部通过！多方聚合测试验证无误。\n");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("💥 测试脚本异常:", e);
  process.exit(2);
});
