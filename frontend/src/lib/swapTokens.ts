import { type Address, getAddress, isAddress } from "viem";

const envAddress = (value: string | undefined, fallback: Address): Address => {
  if (value && isAddress(value)) return getAddress(value) as Address;
  return fallback;
};

export const BSC_CHAIN_ID = 56;
export const PANCAKE_V2_ROUTER = envAddress(
  process.env.NEXT_PUBLIC_PANCAKE_V2_ROUTER_ADDRESS || process.env.NEXT_PUBLIC_ROUTER_ADDRESS,
  "0x10ED43C718714eb63d5aA57B78B54704E256024E"
);
export const WBNB_ADDRESS = envAddress(
  process.env.NEXT_PUBLIC_WBNB_ADDRESS || process.env.NEXT_PUBLIC_WETH_ADDRESS,
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
);
export const USDT_ADDRESS = envAddress(
  process.env.NEXT_PUBLIC_USDT_ADDRESS,
  "0x55d398326f99059fF775485246999027B3197955"
);

export interface SwapToken {
  symbol: string;
  name: string;
  address: Address | null;
  wrappedAddress: Address;
  decimals: number;
  native: boolean;
  enabled: boolean;
  tags: string[];
}

export const SWAP_TOKENS: SwapToken[] = [
  {
    symbol: "BNB",
    name: "BNB",
    address: null,
    wrappedAddress: WBNB_ADDRESS,
    decimals: 18,
    native: true,
    enabled: true,
    tags: ["gas", "collateral"],
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    address: USDT_ADDRESS,
    wrappedAddress: USDT_ADDRESS,
    decimals: 18,
    native: false,
    enabled: true,
    tags: ["stablecoin"],
  },
  {
    symbol: "DOGE",
    name: "Binance-Peg Dogecoin",
    address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43",
    wrappedAddress: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43",
    decimals: 8,
    native: false,
    enabled: true,
    tags: ["meme", "binance-peg"],
  },
  {
    symbol: "SHIB",
    name: "Binance-Peg SHIBA INU",
    address: "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D",
    wrappedAddress: "0x2859e4544C4bB03966803b044A93563Bd2D0DD4D",
    decimals: 18,
    native: false,
    enabled: true,
    tags: ["meme", "binance-peg"],
  },
  {
    symbol: "PEPE",
    name: "Pepe",
    address: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00",
    wrappedAddress: "0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00",
    decimals: 18,
    native: false,
    enabled: true,
    tags: ["meme"],
  },
  {
    symbol: "FLOKI",
    name: "FLOKI",
    address: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E",
    wrappedAddress: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E",
    decimals: 9,
    native: false,
    enabled: true,
    tags: ["meme"],
  },
  {
    symbol: "BONK",
    name: "BONK",
    address: null,
    wrappedAddress: WBNB_ADDRESS,
    decimals: 18,
    native: false,
    enabled: false,
    tags: ["pending-bsc-token"],
  },
  {
    symbol: "WIF",
    name: "dogwifhat",
    address: null,
    wrappedAddress: WBNB_ADDRESS,
    decimals: 18,
    native: false,
    enabled: false,
    tags: ["pending-bsc-token"],
  },
];

export function getSwapToken(symbol: string): SwapToken | undefined {
  return SWAP_TOKENS.find((token) => token.symbol.toLowerCase() === symbol.toLowerCase());
}

export function getSwapPath(from: SwapToken, to: SwapToken): Address[] {
  if (from.wrappedAddress.toLowerCase() === to.wrappedAddress.toLowerCase()) return [];

  const fromAddress = from.wrappedAddress;
  const toAddress = to.wrappedAddress;

  if (
    fromAddress.toLowerCase() === WBNB_ADDRESS.toLowerCase() ||
    toAddress.toLowerCase() === WBNB_ADDRESS.toLowerCase()
  ) {
    return [fromAddress, toAddress];
  }

  return [fromAddress, WBNB_ADDRESS, toAddress];
}

export const PANCAKE_V2_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    name: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "swapExactTokensForETHSupportingFeeOnTransferTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
