/**
 * Spot Trader — Buy/sell tokens on TokenFactory bonding curve
 *
 * This is the CRITICAL piece that was missing from the previous test.
 * Without spot trading, PriceFeed never updates, mark price never changes,
 * and there can never be liquidations, PnL, or meaningful funding rates.
 */
import { type Address, type Hex, parseEther, formatEther } from "viem";
import { CONTRACTS, ABI } from "../config/test-config";
import { getPublicClient, getWalletClient, waitForTx } from "./rpc-client";

const ERC20_ABI = ABI.ERC20;

export interface SpotTradeResult {
  success: boolean;
  txHash?: string;
  priceBefore?: bigint;
  priceAfter?: bigint;
  error?: string;
}

/**
 * Buy tokens on bonding curve (pushes price UP)
 */
export async function spotBuy(
  privateKey: Hex,
  token: Address,
  bnbAmount: string, // e.g. "0.3"
): Promise<SpotTradeResult> {
  try {
    const client = getPublicClient();
    const wallet = getWalletClient(privateKey);

    // Read price before
    const priceBefore = await client.readContract({
      address: CONTRACTS.TokenFactory,
      abi: ABI.TokenFactory,
      functionName: "getCurrentPrice",
      args: [token],
    }) as bigint;

    // Buy on bonding curve
    const hash = await wallet.writeContract({
      address: CONTRACTS.TokenFactory,
      abi: ABI.TokenFactory,
      functionName: "buy",
      args: [token, 0n], // minTokensOut = 0 (no slippage protection for test)
      value: parseEther(bnbAmount),
    });

    await waitForTx(hash);

    // Read price after
    const priceAfter = await client.readContract({
      address: CONTRACTS.TokenFactory,
      abi: ABI.TokenFactory,
      functionName: "getCurrentPrice",
      args: [token],
    }) as bigint;

    return { success: true, txHash: hash, priceBefore, priceAfter };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 200) };
  }
}

/**
 * Sell tokens on bonding curve (pushes price DOWN)
 * Requires the wallet to already hold tokens.
 * If wallet has no tokens, buys first then sells.
 */
export async function spotSell(
  privateKey: Hex,
  token: Address,
  sellFraction: number = 0.5, // sell this fraction of held tokens
): Promise<SpotTradeResult> {
  try {
    const client = getPublicClient();
    const wallet = getWalletClient(privateKey);
    const account = wallet.account!;

    // Check token balance
    let tokenBalance = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    }) as bigint;

    if (tokenBalance === 0n) {
      // Buy some first so we can sell
      const buyHash = await wallet.writeContract({
        address: CONTRACTS.TokenFactory,
        abi: ABI.TokenFactory,
        functionName: "buy",
        args: [token, 0n],
        value: parseEther("0.2"),
      });
      await waitForTx(buyHash);

      tokenBalance = await client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      }) as bigint;
    }

    const sellAmount = (tokenBalance * BigInt(Math.floor(sellFraction * 100))) / 100n;
    if (sellAmount === 0n) {
      return { success: false, error: "No tokens to sell" };
    }

    const priceBefore = await client.readContract({
      address: CONTRACTS.TokenFactory,
      abi: ABI.TokenFactory,
      functionName: "getCurrentPrice",
      args: [token],
    }) as bigint;

    // Approve TokenFactory to spend tokens
    const approveHash = await wallet.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONTRACTS.TokenFactory, sellAmount],
    });
    await waitForTx(approveHash);

    // Sell
    const hash = await wallet.writeContract({
      address: CONTRACTS.TokenFactory,
      abi: ABI.TokenFactory,
      functionName: "sell",
      args: [token, sellAmount, 0n], // minETHOut = 0
    });
    await waitForTx(hash);

    const priceAfter = await client.readContract({
      address: CONTRACTS.TokenFactory,
      abi: ABI.TokenFactory,
      functionName: "getCurrentPrice",
      args: [token],
    }) as bigint;

    return { success: true, txHash: hash, priceBefore, priceAfter };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 200) };
  }
}

/**
 * Get current price from PriceFeed
 */
export async function getSpotPrice(token: Address): Promise<bigint> {
  const client = getPublicClient();
  try {
    return await client.readContract({
      address: CONTRACTS.PriceFeed,
      abi: ABI.PriceFeed,
      functionName: "getPrice",
      args: [token],
    }) as bigint;
  } catch {
    // PriceFeed.getPrice may revert for bonding curve tokens — use TokenFactory
    return await client.readContract({
      address: CONTRACTS.TokenFactory,
      abi: ABI.TokenFactory,
      functionName: "getCurrentPrice",
      args: [token],
    }) as bigint;
  }
}
