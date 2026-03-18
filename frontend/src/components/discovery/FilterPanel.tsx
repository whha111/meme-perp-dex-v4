'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';

export interface FilterState {
  keyword: string;
  marketCapMin: string;
  marketCapMax: string;
  volume24hMin: string;
  volume24hMax: string;
  priceChangeMin: string;
  priceChangeMax: string;
  tradersMin: string;
  tradersMax: string;
  progressMin: string;
  progressMax: string;
}

export const defaultFilterState: FilterState = {
  keyword: '',
  marketCapMin: '',
  marketCapMax: '',
  volume24hMin: '',
  volume24hMax: '',
  priceChangeMin: '',
  priceChangeMax: '',
  tradersMin: '',
  tradersMax: '',
  progressMin: '',
  progressMax: '',
};

interface FilterPanelProps {
  isOpen: boolean;
  onClose: () => void;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  counts: {
    new: number;
    migrating: number;
    migrated: number;
  };
}

export function FilterPanel({ isOpen, onClose, filters, onFiltersChange, counts }: FilterPanelProps) {
  const t = useTranslations('filter');
  const tMarket = useTranslations('market');

  const [activeTab, setActiveTab] = useState<'new' | 'migrating' | 'migrated'>('new');
  const [localFilters, setLocalFilters] = useState<FilterState>(filters);

  const handleInputChange = useCallback((field: keyof FilterState, value: string) => {
    setLocalFilters(prev => ({ ...prev, [field]: value }));
  }, []);

  const handleApply = useCallback(() => {
    onFiltersChange(localFilters);
    onClose();
  }, [localFilters, onFiltersChange, onClose]);

  const handleReset = useCallback(() => {
    setLocalFilters(defaultFilterState);
    onFiltersChange(defaultFilterState);
  }, [onFiltersChange]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-[360px] bg-okx-bg-primary border-l border-okx-border-primary z-50 overflow-y-auto">
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

        {/* Tabs */}
        <div className="flex border-b border-okx-border-primary">
          <button
            onClick={() => setActiveTab('new')}
            className={`flex-1 py-3 text-sm font-medium ${
              activeTab === 'new'
                ? 'text-okx-text-primary border-b-2 border-okx-up'
                : 'text-okx-text-secondary'
            }`}
          >
            {tMarket('new')} <span className="text-okx-up ml-1">{counts.new}</span>
          </button>
          <button
            onClick={() => setActiveTab('migrating')}
            className={`flex-1 py-3 text-sm font-medium ${
              activeTab === 'migrating'
                ? 'text-okx-text-primary border-b-2 border-okx-up'
                : 'text-okx-text-secondary'
            }`}
          >
            {tMarket('migrating')} <span className="text-okx-up ml-1">{counts.migrating}</span>
          </button>
          <button
            onClick={() => setActiveTab('migrated')}
            className={`flex-1 py-3 text-sm font-medium ${
              activeTab === 'migrated'
                ? 'text-okx-text-primary border-b-2 border-okx-up'
                : 'text-okx-text-secondary'
            }`}
          >
            {tMarket('migrated')} <span className="text-okx-up ml-1">{counts.migrated}</span>
          </button>
        </div>

        {/* Filter Content */}
        <div className="p-4 space-y-5">
          {/* Keyword Search */}
          <div>
            <label className="block text-okx-text-secondary text-xs mb-2">{t('keyword')}</label>
            <input
              type="text"
              value={localFilters.keyword}
              onChange={(e) => handleInputChange('keyword', e.target.value)}
              placeholder={t('keywordPlaceholder')}
              className="w-full bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
            />
          </div>

          {/* Market Cap Range */}
          <div>
            <label className="block text-okx-text-secondary text-xs mb-2">{t('marketCap')}</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={localFilters.marketCapMin}
                onChange={(e) => handleInputChange('marketCapMin', e.target.value)}
                placeholder={t('min')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
              <span className="text-okx-text-tertiary">-</span>
              <input
                type="text"
                value={localFilters.marketCapMax}
                onChange={(e) => handleInputChange('marketCapMax', e.target.value)}
                placeholder={t('max')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
            </div>
          </div>

          {/* 24h Volume Range */}
          <div>
            <label className="block text-okx-text-secondary text-xs mb-2">{t('volume24h')}</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={localFilters.volume24hMin}
                onChange={(e) => handleInputChange('volume24hMin', e.target.value)}
                placeholder={t('min')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
              <span className="text-okx-text-tertiary">-</span>
              <input
                type="text"
                value={localFilters.volume24hMax}
                onChange={(e) => handleInputChange('volume24hMax', e.target.value)}
                placeholder={t('max')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
            </div>
          </div>

          {/* 24h Price Change Range */}
          <div>
            <label className="block text-okx-text-secondary text-xs mb-2">{t('priceChange24h')}</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={localFilters.priceChangeMin}
                onChange={(e) => handleInputChange('priceChangeMin', e.target.value)}
                placeholder={t('min')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
              <span className="text-okx-text-tertiary">%</span>
              <span className="text-okx-text-tertiary">-</span>
              <input
                type="text"
                value={localFilters.priceChangeMax}
                onChange={(e) => handleInputChange('priceChangeMax', e.target.value)}
                placeholder={t('max')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
              <span className="text-okx-text-tertiary">%</span>
            </div>
          </div>

          {/* Traders Count Range */}
          <div>
            <label className="block text-okx-text-secondary text-xs mb-2">{t('traders')}</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={localFilters.tradersMin}
                onChange={(e) => handleInputChange('tradersMin', e.target.value)}
                placeholder={t('min')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
              <span className="text-okx-text-tertiary">-</span>
              <input
                type="text"
                value={localFilters.tradersMax}
                onChange={(e) => handleInputChange('tradersMax', e.target.value)}
                placeholder={t('max')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
            </div>
          </div>

          {/* Progress Range */}
          <div>
            <label className="block text-okx-text-secondary text-xs mb-2">{t('progress')}</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={localFilters.progressMin}
                onChange={(e) => handleInputChange('progressMin', e.target.value)}
                placeholder={t('min')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
              <span className="text-okx-text-tertiary">%</span>
              <span className="text-okx-text-tertiary">-</span>
              <input
                type="text"
                value={localFilters.progressMax}
                onChange={(e) => handleInputChange('progressMax', e.target.value)}
                placeholder={t('max')}
                className="flex-1 bg-okx-bg-hover border border-okx-border-primary rounded-lg px-3 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-border-secondary"
              />
              <span className="text-okx-text-tertiary">%</span>
            </div>
          </div>

          {/* Note */}
          <div className="text-okx-text-tertiary text-xs flex items-start gap-1">
            <span>ⓘ</span>
            <span>{t('note')}</span>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="sticky bottom-0 bg-okx-bg-primary border-t border-okx-border-primary p-4 flex gap-3">
          <button
            onClick={handleReset}
            className="flex-1 bg-okx-bg-hover border border-okx-border-primary text-okx-text-primary py-2.5 rounded-lg text-sm font-medium hover:bg-okx-bg-card transition-colors"
          >
            {t('reset')}
          </button>
          <button
            onClick={handleApply}
            className="flex-1 bg-okx-up text-black py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-opacity"
          >
            {t('apply')}
          </button>
        </div>
      </div>
    </>
  );
}
