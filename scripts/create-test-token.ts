/**
 * 在 BSC Testnet 上通过 TokenFactory 创建一个测试代币
 * Usage: bun run scripts/create-test-token.ts
 */
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const TOKEN_FACTORY = "0x22276744bAF24eD503dB50Cc999a9c5AD62728cb" as const;
// AUDIT-FIX DP-C01: Private key from env (never hardcode)
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Set DEPLOYER_PRIVATE_KEY or PRIVATE_KEY env var");

const TOKEN_FACTORY_ABI = [
  {
    name: "createToken",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "minTokensOut", type: "uint256" },
    ],
    outputs: [{ name: "tokenAddress", type: "address" }],
  },
  {
    name: "getAllTokens",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    name: "getPoolState",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "realETHReserve", type: "uint256" },
        { name: "realTokenReserve", type: "uint256" },
        { name: "soldTokens", type: "uint256" },
        { name: "isGraduated", type: "bool" },
        { name: "isActive", type: "bool" },
        { name: "creator", type: "address" },
        { name: "createdAt", type: "uint64" },
        { name: "metadataURI", type: "string" },
        { name: "graduationFailed", type: "bool" },
        { name: "graduationAttempts", type: "uint256" },
        { name: "perpEnabled", type: "bool" },
        { name: "lendingEnabled", type: "bool" },
      ],
    }],
  },
] as const;

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log(`Wallet: ${account.address}`);

  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  // 检查余额
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Balance: ${formatEther(balance)} tBNB`);

  if (balance < parseEther("0.05")) {
    console.error("Insufficient balance. Need at least 0.05 tBNB.");
    process.exit(1);
  }

  // 创建代币: 0.01 BNB (0.001 service fee + 0.009 initial buy)
  console.log("\n--- Creating DOGE token ---");
  const value = parseEther("0.01");

  const hash = await walletClient.writeContract({
    address: TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "createToken",
    args: ["Dogecoin", "DOGE", "ipfs://test-doge-metadata", 0n],
    value,
  });

  console.log(`TX Hash: ${hash}`);
  console.log("Waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Status: ${receipt.status}`);
  console.log(`Block: ${receipt.blockNumber}`);
  console.log(`Gas Used: ${receipt.gasUsed}`);

  // 读取所有代币
  const allTokens = await publicClient.readContract({
    address: TOKEN_FACTORY,
    abi: TOKEN_FACTORY_ABI,
    functionName: "getAllTokens",
  });

  console.log(`\n--- All Tokens (${allTokens.length}) ---`);
  for (const token of allTokens) {
    const pool = await publicClient.readContract({
      address: TOKEN_FACTORY,
      abi: TOKEN_FACTORY_ABI,
      functionName: "getPoolState",
      args: [token],
    });
    console.log(`  ${token}`);
    console.log(`    ETH Reserve: ${formatEther(pool.realETHReserve)} BNB`);
    console.log(`    Sold Tokens: ${pool.soldTokens}`);
    console.log(`    Active: ${pool.isActive}`);
  }

  console.log("\n✅ Done!");
}

main().catch(console.error);
