/**
 * Quick Market Maker - 使用 deployer 钱包做市
 *
 * 1. Deposit ETH to Settlement contract
 * 2. Submit buy/sell limit orders for all tokens
 * 3. Repeat every 10 seconds
 */

import { createWalletClient, http, parseEther, formatEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// ============================================================
// Config
// ============================================================

const DEPLOYER_KEY = "0xf9a07bb59ea400ef88bfbcf314d89f357c8580d1a4fb543e48cfb98b02b41d2c" as Hex;
const RPC_URL = "https://base-sepolia-rpc.publicnode.com";
const API_URL = "http://localhost:8081";
const SETTLEMENT_ADDRESS = "0x027131BbC5EF6427826F64D12BACAAb447Ee1B13" as Address;

// Both supported tokens (from TokenFactory)
const TOKENS: Address[] = [
  "0x8C219589Db787C1a5B57b1d2075C76C0d3f51C73",
  "0xF8609911644b8c36b406370F5d7eCf5B3A07fF78",
];

// EIP-712 domain
const EIP712_DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: 84532,
  verifyingContract: SETTLEMENT_ADDRESS,
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
};

// ============================================================
// Setup
// ============================================================

const account = privateKeyToAccount(DEPLOYER_KEY);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(RPC_URL),
});

function log(emoji: string, ...args: any[]) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] ${emoji}`, ...args);
}

// ============================================================
// Step 1: Check balance via matching engine API (NOT on-chain)
// ============================================================

async function checkBalance(): Promise<bigint> {
  try {
    const res = await fetch(`${API_URL}/api/user/${account.address}/balance`);
    const data = await res.json() as any;
    const available = BigInt(data.availableBalance || "0");
    log("💰", `Engine available: ${data.display?.availableBalance || formatEther(available)} ETH`);
    return available;
  } catch (e: any) {
    log("⚠️", `Balance check failed: ${e.message}`);
    return 0n;
  }
}

// ============================================================
// Step 2: Get nonce
// ============================================================

async function getNonce(): Promise<bigint> {
  try {
    const res = await fetch(`${API_URL}/api/user/${account.address}/nonce`);
    const data = await res.json() as any;
    return BigInt(data.nonce || "0");
  } catch {
    return 0n;
  }
}

// ============================================================
// Step 3: Submit order
// ============================================================

async function submitOrder(
  token: Address,
  isLong: boolean,
  size: bigint,
  price: bigint,
  nonce: bigint
): Promise<{ success: boolean; error?: string }> {
  const LEVERAGE_PRECISION = 10000n;
  const orderParams = {
    trader: account.address,
    token,
    isLong,
    size,
    leverage: 2n * LEVERAGE_PRECISION, // 2x leverage
    price,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce,
    orderType: 1, // LIMIT
  };

  const signature = await walletClient.signTypedData({
    account,
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: orderParams,
  });

  const response = await fetch(`${API_URL}/api/order/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trader: orderParams.trader,
      token: orderParams.token,
      isLong: orderParams.isLong,
      size: orderParams.size.toString(),
      leverage: orderParams.leverage.toString(),
      price: orderParams.price.toString(),
      deadline: orderParams.deadline.toString(),
      nonce: orderParams.nonce.toString(),
      orderType: orderParams.orderType,
      signature,
    }),
  });

  const result = await response.json() as any;
  return { success: !!result.success, error: result.error };
}

// ============================================================
// Step 4: Get current spot price for token
// ============================================================

async function getSpotPrice(token: Address): Promise<bigint> {
  try {
    const res = await fetch(`${API_URL}/api/stats/${token.toLowerCase()}`);
    const data = await res.json() as any;
    // Price from API is in ETH (e.g., "2.4986775013e-8")
    // Convert to 1e18 wei precision (matching engine's PRICE precision)
    const priceFloat = parseFloat(data.price || "0");
    if (priceFloat === 0 || isNaN(priceFloat)) return 0n;
    return BigInt(Math.floor(priceFloat * 1e18));
  } catch (e) {
    return 0n;
  }
}

// ============================================================
// Main loop
// ============================================================

async function runIteration(nonce: bigint): Promise<bigint> {
  let currentNonce = nonce;

  for (const token of TOKENS) {
    const spotPrice = await getSpotPrice(token);
    if (spotPrice === 0n) {
      log("⚠️", `No spot price for ${token.slice(0, 10)}, skipping`);
      continue;
    }

    // Display price in ETH
    const priceETH = Number(spotPrice) / 1e18;
    log("📊", `${token.slice(0, 10)}: spot = ${priceETH.toExponential(4)} ETH (${spotPrice} wei)`);

    // Size = ETH notional value (NOT token count!)
    // margin = size * 10000 / leverage, so size=0.002 ETH @ 2x = 0.001 ETH margin
    // With 0.1 ETH deposit, we can place ~50 orders of 0.002 ETH each
    const baseSize = BigInt("2000000000000000"); // 0.002 ETH notional

    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < 5; i++) {
      // Buy order: slightly below spot
      const buyMult = 1 - (0.005 + i * 0.01); // -0.5%, -1.5%, -2.5%, -3.5%, -4.5%
      const buyPrice = BigInt(Math.floor(Number(spotPrice) * buyMult));

      const buyResult = await submitOrder(token, true, baseSize, buyPrice, currentNonce);
      if (buyResult.success) {
        okCount++;
        currentNonce++;
      } else {
        failCount++;
        if (i === 0) log("❌", `BUY fail: ${buyResult.error?.slice(0, 80)}`);
        // If first order fails, don't waste time on more
        if (buyResult.error?.includes("余额不足")) break;
      }

      // Sell order: slightly above spot
      const sellMult = 1 + (0.005 + i * 0.01); // +0.5%, +1.5%, +2.5%, +3.5%, +4.5%
      const sellPrice = BigInt(Math.floor(Number(spotPrice) * sellMult));

      const sellResult = await submitOrder(token, false, baseSize, sellPrice, currentNonce);
      if (sellResult.success) {
        okCount++;
        currentNonce++;
      } else {
        failCount++;
        if (i === 0) log("❌", `SELL fail: ${sellResult.error?.slice(0, 80)}`);
        if (sellResult.error?.includes("余额不足")) break;
      }

      await new Promise(r => setTimeout(r, 50));
    }

    log(okCount > 0 ? "✅" : "❌", `${token.slice(0, 10)}: ${okCount} orders placed, ${failCount} failed`);
  }

  return currentNonce;
}

async function main() {
  log("🚀", "=== Quick Market Maker ===");
  log("📝", `Deployer: ${account.address}`);
  log("📝", `Tokens: ${TOKENS.length}`);

  // Step 1: Check balance (no deposit - engine already has funds)
  const available = await checkBalance();
  if (available < parseEther("0.001")) {
    log("❌", "Insufficient balance in matching engine. Exiting.");
    process.exit(1);
  }

  // Step 2: Get initial nonce
  let nonce = await getNonce();
  log("🔑", `Initial nonce: ${nonce}`);

  // Step 3: Run iterations
  let iteration = 0;
  const loop = async () => {
    iteration++;
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("📊", `Iteration #${iteration}`);

    try {
      nonce = await runIteration(nonce);
    } catch (err: any) {
      log("❌", `Error: ${err.message}`);
    }
  };

  // Run first iteration immediately
  await loop();

  // Then every 10 seconds
  setInterval(loop, 10000);
}

main().catch(console.error);
