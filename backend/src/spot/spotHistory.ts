/**
 * 现货交易历史与 K 线数据管理模块
 *
 * 功能：
 * - 存储 TokenFactory Trade 事件
 * - 生成和更新 K 线数据
 * - 提供 API 查询接口
 */

import type { Address, Hex } from "viem";
import { getRedisClient, isRedisConnected } from "../matching/database/redis";
import { logger } from "../matching/utils/logger";

// ============================================================
// Types
// ============================================================

export interface SpotTrade {
  id: string;
  token: Address;
  trader: Address;
  isBuy: boolean;
  ethAmount: string;       // wei string
  tokenAmount: string;     // wei string
  virtualEth: string;      // wei string (after trade)
  virtualToken: string;    // wei string (after trade)
  price: string;           // ETH per token (decimal string)
  priceUsd: string;        // USD price (decimal string)
  txHash: Hex;
  blockNumber: string;
  timestamp: number;       // unix seconds
}

export interface KlineBar {
  time: number;            // bucket timestamp (unix seconds)
  open: string;            // decimal string
  high: string;
  low: string;
  close: string;
  volume: string;          // ETH volume
  trades: number;          // trade count
}

// K 线时间周期 (秒)
export const KLINE_RESOLUTIONS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
} as const;

export type KlineResolution = keyof typeof KLINE_RESOLUTIONS;

// ============================================================
// Redis Keys
// ============================================================

const Keys = {
  // 交易历史 (按代币)
  tokenTrades: (token: Address) => `spot:trades:${token.toLowerCase()}`,
  // 单笔交易详情
  trade: (id: string) => `spot:trade:${id}`,
  // K 线数据 (按代币和周期)
  kline: (token: Address, resolution: string) => `spot:kline:${token.toLowerCase()}:${resolution}`,
  // 最新价格
  latestPrice: (token: Address) => `spot:price:${token.toLowerCase()}`,
  // 24h 统计
  stats24h: (token: Address) => `spot:stats24h:${token.toLowerCase()}`,
};

// ============================================================
// Trade Repository
// ============================================================

export const SpotTradeRepo = {
  /**
   * 保存交易记录
   */
  async save(trade: SpotTrade): Promise<void> {
    if (!isRedisConnected()) return;

    const client = getRedisClient();
    const key = Keys.trade(trade.id);

    // 存储交易详情
    await client.hset(key, {
      id: trade.id,
      token: trade.token,
      trader: trade.trader,
      isBuy: trade.isBuy.toString(),
      ethAmount: trade.ethAmount,
      tokenAmount: trade.tokenAmount,
      virtualEth: trade.virtualEth,
      virtualToken: trade.virtualToken,
      price: trade.price,
      priceUsd: trade.priceUsd,
      txHash: trade.txHash,
      blockNumber: trade.blockNumber,
      timestamp: trade.timestamp.toString(),
    });

    // 设置过期时间 (7 天)
    await client.expire(key, 7 * 24 * 60 * 60);

    // 添加到代币交易列表 (按时间戳排序)
    await client.zadd(Keys.tokenTrades(trade.token), trade.timestamp, trade.id);

    // 只保留最近 10000 笔交易
    const count = await client.zcard(Keys.tokenTrades(trade.token));
    if (count > 10000) {
      await client.zremrangebyrank(Keys.tokenTrades(trade.token), 0, count - 10001);
    }

    logger.debug("SpotHistory", `Saved trade ${trade.id} for ${trade.token.slice(0, 10)}`);
  },

  /**
   * 获取代币的交易历史
   */
  async getByToken(token: Address, limit = 100, before?: number): Promise<SpotTrade[]> {
    if (!isRedisConnected()) return [];

    const client = getRedisClient();
    const maxScore = before ? before - 1 : "+inf";

    // 获取交易 ID 列表
    const ids = await client.zrevrangebyscore(
      Keys.tokenTrades(token),
      maxScore,
      "-inf",
      "LIMIT",
      0,
      limit
    );

    if (ids.length === 0) return [];

    // 批量获取交易详情
    const trades: SpotTrade[] = [];
    for (const id of ids) {
      const data = await client.hgetall(Keys.trade(id));
      if (data && Object.keys(data).length > 0) {
        trades.push({
          id: data.id,
          token: data.token as Address,
          trader: data.trader as Address,
          isBuy: data.isBuy === "true",
          ethAmount: data.ethAmount,
          tokenAmount: data.tokenAmount,
          virtualEth: data.virtualEth,
          virtualToken: data.virtualToken,
          price: data.price,
          priceUsd: data.priceUsd,
          txHash: data.txHash as Hex,
          blockNumber: data.blockNumber,
          timestamp: parseInt(data.timestamp),
        });
      }
    }

    return trades;
  },

  /**
   * 检查交易是否已存在 (防止重复)
   */
  async exists(txHash: Hex): Promise<boolean> {
    if (!isRedisConnected()) return false;
    const client = getRedisClient();
    return (await client.exists(Keys.trade(txHash))) === 1;
  },
};

// ============================================================
// K-line Repository
// ============================================================

export const KlineRepo = {
  /**
   * 更新 K 线数据
   */
  async update(token: Address, resolution: KlineResolution, trade: SpotTrade): Promise<void> {
    if (!isRedisConnected()) return;

    const client = getRedisClient();
    const resolutionSeconds = KLINE_RESOLUTIONS[resolution];
    const bucketTime = Math.floor(trade.timestamp / resolutionSeconds) * resolutionSeconds;
    const key = Keys.kline(token, resolution);

    // 获取当前 K 线
    const existing = await client.hget(key, bucketTime.toString());
    let bar: KlineBar;

    // ETH 本位: 使用 Token/ETH 价格 (trade.price)，而非 USD 价格
    const price = parseFloat(trade.price);
    const volume = parseFloat(trade.ethAmount) / 1e18;

    if (existing) {
      bar = JSON.parse(existing);
      bar.high = Math.max(parseFloat(bar.high), price).toString();
      bar.low = Math.min(parseFloat(bar.low), price).toString();
      bar.close = price.toString();
      bar.volume = (parseFloat(bar.volume) + volume).toString();
      bar.trades += 1;
    } else {
      // 新 K 线：获取上一个时间桶的 K 线
      const prevBucketTime = bucketTime - resolutionSeconds;
      const prevBarJson = await client.hget(key, prevBucketTime.toString());

      // 上一根 K 线的收盘价，如果没有则用当前交易价格
      let prevClose = price;
      if (prevBarJson) {
        const prevBar = JSON.parse(prevBarJson);
        prevClose = parseFloat(prevBar.close);
      }

      bar = {
        time: bucketTime,
        open: prevClose.toString(),  // 开盘价 = 上一根收盘价
        high: Math.max(prevClose, price).toString(),
        low: Math.min(prevClose, price).toString(),
        close: price.toString(),
        volume: volume.toString(),
        trades: 1,
      };
    }

    // 保存 K 线
    await client.hset(key, bucketTime.toString(), JSON.stringify(bar));

    // 设置过期时间 (根据周期不同)
    const expireSeconds = resolution === "1m" ? 7 * 24 * 60 * 60 : 30 * 24 * 60 * 60;
    await client.expire(key, expireSeconds);
  },

  /**
   * 获取 K 线数据
   */
  async get(
    token: Address,
    resolution: KlineResolution,
    from: number,
    to: number
  ): Promise<KlineBar[]> {
    if (!isRedisConnected()) return [];

    const client = getRedisClient();
    const key = Keys.kline(token, resolution);
    const resolutionSeconds = KLINE_RESOLUTIONS[resolution];

    // 获取所有 K 线
    const allBars = await client.hgetall(key);
    if (!allBars || Object.keys(allBars).length === 0) return [];

    const bars: KlineBar[] = [];
    for (const [timeStr, barJson] of Object.entries(allBars)) {
      const time = parseInt(timeStr);
      if (time >= from && time <= to) {
        bars.push(JSON.parse(barJson));
      }
    }

    // 按时间排序
    bars.sort((a, b) => a.time - b.time);

    // 填充空白 K 线
    const filledBars: KlineBar[] = [];
    let prevClose = bars.length > 0 ? bars[0].open : "0";

    for (let t = from; t <= to; t += resolutionSeconds) {
      const existing = bars.find((b) => b.time === t);
      if (existing) {
        filledBars.push(existing);
        prevClose = existing.close;
      } else {
        // 空白 K 线
        filledBars.push({
          time: t,
          open: prevClose,
          high: prevClose,
          low: prevClose,
          close: prevClose,
          volume: "0",
          trades: 0,
        });
      }
    }

    return filledBars;
  },

  /**
   * 获取最新的 K 线（从第一笔交易开始，填充到当前时间）
   *
   * 重要：不再使用 limit 参数限制起始时间，而是从第一笔有交易的 K 线开始
   * 这样可以完整显示代币的价格历史
   */
  async getLatest(token: Address, resolution: KlineResolution, limit = 100): Promise<KlineBar[]> {
    if (!isRedisConnected()) return [];

    const client = getRedisClient();
    const key = Keys.kline(token, resolution);

    const allBars = await client.hgetall(key);
    if (!allBars || Object.keys(allBars).length === 0) return [];

    // 解析所有存储的 K 线
    const storedBars: KlineBar[] = Object.values(allBars)
      .map((json) => JSON.parse(json))
      .sort((a, b) => a.time - b.time); // 按时间正序

    if (storedBars.length === 0) return [];

    // 计算时间范围
    const resolutionSeconds = KLINE_RESOLUTIONS[resolution];
    const now = Math.floor(Date.now() / 1000);
    const currentBucket = Math.floor(now / resolutionSeconds) * resolutionSeconds;

    // 创建时间到 K 线的映射
    const barMap = new Map<number, KlineBar>();
    for (const bar of storedBars) {
      barMap.set(bar.time, bar);
    }

    // ✅ 关键修改：从第一笔有交易的 K 线开始，而不是从 limit 个周期前开始
    // 找到第一根有交易的 K 线（trades > 0）
    const firstTradeBar = storedBars.find(b => b.trades > 0);
    if (!firstTradeBar) {
      // 没有任何交易：只返回最新的 1 根 K 线（当前价格点）
      // 不做 gap-fill，避免新 token 未交易就显示多根虚假水平线
      const latestBar = storedBars[storedBars.length - 1];
      return [latestBar];
    }

    // 从第一笔交易开始
    const startTime = firstTradeBar.time;

    // 填充 K 线数据（从第一笔交易到当前时间）
    const filledBars: KlineBar[] = [];
    // 初始 prevClose：用第一根有交易的 K 线的 open
    let prevClose = firstTradeBar.open;

    for (let t = startTime; t <= currentBucket; t += resolutionSeconds) {
      const existing = barMap.get(t);
      if (existing) {
        filledBars.push(existing);
        prevClose = existing.close;
      } else {
        // 空白 K 线：使用上一根的收盘价（横盘）
        filledBars.push({
          time: t,
          open: prevClose,
          high: prevClose,
          low: prevClose,
          close: prevClose,
          volume: "0",
          trades: 0,
        });
      }
    }

    // 返回 K 线（按时间倒序，前端会 reverse）
    return filledBars.reverse();
  },
};

// ============================================================
// Price & Stats
// ============================================================

export const SpotStatsRepo = {
  /**
   * 更新最新价格
   */
  async updatePrice(token: Address, price: string, priceUsd: string): Promise<void> {
    if (!isRedisConnected()) return;

    const client = getRedisClient();
    await client.hset(Keys.latestPrice(token), {
      price,
      priceUsd,
      updatedAt: Date.now().toString(),
    });
  },

  /**
   * 获取最新价格
   */
  async getPrice(token: Address): Promise<{ price: string; priceUsd: string } | null> {
    if (!isRedisConnected()) return null;

    const client = getRedisClient();
    const data = await client.hgetall(Keys.latestPrice(token));
    if (!data || !data.price) return null;

    return {
      price: data.price,
      priceUsd: data.priceUsd,
    };
  },

  /**
   * 更新 24h 统计
   */
  async update24hStats(token: Address): Promise<void> {
    if (!isRedisConnected()) return;

    const client = getRedisClient();
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 24 * 60 * 60;

    // 获取 24h 内的交易
    const trades = await SpotTradeRepo.getByToken(token, 10000, now + 1);
    const trades24h = trades.filter((t) => t.timestamp >= dayAgo);

    if (trades24h.length === 0) return;

    // 计算统计数据
    let volume24h = 0;
    let high24h = 0;
    let low24h = Infinity;

    for (const trade of trades24h) {
      volume24h += parseFloat(trade.ethAmount) / 1e18;
      const price = parseFloat(trade.price);
      high24h = Math.max(high24h, price);
      low24h = Math.min(low24h, price);
    }

    const open24h = parseFloat(trades24h[trades24h.length - 1].price);
    const close24h = parseFloat(trades24h[0].price);
    const change24h = ((close24h - open24h) / open24h) * 100;

    await client.hset(Keys.stats24h(token), {
      volume24h: volume24h.toString(),
      high24h: high24h.toString(),
      low24h: low24h === Infinity ? "0" : low24h.toString(),
      open24h: open24h.toString(),
      close24h: close24h.toString(),
      change24h: change24h.toString(),
      trades24h: trades24h.length.toString(),
      updatedAt: Date.now().toString(),
    });
  },

  /**
   * 获取 24h 统计
   */
  async get24hStats(token: Address): Promise<{
    volume24h: string;
    high24h: string;
    low24h: string;
    open24h: string;
    change24h: string;
    trades24h: number;
  } | null> {
    if (!isRedisConnected()) return null;

    const client = getRedisClient();
    const data = await client.hgetall(Keys.stats24h(token));
    if (!data || !data.volume24h) return null;

    return {
      volume24h: data.volume24h,
      high24h: data.high24h,
      low24h: data.low24h,
      open24h: data.open24h || "0",
      change24h: data.change24h,
      trades24h: parseInt(data.trades24h || "0"),
    };
  },
};

// ============================================================
// Trade Processing
// ============================================================

/**
 * 处理新的交易事件
 */
export async function processTradeEvent(
  token: Address,
  trader: Address,
  isBuy: boolean,
  ethAmount: bigint,
  tokenAmount: bigint,
  virtualEth: bigint,
  virtualToken: bigint,
  timestamp: bigint,
  txHash: Hex,
  blockNumber: bigint,
  ethPriceUsd: number
): Promise<void> {
  // 检查是否已处理
  if (await SpotTradeRepo.exists(txHash)) {
    logger.debug("SpotHistory", `Trade ${txHash.slice(0, 10)} already processed`);
    return;
  }

  // 计算交易后的价格 (ETH per token)
  // 重要：合约发出的 virtualEth/virtualToken 是交易前的值！
  // 需要根据交易方向计算交易后的值
  let afterVirtualEth: bigint;
  let afterVirtualToken: bigint;

  if (isBuy) {
    // 买入：ETH进入池子，Token离开池子
    // virtualEth 增加 ethAmount（买入金额）
    // virtualToken 减少 tokenAmount（获得的代币）
    afterVirtualEth = virtualEth + ethAmount;
    afterVirtualToken = virtualToken - tokenAmount;
  } else {
    // 卖出：Token进入池子，ETH离开池子
    // 注意：事件中的 ethAmount 是扣除手续费后的净值
    // 实际从池子扣除的是 ethAmount / 0.99（假设1%手续费）
    const FEE_MULTIPLIER = 0.99;
    const ethOutTotal = BigInt(Math.ceil(Number(ethAmount) / FEE_MULTIPLIER));
    afterVirtualEth = virtualEth - ethOutTotal;
    afterVirtualToken = virtualToken + tokenAmount;
  }

  // 确保不会除以零
  if (afterVirtualToken <= 0n) {
    logger.warn("SpotHistory", `Invalid afterVirtualToken: ${afterVirtualToken}`);
    return;
  }

  const price = Number(afterVirtualEth) / Number(afterVirtualToken);
  const priceUsd = price * ethPriceUsd;

  const trade: SpotTrade = {
    id: txHash,
    token,
    trader,
    isBuy,
    ethAmount: ethAmount.toString(),
    tokenAmount: tokenAmount.toString(),
    virtualEth: virtualEth.toString(),
    virtualToken: virtualToken.toString(),
    price: price.toString(),
    priceUsd: priceUsd.toString(),
    txHash,
    blockNumber: blockNumber.toString(),
    timestamp: Number(timestamp),
  };

  // 保存交易
  await SpotTradeRepo.save(trade);
  console.log(`[ProcessTrade] Saved trade ${txHash.slice(0, 10)} for ${token.slice(0, 10)}, price: ${price.toExponential(4)}`);

  // 更新所有周期的 K 线
  for (const resolution of Object.keys(KLINE_RESOLUTIONS) as KlineResolution[]) {
    await KlineRepo.update(token, resolution, trade);
    console.log(`[ProcessTrade] Updated ${resolution} kline for ${token.slice(0, 10)}`);
  }

  // 更新价格
  await SpotStatsRepo.updatePrice(token, price.toString(), priceUsd.toString());

  // 更新 24h 统计 (异步，不阻塞)
  SpotStatsRepo.update24hStats(token).catch((err) => {
    logger.warn("SpotHistory", `Failed to update 24h stats: ${err.message}`);
  });

  logger.info("SpotHistory", `Processed trade: ${isBuy ? "BUY" : "SELL"} ${token.slice(0, 10)} @ ${priceUsd.toFixed(8)} USD`);
}

/**
 * 从链上回填历史交易数据
 */
export async function backfillHistoricalTrades(
  token: Address,
  fromBlock: bigint,
  toBlock: bigint,
  ethPriceUsd: number = 2500
): Promise<number> {
  const { createPublicClient, http, parseAbiItem } = await import("viem");
  const { bscTestnet } = await import("viem/chains");

  // BSC Testnet RPC for backfill
  const RPC_URL = "https://data-seed-prebsc-1-s1.binance.org:8545/";
  // 使用部署的 TokenFactory 地址
  const TOKEN_FACTORY_ADDRESS = (process.env.TOKEN_FACTORY_ADDRESS || "0xd05A38E6C2a39762De453D90a670ED0Af65ff2f8") as Address;

  logger.info("SpotHistory", `Using TokenFactory: ${TOKEN_FACTORY_ADDRESS}`);

  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  const TRADE_EVENT_ABI = parseAbiItem(
    "event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 virtualEth, uint256 virtualToken, uint256 timestamp)"
  );

  // Normalize token address to lowercase for consistent comparison
  const normalizedToken = token.toLowerCase() as Address;
  console.log(`[Backfill] Using TokenFactory: ${TOKEN_FACTORY_ADDRESS}`);
  console.log(`[Backfill] Backfilling trades for ${normalizedToken} from block ${fromBlock} to ${toBlock}`);

  let processedCount = 0;
  const BATCH_SIZE = 5000n; // publicnode.com 限制

  for (let start = fromBlock; start <= toBlock; start += BATCH_SIZE) {
    const end = start + BATCH_SIZE > toBlock ? toBlock : start + BATCH_SIZE;

    try {
      console.log(`[Backfill] Fetching logs from block ${start} to ${end}...`);

      // First get all Trade events without token filter, then filter manually
      // This avoids case-sensitivity issues with indexed parameters
      const logs = await publicClient.getLogs({
        address: TOKEN_FACTORY_ADDRESS,
        event: TRADE_EVENT_ABI,
        fromBlock: BigInt(start),
        toBlock: BigInt(end),
      });

      // Filter by token address manually (case-insensitive)
      const filteredLogs = logs.filter(log => {
        const logToken = (log.args as any)?.token;
        return logToken && logToken.toLowerCase() === normalizedToken;
      });

      console.log(`[Backfill] Blocks ${start}-${end}: ${logs.length} total trades, ${filteredLogs.length} for token`);

      for (const log of filteredLogs) {
        const args = log.args as {
          token: Address;
          trader: Address;
          isBuy: boolean;
          ethAmount: bigint;
          tokenAmount: bigint;
          virtualEth: bigint;
          virtualToken: bigint;
          timestamp: bigint;
        };

        try {
          console.log(`[Backfill] Processing trade ${log.transactionHash?.slice(0, 10)}...`);
          await processTradeEvent(
            args.token,
            args.trader,
            args.isBuy,
            args.ethAmount,
            args.tokenAmount,
            args.virtualEth,
            args.virtualToken,
            args.timestamp,
            log.transactionHash as Hex,
            log.blockNumber ?? 0n,
            ethPriceUsd
          );
          processedCount++;
          console.log(`[Backfill] ✅ Processed trade ${log.transactionHash?.slice(0, 10)}`);
        } catch (tradeErr: any) {
          console.error(`[Backfill] ❌ Failed to process trade: ${tradeErr?.message || tradeErr}`);
        }
      }
    } catch (e: any) {
      console.error(`[Backfill] ERROR fetching logs for blocks ${start}-${end}: ${e?.message || e}`);
    }
  }

  console.log(`[Backfill] Complete: ${processedCount} trades processed`);
  return processedCount;
}

/**
 * 初始化代币 K 线数据 (在 TokenCreated 事件时调用)
 * Pump.fun 模式：代币创建时立即有初始价格
 */
export async function initializeTokenKline(
  token: Address,
  priceEth: string,
  priceUsd: string,
  blockNumber: number
): Promise<void> {
  if (!isRedisConnected()) {
    logger.warn("SpotHistory", "Redis not connected, cannot initialize K-line");
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  // 为所有时间周期创建初始 K 线
  for (const resolution of Object.keys(KLINE_RESOLUTIONS) as KlineResolution[]) {
    const resolutionSeconds = KLINE_RESOLUTIONS[resolution];
    const bucketTime = Math.floor(now / resolutionSeconds) * resolutionSeconds;

    const client = getRedisClient();
    const key = Keys.kline(token, resolution);

    // 检查是否已存在 K 线数据
    const existing = await client.hget(key, bucketTime.toString());
    if (existing) {
      logger.debug("SpotHistory", `K-line already exists for ${token.slice(0, 10)} at ${resolution}`);
      continue;
    }

    // 创建初始 K 线 (OHLC 使用 ETH 价格，因为是 TOKEN/WETH 交易对)
    const bar: KlineBar = {
      time: bucketTime,
      open: priceEth,
      high: priceEth,
      low: priceEth,
      close: priceEth,
      volume: "0",
      trades: 0,
    };

    await client.hset(key, bucketTime.toString(), JSON.stringify(bar));

    // 设置过期时间
    const expireSeconds = resolution === "1m" ? 7 * 24 * 60 * 60 : 30 * 24 * 60 * 60;
    await client.expire(key, expireSeconds);
  }

  // 更新最新价格
  await SpotStatsRepo.updatePrice(token, priceEth, priceUsd);

  logger.info("SpotHistory", `Initialized K-line for ${token.slice(0, 10)}: $${parseFloat(priceUsd).toExponential(4)}`);
}

/**
 * 用当前池子价格更新 K 线 (Pump.fun 模式)
 * 即使没有交易，也保持 K 线的实时性
 */
export async function updateKlineWithCurrentPrice(
  token: Address,
  priceEth: string,
  priceUsd: string
): Promise<void> {
  if (!isRedisConnected()) return;

  const now = Math.floor(Date.now() / 1000);
  const client = getRedisClient();
  // 使用 USD 价格，前端图表直接显示 USD
  const price = parseFloat(priceUsd);

  // 只更新 1m K 线 (其他周期会基于 1m 聚合)
  const resolution: KlineResolution = "1m";
  const resolutionSeconds = KLINE_RESOLUTIONS[resolution];
  const bucketTime = Math.floor(now / resolutionSeconds) * resolutionSeconds;

  const key = Keys.kline(token, resolution);
  const existing = await client.hget(key, bucketTime.toString());

  let bar: KlineBar;

  if (existing) {
    bar = JSON.parse(existing);

    // 始终用当前价格更新 close、high、low
    // 标准交易所 K 线规范: close = 该 K 线周期内最新价格 (不仅是最后一笔成交价)
    bar.high = Math.max(parseFloat(bar.high), price).toString();
    bar.low = Math.min(parseFloat(bar.low), price).toString();
    bar.close = price.toString();
  } else {
    // 创建新的 K 线
    // 获取上一根 K 线的收盘价作为开盘价
    const prevBars = await KlineRepo.getLatest(token, resolution, 1);
    const prevClose = prevBars.length > 0 ? parseFloat(prevBars[0].close) : price;

    bar = {
      time: bucketTime,
      open: prevClose.toString(),
      high: Math.max(prevClose, price).toString(),
      low: Math.min(prevClose, price).toString(),
      close: price.toString(),
      volume: "0",
      trades: 0,
    };
  }

  await client.hset(key, bucketTime.toString(), JSON.stringify(bar));

  // 更新最新价格
  await SpotStatsRepo.updatePrice(token, priceEth, priceUsd);
}

export default {
  SpotTradeRepo,
  KlineRepo,
  SpotStatsRepo,
  processTradeEvent,
  backfillHistoricalTrades,
  initializeTokenKline,
  updateKlineWithCurrentPrice,
  KLINE_RESOLUTIONS,
};
