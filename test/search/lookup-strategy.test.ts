import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import type { StoredChunk } from "../../src/storage/types.js";
import type { SeedCandidate, SeedResult } from "../../src/search/seed.js";
import { buildFocusedExactResults } from "../../src/search/lookup-strategy.js";

function tmpDir(): string {
  const dir = join(tmpdir(), `lookup-strategy-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeChunk(overrides: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id: randomUUID(),
    filePath: "src/foo.ts",
    name: "fooFunction",
    kind: "function_declaration",
    startLine: 1,
    endLine: 10,
    content: "function fooFunction() {}",
    docstring: undefined,
    parentName: undefined,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    fileMtime: undefined,
    ...overrides,
  };
}

function makeSeed(chunk: StoredChunk, overrides: Partial<SeedCandidate> = {}): SeedCandidate {
  return {
    chunkId: chunk.id,
    name: chunk.name,
    filePath: chunk.filePath,
    kind: chunk.kind,
    confidence: 0.8,
    reason: "explicit_target",
    ...overrides,
  };
}

describe("buildFocusedExactResults — seed/query anchor gate", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it("returns the primary seed when ≥2 query anchors match its file path or name", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);
    const chunk = makeChunk({
      filePath: "src/indexer/pipeline.ts",
      name: "rebuildIndex",
    });
    store.upsertFile(chunk.filePath, "hash");
    store.upsertChunk(chunk);

    const seed = makeSeed(chunk);
    const seedResult: SeedResult = { seeds: [seed], bestSeed: seed };

    const results = buildFocusedExactResults(
      "find indexer rebuild function",
      seedResult,
      5,
      store,
    );
    expect(results).not.toBeNull();
    expect(results!.length).toBeGreaterThan(0);
    expect(results![0].filePath).toBe("src/indexer/pipeline.ts");

    store.close();
  });

  it("rejects a confident-wrong primary seed whose file/name share no query anchors", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    // A seed with reason "resolved_target" pointing to a totally unrelated file.
    // The current code would return it with score 3.0 regardless; with the
    // anchor gate it must fall through to null (broader retrieval).
    const irrelevantChunk = makeChunk({
      filePath: "src/parser/chunker.ts",
      name: "extractChunks",
    });
    store.upsertFile(irrelevantChunk.filePath, "hash");
    store.upsertChunk(irrelevantChunk);

    const seed = makeSeed(irrelevantChunk, { reason: "resolved_target" });
    const seedResult: SeedResult = { seeds: [seed], bestSeed: seed };

    const results = buildFocusedExactResults(
      "where is the fts rebuild scheduled in the indexer pipeline",
      seedResult,
      5,
      store,
    );
    expect(results).toBeNull();

    store.close();
  });

  it("bypasses the anchor gate for short queries (<2 non-generic anchors)", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);
    const chunk = makeChunk({
      filePath: "src/auth/useAuth.tsx",
      name: "useAuth",
    });
    store.upsertFile(chunk.filePath, "hash");
    store.upsertChunk(chunk);

    const seed = makeSeed(chunk);
    const seedResult: SeedResult = { seeds: [seed], bestSeed: seed };

    // "show useAuth" → 1 anchor after filtering generic action terms; gate bypassed.
    const results = buildFocusedExactResults("show useAuth", seedResult, 5, store);
    expect(results).not.toBeNull();
    expect(results![0].name).toBe("useAuth");

    store.close();
  });
});
