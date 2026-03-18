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

export interface AssembleOptions {
  scoreFloorRatio?: number;   // default 0.5
  maxChunks?: number;         // default Infinity (no cap unless config passes one)
  directiveHeader?: boolean;  // default true
  query?: string;
  factExtractors?: Array<{ keyword: string; pattern: string; label: string }>;
}

export type ConceptContextKind = "ast" | "call_graph" | "search_pipeline";

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
    ? "## Relevant codebase context\n\n> The following codebase context was retrieved by the Memory Engine for this prompt. If a `Direct facts` section answers the question, answer directly from it and do not use repository tools. If the context is insufficient, reply with `Insufficient context`.\n\n"
    : "## Relevant codebase context\n\n";
  totalTokens += countTokens(header);

  // Drop results scoring below scoreFloorRatio of the top result
  const scoreFloor = results.length > 0 ? (results[0]?.score ?? 0) * scoreFloorRatio : 0;

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
    routeStyle: "standard",
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

  if (kind === "ast") {
    const facts = [
      `Main entry point: ${describeChunk(byName.get("chunkFileWithCalls")) ?? "`chunkFileWithCalls`"} parses a file, builds the syntax tree, and orchestrates chunk, import, and call-edge extraction.`,
      `Parser setup: ${describeChunk(byName.get("initTreeSitter")) ?? "`initTreeSitter`"} initializes Tree-sitter, and ${describeChunk(byName.get("createParser")) ?? "`createParser`"} creates the parser instance for the loaded grammar.`,
      `AST traversal: ${describeChunk(byName.get("walkForExtractables")) ?? "`walkForExtractables`"} walks the tree for extractable nodes, while ${describeChunk(byName.get("extractName")) ?? "`extractName`"} derives stable symbol names for chunks.`,
    ];
    return facts.map((fact) => `- ${fact}`);
  }

  if (kind === "search_pipeline") {
    const facts = [
      `Routing: ${describeChunk(byName.get("classifyIntent")) ?? "`classifyIntent`"} classifies the query, ${describeChunk(byName.get("deriveRoute")) ?? "`deriveRoute`"} selects skip/R0/R1/R2, and ${describeChunk(byName.get("handlePromptContextDetailed")) ?? "`handlePromptContextDetailed`"} dispatches the chosen route.`,
      `R0 retrieval: ${describeChunk(byName.get("searchWithContext")) ?? "`searchWithContext`"} builds the prompt bundle, while ${describeChunk(byName.get("search")) ?? "`search`"} runs retrieve, fuse, expand, and hydrate/rerank.`,
      `Navigational path: ${describeChunk(byName.get("resolveSeeds")) ?? "`resolveSeeds`"} chooses seeds for R1 flow traces, and weak or ambiguous navigational results degrade to the low-confidence deep route.`,
    ];
    return facts.map((fact) => `- ${fact}`);
  }

  const facts = [
    `Main entry point: ${describeChunk(byName.get("extractCallEdges")) ?? "`extractCallEdges`"} walks AST call sites and emits persisted call edges.`,
    `Callee resolution: ${describeChunk(byName.get("extractCalleeInfo")) ?? "`extractCalleeInfo`"} resolves the callee name and receiver, and ${describeChunk(byName.get("extractReceiver")) ?? "`extractReceiver`"} normalizes chained member receivers.`,
    `Consumers: ${describeChunk(byName.get("graphCommand")) ?? "`graphCommand`"} exposes the CLI view, and ${describeChunk(byName.get("buildStackTree")) ?? "`buildStackTree`"} builds higher-level caller/callee navigation from stored edges.`,
  ];
  return facts.map((fact) => `- ${fact}`);
}

export function assembleConceptContext(
  kind: ConceptContextKind,
  chunks: SearchResult[],
  tokenBudget: number
): AssembledContext {
  const title =
    kind === "ast"
      ? "AST pipeline"
      : kind === "call_graph"
        ? "call graph"
        : "search pipeline";
  const routeNote =
    kind === "ast"
      ? "This query is about the AST parsing and chunking pipeline, not the call graph."
      : kind === "call_graph"
        ? "This query is about the call graph system, not the AST chunking pipeline."
        : "This query is about the routing and retrieval pipeline for answering repository search prompts.";
  const header =
    `## Relevant codebase context (${title})\n\n` +
    `> ${routeNote} Answer directly from this bundle. Do not use repository tools unless a required detail is missing from this context.\n\n`;
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
    parts.push(formatChunk(chunk));
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
  _query?: string
): AssembledContext {
  const log = getLogger();
  const SUMMARY_RESERVE = 80;

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

  const header =
    `## Relevant codebase context (flow trace)\n\n` +
    `> Route: R1 | Seed: ${seedInfo}\n` +
    `> This caller/seed/callee path was selected to answer the current query. Answer from it directly before considering repository tools.\n\n`;

  let totalTokens = countTokens(header);
  const included: SearchResult[] = [];
  const parts: string[] = [header];

  // Always include seed first
  if (seedChunk) {
    const seedResult = storedChunkToSearchResult(seedChunk);
    const seedSection = `### Seed\n` + formatChunk(seedResult);
    const seedTokens = countTokens(seedSection);

    // Seed always gets included even if it fills the budget
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
      const callerText = formatChunk(callerResult);
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
      const calleeText = formatChunk(calleeResult);
      const calleeTokens = countTokens(calleeText);

      if (totalTokens + calleeTokens > tokenBudget - SUMMARY_RESERVE) break;

      totalTokens += calleeTokens;
      calleeParts.push(calleeText);
      calleeResults.push(calleeResult);
    }

    // Assemble in order: callers -> seed -> callees
    if (callerParts.length > 0) {
      parts.push(`### Callers (who invokes this)\n`);
      parts.push(...callerParts);
      included.push(...callerResults);
    }

    parts.push(seedSection);

    if (calleeParts.length > 0) {
      parts.push(`### Callees (what this invokes)\n`);
      parts.push(...calleeParts);
      included.push(...calleeResults);
    }
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

const DEEP_ROUTE_HEADER =
  `## Relevant codebase context (low confidence)\n\n` +
  `> The retrieval engine could not identify a clear entry point for this query.\n` +
  `> Repository tools are allowed here because the injected bundle is low confidence.\n` +
  `> Use \`explain_flow\` for one-shot flow analysis, or \`resolve_seed\` and \`build_stack_tree\` for step-by-step navigation.\n\n`;

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
  const markerTokens = countTokens(DEEP_ROUTE_HEADER);
  const remainingBudget = Math.max(0, tokenBudget - markerTokens);

  // Use existing assembleContext with reduced budget and no directive header
  // (the deep route header replaces it)
  const baseContext = assembleContext(chunks, remainingBudget, {
    scoreFloorRatio: 0.3,
    directiveHeader: false,
    query,
  });

  // Replace the standard header in baseContext.text with our deep route header
  const textWithoutHeader = baseContext.text.replace(
    /^## Relevant codebase context\n\n/,
    ""
  );

  return {
    text: DEEP_ROUTE_HEADER + textWithoutHeader,
    tokenCount: markerTokens + baseContext.tokenCount - countTokens("## Relevant codebase context\n\n"),
    chunks: baseContext.chunks,
    routeStyle: "deep",
  };
}
