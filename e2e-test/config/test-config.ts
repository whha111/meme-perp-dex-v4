/**
 * Central configuration for E2E tests
 * Reads from .env + deployments/97.json
 */
import { type Address, parseAbi } from "viem";
import deployments from "../../deployments/97.json";

// ═══════════════════════════════════════════════
// Environment
// ═══════════════════════════════════════════════
export const ENV = {
  RPC_URL: process.env.RPC_URL || "https://bsc-testnet-rpc.publicnode.com",
  CHAIN_ID: Number(process.env.CHAIN_ID || 97),
  FRONTEND_URL: process.env.FRONTEND_URL || "http://localhost:3000",
  ENGINE_URL: process.env.MATCHING_ENGINE_URL || "http://localhost:8081",
  BACKEND_URL: process.env.BACKEND_URL || "http://localhost:8080",
  MASTER_PRIVATE_KEY: process.env.MASTER_PRIVATE_KEY || "",
  MASTER_MNEMONIC: process.env.MASTER_MNEMONIC || "",
  DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY || "0x4698c351c4aead4844a41399b035e1177535db94a5418a79df07b7f0bf158776",
};

// ═══════════════════════════════════════════════
// Contract Addresses (from deployments/97.json — single source of truth)
// ═══════════════════════════════════════════════
export const CONTRACTS = {
  TokenFactory: deployments.contracts.TokenFactory as Address,
  Settlement: deployments.contracts.Settlement as Address,
  SettlementV2: deployments.contracts.SettlementV2 as Address,
  PriceFeed: deployments.contracts.PriceFeed as Address,
  PositionManager: deployments.contracts.PositionManager as Address,
  Vault: deployments.contracts.Vault as Address,
  PerpVault: deployments.contracts.PerpVault as Address,
  RiskManager: deployments.contracts.RiskManager as Address,
  FundingRate: deployments.contracts.FundingRate as Address,
  Liquidation: deployments.contracts.Liquidation as Address,
  InsuranceFund: deployments.contracts.InsuranceFund as Address,
  ContractRegistry: deployments.contracts.ContractRegistry as Address,
  WBNB: deployments.contracts.WBNB as Address,
  PancakeRouterV2: deployments.contracts.PancakeRouterV2 as Address,
} as const;

// ═══════════════════════════════════════════════
// Test Tokens (created by create-test-tokens.ts, stored in data/token-addresses.json)
// ═══════════════════════════════════════════════
export interface TestToken {
  name: string;
  symbol: string;
  address: Address;
  gmxMarket: string;     // GMX market address for data mapping
  gmxTrades48h: number;  // Expected trade count
}

export const GMX_MEME_MARKETS: Record<string, string> = {
  DOGE: "0x47c031236e19d024b42f8AE6780E44A573170703",
  SHIB: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
  PEPE: "0x970b730b5dD18de53A230eE8F4af088dBC3a6F8d",
  FLOKI: "0x7f1fa204bb700853D36994DA19F830b6Ad18455C",
};

// ═══════════════════════════════════════════════
// Test Parameters
// ═══════════════════════════════════════════════
export const TEST_PARAMS = {
  // Wallet allocation
  WALLET_COUNT: 100,
  BNB_PER_WALLET: 0.7,       // BNB deposited per wallet
  LP_POOL_BNB: 15,            // PerpVault LP liquidity
  TOKEN_LIQUIDITY_BNB: 1.25,  // Per token bonding curve buy (5 BNB / 4 tokens)
  GAS_RESERVE_BNB: 5,         // Gas for on-chain ops
  MARKET_MAKER_BNB: 5,        // Orderbook depth

  // Replay
  REPLAY_DURATION_HOURS: 4,    // 48h compressed to 4h
  TIME_COMPRESSION: 12,        // 12x speed
  MAX_CONCURRENT_BROWSERS: 10,
  ORDER_DELAY_MS: 200,         // Min delay between orders from same wallet

  // Leverage limits (must match engine config)
  MAX_LEVERAGE: 25000,  // 2.5x in 1e4 format (inner market)
  MIN_LEVERAGE: 10000,  // 1x

  // Fees (must match config.ts TRADING)
  TAKER_FEE_BPS: 5,    // 0.05%
  MAKER_FEE_BPS: 3,    // 0.03%

  // Timeouts
  TX_CONFIRM_TIMEOUT_MS: 30_000,
  UI_ACTION_TIMEOUT_MS: 15_000,
  WS_MESSAGE_TIMEOUT_MS: 10_000,
  ENGINE_HEALTH_TIMEOUT_MS: 5_000,

  // Thresholds for pass/fail
  MIN_ACCEPTANCE_RATE: 0.90,        // 90% of orders should be accepted
  MAX_BALANCE_DRIFT_BNB: 0.01,     // Balance audit tolerance
  MAX_P50_LATENCY_MS: 100,
  MAX_MEMORY_MB: 512,
} as const;

// ═══════════════════════════════════════════════
// ABIs (minimal — only functions we call)
// ═══════════════════════════════════════════════
export const ABI = {
  TokenFactory: [
    ...parseAbi([
      "function createToken(string name, string symbol, string metadataURI, uint256 initialBuyAmount) payable returns (address)",
      "function buy(address tokenAddress, uint256 minTokensOut) payable",
      "function sell(address tokenAddress, uint256 tokenAmount, uint256 minETHOut)",
      "function getTokenCount() view returns (uint256)",
      "function getCurrentPrice(address token) view returns (uint256)",
    ]),
    // getPoolState returns a struct — needs JSON ABI (parseAbi can't handle tuple returns)
    {
      type: "function" as const,
      name: "getPoolState" as const,
      inputs: [{ name: "tokenAddress", type: "address" as const }],
      outputs: [{
        name: "", type: "tuple" as const,
        components: [
          { name: "realETHReserve", type: "uint256" as const },
          { name: "realTokenReserve", type: "uint256" as const },
          { name: "soldTokens", type: "uint256" as const },
          { name: "isGraduated", type: "bool" as const },
          { name: "isActive", type: "bool" as const },
          { name: "creator", type: "address" as const },
          { name: "createdAt", type: "uint64" as const },
          { name: "metadataURI", type: "string" as const },
          { name: "graduationFailed", type: "bool" as const },
          { name: "graduationAttempts", type: "uint8" as const },
          { name: "perpEnabled", type: "bool" as const },
          { name: "lendingEnabled", type: "bool" as const },
        ],
      }],
      stateMutability: "view" as const,
    },
  ],

  SettlementV2: parseAbi([
    "function deposit(uint256 amount) external",
    "function depositFor(address user, uint256 amount) external",
    "function getUserDeposits(address user) view returns (uint256)",
    "function collateralToken() view returns (address)",
    "function totalDeposited() view returns (uint256)",
    "function withdraw(uint256 amount, uint256 userEquity, bytes32[] merkleProof, bytes32 merkleRoot, uint256 deadline, bytes signature) external",
    "event Deposited(address indexed user, uint256 amount)",
    "event Withdrawn(address indexed user, uint256 amount, uint256 nonce)",
  ]),

  PerpVault: parseAbi([
    "function deposit() payable",
    "function depositWithSlippage(uint256 minSharesOut) payable",
    "function withdraw(uint256 shares)",
    "function getPoolValue() view returns (uint256)",
    "function getTotalOI() view returns (uint256 longOI, uint256 shortOI)",
    "function getShares(address user) view returns (uint256)",
    "function getMaxOI() view returns (uint256)",
    "function setMaxOIPerToken(address token, uint256 maxOI)",
  ]),

  PriceFeed: parseAbi([
    "function updateTokenPrice(address token, uint256 price) external",
    "function getPrice(address token) view returns (uint256)",
    "function updateTokenPriceFromFactory(address token) external",
  ]),

  WBNB: parseAbi([
    "function deposit() payable",
    "function withdraw(uint256 amount)",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
  ]),

  ERC20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address, uint256) returns (bool)",
    "function transfer(address, uint256) returns (bool)",
    "function allowance(address, address) view returns (uint256)",
  ]),
} as const;

// ═══════════════════════════════════════════════
// EIP-712 Domain (for order signing)
// ═══════════════════════════════════════════════
// ⚠️ Must match engine's EIP712_DOMAIN exactly (server.ts:222-227)
// Engine uses SETTLEMENT_ADDRESS (V1), NOT SettlementV2
export const EIP712_DOMAIN = {
  name: "MemePerp",
  version: "1",
  chainId: 97,
  verifyingContract: CONTRACTS.Settlement, // V1 — must match engine config
} as const;

// ⚠️ Must match engine's ORDER_TYPES exactly (server.ts:229-241)
// Field order matters for EIP-712 hash computation
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
} as const;
