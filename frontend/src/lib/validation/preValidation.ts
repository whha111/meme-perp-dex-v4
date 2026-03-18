/**
 * 前置校验系统 (Pre-validation System)
 *
 * 在用户执行操作前，实时检测潜在问题并显示警告
 * 提升用户体验，避免无效操作
 */

import { formatEther, parseEther } from "viem";

// ============================================================
// 类型定义
// ============================================================

/**
 * 校验结果严重程度
 */
export type ValidationSeverity = "error" | "warning" | "info";

/**
 * 单个校验结果
 */
export interface ValidationResult {
  id: string;                    // 唯一标识
  severity: ValidationSeverity;  // 严重程度
  message: string;               // 显示消息
  messageEn?: string;            // 英文消息
  field?: string;                // 关联字段
  suggestion?: string;           // 建议操作
  suggestioEn?: string;         // 英文建议
}

/**
 * 校验状态
 */
export interface ValidationState {
  isValid: boolean;              // 是否通过所有校验
  canSubmit: boolean;            // 是否可以提交（warning 时可提交）
  results: ValidationResult[];   // 所有校验结果
  errors: ValidationResult[];    // 仅错误
  warnings: ValidationResult[];  // 仅警告
}

// ============================================================
// 校验 ID 常量
// ============================================================

export const ValidationIds = {
  // 钱包相关
  WALLET_NOT_CONNECTED: "wallet_not_connected",
  WALLET_WRONG_NETWORK: "wallet_wrong_network",

  // 余额相关
  INSUFFICIENT_BALANCE: "insufficient_balance",
  INSUFFICIENT_GAS: "insufficient_gas",

  // 金额相关
  AMOUNT_EMPTY: "amount_empty",
  AMOUNT_ZERO: "amount_zero",
  AMOUNT_TOO_SMALL: "amount_too_small",
  AMOUNT_TOO_LARGE: "amount_too_large",
  AMOUNT_EXCEEDS_BALANCE: "amount_exceeds_balance",

  // 交易相关
  PRICE_IMPACT_HIGH: "price_impact_high",
  PRICE_IMPACT_VERY_HIGH: "price_impact_very_high",
  SLIPPAGE_WARNING: "slippage_warning",
  INSUFFICIENT_LIQUIDITY: "insufficient_liquidity",

  // 授权相关
  APPROVAL_REQUIRED: "approval_required",
  APPROVAL_PENDING: "approval_pending",

  // 域名相关
  DOMAIN_EMPTY: "domain_empty",
  DOMAIN_INVALID: "domain_invalid",
  DOMAIN_EXISTS: "domain_exists",
  DOMAIN_NOT_VERIFIED: "domain_not_verified",

  // 池子相关
  POOL_NOT_ACTIVE: "pool_not_active",
  TOKEN_GRADUATED: "token_graduated",
} as const;

// ============================================================
// 校验消息字典（中英文）
// ============================================================

interface MessagePair {
  zh: string;
  en: string;
  suggestion?: { zh: string; en: string };
}

const VALIDATION_MESSAGES: Record<string, MessagePair> = {
  [ValidationIds.WALLET_NOT_CONNECTED]: {
    zh: "请先连接钱包",
    en: "Please connect your wallet",
  },
  [ValidationIds.WALLET_WRONG_NETWORK]: {
    zh: "请切换到正确的网络",
    en: "Please switch to the correct network",
  },
  [ValidationIds.INSUFFICIENT_BALANCE]: {
    zh: "余额不足",
    en: "Insufficient balance",
  },
  [ValidationIds.INSUFFICIENT_GAS]: {
    zh: "BNB 不足以支付手续费",
    en: "Insufficient BNB for gas fees",
    suggestion: {
      zh: "建议保留至少 0.005 BNB",
      en: "Keep at least 0.005 BNB for gas",
    },
  },
  [ValidationIds.AMOUNT_EMPTY]: {
    zh: "请输入金额",
    en: "Please enter an amount",
  },
  [ValidationIds.AMOUNT_ZERO]: {
    zh: "金额必须大于 0",
    en: "Amount must be greater than 0",
  },
  [ValidationIds.AMOUNT_TOO_SMALL]: {
    zh: "金额低于最小限制",
    en: "Amount is below minimum",
  },
  [ValidationIds.AMOUNT_TOO_LARGE]: {
    zh: "金额超过最大限制",
    en: "Amount exceeds maximum",
  },
  [ValidationIds.AMOUNT_EXCEEDS_BALANCE]: {
    zh: "金额超过可用余额",
    en: "Amount exceeds available balance",
  },
  [ValidationIds.PRICE_IMPACT_HIGH]: {
    zh: "价格影响较大",
    en: "High price impact",
    suggestion: {
      zh: "建议减少交易金额",
      en: "Consider reducing the amount",
    },
  },
  [ValidationIds.PRICE_IMPACT_VERY_HIGH]: {
    zh: "价格影响较大（正常现象）",
    en: "High price impact (normal for bonding curve)",
    suggestion: {
      zh: "可分批交易以降低影响",
      en: "Consider splitting into smaller trades",
    },
  },
  [ValidationIds.SLIPPAGE_WARNING]: {
    zh: "当前滑点设置较高",
    en: "Current slippage tolerance is high",
  },
  [ValidationIds.INSUFFICIENT_LIQUIDITY]: {
    zh: "池中流动性不足",
    en: "Insufficient liquidity in pool",
    suggestion: {
      zh: "请减少交易金额",
      en: "Please reduce the amount",
    },
  },
  [ValidationIds.APPROVAL_REQUIRED]: {
    zh: "需要先授权代币",
    en: "Token approval required",
  },
  [ValidationIds.APPROVAL_PENDING]: {
    zh: "授权交易进行中...",
    en: "Approval transaction pending...",
  },
  [ValidationIds.DOMAIN_EMPTY]: {
    zh: "请输入域名",
    en: "Please enter a domain",
  },
  [ValidationIds.DOMAIN_INVALID]: {
    zh: "域名格式无效",
    en: "Invalid domain format",
  },
  [ValidationIds.DOMAIN_EXISTS]: {
    zh: "该域名已被注册",
    en: "This domain is already registered",
  },
  [ValidationIds.DOMAIN_NOT_VERIFIED]: {
    zh: "请先完成域名验证",
    en: "Please verify domain ownership first",
  },
  [ValidationIds.POOL_NOT_ACTIVE]: {
    zh: "交易池尚未激活",
    en: "Trading pool is not active",
  },
  [ValidationIds.TOKEN_GRADUATED]: {
    zh: "该代币已毕业，交易通过 PancakeSwap V2 执行",
    en: "Token graduated — trading via PancakeSwap V2",
  },
};

// ============================================================
// 校验工具函数
// ============================================================

/**
 * 创建校验结果
 */
export function createValidation(
  id: string,
  severity: ValidationSeverity,
  customMessage?: { zh?: string; en?: string },
  field?: string
): ValidationResult {
  const messages = VALIDATION_MESSAGES[id] || { zh: id, en: id };

  return {
    id,
    severity,
    message: customMessage?.zh || messages.zh,
    messageEn: customMessage?.en || messages.en,
    field,
    suggestion: messages.suggestion?.zh,
    suggestioEn: messages.suggestion?.en,
  };
}

/**
 * 合并多个校验结果为状态
 */
export function mergeValidations(results: ValidationResult[]): ValidationState {
  const errors = results.filter(r => r.severity === "error");
  const warnings = results.filter(r => r.severity === "warning");

  return {
    isValid: errors.length === 0,
    canSubmit: errors.length === 0, // error 时不能提交，warning 时可以
    results,
    errors,
    warnings,
  };
}

// ============================================================
// 具体校验函数
// ============================================================

/**
 * 校验钱包连接状态
 */
export function validateWalletConnection(
  isConnected: boolean,
  expectedChainId?: number,
  currentChainId?: number
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!isConnected) {
    results.push(createValidation(ValidationIds.WALLET_NOT_CONNECTED, "error"));
  } else if (expectedChainId && currentChainId && expectedChainId !== currentChainId) {
    results.push(createValidation(ValidationIds.WALLET_WRONG_NETWORK, "error"));
  }

  return results;
}

/**
 * 校验 BNB 余额（包括 Gas 费）
 */
export function validateEthBalance(
  balance: bigint | undefined,
  requiredAmount: bigint,
  estimatedGas: bigint = parseEther("0.005") // 默认预估 0.005 BNB Gas
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!balance || balance === 0n) {
    results.push(createValidation(ValidationIds.INSUFFICIENT_BALANCE, "error", {
      zh: "BNB 余额为 0",
      en: "BNB balance is 0",
    }));
    return results;
  }

  const totalRequired = requiredAmount + estimatedGas;

  if (balance < totalRequired) {
    if (balance < requiredAmount) {
      // 余额不足以支付金额
      results.push(createValidation(ValidationIds.INSUFFICIENT_BALANCE, "error", {
        zh: `余额不足 (当前: ${formatEther(balance)} BNB)`,
        en: `Insufficient balance (Current: ${formatEther(balance)} BNB)`,
      }));
    } else {
      // 余额够，但 Gas 不够
      results.push(createValidation(ValidationIds.INSUFFICIENT_GAS, "warning", {
        zh: `BNB 可能不足以支付手续费 (剩余: ${formatEther(balance - requiredAmount)} BNB)`,
        en: `May not have enough BNB for gas (Remaining: ${formatEther(balance - requiredAmount)} BNB)`,
      }));
    }
  }

  return results;
}

/**
 * 校验代币余额
 */
export function validateTokenBalance(
  balance: bigint | undefined,
  requiredAmount: bigint,
  tokenSymbol: string = "Token"
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!balance || balance === 0n) {
    results.push(createValidation(ValidationIds.INSUFFICIENT_BALANCE, "error", {
      zh: `${tokenSymbol} 余额为 0`,
      en: `${tokenSymbol} balance is 0`,
    }));
    return results;
  }

  if (balance < requiredAmount) {
    results.push(createValidation(ValidationIds.AMOUNT_EXCEEDS_BALANCE, "error", {
      zh: `${tokenSymbol} 余额不足`,
      en: `Insufficient ${tokenSymbol} balance`,
    }));
  }

  return results;
}

/**
 * 校验输入金额
 */
export function validateAmount(
  amount: string | undefined,
  minAmount?: bigint,
  maxAmount?: bigint
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!amount || amount.trim() === "") {
    results.push(createValidation(ValidationIds.AMOUNT_EMPTY, "error"));
    return results;
  }

  try {
    const amountBigInt = parseEther(amount);

    if (amountBigInt === 0n) {
      results.push(createValidation(ValidationIds.AMOUNT_ZERO, "error"));
      return results;
    }

    if (minAmount && amountBigInt < minAmount) {
      results.push(createValidation(ValidationIds.AMOUNT_TOO_SMALL, "error", {
        zh: `最小金额: ${formatEther(minAmount)} BNB`,
        en: `Minimum amount: ${formatEther(minAmount)} BNB`,
      }));
    }

    if (maxAmount && amountBigInt > maxAmount) {
      results.push(createValidation(ValidationIds.AMOUNT_TOO_LARGE, "error", {
        zh: `最大金额: ${formatEther(maxAmount)} BNB`,
        en: `Maximum amount: ${formatEther(maxAmount)} BNB`,
      }));
    }
  } catch {
    results.push(createValidation(ValidationIds.AMOUNT_EMPTY, "error", {
      zh: "请输入有效金额",
      en: "Please enter a valid amount",
    }));
  }

  return results;
}

/**
 * 校验价格影响
 *
 * 注意：完全移除价格影响限制
 * Bonding Curve 大额交易的高价格影响是正常的 AMM 机制
 * 不阻止任何交易，只显示信息提示
 */
export function validatePriceImpact(
  priceImpact: number | undefined,
  warningThreshold: number = 20,  // 20% 显示提示（仅信息，不阻止）
  errorThreshold: number = 100    // 100% 永不触发错误
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (priceImpact === undefined) return results;

  // 只显示信息提示，不阻止交易
  if (priceImpact >= warningThreshold) {
    results.push(createValidation(ValidationIds.PRICE_IMPACT_HIGH, "info", {
      zh: `价格影响 ${priceImpact.toFixed(2)}%`,
      en: `Price impact ${priceImpact.toFixed(2)}%`,
    }));
  }

  return results;
}

/**
 * 校验滑点设置
 */
export function validateSlippage(
  slippageBps: number,
  warningThreshold: number = 500 // 5%
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (slippageBps >= warningThreshold) {
    const slippagePercent = slippageBps / 100;
    results.push(createValidation(ValidationIds.SLIPPAGE_WARNING, "warning", {
      zh: `滑点设置 ${slippagePercent}%，可能导致不利成交`,
      en: `Slippage tolerance ${slippagePercent}%, may result in unfavorable execution`,
    }));
  }

  return results;
}

/**
 * 校验授权状态
 */
export function validateApproval(
  allowance: bigint | undefined,
  requiredAmount: bigint,
  isPending: boolean = false
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (isPending) {
    results.push(createValidation(ValidationIds.APPROVAL_PENDING, "info"));
    return results;
  }

  if (!allowance || allowance < requiredAmount) {
    results.push(createValidation(ValidationIds.APPROVAL_REQUIRED, "warning"));
  }

  return results;
}

/**
 * 校验域名
 */
export function validateDomain(
  domain: string | undefined,
  existingDomains?: string[]
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!domain || domain.trim() === "") {
    results.push(createValidation(ValidationIds.DOMAIN_EMPTY, "error"));
    return results;
  }

  // 简单的域名格式校验
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
  if (!domainRegex.test(domain)) {
    results.push(createValidation(ValidationIds.DOMAIN_INVALID, "error"));
    return results;
  }

  // 检查是否已存在
  if (existingDomains?.includes(domain.toLowerCase())) {
    results.push(createValidation(ValidationIds.DOMAIN_EXISTS, "error"));
  }

  return results;
}

/**
 * 校验池子状态
 */
export function validatePoolStatus(
  isActive: boolean,
  isGraduated: boolean
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (isGraduated) {
    results.push(createValidation(ValidationIds.TOKEN_GRADUATED, "warning"));
  } else if (!isActive) {
    results.push(createValidation(ValidationIds.POOL_NOT_ACTIVE, "error"));
  }

  return results;
}

// ============================================================
// 组合校验函数
// ============================================================

/**
 * 买入交易的完整校验
 */
export function validateBuyTransaction(params: {
  isConnected: boolean;
  chainId?: number;
  expectedChainId?: number;
  ethBalance?: bigint;
  amount: string;
  priceImpact?: number;
  slippageBps: number;
  isPoolActive: boolean;
  isGraduated: boolean;
  minAmount?: bigint;
}): ValidationState {
  const results: ValidationResult[] = [];

  // 1. 钱包校验
  results.push(...validateWalletConnection(
    params.isConnected,
    params.expectedChainId,
    params.chainId
  ));

  // 如果钱包未连接，直接返回
  if (!params.isConnected) {
    return mergeValidations(results);
  }

  // 2. 池子状态校验
  results.push(...validatePoolStatus(params.isPoolActive, params.isGraduated));

  // 3. 金额校验
  results.push(...validateAmount(params.amount, params.minAmount));

  // 如果金额无效，跳过余额校验
  if (results.some(r => r.id === ValidationIds.AMOUNT_EMPTY || r.id === ValidationIds.AMOUNT_ZERO)) {
    return mergeValidations(results);
  }

  // 4. ETH 余额校验
  try {
    const amountBigInt = parseEther(params.amount);
    results.push(...validateEthBalance(params.ethBalance, amountBigInt));
  } catch {
    // 金额解析失败，已在上面处理
  }

  // 5. 价格影响校验
  results.push(...validatePriceImpact(params.priceImpact));

  // 6. 滑点校验
  results.push(...validateSlippage(params.slippageBps));

  return mergeValidations(results);
}

/**
 * 卖出交易的完整校验
 */
export function validateSellTransaction(params: {
  isConnected: boolean;
  chainId?: number;
  expectedChainId?: number;
  tokenBalance?: bigint;
  tokenSymbol: string;
  amount: string;
  priceImpact?: number;
  slippageBps: number;
  ethBalance?: bigint;  // 用于检查 Gas
  isPoolActive: boolean;
  isGraduated: boolean;
  allowance?: bigint;
}): ValidationState {
  const results: ValidationResult[] = [];

  // 1. 钱包校验
  results.push(...validateWalletConnection(
    params.isConnected,
    params.expectedChainId,
    params.chainId
  ));

  if (!params.isConnected) {
    return mergeValidations(results);
  }

  // 2. 池子状态校验
  results.push(...validatePoolStatus(params.isPoolActive, params.isGraduated));

  // 3. 金额校验
  results.push(...validateAmount(params.amount));

  if (results.some(r => r.id === ValidationIds.AMOUNT_EMPTY || r.id === ValidationIds.AMOUNT_ZERO)) {
    return mergeValidations(results);
  }

  // 4. 代币余额校验
  try {
    const amountBigInt = parseEther(params.amount);
    results.push(...validateTokenBalance(params.tokenBalance, amountBigInt, params.tokenSymbol));

    // 5. 授权校验
    results.push(...validateApproval(params.allowance, amountBigInt));
  } catch {
    // 已处理
  }

  // 6. Gas 费校验
  results.push(...validateEthBalance(params.ethBalance, 0n)); // 只检查 Gas

  // 7. 价格影响校验
  results.push(...validatePriceImpact(params.priceImpact));

  // 8. 滑点校验
  results.push(...validateSlippage(params.slippageBps));

  return mergeValidations(results);
}

/**
 * 创建代币的完整校验
 */
export function validateCreateToken(params: {
  isConnected: boolean;
  chainId?: number;
  expectedChainId?: number;
  domain: string;
  isDomainVerified: boolean;
  ethBalance?: bigint;
  initialLiquidity?: string;
}): ValidationState {
  const results: ValidationResult[] = [];

  // 1. 钱包校验
  results.push(...validateWalletConnection(
    params.isConnected,
    params.expectedChainId,
    params.chainId
  ));

  if (!params.isConnected) {
    return mergeValidations(results);
  }

  // 2. 域名校验
  results.push(...validateDomain(params.domain));

  // 3. 域名验证状态
  if (params.domain && !params.isDomainVerified) {
    results.push(createValidation(ValidationIds.DOMAIN_NOT_VERIFIED, "error"));
  }

  // 4. 初始流动性校验（如果有）
  if (params.initialLiquidity) {
    results.push(...validateAmount(params.initialLiquidity, parseEther("0.001")));

    try {
      const amountBigInt = parseEther(params.initialLiquidity);
      results.push(...validateEthBalance(params.ethBalance, amountBigInt));
    } catch {
      // 已处理
    }
  }

  return mergeValidations(results);
}

export default {
  validateBuyTransaction,
  validateSellTransaction,
  validateCreateToken,
  validateWalletConnection,
  validateEthBalance,
  validateTokenBalance,
  validateAmount,
  validatePriceImpact,
  validateSlippage,
  validateApproval,
  validateDomain,
  validatePoolStatus,
  mergeValidations,
  createValidation,
  ValidationIds,
};
