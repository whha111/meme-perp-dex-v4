"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { formatEther } from "viem";
import { Navbar } from "@/components/layout/Navbar";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/shared/Toast";
import { ImageUpload } from "@/components/shared/ImageUpload";
import { useCreateMemeToken } from "@/hooks/spot/useCreateMemeToken";
import { NETWORK_CONFIG } from "@/lib/contracts";
import { createTokenMetadata } from "@/lib/api/tokenMetadata";

/**
 * 创建 Meme 代币页面 — 匹配 Pencil 设计: 双栏布局
 * 左栏: 代币信息表单 + 社交链接 + 初始购买 + 费用摘要 + 创建按钮
 * 右栏: 代币参数 + 手续费分配 + 运作方式
 */
export default function CreateTokenPage() {
  const router = useRouter();
  const { address, isConnected, isReconnecting } = useAccount();
  const [mounted, setMounted] = useState(false);

  // 代币基本信息
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoIpfsHash, setLogoIpfsHash] = useState("");

  // 社交链接
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [discord, setDiscord] = useState("");

  // 初始购买金额
  const [initialBuyEth, setInitialBuyEth] = useState("");

  // 展开社交链接
  const [showSocials, setShowSocials] = useState(false);

  // i18n
  const tc = useTranslations("common");
  const t = useTranslations("create.memeToken");
  const tErrors = useTranslations("errors");
  const { showToast } = useToast();

  // 使用创建代币 hook
  const {
    createToken,
    isPending,
    isConfirming,
    isConfirmed,
    isTransactionFailed,
    step,
    txHash,
    createdTokenAddress,
    error,
    serviceFee,
    serviceFeeEth,
    reset,
  } = useCreateMemeToken();

  useEffect(() => {
    setMounted(true);
  }, []);

  // 监听创建成功
  useEffect(() => {
    const saveMetadataAndRedirect = async () => {
      if (isConfirmed && createdTokenAddress && address) {
        try {
          const instId = `${tokenSymbol}-USDT-SWAP`;
          await createTokenMetadata({
            instId,
            tokenAddress: createdTokenAddress,
            name: tokenName,
            symbol: tokenSymbol,
            description,
            logoUrl: logoUrl || logoIpfsHash,
            imageUrl: logoUrl || logoIpfsHash,
            website,
            twitter,
            telegram,
            discord,
            creatorAddress: address,
            totalSupply: "1000000.0",
            initialBuyAmount: initialBuyEth || undefined,
          });
          console.log("Token metadata saved successfully");
        } catch (error) {
          console.error("Failed to save token metadata:", error);
        }

        showToast(t("tokenCreated"), "success");
        router.push(`/trade/${createdTokenAddress}`);
      }
    };

    saveMetadataAndRedirect();
  }, [isConfirmed, createdTokenAddress, address, tokenName, tokenSymbol, description, logoUrl, logoIpfsHash, website, twitter, telegram, discord, initialBuyEth, router, showToast, t]);

  // 监听交易失败
  useEffect(() => {
    if (isTransactionFailed) {
      showToast(tErrors("unknown"), "error");
      reset();
    }
  }, [isTransactionFailed, showToast, reset, tErrors]);

  // 创建代币
  const handleCreateToken = async () => {
    if (!tokenName || !tokenSymbol) {
      showToast(t("fillNameAndSymbol"), "warning");
      return;
    }

    if (!isConnected || !address) {
      showToast(tc("connectWalletFirst"), "warning");
      return;
    }

    try {
      const metadata = {
        name: tokenName,
        symbol: tokenSymbol,
        description,
        image: logoUrl || logoIpfsHash,
        external_url: website,
        attributes: [
          { trait_type: "twitter", value: twitter },
          { trait_type: "telegram", value: telegram },
          { trait_type: "discord", value: discord },
        ].filter(attr => attr.value),
      };

      const metadataURI = logoIpfsHash
        ? `ipfs://${logoIpfsHash}`
        : `data:application/json;base64,${btoa(JSON.stringify(metadata))}`;

      await createToken({
        name: tokenName,
        symbol: tokenSymbol,
        metadataURI,
        initialBuyEth: initialBuyEth || undefined,
      });
    } catch (err) {
      console.error("Create token error:", err);
      const errorMessage = err instanceof Error ? err.message : tErrors("unknown");
      showToast(errorMessage, "error");
    }
  };

  const isCreating = isPending || isConfirming;

  if (!mounted) {
    return (
      <main className="min-h-screen bg-okx-bg-primary text-okx-text-primary">
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-10 h-10 border-4 border-okx-up border-t-transparent rounded-full animate-spin"></div>
        </div>
      </main>
    );
  }

  const showWalletLoading = isReconnecting;
  const effectivelyConnected = isConnected && !isReconnecting;
  const buyVal = parseFloat(initialBuyEth) || 0;
  const totalCost = (parseFloat(serviceFeeEth) || 0.001) + buyVal;

  return (
    <main className="min-h-screen bg-[#000000] text-okx-text-primary">
      <Navbar />

      {/* Title Section — full width */}
      <div className="px-12 pt-10">
        <h1 className="text-[32px] font-semibold text-white">
          {t("title")}
        </h1>
        <p className="text-sm text-[#6e6e6e] font-mono mt-2">
          {t("subtitle")}
        </p>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-8 px-12 py-8">
        {/* ====== Left Column — Form ====== */}
        <div className="flex-1 flex flex-col gap-8">

          {/* Token Info Card */}
          <div className="bg-[#111111] border border-[#1A1A1A] rounded-lg p-6 space-y-6">
            <h2 className="text-lg font-semibold text-white">{t("descriptionLabel") === "描述" ? "代币信息" : "Token Info"}</h2>

            <div className="flex gap-6">
              {/* Logo Upload */}
              <div className="flex-shrink-0">
                <ImageUpload
                  value={logoUrl}
                  onChange={(url, hash) => {
                    setLogoUrl(url);
                    setLogoIpfsHash(hash);
                  }}
                  label=""
                  hint=""
                  size="lg"
                />
                <p className="text-center text-[#6e6e6e] text-xs mt-2">{t("uploadLogo")}</p>
              </div>

              {/* Name + Symbol fields */}
              <div className="flex-1 space-y-4">
                <div>
                  <label className="block text-[#999999] text-xs font-medium font-mono mb-1.5">
                    {t("nameLabel")} <span className="text-[#FF3B30]">*</span>
                  </label>
                  <input
                    type="text"
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    placeholder={t("namePlaceholder")}
                    className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg px-3.5 py-3 text-white placeholder:text-[#6e6e6e] focus:outline-none focus:border-[#BFFF00] transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[#999999] text-xs font-medium font-mono mb-1.5">
                    {t("symbolLabel")} <span className="text-[#FF3B30]">*</span>
                  </label>
                  <input
                    type="text"
                    value={tokenSymbol}
                    onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
                    placeholder={t("symbolPlaceholder")}
                    maxLength={10}
                    className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg px-3.5 py-3 text-white placeholder:text-[#6e6e6e] focus:outline-none focus:border-[#BFFF00] transition-colors uppercase"
                  />
                </div>
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-[#999999] text-xs font-medium font-mono mb-1.5">
                {t("descriptionLabel")}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                rows={3}
                className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg px-3.5 py-3 text-white placeholder:text-[#6e6e6e] focus:outline-none focus:border-[#BFFF00] transition-colors resize-none"
              />
            </div>
          </div>

          {/* Social Links Card */}
          <div className="bg-[#111111] border border-[#1A1A1A] rounded-lg p-6">
            <button
              onClick={() => setShowSocials(!showSocials)}
              className="flex items-center justify-between w-full"
            >
              <span className="text-base font-semibold text-white">{t("addSocialLinks")}</span>
              <svg className={`w-4 h-4 text-[#6e6e6e] transition-transform ${showSocials ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showSocials && (
              <div className="grid grid-cols-2 gap-4 mt-5">
                <div>
                  <label className="block text-[#999999] text-xs font-medium font-mono mb-1.5">{t("websitePlaceholder")}</label>
                  <input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..."
                    className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg px-3.5 py-2.5 text-white placeholder:text-[#6e6e6e] focus:outline-none focus:border-[#BFFF00] text-sm" />
                </div>
                <div>
                  <label className="block text-[#999999] text-xs font-medium font-mono mb-1.5">Twitter / X</label>
                  <input type="url" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="https://twitter.com/..."
                    className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg px-3.5 py-2.5 text-white placeholder:text-[#6e6e6e] focus:outline-none focus:border-[#BFFF00] text-sm" />
                </div>
                <div>
                  <label className="block text-[#999999] text-xs font-medium font-mono mb-1.5">Telegram</label>
                  <input type="url" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/..."
                    className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg px-3.5 py-2.5 text-white placeholder:text-[#6e6e6e] focus:outline-none focus:border-[#BFFF00] text-sm" />
                </div>
                <div>
                  <label className="block text-[#999999] text-xs font-medium font-mono mb-1.5">Discord</label>
                  <input type="url" value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="https://discord.gg/..."
                    className="w-full bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg px-3.5 py-2.5 text-white placeholder:text-[#6e6e6e] focus:outline-none focus:border-[#BFFF00] text-sm" />
                </div>
              </div>
            )}
          </div>

          {/* Initial Buy Card */}
          <div className="bg-[#111111] border border-[#1A1A1A] rounded-lg p-6 space-y-5">
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold text-white">{t("initialBuyTitle")}</span>
              <span className="text-xs text-[#6e6e6e] font-mono">{t("initialBuySubtitle")}</span>
            </div>

            <div>
              <label className="block text-[#999999] text-xs font-medium font-mono mb-1.5">
                {t("buyAmountLabel")}
              </label>
              <div className="flex items-center bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg px-3.5 h-12">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={initialBuyEth}
                  onChange={(e) => setInitialBuyEth(e.target.value)}
                  placeholder="0.00"
                  className="flex-1 bg-transparent text-lg font-bold text-white placeholder:text-[#6e6e6e] focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full bg-[#BFFF00] flex items-center justify-center">
                    <span className="text-[10px] text-black font-bold">B</span>
                  </div>
                  <span className="text-sm font-bold text-white">BNB</span>
                </div>
              </div>
            </div>

            {/* Quick buttons */}
            <div className="flex gap-2">
              {["0.01", "0.05", "0.1", "0.5", "1"].map(val => (
                <button
                  key={val}
                  onClick={() => setInitialBuyEth(val)}
                  className={`flex-1 h-9 text-xs font-medium rounded-lg border transition-all ${
                    initialBuyEth === val
                      ? "bg-[#1A1A1A] border-[#BFFF00] text-[#BFFF00]"
                      : "bg-[#1A1A1A] border-[#2A2A2A] text-[#999999] hover:border-[#444] hover:text-white"
                  }`}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>

          {/* Fee Summary */}
          <div className="space-y-2.5 px-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#6e6e6e] font-mono">{t("creationFee")}</span>
              <span className="text-[#999999] font-mono font-medium">{serviceFeeEth} BNB</span>
            </div>
            {buyVal > 0 && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#6e6e6e] font-mono">{t("initialBuy")}</span>
                <span className="text-[#999999] font-mono font-medium">{initialBuyEth} BNB</span>
              </div>
            )}
            <div className="h-px bg-[#1A1A1A]"></div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-white font-mono font-semibold">{t("totalLabel")}</span>
              <span className="text-[#BFFF00] font-mono font-semibold">{totalCost.toFixed(4)} BNB</span>
            </div>
          </div>

          {/* Create Button */}
          {showWalletLoading ? (
            <div className="flex items-center justify-center py-4">
              <div className="w-5 h-5 border-2 border-[#BFFF00] border-t-transparent rounded-full animate-spin"></div>
              <span className="ml-3 text-[#6e6e6e] text-sm">{tc("syncingWallet")}</span>
            </div>
          ) : !effectivelyConnected ? (
            <div className="bg-[#BFFF00]/10 border border-[#BFFF00]/30 rounded-xl p-4">
              <p className="text-[#BFFF00] text-sm text-center font-medium">{tc("connectWalletFirst")}</p>
            </div>
          ) : (
            <button
              onClick={handleCreateToken}
              disabled={isCreating || !tokenName || !tokenSymbol}
              className={`w-full h-14 bg-[#BFFF00] text-black rounded-lg font-bold text-base flex items-center justify-center gap-2.5 transition-all ${
                isCreating || !tokenName || !tokenSymbol ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-110'
              }`}
            >
              {isCreating ? (
                <>
                  <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin"></div>
                  {step === "creating" && t("submitTx")}
                  {step === "confirming" && t("waitingConfirm")}
                  {step === "done" && t("createSuccess")}
                </>
              ) : (
                <>{t("createTokenButton")}</>
              )}
            </button>
          )}

          {txHash && (
            <div className="text-center">
              <a
                href={`${NETWORK_CONFIG.BLOCK_EXPLORER}/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[#BFFF00] text-xs hover:underline"
              >
                {t("viewTransaction")} ↗
              </a>
            </div>
          )}
        </div>

        {/* ====== Right Column — Info Sidebar ====== */}
        <div className="w-[380px] flex-shrink-0 flex flex-col gap-6">

          {/* Token Parameters */}
          <div className="bg-[#111111] border border-[#1A1A1A] rounded-lg p-6">
            <h3 className="text-base font-semibold text-white mb-4">{t("tokenParams")}</h3>
            <div className="space-y-0">
              {[
                { label: t("totalSupply"), value: "1,000,000,000", color: "text-white" },
                { label: t("creationFee"), value: `${serviceFeeEth} BNB`, color: "text-white" },
                { label: t("tradingFee"), value: "1%", color: "text-white" },
                { label: t("graduationThreshold"), value: "~5.16 BNB", color: "text-[#BFFF00]" },
                { label: t("bondingCurve"), value: t("bondingCurveFormula"), color: "text-white" },
              ].map((row, i, arr) => (
                <React.Fragment key={i}>
                  <div className="flex items-center justify-between py-3">
                    <span className="text-xs text-[#6e6e6e] font-mono">{row.label}</span>
                    <span className={`text-xs font-mono font-semibold ${row.color}`}>{row.value}</span>
                  </div>
                  {i < arr.length - 1 && <div className="h-px bg-[#1A1A1A]"></div>}
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Fee Distribution */}
          <div className="bg-[#111111] border border-[#1A1A1A] rounded-lg p-6">
            <h3 className="text-base font-semibold text-white mb-4">{t("feeDistribution")}</h3>
            {/* Colored bar */}
            <div className="flex h-2 rounded-full overflow-hidden mb-4">
              <div className="bg-[#BFFF00]" style={{ width: '50%' }}></div>
              <div className="bg-[#3B82F6]" style={{ width: '20%' }}></div>
              <div className="bg-[#404040] flex-1"></div>
            </div>
            {/* Legend */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-[#BFFF00]"></div>
                  <span className="text-xs text-[#6e6e6e] font-mono">{t("creator")}</span>
                </div>
                <span className="text-xs text-white font-mono font-medium">50%</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-[#3B82F6]"></div>
                  <span className="text-xs text-[#6e6e6e] font-mono">{t("referrer")}</span>
                </div>
                <span className="text-xs text-white font-mono font-medium">10%</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-[#404040]"></div>
                  <span className="text-xs text-[#6e6e6e] font-mono">{t("platform")}</span>
                </div>
                <span className="text-xs text-white font-mono font-medium">40%</span>
              </div>
            </div>
          </div>

          {/* How It Works */}
          <div className="bg-[#111111] border border-[#1A1A1A] rounded-lg p-6">
            <h3 className="text-base font-semibold text-white mb-5">{t("howItWorks")}</h3>
            <div className="space-y-5">
              {[
                { num: "1", title: t("step1Title"), desc: t("step1Desc"), active: true },
                { num: "2", title: t("step2Title"), desc: t("step2Desc"), active: false },
                { num: "3", title: t("step3Title"), desc: t("step3Desc"), active: false },
              ].map((s) => (
                <div key={s.num} className="flex gap-3">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                    s.active
                      ? 'bg-[#BFFF00] text-black'
                      : 'bg-[#1A1A1A] border border-[#2A2A2A] text-[#6e6e6e]'
                  }`}>
                    {s.num}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white">{s.title}</div>
                    <div className="text-xs text-[#6e6e6e] font-mono mt-1 leading-relaxed">{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Terms */}
      <div className="px-12 pb-8 text-center">
        <p className="text-[#6e6e6e] text-xs">
          {t("termsAgree")} <a href="#" className="text-[#999999] hover:text-white">{t("termsOfService")}</a>
        </p>
      </div>
    </main>
  );
}
