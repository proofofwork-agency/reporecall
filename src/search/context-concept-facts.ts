import type { SearchResult } from "./types.js";
import type { StoredChunk } from "../storage/types.js";

export type ConceptContextKind = "ast" | "call_graph" | "search_pipeline" | "storage" | "daemon" | "embedding" | "cli" | "context_assembly" | (string & {});

function describeChunk(chunk: SearchResult | StoredChunk | undefined): string | null {
  if (!chunk) return null;
  return `\`${chunk.name}\` (${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`;
}

export function buildConceptFacts(
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
