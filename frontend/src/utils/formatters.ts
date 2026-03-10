/**
 * 通用格式化工具函数
 */

// Static time-ago translations for all locales
const timeAgoI18n: Record<string, { justNow: string; s: string; m: string; h: string; d: string }> = {
  zh: { justNow: "刚刚", s: "秒前", m: "分钟前", h: "小时前", d: "天前" },
  en: { justNow: "just now", s: "s ago", m: "m ago", h: "h ago", d: "d ago" },
  ja: { justNow: "たった今", s: "秒前", m: "分前", h: "時間前", d: "日前" },
  ko: { justNow: "방금", s: "초 전", m: "분 전", h: "시간 전", d: "일 전" },
};

function getLocale(): string {
  if (typeof window === 'undefined') return 'zh';
  try {
    return localStorage.getItem('meme-perp-locale') || 'zh';
  } catch {
    return 'zh';
  }
}

/**
 * 格式化时间为"多久之前"的形式
 * @param timestamp Unix 时间戳（秒或毫秒）或 bigint
 * @returns 格式化的时间字符串，如 "3m ago"、"2h ago"
 */
export function formatTimeAgo(timestamp: bigint | number | undefined | null): string {
  const t = timeAgoI18n[getLocale()] || timeAgoI18n.zh;

  if (timestamp === undefined || timestamp === null || timestamp === 0) {
    return t.justNow;
  }

  // 自动检测: 如果时间戳大于 1e11，认为是毫秒；否则是秒
  let timestampMs = Number(timestamp);
  if (timestampMs < 1e11) {
    timestampMs = timestampMs * 1000;
  }

  const seconds = Math.floor((Date.now() - timestampMs) / 1000);

  if (seconds < 0) return t.justNow;
  if (seconds < 60) return `${seconds}${t.s}`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${t.m}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${t.h}`;

  const days = Math.floor(hours / 24);
  return `${days}${t.d}`;
}

/**
 * 格式化日期为标准格式
 * @param timestamp Unix 时间戳（毫秒）
 * @returns 格式化的日期字符串，如 "2024-01-05 14:30"
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * 格式化日期为简短格式（仅日期）
 * @param timestamp Unix 时间戳（毫秒）
 * @returns 格式化的日期字符串，如 "2024-01-05"
 */
export function formatDateShort(timestamp: number): string {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 格式化时间为简短格式（仅时间）
 * @param timestamp Unix 时间戳（毫秒）
 * @returns 格式化的时间字符串，如 "14:30:25"
 */
export function formatTimeShort(timestamp: number): string {
  const date = new Date(timestamp);
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${min}:${s}`;
}

/**
 * 格式化数字为带千分位的字符串
 * @param value 数字值
 * @param decimals 小数位数，默认 2
 * @returns 格式化的字符串，如 "1,234.56"
 */
export function formatNumber(value: number, decimals: number = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * 格式化数字为简短形式（K, M, B）
 * @param value 数字值
 * @returns 格式化的字符串，如 "1.2K", "3.4M"
 */
export function formatNumberShort(value: number): string {
  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000).toFixed(2) + 'B';
  }
  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(2) + 'M';
  }
  if (value >= 1_000) {
    return (value / 1_000).toFixed(2) + 'K';
  }
  return value.toFixed(2);
}

/**
 * 格式化 Token 价格 (ETH 本位: Token/ETH 比率)
 * 极小数使用下标格式: 0.00000001016 → "0.0₈1016"
 * @param price 价格数值
 * @returns 格式化的价格字符串
 */
export function formatTokenPrice(price: number): string {
  if (price === 0 || isNaN(price)) return "0";
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  if (price >= 0.0001) return price.toFixed(8);

  // 极小数使用下标格式: 0.0₂₆9890
  // 用 toExponential 解析，避免 toFixed(18) 对超小数丢失精度
  const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
  const expStr = price.toExponential(4); // e.g. "9.8900e-27"
  const expMatch = expStr.match(/^(\d+\.\d+)e([+-]\d+)$/);
  if (expMatch) {
    const coeff = expMatch[1].replace(".", ""); // "98900"
    const exp = parseInt(expMatch[2]); // -27
    if (exp < 0) {
      const zeroCount = Math.abs(exp) - 1; // 26 zeros after "0."
      const significantDigits = coeff.slice(0, 4); // "9890"
      const subscriptNum = zeroCount.toString().split("").map((d) => subscripts[parseInt(d)]).join("");
      return `0.0${subscriptNum}${significantDigits}`;
    }
  }

  // Fallback for moderate small numbers (1e-4 to 1e-18)
  const priceStr = price.toFixed(18);
  const match = priceStr.match(/^0\.(0*)([1-9]\d*)/);
  if (match) {
    const zeroCount = match[1].length;
    const significantDigits = match[2].slice(0, 4);
    const subscriptNum = zeroCount.toString().split("").map((d) => subscripts[parseInt(d)]).join("");
    return `0.0${subscriptNum}${significantDigits}`;
  }
  return price.toFixed(10);
}

/**
 * 格式化 BNB 金额
 * @param amount BNB 金额
 * @returns 格式化的字符串，如 "BNB 0.0234" 或 "BNB 1.2345"
 */
export function formatEthAmount(amount: number): string {
  if (amount === 0 || isNaN(amount)) return "BNB 0";
  if (amount >= 1) return `BNB ${amount.toFixed(4)}`;
  if (amount >= 0.0001) return `BNB ${amount.toFixed(6)}`;

  // 极小数使用下标格式
  const amountStr = amount.toFixed(18);
  const match = amountStr.match(/^0\.(0*)([1-9]\d*)/);
  if (match) {
    const zeroCount = match[1].length;
    const significantDigits = match[2].slice(0, 4);
    const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
    const subscriptNum = zeroCount.toString().split("").map((d) => subscripts[parseInt(d)]).join("");
    return `BNB 0.0${subscriptNum}${significantDigits}`;
  }
  return `BNB ${amount.toFixed(8)}`;
}
