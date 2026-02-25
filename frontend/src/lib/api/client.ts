/**
 * REST API 客户端
 *
 * 仅保留实际使用的端点和类型。
 */

// ============================================================
// Types
// ============================================================

export interface Instrument {
  instId: string;
  baseCcy: string;
  quoteCcy: string;
  settleCcy: string;
  instType: string;
  state: string;
  ctVal: string;
  ctMult: string;
  lever: string;
  minSz: string;
  lotSz: string;
  tickSz: string;
  maxLever: number;
  maxLimitSz: string;
  maxMktSz: string;
}

export interface Ticker {
  instId: string;
  last: string;
  lastSz: string;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
  vol24h: string;
  ts: number;
  logoUrl?: string;
  imageUrl?: string;
}

// ============================================================
// ApiClient
// ============================================================

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.NEXT_PUBLIC_MATCHING_ENGINE_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8081";
  }

  async getInstruments(_instType?: string): Promise<Instrument[]> {
    // TODO: 对接真实 API
    return [];
  }

  async getTickers(): Promise<Ticker[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/market/tickers`);
      if (!res.ok) return [];
      const json = await res.json();
      if (json.code === "0" && Array.isArray(json.data)) {
        return json.data;
      }
      return [];
    } catch {
      return [];
    }
  }

}

// Singleton instance
export const apiClient = new ApiClient();

export default apiClient;
