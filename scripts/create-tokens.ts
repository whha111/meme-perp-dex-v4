/**
 * Create 3 meme tokens on the fresh TokenFactory
 * Usage: cd scripts && PRIVATE_KEY=0x... bun run create-tokens.ts
 */
import {
  createPublicClient, createWalletClient, http, parseEther, formatEther,
  type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/";
const TOKEN_FACTORY = (process.env.TOKEN_FACTORY_ADDRESS || "0xd05A38E6C2a39762De453D90a670ED0Af65ff2f8") as Address;
const DEPLOYER_KEY = (process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY) as Hex;

if (!DEPLOYER_KEY) {
  console.error("❌ PRIVATE_KEY env var required");
  process.exit(1);
}

const TF_ABI = [
  {
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "minTokensOut", type: "uint256" },
    ],
    name: "createToken",
    outputs: [{ name: "tokenAddress", type: "address" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ name: "token", type: "address" }],
    name: "getCurrentPrice",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getAllTokens",
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const transport = http(RPC_URL, { timeout: 30_000 });
const pub = createPublicClient({ chain: bscTestnet, transport });
const account = privateKeyToAccount(DEPLOYER_KEY);
const wallet = createWalletClient({ account, chain: bscTestnet, transport });

const TOKENS_TO_CREATE = [
  { name: "Dogecoin", symbol: "DOGE", uri: "ipfs://doge-metadata" },
  { name: "Pepe", symbol: "PEPE", uri: "ipfs://pepe-metadata" },
  { name: "Shiba Inu", symbol: "SHIB", uri: "ipfs://shib-metadata" },
];

// Initial buy amount per token (ETH sent with createToken)
const INITIAL_ETH = parseEther("0.5");

async function main() {
  console.log("╔═══════════════════════════════════════╗");
  console.log("║  🎯 CREATE TOKENS ON NEW FACTORY      ║");
  console.log("╚═══════════════════════════════════════╝\n");

  const bal = await pub.getBalance({ address: account.address });
  console.log(`Deployer: ${account.address}`);
  console.log(`Balance:  ${formatEther(bal)} ETH`);
  console.log(`Factory:  ${TOKEN_FACTORY}\n`);

  if (bal < INITIAL_ETH * 3n) {
    console.error(`❌ Need at least ${formatEther(INITIAL_ETH * 3n)} ETH, have ${formatEther(bal)}`);
    process.exit(1);
  }

  // Check if tokens already exist
  const existing = await pub.readContract({ address: TOKEN_FACTORY, abi: TF_ABI, functionName: "getAllTokens" });
  if (existing.length > 0) {
    console.log(`⚠️  Factory already has ${existing.length} tokens:`);
    for (const addr of existing) console.log(`   ${addr}`);
    console.log("\nProceeding to create additional tokens...\n");
  }

  const created: { symbol: string; address: Address }[] = [];

  for (const token of TOKENS_TO_CREATE) {
    console.log(`Creating ${token.symbol}...`);
    try {
      const hash = await wallet.writeContract({
        address: TOKEN_FACTORY,
        abi: TF_ABI,
        functionName: "createToken",
        args: [token.name, token.symbol, token.uri, 0n],
        value: INITIAL_ETH,
      });
      console.log(`  tx: ${hash}`);

      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      console.log(`  status: ${receipt.status}`);

      // Find the token address from logs (Transfer event from 0x0)
      // Or just re-read getAllTokens
      const allTokens = await pub.readContract({ address: TOKEN_FACTORY, abi: TF_ABI, functionName: "getAllTokens" });
      const newAddr = allTokens[allTokens.length - 1] as Address;
      created.push({ symbol: token.symbol, address: newAddr });

      const price = await pub.readContract({ address: TOKEN_FACTORY, abi: TF_ABI, functionName: "getCurrentPrice", args: [newAddr] });
      console.log(`  ✅ ${token.symbol}: ${newAddr}`);
      console.log(`     Price: ${(Number(price) / 1e18).toExponential(4)} ETH\n`);
    } catch (e: any) {
      console.error(`  ❌ Failed: ${e.message?.slice(0, 200)}\n`);
    }
  }

  console.log("\n═══════════════════════════════════════");
  console.log("CREATED TOKENS:");
  console.log("═══════════════════════════════════════");
  for (const t of created) {
    console.log(`  ${t.symbol}: "${t.address}"`);
  }
  console.log("\nUpdate TOKENS array in market-maker-all.ts:");
  console.log("const TOKENS: [string, Address][] = [");
  for (const t of created) {
    console.log(`  ["${t.symbol}", "${t.address}"],`);
  }
  console.log("];");
  console.log("═══════════════════════════════════════\n");
}

main().catch(e => { console.error(e); process.exit(1); });
