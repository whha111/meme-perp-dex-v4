"use client";

import { useEffect, useState } from "react";

// Static error texts - no hooks to avoid crashes
const errorTexts: Record<string, Record<string, string>> = {
  zh: {
    title: '出错了',
    retry: '重试',
  },
  en: {
    title: 'Something went wrong',
    retry: 'Try again',
  },
  ja: {
    title: 'エラーが発生しました',
    retry: '再試行',
  },
  ko: {
    title: '오류가 발생했습니다',
    retry: '다시 시도',
  },
};

function getLocale(): string {
  if (typeof window === 'undefined') return 'zh';
  try {
    return localStorage.getItem('meme-perp-locale') || 'zh';
  } catch {
    return 'zh';
  }
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState('zh');

  useEffect(() => {
    setLocale(getLocale());
    // Log the error to an error reporting service
    console.error("Application error:", error);
  }, [error]);

  const t = errorTexts[locale] || errorTexts.zh;

  return (
    <div className="min-h-screen bg-okx-bg-primary text-okx-text-primary flex items-center justify-center">
      <div className="max-w-md mx-auto px-4 text-center">
        <h2 className="text-2xl font-bold mb-4">{t.title}</h2>
        <p className="text-okx-text-secondary mb-6 break-all">
          {error.message || 'Unknown error'}
        </p>
        <button
          onClick={reset}
          className="bg-meme-lime text-black px-6 py-3 rounded-lg font-bold hover:opacity-90 transition-opacity"
        >
          {t.retry}
        </button>
      </div>
    </div>
  );
}

