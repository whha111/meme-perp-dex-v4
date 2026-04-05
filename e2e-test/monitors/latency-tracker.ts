/**
 * Latency Tracker — Track and report API response times
 */
import { log } from "../utils/logger";

interface LatencyRecord {
  endpoint: string;
  latencyMs: number;
  timestamp: number;
  success: boolean;
}

class LatencyTracker {
  private records: LatencyRecord[] = [];
  private alertThresholdMs: number;

  constructor(alertThresholdMs = 5000) {
    this.alertThresholdMs = alertThresholdMs;
  }

  async track<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    let success = true;

    try {
      const result = await fn();
      return result;
    } catch (err) {
      success = false;
      throw err;
    } finally {
      const latencyMs = Math.round(performance.now() - start);
      this.records.push({ endpoint, latencyMs, timestamp: Date.now(), success });

      if (latencyMs > this.alertThresholdMs) {
        log.monitor.warn({ endpoint, latencyMs }, "High latency detected");
      }
    }
  }

  getStats(endpoint?: string): {
    count: number;
    p50: number;
    p90: number;
    p99: number;
    avg: number;
    min: number;
    max: number;
    errorRate: string;
  } {
    const filtered = endpoint
      ? this.records.filter(r => r.endpoint === endpoint)
      : this.records;

    if (filtered.length === 0) {
      return { count: 0, p50: 0, p90: 0, p99: 0, avg: 0, min: 0, max: 0, errorRate: "0%" };
    }

    const latencies = filtered.map(r => r.latencyMs).sort((a, b) => a - b);
    const errors = filtered.filter(r => !r.success).length;

    return {
      count: filtered.length,
      p50: latencies[Math.floor(latencies.length * 0.5)],
      p90: latencies[Math.floor(latencies.length * 0.9)],
      p99: latencies[Math.floor(latencies.length * 0.99)],
      avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      min: latencies[0],
      max: latencies[latencies.length - 1],
      errorRate: `${((errors / filtered.length) * 100).toFixed(1)}%`,
    };
  }

  getSummary(): Record<string, ReturnType<LatencyTracker["getStats"]>> {
    const endpoints = [...new Set(this.records.map(r => r.endpoint))];
    const summary: Record<string, ReturnType<LatencyTracker["getStats"]>> = {};
    for (const ep of endpoints) {
      summary[ep] = this.getStats(ep);
    }
    return summary;
  }

  reset(): void {
    this.records = [];
  }
}

// Singleton
export const latencyTracker = new LatencyTracker();
export { LatencyTracker };
