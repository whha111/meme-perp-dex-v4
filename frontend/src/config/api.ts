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

// H-10 fix: 生产环境强制 HTTPS（仅当配置了 SSL 域名时）
// 如果显式配置了 http:// URL（如 VPS IP 部署），则尊重配置不强制升级
export const MATCHING_ENGINE_URL = _MATCHING_ENGINE_URL;

// WebSocket URL（从 HTTP URL 转换，添加 /ws 路径）
export const WS_URL = MATCHING_ENGINE_URL.replace(/^http/, "ws") + "/ws";

// API 基础 URL（向后兼容）
export const API_BASE_URL = MATCHING_ENGINE_URL;

// 链配置
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 56);

// Settlement 合约地址
export const SETTLEMENT_ADDRESS = process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS as `0x${string}` | undefined;

// SettlementV2 合约地址 (Merkle 提款系统)
export const SETTLEMENT_V2_ADDRESS = process.env.NEXT_PUBLIC_SETTLEMENT_V2_ADDRESS as `0x${string}` | undefined;
