import type { ContextOriginalRef, SearchResult } from "./types.js";

export type EvidenceCompressionMode = "off" | "auto" | "always";

export interface EvidenceCompressionOptions {
  query?: string;
  minChunkTokens?: number;
  targetRatio?: number;
}

export interface EvidenceCompressionResult {
  text: string;
  strategy: "code" | "search_result" | "config_or_data" | "text";
  originalRef: ContextOriginalRef;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "what", "which",
  "where", "when", "does", "how", "work", "flow", "files", "file",
  "code", "show", "tell", "about", "into", "over", "under", "using",
]);

const IMPORT_LIKE_RE = /^\s*(import|from|export|require\(|use\s+|using\s+|#include|include\s+|package\s+|module\s+|namespace\s+|mod\s+)/i;
const SIGNATURE_LIKE_RE = /^\s*(export\s+)?((async\s+)?function|def|class|interface|type|enum|struct|trait|impl|func|fn|pub\s+(fn|struct|enum|trait)|public|private|protected|static|const|let|var|protocol|extension|object|case\s+class)\b/i;
const DECORATOR_LIKE_RE = /^\s*(@[\w.:-]+|#\[|\[[A-Z]\w+|\*\s*@)/;
const CONFIG_LIKE_RE = /^\s*["']?[A-Z0-9_]*(URL|URI|HOST|PORT|TOKEN|SECRET|KEY|PASSWORD|AUTH|ROUTE|PATH|ENDPOINT|BUCKET|QUEUE|TOPIC|MODEL|ENV)[A-Z0-9_]*["']?\s*[:=]/i;
const ROUTE_LITERAL_RE = /["'`](\/[A-Za-z0-9_./:{}-]{2,}|[A-Z]{3,8}\s+\/[A-Za-z0-9_./:{}-]*)["'`]/;
const ERROR_LITERAL_RE = /\b(error|exception|fatal|panic|throw|throws|raise|warn|warning|failed|failure|invalid|unauthorized|forbidden|not found)\b/i;
const HIGH_ENTROPY_RE = /\b[A-Za-z0-9_-]{20,}\b/;
const SEARCH_RESULT_RE = /^[^\s:][^:\n]{0,240}:\d+:/m;
const DATA_LANGUAGE_SET = new Set(["json", "toml", "yaml", "yml", "html", "css"]);
const TEXT_LANGUAGE_SET = new Set(["markdown", "md", "text"]);

export function compressEvidenceChunk(
  chunk: SearchResult,
  options: EvidenceCompressionOptions
): EvidenceCompressionResult {
  const strategy = inferStrategy(chunk);
  const selected = selectEvidenceLines(chunk, options.query, strategy, options.targetRatio);
  const ref = buildOriginalRef(chunk);
  const doc = chunk.docstring ? `\n  - doc: ${oneLine(chunk.docstring, 180)}` : "";
  const evidence = selected.length > 0
    ? selected.map((line) => `  - L${line.line}: ${line.text}`).join("\n")
    : `  - ${fallbackSummary(chunk)}`;
  const omitted = Math.max(0, chunk.content.split("\n").length - selected.length);
  const omittedLine = omitted > 0 ? `\n  - omitted: ${omitted} lines; retrieve original with chunkId \`${chunk.id}\`` : "";

  return {
    strategy,
    originalRef: ref,
    text:
      `- \`${chunk.kind} ${chunk.name}\` (${chunk.filePath}:${chunk.startLine}-${chunk.endLine}, chunkId \`${chunk.id}\`, ${chunk.language || "unknown"})`
      + doc
      + `\n  - strategy: ${strategy}`
      + `\n${evidence}`
      + omittedLine
      + "\n",
  };
}

function inferStrategy(chunk: SearchResult): EvidenceCompressionResult["strategy"] {
  const language = chunk.language.toLowerCase();
  const path = chunk.filePath.toLowerCase();
  if (SEARCH_RESULT_RE.test(chunk.content)) return "search_result";
  if (DATA_LANGUAGE_SET.has(language) || /\.(json|ya?ml|toml|env|ini|css|html?)$/.test(path)) {
    return "config_or_data";
  }
  if (TEXT_LANGUAGE_SET.has(language) || /\.(md|txt|rst)$/.test(path)) return "text";
  return "code";
}

function selectEvidenceLines(
  chunk: SearchResult,
  query: string | undefined,
  strategy: EvidenceCompressionResult["strategy"],
  targetRatio?: number
): Array<{ line: number; text: string; score: number }> {
  const queryTerms = tokenizeQuery(query);
  const lines = chunk.content.split("\n");
  const candidates: Array<{ index: number; line: number; text: string; score: number }> = [];

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const text = raw.trimEnd();
    if (!text.trim()) continue;
    const commentOnly = /^\s*(\/\/|#(?!\[)|--|\*)/.test(text);
    let score = 0;
    if (IMPORT_LIKE_RE.test(text)) score += strategy === "code" ? 18 : 8;
    if (SIGNATURE_LIKE_RE.test(text)) score += 24;
    if (DECORATOR_LIKE_RE.test(text)) score += 12;
    if (CONFIG_LIKE_RE.test(text)) score += 16;
    if (ROUTE_LITERAL_RE.test(text)) score += 14;
    if (ERROR_LITERAL_RE.test(text)) score += 12;
    if (HIGH_ENTROPY_RE.test(text)) score += 8;
    if (chunk.name && text.includes(chunk.name)) score += 18;
    if (chunk.parentName && text.includes(chunk.parentName)) score += 8;
    if (strategy === "search_result" && /^[^\s:][^:\n]{0,240}:\d+:/.test(text)) score += 18;
    if (strategy === "text" && /^\s{0,3}(#{1,6}\s+|- |\* |\d+\. )/.test(text)) score += 10;
    if (strategy === "config_or_data" && /["']?[A-Za-z0-9_.-]+["']?\s*[:=]/.test(text)) score += 10;
    const queryScore = queryTerms.filter((term) => text.toLowerCase().includes(term)).length * 20;
    score += commentOnly ? Math.min(queryScore, 6) : queryScore;
    if (commentOnly && score < 25) score = Math.floor(score * 0.25);

    if (score > 0) {
      candidates.push({
        index,
        line: chunk.startLine + index,
        text: oneLine(text.trim(), 220),
        score,
      });
    }
  }

  if (candidates.length === 0) {
    const first = lines.findIndex((line) => line.trim().length > 0);
    if (first >= 0) {
      candidates.push({
        index: first,
        line: chunk.startLine + first,
        text: oneLine((lines[first] ?? "").trim(), 220),
        score: 1,
      });
    }
  }

  // Base cap by strategy; scale down conservatively when a targetRatio is
  // requested so callers can request a tighter evidence summary.
  const baseMaxLines = strategy === "code" ? 8 : 10;
  const maxLines = targetRatio !== undefined && targetRatio > 0
    ? Math.max(2, Math.min(baseMaxLines, Math.floor(baseMaxLines * targetRatio)))
    : baseMaxLines;
  return candidates
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxLines)
    .sort((a, b) => a.index - b.index)
    .map(({ line, text, score }) => ({ line, text, score }));
}

function tokenizeQuery(query: string | undefined): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term))
    .slice(0, 16);
}

function buildOriginalRef(chunk: SearchResult): ContextOriginalRef {
  return {
    chunkId: chunk.id,
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    name: chunk.name,
    kind: chunk.kind,
    language: chunk.language,
  };
}

function fallbackSummary(chunk: SearchResult): string {
  return `${chunk.language || "unknown"} ${chunk.kind} evidence in ${chunk.filePath}; retrieve original with chunkId \`${chunk.id}\``;
}

function oneLine(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}
