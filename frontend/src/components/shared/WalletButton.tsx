"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Simple wallet connection button using wagmi directly.
 * Used when WalletConnect Project ID is not configured.
 */
export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const [showMenu, setShowMenu] = useState(false);
  const t = useTranslations();

  if (isConnected && address) {
    return (
      <div className="relative">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="bg-meme-lime text-black px-4 py-1.5 rounded-full text-sm font-bold hover:opacity-90 transition-opacity"
        >
          {address.slice(0, 6)}...{address.slice(-4)}
        </button>
        {showMenu && (
          <div className="absolute right-0 mt-2 bg-okx-bg-card rounded-lg border border-okx-border-primary shadow-lg z-50">
            <button
              onClick={() => {
                disconnect();
                setShowMenu(false);
              }}
              className="px-4 py-2 text-okx-text-primary text-sm hover:bg-okx-bg-hover w-full text-left"
            >
              {t('common.disconnect')}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Find injected connector (MetaMask, etc.)
  const injectedConnector = connectors.find(c => c.type === 'injected');

  return (
    <button
      onClick={() => {
        if (injectedConnector) {
          connect({ connector: injectedConnector });
        }
      }}
      disabled={isPending || !injectedConnector}
      className="bg-meme-lime text-black px-4 py-1.5 rounded-full text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-50"
    >
      {isPending ? t('common.connecting') : t('wallet.connect')}
    </button>
  );
}

/**
 * Wrapper that renders children with wallet connection context.
 * For use with ConnectButton.Custom pattern compatibility.
 */
interface WalletButtonCustomProps {
  children: (props: {
    account?: { address: string; displayName: string };
    chain?: { id: number; name: string };
    openConnectModal: () => void;
    openAccountModal: () => void;
    mounted: boolean;
  }) => React.ReactNode;
}

export function WalletButtonCustom({ children }: WalletButtonCustomProps) {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const injectedConnector = connectors.find(c => c.type === 'injected');

  const account = isConnected && address ? {
    address,
    displayName: `${address.slice(0, 6)}...${address.slice(-4)}`,
  } : undefined;

  const chainInfo = chain ? {
    id: chain.id,
    name: chain.name,
  } : undefined;

  return (
    <>
      {children({
        account,
        chain: chainInfo,
        openConnectModal: () => {
          if (injectedConnector) {
            connect({ connector: injectedConnector });
          }
        },
        openAccountModal: () => {
          disconnect();
        },
        mounted: true,
      })}
    </>
  );
}
