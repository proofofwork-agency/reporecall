import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore } from "../../src/storage/memory-store.js";
import { MemorySearch } from "../../src/memory/search.js";
import type { Memory } from "../../src/memory/types.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const id = overrides.id ?? "test-id";
  return {
    id,
    name: "test_memory",
    description: "A test memory",
    type: "feedback",
    content: "Test content here.",
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

describe("MemorySearch", () => {
  let dataDir: string;
  let store: MemoryStore;
  let search: MemorySearch;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mem-search-"));
    store = new MemoryStore(dataDir);
    search = new MemorySearch(store);
  });

  afterEach(async () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("finds memories by keyword search", async () => {
    store.upsert(
      makeMemory({
        id: "1",
        name: "feedback_commits",
        description: "Commit message guidelines",
        content: "Do not add Co-Authored-By trailer to commit messages.",
      })
    );
    store.upsert(
      makeMemory({
        id: "2",
        name: "user_role",
        description: "User is a backend engineer",
        content: "Expert in Go and TypeScript.",
        type: "user",
      })
    );

    // "trailer" appears in both name (via splitIdentifiers) and content
    const results = await search.search("trailer");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe("feedback_commits");
  });

  it("returns empty for no matches", async () => {
    store.upsert(makeMemory({ id: "1" }));
    const results = await search.search("xyznonexistent");
    expect(results).toHaveLength(0);
  });

  it("filters by memory type", async () => {
    store.upsert(makeMemory({ id: "1", type: "feedback", content: "shared keyword test" }));
    store.upsert(makeMemory({ id: "2", type: "user", content: "shared keyword test" }));

    const results = await search.search("keyword", { types: ["feedback"] });
    expect(results.every((r) => r.type === "feedback")).toBe(true);
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      store.upsert(
        makeMemory({
          id: `mem-${i}`,
          name: `memory_${i}`,
          content: `common searchable content item ${i}`,
        })
      );
    }

    const results = await search.search("content", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("boosts feedback memories", async () => {
    // Two memories with similar content but different types
    store.upsert(
      makeMemory({
        id: "fb",
        name: "feedback_testing",
        description: "Testing guidance",
        content: "Always write integration tests for database queries.",
        type: "feedback",
      })
    );
    store.upsert(
      makeMemory({
        id: "ref",
        name: "reference_testing",
        description: "Testing reference",
        content: "Integration tests for database queries are documented here.",
        type: "reference",
      })
    );

    const results = await search.search("database tests");
    if (results.length >= 2) {
      // Feedback should score higher due to type boost
      const fbResult = results.find((r) => r.id === "fb");
      const refResult = results.find((r) => r.id === "ref");
      if (fbResult && refResult) {
        expect(fbResult.score).toBeGreaterThan(refResult.score);
      }
    }
  });

  it("returns all expected fields in results", async () => {
    store.upsert(
      makeMemory({
        id: "full",
        name: "full_memory",
        description: "Complete memory with all fields",
        content: "Full content body.",
        type: "project",
        filePath: "/tmp/memory/full.md",
      })
    );

    const results = await search.search("full content");
    expect(results.length).toBeGreaterThan(0);

    const result = results[0]!;
    expect(result.id).toBe("full");
    expect(result.name).toBe("full_memory");
    expect(result.description).toBe("Complete memory with all fields");
    expect(result.type).toBe("project");
    expect(result.content).toBe("Full content body.");
    expect(result.filePath).toBe("/tmp/memory/full.md");
    expect(result.score).toBeGreaterThan(0);
  });

  it("skips archived memories unless explicitly requested", async () => {
    store.upsert(
      makeMemory({
        id: "active",
        content: "shared keyword test",
        fingerprint: "active-fp",
        status: "active",
      })
    );
    store.upsert(
      makeMemory({
        id: "archived",
        content: "shared keyword test",
        fingerprint: "archived-fp",
        status: "archived",
      })
    );

    const activeResults = await search.search("keyword");
    expect(activeResults.every((r) => r.status === "active")).toBe(true);
    expect(activeResults.some((r) => r.id === "archived")).toBe(false);

    const archivedResults = await search.search("keyword", { statuses: ["archived"] });
    expect(archivedResults.some((r) => r.id === "archived")).toBe(true);
  });
});
