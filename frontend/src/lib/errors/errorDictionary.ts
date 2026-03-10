/**
 * 错误码字典 - 完整版
 *
 * 覆盖整个系统所有可能的错误场景
 * 支持多语言（中文/英文）
 */

// ============================================================
// 错误码定义
// ============================================================

export enum ErrorCode {
  // ==================== 通用错误 (1xxx) ====================
  UNKNOWN = "1000",
  INVALID_ARGUMENT = "1001",
  NOT_FOUND = "1002",
  UNAVAILABLE = "1003",
  INTERNAL = "1004",
  PERMISSION_DENIED = "1005",
  RESOURCE_EXHAUSTED = "1006",
  DEADLINE_EXCEEDED = "1007",
  OPERATION_CANCELLED = "1008",

  // ==================== 钱包错误 (2xxx) ====================
  WALLET_NOT_CONNECTED = "2001",
  WALLET_WRONG_NETWORK = "2002",
  WALLET_INSUFFICIENT_BALANCE = "2003",
  WALLET_INSUFFICIENT_GAS = "2004",
  WALLET_ADDRESS_INVALID = "2005",
  WALLET_LOCKED = "2006",
  WALLET_CONNECTION_FAILED = "2007",
  WALLET_DISCONNECTED = "2008",

  // ==================== 交易错误 (3xxx) ====================
  TRANSACTION_REJECTED = "3001",        // 用户取消
  TRANSACTION_FAILED = "3002",          // 链上失败
  TRANSACTION_TIMEOUT = "3003",         // 确认超时
  TRANSACTION_REPLACED = "3004",        // 被替换
  TRANSACTION_UNDERPRICED = "3005",     // Gas 过低
  TRANSACTION_NONCE_ERROR = "3006",     // Nonce 错误
  TRANSACTION_REVERTED = "3007",        // 合约 revert

  // ==================== 交易参数错误 (31xx) ====================
  SLIPPAGE_EXCEEDED = "3101",
  PRICE_IMPACT_TOO_HIGH = "3102",
  INSUFFICIENT_LIQUIDITY = "3103",
  AMOUNT_TOO_SMALL = "3104",
  AMOUNT_TOO_LARGE = "3105",
  DEADLINE_PASSED = "3106",

  // ==================== 合约错误 (4xxx) ====================
  CONTRACT_ERROR = "4001",
  CONTRACT_NOT_FOUND = "4002",
  CONTRACT_CALL_FAILED = "4003",
  APPROVAL_FAILED = "4004",
  APPROVAL_PENDING = "4005",
  GAS_ESTIMATION_FAILED = "4006",

  // ==================== 域名错误 (5xxx) ====================
  DOMAIN_INVALID = "5001",
  DOMAIN_NOT_FOUND = "5002",
  DOMAIN_ALREADY_EXISTS = "5003",
  DOMAIN_NOT_VERIFIED = "5004",
  DOMAIN_EXPIRED = "5005",
  DOMAIN_NOT_OWNED = "5006",

  // ==================== DNS 验证错误 (51xx) ====================
  DNS_QUERY_FAILED = "5101",
  DNS_VERIFICATION_FAILED = "5102",
  DNS_RECORD_NOT_FOUND = "5103",
  DNS_RECORD_MISMATCH = "5104",
  DNS_PROPAGATION_PENDING = "5105",

  // ==================== 代币错误 (6xxx) ====================
  TOKEN_CREATE_FAILED = "6001",
  TOKEN_NOT_FOUND = "6002",
  TOKEN_ALREADY_EXISTS = "6003",
  TOKEN_GRADUATED = "6004",
  TOKEN_NOT_ACTIVE = "6005",
  POOL_INIT_FAILED = "6006",
  POOL_NOT_FOUND = "6007",

  // ==================== 签名错误 (7xxx) ====================
  SIGNATURE_FAILED = "7001",
  SIGNATURE_INVALID = "7002",
  SIGNATURE_EXPIRED = "7003",
  SIGNATURE_REJECTED = "7004",

  // ==================== 网络错误 (8xxx) ====================
  NETWORK_ERROR = "8001",
  NETWORK_TIMEOUT = "8002",
  RPC_ERROR = "8003",
  RPC_RATE_LIMITED = "8004",
  WEBSOCKET_DISCONNECTED = "8005",
  WEBSOCKET_ERROR = "8006",
  API_ERROR = "8007",
  API_RATE_LIMITED = "8008",

  // ==================== 系统错误 (9xxx) ====================
  SYSTEM_MAINTENANCE = "9001",
  SYSTEM_OVERLOADED = "9002",
  FEATURE_DISABLED = "9003",
  VERSION_OUTDATED = "9004",
}

// ============================================================
// 错误消息字典 - 多语言
// ============================================================

export interface ErrorMessage {
  title: string;
  description: string;
}

export const ERROR_MESSAGES: Record<string, Record<ErrorCode, ErrorMessage>> = {
  // ==================== 中文 ====================
  zh: {
    // 通用错误
    [ErrorCode.UNKNOWN]: { title: "未知错误", description: "发生了未知错误，请稍后重试" },
    [ErrorCode.INVALID_ARGUMENT]: { title: "参数错误", description: "输入的参数无效，请检查后重试" },
    [ErrorCode.NOT_FOUND]: { title: "未找到", description: "请求的资源不存在" },
    [ErrorCode.UNAVAILABLE]: { title: "服务不可用", description: "服务暂时不可用，请稍后重试" },
    [ErrorCode.INTERNAL]: { title: "系统错误", description: "系统内部错误，请稍后重试" },
    [ErrorCode.PERMISSION_DENIED]: { title: "权限不足", description: "您没有执行此操作的权限" },
    [ErrorCode.RESOURCE_EXHAUSTED]: { title: "请求过多", description: "请求过于频繁，请稍后重试" },
    [ErrorCode.DEADLINE_EXCEEDED]: { title: "请求超时", description: "请求处理超时，请重试" },
    [ErrorCode.OPERATION_CANCELLED]: { title: "操作已取消", description: "操作已被取消" },

    // 钱包错误
    [ErrorCode.WALLET_NOT_CONNECTED]: { title: "钱包未连接", description: "请先连接您的钱包" },
    [ErrorCode.WALLET_WRONG_NETWORK]: { title: "网络错误", description: "请切换到正确的网络" },
    [ErrorCode.WALLET_INSUFFICIENT_BALANCE]: { title: "余额不足", description: "账户余额不足以完成交易" },
    [ErrorCode.WALLET_INSUFFICIENT_GAS]: { title: "Gas 不足", description: "账户 BNB 不足以支付 Gas 费" },
    [ErrorCode.WALLET_ADDRESS_INVALID]: { title: "地址无效", description: "钱包地址格式无效" },
    [ErrorCode.WALLET_LOCKED]: { title: "钱包已锁定", description: "请解锁您的钱包" },
    [ErrorCode.WALLET_CONNECTION_FAILED]: { title: "连接失败", description: "钱包连接失败，请重试" },
    [ErrorCode.WALLET_DISCONNECTED]: { title: "钱包断开", description: "钱包连接已断开，请重新连接" },

    // 交易错误
    [ErrorCode.TRANSACTION_REJECTED]: { title: "交易已取消", description: "您取消了此次交易" },
    [ErrorCode.TRANSACTION_FAILED]: { title: "交易失败", description: "交易执行失败，请检查参数后重试" },
    [ErrorCode.TRANSACTION_TIMEOUT]: { title: "交易超时", description: "交易确认超时，请在区块浏览器查看状态" },
    [ErrorCode.TRANSACTION_REPLACED]: { title: "交易被替换", description: "交易已被新交易替换" },
    [ErrorCode.TRANSACTION_UNDERPRICED]: { title: "Gas 过低", description: "Gas 费用过低，请提高后重试" },
    [ErrorCode.TRANSACTION_NONCE_ERROR]: { title: "交易冲突", description: "交易序号冲突，请稍后重试" },
    [ErrorCode.TRANSACTION_REVERTED]: { title: "合约拒绝", description: "智能合约拒绝了此交易" },

    // 交易参数错误
    [ErrorCode.SLIPPAGE_EXCEEDED]: { title: "滑点超限", description: "价格波动超过滑点设置，请调整后重试" },
    [ErrorCode.PRICE_IMPACT_TOO_HIGH]: { title: "价格影响过大", description: "此交易对价格影响过大" },
    [ErrorCode.INSUFFICIENT_LIQUIDITY]: { title: "流动性不足", description: "池中流动性不足，请减少交易金额" },
    [ErrorCode.AMOUNT_TOO_SMALL]: { title: "金额过小", description: "交易金额低于最小限制" },
    [ErrorCode.AMOUNT_TOO_LARGE]: { title: "金额过大", description: "交易金额超过最大限制" },
    [ErrorCode.DEADLINE_PASSED]: { title: "交易过期", description: "交易已过期，请重新提交" },

    // 合约错误
    [ErrorCode.CONTRACT_ERROR]: { title: "合约错误", description: "智能合约执行出错" },
    [ErrorCode.CONTRACT_NOT_FOUND]: { title: "合约未找到", description: "智能合约地址无效" },
    [ErrorCode.CONTRACT_CALL_FAILED]: { title: "调用失败", description: "合约调用失败，请稍后重试" },
    [ErrorCode.APPROVAL_FAILED]: { title: "授权失败", description: "代币授权失败，请重试" },
    [ErrorCode.APPROVAL_PENDING]: { title: "授权中", description: "请先完成代币授权" },
    [ErrorCode.GAS_ESTIMATION_FAILED]: { title: "Gas 估算失败", description: "无法估算 Gas，交易可能会失败" },

    // 域名错误
    [ErrorCode.DOMAIN_INVALID]: { title: "域名无效", description: "域名格式不正确" },
    [ErrorCode.DOMAIN_NOT_FOUND]: { title: "域名不存在", description: "该域名尚未注册" },
    [ErrorCode.DOMAIN_ALREADY_EXISTS]: { title: "域名已存在", description: "该域名已被注册" },
    [ErrorCode.DOMAIN_NOT_VERIFIED]: { title: "域名未验证", description: "请先完成域名所有权验证" },
    [ErrorCode.DOMAIN_EXPIRED]: { title: "域名已过期", description: "域名验证已过期，请重新验证" },
    [ErrorCode.DOMAIN_NOT_OWNED]: { title: "非域名所有者", description: "您不是该域名的所有者" },

    // DNS 验证错误
    [ErrorCode.DNS_QUERY_FAILED]: { title: "DNS 查询失败", description: "无法查询域名 DNS 记录" },
    [ErrorCode.DNS_VERIFICATION_FAILED]: { title: "DNS 验证失败", description: "DNS 记录验证未通过" },
    [ErrorCode.DNS_RECORD_NOT_FOUND]: { title: "记录未找到", description: "未找到 DNS TXT 记录" },
    [ErrorCode.DNS_RECORD_MISMATCH]: { title: "记录不匹配", description: "DNS 记录与预期不符" },
    [ErrorCode.DNS_PROPAGATION_PENDING]: { title: "DNS 传播中", description: "DNS 记录正在传播，请等待几分钟后重试" },

    // 代币错误
    [ErrorCode.TOKEN_CREATE_FAILED]: { title: "创建失败", description: "代币创建失败，请重试" },
    [ErrorCode.TOKEN_NOT_FOUND]: { title: "代币不存在", description: "该代币尚未创建" },
    [ErrorCode.TOKEN_ALREADY_EXISTS]: { title: "代币已存在", description: "该域名的代币已存在" },
    [ErrorCode.TOKEN_GRADUATED]: { title: "代币已毕业", description: "该代币已迁移到 DEX" },
    [ErrorCode.TOKEN_NOT_ACTIVE]: { title: "代币未激活", description: "代币尚未激活交易" },
    [ErrorCode.POOL_INIT_FAILED]: { title: "池子初始化失败", description: "流动性池初始化失败" },
    [ErrorCode.POOL_NOT_FOUND]: { title: "池子不存在", description: "流动性池尚未创建" },

    // 签名错误
    [ErrorCode.SIGNATURE_FAILED]: { title: "签名失败", description: "消息签名失败，请重试" },
    [ErrorCode.SIGNATURE_INVALID]: { title: "签名无效", description: "签名验证未通过" },
    [ErrorCode.SIGNATURE_EXPIRED]: { title: "签名过期", description: "签名已过期，请重新签名" },
    [ErrorCode.SIGNATURE_REJECTED]: { title: "签名已拒绝", description: "您拒绝了签名请求" },

    // 网络错误
    [ErrorCode.NETWORK_ERROR]: { title: "网络错误", description: "网络连接失败，请检查网络后重试" },
    [ErrorCode.NETWORK_TIMEOUT]: { title: "网络超时", description: "网络请求超时，请重试" },
    [ErrorCode.RPC_ERROR]: { title: "RPC 错误", description: "区块链节点连接失败" },
    [ErrorCode.RPC_RATE_LIMITED]: { title: "请求受限", description: "RPC 请求过于频繁，请稍后重试" },
    [ErrorCode.WEBSOCKET_DISCONNECTED]: { title: "连接断开", description: "实时连接已断开，正在重连..." },
    [ErrorCode.WEBSOCKET_ERROR]: { title: "连接错误", description: "实时连接出现错误" },
    [ErrorCode.API_ERROR]: { title: "API 错误", description: "服务器请求失败" },
    [ErrorCode.API_RATE_LIMITED]: { title: "请求受限", description: "API 请求过于频繁，请稍后重试" },

    // 系统错误
    [ErrorCode.SYSTEM_MAINTENANCE]: { title: "系统维护中", description: "系统正在维护，请稍后访问" },
    [ErrorCode.SYSTEM_OVERLOADED]: { title: "系统繁忙", description: "系统负载过高，请稍后重试" },
    [ErrorCode.FEATURE_DISABLED]: { title: "功能未开放", description: "该功能暂时不可用" },
    [ErrorCode.VERSION_OUTDATED]: { title: "版本过旧", description: "请刷新页面获取最新版本" },
  },

  // ==================== English ====================
  en: {
    // General errors
    [ErrorCode.UNKNOWN]: { title: "Unknown Error", description: "An unknown error occurred. Please try again." },
    [ErrorCode.INVALID_ARGUMENT]: { title: "Invalid Input", description: "The input provided is invalid. Please check and try again." },
    [ErrorCode.NOT_FOUND]: { title: "Not Found", description: "The requested resource was not found." },
    [ErrorCode.UNAVAILABLE]: { title: "Service Unavailable", description: "The service is temporarily unavailable. Please try again later." },
    [ErrorCode.INTERNAL]: { title: "System Error", description: "An internal system error occurred. Please try again." },
    [ErrorCode.PERMISSION_DENIED]: { title: "Permission Denied", description: "You don't have permission to perform this action." },
    [ErrorCode.RESOURCE_EXHAUSTED]: { title: "Too Many Requests", description: "Too many requests. Please try again later." },
    [ErrorCode.DEADLINE_EXCEEDED]: { title: "Request Timeout", description: "The request timed out. Please try again." },
    [ErrorCode.OPERATION_CANCELLED]: { title: "Operation Cancelled", description: "The operation was cancelled." },

    // Wallet errors
    [ErrorCode.WALLET_NOT_CONNECTED]: { title: "Wallet Not Connected", description: "Please connect your wallet first." },
    [ErrorCode.WALLET_WRONG_NETWORK]: { title: "Wrong Network", description: "Please switch to the correct network." },
    [ErrorCode.WALLET_INSUFFICIENT_BALANCE]: { title: "Insufficient Balance", description: "Your account balance is insufficient for this transaction." },
    [ErrorCode.WALLET_INSUFFICIENT_GAS]: { title: "Insufficient Gas", description: "Not enough BNB to pay for gas fees." },
    [ErrorCode.WALLET_ADDRESS_INVALID]: { title: "Invalid Address", description: "The wallet address is invalid." },
    [ErrorCode.WALLET_LOCKED]: { title: "Wallet Locked", description: "Please unlock your wallet." },
    [ErrorCode.WALLET_CONNECTION_FAILED]: { title: "Connection Failed", description: "Failed to connect wallet. Please try again." },
    [ErrorCode.WALLET_DISCONNECTED]: { title: "Wallet Disconnected", description: "Wallet connection lost. Please reconnect." },

    // Transaction errors
    [ErrorCode.TRANSACTION_REJECTED]: { title: "Transaction Cancelled", description: "You cancelled the transaction." },
    [ErrorCode.TRANSACTION_FAILED]: { title: "Transaction Failed", description: "The transaction failed. Please check and try again." },
    [ErrorCode.TRANSACTION_TIMEOUT]: { title: "Transaction Timeout", description: "Transaction confirmation timed out. Check the block explorer." },
    [ErrorCode.TRANSACTION_REPLACED]: { title: "Transaction Replaced", description: "The transaction was replaced by a new one." },
    [ErrorCode.TRANSACTION_UNDERPRICED]: { title: "Gas Too Low", description: "Gas fee is too low. Please increase and try again." },
    [ErrorCode.TRANSACTION_NONCE_ERROR]: { title: "Transaction Conflict", description: "Transaction nonce conflict. Please try again." },
    [ErrorCode.TRANSACTION_REVERTED]: { title: "Contract Rejected", description: "The smart contract rejected this transaction." },

    // Transaction parameter errors
    [ErrorCode.SLIPPAGE_EXCEEDED]: { title: "Slippage Exceeded", description: "Price moved beyond your slippage tolerance." },
    [ErrorCode.PRICE_IMPACT_TOO_HIGH]: { title: "High Price Impact", description: "This trade has a significant price impact." },
    [ErrorCode.INSUFFICIENT_LIQUIDITY]: { title: "Insufficient Liquidity", description: "Not enough liquidity. Please reduce the amount." },
    [ErrorCode.AMOUNT_TOO_SMALL]: { title: "Amount Too Small", description: "The amount is below the minimum limit." },
    [ErrorCode.AMOUNT_TOO_LARGE]: { title: "Amount Too Large", description: "The amount exceeds the maximum limit." },
    [ErrorCode.DEADLINE_PASSED]: { title: "Transaction Expired", description: "The transaction expired. Please submit again." },

    // Contract errors
    [ErrorCode.CONTRACT_ERROR]: { title: "Contract Error", description: "Smart contract execution failed." },
    [ErrorCode.CONTRACT_NOT_FOUND]: { title: "Contract Not Found", description: "The smart contract address is invalid." },
    [ErrorCode.CONTRACT_CALL_FAILED]: { title: "Call Failed", description: "Contract call failed. Please try again." },
    [ErrorCode.APPROVAL_FAILED]: { title: "Approval Failed", description: "Token approval failed. Please try again." },
    [ErrorCode.APPROVAL_PENDING]: { title: "Approval Pending", description: "Please complete the token approval first." },
    [ErrorCode.GAS_ESTIMATION_FAILED]: { title: "Gas Estimation Failed", description: "Unable to estimate gas. The transaction may fail." },

    // Domain errors
    [ErrorCode.DOMAIN_INVALID]: { title: "Invalid Domain", description: "The domain format is incorrect." },
    [ErrorCode.DOMAIN_NOT_FOUND]: { title: "Domain Not Found", description: "This domain is not registered." },
    [ErrorCode.DOMAIN_ALREADY_EXISTS]: { title: "Domain Exists", description: "This domain is already registered." },
    [ErrorCode.DOMAIN_NOT_VERIFIED]: { title: "Domain Not Verified", description: "Please verify domain ownership first." },
    [ErrorCode.DOMAIN_EXPIRED]: { title: "Domain Expired", description: "Domain verification expired. Please verify again." },
    [ErrorCode.DOMAIN_NOT_OWNED]: { title: "Not Domain Owner", description: "You are not the owner of this domain." },

    // DNS verification errors
    [ErrorCode.DNS_QUERY_FAILED]: { title: "DNS Query Failed", description: "Failed to query domain DNS records." },
    [ErrorCode.DNS_VERIFICATION_FAILED]: { title: "DNS Verification Failed", description: "DNS record verification failed." },
    [ErrorCode.DNS_RECORD_NOT_FOUND]: { title: "Record Not Found", description: "DNS TXT record not found." },
    [ErrorCode.DNS_RECORD_MISMATCH]: { title: "Record Mismatch", description: "DNS record does not match expected value." },
    [ErrorCode.DNS_PROPAGATION_PENDING]: { title: "DNS Propagating", description: "DNS record is propagating. Please wait a few minutes." },

    // Token errors
    [ErrorCode.TOKEN_CREATE_FAILED]: { title: "Creation Failed", description: "Token creation failed. Please try again." },
    [ErrorCode.TOKEN_NOT_FOUND]: { title: "Token Not Found", description: "This token does not exist yet." },
    [ErrorCode.TOKEN_ALREADY_EXISTS]: { title: "Token Exists", description: "A token for this domain already exists." },
    [ErrorCode.TOKEN_GRADUATED]: { title: "Token Graduated", description: "This token has migrated to DEX." },
    [ErrorCode.TOKEN_NOT_ACTIVE]: { title: "Token Not Active", description: "Trading is not yet active for this token." },
    [ErrorCode.POOL_INIT_FAILED]: { title: "Pool Init Failed", description: "Liquidity pool initialization failed." },
    [ErrorCode.POOL_NOT_FOUND]: { title: "Pool Not Found", description: "Liquidity pool has not been created." },

    // Signature errors
    [ErrorCode.SIGNATURE_FAILED]: { title: "Signature Failed", description: "Message signing failed. Please try again." },
    [ErrorCode.SIGNATURE_INVALID]: { title: "Invalid Signature", description: "Signature verification failed." },
    [ErrorCode.SIGNATURE_EXPIRED]: { title: "Signature Expired", description: "The signature has expired. Please sign again." },
    [ErrorCode.SIGNATURE_REJECTED]: { title: "Signature Rejected", description: "You rejected the signature request." },

    // Network errors
    [ErrorCode.NETWORK_ERROR]: { title: "Network Error", description: "Network connection failed. Please check and try again." },
    [ErrorCode.NETWORK_TIMEOUT]: { title: "Network Timeout", description: "Network request timed out. Please try again." },
    [ErrorCode.RPC_ERROR]: { title: "RPC Error", description: "Blockchain node connection failed." },
    [ErrorCode.RPC_RATE_LIMITED]: { title: "Rate Limited", description: "Too many RPC requests. Please try again later." },
    [ErrorCode.WEBSOCKET_DISCONNECTED]: { title: "Disconnected", description: "Real-time connection lost. Reconnecting..." },
    [ErrorCode.WEBSOCKET_ERROR]: { title: "Connection Error", description: "Real-time connection error occurred." },
    [ErrorCode.API_ERROR]: { title: "API Error", description: "Server request failed." },
    [ErrorCode.API_RATE_LIMITED]: { title: "Rate Limited", description: "Too many API requests. Please try again later." },

    // System errors
    [ErrorCode.SYSTEM_MAINTENANCE]: { title: "Under Maintenance", description: "System is under maintenance. Please try again later." },
    [ErrorCode.SYSTEM_OVERLOADED]: { title: "System Busy", description: "System is overloaded. Please try again later." },
    [ErrorCode.FEATURE_DISABLED]: { title: "Feature Disabled", description: "This feature is temporarily unavailable." },
    [ErrorCode.VERSION_OUTDATED]: { title: "Version Outdated", description: "Please refresh the page for the latest version." },
  },
};

// ============================================================
// 获取错误消息
// ============================================================

/**
 * 根据错误码和语言获取错误消息
 */
export function getErrorMessage(code: ErrorCode, locale: string = 'zh'): ErrorMessage {
  const lang = locale.startsWith('zh') ? 'zh' : 'en';
  return ERROR_MESSAGES[lang]?.[code] || ERROR_MESSAGES['en'][ErrorCode.UNKNOWN];
}

/**
 * 判断是否为用户主动取消的操作（不需要显示错误弹窗）
 */
export function isUserCancelledError(code: ErrorCode): boolean {
  return [
    ErrorCode.TRANSACTION_REJECTED,
    ErrorCode.SIGNATURE_REJECTED,
    ErrorCode.OPERATION_CANCELLED,
  ].includes(code);
}

// ============================================================
// 错误码识别 - 从原始错误解析
// ============================================================

/**
 * 从原始错误对象解析错误码
 */
export function parseErrorCode(error: unknown): ErrorCode {
  if (!error) return ErrorCode.UNKNOWN;

  // 检查是否为对象
  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // 1. 检查是否有 code 属性（标准错误码）
    if (typeof err.code === 'string' && err.code in ErrorCode) {
      return err.code as ErrorCode;
    }

    // 2. EIP-1193 错误码
    if (err.code === 4001) return ErrorCode.TRANSACTION_REJECTED;
    if (err.code === 4100) return ErrorCode.WALLET_LOCKED;
    if (err.code === 4200) return ErrorCode.FEATURE_DISABLED;
    if (err.code === 4900) return ErrorCode.WALLET_DISCONNECTED;
    if (err.code === 4901) return ErrorCode.WALLET_WRONG_NETWORK;

    // 3. 检查 name 属性
    const name = typeof err.name === 'string' ? err.name : '';
    if (name.includes('UserRejected') || name.includes('Rejected') || name.includes('Denied')) {
      return ErrorCode.TRANSACTION_REJECTED;
    }
    if (name.includes('InsufficientFunds')) {
      return ErrorCode.WALLET_INSUFFICIENT_BALANCE;
    }

    // 4. 检查 shortMessage
    const shortMessage = typeof err.shortMessage === 'string'
      ? err.shortMessage.toLowerCase()
      : '';
    if (shortMessage.includes('rejected') || shortMessage.includes('denied') ||
        shortMessage.includes('cancel') || shortMessage.includes('declined') ||
        shortMessage.includes('refused') || shortMessage.includes('取消') ||
        shortMessage.includes('拒绝')) {
      return ErrorCode.TRANSACTION_REJECTED;
    }
    if (shortMessage.includes('insufficient')) {
      return ErrorCode.WALLET_INSUFFICIENT_BALANCE;
    }

    // 4.5. 检查 details (wagmi/viem 错误可能有 details)
    const details = typeof err.details === 'string' ? err.details.toLowerCase() : '';
    if (details.includes('rejected') || details.includes('denied') ||
        details.includes('cancel') || details.includes('declined')) {
      return ErrorCode.TRANSACTION_REJECTED;
    }

    // 5. 检查 cause（递归）
    if (err.cause) {
      const causeCode = parseErrorCode(err.cause);
      if (causeCode !== ErrorCode.UNKNOWN) return causeCode;
    }

    // 6. 检查 message
    const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
    return parseErrorFromMessage(message);
  }

  // 字符串错误
  if (typeof error === 'string') {
    return parseErrorFromMessage(error.toLowerCase());
  }

  return ErrorCode.UNKNOWN;
}

/**
 * 从错误消息文本解析错误码
 */
function parseErrorFromMessage(message: string): ErrorCode {
  // 用户取消 - 英文
  if (message.includes('user rejected') || message.includes('user denied') ||
      message.includes('user cancelled') || message.includes('user canceled') ||
      message.includes('rejected the request') || message.includes('denied the request') ||
      message.includes('request was rejected') || message.includes('signature denied') ||
      message.includes('declined') || message.includes('refused')) {
    return ErrorCode.TRANSACTION_REJECTED;
  }

  // 用户取消 - 中文
  if (message.includes('取消') || message.includes('拒绝') || message.includes('用户取消') ||
      message.includes('已取消') || message.includes('已拒绝')) {
    return ErrorCode.TRANSACTION_REJECTED;
  }

  // 签名相关取消
  if (message.includes('签名') && (message.includes('取消') || message.includes('拒绝') || message.includes('失败'))) {
    return ErrorCode.SIGNATURE_REJECTED;
  }

  // 余额不足
  if (message.includes('insufficient funds') || message.includes('insufficient balance')) {
    return ErrorCode.WALLET_INSUFFICIENT_BALANCE;
  }

  // Gas 相关
  if (message.includes('gas required exceeds') || message.includes('out of gas')) {
    return ErrorCode.WALLET_INSUFFICIENT_GAS;
  }
  if (message.includes('underpriced') || message.includes('gas price too low')) {
    return ErrorCode.TRANSACTION_UNDERPRICED;
  }
  if (message.includes('gas estimation failed') || message.includes('cannot estimate')) {
    return ErrorCode.GAS_ESTIMATION_FAILED;
  }

  // Nonce 错误
  if (message.includes('nonce too low') || message.includes('nonce has already been used')) {
    return ErrorCode.TRANSACTION_NONCE_ERROR;
  }

  // 交易被替换
  if (message.includes('replacement transaction') || message.includes('replaced')) {
    return ErrorCode.TRANSACTION_REPLACED;
  }

  // 合约 revert
  if (message.includes('execution reverted') || message.includes('revert')) {
    return ErrorCode.TRANSACTION_REVERTED;
  }

  // 超时
  if (message.includes('timeout') || message.includes('timed out')) {
    return ErrorCode.NETWORK_TIMEOUT;
  }

  // 网络错误
  if (message.includes('network') || message.includes('fetch failed') || message.includes('econnrefused')) {
    return ErrorCode.NETWORK_ERROR;
  }

  // RPC 错误
  if (message.includes('rpc') || message.includes('jsonrpc')) {
    return ErrorCode.RPC_ERROR;
  }

  // 滑点
  if (message.includes('slippage')) {
    return ErrorCode.SLIPPAGE_EXCEEDED;
  }

  // 流动性
  if (message.includes('liquidity')) {
    return ErrorCode.INSUFFICIENT_LIQUIDITY;
  }

  return ErrorCode.UNKNOWN;
}

/**
 * 从 unknown 类型安全地提取错误信息
 * 兼容 wagmi/viem BaseError (shortMessage) 和标准 Error
 */
export function extractErrorMessage(err: unknown, fallback = "操作失败"): string {
  if (err && typeof err === "object") {
    // wagmi/viem BaseError — shortMessage 是面向用户的简短提示
    if ("shortMessage" in err && typeof (err as Record<string, unknown>).shortMessage === "string") {
      return (err as Record<string, unknown>).shortMessage as string;
    }
    if (err instanceof Error) return err.message;
    if ("message" in err && typeof (err as Record<string, unknown>).message === "string") {
      return (err as Record<string, unknown>).message as string;
    }
  }
  if (typeof err === "string") return err;
  return fallback;
}

/**
 * 判断错误是否为用户主动取消操作 (MetaMask / WalletConnect reject)
 */
export function isUserRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e.code === 4001) return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return msg.includes("rejected") || msg.includes("denied") || msg.includes("cancelled");
}

export default ErrorCode;
