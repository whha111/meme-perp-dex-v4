/**
 * 余额管理模块 (ETH 本位 Mode 2)
 *
 * 功能:
 * 1. 链上余额同步 (读取 Settlement 合约 ETH 余额 + 派生钱包 ETH/WETH 余额)
 * 2. 冻结/解冻保证金 (内存中)
 * 3. 计算可用余额和权益 (所有值以 ETH 计价, 1e18 精度)
 *
 * ETH 本位资金流向:
 * 1. 用户从主钱包转账 ETH 到派生钱包 (用户持有私钥)
 * 2. 用户调用 Settlement.deposit() 发送 ETH (资金托管)
 * 3. 后端读取 Settlement.available (链上托管 ETH) + 派生钱包 ETH 余额
 * 4. 仓位保证金从后端 Redis 计算，不从链上读取
 * 5. 提现时从 Settlement 提取 ETH 到派生钱包，再转到主钱包
 *
 * ⚠️ Mode 2: 链上 Settlement.locked 已废弃，仓位在 Redis 中管理
 */

import { createPublicClient, http, type Address } from "viem";
import { bscTestnet } from "viem/chains";
import { RPC_URL, SETTLEMENT_ADDRESS } from "../config";
import { BalanceRepo } from "../database/redis";
import { logger } from "../utils/logger";
import type { UserBalance } from "../types";

// ============================================================
// Viem Client
// ============================================================

const publicClient = createPublicClient({
  chain: bscTestnet,
  transport: http(RPC_URL),
});

// ERC20 ABI for reading WETH balance
const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Settlement ABI for reading user balance (ETH 本位)
const SETTLEMENT_ABI = [
  {
    inputs: [{ name: "user", type: "address" }],
    name: "getUserBalance",
    outputs: [
      { name: "available", type: "uint256" },  // ETH (1e18)
      { name: "locked", type: "uint256" },     // 已废弃 (Mode 2)
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// WBNB 地址 (BSC Testnet)
const WETH_ADDRESS = (process.env.WETH_ADDRESS || "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd") as Address;

// ============================================================
// Balance Functions
// ============================================================

/**
 * 从链上同步用户余额 (ETH 本位 Mode 2)
 *
 * 读取三个来源:
 * 1. 派生钱包的原生 ETH 余额
 * 2. 派生钱包的 WETH 余额 (可能有)
 * 3. Settlement 合约中的 available 余额 (ETH 托管)
 *
 * ⚠️ Mode 2: 不读取 Settlement.locked，仓位保证金从 Redis 计算
 * 所有值都是 ETH (1e18 精度)
 */
export async function syncBalanceFromChain(trader: Address): Promise<UserBalance> {
  try {
    let walletETH = 0n;
    let walletWETH = 0n;
    let contractAvailable = 0n;

    // 1. 读取派生钱包的原生 ETH 余额
    try {
      walletETH = await publicClient.getBalance({ address: trader });
    } catch (e) {
      logger.warn("Balance", `Failed to read wallet ETH balance for ${trader}`);
    }

    // 2. 读取派生钱包的 WETH 余额 (可选)
    try {
      walletWETH = await publicClient.readContract({
        address: WETH_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [trader],
      });
    } catch (e) {
      // WETH 余额读取失败不影响主流程
    }

    // 3. 读取 Settlement 合约中的 available ETH 余额 (资金托管)
    // ⚠️ Mode 2: locked 值忽略，仓位保证金从后端 Redis 计算
    if (SETTLEMENT_ADDRESS && SETTLEMENT_ADDRESS !== "0x0000000000000000000000000000000000000000") {
      try {
        const [available, _locked] = await publicClient.readContract({
          address: SETTLEMENT_ADDRESS,
          abi: SETTLEMENT_ABI,
          functionName: "getUserBalance",
          args: [trader],
        }) as [bigint, bigint];

        contractAvailable = available;  // ETH (1e18)
        // Mode 2: _locked 被忽略，链上不再追踪仓位锁定
      } catch (e) {
        logger.warn("Balance", `Failed to read Settlement balance for ${trader}`);
      }
    }

    const blockNumber = await publicClient.getBlockNumber();

    // ETH 本位: 总余额 = 钱包 ETH + 钱包 WETH + 合约可用 ETH
    const walletBalance = walletETH + walletWETH;
    const totalBalance = walletBalance + contractAvailable;

    await BalanceRepo.syncFromChain(trader, totalBalance, blockNumber);

    const balance = await BalanceRepo.getOrCreate(trader);
    balance.walletBalance = walletBalance;           // 派生钱包中的 ETH + WETH (1e18)
    balance.availableBalance = contractAvailable;    // Settlement 中可用 ETH (1e18)
    balance.usedMargin = 0n;                         // Mode 2: 仓位保证金由调用方从 Redis 计算
    balance.frozenMargin = 0n;                       // Redis 中冻结 (待成交订单)

    await BalanceRepo.update(trader, balance);

    logger.info("Balance", `[ETH Mode2] Synced for ${trader}: walletETH=${walletETH}, walletWETH=${walletWETH}, contractAvail=${contractAvailable}`);
    return balance;
  } catch (error) {
    logger.error("Balance", `Failed to sync balance for ${trader}:`, error);
    throw error;
  }
}

/**
 * 获取用户余额
 */
export async function getBalance(trader: Address): Promise<UserBalance> {
  return BalanceRepo.getOrCreate(trader);
}

/**
 * 冻结保证金
 */
export async function freezeMargin(trader: Address, amount: bigint): Promise<boolean> {
  const result = await BalanceRepo.freezeMargin(trader, amount);
  if (result) {
    logger.debug("Balance", `Frozen ${amount} margin for ${trader}`);
  }
  return result;
}

/**
 * 解冻保证金
 */
export async function unfreezeMargin(trader: Address, amount: bigint): Promise<void> {
  await BalanceRepo.unfreezeMargin(trader, amount);
  logger.debug("Balance", `Unfrozen ${amount} margin for ${trader}`);
}

/**
 * 计算用户权益
 */
export async function calculateEquity(
  trader: Address,
  unrealizedPnL: bigint
): Promise<bigint> {
  const balance = await getBalance(trader);
  // 权益 = 可用余额 + 已用保证金 + 未实现盈亏
  return balance.availableBalance + balance.usedMargin + unrealizedPnL;
}

/**
 * 更新已用保证金 (仓位占用)
 */
export async function updateUsedMargin(
  trader: Address,
  usedMargin: bigint
): Promise<void> {
  await BalanceRepo.update(trader, { usedMargin });
}

/**
 * 更新未实现盈亏
 */
export async function updateUnrealizedPnL(
  trader: Address,
  unrealizedPnL: bigint
): Promise<void> {
  const balance = await getBalance(trader);
  const equity = balance.availableBalance + balance.usedMargin + unrealizedPnL;
  await BalanceRepo.update(trader, { unrealizedPnL, equity });
}

/**
 * 检查是否有足够余额
 */
export async function hasEnoughBalance(
  trader: Address,
  required: bigint
): Promise<boolean> {
  const balance = await getBalance(trader);
  return balance.availableBalance >= required;
}

/**
 * 批量同步余额
 */
export async function batchSyncBalances(traders: Address[]): Promise<void> {
  const promises = traders.map(trader => syncBalanceFromChain(trader).catch(err => {
    logger.error("Balance", `Failed to sync ${trader}:`, err);
  }));
  await Promise.all(promises);
}

export default {
  syncBalanceFromChain,
  getBalance,
  freezeMargin,
  unfreezeMargin,
  calculateEquity,
  updateUsedMargin,
  updateUnrealizedPnL,
  hasEnoughBalance,
  batchSyncBalances,
};
