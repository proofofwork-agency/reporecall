import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import type { StoredChunk } from "../../src/storage/types.js";

function tmpDir(): string {
  const dir = join(tmpdir(), `metadata-lw-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeChunk(overrides: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id: randomUUID(),
    filePath: "src/foo.ts",
    name: "myFunction",
    kind: "function_declaration",
    startLine: 1,
    endLine: 10,
    content: "function myFunction() { /* lots of source text */ }",
    docstring: "Does something.",
    parentName: undefined,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    fileMtime: undefined,
    ...overrides,
  };
}

describe("MetadataStore.getChunksLightweight", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it("returns an empty array when no chunks are stored", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);
    expect(store.getChunksLightweight()).toEqual([]);
    store.close();
  });

  it("returns one lightweight row per stored chunk", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    const chunk = makeChunk();
    store.upsertChunk(chunk);

    const rows = store.getChunksLightweight();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.name).toBe(chunk.name);
    expect(row.kind).toBe(chunk.kind);
    expect(row.language).toBe(chunk.language);
    expect(row.startLine).toBe(chunk.startLine);
    expect(row.endLine).toBe(chunk.endLine);
    expect(row.docstring).toBe(chunk.docstring);
    expect(row.filePath).toBe(chunk.filePath);
    // content must NOT be present on the lightweight type
    expect((row as Record<string, unknown>)["content"]).toBeUndefined();
    store.close();
  });

  it("omits content while getAllChunks still includes it", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    store.upsertChunk(makeChunk({ content: "large source text here" }));

    const heavy = store.getAllChunks();
    expect(heavy[0].content).toBe("large source text here");

    const light = store.getChunksLightweight();
    expect((light[0] as Record<string, unknown>)["content"]).toBeUndefined();
    store.close();
  });

  it("handles missing docstring as undefined", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    store.upsertChunk(makeChunk({ docstring: undefined }));

    const rows = store.getChunksLightweight();
    expect(rows[0].docstring).toBeUndefined();
    store.close();
  });

  it("returns all chunks across multiple files", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    const chunks = [
      makeChunk({ filePath: "a.ts", name: "alpha" }),
      makeChunk({ filePath: "b.ts", name: "beta" }),
      makeChunk({ filePath: "a.ts", name: "gamma", kind: "class_declaration" }),
    ];
    for (const c of chunks) store.upsertChunk(c);

    const rows = store.getChunksLightweight();
    expect(rows).toHaveLength(3);

    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
    store.close();
  });
});
