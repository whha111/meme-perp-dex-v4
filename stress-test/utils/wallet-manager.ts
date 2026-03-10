/**
 * Wallet Manager
 *
 * Loads wallets from two sources (main-wallets.json + external market-maker wallets),
 * merges them into a unified 300-wallet pool, and assigns to spot/perp groups.
 */
import { readFileSync } from "fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { WALLET_SOURCES, WALLET_GROUPS } from "../config.js";

// ── Types ──────────────────────────────────────────────────────

export interface StressWallet {
  index: number;
  address: Address;
  privateKey: Hex;
  group: "spot" | "perp";
  nonce: bigint; // Tracked locally, synced from chain periodically
}

// ── Wallet Loading ─────────────────────────────────────────────

interface MainWalletEntry {
  index: number;
  address: string;
  privateKey: string;
}

interface ExtendedWalletsFile {
  wallets: Array<{ privateKey: string; address: string; index: number }>;
  count: number;
}

function loadMainWallets(): MainWalletEntry[] {
  const raw = readFileSync(WALLET_SOURCES.main, "utf-8");
  return JSON.parse(raw) as MainWalletEntry[];
}

function loadExtendedWallets(): ExtendedWalletsFile {
  const raw = readFileSync(WALLET_SOURCES.extended, "utf-8");
  return JSON.parse(raw) as ExtendedWalletsFile;
}

/**
 * Load and merge wallets from both sources.
 *
 * Strategy: Main wallets have ~0.003 ETH each (funded and reliable).
 * Extended wallets are used as overflow only if needed.
 *
 * Allocation:
 * - Main wallets first → spot + perp groups (funded, on-chain tx)
 * - Extended wallets as overflow if main exhausted
 */
export function loadWallets(
  spotCount: number = WALLET_GROUPS.spot.count,
  perpCount: number = WALLET_GROUPS.perp.count,
): StressWallet[] {
  const mainWallets = loadMainWallets();
  const extendedFile = loadExtendedWallets();
  const extendedWallets = extendedFile.wallets;

  // Pool: main first (funded ~0.003 ETH each), then extended as overflow
  const allSources = [
    ...mainWallets.map(w => ({ address: w.address, privateKey: w.privateKey })),
    ...extendedWallets.map(w => ({ address: w.address, privateKey: w.privateKey })),
  ];

  const wallets: StressWallet[] = [];
  let idx = 0;

  // Assign spot group (first spotCount from pool)
  for (let i = 0; i < spotCount && idx < allSources.length; i++, idx++) {
    const w = allSources[idx];
    wallets.push({
      index: i,
      address: w.address as Address,
      privateKey: w.privateKey as Hex,
      group: "spot",
      nonce: 0n,
    });
  }

  // Assign perp group (next perpCount from pool)
  for (let i = 0; i < perpCount && idx < allSources.length; i++, idx++) {
    const w = allSources[idx];
    wallets.push({
      index: spotCount + i,
      address: w.address as Address,
      privateKey: w.privateKey as Hex,
      group: "perp",
      nonce: 0n,
    });
  }

  const spotLoaded = wallets.filter(w => w.group === "spot").length;
  const perpLoaded = wallets.filter(w => w.group === "perp").length;
  console.log(`[WalletManager] Loaded ${wallets.length} wallets (${spotLoaded} spot + ${perpLoaded} perp) from ${Math.min(idx, mainWallets.length)} main + ${Math.max(0, idx - mainWallets.length)} extended`);
  return wallets;
}

/** Get wallets by group */
export function getSpotWallets(wallets: StressWallet[]): StressWallet[] {
  return wallets.filter(w => w.group === "spot");
}

export function getPerpWallets(wallets: StressWallet[]): StressWallet[] {
  return wallets.filter(w => w.group === "perp");
}

/** Pick N random wallets from a group */
export function pickRandom(wallets: StressWallet[], count: number): StressWallet[] {
  const shuffled = [...wallets].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, wallets.length));
}

/** Random integer in [min, max] inclusive */
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random bigint in [min, max] */
export function randBigInt(min: bigint, max: bigint): bigint {
  const range = max - min;
  return min + BigInt(Math.floor(Math.random() * Number(range)));
}
