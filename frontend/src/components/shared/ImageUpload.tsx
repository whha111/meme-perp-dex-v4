"use client";

import React, { useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { uploadToIPFS, getIPFSUrl } from "@/lib/ipfs";

interface ImageUploadProps {
  value?: string; // IPFS hash 或 URL
  onChange: (ipfsUrl: string, ipfsHash: string) => void;
  label?: string;
  hint?: string;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}

const sizeMap = {
  sm: "w-16 h-16",
  md: "w-24 h-24",
  lg: "w-32 h-32",
};

export function ImageUpload({
  value,
  onChange,
  label,
  hint,
  size = "md",
  disabled = false,
}: ImageUploadProps) {
  const t = useTranslations("imageUpload");
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(value ? getIPFSUrl(value) : null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (!disabled && inputRef.current) {
      inputRef.current.click();
    }
  }, [disabled]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setIsUploading(true);

    // 先显示本地预览
    const localPreview = URL.createObjectURL(file);
    setPreview(localPreview);

    try {
      const result = await uploadToIPFS(file);

      if (result.success && result.ipfsUrl && result.ipfsHash) {
        setPreview(result.ipfsUrl);
        onChange(result.ipfsUrl, result.ipfsHash);
      } else {
        setError(result.error || t("uploadFailed"));
        setPreview(null);
      }
    } catch (err) {
      setError(t("uploadError"));
      setPreview(null);
    } finally {
      setIsUploading(false);
      // 清空 input，允许重新选择同一文件
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }, [onChange]);

  const handleRemove = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setPreview(null);
    onChange("", "");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }, [onChange]);

  return (
    <div className="space-y-2">
      {label && (
        <label className="block text-okx-text-secondary text-sm">{label}</label>
      )}

      <div
        onClick={handleClick}
        className={`
          ${sizeMap[size]}
          relative rounded-xl border-2 border-dashed
          ${disabled
            ? "border-okx-border-primary cursor-not-allowed opacity-50"
            : "border-okx-border-primary hover:border-okx-accent cursor-pointer"
          }
          bg-okx-bg-hover transition-colors overflow-hidden
          flex items-center justify-center
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
          onChange={handleFileChange}
          disabled={disabled || isUploading}
          className="hidden"
        />

        {isUploading ? (
          <div className="flex flex-col items-center justify-center">
            <div className="w-6 h-6 border-2 border-okx-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-okx-text-tertiary mt-1">{t("uploading")}</span>
          </div>
        ) : preview ? (
          <>
            <img
              src={preview}
              alt="Preview"
              className="w-full h-full object-cover"
            />
            {!disabled && (
              <button
                onClick={handleRemove}
                className="absolute top-1 right-1 w-5 h-5 bg-okx-bg-primary/70 hover:bg-okx-down rounded-full flex items-center justify-center transition-colors"
              >
                <svg className="w-3 h-3 text-okx-text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center text-okx-text-tertiary">
            <svg className="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-xs">{t("clickToUpload")}</span>
          </div>
        )}
      </div>

      {error && (
        <p className="text-red-500 text-xs">{error}</p>
      )}

      {hint && !error && (
        <p className="text-okx-text-tertiary text-xs">{hint}</p>
      )}
    </div>
  );
}

export default ImageUpload;
