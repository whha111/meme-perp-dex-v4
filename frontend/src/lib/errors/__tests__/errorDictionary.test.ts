/**
 * errorDictionary 工具函数测试
 *
 * 覆盖:
 * - extractErrorMessage: 从各类错误对象中提取人类可读消息
 * - isUserRejection: 检测用户主动拒绝签名/交易
 */
import { describe, test, expect } from "vitest";
import { extractErrorMessage, isUserRejection } from "../errorDictionary";

// =====================================================
// extractErrorMessage
// =====================================================

describe("extractErrorMessage", () => {
  test("从 wagmi/viem BaseError 提取 shortMessage", () => {
    const err = { shortMessage: "User rejected the request.", message: "long stack..." };
    expect(extractErrorMessage(err)).toBe("User rejected the request.");
  });

  test("从标准 Error 提取 message", () => {
    const err = new Error("transaction reverted");
    expect(extractErrorMessage(err)).toBe("transaction reverted");
  });

  test("从 plain object 提取 message 字段", () => {
    const err = { message: "not enough gas", code: -32000 };
    expect(extractErrorMessage(err)).toBe("not enough gas");
  });

  test("处理 string 类型错误", () => {
    expect(extractErrorMessage("something broke")).toBe("something broke");
  });

  test("处理 null/undefined 返回 fallback", () => {
    expect(extractErrorMessage(null)).toBe("操作失败");
    expect(extractErrorMessage(undefined)).toBe("操作失败");
    expect(extractErrorMessage(null, "custom fallback")).toBe("custom fallback");
  });

  test("处理数字类型返回 fallback", () => {
    expect(extractErrorMessage(42)).toBe("操作失败");
  });

  test("shortMessage 优先级高于 message", () => {
    const err = { shortMessage: "短消息", message: "长消息" };
    expect(extractErrorMessage(err)).toBe("短消息");
  });

  test("非字符串 shortMessage 被忽略", () => {
    const err = { shortMessage: 123, message: "fallback message" };
    expect(extractErrorMessage(err)).toBe("fallback message");
  });
});

// =====================================================
// isUserRejection
// =====================================================

describe("isUserRejection", () => {
  test("EIP-1193 code 4001 (MetaMask 标准拒绝)", () => {
    expect(isUserRejection({ code: 4001, message: "MetaMask Tx Signature: User denied" })).toBe(true);
  });

  test("message 包含 rejected", () => {
    expect(isUserRejection({ message: "User rejected the request." })).toBe(true);
  });

  test("message 包含 denied", () => {
    expect(isUserRejection({ message: "Transaction denied by user" })).toBe(true);
  });

  test("message 包含 cancelled", () => {
    expect(isUserRejection({ message: "Request cancelled by the user" })).toBe(true);
  });

  test("普通错误不被判定为拒绝", () => {
    expect(isUserRejection({ code: -32000, message: "insufficient funds" })).toBe(false);
  });

  test("null/undefined 返回 false", () => {
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });

  test("string 类型返回 false", () => {
    expect(isUserRejection("some error")).toBe(false);
  });

  test("空对象返回 false", () => {
    expect(isUserRejection({})).toBe(false);
  });
});
