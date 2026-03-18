/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        // OKX 配色方案 - 使用 CSS 变量实现主题切换
        okx: {
          bg: {
            primary: 'var(--okx-bg-primary)',
            secondary: 'var(--okx-bg-secondary)',
            card: 'var(--okx-bg-card)',
            hover: 'var(--okx-bg-hover)',
            active: 'var(--okx-bg-active)',
          },
          text: {
            primary: 'var(--okx-text-primary)',
            secondary: 'var(--okx-text-secondary)',
            tertiary: 'var(--okx-text-tertiary)',
          },
          border: {
            primary: 'var(--okx-border-primary)',
            secondary: 'var(--okx-border-secondary)',
            hover: 'var(--okx-border-hover)',
          },
          // 涨跌颜色
          up: 'var(--okx-up)',
          down: 'var(--okx-down)',
          // 功能色
          accent: 'var(--okx-accent)',
          warning: 'var(--okx-warning)',
        },
        // MEMEPERP 品牌直接颜色
        meme: {
          lime: '#BFFF00',
          dark: '#111111',
          darker: '#0a0a0a',
          black: '#000000',
        },
        // 合约交易 Binance 配色
        perp: {
          bg: '#0B0E11',
          surface: '#1E2329',
          hover: '#2B3139',
          border: '#2B3139',
          yellow: '#F0B90B',
          green: '#0ECB81',
          red: '#F6465D',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        card: '12px',
        button: '8px',
        input: '8px',
      },
      spacing: {
        card: '16px',
        section: '24px',
      },
      animation: {
        'price-flash-up': 'priceFlashUp 0.3s ease-in-out',
        'price-flash-down': 'priceFlashDown 0.3s ease-in-out',
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
        'slide-in-right': 'slideInFromRight 0.3s ease-out',
      },
      keyframes: {
        priceFlashUp: {
          '0%': { backgroundColor: 'transparent' },
          '50%': { backgroundColor: 'rgba(14, 203, 129, 0.2)' },
          '100%': { backgroundColor: 'transparent' },
        },
        priceFlashDown: {
          '0%': { backgroundColor: 'transparent' },
          '50%': { backgroundColor: 'rgba(246, 70, 93, 0.2)' },
          '100%': { backgroundColor: 'transparent' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideInFromRight: {
          '0%': { transform: 'translateX(20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
