import { encoding_for_model } from "tiktoken";
import type { ContextCompressionMetadata, SearchResult, AssembledContext } from "./types.js";
import type { StackTree } from "./tree-builder.js";
import type { StoredChunk } from "../storage/types.js";
import { getLogger } from "../core/logger.js";
import { compressEvidenceChunk, type EvidenceCompressionMode, type EvidenceCompressionResult } from "./evidence-compressor.js";

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

function buildFileListLine(chunks: SearchResult[], maxFiles = 8): string {
  const files = [...new Set(chunks.map(c => c.filePath))];
  if (files.length === 0) return "";
  const shown = files.slice(0, maxFiles);
  const suffix = files.length > maxFiles ? ` (+${files.length - maxFiles} more)` : "";
  return `> Files included: ${shown.join(", ")}${suffix}\n`;
}

export interface AssembleOptions {
  scoreFloorRatio?: number;   // default 0.7
  maxChunks?: number;         // default Infinity (no cap unless config passes one)
  directiveHeader?: boolean;  // default true
  query?: string;
  factExtractors?: Array<{ keyword: string; pattern: string; label: string }>;
  compressionRank?: number;   // chunks after this rank use compressed format (default: undefined = no compression)
  contextCompressionEnabled?: boolean;
  contextCompressionMode?: EvidenceCompressionMode;
  contextCompressionPreserveTopChunks?: number;
  contextCompressionMinChunkTokens?: number;
  contextCompressionTargetRatio?: number;
}

interface RenderedChunk {
  result: SearchResult;
  text: string;
  fullText: string;
  tokenCount: number;
  fullTokenCount: number;
  compressed: boolean;
  compression?: EvidenceCompressionResult;
}

export type ConceptContextKind = "ast" | "call_graph" | "search_pipeline" | "storage" | "daemon" | "embedding" | "cli" | "context_assembly" | (string & {});

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

  const scoreFloorRatio = opts.scoreFloorRatio ?? 0.7;
  const maxChunks = opts.maxChunks ?? Infinity;
  const directiveHeader = opts.directiveHeader ?? true;
  const compressionMode = opts.contextCompressionMode ?? "auto";
  const compressionEnabled =
    opts.contextCompressionEnabled !== false && compressionMode !== "off";
  const preserveTopChunks =
    opts.compressionRank ?? opts.contextCompressionPreserveTopChunks ?? 1;
  const minChunkTokens = opts.contextCompressionMinChunkTokens ?? 100;
  const targetRatio = opts.contextCompressionTargetRatio ?? 0.75;

  const included: SearchResult[] = [];
  const rendered: RenderedChunk[] = [];
  let totalTokens = 0;

  // Header — file list is added after chunk assembly (placeholder budget for now)
  const baseHeader = "## Relevant codebase context\n\n";
  const directiveLine = "> Answer from this context first. Only fetch files NOT listed above.\n\n";
  const fileListFileCount = results.length > 0
    ? Math.min(new Set(results.map((r) => r.filePath)).size, 8)
    : 0;
  const fileListEstimate = fileListFileCount > 0
    ? countTokens("> Files included: ") + fileListFileCount * 12
    : 0;
  const headerBudget = countTokens(baseHeader)
    + fileListEstimate
    + (directiveHeader ? countTokens(directiveLine) : 0);
  totalTokens += headerBudget;

  // Drop results scoring below scoreFloorRatio of the top result
  const scoreFloor = results.length > 0 ? (results[0]?.score ?? 0) * scoreFloorRatio : 0;

  // Track file headers already emitted
  const emittedHeaders = new Set<string>();

  // Reserve space for summary/facts that will be appended after the loop
  const SUMMARY_RESERVE = 80;

  for (const result of results) {
    if (included.length >= maxChunks) break;
    if (result.score < scoreFloor) continue;
    const fullText = formatChunk(result);
    const fullTokens = countTokens(fullText);
    const shouldPreferCompressed =
      compressionEnabled
      && (
        compressionMode === "always"
        || opts.compressionRank !== undefined && included.length >= opts.compressionRank
        || included.length >= preserveTopChunks
      );

    let candidate = buildRenderedChunk(
      result,
      fullText,
      fullTokens,
      shouldPreferCompressed,
      opts.query,
      minChunkTokens,
      targetRatio
    );

    const fileHeader = `### ${result.filePath}\n`;
    let fileHeaderTokens = candidate.compressed || emittedHeaders.has(result.filePath) ? 0 : countTokens(fileHeader);

    if (totalTokens + fileHeaderTokens + candidate.tokenCount > tokenBudget - SUMMARY_RESERVE) {
      if (compressionEnabled && !candidate.compressed) {
        const compactCandidate = buildRenderedChunk(
          result,
          fullText,
          fullTokens,
          true,
          opts.query,
          minChunkTokens,
          targetRatio
        );
        if (compactCandidate.compressed) {
          candidate = compactCandidate;
          fileHeaderTokens = 0;
        }
      }
    }

    if (totalTokens + fileHeaderTokens + candidate.tokenCount > tokenBudget - SUMMARY_RESERVE) {
      if (compressionEnabled || opts.compressionRank !== undefined) {
        continue;
      }
      break;
    }

    if (!candidate.compressed && !emittedHeaders.has(result.filePath)) {
      emittedHeaders.add(result.filePath);
      totalTokens += fileHeaderTokens;
    }

    totalTokens += candidate.tokenCount;
    included.push(result);
    rendered.push(candidate);
  }

  // Build direct facts (skip summary — chunk list is redundant with the chunks themselves)
  const factsSection = buildDirectFactsSection(opts.query, included, opts.factExtractors);
  const factsTokens = factsSection ? countTokens(factsSection) : 0;
  const includeFacts =
    included.length > 0 &&
    !!factsSection &&
    totalTokens + factsTokens <= tokenBudget;
  if (includeFacts) {
    totalTokens += factsTokens;
  }

  // Build final header with file list
  const fileListLine = buildFileListLine(included);
  const header = directiveHeader && fileListLine
    ? baseHeader + fileListLine + directiveLine
    : baseHeader + fileListLine;
  const actualHeaderTokens = countTokens(header);
  totalTokens = totalTokens - headerBudget + actualHeaderTokens;

  // Build final text — emit chunks in score order with file headers interspersed
  const parts: string[] = [header];

  if (includeFacts && factsSection) {
    parts.push(factsSection);
    parts.push("");
  }

  const seenFiles = new Set<string>();

  for (const entry of rendered) {
    const chunk = entry.result;
    if (!entry.compressed && !seenFiles.has(chunk.filePath)) {
      if (seenFiles.size > 0) parts.push(""); // blank line between file groups
      parts.push(`### ${chunk.filePath}\n`);
      seenFiles.add(chunk.filePath);
    }
    parts.push(entry.text);
  }
  if (included.length > 0) parts.push("");

  const finalText = parts.join("\n");
  const finalTokenCount = countTokens(finalText);
  const compression = buildCompressionMetadata(
    compressionEnabled,
    compressionMode,
    header,
    includeFacts ? factsSection : null,
    rendered,
    finalTokenCount
  );

  const log = getLogger();
  log.debug({
    inputResults: results.length,
    scoreFloor: +scoreFloor.toFixed(3),
    includedChunks: included.length,
    droppedByScoreFloor: results.filter(r => r.score < scoreFloor).length,
    droppedByBudget: results.filter(r => r.score >= scoreFloor).length - included.length,
    totalTokens: finalTokenCount,
    tokenBudget,
    compressedChunks: compression.compressedChunks,
    compressionTokensSaved: compression.tokensSaved,
  }, "context assembly complete");

  return {
    text: finalText,
    tokenCount: finalTokenCount,
    chunks: included,
    routeStyle: "standard",
    deliveryMode: "code_context",
    compression,
  };
}

function buildRenderedChunk(
  result: SearchResult,
  fullText: string,
  fullTokens: number,
  preferCompressed: boolean,
  query: string | undefined,
  minChunkTokens: number,
  targetRatio: number
): RenderedChunk {
  if (!preferCompressed || fullTokens < minChunkTokens) {
    return {
      result,
      text: fullText,
      fullText,
      tokenCount: fullTokens,
      fullTokenCount: fullTokens,
      compressed: false,
    };
  }

  const compression = compressEvidenceChunk(result, {
    query,
    minChunkTokens,
    targetRatio,
  });
  const compressedTokens = countTokens(compression.text);
  const ratio = fullTokens > 0 ? compressedTokens / fullTokens : 1;
  const worthwhile = compression.text.trim().length > 0
    && compressedTokens < fullTokens
    && ratio <= targetRatio;

  if (!worthwhile) {
    return {
      result,
      text: fullText,
      fullText,
      tokenCount: fullTokens,
      fullTokenCount: fullTokens,
      compressed: false,
    };
  }

  return {
    result,
    text: compression.text,
    fullText,
    tokenCount: compressedTokens,
    fullTokenCount: fullTokens,
    compressed: true,
    compression,
  };
}

function buildCompressionMetadata(
  enabled: boolean,
  mode: EvidenceCompressionMode,
  header: string,
  factsSection: string | null,
  rendered: RenderedChunk[],
  finalTokenCount: number
): ContextCompressionMetadata {
  const fullParts: string[] = [header];
  if (factsSection) {
    fullParts.push(factsSection);
    fullParts.push("");
  }

  const seenFiles = new Set<string>();
  for (const entry of rendered) {
    const chunk = entry.result;
    if (!seenFiles.has(chunk.filePath)) {
      if (seenFiles.size > 0) fullParts.push("");
      fullParts.push(`### ${chunk.filePath}\n`);
      seenFiles.add(chunk.filePath);
    }
    fullParts.push(entry.fullText);
  }
  if (rendered.length > 0) fullParts.push("");

  const tokensBeforeCompression = countTokens(fullParts.join("\n"));
  const compressedEntries = rendered.filter((entry) => entry.compressed && entry.compression);
  const strategies: Record<string, number> = {};
  for (const entry of compressedEntries) {
    const strategy = entry.compression?.strategy;
    if (!strategy) continue;
    strategies[strategy] = (strategies[strategy] ?? 0) + 1;
  }

  const tokensSaved = Math.max(0, tokensBeforeCompression - finalTokenCount);
  return {
    enabled,
    mode,
    tokensBeforeCompression,
    tokensAfterCompression: finalTokenCount,
    tokensSaved,
    savingsRatio: tokensBeforeCompression > 0 ? tokensSaved / tokensBeforeCompression : 0,
    fullChunks: rendered.length - compressedEntries.length,
    compressedChunks: compressedEntries.length,
    originalRefs: compressedEntries.flatMap((entry) =>
      entry.compression ? [entry.compression.originalRef] : []
    ),
    strategies,
  };
}

function buildDirectFactsSection(
  query: string | undefined,
  included: SearchResult[],
  factExtractors?: Array<{ keyword: string; pattern: string; label: string }>
): string | null {
  const log = getLogger();
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
      } catch (err) {
        log.warn(
          {
            label: extractor.label,
            keyword: extractor.keyword,
            pattern: extractor.pattern,
            error: err instanceof Error ? err.message : String(err),
          },
          "skipping invalid fact extractor regex"
        );
        continue; // Skip invalid patterns (safety net if bypassing config validation)
      }
      const matches = extractUniqueMatches(included, regex);
      if (matches.length > 0) {
        facts.push(`- ${extractor.label}: ${matches.join(", ")}`);
      }
    }
  }

  return facts.length > 0
    ? `## Direct facts\n${facts.join("\n")}`
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

  if (
    /\b(where\s+is|defined|definition|find|show)\b/.test(lowerQuery) &&
    included.length > 0
  ) {
    const primary = included[0];
    if (primary) {
      facts.push(
        `- Primary location: \`${primary.name}\` is defined in \`${primary.filePath}:${primary.startLine}-${primary.endLine}\`.`
      );
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

function longestBacktickRun(content: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of content) {
    if (ch === "`") {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function formatChunk(result: SearchResult): string {
  const lang = result.language || "";
  const location = `Lines ${result.startLine}-${result.endLine}: ${result.kind} ${result.name}`;
  const fence = "`".repeat(Math.max(3, longestBacktickRun(result.content) + 1));
  return `${fence}${lang}\n// ${location}\n${result.content}\n${fence}\n`;
}

// --- Metadata-aware chunk type for hydration ---

interface HydratableMetadata {
  getChunksByIds(ids: string[]): StoredChunk[];
}

function storedChunkToSearchResult(chunk: StoredChunk, score: number = 1.0): SearchResult {
  return {
    id: chunk.id,
    score,
    filePath: chunk.filePath,
    name: chunk.name,
    kind: chunk.kind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    docstring: chunk.docstring,
    parentName: chunk.parentName,
    language: chunk.language,
  };
}

// --- Flow context assembly (R1) ---

function tokenizeFlowAssemblyQuery(query?: string): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function countFlowQueryMatches(terms: string[], ...texts: Array<string | undefined>): number {
  if (terms.length === 0) return 0;
  const haystack = texts
    .filter((text): text is string => !!text)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]/g, " ");
  let count = 0;
  for (const term of terms) {
    const prefix = term.length >= 6 ? term.slice(0, 4) : term;
    if (haystack.includes(term) || (prefix.length >= 4 && haystack.includes(prefix))) count++;
  }
  return count;
}

function commonFlowPathPrefixLength(left: string, right: string): number {
  const leftParts = left.toLowerCase().split("/").filter(Boolean);
  const rightParts = right.toLowerCase().split("/").filter(Boolean);
  let count = 0;
  while (count < leftParts.length && count < rightParts.length && leftParts[count] === rightParts[count]) {
    count++;
  }
  return count;
}

function inferFlowFamilies(queryTerms: string[]) {
  return {
    auth: queryTerms.some((term) => /^auth|token|session|login|signin|credential|callback|redirect|protect/.test(term)),
    generation: queryTerms.some((term) => /^image|generate|generation|render|shot|regen/.test(term)),
    billing: queryTerms.some((term) => /^bill|checkout|portal|subscription|invoice|payment|credit|customer/.test(term)),
    upload: queryTerms.some((term) => /^upload|storage|media|signed|bucket|file/.test(term)),
  };
}

function scoreFlowChunkAffinity(
  chunk: StoredChunk,
  seedChunk: StoredChunk,
  queryTerms: string[],
  families: ReturnType<typeof inferFlowFamilies>,
  direction: "caller" | "callee",
  implementationFirst: boolean,
  callerFocused: boolean,
  nodeDepth: number = 99
): number {
  let score = 0;
  const sameFile = chunk.filePath === seedChunk.filePath;
  const prefix = commonFlowPathPrefixLength(seedChunk.filePath, chunk.filePath);
  const queryMatches = countFlowQueryMatches(
    queryTerms,
    chunk.filePath,
    chunk.name,
    chunk.parentName,
    chunk.docstring
  );
  const fileText = `${chunk.filePath} ${chunk.name} ${chunk.parentName ?? ""}`.toLowerCase();
  const sharedFile = /(?:^|\/)_shared\//.test(chunk.filePath);
  const seedInHooks = /(?:^|\/)hooks\//.test(seedChunk.filePath);
  const seedInEndpoint = /supabase\/functions\//.test(seedChunk.filePath);
  const candidateInUi = /(?:^|\/)(pages|components|routes)\//.test(chunk.filePath);
  const candidateInClient = /^src\//.test(chunk.filePath);

  if (sameFile) score += 140;
  score += prefix * 18;
  score += queryMatches * 35;

  if (implementationFirst) {
    if (direction === "callee") score += 8;
    if (direction === "caller") score -= 8;
  }
  if (callerFocused) {
    if (direction === "caller") score += 40;
    if (direction === "callee") score -= 10;
  }
  if (implementationFirst && direction === "caller" && !callerFocused) {
    if (seedInHooks && candidateInUi && queryMatches < 2) score -= 70;
    if (seedInEndpoint && candidateInClient && queryMatches < 2) score -= 75;
  }
  // Penalize generic workers and shared middleware when the query isn't about them
  if (/\/workers\//.test(chunk.filePath) && !queryTerms.some((t) => /\bworker\b/.test(t))) {
    score -= 150;
  }
  if (/\/(?:cors|rate[-_]?limit)[^/]*\./.test(chunk.filePath) && !queryTerms.some((t) => /\b(cors|rate|limit|middleware)\b/.test(t)) && queryMatches < 1) {
    score -= 100;
  }
  // For hook seeds: suppress callers with zero query-term overlap (they are just importers, not related)
  if (seedInHooks && direction === "caller" && queryMatches === 0) {
    score -= 100;
  }

  if (families.auth) {
    if (/(auth|callback|protected|session|login|signin|redirect|token)/.test(fileText)) score += 30;
    if (/(storage|analytics|project|dashboard|admin)/.test(fileText)) score -= 35;
    if (/(?:cors|rate[-_]?limit|logger)/.test(fileText)) score -= 25;
  }
  if (families.generation) {
    if (/(generate|generation|render|image|shot|regener)/.test(fileText)) score += 30;
    if (/(upload|storage|media|bucket)/.test(fileText)) score -= 25;
  }
  if (families.billing) {
    if (/(billing|checkout|portal|subscription|invoice|payment|customer|credit)/.test(fileText)) score += 28;
    if (/(analytics|dashboard|project)/.test(fileText)) score -= 20;
  }
  if (families.upload) {
    if (/(upload|storage|media|signed|bucket|file)/.test(fileText)) score += 24;
    if (families.auth && /auth/.test(fileText)) score += 18;
  }

  if (sharedFile && queryMatches === 0 && !families.auth && !families.billing && !families.generation && !families.upload) {
    score -= 22;
  }
  // Skip harsh penalty for direct neighbors (depth 1) — they're in the call graph and always relevant
  if (queryTerms.length > 0 && !sameFile && prefix < 2 && queryMatches === 0 && nodeDepth > 1) score -= 60;
  if (/schema|migration|fixture|example|test|spec/i.test(chunk.filePath)) score -= 120;

  return score;
}

interface FlowEntry {
  node: StackTree["upTree"][number];
  chunk: StoredChunk;
  result: SearchResult;
  score: number;
  sameFile: boolean;
  filePath: string;
  depth: number;
}

function selectFlowEntries(
  entries: FlowEntry[],
  tokenBudget: number,
  totalTokens: number,
  summaryReserve: number,
  implementationFirst: boolean,
  callerFocused: boolean,
  direction: "caller" | "callee",
  query: string | undefined,
  compressionEnabled: boolean,
  minChunkTokens: number,
  targetRatio: number
): { parts: string[]; results: SearchResult[]; rendered: RenderedChunk[]; totalTokens: number } {
  const parts: string[] = [];
  const results: SearchResult[] = [];
  const rendered: RenderedChunk[] = [];
  const seenFiles = new Set<string>();
  let currentTokens = totalTokens;
  let crossFileCount = 0;
  const maxCrossFile = implementationFirst
    ? (callerFocused ? (direction === "caller" ? 2 : 1) : (direction === "callee" ? 2 : 1))
    : 3;
  const maxEntries = implementationFirst ? 3 : 4;

  for (const entry of entries) {
    if (!entry.sameFile) {
      if (crossFileCount >= maxCrossFile) continue;
      // Depth-1 nodes (direct callers/callees) get a lower threshold — they're in the call graph.
      // Depth > 1 still needs a high bar to avoid noise from distant nodes.
      const scoreThreshold = implementationFirst ? (entry.depth === 1 ? 10 : 45) : 0;
      if (entry.score < scoreThreshold) continue;
    }

    const chunkLines = entry.chunk.endLine - entry.chunk.startLine + 1;
    const useCompressed = parts.length >= 1 || chunkLines > 80 || (!entry.sameFile && results.length >= 1);
    const fullText = formatChunk(entry.result);
    const fullTokens = countTokens(fullText);
    const candidate = buildRenderedChunk(
      entry.result,
      fullText,
      fullTokens,
      compressionEnabled && useCompressed,
      query,
      minChunkTokens,
      targetRatio
    );
    if (currentTokens + candidate.tokenCount > tokenBudget - summaryReserve) continue;

    currentTokens += candidate.tokenCount;
    parts.push(candidate.text);
    results.push(entry.result);
    rendered.push(candidate);
    seenFiles.add(entry.filePath);
    if (!entry.sameFile) crossFileCount++;
    if (results.length >= maxEntries) break;
  }

  return { parts, results, rendered, totalTokens: currentTokens };
}

function describeChunk(chunk: SearchResult | StoredChunk | undefined): string | null {
  if (!chunk) return null;
  return `\`${chunk.name}\` (${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`;
}

function buildConceptFacts(
  kind: ConceptContextKind,
  chunks: SearchResult[]
): string[] {
  const byName = new Map(chunks.map((chunk) => [chunk.name, chunk]));

  const CONCEPT_FACTS: Record<string, (m: Map<string, SearchResult>) => string[]> = {
    ast: (m) => [
      `Main entry point: ${describeChunk(m.get("chunkFileWithCalls")) ?? "`chunkFileWithCalls`"} parses a file, builds the syntax tree, and orchestrates chunk, import, and call-edge extraction.`,
      `Parser setup: ${describeChunk(m.get("initTreeSitter")) ?? "`initTreeSitter`"} initializes Tree-sitter, and ${describeChunk(m.get("createParser")) ?? "`createParser`"} creates the parser instance for the loaded grammar.`,
      `AST traversal: ${describeChunk(m.get("walkForExtractables")) ?? "`walkForExtractables`"} walks the tree for extractable nodes, while ${describeChunk(m.get("extractName")) ?? "`extractName`"} derives stable symbol names for chunks.`,
    ],
    call_graph: (m) => [
      `Main entry point: ${describeChunk(m.get("extractCallEdges")) ?? "`extractCallEdges`"} walks AST call sites and emits persisted call edges.`,
      `Callee resolution: ${describeChunk(m.get("extractCalleeInfo")) ?? "`extractCalleeInfo`"} resolves the callee name and receiver, and ${describeChunk(m.get("extractReceiver")) ?? "`extractReceiver`"} normalizes chained member receivers.`,
      `Consumers: ${describeChunk(m.get("graphCommand")) ?? "`graphCommand`"} exposes the CLI view, and ${describeChunk(m.get("buildStackTree")) ?? "`buildStackTree`"} builds higher-level caller/callee navigation from stored edges.`,
    ],
    search_pipeline: (m) => [
      `Routing: ${describeChunk(m.get("classifyIntent")) ?? "`classifyIntent`"} classifies the query into lookup, trace, bug, architecture, or change, and ${describeChunk(m.get("handlePromptContextDetailed")) ?? "`handlePromptContextDetailed`"} dispatches the chosen mode.`,
      `Lookup and bug retrieval: ${describeChunk(m.get("searchWithContext")) ?? "`searchWithContext`"} builds the prompt bundle, while ${describeChunk(m.get("search")) ?? "`search`"} runs retrieve, fuse, expand, and hydrate.`,
      `Trace path: ${describeChunk(m.get("resolveSeeds")) ?? "`resolveSeeds`"} chooses seeds for implementation traces, and weak broad architecture candidates degrade to summary-only guidance instead of noisy code bundles.`,
    ],
    storage: (m) => [
      `Facade: ${describeChunk(m.get("MetadataStore")) ?? "`MetadataStore`"} delegates to sub-stores for chunks, call edges, stats, conventions, and imports.`,
      `Keyword search: ${describeChunk(m.get("FTSStore")) ?? "`FTSStore`"} provides FTS5 full-text search with Porter stemming and camelCase splitting.`,
      `Chunk persistence: ${describeChunk(m.get("ChunkStore")) ?? "`ChunkStore`"} stores parsed code chunks with schema migrations and batch queries.`,
    ],
    daemon: (m) => [
      `Server: ${describeChunk(m.get("createDaemonServer")) ?? "`createDaemonServer`"} creates the HTTP server with bearer auth, rate limiting, and hook endpoints.`,
      `Query processing: ${describeChunk(m.get("sanitizeQuery")) ?? "`sanitizeQuery`"} strips code fragments from hook payloads before intent classification.`,
      `Incremental updates: ${describeChunk(m.get("IndexScheduler")) ?? "`IndexScheduler`"} queues file changes from the watcher and flushes them through the pipeline.`,
    ],
    embedding: (m) => [
      `Local embedder: ${describeChunk(m.get("LocalEmbedder")) ?? "`LocalEmbedder`"} runs all-MiniLM-L6-v2 in-process via ONNX for zero-dependency vector encoding.`,
      `Keyword fallback: ${describeChunk(m.get("NullEmbedder")) ?? "`NullEmbedder`"} provides a no-op embedder for keyword-only mode.`,
      `Remote provider: ${describeChunk(m.get("OllamaEmbedder")) ?? "`OllamaEmbedder`"} connects to Ollama with circuit breaker and retry logic.`,
    ],
    cli: (m) => [
      `Entry point: ${describeChunk(m.get("createCLI")) ?? "`createCLI`"} registers all commands using Commander.`,
      `Initialization: ${describeChunk(m.get("initCommand")) ?? "`initCommand`"} sets up .memory/, hooks, and .mcp.json configuration.`,
      `Daemon startup: ${describeChunk(m.get("serveCommand")) ?? "`serveCommand`"} manages the daemon lifecycle with PID locking and graceful shutdown.`,
    ],
    context_assembly: (m) => [
      `Standard assembly: ${describeChunk(m.get("assembleContext")) ?? "`assembleContext`"} builds token-budgeted context from ranked search results.`,
      `Concept assembly: ${describeChunk(m.get("assembleConceptContext")) ?? "`assembleConceptContext`"} builds subsystem-specific context bundles with targeted facts.`,
      `Token counting: ${describeChunk(m.get("countTokens")) ?? "`countTokens`"} uses tiktoken gpt-4o encoding for accurate budget tracking.`,
    ],
  };

  const factBuilder = CONCEPT_FACTS[kind];
  if (factBuilder) {
    return factBuilder(byName).map((fact) => `- ${fact}`);
  }

  // Generic fallback for user-defined concept kinds
  const names = chunks.slice(0, 3).map((c) => describeChunk(c) ?? `\`${c.name}\``);
  return names.map((n) => `- Key symbol: ${n}`);
}

export function assembleConceptContext(
  kind: ConceptContextKind,
  chunks: SearchResult[],
  tokenBudget: number
): AssembledContext {
  const CONCEPT_TITLES: Record<string, string> = {
    ast: "AST pipeline",
    call_graph: "call graph",
    search_pipeline: "search pipeline",
    storage: "storage layer",
    daemon: "daemon server",
    embedding: "embedding system",
    cli: "CLI commands",
    context_assembly: "context assembly",
  };
  const title = CONCEPT_TITLES[kind] ?? kind.replace(/_/g, " ");
  const header =
    `## Relevant codebase context (${title})\n\n`;
  const facts = `## Direct facts\n${buildConceptFacts(kind, chunks).join("\n")}\n\n`;

  let totalTokens = countTokens(header) + countTokens(facts);
  const included: SearchResult[] = [];
  const parts: string[] = [header, facts];

  for (const chunk of chunks) {
    const chunkText = formatChunk(chunk);
    const chunkTokens = countTokens(chunkText);
    if (totalTokens + chunkTokens > tokenBudget) break;
    totalTokens += chunkTokens;
    included.push(chunk);
    parts.push(chunkText);
  }

  if (included.length > 0) {
    parts.push("");
  }

  return {
    text: parts.join("\n"),
    tokenCount: totalTokens,
    chunks: included,
    routeStyle: "concept",
    deliveryMode: "code_context",
  };
}

/**
 * Assemble context from a StackTree (flow trace) for the R1 route.
 *
 * Hydrates tree nodes into full chunk content, then builds a structured
 * flow-trace document with callers, seed, and callees sections.
 *
 * @param tree - The StackTree built by buildStackTree
 * @param metadata - MetadataStore (or any object with getChunksByIds)
 * @param tokenBudget - Maximum tokens for the assembled context
 * @param query - Optional query string for header metadata
 * @returns AssembledContext with text, tokenCount, and chunks
 */
export function assembleFlowContext(
  tree: StackTree,
  metadata: HydratableMetadata,
  tokenBudget: number,
  query?: string,
  options: Pick<AssembleOptions,
    "contextCompressionEnabled"
    | "contextCompressionMode"
    | "contextCompressionPreserveTopChunks"
    | "contextCompressionMinChunkTokens"
    | "contextCompressionTargetRatio"
  > = {}
): AssembledContext {
  const log = getLogger();
  const SUMMARY_RESERVE = 80;
  const implementationFirst =
    !!query && /\b(how\s+does|how\s+do|how\s+is|why\s+does|why\s+is|what\s+happens|work|works|implemented|implementation|fail|fails|failing|failure|error|broken)\b/i.test(query);
  const callerFocused =
    !!query && /\b(who|what)\s+calls\b|\bcalled\s+by\b|\bwhere\s+is\b.*\bused\b|\busage\b/i.test(query);
  const queryTerms = tokenizeFlowAssemblyQuery(query);
  const families = inferFlowFamilies(queryTerms);
  const compressionMode = options.contextCompressionMode ?? "auto";
  const compressionEnabled =
    options.contextCompressionEnabled !== false && compressionMode !== "off";
  const minChunkTokens = options.contextCompressionMinChunkTokens ?? 100;
  const targetRatio = options.contextCompressionTargetRatio ?? 0.75;

  // Collect all node IDs for bulk hydration
  const allNodeIds = [
    tree.seed.chunkId,
    ...tree.upTree.map((n) => n.chunkId),
    ...tree.downTree.map((n) => n.chunkId),
  ];
  const storedChunks = metadata.getChunksByIds(allNodeIds);
  const chunkMap = new Map<string, StoredChunk>();
  for (const chunk of storedChunks) {
    chunkMap.set(chunk.id, chunk);
  }

  // If seed chunk was deleted between resolution and assembly, return empty context
  const seedChunk = chunkMap.get(tree.seed.chunkId);
  if (!seedChunk) {
    log.warn(
      {
        seedChunkId: tree.seed.chunkId,
        seedName: tree.seed.name,
        nodeCount: tree.nodeCount,
      },
      "flow context assembly skipped because the seed chunk could not be hydrated"
    );
    return { text: "", tokenCount: 0, chunks: [], routeStyle: "flow", deliveryMode: "code_context" };
  }

  // Build header
  const seedInfo = `${tree.seed.name} (${tree.seed.kind}, ${seedChunk.filePath}:${seedChunk.startLine}-${seedChunk.endLine})`;

  // Header is built after chunk assembly to include file list; estimate its
  // tokens from the title, file list (up to 8 paths), directive, and seed line.
  const flowFileCount = Math.min(
    new Set(
      [seedChunk.filePath, ...tree.upTree.map((n) => n.filePath), ...tree.downTree.map((n) => n.filePath)]
        .filter((p): p is string => Boolean(p))
    ).size,
    8
  );
  const flowTitle = "## Relevant codebase context (flow trace)\n\n";
  const flowDirective = "> Answer from this context first. The flow trace below shows the call graph from the seed.\n";
  const headerEstimate = countTokens(flowTitle)
    + (flowFileCount > 0 ? countTokens("> Files included: ") + flowFileCount * 12 : 0)
    + countTokens(flowDirective)
    + countTokens(`> Seed: ${seedInfo}\n\n`);
  let totalTokens = headerEstimate;
  const included: SearchResult[] = [];

  // Always include seed
  const seedResult = storedChunkToSearchResult(seedChunk);
  const seedSection = `> Flow seed\n\n` + formatChunk(seedResult);
  const seedTokens = countTokens(seedSection);
  const seedRendered: RenderedChunk = {
    result: seedResult,
    text: seedSection,
    fullText: seedSection,
    tokenCount: seedTokens,
    fullTokenCount: seedTokens,
    compressed: false,
  };

  // Seed always gets included even if it fills the budget
  if (seedTokens > tokenBudget - SUMMARY_RESERVE) {
    log.warn({ seedName: tree.seed.name, seedTokens, tokenBudget }, "seed chunk exceeds token budget — callers/callees may be truncated");
  }
  totalTokens += seedTokens;
  included.push(seedResult);

  // Build callers section (sorted by depth descending: entry point first)
  const callersSorted = [...tree.upTree]
    .map((node) => {
      const chunk = chunkMap.get(node.chunkId);
      if (!chunk) return null;
      return {
        node,
        chunk,
        result: storedChunkToSearchResult(chunk, 0.8),
        score: scoreFlowChunkAffinity(chunk, seedChunk, queryTerms, families, "caller", implementationFirst, callerFocused, node.depth) + node.depth * 4,
        sameFile: chunk.filePath === seedChunk.filePath,
        filePath: chunk.filePath,
        depth: node.depth,
      } satisfies FlowEntry;
    })
    .filter((entry): entry is FlowEntry => !!entry)
    .sort((a, b) => b.score - a.score || b.node.depth - a.node.depth);
  const selectedCallers = selectFlowEntries(
    callersSorted,
    tokenBudget,
    totalTokens,
    SUMMARY_RESERVE,
    implementationFirst,
    callerFocused,
    "caller",
    query,
    compressionEnabled,
    minChunkTokens,
    targetRatio
  );
  totalTokens = selectedCallers.totalTokens;
  const callerParts = selectedCallers.parts;
  const callerResults = selectedCallers.results;

  // Build callees section (sorted by depth ascending: nearest first)
  const calleesSorted = [...tree.downTree]
    .map((node) => {
      const chunk = chunkMap.get(node.chunkId);
      if (!chunk) return null;
      return {
        node,
        chunk,
        result: storedChunkToSearchResult(chunk, 0.7),
        score: scoreFlowChunkAffinity(chunk, seedChunk, queryTerms, families, "callee", implementationFirst, callerFocused, node.depth) - node.depth * 3,
        sameFile: chunk.filePath === seedChunk.filePath,
        filePath: chunk.filePath,
        depth: node.depth,
      } satisfies FlowEntry;
    })
    .filter((entry): entry is FlowEntry => !!entry)
    .sort((a, b) => b.score - a.score || a.node.depth - b.node.depth);
  const selectedCallees = selectFlowEntries(
    calleesSorted,
    tokenBudget,
    totalTokens,
    SUMMARY_RESERVE,
    implementationFirst,
    callerFocused,
    "callee",
    query,
    compressionEnabled,
    minChunkTokens,
    targetRatio
  );
  totalTokens = selectedCallees.totalTokens;
  const calleeParts = selectedCallees.parts;
  const calleeResults = selectedCallees.results;

  // Build final header with file list from all collected chunks
  const allFlowChunks = [seedResult, ...callerResults, ...calleeResults];
  const flowFileList = buildFileListLine(allFlowChunks);
  const header =
    `## Relevant codebase context (flow trace)\n\n` +
    flowFileList +
    `> Answer from this context first. The flow trace below shows the call graph from the seed.\n` +
    `> Seed: ${seedInfo}\n\n`;
  const actualHeaderTokens = countTokens(header);
  totalTokens = totalTokens - headerEstimate + actualHeaderTokens;
  const parts: string[] = [header];

  const appendCallers = () => {
    if (callerParts.length === 0) return;
    parts.push(`> Callers (who invokes this)\n`);
    parts.push(...callerParts);
    included.push(...callerResults);
  };
  const appendCallees = () => {
    if (calleeParts.length === 0) return;
    parts.push(`> Callees (what this invokes)\n`);
    parts.push(...calleeParts);
    included.push(...calleeResults);
  };

  if (implementationFirst && !callerFocused) {
    parts.push(seedRendered.text);
    appendCallees();
    appendCallers();
  } else {
    appendCallers();
    parts.push(seedRendered.text);
    appendCallees();
  }

  parts.push("");
  const finalText = parts.join("\n");
  const finalTokenCount = countTokens(finalText);
  const renderedForMetadata = [seedRendered, ...selectedCallers.rendered, ...selectedCallees.rendered];
  const compression = buildCompressionMetadata(
    compressionEnabled,
    compressionMode,
    header,
    null,
    renderedForMetadata,
    finalTokenCount
  );

  log.debug({
    seedName: tree.seed.name,
    upTreeCount: tree.upTree.length,
    downTreeCount: tree.downTree.length,
    includedChunks: included.length,
    totalTokens: finalTokenCount,
    tokenBudget,
    coverage: tree.coverage,
    compressedChunks: compression.compressedChunks,
    compressionTokensSaved: compression.tokensSaved,
  }, "flow context assembly complete");

  return {
    text: finalText,
    tokenCount: finalTokenCount,
    chunks: included,
    routeStyle: "flow",
    deliveryMode: "code_context",
    compression,
  };
}

// --- Deep route context assembly (R2) ---

function buildDeepRouteHeader(chunks: SearchResult[]): string {
  const fileList = buildFileListLine(chunks);
  return (
    `## Relevant codebase context (broad search)\n\n` +
    fileList +
    `> Answer from this context first. If coverage is incomplete, Reporecall MCP tools can fill gaps.\n\n`
  );
}

/**
 * Assemble context for the R2 (deep) route. Wraps the regular chunk-based
 * assembleContext output with a low-confidence marker and MCP guidance.
 *
 * @param chunks - SearchResult array from hybrid search
 * @param tokenBudget - Maximum tokens for the assembled context
 * @param query - Optional query string
 * @returns AssembledContext with low-confidence header prepended
 */
export function assembleDeepRouteContext(
  chunks: SearchResult[],
  tokenBudget: number,
  query?: string,
  options: Pick<AssembleOptions,
    "contextCompressionEnabled"
    | "contextCompressionMode"
    | "contextCompressionPreserveTopChunks"
    | "contextCompressionMinChunkTokens"
    | "contextCompressionTargetRatio"
  > = {}
): AssembledContext {
  // Reserve a generous estimate for the header (file list varies); adjust after assembly
  const headerEstimate = 60;
  const remainingBudget = Math.max(0, tokenBudget - headerEstimate);

  // Use existing assembleContext with reduced budget and no directive header
  // (the deep route header replaces it)
  const baseContext = assembleContext(chunks, remainingBudget, {
    scoreFloorRatio: 0.35,
    directiveHeader: false,
    query,
    maxChunks: 5,
    compressionRank: options.contextCompressionPreserveTopChunks ?? 3,
    contextCompressionEnabled: options.contextCompressionEnabled,
    contextCompressionMode: options.contextCompressionMode,
    contextCompressionPreserveTopChunks: options.contextCompressionPreserveTopChunks,
    contextCompressionMinChunkTokens: options.contextCompressionMinChunkTokens,
    contextCompressionTargetRatio: options.contextCompressionTargetRatio,
  });

  // Build final header with actual file list from assembled chunks
  const deepHeader = buildDeepRouteHeader(baseContext.chunks);

  // The base context was assembled with directiveHeader:false, so it still
  // begins with "## Relevant codebase context\n\n> Files included: ...\n".
  // Strip that entire prefix — buildDeepRouteHeader already rebuilds a complete
  // (broad-search) header carrying the same file list, so leaving the base
  // file-list line in place would emit it twice (and miscount tokens).
  const strippedPrefixRe = /^## Relevant codebase context\n\n(?:> Files included:[^\n]*\n)?\n?/;
  const prefixMatch = strippedPrefixRe.exec(baseContext.text);
  const removedPrefix = prefixMatch ? prefixMatch[0] : "## Relevant codebase context\n\n";
  const removedTokens = countTokens(removedPrefix);
  const textWithoutHeader = baseContext.text.slice(removedPrefix.length);
  const deepHeaderTokens = countTokens(deepHeader);

  return {
    text: deepHeader + textWithoutHeader,
    tokenCount: deepHeaderTokens + baseContext.tokenCount - removedTokens,
    chunks: baseContext.chunks,
    routeStyle: "deep",
    deliveryMode: baseContext.deliveryMode ?? "code_context",
    compression: baseContext.compression,
  };
}
