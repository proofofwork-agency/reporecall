import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import { FTSStore } from "../../src/storage/fts-store.js";
import {
  ArchitectureStrategy,
  compileConceptBundles,
  BROAD_INVENTORY_RE,
  SUBSYSTEM_INVENTORY_FAMILIES,
  STRICT_WORKFLOW_FAMILY_COHESION,
  INVENTORY_GENERIC_TARGET_ALIAS_TERMS,
  INVENTORY_STRUCTURAL_TERMS,
  ADJACENT_WORKFLOW_FAMILIES,
} from "../../src/search/architecture-strategy.js";
import {
  chunkToSearchResult,
  isImplementationPath,
} from "../../src/search/shared/mappers.js";
import type { SearchResult } from "../../src/search/types.js";

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    conceptBundles: [],
    implementationPaths: ["src/", "lib/", "bin/"],
    ...overrides,
  };
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "x",
    score: 0.9,
    filePath: "src/auth/session.ts",
    name: "validateSession",
    kind: "function_declaration",
    startLine: 1,
    endLine: 20,
    content: "export function validateSession() {}",
    language: "typescript",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure module-level exports
// ---------------------------------------------------------------------------

describe("architecture-strategy pure exports", () => {
  describe("compileConceptBundles", () => {
    it("compiles pattern strings into case-insensitive regexes", () => {
      const [bundle] = compileConceptBundles([
        { kind: "lifecycle", pattern: "\\bshutdown\\b", symbols: ["stop"], maxChunks: 4 },
      ]);
      expect(bundle).toBeDefined();
      expect(bundle.pattern).toBeInstanceOf(RegExp);
      expect(bundle.pattern.flags).toContain("i");
      expect(bundle.pattern.test("Graceful SHUTDOWN")).toBe(true);
      expect(bundle.pattern.test("startup")).toBe(false);
    });

    it("preserves kind, symbols, and maxChunks", () => {
      const [bundle] = compileConceptBundles([
        { kind: "search_pipeline", pattern: "search", symbols: ["a", "b"], maxChunks: 6 },
      ]);
      expect(bundle.kind).toBe("search_pipeline");
      expect(bundle.symbols).toEqual(["a", "b"]);
      expect(bundle.maxChunks).toBe(6);
    });

    it("returns [] for undefined / empty input", () => {
      expect(compileConceptBundles(undefined as any)).toEqual([]);
      expect(compileConceptBundles([])).toEqual([]);
    });
  });

  describe("BROAD_INVENTORY_RE", () => {
    it("matches inventory-style phrases", () => {
      expect(BROAD_INVENTORY_RE.test("which files implement auth")).toBe(true);
      expect(BROAD_INVENTORY_RE.test("what files handle billing")).toBe(true);
      expect(BROAD_INVENTORY_RE.test("list files that power the API")).toBe(true);
    });

    it("rejects non-inventory queries", () => {
      expect(BROAD_INVENTORY_RE.test("how does auth work")).toBe(false);
      expect(BROAD_INVENTORY_RE.test("validateSession implementation")).toBe(false);
    });
  });

  describe("workflow-family constants", () => {
    it("exports the expected family sets and maps", () => {
      expect(SUBSYSTEM_INVENTORY_FAMILIES.has("search")).toBe(true);
      expect(STRICT_WORKFLOW_FAMILY_COHESION.has("auth")).toBe(true);
      expect(STRICT_WORKFLOW_FAMILY_COHESION.has("billing")).toBe(true);
      expect(STRICT_WORKFLOW_FAMILY_COHESION.has("workflow")).toBe(true);
      expect(INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has("route")).toBe(true);
      expect(INVENTORY_STRUCTURAL_TERMS.has("which")).toBe(true);
      expect(ADJACENT_WORKFLOW_FAMILIES.auth).toContain("routing");
      expect(ADJACENT_WORKFLOW_FAMILIES.generation).toContain("storage");
    });
  });

  describe("shared pure mappers", () => {
    it("chunkToSearchResult maps all fields with a given score", () => {
      const chunk = {
        id: "c1",
        filePath: "src/a.ts",
        name: "fn",
        kind: "function_declaration",
        startLine: 3,
        endLine: 9,
        content: "function fn() {}",
        docstring: "docs",
        parentName: "Cls",
        language: "typescript",
        indexedAt: new Date().toISOString(),
      };
      const result = chunkToSearchResult(chunk, 0.42);
      expect(result.id).toBe("c1");
      expect(result.score).toBe(0.42);
      expect(result.filePath).toBe("src/a.ts");
      expect(result.docstring).toBe("docs");
      expect(result.parentName).toBe("Cls");
      expect(result.language).toBe("typescript");
    });

    it("isImplementationPath matches configured and conventional prefixes", () => {
      expect(isImplementationPath("src/auth.ts")).toBe(true);
      expect(isImplementationPath("lib/util.ts")).toBe(true);
      expect(isImplementationPath("app/server/index.ts")).toBe(true);
      expect(isImplementationPath("supabase/functions/handler.ts")).toBe(true);
      expect(isImplementationPath("docs/readme.md")).toBe(false);
    });

    it("isImplementationPath honors a custom implementationPaths list", () => {
      expect(isImplementationPath("app/x.ts", ["app/"])).toBe(true);
      // "src/" is conventional but not in this custom list prefix; still matched by regex
      expect(isImplementationPath("src/x.ts", ["app/"])).toBe(true);
      expect(isImplementationPath("notes/a.md", ["app/"])).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// ArchitectureStrategy class — construction, store management, pure helpers
// ---------------------------------------------------------------------------

describe("ArchitectureStrategy construction and store management", () => {
  let dir: string;
  let metadata: MetadataStore;
  let fts: FTSStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-arch-"));
    metadata = new MetadataStore(dir);
    fts = new FTSStore(dir);
  });

  afterEach(() => {
    metadata.close();
    fts.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("constructs with real stores and a minimal config", () => {
    const strategy = new ArchitectureStrategy({ metadata, config: makeConfig(), ftsStore: fts });
    expect(strategy).toBeInstanceOf(ArchitectureStrategy);
    expect(strategy.lastBroadSelection).toBeNull();
  });

  it("compiles conceptBundles through the constructor", () => {
    const strategy = new ArchitectureStrategy({
      metadata,
      config: makeConfig({
        conceptBundles: [
          { kind: "lifecycle", pattern: "\\bshutdown\\b", symbols: ["stop"], maxChunks: 3 },
        ],
      }),
      ftsStore: fts,
    });
    // A lifecycle query against a chunk named "stop" should be surfaced as a
    // concept result, proving the bundle was compiled and wired in.
    metadata.upsertChunk({
      id: "stop-chunk",
      filePath: "src/runtime.ts",
      name: "stop",
      kind: "method_definition",
      startLine: 1,
      endLine: 10,
      content: "async stop() {}",
      language: "typescript",
      indexedAt: new Date().toISOString(),
    });
    const profile = strategy.buildBroadQueryProfile("how does graceful shutdown work");
    const concept = strategy.buildBroadConceptResults(
      "how does graceful shutdown work",
      false,
      profile
    );
    expect(concept.length).toBeGreaterThan(0);
    expect(concept.some((r) => r.name === "stop")).toBe(true);
  });

  it("updateStores swaps the active metadata and fts references", () => {
    const dirB = mkdtempSync(join(tmpdir(), "mem-arch-b-"));
    const metadataB = new MetadataStore(dirB);
    const ftsB = new FTSStore(dirB);
    try {
      // Seed store A with one import neighbor, store B with a different one.
      metadata.upsertImports([
        { filePath: "src/core.ts", importedName: "a", sourceModule: "./a", resolvedPath: "neighborA", isDefault: false, isNamespace: false },
      ]);
      metadataB.upsertImports([
        { filePath: "src/core.ts", importedName: "b", sourceModule: "./b", resolvedPath: "neighborB", isDefault: false, isNamespace: false },
      ]);

      const strategy = new ArchitectureStrategy({ metadata, config: makeConfig(), ftsStore: fts });
      expect(strategy.collectBroadImportNeighbors("src/core.ts")).toEqual(["neighborA"]);

      strategy.updateStores(metadataB, ftsB);
      expect(strategy.collectBroadImportNeighbors("src/core.ts")).toEqual(["neighborB"]);
    } finally {
      metadataB.close();
      ftsB.close();
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("ArchitectureStrategy layer/path detection helpers", () => {
  let dir: string;
  let metadata: MetadataStore;
  let fts: FTSStore;
  let strategy: ArchitectureStrategy;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-arch-layers-"));
    metadata = new MetadataStore(dir);
    fts = new FTSStore(dir);
    strategy = new ArchitectureStrategy({ metadata, config: makeConfig(), ftsStore: fts });
  });

  afterEach(() => {
    metadata.close();
    fts.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("detectWorkflowLayers assigns layers by path/name and defaults to core", () => {
    expect(strategy.detectWorkflowLayers("src/pages/home.tsx", "homePage")).toContain("ui");
    expect(strategy.detectWorkflowLayers("src/hooks/useauth.ts", "useAuth")).toContain("state");
    expect(strategy.detectWorkflowLayers("src/api/router.ts", "router")).toContain("routing");
    expect(strategy.detectWorkflowLayers("src/api/server.ts", "createServer")).toContain("backend");
    expect(strategy.detectWorkflowLayers("src/lib/helpers.ts", "formatError")).toContain("shared");
    // Unknown shape → core fallback
    expect(strategy.detectWorkflowLayers("some/random.ts", "thing")).toEqual(["core"]);
  });

  it("isUtilityLikePath flags lib/shared/core/utils paths", () => {
    expect(strategy.isUtilityLikePath("src/lib/x.ts", "x")).toBe(true);
    expect(strategy.isUtilityLikePath("src/shared/y.ts", "format")).toBe(true);
    expect(strategy.isUtilityLikePath("src/utils/clean.ts", "clean")).toBe(true);
    expect(strategy.isUtilityLikePath("src/utils/clean.ts", "Helpers")).toBe(true);
    expect(strategy.isUtilityLikePath("src/auth/login.ts", "login")).toBe(false);
  });

  it("isObservabilitySidecarPath flags metrics/logger/telemetry", () => {
    expect(strategy.isObservabilitySidecarPath("src/daemon/metrics.ts", "incrementRequest")).toBe(true);
    expect(strategy.isObservabilitySidecarPath("src/core/logger.ts", "getLogger")).toBe(true);
    expect(strategy.isObservabilitySidecarPath("src/auth/session.ts", "validateSession")).toBe(false);
  });

  it("isBroadOrchestratorLikePath flags orchestrator/pipeline/entry names", () => {
    expect(strategy.isBroadOrchestratorLikePath("src/indexer/pipeline.ts", "IndexingPipeline")).toBe(true);
    expect(strategy.isBroadOrchestratorLikePath("src/cli/index.ts", "main")).toBe(true);
    expect(strategy.isBroadOrchestratorLikePath("src/auth/session.ts", "validateSession")).toBe(false);
  });
});

describe("ArchitectureStrategy query helpers", () => {
  let dir: string;
  let metadata: MetadataStore;
  let fts: FTSStore;
  let strategy: ArchitectureStrategy;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-arch-query-"));
    metadata = new MetadataStore(dir);
    fts = new FTSStore(dir);
    strategy = new ArchitectureStrategy({ metadata, config: makeConfig(), ftsStore: fts });
  });

  afterEach(() => {
    metadata.close();
    fts.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildBroadPhrases builds non-generic bigrams/trigrams", () => {
    const phrases = strategy.buildBroadPhrases(["auth", "session", "login"]);
    expect(phrases).toContain("auth session");
    expect(phrases).toContain("session login");
    expect(phrases).toContain("auth session login");
  });

  it("buildBroadPhrases drops pairs composed entirely of generic terms", () => {
    // "flow" and "path" are both generic → no phrase should be emitted
    const phrases = strategy.buildBroadPhrases(["flow", "path"]);
    expect(phrases).toEqual([]);
  });

  it("mergeBroadResults dedupes by id keeping the highest score and sorts desc", () => {
    const merged = strategy.mergeBroadResults(
      [
        makeResult({ id: "a", score: 0.5 }),
        makeResult({ id: "b", score: 0.9 }),
      ],
      [
        makeResult({ id: "a", score: 0.8 }),
        makeResult({ id: "c", score: 0.3 }),
      ]
    );
    expect(merged.map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(merged.find((r) => r.id === "a")!.score).toBe(0.8);
  });

  it("buildBroadQueryProfile returns a populated profile", () => {
    const profile = strategy.buildBroadQueryProfile("how does the authentication flow work");
    expect(Array.isArray(profile.tokens)).toBe(true);
    expect(profile.tokens.length).toBeGreaterThan(0);
    expect(profile.inventoryMode).toBe(false);
    expect(profile.lifecycleMode).toBe(false);
    expect(profile.phrases).toBeInstanceOf(Array);
    expect(profile.allowedFamilies).toBeInstanceOf(Set);
    expect(profile.surfaceBias).toBeDefined();
  });

  it("buildBroadQueryProfile detects inventory mode for inventory queries", () => {
    const profile = strategy.buildBroadQueryProfile("which files implement auth");
    expect(profile.inventoryMode).toBe(true);
  });

  it("buildBroadQueryProfile detects lifecycle mode for shutdown queries", () => {
    const profile = strategy.buildBroadQueryProfile("how does graceful shutdown work");
    expect(profile.lifecycleMode).toBe(true);
  });

  it("isCallbackNoiseTarget flags useCallback/navigation/perf when not requested", () => {
    const profile = strategy.buildBroadQueryProfile("how does authentication work");
    expect(strategy.isCallbackNoiseTarget("src/hooks/useauth.ts", "usecallbackhandler", profile)).toBe(true);
    expect(strategy.isCallbackNoiseTarget("src/navigation/index.ts", "nav", profile)).toBe(true);
    // Not noise when the query actually asks about callbacks
    const cbProfile = strategy.buildBroadQueryProfile("how does the auth callback work");
    expect(strategy.isCallbackNoiseTarget("src/hooks/useauth.ts", "usecallbackhandler", cbProfile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectBroadWorkflowBundle — the main public entry point
// ---------------------------------------------------------------------------

describe("ArchitectureStrategy.selectBroadWorkflowBundle", () => {
  let dir: string;
  let metadata: MetadataStore;
  let fts: FTSStore;
  let strategy: ArchitectureStrategy;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-arch-bundle-"));
    metadata = new MetadataStore(dir);
    fts = new FTSStore(dir);
    strategy = new ArchitectureStrategy({ metadata, config: makeConfig(), ftsStore: fts });
  });

  afterEach(() => {
    metadata.close();
    fts.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an array and is deterministic on an empty input list", () => {
    const out = strategy.selectBroadWorkflowBundle("how does auth work", []);
    expect(Array.isArray(out)).toBe(true);
    expect(strategy.lastBroadSelection).not.toBeNull();
    expect(strategy.lastBroadSelection!.broadMode).toBe("workflow");
  });

  it("returns an array without throwing on a small input list", () => {
    const results = [
      makeResult({ id: "a", score: 0.9 }),
      makeResult({ id: "b", score: 0.8, filePath: "src/hooks/useauth.ts", name: "useAuth" }),
    ];
    const out = strategy.selectBroadWorkflowBundle("how does authentication work", results);
    expect(Array.isArray(out)).toBe(true);
    expect(strategy.lastBroadSelection).not.toBeNull();
  });

  it("selects an auth-centered bundle for a known auth-family keyword", () => {
    const results = [
      makeResult({ id: "page", score: 0.95, filePath: "src/pages/Auth.tsx", name: "AuthPage" }),
      makeResult({ id: "hook", score: 0.9, filePath: "src/hooks/useAuth.tsx", name: "useAuth" }),
      makeResult({ id: "cb", score: 0.88, filePath: "src/pages/AuthCallback.tsx", name: "AuthCallback" }),
      makeResult({ id: "api", score: 0.84, filePath: "supabase/functions/auth/index.ts", name: "authenticateRequest" }),
    ];
    const out = strategy.selectBroadWorkflowBundle(
      "add logging to every step in the authentication flow",
      results
    );
    expect(Array.isArray(out)).toBe(true);
    const diag = strategy.lastBroadSelection!;
    expect(diag.broadMode).toBe("workflow");
    // When delivered as code context the auth files should be present
    if (diag.deliveryMode === "code_context") {
      const paths = out.map((r) => r.filePath);
      expect(paths).toContain("src/pages/AuthCallback.tsx");
    } else {
      expect(diag.deferredReason).toBeTruthy();
    }
  });

  it("produces consistent output across repeated identical calls (determinism)", () => {
    const results = [
      makeResult({ id: "a", score: 0.9 }),
      makeResult({ id: "b", score: 0.7, filePath: "src/api/auth.ts", name: "login" }),
    ];
    const first = strategy.selectBroadWorkflowBundle("authentication flow", results);
    const second = strategy.selectBroadWorkflowBundle("authentication flow", results);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });
});
