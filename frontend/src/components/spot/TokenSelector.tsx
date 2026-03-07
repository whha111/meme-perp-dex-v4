"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { WssOnChainToken } from "@/lib/stores/tradingDataStore";
import { formatTokenPrice } from "@/utils/formatters";

type FilterTab = "all" | "active" | "graduated";

interface TokenSelectorProps {
  tokens: WssOnChainToken[];
  isLoading: boolean;
  selectedAddress: string | null;
  onSelect: (tokenAddress: string) => void;
  className?: string;
}

/**
 * Token 选择器 — OKX 风格下拉选择器
 * 用于 Exchange 页面选择交易代币
 */
export function TokenSelector({
  tokens,
  isLoading,
  selectedAddress,
  onSelect,
  className = "",
}: TokenSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const t = useTranslations("tokenSelector");

  // 当前选中的代币
  const selectedToken = useMemo(() => {
    return tokens.find(
      (t) => t.address.toLowerCase() === selectedAddress?.toLowerCase()
    );
  }, [tokens, selectedAddress]);

  // 过滤 + 搜索 + 排序
  const filteredTokens = useMemo(() => {
    let list = [...tokens];

    // 按状态筛选
    switch (activeFilter) {
      case "active":
        list = list.filter((t) => t.isActive && !t.isGraduated);
        break;
      case "graduated":
        list = list.filter((t) => t.isGraduated);
        break;
      case "all":
      default:
        break;
    }

    // 搜索过滤
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(term) ||
          t.symbol.toLowerCase().includes(term) ||
          t.address.toLowerCase().includes(term)
      );
    }

    // 按 realETHReserve 降序 (流动性最高优先)
    list.sort((a, b) => {
      const aETH = parseFloat(a.realETHReserve) || 0;
      const bETH = parseFloat(b.realETHReserve) || 0;
      return bETH - aETH;
    });

    return list;
  }, [tokens, searchTerm, activeFilter]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // 格式化价格 — 使用统一的 formatTokenPrice (支持下标格式)
  const formatPrice = (price: string) => {
    const num = parseFloat(price);
    if (num === 0) return "0";
    return formatTokenPrice(num);
  };

  // 处理选择
  const handleSelect = (address: string) => {
    onSelect(address);
    setIsOpen(false);
    setSearchTerm("");
  };

  const filterTabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: t("all") },
    { key: "active", label: t("active") },
    { key: "graduated", label: t("graduated") },
  ];

  return (
    <div ref={dropdownRef} className={`relative ${className}`}>
      {/* 触发按钮 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-okx-bg-hover transition-colors"
      >
        {/* 代币头像 */}
        <div className="w-7 h-7 rounded-full overflow-hidden bg-okx-bg-hover flex items-center justify-center flex-shrink-0">
          <span className="text-xs font-bold text-okx-up">
            {selectedToken?.symbol?.charAt(0) || "?"}
          </span>
        </div>

        {/* 代币名称 */}
        <div className="flex items-center gap-1.5">
          <span className="text-okx-text-primary font-bold text-[15px]">
            {selectedToken?.symbol || t("selectToken")}
          </span>
          {selectedToken?.isGraduated && (
            <span className="px-1.5 py-0.5 text-[10px] bg-[#FFB800]/20 text-[#FFB800] rounded font-medium">
              DEX
            </span>
          )}
          <span className="text-okx-text-tertiary text-[12px]">/BNB</span>
        </div>

        <ChevronDown
          className={`w-4 h-4 text-okx-text-tertiary transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* 下拉面板 */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-[400px] bg-okx-bg-card border border-okx-border-primary rounded-xl shadow-xl z-50 overflow-hidden">
          {/* 搜索框 */}
          <div className="p-3 border-b border-okx-border-primary">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-okx-text-tertiary" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder={t("searchPlaceholder")}
                className="w-full bg-okx-bg-hover border border-okx-border-primary rounded-lg pl-10 pr-10 py-2 text-sm text-okx-text-primary placeholder:text-okx-text-tertiary focus:outline-none focus:border-okx-up"
                autoFocus
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-okx-text-tertiary hover:text-okx-text-primary"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* 筛选标签 */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-okx-border-primary">
            {filterTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveFilter(tab.key)}
                className={`px-3 py-1 text-[12px] rounded-md whitespace-nowrap transition-colors ${
                  activeFilter === tab.key
                    ? "bg-okx-bg-hover text-okx-text-primary font-medium"
                    : "text-okx-text-tertiary hover:text-okx-text-secondary"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* 表头 */}
          <div className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] text-okx-text-tertiary border-b border-okx-border-primary">
            <div className="col-span-6">{t("selectToken")}</div>
            <div className="col-span-3 text-right">{t("price")}</div>
            <div className="col-span-3 text-right">{t("bnbReserve")}</div>
          </div>

          {/* 代币列表 */}
          <div className="max-h-[400px] overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-okx-up border-t-transparent rounded-full animate-spin" />
              </div>
            ) : filteredTokens.length > 0 ? (
              filteredTokens.map((token) => (
                <TokenRow
                  key={token.address}
                  token={token}
                  isSelected={
                    token.address.toLowerCase() ===
                    selectedAddress?.toLowerCase()
                  }
                  onSelect={() => handleSelect(token.address)}
                  formatPrice={formatPrice}
                />
              ))
            ) : (
              <div className="text-center py-8 text-okx-text-tertiary">
                <p>{t("noTokensFound")}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 单行代币数据
 */
function TokenRow({
  token,
  isSelected,
  onSelect,
  formatPrice,
}: {
  token: WssOnChainToken;
  isSelected: boolean;
  onSelect: () => void;
  formatPrice: (p: string) => string;
}) {
  return (
    <div
      className={`grid grid-cols-12 gap-2 px-3 py-2.5 items-center cursor-pointer transition-colors ${
        isSelected ? "bg-okx-bg-hover" : "hover:bg-okx-bg-hover"
      }`}
      onClick={onSelect}
    >
      {/* 名称 + 状态 */}
      <div className="col-span-6 flex items-center gap-2 min-w-0">
        <div className="w-7 h-7 rounded-full bg-okx-up/20 flex items-center justify-center text-okx-up text-xs font-bold flex-shrink-0">
          {token.symbol.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-[13px] font-medium text-okx-text-primary truncate">
              {token.symbol}
            </p>
            {token.isGraduated ? (
              <span className="px-1.5 py-0.5 text-[9px] bg-[#FFB800]/20 text-[#FFB800] rounded font-medium flex-shrink-0">
                DEX
              </span>
            ) : token.isActive ? (
              <span className="px-1.5 py-0.5 text-[9px] bg-okx-up/20 text-okx-up rounded font-medium flex-shrink-0">
                Live
              </span>
            ) : null}
          </div>
          <p className="text-[10px] text-okx-text-tertiary truncate">
            {token.name}
          </p>
        </div>
      </div>

      {/* 价格 (ETH) */}
      <div className="col-span-3 text-right">
        <p className="text-[12px] text-okx-text-primary font-mono">
          {formatPrice(token.price)}
        </p>
      </div>

      {/* ETH Reserve */}
      <div className="col-span-3 text-right">
        <p className="text-[12px] text-okx-text-secondary font-mono">
          {parseFloat(token.realETHReserve).toFixed(2)}
        </p>
      </div>
    </div>
  );
}

export default TokenSelector;
