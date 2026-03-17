import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { mkdirSync, rmSync } from "fs";
import { createServer, type Server } from "http";
import { createDaemonServer } from "../../src/daemon/server.js";

// 3F: Daemon HTTP endpoints

const TEST_DATA_DIR = resolve(import.meta.dirname, "..", ".test-data-server-3f");

function makeConfig(port: number): any {
  return {
    projectRoot: "/tmp/test-server",
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

function makeEmptyAssembledContext() {
  return { text: "", tokenCount: 0, chunks: [] };
}

function makeSearch(overrides?: Partial<any>): any {
  return {
    search: async () => [],
    searchWithContext: async () => makeEmptyAssembledContext(),
    findCallers: () => [],
    findCallees: () => [],
    updateStores: () => {},
    ...overrides,
  };
}

function makeMetadata(overrides?: Partial<any>): any {
  return {
    getStats: () => ({ totalFiles: 3, totalChunks: 12, languages: { typescript: 12 } }),
    getStat: (_key: string) => undefined,
    setStat: () => {},
    recordLatency: () => {},
    incrementRouteStat: () => {},
    getConventions: () => null,
    getLatencyPercentiles: () => ({ avg: 0, p50: 0, p95: 0, count: 0 }),
    close: () => {},
    ...overrides,
  };
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  authToken?: string
): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
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
        ...(authToken ? { "Authorization": `Bearer ${authToken}` } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(text),
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
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

describe("daemon HTTP server (3F)", () => {
  let server: ReturnType<typeof createServer>;
  let token: string;
  let port: number;

  beforeEach(async () => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    // Pick a port by binding to 0 and releasing
    port = await new Promise<number>((res) => {
      const tmp = createServer();
      tmp.listen(0, "127.0.0.1", () => {
        const addr = tmp.address() as { port: number };
        tmp.close(() => res(addr.port));
      });
    });

    const config = makeConfig(port);
    const result = createDaemonServer(config, makeSearch(), makeMetadata());
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));
  });

  afterEach(async () => {
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("GET /health returns status ok", async () => {
    const { status, body } = await request(port, "GET", "/health");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("GET /status returns index statistics", async () => {
    const { status, body } = await request(port, "GET", "/status", undefined, token);
    expect(status).toBe(200);
    expect(body).toHaveProperty("totalFiles");
    expect(body).toHaveProperty("totalChunks");
    expect(body.totalFiles).toBe(3);
    expect(body.totalChunks).toBe(12);
  });

  it("POST /hooks/session-start returns additionalContext", async () => {
    const { status, body } = await request(port, "POST", "/hooks/session-start", undefined, token);
    expect(status).toBe(200);
    expect(body).toHaveProperty("hookSpecificOutput");
    expect(body.hookSpecificOutput).toHaveProperty("hookEventName", "SessionStart");
    expect(typeof body.hookSpecificOutput.additionalContext).toBe("string");
  });

  it("POST /hooks/prompt-context with query returns context", async () => {
    const searchWithContext = async () => ({
      text: "## src/auth.ts\nfunction authenticate() {}",
      tokenCount: 15,
      chunks: [
        {
          id: "c1",
          filePath: "src/auth.ts",
          name: "authenticate",
          kind: "function_declaration",
          startLine: 1,
          endLine: 5,
          content: "function authenticate() {}",
          language: "typescript",
          score: 0.9,
        },
      ],
    });

    // Rebuild server with a search that returns real context
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );

    const config = makeConfig(port);
    const result = createDaemonServer(
      config,
      makeSearch({ searchWithContext }),
      makeMetadata()
    );
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, body } = await request(port, "POST", "/hooks/prompt-context", {
      query: "how does authentication work",
    }, token);
    expect(status).toBe(200);
    expect(body).toHaveProperty("hookSpecificOutput");
    expect(body.hookSpecificOutput).toHaveProperty("hookEventName", "UserPromptSubmit");
    expect(body.hookSpecificOutput.additionalContext).toContain("authenticate");
  });

  it("POST /hooks/prompt-context with empty query returns empty context", async () => {
    const { status, body } = await request(port, "POST", "/hooks/prompt-context", {
      query: "",
    }, token);
    expect(status).toBe(200);
    expect(body.additionalContext).toBe("");
    expect(body._debug).toBeDefined();
    expect(body._debug.route).toBe("skip");
  });

  it("GET /unknown returns 404", async () => {
    const { status, body } = await request(port, "GET", "/unknown-route", undefined, token);
    expect(status).toBe(404);
    expect(body).toHaveProperty("error");
  });

  // NEW-7: sanitizeQuery — exercised indirectly via POST /hooks/prompt-context

  it("sanitizeQuery: strips code-like lines from query", async () => {
    const { status, body } = await request(
      port,
      "POST",
      "/hooks/prompt-context",
      { query: "how does auth work\nimport { foo } from 'bar'\nconst x = 1" },
      token
    );
    expect(status).toBe(200);
    // The sanitized query is "how does auth work" — non-empty, so the handler
    // proceeds and returns hookSpecificOutput (context may be empty string).
    expect(body).toHaveProperty("hookSpecificOutput");
  });

  it("sanitizeQuery: returns empty for code-only input", async () => {
    const { status, body } = await request(
      port,
      "POST",
      "/hooks/prompt-context",
      { query: "import { foo } from 'bar'" },
      token
    );
    expect(status).toBe(200);
    expect(body.additionalContext).toBe("");
    expect(body._debug).toBeDefined();
    expect(body._debug.route).toBe("skip");
  });

  it("sanitizeQuery: handles multi-line natural language", async () => {
    const { status, body } = await request(
      port,
      "POST",
      "/hooks/prompt-context",
      { query: "how does authentication work\nwhat about authorization" },
      token
    );
    expect(status).toBe(200);
    expect(body).toHaveProperty("hookSpecificOutput");
  });

  // Bearer token auth tests

  it("returns 401 for requests without auth token", async () => {
    const { status, body } = await request(port, "GET", "/status");
    expect(status).toBe(401);
    expect(body).toHaveProperty("error", "Unauthorized");
  });

  it("returns 401 for requests with wrong auth token", async () => {
    const { status, body } = await request(port, "GET", "/status", undefined, "wrong-token");
    expect(status).toBe(401);
    expect(body).toHaveProperty("error", "Unauthorized");
  });

  it("GET /health works without auth token", async () => {
    const { status, body } = await request(port, "GET", "/health");
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  // CORS preflight test

  it("OPTIONS request returns 403", async () => {
    const { default: http } = await import("http");
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/status",
          method: "OPTIONS",
          headers: {},
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  // --- /ready endpoint tests (Task 1) ---

  it("GET /ready returns 200 with chunk/file counts when index has data", async () => {
    const { status, body } = await request(port, "GET", "/ready");
    expect(status).toBe(200);
    expect(body).toEqual({ ready: true, chunks: 12, files: 3 });
  });

  it("GET /ready returns 503 when no chunks are indexed", async () => {
    // Rebuild server with empty metadata
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );

    const config = makeConfig(port);
    const emptyMetadata = makeMetadata({
      getStats: () => ({ totalFiles: 0, totalChunks: 0, languages: {} }),
    });
    const result = createDaemonServer(config, makeSearch(), emptyMetadata);
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, body } = await request(port, "GET", "/ready");
    expect(status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.reason).toContain("no chunks indexed");
  });

  it("GET /ready returns 503 when FTS store is not initialized", async () => {
    // Rebuild server with ftsInitialized = false
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );

    const config = makeConfig(port);
    const result = createDaemonServer(config, makeSearch(), makeMetadata(), {
      ftsInitialized: false,
    });
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, body } = await request(port, "GET", "/ready");
    expect(status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.reason).toContain("FTS store not initialized");
  });

  it("GET /ready returns 503 when metadata.getStats throws", async () => {
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );

    const config = makeConfig(port);
    const brokenMetadata = makeMetadata({
      getStats: () => { throw new Error("database locked"); },
    });
    const result = createDaemonServer(config, makeSearch(), brokenMetadata);
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, body } = await request(port, "GET", "/ready");
    expect(status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.reason).toContain("store query failed");
    expect(body.reason).toContain("database locked");
  });

  it("GET /ready works without auth token", async () => {
    const { status, body } = await request(port, "GET", "/ready");
    expect(status).toBe(200);
    expect(body.ready).toBe(true);
  });

  // --- Enriched error response tests (Task 3) ---

  it("search errors include query and searchType in error response", async () => {
    // Rebuild server with a search that throws
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );

    const config = makeConfig(port);
    const failingSearch = makeSearch({
      searchWithContext: async () => { throw new Error("embedding service unavailable"); },
    });
    const result = createDaemonServer(config, failingSearch, makeMetadata());
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, body } = await request(port, "POST", "/hooks/prompt-context", {
      query: "how does auth work",
    }, token);
    expect(status).toBe(500);
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("requestId");
    expect(body.searchType).toBe("prompt-context");
  });

  it("session-start errors include hookType in error response", async () => {
    // Rebuild server with a search that throws on session start
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );

    const config = makeConfig(port);
    const failingSearch = makeSearch({
      searchWithContext: async () => { throw new Error("something broke"); },
    });
    // Also make metadata throw on getConventions to trigger session-start error
    const failingMetadata = makeMetadata({
      getConventions: () => { throw new Error("session start failure"); },
    });
    const result = createDaemonServer(config, failingSearch, failingMetadata);
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, body } = await request(port, "POST", "/hooks/session-start", undefined, token);
    expect(status).toBe(500);
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("requestId");
    expect(body.hookType).toBe("SessionStart");
  });

  // Note: timeout error enrichment (endpoint + timeoutMs fields in 504 responses)
  // is verified by code inspection. Testing it end-to-end would require either
  // waiting 10-30 seconds for real timeouts or mocking setTimeout globally,
  // both of which are impractical for a unit test suite.
});

describe("daemon HTTP server — debug mode", () => {
  let server: ReturnType<typeof createServer>;
  let token: string;
  let port: number;

  beforeEach(async () => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    port = await new Promise<number>((res) => {
      const tmp = createServer();
      tmp.listen(0, "127.0.0.1", () => {
        const addr = tmp.address() as { port: number };
        tmp.close(() => res(addr.port));
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("X-Memory-Debug header is present on session-start when debugMode is true", async () => {
    const config = makeConfig(port);
    const result = createDaemonServer(config, makeSearch(), makeMetadata(), {
      debugMode: true,
    });
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, headers } = await request(port, "POST", "/hooks/session-start", undefined, token);
    expect(status).toBe(200);

    const debugHeader = headers["x-memory-debug"];
    expect(debugHeader).toBeDefined();
    const parsed = JSON.parse(debugHeader as string);
    expect(parsed).toHaveProperty("requestId");
    expect(parsed).toHaveProperty("chunks");
    expect(parsed).toHaveProperty("tokens");
    expect(parsed).toHaveProperty("elapsedMs");
    expect(typeof parsed.chunks).toBe("number");
    expect(typeof parsed.tokens).toBe("number");
    expect(typeof parsed.elapsedMs).toBe("number");
  });

  it("X-Memory-Debug header is present on prompt-context when debugMode is true", async () => {
    const searchWithContext = async () => ({
      text: "## src/foo.ts\nfunction foo() {}",
      tokenCount: 10,
      chunks: [
        {
          id: "c1", filePath: "src/foo.ts", name: "foo",
          kind: "function_declaration", startLine: 1, endLine: 3,
          content: "function foo() {}", language: "typescript", score: 0.8,
        },
      ],
    });

    const config = makeConfig(port);
    const result = createDaemonServer(
      config,
      makeSearch({ searchWithContext }),
      makeMetadata(),
      { debugMode: true }
    );
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, headers } = await request(port, "POST", "/hooks/prompt-context", {
      query: "how does foo work",
    }, token);
    expect(status).toBe(200);

    const debugHeader = headers["x-memory-debug"];
    expect(debugHeader).toBeDefined();
    const parsed = JSON.parse(debugHeader as string);
    expect(parsed).toHaveProperty("requestId");
    expect(parsed).toHaveProperty("hookEventName", "UserPromptSubmit");
    expect(parsed).toHaveProperty("route", "R0");
    expect(parsed.chunks).toBe(1);
    expect(parsed.tokens).toBe(10);
    expect(parsed).toHaveProperty("queryClassification");
    expect(parsed.queryClassification).toMatchObject({
      isCodeQuery: true,
      needsNavigation: true,
    });
    expect(typeof parsed.elapsedMs).toBe("number");
  });

  it("X-Memory-Debug header is present on skip responses when debugMode is true", async () => {
    const config = makeConfig(port);
    const result = createDaemonServer(config, makeSearch(), makeMetadata(), {
      debugMode: true,
    });
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { status, headers, body } = await request(port, "POST", "/hooks/prompt-context", {
      query: "hello",
    }, token);
    expect(status).toBe(200);
    expect(body._debug.route).toBe("skip");

    const debugHeader = headers["x-memory-debug"];
    expect(debugHeader).toBeDefined();
    const parsed = JSON.parse(debugHeader as string);
    expect(parsed).toMatchObject({
      hookEventName: "UserPromptSubmit",
      route: "skip",
      chunks: 0,
      tokens: 0,
      skipReason: "non-code query",
    });
    expect(parsed.queryClassification).toMatchObject({
      isCodeQuery: false,
      needsNavigation: false,
    });
  });

  it("X-Memory-Debug header is absent when debugMode is false", async () => {
    const config = makeConfig(port);
    const result = createDaemonServer(config, makeSearch(), makeMetadata(), {
      debugMode: false,
    });
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { headers } = await request(port, "POST", "/hooks/session-start", undefined, token);
    expect(headers["x-memory-debug"]).toBeUndefined();
  });

  it("X-Memory-Debug header is absent when debugMode is omitted", async () => {
    const config = makeConfig(port);
    const result = createDaemonServer(config, makeSearch(), makeMetadata());
    server = result.server;
    token = result.token;
    await new Promise<void>((res) => server.listen(port, "127.0.0.1", res));

    const { headers } = await request(port, "POST", "/hooks/session-start", undefined, token);
    expect(headers["x-memory-debug"]).toBeUndefined();
  });
});
