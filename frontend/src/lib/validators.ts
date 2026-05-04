/**
 * 统一验证工具库
 * 集中管理所有前端验证逻辑，确保一致性
 *
 * [FIX SECURITY] 增强验证以防止 IDN 攻击、无效 TLD 等
 */

import { keccak256, toBytes } from 'viem';

// ==================== 安全常量 ====================

/** 有效的顶级域名列表 */
const VALID_TLDS = new Set([
  // 通用顶级域名
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'app', 'dev',
  // 国家代码顶级域名
  'uk', 'de', 'fr', 'jp', 'cn', 'in', 'au', 'ca', 'us', 'br', 'ru', 'kr', 'it', 'es', 'nl',
  // 新型通用顶级域名
  'xyz', 'fun', 'tech', 'online', 'site', 'club', 'shop', 'blog', 'ai', 'me', 'tv', 'cc',
  // 区块链相关
  'eth', 'crypto', 'nft', 'dao', 'web3', 'defi',
]);

/** 保留域名（不允许注册） */
const RESERVED_DOMAINS = new Set([
  'localhost', 'test', 'invalid', 'example', 'local',
  'admin', 'root', 'system', 'null', 'undefined',
]);

/** DNS 标签最大长度 */
const MAX_LABEL_LENGTH = 63;

// ==================== 地址验证 ====================

/**
 * 验证以太坊地址格式
 * [FIX SECURITY] 增加 ERC-55 校验和验证
 * @param address 以太坊地址
 * @param strictChecksum 是否严格检查校验和（默认 false，兼容全小写地址）
 * @returns 是否有效
 */
export function validateEthereumAddress(address: string, strictChecksum: boolean = false): boolean {
  if (!address || typeof address !== 'string') return false;

  // 基本格式检查
  if (!address.startsWith('0x')) return false;
  if (address.length !== 42) return false;

  // 十六进制字符检查
  const hexPart = address.slice(2);
  if (!/^[a-fA-F0-9]{40}$/.test(hexPart)) return false;

  // 如果是全小写或全大写，跳过校验和检查（兼容模式）
  if (!strictChecksum) {
    if (hexPart === hexPart.toLowerCase() || hexPart === hexPart.toUpperCase()) {
      return true;
    }
  }

  // ERC-55 校验和验证（混合大小写地址）
  try {
    const hash = keccak256(toBytes(hexPart.toLowerCase()));
    for (let i = 0; i < 40; i++) {
      const hashChar = parseInt(hash[2 + i], 16);
      const addrChar = hexPart[i];
      const isUpperCase = addrChar === addrChar.toUpperCase();
      const shouldBeUpperCase = hashChar >= 8;

      // 如果是字母，检查大小写是否符合校验和
      if (/[a-fA-F]/.test(addrChar) && isUpperCase !== shouldBeUpperCase) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 将地址转换为校验和格式
 * @param address 以太坊地址
 * @returns 校验和格式的地址
 */
export function toChecksumAddress(address: string): string | null {
  if (!address || !address.startsWith('0x') || address.length !== 42) {
    return null;
  }

  try {
    const hexPart = address.slice(2).toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hexPart)) return null;

    const hash = keccak256(toBytes(hexPart));
    let checksummed = '0x';

    for (let i = 0; i < 40; i++) {
      const hashChar = parseInt(hash[2 + i], 16);
      checksummed += hashChar >= 8 ? hexPart[i].toUpperCase() : hexPart[i];
    }

    return checksummed;
  } catch {
    return null;
  }
}

// ==================== 域名验证 ====================

/**
 * 域名验证结果
 */
export interface DomainValidationResult {
  isValid: boolean;
  error?: string;
  normalizedDomain?: string;
}

/**
 * 验证域名格式
 * [FIX SECURITY] 增强验证：IDN 攻击防护、TLD 检查、保留域名检查
 * @param domain 域名
 * @returns 是否有效
 */
export function validateDomainName(domain: string): boolean {
  return validateDomainNameDetailed(domain).isValid;
}

/**
 * 详细验证域名格式，返回具体错误信息
 * @param domain 域名
 * @returns 验证结果
 */
export function validateDomainNameDetailed(domain: string): DomainValidationResult {
  if (!domain || typeof domain !== 'string') {
    return { isValid: false, error: '域名不能为空' };
  }

  // 转换为小写并去除空格
  const normalizedDomain = domain.trim().toLowerCase();

  if (normalizedDomain.length < 3) {
    return { isValid: false, error: '域名长度至少为 3 个字符' };
  }

  if (normalizedDomain.length > 253) {
    return { isValid: false, error: '域名长度不能超过 253 个字符' };
  }

  // [FIX SECURITY] IDN 攻击防护：检查 Punycode (允许但不记录，避免生产环境日志)

  // 检查是否包含非 ASCII 字符（潜在 IDN 欺骗）
  if (/[^\x00-\x7F]/.test(normalizedDomain)) {
    return { isValid: false, error: '域名包含非法字符，请使用标准 ASCII 字符' };
  }

  // 分割标签
  const labels = normalizedDomain.split('.');

  if (labels.length < 2) {
    return { isValid: false, error: '域名必须包含至少一个点（如 example.com）' };
  }

  // 检查每个标签
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];

    if (!label) {
      return { isValid: false, error: '域名标签不能为空（不能有连续的点）' };
    }

    if (label.length > MAX_LABEL_LENGTH) {
      return { isValid: false, error: `域名标签 "${label}" 超过 ${MAX_LABEL_LENGTH} 个字符` };
    }

    // 标签格式验证
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label) && !/^[a-z0-9]$/.test(label)) {
      return { isValid: false, error: `域名标签 "${label}" 格式无效` };
    }

    // 检查连续连字符
    if (label.includes('--') && !label.startsWith('xn--')) {
      return { isValid: false, error: '域名标签不能包含连续的连字符' };
    }
  }

  // [FIX SECURITY] 检查保留域名
  const mainDomain = labels[0];
  if (RESERVED_DOMAINS.has(mainDomain)) {
    return { isValid: false, error: `"${mainDomain}" 是保留域名，不能使用` };
  }

  // [FIX SECURITY] 检查 TLD 是否有效
  const tld = labels[labels.length - 1];
  if (!VALID_TLDS.has(tld)) {
    return { isValid: false, error: `顶级域名 ".${tld}" 不在支持列表中` };
  }

  return { isValid: true, normalizedDomain };
}

/**
 * 验证金额格式
 * @param amount 金额字符串
 * @param options 配置选项
 * @returns 是否有效
 */
export function validateAmount(
  amount: string, 
  options: { min?: number; max?: number; allowZero?: boolean } = {}
): boolean {
  if (!amount || typeof amount !== 'string') return false;
  
  try {
    const num = parseFloat(amount);
    if (isNaN(num)) return false;
    
    // 检查是否为负数
    if (num < 0) return false;
    
    // 检查是否允许零值
    if (!options.allowZero && num === 0) return false;
    
    // 检查最小值
    if (options.min !== undefined && num < options.min) return false;
    
    // 检查最大值
    if (options.max !== undefined && num > options.max) return false;
    
    return true;
  } catch {
    return false;
  }
}

/**
 * 验证 WalletConnect Project ID 格式
 * @param projectId Project ID
 * @returns 是否有效
 */
export function validateWalletConnectProjectId(projectId: string): boolean {
  if (!projectId || typeof projectId !== 'string') return false;
  
  // 简化验证：检查长度和基本格式
  if (projectId.length !== 32) return false;
  
  // 可选：检查是否为十六进制
  return /^[a-fA-F0-9]+$/.test(projectId);
}

/**
 * 验证 DNS TXT 记录格式
 * @param txtValue TXT 记录值
 * @param expectedPrefix 预期前缀
 * @returns 提取的钱包地址或 null
 */
export function validateAndExtractWalletFromTXT(
  txtValue: string, 
  expectedPrefix: string = "domainfi-verify="
): string | null {
  if (!txtValue || !txtValue.startsWith(expectedPrefix)) {
    return null;
  }
  
  const wallet = txtValue.slice(expectedPrefix.length).trim();
  
  // 使用统一的地址验证
  if (validateEthereumAddress(wallet)) {
    return wallet.toLowerCase();
  }
  
  return null;
}

/**
 * 验证链 ID
 * @param chainId 链 ID
 * @param allowedChains 允许的链 ID 列表
 * @returns 是否有效
 */
export function validateChainId(
  chainId: number, 
  allowedChains: number[] = [56] // BSC Mainnet
): boolean {
  return allowedChains.includes(chainId);
}

/**
 * 验证交易参数
 * @param params 交易参数
 * @returns 验证结果
 */
export interface TradeParamsValidationResult {
  isValid: boolean;
  errors: string[];
}

export function validateTradeParams(params: {
  domainName: string;
  amount: string;
  isBuy: boolean;
}): TradeParamsValidationResult {
  const errors: string[] = [];
  
  // 验证域名
  if (!validateDomainName(params.domainName)) {
    errors.push("无效的域名格式");
  }
  
  // 验证金额
  if (!validateAmount(params.amount, { min: 0.0001, allowZero: false })) {
    errors.push("无效的交易金额");
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * 获取友好的验证错误信息
 * @param field 字段名
 * @param value 字段值
 * @param validator 验证器函数
 * @returns 错误信息或 null
 */
export function getValidationError<T = unknown>(
  field: string,
  value: T,
  validator: (value: T) => boolean
): string | null {
  if (!validator(value)) {
    switch (field) {
      case 'address':
        return "请输入有效的以太坊地址（0x开头，42位字符）";
      case 'domain':
        return "请输入有效的域名格式（如：example.com）";
      case 'amount':
        return "请输入有效的交易金额（大于0的数字）";
      case 'projectId':
        return "请输入有效的 WalletConnect Project ID（32位字符）";
      default:
        return `无效的 ${field} 格式`;
    }
  }
  return null;
}

// ==================== 错误处理 ====================

/**
 * [FIX SECURITY] 敏感关键词列表 - 这些信息不应暴露给用户
 */
const SENSITIVE_KEYWORDS = [
  'internal server error',
  'sql',
  'database',
  'postgres',
  'mysql',
  'mongodb',
  'redis',
  'connection refused',
  'econnrefused',
  'etimedout',
  'stack trace',
  'at function',
  'at async',
  'at object',
  'node_modules',
  '.ts:',
  '.js:',
  'undefined is not',
  'cannot read property',
  'unexpected token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'private_key',
  'privatekey',
  'auth_token',
  'bearer',
  'jwt',
  'websocket error',
  'ws error',
  '127.0.0.1',
  'localhost',
  '0.0.0.0',
  'enoent',
  'permission denied',
  'access denied',
];

/**
 * [FIX SECURITY] 用户友好的错误消息映射
 */
const USER_FRIENDLY_ERRORS: Record<string, string> = {
  // 网络相关
  'network error': '网络连接失败，请检查网络后重试',
  'fetch failed': '网络请求失败，请稍后重试',
  'timeout': '请求超时，请稍后重试',
  'websocket': 'WebSocket 连接异常，正在重连...',

  // 钱包相关
  'user rejected': '用户取消了操作',
  'user denied': '用户拒绝了请求',
  'wallet not connected': '请先连接钱包',
  'insufficient funds': '余额不足',
  'insufficient balance': '余额不足',
  'nonce too low': '交易序号冲突，请稍后重试',
  'replacement fee too low': '交易费用过低，请提高 Gas 费',
  'execution reverted': '交易执行失败，请检查参数',
  'address is invalid': '合约地址配置错误，请联系管理员',
  'invalid address': '合约地址配置错误，请联系管理员',

  // 交易相关
  'slippage': '价格波动过大，请调整滑点设置',
  'liquidity': '流动性不足，请减少交易金额',
  'deadline': '交易超时，请重新提交',
  'max wallet': '超过钱包持仓上限',

  // 域名相关
  'domain not found': '域名不存在',
  'domain not active': '域名代币尚未激活',
  'domain already exists': '域名已被注册',

  // 认证相关
  'unauthorized': '请先完成钱包认证',
  'authentication': '认证失败，请重新连接钱包',
  'signature': '签名验证失败',
};

/**
 * 检测是否为用户取消操作的错误
 * 用户取消不应显示为错误，而应静默处理或显示中性提示
 *
 * 参考：
 * - EIP-1193 错误码 4001 = 用户拒绝请求
 * - wagmi/viem UserRejectedRequestError
 *
 * @param error 错误对象
 * @returns 是否为用户取消操作
 */
export function isUserRejectedError(error: unknown): boolean {
  if (!error) return false;

  // 检查对象类型错误
  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // EIP-1193 标准错误码 4001 = 用户拒绝
    if (err.code === 4001) return true;

    // wagmi/viem 错误名称
    if (err.name === 'UserRejectedRequestError' ||
        err.name === 'TransactionRejectedRpcError' ||
        (typeof err.name === 'string' && err.name.includes('Rejected'))) {
      return true;
    }

    // 检查 shortMessage
    if (typeof err.shortMessage === 'string') {
      const shortMsg = err.shortMessage.toLowerCase();
      if (shortMsg.includes('rejected') || shortMsg.includes('denied') ||
          shortMsg.includes('cancelled') || shortMsg.includes('canceled')) {
        return true;
      }
    }

    // 检查 cause 链（viem 错误经常嵌套）
    if (err.cause) {
      return isUserRejectedError(err.cause);
    }

    // 检查 details 字段（某些钱包使用）
    if (typeof err.details === 'string') {
      const details = err.details.toLowerCase();
      if (details.includes('rejected') || details.includes('denied') ||
          details.includes('cancelled') || details.includes('canceled')) {
        return true;
      }
    }
  }

  // 检查字符串错误
  if (typeof error === 'string') {
    const msg = error.toLowerCase();
    return msg.includes('user rejected') || msg.includes('user denied') ||
           msg.includes('user cancelled') || msg.includes('user canceled');
  }

  // 检查 Error 对象
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('user rejected') || msg.includes('user denied') ||
           msg.includes('user cancelled') || msg.includes('user canceled');
  }

  return false;
}

/**
 * [FIX SECURITY] 消毒用户可见的错误信息
 * 移除敏感技术细节，返回用户友好的错误信息
 *
 * @param error 原始错误（Error 对象或字符串）
 * @param context 可选的上下文（如 'swap', 'create' 等）
 * @returns 安全的、用户友好的错误信息
 */
export function sanitizeErrorMessage(
  error: unknown,
  context?: string
): string {
  // 用户取消操作 - 返回 null 让调用者决定如何处理
  // 最佳实践：用户取消不应显示为红色错误
  if (isUserRejectedError(error)) {
    return ''; // 返回空字符串，让调用者知道这是用户取消
  }

  // 获取错误信息字符串
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = '未知错误';
  }

  const lowerMessage = message.toLowerCase();

  // 是否为开发环境
  const isDev = process.env.NODE_ENV === 'development';

  // [FIX SECURITY] 检查是否包含敏感关键词
  const containsSensitiveInfo = SENSITIVE_KEYWORDS.some(keyword =>
    lowerMessage.includes(keyword.toLowerCase())
  );

  // 如果包含敏感信息，返回通用错误
  if (containsSensitiveInfo) {
    // 仅在开发环境下记录原始错误
    if (isDev) {
      console.error('[SanitizeError] 已过滤敏感错误信息');
    }
    return getGenericErrorMessage(context);
  }

  // [FIX SECURITY] 尝试匹配用户友好的错误消息
  for (const [keyword, friendlyMessage] of Object.entries(USER_FRIENDLY_ERRORS)) {
    if (lowerMessage.includes(keyword.toLowerCase())) {
      return friendlyMessage;
    }
  }

  // 如果消息过长（可能包含技术细节），截断并返回通用错误
  if (message.length > 100) {
    return getGenericErrorMessage(context);
  }

  // 如果看起来是技术性错误（包含特殊字符），返回通用错误
  if (/[{}[\]<>]|Error:|at\s+/.test(message)) {
    return getGenericErrorMessage(context);
  }

  // 返回原始消息（已经是用户友好的）
  return message;
}

/**
 * 获取通用错误信息
 */
function getGenericErrorMessage(context?: string): string {
  switch (context) {
    case 'swap':
    case 'trade':
      return '交易处理失败，请稍后重试';
    case 'create':
      return '创建代币失败，请稍后重试';
    case 'verify':
      return '验证失败，请检查输入后重试';
    case 'connect':
      return '连接失败，请检查网络后重试';
    case 'sign':
      return '签名失败，请重试';
    default:
      return '操作失败，请稍后重试';
  }
}

/**
 * [FIX SECURITY] 安全地记录错误到控制台
 * 在开发环境显示完整错误，生产环境只记录摘要
 */
export function logError(
  error: unknown,
  context: string,
  additionalInfo?: Record<string, unknown>
): void {
  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    console.error(`[${context}] 错误:`, error, additionalInfo);
  } else {
    // 生产环境只记录错误类型和上下文
    const errorType = error instanceof Error ? error.name : typeof error;
    console.error(`[${context}] 错误类型: ${errorType}`);
  }
}

// ==================== 永续合约验证 ====================

/**
 * 验证杠杆倍数
 * @param leverage 杠杆倍数
 * @param max 最大杠杆（默认 100）
 * @returns 验证结果
 */
export function validateLeverage(leverage: number, max: number = 100): { isValid: boolean; error?: string } {
  if (!Number.isInteger(leverage)) {
    return { isValid: false, error: '杠杆必须为整数' };
  }
  if (leverage < 1) {
    return { isValid: false, error: '杠杆最小为 1x' };
  }
  if (leverage > max) {
    return { isValid: false, error: `杠杆最大为 ${max}x` };
  }
  return { isValid: true };
}

/**
 * 验证仓位大小
 * @param size 仓位大小
 * @param minSize 最小仓位
 * @param maxSize 最大仓位
 * @returns 验证结果
 */
export function validatePositionSize(
  size: string,
  minSize: string = '0.001',
  maxSize?: string
): { isValid: boolean; error?: string } {
  const sizeNum = parseFloat(size);
  const minNum = parseFloat(minSize);

  if (isNaN(sizeNum)) {
    return { isValid: false, error: '请输入有效的仓位大小' };
  }
  if (sizeNum <= 0) {
    return { isValid: false, error: '仓位大小必须大于 0' };
  }
  if (sizeNum < minNum) {
    return { isValid: false, error: `最小仓位为 ${minSize}` };
  }
  if (maxSize) {
    const maxNum = parseFloat(maxSize);
    if (sizeNum > maxNum) {
      return { isValid: false, error: `最大仓位为 ${maxSize}` };
    }
  }
  return { isValid: true };
}

/**
 * 验证止盈止损价格
 * @param price 止盈/止损价格
 * @param entryPrice 开仓价格
 * @param isLong 是否做多
 * @param isTakeProfit 是否为止盈（否则为止损）
 * @returns 验证结果
 */
export function validateTpSlPrice(
  price: string,
  entryPrice: string,
  isLong: boolean,
  isTakeProfit: boolean
): { isValid: boolean; error?: string } {
  const priceNum = parseFloat(price);
  const entryNum = parseFloat(entryPrice);

  if (isNaN(priceNum) || priceNum <= 0) {
    return { isValid: false, error: '请输入有效的价格' };
  }

  if (isLong) {
    if (isTakeProfit && priceNum <= entryNum) {
      return { isValid: false, error: '多仓止盈价必须高于开仓价' };
    }
    if (!isTakeProfit && priceNum >= entryNum) {
      return { isValid: false, error: '多仓止损价必须低于开仓价' };
    }
  } else {
    if (isTakeProfit && priceNum >= entryNum) {
      return { isValid: false, error: '空仓止盈价必须低于开仓价' };
    }
    if (!isTakeProfit && priceNum <= entryNum) {
      return { isValid: false, error: '空仓止损价必须高于开仓价' };
    }
  }

  return { isValid: true };
}

/**
 * 验证保证金是否足够
 * AUDIT-FIX M-27: Use BigInt comparison instead of parseFloat to avoid IEEE-754
 * precision loss near boundary values (e.g., parseFloat("0.1") + parseFloat("0.2") !== 0.3).
 * Both availableBalance and requiredMargin are expected as 1e18 wei strings or
 * human-readable decimals — we parse both to avoid silent precision bugs.
 * @param availableBalance 可用余额 (1e18 string or decimal)
 * @param requiredMargin 所需保证金 (1e18 string or decimal)
 * @returns 验证结果
 */
export function validateMarginSufficiency(
  availableBalance: string,
  requiredMargin: string
): { isValid: boolean; error?: string } {
  try {
    // Try BigInt first (1e18 wei strings from backend)
    const availBig = parseDecimalToBigInt(availableBalance);
    const requiredBig = parseDecimalToBigInt(requiredMargin);
    if (availBig === null || requiredBig === null) {
      return { isValid: false, error: '无效的余额数据' };
    }
    if (requiredBig > availBig) {
      return { isValid: false, error: `保证金不足，需要 ${requiredMargin}，可用 ${availableBalance}` };
    }
    return { isValid: true };
  } catch {
    return { isValid: false, error: '无效的余额数据' };
  }
}

/**
 * AUDIT-FIX M-27: Parse a decimal string or integer string into BigInt with 18 decimals precision.
 * Handles both "0.05" (human-readable) and "50000000000000000" (wei) formats.
 */
function parseDecimalToBigInt(value: string): bigint | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // If it's already a pure integer (wei string), parse directly
  if (/^[0-9]+$/.test(trimmed)) {
    return BigInt(trimmed);
  }

  // Parse decimal: "1.5" → 1500000000000000000n (1.5 * 1e18)
  const parts = trimmed.split('.');
  if (parts.length > 2) return null;

  const intPart = parts[0] || '0';
  const decPart = (parts[1] || '').padEnd(18, '0').slice(0, 18);

  if (!/^[0-9]*$/.test(intPart) || !/^[0-9]+$/.test(decPart)) return null;

  return BigInt(intPart) * 10n ** 18n + BigInt(decPart);
}

/**
 * 验证滑点设置
 * @param slippage 滑点百分比
 * @returns 验证结果
 */
export function validateSlippage(slippage: number): { isValid: boolean; error?: string } {
  if (isNaN(slippage)) {
    return { isValid: false, error: '请输入有效的滑点' };
  }
  if (slippage < 0) {
    return { isValid: false, error: '滑点不能为负数' };
  }
  if (slippage > 50) {
    return { isValid: false, error: '滑点不能超过 50%' };
  }
  if (slippage < 0.1) {
    return { isValid: false, error: '滑点过低可能导致交易失败，建议至少 0.1%' };
  }
  if (slippage > 5) {
    return { isValid: false, error: '滑点过高可能导致价格损失，建议不超过 5%' };
  }
  return { isValid: true };
}

/**
 * 计算所需保证金
 * AUDIT-FIX M-27: Use BigInt arithmetic to avoid float precision loss.
 * Returns a decimal string (human-readable) for display.
 * @param size 仓位大小
 * @param price 价格
 * @param leverage 杠杆
 * @returns 所需保证金 (decimal string)
 */
export function calculateRequiredMargin(
  size: string,
  price: string,
  leverage: number
): string {
  const sizeBig = parseDecimalToBigInt(size);
  const priceBig = parseDecimalToBigInt(price);

  if (sizeBig === null || priceBig === null || leverage <= 0) {
    return '0';
  }

  // notional = size * price / 1e18 (both are 1e18-scaled)
  // margin = notional / leverage
  const notional = sizeBig * priceBig / (10n ** 18n);
  const margin = notional / BigInt(leverage);

  // Convert back to decimal string with 8 decimal places
  const intPart = margin / (10n ** 18n);
  const decPart = margin % (10n ** 18n);
  const decStr = decPart.toString().padStart(18, '0').slice(0, 8);
  return `${intPart}.${decStr}`;
}

/**
 * 计算预估清算价格
 * @param entryPrice 开仓价格
 * @param leverage 杠杆
 * @param isLong 是否做多
 * @param maintenanceMarginRate 维持保证金率（默认 0.5%）
 * @returns 预估清算价格
 */
export function calculateLiquidationPrice(
  entryPrice: string,
  leverage: number,
  isLong: boolean,
  maintenanceMarginRate: number = 0.005
): string {
  const price = parseFloat(entryPrice);
  if (isNaN(price) || leverage <= 0) {
    return '0';
  }

  // 清算价格 = 开仓价格 * (1 ± (1/杠杆 - 维持保证金率))
  const margin = 1 / leverage - maintenanceMarginRate;

  let liqPrice: number;
  if (isLong) {
    liqPrice = price * (1 - margin);
  } else {
    liqPrice = price * (1 + margin);
  }

  return Math.max(0, liqPrice).toFixed(8);
}

/**
 * 综合验证开仓参数
 */
export interface OpenPositionValidationResult {
  isValid: boolean;
  errors: string[];
  calculations?: {
    requiredMargin: string;
    liquidationPrice: string;
  };
}

export function validateOpenPositionParams(params: {
  size: string;
  leverage: number;
  price: string;
  availableBalance: string;
  isLong: boolean;
  minSize?: string;
  maxSize?: string;
  maxLeverage?: number;
}): OpenPositionValidationResult {
  const errors: string[] = [];

  // 验证仓位大小
  const sizeValidation = validatePositionSize(params.size, params.minSize, params.maxSize);
  if (!sizeValidation.isValid && sizeValidation.error) {
    errors.push(sizeValidation.error);
  }

  // 验证杠杆
  const leverageValidation = validateLeverage(params.leverage, params.maxLeverage);
  if (!leverageValidation.isValid && leverageValidation.error) {
    errors.push(leverageValidation.error);
  }

  // 计算所需保证金
  const requiredMargin = calculateRequiredMargin(params.size, params.price, params.leverage);

  // 验证保证金
  const marginValidation = validateMarginSufficiency(params.availableBalance, requiredMargin);
  if (!marginValidation.isValid && marginValidation.error) {
    errors.push(marginValidation.error);
  }

  // 计算清算价格
  const liquidationPrice = calculateLiquidationPrice(params.price, params.leverage, params.isLong);

  return {
    isValid: errors.length === 0,
    errors,
    calculations: {
      requiredMargin,
      liquidationPrice,
    },
  };
}
