import { createWalletClient, createPublicClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const ENGINE_URL = "http://localhost:8081";
const SETTLEMENT = "0x35ce4ed5e5d2515Ea05a2f49A70170Fa78e13F7c" as Address;
const TOKEN = "0x01eA557E2B17f65604568791Edda8dE1Ae702BE8" as Address;

const TEST_KEY1 = "0x" + "a".repeat(63) + "1" as Hex;
const TEST_KEY2 = "0x" + "b".repeat(63) + "2" as Hex;
const account1 = privateKeyToAccount(TEST_KEY1);
const account2 = privateKeyToAccount(TEST_KEY2);

const pub = createPublicClient({ chain: bscTestnet, transport: http(RPC_URL) });

// Correct EIP-712 domain matching the engine
const domain = {
  name: "MemePerp",
  version: "1",
  chainId: 97,
  verifyingContract: SETTLEMENT,
};

// CRITICAL: includes orderType as uint8 (must match server!)
const types = {
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
};

async function getNonce(addr: string): Promise<string> {
  const resp = await fetch(`${ENGINE_URL}/api/user/${addr}/nonce`);
  const data = await resp.json() as { nonce: string };
  return data.nonce || "0";
}

async function syncBalance(addr: string) {
  await fetch(`${ENGINE_URL}/api/balance/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trader: addr }),
  });
}

async function submitOrder(acct: any, isLong: boolean, orderType: number = 0) {
  const nonce = await getNonce(acct.address);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const size = parseEther("0.005");
  const leverage = parseEther("2");
  const price = BigInt("1698024733");
  
  const message = {
    trader: acct.address as Address,
    token: TOKEN,
    isLong,
    size,
    leverage,
    price,
    deadline,
    nonce: BigInt(nonce),
    orderType,
  };
  
  const signature = await acct.signTypedData({
    domain,
    types,
    primaryType: "Order",
    message,
  });
  
  const body = {
    trader: acct.address,
    token: TOKEN,
    isLong,
    size: size.toString(),
    leverage: leverage.toString(),
    price: price.toString(),
    deadline: deadline.toString(),
    nonce,
    orderType,
    signature,
  };
  
  const resp = await fetch(`${ENGINE_URL}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  return data;
}

async function main() {
  console.log("Wallet 1 (Long):", account1.address);
  console.log("Wallet 2 (Short):", account2.address);
  
  // Check if already funded (from previous run)
  const bal1 = await pub.getBalance({ address: account1.address });
  console.log(`Wallet 1 balance: ${bal1}`);
  
  if (bal1 < parseEther("0.005")) {
    console.log("Funding wallets...");
    const MATCHER_KEY = process.env.MATCHER_PRIVATE_KEY as Hex;
    if (!MATCHER_KEY) throw new Error("Set MATCHER_PRIVATE_KEY env var");
    const matcher = privateKeyToAccount(MATCHER_KEY);
    const client = createWalletClient({ account: matcher, chain: bscTestnet, transport: http(RPC_URL) });
    
    for (const addr of [account1.address, account2.address]) {
      const hash = await client.sendTransaction({ to: addr, value: parseEther("0.02") });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`Funded ${addr.slice(0,10)}: ${hash.slice(0,20)}...`);
    }
  }
  
  // Check Settlement balances
  const settleAbi = [
    { inputs: [{ name: "user", type: "address" }], name: "getUserBalance", outputs: [{ name: "available", type: "uint256" }, { name: "locked", type: "uint256" }], stateMutability: "view", type: "function" },
    { inputs: [], name: "depositETH", outputs: [], stateMutability: "payable", type: "function" },
  ] as const;
  
  for (const acct of [account1, account2]) {
    const bal = await pub.readContract({
      address: SETTLEMENT,
      abi: settleAbi,
      functionName: "getUserBalance",
      args: [acct.address],
    });
    console.log(`${acct.address.slice(0,10)} settlement: available=${bal[0]} locked=${bal[1]}`);
    
    if (bal[0] < 5000n) { // Less than 0.005 in 6-decimal
      console.log(`Depositing 0.01 ETH for ${acct.address.slice(0,10)}...`);
      const client = createWalletClient({ account: acct, chain: bscTestnet, transport: http(RPC_URL) });
      const hash = await client.writeContract({
        address: SETTLEMENT,
        abi: settleAbi,
        functionName: "depositETH",
        value: parseEther("0.01"),
      });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`Deposited: ${hash.slice(0,20)}...`);
    }
    await syncBalance(acct.address);
  }
  
  // Verify balances on matching engine
  for (const addr of [account1.address, account2.address]) {
    const resp = await fetch(`${ENGINE_URL}/api/user/${addr}/balance`);
    const data = await resp.json() as any;
    console.log(`${addr.slice(0,10)} engine: available=${data.display?.availableBalance}`);
  }
  
  // §3.5 Submit market orders
  console.log("\n=== §3.5 Submit Market Orders ===");
  const longResult = await submitOrder(account1, true, 0);
  console.log("LONG:", JSON.stringify(longResult));
  const shortResult = await submitOrder(account2, false, 0);
  console.log("SHORT:", JSON.stringify(shortResult));
  
  // §3.4 Submit limit order
  console.log("\n=== §3.4 Submit Limit Order ===");
  const limitResult = await submitOrder(account1, true, 1);
  console.log("LIMIT:", JSON.stringify(limitResult));
  
  // Wait for matching
  console.log("\nWaiting 5s for matching...");
  await new Promise(r => setTimeout(r, 5000));
  
  // §3.6 Orderbook
  console.log("\n=== §3.6 Orderbook ===");
  const ob = await (await fetch(`${ENGINE_URL}/api/orderbook/${TOKEN}`)).json();
  console.log(JSON.stringify(ob).slice(0, 300));
  
  // §3.7 Trades
  console.log("\n=== §3.7 Trades ===");
  const trades = await (await fetch(`${ENGINE_URL}/api/trades/${TOKEN}`)).json() as any;
  console.log(`Total trades: ${trades.trades?.length || 0}`);
  if (trades.trades?.length > 0) console.log("Last trade:", JSON.stringify(trades.trades[0]).slice(0,200));
  
  // §3.8 Positions
  console.log("\n=== §3.8 Positions ===");
  for (const acct of [account1, account2]) {
    const positions = await (await fetch(`${ENGINE_URL}/api/user/${acct.address}/positions`)).json() as any[];
    console.log(`${acct.address.slice(0,10)}: ${positions.length} positions`);
    if (positions.length > 0) console.log("  First:", JSON.stringify(positions[0]).slice(0, 200));
  }
  
  // §3.10 TP/SL order
  console.log("\n=== §3.10 TP/SL Order ===");
  const nonce3 = await getNonce(account1.address);
  const deadline3 = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const tpSlMsg = {
    trader: account1.address as Address, token: TOKEN, isLong: true,
    size: parseEther("0.003"), leverage: parseEther("3"),
    price: BigInt("1698024733"), deadline: deadline3,
    nonce: BigInt(nonce3), orderType: 0,
  };
  const tpSlSig = await account1.signTypedData({ domain, types, primaryType: "Order", message: tpSlMsg });
  const tpSlResp = await fetch(`${ENGINE_URL}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...Object.fromEntries(Object.entries(tpSlMsg).map(([k,v]) => [k, v.toString()])),
      signature: tpSlSig,
      takeProfit: "2000000000",
      stopLoss: "1000000000",
    }),
  });
  console.log("TP/SL:", JSON.stringify(await tpSlResp.json()));
  
  // §3.9 Close position
  console.log("\n=== §3.9 Close Position ===");
  const pos1 = await (await fetch(`${ENGINE_URL}/api/user/${account1.address}/positions`)).json() as any[];
  if (pos1.length > 0) {
    const pairId = pos1[0].pairId || pos1[0].id;
    console.log("Closing pair:", pairId);
    const closeResp = await fetch(`${ENGINE_URL}/api/position/${pairId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trader: account1.address }),
    });
    console.log("Close:", JSON.stringify(await closeResp.json()));
  } else {
    console.log("No positions to close");
  }
  
  console.log("\n=== COMPLETE ===");
}

main().catch(console.error);
