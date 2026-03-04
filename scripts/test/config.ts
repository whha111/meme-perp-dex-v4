/**
 * 测试配置文件
 */
import { type Address, type Hex } from "viem";
import { bscTestnet } from "viem/chains";

// AUDIT-FIX DP-C01: Read key from env
const DEPLOYER_KEY = (process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY) as Hex;
if (!DEPLOYER_KEY) { console.error("Set DEPLOYER_PRIVATE_KEY env var"); process.exit(1); }

export const CONFIG = {
  // RPC
  RPC_URL: "https://data-seed-prebsc-1-s1.binance.org:8545/",
  CHAIN: bscTestnet,

  // 合约地址 (V5 - 5分钟资金费)
  SETTLEMENT: "0xB06C32C7536EC5EAD101fEe2AD4005a5eedcB258" as Address,
  CONTRACT_REGISTRY: "0x8f6277275c4e11A42b3928B55e5653bB694D5A61" as Address,
  USDT: "0x2251A4dD878a0AF6d18B5F0CAE7FDF9fe85D8324" as Address,
  WETH: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" as Address,  // BSC Testnet WBNB
  TOKEN_FACTORY: "0xE0ddf67E89f5773c960Bc2329109815E8c66BAAe" as Address,
  PRICE_FEED: "0x70dAC8f7338fFF15CAB9cE01e896e56a6C2FcF0A" as Address,

  // 测试钱包
  WALLETS_PATH: "/Users/qinlinqiu/Desktop/Namespace/scripts/market-maker/wallets.json",

  // Deployer (用作 Matcher)
  DEPLOYER_KEY,
  DEPLOYER_ADDRESS: "0x5AF11d4784c3739cf2FD51Fdc272ae4957ADf7fE" as Address,

  // 后端 API
  API_URL: "http://localhost:8080",
  MATCHING_ENGINE_URL: "http://localhost:8081",

  // EIP-712 Domain
  EIP712_DOMAIN: {
    name: "MemePerp",
    version: "1",
    chainId: 97,
    verifyingContract: "0xB06C32C7536EC5EAD101fEe2AD4005a5eedcB258" as Address,
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
