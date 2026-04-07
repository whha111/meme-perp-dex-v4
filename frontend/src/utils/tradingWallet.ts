/**
 * 签名派生交易钱包
 *
 * 原理：
 * 1. 用户用主钱包签名一条固定消息
 * 2. 从签名派生出私钥 (keccak256)
 * 3. 得到一个真正的 EOA 钱包（有私钥）
 *
 * 优势：
 * - 完全去中心化（有真实私钥）
 * - 用户可以导出私钥
 * - 只要有主钱包，随时可以恢复
 * - 不需要信任任何合约
 */

import { keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// 签名消息的版本号，如果需要迁移可以更新
const SIGNING_MESSAGE_VERSION = "v1";

// 用于派生交易钱包的签名消息
const getSigningMessage = (chainId: number): string => {
  return `DEXI Trading Wallet ${SIGNING_MESSAGE_VERSION}\n\nChain ID: ${chainId}\n\nThis signature will be used to generate your trading wallet. You can always recover this wallet by signing the same message with your main wallet.\n\nThis request will not trigger a blockchain transaction or cost any gas fees.`;
};

/**
 * 从签名派生私钥
 * @param signature - 用户签名
 * @returns 派生的私钥
 */
export function derivePrivateKey(signature: Hex): Hex {
  // 使用 keccak256 哈希签名得到私钥
  return keccak256(signature);
}

/**
 * 从签名创建交易钱包
 * @param signature - 用户签名
 * @returns 交易钱包账户
 */
export function createTradingWallet(signature: Hex) {
  const privateKey = derivePrivateKey(signature);
  const account = privateKeyToAccount(privateKey);

  return {
    address: account.address,
    privateKey,
    account,
  };
}

/**
 * 获取签名消息
 * @param chainId - 链 ID
 * @returns 签名消息
 */
export function getWalletSigningMessage(chainId: number): string {
  return getSigningMessage(chainId);
}

// LocalStorage 键名
const TRADING_WALLET_STORAGE_KEY = "memeperp_trading_wallet";

interface StoredWalletData {
  mainWallet: Address;
  tradingWallet: Address;
  signature: Hex;
  chainId: number;
  createdAt: number;
}

/**
 * 保存交易钱包到本地存储
 * 注意：签名存储在本地，用户应该导出私钥作为备份
 */
export function saveTradingWallet(
  mainWallet: Address,
  tradingWallet: Address,
  signature: Hex,
  chainId: number
): void {
  const data: StoredWalletData = {
    mainWallet,
    tradingWallet,
    signature,
    chainId,
    createdAt: Date.now(),
  };

  localStorage.setItem(
    `${TRADING_WALLET_STORAGE_KEY}_${mainWallet.toLowerCase()}`,
    JSON.stringify(data)
  );
}

/**
 * 从本地存储加载交易钱包
 */
export function loadTradingWallet(mainWallet: Address): StoredWalletData | null {
  try {
    const stored = localStorage.getItem(
      `${TRADING_WALLET_STORAGE_KEY}_${mainWallet.toLowerCase()}`
    );

    if (!stored) return null;

    const data = JSON.parse(stored) as StoredWalletData;

    // 验证数据完整性
    if (!data.mainWallet || !data.tradingWallet || !data.signature) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * 清除本地存储的交易钱包
 */
export function clearTradingWallet(mainWallet: Address): void {
  localStorage.removeItem(
    `${TRADING_WALLET_STORAGE_KEY}_${mainWallet.toLowerCase()}`
  );
}

/**
 * 导出私钥（用于用户备份）
 */
export function exportPrivateKey(signature: Hex): {
  privateKey: Hex;
  warning: string;
} {
  const privateKey = derivePrivateKey(signature);

  return {
    privateKey,
    warning: "⚠️ 请妥善保管此私钥！任何拥有此私钥的人都可以控制你的交易钱包中的资金。",
  };
}

/**
 * 验证交易钱包是否匹配
 */
export function verifyTradingWallet(
  signature: Hex,
  expectedAddress: Address
): boolean {
  const wallet = createTradingWallet(signature);
  return wallet.address.toLowerCase() === expectedAddress.toLowerCase();
}
