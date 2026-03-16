import { monitorEventLoopDelay, type IntervalHistogram } from "perf_hooks";

// ---------------------------------------------------------------------------
// MetricsCollector — lightweight, zero-dependency observability
//
// Tracks per-endpoint request counts, error codes, latency distributions
// (min / max / sum / count + a FIFO ring buffer for p95), and the
// current number of in-flight connections.  All operations are synchronous
// and O(1) amortised — the ring buffer is capped at MAX_LATENCY_SAMPLES.
// ---------------------------------------------------------------------------

const MAX_LATENCY_SAMPLES = 200; // cap memory usage
const RESOURCE_LOG_INTERVAL_MS = 60_000;

export interface LatencySummary {
  avg: number;
  p95: number;
  min: number;
  max: number;
  count: number;
}

export interface EndpointLatency {
  min: number;
  max: number;
  sum: number;
  count: number;
  /** FIFO ring buffer for percentile computation. */
  ring: number[];
  ringIndex: number;
}

export interface MetricsSnapshot {
  uptime: number;
  requests: Record<string, number>;
  errors: Record<string, number>;
  latency: Record<string, LatencySummary>;
  activeConnections: number;
  resources: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    eventLoopLagMs: number;
  };
}

export class MetricsCollector {
  private readonly startTime = Date.now();
  private readonly requestCounts = new Map<string, number>();
  private readonly errorCounts = new Map<string, number>();
  private readonly latencyData = new Map<string, EndpointLatency>();
  private _activeConnections = 0;

  // Event-loop delay monitoring (Node.js built-in, no external deps)
  private readonly elHistogram: IntervalHistogram | null;
  private readonly resourceTimer: NodeJS.Timeout;

  constructor(logResource?: (msg: string) => void) {
    // monitorEventLoopDelay is available in Node >= 11.10
    let histogram: IntervalHistogram | null = null;
    try {
      histogram = monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
    } catch {
      // Silently skip if unavailable in the current runtime
      histogram = null;
    }
    this.elHistogram = histogram;

    // Periodic resource logging (every 60 s, unref'd so it never blocks exit)
    this.resourceTimer = setInterval(() => {
      const snap = this.resourceSnapshot();
      const msg =
        `[metrics] heap=${snap.heapUsedMB}/${snap.heapTotalMB} MB ` +
        `rss=${snap.rssMB} MB ` +
        `eventLoopLag=${snap.eventLoopLagMs} ms`;
      if (logResource) {
        logResource(msg);
      }
    }, RESOURCE_LOG_INTERVAL_MS).unref();
  }

  // --- Connection tracking --------------------------------------------------

  connectionOpen(): void {
    this._activeConnections++;
  }

  connectionClose(): void {
    if (this._activeConnections > 0) this._activeConnections--;
  }

  get activeConnections(): number {
    return this._activeConnections;
  }

  // --- Request counters -----------------------------------------------------

  incrementRequest(endpoint: string): void {
    this.requestCounts.set(endpoint, (this.requestCounts.get(endpoint) ?? 0) + 1);
  }

  incrementError(code: string): void {
    this.errorCounts.set(code, (this.errorCounts.get(code) ?? 0) + 1);
  }

  // --- Latency tracking -----------------------------------------------------

  recordLatency(endpoint: string, ms: number): void {
    let data = this.latencyData.get(endpoint);
    if (!data) {
      data = { min: ms, max: ms, sum: 0, count: 0, ring: [], ringIndex: 0 };
      this.latencyData.set(endpoint, data);
    }

    data.sum += ms;
    data.count++;
    if (ms < data.min) data.min = ms;
    if (ms > data.max) data.max = ms;

    // FIFO ring buffer: overwrite oldest entry when full
    if (data.ring.length < MAX_LATENCY_SAMPLES) {
      data.ring.push(ms);
    } else {
      data.ring[data.ringIndex] = ms;
    }
    data.ringIndex = (data.ringIndex + 1) % MAX_LATENCY_SAMPLES;
  }

  private _summarise(data: EndpointLatency): LatencySummary {
    const avg = data.count > 0 ? Math.round(data.sum / data.count) : 0;
    let p95 = 0;
    if (data.ring.length > 0) {
      const sorted = [...data.ring].sort((a, b) => a - b);
      const idx = Math.ceil(0.95 * sorted.length) - 1;
      p95 = sorted[Math.max(0, idx)] ?? 0;
    }
    return { avg, p95, min: data.min, max: data.max, count: data.count };
  }

  // --- Resource snapshot ----------------------------------------------------

  resourceSnapshot(): MetricsSnapshot["resources"] {
    const mem = process.memoryUsage();
    const toMB = (bytes: number) => Math.round(bytes / 1024 / 1024);
    let eventLoopLagMs = 0;
    if (this.elHistogram) {
      // mean delay in nanoseconds → milliseconds. Guard against NaN which
      // occurs before the histogram has recorded any samples.
      const meanNs = this.elHistogram.mean;
      if (!isNaN(meanNs)) {
        eventLoopLagMs = Math.round(meanNs / 1e6);
      }
    }
    return {
      heapUsedMB: toMB(mem.heapUsed),
      heapTotalMB: toMB(mem.heapTotal),
      rssMB: toMB(mem.rss),
      eventLoopLagMs,
    };
  }

  // --- Full snapshot ---------------------------------------------------------

  snapshot(): MetricsSnapshot {
    const requests: Record<string, number> = {};
    for (const [k, v] of this.requestCounts) requests[k] = v;

    const errors: Record<string, number> = {};
    for (const [k, v] of this.errorCounts) errors[k] = v;

    const latency: Record<string, LatencySummary> = {};
    for (const [k, v] of this.latencyData) latency[k] = this._summarise(v);

    return {
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      requests,
      errors,
      latency,
      activeConnections: this._activeConnections,
      resources: this.resourceSnapshot(),
    };
  }

  // --- Lifecycle ------------------------------------------------------------

  destroy(): void {
    clearInterval(this.resourceTimer);
    this.elHistogram?.disable();
  }
}
