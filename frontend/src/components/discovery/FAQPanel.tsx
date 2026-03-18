'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface FAQPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

interface FAQItem {
  question: string;
  answer: string;
}

export function FAQPanel({ isOpen, onClose }: FAQPanelProps) {
  const t = useTranslations('faqPage');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);

  if (!isOpen) return null;

  const faqItems: FAQItem[] = [
    { question: t('q1'), answer: t('a1') },
    { question: t('q2'), answer: t('a2') },
    { question: t('q3'), answer: t('a3') },
    { question: t('q4'), answer: t('a4') },
    { question: t('q5'), answer: t('a5') },
    { question: t('q6'), answer: t('a6') },
    { question: t('q7'), answer: t('a7') },
    { question: t('q8'), answer: t('a8') },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-[420px] bg-okx-bg-primary border-l border-okx-border-primary z-50 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-okx-bg-primary border-b border-okx-border-primary p-4 flex items-center justify-between">
          <h2 className="text-okx-text-primary font-bold text-[16px]">{t('title')}</h2>
          <button
            onClick={onClose}
            className="text-okx-text-tertiary hover:text-okx-text-primary text-xl"
          >
            ✕
          </button>
        </div>

        {/* FAQ Content */}
        <div className="p-4 space-y-3">
          {faqItems.map((item, index) => (
            <div
              key={index}
              className="bg-okx-bg-hover border border-okx-border-primary rounded-lg overflow-hidden"
            >
              <button
                onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
                className="w-full p-4 flex items-center justify-between text-left"
              >
                <span className="text-okx-text-primary text-sm font-medium pr-4">
                  {item.question}
                </span>
                <span className="text-okx-text-tertiary text-lg flex-shrink-0">
                  {expandedIndex === index ? '−' : '+'}
                </span>
              </button>
              {expandedIndex === index && (
                <div className="px-4 pb-4 text-okx-text-secondary text-sm leading-relaxed whitespace-pre-line">
                  {item.answer}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-okx-bg-primary border-t border-okx-border-primary p-4">
          <p className="text-okx-text-tertiary text-xs text-center">
            {t('contact')}
          </p>
        </div>
      </div>
    </>
  );
}
