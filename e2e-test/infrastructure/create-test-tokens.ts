/**
 * Create 4 meme tokens on TokenFactory: DOGE, SHIB, PEPE, FLOKI
 * Each gets an initial bonding curve buy to establish a price
 * Output: data/token-addresses.json
 */
import { writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import {
  parseEther,
  formatEther,
  type Address,
  encodeFunctionData,
  decodeFunctionResult,
} from "viem";
import { ENV, CONTRACTS, ABI, GMX_MEME_MARKETS } from "../config/test-config";
import { getPublicClient, getWalletClient, waitForTx, getAccount } from "../utils/rpc-client";
import { log } from "../utils/logger";

// initialBuy = 6.5 BNB → exceeds PERP_ENABLE_THRESHOLD (6 BNB) → auto-enables perp trading
const TOKENS_TO_CREATE = [
  { name: "Dogecoin E2E", symbol: "DOGE3", gmxMarket: GMX_MEME_MARKETS.DOGE, initialBuy: "6.5" },
  { name: "Shiba Inu E2E", symbol: "SHIB2", gmxMarket: GMX_MEME_MARKETS.SHIB, initialBuy: "6.5" },
  { name: "Pepe E2E", symbol: "PEPE2", gmxMarket: GMX_MEME_MARKETS.PEPE, initialBuy: "6.5" },
  { name: "Floki E2E", symbol: "FLOK2", gmxMarket: GMX_MEME_MARKETS.FLOKI, initialBuy: "6.5" },
];

async function main() {
  log.infra.info("═══ Creating Test Tokens on TokenFactory ═══");

  const deployer = getAccount(ENV.DEPLOYER_PRIVATE_KEY as `0x${string}`);
  const wallet = getWalletClient(ENV.DEPLOYER_PRIVATE_KEY as `0x${string}`);
  const client = getPublicClient();

  log.infra.info({ deployer: deployer.address, tokenFactory: CONTRACTS.TokenFactory }, "Config");

  // Check deployer balance
  const balance = await client.getBalance({ address: deployer.address });
  log.infra.info({ balance: formatEther(balance) + " BNB" }, "Deployer balance");

  const totalNeeded = TOKENS_TO_CREATE.reduce((sum, t) => sum + parseFloat(t.initialBuy), 0);
  if (Number(formatEther(balance)) < totalNeeded + 1) {
    throw new Error(`Insufficient deployer balance. Need ~${totalNeeded + 1} BNB`);
  }

  // Load existing tokens (skip already created)
  let existingTokens: Record<string, any> = {};
  try {
    const existing = readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8");
    existingTokens = JSON.parse(existing);
  } catch {}

  const tokenAddresses: Record<string, { address: Address; gmxMarket: string }> = { ...existingTokens };

  for (const token of TOKENS_TO_CREATE) {
    if (existingTokens[token.symbol]) {
      log.infra.info({ symbol: token.symbol, address: existingTokens[token.symbol].address }, "Token already exists, skipping");
      continue;
    }
    log.infra.info({ name: token.name, symbol: token.symbol }, "Creating token");

    try {
      // Create token with initial buy
      const hash = await wallet.writeContract({
        address: CONTRACTS.TokenFactory,
        abi: ABI.TokenFactory,
        functionName: "createToken",
        args: [token.name, token.symbol, `ipfs://e2e-test/${token.symbol}`, parseEther(token.initialBuy)],
        value: parseEther(token.initialBuy),
      });

      log.infra.info({ hash }, `${token.symbol} creation tx sent`);
      const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });

      // Extract token address from logs
      // TokenFactory emits TokenCreated(address token, address creator, ...)
      const tokenCreatedLog = receipt.logs.find(
        (l) => l.address.toLowerCase() === CONTRACTS.TokenFactory.toLowerCase()
      );

      if (tokenCreatedLog && tokenCreatedLog.topics[1]) {
        // Token address is in the first indexed parameter
        const tokenAddr = ("0x" + tokenCreatedLog.topics[1].slice(26)) as Address;
        tokenAddresses[token.symbol] = {
          address: tokenAddr,
          gmxMarket: token.gmxMarket,
        };
        log.infra.info({ symbol: token.symbol, address: tokenAddr }, "Token created");
      } else {
        // Fallback: query TokenFactory for the latest token
        const tokenCount = await client.readContract({
          address: CONTRACTS.TokenFactory,
          abi: ABI.TokenFactory,
          functionName: "getTokenCount",
        });
        log.infra.warn({ symbol: token.symbol, tokenCount }, "Could not extract address from logs, check manually");
      }

      // Wait a bit between creations to avoid nonce issues
      await new Promise(r => setTimeout(r, 3000));

    } catch (err: any) {
      log.infra.error({ symbol: token.symbol, error: err.message }, "Failed to create token");
    }
  }

  // Save token addresses
  const outputPath = resolve(__dirname, "../data/token-addresses.json");
  writeFileSync(outputPath, JSON.stringify(tokenAddresses, null, 2));

  console.log(`\n✅ ${Object.keys(tokenAddresses).length} tokens created`);
  for (const [sym, info] of Object.entries(tokenAddresses)) {
    console.log(`   ${sym}: ${info.address}`);
  }
  console.log(`\n📝 Saved to ${outputPath}`);
}

main().catch(console.error);
