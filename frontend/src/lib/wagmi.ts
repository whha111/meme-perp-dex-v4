import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { bsc, bscTestnet } from "wagmi/chains";
import { http } from "viem";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";

// =====================================================
// 🔐 MemePerpDEX Configuration (BSC)
// =====================================================

const isDev = process.env.NODE_ENV === 'development';

// Determine default chain based on environment variable
const chainId = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "56", 10);
const isMainnet = chainId === 56;

// Get RPC URLs for both chains
const mainnetRpcUrl = process.env.NEXT_PUBLIC_BSC_MAINNET_RPC_URL || "https://bsc-dataseed.binance.org/";
const testnetRpcUrl = process.env.NEXT_PUBLIC_BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/";

// Get WalletConnect Project ID from environment
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// 使用统一验证工具
import { validateWalletConnectProjectId } from "./validators";
const isValidProjectId = projectId && validateWalletConnectProjectId(projectId);

// Log warning if no valid project ID (development only)
if (!isValidProjectId && isDev && typeof window !== 'undefined') {
  // Only log once, and only in browser console during development
  console.warn(
    "⚠️ WalletConnect Project ID not configured. Using injected wallet only."
  );
}

let configError: Error | null = null;
let config: ReturnType<typeof getDefaultConfig>;

try {
  if (isValidProjectId) {
    // 有效的 WalletConnect Project ID - 使用完整配置
    config = getDefaultConfig({
      appName: "MemePerpDEX",
      projectId: projectId,
      chains: [bsc, bscTestnet],
      transports: {
        [bsc.id]: http(mainnetRpcUrl),
        [bscTestnet.id]: http(testnetRpcUrl),
      },
      ssr: true,
    });
  } else {
    // 无效的 Project ID - 只使用注入钱包，跳过 WalletConnect 以避免网络请求延迟
    config = createConfig({
      chains: [bsc, bscTestnet],
      connectors: [
        injected({ shimDisconnect: true }),
      ],
      transports: {
        [bsc.id]: http(mainnetRpcUrl),
        [bscTestnet.id]: http(testnetRpcUrl),
      },
      ssr: true,
    }) as ReturnType<typeof getDefaultConfig>;
  }
} catch (error) {
  configError = error as Error;

  // Fallback config - 只使用注入钱包
  config = createConfig({
    chains: [bsc, bscTestnet],
    connectors: [
      injected({ shimDisconnect: true }),
    ],
    transports: {
      [bsc.id]: http(mainnetRpcUrl),
      [bscTestnet.id]: http(testnetRpcUrl),
    },
    ssr: true,
  }) as ReturnType<typeof getDefaultConfig>;
}

// Export the default chain based on environment (but both are available)
const targetChain = isMainnet ? bsc : bscTestnet;

export { config, configError, isValidProjectId, targetChain, isMainnet, bsc, bscTestnet };
