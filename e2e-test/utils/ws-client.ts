/**
 * WebSocket Client for Matching Engine
 * Connect, subscribe, and receive real-time data
 */
import WebSocket from "ws";
import { log } from "./logger";

interface WsMessage {
  type: string;
  channel?: string;
  data?: any;
  [key: string]: any;
}

export class EngineWsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private messageQueue: WsMessage[] = [];
  private listeners: Map<string, ((msg: WsMessage) => void)[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnects = 5;
  private reconnectDelay = 1000;

  constructor(url = "ws://localhost:8081") {
    this.url = url;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on("open", () => {
        this.reconnectAttempts = 0;
        log.test.info({ url: this.url }, "WS connected");
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WsMessage;
          this.messageQueue.push(msg);
          const listeners = this.listeners.get(msg.type) || [];
          for (const cb of listeners) cb(msg);
        } catch {
          // Non-JSON message
        }
      });

      this.ws.on("close", () => {
        log.test.warn("WS disconnected");
        if (this.reconnectAttempts < this.maxReconnects) {
          this.reconnectAttempts++;
          const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
          setTimeout(() => this.connect().catch(() => {}), delay);
        }
      });

      this.ws.on("error", (err) => {
        log.test.error({ error: err.message }, "WS error");
        reject(err);
      });

      setTimeout(() => reject(new Error("WS connect timeout")), 10000);
    });
  }

  subscribe(channel: string, token?: string): void {
    this.send({ type: "subscribe", channel, token });
  }

  authenticate(trader: string): void {
    this.send({ type: "auth", trader });
  }

  send(msg: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async waitForMessage(type: string, timeout = 10000): Promise<WsMessage> {
    // Check queue first
    const idx = this.messageQueue.findIndex(m => m.type === type);
    if (idx >= 0) {
      return this.messageQueue.splice(idx, 1)[0];
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener(type, handler);
        reject(new Error(`WS message timeout: ${type}`));
      }, timeout);

      const handler = (msg: WsMessage) => {
        clearTimeout(timer);
        this.removeListener(type, handler);
        resolve(msg);
      };

      this.addListener(type, handler);
    });
  }

  private addListener(type: string, cb: (msg: WsMessage) => void): void {
    const list = this.listeners.get(type) || [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  private removeListener(type: string, cb: (msg: WsMessage) => void): void {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter(l => l !== cb));
  }

  close(): void {
    this.maxReconnects = 0; // prevent reconnect
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
