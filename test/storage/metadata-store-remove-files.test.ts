import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import type { StoredChunk } from "../../src/storage/types.js";

function tmpDir(): string {
  const dir = join(tmpdir(), `metadata-removeFiles-test-${randomUUID()}`);
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
    content: "function myFunction() {}",
    docstring: undefined,
    parentName: undefined,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    fileMtime: undefined,
    ...overrides,
  };
}

describe("MetadataStore.removeFiles", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  it("removes all chunks for the listed paths in a single transaction", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    const paths = ["a.ts", "b.ts", "c.ts"];
    for (const p of paths) {
      store.upsertFile(p, `hash-${p}`);
      store.upsertChunk(makeChunk({ filePath: p, name: `fn_${p}` }));
    }
    expect(store.getAllChunks()).toHaveLength(3);

    store.removeFiles(paths);

    expect(store.getAllChunks()).toHaveLength(0);
    store.close();
  });

  it("is a no-op on empty input", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const store = new MetadataStore(dir);

    store.upsertFile("kept.ts", "hash");
    store.upsertChunk(makeChunk({ filePath: "kept.ts", name: "kept" }));
    store.removeFiles([]);

    expect(store.getAllChunks()).toHaveLength(1);
    store.close();
  });

  it("matches the behavior of looped removeFile calls", () => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    dirs.push(dir1, dir2);
    const looped = new MetadataStore(dir1);
    const batched = new MetadataStore(dir2);

    const filesToDelete = ["x.ts", "y.ts"];
    const filesToKeep = ["keep.ts"];

    for (const store of [looped, batched]) {
      for (const p of [...filesToDelete, ...filesToKeep]) {
        store.upsertFile(p, `hash-${p}`);
        store.upsertChunk(makeChunk({ filePath: p, name: `fn_${p}` }));
      }
    }

    for (const p of filesToDelete) looped.removeFile(p);
    batched.removeFiles(filesToDelete);

    expect(looped.getAllChunks().map((c) => c.filePath).sort())
      .toEqual(batched.getAllChunks().map((c) => c.filePath).sort());
    expect(batched.getAllChunks().map((c) => c.filePath)).toEqual(["keep.ts"]);

    looped.close();
    batched.close();
  });
});
