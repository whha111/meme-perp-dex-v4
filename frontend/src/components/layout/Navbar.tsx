'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useConnectModal, useAccountModal, useChainModal } from '@rainbow-me/rainbowkit';
import { useTranslations } from 'next-intl';
import { ThemeToggle } from '@/components/shared/ThemeToggle';
import { LanguageSelector } from '@/components/shared/LanguageSelector';
import { useAccount, useDisconnect, useBalance } from 'wagmi';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useTradingDataStore } from '@/lib/stores/tradingDataStore';
import {
  ChevronDown,
  Copy,
  LogOut,
  Menu,
  Search,
  Settings,
  UserCircle,
  Wallet,
  X,
} from 'lucide-react';

const DEFAULT_PERP_HREF = '/perp?marketId=PEPE-USDT-PERP';

const NAV_ITEMS = [
  { href: '/', key: 'market' },
  { href: '/exchange', key: 'spot' },
  { href: DEFAULT_PERP_HREF, key: 'perpetual' },
  { href: '/deposit', key: 'deposit' },
  { href: '/vault', key: 'vault' },
  { href: '/account', key: 'assets' },
] as const;

function formatAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function Navbar() {
  const t = useTranslations('nav');
  const tWallet = useTranslations('wallet');
  const tCommon = useTranslations('common');
  const pathname = usePathname();
  const router = useRouter();

  const { address, isConnected, chain } = useAccount();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address });
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const { openChainModal } = useChainModal();

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
      .filter((token) =>
        token.symbol?.toLowerCase().includes(q) ||
        token.name?.toLowerCase().includes(q) ||
        token.address.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [searchQuery, allTokens]);

  useEffect(() => {
    setMounted(true);
  }, []);

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

  const targetChainId = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || '56');
  const isWrongNetwork = !!chain && chain.id !== targetChainId;
  const formattedBalance = balance ? `${parseFloat(balance.formatted).toFixed(4)} ${balance.symbol}` : '';

  const goToToken = (tokenAddress: string) => {
    router.push(`/perp?symbol=${tokenAddress}`);
    setSearchQuery('');
    setSearchFocused(false);
    setMobileMenuOpen(false);
  };

  const isTradeShell = pathname.startsWith('/perp');

  if (isTradeShell) {
    return (
      <nav className="sticky top-0 z-30 h-[2.75rem] border-b border-[#2B3542] bg-[#11161E] text-[#A7B2BE]">
        <div className="flex h-full w-full items-center justify-between">
          <div className="flex h-full min-w-0 items-center">
            <Link href="/" className="flex h-full items-center gap-2 px-4 text-[#F3F7F9]">
              <span className="dexi-logo-mark h-6 w-6 rounded-[4px] text-[11px]">D</span>
              <span className="text-[14px] font-semibold">DEXI</span>
            </Link>
            <div className="flex h-full items-center gap-4 border-l border-[#2B3542] px-4 text-[13px]">
              <span className="rounded-[0.375rem] bg-[#18191E] px-2 py-1 text-[12px] font-medium text-[#A7B2BE]">BSC Mainnet</span>
            </div>
            <div className="hidden h-full items-center gap-1 lg:flex">
              {[
                { href: '/', label: '行情' },
                { href: '/exchange', label: '现货' },
                { href: DEFAULT_PERP_HREF, label: '合约' },
                { href: '/deposit', label: '充值' },
                { href: '/vault', label: '金库' },
                { href: '/account', label: '资产' },
              ].map((item) => {
                const itemPath = item.href.split('?')[0];
                const isActive = pathname === itemPath || pathname.startsWith(itemPath + '/');
                return (
                  <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  className={`relative flex h-full items-center px-3 text-[14px] transition-colors ${
                      isActive ? 'text-[#F3F7F9]' : 'text-[#A0ACB8] hover:text-[#F3F7F9]'
                    }`}
                  >
                    {item.label}
                    {isActive && <span className="absolute bottom-0 left-3 right-3 h-[2px] bg-[#5EEAD4]" />}
                  </Link>
                );
              })}
              <span className="ml-2 rounded-[0.375rem] border border-[#2B3542] bg-[#18191E] px-2 py-1 text-[12px] font-medium text-[#77838F]">
                Curated Meme Perps
              </span>
            </div>
          </div>

          <div className="flex h-full items-center gap-2 px-4">
            <div className="relative hidden md:block" ref={searchRef}>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#77838F]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && searchResults.length > 0) {
                    goToToken(searchResults[0].address);
                  }
                  if (event.key === 'Escape') setSearchFocused(false);
                }}
                placeholder="搜索市场 / 地址"
                className="h-8 w-56 rounded-[0.375rem] border border-[#2B3542] bg-[#18191E] pl-9 pr-3 text-[13px] text-[#F3F7F9] placeholder:text-[#77838F] transition-colors focus:border-[#465565] focus:outline-none xl:w-72"
              />
              {searchFocused && searchQuery.trim() && (
                <div className="absolute right-0 top-full z-50 mt-2 max-h-[320px] w-80 overflow-y-auto rounded-lg border border-[#2B3542] bg-[#11161E] shadow-2xl">
                  {searchResults.length > 0 ? (
                    searchResults.map((token) => (
                      <button
                        key={token.address}
                        onClick={() => goToToken(token.address)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[#1D2430]"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#5EEAD4]/20 text-xs font-bold text-[#8FF7E8]">
                          {token.symbol?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-[#F3F7F9]">{token.symbol}</div>
                          <div className="truncate text-xs text-[#77838F]">{token.name}</div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-xs text-[#77838F]">没有结果</div>
                  )}
                </div>
              )}
            </div>
            <Link
              href="/deposit"
              className="hidden h-8 items-center justify-center rounded-full bg-[#5EEAD4] px-4 text-[13px] font-semibold text-[#061215] transition-colors hover:bg-[#8FF7E8] sm:flex"
            >
              充值
            </Link>
            <LanguageSelector />
            <button className="hidden h-8 w-8 items-center justify-center rounded-[0.375rem] text-[#77838F] hover:bg-[#1D2430] hover:text-[#F3F7F9] md:flex">
              ?
            </button>
            <Link
              href="/settings"
              className="hidden h-8 w-8 items-center justify-center rounded-[0.375rem] text-[#77838F] transition-colors hover:bg-[#1D2430] hover:text-[#F3F7F9] sm:flex"
              title={tCommon('settings')}
            >
              <Settings className="h-[17px] w-[17px]" />
            </Link>
            {!mounted ? (
              <div className="h-8 w-24 rounded-[0.375rem] bg-[#1D2430]" />
            ) : !isConnected || !address ? (
              <button
                onClick={() => openConnectModal?.()}
                data-testid="connect-wallet-btn"
                className="inline-flex h-8 items-center gap-2 rounded-[0.375rem] bg-[#5EEAD4] px-3 text-[13px] font-semibold text-[#061215] transition-colors hover:bg-[#8FF7E8]"
              >
                <Wallet className="h-4 w-4" />
                <span className="hidden sm:inline">{tWallet('connect')}</span>
              </button>
            ) : isWrongNetwork ? (
              <button
                onClick={() => openChainModal?.()}
                className="h-8 rounded-[0.375rem] bg-okx-down px-3 text-[13px] font-semibold text-white"
              >
                {tWallet('switchNetwork')}
              </button>
            ) : (
              <button
                onClick={() => setShowAccountMenu((open) => !open)}
                data-testid="wallet-address"
                className="flex h-8 items-center gap-2 rounded-[0.375rem] bg-[#1D2430] px-3 text-[13px] font-medium text-[#F3F7F9]"
              >
                {formatAddress(address)}
                <ChevronDown className="h-3.5 w-3.5 text-[#77838F]" />
              </button>
            )}
          </div>
        </div>
      </nav>
    );
  }

  return (
    <nav className="sticky top-0 z-30 h-[2.75rem] border-b border-[#2B3542] bg-[#0A0C11]/95 backdrop-blur supports-[backdrop-filter]:bg-[#0A0C11]/90">
      <div className="flex h-full w-full items-center justify-between gap-3 px-3">
        <div className="flex min-w-0 items-center gap-3 lg:gap-5">
          <button
            onClick={() => setMobileMenuOpen((open) => !open)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-okx-text-secondary transition-colors hover:bg-okx-bg-hover hover:text-okx-text-primary lg:hidden"
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>

          <Link href="/" className="flex shrink-0 items-center gap-2 text-okx-text-primary">
            <span className="dexi-logo-mark rounded-[4px]">
              D
            </span>
            <span className="hidden text-sm font-semibold tracking-normal sm:inline">DEXI</span>
            <span className="text-sm font-semibold tracking-normal sm:hidden">DEXI</span>
          </Link>

          <div className="hidden items-center gap-1 lg:flex">
            {NAV_ITEMS.map(({ href, key }) => {
              const itemPath = href.split('?')[0];
              const isActive = pathname === itemPath || pathname.startsWith(itemPath + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  prefetch={false}
                  className={`rounded-[0.375rem] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    isActive
                      ? 'bg-[#151A22] text-[#F7FAFC]'
                      : 'text-[#A7B2BE] hover:bg-[#151A22] hover:text-[#F7FAFC]'
                  }`}
                >
                  {t(key)}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative hidden md:block" ref={searchRef}>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-okx-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onFocus={() => setSearchFocused(true)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && searchResults.length > 0) {
                  goToToken(searchResults[0].address);
                }
                if (event.key === 'Escape') setSearchFocused(false);
              }}
              placeholder={t('searchPlaceholder')}
              className="h-8 w-56 rounded-[0.5rem] border border-[#2B3542] bg-[#10141B] pl-9 pr-3 text-sm text-[#F7FAFC] placeholder:text-[#77838F] transition-colors focus:border-[#465565] focus:outline-none xl:w-72"
            />
            {searchFocused && searchQuery.trim() && (
              <div className="absolute right-0 top-full z-50 mt-2 max-h-[320px] w-80 overflow-y-auto rounded-lg border border-okx-border-primary bg-okx-bg-card shadow-2xl">
                {searchResults.length > 0 ? (
                  searchResults.map((token) => (
                    <button
                      key={token.address}
                      onClick={() => goToToken(token.address)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-okx-bg-hover"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-dexi-accent-soft text-xs font-bold text-meme-lime">
                        {token.symbol?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-okx-text-primary">{token.symbol}</div>
                        <div className="truncate text-xs text-okx-text-tertiary">{token.name}</div>
                      </div>
                      <span className="font-mono text-xs text-okx-text-secondary">
                        {Number(token.price || '0') > 0 ? (Number(token.price) / 1e18).toFixed(8) : '--'}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-6 text-center text-xs text-okx-text-tertiary">{t('noResults')}</div>
                )}
              </div>
            )}
          </div>

          <LanguageSelector />
          <ThemeToggle />

          <Link
            href="/settings"
            className="hidden h-8 w-8 items-center justify-center rounded-[0.5rem] text-[#A7B2BE] transition-colors hover:bg-[#151A22] hover:text-[#F7FAFC] sm:inline-flex"
            title={tCommon('settings')}
          >
            <Settings className="h-[18px] w-[18px]" />
          </Link>

          {!mounted ? (
            <div className="inline-flex h-8 items-center gap-2 rounded-[0.5rem] bg-dexi-accent px-3 text-sm font-bold text-[#061215]">
              <Wallet className="h-4 w-4" />
              <span className="hidden sm:inline">{tWallet('connect')}</span>
            </div>
          ) : !isConnected || !address ? (
            <button
              onClick={() => openConnectModal?.()}
              data-testid="connect-wallet-btn"
              className="inline-flex h-8 items-center gap-2 rounded-[0.5rem] bg-dexi-accent px-3 text-sm font-bold text-[#061215] transition-colors hover:bg-dexi-accent-strong"
            >
              <Wallet className="h-4 w-4" />
              <span className="hidden sm:inline">{tWallet('connect')}</span>
            </button>
          ) : isWrongNetwork ? (
            <button
              onClick={() => openChainModal?.()}
              className="h-8 rounded-[4px] bg-okx-down px-3 text-sm font-bold text-white transition-opacity hover:opacity-90"
            >
              {tWallet('switchNetwork')}
            </button>
          ) : (
            <div className="flex items-center gap-2" data-testid="wallet-connected">
              <button
                onClick={() => openChainModal?.()}
                data-testid="network-badge"
                className="hidden h-8 items-center gap-1.5 rounded-[4px] border border-okx-border-primary bg-okx-bg-secondary px-3 text-xs font-medium text-okx-text-secondary transition-colors hover:border-okx-border-hover hover:text-okx-text-primary sm:inline-flex"
              >
                {chain?.name || 'BSC Mainnet'}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>

              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setShowAccountMenu((open) => !open)}
                  data-testid="wallet-address"
                  className="flex h-8 items-center overflow-hidden rounded-[4px] border border-okx-border-primary bg-okx-bg-secondary text-xs transition-colors hover:border-okx-border-hover"
                >
                  {formattedBalance && (
                    <span className="hidden border-r border-okx-border-primary px-3 font-mono text-okx-text-primary md:inline" data-testid="wallet-balance">
                      {formattedBalance}
                    </span>
                  )}
                  <span className="flex items-center gap-2 px-3 font-medium text-okx-text-primary">
                    {formatAddress(address)}
                    <ChevronDown className="h-3.5 w-3.5 text-okx-text-tertiary" />
                  </span>
                </button>

                {showAccountMenu && (
                  <div className="absolute right-0 z-50 mt-2 min-w-[190px] overflow-hidden rounded-lg border border-okx-border-primary bg-okx-bg-card shadow-2xl">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(address);
                        setShowAccountMenu(false);
                      }}
                      className="flex w-full items-center gap-2 border-b border-okx-border-primary px-4 py-2.5 text-left text-sm text-okx-text-primary transition-colors hover:bg-okx-bg-hover"
                    >
                      <Copy className="h-4 w-4 text-okx-text-secondary" />
                      {tCommon('copyAddress')}
                    </button>
                    <button
                      onClick={() => {
                        openAccountModal?.();
                        setShowAccountMenu(false);
                      }}
                      className="flex w-full items-center gap-2 border-b border-okx-border-primary px-4 py-2.5 text-left text-sm text-okx-text-primary transition-colors hover:bg-okx-bg-hover"
                    >
                      <UserCircle className="h-4 w-4 text-okx-text-secondary" />
                      {tCommon('accountDetails')}
                    </button>
                    <button
                      onClick={() => {
                        router.push('/settings');
                        setShowAccountMenu(false);
                      }}
                      className="flex w-full items-center gap-2 border-b border-okx-border-primary px-4 py-2.5 text-left text-sm text-okx-text-primary transition-colors hover:bg-okx-bg-hover"
                    >
                      <Settings className="h-4 w-4 text-okx-text-secondary" />
                      {tCommon('settings')}
                    </button>
                    <button
                      onClick={() => {
                        disconnect();
                        setShowAccountMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-okx-down transition-colors hover:bg-okx-bg-hover"
                    >
                      <LogOut className="h-4 w-4" />
                      {tCommon('disconnect')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="absolute left-0 right-0 top-12 z-40 border-b border-okx-border-primary bg-okx-bg-secondary shadow-2xl lg:hidden">
          <div className="flex flex-col gap-1 p-3">
            {NAV_ITEMS.map(({ href, key }) => {
              const itemPath = href.split('?')[0];
              const isActive = pathname === itemPath || pathname.startsWith(itemPath + '/');
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileMenuOpen(false)}
                  prefetch={false}
                  className={`rounded-md px-3 py-3 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-okx-bg-hover text-okx-text-primary'
                      : 'text-okx-text-secondary hover:bg-okx-bg-hover hover:text-okx-text-primary'
                  }`}
                >
                  {t(key)}
                </Link>
              );
            })}
            <Link
              href="/settings"
              onClick={() => setMobileMenuOpen(false)}
              className={`rounded-md px-3 py-3 text-sm font-medium transition-colors ${
                pathname === '/settings'
                  ? 'bg-okx-bg-hover text-okx-text-primary'
                  : 'text-okx-text-secondary hover:bg-okx-bg-hover hover:text-okx-text-primary'
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

