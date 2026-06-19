import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openSqliteWithRecovery } from "../../src/storage/sqlite-utils.js";
import { ChunkStore } from "../../src/storage/chunk-store.js";
import { SemanticStore } from "../../src/storage/semantic-store.js";
import { TargetStore } from "../../src/storage/target-store.js";
import { CommunityStore } from "../../src/storage/community-store.js";
import { StatsStore } from "../../src/storage/stats-store.js";
import type Database from "better-sqlite3";

function openDb(dir: string, name: string): Database.Database {
  return openSqliteWithRecovery(join(dir, name));
}

describe("SemanticStore", () => {
  let dir: string;
  let db: Database.Database;
  let store: SemanticStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-semantic-"));
    db = openDb(dir, "semantic.db");
    // SemanticStore.initSchema prepares a statement that joins the `chunks`
    // table, so the chunk schema must exist first (mirrors MetadataStore boot).
    new ChunkStore(db).initSchema();
    store = new SemanticStore(db);
    store.initSchema();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips chunk features", () => {
    const feature = {
      chunkId: "chunk-1",
      filePath: "src/auth.ts",
      returnsBoolean: true,
      branchCount: 3,
      guardCount: 1,
      throwsCount: 2,
      earlyReturnCount: 1,
      callsPredicateCount: 4,
      callerCount: 5,
      calleeCount: 2,
      isPredicate: true,
      isValidator: true,
      isGuard: false,
      isController: false,
      isRegistry: false,
      isUiComponent: false,
      writesState: true,
      writesNetwork: false,
      writesStorage: true,
      docLike: false,
      testLike: false,
    };
    store.replaceChunkFeatures([feature]);

    const fetched = store.getChunkFeaturesByIds(["chunk-1"]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].chunkId).toBe("chunk-1");
    expect(fetched[0].branchCount).toBe(3);
    expect(fetched[0].isPredicate).toBe(true);
    expect(fetched[0].writesStorage).toBe(true);
  });

  it("replaces (not appends) chunk features for a file on re-upsert", () => {
    store.replaceChunkFeatures([
      { chunkId: "a", filePath: "f.ts", returnsBoolean: false, branchCount: 1, guardCount: 0, throwsCount: 0, earlyReturnCount: 0, callsPredicateCount: 0, callerCount: 0, calleeCount: 0, isPredicate: false, isValidator: false, isGuard: false, isController: false, isRegistry: false, isUiComponent: false, writesState: false, writesNetwork: false, writesStorage: false, docLike: false, testLike: false },
      { chunkId: "b", filePath: "f.ts", returnsBoolean: false, branchCount: 1, guardCount: 0, throwsCount: 0, earlyReturnCount: 0, callsPredicateCount: 0, callerCount: 0, calleeCount: 0, isPredicate: false, isValidator: false, isGuard: false, isController: false, isRegistry: false, isUiComponent: false, writesState: false, writesNetwork: false, writesStorage: false, docLike: false, testLike: false },
    ]);
    expect(store.getChunkFeaturesByIds(["a", "b"])).toHaveLength(2);

    // Re-upserting only one chunk for the same file wipes the other
    store.replaceChunkFeatures([
      { chunkId: "b", filePath: "f.ts", returnsBoolean: false, branchCount: 9, guardCount: 0, throwsCount: 0, earlyReturnCount: 0, callsPredicateCount: 0, callerCount: 0, calleeCount: 0, isPredicate: false, isValidator: false, isGuard: false, isController: false, isRegistry: false, isUiComponent: false, writesState: false, writesNetwork: false, writesStorage: false, docLike: false, testLike: false },
    ]);
    const fetched = store.getChunkFeaturesByIds(["a", "b"]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].chunkId).toBe("b");
    expect(fetched[0].branchCount).toBe(9);
  });

  it("round-trips file features and chunk tags", () => {
    store.replaceFileFeatures([
      { filePath: "src/auth.ts", predicateCount: 2, validatorCount: 1, guardCount: 0, controllerCount: 0, registryCount: 0, uiComponentCount: 0, writesStateCount: 3, writesNetworkCount: 0, writesStorageCount: 1, docLike: false, testLike: false },
    ]);
    store.replaceChunkTags([
      { chunkId: "c1", filePath: "src/auth.ts", tag: "predicate", weight: 0.9 },
      { chunkId: "c1", filePath: "src/auth.ts", tag: "guard", weight: 0.5 },
    ]);

    const files = store.getFileFeatures(["src/auth.ts"]);
    expect(files).toHaveLength(1);
    expect(files[0].predicateCount).toBe(2);

    const tags = store.getChunkTagsByIds(["c1"]);
    expect(tags).toHaveLength(2);
    // ordered by weight DESC then tag ASC
    expect(tags[0].tag).toBe("predicate");
    expect(tags[0].weight).toBe(0.9);
  });

  it("removeByFile clears features and tags for that file", () => {
    store.replaceChunkFeatures([
      { chunkId: "a", filePath: "src/x.ts", returnsBoolean: false, branchCount: 1, guardCount: 0, throwsCount: 0, earlyReturnCount: 0, callsPredicateCount: 0, callerCount: 0, calleeCount: 0, isPredicate: false, isValidator: false, isGuard: false, isController: false, isRegistry: false, isUiComponent: false, writesState: false, writesNetwork: false, writesStorage: false, docLike: false, testLike: false },
    ]);
    store.replaceChunkTags([
      { chunkId: "a", filePath: "src/x.ts", tag: "t", weight: 1 },
    ]);
    store.removeByFile("src/x.ts");

    expect(store.getChunkFeaturesByIds(["a"])).toHaveLength(0);
    expect(store.getChunkTagsByIds(["a"])).toHaveLength(0);
  });

  it("returns empty arrays for empty id lists and supports clearAll", () => {
    expect(store.getChunkFeaturesByIds([])).toEqual([]);
    expect(store.getChunkTagsByIds([])).toEqual([]);
    expect(store.getFileFeatures([])).toEqual([]);

    store.replaceChunkFeatures([
      { chunkId: "a", filePath: "f.ts", returnsBoolean: false, branchCount: 1, guardCount: 0, throwsCount: 0, earlyReturnCount: 0, callsPredicateCount: 0, callerCount: 0, calleeCount: 0, isPredicate: false, isValidator: false, isGuard: false, isController: false, isRegistry: false, isUiComponent: false, writesState: false, writesNetwork: false, writesStorage: false, docLike: false, testLike: false },
    ]);
    expect(store.getChunkFeaturesByIds(["a"])).toHaveLength(1);
    store.clearAll();
    expect(store.getChunkFeaturesByIds(["a"])).toHaveLength(0);
  });

  it("no-ops when replacing empty arrays", () => {
    store.replaceChunkFeatures([]);
    store.replaceFileFeatures([]);
    store.replaceChunkTags([]);
    expect(store.getChunkFeaturesByIds(["any"])).toHaveLength(0);
  });
});

describe("TargetStore", () => {
  let dir: string;
  let db: Database.Database;
  let store: TargetStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-target-"));
    db = openDb(dir, "target.db");
    store = new TargetStore(db);
    store.initSchema();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedTargets() {
    store.replaceAll(
      [
        {
          id: "file_module:src/auth/session.ts",
          kind: "file_module" as const,
          canonicalName: "session",
          normalizedName: "auth session",
          filePath: "src/auth/session.ts",
          ownerChunkId: "session-chunk",
          subsystem: "auth",
          confidence: 0.95,
        },
        {
          id: "endpoint:supabase/functions/auth/index.ts",
          kind: "endpoint" as const,
          canonicalName: "authenticate",
          normalizedName: "authenticate",
          filePath: "supabase/functions/auth/index.ts",
          subsystem: "auth",
          confidence: 0.9,
        },
      ],
      [
        {
          targetId: "file_module:src/auth/session.ts",
          alias: "session",
          normalizedAlias: "auth session",
          source: "file_path" as const,
          weight: 0.96,
        },
        {
          targetId: "endpoint:supabase/functions/auth/index.ts",
          alias: "authenticate",
          normalizedAlias: "authenticate",
          source: "slug" as const,
          weight: 0.9,
        },
      ]
    );
  }

  it("inserts and finds targets by id", () => {
    seedTargets();
    const found = store.findTargetById("file_module:src/auth/session.ts");
    expect(found).toBeDefined();
    expect(found!.canonicalName).toBe("session");
    expect(found!.subsystem).toBe("auth");

    expect(store.findTargetById("missing")).toBeUndefined();
  });

  it("getTargetsByIds returns matching targets and empty for empty input", () => {
    seedTargets();
    expect(store.getTargetsByIds([])).toEqual([]);
    const many = store.getTargetsByIds([
      "file_module:src/auth/session.ts",
      "endpoint:supabase/functions/auth/index.ts",
      "nope",
    ]);
    expect(many).toHaveLength(2);
  });

  it("resolves aliases and orders by weight desc", () => {
    seedTargets();
    const hits = store.resolveAliases(["auth session", "authenticate"]);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // higher weight first
    expect(hits[0].weight).toBeGreaterThanOrEqual(hits[1].weight);
    expect(hits.some((h) => h.target.canonicalName === "session")).toBe(true);
  });

  it("resolveAliases returns empty for empty input and respects kind filter", () => {
    seedTargets();
    expect(store.resolveAliases([])).toEqual([]);

    const endpoints = store.resolveAliases(["authenticate"], 25, ["endpoint"]);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].target.kind).toBe("endpoint");

    const none = store.resolveAliases(["authenticate"], 25, ["file_module"]);
    expect(none).toHaveLength(0);
  });

  it("findTargetsByFilePath and findTargetsBySubsystem work", () => {
    seedTargets();
    expect(store.findTargetsByFilePath("src/auth/session.ts")).toHaveLength(1);
    const bySubsystem = store.findTargetsBySubsystem(["auth"]);
    expect(bySubsystem).toHaveLength(2);
    expect(bySubsystem[0].confidence).toBeGreaterThanOrEqual(bySubsystem[1].confidence);
    expect(store.findTargetsBySubsystem([])).toEqual([]);
  });

  it("replaceAll wipes previous data and clearAll empties everything", () => {
    seedTargets();
    expect(store.findTargetById("file_module:src/auth/session.ts")).toBeDefined();

    store.replaceAll([], []);
    expect(store.findTargetById("file_module:src/auth/session.ts")).toBeUndefined();
    expect(store.resolveAliases(["auth session"])).toEqual([]);

    seedTargets();
    store.clearAll();
    expect(store.findTargetById("file_module:src/auth/session.ts")).toBeUndefined();
  });
});

describe("CommunityStore", () => {
  let dir: string;
  let db: Database.Database;
  let store: CommunityStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-community-"));
    db = openDb(dir, "community.db");
    store = new CommunityStore(db);
    store.initSchema();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const computedAt = new Date().toISOString();

  function seedTopology() {
    store.replaceTopology({
      communities: [
        { id: "c1", nodeCount: 12, cohesion: 0.8, label: "auth", computedAt },
        { id: "c2", nodeCount: 5, cohesion: 0.6, label: null, computedAt },
      ],
      memberships: [
        { chunkId: "chunk-a", communityId: "c1" },
        { chunkId: "chunk-b", communityId: "c1" },
        { chunkId: "chunk-c", communityId: "c2" },
      ],
      surprises: [
        { sourceChunkId: "chunk-a", targetChunkId: "chunk-c", score: 9, reasons: ["cross-module"], relation: "calls", computedAt },
      ],
      godNodes: [
        { chunkId: "chunk-a", name: "authenticate", filePath: "src/auth.ts", degree: 20, communityId: "c1" },
      ],
      questions: [
        { type: "weak_spot", question: "Why does auth call storage?", why: "cross-community edge" },
      ],
      computedAt,
    });
  }

  it("getCommunityForChunk resolves membership", () => {
    seedTopology();
    expect(store.getCommunityForChunk("chunk-a")).toBe("c1");
    expect(store.getCommunityForChunk("chunk-c")).toBe("c2");
    expect(store.getCommunityForChunk("unknown")).toBeUndefined();
  });

  it("getCommunityInfo and getAllCommunities return records", () => {
    seedTopology();
    const info = store.getCommunityInfo("c1");
    expect(info).toBeDefined();
    expect(info!.nodeCount).toBe(12);
    expect(info!.label).toBe("auth");

    const all = store.getAllCommunities();
    expect(all).toHaveLength(2);
    // ordered by node_count DESC
    expect(all[0].id).toBe("c1");
  });

  it("getTopSurprises, getGodNodes, getSuggestedQuestions round-trip", () => {
    seedTopology();
    const surprises = store.getTopSurprises();
    expect(surprises).toHaveLength(1);
    expect(surprises[0].reasons).toEqual(["cross-module"]);
    expect(surprises[0].relation).toBe("calls");

    const gods = store.getGodNodes();
    expect(gods).toHaveLength(1);
    expect(gods[0].degree).toBe(20);

    const qs = store.getSuggestedQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0].type).toBe("weak_spot");
  });

  it("replaceTopology replaces and clearAll empties", () => {
    seedTopology();
    expect(store.getCommunityForChunk("chunk-a")).toBe("c1");

    store.replaceTopology({
      communities: [{ id: "c9", nodeCount: 1, cohesion: 0.1, label: null, computedAt }],
      memberships: [{ chunkId: "z", communityId: "c9" }],
      surprises: [],
      godNodes: [],
      questions: [],
      computedAt,
    });
    expect(store.getCommunityForChunk("chunk-a")).toBeUndefined();
    expect(store.getCommunityForChunk("z")).toBe("c9");
    expect(store.getAllCommunities()).toHaveLength(1);

    store.clearAll();
    expect(store.getAllCommunities()).toHaveLength(0);
    expect(store.getGodNodes()).toHaveLength(0);
  });
});

describe("StatsStore", () => {
  let dir: string;
  let db: Database.Database;
  let store: StatsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-stats-"));
    db = openDb(dir, "stats.db");
    store = new StatsStore(db);
    store.initSchema();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("setStat/getStat persist string values", () => {
    store.setStat("last_index", "2024-01-01");
    expect(store.getStat("last_index")).toBe("2024-01-01");
    expect(store.getStat("missing")).toBeUndefined();
  });

  it("setStat overwrites existing values", () => {
    store.setStat("counter", "1");
    store.setStat("counter", "42");
    expect(store.getStat("counter")).toBe("42");
  });

  it("incrementStat accumulates numeric deltas", () => {
    store.incrementStat("searches", 1);
    store.incrementStat("searches", 4);
    store.incrementStat("searches");
    // value stored as TEXT; parse numerically to be robust to "6" vs "6.0"
    expect(Number(store.getStat("searches"))).toBe(6);
  });

  it("incrementRouteStat increments per-route keys", () => {
    store.incrementRouteStat("standard");
    store.incrementRouteStat("standard");
    store.incrementRouteStat("concept");
    expect(Number(store.getStat("route_standard_count"))).toBe(2);
    expect(Number(store.getStat("route_concept_count"))).toBe(1);
  });

  it("recordLatency/getLatencyPercentiles compute aggregates", () => {
    expect(store.getLatencyPercentiles()).toEqual({ avg: 0, p50: 0, p95: 0, count: 0 });

    store.recordLatency(10);
    store.recordLatency(20);
    store.recordLatency(30);

    const stats = store.getLatencyPercentiles();
    expect(stats.count).toBe(3);
    expect(stats.avg).toBe(20);
    expect(stats.p50).toBe(20);
    expect(stats.p95).toBe(30);
  });

  it("prunes latency history to the most recent 1000 entries", () => {
    for (let i = 1; i <= 1050; i++) store.recordLatency(i);
    const stats = store.getLatencyPercentiles();
    expect(stats.count).toBe(1000);
  });
});
