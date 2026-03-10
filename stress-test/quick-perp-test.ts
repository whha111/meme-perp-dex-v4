import { createWalletClient, http, parseEther, type Address, type Hex, encodePacked, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const ENGINE_URL = "http://localhost:8081";
const SETTLEMENT = "0x35ce4ed5e5d2515Ea05a2f49A70170Fa78e13F7c" as Address;
const TOKEN = "0x01eA557E2B17f65604568791Edda8dE1Ae702BE8" as Address;

// AUDIT-FIX DP-C01: Matcher key from env (never hardcode)
const MATCHER_KEY = process.env.MATCHER_PRIVATE_KEY as Hex;
if (!MATCHER_KEY) throw new Error("Set MATCHER_PRIVATE_KEY env var");

// Generate 2 test wallets
const TEST_KEY1 = "0x" + "a".repeat(63) + "1" as Hex;
const TEST_KEY2 = "0x" + "b".repeat(63) + "2" as Hex;

const account1 = privateKeyToAccount(TEST_KEY1);
const account2 = privateKeyToAccount(TEST_KEY2);

console.log("Wallet 1 (Long):", account1.address);
console.log("Wallet 2 (Short):", account2.address);

// EIP-712 domain
const domain = {
  name: "MemePerp",
  version: "1",
  chainId: 97,
  verifyingContract: SETTLEMENT,
};

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
  ],
};

async function getNonce(addr: string): Promise<bigint> {
  const resp = await fetch(`${ENGINE_URL}/api/user/${addr}/nonce`);
  const data = await resp.json() as { nonce: string };
  return BigInt(data.nonce || "0");
}

async function syncBalance(addr: string) {
  await fetch(`${ENGINE_URL}/api/balance/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trader: addr }),
  });
}

async function depositETH(key: Hex, amount: bigint) {
  const account = privateKeyToAccount(key);
  const client = createWalletClient({
    account,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });
  
  const hash = await client.writeContract({
    address: SETTLEMENT,
    abi: [{ inputs: [], name: "depositETH", outputs: [], stateMutability: "payable", type: "function" }],
    functionName: "depositETH",
    value: amount,
  });
  console.log(`Deposit ${amount} from ${account.address}: ${hash}`);
  
  // Wait for confirmation
  const { createPublicClient } = await import("viem");
  const pub = createPublicClient({ chain: bscTestnet, transport: http(RPC_URL) });
  await pub.waitForTransactionReceipt({ hash });
  
  // Sync with matching engine
  await syncBalance(account.address);
}

async function submitOrder(account: any, isLong: boolean, size: bigint, leverage: bigint, price: bigint) {
  const nonce = await getNonce(account.address);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  
  const message = {
    trader: account.address as Address,
    token: TOKEN,
    isLong,
    size,
    leverage,
    price,
    deadline,
    nonce,
  };
  
  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "Order",
    message,
  });
  
  const resp = await fetch(`${ENGINE_URL}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trader: account.address,
      token: TOKEN,
      isLong,
      size: size.toString(),
      leverage: leverage.toString(),
      price: price.toString(),
      deadline: deadline.toString(),
      nonce: nonce.toString(),
      orderType: 0, // market
      signature,
    }),
  });
  
  const data = await resp.json();
  console.log(`Order ${isLong ? "LONG" : "SHORT"} from ${account.address.slice(0,10)}:`, JSON.stringify(data));
  return data;
}

async function main() {
  const size = parseEther("0.005");
  const leverage = parseEther("2"); // 2x
  const price = parseEther("0.000000001698024733"); // approx market price
  
  // First fund the test wallets from matcher
  const matcherAccount = privateKeyToAccount(MATCHER_KEY);
  const client = createWalletClient({
    account: matcherAccount,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });
  
  console.log("\n--- Funding test wallets ---");
  // Send 0.02 ETH to each test wallet
  for (const addr of [account1.address, account2.address]) {
    try {
      const hash = await client.sendTransaction({
        to: addr,
        value: parseEther("0.02"),
      });
      console.log(`Sent 0.02 ETH to ${addr}: ${hash}`);
      const { createPublicClient } = await import("viem");
      const pub = createPublicClient({ chain: bscTestnet, transport: http(RPC_URL) });
      await pub.waitForTransactionReceipt({ hash });
    } catch (e: any) {
      console.log(`Funding ${addr} error:`, e.message?.slice(0, 100));
    }
  }
  
  console.log("\n--- Depositing to Settlement ---");
  await depositETH(TEST_KEY1, parseEther("0.01"));
  await depositETH(TEST_KEY2, parseEther("0.01"));
  
  console.log("\n--- Checking balances ---");
  for (const addr of [account1.address, account2.address]) {
    const resp = await fetch(`${ENGINE_URL}/api/user/${addr}/balance`);
    const data = await resp.json() as any;
    console.log(`${addr.slice(0,10)}: available=${data.display?.availableBalance}`);
  }
  
  console.log("\n--- §3.5 Submit Market Orders ---");
  // Submit long order
  const longResult = await submitOrder(account1, true, size, leverage, BigInt("1698024733"));
  // Submit short order
  const shortResult = await submitOrder(account2, false, size, leverage, BigInt("1698024733"));
  
  // Wait for matching
  console.log("\n--- Waiting for match (5s) ---");
  await new Promise(r => setTimeout(r, 5000));
  
  console.log("\n--- §3.6 Check Orderbook ---");
  const ob = await (await fetch(`${ENGINE_URL}/api/orderbook/${TOKEN}`)).json();
  console.log("Orderbook:", JSON.stringify(ob).slice(0, 200));
  
  console.log("\n--- §3.7 Check Trades ---");
  const trades = await (await fetch(`${ENGINE_URL}/api/trades/${TOKEN}`)).json();
  console.log("Trades:", JSON.stringify(trades).slice(0, 300));
  
  console.log("\n--- §3.8 Check Positions ---");
  for (const addr of [account1.address, account2.address]) {
    const positions = await (await fetch(`${ENGINE_URL}/api/user/${addr}/positions`)).json();
    console.log(`${addr.slice(0,10)} positions:`, JSON.stringify(positions).slice(0, 200));
  }
  
  console.log("\n--- §3.10 Submit with TP/SL ---");
  const nonce3 = await getNonce(account1.address);
  const tpSlSignature = await account1.signTypedData({
    domain, types, primaryType: "Order",
    message: {
      trader: account1.address as Address, token: TOKEN, isLong: true,
      size: parseEther("0.003"), leverage: parseEther("3"),
      price: BigInt("1698024733"),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: nonce3,
    },
  });
  
  const tpSlResp = await fetch(`${ENGINE_URL}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trader: account1.address, token: TOKEN, isLong: true,
      size: parseEther("0.003").toString(), leverage: parseEther("3").toString(),
      price: "1698024733", deadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
      nonce: nonce3.toString(), orderType: 0, signature: tpSlSignature,
      takeProfit: "2000000000",  // TP at 2e9
      stopLoss: "1000000000",    // SL at 1e9
    }),
  });
  console.log("TP/SL order:", JSON.stringify(await tpSlResp.json()));
  
  console.log("\n--- §3.9 Close Position ---");
  // Get first wallet's positions and close one
  const pos1 = await (await fetch(`${ENGINE_URL}/api/user/${account1.address}/positions`)).json() as any[];
  if (pos1.length > 0) {
    const pairId = pos1[0].pairId || pos1[0].id;
    console.log("Closing pair:", pairId);
    const closeResp = await fetch(`${ENGINE_URL}/api/position/${pairId}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trader: account1.address }),
    });
    console.log("Close result:", JSON.stringify(await closeResp.json()));
  } else {
    console.log("No positions to close");
  }
  
  console.log("\n=== DONE ===");
}

main().catch(console.error);
