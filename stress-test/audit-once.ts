/**
 * One-shot fund audit — run independently to verify fund conservation
 *
 * Usage: bun run audit-once.ts
 */
import { loadWallets } from "./utils/wallet-manager.js";
import { FundAuditor } from "./monitors/fund-auditor.js";

async function main() {
  const wallets = loadWallets(200, 100);
  const auditor = new FundAuditor(wallets);

  console.log("Running one-shot fund conservation audit...\n");
  const snapshot = await auditor.runOnce();

  console.log("\n=== Audit Result ===");
  console.log(JSON.stringify(snapshot, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));

  process.exit(snapshot.pass ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
