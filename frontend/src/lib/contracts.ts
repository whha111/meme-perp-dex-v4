/**
 * Smart Contract Addresses and ABIs for MEME Perp DEX
 */

import { type Address } from "viem";
import TOKEN_FACTORY_ABI_IMPORT from "../abis/TokenFactory.json";

// Export TokenFactory ABI (extract .abi from Foundry JSON format)
export const TOKEN_FACTORY_ABI = TOKEN_FACTORY_ABI_IMPORT.abi;

/**
 * Deployed Contract Addresses (BSC Testnet)
 */
export const CONTRACTS = {
  // TokenFactory - Pump.fun 风格 Bonding Curve 代币工厂
  TOKEN_FACTORY: (process.env.NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS || "0x22276744bAF24eD503dB50Cc999a9c5AD62728cb") as Address,

  // Platform tokens
  MEME_TOKEN: (process.env.NEXT_PUBLIC_MEME_TOKEN_ADDRESS || "0xB3D475Bf9c7427Fd1dC6494227803fE163320d69") as Address,
  LP_TOKEN_AMM: (process.env.NEXT_PUBLIC_AMM_LP_TOKEN_ADDRESS || "0xef54701cab1B76701Aa8B607Bd561E14BD14Db24") as Address,
  LP_TOKEN_LENDING: (process.env.NEXT_PUBLIC_LP_TOKEN_ADDRESS || "0x0e422348A737D9ee57D3B8f17f750dA5743D51eB") as Address,

  // Perpetual trading contracts (2026-02-28)
  SETTLEMENT: (process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS || "0x63df8d6acF3f99Ae59Bee6184A5EB6beA8663eb7") as Address,
  VAULT: (process.env.NEXT_PUBLIC_VAULT_ADDRESS || "0xACE7014F60eF9c367E7fA5Dd80601A9945E6F4d1") as Address,
  PRICE_FEED: (process.env.NEXT_PUBLIC_PRICE_FEED_ADDRESS || "0xe2b22673fFBeB7A2a4617125E885C12EC072ee48") as Address,
  RISK_MANAGER: (process.env.NEXT_PUBLIC_RISK_MANAGER_ADDRESS || "0xd4fbB0f140d8909e73e3D91C897EBe66f01B15F9") as Address,
  POSITION_MANAGER: (process.env.NEXT_PUBLIC_POSITION_MANAGER_ADDRESS || "0x04C515CcFac80BFFF27E0c5A9113e515171057b6") as Address,
  INSURANCE_FUND: (process.env.NEXT_PUBLIC_INSURANCE_FUND_ADDRESS || "0x162CEbAe2013545D191360d13ceA5083E6fcE1a7") as Address,
  CONTRACT_REGISTRY: (process.env.NEXT_PUBLIC_CONTRACT_REGISTRY_ADDRESS || "0x6956c982aec9Ad08040b91417a313003879d0f48") as Address,

  // Stablecoins (MockUSDT/USDC - 可铸造测试币)
  USDT: (process.env.NEXT_PUBLIC_USDT_ADDRESS || "0x050C988477F818b19a2f44Feee87a147D8f04DfF") as Address,
  USDC: (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0xC9067996aF0b55414EF025002121Bf289D28c32B") as Address,
  USD1: (process.env.NEXT_PUBLIC_USD1_ADDRESS || "0x0A0FbEac39BeF8258795a742A82d170E8a255025") as Address,
  WETH: (process.env.NEXT_PUBLIC_WETH_ADDRESS || "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd") as Address, // WBNB on BSC Testnet

  // SettlementV2 (dYdX-style Merkle Withdrawal System - Redeployed 2026-02-28)
  SETTLEMENT_V2: (process.env.NEXT_PUBLIC_SETTLEMENT_V2_ADDRESS || "0x7fF9d60aE49F14bB604FeF1961910D7931067873") as Address,

  // PerpVault (GMX-style LP pool - Deployed 2026-02-28)
  PERP_VAULT: (process.env.NEXT_PUBLIC_PERP_VAULT_ADDRESS || "0x7F98ed779c3352f39b041C57d5B2C73F84dcAA75") as Address,

  // Other contracts
  AMM: (process.env.NEXT_PUBLIC_AMM_ADDRESS || "0x2c23046DC1595754528a10b8340F2AD8fdE05112") as Address,
  LENDING_POOL: (process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS || "0x98a7665301C0dB32ceff957e1A2c505dF8384CA4") as Address,
  FUNDING_RATE: (process.env.NEXT_PUBLIC_FUNDING_RATE_ADDRESS || "0x0a513bf3DE079Bf2439A5884583712bD014487aa") as Address,
  LIQUIDATION: (process.env.NEXT_PUBLIC_LIQUIDATION_ADDRESS || "0x322AeeD67C12c10684B134e1727866425dc75F1c") as Address,
  CONTRACT_SPEC: (process.env.NEXT_PUBLIC_CONTRACT_SPEC_ADDRESS || "0x6AB576624d66e3E60385851ab6Fc65262CEAFafA") as Address,
  ROUTER: (process.env.NEXT_PUBLIC_ROUTER_ADDRESS || "0xF15197BA411b578dafC7936C241bE9DD725c22BE") as Address,

} as const;

/**
 * Network Configuration
 */
export const NETWORK_CONFIG = {
  CHAIN_ID: parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || "97"),
  CHAIN_NAME: "BSC Testnet",
  BLOCK_EXPLORER: process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "https://testnet.bscscan.com",
  RPC_URL: process.env.NEXT_PUBLIC_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545/",
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
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "userEquity", type: "uint256" },
      { name: "merkleProof", type: "bytes32[]" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    name: "withdraw",
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
 * Check if contracts are configured
 */
export function areContractsConfigured(): boolean {
  return CONTRACTS.AMM !== ("" as Address) && CONTRACTS.MEME_TOKEN !== ("" as Address);
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
