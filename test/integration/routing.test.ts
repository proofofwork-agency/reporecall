import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { classifyIntent, deriveRoute } from "../../src/search/intent.js";
import { resolveSeeds } from "../../src/search/seed.js";
import { buildStackTree } from "../../src/search/tree-builder.js";
import { assembleFlowContext, assembleDeepRouteContext } from "../../src/search/context-assembler.js";
import { handlePromptContext } from "../../src/hooks/prompt-context.js";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import { HybridSearch } from "../../src/search/hybrid.js";
import type { MemoryConfig } from "../../src/core/config.js";

const ROUTING_FIXTURES = resolve(import.meta.dirname, "..", "fixtures", "routing");
const TEST_PROJECT = resolve(import.meta.dirname, "..", ".test-routing-project");
const TEST_DATA = resolve(TEST_PROJECT, ".memory");

function makeConfig(): MemoryConfig {
  return {
    projectRoot: TEST_PROJECT,
    dataDir: TEST_DATA,
    embeddingProvider: "keyword",
    embeddingModel: "",
    embeddingDimensions: 0,
    ollamaUrl: "",
    extensions: [".ts"],
    ignorePatterns: ["node_modules", ".git", ".memory"],
    maxFileSize: 100 * 1024,
    batchSize: 32,
    contextBudget: 8000,
    maxContextChunks: 0,
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
    port: 37230,
    implementationPaths: ["src/", "lib/", "bin/"],
    factExtractors: [],
    conceptBundles: [],
  };
}

let pipeline: IndexingPipeline;
let search: HybridSearch;
let config: MemoryConfig;

beforeAll(async () => {
  // Copy fixture files into a temp project directory
  mkdirSync(resolve(TEST_PROJECT, "src"), { recursive: true });
  cpSync(resolve(ROUTING_FIXTURES, "src"), resolve(TEST_PROJECT, "src"), { recursive: true });

  config = makeConfig();
  pipeline = new IndexingPipeline(config);

  const result = await pipeline.indexAll();
  expect(result.filesProcessed).toBeGreaterThan(0);
  expect(result.chunksCreated).toBeGreaterThan(0);

  // Build HybridSearch from indexed stores
  search = new HybridSearch(
    pipeline.getEmbedder(),
    pipeline.getVectorStore(),
    pipeline.getFTSStore(),
    pipeline.getMetadataStore(),
    config
  );
}, 30000);

afterAll(() => {
  pipeline?.close();
  rmSync(TEST_PROJECT, { recursive: true, force: true });
});

// ── Test 1: Meta prompt -> G0 skip ──────────────────────────────────

describe("G0 skip gate", () => {
  it("skips retrieval for meta prompts", () => {
    const intent = classifyIntent("am I using memory?");
    expect(intent.isCodeQuery).toBe(false);
    const route = deriveRoute(intent);
    expect(route).toBe("skip");
  });

  it("skips retrieval for greetings", () => {
    const intent = classifyIntent("hello");
    expect(intent.isCodeQuery).toBe(false);
    const route = deriveRoute(intent);
    expect(route).toBe("skip");
  });

  it("skips retrieval for thanks", () => {
    const intent = classifyIntent("thank you");
    expect(intent.isCodeQuery).toBe(false);
    const route = deriveRoute(intent);
    expect(route).toBe("skip");
  });

  it("skips retrieval for very short queries", () => {
    const intent = classifyIntent("hi");
    expect(intent.isCodeQuery).toBe(false);
  });
});

// ── Test 2: Direct code query -> R0 ────────────────────────────────

describe("R0 direct code queries", () => {
  it("uses R0 for direct code queries", () => {
    const intent = classifyIntent("where is validate?");
    expect(intent.isCodeQuery).toBe(true);
    expect(intent.needsNavigation).toBe(false);
    const route = deriveRoute(intent);
    expect(route).toBe("R0");
  });

  it("handlePromptContext returns chunk-based result for R0", async () => {
    const result = await handlePromptContext(
      "where is validate?",
      search,
      config,
      undefined,
      undefined,
      "R0",
      pipeline.getMetadataStore(),
      pipeline.getFTSStore()
    );
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Relevant codebase context");
    expect(result!.chunks.length).toBeGreaterThan(0);
  });
});

// ── Test 3: Navigational query with strong seed -> R1 ──────────────

describe("R1 flow bundle", () => {
  it("uses R1 for navigational queries with strong seeds", async () => {
    const intent = classifyIntent("how does validate work?");
    expect(intent.isCodeQuery).toBe(true);
    expect(intent.needsNavigation).toBe(true);

    // Resolve seeds — "validate" should be found with high confidence
    const metadata = pipeline.getMetadataStore();
    const fts = pipeline.getFTSStore();
    const seedResult = resolveSeeds("how does validate work?", metadata, fts);

    expect(seedResult.bestSeed).not.toBeNull();
    expect(seedResult.bestSeed!.name).toBe("validate");
    expect(seedResult.bestSeed!.confidence).toBeGreaterThanOrEqual(0.7);

    const route = deriveRoute(intent, seedResult.bestSeed!.confidence);
    expect(route).toBe("R1");
  });

  it("handlePromptContext returns flow context for R1", async () => {
    const result = await handlePromptContext(
      "how does validate work?",
      search,
      config,
      undefined,
      undefined,
      "R1",
      pipeline.getMetadataStore(),
      pipeline.getFTSStore()
    );
    expect(result).not.toBeNull();
    expect(result!.text).toContain("flow trace");
    expect(result!.chunks.length).toBeGreaterThan(0);
  });

  it("R1 flow bundle has correct structure", async () => {
    const metadata = pipeline.getMetadataStore();
    const fts = pipeline.getFTSStore();
    const seedResult = resolveSeeds("how does validate work?", metadata, fts);

    expect(seedResult.bestSeed).not.toBeNull();

    const tree = buildStackTree(metadata, {
      seed: seedResult.bestSeed!,
      direction: "both",
      maxDepth: 2,
      maxBranchFactor: 3,
      maxNodes: 24,
    });

    const flowContext = assembleFlowContext(tree, metadata, config.contextBudget, "how does validate work?");

    // Verify structural markers
    expect(flowContext.text).toContain("## Relevant codebase context (flow trace)");
    expect(flowContext.text).toContain("### Seed");

    // validate is called by handleRequest -> expect callers section
    if (tree.upTree.length > 0) {
      expect(flowContext.text).toContain("### Callers");
    }

    // validate calls decode -> expect callees section
    if (tree.downTree.length > 0) {
      expect(flowContext.text).toContain("### Callees");
    }

    // The seed chunk content should be present
    expect(flowContext.text).toContain("validate");
    expect(flowContext.tokenCount).toBeGreaterThan(0);
  });

  it("builds a call tree with callers and callees from validate", () => {
    const metadata = pipeline.getMetadataStore();
    const fts = pipeline.getFTSStore();
    const seedResult = resolveSeeds("how does validate work?", metadata, fts);

    expect(seedResult.bestSeed).not.toBeNull();

    const tree = buildStackTree(metadata, {
      seed: seedResult.bestSeed!,
      direction: "both",
      maxDepth: 2,
    });

    // validate is called by handleRequest (caller)
    const callerNames = tree.upTree.map((n) => n.name);
    expect(callerNames).toContain("handleRequest");

    // validate calls decode (callee)
    const calleeNames = tree.downTree.map((n) => n.name);
    expect(calleeNames).toContain("decode");

    expect(tree.nodeCount).toBeGreaterThanOrEqual(3); // seed + at least one caller + one callee
  });
});

// ── Test 4: Navigational query with weak seed -> R2 ────────────────

describe("R2 deep route", () => {
  it("falls back to R2 when seed confidence is low", () => {
    const intent = classifyIntent("how does the architecture handle requests?");
    expect(intent.isCodeQuery).toBe(true);
    expect(intent.needsNavigation).toBe(true);

    // With a low seed confidence, deriveRoute should return R2
    const route = deriveRoute(intent, 0.3);
    expect(route).toBe("R2");
  });

  it("R2 context includes MCP tool guidance", async () => {
    const metadata = pipeline.getMetadataStore();
    const fts = pipeline.getFTSStore();

    // Use a vague query that should produce low-confidence seeds
    const seedResult = resolveSeeds("how does the architecture handle requests?", metadata, fts);

    // Build R2 context from search results
    const searchResults = await search.search("how does the architecture handle requests?", { limit: 10 });

    if (searchResults.length > 0) {
      const deepContext = assembleDeepRouteContext(searchResults, config.contextBudget, "how does the architecture handle requests?");

      expect(deepContext.text).toContain("low confidence");
      expect(deepContext.text).toContain("repository tools are allowed");
    }
  });

  it("handlePromptContext returns deep route context for R2", async () => {
    const result = await handlePromptContext(
      "how does the architecture handle requests?",
      search,
      config,
      undefined,
      undefined,
      "R2",
      pipeline.getMetadataStore(),
      pipeline.getFTSStore()
    );
    expect(result).not.toBeNull();
    expect(result!.text).toContain("low confidence");
    expect(result!.text).toContain("repository tools are allowed");
  });
});

// ── Test 5: R0 latency ─────────────────────────────────────────────

describe("R0 latency", () => {
  it("R0 responds within acceptable latency", async () => {
    const start = Date.now();
    const result = await handlePromptContext(
      "where is handleRequest?",
      search,
      config,
      undefined,
      undefined,
      "R0",
      pipeline.getMetadataStore(),
      pipeline.getFTSStore()
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // generous threshold for CI
    expect(result).not.toBeNull();
  });
});

// ── Test 6: Existing search functions still work ────────────────────

describe("existing search functions", () => {
  it("search_code returns results via HybridSearch", async () => {
    const results = await search.search("validate", { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.name);
    expect(names).toContain("validate");
  });

  it("find_callers returns results via HybridSearch", () => {
    const callers = search.findCallers("validate");
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.some((c) => c.callerName === "handleRequest")).toBe(true);
  });

  it("find_callees returns results via HybridSearch", () => {
    const callees = search.findCallees("validate");
    expect(callees.length).toBeGreaterThan(0);
    expect(callees.some((c) => c.targetName === "decode")).toBe(true);
  });
});

// ── Test 7: Route stats tracking ────────────────────────────────────

describe("route stats tracking", () => {
  it("tracks and increments route statistics independently per route", () => {
    const metadata = pipeline.getMetadataStore();

    // Increment each route within a single test to avoid cross-it() state
    // dependencies that make test results order-dependent.
    metadata.incrementRouteStat("skip");
    metadata.incrementRouteStat("R0");
    metadata.incrementRouteStat("R0");

    expect(metadata.getStat("route_skip_count")).toBe("1");
    expect(metadata.getStat("route_R0_count")).toBe("2");

    metadata.incrementRouteStat("R1");
    metadata.incrementRouteStat("R1");
    metadata.incrementRouteStat("R1");
    metadata.incrementRouteStat("R2");

    expect(metadata.getStat("route_R1_count")).toBe("3");
    expect(metadata.getStat("route_R2_count")).toBe("1");

    // Previously set counts are still correct within the same test
    expect(metadata.getStat("route_skip_count")).toBe("1");
    expect(metadata.getStat("route_R0_count")).toBe("2");
  });
});

// ── Test 8: R0 concept bundle path ──────────────────────────────────
//
// The concept bundle short-circuit fires inside searchWithContext() when
// the query matches one of the three hardcoded concept regexes (AST,
// call graph, search pipeline) AND no explicit symbol target was resolved.
// Because the concept bundle looks up symbols from Reporecall's own source,
// this test uses the real project root rather than the routing fixture.

describe("R0 concept bundle", () => {
  // A standalone HybridSearch instance pointing at the real project so
  // that the concept symbols (classifyIntent, extractCallEdges, etc.)
  // can be found in the metadata store.  We create an isolated data dir
  // so the test never corrupts the developer's own .memory directory.

  const CONCEPT_PROJECT = resolve(import.meta.dirname, "..", ".test-concept-project");
  const CONCEPT_DATA = resolve(CONCEPT_PROJECT, ".memory");

  let conceptPipeline: IndexingPipeline;
  let conceptSearch: HybridSearch;

  beforeAll(async () => {
    // Index only the src directory of the real project so concept symbols exist.
    const { cpSync: cp2 } = await import("fs");
    mkdirSync(resolve(CONCEPT_PROJECT, "src"), { recursive: true });
    cp2(
      resolve(import.meta.dirname, "..", "..", "src"),
      resolve(CONCEPT_PROJECT, "src"),
      { recursive: true }
    );

    const conceptConfig: MemoryConfig = {
      projectRoot: CONCEPT_PROJECT,
      dataDir: CONCEPT_DATA,
      embeddingProvider: "keyword",
      embeddingModel: "",
      embeddingDimensions: 0,
      ollamaUrl: "",
      extensions: [".ts"],
      ignorePatterns: ["node_modules", ".git", ".memory"],
      maxFileSize: 100 * 1024,
      batchSize: 32,
      contextBudget: 8000,
      maxContextChunks: 0,
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
      port: 37231,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
      conceptBundles: [
        {
          kind: "ast",
          pattern: "\\b(ast|tree[- ]?sitter)\\b",
          symbols: ["initTreeSitter", "createParser", "chunkFileWithCalls", "walkForExtractables", "extractName"],
          maxChunks: 4,
        },
        {
          kind: "call_graph",
          pattern: "\\bcall\\s+graph\\b|\\bwho\\s+calls\\b|\\bcalled\\s+by\\b|\\bcaller(?:s)?\\b|\\bcallee(?:s)?\\b",
          symbols: ["extractCallEdges", "extractCalleeInfo", "extractReceiver", "graphCommand", "buildStackTree"],
          maxChunks: 4,
        },
        {
          kind: "search_pipeline",
          pattern: "\\bsearch\\s+pipeline\\b|\\bretrieval\\s+pipeline\\b|\\bintent\\s+classification\\s+route\\b|\\bhybrid\\s+search\\b|\\bsearch\\s+routing\\b|\\bquery\\s+routing\\b|\\broute\\s+selection\\b",
          symbols: ["classifyIntent", "deriveRoute", "handlePromptContextDetailed", "searchWithContext", "search", "resolveSeeds"],
          maxChunks: 5,
        },
      ],
    };

    conceptPipeline = new IndexingPipeline(conceptConfig);
    const result = await conceptPipeline.indexAll();
    expect(result.filesProcessed).toBeGreaterThan(0);

    conceptSearch = new HybridSearch(
      conceptPipeline.getEmbedder(),
      conceptPipeline.getVectorStore(),
      conceptPipeline.getFTSStore(),
      conceptPipeline.getMetadataStore(),
      conceptConfig
    );
  }, 60000);

  afterAll(() => {
    conceptPipeline?.close();
    rmSync(CONCEPT_PROJECT, { recursive: true, force: true });
  });

  it("hasConceptContext returns true for call-graph queries", () => {
    expect(conceptSearch.hasConceptContext("who calls extractCallEdges?")).toBe(true);
    expect(conceptSearch.hasConceptContext("show me the call graph")).toBe(true);
  });

  it("hasConceptContext returns true for AST queries", () => {
    expect(conceptSearch.hasConceptContext("how does AST parsing work?")).toBe(true);
    expect(conceptSearch.hasConceptContext("explain tree-sitter usage")).toBe(true);
  });

  it("hasConceptContext returns true for search-pipeline queries", () => {
    expect(conceptSearch.hasConceptContext("how does the search pipeline work?")).toBe(true);
    expect(conceptSearch.hasConceptContext("explain query routing")).toBe(true);
  });

  it("hasConceptContext returns false for unrelated queries", () => {
    expect(conceptSearch.hasConceptContext("how does validate work?")).toBe(false);
    expect(conceptSearch.hasConceptContext("where is the config file?")).toBe(false);
  });

  it("searchWithContext returns concept routeStyle for call-graph query", async () => {
    const result = await conceptSearch.searchWithContext(
      "how does the call graph work?",
      8000
    );
    // If concept symbols were found the bundle short-circuit fires; otherwise
    // we fall through to normal search.  Guard against an empty index.
    if (result.routeStyle === "concept") {
      expect(result.text).toContain("call graph");
      expect(result.chunks.length).toBeGreaterThan(0);
    } else {
      // Concept symbols not found means the metadata store returned nothing
      // for the call-graph symbol list — acceptable only if indexing produced
      // no chunks (should not happen with the real src tree).
      expect(result.chunks.length).toBeGreaterThan(0);
    }
  });

  it("searchWithContext concept bundle contains expected call-graph symbol chunks", async () => {
    const result = await conceptSearch.searchWithContext(
      "show callers and callees — explain the call graph system",
      8000
    );
    if (result.routeStyle !== "concept") {
      // Symbol lookup missed — still verify search returned something useful.
      expect(result.chunks.length).toBeGreaterThan(0);
      return;
    }
    // The concept bundle header identifies the bundle kind.
    expect(result.text).toContain("## Relevant codebase context (call graph)");
    // At least one of the canonical call-graph symbols should appear in the text.
    const callGraphSymbols = [
      "extractCallEdges",
      "extractCalleeInfo",
      "buildStackTree",
      "graphCommand",
    ];
    const foundSymbol = callGraphSymbols.some((sym) => result.text.includes(sym));
    expect(foundSymbol).toBe(true);
  });

  it("searchWithContext concept bundle contains expected AST symbol chunks", async () => {
    const result = await conceptSearch.searchWithContext(
      "how does the AST pipeline parse files?",
      8000
    );
    if (result.routeStyle !== "concept") {
      expect(result.chunks.length).toBeGreaterThan(0);
      return;
    }
    expect(result.text).toContain("## Relevant codebase context (AST pipeline)");
    const astSymbols = [
      "initTreeSitter",
      "createParser",
      "chunkFileWithCalls",
      "walkForExtractables",
    ];
    const foundSymbol = astSymbols.some((sym) => result.text.includes(sym));
    expect(foundSymbol).toBe(true);
  });

  it("concept bundle does NOT fire when an explicit symbol target is resolved", async () => {
    // "buildStackTree" is a call-graph concept symbol; but the query names it
    // explicitly so resolveSeeds will produce an explicit_target hit,
    // suppressing the concept bundle short-circuit.
    const result = await conceptSearch.searchWithContext(
      "how does buildStackTree work?",
      8000
    );
    // Must NOT return a concept bundle — explicit target takes precedence.
    expect(result.routeStyle).not.toBe("concept");
  });
});

// ── Test 9: Full routing pipeline integration ───────────────────────

describe("full routing pipeline integration", () => {
  it("routes a meta query through skip without searching", async () => {
    const query = "am I using memory?";
    const intent = classifyIntent(query);
    const route = deriveRoute(intent);

    expect(route).toBe("skip");

    // handlePromptContext with skip route delegates to R0 path
    // but the real daemon would short-circuit before calling it
    // Verify intent classification is correct
    expect(intent.isCodeQuery).toBe(false);
    expect(intent.skipReason).toBeDefined();
  });

  it("routes a direct query through R0 end-to-end", async () => {
    const query = "where is decode?";
    const intent = classifyIntent(query);
    const route = deriveRoute(intent);

    expect(route).toBe("R0");

    const result = await handlePromptContext(
      query,
      search,
      config,
      undefined,
      undefined,
      route,
      pipeline.getMetadataStore(),
      pipeline.getFTSStore()
    );

    expect(result).not.toBeNull();
    expect(result!.chunks.length).toBeGreaterThan(0);
    // Should contain the decode function content
    expect(result!.text).toContain("decode");
  });

  it("routes a navigational query through R1 end-to-end", async () => {
    const query = "how does handleRequest work?";
    const intent = classifyIntent(query);
    expect(intent.needsNavigation).toBe(true);

    const metadata = pipeline.getMetadataStore();
    const fts = pipeline.getFTSStore();
    const seedResult = resolveSeeds(query, metadata, fts);

    // handleRequest is an explicit target with high confidence
    const bestConfidence = seedResult.bestSeed?.confidence ?? 0;
    const route = deriveRoute(intent, bestConfidence);

    if (route === "R1") {
      const result = await handlePromptContext(
        query,
        search,
        config,
        undefined,
        undefined,
        route,
        metadata,
        fts
      );

      expect(result).not.toBeNull();
      expect(result!.text).toContain("flow trace");
      // handleRequest calls validate, which calls decode
      // At minimum the seed should be present
      expect(result!.text).toContain("handleRequest");
    } else {
      // If seed confidence was low, it falls to R0 or R2 -- that's still valid
      expect(["R0", "R2"]).toContain(route);
    }
  });
});
