import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { ChunkStore } from "../../src/storage/chunk-store.js";
import { CallEdgeStore } from "../../src/storage/call-edge-store.js";
import type { StoredChunk } from "../../src/storage/types.js";
import type { CallEdge } from "../../src/analysis/call-graph.js";
import { buildStackTree } from "../../src/search/tree-builder.js";
import type { MetadataStore } from "../../src/storage/metadata-store.js";

/**
 * Creates a minimal MetadataStore-like object backed by real ChunkStore and
 * CallEdgeStore instances on an in-memory SQLite database.
 */
function createTestMetadata(db: Database.Database) {
  const chunks = new ChunkStore(db);
  const callEdges = new CallEdgeStore(db);
  chunks.initSchema();
  callEdges.initSchema();

  return {
    chunks,
    callEdges,
    // Only expose the methods that buildStackTree actually uses
    asFacade(): Pick<
      MetadataStore,
      "findCallers" | "findCallees" | "findCalleesForChunk" | "findChunksByNames" | "getChunksByIds" | "findChunksByFilePath" | "findTargetById"
    > {
      return {
        findCallers: (targetName: string, limit?: number, targetFilePath?: string, targetId?: string) =>
          callEdges.findCallers(targetName, limit, targetFilePath, targetId),
        findCallees: (sourceName: string, limit?: number) =>
          callEdges.findCallees(sourceName, limit),
        findCalleesForChunk: (sourceChunkId: string, limit?: number) =>
          callEdges.findCalleesForChunk(sourceChunkId, limit),
        findChunksByNames: (names: string[]) =>
          chunks.findChunksByNames(names),
        getChunksByIds: (ids: string[]) => chunks.getChunksByIds(ids),
        findChunksByFilePath: (filePath: string) => chunks.findChunksByFilePath(filePath),
        findTargetById: (_id: string) => undefined,
      };
    },
  };
}

function makeChunk(
  overrides: Partial<StoredChunk> & { id: string; name: string; filePath: string }
): StoredChunk {
  return {
    kind: "function",
    startLine: 1,
    endLine: 10,
    content: `function ${overrides.name}() {}`,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCallEdge(
  overrides: Partial<CallEdge> & {
    sourceChunkId: string;
    targetName: string;
    filePath: string;
  }
): CallEdge {
  return {
    callType: "call",
    line: 5,
    ...overrides,
  };
}

describe("buildStackTree", () => {
  let db: Database.Database;
  let tmpDir: string;
  let meta: ReturnType<typeof createTestMetadata>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tree-builder-"));
    db = new Database(join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    meta = createTestMetadata(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Helper to seed data ------------------------------------------------

  function seedChunks(...chunks: StoredChunk[]) {
    meta.chunks.bulkUpsertChunks(chunks);
  }

  function seedEdges(...edges: CallEdge[]) {
    meta.callEdges.upsertCallEdges(edges);
  }

  // ---- Tests --------------------------------------------------------------

  it("basic up-tree: returns callers at depth 1", () => {
    const seedChunk = makeChunk({ id: "seed", name: "target", filePath: "src/target.ts" });
    const callerA = makeChunk({ id: "callerA", name: "callerA", filePath: "src/a.ts" });

    seedChunks(seedChunk, callerA);
    seedEdges(
      makeCallEdge({ sourceChunkId: "callerA", targetName: "target", filePath: "src/a.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "target", filePath: "src/target.ts", kind: "function" },
      direction: "up",
    });

    expect(tree.upTree).toHaveLength(1);
    expect(tree.upTree[0].chunkId).toBe("callerA");
    expect(tree.upTree[0].depth).toBe(1);
    expect(tree.upTree[0].direction).toBe("up");
    expect(tree.downTree).toHaveLength(0);
    expect(tree.edges).toHaveLength(1);
    expect(tree.edges[0]).toEqual({ from: "callerA", to: "seed", callType: "call" });
    expect(tree.nodeCount).toBe(2);
  });

  it("basic down-tree: returns callees at depth 1", () => {
    const seedChunk = makeChunk({ id: "seed", name: "main", filePath: "src/main.ts" });
    const calleeA = makeChunk({ id: "calleeA", name: "helper", filePath: "src/helper.ts" });

    seedChunks(seedChunk, calleeA);
    seedEdges(
      makeCallEdge({ sourceChunkId: "seed", targetName: "helper", filePath: "src/main.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "main", filePath: "src/main.ts", kind: "function" },
      direction: "down",
    });

    expect(tree.downTree).toHaveLength(1);
    expect(tree.downTree[0].chunkId).toBe("calleeA");
    expect(tree.downTree[0].depth).toBe(1);
    expect(tree.downTree[0].direction).toBe("down");
    expect(tree.upTree).toHaveLength(0);
    expect(tree.edges).toHaveLength(1);
    expect(tree.edges[0]).toEqual({ from: "seed", to: "calleeA", callType: "call" });
    expect(tree.nodeCount).toBe(2);
  });

  it("both directions: returns callers AND callees", () => {
    const seedChunk = makeChunk({ id: "seed", name: "middle", filePath: "src/mid.ts" });
    const caller = makeChunk({ id: "caller1", name: "entryPoint", filePath: "src/entry.ts" });
    const callee = makeChunk({ id: "callee1", name: "utility", filePath: "src/util.ts" });

    seedChunks(seedChunk, caller, callee);
    seedEdges(
      makeCallEdge({ sourceChunkId: "caller1", targetName: "middle", filePath: "src/entry.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "utility", filePath: "src/mid.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "middle", filePath: "src/mid.ts", kind: "function" },
      direction: "both",
    });

    expect(tree.upTree).toHaveLength(1);
    expect(tree.upTree[0].name).toBe("entryPoint");
    expect(tree.downTree).toHaveLength(1);
    expect(tree.downTree[0].name).toBe("utility");
    expect(tree.nodeCount).toBe(3);
    expect(tree.edges).toHaveLength(2);
  });

  it("adds same-file siblings for endpoint/file-module seeds and skips test callers when real callers exist", () => {
    const seedChunk = makeChunk({ id: "seed", name: "serve_handler", filePath: "supabase/functions/generate-image/index.ts" });
    const sibling = makeChunk({ id: "helper", name: "isInternalServiceRequest", filePath: "supabase/functions/generate-image/index.ts" });
    const realCaller = makeChunk({ id: "caller-real", name: "generate_image", filePath: "supabase/functions/storyboard-controller/index.ts" });
    const testCaller = makeChunk({ id: "caller-test", name: "generate_image_test", filePath: "src/__tests__/storyboard-controller.test.ts" });

    seedChunks(seedChunk, sibling, realCaller, testCaller);
    seedEdges(
      makeCallEdge({
        sourceChunkId: "caller-real",
        targetName: "generate-image",
        filePath: "supabase/functions/storyboard-controller/index.ts",
        targetId: "endpoint:supabase/functions/generate-image/index.ts",
        targetKind: "endpoint",
      }),
      makeCallEdge({
        sourceChunkId: "caller-test",
        targetName: "generate-image",
        filePath: "src/__tests__/storyboard-controller.test.ts",
        targetId: "endpoint:supabase/functions/generate-image/index.ts",
        targetKind: "endpoint",
      })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: {
        chunkId: "seed",
        name: "serve_handler",
        filePath: "supabase/functions/generate-image/index.ts",
        kind: "arrow_function",
        targetId: "endpoint:supabase/functions/generate-image/index.ts",
        targetKind: "endpoint",
      },
      direction: "both",
      query: "how does generate-image work?",
    });

    expect(tree.upTree.some((node) => node.chunkId === "caller-real")).toBe(true);
    expect(tree.upTree.some((node) => node.chunkId === "caller-test")).toBe(false);
    expect(tree.downTree.some((node) => node.chunkId === "helper")).toBe(true);
  });

  it("implementation-shaped queries skip test-only callers and avoid depth-2 caller expansion", () => {
    const seedChunk = makeChunk({ id: "seed", name: "IndexingPipeline", filePath: "src/indexer/pipeline.ts" });
    const testCaller = makeChunk({ id: "caller-test", name: "describe_handler", filePath: "test/indexer/pipeline.test.ts" });
    const realCallee = makeChunk({ id: "callee-real", name: "createEmbedder", filePath: "src/indexer/embedder.ts" });
    const depth2Caller = makeChunk({ id: "caller-2", name: "testHarness", filePath: "test/indexer/harness.test.ts" });

    seedChunks(seedChunk, testCaller, realCallee, depth2Caller);
    seedEdges(
      makeCallEdge({
        sourceChunkId: "caller-test",
        targetName: "IndexingPipeline",
        filePath: "test/indexer/pipeline.test.ts",
      }),
      makeCallEdge({
        sourceChunkId: "caller-2",
        targetName: "describe_handler",
        filePath: "test/indexer/harness.test.ts",
      }),
      makeCallEdge({
        sourceChunkId: "seed",
        targetName: "createEmbedder",
        filePath: "src/indexer/pipeline.ts",
        targetFilePath: "src/indexer/embedder.ts",
      })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "IndexingPipeline", filePath: "src/indexer/pipeline.ts", kind: "class_declaration" },
      direction: "both",
      maxDepth: 2,
      query: "why does indexing fail",
    });

    expect(tree.upTree).toHaveLength(0);
    expect(tree.downTree.some((node) => node.chunkId === "callee-real")).toBe(true);
  });

  it("implementation-shaped class seeds include same-file methods before expanding outward", () => {
    const seedChunk = makeChunk({ id: "seed", name: "IndexingPipeline", filePath: "src/indexer/pipeline.ts", kind: "class_declaration" });
    const methodChunk = makeChunk({ id: "method", name: "indexAll", filePath: "src/indexer/pipeline.ts", kind: "method_definition" });
    const externalChunk = makeChunk({ id: "external", name: "MetadataStore", filePath: "src/storage/metadata-store.ts", kind: "class_declaration" });

    seedChunks(seedChunk, methodChunk, externalChunk);
    seedEdges(
      makeCallEdge({
        sourceChunkId: "seed",
        targetName: "MetadataStore",
        filePath: "src/indexer/pipeline.ts",
        targetFilePath: "src/storage/metadata-store.ts",
      })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "IndexingPipeline", filePath: "src/indexer/pipeline.ts", kind: "class_declaration" },
      direction: "both",
      query: "why does indexing fail",
    });

    expect(tree.downTree[0]?.chunkId).toBe("method");
    expect(tree.downTree.some((node) => node.chunkId === "external")).toBe(true);
  });

  it("depth limit: maxDepth=1 prevents depth-2 nodes", () => {
    const seedChunk = makeChunk({ id: "seed", name: "a", filePath: "src/a.ts" });
    const depth1 = makeChunk({ id: "b", name: "b", filePath: "src/b.ts" });
    const depth2 = makeChunk({ id: "c", name: "c", filePath: "src/c.ts" });

    seedChunks(seedChunk, depth1, depth2);
    seedEdges(
      // a calls b, b calls c
      makeCallEdge({ sourceChunkId: "seed", targetName: "b", filePath: "src/a.ts" }),
      makeCallEdge({ sourceChunkId: "b", targetName: "c", filePath: "src/b.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "a", filePath: "src/a.ts", kind: "function" },
      direction: "down",
      maxDepth: 1,
    });

    expect(tree.downTree).toHaveLength(1);
    expect(tree.downTree[0].name).toBe("b");
    expect(tree.nodeCount).toBe(2);
  });

  it("branch limit: maxBranchFactor=2 fetches up to 4 but maxNodes caps total", () => {
    const seedChunk = makeChunk({ id: "seed", name: "root", filePath: "src/root.ts" });
    const c1 = makeChunk({ id: "c1", name: "child1", filePath: "src/c1.ts" });
    const c2 = makeChunk({ id: "c2", name: "child2", filePath: "src/c2.ts" });
    const c3 = makeChunk({ id: "c3", name: "child3", filePath: "src/c3.ts" });
    const c4 = makeChunk({ id: "c4", name: "child4", filePath: "src/c4.ts" });
    const c5 = makeChunk({ id: "c5", name: "child5", filePath: "src/c5.ts" });

    seedChunks(seedChunk, c1, c2, c3, c4, c5);
    seedEdges(
      makeCallEdge({ sourceChunkId: "seed", targetName: "child1", filePath: "src/root.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "child2", filePath: "src/root.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "child3", filePath: "src/root.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "child4", filePath: "src/root.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "child5", filePath: "src/root.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "root", filePath: "src/root.ts", kind: "function" },
      direction: "down",
      maxBranchFactor: 2,
      maxNodes: 3,
    });

    // maxBranchFactor=2 fetches 4 candidates, but maxNodes=3 caps at 2 callees
    expect(tree.downTree).toHaveLength(2);
    expect(tree.nodeCount).toBe(3);
  });

  it("node limit: maxNodes=5 stops tree at 5 nodes", () => {
    // Create a wider + deeper tree
    const seedChunk = makeChunk({ id: "seed", name: "root", filePath: "src/root.ts" });
    const chunks: StoredChunk[] = [seedChunk];
    const edges: CallEdge[] = [];

    // 6 callees of root
    for (let i = 1; i <= 6; i++) {
      chunks.push(makeChunk({ id: `n${i}`, name: `fn${i}`, filePath: `src/fn${i}.ts` }));
      edges.push(
        makeCallEdge({ sourceChunkId: "seed", targetName: `fn${i}`, filePath: "src/root.ts" })
      );
    }

    seedChunks(...chunks);
    seedEdges(...edges);

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "root", filePath: "src/root.ts", kind: "function" },
      direction: "down",
      maxNodes: 5,
      maxBranchFactor: 10,
    });

    expect(tree.nodeCount).toBe(5);
    expect(tree.downTree).toHaveLength(4); // seed + 4 = 5
  });

  it("cycle detection: A calls B, B calls A does not loop", () => {
    const a = makeChunk({ id: "a", name: "funcA", filePath: "src/a.ts" });
    const b = makeChunk({ id: "b", name: "funcB", filePath: "src/b.ts" });

    seedChunks(a, b);
    seedEdges(
      makeCallEdge({ sourceChunkId: "a", targetName: "funcB", filePath: "src/a.ts" }),
      makeCallEdge({ sourceChunkId: "b", targetName: "funcA", filePath: "src/b.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "a", name: "funcA", filePath: "src/a.ts", kind: "function" },
      direction: "down",
      maxDepth: 10,
    });

    // Should visit B (callee of A), then try to visit A (callee of B) but skip due to visited
    expect(tree.downTree).toHaveLength(1);
    expect(tree.downTree[0].name).toBe("funcB");
    expect(tree.nodeCount).toBe(2);
  });

  it("empty tree: seed with no callers/callees returns empty subtrees", () => {
    const seedChunk = makeChunk({ id: "lonely", name: "lonely", filePath: "src/lonely.ts" });
    seedChunks(seedChunk);

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "lonely", name: "lonely", filePath: "src/lonely.ts", kind: "function" },
      direction: "both",
    });

    expect(tree.upTree).toHaveLength(0);
    expect(tree.downTree).toHaveLength(0);
    expect(tree.edges).toHaveLength(0);
    expect(tree.nodeCount).toBe(1);
    expect(tree.seed.chunkId).toBe("lonely");
    expect(tree.seed.direction).toBe("seed");
  });

  it("seed only in up direction: only upTree populated", () => {
    const seedChunk = makeChunk({ id: "seed", name: "target", filePath: "src/target.ts" });
    const caller = makeChunk({ id: "caller", name: "caller", filePath: "src/caller.ts" });
    const callee = makeChunk({ id: "callee", name: "callee", filePath: "src/callee.ts" });

    seedChunks(seedChunk, caller, callee);
    seedEdges(
      makeCallEdge({ sourceChunkId: "caller", targetName: "target", filePath: "src/caller.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "callee", filePath: "src/target.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "target", filePath: "src/target.ts", kind: "function" },
      direction: "up",
    });

    expect(tree.upTree).toHaveLength(1);
    expect(tree.downTree).toHaveLength(0);
    expect(tree.nodeCount).toBe(2);
  });

  it("multi-depth traversal walks depth 1 and depth 2", () => {
    const seedChunk = makeChunk({ id: "seed", name: "a", filePath: "src/a.ts" });
    const d1 = makeChunk({ id: "b", name: "b", filePath: "src/b.ts" });
    const d2 = makeChunk({ id: "c", name: "c", filePath: "src/c.ts" });

    seedChunks(seedChunk, d1, d2);
    seedEdges(
      makeCallEdge({ sourceChunkId: "seed", targetName: "b", filePath: "src/a.ts" }),
      makeCallEdge({ sourceChunkId: "b", targetName: "c", filePath: "src/b.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "a", filePath: "src/a.ts", kind: "function" },
      direction: "down",
      maxDepth: 2,
    });

    expect(tree.downTree).toHaveLength(2);
    const byDepth = tree.downTree.sort((a, b) => a.depth - b.depth);
    expect(byDepth[0]).toMatchObject({ name: "b", depth: 1 });
    expect(byDepth[1]).toMatchObject({ name: "c", depth: 2 });
    expect(tree.nodeCount).toBe(3);
    expect(tree.edges).toHaveLength(2);
  });

  it("callee resolution prefers same-file chunk", () => {
    const seedChunk = makeChunk({ id: "seed", name: "main", filePath: "src/main.ts" });
    // Two chunks with the same name but different files
    const helperSameFile = makeChunk({
      id: "helper-same",
      name: "helper",
      filePath: "src/main.ts",
    });
    const helperOtherFile = makeChunk({
      id: "helper-other",
      name: "helper",
      filePath: "src/other.ts",
    });

    seedChunks(seedChunk, helperSameFile, helperOtherFile);
    seedEdges(
      makeCallEdge({ sourceChunkId: "seed", targetName: "helper", filePath: "src/main.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "main", filePath: "src/main.ts", kind: "function" },
      direction: "down",
    });

    expect(tree.downTree).toHaveLength(1);
    expect(tree.downTree[0].chunkId).toBe("helper-same");
  });

  it("callee resolution prefers resolved target_file_path over same-file heuristic", () => {
    const seedChunk = makeChunk({ id: "seed", name: "main", filePath: "src/main.ts" });
    const helperSameFile = makeChunk({
      id: "helper-same",
      name: "helper",
      filePath: "src/main.ts",
    });
    const helperResolved = makeChunk({
      id: "helper-resolved",
      name: "helper",
      filePath: "src/shared/helper.ts",
    });

    seedChunks(seedChunk, helperSameFile, helperResolved);
    seedEdges(
      makeCallEdge({
        sourceChunkId: "seed",
        targetName: "helper",
        filePath: "src/main.ts",
        targetFilePath: "src/shared/helper.ts",
      })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "main", filePath: "src/main.ts", kind: "function" },
      direction: "down",
    });

    expect(tree.downTree).toHaveLength(1);
    expect(tree.downTree[0].chunkId).toBe("helper-resolved");
  });

  it("skips unresolvable callees gracefully", () => {
    const seedChunk = makeChunk({ id: "seed", name: "main", filePath: "src/main.ts" });

    seedChunks(seedChunk);
    // Seed has callee edges, but none of the target names exist in the chunk store
    seedEdges(
      makeCallEdge({ sourceChunkId: "seed", targetName: "ghost1", filePath: "src/main.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "ghost2", filePath: "src/main.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "main", filePath: "src/main.ts", kind: "function" },
      direction: "down",
    });

    // Tree should have only the seed node — no crash, no phantom nodes
    expect(tree.downTree).toHaveLength(0);
    expect(tree.nodeCount).toBe(1);
    expect(tree.seed.chunkId).toBe("seed");
  });

  it("up-tree filters callers by resolved target_file_path", () => {
    const seedA = makeChunk({ id: "seed-a", name: "validate", filePath: "src/a.ts" });
    const seedB = makeChunk({ id: "seed-b", name: "validate", filePath: "src/b.ts" });
    const callerA = makeChunk({ id: "caller-a", name: "handleA", filePath: "src/caller-a.ts" });
    const callerB = makeChunk({ id: "caller-b", name: "handleB", filePath: "src/caller-b.ts" });

    seedChunks(seedA, seedB, callerA, callerB);
    seedEdges(
      makeCallEdge({
        sourceChunkId: "caller-a",
        targetName: "validate",
        filePath: "src/caller-a.ts",
        targetFilePath: "src/a.ts",
      }),
      makeCallEdge({
        sourceChunkId: "caller-b",
        targetName: "validate",
        filePath: "src/caller-b.ts",
        targetFilePath: "src/b.ts",
      })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed-b", name: "validate", filePath: "src/b.ts", kind: "function" },
      direction: "up",
    });

    expect(tree.upTree).toHaveLength(1);
    expect(tree.upTree[0].chunkId).toBe("caller-b");
  });

  // ---- Coverage score tests ------------------------------------------------

  it("coverage: empty tree has zero utilization and zero balance", () => {
    const seedChunk = makeChunk({ id: "lonely", name: "lonely", filePath: "src/lonely.ts" });
    seedChunks(seedChunk);

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "lonely", name: "lonely", filePath: "src/lonely.ts", kind: "function" },
      direction: "both",
    });

    expect(tree.coverage).toBeDefined();
    expect(tree.coverage.utilization).toBe(0);
    expect(tree.coverage.balance).toBe(0);
    expect(tree.coverage.overall).toBe(0);
  });

  it("coverage: balanced tree scores higher balance than one-directional", () => {
    const seedChunk = makeChunk({ id: "seed", name: "middle", filePath: "src/mid.ts" });
    const caller = makeChunk({ id: "caller1", name: "entryPoint", filePath: "src/entry.ts" });
    const callee = makeChunk({ id: "callee1", name: "utility", filePath: "src/util.ts" });

    seedChunks(seedChunk, caller, callee);
    seedEdges(
      makeCallEdge({ sourceChunkId: "caller1", targetName: "middle", filePath: "src/entry.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "utility", filePath: "src/mid.ts" })
    );

    const balanced = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "middle", filePath: "src/mid.ts", kind: "function" },
      direction: "both",
    });

    // 1 up, 1 down => perfect balance
    expect(balanced.coverage.balance).toBe(1);

    const downOnly = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "middle", filePath: "src/mid.ts", kind: "function" },
      direction: "down",
    });

    // 0 up, 1 down => zero balance
    expect(downOnly.coverage.balance).toBe(0);
    expect(balanced.coverage.overall).toBeGreaterThan(downOnly.coverage.overall);
  });

  // ---- Test caller deprioritization -----------------------------------------

  it("up-tree: implementation callers exclude test callers when real callers exist", () => {
    const seedChunk = makeChunk({ id: "seed", name: "target", filePath: "src/target.ts" });
    const implCaller = makeChunk({ id: "impl-caller", name: "implCaller", filePath: "src/caller.ts" });
    const testCaller = makeChunk({ id: "test-caller", name: "testCaller", filePath: "test/caller.test.ts" });

    seedChunks(seedChunk, implCaller, testCaller);
    seedEdges(
      makeCallEdge({ sourceChunkId: "test-caller", targetName: "target", filePath: "test/caller.test.ts" }),
      makeCallEdge({ sourceChunkId: "impl-caller", targetName: "target", filePath: "src/caller.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "target", filePath: "src/target.ts", kind: "function" },
      direction: "up",
      maxBranchFactor: 2,
    });

    expect(tree.upTree).toHaveLength(1);
    expect(tree.upTree[0].filePath).not.toMatch(/test/);
    expect(tree.upTree[0].name).toBe("implCaller");
  });

  it("up-tree: test callers still included when branch budget allows", () => {
    const seedChunk = makeChunk({ id: "seed", name: "target", filePath: "src/target.ts" });
    const testCaller = makeChunk({ id: "test-caller", name: "testCaller", filePath: "test/target.test.ts" });

    seedChunks(seedChunk, testCaller);
    seedEdges(
      makeCallEdge({ sourceChunkId: "test-caller", targetName: "target", filePath: "test/target.test.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "target", filePath: "src/target.ts", kind: "function" },
      direction: "up",
      maxBranchFactor: 3,
    });

    // Test caller still appears when it's the only caller
    expect(tree.upTree).toHaveLength(1);
    expect(tree.upTree[0].name).toBe("testCaller");
  });

  it("down-tree: implementation callees exclude test callees when real callees exist", () => {
    const seedChunk = makeChunk({ id: "seed", name: "main", filePath: "src/main.ts" });
    const implCallee = makeChunk({ id: "impl-callee", name: "helper", filePath: "src/helper.ts" });
    const testCallee = makeChunk({ id: "test-callee", name: "testHelper", filePath: "test/helper.test.ts" });

    seedChunks(seedChunk, implCallee, testCallee);
    seedEdges(
      makeCallEdge({ sourceChunkId: "seed", targetName: "testHelper", filePath: "src/main.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "helper", filePath: "src/main.ts" })
    );

    const tree = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "main", filePath: "src/main.ts", kind: "function" },
      direction: "down",
      maxBranchFactor: 2,
    });

    expect(tree.downTree).toHaveLength(1);
    expect(tree.downTree[0].filePath).not.toMatch(/test/);
    expect(tree.downTree[0].name).toBe("helper");
  });

  // ---- Coverage score tests ------------------------------------------------

  it("coverage: utilization scales with node count relative to maxNodes", () => {
    const seedChunk = makeChunk({ id: "seed", name: "root", filePath: "src/root.ts" });
    const c1 = makeChunk({ id: "c1", name: "child1", filePath: "src/c1.ts" });
    const c2 = makeChunk({ id: "c2", name: "child2", filePath: "src/c2.ts" });

    seedChunks(seedChunk, c1, c2);
    seedEdges(
      makeCallEdge({ sourceChunkId: "seed", targetName: "child1", filePath: "src/root.ts" }),
      makeCallEdge({ sourceChunkId: "seed", targetName: "child2", filePath: "src/root.ts" })
    );

    const smallBudget = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "root", filePath: "src/root.ts", kind: "function" },
      direction: "down",
      maxNodes: 3,
    });

    const largeBudget = buildStackTree(meta.asFacade() as MetadataStore, {
      seed: { chunkId: "seed", name: "root", filePath: "src/root.ts", kind: "function" },
      direction: "down",
      maxNodes: 24,
    });

    // Same 3 nodes but different maxNodes => different utilization
    expect(smallBudget.coverage.utilization).toBe(1); // 2/(3-1)=1
    expect(largeBudget.coverage.utilization).toBeLessThan(smallBudget.coverage.utilization);
  });
});
