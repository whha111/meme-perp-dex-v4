/**
 * Check all token pool states on TokenFactory
 * Usage: npx ts-node scripts/check-pool-states.ts
 */
import { createPublicClient, http, formatEther, parseAbi } from "viem";
import { bscTestnet } from "viem/chains";

const TOKEN_FACTORY = "0xB40541Ff9f24883149fc6F9CD1021dB9C7BCcB83";
const RPC = process.env.RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/";

const abi = parseAbi([
  "function getAllTokens() view returns (address[])",
  "function getPoolState(address) view returns (uint256 realETHReserve, uint256 realTokenReserve, uint256 soldTokens, bool isGraduated, bool isActive, address creator, uint64 createdAt, string metadataURI, bool graduationFailed, uint8 graduationAttempts, bool perpEnabled, bool lendingEnabled)",
  "function tokenNames(address) view returns (string)",
  "function tokenSymbols(address) view returns (string)",
]);

const GRADUATION_THRESHOLD = 207_000_000n * 10n ** 18n; // 207M tokens
const VIRTUAL_ETH = 10_593n * 10n ** 15n; // 10.593 ETH
const VIRTUAL_TOKEN = 1_073_000_000n * 10n ** 18n; // 1.073B
const REAL_TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n; // 1B

async function main() {
  const client = createPublicClient({
    chain: bscTestnet,
    transport: http(RPC),
  });

  const tokens = await client.readContract({
    address: TOKEN_FACTORY,
    abi,
    functionName: "getAllTokens",
  }) as `0x${string}`[];

  console.log(`\n=== ${tokens.length} tokens found ===\n`);

  for (const token of tokens) {
    const [state, name, symbol] = await Promise.all([
      client.readContract({ address: TOKEN_FACTORY, abi, functionName: "getPoolState", args: [token] }),
      client.readContract({ address: TOKEN_FACTORY, abi, functionName: "tokenNames", args: [token] }).catch(() => "?"),
      client.readContract({ address: TOKEN_FACTORY, abi, functionName: "tokenSymbols", args: [token] }).catch(() => "?"),
    ]);

    const [realETH, realToken, soldTokens, isGraduated, isActive, creator, createdAt, uri, gradFailed, gradAttempts, perpEnabled, lendingEnabled] = state as any;

    const maxBuyable = realToken > GRADUATION_THRESHOLD ? realToken - GRADUATION_THRESHOLD : 0n;
    const soldPercent = Number(soldTokens * 10000n / REAL_TOKEN_SUPPLY) / 100;
    const progressPercent = Number((REAL_TOKEN_SUPPLY - realToken) * 10000n / (REAL_TOKEN_SUPPLY - GRADUATION_THRESHOLD)) / 100;

    // Calculate ETH needed to buy all remaining tokens to graduation
    const virtualEth = VIRTUAL_ETH + realETH;
    const virtualToken = realToken + (VIRTUAL_TOKEN - REAL_TOKEN_SUPPLY);
    // To buy maxBuyable tokens: dX = (x * dY) / (y - dY)
    let ethNeeded = 0n;
    if (maxBuyable > 0n && virtualToken > maxBuyable) {
      ethNeeded = (virtualEth * maxBuyable) / (virtualToken - maxBuyable);
      ethNeeded = ethNeeded * 101n / 100n; // +1% fee
    }

    console.log(`📦 ${symbol} (${name})`);
    console.log(`   Address: ${token}`);
    console.log(`   ETH Reserve: ${formatEther(realETH)} BNB`);
    console.log(`   Token Reserve: ${Number(formatEther(realToken)).toLocaleString()} tokens`);
    console.log(`   Sold: ${Number(formatEther(soldTokens)).toLocaleString()} (${soldPercent}%)`);
    console.log(`   Progress to graduation: ${progressPercent.toFixed(2)}%`);
    console.log(`   BNB needed to graduate: ${formatEther(ethNeeded)} BNB`);
    console.log(`   Status: ${isGraduated ? "🎓 GRADUATED" : isActive ? "🟢 Active" : "⚪ Inactive"}`);
    console.log(`   Perp: ${perpEnabled ? "✅" : "❌"} | Lending: ${lendingEnabled ? "✅" : "❌"}`);
    if (gradFailed) console.log(`   ⚠️  Graduation failed (${gradAttempts} attempts)`);
    console.log();
  }
}

main().catch(console.error);
