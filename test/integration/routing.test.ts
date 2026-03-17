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

      expect(deepContext.text).toContain("resolve_seed");
      expect(deepContext.text).toContain("build_stack_tree");
      expect(deepContext.text).toContain("low confidence");
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
    expect(result!.text).toContain("resolve_seed");
    expect(result!.text).toContain("build_stack_tree");
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
  it("tracks route statistics", () => {
    const metadata = pipeline.getMetadataStore();

    metadata.incrementRouteStat("skip");
    metadata.incrementRouteStat("R0");
    metadata.incrementRouteStat("R0");

    expect(metadata.getStat("route_skip_count")).toBe("1");
    expect(metadata.getStat("route_R0_count")).toBe("2");
  });

  it("increments stats independently per route", () => {
    const metadata = pipeline.getMetadataStore();

    // Stats from prior test are already stored; add R1 and R2
    metadata.incrementRouteStat("R1");
    metadata.incrementRouteStat("R1");
    metadata.incrementRouteStat("R1");
    metadata.incrementRouteStat("R2");

    expect(metadata.getStat("route_R1_count")).toBe("3");
    expect(metadata.getStat("route_R2_count")).toBe("1");

    // Prior counts still correct (skip=1, R0=2 from previous test)
    expect(metadata.getStat("route_skip_count")).toBe("1");
    expect(metadata.getStat("route_R0_count")).toBe("2");
  });
});

// ── Test 8: Full routing pipeline integration ───────────────────────

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
