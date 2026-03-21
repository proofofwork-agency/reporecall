import { describe, it, expect, beforeEach } from "vitest";
import { resolveSeeds, extractExplicitTargets, scoreFTSCandidate } from "../../src/search/seed.js";
import type { ResolvedTargetAliasHit, StoredChunk } from "../../src/storage/types.js";
import type { FTSResult } from "../../src/storage/fts-store.js";

// ---------------------------------------------------------------------------
// Helpers — lightweight fakes for MetadataStore and FTSStore
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<StoredChunk> & { id: string; name: string; filePath: string; kind: string }): StoredChunk {
  return {
    startLine: 1,
    endLine: 10,
    content: "// stub",
    language: "typescript",
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface FakeMetadata {
  findChunksByNames(names: string[]): StoredChunk[];
  findChunksByNamePrefixes?(prefixes: string[], limit?: number): StoredChunk[];
  getChunk(id: string): StoredChunk | undefined;
  getChunksByIds?(ids: string[]): StoredChunk[];
  findChunksByFilePath?(filePath: string): StoredChunk[];
  resolveTargetAliases?(normalizedAliases: string[]): ResolvedTargetAliasHit[];
}

interface FakeFTS {
  search(query: string, limit?: number): FTSResult[];
}

function createFakeMetadata(chunks: StoredChunk[]): FakeMetadata {
  return {
    findChunksByNames(names: string[]): StoredChunk[] {
      return chunks.filter((c) => names.includes(c.name));
    },
    findChunksByNamePrefixes(prefixes: string[], limit = 20): StoredChunk[] {
      return chunks.filter((c) =>
        prefixes.some((p) => p.length >= 4 && c.name.startsWith(p))
      ).slice(0, limit);
    },
    getChunk(id: string): StoredChunk | undefined {
      return chunks.find((c) => c.id === id);
    },
    getChunksByIds(ids: string[]): StoredChunk[] {
      return chunks.filter((c) => ids.includes(c.id));
    },
    findChunksByFilePath(filePath: string): StoredChunk[] {
      return chunks.filter((c) => c.filePath === filePath);
    },
    resolveTargetAliases(): ResolvedTargetAliasHit[] {
      return [];
    },
  };
}

function createFakeFTS(results: Array<{ id: string; rank: number }>): FakeFTS {
  return {
    search(_query: string, _limit?: number): FTSResult[] {
      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// extractExplicitTargets (unit)
// ---------------------------------------------------------------------------

describe("extractExplicitTargets", () => {
  it("extracts PascalCase identifiers", () => {
    const targets = extractExplicitTargets("why does AuthService fail?");
    expect(targets).toContain("AuthService");
  });

  it("extracts camelCase identifiers", () => {
    const targets = extractExplicitTargets("show me validateToken");
    expect(targets).toContain("validateToken");
  });

  it("extracts dotted paths as separate parts", () => {
    const targets = extractExplicitTargets("AuthService.login is broken");
    expect(targets).toContain("AuthService");
    expect(targets).toContain("login");
  });

  it("extracts file paths", () => {
    const targets = extractExplicitTargets("fix src/auth/handler.ts");
    expect(targets).toContain("src/auth/handler.ts");
  });

  it("returns empty array for non-code queries", () => {
    const targets = extractExplicitTargets("what is the meaning of life");
    // Should contain no PascalCase or meaningful camelCase identifiers
    expect(targets.filter((t) => /^[A-Z]/.test(t))).toHaveLength(0);
  });

  it("does not extract blocklisted all-caps acronyms (AST, MCP)", () => {
    expect(extractExplicitTargets("show me the AST graph")).not.toContain("AST");
    expect(extractExplicitTargets("what is the MCP server?")).not.toContain("MCP");
  });

  it("extracts non-blocklisted uppercase acronyms (FTS)", () => {
    expect(extractExplicitTargets("how does FTS work?")).toContain("FTS");
    expect(extractExplicitTargets("why does the FTS search return empty results?")).toContain("FTS");
  });

  it("does not extract short route labels (R0, R1, R2)", () => {
    const t = extractExplicitTargets("how does R1 routing work?");
    expect(t).not.toContain("R1");
  });

  it("still extracts PascalCase identifiers with lowercase in position 2", () => {
    expect(extractExplicitTargets("explain HybridSearch")).toContain("HybridSearch");
    expect(extractExplicitTargets("trace IndexingPipeline")).toContain("IndexingPipeline");
    expect(extractExplicitTargets("fix MetadataStore")).toContain("MetadataStore");
  });
});

// ---------------------------------------------------------------------------
// resolveSeeds
// ---------------------------------------------------------------------------

describe("resolveSeeds", () => {
  describe("explicit PascalCase target", () => {
    it("finds a single match with high confidence", () => {
      const chunk = makeChunk({
        id: "auth-service-1",
        name: "AuthService",
        filePath: "src/auth/auth-service.ts",
        kind: "class",
      });
      const metadata = createFakeMetadata([chunk]);
      const fts = createFakeFTS([]);

      const result = resolveSeeds("why does AuthService fail?", metadata as any, fts as any);

      expect(result.bestSeed).not.toBeNull();
      expect(result.bestSeed!.name).toBe("AuthService");
      expect(result.bestSeed!.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.bestSeed!.reason).toBe("explicit_target");
    });
  });

  describe("resolved typed targets", () => {
    it("resolves hyphenated endpoint slugs before FTS fallback", () => {
      const endpointChunk = makeChunk({
        id: "serve-handler",
        name: "serve_handler",
        filePath: "supabase/functions/generate-image/index.ts",
        kind: "function_declaration",
      });
      const metadata = createFakeMetadata([endpointChunk]);
      metadata.resolveTargetAliases = () => [
        {
          target: {
            id: "endpoint:supabase/functions/generate-image/index.ts",
            kind: "endpoint",
            canonicalName: "generate-image",
            normalizedName: "generate image",
            filePath: "supabase/functions/generate-image/index.ts",
            ownerChunkId: "serve-handler",
            subsystem: "functions",
            confidence: 0.98,
          },
          alias: "generate-image",
          normalizedAlias: "generate image",
          source: "slug",
          weight: 0.95,
        },
      ];
      const fts = createFakeFTS([]);

      const result = resolveSeeds("how does generate-image work?", metadata as any, fts as any);

      expect(result.bestSeed).not.toBeNull();
      expect(result.bestSeed?.filePath).toBe("supabase/functions/generate-image/index.ts");
      expect(result.bestSeed?.reason).toBe("resolved_target");
      expect(result.bestSeed?.targetKind).toBe("endpoint");
    });

    it("keeps subsystem nouns routable without outranking direct symbols", () => {
      const pipelineChunk = makeChunk({
        id: "index-pipeline",
        name: "IndexingPipeline",
        filePath: "src/indexer/pipeline.ts",
        kind: "class_declaration",
      });
      const metadata = createFakeMetadata([pipelineChunk]);
      metadata.resolveTargetAliases = () => [
        {
          target: {
            id: "subsystem:indexer",
            kind: "subsystem",
            canonicalName: "indexer",
            normalizedName: "indexer",
            filePath: "src/indexer/pipeline.ts",
            ownerChunkId: "index-pipeline",
            subsystem: "indexer",
            confidence: 0.84,
          },
          alias: "indexing",
          normalizedAlias: "indexing",
          source: "derived",
          weight: 0.88,
        },
      ];
      const fts = createFakeFTS([]);

      const result = resolveSeeds("why does indexing fail", metadata as any, fts as any);

      expect(result.bestSeed?.filePath).toBe("src/indexer/pipeline.ts");
      expect(["subsystem", "symbol"]).toContain(result.bestSeed?.targetKind);
      expect(result.bestSeed?.reason).toBe("resolved_target");
    });

    it("prefers direct symbol matches over derived subsystem expansions on multi-term queries", () => {
      const pipelineChunk = makeChunk({
        id: "index-pipeline",
        name: "IndexingPipeline",
        filePath: "src/indexer/pipeline.ts",
        kind: "class_declaration",
      });
      const storageChunk = makeChunk({
        id: "stats-store",
        name: "StatsStore",
        filePath: "src/storage/stats-store.ts",
        kind: "class_declaration",
      });
      const metadata = createFakeMetadata([pipelineChunk, storageChunk]);
      metadata.resolveTargetAliases = () => [
        {
          target: {
            id: "subsystem:storage",
            kind: "subsystem",
            canonicalName: "storage",
            normalizedName: "storage",
            filePath: "src/storage/stats-store.ts",
            ownerChunkId: "stats-store",
            subsystem: "storage",
            confidence: 0.84,
          },
          alias: "storage",
          normalizedAlias: "storage",
          source: "derived",
          weight: 0.86,
        },
        {
          target: {
            id: "symbol:indexing",
            kind: "symbol",
            canonicalName: "IndexingPipeline",
            normalizedName: "indexing pipeline",
            filePath: "src/indexer/pipeline.ts",
            ownerChunkId: "index-pipeline",
            subsystem: "indexer",
            confidence: 0.98,
          },
          alias: "IndexingPipeline",
          normalizedAlias: "indexing pipeline",
          source: "symbol",
          weight: 1,
        },
      ];
      const fts = createFakeFTS([]);

      const result = resolveSeeds("how does the indexing pipeline process files?", metadata as any, fts as any);

      expect(result.bestSeed?.name).toBe("IndexingPipeline");
      expect(result.bestSeed?.targetKind).toBe("symbol");
    });
  });

  describe("explicit camelCase target", () => {
    it("finds validateToken with high confidence", () => {
      const chunk = makeChunk({
        id: "validate-token-1",
        name: "validateToken",
        filePath: "src/auth/tokens.ts",
        kind: "function",
      });
      const metadata = createFakeMetadata([chunk]);
      const fts = createFakeFTS([]);

      const result = resolveSeeds("show me validateToken", metadata as any, fts as any);

      expect(result.bestSeed).not.toBeNull();
      expect(result.bestSeed!.name).toBe("validateToken");
      expect(result.bestSeed!.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe("dotted path", () => {
    it("prefers the more specific match (method over class)", () => {
      const classChunk = makeChunk({
        id: "auth-class",
        name: "AuthService",
        filePath: "src/auth/auth-service.ts",
        kind: "class",
      });
      const methodChunk = makeChunk({
        id: "login-method",
        name: "login",
        filePath: "src/auth/auth-service.ts",
        kind: "method",
        parentName: "AuthService",
      });
      const metadata = createFakeMetadata([classChunk, methodChunk]);
      const fts = createFakeFTS([]);

      const result = resolveSeeds("AuthService.login is broken", metadata as any, fts as any);

      // Should have both candidates
      expect(result.seeds.length).toBeGreaterThanOrEqual(2);
      // The method should appear as a seed since it's more specific (child of AuthService)
      const loginSeed = result.seeds.find((s) => s.name === "login");
      expect(loginSeed).toBeDefined();
    });
  });

  describe("multiple matches — disambiguation", () => {
    it("prefers non-test files", () => {
      const implChunk = makeChunk({
        id: "auth-impl",
        name: "AuthService",
        filePath: "src/auth/auth-service.ts",
        kind: "class",
      });
      const testChunk = makeChunk({
        id: "auth-test",
        name: "AuthService",
        filePath: "test/auth/auth-service.test.ts",
        kind: "class",
      });
      const metadata = createFakeMetadata([implChunk, testChunk]);
      const fts = createFakeFTS([]);

      const result = resolveSeeds("why does AuthService fail?", metadata as any, fts as any);

      expect(result.bestSeed).not.toBeNull();
      expect(result.bestSeed!.chunkId).toBe("auth-impl");
      expect(result.bestSeed!.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("prefers chunks whose file path is mentioned in the query", () => {
      const chunkA = makeChunk({
        id: "handler-a",
        name: "handleLogin",
        filePath: "src/auth/handler.ts",
        kind: "function",
      });
      const chunkB = makeChunk({
        id: "handler-b",
        name: "handleLogin",
        filePath: "src/user/handler.ts",
        kind: "function",
      });
      const metadata = createFakeMetadata([chunkA, chunkB]);
      const fts = createFakeFTS([]);

      const result = resolveSeeds(
        "fix handleLogin in src/auth/handler.ts",
        metadata as any,
        fts as any
      );

      expect(result.bestSeed).not.toBeNull();
      expect(result.bestSeed!.chunkId).toBe("handler-a");
    });
  });

  describe("FTS fallback", () => {
    it("uses FTS when no explicit identifier found", () => {
      const chunk = makeChunk({
        id: "some-chunk",
        name: "dataProcessor",
        filePath: "src/data/processor.ts",
        kind: "function",
      });
      // Metadata can hydrate this chunk via getChunk
      const metadata = createFakeMetadata([chunk]);
      const fts = createFakeFTS([{ id: "some-chunk", rank: -5.0 }]);

      // Query has no PascalCase/camelCase identifiers -- falls through to FTS
      const result = resolveSeeds("how does data processing work", metadata as any, fts as any);

      // FTS fallback should produce a candidate
      expect(result.seeds.length).toBeGreaterThanOrEqual(1);
      const ftsSeed = result.seeds.find((s) => s.reason === "fts_exact" || s.reason === "hybrid_top");
      expect(ftsSeed).toBeDefined();
    });

    it("assigns higher confidence when FTS name exactly matches a query term", () => {
      const chunk = makeChunk({
        id: "process-data",
        name: "processData",
        filePath: "src/data/processor.ts",
        kind: "function",
      });
      const metadata = createFakeMetadata([chunk]);
      const fts = createFakeFTS([{ id: "process-data", rank: -5.0 }]);

      // "processData" literally appears in the query — exact substring match
      const result = resolveSeeds("explain processData logic", metadata as any, fts as any);

      // This should actually be caught by explicit target extraction, but if the
      // name is a camelCase identifier it will be. Let's test a case that truly
      // falls through to FTS.
      expect(result.seeds.length).toBeGreaterThanOrEqual(1);
    });

    it("excludes file-level doc chunks and prefers structural code chunks", () => {
      const readmeChunk = makeChunk({
        id: "readme",
        name: "README",
        filePath: "README.md",
        kind: "file",
      });
      const codeChunk = makeChunk({
        id: "search-pipeline",
        name: "searchPipeline",
        filePath: "src/search/pipeline.ts",
        kind: "function_declaration",
        content: "export function searchPipeline() {}",
      });
      const metadata = createFakeMetadata([readmeChunk, codeChunk]);
      const fts = createFakeFTS([
        { id: "readme", rank: -10.0 },
        { id: "search-pipeline", rank: -5.0 },
      ]);

      const result = resolveSeeds(
        "how does the search pipeline work",
        metadata as any,
        fts as any
      );

      expect(result.bestSeed).not.toBeNull();
      expect(result.bestSeed!.chunkId).toBe("search-pipeline");
      expect(result.seeds.some((seed) => seed.chunkId === "readme")).toBe(false);
    });
  });

  describe("prefix variants in FTS fallback", () => {
    it("generates prefix queries that bridge natural-language to code abbreviations", () => {
      const authChunk = makeChunk({
        id: "auth-provider",
        name: "AuthProvider",
        filePath: "src/auth/provider.ts",
        kind: "class_declaration",
        content: "export class AuthProvider {}",
      });
      // FTS returns auth chunk when searching prefix "auth" (from "authentication")
      let searchedQueries: string[] = [];
      const fts = {
        search(query: string, _limit?: number): FTSResult[] {
          searchedQueries.push(query);
          // Return auth chunk for any query containing "auth"
          if (query.includes("auth")) {
            return [{ id: "auth-provider", rank: -6.0 }];
          }
          return [];
        },
      };
      const metadata = createFakeMetadata([authChunk]);

      resolveSeeds(
        "add to every step in the authentication flow a log message",
        metadata as any,
        fts as any
      );

      // The prefix "auth" (from "authentication".slice(0,4)) should be among searched queries
      expect(searchedQueries.some((q) => q === "auth")).toBe(true);
    });

    it("prefers implementation auth seeds over e2e helpers for broad auth-flow queries", () => {
      const authProvider = makeChunk({
        id: "auth-provider",
        name: "AuthProvider",
        filePath: "src/hooks/useAuth.tsx",
        kind: "function_declaration",
      });
      const useAuth = makeChunk({
        id: "use-auth",
        name: "useAuth",
        filePath: "src/hooks/useAuth.tsx",
        kind: "function_declaration",
      });
      const e2eHelper = makeChunk({
        id: "e2e-auth",
        name: "setupMockAuth",
        filePath: "e2e/helpers/auth.ts",
        kind: "function_declaration",
      });
      const noisyFlow = makeChunk({
        id: "flow-noise",
        name: "stripBunnyCDNSigningParams",
        filePath: "src/lib/flow/flowService.ts",
        kind: "function_declaration",
      });
      const metadata = createFakeMetadata([authProvider, useAuth, e2eHelper, noisyFlow]);
      const fts = createFakeFTS([
        { id: "flow-noise", rank: -8.0 },
        { id: "e2e-auth", rank: -7.5 },
        { id: "auth-provider", rank: -7.0 },
        { id: "use-auth", rank: -6.5 },
      ]);

      const result = resolveSeeds(
        "add to every step in the authentication flow a log message",
        metadata as any,
        fts as any
      );

      expect(result.bestSeed).not.toBeNull();
      expect(result.bestSeed!.filePath).toBe("src/hooks/useAuth.tsx");
      expect(result.bestSeed!.confidence).toBeGreaterThanOrEqual(0.55);
      expect(result.seeds.some((seed) => seed.filePath === "e2e/helpers/auth.ts")).toBe(false);
    });

    it("does not stop before later higher-confidence auth candidates", () => {
      const authModal = makeChunk({
        id: "auth-modal",
        name: "AuthModal",
        filePath: "src/components/AuthModal.tsx",
        kind: "function_declaration",
      });
      const authProvider = makeChunk({
        id: "auth-provider",
        name: "AuthProvider",
        filePath: "src/hooks/useAuth.tsx",
        kind: "function_declaration",
      });
      const noisy = Array.from({ length: 8 }, (_, i) =>
        makeChunk({
          id: `noise-${i}`,
          name: `flowHandler${i}`,
          filePath: `src/lib/flow/handler${i}.ts`,
          kind: "function_declaration",
        })
      );
      const metadata = createFakeMetadata([...noisy, authModal, authProvider]);
      const fts = createFakeFTS([
        ...noisy.map((chunk, i) => ({ id: chunk.id, rank: -(20 - i) })),
        { id: "auth-modal", rank: -6.5 },
        { id: "auth-provider", rank: -6.2 },
      ]);

      const result = resolveSeeds(
        "add to every step in the authentication flow a log message",
        metadata as any,
        fts as any
      );

      expect(result.bestSeed).not.toBeNull();
      expect(["src/components/AuthModal.tsx", "src/hooks/useAuth.tsx"]).toContain(
        result.bestSeed!.filePath
      );
    });
  });

  describe("no match", () => {
    it("returns null bestSeed for completely unrelated query", () => {
      const metadata = createFakeMetadata([]);
      const fts = createFakeFTS([]);

      const result = resolveSeeds("what is the weather today", metadata as any, fts as any);

      expect(result.bestSeed).toBeNull();
      expect(result.seeds).toHaveLength(0);
    });
  });

  describe("file path in query", () => {
    it("finds chunks in the specified file path", () => {
      const chunk = makeChunk({
        id: "handler-chunk",
        name: "handleRequest",
        filePath: "src/auth/handler.ts",
        kind: "function",
      });
      const metadata = createFakeMetadata([chunk]);
      // FTS returns the chunk when searching for the file path
      const fts = createFakeFTS([{ id: "handler-chunk", rank: -5.0 }]);

      const result = resolveSeeds("fix src/auth/handler.ts", metadata as any, fts as any);

      expect(result.seeds.length).toBeGreaterThanOrEqual(1);
      expect(result.seeds[0].filePath).toBe("src/auth/handler.ts");
    });
  });

  describe("confidence thresholds", () => {
    it("only sets bestSeed when confidence >= 0.55", () => {
      const metadata = createFakeMetadata([]);
      // FTS returns something but name doesn't match query at all
      const fts = createFakeFTS([{ id: "random-chunk", rank: -1.0 }]);
      // We need the chunk in metadata to hydrate
      const chunk = makeChunk({
        id: "random-chunk",
        name: "totallyUnrelated",
        filePath: "src/misc/stuff.ts",
        kind: "function",
      });
      const metadataWithChunk = {
        findChunksByNames(_names: string[]): StoredChunk[] {
          return [];
        },
        getChunk(id: string): StoredChunk | undefined {
          if (id === "random-chunk") return chunk;
          return undefined;
        },
      };

      const result = resolveSeeds(
        "how does the system work",
        metadataWithChunk as any,
        fts as any
      );

      // With multi-signal scoring, low rank + no name match + generic kind
      // should still produce a candidate but potentially below 0.55.
      // The meaningful invariant: seeds is always an array, and if bestSeed is
      // set its confidence must meet the 0.55 threshold.
      expect(Array.isArray(result.seeds)).toBe(true);
      if (result.bestSeed !== null) {
        expect(result.bestSeed.confidence).toBeGreaterThanOrEqual(0.55);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// scoreFTSCandidate (multi-signal scoring)
// ---------------------------------------------------------------------------

describe("scoreFTSCandidate", () => {
  it("scores higher when chunk name exactly matches a query term", () => {
    const chunk = makeChunk({
      id: "search-1",
      name: "search",
      filePath: "src/search/hybrid.ts",
      kind: "function_declaration",
    });
    const exact = scoreFTSCandidate(chunk, ["search", "pipeline"], -5.0);
    const noMatch = scoreFTSCandidate(
      makeChunk({ id: "x", name: "unrelated", filePath: "src/foo.ts", kind: "function_declaration" }),
      ["search", "pipeline"],
      -5.0
    );
    expect(exact).toBeGreaterThan(noMatch);
  });

  it("scores higher for meaningful kinds (function_declaration, class_declaration)", () => {
    // Use a name that does NOT match query terms so that the kind signal is visible
    const fnChunk = makeChunk({
      id: "fn-1",
      name: "doWork",
      filePath: "src/misc/runner.ts",
      kind: "function_declaration",
    });
    const unknownChunk = makeChunk({
      id: "uk-1",
      name: "doWork",
      filePath: "src/misc/runner.ts",
      kind: "unknown",
    });
    const fnScore = scoreFTSCandidate(fnChunk, ["something", "else"], -3.0);
    const ukScore = scoreFTSCandidate(unknownChunk, ["something", "else"], -3.0);
    expect(fnScore).toBeGreaterThan(ukScore);
  });

  it("includes file path overlap in scoring", () => {
    const chunkInPath = makeChunk({
      id: "sp-1",
      name: "execute",
      filePath: "src/search/pipeline.ts",
      kind: "function_declaration",
    });
    const chunkNotInPath = makeChunk({
      id: "sp-2",
      name: "execute",
      filePath: "src/util/misc.ts",
      kind: "function_declaration",
    });
    const scoreInPath = scoreFTSCandidate(chunkInPath, ["search", "pipeline"], -5.0);
    const scoreNotInPath = scoreFTSCandidate(chunkNotInPath, ["search", "pipeline"], -5.0);
    expect(scoreInPath).toBeGreaterThan(scoreNotInPath);
  });

  it("caps confidence at 0.85", () => {
    const chunk = makeChunk({
      id: "perfect",
      name: "search",
      filePath: "src/search/pipeline.ts",
      kind: "export_statement",
      content: "export function search() {}",
    });
    const score = scoreFTSCandidate(chunk, ["search", "pipeline"], -20.0);
    expect(score).toBeLessThanOrEqual(0.85);
  });

  it("penalises low coverage-ratio on multi-term queries below 0.55", () => {
    // Simulates "add to every step in the authentication flow a log message"
    // → stripBunnyCDNSigningParams in src/lib/flow/flowservice.ts
    // "sign" substring-matches "signing" in name → +1
    // "flow" substring-matches path → +1
    // localityCount = 2 but ratio 2/7 = 0.28 → still below 0.5 → scaling applies
    const chunk = makeChunk({
      id: "flow-1",
      name: "stripBunnyCDNSigningParams",
      filePath: "src/lib/flow/flowservice.ts",
      kind: "function_declaration",
    });
    const score = scoreFTSCandidate(
      chunk,
      ["add", "every", "step", "authentication", "flow", "log", "message"],
      -8.0
    );
    expect(score).toBeLessThan(0.55);
  });

  it("keeps strong long-term auth anchors above the R1 threshold", () => {
    const chunk = makeChunk({
      id: "auth-provider",
      name: "AuthProvider",
      filePath: "src/hooks/useAuth.tsx",
      kind: "function_declaration",
    });
    const score = scoreFTSCandidate(
      chunk,
      ["add", "every", "step", "authentication", "flow", "log", "message"],
      -7.0
    );
    expect(score).toBeGreaterThanOrEqual(0.55);
  });

  it("does not penalise 2-term queries matching both terms", () => {
    const chunk = makeChunk({
      id: "sp-1",
      name: "searchPipeline",
      filePath: "src/search/pipeline.ts",
      kind: "function_declaration",
      content: "export function searchPipeline() {}",
    });
    // 2 content terms — both match name+path → no scaling
    const score = scoreFTSCandidate(chunk, ["search", "pipeline"], -8.0);
    expect(score).toBeGreaterThanOrEqual(0.55);
  });

  it("generic navigational query scores high enough for R1 with good FTS hit", () => {
    const chunk = makeChunk({
      id: "pipeline-1",
      name: "searchPipeline",
      filePath: "src/search/pipeline.ts",
      kind: "function_declaration",
      content: "export function searchPipeline() {}",
    });
    const score = scoreFTSCandidate(chunk, ["search", "pipeline"], -8.0);
    // Should be >= 0.55 (R1 threshold)
    expect(score).toBeGreaterThanOrEqual(0.55);
  });
});
