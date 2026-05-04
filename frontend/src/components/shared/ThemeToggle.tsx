'use client';

import { useEffect, useState } from 'react';
import { useAppStore, type AppTheme } from '@/lib/stores/appStore';

export function ThemeToggle() {
  const theme = useAppStore((state) => state.preferences.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const [mounted, setMounted] = useState(false);

  // 避免 hydration 不匹配
  useEffect(() => {
    setMounted(true);
  }, []);

  // 应用主题到 document
  useEffect(() => {
    if (!mounted) return;

    const root = document.documentElement;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    // 确定实际主题
    const actualTheme: 'light' | 'dark' =
      theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

    // 应用主题类
    root.classList.remove('light', 'dark');
    root.classList.add(actualTheme);

    // 监听系统主题变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        const newTheme = mediaQuery.matches ? 'dark' : 'light';
        root.classList.remove('light', 'dark');
        root.classList.add(newTheme);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme, mounted]);

  const toggleTheme = () => {
    // 循环切换: dark -> light -> dark
    const nextTheme: AppTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
  };

  if (!mounted) {
    return (
      <button className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-okx-bg-hover text-okx-text-secondary">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      </button>
    );
  }

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <button
      onClick={toggleTheme}
      className="flex h-8 w-8 items-center justify-center rounded-[4px] bg-okx-bg-hover transition-colors hover:bg-okx-border-secondary"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? (
        // 太阳图标 - 切换到浅色模式
        <svg
          className="h-4 w-4 text-okx-text-secondary"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
          />
        </svg>
      ) : (
        // 月亮图标 - 切换到深色模式
        <svg
          className="h-4 w-4 text-okx-text-secondary"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
          />
        </svg>
      )}
    </button>
  );
}
