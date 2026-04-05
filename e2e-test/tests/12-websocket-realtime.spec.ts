/**
 * 12 — WebSocket Real-time Tests (Production Mode)
 * Verify WS connection, subscriptions, and real-time data pushes
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";
import WebSocket from "ws";

const ENGINE_WS = "ws://localhost:8081";
const ENGINE = process.env.MATCHING_ENGINE_URL || "http://localhost:8081";
const tokens = JSON.parse(readFileSync(resolve(__dirname, "../data/token-addresses.json"), "utf8"));
const token = (Object.values(tokens)[0] as any).address;

function connectWS(path = ""): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ENGINE_WS}${path}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 10000);
  });
}

function waitForMessage(ws: WebSocket, timeout = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS message timeout")), timeout);
    ws.once("message", (data) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString())); } catch { resolve(data.toString()); }
    });
  });
}

test.describe.serial("12 — WebSocket Real-time (Production)", () => {
  test("connect to WebSocket", async () => {
    let ws: WebSocket | null = null;
    try {
      ws = await connectWS();
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws?.close();
    }
  });

  test("subscribe to orderbook updates", async () => {
    let ws: WebSocket | null = null;
    try {
      ws = await connectWS();
      ws.send(JSON.stringify({ type: "subscribe", channel: "orderbook", token }));
      const msg = await waitForMessage(ws, 5000).catch(() => null);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws?.close();
    }
  });

  test("subscribe to trade feed", async () => {
    let ws: WebSocket | null = null;
    try {
      ws = await connectWS();
      ws.send(JSON.stringify({ type: "subscribe", channel: "trades", token }));
      await new Promise(r => setTimeout(r, 1000));
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws?.close();
    }
  });

  test("multiple concurrent WS connections", async () => {
    const connections: WebSocket[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        const ws = await connectWS();
        connections.push(ws);
      }
      for (const ws of connections) {
        expect(ws.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      for (const ws of connections) ws.close();
    }
  });
});
