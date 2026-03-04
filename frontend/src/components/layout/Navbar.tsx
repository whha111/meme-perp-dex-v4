'use client';

import Link from 'next/link';
import { useConnectModal, useAccountModal, useChainModal } from '@rainbow-me/rainbowkit';
import { useTranslations } from 'next-intl';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { LanguageSelector } from '@/components/shared/LanguageSelector';
import { useAccount, useDisconnect, useBalance } from 'wagmi';
import { useState, useRef, useEffect } from 'react';

export function Navbar() {
  const t = useTranslations('nav');
  const tWallet = useTranslations('wallet');
  const tCommon = useTranslations('common');

  const { address, isConnected, chain } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address });
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const { openChainModal } = useChainModal();

  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [mounted, setMounted] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowAccountMenu(false);
      }
    }

    if (showAccountMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showAccountMenu]);

  return (
    <nav className="sticky top-0 z-30 bg-okx-bg-primary border-b border-okx-border-primary h-[64px]">
      <div className="max-w-[1440px] mx-auto px-4 h-full flex items-center justify-between">
        {/* 左侧: Logo + 导航链接 */}
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2 text-okx-text-primary font-bold text-xl">
            <span className="text-2xl">💊</span>
            FOMO
          </Link>
          <div className="flex items-center gap-6 text-[14px] text-okx-text-secondary">
            <Link href="/" className="text-okx-text-primary cursor-pointer hidden lg:inline">
              {t('market')}
            </Link>
            <Link
              href="/exchange"
              prefetch={false}
              className="hover:text-okx-text-primary cursor-pointer hidden lg:inline"
            >
              {t('exchange')}
            </Link>
            <Link
              href="/perp"
              prefetch={false}
              className="hover:text-okx-text-primary cursor-pointer hidden lg:inline"
            >
              {t('perpetual')}
            </Link>
            <Link
              href="/create"
              className="hover:text-okx-text-primary cursor-pointer text-okx-up font-bold"
            >
              {t('createToken')}
            </Link>
            <Link
              href="/earnings"
              prefetch={false}
              className="hover:text-okx-text-primary cursor-pointer hidden lg:inline"
            >
              {t('earnings')}
            </Link>
            <Link
              href="/lend"
              prefetch={false}
              className="hover:text-okx-text-primary cursor-pointer hidden lg:inline"
            >
              {t('lending')}
            </Link>
          </div>
        </div>

        {/* 右侧: 搜索框 + 语言 + 主题 + 钱包 */}
        <div className="flex items-center gap-3">
          {/* 搜索框 */}
          <div className="relative hidden md:block">
            <input
              type="text"
              placeholder={t('searchPlaceholder')}
              className="bg-okx-bg-hover border border-okx-border-primary rounded-full px-4 py-1.5 text-[12px] text-okx-text-primary w-64 focus:outline-none focus:border-okx-border-secondary placeholder:text-okx-text-tertiary"
            />
          </div>

          {/* 语言选择器 */}
          <LanguageSelector />

          {/* 主题切换 */}
          <ThemeToggle />

          {/* 钱包按钮 */}
          {!mounted ? (
            <div className="bg-okx-up text-black px-4 py-1.5 rounded-full text-[13px] font-bold opacity-50">
              {tWallet('connect')}
            </div>
          ) : !isConnected || !address ? (
            <button
              onClick={openConnectModal}
              data-testid="connect-wallet-btn"
              className="bg-okx-up text-black px-4 py-1.5 rounded-full text-[13px] font-bold hover:opacity-90 transition-opacity"
            >
              {tWallet('connect')}
            </button>
          ) : (
            <>
              {/* Check if wrong network */}
              {chain && (
                <>
                  {(() => {
                    const targetChainId = parseInt(process.env.NEXT_PUBLIC_TARGET_CHAIN_ID || '97');
                    if (chain.id !== targetChainId) {
                      return (
                        <button
                          onClick={openChainModal}
                          className="bg-okx-down text-white px-4 py-1.5 rounded-full text-[13px] font-bold hover:opacity-90 transition-opacity"
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
                          className="flex items-center gap-2 bg-okx-bg-hover border border-okx-border-primary text-okx-text-primary px-3 py-1.5 rounded-full text-[12px] hover:border-okx-border-secondary transition-colors"
                        >
                          {chain.name && (
                            <>
                              <span className="font-bold hidden sm:inline">{chain.name}</span>
                              <span className="text-[10px] text-okx-text-tertiary">▼</span>
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
                                className="px-3 py-1.5 text-okx-text-primary text-[12px] font-bold border-r border-okx-border-primary"
                                data-testid="wallet-balance"
                              >
                                {formattedBalance}
                              </span>
                            )}
                            <div className="px-3 py-1.5 flex items-center gap-2">
                              <span className="text-okx-text-primary text-[12px] font-medium">
                                {formattedAddress}
                              </span>
                              <span className="text-[10px] text-okx-text-tertiary">▼</span>
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
    </nav>
  );
}
