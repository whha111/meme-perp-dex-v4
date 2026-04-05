/**
 * Engine Health Monitor — Continuously polls engine health during tests
 * Tracks: memory, Redis, latency, positions, orders
 */
import { ENV, TEST_PARAMS } from "../config/test-config";
import { log } from "../utils/logger";
import { writeFileSync } from "fs";
import { resolve } from "path";

interface HealthSnapshot {
  timestamp: number;
  status: string;
  uptime: number;
  memoryMB: number;
  redisConnected: boolean;
  redisErrors: number;
  totalRequests: number;
  totalOrders: number;
  pendingMatches: number;
  openPositions: number;
  userNonces: number;
}

const snapshots: HealthSnapshot[] = [];
let monitorInterval: NodeJS.Timeout | null = null;

async function pollHealth(): Promise<HealthSnapshot | null> {
  try {
    const resp = await fetch(`${ENV.ENGINE_URL}/health`, {
      signal: AbortSignal.timeout(TEST_PARAMS.ENGINE_HEALTH_TIMEOUT_MS),
    });
    const data = await resp.json() as any;

    return {
      timestamp: Date.now(),
      status: data.status,
      uptime: data.uptime,
      memoryMB: data.metrics?.memoryMB || 0,
      redisConnected: data.services?.redis === "connected",
      redisErrors: data.services?.redisErrors?.total || 0,
      totalRequests: data.metrics?.totalRequests || 0,
      totalOrders: data.metrics?.totalOrders || 0,
      pendingMatches: data.metrics?.pendingMatches || 0,
      openPositions: data.metrics?.mapSizes?.userPositions || 0,
      userNonces: data.metrics?.mapSizes?.userNonces || 0,
    };
  } catch (err) {
    log.monitor.error({ error: (err as Error).message }, "Health check failed");
    return null;
  }
}

export function startHealthMonitor(intervalMs = 10_000): void {
  log.monitor.info({ intervalMs }, "Starting health monitor");

  monitorInterval = setInterval(async () => {
    const snapshot = await pollHealth();
    if (snapshot) {
      snapshots.push(snapshot);

      // Alert conditions
      if (snapshot.memoryMB > TEST_PARAMS.MAX_MEMORY_MB) {
        log.monitor.warn({ memoryMB: snapshot.memoryMB }, "HIGH MEMORY");
      }
      if (!snapshot.redisConnected) {
        log.monitor.error("REDIS DISCONNECTED");
      }
      if (snapshot.redisErrors > 0) {
        log.monitor.warn({ errors: snapshot.redisErrors }, "Redis errors detected");
      }
    }
  }, intervalMs);
}

export function stopHealthMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  // Save snapshots
  const outputPath = resolve(__dirname, "../reports/health-snapshots.json");
  writeFileSync(outputPath, JSON.stringify(snapshots, null, 2));
  log.monitor.info({ snapshots: snapshots.length, outputPath }, "Health monitor stopped");
}

export function getSnapshots(): HealthSnapshot[] {
  return snapshots;
}

export function getHealthSummary() {
  if (snapshots.length === 0) return null;

  const mems = snapshots.map((s) => s.memoryMB);
  const sorted = [...mems].sort((a, b) => a - b);

  return {
    snapshotCount: snapshots.length,
    status: snapshots.every((s) => s.status === "ok") ? "ALL_OK" : "DEGRADED",
    memory: {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: Math.round(mems.reduce((a, b) => a + b, 0) / mems.length),
    },
    redis: {
      connected: snapshots.every((s) => s.redisConnected),
      totalErrors: snapshots[snapshots.length - 1]?.redisErrors || 0,
    },
    peak: {
      positions: Math.max(...snapshots.map((s) => s.openPositions)),
      orders: snapshots[snapshots.length - 1]?.totalOrders || 0,
      requests: snapshots[snapshots.length - 1]?.totalRequests || 0,
    },
  };
}

// Direct execution
if (import.meta.main) {
  startHealthMonitor(5000);
  console.log("Health monitor running. Press Ctrl+C to stop.");
  process.on("SIGINT", () => {
    stopHealthMonitor();
    process.exit(0);
  });
}
