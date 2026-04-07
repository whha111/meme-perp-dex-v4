/**
 * IPFS 上传服务 (使用 Pinata)
 *
 * 用于上传代币 Logo 图片到 IPFS
 */

// P0-1: Pinata JWT 不能暴露在客户端 (NEXT_PUBLIC_ 前缀会被打包进浏览器 JS)
// 上传功能通过 /api/upload 代理到后端，JWT 仅在服务端使用
// 客户端只需要 gateway URL（公开可读，无需认证）
const PINATA_GATEWAY = process.env.NEXT_PUBLIC_PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';

// Locale-aware error messages for IPFS upload
const ipfsI18n: Record<string, { invalidFormat: string; tooLarge: string; uploadFailed: string }> = {
  zh: { invalidFormat: '不支持的图片格式，请使用 JPG、PNG、GIF、WebP 或 SVG', tooLarge: '图片大小不能超过 5MB', uploadFailed: '上传失败' },
  en: { invalidFormat: 'Unsupported image format. Please use JPG, PNG, GIF, WebP or SVG', tooLarge: 'Image size cannot exceed 5MB', uploadFailed: 'Upload failed' },
  ja: { invalidFormat: 'サポートされていない画像形式です。JPG、PNG、GIF、WebP、SVGを使用してください', tooLarge: '画像サイズは5MBを超えることはできません', uploadFailed: 'アップロード失敗' },
  ko: { invalidFormat: '지원되지 않는 이미지 형식입니다. JPG, PNG, GIF, WebP 또는 SVG를 사용하세요', tooLarge: '이미지 크기는 5MB를 초과할 수 없습니다', uploadFailed: '업로드 실패' },
};

function getLocale(): string {
  if (typeof window === 'undefined') return 'zh';
  try { return localStorage.getItem('dexi-locale') || 'zh'; } catch { return 'zh'; }
}

export interface UploadResult {
  success: boolean;
  ipfsHash?: string;
  ipfsUrl?: string;
  error?: string;
}

/**
 * 上传文件到 IPFS (通过后端 API 代理，JWT 不暴露在客户端)
 */
export async function uploadToIPFS(file: File): Promise<UploadResult> {
  const t = ipfsI18n[getLocale()] || ipfsI18n.zh;

  // 验证文件类型
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  if (!allowedTypes.includes(file.type)) {
    return {
      success: false,
      error: t.invalidFormat,
    };
  }

  // 验证文件大小 (最大 5MB)
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    return {
      success: false,
      error: t.tooLarge,
    };
  }

  try {
    const formData = new FormData();
    formData.append('file', file);

    // P0-1: 通过 Next.js API route 代理上传，JWT 仅在服务端使用
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `${t.uploadFailed}: ${response.status}`);
    }

    const data = await response.json();
    const ipfsHash = data.ipfsHash;

    return {
      success: true,
      ipfsHash,
      ipfsUrl: `${PINATA_GATEWAY}/${ipfsHash}`,
    };
  } catch (error) {
    console.error('[IPFS] upload failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : t.uploadFailed,
    };
  }
}

/**
 * 上传 JSON 元数据到 IPFS (通过后端 API 代理)
 */
export async function uploadJSONToIPFS(data: Record<string, unknown>, name: string): Promise<UploadResult> {
  const t = ipfsI18n[getLocale()] || ipfsI18n.zh;

  try {
    // P0-1: 通过 Next.js API route 代理上传，JWT 仅在服务端使用
    const response = await fetch('/api/upload-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, name }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `${t.uploadFailed}: ${response.status}`);
    }

    const result = await response.json();
    const ipfsHash = result.ipfsHash;

    return {
      success: true,
      ipfsHash,
      ipfsUrl: `${PINATA_GATEWAY}/${ipfsHash}`,
    };
  } catch (error) {
    console.error('[IPFS] JSON upload failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : t.uploadFailed,
    };
  }
}

/**
 * 获取 IPFS 网关 URL
 */
export function getIPFSUrl(ipfsHash: string): string {
  if (!ipfsHash) return '';

  // 如果已经是完整 URL，直接返回
  if (ipfsHash.startsWith('http')) {
    return ipfsHash;
  }

  // 移除可能的 ipfs:// 前缀
  const hash = ipfsHash.replace('ipfs://', '');

  return `${PINATA_GATEWAY}/${hash}`;
}

/**
 * 验证是否为有效的 IPFS hash
 */
export function isValidIPFSHash(hash: string): boolean {
  if (!hash) return false;

  // CIDv0 (Qm 开头，46 字符)
  if (hash.startsWith('Qm') && hash.length === 46) {
    return true;
  }

  // CIDv1 (bafy 开头)
  if (hash.startsWith('bafy')) {
    return true;
  }

  return false;
}
