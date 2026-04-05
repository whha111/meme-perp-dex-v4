/**
 * 派生钱包管理模块
 *
 * 功能:
 * 1. 生成派生钱包
 * 2. 加密存储私钥
 * 3. 交易授权 (Session Key)
 * 4. 导出私钥
 */

import { Wallet } from "ethers";
import { createWalletClient, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { v4 as uuidv4 } from "uuid";
import { rpcTransport } from "../config";
import { encryptPrivateKey, decryptPrivateKey, generateSessionId, hashPassword, verifyPassword } from "../utils/crypto";
import { logger } from "../utils/logger";
import { getRedisClient, Keys, WalletRepo } from "../database/redis";
import type { TradingSession, SessionPermissions, SessionLimits } from "../types";

// ============================================================
// In-memory session cache: derivedAddress → sessionId
// ============================================================

const activeSessionByDerived = new Map<Address, string>();

/**
 * 根据派生钱包地址获取活跃的 sessionId
 * 先查内存缓存，miss 则回退到 Redis 扫描 userSessions
 */
export async function getActiveSessionForDerived(derivedAddress: Address): Promise<string | undefined> {
  const normalized = derivedAddress.toLowerCase() as Address;

  // 快路径: 内存缓存
  const cached = activeSessionByDerived.get(normalized);
  if (cached) return cached;

  try {
    const client = getRedisClient();

    // 路径 1: 查专用反向索引 derived_session:{addr}
    const directSessionId = await client.get(`derived_session:${normalized}`);
    if (directSessionId) {
      const sessionData = await client.hgetall(Keys.session(directSessionId));
      if (sessionData && Object.keys(sessionData).length > 0) {
        activeSessionByDerived.set(normalized, directSessionId);
        logger.info("Wallet", `Restored session from Redis index for ${normalized.slice(0, 10)}`);
        return directSessionId;
      }
    }

    // 路径 2: 反向索引不存在 (旧 session)，通过 wallet → userSessions 查找
    // 先扫描所有 wallet:{user} 找到 derivedAddress 匹配的 mainWallet
    const allDerived = await client.smembers(Keys.allWallets());
    for (const dw of allDerived) {
      if (dw.toLowerCase() !== normalized) continue;
      // 找到了这个 derived wallet，现在需要找它的 mainWallet
      // 遍历所有 wallet: keys 匹配 derivedAddress
      // wallet:{mainWallet} → { derivedAddress, ... }
      // 用 SCAN 查找所有 wallet:* keys
      let cursor = "0";
      do {
        const [nextCursor, keys] = await client.scan(cursor, "MATCH", "wallet:*", "COUNT", 100);
        cursor = nextCursor;
        for (const wKey of keys) {
          const walletData = await client.hgetall(wKey);
          if (walletData.derivedAddress?.toLowerCase() === normalized) {
            // 找到 mainWallet，查它的 sessions
            const mainWallet = walletData.userAddress as Address;
            const sessionIds = await client.smembers(Keys.userSessions(mainWallet));
            for (const sid of sessionIds) {
              const sData = await client.hgetall(Keys.session(sid));
              if (sData && sData.sessionKey?.toLowerCase() === normalized) {
                activeSessionByDerived.set(normalized, sid);
                // 补写反向索引，下次就不用扫描了
                await client.set(`derived_session:${normalized}`, sid);
                if (sData.expiresAt) {
                  await client.expireat(`derived_session:${normalized}`, parseInt(sData.expiresAt));
                }
                logger.info("Wallet", `Found session via wallet scan for ${normalized.slice(0, 10)}: ${sid.slice(0, 8)}...`);
                return sid;
              }
            }
          }
        }
      } while (cursor !== "0");
      break; // 已经匹配到 derived wallet，不需要继续
    }
  } catch (e) {
    logger.error("Wallet", "Failed to lookup session from Redis:", e);
  }

  return undefined;
}

// ============================================================
// Types
// ============================================================

interface StoredWallet {
  userAddress: Address;
  derivedAddress: Address;
  encryptedPrivateKey: string;
  salt: string;
  passwordHash: string;
  createdAt: number;
}

// ============================================================
// Wallet Management
// ============================================================

/**
 * 创建派生钱包
 */
export async function createDerivedWallet(
  userAddress: Address,
  tradingPassword: string
): Promise<{ derivedAddress: Address }> {
  const client = getRedisClient();
  const walletKey = Keys.wallet(userAddress);

  // 检查是否已存在
  const existing = await client.hgetall(walletKey);
  if (existing && Object.keys(existing).length > 0) {
    throw new Error("Wallet already exists for this user");
  }

  // 生成新钱包
  const wallet = Wallet.createRandom();
  const derivedAddress = wallet.address.toLowerCase() as Address;
  const privateKey = wallet.privateKey;

  // 加密私钥
  const { encrypted, salt } = await encryptPrivateKey(privateKey, tradingPassword);
  const passwordHash = await hashPassword(tradingPassword, salt);

  // 存储
  const storedWallet: StoredWallet = {
    userAddress: userAddress.toLowerCase() as Address,
    derivedAddress,
    encryptedPrivateKey: encrypted,
    salt,
    passwordHash,
    createdAt: Date.now(),
  };

  await client.hset(walletKey, storedWallet as Record<string, string>);

  // 添加到派生钱包追踪列表 (用于事件监听)
  await WalletRepo.addDerivedWallet(derivedAddress);

  logger.info("Wallet", `Created derived wallet for ${userAddress}: ${derivedAddress}`);

  // 清除内存中的私钥
  // (JavaScript 无法真正清除，但可以覆盖变量)

  return { derivedAddress };
}

/**
 * 获取派生钱包地址
 */
export async function getDerivedWallet(userAddress: Address): Promise<Address | null> {
  const client = getRedisClient();
  const walletKey = Keys.wallet(userAddress);
  const data = await client.hgetall(walletKey);

  if (!data || !data.derivedAddress) {
    return null;
  }

  return data.derivedAddress as Address;
}

/**
 * 验证交易密码
 */
export async function verifyTradingPassword(
  userAddress: Address,
  tradingPassword: string
): Promise<boolean> {
  const client = getRedisClient();
  const walletKey = Keys.wallet(userAddress);
  const data = await client.hgetall(walletKey);

  if (!data || !data.salt || !data.passwordHash) {
    return false;
  }

  return verifyPassword(tradingPassword, data.salt, data.passwordHash);
}

/**
 * 创建交易授权 (Session Key)
 */
export async function authorizeTrading(
  userAddress: Address,
  tradingPassword: string,
  expiresInSeconds: number,
  permissions: SessionPermissions,
  limits: SessionLimits,
  deviceId: string,
  ipAddress: string
): Promise<TradingSession> {
  // 验证密码
  const isValid = await verifyTradingPassword(userAddress, tradingPassword);
  if (!isValid) {
    throw new Error("Invalid trading password");
  }

  const client = getRedisClient();
  const walletKey = Keys.wallet(userAddress);
  const data = await client.hgetall(walletKey);

  // 解密私钥用于创建 session
  const privateKey = await decryptPrivateKey(
    data.encryptedPrivateKey,
    tradingPassword,
    data.salt
  );

  // 生成 session
  const sessionId = generateSessionId();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

  // 重新加密私钥用于 session (使用 session ID 作为密钥的一部分)
  const { encrypted: sessionEncryptedKey, salt: sessionSalt } = await encryptPrivateKey(
    privateKey,
    sessionId
  );

  const session: TradingSession = {
    trader: userAddress.toLowerCase() as Address,
    sessionId,
    sessionKey: data.derivedAddress as Address,
    encryptedSigningKey: `${sessionSalt}:${sessionEncryptedKey}`,
    expiresAt,
    deviceId,
    ipAddress,
    failedAttempts: 0,
    permissions,
    limits,
  };

  // 存储 session
  const sessionKey = Keys.session(sessionId);
  await client.hset(sessionKey, serializeSession(session));
  await client.expireat(sessionKey, expiresAt);

  // 添加到用户 sessions 列表
  await client.sadd(Keys.userSessions(userAddress), sessionId);

  logger.info("Wallet", `Created trading session for ${userAddress}, expires in ${expiresInSeconds}s`);

  // 缓存 derivedAddress → sessionId，供下单时自动充值使用 (内存 + Redis 双写)
  const derivedNormalized = (data.derivedAddress as Address).toLowerCase() as Address;
  activeSessionByDerived.set(derivedNormalized, sessionId);
  await client.set(`derived_session:${derivedNormalized}`, sessionId);
  await client.expireat(`derived_session:${derivedNormalized}`, expiresAt);

  return session;
}

/**
 * 验证交易授权
 */
export async function validateSession(sessionId: string): Promise<TradingSession | null> {
  const client = getRedisClient();
  const sessionKey = Keys.session(sessionId);
  const data = await client.hgetall(sessionKey);

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  const session = deserializeSession(data);

  // 检查是否过期
  if (session.expiresAt < Math.floor(Date.now() / 1000)) {
    await revokeSession(sessionId);
    return null;
  }

  return session;
}

/**
 * 获取签名私钥 (用于自动签名)
 */
export async function getSigningKey(sessionId: string): Promise<Hex | null> {
  const session = await validateSession(sessionId);
  if (!session) {
    return null;
  }

  try {
    // 格式: salt:iv:authTag:ciphertext — 前32字节hex是salt，剩余是加密数据
    const firstColon = session.encryptedSigningKey.indexOf(":");
    const salt = session.encryptedSigningKey.slice(0, firstColon);
    const encrypted = session.encryptedSigningKey.slice(firstColon + 1);
    const privateKey = await decryptPrivateKey(encrypted, sessionId, salt);
    return privateKey as Hex;
  } catch (error) {
    logger.error("Wallet", "Failed to decrypt signing key:", error);
    return null;
  }
}

/**
 * 撤销交易授权
 */
export async function revokeSession(sessionId: string): Promise<boolean> {
  const client = getRedisClient();
  const sessionKey = Keys.session(sessionId);
  const data = await client.hgetall(sessionKey);

  if (data && data.trader) {
    await client.srem(Keys.userSessions(data.trader as Address), sessionId);
  }

  await client.del(sessionKey);
  logger.info("Wallet", `Revoked session ${sessionId}`);
  return true;
}

/**
 * 撤销用户所有授权
 */
export async function revokeAllSessions(userAddress: Address): Promise<number> {
  const client = getRedisClient();
  const sessionIds = await client.smembers(Keys.userSessions(userAddress));

  for (const sessionId of sessionIds) {
    await client.del(Keys.session(sessionId));
  }

  await client.del(Keys.userSessions(userAddress));
  logger.info("Wallet", `Revoked ${sessionIds.length} sessions for ${userAddress}`);
  return sessionIds.length;
}

/**
 * 导出私钥 (需要交易密码)
 */
export async function exportPrivateKey(
  userAddress: Address,
  tradingPassword: string
): Promise<Hex> {
  const isValid = await verifyTradingPassword(userAddress, tradingPassword);
  if (!isValid) {
    throw new Error("Invalid trading password");
  }

  const client = getRedisClient();
  const walletKey = Keys.wallet(userAddress);
  const data = await client.hgetall(walletKey);

  if (!data || !data.encryptedPrivateKey) {
    throw new Error("Wallet not found");
  }

  const privateKey = await decryptPrivateKey(
    data.encryptedPrivateKey,
    tradingPassword,
    data.salt
  );

  return privateKey as Hex;
}

/**
 * 创建钱包客户端 (用于链上操作)
 */
export async function createWalletClientFromSession(sessionId: string) {
  const privateKey = await getSigningKey(sessionId);
  if (!privateKey) {
    throw new Error("Invalid session");
  }

  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: bsc,
    transport: rpcTransport,
  });
}

/**
 * 注册前端派生交易钱包的 session
 *
 * 前端通过 MetaMask 签名派生交易钱包 (keccak256(signature) → 私钥)。
 * 此函数接收该签名，在后端创建 session，使平台可以代替用户执行链上操作。
 *
 * @param walletSignature 前端的 MetaMask 签名 (用于派生私钥)
 * @param expiresInSeconds session 有效期
 * @returns { sessionId, tradingWalletAddress, expiresAt }
 */
export async function registerTradingSession(
  walletSignature: Hex,
  expiresInSeconds: number = 86400 // 默认 24 小时
): Promise<{ sessionId: string; tradingWalletAddress: Address; expiresAt: number }> {
  // 1. 从签名派生私钥 (与前端 tradingWallet.ts 逻辑一致)
  const derivedPrivateKey = keccak256(walletSignature);
  const account = privateKeyToAccount(derivedPrivateKey);
  const tradingWalletAddress = account.address.toLowerCase() as Address;

  // 2. 生成 session
  const client = getRedisClient();
  const sessionId = generateSessionId();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

  // 3. 加密私钥存储
  const { encrypted, salt } = await encryptPrivateKey(derivedPrivateKey, sessionId);

  const session: TradingSession = {
    trader: tradingWalletAddress,
    sessionId,
    sessionKey: tradingWalletAddress,
    encryptedSigningKey: `${salt}:${encrypted}`,
    expiresAt,
    deviceId: "frontend",
    ipAddress: "0.0.0.0",
    failedAttempts: 0,
    permissions: { canDeposit: true, canTrade: true, canWithdraw: false },
    limits: { maxSingleAmount: BigInt("100000000000"), dailyLimit: BigInt("1000000000000"), dailyUsed: 0n },
  };

  // 4. 存储 session
  const sessionKey = Keys.session(sessionId);
  await client.hset(sessionKey, serializeSession(session));
  await client.expireat(sessionKey, expiresAt);

  // 5. 缓存 derivedAddress → sessionId (内存 + Redis 双写)
  activeSessionByDerived.set(tradingWalletAddress, sessionId);
  await client.set(`derived_session:${tradingWalletAddress}`, sessionId);
  await client.expireat(`derived_session:${tradingWalletAddress}`, expiresAt);

  logger.info("Wallet", `Registered trading session for ${tradingWalletAddress.slice(0, 10)}, expires in ${expiresInSeconds}s`);

  return { sessionId, tradingWalletAddress, expiresAt };
}

// ============================================================
// Serialization
// ============================================================

function serializeSession(session: TradingSession): Record<string, string> {
  return {
    trader: session.trader,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    encryptedSigningKey: session.encryptedSigningKey,
    expiresAt: session.expiresAt.toString(),
    deviceId: session.deviceId,
    ipAddress: session.ipAddress,
    failedAttempts: session.failedAttempts.toString(),
    canDeposit: session.permissions.canDeposit.toString(),
    canTrade: session.permissions.canTrade.toString(),
    canWithdraw: session.permissions.canWithdraw.toString(),
    maxSingleAmount: session.limits.maxSingleAmount.toString(),
    dailyLimit: session.limits.dailyLimit.toString(),
    dailyUsed: session.limits.dailyUsed.toString(),
  };
}

function deserializeSession(data: Record<string, string>): TradingSession {
  return {
    trader: data.trader as Address,
    sessionId: data.sessionId,
    sessionKey: data.sessionKey as Address,
    encryptedSigningKey: data.encryptedSigningKey,
    expiresAt: parseInt(data.expiresAt),
    deviceId: data.deviceId,
    ipAddress: data.ipAddress,
    failedAttempts: parseInt(data.failedAttempts || "0"),
    permissions: {
      canDeposit: data.canDeposit === "true",
      canTrade: data.canTrade === "true",
      canWithdraw: data.canWithdraw === "true",
    },
    limits: {
      maxSingleAmount: BigInt(data.maxSingleAmount || "0"),
      dailyLimit: BigInt(data.dailyLimit || "0"),
      dailyUsed: BigInt(data.dailyUsed || "0"),
    },
  };
}

export default {
  createDerivedWallet,
  getDerivedWallet,
  verifyTradingPassword,
  authorizeTrading,
  validateSession,
  getSigningKey,
  getActiveSessionForDerived,
  registerTradingSession,
  revokeSession,
  revokeAllSessions,
  exportPrivateKey,
  createWalletClientFromSession,
};
