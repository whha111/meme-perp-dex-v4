"use client";

import { useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { useTranslations } from "next-intl";
import { getWebSocketClient } from "@/lib/websocket/client";
import { MessageType } from "@/lib/websocket/types";
import { useWalletAuth } from "./useWalletAuth";

// 本地类型定义 (替代 @namespace/protocol)
export interface TokenMetadata {
  inst_id: string;
  logo_url?: string;
  description?: string;
  website_url?: string;
  twitter_url?: string;
  telegram_url?: string;
  discord_url?: string;
  created_at?: number;
  updated_at?: number;
  // Aliases for Namespace compatibility
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
}

export interface SaveMetadataReq {
  inst_id: string;
  creator_address: string;
  logo_url?: string;
  description?: string;
  website_url?: string;
  twitter_url?: string;
  telegram_url?: string;
  discord_url?: string;
}

export interface SaveMetadataResp {
  success: boolean;
  message?: string;
  metadata?: TokenMetadata;
}

export interface GetMetadataResp {
  success: boolean;
  message?: string;
  metadata?: TokenMetadata;
}

export interface UseTokenMetadataReturn {
  // 数据
  metadata: TokenMetadata | null;
  isLoading: boolean;
  error: string | null;

  // 操作
  saveMetadata: (data: Omit<SaveMetadataReq, "creator_address">) => Promise<boolean>;
  fetchMetadata: (instId: string) => Promise<TokenMetadata | null>;

  // 状态
  isSaving: boolean;
}

/**
 * Hook 用于管理代币元数据（Logo、描述、社交链接等）
 */
export function useTokenMetadata(): UseTokenMetadataReturn {
  const { address } = useAccount();
  const { authenticate, isAuthenticated } = useWalletAuth();
  const t = useTranslations("hooks");

  const [metadata, setMetadata] = useState<TokenMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 获取代币元数据
   */
  const fetchMetadata = useCallback(async (instId: string): Promise<TokenMetadata | null> => {
    if (!instId) {
      return null;
    }

    setIsLoading(true);
    setError(null);

    try {
      const wsClient = getWebSocketClient();

      if (!wsClient.isConnected()) {
        await wsClient.connect();
      }

      const response = await wsClient.request<GetMetadataResp>(
        MessageType.GET_METADATA_REQUEST,
        { inst_id: instId }
      );

      if (response.success && response.metadata) {
        setMetadata(response.metadata);
        return response.metadata;
      }

      // 没有找到元数据，不算错误
      setMetadata(null);
      return null;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t("fetchMetadataFailed");
      setError(errorMessage);
      console.error("[useTokenMetadata] fetchMetadata error:", err);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  /**
   * 保存代币元数据
   */
  const saveMetadata = useCallback(async (
    data: Omit<SaveMetadataReq, "creator_address">
  ): Promise<boolean> => {
    if (!address) {
      setError(t("connectWalletFirst"));
      return false;
    }

    if (!data.inst_id) {
      setError(t("tradingPairIdRequired"));
      return false;
    }

    setIsSaving(true);
    setError(null);

    try {
      // 确保钱包已认证
      if (!isAuthenticated) {
        const authOk = await authenticate();
        if (!authOk) {
          setError(t("walletAuthFailed"));
          return false;
        }
      }

      const wsClient = getWebSocketClient();

      if (!wsClient.isConnected()) {
        await wsClient.connect();
      }

      const request: SaveMetadataReq = {
        ...data,
        inst_id: data.inst_id,
        creator_address: address,
      };

      const response = await wsClient.request<SaveMetadataResp>(
        MessageType.SAVE_METADATA_REQUEST,
        request
      );

      if (response.success && response.metadata) {
        setMetadata(response.metadata);
        return true;
      }

      setError(response.message || t("saveMetadataFailed"));
      return false;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t("saveMetadataFailed");
      setError(errorMessage);
      console.error("[useTokenMetadata] saveMetadata error:", err);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [address, authenticate, isAuthenticated, t]);

  return {
    metadata,
    isLoading,
    error,
    saveMetadata,
    fetchMetadata,
    isSaving,
  };
}

export default useTokenMetadata;
