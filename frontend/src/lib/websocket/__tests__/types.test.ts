/**
 * WebSocket 类型 & 工具函数测试
 *
 * 覆盖:
 * - MessageType 枚举值完整性
 * - nowUnix / generateRequestId / createMessage 工具函数
 * - createTokenTopic / createPriceTopic 主题构建
 * - adaptInstrumentAssetResponse 数据适配
 * - adaptTokenAssetList 列表适配
 */
import { describe, test, expect } from "vitest";
import {
  MessageType,
  nowUnix,
  generateRequestId,
  createMessage,
  createTokenTopic,
  createPriceTopic,
} from "../types";
import {
  adaptInstrumentAssetResponse,
  adaptTokenAssetList,
} from "../index";

// =====================================================
// MessageType 枚举
// =====================================================

describe("MessageType", () => {
  test("包含核心交易消息类型", () => {
    expect(MessageType.TRADE).toBe("trade");
    expect(MessageType.QUOTE).toBe("quote");
    expect(MessageType.TRADE_EVENT).toBe("trade_event");
  });

  test("包含订阅消息类型", () => {
    expect(MessageType.SUBSCRIBE).toBe("subscribe");
    expect(MessageType.UNSUBSCRIBE).toBe("unsubscribe");
  });

  test("包含行情数据类型", () => {
    expect(MessageType.TICKER).toBe("tickers");
    expect(MessageType.BOOKS).toBe("books");
    expect(MessageType.CANDLE).toBe("candle");
    expect(MessageType.FUNDING_RATE).toBe("funding-rate");
  });

  test("包含心跳消息", () => {
    expect(MessageType.PING).toBe("ping");
    expect(MessageType.PONG).toBe("pong");
    expect(MessageType.HEARTBEAT).toBe("heartbeat");
  });
});

// =====================================================
// 工具函数
// =====================================================

describe("nowUnix", () => {
  test("返回秒级 Unix 时间戳", () => {
    const ts = nowUnix();
    expect(typeof ts).toBe("number");
    // 应在合理范围 (2024-01-01 ~ 2030-01-01)
    expect(ts).toBeGreaterThan(1704067200);
    expect(ts).toBeLessThan(1893456000);
  });

  test("是整数 (秒级, 非毫秒)", () => {
    const ts = nowUnix();
    expect(Number.isInteger(ts)).toBe(true);
  });
});

describe("generateRequestId", () => {
  test("返回非空字符串", () => {
    const id = generateRequestId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("每次生成唯一 ID", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBe(100);
  });
});

describe("createMessage", () => {
  test("创建包含 type 和 timestamp 的消息", () => {
    const msg = createMessage(MessageType.PING);
    expect(msg.type).toBe("ping");
    expect(typeof msg.timestamp).toBe("number");
  });

  test("可携带 data 和 request_id", () => {
    const msg = createMessage(MessageType.TRADE, { side: "buy" }, "req-123");
    expect(msg.type).toBe("trade");
    expect(msg.data).toEqual({ side: "buy" });
    expect(msg.request_id).toBe("req-123");
  });
});

describe("createTokenTopic / createPriceTopic", () => {
  test("createTokenTopic 返回正确格式", () => {
    const topic = createTokenTopic("0xabc");
    expect(typeof topic).toBe("string");
    expect(topic).toContain("0xabc");
  });

  test("createPriceTopic 返回正确格式", () => {
    const topic = createPriceTopic("0xdef");
    expect(typeof topic).toBe("string");
    expect(topic).toContain("0xdef");
  });
});

// =====================================================
// adaptInstrumentAssetResponse
// =====================================================

describe("adaptInstrumentAssetResponse", () => {
  test("适配 snake_case 后端响应", () => {
    const resp = {
      inst_id: "0xABC-USDT",
      symbol: "MEME",
      current_price: "0.00001234",
      fdv: "12345.678",
      volume_24h: "99.5",
      price_change_24h: 5.23,
      token_address: "0xABC",
      is_graduated: true,
    };
    const result = adaptInstrumentAssetResponse(resp);

    expect(result.instId).toBe("0xABC-USDT");
    expect(result.symbol).toBe("MEME");
    expect(result.currentPrice).toBe("0.00001234");
    expect(result.fdv).toBe("12345.678");
    expect(result.volume24h).toBe("99.5");
    expect(result.priceChange24h).toBe(5.23);
    expect(result.tokenAddress).toBe("0xABC");
    expect(result.isGraduated).toBe(true);
  });

  test("适配 camelCase 响应", () => {
    const resp = {
      instId: "0xDEF-USDT",
      currentPrice: "0.5",
      fdv: "1000",
    };
    const result = adaptInstrumentAssetResponse(resp);
    expect(result.instId).toBe("0xDEF-USDT");
    expect(result.currentPrice).toBe("0.5");
  });

  test("缺少字段时使用默认值", () => {
    const result = adaptInstrumentAssetResponse({});
    expect(result.currentPrice).toBe("0");
    expect(result.fdv).toBe("0");
    expect(result.priceChange24h).toBe(0);
    expect(result.isGraduated).toBe(false);
  });

  test("symbol 缺失时从 instId 推导", () => {
    const result = adaptInstrumentAssetResponse({ inst_id: "TOKEN-USDT" });
    expect(result.symbol).toBe("TOKEN");
  });
});

// =====================================================
// adaptTokenAssetList
// =====================================================

describe("adaptTokenAssetList", () => {
  test("适配代币列表", () => {
    const tokens = [
      { inst_id: "A-USDT", current_price: "1.0", fdv: "100" },
      { inst_id: "B-USDT", current_price: "2.0", fdv: "200" },
    ];
    const result = adaptTokenAssetList(tokens);
    expect(result).toHaveLength(2);
    expect(result[0].instId).toBe("A-USDT");
    expect(result[1].currentPrice).toBe("2.0");
  });

  test("空列表返回空数组", () => {
    expect(adaptTokenAssetList([])).toEqual([]);
  });

  test("undefined 返回空数组", () => {
    expect(adaptTokenAssetList(undefined)).toEqual([]);
  });
});
