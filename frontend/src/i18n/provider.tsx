'use client';

import { NextIntlClientProvider } from 'next-intl';
import { ReactNode, useEffect, useState, useRef } from 'react';
import { defaultLocale, type Locale } from './config';
// Static import of default locale messages to prevent flash of raw keys
import defaultMessages from '../../messages/zh.json';

// 动态导入消息
const loadMessages = async (locale: Locale) => {
  try {
    return (await import(`../../messages/${locale}.json`)).default;
  } catch {
    return (await import(`../../messages/${defaultLocale}.json`)).default;
  }
};

// 从 localStorage 获取语言偏好
const getStoredLocale = (): Locale => {
  if (typeof window === 'undefined') return defaultLocale;

  try {
    const stored = localStorage.getItem('dexi-locale');
    if (stored && ['zh', 'en', 'ja', 'ko'].includes(stored)) {
      return stored as Locale;
    }
  } catch {
    // localStorage 不可用
  }

  return defaultLocale;
};

// 保存语言偏好到 localStorage
export const setStoredLocale = (locale: Locale) => {
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem('dexi-locale', locale);
    // 触发自定义事件通知语言变化
    window.dispatchEvent(new CustomEvent('locale-change', { detail: locale }));
  } catch {
    // localStorage 不可用
  }
};

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [messages, setMessages] = useState<Record<string, any>>(defaultMessages);
  // Keep reference to previous messages to prevent flash during locale switch
  const previousMessagesRef = useRef<Record<string, any>>(defaultMessages);

  // 初始化：从 localStorage 加载语言偏好
  useEffect(() => {
    const storedLocale = getStoredLocale();
    setLocale(storedLocale);
  }, []);

  // 加载对应语言的消息
  useEffect(() => {
    let isMounted = true;

    loadMessages(locale).then((loadedMessages) => {
      if (isMounted) {
        setMessages(loadedMessages);
        previousMessagesRef.current = loadedMessages;
      }
    });

    return () => {
      isMounted = false;
    };
  }, [locale]);

  // 监听语言变化事件
  useEffect(() => {
    const handleLocaleChange = (event: CustomEvent<Locale>) => {
      setLocale(event.detail);
    };

    window.addEventListener('locale-change', handleLocaleChange as EventListener);
    return () => {
      window.removeEventListener('locale-change', handleLocaleChange as EventListener);
    };
  }, []);

  // During locale switch, use previous messages to prevent flash
  const currentMessages = messages || previousMessagesRef.current;

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={currentMessages}
      onError={(error) => {
        // Suppress missing translation errors during initial load
        if (process.env.NODE_ENV === 'development' && messages) {
          console.warn('[i18n]', error.message);
        }
      }}
      getMessageFallback={({ namespace, key }) => {
        // Return the key as fallback when translation is missing
        return key;
      }}
    >
      {children}
    </NextIntlClientProvider>
  );
}

// 导出获取当前语言的 hook
export function useLocale(): Locale {
  const [locale, setLocale] = useState<Locale>(defaultLocale);

  useEffect(() => {
    setLocale(getStoredLocale());

    const handleLocaleChange = (event: CustomEvent<Locale>) => {
      setLocale(event.detail);
    };

    window.addEventListener('locale-change', handleLocaleChange as EventListener);
    return () => {
      window.removeEventListener('locale-change', handleLocaleChange as EventListener);
    };
  }, []);

  return locale;
}

// 导出切换语言的函数
export function changeLocale(locale: Locale) {
  setStoredLocale(locale);
}
