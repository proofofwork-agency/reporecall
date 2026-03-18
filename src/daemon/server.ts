import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { MemoryConfig } from "../core/config.js";
import type { HybridSearch } from "../search/hybrid.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { handleSessionStart } from "../hooks/session-start.js";
import { handlePromptContextDetailed } from "../hooks/prompt-context.js";
import { classifyIntent, deriveRoute } from "../search/intent.js";
import { getLogger } from "../core/logger.js";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { RotatingLog } from "./rotating-log.js";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { MetricsCollector } from "./metrics.js";
import type { HookDebugRecord } from "../search/types.js";

// --- Rate limiter -----------------------------------------------------------
// Sliding-window, in-memory, per client IP. No external dependencies.

const RATE_LIMIT_WINDOW_MS = 10_000; // 10 seconds
const RATE_LIMIT_MAX_REQUESTS = 100;
const PROBE_RATE_LIMIT_MAX_REQUESTS = 1000; // generous limit for /health, /metrics, /ready
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;

interface RateEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateEntry>();

// Periodic cleanup of stale entries so the Map does not grow unboundedly.
// The return value is intentionally discarded; .unref() ensures the timer
// never prevents the process from exiting.
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, entry] of rateLimitMap) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS).unref();

export function resetRateLimitMap(): void {
  rateLimitMap.clear();
}

function checkRateLimit(ip: string, maxRequests: number = RATE_LIMIT_MAX_REQUESTS): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let entry = rateLimitMap.get(ip);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitMap.set(ip, entry);
  }
  // Evict timestamps outside the sliding window
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
  if (entry.timestamps.length >= maxRequests) {
    return false; // rate limit exceeded
  }
  entry.timestamps.push(now);
  return true;
}

// ---------------------------------------------------------------------------

// Pattern matching lines that look like code rather than natural language.
// Covers: imports, declarations, control flow, common language constructs,
// comments, and block openers.
const CODE_LINE_RE =
  /^(import |from |const |let |var |function |class |def |return |export |await |async |if\s*\(|if\b.+:|elif\b.+:|else:|for\s*\(|for\b.+:|while\s*\(|while\b.+:|switch\s*\(|try\s*\{|try:|catch\s*\(|except\b.+:|with\b.+:|#!|\/\/|\/\*|#include|#define|package |using |\{|\[|<\?|<%)/;

const ASSIGNMENT_LINE_RE =
  /^[A-Za-z_][A-Za-z0-9_.]*\s*=\s*.+$/;

const CALLISH_LINE_RE =
  /^(?:\([^)]*\)|[^\s(][^\s]*)\s*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\([^)]*\)\s*$/;

function looksLikeCodeLine(trimmed: string): boolean {
  if (CODE_LINE_RE.test(trimmed)) return true;
  if (ASSIGNMENT_LINE_RE.test(trimmed)) return true;
  if (CALLISH_LINE_RE.test(trimmed)) return true;

  const codePunctuation = (trimmed.match(/[=()[\]{};]|=>|->|::/g) ?? []).length;
  if (
    codePunctuation >= 3 &&
    /[./'"\\[\]{}]/.test(trimmed)
  ) {
    return true;
  }

  return false;
}

export function sanitizeQuery(raw: string): string {
  // 1. Strip backtick-fenced code blocks (``` ... ```) which may contain
  //    multi-line code embedded in an otherwise natural-language prompt.
  //    This handles both ```lang\n...\n``` and bare ```\n...\n```.
  const withoutFencedBlocks = raw.replace(/```[\s\S]*?```/g, " ");

  // 2. Strip inline code spans (`...`) that may contain code fragments
  const withoutInlineCode = withoutFencedBlocks.replace(/`[^`]*`/g, " ");

  // 3. Process line-by-line, SKIPPING (not breaking at) code-like lines.
  //    The old implementation used `break` which meant code on line 2 would
  //    discard valid natural language on line 3+. Now we skip individual
  //    code lines so NL lines after code are still collected.
  const lines = withoutInlineCode.split("\n");
  const cleanLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip lines that look like code
    if (looksLikeCodeLine(trimmed)) continue;
    // Skip lines that are mostly non-alphanumeric (likely code/symbols)
    const alphaCount = (trimmed.match(/[a-zA-Z]/g) ?? []).length;
    if (trimmed.length > 4 && alphaCount / trimmed.length < 0.3) continue;
    cleanLines.push(trimmed);
  }

  return cleanLines.join(" ").slice(0, 500).trim();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function succeed(body: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(body);
    }

    function onData(chunk: Buffer): void {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        fail(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      succeed(Buffer.concat(chunks).toString());
    }

    function onError(err: Error): void {
      fail(err);
    }

    function onClose(): void {
      fail(new Error("Client disconnected before body was fully received"));
    }

    function cleanup(): void {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
      req.off("aborted", onClose);
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
    req.on("aborted", onClose);
  });
}

function withTimeout(
  handler: (signal: AbortSignal) => Promise<void>,
  res: ServerResponse,
  timeoutMs: number,
  endpoint?: string
): Promise<void> {
  const abortController = new AbortController();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortController.abort();
      if (!res.writableEnded) {
        json(res, { error: "Request timeout", code: "TIMEOUT", endpoint, timeoutMs }, 504);
      }
      resolve();
    }, timeoutMs);

    handler(abortController.signal)
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

export interface DaemonServerOptions {
  ftsInitialized?: boolean;
  debugMode?: boolean;
  ftsStore?: import("../storage/fts-store.js").FTSStore;
}

export function createDaemonServer(
  config: MemoryConfig,
  search: HybridSearch,
  metadata: MetadataStore,
  options?: DaemonServerOptions
): { server: ReturnType<typeof createServer>; token: string; metrics: MetricsCollector } {
  // Keep a live reference to the options object so that getter properties
  // (e.g. ftsInitialized, ftsStore) are re-evaluated on each access rather
  // than captured as a snapshot at construction time.  This allows callers in
  // serve.ts to use object getter accessors to reflect post-startup state
  // changes (e.g. FTS becoming available after a recovery re-index).
  const liveOptions = options ?? {};
  const debugMode = options?.debugMode ?? false;
  const log = getLogger();
  const hookLogDir = resolve(config.dataDir, "logs");
  mkdirSync(hookLogDir, { recursive: true });
  const hookLogPath = resolve(hookLogDir, "hooks.log");

  // Generate a random bearer token for authenticating requests
  const token = randomBytes(32).toString("hex");
  const tokenPath = resolve(config.dataDir, "daemon.token");
  writeFileSync(tokenPath, token, { mode: 0o600 });

  // Metrics collector — shared across all request handlers for this server
  // instance. Periodically logs resource usage to the daemon logger.
  const metrics = new MetricsCollector((msg) => log.info(msg));

  const hookLog = new RotatingLog(hookLogPath);
  function logHook(message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    hookLog.append(`[${timestamp}] ${message}\n`).catch(() => {});
  }

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
    const endpoint = url.pathname;

    // Track active connections for the lifetime of this request
    metrics.connectionOpen();
    res.on("close", () => metrics.connectionClose());

    const requestStart = Date.now();

    try {
      // Reject CORS preflight requests
      if (req.method === "OPTIONS") {
        res.writeHead(403, {
          "X-Content-Type-Options": "nosniff",
        });
        res.end();
        return;
      }

      // Probe endpoints rate limiting (generous limit, no auth required)
      const isProbeEndpoint =
        req.method === "GET" &&
        (endpoint === "/health" || endpoint === "/ready");
      if (isProbeEndpoint) {
        const probeIp = req.socket.remoteAddress ?? "unknown";
        if (!checkRateLimit(probeIp, PROBE_RATE_LIMIT_MAX_REQUESTS)) {
          metrics.incrementError("RATE_LIMITED");
          json(
            res,
            { error: "Too many requests", code: "RATE_LIMITED", retryAfterMs: RATE_LIMIT_WINDOW_MS },
            429
          );
          return;
        }
      }

      // Health check (no auth required)
      if (req.method === "GET" && endpoint === "/health") {
        metrics.incrementRequest(endpoint);
        await withTimeout(async (_signal) => {
          json(res, { status: "ok" });
        }, res, 10000, "/health");
        metrics.recordLatency(endpoint, Date.now() - requestStart);
        return;
      }

      // Readiness check (no auth required)
      if (req.method === "GET" && endpoint === "/ready") {
        metrics.incrementRequest(endpoint);
        await withTimeout(async (_signal) => {
          try {
            const stats = metadata.getStats();
            const hasChunks = stats.totalChunks > 0;
            const storesReady = liveOptions.ftsInitialized ?? true;

            log.debug({ ready: hasChunks && storesReady, chunks: stats.totalChunks, ftsInitialized: storesReady }, "readiness check");

            if (hasChunks && storesReady) {
              json(res, {
                ready: true,
                chunks: stats.totalChunks,
                files: stats.totalFiles,
              });
            } else {
              const reasons: string[] = [];
              if (!hasChunks) reasons.push("no chunks indexed");
              if (!storesReady) reasons.push("FTS store not initialized");
              json(
                res,
                { ready: false, reason: reasons.join("; ") },
                503
              );
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            json(res, { ready: false, reason: `store query failed: ${reason}` }, 503);
          }
        }, res, 10000, "/ready");
        metrics.recordLatency(endpoint, Date.now() - requestStart);
        return;
      }

      // Rate limiting (applied to all routes except /health, /metrics, /ready)
      // Use socket address only — ignore X-Forwarded-For to prevent spoofing
      const clientIp = req.socket.remoteAddress ?? "unknown";
      if (!checkRateLimit(clientIp)) {
        metrics.incrementError("RATE_LIMITED");
        json(
          res,
          { error: "Too many requests", code: "RATE_LIMITED", retryAfterMs: RATE_LIMIT_WINDOW_MS },
          429
        );
        return;
      }

      // Validate bearer token on all routes except /health, /ready
      const authHeader = req.headers.authorization ?? "";
      const expected = `Bearer ${token}`;
      let authValid = false;
      if (authHeader.length === expected.length) {
        try {
          authValid = timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
        } catch {
          authValid = false;
        }
      }
      log.debug({ endpoint, authValid }, "auth check");

      if (!authValid) {
        metrics.incrementError("UNAUTHORIZED");
        json(res, { error: "Unauthorized" }, 401);
        return;
      }

      // Count the authenticated request after auth passes
      metrics.incrementRequest(endpoint);

      // Metrics endpoint (auth required)
      if (req.method === "GET" && endpoint === "/metrics") {
        await withTimeout(async (_signal) => {
          json(res, metrics.snapshot());
        }, res, 10000, "/metrics");
        metrics.recordLatency(endpoint, Date.now() - requestStart);
        return;
      }

      // Status
      if (req.method === "GET" && endpoint === "/status") {
        await withTimeout(async (_signal) => {
          const stats = metadata.getStats();
          const lastIndexed = metadata.getStat("lastIndexedAt");
          json(res, { ...stats, lastIndexedAt: lastIndexed });
        }, res, 10000, "/status");
        metrics.recordLatency(endpoint, Date.now() - requestStart);
        return;
      }

      // Session start hook
      if (
        req.method === "POST" &&
        endpoint === "/hooks/session-start"
      ) {
        await withTimeout(async (_signal) => {
          const startTime = Date.now();
          logHook(`[${requestId}] SESSION_START`);

          const context = await handleSessionStart(search, config, metadata);

          const elapsed = Date.now() - startTime;
          logHook(
            `[${requestId}] SESSION_START RESULT ${context.chunks.length} chunks (${context.tokenCount} tokens) in ${elapsed}ms`
          );

          log.debug({
            requestId,
            chunkCount: context.chunks.length,
            tokenCount: context.tokenCount,
            topChunks: context.chunks.slice(0, 5).map(c => ({
              path: c.filePath, name: c.name, score: +c.score.toFixed(3),
            })),
            elapsedMs: elapsed,
          }, "session-start hook complete");

          for (const chunk of context.chunks) {
            logHook(
              `  -> ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.name}) [score: ${chunk.score.toFixed(2)}]`
            );
          }

          if (debugMode) {
            res.setHeader("X-Memory-Debug", JSON.stringify({
              requestId,
              chunks: context.chunks.length,
              tokens: context.tokenCount,
              elapsedMs: elapsed,
            }));
          }

          json(res, {
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: context.text,
            },
          });
        }, res, 30000, "/hooks/session-start");
        metrics.recordLatency(endpoint, Date.now() - requestStart);
        return;
      }

      // Prompt context hook
      if (
        req.method === "POST" &&
        endpoint === "/hooks/prompt-context"
      ) {
        await withTimeout(async (signal) => {
          const body = await readBody(req);
          let query = "";
          let activeFiles: string[] | undefined;

          try {
            const parsed = JSON.parse(body);
            query = parsed.query ?? parsed.prompt ?? parsed.message ?? "";
            if (Array.isArray(parsed.activeFiles)) {
              activeFiles = parsed.activeFiles
                .filter((f: unknown) => typeof f === "string" && f.length < 1024)
                .slice(0, 100);
            }
          } catch {
            query = body;
          }

          // Save raw query before sanitization for debug records.
          // Strip control characters to prevent log injection.
          const rawQuery = query.replace(/[\x00-\x1f\x7f]/g, " ");

          // Sanitize query: strip code fragments, imports, and other noise
          // that can leak into the hook payload from CLI wrappers
          query = sanitizeQuery(query);

          if (!query) {
            log.debug({ requestId, reason: "empty query after sanitization" }, "prompt-context skipped");
            metadata.incrementRouteStat("skip");
            const skipDebug: HookDebugRecord = {
              route: "skip",
              intentType: { isCodeQuery: false, needsNavigation: false },
              skipReason: "empty query after sanitization",
              injectedTokenCount: 0,
              injectedChunkCount: 0,
              seedCandidate: null,
              confidence: null,
              latencyMs: 0,
              query: rawQuery,
              sanitizedQuery: query,
            };
            logHook(`[${requestId}] SKIP reason="empty query after sanitization" debug=${JSON.stringify(skipDebug)}`);
            if (debugMode) {
              res.setHeader("X-Memory-Debug", JSON.stringify({
                requestId,
                hookEventName: "UserPromptSubmit",
                route: "skip",
                chunks: 0,
                tokens: 0,
                elapsedMs: 0,
                queryClassification: { isCodeQuery: false, needsNavigation: false },
                skipReason: "empty query after sanitization",
              }));
            }
            json(res, {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "",
              },
              ...(debugMode ? {
                _debug: {
                  route: "skip" as const,
                  tokensInjected: 0,
                  chunksInjected: 0,
                  queryClassification: { isCodeQuery: false, needsNavigation: false },
                  skipReason: "empty query after sanitization",
                  latencyMs: 0,
                },
              } : {}),
            });
            return;
          }

          // Classify intent — skip retrieval entirely for non-code queries
          const intent = classifyIntent(query);
          let route = deriveRoute(intent);

          // For navigational queries, attempt seed resolution to determine R1 vs R2.
          // The seedResult is captured and threaded through to downstream handlers
          // so that resolveSeeds is only called once per request.
          let seedCandidate: string | null = null;
          let seedConfidence: number | null = null;
          let cachedSeedResult: import("../search/seed.js").SeedResult | undefined;
          if (intent.needsNavigation && route === "R0" && liveOptions.ftsStore) {
            const { resolveSeeds } = await import("../search/seed.js");
            const seedResult = resolveSeeds(query, metadata, liveOptions.ftsStore);
            cachedSeedResult = seedResult;
            if (seedResult.bestSeed) {
              seedCandidate = seedResult.bestSeed.name;
              seedConfidence = seedResult.bestSeed.confidence;
            }
            route = deriveRoute(intent, seedResult.bestSeed?.confidence ?? null);
          }

          if (route === "skip") {
            const skipDebug: HookDebugRecord = {
              route: "skip",
              intentType: { isCodeQuery: intent.isCodeQuery, needsNavigation: intent.needsNavigation },
              skipReason: intent.skipReason ?? "non-code query",
              injectedTokenCount: 0,
              injectedChunkCount: 0,
              seedCandidate: null,
              confidence: null,
              latencyMs: 0,
              query: rawQuery,
              sanitizedQuery: query,
            };
            logHook(
              `[${requestId}] SKIP query="${rawQuery.slice(0, 100)}" reason="${intent.skipReason ?? "non-code query"}" debug=${JSON.stringify(skipDebug)}`
            );
            metadata.incrementRouteStat("skip");
            if (debugMode) {
              res.setHeader("X-Memory-Debug", JSON.stringify({
                requestId,
                hookEventName: "UserPromptSubmit",
                route: "skip",
                chunks: 0,
                tokens: 0,
                elapsedMs: 0,
                queryClassification: intent,
                skipReason: intent.skipReason ?? "non-code query",
              }));
            }
            json(res, {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "",
              },
              ...(debugMode ? {
                _debug: {
                  route: "skip",
                  tokensInjected: 0,
                  chunksInjected: 0,
                  queryClassification: intent,
                  skipReason: intent.skipReason,
                  latencyMs: 0,
                },
              } : {}),
            });
            return;
          }

          const startTime = Date.now();
          logHook(`[${requestId}] SEARCH route=${route} query="${rawQuery.slice(0, 100)}"`);

          const promptContext = await handlePromptContextDetailed(
            query,
            search,
            config,
            activeFiles,
            signal,
            route,
            liveOptions.ftsStore ? metadata : undefined,
            liveOptions.ftsStore,
            cachedSeedResult
          );
          route = promptContext.resolvedRoute;
          const context = promptContext.context;

          if (!context) {
            const skipElapsed = Date.now() - startTime;
            metadata.incrementRouteStat("skip");
            const skipDebug: HookDebugRecord = {
              route: "skip",
              intentType: { isCodeQuery: intent.isCodeQuery, needsNavigation: intent.needsNavigation },
              skipReason: "no context returned",
              injectedTokenCount: 0,
              injectedChunkCount: 0,
              seedCandidate: null,
              confidence: null,
              latencyMs: skipElapsed,
              query: rawQuery,
              sanitizedQuery: query,
            };
            logHook(`[${requestId}] SKIP reason="no context returned" debug=${JSON.stringify(skipDebug)}`);
            if (debugMode) {
              res.setHeader("X-Memory-Debug", JSON.stringify({
                requestId,
                hookEventName: "UserPromptSubmit",
                route: "skip",
                chunks: 0,
                tokens: 0,
                elapsedMs: skipElapsed,
                queryClassification: intent,
                skipReason: "no context returned",
              }));
            }
            json(res, {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "",
              },
              ...(debugMode ? {
                _debug: {
                  route: "skip" as const,
                  tokensInjected: 0,
                  chunksInjected: 0,
                  queryClassification: intent,
                  skipReason: "no context returned",
                  latencyMs: skipElapsed,
                },
              } : {}),
            });
            return;
          }

          const elapsed = Date.now() - startTime;

          const debugRecord: HookDebugRecord = {
            route,
            intentType: { isCodeQuery: intent.isCodeQuery, needsNavigation: intent.needsNavigation },
            skipReason: null,
            injectedTokenCount: context.tokenCount,
            injectedChunkCount: context.chunks.length,
            seedCandidate,
            confidence: seedConfidence,
            latencyMs: elapsed,
            query: rawQuery,
            sanitizedQuery: query,
          };

          logHook(
            `[${requestId}] RESULT ${context.chunks.length} chunks (${context.tokenCount} tokens) in ${elapsed}ms route=${route}`
          );

          log.debug({
            requestId,
            query: query.slice(0, 120),
            route,
            activeFilesCount: activeFiles?.length ?? 0,
            chunkCount: context.chunks.length,
            tokenCount: context.tokenCount,
            topChunks: context.chunks.slice(0, 5).map(c => ({
              path: c.filePath, name: c.name, score: +c.score.toFixed(3),
            })),
            hasHookOutput: context.text.length > 0,
            elapsedMs: elapsed,
            debugRecord,
          }, "prompt-context hook complete");

          for (const chunk of context.chunks) {
            logHook(
              `  -> ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.name}) [score: ${chunk.score.toFixed(2)}]`
            );
          }

          logHook(
            `[${requestId}] BUDGET ${context.tokenCount} / ${config.contextBudget} tokens (${((context.tokenCount / config.contextBudget) * 100).toFixed(1)}%)`
          );

          // Stats update: all reads and writes are synchronous (better-sqlite3),
          // so no interleaving is possible within this block
          metadata.recordLatency(elapsed);
          metadata.incrementRouteStat(route);
          metadata.incrementStat("hooksFireCount");
          metadata.incrementStat("totalTokensInjected", context.tokenCount);
          metadata.incrementStat("chunksServed", context.chunks.length);

          if (debugMode) {
            res.setHeader("X-Memory-Debug", JSON.stringify({
              requestId,
              hookEventName: "UserPromptSubmit",
              route,
              chunks: context.chunks.length,
              tokens: context.tokenCount,
              elapsedMs: elapsed,
              queryClassification: intent,
              ...(seedCandidate ? { seedCandidate, seedConfidence } : {}),
            }));
          }

          json(res, {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: context.text,
            },
            ...(debugMode ? {
              _debug: {
                route,
                tokensInjected: context.tokenCount,
                chunksInjected: context.chunks.length,
                queryClassification: intent,
                latencyMs: elapsed,
                ...(seedCandidate ? { seedCandidate, seedConfidence } : {}),
              },
            } : {}),
          });
        }, res, 30000, "/hooks/prompt-context");
        metrics.recordLatency(endpoint, Date.now() - requestStart);
        return;
      }

      // 404
      json(res, { error: "Not found" }, 404);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`[${requestId}] Server error: ${errorMessage}`);

      let code = "INTERNAL_ERROR";
      if (errorMessage.includes("embedding") || errorMessage.includes("Embedding")) {
        code = "EMBEDDING_UNAVAILABLE";
      } else if (errorMessage.includes("timeout") || errorMessage.includes("Timeout")) {
        code = "TIMEOUT";
      } else if (errorMessage.includes("corrupt") || errorMessage.includes("database")) {
        code = "INDEX_CORRUPTED";
      }

      // Record the error in metrics
      metrics.incrementError(code);

      // Build endpoint-specific error context
      const context: Record<string, unknown> = {};

      if (endpoint === "/hooks/prompt-context") {
        // Search error context — body was already consumed by the handler,
        // so we cannot re-read it here. Include the search type so clients
        // know this was a search-related failure.
        context.searchType = "prompt-context";
      } else if (endpoint === "/hooks/session-start") {
        context.hookType = "SessionStart";
      } else if (endpoint.startsWith("/hooks/")) {
        context.hookType = endpoint.replace("/hooks/", "");
        context.path = endpoint;
      }

      if (code === "TIMEOUT") {
        context.endpoint = endpoint;
      }

      if (code === "INDEX_CORRUPTED") {
        context.needsReindex = true;
      }

      json(
        res,
        { error: "Internal server error", code, requestId, ...context },
        500
      );
    }
  });

  return { server, token, metrics };
}
