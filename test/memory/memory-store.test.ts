import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { MemoryStore } from "../../src/storage/memory-store.js";
import type { Memory } from "../../src/memory/types.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const id = overrides.id ?? "test-id-1";
  return {
    id,
    name: "feedback_no_coauthor",
    description: "Do not add Co-Authored-By Claude tag to commits",
    type: "feedback",
    class: "rule",
    scope: "global",
    status: "active",
    summary: "Do not add coauthor trailer",
    sourceKind: "reporecall_local",
    fingerprint: `fingerprint-${id}`,
    pinned: false,
    relatedFiles: [],
    relatedSymbols: [],
    supersedesId: "",
    confidence: 0.9,
    reason: "",
    content: "Skip the Co-Authored-By trailer.",
    filePath: `/tmp/memory/${id}.md`,
    indexedAt: new Date().toISOString(),
    fileMtime: new Date().toISOString(),
    accessCount: 0,
    lastAccessed: "",
    importance: 1.0,
    tags: "",
    ...overrides,
  };
}

describe("MemoryStore", () => {
  let dataDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mem-store-"));
    store = new MemoryStore(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("upserts and retrieves a memory by ID", () => {
    const memory = makeMemory();
    store.upsert(memory);

    const retrieved = store.get("test-id-1");
    expect(retrieved).not.toBeUndefined();
    expect(retrieved!.name).toBe("feedback_no_coauthor");
    expect(retrieved!.type).toBe("feedback");
    expect(retrieved!.content).toBe("Skip the Co-Authored-By trailer.");
  });

  it("upserts and retrieves by file path", () => {
    const memory = makeMemory();
    store.upsert(memory);

    const retrieved = store.getByFilePath(memory.filePath);
    expect(retrieved).not.toBeUndefined();
    expect(retrieved!.id).toBe("test-id-1");
  });

  it("returns undefined for non-existent ID", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("removes a memory", () => {
    store.upsert(makeMemory());
    expect(store.get("test-id-1")).not.toBeUndefined();

    store.remove("test-id-1");
    expect(store.get("test-id-1")).toBeUndefined();
  });

  it("lists all memories", () => {
    store.upsert(makeMemory({ id: "1", name: "mem1" }));
    store.upsert(makeMemory({ id: "2", name: "mem2", type: "user" }));
    store.upsert(makeMemory({ id: "3", name: "mem3", type: "project" }));

    const all = store.getAll();
    expect(all).toHaveLength(3);
  });

  it("filters by type", () => {
    store.upsert(makeMemory({ id: "1", name: "mem1", type: "feedback" }));
    store.upsert(makeMemory({ id: "2", name: "mem2", type: "user" }));
    store.upsert(makeMemory({ id: "3", name: "mem3", type: "feedback" }));

    const feedback = store.getByType("feedback");
    expect(feedback).toHaveLength(2);
    expect(feedback.every((m) => m.type === "feedback")).toBe(true);
  });

  it("counts memories", () => {
    expect(store.getCount()).toBe(0);
    store.upsert(makeMemory({ id: "1" }));
    store.upsert(makeMemory({ id: "2" }));
    expect(store.getCount()).toBe(2);
  });

  it("updates an existing memory on re-upsert", () => {
    store.upsert(makeMemory({ id: "1", content: "original" }));
    store.upsert(makeMemory({ id: "1", content: "updated" }));

    const retrieved = store.get("1");
    expect(retrieved!.content).toBe("updated");
    expect(store.getCount()).toBe(1);
  });

  it("finds memories by name", () => {
    store.upsert(makeMemory({ id: "1", name: "unique_name" }));
    store.upsert(makeMemory({ id: "2", name: "other_name" }));

    const found = store.findByName("unique_name");
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe("1");
  });

  it("round-trips richer memory metadata", () => {
    const memory = makeMemory({
      id: "meta",
      class: "episode",
      scope: "branch",
      status: "archived",
      summary: "A compact summary",
      sourceKind: "generated",
      fingerprint: "meta-fingerprint",
      pinned: true,
      relatedFiles: ["src/foo.ts", "src/bar.ts"],
      relatedSymbols: ["foo", "bar"],
      supersedesId: "prev",
      confidence: 0.42,
      reason: "Compacted during cleanup",
    });

    store.upsert(memory);
    const retrieved = store.get("meta");
    expect(retrieved).not.toBeUndefined();
    expect(retrieved!.class).toBe("episode");
    expect(retrieved!.scope).toBe("branch");
    expect(retrieved!.status).toBe("archived");
    expect(retrieved!.summary).toBe("A compact summary");
    expect(retrieved!.sourceKind).toBe("generated");
    expect(retrieved!.fingerprint).toBe("meta-fingerprint");
    expect(retrieved!.pinned).toBe(true);
    expect(retrieved!.relatedFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(retrieved!.relatedSymbols).toEqual(["foo", "bar"]);
    expect(retrieved!.supersedesId).toBe("prev");
    expect(retrieved!.confidence).toBe(0.42);
    expect(retrieved!.reason).toBe("Compacted during cleanup");
  });

  describe("FTS search", () => {
    beforeEach(() => {
      store.upsert(
        makeMemory({
          id: "1",
          name: "feedback_no_coauthor",
          description: "Do not add Co-Authored-By tag",
          content: "Skip the trailer in commit messages.",
          type: "feedback",
        })
      );
      store.upsert(
        makeMemory({
          id: "2",
          name: "user_role",
          description: "User is a senior backend engineer",
          content: "Experienced with Go, TypeScript, and PostgreSQL.",
          type: "user",
        })
      );
      store.upsert(
        makeMemory({
          id: "3",
          name: "project_deadline",
          description: "Launch deadline is 2026-04-01",
          content: "All features must be complete by March 28.",
          type: "project",
        })
      );
    });

    it("searches by keyword in content", () => {
      const results = store.search("commit");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe("1");
    });

    it("searches by keyword in name", () => {
      const results = store.search("coauthor");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe("1");
    });

    it("searches by keyword in description", () => {
      const results = store.search("backend engineer");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe("2");
    });

    it("searches by type keyword", () => {
      const results = store.search("feedback");
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns empty for no matches", () => {
      const results = store.search("xyznonexistent");
      expect(results).toHaveLength(0);
    });

    it("removes FTS entries when memory is deleted", () => {
      const before = store.search("commit");
      expect(before.length).toBeGreaterThan(0);

      store.remove("1");

      const after = store.search("commit");
      // The commit-related memory should be gone
      expect(after.every((r) => r.id !== "1")).toBe(true);
    });
  });

  it("migrates an older memories table without losing rows", () => {
    const oldDir = mkdtempSync(join(tmpdir(), "mem-old-store-"));
    const oldDb = new Database(join(oldDir, "memories.db"));
    oldDb.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        indexed_at TEXT NOT NULL,
        file_mtime TEXT NOT NULL
      );
      INSERT INTO memories (
        id, name, description, type, content, file_path, indexed_at, file_mtime
      ) VALUES (
        'legacy',
        'legacy_memory',
        'Legacy description',
        'feedback',
        'Legacy content.',
        '/tmp/legacy.md',
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z'
      );
    `);
    oldDb.close();

    const migratedStore = new MemoryStore(oldDir);
    const migrated = migratedStore.get("legacy");
    expect(migrated).not.toBeUndefined();
    expect(migrated!.name).toBe("legacy_memory");
    expect(migrated!.class).toBe("fact");
    expect(migrated!.scope).toBe("project");
    expect(migrated!.status).toBe("active");
    expect(migrated!.summary).toBe("");
    expect(migrated!.sourceKind).toBe("claude_auto");
    expect(migrated!.fingerprint).toBe("");
    expect(migrated!.relatedFiles).toEqual([]);
    expect(migrated!.relatedSymbols).toEqual([]);
    expect(migrated!.confidence).toBe(0.5);
    migratedStore.close();
    rmSync(oldDir, { recursive: true, force: true });
  });

  it("compacts duplicate fingerprints and archives old episodes", () => {
    store.upsert(
      makeMemory({
        id: "keep",
        name: "keep_memory",
        fingerprint: "dup-fp",
        class: "fact",
        sourceKind: "generated",
        confidence: 0.9,
      })
    );
    store.upsert(
      makeMemory({
        id: "dup",
        name: "dup_memory",
        fingerprint: "dup-fp",
        class: "fact",
        sourceKind: "generated",
        confidence: 0.5,
      })
    );
    store.upsert(
      makeMemory({
        id: "old-episode",
        name: "old_episode",
        class: "episode",
        status: "active",
        indexedAt: "2024-01-01T00:00:00.000Z",
        fingerprint: "episode-fp",
      })
    );

    const result = store.compact({ archiveEpisodeOlderThanDays: 30 });
    expect(result.deduped).toBe(1);
    expect(result.superseded).toBe(1);
    expect(result.archived).toBe(1);
    expect(store.get("dup")!.status).toBe("superseded");
    expect(store.get("dup")!.supersedesId).toBe("keep");
    expect(store.get("old-episode")!.status).toBe("archived");
  });
});
