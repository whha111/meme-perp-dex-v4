/**
 * Smart Contract Addresses and ABIs for MEME Perp DEX
 */

import { type Address } from "viem";
import TOKEN_FACTORY_ABI_IMPORT from "../abis/TokenFactory.json";

// Export TokenFactory ABI (extract .abi from Foundry JSON format)
export const TOKEN_FACTORY_ABI = TOKEN_FACTORY_ABI_IMPORT.abi;

/**
 * Deployed Contract Addresses (BSC Mainnet)
 *
 * All addresses MUST be set via NEXT_PUBLIC_* environment variables.
 * No fallback values — if an address is missing, the app will show warnings.
 * Set addresses in .env.local (dev) or docker-compose build args (production).
 */
export const CONTRACTS = {
  // TokenFactory - Pump.fun 风格 Bonding Curve 代币工厂
  TOKEN_FACTORY: (process.env.NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS || "") as Address,

  // Platform tokens
  MEME_TOKEN: (process.env.NEXT_PUBLIC_MEME_TOKEN_ADDRESS || "") as Address,
  LP_TOKEN_AMM: (process.env.NEXT_PUBLIC_AMM_LP_TOKEN_ADDRESS || "") as Address,
  LP_TOKEN_LENDING: (process.env.NEXT_PUBLIC_LP_TOKEN_ADDRESS || "") as Address,

  // Perpetual trading contracts
  SETTLEMENT: (process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS || "") as Address,
  VAULT: (process.env.NEXT_PUBLIC_VAULT_ADDRESS || "") as Address,
  PRICE_FEED: (process.env.NEXT_PUBLIC_PRICE_FEED_ADDRESS || "") as Address,
  RISK_MANAGER: (process.env.NEXT_PUBLIC_RISK_MANAGER_ADDRESS || "") as Address,
  POSITION_MANAGER: (process.env.NEXT_PUBLIC_POSITION_MANAGER_ADDRESS || "") as Address,
  INSURANCE_FUND: (process.env.NEXT_PUBLIC_INSURANCE_FUND_ADDRESS || "") as Address,
  CONTRACT_REGISTRY: (process.env.NEXT_PUBLIC_CONTRACT_REGISTRY_ADDRESS || "") as Address,

  // Stablecoins
  USDT: (process.env.NEXT_PUBLIC_USDT_ADDRESS || "") as Address,
  USDC: (process.env.NEXT_PUBLIC_USDC_ADDRESS || "") as Address,
  USD1: (process.env.NEXT_PUBLIC_USD1_ADDRESS || "") as Address,
  WETH: (process.env.NEXT_PUBLIC_WETH_ADDRESS || "") as Address, // WBNB on BSC Mainnet

  // SettlementV2 (dYdX-style Merkle Withdrawal System)
  SETTLEMENT_V2: (process.env.NEXT_PUBLIC_SETTLEMENT_V2_ADDRESS || "") as Address,

  // PerpVault (GMX-style LP pool)
  PERP_VAULT: (process.env.NEXT_PUBLIC_PERP_VAULT_ADDRESS || "") as Address,

  // Other contracts
  AMM: (process.env.NEXT_PUBLIC_AMM_ADDRESS || "") as Address,
  LENDING_POOL: (process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS || "") as Address,
  FUNDING_RATE: (process.env.NEXT_PUBLIC_FUNDING_RATE_ADDRESS || "") as Address,
  LIQUIDATION: (process.env.NEXT_PUBLIC_LIQUIDATION_ADDRESS || "") as Address,
  CONTRACT_SPEC: (process.env.NEXT_PUBLIC_CONTRACT_SPEC_ADDRESS || "") as Address,
  ROUTER: (process.env.NEXT_PUBLIC_ROUTER_ADDRESS || "") as Address,

} as const;

/**
 * Network Configuration
 */
export const NETWORK_CONFIG = {
  CHAIN_ID: parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "56"),
  CHAIN_NAME: parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "56") === 56 ? "BSC Mainnet" : "BSC Testnet",
  BLOCK_EXPLORER: process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "https://bscscan.com",
  RPC_URL: process.env.NEXT_PUBLIC_BSC_RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/",
};

/**
 * AMM Contract ABI (Swap Functions)
 */
export const AMM_ABI = [
  // View Functions
  {
    inputs: [],
    name: "isActive",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getSpotPrice",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getReserves",
    outputs: [
      { name: "bnb", type: "uint256" },
      { name: "meme", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "isBuy", type: "bool" },
      { name: "amountIn", type: "uint256" },
    ],
    name: "getAmountOut",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "isBuy", type: "bool" },
      { name: "amountIn", type: "uint256" },
    ],
    name: "getPriceImpact",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "swapFee",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // Write Functions
  {
    inputs: [{ name: "minAmountOut", type: "uint256" }],
    name: "swapBNBForMeme",
    outputs: [{ type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { name: "memeAmount", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
    ],
    name: "swapMemeForBNB",
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Events
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "isBuy", type: "bool" },
      { indexed: false, name: "amountIn", type: "uint256" },
      { indexed: false, name: "amountOut", type: "uint256" },
      { indexed: false, name: "fee", type: "uint256" },
    ],
    name: "Swap",
    type: "event",
  },
] as const;

/**
 * PriceFeed ABI
 */
export const PRICE_FEED_ABI = [
  {
    inputs: [],
    name: "getMarkPrice",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "token", type: "address" }],
    name: "getTokenMarkPrice",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getSpotPrice",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "token", type: "address" }],
    name: "getTokenSpotPrice",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // TWAP functions removed - 内盘合约100%硬锚现货价格，不需要TWAP
  {
    inputs: [{ name: "token", type: "address" }],
    name: "isTokenSupported",
    outputs: [{ type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "lastPrice",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "lastUpdateTime",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * ERC20 ABI (for Token Approval)
 */
export const ERC20_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * SettlementV2 ABI (Merkle Withdrawal System)
 */
export const SETTLEMENT_V2_ABI = [
  {
    inputs: [{ name: "amount", type: "uint256" }],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "depositFor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "depositBNB",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ name: "user", type: "address" }],
    name: "depositBNBFor",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "userEquity", type: "uint256" },
      { name: "merkleProof", type: "bytes32[]" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    name: "fastWithdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "userDeposits",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "collateralToken",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "currentStateRoot",
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "platformSigner",
    outputs: [{ type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "withdrawalNonces",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  // Events
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
    name: "Deposited",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: "user", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "nonce", type: "uint256" },
    ],
    name: "Withdrawn",
    type: "event",
  },
] as const;

/**
 * Helper function to get block explorer URL
 */
export function getExplorerUrl(addressOrTx: string, type: "address" | "tx" = "address"): string {
  return `${NETWORK_CONFIG.BLOCK_EXPLORER}/${type}/${addressOrTx}`;
}

/**
 * PancakeSwap V2 integration for graduated tokens
 */
export function getPancakeSwapUrl(tokenAddress: string): string {
  const chainParam = NETWORK_CONFIG.CHAIN_ID === 56 ? "bsc" : "bscTestnet";
  return `https://pancakeswap.finance/swap?chain=${chainParam}&outputCurrency=${tokenAddress}`;
}

/**
 * Check if contracts are configured
 */
export function areContractsConfigured(): boolean {
  // Check all critical contract addresses are set (not empty strings)
  const criticalContracts = [
    CONTRACTS.SETTLEMENT_V2,
    CONTRACTS.PERP_VAULT,
    CONTRACTS.TOKEN_FACTORY,
    CONTRACTS.PRICE_FEED,
    CONTRACTS.WETH,
  ];
  return criticalContracts.every((addr) => addr && addr !== ("" as Address));
}

/**
 * Get contract configuration for debugging
 */
export function getContractConfig() {
  return {
    contracts: CONTRACTS,
    network: NETWORK_CONFIG,
    configured: areContractsConfigured(),
  };
}
