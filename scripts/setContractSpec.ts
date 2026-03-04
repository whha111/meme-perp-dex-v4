/**
 * 设置123token的合约规格
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const REGISTRY = "0x8f6277275c4e11A42b3928B55e5653bB694D5A61";
const TOKEN_123 = "0x01c6058175eda34fc8922eeae32bc383cb203211";
// AUDIT-FIX DP-C01: Read key from env
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY) as `0x${string}`;
if (!DEPLOYER_KEY) { console.error("Set DEPLOYER_PRIVATE_KEY env var"); process.exit(1); }

const REGISTRY_ABI = [
  {
    inputs: [
      { name: "token", type: "address" },
      {
        name: "spec",
        type: "tuple",
        components: [
          { name: "contractSize", type: "uint256" },
          { name: "tickSize", type: "uint256" },
          { name: "priceDecimals", type: "uint8" },
          { name: "quantityDecimals", type: "uint8" },
          { name: "minOrderSize", type: "uint256" },
          { name: "maxOrderSize", type: "uint256" },
          { name: "maxPositionSize", type: "uint256" },
          { name: "maxLeverage", type: "uint256" },
          { name: "imRate", type: "uint256" },
          { name: "mmRate", type: "uint256" },
          { name: "maxPriceDeviation", type: "uint256" },
          { name: "isActive", type: "bool" },
          { name: "createdAt", type: "uint256" },
        ],
      },
    ],
    name: "setContractSpec",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

async function main() {
  const account = privateKeyToAccount(DEPLOYER_KEY as `0x${string}`);

  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  console.log("=== 设置123token合约规格 ===");
  console.log("Registry:", REGISTRY);
  console.log("Token:", TOKEN_123);
  console.log("Deployer:", account.address);

  const spec = {
    contractSize: 200_000n,           // 1张 = 200,000 代币
    tickSize: BigInt(1e11),           // 0.0000001
    priceDecimals: 7,
    quantityDecimals: 0,
    minOrderSize: 1000n,              // 最小 $0.001 (允许小额测试)
    maxOrderSize: 100_000_000_000n,   // 单笔最大 $100,000
    maxPositionSize: 500_000_000_000n, // 持仓限额 $500,000
    maxLeverage: 1_000_000n,           // 最大100x杠杆
    imRate: 500n,                     // 初始保证金5%
    mmRate: 250n,                     // 维持保证金2.5%
    maxPriceDeviation: 1000n,         // 限价单最大偏离10%
    isActive: true,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
  };

  try {
    const hash = await walletClient.writeContract({
      address: REGISTRY as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "setContractSpec",
      args: [TOKEN_123 as `0x${string}`, spec],
    });

    console.log("交易哈希:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("状态:", receipt.status === "success" ? "✅ 成功" : "❌ 失败");

  } catch (e: any) {
    console.error("失败:", e.message?.slice(0, 500));
  }
}

main().catch(console.error);
