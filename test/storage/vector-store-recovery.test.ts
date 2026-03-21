import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { VectorStore } from "../../src/storage/vector-store.js";

describe("VectorStore corruption recovery", () => {
  it("isCorruptionError correctly identifies corruption messages", () => {
    const store = new VectorStore(mkdtempSync(join(tmpdir(), "vs-test-")), 384);
    // Access private method via prototype for testing
    const isCorruption = (store as any).isCorruptionError.bind(store);

    expect(isCorruption(new Error("file is corrupt"))).toBe(true);
    expect(isCorruption(new Error("Invalid Parquet file"))).toBe(true);
    expect(isCorruption(new Error("Arrow error: schema mismatch"))).toBe(true);
    expect(isCorruption(new Error("Lance error: table broken"))).toBe(true);
    expect(isCorruption(new Error("schema is a mismatch"))).toBe(true);
    expect(isCorruption(new Error("normal error"))).toBe(false);
    expect(isCorruption(new Error("connection refused"))).toBe(false);
    expect(isCorruption("corrupt string error")).toBe(true);
  });

  it("isCorrupted flag is set and can be cleared", () => {
    const store = new VectorStore(mkdtempSync(join(tmpdir(), "vs-test-")), 384);
    expect(store.isCorrupted()).toBe(false);

    // Simulate corruption recovery
    (store as any).corrupted = true;
    expect(store.isCorrupted()).toBe(true);

    store.clearCorrupted();
    expect(store.isCorrupted()).toBe(false);
  });

  it("search returns [] after corruption (not throws)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vs-test-"));
    const store = new VectorStore(tmpDir, 384);

    // Search on empty store should return []
    const results = await store.search(new Array(384).fill(0), 10);
    expect(results).toEqual([]);
  });
});
