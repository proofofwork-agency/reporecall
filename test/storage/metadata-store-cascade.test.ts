import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import type { StoredChunk } from "../../src/storage/types.js";

function tmpDir(): string {
  const dir = join(tmpdir(), `metadata-cascade-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeChunk(overrides: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id: randomUUID(),
    filePath: "src/cascade.ts",
    name: "myFunction",
    kind: "function_declaration",
    startLine: 1,
    endLine: 10,
    content: "function myFunction() {}",
    docstring: undefined,
    parentName: undefined,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    fileMtime: undefined,
    ...overrides,
  };
}

describe("MetadataStore cascade delete", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true });
      } catch {
        // ignore
      }
    }
    dirs.length = 0;
  });

  it("removes targets and community memberships when removeFile is called", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    const filePath = "src/billing.ts";
    const chunkA = makeChunk({ id: "chunk-a", filePath, name: "processPayment" });
    const chunkB = makeChunk({ id: "chunk-b", filePath, name: "createInvoice" });

    store.upsertFile(filePath, "hash-1");
    store.upsertChunk(chunkA);
    store.upsertChunk(chunkB);

    // Insert a target keyed by file_path
    store.replaceAllTargets(
      [
        {
          id: "target-1",
          kind: "symbol",
          canonicalName: "processPayment",
          normalizedName: "processpayment",
          filePath,
          ownerChunkId: "chunk-a",
          subsystem: "billing",
          confidence: 0.95,
        },
      ],
      []
    );

    // Insert a community membership keyed by chunk_id
    store.replaceTopology({
      communities: [
        {
          id: "comm-1",
          nodeCount: 2,
          cohesion: 0.8,
          label: "billing",
          computedAt: new Date().toISOString(),
        },
      ],
      memberships: [
        { chunkId: "chunk-a", communityId: "comm-1" },
        { chunkId: "chunk-b", communityId: "comm-1" },
      ],
      surprises: [],
      godNodes: [
        {
          chunkId: "chunk-a",
          name: "processPayment",
          filePath,
          degree: 5,
          communityId: "comm-1",
        },
      ],
      questions: [],
      computedAt: new Date().toISOString(),
    });

    // regression: cascade-delete should clean up targets and topology rows
    expect(store.findTargetsByFilePath(filePath)).toHaveLength(1);
    expect(store.getCommunityForChunk("chunk-a")).toBe("comm-1");

    store.removeFile(filePath);

    // Targets must be gone — no orphans
    expect(store.findTargetsByFilePath(filePath)).toEqual([]);
    // Community memberships must be gone
    expect(store.getCommunityForChunk("chunk-a")).toBeUndefined();
    expect(store.getCommunityForChunk("chunk-b")).toBeUndefined();
    // God nodes must be gone
    expect(store.getGodNodes().filter((g) => g.chunkId === "chunk-a")).toHaveLength(0);
    // Chunks themselves must be gone
    expect(store.findChunksByFilePath(filePath)).toHaveLength(0);

    store.close();
  });

  it("removes targets and community memberships when removeFiles is called in batch", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    const filePath = "src/auth.ts";
    const chunk = makeChunk({ id: "chunk-x", filePath, name: "login" });

    store.upsertFile(filePath, "hash-2");
    store.upsertChunk(chunk);

    store.replaceAllTargets(
      [
        {
          id: "target-2",
          kind: "symbol",
          canonicalName: "login",
          normalizedName: "login",
          filePath,
          ownerChunkId: "chunk-x",
          confidence: 0.9,
        },
      ],
      []
    );

    store.replaceTopology({
      communities: [
        {
          id: "comm-2",
          nodeCount: 1,
          cohesion: 0.5,
          label: null,
          computedAt: new Date().toISOString(),
        },
      ],
      memberships: [{ chunkId: "chunk-x", communityId: "comm-2" }],
      surprises: [],
      godNodes: [],
      questions: [],
      computedAt: new Date().toISOString(),
    });

    expect(store.findTargetsByFilePath(filePath)).toHaveLength(1);
    expect(store.getCommunityForChunk("chunk-x")).toBe("comm-2");

    store.removeFiles([filePath]);

    expect(store.findTargetsByFilePath(filePath)).toEqual([]);
    expect(store.getCommunityForChunk("chunk-x")).toBeUndefined();

    store.close();
  });

  it("preserves targets and memberships for other files", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    const deletePath = "src/old.ts";
    const keepPath = "src/active.ts";

    store.upsertFile(deletePath, "h1");
    store.upsertFile(keepPath, "h2");
    store.upsertChunk(makeChunk({ id: "c-del", filePath: deletePath }));
    store.upsertChunk(makeChunk({ id: "c-keep", filePath: keepPath }));

    store.replaceAllTargets(
      [
        {
          id: "t-del",
          kind: "symbol",
          canonicalName: "old",
          normalizedName: "old",
          filePath: deletePath,
          confidence: 0.5,
        },
        {
          id: "t-keep",
          kind: "symbol",
          canonicalName: "active",
          normalizedName: "active",
          filePath: keepPath,
          confidence: 0.9,
        },
      ],
      []
    );

    store.replaceTopology({
      communities: [
        {
          id: "comm-x",
          nodeCount: 2,
          cohesion: 0.7,
          label: null,
          computedAt: new Date().toISOString(),
        },
      ],
      memberships: [
        { chunkId: "c-del", communityId: "comm-x" },
        { chunkId: "c-keep", communityId: "comm-x" },
      ],
      surprises: [],
      godNodes: [],
      questions: [],
      computedAt: new Date().toISOString(),
    });

    store.removeFile(deletePath);

    expect(store.findTargetsByFilePath(deletePath)).toEqual([]);
    expect(store.findTargetsByFilePath(keepPath)).toHaveLength(1);
    expect(store.getCommunityForChunk("c-del")).toBeUndefined();
    expect(store.getCommunityForChunk("c-keep")).toBe("comm-x");

    store.close();
  });
});
