/**
 * Generate 100 HD wallets from a master mnemonic
 * Output: data/wallets.json
 */
import { mnemonicToAccount, generateMnemonic, english } from "viem/accounts";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { TEST_PARAMS, ENV } from "../config/test-config";
import { log } from "../utils/logger";

interface WalletEntry {
  index: number;
  address: string;
  privateKey: string;
  role: "trader" | "market-maker" | "lp-provider";
}

async function main() {
  log.infra.info("═══ Generating Test Wallets ═══");

  // Use provided mnemonic or generate a new one
  const mnemonic = ENV.MASTER_MNEMONIC || generateMnemonic(english);
  log.infra.info({ mnemonic: mnemonic.split(" ").slice(0, 3).join(" ") + "..." }, "Using mnemonic");

  const wallets: WalletEntry[] = [];

  for (let i = 0; i < TEST_PARAMS.WALLET_COUNT; i++) {
    const account = mnemonicToAccount(mnemonic, {
      addressIndex: i,
    });

    let role: WalletEntry["role"] = "trader";
    if (i < 5) role = "market-maker";      // First 5 wallets are market makers
    else if (i < 8) role = "lp-provider";   // Next 3 are LP providers

    wallets.push({
      index: i,
      address: account.address,
      privateKey: account.getHdKey().privateKey
        ? "0x" + Buffer.from(account.getHdKey().privateKey!).toString("hex")
        : "",
      role,
    });
  }

  // Save to data/wallets.json
  const outputPath = resolve(__dirname, "../data/wallets.json");
  writeFileSync(outputPath, JSON.stringify(wallets, null, 2));

  // Also save mnemonic to .env if not already set
  const envPath = resolve(__dirname, "../.env");
  const envContent = `
# Generated mnemonic — KEEP SECRET, DO NOT COMMIT
MASTER_MNEMONIC="${mnemonic}"
`.trim();

  log.infra.info({
    walletCount: wallets.length,
    marketMakers: wallets.filter(w => w.role === "market-maker").length,
    lpProviders: wallets.filter(w => w.role === "lp-provider").length,
    traders: wallets.filter(w => w.role === "trader").length,
    outputPath,
  }, "Wallets generated");

  // Print first 3 for verification
  for (const w of wallets.slice(0, 3)) {
    log.infra.info({ index: w.index, address: w.address, role: w.role }, "Sample wallet");
  }

  console.log(`\n✅ ${wallets.length} wallets saved to ${outputPath}`);
  console.log(`📝 Mnemonic: ${mnemonic}`);
  console.log(`\n⚠️  Save this mnemonic! You need it to recover wallets.`);
}

main().catch(console.error);
