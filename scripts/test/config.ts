/**
 * 测试配置文件
 */
import { type Address, type Hex } from "viem";
import { bsc, bscTestnet } from "viem/chains";

// AUDIT-FIX DP-C01: Read key from env
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex;
if (!DEPLOYER_KEY) { console.error("Set DEPLOYER_PRIVATE_KEY env var"); process.exit(1); }

const chainId = parseInt(process.env.CHAIN_ID || "56");

export const CONFIG = {
  // RPC
  RPC_URL: process.env.RPC_URL || "https://bsc-dataseed.binance.org/",
  CHAIN: chainId === 56 ? bsc : bscTestnet,

  // 合约地址 (from env vars — no hardcoded fallbacks)
  SETTLEMENT: (process.env.SETTLEMENT_ADDRESS || "") as Address,
  CONTRACT_REGISTRY: (process.env.CONTRACT_REGISTRY_ADDRESS || "") as Address,
  USDT: (process.env.USDT_ADDRESS || "") as Address,
  WETH: (process.env.WETH_ADDRESS || "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c") as Address,  // WBNB
  TOKEN_FACTORY: (process.env.TOKEN_FACTORY_ADDRESS || "") as Address,
  PRICE_FEED: (process.env.PRICE_FEED_ADDRESS || "") as Address,

  // 测试钱包
  WALLETS_PATH: process.env.WALLETS_PATH || "",

  // Deployer (用作 Matcher)
  DEPLOYER_KEY,
  DEPLOYER_ADDRESS: (process.env.DEPLOYER_ADDRESS || "") as Address,

  // 后端 API
  API_URL: process.env.API_URL || "http://localhost:8080",
  MATCHING_ENGINE_URL: process.env.MATCHING_ENGINE_URL || "http://localhost:8081",

  // EIP-712 Domain
  EIP712_DOMAIN: {
    name: "MemePerp",
    version: "1",
    chainId,
    verifyingContract: (process.env.SETTLEMENT_ADDRESS || "") as Address,
  },

  // 精度
  PRECISION: 1000000n, // 6 decimals for USDT
  LEVERAGE_PRECISION: 10000n,
};

export const SETTLEMENT_ABI = [
  // User functions
  { inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], name: "deposit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "incrementNonce", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "enabled", type: "bool" }], name: "setSequentialNonceMode", outputs: [], stateMutability: "nonpayable", type: "function" },

  // Matcher functions
  { inputs: [{ name: "matcher", type: "address" }, { name: "authorized", type: "bool" }], name: "setAuthorizedMatcher", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "token", type: "address" }, { name: "price", type: "uint256" }], name: "updatePrice", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "token", type: "address" }, { name: "rate", type: "int256" }], name: "updateFundingRate", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [{
      components: [
        { components: [{ name: "trader", type: "address" }, { name: "token", type: "address" }, { name: "isLong", type: "bool" }, { name: "size", type: "uint256" }, { name: "leverage", type: "uint256" }, { name: "price", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "orderType", type: "uint8" }], name: "longOrder", type: "tuple" },
        { name: "longSignature", type: "bytes" },
        { components: [{ name: "trader", type: "address" }, { name: "token", type: "address" }, { name: "isLong", type: "bool" }, { name: "size", type: "uint256" }, { name: "leverage", type: "uint256" }, { name: "price", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "orderType", type: "uint8" }], name: "shortOrder", type: "tuple" },
        { name: "shortSignature", type: "bytes" },
        { name: "matchPrice", type: "uint256" },
        { name: "matchSize", type: "uint256" },
      ],
      name: "pairs",
      type: "tuple[]"
    }],
    name: "settleBatch",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  { inputs: [{ name: "pairIds", type: "uint256[]" }, { name: "exitPrices", type: "uint256[]" }], name: "closePairsBatch", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "pairIds", type: "uint256[]" }], name: "settleFundingBatch", outputs: [], stateMutability: "nonpayable", type: "function" },

  // User position functions
  { inputs: [{ name: "pairId", type: "uint256" }], name: "closePair", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "pairId", type: "uint256" }], name: "liquidate", outputs: [], stateMutability: "nonpayable", type: "function" },

  // View functions
  { inputs: [{ name: "user", type: "address" }], name: "getUserBalance", outputs: [{ name: "available", type: "uint256" }, { name: "locked", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "user", type: "address" }], name: "nonces", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "pairId", type: "uint256" }], name: "getPairedPosition", outputs: [{ components: [{ name: "pairId", type: "uint256" }, { name: "longTrader", type: "address" }, { name: "shortTrader", type: "address" }, { name: "token", type: "address" }, { name: "size", type: "uint256" }, { name: "entryPrice", type: "uint256" }, { name: "longCollateral", type: "uint256" }, { name: "shortCollateral", type: "uint256" }, { name: "longLeverage", type: "uint256" }, { name: "shortLeverage", type: "uint256" }, { name: "openTime", type: "uint256" }, { name: "accFundingLong", type: "int256" }, { name: "accFundingShort", type: "int256" }, { name: "status", type: "uint8" }], type: "tuple" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "user", type: "address" }], name: "getUserPairIds", outputs: [{ type: "uint256[]" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "pairId", type: "uint256" }], name: "getUnrealizedPnL", outputs: [{ name: "longPnL", type: "int256" }, { name: "shortPnL", type: "int256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "pairId", type: "uint256" }], name: "canLiquidate", outputs: [{ name: "liquidateLong", type: "bool" }, { name: "liquidateShort", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "token", type: "address" }], name: "tokenPrices", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "token", type: "address" }], name: "fundingRates", outputs: [{ type: "int256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "nextPairId", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "matcher", type: "address" }], name: "authorizedMatchers", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "insuranceFund", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "feeRate", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "getSupportedTokens", outputs: [{ type: "address[]" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },

  // Admin functions
  { inputs: [{ name: "_insuranceFund", type: "address" }], name: "setInsuranceFund", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "token", type: "address" }, { name: "decimals", type: "uint8" }], name: "addSupportedToken", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

export const ERC20_ABI = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transfer", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "mint", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

export const WETH_ABI = [
  { inputs: [], name: "deposit", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ name: "wad", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transfer", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "symbol", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
] as const;

export const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "token", type: "address" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "leverage", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "orderType", type: "uint8" },
  ],
};
