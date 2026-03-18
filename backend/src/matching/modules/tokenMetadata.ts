/**
 * Token Metadata Module
 *
 * Manages token metadata storage and retrieval
 * - Logo URLs, descriptions, social links
 * - Creator information
 * - Token supply and graduation status
 */

import db from "../database";
import type { Address } from "viem";

// Get Redis client
const redis = db.getClient();

// ============================================================
// Types
// ============================================================

export interface TokenMetadata {
  instId: string;
  tokenAddress: Address;
  name: string;
  symbol: string;
  description?: string;
  logoUrl?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  creatorAddress: Address;
  totalSupply: string;
  initialBuyAmount?: string;
  isGraduated?: boolean;
  graduationTime?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTokenMetadataRequest {
  instId: string;
  tokenAddress: Address;
  name: string;
  symbol: string;
  description?: string;
  logoUrl?: string;
  imageUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  creatorAddress: Address;
  totalSupply: string;
  initialBuyAmount?: string;
}

// ============================================================
// Constants
// ============================================================

const METADATA_PREFIX = "token:metadata:";
const METADATA_LIST_KEY = "token:metadata:list";

// ============================================================
// Validation
// ============================================================

/**
 * Validate Ethereum address format
 */
function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate URL format
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize string input (prevent XSS)
 */
function sanitizeString(str: string): string {
  return str
    .replace(/[<>]/g, "") // Remove < and >
    .trim()
    .substring(0, 1000); // Max 1000 chars
}

/**
 * Validate token metadata
 */
function validateMetadata(data: CreateTokenMetadataRequest): { valid: boolean; error?: string } {
  // Required fields
  if (!data.instId || !data.tokenAddress || !data.name || !data.symbol || !data.creatorAddress) {
    return { valid: false, error: "Missing required fields: instId, tokenAddress, name, symbol, creatorAddress" };
  }

  // Validate addresses
  if (!isValidAddress(data.tokenAddress)) {
    return { valid: false, error: "Invalid tokenAddress format" };
  }

  if (!isValidAddress(data.creatorAddress)) {
    return { valid: false, error: "Invalid creatorAddress format" };
  }

  // Validate URLs (if provided)
  if (data.logoUrl && !isValidUrl(data.logoUrl)) {
    return { valid: false, error: "Invalid logoUrl format" };
  }

  if (data.imageUrl && !isValidUrl(data.imageUrl)) {
    return { valid: false, error: "Invalid imageUrl format" };
  }

  if (data.website && !isValidUrl(data.website)) {
    return { valid: false, error: "Invalid website format" };
  }

  // Validate twitter handle (if provided)
  if (data.twitter && !/^@?[\w]{1,15}$/.test(data.twitter)) {
    return { valid: false, error: "Invalid twitter handle" };
  }

  // Validate name and symbol length
  if (data.name.length > 100) {
    return { valid: false, error: "Name too long (max 100 characters)" };
  }

  if (data.symbol.length > 20) {
    return { valid: false, error: "Symbol too long (max 20 characters)" };
  }

  return { valid: true };
}

// ============================================================
// Storage Functions
// ============================================================

/**
 * Save or update token metadata
 */
export async function saveTokenMetadata(data: CreateTokenMetadataRequest): Promise<TokenMetadata> {
  // Validate input
  const validation = validateMetadata(data);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const now = new Date().toISOString();
  const key = `${METADATA_PREFIX}${data.instId}`;

  // Check if metadata already exists — merge to preserve fields from earlier saves
  const existing = await redis.get(key);
  const prev: Partial<TokenMetadata> = existing ? JSON.parse(existing) : {};
  const createdAt = prev.createdAt || now;

  // Sanitize string inputs. Merge: new non-empty values win, fall back to existing.
  const metadata: TokenMetadata = {
    instId: data.instId,
    tokenAddress: data.tokenAddress,
    name: sanitizeString(data.name),
    symbol: sanitizeString(data.symbol),
    description: data.description ? sanitizeString(data.description) : (prev.description || undefined),
    logoUrl: data.logoUrl || prev.logoUrl,
    imageUrl: data.imageUrl || prev.imageUrl,
    website: data.website || prev.website,
    twitter: data.twitter || prev.twitter,
    telegram: data.telegram || prev.telegram,
    discord: data.discord || prev.discord,
    creatorAddress: data.creatorAddress,
    totalSupply: data.totalSupply,
    initialBuyAmount: data.initialBuyAmount || prev.initialBuyAmount,
    isGraduated: prev.isGraduated || false,
    graduationTime: prev.graduationTime,
    createdAt,
    updatedAt: now,
  };

  // Save to Redis
  await redis.set(key, JSON.stringify(metadata));

  // Add to list (for getAllTokenMetadata)
  await redis.sadd(METADATA_LIST_KEY, data.instId);

  console.log(`[TokenMetadata] Saved metadata for ${data.symbol} (${data.instId})`);

  return metadata;
}

/**
 * Get token metadata by instId
 */
export async function getTokenMetadata(instId: string): Promise<TokenMetadata | null> {
  const key = `${METADATA_PREFIX}${instId}`;
  const data = await redis.get(key);

  if (!data) {
    return null;
  }

  return JSON.parse(data) as TokenMetadata;
}

/**
 * Get all token metadata
 */
export async function getAllTokenMetadata(): Promise<TokenMetadata[]> {
  // Get all instIds from the set
  const instIds = await redis.smembers(METADATA_LIST_KEY);

  if (instIds.length === 0) {
    return [];
  }

  // Get all metadata in parallel
  const keys = instIds.map((instId) => `${METADATA_PREFIX}${instId}`);
  const results = await redis.mget(...keys);

  // Parse and filter out nulls
  const metadata: TokenMetadata[] = [];
  for (const result of results) {
    if (result) {
      try {
        metadata.push(JSON.parse(result) as TokenMetadata);
      } catch (error) {
        console.error("[TokenMetadata] Failed to parse metadata:", error);
      }
    }
  }

  // Sort by createdAt (newest first)
  metadata.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return metadata;
}

/**
 * Delete token metadata
 */
export async function deleteTokenMetadata(instId: string): Promise<boolean> {
  const key = `${METADATA_PREFIX}${instId}`;

  // Remove from Redis
  const deleted = await redis.del(key);

  // Remove from list
  await redis.srem(METADATA_LIST_KEY, instId);

  console.log(`[TokenMetadata] Deleted metadata for ${instId}`);

  return deleted > 0;
}

/**
 * Update graduation status
 */
export async function updateGraduationStatus(
  instId: string,
  isGraduated: boolean,
  graduationTime?: number
): Promise<TokenMetadata | null> {
  const metadata = await getTokenMetadata(instId);

  if (!metadata) {
    return null;
  }

  metadata.isGraduated = isGraduated;
  metadata.graduationTime = graduationTime;
  metadata.updatedAt = new Date().toISOString();

  const key = `${METADATA_PREFIX}${instId}`;
  await redis.set(key, JSON.stringify(metadata));

  console.log(`[TokenMetadata] Updated graduation status for ${instId}: ${isGraduated}`);

  return metadata;
}

/**
 * Search tokens by name or symbol
 */
export async function searchTokens(query: string): Promise<TokenMetadata[]> {
  const allTokens = await getAllTokenMetadata();
  const lowerQuery = query.toLowerCase();

  return allTokens.filter(
    (token) =>
      token.name.toLowerCase().includes(lowerQuery) ||
      token.symbol.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get tokens by creator address
 */
export async function getTokensByCreator(creatorAddress: Address): Promise<TokenMetadata[]> {
  const allTokens = await getAllTokenMetadata();

  return allTokens.filter(
    (token) => token.creatorAddress.toLowerCase() === creatorAddress.toLowerCase()
  );
}
