import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetricsCollector } from "../../src/daemon/metrics.js";

// ---------------------------------------------------------------------------
// Unit tests for MetricsCollector
// ---------------------------------------------------------------------------

describe("MetricsCollector", () => {
  let mc: MetricsCollector;

  beforeEach(() => {
    mc = new MetricsCollector();
  });

  afterEach(() => {
    mc.destroy();
  });

  // --- Connection tracking --------------------------------------------------

  describe("connection tracking", () => {
    it("starts with zero active connections", () => {
      expect(mc.activeConnections).toBe(0);
    });

    it("increments on connectionOpen", () => {
      mc.connectionOpen();
      expect(mc.activeConnections).toBe(1);
      mc.connectionOpen();
      expect(mc.activeConnections).toBe(2);
    });

    it("decrements on connectionClose", () => {
      mc.connectionOpen();
      mc.connectionOpen();
      mc.connectionClose();
      expect(mc.activeConnections).toBe(1);
    });

    it("does not go below zero on extra closes", () => {
      mc.connectionClose();
      expect(mc.activeConnections).toBe(0);
    });
  });

  // --- Request counters -----------------------------------------------------

  describe("request counting", () => {
    it("starts with empty request map", () => {
      expect(mc.snapshot().requests).toEqual({});
    });

    it("increments per endpoint", () => {
      mc.incrementRequest("/health");
      mc.incrementRequest("/health");
      mc.incrementRequest("/status");
      const { requests } = mc.snapshot();
      expect(requests["/health"]).toBe(2);
      expect(requests["/status"]).toBe(1);
    });

    it("tracks multiple distinct endpoints independently", () => {
      ["/a", "/b", "/c"].forEach((ep) => mc.incrementRequest(ep));
      const { requests } = mc.snapshot();
      expect(Object.keys(requests)).toHaveLength(3);
    });
  });

  // --- Error counters -------------------------------------------------------

  describe("error counting", () => {
    it("starts with empty error map", () => {
      expect(mc.snapshot().errors).toEqual({});
    });

    it("increments per error code", () => {
      mc.incrementError("TIMEOUT");
      mc.incrementError("TIMEOUT");
      mc.incrementError("INTERNAL_ERROR");
      const { errors } = mc.snapshot();
      expect(errors["TIMEOUT"]).toBe(2);
      expect(errors["INTERNAL_ERROR"]).toBe(1);
    });
  });

  // --- Latency tracking -----------------------------------------------------

  describe("latency tracking", () => {
    it("computes correct min, max and avg for a single sample", () => {
      mc.recordLatency("/api", 100);
      const summary = mc.snapshot().latency["/api"]!;
      expect(summary.min).toBe(100);
      expect(summary.max).toBe(100);
      expect(summary.avg).toBe(100);
      expect(summary.p95).toBe(100);
    });

    it("tracks min and max correctly across multiple samples", () => {
      [50, 200, 100, 300, 10].forEach((ms) => mc.recordLatency("/api", ms));
      const summary = mc.snapshot().latency["/api"]!;
      expect(summary.min).toBe(10);
      expect(summary.max).toBe(300);
    });

    it("computes correct average", () => {
      [100, 200, 300].forEach((ms) => mc.recordLatency("/avg", ms));
      // avg = 600 / 3 = 200
      expect(mc.snapshot().latency["/avg"]!.avg).toBe(200);
    });

    it("p95 is at or above the 95th-percentile sample", () => {
      // 20 samples: 1, 2, ..., 20. p95 index = ceil(0.95 * 20) - 1 = 18 => value 19
      for (let i = 1; i <= 20; i++) mc.recordLatency("/p95", i);
      const { p95 } = mc.snapshot().latency["/p95"]!;
      // Should be sample at 95th percentile — 19 in a sorted [1..20] array
      expect(p95).toBe(19);
    });

    it("handles a single sample for p95", () => {
      mc.recordLatency("/single", 42);
      expect(mc.snapshot().latency["/single"]!.p95).toBe(42);
    });

    it("tracks independent endpoints separately", () => {
      mc.recordLatency("/a", 10);
      mc.recordLatency("/b", 999);
      const { latency } = mc.snapshot();
      expect(latency["/a"]!.max).toBe(10);
      expect(latency["/b"]!.min).toBe(999);
    });

    it("caps sample buffer at 200 entries without errors", () => {
      for (let i = 0; i < 500; i++) mc.recordLatency("/heavy", i);
      // Should not throw and should still produce valid stats
      const summary = mc.snapshot().latency["/heavy"]!;
      expect(summary.count).toBe(500);
      expect(summary.min).toBe(0);
      expect(summary.max).toBe(499);
    });
  });

  // --- Full snapshot --------------------------------------------------------

  describe("snapshot()", () => {
    it("returns all required top-level keys", () => {
      const snap = mc.snapshot();
      expect(snap).toHaveProperty("uptime");
      expect(snap).toHaveProperty("requests");
      expect(snap).toHaveProperty("errors");
      expect(snap).toHaveProperty("latency");
      expect(snap).toHaveProperty("activeConnections");
      expect(snap).toHaveProperty("resources");
    });

    it("uptime is a non-negative number", () => {
      expect(mc.snapshot().uptime).toBeGreaterThanOrEqual(0);
    });

    it("resources contains heap and rss fields", () => {
      const { resources } = mc.snapshot();
      expect(resources).toHaveProperty("heapUsedMB");
      expect(resources).toHaveProperty("heapTotalMB");
      expect(resources).toHaveProperty("rssMB");
      expect(resources).toHaveProperty("eventLoopLagMs");
      // All values should be non-negative numbers
      expect(resources.heapUsedMB).toBeGreaterThanOrEqual(0);
      expect(resources.heapTotalMB).toBeGreaterThanOrEqual(0);
      expect(resources.rssMB).toBeGreaterThanOrEqual(0);
      expect(resources.eventLoopLagMs).toBeGreaterThanOrEqual(0);
    });

    it("activeConnections reflects open/close calls", () => {
      mc.connectionOpen();
      mc.connectionOpen();
      mc.connectionClose();
      expect(mc.snapshot().activeConnections).toBe(1);
    });
  });

  // --- Resource snapshot ----------------------------------------------------

  describe("resourceSnapshot()", () => {
    it("returns numeric MB values from process.memoryUsage()", () => {
      const snap = mc.resourceSnapshot();
      expect(typeof snap.heapUsedMB).toBe("number");
      expect(typeof snap.heapTotalMB).toBe("number");
      expect(typeof snap.rssMB).toBe("number");
      // heapUsed should be less than or equal to heapTotal
      expect(snap.heapUsedMB).toBeLessThanOrEqual(snap.heapTotalMB);
    });
  });

  // --- Resource logging callback --------------------------------------------

  describe("resource logging callback", () => {
    it("calls the provided logger function with a message string", () => {
      vi.useFakeTimers();
      const logs: string[] = [];
      const logged = new MetricsCollector((msg) => logs.push(msg));

      // Advance time by 60 seconds to trigger the periodic log
      vi.advanceTimersByTime(60_000);

      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0]).toMatch(/\[metrics\]/);
      expect(logs[0]).toMatch(/heap=/);

      logged.destroy();
      vi.useRealTimers();
    });
  });

  // --- Destroy --------------------------------------------------------------

  describe("destroy()", () => {
    it("can be called multiple times without error", () => {
      expect(() => {
        mc.destroy();
        mc.destroy();
      }).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: /metrics HTTP endpoint via the full daemon server
// ---------------------------------------------------------------------------

import { describe as describeServer, it as itServer, expect as expectServer, beforeEach as bEach, afterEach as aEach } from "vitest";
import { createServer } from "http";
import { mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { createDaemonServer } from "../../src/daemon/server.js";

const TEST_DATA_DIR = resolve(import.meta.dirname, "..", ".test-data-metrics");

function makeConfig(port: number): Record<string, unknown> {
  return {
    projectRoot: "/tmp/test-metrics",
    dataDir: TEST_DATA_DIR,
    embeddingProvider: "keyword",
    embeddingModel: "",
    embeddingDimensions: 0,
    ollamaUrl: "",
    extensions: [".ts"],
    ignorePatterns: [],
    maxFileSize: 100000,
    batchSize: 32,
    contextBudget: 8000,
    sessionBudget: 2000,
    searchWeights: { vector: 0, keyword: 0.7, recency: 0.3 },
    rrfK: 60,
    graphExpansion: false,
    graphDiscountFactor: 0.6,
    siblingExpansion: false,
    siblingDiscountFactor: 0.4,
    reranking: false,
    rerankingModel: "",
    rerankTopK: 25,
    codeBoostFactor: 1.5,
    testPenaltyFactor: 0.3,
    anonymousPenaltyFactor: 0.5,
    debounceMs: 2000,
    port,
    implementationPaths: ["src/", "lib/", "bin/"],
    factExtractors: [],
  };
}

function makeSearch(): Record<string, unknown> {
  return {
    search: async () => [],
    searchWithContext: async () => ({ text: "", tokenCount: 0, chunks: [] }),
    findCallers: () => [],
    findCallees: () => [],
    updateStores: () => {},
  };
}

function makeMetadata(): Record<string, unknown> {
  return {
    getStats: () => ({ totalFiles: 0, totalChunks: 0, languages: {} }),
    getStat: () => undefined,
    setStat: () => {},
    recordLatency: () => {},
    getConventions: () => null,
    getLatencyPercentiles: () => ({ avg: 0, p50: 0, p95: 0, count: 0 }),
    close: () => {},
  };
}

async function httpGet(
  port: number,
  path: string,
  authToken?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { default: http } = await import("http");
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch {
            reject(new Error("Failed to parse JSON response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describeServer("/metrics HTTP endpoint", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let token: string;

  bEach(async () => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    port = await new Promise<number>((res) => {
      const tmp = createServer();
      tmp.listen(0, "127.0.0.1", () => {
        const addr = tmp.address() as { port: number };
        tmp.close(() => res(addr.port));
      });
    });
    const result = createDaemonServer(
      makeConfig(port) as never,
      makeSearch() as never,
      makeMetadata() as never
    );
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));
  });

  aEach(async () => {
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  itServer("GET /metrics returns 401 without auth", async () => {
    const { status } = await httpGet(port, "/metrics");
    expectServer(status).toBe(401);
  });

  itServer("GET /metrics returns the expected top-level shape", async () => {
    const { body } = await httpGet(port, "/metrics", token);
    expectServer(body).toHaveProperty("uptime");
    expectServer(body).toHaveProperty("requests");
    expectServer(body).toHaveProperty("errors");
    expectServer(body).toHaveProperty("latency");
    expectServer(body).toHaveProperty("activeConnections");
    expectServer(body).toHaveProperty("resources");
  });

  itServer("GET /metrics records itself in request counts after first call", async () => {
    // First call — may or may not be recorded depending on ordering
    await httpGet(port, "/metrics", token);
    // Second call — the first call's count should now be visible
    const { body } = await httpGet(port, "/metrics", token);
    const requests = body["requests"] as Record<string, number>;
    expectServer(requests["/metrics"]).toBeGreaterThanOrEqual(1);
  });

  itServer("GET /metrics reflects /health request count", async () => {
    await httpGet(port, "/health");
    await httpGet(port, "/health");
    const { body } = await httpGet(port, "/metrics", token);
    const requests = body["requests"] as Record<string, number>;
    expectServer(requests["/health"]).toBeGreaterThanOrEqual(2);
  });

  itServer("resources fields are non-negative numbers", async () => {
    const { body } = await httpGet(port, "/metrics", token);
    const resources = body["resources"] as Record<string, number>;
    expectServer(resources["heapUsedMB"]).toBeGreaterThanOrEqual(0);
    expectServer(resources["heapTotalMB"]).toBeGreaterThanOrEqual(0);
    expectServer(resources["rssMB"]).toBeGreaterThanOrEqual(0);
    expectServer(resources["eventLoopLagMs"]).toBeGreaterThanOrEqual(0);
  });
});
