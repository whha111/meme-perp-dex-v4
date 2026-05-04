'use client';

import { useEffect, useState, useRef } from 'react';
import { locales, localeNames, localeFlags, type Locale, changeLocale, useLocale } from '@/i18n';

export function LanguageSelector() {
  const currentLocale = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 避免 hydration 不匹配
  useEffect(() => {
    setMounted(true);
  }, []);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (locale: Locale) => {
    changeLocale(locale);
    setIsOpen(false);
  };

  if (!mounted) {
    return (
      <button className="flex h-8 items-center gap-1.5 rounded-[4px] bg-okx-bg-hover px-2 text-sm font-semibold text-okx-text-secondary">
        CN
        <svg className="h-3 w-3 text-okx-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-8 items-center gap-1.5 rounded-[4px] bg-okx-bg-hover px-2 transition-colors hover:bg-okx-border-secondary"
        aria-label="Select language"
      >
        <span className="text-base">{localeFlags[currentLocale]}</span>
        <span className="text-sm text-okx-text-secondary hidden sm:inline">
          {currentLocale.toUpperCase()}
        </span>
        <svg
          className={`w-3 h-3 text-okx-text-tertiary transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 z-50 mt-2 w-36 overflow-hidden rounded-[4px] border border-okx-border-primary bg-okx-bg-card py-1 shadow-lg">
          {locales.map((locale) => (
            <button
              key={locale}
              onClick={() => handleSelect(locale)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-okx-bg-hover transition-colors ${
                locale === currentLocale ? 'text-okx-accent' : 'text-okx-text-primary'
              }`}
            >
              <span className="text-base">{localeFlags[locale]}</span>
              <span>{localeNames[locale]}</span>
              {locale === currentLocale && (
                <svg className="w-4 h-4 ml-auto" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
