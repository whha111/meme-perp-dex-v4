#!/usr/bin/env bun
/**
 * 🔥 压力测试脚本 — 模拟大量并发用户操作
 *
 * 用法:
 *   bun run scripts/stress-test.ts [--url=http://localhost:8081] [--users=50] [--rounds=10]
 *
 * 测试范围:
 *   1. 并发注册推荐人 (POST /api/referral/register)
 *   2. 并发绑定邀请码 (POST /api/referral/bind)
 *   3. 并发查询余额 (GET /api/user/{addr}/balance)
 *   4. 并发查询仓位 (GET /api/user/{addr}/positions)
 *   5. 并发查询订单簿 (GET /api/v1/market/books)
 *   6. 并发查询行情 (GET /api/v1/market/tickers)
 *   7. 并发 K 线请求 (GET /api/klines)
 *   8. 并发推荐排行榜 (GET /api/referral/leaderboard)
 *   9. 并发提现查询 (GET /api/referral/commissions)
 *  10. WebSocket 连接压力 (多连接并发)
 *
 * 注意: 涉及签名的操作 (下单/取消/提现) 需要私钥，本脚本仅测试无签名端点。
 * 完整下单压测请使用 scripts/market-maker-all.ts
 */

const BASE_URL = process.argv.find(a => a.startsWith("--url="))?.split("=")[1] || "http://localhost:8081";
const NUM_USERS = parseInt(process.argv.find(a => a.startsWith("--users="))?.split("=")[1] || "50");
const ROUNDS = parseInt(process.argv.find(a => a.startsWith("--rounds="))?.split("=")[1] || "10");

// ============================================================
// Helpers
// ============================================================

function randomAddress(): string {
  const hex = Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `0x${hex}`;
}

interface TestResult {
  name: string;
  total: number;
  success: number;
  failed: number;
  avgMs: number;
  maxMs: number;
  minMs: number;
  errors: string[];
}

async function runConcurrent(
  name: string,
  count: number,
  fn: (index: number) => Promise<{ ok: boolean; error?: string }>,
): Promise<TestResult> {
  const start = Date.now();
  const times: number[] = [];
  const errors: string[] = [];
  let success = 0;
  let failed = 0;

  const promises = Array.from({ length: count }, async (_, i) => {
    const t0 = Date.now();
    try {
      const result = await fn(i);
      times.push(Date.now() - t0);
      if (result.ok) success++;
      else {
        failed++;
        if (result.error && errors.length < 5) errors.push(result.error);
      }
    } catch (e: any) {
      times.push(Date.now() - t0);
      failed++;
      if (errors.length < 5) errors.push(e.message?.slice(0, 100) || "Unknown");
    }
  });

  await Promise.all(promises);

  return {
    name,
    total: count,
    success,
    failed,
    avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
    maxMs: times.length ? Math.max(...times) : 0,
    minMs: times.length ? Math.min(...times) : 0,
    errors,
  };
}

function printResult(r: TestResult): void {
  const status = r.failed === 0 ? "✅" : r.failed < r.total / 2 ? "⚠️" : "❌";
  console.log(
    `${status} ${r.name.padEnd(40)} | ${String(r.success).padStart(4)}/${String(r.total).padStart(4)} ok | ` +
    `avg ${String(r.avgMs).padStart(5)}ms | max ${String(r.maxMs).padStart(5)}ms | min ${String(r.minMs).padStart(5)}ms`,
  );
  if (r.errors.length > 0) {
    for (const e of r.errors.slice(0, 3)) {
      console.log(`   └─ ${e}`);
    }
  }
}

// ============================================================
// Test Cases
// ============================================================

// Pre-generate test users
const users = Array.from({ length: NUM_USERS }, () => randomAddress());
let referralCodes: string[] = [];

async function testServerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/market/tickers`);
    return res.ok;
  } catch {
    return false;
  }
}

async function testReferralRegister(): Promise<TestResult> {
  return runConcurrent("Referral Register (concurrent)", NUM_USERS, async (i) => {
    const res = await fetch(`${BASE_URL}/api/referral/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: users[i] }),
    });
    const data = await res.json();
    if (data.referrer?.code) referralCodes.push(data.referrer.code);
    return { ok: res.ok, error: data.error };
  });
}

async function testReferralBind(): Promise<TestResult> {
  if (referralCodes.length === 0) {
    return { name: "Referral Bind", total: 0, success: 0, failed: 0, avgMs: 0, maxMs: 0, minMs: 0, errors: ["No codes available"] };
  }
  // Create new users and bind them to existing referral codes
  const bindUsers = Array.from({ length: NUM_USERS }, () => randomAddress());
  return runConcurrent("Referral Bind (concurrent)", NUM_USERS, async (i) => {
    const code = referralCodes[i % referralCodes.length];
    const res = await fetch(`${BASE_URL}/api/referral/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: bindUsers[i], referralCode: code }),
    });
    const data = await res.json();
    return { ok: res.ok, error: data.error };
  });
}

async function testReferralLeaderboard(): Promise<TestResult> {
  return runConcurrent("Referral Leaderboard (burst)", NUM_USERS * 2, async () => {
    const res = await fetch(`${BASE_URL}/api/referral/leaderboard?limit=10`);
    return { ok: res.ok };
  });
}

async function testReferralReferrer(): Promise<TestResult> {
  return runConcurrent("Referral Referrer Query", NUM_USERS, async (i) => {
    const res = await fetch(`${BASE_URL}/api/referral/referrer?address=${users[i % users.length]}`);
    return { ok: res.ok };
  });
}

async function testReferralCommissions(): Promise<TestResult> {
  return runConcurrent("Referral Commissions Query", NUM_USERS, async (i) => {
    const res = await fetch(`${BASE_URL}/api/referral/commissions?address=${users[i % users.length]}&limit=20`);
    return { ok: res.ok };
  });
}

async function testBalanceQuery(): Promise<TestResult> {
  return runConcurrent("Balance Query (burst)", NUM_USERS * 2, async (i) => {
    const res = await fetch(`${BASE_URL}/api/user/${users[i % users.length]}/balance`);
    return { ok: res.ok };
  });
}

async function testPositionsQuery(): Promise<TestResult> {
  return runConcurrent("Positions Query (burst)", NUM_USERS * 2, async (i) => {
    const res = await fetch(`${BASE_URL}/api/user/${users[i % users.length]}/positions`);
    return { ok: res.ok };
  });
}

async function testOrderBookQuery(): Promise<TestResult> {
  return runConcurrent("OrderBook Query (burst)", NUM_USERS * 2, async () => {
    // Use a dummy token address
    const res = await fetch(`${BASE_URL}/api/v1/market/books?instId=0xcafe000000000000000000000000000000000001-ETH&sz=20`);
    return { ok: res.ok };
  });
}

async function testTickersQuery(): Promise<TestResult> {
  return runConcurrent("Tickers Query (burst)", NUM_USERS * 2, async () => {
    const res = await fetch(`${BASE_URL}/api/v1/market/tickers`);
    return { ok: res.ok };
  });
}

async function testHealthEndpoint(): Promise<TestResult> {
  return runConcurrent("Health Check (burst)", NUM_USERS * 3, async () => {
    const res = await fetch(`${BASE_URL}/api/v1/market/tickers`);
    return { ok: res.ok };
  });
}

async function testKlinesQuery(): Promise<TestResult> {
  return runConcurrent("Klines Query", NUM_USERS, async () => {
    const token = "0xcafe000000000000000000000000000000000001";
    const res = await fetch(`${BASE_URL}/api/klines?token=${token}&interval=1m&limit=100`);
    return { ok: res.ok };
  });
}

async function testDuplicateRegister(): Promise<TestResult> {
  // Try to register the same address multiple times concurrently
  const addr = randomAddress();
  return runConcurrent("Duplicate Register (race)", 20, async () => {
    const res = await fetch(`${BASE_URL}/api/referral/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: addr }),
    });
    const data = await res.json();
    return { ok: res.ok, error: data.error };
  });
}

async function testDuplicateBind(): Promise<TestResult> {
  if (referralCodes.length === 0) {
    return { name: "Duplicate Bind (race)", total: 0, success: 0, failed: 0, avgMs: 0, maxMs: 0, minMs: 0, errors: ["No codes"] };
  }
  // Try to bind the same address with different codes concurrently
  const addr = randomAddress();
  return runConcurrent("Duplicate Bind (race)", 20, async (i) => {
    const code = referralCodes[i % referralCodes.length];
    const res = await fetch(`${BASE_URL}/api/referral/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: addr, referralCode: code }),
    });
    const data = await res.json();
    // We expect first one to succeed, rest to get "already bound"
    return { ok: res.ok || data.error?.includes("already"), error: data.error };
  });
}

async function testWebSocketConnections(): Promise<TestResult> {
  const WS_URL = BASE_URL.replace("http", "ws") + "/ws";
  const connections = 30;

  return runConcurrent("WebSocket Connect/Disconnect", connections, async (i) => {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false, error: "WS connect timeout (5s)" }), 5000);
      try {
        const ws = new WebSocket(WS_URL);
        ws.onopen = () => {
          // Subscribe to a token
          ws.send(JSON.stringify({ type: "subscribe_token", token: "0xcafe000000000000000000000000000000000001" }));
          // Wait a bit then disconnect
          setTimeout(() => {
            clearTimeout(timeout);
            ws.close();
            resolve({ ok: true });
          }, 200);
        };
        ws.onerror = (e) => {
          clearTimeout(timeout);
          resolve({ ok: false, error: "WS connection error" });
        };
      } catch (e: any) {
        clearTimeout(timeout);
        resolve({ ok: false, error: e.message });
      }
    });
  });
}

async function testMixedLoad(): Promise<TestResult> {
  // Simulate real usage: mix of different endpoints concurrently
  const endpoints = [
    () => fetch(`${BASE_URL}/api/health`),
    () => fetch(`${BASE_URL}/api/v1/market/tickers`),
    () => fetch(`${BASE_URL}/api/user/${users[0]}/balance`),
    () => fetch(`${BASE_URL}/api/user/${users[0]}/positions`),
    () => fetch(`${BASE_URL}/api/referral/leaderboard?limit=10`),
    () => fetch(`${BASE_URL}/api/referral/referrer?address=${users[0]}`),
  ];

  return runConcurrent("Mixed Load (realistic)", NUM_USERS * 3, async (i) => {
    const fn = endpoints[i % endpoints.length];
    const res = await fn();
    return { ok: res.ok };
  });
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("🔥 MemePerpDEX 压力测试");
  console.log(`   URL: ${BASE_URL}`);
  console.log(`   模拟用户数: ${NUM_USERS}`);
  console.log(`   测试轮次: ${ROUNDS}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Check server alive
  const alive = await testServerAlive();
  if (!alive) {
    console.error("❌ 服务器无响应！请确保撮合引擎正在运行:");
    console.error(`   cd backend/src/matching && bun run server.ts`);
    process.exit(1);
  }
  console.log("✅ 服务器在线\n");

  const allResults: TestResult[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    console.log(`\n── 第 ${round + 1}/${ROUNDS} 轮 ──────────────────────────────────────`);

    // Round 1: Registration + Binding
    if (round === 0) {
      allResults.push(await testReferralRegister());
      printResult(allResults[allResults.length - 1]);

      allResults.push(await testReferralBind());
      printResult(allResults[allResults.length - 1]);

      allResults.push(await testDuplicateRegister());
      printResult(allResults[allResults.length - 1]);

      allResults.push(await testDuplicateBind());
      printResult(allResults[allResults.length - 1]);
    }

    // Every round: read endpoints
    const readTests = [
      testHealthEndpoint(),
      testBalanceQuery(),
      testPositionsQuery(),
      testTickersQuery(),
      testOrderBookQuery(),
      testKlinesQuery(),
      testReferralLeaderboard(),
      testReferralReferrer(),
      testReferralCommissions(),
    ];

    const results = await Promise.all(readTests);
    for (const r of results) {
      allResults.push(r);
      printResult(r);
    }

    // WebSocket test (only round 0 and last round)
    if (round === 0 || round === ROUNDS - 1) {
      allResults.push(await testWebSocketConnections());
      printResult(allResults[allResults.length - 1]);
    }

    // Mixed load test
    allResults.push(await testMixedLoad());
    printResult(allResults[allResults.length - 1]);
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("📊 测试总结");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const totalRequests = allResults.reduce((s, r) => s + r.total, 0);
  const totalSuccess = allResults.reduce((s, r) => s + r.success, 0);
  const totalFailed = allResults.reduce((s, r) => s + r.failed, 0);
  const allTimes = allResults.filter(r => r.total > 0);
  const avgLatency = allTimes.length ? Math.round(allTimes.reduce((s, r) => s + r.avgMs, 0) / allTimes.length) : 0;
  const maxLatency = allTimes.length ? Math.max(...allTimes.map(r => r.maxMs)) : 0;

  console.log(`总请求数:    ${totalRequests}`);
  console.log(`成功:        ${totalSuccess} (${((totalSuccess / totalRequests) * 100).toFixed(1)}%)`);
  console.log(`失败:        ${totalFailed} (${((totalFailed / totalRequests) * 100).toFixed(1)}%)`);
  console.log(`平均延迟:    ${avgLatency}ms`);
  console.log(`最大延迟:    ${maxLatency}ms`);
  console.log();

  // Failures breakdown
  const failedTests = allResults.filter(r => r.failed > 0);
  if (failedTests.length > 0) {
    console.log("⚠️ 失败的测试:");
    for (const r of failedTests) {
      console.log(`  - ${r.name}: ${r.failed}/${r.total} failed`);
      for (const e of r.errors.slice(0, 2)) {
        console.log(`    └─ ${e}`);
      }
    }
  } else {
    console.log("🎉 全部测试通过！零失败。");
  }

  console.log("\n═══════════════════════════════════════════════════════════════");

  // Exit with error code if failures
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(console.error);
