import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: 'class',
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        // OKX 配色方案 - 使用 CSS 变量实现主题切换
        okx: {
          bg: {
            primary: "var(--okx-bg-primary)",
            secondary: "var(--okx-bg-secondary)",
            card: "var(--okx-bg-card)",
            hover: "var(--okx-bg-hover)",
            active: "var(--okx-bg-active)",
          },
          text: {
            primary: "var(--okx-text-primary)",
            secondary: "var(--okx-text-secondary)",
            tertiary: "var(--okx-text-tertiary)",
          },
          border: {
            primary: "var(--okx-border-primary)",
            secondary: "var(--okx-border-secondary)",
            hover: "var(--okx-border-hover)",
          },
          // 涨跌颜色
          up: "var(--okx-up)",
          down: "var(--okx-down)",
          // 功能色
          accent: "var(--okx-accent)",
          warning: "var(--okx-warning)",
        },
        // MEMEPERP 品牌直接颜色
        meme: {
          lime: "#BFFF00",
          dark: "#111111",
          darker: "#0a0a0a",
          black: "#000000",
        },
        // 合约交易 Binance 配色
        perp: {
          bg: "#0B0E11",
          surface: "#1E2329",
          hover: "#2B3139",
          border: "#2B3139",
          yellow: "#F0B90B",
          green: "#0ECB81",
          red: "#F6465D",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "SF Mono", "Consolas", "monospace"],
      },
      borderRadius: {
        card: "12px",
        button: "8px",
        input: "8px",
      },
      spacing: {
        card: "16px",
        section: "24px",
      },
      animation: {
        "price-flash-up": "priceFlashUp 0.3s ease-in-out",
        "price-flash-down": "priceFlashDown 0.3s ease-in-out",
        "pulse-slow": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      keyframes: {
        priceFlashUp: {
          "0%": { backgroundColor: "transparent" },
          "50%": { backgroundColor: "rgba(0, 210, 106, 0.2)" },
          "100%": { backgroundColor: "transparent" },
        },
        priceFlashDown: {
          "0%": { backgroundColor: "transparent" },
          "50%": { backgroundColor: "rgba(255, 59, 48, 0.2)" },
          "100%": { backgroundColor: "transparent" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
