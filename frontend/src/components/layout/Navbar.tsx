'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useConnectModal, useAccountModal, useChainModal } from '@rainbow-me/rainbowkit';
import { useTranslations } from 'next-intl';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { LanguageSelector } from '@/components/shared/LanguageSelector';
import { useAccount, useDisconnect, useBalance } from 'wagmi';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTradingDataStore } from '@/lib/stores/tradingDataStore';

const NAV_ITEMS = [
  { href: '/exchange', key: 'spot' },
  { href: '/perp', key: 'perpetual' },
  { href: '/create', key: 'launch' },
  { href: '/account', key: 'assets' },
  { href: '/earnings', key: 'invite' },
  { href: '/leaderboard', key: 'leaderboard' },
] as const;

export function Navbar() {
  const t = useTranslations('nav');
  const tWallet = useTranslations('wallet');
  const tCommon = useTranslations('common');
  const pathname = usePathname();

  const { address, isConnected, chain } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address });
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const { openChainModal } = useChainModal();

  const router = useRouter();
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const allTokens = useTradingDataStore((state) => state.allTokens);

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return allTokens
      .filter((t) => t.symbol?.toLowerCase().includes(q) || t.name?.toLowerCase().includes(q) || t.address.toLowerCase().includes(q))
      .slice(0, 8);
  }, [searchQuery, allTokens]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close menus when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowAccountMenu(false);
      }
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setSearchFocused(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <nav className="sticky top-0 z-30 bg-okx-bg-primary border-b border-okx-border-primary h-[64px]">
      <div className="max-w-[1440px] mx-auto px-4 h-full flex items-center justify-between">
        {/* 左侧: Logo + 汉堡菜单 + 导航链接 */}
        <div className="flex items-center gap-4 lg:gap-8">
          {/* 汉堡菜单按钮 (mobile/tablet only) */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="lg:hidden p-1.5 rounded-md hover:bg-okx-bg-hover transition-colors text-okx-text-secondary"
            aria-label="Toggle menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              )}
            </svg>
          </button>

          <Link href="/" className="flex items-center gap-2 text-okx-text-primary font-bold text-xl">
            <span className="text-meme-lime text-lg">✦</span>
            <span className="tracking-tight">MEMEPERP</span>
          </Link>
          <div className="flex items-center gap-6 text-sm font-mono">
            {NAV_ITEMS.map(({ href, key }) => {
              const isActive = pathname === href || pathname.startsWith(href + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  className={`hidden lg:inline transition-colors ${
                    isActive
                      ? 'text-meme-lime font-medium'
                      : 'text-okx-text-secondary hover:text-okx-text-primary'
                  }`}
                >
                  {t(key)}
                </Link>
              );
            })}
          </div>
        </div>

        {/* 右侧: 搜索框 + 语言 + 主题 + 钱包 */}
        <div className="flex items-center gap-3">
          {/* 搜索框 */}
          <div className="relative hidden md:block" ref={searchRef}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchResults.length > 0) {
                  router.push(`/exchange?symbol=${searchResults[0].address}`);
                  setSearchQuery('');
                  setSearchFocused(false);
                }
                if (e.key === 'Escape') setSearchFocused(false);
              }}
              placeholder={t('searchPlaceholder')}
              className="bg-okx-bg-hover border border-okx-border-primary rounded-full px-4 py-1.5 text-xs text-okx-text-primary w-64 focus:outline-none focus:border-okx-border-secondary placeholder:text-okx-text-tertiary"
            />
            {searchFocused && searchQuery.trim() && (
              <div className="absolute top-full mt-1 left-0 w-80 bg-okx-bg-card border border-okx-border-primary rounded-lg shadow-xl z-50 max-h-[320px] overflow-y-auto">
                {searchResults.length > 0 ? (
                  searchResults.map((token) => (
                    <button
                      key={token.address}
                      onClick={() => {
                        router.push(`/exchange?symbol=${token.address}`);
                        setSearchQuery('');
                        setSearchFocused(false);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-okx-bg-hover text-left transition-colors"
                    >
                      <div className="w-7 h-7 rounded-full bg-meme-lime/20 flex items-center justify-center text-meme-lime text-xs font-bold flex-shrink-0">
                        {token.symbol?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <div className="flex flex-col gap-px flex-1 min-w-0">
                        <span className="text-sm font-semibold text-okx-text-primary">{token.symbol}</span>
                        <span className="text-xs text-okx-text-tertiary truncate">{token.name}</span>
                      </div>
                      <span className="font-mono text-xs text-okx-text-secondary">
                        {Number(token.price || '0') > 0
                          ? `${(Number(token.price) / 1e18).toFixed(8)}`
                          : '--'}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-6 text-center text-okx-text-tertiary text-xs">
                    {t('noResults')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 语言选择器 */}
          <LanguageSelector />

          {/* 主题切换 */}
          <ThemeToggle />

          {/* 设置 */}
          <Link
            href="/settings"
            className="p-2 rounded-full hover:bg-okx-bg-hover transition-colors text-okx-text-secondary hover:text-okx-text-primary"
            title={tCommon('settings')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </Link>

          {/* 钱包按钮 */}
          {!mounted ? (
            <div className="bg-meme-lime text-black px-4 py-1.5 rounded-full text-sm font-bold opacity-50">
              {tWallet('connect')}
            </div>
          ) : !isConnected || !address ? (
            <button
              onClick={openConnectModal}
              data-testid="connect-wallet-btn"
              className="bg-meme-lime text-black px-4 py-1.5 rounded-full text-sm font-bold hover:opacity-90 transition-opacity"
            >
              {tWallet('connect')}
            </button>
          ) : (
            <>
              {/* Check if wrong network */}
              {chain && (
                <>
                  {(() => {
                    const targetChainId = parseInt(process.env.NEXT_PUBLIC_TARGET_CHAIN_ID || '56');
                    if (chain.id !== targetChainId) {
                      return (
                        <button
                          onClick={openChainModal}
                          className="bg-okx-down text-white px-4 py-1.5 rounded-full text-sm font-bold hover:opacity-90 transition-opacity"
                        >
                          {tWallet('switchNetwork')}
                        </button>
                      );
                    }

                    // Format address: 0x1234...5678
                    const formattedAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;
                    const formattedBalance = balance
                      ? `${parseFloat(balance.formatted).toFixed(4)} ${balance.symbol}`
                      : '';

                    return (
                      <div className="flex items-center gap-2" data-testid="wallet-connected">
                        <button
                          onClick={openChainModal}
                          data-testid="network-badge"
                          className="flex items-center gap-2 bg-okx-bg-hover border border-okx-border-primary text-okx-text-primary px-3 py-1.5 rounded-full text-xs hover:border-okx-border-secondary transition-colors"
                        >
                          {chain.name && (
                            <>
                              <span className="font-bold hidden sm:inline">{chain.name}</span>
                              <span className="text-xs text-okx-text-tertiary">▼</span>
                            </>
                          )}
                        </button>

                        <div className="relative" ref={menuRef}>
                          <button
                            onClick={() => setShowAccountMenu(!showAccountMenu)}
                            data-testid="wallet-address"
                            className="flex items-center bg-okx-bg-hover border border-okx-border-primary rounded-full overflow-hidden hover:border-okx-border-secondary transition-colors"
                          >
                            {formattedBalance && (
                              <span
                                className="px-3 py-1.5 text-okx-text-primary text-xs font-bold border-r border-okx-border-primary"
                                data-testid="wallet-balance"
                              >
                                {formattedBalance}
                              </span>
                            )}
                            <div className="px-3 py-1.5 flex items-center gap-2">
                              <span className="text-okx-text-primary text-xs font-medium">
                                {formattedAddress}
                              </span>
                              <span className="text-xs text-okx-text-tertiary">▼</span>
                            </div>
                          </button>

                          {/* Account dropdown menu */}
                          {showAccountMenu && (
                            <div className="absolute right-0 mt-2 bg-okx-bg-card rounded-lg border border-okx-border-primary shadow-lg z-50 min-w-[180px]">
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(address);
                                  setShowAccountMenu(false);
                                }}
                                className="w-full px-4 py-2.5 text-okx-text-primary text-sm hover:bg-okx-bg-hover text-left flex items-center gap-2 border-b border-okx-border-primary"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                                {tCommon('copyAddress')}
                              </button>
                              <button
                                onClick={() => {
                                  openAccountModal?.();
                                  setShowAccountMenu(false);
                                }}
                                className="w-full px-4 py-2.5 text-okx-text-primary text-sm hover:bg-okx-bg-hover text-left flex items-center gap-2 border-b border-okx-border-primary"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                                </svg>
                                {tCommon('accountDetails')}
                              </button>
                              <button
                                onClick={() => {
                                  router.push('/settings');
                                  setShowAccountMenu(false);
                                }}
                                className="w-full px-4 py-2.5 text-okx-text-primary text-sm hover:bg-okx-bg-hover text-left flex items-center gap-2 border-b border-okx-border-primary"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                                {tCommon('settings')}
                              </button>
                              <button
                                onClick={() => {
                                  disconnect();
                                  setShowAccountMenu(false);
                                }}
                                className="w-full px-4 py-2.5 text-okx-down text-sm hover:bg-okx-bg-hover text-left flex items-center gap-2"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                                </svg>
                                {tCommon('disconnect')}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div className="lg:hidden absolute top-[64px] left-0 right-0 bg-okx-bg-primary border-b border-okx-border-primary shadow-lg z-40">
          <div className="flex flex-col py-2 px-4">
            {NAV_ITEMS.map(({ href, key }) => {
              const isActive = pathname === href || pathname.startsWith(href + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`py-3 px-3 rounded-lg text-sm font-mono transition-colors ${
                    isActive
                      ? 'text-meme-lime font-medium bg-meme-lime/5'
                      : 'text-okx-text-secondary hover:text-okx-text-primary hover:bg-okx-bg-hover'
                  }`}
                >
                  {t(key)}
                </Link>
              );
            })}
            {/* Settings link in mobile menu */}
            <Link
              href="/settings"
              onClick={() => setMobileMenuOpen(false)}
              className={`py-3 px-3 rounded-lg text-sm font-mono transition-colors ${
                pathname === '/settings'
                  ? 'text-meme-lime font-medium bg-meme-lime/5'
                  : 'text-okx-text-secondary hover:text-okx-text-primary hover:bg-okx-bg-hover'
              }`}
            >
              {tCommon('settings')}
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
