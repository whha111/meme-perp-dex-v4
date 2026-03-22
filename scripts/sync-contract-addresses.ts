#!/usr/bin/env bun
/**
 * Contract Address Sync Script
 * ============================
 * Single Source of Truth for all contract addresses.
 *
 * After deploying new contracts, update the ADDRESSES object below,
 * then run: bun scripts/sync-contract-addresses.ts
 *
 * This script will update ALL config files automatically:
 *   1. backend/.env
 *   2. backend/src/matching/.env
 *   3. backend/configs/config.yaml
 *   4. frontend/.env.local
 *   5. testnet/.env.testnet
 *   6. docker-compose.yml (chain_id + RPC defaults)
 *
 * Usage:
 *   bun scripts/sync-contract-addresses.ts          # dry-run (show changes)
 *   bun scripts/sync-contract-addresses.ts --apply   # apply changes
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ============================================================
// ★ SINGLE SOURCE OF TRUTH — Update addresses here after deploy
// ============================================================

const CHAIN = {
  id: 97,
  name: "BSC Testnet",
  rpc: "https://data-seed-prebsc-1-s1.binance.org:8545/",
  wss: "wss://bsc-testnet-rpc.publicnode.com",
  explorer: "https://testnet.bscscan.com",
};

// Read addresses from deployments/97.json — single source of truth
const deploymentsPath = resolve(import.meta.dir, "../deployments/97.json");
const deployments = JSON.parse(readFileSync(deploymentsPath, "utf-8"));
const C = deployments.contracts;

const ADDRESSES = {
  // Core — from deployments/97.json
  TOKEN_FACTORY: C.TokenFactory,
  SETTLEMENT: C.Settlement,
  SETTLEMENT_V2: C.SettlementV2,
  PERP_VAULT: C.PerpVault,
  PRICE_FEED: C.PriceFeed,
  POSITION_MANAGER: C.PositionManager,
  VAULT: C.Vault,
  LIQUIDATION: C.Liquidation,
  FUNDING_RATE: C.FundingRate,
  INSURANCE_FUND: C.InsuranceFund,
  RISK_MANAGER: C.RiskManager,
  CONTRACT_REGISTRY: C.ContractRegistry,
  ROUTER: C.PancakeRouterV2,

  // Tokens
  WBNB: C.WBNB,
  USDT: "0x050C988477F818b19a2f44Feee87a147D8f04DfF",
  USDC: "0xC9067996aF0b55414EF025002121Bf289D28c32B",
  USD1: "0x0A0FbEac39BeF8258795a742A82d170E8a255025",
  MEME_TOKEN: "0xB3D475Bf9c7427Fd1dC6494227803fE163320d69",
  AMM: "0x2c23046DC1595754528a10b8340F2AD8fdE05112",
  LENDING_POOL: "0x98a7665301C0dB32ceff957e1A2c505dF8384CA4",

  // External
  PANCAKESWAP_FACTORY: "0x6725F303b657a9451d8BA641348b6733DCBd9f4c",
  DEPLOYER: deployments.deployer,
} as const;

// ============================================================
// Sync logic
// ============================================================

const ROOT = resolve(import.meta.dir, "..");
const dryRun = !process.argv.includes("--apply");

let totalChanges = 0;

function updateEnvFile(relPath: string, mapping: Record<string, string>) {
  const absPath = resolve(ROOT, relPath);
  if (!existsSync(absPath)) {
    console.log(`  ⚠ SKIP (not found): ${relPath}`);
    return;
  }

  let content = readFileSync(absPath, "utf-8");
  let fileChanges = 0;

  for (const [key, value] of Object.entries(mapping)) {
    // Match KEY=<any 0x address or value> but preserve comments
    const regex = new RegExp(`^(${key}=)(.*)$`, "m");
    const match = content.match(regex);
    if (match && match[2] !== value) {
      console.log(`  ${relPath}: ${key}=${match[2]} → ${value}`);
      content = content.replace(regex, `$1${value}`);
      fileChanges++;
      totalChanges++;
    }
  }

  if (fileChanges > 0 && !dryRun) {
    writeFileSync(absPath, content);
  }
  if (fileChanges === 0) {
    console.log(`  ✅ ${relPath} — already up to date`);
  }
}

function updateYamlDefaults(relPath: string, mapping: Record<string, string>) {
  const absPath = resolve(ROOT, relPath);
  if (!existsSync(absPath)) {
    console.log(`  ⚠ SKIP (not found): ${relPath}`);
    return;
  }

  let content = readFileSync(absPath, "utf-8");
  let fileChanges = 0;

  for (const [yamlKey, newDefault] of Object.entries(mapping)) {
    // Match: key: "${ENV_VAR:-OLD_DEFAULT}" — use word boundary to avoid partial matches
    // e.g., "vault_address" should NOT match inside "perp_vault_address"
    const escapedKey = yamlKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `((?:^|\\s)${escapedKey}:\\s*"\\$\\{[^:]+:-)([^"]+)(\\}")`,
      "gm"
    );
    content = content.replace(regex, (match, prefix, oldDefault, suffix) => {
      if (oldDefault !== newDefault) {
        console.log(`  ${relPath}: ${yamlKey} default ${oldDefault} → ${newDefault}`);
        fileChanges++;
        totalChanges++;
        return `${prefix}${newDefault}${suffix}`;
      }
      return match;
    });
  }

  if (fileChanges > 0 && !dryRun) {
    writeFileSync(absPath, content);
  }
  if (fileChanges === 0) {
    console.log(`  ✅ ${relPath} — already up to date`);
  }
}

// ============================================================
// Main
// ============================================================

console.log(`\n🔄 Contract Address Sync ${dryRun ? "(DRY RUN)" : "(APPLYING)"}\n`);
console.log(`Chain: ${CHAIN.name} (${CHAIN.id})`);
console.log(`Source: scripts/sync-contract-addresses.ts\n`);

// 1. backend/.env
console.log("── backend/.env ──");
updateEnvFile("backend/.env", {
  CHAIN_ID: String(CHAIN.id),
  RPC_URL: CHAIN.rpc,
  SETTLEMENT_ADDRESS: ADDRESSES.SETTLEMENT,
  SETTLEMENT_V2_ADDRESS: ADDRESSES.SETTLEMENT_V2,
  TOKEN_FACTORY_ADDRESS: ADDRESSES.TOKEN_FACTORY,
  PRICE_FEED_ADDRESS: ADDRESSES.PRICE_FEED,
  LIQUIDATION_ADDRESS: ADDRESSES.LIQUIDATION,
  VAULT_ADDRESS: ADDRESSES.VAULT,
  POSITION_MANAGER_ADDRESS: ADDRESSES.POSITION_MANAGER,
  INSURANCE_FUND_ADDRESS: ADDRESSES.INSURANCE_FUND,
  PERP_VAULT_ADDRESS: ADDRESSES.PERP_VAULT,
  COLLATERAL_TOKEN_ADDRESS: ADDRESSES.WBNB,
});

// 2. backend/src/matching/.env
console.log("\n── backend/src/matching/.env ──");
updateEnvFile("backend/src/matching/.env", {
  CHAIN_ID: String(CHAIN.id),
  RPC_URL: CHAIN.rpc,
  SETTLEMENT_ADDRESS: ADDRESSES.SETTLEMENT,
  SETTLEMENT_V2_ADDRESS: ADDRESSES.SETTLEMENT_V2,
  TOKEN_FACTORY_ADDRESS: ADDRESSES.TOKEN_FACTORY,
  PRICE_FEED_ADDRESS: ADDRESSES.PRICE_FEED,
  LIQUIDATION_ADDRESS: ADDRESSES.LIQUIDATION,
  VAULT_ADDRESS: ADDRESSES.VAULT,
  POSITION_MANAGER_ADDRESS: ADDRESSES.POSITION_MANAGER,
  INSURANCE_FUND_ADDRESS: ADDRESSES.INSURANCE_FUND,
  PERP_VAULT_ADDRESS: ADDRESSES.PERP_VAULT,
  COLLATERAL_TOKEN_ADDRESS: ADDRESSES.WBNB,
  FUNDING_RATE_ADDRESS: ADDRESSES.FUNDING_RATE,
  RISK_MANAGER_ADDRESS: ADDRESSES.RISK_MANAGER,
  CONTRACT_REGISTRY_ADDRESS: ADDRESSES.CONTRACT_REGISTRY,
  ROUTER_ADDRESS: ADDRESSES.ROUTER,
  WETH_ADDRESS: ADDRESSES.WBNB,
  FEE_RECEIVER_ADDRESS: ADDRESSES.DEPLOYER,
});

// 3. frontend/.env.local
console.log("\n── frontend/.env.local ──");
updateEnvFile("frontend/.env.local", {
  NEXT_PUBLIC_CHAIN_ID: String(CHAIN.id),
  NEXT_PUBLIC_RPC_URL: CHAIN.rpc,
  NEXT_PUBLIC_BLOCK_EXPLORER_URL: CHAIN.explorer,
  NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS: ADDRESSES.TOKEN_FACTORY,
  NEXT_PUBLIC_SETTLEMENT_ADDRESS: ADDRESSES.SETTLEMENT,
  NEXT_PUBLIC_SETTLEMENT_V2_ADDRESS: ADDRESSES.SETTLEMENT_V2,
  NEXT_PUBLIC_VAULT_ADDRESS: ADDRESSES.VAULT,
  NEXT_PUBLIC_PRICE_FEED_ADDRESS: ADDRESSES.PRICE_FEED,
  NEXT_PUBLIC_POSITION_MANAGER_ADDRESS: ADDRESSES.POSITION_MANAGER,
  NEXT_PUBLIC_RISK_MANAGER_ADDRESS: ADDRESSES.RISK_MANAGER,
  NEXT_PUBLIC_INSURANCE_FUND_ADDRESS: ADDRESSES.INSURANCE_FUND,
  NEXT_PUBLIC_CONTRACT_REGISTRY_ADDRESS: ADDRESSES.CONTRACT_REGISTRY,
  NEXT_PUBLIC_ROUTER_ADDRESS: ADDRESSES.ROUTER,
  NEXT_PUBLIC_FUNDING_RATE_ADDRESS: ADDRESSES.FUNDING_RATE,
  NEXT_PUBLIC_LIQUIDATION_ADDRESS: ADDRESSES.LIQUIDATION,
  NEXT_PUBLIC_PERP_VAULT_ADDRESS: ADDRESSES.PERP_VAULT,
  NEXT_PUBLIC_WETH_ADDRESS: ADDRESSES.WBNB,
});

// 4. testnet/.env.testnet
console.log("\n── testnet/.env.testnet ──");
updateEnvFile("testnet/.env.testnet", {
  CHAIN_ID: String(CHAIN.id),
  RPC_URL: CHAIN.rpc,
  WSS_URL: CHAIN.wss,
  SETTLEMENT_ADDRESS: ADDRESSES.SETTLEMENT,
  SETTLEMENT_V2_ADDRESS: ADDRESSES.SETTLEMENT_V2,
  TOKEN_FACTORY_ADDRESS: ADDRESSES.TOKEN_FACTORY,
  PRICE_FEED_ADDRESS: ADDRESSES.PRICE_FEED,
  LIQUIDATION_ADDRESS: ADDRESSES.LIQUIDATION,
  VAULT_ADDRESS: ADDRESSES.VAULT,
  POSITION_MANAGER_ADDRESS: ADDRESSES.POSITION_MANAGER,
  INSURANCE_FUND_ADDRESS: ADDRESSES.INSURANCE_FUND,
  PERP_VAULT_ADDRESS: ADDRESSES.PERP_VAULT,
  FUNDING_RATE_ADDRESS: ADDRESSES.FUNDING_RATE,
  RISK_MANAGER_ADDRESS: ADDRESSES.RISK_MANAGER,
  CONTRACT_REGISTRY_ADDRESS: ADDRESSES.CONTRACT_REGISTRY,
  ROUTER_ADDRESS: ADDRESSES.ROUTER,
  WETH_ADDRESS: ADDRESSES.WBNB,
  FEE_RECEIVER_ADDRESS: ADDRESSES.DEPLOYER,
});

// 5. backend/configs/config.yaml
console.log("\n── backend/configs/config.yaml ──");
updateYamlDefaults("backend/configs/config.yaml", {
  rpc_url: CHAIN.rpc,
  router_address: ADDRESSES.ROUTER,
  vault_address: ADDRESSES.VAULT,
  position_address: ADDRESSES.POSITION_MANAGER,
  liquidation_address: ADDRESSES.LIQUIDATION,
  funding_rate_address: ADDRESSES.FUNDING_RATE,
  lending_pool_address: ADDRESSES.LENDING_POOL,
  price_feed_address: ADDRESSES.PRICE_FEED,
  risk_manager_address: ADDRESSES.RISK_MANAGER,
  meme_token_address: ADDRESSES.MEME_TOKEN,
  settlement_address: ADDRESSES.SETTLEMENT,
  settlement_v2_address: ADDRESSES.SETTLEMENT_V2,
  insurance_fund_address: ADDRESSES.INSURANCE_FUND,
  contract_registry_address: ADDRESSES.CONTRACT_REGISTRY,
  perp_vault_address: ADDRESSES.PERP_VAULT,
});

// Summary
console.log(`\n${"═".repeat(50)}`);
if (totalChanges === 0) {
  console.log("✅ All config files are already in sync!");
} else if (dryRun) {
  console.log(`⚠ ${totalChanges} changes needed. Run with --apply to update files.`);
} else {
  console.log(`✅ Applied ${totalChanges} changes across all config files.`);
}
console.log("");
