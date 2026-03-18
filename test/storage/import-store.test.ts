import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";
import { ImportStore } from "../../src/storage/import-store.js";
import type { ImportRecord } from "../../src/storage/import-store.js";

describe("ImportStore", () => {
  let db: Database.Database;
  let store: ImportStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-import-"));
    db = new Database(join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    store = new ImportStore(db);
    store.initSchema();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upserts and queries imports for a file", () => {
    const imports: ImportRecord[] = [
      {
        filePath: "src/index.ts",
        importedName: "foo",
        sourceModule: "./module",
        resolvedPath: "src/module.ts",
        isDefault: false,
        isNamespace: false,
      },
      {
        filePath: "src/index.ts",
        importedName: "Bar",
        sourceModule: "./bar",
        resolvedPath: "src/bar.ts",
        isDefault: true,
        isNamespace: false,
      },
    ];

    store.upsertImports(imports);

    const result = store.getImportsForFile("src/index.ts");
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(imports[0]);
    expect(result).toContainEqual(imports[1]);
  });

  it("upsert replaces existing imports for the same file", () => {
    store.upsertImports([
      {
        filePath: "src/index.ts",
        importedName: "old",
        sourceModule: "./old",
        resolvedPath: null,
        isDefault: false,
        isNamespace: false,
      },
    ]);

    store.upsertImports([
      {
        filePath: "src/index.ts",
        importedName: "new",
        sourceModule: "./new",
        resolvedPath: null,
        isDefault: false,
        isNamespace: false,
      },
    ]);

    const result = store.getImportsForFile("src/index.ts");
    expect(result).toHaveLength(1);
    expect(result[0].importedName).toBe("new");
  });

  it("removes imports for a file", () => {
    store.upsertImports([
      {
        filePath: "src/a.ts",
        importedName: "foo",
        sourceModule: "./foo",
        resolvedPath: null,
        isDefault: false,
        isNamespace: false,
      },
      {
        filePath: "src/b.ts",
        importedName: "bar",
        sourceModule: "./bar",
        resolvedPath: null,
        isDefault: false,
        isNamespace: false,
      },
    ]);

    store.removeImportsForFile("src/a.ts");

    expect(store.getImportsForFile("src/a.ts")).toHaveLength(0);
    expect(store.getImportsForFile("src/b.ts")).toHaveLength(1);
  });

  it("finds imports by name without filePath filter", () => {
    store.upsertImports([
      {
        filePath: "src/a.ts",
        importedName: "React",
        sourceModule: "react",
        resolvedPath: null,
        isDefault: true,
        isNamespace: false,
      },
      {
        filePath: "src/b.ts",
        importedName: "React",
        sourceModule: "react",
        resolvedPath: null,
        isDefault: true,
        isNamespace: false,
      },
    ]);

    const result = store.findImportByName("React");
    expect(result).toHaveLength(2);
  });

  it("finds imports by name with filePath filter", () => {
    store.upsertImports([
      {
        filePath: "src/a.ts",
        importedName: "React",
        sourceModule: "react",
        resolvedPath: null,
        isDefault: true,
        isNamespace: false,
      },
      {
        filePath: "src/b.ts",
        importedName: "React",
        sourceModule: "react",
        resolvedPath: null,
        isDefault: true,
        isNamespace: false,
      },
    ]);

    const result = store.findImportByName("React", "src/a.ts");
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("src/a.ts");
  });

  it("handles empty imports array", () => {
    store.upsertImports([]);
    expect(store.getImportsForFile("any.ts")).toHaveLength(0);
  });

  it("finds importer files by resolved path", () => {
    store.upsertImports([
      {
        filePath: "src/server.ts",
        importedName: "handlePromptContext",
        sourceModule: "./hooks/prompt-context",
        resolvedPath: "src/hooks/prompt-context.ts",
        isDefault: false,
        isNamespace: false,
      },
      {
        filePath: "src/router.ts",
        importedName: "handlePromptContext",
        sourceModule: "./hooks/prompt-context",
        resolvedPath: "src/hooks/prompt-context.ts",
        isDefault: false,
        isNamespace: false,
      },
      {
        filePath: "src/other.ts",
        importedName: "something",
        sourceModule: "./other-module",
        resolvedPath: "src/other-module.ts",
        isDefault: false,
        isNamespace: false,
      },
    ]);

    const result = store.findImporterFiles("src/hooks/prompt-context.ts");
    expect(result).toHaveLength(2);
    expect(result).toContain("src/server.ts");
    expect(result).toContain("src/router.ts");
  });

  it("returns empty array when no file imports the resolved path", () => {
    store.upsertImports([
      {
        filePath: "src/a.ts",
        importedName: "foo",
        sourceModule: "./foo",
        resolvedPath: "src/foo.ts",
        isDefault: false,
        isNamespace: false,
      },
    ]);

    const result = store.findImporterFiles("src/nonexistent.ts");
    expect(result).toHaveLength(0);
  });

  it("deduplicates importer files when multiple named imports come from the same file", () => {
    store.upsertImports([
      {
        filePath: "src/consumer.ts",
        importedName: "ClassA",
        sourceModule: "./module",
        resolvedPath: "src/module.ts",
        isDefault: false,
        isNamespace: false,
      },
      {
        filePath: "src/consumer.ts",
        importedName: "ClassB",
        sourceModule: "./module",
        resolvedPath: "src/module.ts",
        isDefault: false,
        isNamespace: false,
      },
    ]);

    const result = store.findImporterFiles("src/module.ts");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("src/consumer.ts");
  });

  it("stores namespace imports correctly", () => {
    store.upsertImports([
      {
        filePath: "src/index.ts",
        importedName: "path",
        sourceModule: "path",
        resolvedPath: null,
        isDefault: false,
        isNamespace: true,
      },
    ]);

    const result = store.getImportsForFile("src/index.ts");
    expect(result).toHaveLength(1);
    expect(result[0].isNamespace).toBe(true);
    expect(result[0].isDefault).toBe(false);
  });
});
