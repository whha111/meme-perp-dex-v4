/**
 * 统一 API 配置
 *
 * 所有 API URL 从这里导出，禁止在其他文件中直接使用 process.env
 */

// 撮合引擎 URL（主要 API）
const _MATCHING_ENGINE_URL =
  process.env.NEXT_PUBLIC_MATCHING_ENGINE_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:8081";

// H-10 fix: 生产环境强制 HTTPS，防止签名数据被中间人截获
export const MATCHING_ENGINE_URL = (() => {
  if (typeof window !== "undefined" && process.env.NODE_ENV === "production") {
    if (_MATCHING_ENGINE_URL.startsWith("http://") && !_MATCHING_ENGINE_URL.includes("localhost")) {
      console.error("[API] ⚠️ 生产环境检测到 HTTP URL，自动升级为 HTTPS");
      return _MATCHING_ENGINE_URL.replace("http://", "https://");
    }
  }
  return _MATCHING_ENGINE_URL;
})();

// WebSocket URL（从 HTTP URL 转换，添加 /ws 路径）
export const WS_URL = MATCHING_ENGINE_URL.replace(/^http/, "ws") + "/ws";

// API 基础 URL（向后兼容）
export const API_BASE_URL = MATCHING_ENGINE_URL;

// 链配置
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 84532);

// Settlement 合约地址
export const SETTLEMENT_ADDRESS = process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS as `0x${string}` | undefined;

// SettlementV2 合约地址 (Merkle 提款系统)
export const SETTLEMENT_V2_ADDRESS = process.env.NEXT_PUBLIC_SETTLEMENT_V2_ADDRESS as `0x${string}` | undefined;
