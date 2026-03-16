import { encoding_for_model } from "tiktoken";
import type { SearchResult, AssembledContext } from "./types.js";
import { getLogger } from "../core/logger.js";

let encoder: ReturnType<typeof encoding_for_model> | undefined;

function getEncoder() {
  if (!encoder) {
    encoder = encoding_for_model("gpt-4o");
  }
  return encoder;
}

export function freeEncoder(): void {
  if (encoder) {
    encoder.free();
    encoder = undefined;
  }
}

export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}

export interface AssembleOptions {
  scoreFloorRatio?: number;   // default 0.5
  maxChunks?: number;         // default Infinity (no cap unless config passes one)
  directiveHeader?: boolean;  // default true
  query?: string;
  factExtractors?: Array<{ keyword: string; pattern: string; label: string }>;
}

export function assembleContext(
  results: SearchResult[],
  tokenBudget: number,
  optionsOrFloorRatio?: AssembleOptions | number
): AssembledContext {
  // Backward-compatible: number treated as scoreFloorRatio
  const opts: AssembleOptions =
    typeof optionsOrFloorRatio === "number"
      ? { scoreFloorRatio: optionsOrFloorRatio }
      : optionsOrFloorRatio ?? {};

  const scoreFloorRatio = opts.scoreFloorRatio ?? 0.5;
  const maxChunks = opts.maxChunks ?? Infinity;
  const directiveHeader = opts.directiveHeader ?? true;

  const included: SearchResult[] = [];
  let totalTokens = 0;

  // Header
  const header = directiveHeader
    ? "## Relevant codebase context\n\n> The following codebase context was retrieved by the Memory Engine and is likely relevant. If a `Direct facts` section is present and it answers the question, answer directly from it. If the context is insufficient, reply with `Insufficient context`.\n\n"
    : "## Relevant codebase context\n\n";
  totalTokens += countTokens(header);

  // Drop results scoring below scoreFloorRatio of the top result
  const scoreFloor = results.length > 0 ? results[0].score * scoreFloorRatio : 0;

  // Track file headers already emitted
  const emittedHeaders = new Set<string>();

  // Reserve space for summary/facts that will be appended after the loop
  const SUMMARY_RESERVE = 80;

  for (const result of results) {
    if (result.score < scoreFloor) continue;
    const fileHeader = `### ${result.filePath}\n`;
    const fileHeaderTokens = emittedHeaders.has(result.filePath) ? 0 : countTokens(fileHeader);
    const chunkText = formatChunk(result);
    const chunkTokens = countTokens(chunkText);

    if (totalTokens + fileHeaderTokens + chunkTokens > tokenBudget - SUMMARY_RESERVE) {
      break;
    }

    if (!emittedHeaders.has(result.filePath)) {
      emittedHeaders.add(result.filePath);
      totalTokens += fileHeaderTokens;
    }

    totalTokens += chunkTokens;
    included.push(result);

    if (included.length >= maxChunks) break;
  }

  // Build summary line
  const summaryLine = buildSummary(included);
  const summaryTokens = countTokens(summaryLine);
  const factsSection = buildDirectFactsSection(opts.query, included, opts.factExtractors);
  const factsTokens = factsSection ? countTokens(factsSection) : 0;
  // Only include summary if it fits in budget
  const includeSummary = included.length > 0 && totalTokens + summaryTokens <= tokenBudget;
  if (includeSummary) {
    totalTokens += summaryTokens;
  }
  const includeFacts =
    included.length > 0 &&
    !!factsSection &&
    totalTokens + factsTokens <= tokenBudget;
  if (includeFacts) {
    totalTokens += factsTokens;
  }

  // Build final text — emit chunks in score order with file headers interspersed
  const parts: string[] = [header];

  if (includeSummary) {
    parts.push(summaryLine);
    parts.push("");
  }
  if (includeFacts && factsSection) {
    parts.push(factsSection);
    parts.push("");
  }

  const seenFiles = new Set<string>();

  for (const chunk of included) {
    if (!seenFiles.has(chunk.filePath)) {
      if (seenFiles.size > 0) parts.push(""); // blank line between file groups
      parts.push(`### ${chunk.filePath}\n`);
      seenFiles.add(chunk.filePath);
    }
    parts.push(formatChunk(chunk));
  }
  if (included.length > 0) parts.push("");

  const log = getLogger();
  log.debug({
    inputResults: results.length,
    scoreFloor: +scoreFloor.toFixed(3),
    includedChunks: included.length,
    droppedByScoreFloor: results.filter(r => r.score < scoreFloor).length,
    droppedByBudget: results.filter(r => r.score >= scoreFloor).length - included.length,
    totalTokens,
    tokenBudget,
  }, "context assembly complete");

  return {
    text: parts.join("\n"),
    tokenCount: totalTokens,
    chunks: included,
  };
}

function buildSummary(included: SearchResult[]): string {
  const entries = included.map(
    (r) => `\`${r.name}\` (${r.kind}, ${r.filePath}:${r.startLine}-${r.endLine})`
  );
  return `**Found:** ${entries.join(", ")}\n`;
}

function buildDirectFactsSection(
  query: string | undefined,
  included: SearchResult[],
  factExtractors?: Array<{ keyword: string; pattern: string; label: string }>
): string | null {
  if (!query || included.length === 0) return null;

  const lowerQuery = query.toLowerCase();
  const facts: string[] = [];

  const builtinFacts = buildBuiltinFacts(lowerQuery, included);
  facts.push(...builtinFacts);

  if (!factExtractors || factExtractors.length === 0) {
    return facts.length > 0 ? `## Direct facts\n${facts.join("\n")}` : null;
  }

  for (const extractor of factExtractors) {
    if (lowerQuery.includes(extractor.keyword.toLowerCase())) {
      let regex: RegExp;
      try {
        regex = new RegExp(extractor.pattern, "g");
      } catch {
        continue; // Skip invalid patterns (safety net if bypassing config validation)
      }
      const matches = extractUniqueMatches(included, regex);
      if (matches.length > 0) {
        facts.push(`- ${extractor.label}: ${matches.join(", ")}`);
      }
    }
  }

  return facts.length > 0
    ? `## Direct facts\nThese facts were extracted directly from the retrieved code. Use them as the answer if they address the question.\n${facts.join("\n")}`
    : null;
}

function buildBuiltinFacts(
  lowerQuery: string,
  included: SearchResult[]
): string[] {
  const facts: string[] = [];

  if (/\bmcp\b/.test(lowerQuery) && /\btools?\b/.test(lowerQuery)) {
    const tools = extractUniqueMatches(
      included,
      /registerTool\(\s*["']([^"']+)["']/g
    );
    if (tools.length > 0) {
      facts.push(`- Exposed tools: ${tools.join(", ")}`);
    }
  }

  return facts;
}

const MAX_MATCHES = 100;
const EXTRACTION_DEADLINE_MS = 50;

function extractUniqueMatches(
  included: SearchResult[],
  pattern: RegExp
): string[] {
  const values = new Set<string>();
  const deadline = Date.now() + EXTRACTION_DEADLINE_MS;
  for (const chunk of included) {
    pattern.lastIndex = 0;
    const matches = chunk.content.matchAll(pattern);
    for (const match of matches) {
      if (values.size >= MAX_MATCHES || Date.now() > deadline) {
        return Array.from(values);
      }
      const value = match[1]?.trim();
      if (value) values.add(value);
    }
  }
  return Array.from(values);
}

function formatChunk(result: SearchResult): string {
  const lang = result.language || "";
  const location = `Lines ${result.startLine}-${result.endLine}: ${result.kind} ${result.name}`;
  return `\`\`\`${lang}\n// ${location}\n${result.content}\n\`\`\`\n`;
}
