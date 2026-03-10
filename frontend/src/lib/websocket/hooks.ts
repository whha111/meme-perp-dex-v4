/**
 * WebSocket React Hooks — System A (WebSocketClient)
 *
 * 这些 hooks 使用 lib/websocket/client.ts 的 WebSocketClient 单例。
 * 主要用于 kline 和 spot trade 数据。
 *
 * 注意: balance/positions/orders 消息通过 System B (WebSocketManager → tradingDataStore) 接收,
 * 不经过此处的 hooks。请直接从 tradingDataStore 读取。
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { WebSocketClient, getWebSocketClient } from "./client";
import { ConnectionStatus, MessageType, WebSocketMessage } from "./types";

/**
 * 使用 WebSocket 连接状态
 */
export function useWebSocketStatus(client?: WebSocketClient): ConnectionStatus {
  const wsClient = client || getWebSocketClient();
  const [status, setStatus] = useState<ConnectionStatus>(wsClient.getStatus());

  useEffect(() => {
    const unsubscribe = wsClient.onConnectionChange(setStatus);
    return unsubscribe;
  }, [wsClient]);

  return status;
}

/**
 * 使用 WebSocket 消息订阅
 */
export function useWebSocketMessage<T = unknown>(
  type: MessageType,
  handler: (message: WebSocketMessage<T>) => void,
  client?: WebSocketClient
): void {
  const wsClient = client || getWebSocketClient();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const messageHandler = (message: WebSocketMessage<unknown>) => {
      handlerRef.current(message as WebSocketMessage<T>);
    };

    const unsubscribe = wsClient.on(type, messageHandler);
    return unsubscribe;
  }, [type, wsClient]);
}

/**
 * 使用 WebSocket 请求
 */
export function useWebSocketRequest() {
  const wsClient = getWebSocketClient();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const request = useCallback(
    async <T = unknown>(type: MessageType, data?: unknown): Promise<T> => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await wsClient.request<T>(type, data);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [wsClient]
  );

  return {
    request,
    isLoading,
    error,
  };
}

/**
 * 使用 WebSocket 连接管理
 */
export function useWebSocketConnection() {
  const wsClient = getWebSocketClient();
  const status = useWebSocketStatus(wsClient);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<Error | null>(null);

  const connect = useCallback(async (): Promise<void> => {
    setIsConnecting(true);
    setConnectionError(null);

    try {
      await wsClient.connect();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setConnectionError(error);
      throw error;
    } finally {
      setIsConnecting(false);
    }
  }, [wsClient]);

  const disconnect = useCallback((): void => {
    wsClient.disconnect();
  }, [wsClient]);

  return {
    connect,
    disconnect,
    status,
    isConnected: status === ConnectionStatus.CONNECTED,
    isConnecting,
    connectionError,
  };
}

/**
 * 使用 WebSocket 主题订阅
 */
export function useWebSocketSubscription() {
  const wsClient = getWebSocketClient();
  const [subscribedTopics, setSubscribedTopics] = useState<Set<string>>(
    new Set()
  );
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<Error | null>(
    null
  );

  const subscribe = useCallback(
    async (topics: string | string[]): Promise<void> => {
      const topicArray = Array.isArray(topics) ? topics : [topics];

      setIsSubscribing(true);
      setSubscriptionError(null);

      try {
        await wsClient.subscribe(topicArray);

        setSubscribedTopics((prev) => {
          const newSet = new Set(prev);
          topicArray.forEach((topic) => newSet.add(topic));
          return newSet;
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setSubscriptionError(error);
        throw error;
      } finally {
        setIsSubscribing(false);
      }
    },
    [wsClient]
  );

  const unsubscribe = useCallback(
    async (topics: string | string[]): Promise<void> => {
      const topicArray = Array.isArray(topics) ? topics : [topics];

      setIsSubscribing(true);
      setSubscriptionError(null);

      try {
        await wsClient.unsubscribe(topicArray);

        setSubscribedTopics((prev) => {
          const newSet = new Set(prev);
          topicArray.forEach((topic) => newSet.delete(topic));
          return newSet;
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setSubscriptionError(error);
        throw error;
      } finally {
        setIsSubscribing(false);
      }
    },
    [wsClient]
  );

  const isSubscribed = useCallback(
    (topic: string): boolean => {
      return subscribedTopics.has(topic);
    },
    [subscribedTopics]
  );

  return {
    subscribe,
    unsubscribe,
    isSubscribed,
    subscribedTopics: Array.from(subscribedTopics),
    isSubscribing,
    subscriptionError,
  };
}
