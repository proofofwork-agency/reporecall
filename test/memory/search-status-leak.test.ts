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
    name: "status_leak_memory",
    description: "Status filter leak regression",
    type: "feedback",
    content: "shared keyword test for regression",
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

describe("MemorySearch — status filter leak", () => {
  let dataDir: string;
  let store: MemoryStore;
  let search: MemorySearch;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mem-status-leak-"));
    store = new MemoryStore(dataDir);
    search = new MemorySearch(store);

    store.upsert(
      makeMemory({
        id: "active",
        content: "shared keyword test for regression",
        fingerprint: "active-fp",
        status: "active",
      })
    );
    store.upsert(
      makeMemory({
        id: "archived",
        content: "shared keyword test for regression",
        fingerprint: "archived-fp",
        status: "archived",
      })
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // regression: archived memories leaked into default-active results because
  // the status filter only ran when `options.statuses` was explicitly provided.
  it("excludes archived memories on the default (active) path", async () => {
    const results = await search.search("keyword");

    expect(results.some((r) => r.id === "active")).toBe(true);
    expect(results.every((r) => r.status === "active")).toBe(true);
    expect(results.some((r) => r.id === "archived")).toBe(false);
  });

  it("includes archived memories when statuses=[\"archived\"] is requested", async () => {
    const results = await search.search("keyword", { statuses: ["archived"] });

    expect(results.some((r) => r.id === "archived")).toBe(true);
    expect(results.some((r) => r.id === "active")).toBe(false);
  });
});
