import { createServer } from "http";
import { type MemoryConfig, resolveContextBudget } from "../core/config.js";
import type { HybridSearch } from "../search/hybrid.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { handleSessionStart } from "../hooks/session-start.js";
import { handlePromptContextDetailed } from "../hooks/prompt-context.js";
import { evaluatePreToolUse } from "../hooks/pre-tool-use.js";
import { classifyIntent } from "../search/intent.js";
import { getLogger } from "../core/logger.js";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { RotatingLog } from "./rotating-log.js";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { MetricsCollector } from "./metrics.js";
import type { HookDebugRecord } from "../search/types.js";
import { banner, clearFreshnessCache, computeFreshness, type IndexFreshness } from "../core/staleness.js";
import { countTokens } from "../search/context-assembler.js";
import { PreToolUseBodySchema, PromptContextBodySchema, SessionStartBodySchema } from "./hook-schemas.js";

import { checkRateLimit, hookSessionState, json, PROBE_RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS, readBody, resolveHookSessionKey, safeHeaderValue, sanitizeQuery, withTimeout, type DaemonServerOptions } from "./server-support.js";
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
  let serverClosed = false;
  function logHook(message: string): void {
    if (serverClosed) return;
    const timestamp = new Date().toISOString().slice(11, 19);
    hookLog.append(`[${timestamp}] ${message}\n`).catch((e) => log.warn({ err: e }, "hook log write failed"));
  }

  let autoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let autoRefreshInFlight = false;
  let autoRefreshQueued = false;

  function scheduleAutoRefresh(freshness: IndexFreshness, requestId: string): void {
    if (serverClosed) return;
    if (config.autoRefresh === false || !liveOptions.refreshIndex) return;
    if (autoRefreshTimer) return;

    autoRefreshTimer = setTimeout(() => {
      autoRefreshTimer = undefined;
      void runAutoRefresh(freshness, requestId);
    }, config.debounceMs);
    autoRefreshTimer.unref?.();
  }

  async function runAutoRefresh(freshness: IndexFreshness, requestId: string): Promise<void> {
    if (serverClosed) return;
    if (autoRefreshInFlight) {
      autoRefreshQueued = true;
      return;
    }

    autoRefreshInFlight = true;
    log.warn({ requestId, freshness }, "reporecall index stale; scheduling background auto-refresh");
    logHook(`[${requestId}] AUTO_REFRESH start reason=${JSON.stringify(freshness)}`);
    try {
      await liveOptions.refreshIndex?.();
      clearFreshnessCache();
      if (!serverClosed) logHook(`[${requestId}] AUTO_REFRESH complete`);
    } catch (err) {
      log.warn({ err, requestId }, "reporecall background auto-refresh failed");
      logHook(`[${requestId}] AUTO_REFRESH failed error=${err instanceof Error ? err.message : String(err)}`);
    } finally {
      autoRefreshInFlight = false;
      if (autoRefreshQueued) {
        autoRefreshQueued = false;
        scheduleAutoRefresh(freshness, requestId);
      }
    }
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
          // Validate request body (session-start currently ignores it, but
          // we still enforce schema so malformed payloads are caught early).
          const body = await readBody(req);
          if (body) {
            try {
              const parsed = JSON.parse(body);
              const result = SessionStartBodySchema.safeParse(parsed);
              if (!result.success) {
                json(res, { error: "Invalid request body", details: result.error.issues }, 400);
                return;
              }
            } catch {
              json(res, { error: "Invalid JSON" }, 400);
              return;
            }
          }

          const startTime = Date.now();
          logHook(`[${requestId}] SESSION_START`);

          const context = await handleSessionStart(search, config, metadata, liveOptions.memoryStore);

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
            res.setHeader("X-Memory-Debug", safeHeaderValue(JSON.stringify({
              requestId,
              chunks: context.chunks.length,
              tokens: context.tokenCount,
              elapsedMs: elapsed,
            })));
          }

          const freshness = computeFreshness(metadata, config.projectRoot);
          json(res, {
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: context.text,
            },
            reporecall: { staleness: freshness },
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
          let sessionKey: string | null = null;

          try {
            const parsed = JSON.parse(body);
            const validation = PromptContextBodySchema.safeParse(parsed);
            if (!validation.success) {
              json(res, { error: "Invalid request body", details: validation.error.issues }, 400);
              return;
            }
            const validated = validation.data;
            sessionKey = resolveHookSessionKey(validated as Record<string, unknown>);
            query = validated.query ?? validated.prompt ?? validated.message ?? "";
            if (Array.isArray(validated.activeFiles)) {
              activeFiles = validated.activeFiles
                .filter((f: unknown) => typeof f === "string" && f.length < 1024)
                .slice(0, 100);
            }
          } catch (err) {
            log.warn({ err }, "prompt-context body JSON parse failed; falling back to raw body as query");
            query = body;
          }

          // Save raw query before sanitization for debug records.
          // Strip control characters to prevent log injection.
          const rawQuery = query.replace(/[\x00-\x1f\x7f]/g, " ");

          // Sanitize query: strip code fragments, imports, and other noise
          // that can leak into the hook payload from CLI wrappers
          query = sanitizeQuery(query);
          const freshness = computeFreshness(metadata, config.projectRoot);
          const freshnessBanner = banner(freshness);

          if (!query) {
            if (sessionKey) hookSessionState.delete(sessionKey);
            log.debug({ requestId, reason: "empty query after sanitization" }, "prompt-context skipped");
            metadata.incrementRouteStat("skip");
            const skipDebug: HookDebugRecord = {
              queryMode: "skip",
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
              res.setHeader("X-Memory-Debug", safeHeaderValue(JSON.stringify({
                requestId,
                hookEventName: "UserPromptSubmit",
                queryMode: "skip",
                chunks: 0,
                tokens: 0,
                elapsedMs: 0,
                queryClassification: { isCodeQuery: false, needsNavigation: false },
                skipReason: "empty query after sanitization",
                staleness: freshness,
              })));
            }
            json(res, {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "",
              },
              reporecall: { staleness: freshness },
              ...(debugMode ? {
                _debug: {
                  queryMode: "skip" as const,
                  tokensInjected: 0,
                  chunksInjected: 0,
                  queryClassification: { isCodeQuery: false, needsNavigation: false },
                  skipReason: "empty query after sanitization",
                  latencyMs: 0,
                  staleness: freshness,
                },
              } : {}),
            });
            return;
          }

          if (freshness.level === "empty") {
            if (sessionKey) hookSessionState.delete(sessionKey);
            log.warn({ requestId, freshness }, "prompt-context skipped because reporecall index is empty");
            metadata.incrementRouteStat("skip");
            const emptyAdditionalContext = freshnessBanner ?? "";
            const emptyTokenCount = countTokens(emptyAdditionalContext);
            const emptyDebug: HookDebugRecord = {
              queryMode: "skip",
              intentType: { isCodeQuery: false, needsNavigation: false },
              skipReason: "empty index",
              injectedTokenCount: emptyTokenCount,
              injectedChunkCount: 0,
              seedCandidate: null,
              confidence: null,
              latencyMs: 0,
              query: rawQuery,
              sanitizedQuery: query,
            };
            logHook(`[${requestId}] SKIP reason="empty index" debug=${JSON.stringify(emptyDebug)}`);
            if (debugMode) {
              res.setHeader("X-Memory-Debug", safeHeaderValue(JSON.stringify({
                requestId,
                hookEventName: "UserPromptSubmit",
                queryMode: "skip",
                chunks: 0,
                tokens: emptyTokenCount,
                elapsedMs: 0,
                skipReason: "empty index",
                staleness: freshness,
              })));
            }
            json(res, {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: emptyAdditionalContext,
              },
              reporecall: { staleness: freshness },
              ...(debugMode ? {
                _debug: {
                  queryMode: "skip" as const,
                  tokensInjected: emptyTokenCount,
                  chunksInjected: 0,
                  skipReason: "empty index",
                  latencyMs: 0,
                  staleness: freshness,
                },
              } : {}),
            });
            return;
          }
          if (freshness.level === "stale") {
            scheduleAutoRefresh(freshness, requestId);
          }

          // Classify intent — skip retrieval entirely for non-code queries
          const intent = classifyIntent(query);
          let queryMode = intent.queryMode;

          // For navigational queries, attempt seed resolution to determine R1 vs R2.
          // The seedResult is captured and threaded through to downstream handlers
          // so that resolveSeeds is only called once per request.
          let seedCandidate: string | null = null;
          let seedConfidence: number | null = null;
          let cachedSeedResult: import("../search/seed.js").SeedResult | undefined;
          if (intent.needsNavigation && liveOptions.ftsStore) {
            const { resolveSeeds } = await import("../search/seed.js");
            const seedResult = resolveSeeds(query, metadata, liveOptions.ftsStore);
            cachedSeedResult = seedResult;
            if (seedResult.bestSeed) {
              seedCandidate = seedResult.bestSeed.name;
              seedConfidence = seedResult.bestSeed.confidence;
            }
          }

          if (queryMode === "skip") {
            if (sessionKey) hookSessionState.delete(sessionKey);
            const skipDebug: HookDebugRecord = {
              queryMode: "skip",
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
              res.setHeader("X-Memory-Debug", safeHeaderValue(JSON.stringify({
                requestId,
                hookEventName: "UserPromptSubmit",
                queryMode: "skip",
                chunks: 0,
                tokens: 0,
                elapsedMs: 0,
                queryClassification: intent,
                skipReason: intent.skipReason ?? "non-code query",
              })));
            }
            json(res, {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "",
              },
              reporecall: { staleness: freshness },
              ...(debugMode ? {
                _debug: {
                  queryMode: "skip",
                  tokensInjected: 0,
                  chunksInjected: 0,
                  queryClassification: intent,
                  skipReason: intent.skipReason,
                  latencyMs: 0,
                  staleness: freshness,
                },
              } : {}),
            });
            return;
          }

          const startTime = Date.now();
          logHook(`[${requestId}] SEARCH mode=${queryMode} query="${rawQuery.slice(0, 100)}"`);

          const totalChunks = metadata.getStats().totalChunks;
          const promptContext = await handlePromptContextDetailed(
            query,
            search,
            config,
            activeFiles,
            signal,
            queryMode,
            liveOptions.ftsStore ? metadata : undefined,
            liveOptions.ftsStore,
            cachedSeedResult,
            totalChunks,
            liveOptions.memorySearch,
            liveOptions.memoryStore
          );
          queryMode = promptContext.resolvedQueryMode;
          const context = promptContext.context;

          if (!context) {
            if (sessionKey) hookSessionState.delete(sessionKey);
            const skipElapsed = Date.now() - startTime;
            metadata.incrementRouteStat("skip");
            const skipDebug: HookDebugRecord = {
              queryMode: "skip",
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
              res.setHeader("X-Memory-Debug", safeHeaderValue(JSON.stringify({
                requestId,
                hookEventName: "UserPromptSubmit",
                queryMode: "skip",
                chunks: 0,
                tokens: 0,
                elapsedMs: skipElapsed,
                queryClassification: intent,
                skipReason: "no context returned",
              })));
            }
            json(res, {
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: "",
              },
              reporecall: { staleness: freshness },
              ...(debugMode ? {
                _debug: {
                  queryMode: "skip" as const,
                  tokensInjected: 0,
                  chunksInjected: 0,
                  queryClassification: intent,
                  skipReason: "no context returned",
                  latencyMs: skipElapsed,
                  staleness: freshness,
                },
              } : {}),
            });
            return;
          }

          if (sessionKey) {
            hookSessionState.set(sessionKey, {
              sessionKey,
              queryMode,
              deliveryMode: promptContext.deliveryMode ?? context.deliveryMode ?? "code_context",
              injectedFiles: context.chunks.map((chunk) => chunk.filePath),
              selectedFiles: promptContext.selectedFiles?.map((file) => file.filePath)
                ?? context.chunks.map((chunk) => chunk.filePath),
              contextStrength: promptContext.contextStrength ?? "weak",
              executionSurface: promptContext.executionSurface,
              query,
              missingEvidence: promptContext.missingEvidence,
              recommendedNextReads: promptContext.recommendedNextReads,
              updatedAt: Date.now(),
            });
          }

          const elapsed = Date.now() - startTime;
          const hookContextBody = promptContext.advisoryText
            ? `${promptContext.advisoryText}\n\n${context.text}`
            : context.text;
          const hookAdditionalContext = freshnessBanner
            ? `${freshnessBanner}\n\n${hookContextBody}`
            : hookContextBody;
          const injectedTokenCount = countTokens(hookAdditionalContext);

          const debugRecord: HookDebugRecord = {
            queryMode,
            intentType: { isCodeQuery: intent.isCodeQuery, needsNavigation: intent.needsNavigation },
            skipReason: null,
            injectedTokenCount,
            injectedChunkCount: context.chunks.length,
            seedCandidate,
            confidence: seedConfidence,
            latencyMs: elapsed,
            query: rawQuery,
            sanitizedQuery: query,
            memoryRoute: promptContext.memoryRoute ?? "M0",
            memoryTokenCount: promptContext.memoryTokenCount ?? 0,
            memoryCount: promptContext.memoryCount ?? 0,
            memoryNames: promptContext.memoryNames ?? [],
            memoryDropped: promptContext.memoryDropped,
            memoryBudgetUsed: promptContext.memoryBudget?.used ?? 0,
            memoryBudgetTotal: promptContext.memoryBudget?.total ?? 0,
            deliveryMode: promptContext.deliveryMode ?? context.deliveryMode ?? "code_context",
            contextStrength: promptContext.contextStrength,
            executionSurface: promptContext.executionSurface,
            selectedFiles: promptContext.selectedFiles?.map((file) => file.filePath),
            missingEvidence: promptContext.missingEvidence,
            recommendedNextReads: promptContext.recommendedNextReads,
            dominantFamily: promptContext.dominantFamily,
            familyConfidence: promptContext.familyConfidence,
            evidenceConfidence: promptContext.evidenceConfidence,
            deferredReason: promptContext.deferredReason,
            compression: context.compression,
          };

          const memTok = promptContext.memoryTokenCount ?? 0;
          const codeTok = context.tokenCount - memTok;
          const memPart = memTok > 0 ? ` + ${memTok} memory tokens (${promptContext.memoryCount} memories)` : "";
          logHook(
            `[${requestId}] RESULT ${context.chunks.length} chunks (${codeTok} code tokens${memPart}) in ${elapsed}ms mode=${queryMode} memory=${promptContext.memoryRoute ?? "M0"}`
          );

          log.debug({
            requestId,
            query: query.slice(0, 120),
            queryMode,
            activeFilesCount: activeFiles?.length ?? 0,
            chunkCount: context.chunks.length,
            tokenCount: injectedTokenCount,
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

          const resolvedBudget = resolveContextBudget(config.contextBudget, totalChunks);
          logHook(
            `[${requestId}] BUDGET ${injectedTokenCount} / ${resolvedBudget} tokens (${((injectedTokenCount / resolvedBudget) * 100).toFixed(1)}%)${config.contextBudget === 0 ? " [auto]" : ""}`
          );

          // Stats update: all reads and writes are synchronous (better-sqlite3),
          // so no interleaving is possible within this block
          metadata.recordLatency(elapsed);
          metadata.incrementRouteStat(queryMode);
          metadata.incrementStat("hooksFireCount");
          metadata.incrementStat("totalTokensInjected", injectedTokenCount);
          metadata.incrementStat("chunksServed", context.chunks.length);
          metadata.incrementStat(`memoryRoute_${promptContext.memoryRoute ?? "M0"}_count`);
          if (promptContext.memoryTokenCount && promptContext.memoryTokenCount > 0) {
            metadata.incrementStat("memoryTokensInjected", promptContext.memoryTokenCount);
            metadata.incrementStat("memoriesInjected", promptContext.memoryCount ?? 0);
            metadata.incrementStat("memoryHitCount");
            if (promptContext.memoryBudget?.used) {
              metadata.incrementStat("memoryBudgetUsed", promptContext.memoryBudget.used);
            }
            if (promptContext.memoryBudget?.total) {
              metadata.incrementStat("memoryBudgetTotal", promptContext.memoryBudget.total);
            }
            const classTokens = promptContext.memoryClassTokens ?? {
              rule: 0,
              fact: 0,
              episode: 0,
              working: 0,
            };
            const classCounts = promptContext.memoryClassCounts ?? {
              rule: 0,
              fact: 0,
              episode: 0,
              working: 0,
            };
            for (const cls of ["rule", "fact", "episode", "working"] as const) {
              if ((classTokens[cls] ?? 0) > 0) {
                metadata.incrementStat(`memoryTokens_${cls}`, classTokens[cls]);
              }
              if ((classCounts[cls] ?? 0) > 0) {
                metadata.incrementStat(`memoryCount_${cls}`, classCounts[cls]);
              }
            }
          }

          if (liveOptions.memoryRuntime) {
            void liveOptions.memoryRuntime.observePrompt({
              query,
              codeRoute: queryMode,
              memoryRoute: promptContext.memoryRoute,
              activeFiles,
              topFiles: context.chunks.slice(0, 5).map((chunk) => chunk.filePath),
              topSymbols: context.chunks.slice(0, 8).map((chunk) => chunk.name),
              memoryHits: promptContext.memoryResults,
            });
          }

          if (debugMode) {
            res.setHeader("X-Memory-Debug", safeHeaderValue(JSON.stringify({
              requestId,
              hookEventName: "UserPromptSubmit",
              queryMode,
              memoryRoute: promptContext.memoryRoute ?? "M0",
              chunks: context.chunks.length,
              tokens: injectedTokenCount,
              elapsedMs: elapsed,
              deliveryMode: promptContext.deliveryMode ?? context.deliveryMode ?? "code_context",
              contextStrength: promptContext.contextStrength,
              executionSurface: promptContext.executionSurface,
              selectedFiles: promptContext.selectedFiles?.map((file) => file.filePath),
              missingEvidence: promptContext.missingEvidence,
              recommendedNextReads: promptContext.recommendedNextReads,
              dominantFamily: promptContext.dominantFamily,
              familyConfidence: promptContext.familyConfidence,
              evidenceConfidence: promptContext.evidenceConfidence,
              deferredReason: promptContext.deferredReason,
              queryClassification: intent,
              ...(seedCandidate ? { seedCandidate, seedConfidence } : {}),
              ...(promptContext.memoryTokenCount ? {
                memoryTokens: promptContext.memoryTokenCount,
                memoryCount: promptContext.memoryCount,
                memoryNames: promptContext.memoryNames,
                memoryDropped: promptContext.memoryDropped,
              } : {}),
              staleness: freshness,
            })));
          }

          json(res, {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: hookAdditionalContext,
            },
            reporecall: { staleness: freshness },
            ...(debugMode ? {
              _debug: {
                queryMode,
                tokensInjected: injectedTokenCount,
                chunksInjected: context.chunks.length,
                deliveryMode: promptContext.deliveryMode ?? context.deliveryMode ?? "code_context",
                contextStrength: promptContext.contextStrength,
                executionSurface: promptContext.executionSurface,
                selectedFiles: promptContext.selectedFiles?.map((file) => file.filePath),
                missingEvidence: promptContext.missingEvidence,
                recommendedNextReads: promptContext.recommendedNextReads,
                dominantFamily: promptContext.dominantFamily,
                familyConfidence: promptContext.familyConfidence,
                evidenceConfidence: promptContext.evidenceConfidence,
                deferredReason: promptContext.deferredReason,
                compression: context.compression,
                queryClassification: intent,
                latencyMs: elapsed,
                staleness: freshness,
                ...(seedCandidate ? { seedCandidate, seedConfidence } : {}),
                ...(promptContext.memoryTokenCount ? {
                  memoryTokensInjected: promptContext.memoryTokenCount,
                  memoriesInjected: promptContext.memoryCount,
                  memoryNames: promptContext.memoryNames,
                  memoryRoute: promptContext.memoryRoute,
                } : {}),
              },
            } : {}),
          });
        }, res, 30000, "/hooks/prompt-context");
        metrics.recordLatency(endpoint, Date.now() - requestStart);
        return;
      }

      if (
        req.method === "POST" &&
        endpoint === "/hooks/pre-tool-use"
      ) {
        await withTimeout(async (_signal) => {
          const body = await readBody(req);
          let parsed: Record<string, unknown> = {};
          try {
            const raw = JSON.parse(body);
            const validation = PreToolUseBodySchema.safeParse(raw);
            if (!validation.success) {
              json(res, { error: "Invalid request body", details: validation.error.issues }, 400);
              return;
            }
            parsed = validation.data as Record<string, unknown>;
          } catch (err) {
            log.warn({ err }, "pre-tool-use body JSON parse failed; continuing with empty context");
            parsed = {};
          }

          const sessionKey = resolveHookSessionKey(parsed);
          const output = evaluatePreToolUse(
            {
              sessionId: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
              transcriptPath: typeof parsed.transcript_path === "string" ? parsed.transcript_path : undefined,
              toolName: typeof parsed.tool_name === "string" ? parsed.tool_name : undefined,
              toolInput: typeof parsed.tool_input === "object" && parsed.tool_input !== null
                ? parsed.tool_input as Record<string, unknown>
                : undefined,
            },
            sessionKey ? hookSessionState.get(sessionKey) : undefined
          );
          json(res, output);
        }, res, 15000, "/hooks/pre-tool-use");
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
  server.on("close", () => {
    serverClosed = true;
    if (autoRefreshTimer) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = undefined;
    }
  });

  return { server, token, metrics };
}
