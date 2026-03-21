import { encoding_for_model } from "tiktoken";
import type { SearchResult, AssembledContext } from "./types.js";
import type { StackTree } from "./tree-builder.js";
import type { StoredChunk } from "../storage/types.js";
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

function buildFileListLine(chunks: SearchResult[], maxFiles = 8): string {
  const files = [...new Set(chunks.map(c => c.filePath))];
  if (files.length === 0) return "";
  const shown = files.slice(0, maxFiles);
  const suffix = files.length > maxFiles ? ` (+${files.length - maxFiles} more)` : "";
  return `> Files included: ${shown.join(", ")}${suffix}\n`;
}

export interface AssembleOptions {
  scoreFloorRatio?: number;   // default 0.5
  maxChunks?: number;         // default Infinity (no cap unless config passes one)
  directiveHeader?: boolean;  // default true
  query?: string;
  factExtractors?: Array<{ keyword: string; pattern: string; label: string }>;
  compressionRank?: number;   // chunks after this rank use compressed format (default: undefined = no compression)
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

  const scoreFloorRatio = opts.scoreFloorRatio ?? 0.5;
  const maxChunks = opts.maxChunks ?? Infinity;
  const directiveHeader = opts.directiveHeader ?? true;

  const included: SearchResult[] = [];
  let totalTokens = 0;

  // Header — file list is added after chunk assembly (placeholder budget for now)
  const baseHeader = "## Relevant codebase context\n\n";
  const directiveLine = "> Answer from this context first. Only fetch files NOT listed above.\n\n";
  const headerBudget = countTokens(baseHeader) + (directiveHeader ? countTokens(directiveLine) + 40 /* file list estimate */ : 0);
  totalTokens += headerBudget;

  // Drop results scoring below scoreFloorRatio of the top result
  const scoreFloor = results.length > 0 ? (results[0]?.score ?? 0) * scoreFloorRatio : 0;

  // Track file headers already emitted
  const emittedHeaders = new Set<string>();

  // Reserve space for summary/facts that will be appended after the loop
  const SUMMARY_RESERVE = 80;

  for (const result of results) {
    if (result.score < scoreFloor) continue;
    let useCompressed = opts.compressionRank !== undefined && included.length >= opts.compressionRank;
    let fileHeader = `### ${result.filePath}\n`;
    let fileHeaderTokens = useCompressed || emittedHeaders.has(result.filePath) ? 0 : countTokens(fileHeader);
    let chunkText = useCompressed ? formatChunkCompressed(result) : formatChunk(result);
    let chunkTokens = countTokens(chunkText);

    if (totalTokens + fileHeaderTokens + chunkTokens > tokenBudget - SUMMARY_RESERVE) {
      if (!useCompressed && opts.compressionRank !== undefined) {
        useCompressed = true;
        fileHeaderTokens = 0;
        chunkText = formatChunkCompressed(result);
        chunkTokens = countTokens(chunkText);
      }
    }

    if (totalTokens + fileHeaderTokens + chunkTokens > tokenBudget - SUMMARY_RESERVE) {
      if (opts.compressionRank !== undefined) {
        continue;
      }
      break;
    }

    if (!useCompressed && !emittedHeaders.has(result.filePath)) {
      emittedHeaders.add(result.filePath);
      totalTokens += fileHeaderTokens;
    }

    totalTokens += chunkTokens;
    included.push(result);

    if (included.length >= maxChunks) break;
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

  for (let i = 0; i < included.length; i++) {
    const chunk = included[i]!;
    const useCompressed = opts.compressionRank !== undefined && i >= opts.compressionRank;
    if (!useCompressed && !seenFiles.has(chunk.filePath)) {
      if (seenFiles.size > 0) parts.push(""); // blank line between file groups
      parts.push(`### ${chunk.filePath}\n`);
      seenFiles.add(chunk.filePath);
    }
    parts.push(useCompressed ? formatChunkCompressed(chunk) : formatChunk(chunk));
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
    routeStyle: "standard",
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

function formatChunk(result: SearchResult): string {
  const lang = result.language || "";
  const location = `Lines ${result.startLine}-${result.endLine}: ${result.kind} ${result.name}`;
  return `\`\`\`${lang}\n// ${location}\n${result.content}\n\`\`\`\n`;
}

function formatChunkCompressed(result: SearchResult): string {
  const loc = `${result.filePath}:${result.startLine}-${result.endLine}`;
  const sig = `${result.kind} ${result.name}`;
  const doc = result.docstring ? ` — ${result.docstring.slice(0, 120)}` : '';
  return `- \`${sig}\` (${loc})${doc}\n`;
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
      `Routing: ${describeChunk(m.get("classifyIntent")) ?? "`classifyIntent`"} classifies the query, ${describeChunk(m.get("deriveRoute")) ?? "`deriveRoute`"} selects skip/R0/R1/R2, and ${describeChunk(m.get("handlePromptContextDetailed")) ?? "`handlePromptContextDetailed`"} dispatches the chosen route.`,
      `R0 retrieval: ${describeChunk(m.get("searchWithContext")) ?? "`searchWithContext`"} builds the prompt bundle, while ${describeChunk(m.get("search")) ?? "`search`"} runs retrieve, fuse, expand, and hydrate/rerank.`,
      `Navigational path: ${describeChunk(m.get("resolveSeeds")) ?? "`resolveSeeds`"} chooses seeds for R1 flow traces, and weak or ambiguous navigational results degrade to the low-confidence deep route.`,
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
  query?: string
): AssembledContext {
  const log = getLogger();
  const SUMMARY_RESERVE = 80;
  const implementationFirst =
    !!query && /\b(how\s+does|how\s+do|how\s+is|why\s+does|why\s+is|what\s+happens|work|works|implemented|implementation|fail|fails|failing|failure|error|broken)\b/i.test(query);
  const callerFocused =
    !!query && /\b(who|what)\s+calls\b|\bcalled\s+by\b|\bwhere\s+is\b.*\bused\b|\busage\b/i.test(query);

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
    return { text: "", tokenCount: 0, chunks: [], routeStyle: "flow" };
  }

  // Build header
  const seedInfo = `${tree.seed.name} (${tree.seed.kind}, ${seedChunk.filePath}:${seedChunk.startLine}-${seedChunk.endLine})`;

  // Header is built after chunk assembly to include file list; use budget estimate
  const headerEstimate = 60; // conservative estimate for header tokens
  let totalTokens = headerEstimate;
  const included: SearchResult[] = [];

  // Always include seed
  const seedResult = storedChunkToSearchResult(seedChunk);
  const seedSection = `### Seed\n` + formatChunk(seedResult);
  const seedTokens = countTokens(seedSection);

  // Seed always gets included even if it fills the budget
  if (seedTokens > tokenBudget - SUMMARY_RESERVE) {
    log.warn({ seedName: tree.seed.name, seedTokens, tokenBudget }, "seed chunk exceeds token budget — callers/callees may be truncated");
  }
  totalTokens += seedTokens;
  included.push(seedResult);

  // Build callers section (sorted by depth descending: entry point first)
  const callersSorted = [...tree.upTree].sort((a, b) => b.depth - a.depth);
  const callerParts: string[] = [];
  const callerResults: SearchResult[] = [];

  for (const callerNode of callersSorted) {
    const callerChunk = chunkMap.get(callerNode.chunkId);
    if (!callerChunk) continue;

    const callerResult = storedChunkToSearchResult(callerChunk, 0.8);
    // First caller gets full content (if reasonably sized), rest get compressed
    const callerLines = callerChunk.endLine - callerChunk.startLine + 1;
    const useCompressed = callerParts.length >= 1 || callerLines > 80;
    const callerText = useCompressed ? formatChunkCompressed(callerResult) : formatChunk(callerResult);
    const callerTokens = countTokens(callerText);

    if (totalTokens + callerTokens > tokenBudget - SUMMARY_RESERVE) break;

    totalTokens += callerTokens;
    callerParts.push(callerText);
    callerResults.push(callerResult);
  }

  // Build callees section (sorted by depth ascending: nearest first)
  const calleesSorted = [...tree.downTree].sort((a, b) => a.depth - b.depth);
  const calleeParts: string[] = [];
  const calleeResults: SearchResult[] = [];

  for (const calleeNode of calleesSorted) {
    const calleeChunk = chunkMap.get(calleeNode.chunkId);
    if (!calleeChunk) continue;

    const calleeResult = storedChunkToSearchResult(calleeChunk, 0.7);
    // First callee gets full content (if reasonably sized), rest get compressed
    const calleeLines = calleeChunk.endLine - calleeChunk.startLine + 1;
    const useCompressed = calleeParts.length >= 1 || calleeLines > 80;
    const calleeText = useCompressed ? formatChunkCompressed(calleeResult) : formatChunk(calleeResult);
    const calleeTokens = countTokens(calleeText);

    if (totalTokens + calleeTokens > tokenBudget - SUMMARY_RESERVE) break;

    totalTokens += calleeTokens;
    calleeParts.push(calleeText);
    calleeResults.push(calleeResult);
  }

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
    parts.push(`### Callers (who invokes this)\n`);
    parts.push(...callerParts);
    included.push(...callerResults);
  };
  const appendCallees = () => {
    if (calleeParts.length === 0) return;
    parts.push(`### Callees (what this invokes)\n`);
    parts.push(...calleeParts);
    included.push(...calleeResults);
  };

  if (implementationFirst && !callerFocused) {
    parts.push(seedSection);
    appendCallees();
    appendCallers();
  } else {
    appendCallers();
    parts.push(seedSection);
    appendCallees();
  }

  parts.push("");

  log.debug({
    seedName: tree.seed.name,
    upTreeCount: tree.upTree.length,
    downTreeCount: tree.downTree.length,
    includedChunks: included.length,
    totalTokens,
    tokenBudget,
    coverage: tree.coverage,
  }, "flow context assembly complete");

  return {
    text: parts.join("\n"),
    tokenCount: totalTokens,
    chunks: included,
    routeStyle: "flow",
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
  query?: string
): AssembledContext {
  // Reserve a generous estimate for the header (file list varies); adjust after assembly
  const headerEstimate = 60;
  const remainingBudget = Math.max(0, tokenBudget - headerEstimate);

  // Use existing assembleContext with reduced budget and no directive header
  // (the deep route header replaces it)
  const baseContext = assembleContext(chunks, remainingBudget, {
    scoreFloorRatio: 0,
    directiveHeader: false,
    query,
    compressionRank: 3,
  });

  // Build final header with actual file list from assembled chunks
  const deepHeader = buildDeepRouteHeader(baseContext.chunks);
  const deepHeaderTokens = countTokens(deepHeader);

  // Replace the standard header in baseContext.text with our deep route header.
  const baseHeader = "## Relevant codebase context\n\n";
  const baseHeaderTokens = countTokens(baseHeader);
  const textWithoutHeader = baseContext.text.replace(
    /^## Relevant codebase context\n\n\n?/,
    ""
  );

  return {
    text: deepHeader + textWithoutHeader,
    tokenCount: deepHeaderTokens + baseContext.tokenCount - baseHeaderTokens,
    chunks: baseContext.chunks,
    routeStyle: "deep",
  };
}
