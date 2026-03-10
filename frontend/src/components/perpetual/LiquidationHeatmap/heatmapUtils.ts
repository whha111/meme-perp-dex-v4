/**
 * 热力图工具函数
 */

// CoinGlass风格渐变色
// 从低到高: 紫色 → 蓝色 → 绿色 → 黄色
const HEATMAP_COLORS = [
  { stop: 0,   color: "#581c87" }, // 紫色
  { stop: 0.2, color: "#5b21b6" }, // 紫罗兰
  { stop: 0.4, color: "#2563eb" }, // 蓝色
  { stop: 0.6, color: "#10b981" }, // 绿色
  { stop: 0.8, color: "#facc15" }, // 黄色
  { stop: 1.0, color: "#fde047" }, // 亮黄
];

/**
 * 根据强度值获取渐变颜色
 * @param intensity 强度值 0-100
 * @returns RGB颜色字符串
 */
export function getHeatmapColor(intensity: number): string {
  const normalizedIntensity = Math.max(0, Math.min(100, intensity)) / 100;

  if (normalizedIntensity === 0) {
    return "rgba(88, 28, 135, 0.1)"; // 几乎透明的紫色
  }

  // 找到对应的颜色区间
  let startColor = HEATMAP_COLORS[0];
  let endColor = HEATMAP_COLORS[1];

  for (let i = 0; i < HEATMAP_COLORS.length - 1; i++) {
    if (normalizedIntensity >= HEATMAP_COLORS[i].stop &&
        normalizedIntensity <= HEATMAP_COLORS[i + 1].stop) {
      startColor = HEATMAP_COLORS[i];
      endColor = HEATMAP_COLORS[i + 1];
      break;
    }
  }

  // 在区间内插值
  const range = endColor.stop - startColor.stop;
  const t = range > 0 ? (normalizedIntensity - startColor.stop) / range : 0;

  return interpolateColor(startColor.color, endColor.color, t);
}

/**
 * 线性插值两个颜色
 */
function interpolateColor(color1: string, color2: string, t: number): string {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  if (!rgb1 || !rgb2) return color1;

  const r = Math.round(rgb1.r + (rgb2.r - rgb1.r) * t);
  const g = Math.round(rgb1.g + (rgb2.g - rgb1.g) * t);
  const b = Math.round(rgb1.b + (rgb2.b - rgb1.b) * t);

  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * HEX转RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : null;
}

/**
 * 格式化价格 (ETH 本位: 1e18精度, Token/ETH 比率) - 使用下标格式，避免科学计数法
 */
export function formatPrice(price: string | number): string {
  const p = typeof price === "string" ? Number(price) / 1e18 : price;
  if (p <= 0) return "0";
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  if (p >= 0.0001) return p.toFixed(8);
  if (p >= 0.000001) return p.toFixed(10);
  // 极小数使用下标格式
  const priceStr = p.toFixed(18);
  const match = priceStr.match(/^0\.(0*)([1-9]\d*)/);
  if (match) {
    const zeroCount = match[1].length;
    const significantDigits = match[2].slice(0, 4);
    const subscripts = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
    const subscriptNum = zeroCount.toString().split("").map((d) => subscripts[parseInt(d)]).join("");
    return `0.0${subscriptNum}${significantDigits}`;
  }
  return p.toFixed(12);
}

/**
 * 格式化ETH金额 (ETH 本位: 1e18精度)
 */
export function formatEthAmount(amount: string | number): string {
  const a = typeof amount === "string" ? Number(amount) / 1e18 : amount;
  if (a >= 1) return `BNB ${a.toFixed(4)}`;
  return `BNB ${a.toFixed(6)}`;
}

// Backwards compatibility alias
export const formatUsdAmount = formatEthAmount;

/**
 * 格式化时间
 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

/**
 * 格式化日期 (仅日期)
 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 创建Canvas渐变
 */
export function createHeatmapGradient(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
): CanvasGradient {
  const gradient = ctx.createLinearGradient(x, y, x + width, y);

  HEATMAP_COLORS.forEach(({ stop, color }) => {
    gradient.addColorStop(stop, color);
  });

  return gradient;
}

/**
 * 时间范围配置
 */
export const TIME_RANGE_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "12h", label: "12h" },
  { key: "1d", label: "1d" },
  { key: "3d", label: "3d" },
  { key: "7d", label: "7d" },
  { key: "1m", label: "1m" },
];
