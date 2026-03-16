import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { mkdirSync, rmSync } from "fs";
import { createServer } from "http";
import { createDaemonServer, resetRateLimitMap } from "../../src/daemon/server.js";

// Tests for Task 2 (HTTP rate limiting) and Task 3 (readBody disconnect fix).

const TEST_DATA_DIR = resolve(import.meta.dirname, "..", ".test-data-rate-limit");

function makeConfig(port: number): any {
  return {
    projectRoot: "/tmp/test-rate-limit",
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

function makeSearch(): any {
  return {
    search: async () => [],
    searchWithContext: async () => ({ text: "", tokenCount: 0, chunks: [] }),
    findCallers: () => [],
    findCallees: () => [],
    updateStores: () => {},
  };
}

function makeMetadata(): any {
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

async function pickPort(): Promise<number> {
  return new Promise<number>((res) => {
    const tmp = createServer();
    tmp.listen(0, "127.0.0.1", () => {
      const addr = tmp.address() as { port: number };
      tmp.close(() => res(addr.port));
    });
  });
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  authToken?: string
): Promise<{ status: number; body: any }> {
  const { default: http } = await import("http");
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? JSON.stringify(body) : undefined;
    const options = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          reject(new Error("Failed to parse response JSON"));
        }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Rate limiting tests
// ---------------------------------------------------------------------------

describe("HTTP rate limiting", () => {
  let server: ReturnType<typeof createServer>;
  let token: string;
  let port: number;

  beforeEach(async () => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    resetRateLimitMap();
    port = await pickPort();
    const result = createDaemonServer(makeConfig(port), makeSearch(), makeMetadata());
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));
  });

  afterEach(async () => {
    await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    resetRateLimitMap();
  });

  it("allows requests below the rate limit threshold", async () => {
    // Send 5 requests — all should succeed (401 is fine, the point is not 429)
    for (let i = 0; i < 5; i++) {
      const { status } = await request(port, "GET", "/status");
      expect(status).not.toBe(429);
    }
  });

  it("returns 429 after exceeding 100 requests per 10 seconds", async () => {
    // Send 100 requests to exhaust the window, then verify the 101st is blocked.
    // All will be 401 (no auth token), but that is fine — the limiter runs before auth.
    for (let i = 0; i < 100; i++) {
      await request(port, "GET", "/status");
    }

    const { status, body } = await request(port, "GET", "/status");
    expect(status).toBe(429);
    expect(body).toHaveProperty("code", "RATE_LIMITED");
    expect(body).toHaveProperty("retryAfterMs");
  });

  it("does NOT rate-limit the /health endpoint", async () => {
    // Exhaust the rate limit via /status calls
    for (let i = 0; i < 100; i++) {
      await request(port, "GET", "/status");
    }

    // /health must still work regardless
    const { status, body } = await request(port, "GET", "/health");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("resetRateLimitMap() clears state between tests", async () => {
    // Exhaust then reset
    for (let i = 0; i < 100; i++) {
      await request(port, "GET", "/status");
    }
    resetRateLimitMap();

    // Should be allowed again
    const { status } = await request(port, "GET", "/status");
    expect(status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// readBody disconnect test
// ---------------------------------------------------------------------------

describe("readBody client disconnect", () => {
  let server: ReturnType<typeof createServer>;
  let token: string;
  let port: number;

  beforeEach(async () => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    resetRateLimitMap();
    port = await pickPort();
    const result = createDaemonServer(makeConfig(port), makeSearch(), makeMetadata());
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));
  });

  afterEach(async () => {
    await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    resetRateLimitMap();
  });

  it("server stays alive after a client disconnects mid-request", async () => {
    const { default: http } = await import("http");

    // Open a connection to /hooks/prompt-context but destroy it before sending body.
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/hooks/prompt-context",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            // Do NOT set Content-Length so the server will keep reading.
          },
        },
        () => {}
      );
      req.on("error", () => {
        // Expected: the socket was destroyed intentionally
        resolve();
      });
      // Write partial data then destroy the socket immediately
      req.write('{"query": "partial');
      req.destroy();
      // Give the server a moment to process the close event
      setTimeout(resolve, 100);
    });

    // Server must still respond to a normal /health request after the disconnect
    const { status } = await request(port, "GET", "/health");
    expect(status).toBe(200);
  });
});
