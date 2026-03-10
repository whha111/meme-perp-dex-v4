/**
 * 结构化日志工具
 *
 * - 生产环境 (NODE_ENV=production): 输出 JSON 格式 (适配 ELK/Loki/Datadog)
 * - 开发环境: 输出人类可读格式 (带时间戳和颜色)
 *
 * API 与旧版完全兼容: logger.info("Redis", "Connected", ...args)
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL = parseInt(process.env.LOG_LEVEL || "1");
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// 服务标识 (用于多容器环境区分日志来源)
const SERVICE_NAME = process.env.SERVICE_NAME || "matching-engine";

interface LogEntry {
  level: string;
  time: string;
  service: string;
  module: string;
  msg: string;
  [key: string]: unknown;
}

function formatJSON(level: string, module: string, message: string, args: unknown[]): string {
  const entry: LogEntry = {
    level,
    time: new Date().toISOString(),
    service: SERVICE_NAME,
    module,
    msg: message,
  };

  // 将额外参数序列化为 data 字段
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
    // 如果唯一参数是对象，展开到顶层
    Object.assign(entry, args[0]);
  } else if (args.length > 0) {
    entry.data = args;
  }

  try {
    return JSON.stringify(entry);
  } catch {
    // 防止循环引用导致 JSON.stringify 失败
    entry.data = "[unserializable]";
    return JSON.stringify(entry);
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(module: string, message: string, ...args: unknown[]): void {
    if (LOG_LEVEL > LogLevel.DEBUG) return;
    if (IS_PRODUCTION) {
      process.stdout.write(formatJSON("debug", module, message, args) + "\n");
    } else {
      console.debug(`[${formatTimestamp()}] [DEBUG] [${module}]`, message, ...args);
    }
  },

  info(module: string, message: string, ...args: unknown[]): void {
    if (LOG_LEVEL > LogLevel.INFO) return;
    if (IS_PRODUCTION) {
      process.stdout.write(formatJSON("info", module, message, args) + "\n");
    } else {
      console.log(`[${formatTimestamp()}] [INFO] [${module}]`, message, ...args);
    }
  },

  warn(module: string, message: string, ...args: unknown[]): void {
    if (LOG_LEVEL > LogLevel.WARN) return;
    if (IS_PRODUCTION) {
      process.stderr.write(formatJSON("warn", module, message, args) + "\n");
    } else {
      console.warn(`[${formatTimestamp()}] [WARN] [${module}]`, message, ...args);
    }
  },

  error(module: string, message: string, ...args: unknown[]): void {
    if (LOG_LEVEL > LogLevel.ERROR) return;
    if (IS_PRODUCTION) {
      process.stderr.write(formatJSON("error", module, message, args) + "\n");
    } else {
      console.error(`[${formatTimestamp()}] [ERROR] [${module}]`, message, ...args);
    }
  },
};

/**
 * 拦截 console.* 输出，在生产环境统一为 JSON 格式。
 * 仅在生产环境调用一次。非破坏性 — 保留原始 console 方法作为后备。
 */
export function enableStructuredConsole(): void {
  if (!IS_PRODUCTION) return;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    process.stdout.write(formatJSON("info", "console", msg, []) + "\n");
  };

  console.warn = (...args: unknown[]) => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    process.stderr.write(formatJSON("warn", "console", msg, []) + "\n");
  };

  console.error = (...args: unknown[]) => {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    process.stderr.write(formatJSON("error", "console", msg, []) + "\n");
  };

  // 保留原始方法以防需要回退
  (console as any)._originalLog = originalLog;
  (console as any)._originalWarn = originalWarn;
  (console as any)._originalError = originalError;

  originalLog("[Logger] Structured JSON logging enabled (production mode)");
}

export default logger;
