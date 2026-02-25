/**
 * WebSocket 客户端
 *
 * 实现功能：
 * - 建立真实 WebSocket 连接到撮合引擎
 * - 自动重连和心跳保活
 * - 消息订阅和分发
 * - 主题订阅管理
 */

import {
  WebSocketConfig,
  DEFAULT_CONFIG,
  ConnectionStatus,
  WebSocketMessage,
  MessageType,
} from "./types";
import { WS_URL } from "@/config/api";

type MessageHandler = (message: WebSocketMessage) => void;
type ConnectionHandler = (status: ConnectionStatus) => void;
type RawMessageHandler = (event: MessageEvent) => void;

// ============================================================
// 重连配置
// ============================================================

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL = 30000;
const PONG_TIMEOUT = 60000;

// ============================================================
// WebSocketClient (真实连接)
// ============================================================

export class WebSocketClient {
  private config: WebSocketConfig;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private messageHandlers = new Map<MessageType, Set<MessageHandler>>();
  private connectionHandlers = new Set<ConnectionHandler>();
  private rawMessageHandlers = new Set<RawMessageHandler>();

  // 重连状态
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // 心跳状态
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastPong: number = Date.now();

  // 订阅的主题
  private subscribedTopics = new Set<string>();

  constructor(config?: Partial<WebSocketConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 连接到 WebSocket 服务器
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      if (this.ws?.readyState === WebSocket.CONNECTING) {
        // 等待现有连接完成
        const checkInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(checkInterval);
            resolve();
          } else if (this.ws?.readyState === WebSocket.CLOSED) {
            clearInterval(checkInterval);
            reject(new Error("WebSocket closed during connection"));
          }
        }, 100);
        return;
      }

      const wsUrl = WS_URL;
      // connecting

      this.setStatus(ConnectionStatus.CONNECTING);

      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          // connected
          this.setStatus(ConnectionStatus.CONNECTED);
          this.reconnectAttempts = 0;
          this.lastPong = Date.now();
          this.startPing();
          this.resubscribeAll();
          resolve();
        };

        this.ws.onclose = (event) => {
          // disconnected
          this.setStatus(ConnectionStatus.DISCONNECTED);
          this.stopPing();
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          console.error("[WebSocketClient] Error:", error);
          this.setStatus(ConnectionStatus.ERROR);
          reject(error);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event);
        };
      } catch (error) {
        console.error("[WebSocketClient] Failed to create WebSocket:", error);
        this.setStatus(ConnectionStatus.ERROR);
        reject(error);
      }
    });
  }

  /**
   * 断开 WebSocket 连接
   */
  disconnect(): void {
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus(ConnectionStatus.DISCONNECTED);
  }

  /**
   * 发送消息
   */
  async send<T = unknown>(
    type: MessageType,
    data?: unknown,
    requestId?: string
  ): Promise<WebSocketMessage<T>> {
    const message: WebSocketMessage = {
      type,
      request_id: requestId || this.generateRequestId(),
      data,
      timestamp: Math.floor(Date.now() / 1000),
    };

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }

    return message as WebSocketMessage<T>;
  }

  /**
   * 发送请求并等待响应
   */
  async request<T = unknown>(type: MessageType, data?: unknown): Promise<T> {
    const requestId = this.generateRequestId();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Request timeout"));
      }, 10000);

      const handler = (message: WebSocketMessage) => {
        if (message.request_id === requestId) {
          clearTimeout(timeout);
          this.messageHandlers.get(type)?.delete(handler);
          if (message.error) {
            reject(new Error(message.error));
          } else {
            resolve(message.data as T);
          }
        }
      };

      if (!this.messageHandlers.has(type)) {
        this.messageHandlers.set(type, new Set());
      }
      this.messageHandlers.get(type)!.add(handler);

      this.send(type, data, requestId);
    });
  }

  /**
   * 订阅消息类型
   */
  on(type: MessageType, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);

    return () => {
      const handlers = this.messageHandlers.get(type);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.messageHandlers.delete(type);
        }
      }
    };
  }

  /**
   * 订阅连接状态变化
   */
  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    handler(this.status);

    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  /**
   * 订阅原始消息 (用于 K 线等需要直接处理的场景)
   */
  onRawMessage(handler: RawMessageHandler): () => void {
    this.rawMessageHandlers.add(handler);

    return () => {
      this.rawMessageHandlers.delete(handler);
    };
  }

  /**
   * 订阅主题
   */
  async subscribe(topics: string[]): Promise<void> {
    topics.forEach((topic) => this.subscribedTopics.add(topic.toLowerCase()));

    if (this.ws?.readyState === WebSocket.OPEN) {
      // 发送订阅消息到服务器 (使用后端期望的格式)
      this.ws.send(
        JSON.stringify({
          type: "subscribe",
          request_id: this.generateRequestId(),
          data: {
            topics: topics.map((t) => t.toLowerCase()),
          },
        })
      );
      // subscribed
    }
  }

  /**
   * 取消订阅主题
   */
  async unsubscribe(topics: string[]): Promise<void> {
    topics.forEach((topic) => this.subscribedTopics.delete(topic.toLowerCase()));

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "unsubscribe",
          request_id: this.generateRequestId(),
          data: {
            topics: topics.map((t) => t.toLowerCase()),
          },
        })
      );
      // unsubscribed
    }
  }

  /**
   * 获取当前订阅的主题列表
   */
  getSubscribedTopics(): string[] {
    return Array.from(this.subscribedTopics);
  }

  /**
   * 获取原始 WebSocket 实例
   */
  getWebSocket(): WebSocket | null {
    return this.ws;
  }

  /**
   * 获取当前连接状态
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ============================================================
  // 私有方法
  // ============================================================

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.connectionHandlers.forEach((handler) => handler(status));
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data;

    // 触发原始消息处理器 (供 K 线等组件使用)
    this.rawMessageHandlers.forEach((handler) => {
      try {
        handler(event);
      } catch (e) {
        console.error("[WebSocketClient] Raw handler error:", e);
      }
    });

    // 处理 pong 响应
    if (data === "pong" || data === '"pong"') {
      this.lastPong = Date.now();
      return;
    }

    try {
      const message = JSON.parse(data) as WebSocketMessage;

      // 分发到类型处理器
      const handlers = this.messageHandlers.get(message.type as MessageType);
      if (handlers) {
        handlers.forEach((handler) => {
          try {
            handler(message);
          } catch (e) {
            console.error("[WebSocketClient] Handler error:", e);
          }
        });
      }

      // 通用消息处理器 (MessageType.TRADE 等)
      const allHandlers = this.messageHandlers.get("*" as MessageType);
      if (allHandlers) {
        allHandlers.forEach((handler) => {
          try {
            handler(message);
          } catch (e) {
            console.error("[WebSocketClient] All handler error:", e);
          }
        });
      }
    } catch (e) {
      // 非 JSON 消息，忽略
    }
  }

  private startPing(): void {
    this.stopPing();

    this.pingInterval = setInterval(() => {
      // 检查心跳超时
      if (Date.now() - this.lastPong > PONG_TIMEOUT) {
        console.warn("[WebSocketClient] Heartbeat timeout, reconnecting...");
        this.ws?.close();
        return;
      }

      // 发送 ping
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
      }
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("[WebSocketClient] Max reconnect attempts reached");
      this.setStatus(ConnectionStatus.ERROR);
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY
    );

    this.setStatus(ConnectionStatus.RECONNECTING);

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch((e) => {
        console.error("[WebSocketClient] Reconnect failed:", e);
      });
    }, delay);
  }

  private resubscribeAll(): void {
    if (this.subscribedTopics.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "subscribe",
          request_id: this.generateRequestId(),
          data: {
            topics: Array.from(this.subscribedTopics),
          },
        })
      );
      // resubscribed
    }
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

// 创建全局单例实例
let globalInstance: WebSocketClient | null = null;

export function getWebSocketClient(
  config?: Partial<WebSocketConfig>
): WebSocketClient {
  if (!globalInstance) {
    globalInstance = new WebSocketClient(config);
  }
  return globalInstance;
}

export default WebSocketClient;
