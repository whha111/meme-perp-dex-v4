import { MATCHING_ENGINE_URL, WS_URL } from "@/config/api";
import type { SignedOrder, SubmitOrderOptions } from "@/utils/orderSigning";

type JsonRecord = Record<string, unknown>;

export interface V3CreateOrderInput {
  signedOrder: SignedOrder;
  market?: string;
  side?: "BUY" | "SELL";
  type?: "MARKET" | "LIMIT";
  timeInForce?: "GTC" | "GTT" | "GTD" | "IOC" | "FOK";
  postOnly?: boolean;
  reduceOnly?: boolean;
  clientId?: string;
  options?: SubmitOrderOptions;
}

export interface V3OrderResult {
  success: boolean;
  orderId?: string;
  status?: string;
  error?: string;
  order?: JsonRecord | null;
  result?: JsonRecord;
}

async function readJson(response: Response): Promise<any> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
  }
  return payload;
}

export class MemePerpClient {
  readonly host: string;
  readonly wsHost: string;

  constructor({ host = MATCHING_ENGINE_URL, wsHost = WS_URL }: { host?: string; wsHost?: string } = {}) {
    this.host = host.replace(/\/$/, "");
    this.wsHost = wsHost;
  }

  private url(path: string): string {
    return `${this.host}${path}`;
  }

  publicApi = {
    getMarkets: async () => readJson(await fetch(this.url("/v3/markets"))),
    getOrderbook: async (market: string) => readJson(await fetch(this.url(`/v3/orderbook/${encodeURIComponent(market)}`))),
    getTrades: async (market: string, limit = 100) =>
      readJson(await fetch(this.url(`/v3/trades/${encodeURIComponent(market)}?limit=${limit}`))),
  };

  privateApi = {
    createOrder: async (input: V3CreateOrderInput): Promise<V3OrderResult> => {
      const { signedOrder, options } = input;
      const market = input.market || options?.marketId || signedOrder.token;
      const type = input.type || (signedOrder.orderType === 0 ? "MARKET" : "LIMIT");
      const side = input.side || (signedOrder.isLong ? "BUY" : "SELL");

      try {
        const payload = await readJson(await fetch(this.url("/v3/orders"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-dexi-trader": signedOrder.trader,
          },
          body: JSON.stringify({
            market,
            side,
            type,
            size: signedOrder.size.toString(),
            price: signedOrder.price.toString(),
            leverage: signedOrder.leverage.toString(),
            expiration: signedOrder.deadline.toString(),
            nonce: signedOrder.nonce.toString(),
            signature: signedOrder.signature,
            trader: signedOrder.trader,
            timeInForce: input.timeInForce || "GTC",
            postOnly: input.postOnly ?? false,
            reduceOnly: input.reduceOnly ?? false,
            clientId: input.clientId,
            collateralToken: options?.collateralToken || "BNB",
            takeProfit: options?.takeProfit,
            stopLoss: options?.stopLoss,
          }),
        }));

        return {
          success: true,
          orderId: payload?.order?.id || payload?.result?.orderId,
          status: payload?.order?.status || payload?.result?.status,
          order: payload?.order || null,
          result: payload?.result,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Order submission failed",
        };
      }
    },

    cancelOrder: async (orderId: string, trader: string, signature: string): Promise<V3OrderResult> => {
      try {
        const payload = await readJson(await fetch(this.url(`/v3/orders/${encodeURIComponent(orderId)}`), {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "x-dexi-trader": trader,
            "x-dexi-signature": signature,
          },
          body: JSON.stringify({ trader, signature }),
        }));
        return {
          success: true,
          orderId,
          status: payload?.order?.status || payload?.result?.status,
          order: payload?.order || null,
          result: payload?.result,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Cancel failed",
        };
      }
    },

    getPositions: async (trader: string) => readJson(await fetch(this.url(`/v3/positions?trader=${encodeURIComponent(trader)}`))),
    getOrders: async (trader: string) => readJson(await fetch(this.url(`/v3/orders?trader=${encodeURIComponent(trader)}`))),
  };

  ["public"] = this.publicApi;
  ["private"] = this.privateApi;
}

export const memePerpClient = new MemePerpClient();
