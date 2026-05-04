/**
 * Receipt-Based Trade Event Scanner (Fallback for eth_getLogs blocking)
 *
 * Problem: some BSC public RPCs block eth_getLogs from datacenter IPs.
 * BSCScan V1 API is deprecated, V2 API requires authenticated access for heavier usage.
 *
 * Solution: Use eth_getBlockByNumber + eth_getTransactionReceipt instead.
 * These are cheap O(1) lookups that are NOT throttled like eth_getLogs.
 *
 * Strategy:
 *  1. Get block with full transactions via getBlock({ includeTransactions: true })
 *  2. Filter transactions where `to` = TokenFactory address
 *  3. For matching txs, get receipt and parse Trade event from logs
 *
 * This is less efficient than getLogs (N+M RPC calls vs 1), but it WORKS
 * from datacenter IPs where getLogs is blocked.
 *
 * Reference: Similar to how The Graph's subgraph handler processes blocks
 * when event subscriptions fail.
 */

import type { Address, Hex } from "viem";
import { decodeAbiParameters, parseAbiParameters, keccak256, toBytes } from "viem";

// ============================================================
// Config
// ============================================================

// Trade event topic0: keccak256("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)")
const TRADE_EVENT_TOPIC = keccak256(
  toBytes("Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256)")
);

// ============================================================
// Types
// ============================================================

export interface ParsedTradeEvent {
  token: Address;
  trader: Address;
  isBuy: boolean;
  ethAmount: bigint;
  tokenAmount: bigint;
  virtualEth: bigint;
  virtualToken: bigint;
  timestamp: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

// ============================================================
// Core: Scan blocks for Trade events via receipts
// ============================================================

/**
 * Scan a range of blocks for Trade events by checking transaction receipts.
 * This bypasses eth_getLogs entirely — uses getBlock + getTransactionReceipt.
 *
 * @param client - viem PublicClient (with fallback transport for reliability)
 * @param contractAddress - TokenFactory contract address
 * @param fromBlock - Start block (inclusive)
 * @param toBlock - End block (inclusive)
 */
export async function scanTradeEventsViaReceipts(
  client: any,
  contractAddress: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<ParsedTradeEvent[]> {
  const allEvents: ParsedTradeEvent[] = [];
  const targetAddress = contractAddress.toLowerCase();
  let blocksScanned = 0;
  let txsChecked = 0;
  // Ensure BigInt types
  fromBlock = BigInt(fromBlock);
  toBlock = BigInt(toBlock);

  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
    try {
      // Get block with full transaction objects
      const block = await client.getBlock({
        blockNumber: blockNum,
        includeTransactions: true,
      });

      if (!block || !block.transactions) continue;
      blocksScanned++;

      // Filter transactions targeting TokenFactory
      const factoryTxs = block.transactions.filter(
        (tx: any) => tx.to && tx.to.toLowerCase() === targetAddress
      );

      if (factoryTxs.length === 0) continue;

      // Get receipts for matching transactions
      for (const tx of factoryTxs) {
        txsChecked++;
        try {
          const receipt = await client.getTransactionReceipt({
            hash: tx.hash,
          });

          if (!receipt || !receipt.logs) continue;

          // Find Trade events in receipt logs
          for (const log of receipt.logs) {
            if (
              log.address.toLowerCase() === targetAddress &&
              log.topics &&
              log.topics.length >= 3 &&
              log.topics[0] === TRADE_EVENT_TOPIC
            ) {
              const parsed = parseTradeFromReceiptLog(log, tx.hash, blockNum);
              if (parsed) {
                allEvents.push(parsed);
              }
            }
          }
        } catch (receiptErr: any) {
          console.warn(`[ReceiptScanner] Failed to get receipt for ${tx.hash?.slice(0, 10)}: ${receiptErr?.message?.slice(0, 80)}`);
        }
      }

      // Rate limiting: small delay every 10 blocks to be polite to RPC
      if (blocksScanned % 10 === 0 && blockNum < toBlock) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (blockErr: any) {
      console.warn(`[ReceiptScanner] Failed to get block ${blockNum}: ${blockErr?.message?.slice(0, 80)}`);
      // Continue with next block
    }
  }

  if (blocksScanned > 0) {
    console.log(`[ReceiptScanner] Scanned ${blocksScanned} blocks, checked ${txsChecked} TokenFactory txs, found ${allEvents.length} Trade events`);
  }

  return allEvents;
}

/**
 * Scan in batches with progress logging.
 * For large ranges, processes in chunks of batchSize blocks.
 */
export async function scanTradeEventsBatched(
  client: any,
  contractAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
  batchSize: bigint = 100n  // Process 100 blocks at a time
): Promise<ParsedTradeEvent[]> {
  const allEvents: ParsedTradeEvent[] = [];
  // Ensure BigInt types (prevent "Invalid mix of BigInt and other type" errors)
  fromBlock = BigInt(fromBlock);
  toBlock = BigInt(toBlock);
  batchSize = BigInt(batchSize);
  const totalBlocks = toBlock - fromBlock + 1n;

  console.log(`[ReceiptScanner] Starting batch scan: blocks ${fromBlock} → ${toBlock} (${totalBlocks} blocks)`);

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = start + batchSize - 1n > toBlock ? toBlock : start + batchSize - 1n;

    const events = await scanTradeEventsViaReceipts(client, contractAddress, start, end);
    allEvents.push(...events);

    if (events.length > 0) {
      console.log(`[ReceiptScanner] Batch ${start}-${end}: found ${events.length} trades (total: ${allEvents.length})`);
    }

    // Rate limit between batches
    if (end < toBlock) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return allEvents;
}

// ============================================================
// Internal: Parse Trade event from receipt log
// ============================================================

function parseTradeFromReceiptLog(
  log: any,
  txHash: Hex,
  blockNumber: bigint
): ParsedTradeEvent | null {
  try {
    // Topics: [eventSig, token(indexed), trader(indexed)]
    if (!log.topics || log.topics.length < 3 || !log.data) {
      return null;
    }

    // Extract indexed params from topics (remove 0x + 24 bytes padding = 26 chars)
    const token = ("0x" + log.topics[1].slice(26)) as Address;
    const trader = ("0x" + log.topics[2].slice(26)) as Address;

    // Decode non-indexed params from data
    const decoded = decodeAbiParameters(
      parseAbiParameters("bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 virtualEth, uint256 virtualToken, uint256 timestamp"),
      log.data as Hex
    );

    const [isBuy, ethAmount, tokenAmount, virtualEth, virtualToken, timestamp] = decoded;

    return {
      token,
      trader,
      isBuy,
      ethAmount,
      tokenAmount,
      virtualEth,
      virtualToken,
      timestamp,
      txHash,
      blockNumber,
    };
  } catch (e: any) {
    console.warn(`[ReceiptScanner] Failed to parse Trade log: ${e.message}`);
    return null;
  }
}

// ============================================================
// Exports for backward compatibility
// ============================================================

// These are kept for the import in pollTradeEventsViaBscscan in server.ts
// They now delegate to the receipt-based scanner
export const fetchTradeEventsBatched = scanTradeEventsBatched;
