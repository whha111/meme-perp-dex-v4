/**
 * 把 deployer 的 ETH 分配到测试钱包
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import * as fs from "fs";

const RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const WALLETS_PATH = "/Users/qinlinqiu/Desktop/Namespace/scripts/market-maker/wallets.json";
// AUDIT-FIX DP-C01: Read key from env
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex;
if (!DEPLOYER_KEY) { console.error("Set DEPLOYER_PRIVATE_KEY env var"); process.exit(1); }

// 保留一点 gas 给 deployer
const RESERVE_FOR_DEPLOYER = parseEther("0.1");

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const client = createPublicClient({
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const deployerClient = createWalletClient({
    account: deployerAccount,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  const data = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf-8"));
  const wallets = data.wallets;

  console.log("=== 分配 ETH 到测试钱包 ===\n");

  // 获取 deployer 余额
  const deployerBalance = await client.getBalance({ address: deployerAccount.address });
  console.log("Deployer 余额: " + formatEther(deployerBalance) + " ETH");

  // 计算可分配金额
  const distributable = deployerBalance - RESERVE_FOR_DEPLOYER;
  if (distributable <= 0n) {
    console.log("Deployer 余额不足以分配");
    return;
  }

  // 计算每个钱包应得金额
  const perWallet = distributable / BigInt(wallets.length);
  console.log("可分配: " + formatEther(distributable) + " ETH");
  console.log("每个钱包: " + formatEther(perWallet) + " ETH");
  console.log("钱包数量: " + wallets.length + "\n");

  // 开始分配
  let successCount = 0;
  let totalSent = 0n;

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const addr = wallet.address as Address;

    try {
      const hash = await deployerClient.sendTransaction({
        to: addr,
        value: perWallet,
      });
      await client.waitForTransactionReceipt({ hash });

      successCount++;
      totalSent += perWallet;

      if ((i + 1) % 20 === 0) {
        console.log("已分配 " + (i + 1) + "/" + wallets.length + " 个钱包");
      }

      await sleep(100);
    } catch (e: any) {
      console.log("[" + i + "] 失败: " + e.message.slice(0, 40));
    }
  }

  console.log("\n=== 完成 ===");
  console.log("成功: " + successCount + "/" + wallets.length);
  console.log("共发送: " + formatEther(totalSent) + " ETH");

  // 检查最终余额
  const finalDeployer = await client.getBalance({ address: deployerAccount.address });
  console.log("\nDeployer 剩余: " + formatEther(finalDeployer) + " ETH");

  // 抽查几个钱包
  let sampleTotal = 0n;
  for (let i = 0; i < 5; i++) {
    const bal = await client.getBalance({ address: wallets[i].address as Address });
    sampleTotal += bal;
    console.log("钱包 #" + i + ": " + formatEther(bal) + " ETH");
  }

  // 计算总余额
  let total = 0n;
  for (const w of wallets) {
    const bal = await client.getBalance({ address: w.address as Address });
    total += bal;
  }
  console.log("\n测试钱包总余额: " + formatEther(total) + " ETH");
}

main().catch(console.error);
