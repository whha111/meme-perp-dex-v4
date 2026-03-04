/**
 * EIP-712 链 ID 配置
 */

// 支持的链 ID
export const CHAIN_ID_BSC_TESTNET = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "97");
export const CHAIN_ID_BSC_MAINNET = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "97");

/**
 * 验证链 ID 是否在白名单中
 */
export function isValidChainId(chainId: number): boolean {
  return chainId === CHAIN_ID_BSC_TESTNET || chainId === CHAIN_ID_BSC_MAINNET;
}

/**
 * 获取链名称用于显示
 */
export function getChainName(chainId: number): string {
  switch (chainId) {
    case CHAIN_ID_BSC_TESTNET:
      return "BSC Testnet";
    case CHAIN_ID_BSC_MAINNET:
      return "BSC Mainnet";
    default:
      return "Unknown";
  }
}
