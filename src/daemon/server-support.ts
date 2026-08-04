import type { IncomingMessage, ServerResponse } from "http";
import type { HookSessionSnapshot } from "../hooks/pre-tool-use.js";
import type { MemoryRuntime } from "./memory/runtime.js";
// --- Header helpers ---------------------------------------------------------

/** Strip non-printable-ASCII chars so setHeader never throws on user content. */
export function safeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?");
}

// --- Rate limiter -----------------------------------------------------------
// Sliding-window, in-memory, per client IP. No external dependencies.

export const RATE_LIMIT_WINDOW_MS = 10_000; // 10 seconds
const RATE_LIMIT_MAX_REQUESTS = 100;
export const PROBE_RATE_LIMIT_MAX_REQUESTS = 1000; // generous limit for /health, /metrics, /ready
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;

interface RateEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateEntry>();
export const hookSessionState = new Map<string, HookSessionSnapshot>();
const HOOK_SESSION_TTL_MS = 1000 * 60 * 60 * 4;

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

setInterval(() => {
  const cutoff = Date.now() - HOOK_SESSION_TTL_MS;
  for (const [key, snapshot] of hookSessionState) {
    if (snapshot.updatedAt < cutoff) hookSessionState.delete(key);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS).unref();

export function resetRateLimitMap(): void {
  rateLimitMap.clear();
}

export function checkRateLimit(ip: string, maxRequests: number = RATE_LIMIT_MAX_REQUESTS): boolean {
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

export function resolveHookSessionKey(parsed: Record<string, unknown>): string | null {
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
  if (sessionId && sessionId.trim()) return sessionId.trim();
  const transcriptPath = typeof parsed.transcript_path === "string" ? parsed.transcript_path : null;
  if (transcriptPath && transcriptPath.trim()) return transcriptPath.trim();
  return null;
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

const MAX_SANITIZED_QUERY_CHARS = 1200;

const CODE_IDENTIFIER_STOP_WORDS = new Set([
  "abstract", "async", "await", "boolean", "break", "case", "catch", "class", "const", "continue",
  "default", "def", "delete", "do", "else", "enum", "except", "export", "extends", "false",
  "finally", "for", "from", "function", "if", "import", "in", "include", "interface", "let",
  "new", "null", "package", "private", "protected", "public", "return", "static", "string",
  "switch", "this", "throw", "true", "try", "type", "undefined", "using", "value", "var", "void",
  "while", "with",
]);

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

function shouldDropCodeIdentifierHints(trimmed: string): boolean {
  if (/^#(?:include|define)\b/.test(trimmed)) return true;
  if (/^import\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)+/.test(trimmed)) return true;
  if (/^[A-Z_][A-Z0-9_]*\s*=/.test(trimmed)) return true;
  if (/^(?:subprocess\.|print\(|raise\s+SystemExit\b|if\s+not\s+[A-Z_]\w*\b)/.test(trimmed)) return true;
  return false;
}

function extractIdentifierHints(text: string): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  const withoutStringLiterals = text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, " ");
  const identifierMatches = withoutStringLiterals.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:(?:[./]|::)[A-Za-z_$][A-Za-z0-9_$]*)*/g) ?? [];
  for (const match of identifierMatches) {
    const normalized = match.replace(/^[_$]+|[_$]+$/g, "");
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (CODE_IDENTIFIER_STOP_WORDS.has(lower)) continue;
    const meaningful =
      normalized.includes("/")
      || normalized.includes(".")
      || normalized.includes("::")
      || /[a-z][A-Z]/.test(normalized)
      || /^[A-Z][A-Za-z0-9_$]{2,}$/.test(normalized)
      || normalized.length >= 5;
    if (!meaningful) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      hints.push(normalized);
    }
    if (hints.length >= 80) break;
  }
  return hints;
}

export function sanitizeQuery(raw: string): string {
  // Some clients accidentally feed the previous hook's additionalContext back
  // into the next prompt payload. Drop the injected suffix at its first stable
  // heading so retrieval terms cannot recursively accumulate across turns.
  const injectedContextStart = raw.search(
    /^(?:⚠\s*)?reporecall index (?:STALE|EMPTY)\b|^## (?:Relevant codebase context|Reporecall Guidance|Memory guidance|Wiki knowledge|Codebase topology)\b/im
  );
  const withoutInjectedContext =
    injectedContextStart >= 0 ? raw.slice(0, injectedContextStart) : raw;

  // 0. Strip Claude Code system-injected XML blocks that leak into hook payloads.
  //    These contain task notifications, system reminders, and other non-user content.
  const withoutSystemTags = withoutInjectedContext.replace(
    /<(task-notification|system-reminder|tool-result|antml:[a-z_]+)\b[\s\S]*?<\/\1>/g,
    " "
  );

  // 0b. Strip non-XML system boilerplate lines that Claude Code injects outside
  //     of XML tags (e.g. task-output read instructions, temp file paths).
  const withoutBoilerplate = withoutSystemTags
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      // "Read the output file to retrieve the result: /private/tmp/..."
      if (/^Read the output file to retrieve the result:/i.test(t)) return false;
      // Bare temp-dir file paths: /private/tmp/..., /var/folders/..., /tmp/...
      if (/^\/(?:private\/tmp|var\/folders|tmp)\/\S+$/.test(t)) return false;
      return true;
    })
    .join("\n");

  // 1. Collapse backtick-fenced code blocks into path/symbol hints. Full code
  //    lines are still removed, but identifiers remain searchable.
  const withoutFencedBlocks = withoutBoilerplate.replace(/```[\s\S]*?```/g, (block) => {
    const body = block
      .replace(/^```[^\n]*\n?/, "")
      .replace(/```$/, "");
    return ` ${extractIdentifierHints(body).join(" ")} `;
  });

  // 2. Collapse inline code spans (`...`) into useful identifiers.
  const withoutInlineCode = withoutFencedBlocks.replace(/`([^`]*)`/g, (_match, code: string) => {
    return ` ${extractIdentifierHints(code).join(" ")} `;
  });

  // 3. Process line-by-line, SKIPPING (not breaking at) code-like lines.
  //    The old implementation used `break` which meant code on line 2 would
  //    discard valid natural language on line 3+. Now we skip individual
  //    code lines so NL lines after code are still collected.
  const lines = withoutInlineCode.split("\n");
  const cleanLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const identifierHints = extractIdentifierHints(trimmed);
    if (looksLikeCodeLine(trimmed)) {
      if (!shouldDropCodeIdentifierHints(trimmed) && identifierHints.length > 0) {
        cleanLines.push(identifierHints.join(" "));
      }
      continue;
    }
    // Skip lines that are mostly non-alphanumeric (likely code/symbols)
    const alphaCount = (trimmed.match(/[a-zA-Z]/g) ?? []).length;
    if (trimmed.length > 4 && alphaCount / trimmed.length < 0.3) {
      if (identifierHints.length > 0) cleanLines.push(identifierHints.join(" "));
      continue;
    }
    cleanLines.push(trimmed);
  }

  return cleanLines.join(" ").replace(/\s+/g, " ").slice(0, MAX_SANITIZED_QUERY_CHARS).trim();
}

export function readBody(req: IncomingMessage): Promise<string> {
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

export function withTimeout(
  handler: (signal: AbortSignal) => Promise<void>,
  res: ServerResponse,
  timeoutMs: number,
  endpoint?: string
): Promise<void> {
  const abortController = new AbortController();
  let timedOut = false;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      if (!res.writableEnded) {
        json(res, { error: "Request timeout", code: "TIMEOUT", endpoint, timeoutMs }, 504);
      }
      resolve();
    }, timeoutMs);

    handler(abortController.signal)
      .then(() => {
        clearTimeout(timer);
        // If the handler resolved AFTER a timeout, the client already received
        // a 504 and any writes it performed hit an ended response — treat as
        // a no-op rather than resolving a second time.
        if (!timedOut) resolve();
      })
      .catch((err) => {
        clearTimeout(timer);
        // Swallow errors raised after a timeout (e.g. a handler attempting
        // json() on an already-ended response throws ERR_HTTP_HEADERS_SENT).
        // These are consequences of the timeout, not independent failures.
        if (!timedOut) reject(err);
      });
  });
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
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
  refreshIndex?: () => Promise<void>;
  memorySearch?: import("../memory/search.js").MemorySearch;
  memoryRuntime?: MemoryRuntime;
  memoryStore?: import("../storage/memory-store.js").MemoryStore;
}
