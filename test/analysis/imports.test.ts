import { describe, it, expect, beforeAll } from "vitest";
import Parser from "web-tree-sitter";
import { resolve } from "path";
import { readFileSync } from "fs";
import { extractImports, resolveImportPath } from "../../src/analysis/imports.js";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");

let tsLanguage: Parser.Language;

beforeAll(async () => {
  await Parser.init();
  const wasmPath = resolve(
    "node_modules",
    "tree-sitter-wasms",
    "out",
    "tree-sitter-typescript.wasm"
  );
  tsLanguage = await Parser.Language.load(wasmPath);
});

function parseTS(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(tsLanguage);
  return parser.parse(code);
}

describe("extractImports", () => {
  it("extracts named imports", () => {
    const tree = parseTS(`import { foo, bar } from "./module";`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(2);
    expect(imports[0]).toEqual({
      importedName: "foo",
      sourceModule: "./module",
      isDefault: false,
      isNamespace: false,
    });
    expect(imports[1]).toEqual({
      importedName: "bar",
      sourceModule: "./module",
      isDefault: false,
      isNamespace: false,
    });
  });

  it("extracts default import", () => {
    const tree = parseTS(`import Foo from "./module";`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({
      importedName: "Foo",
      sourceModule: "./module",
      isDefault: true,
      isNamespace: false,
    });
  });

  it("extracts namespace import", () => {
    const tree = parseTS(`import * as ns from "./module";`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({
      importedName: "ns",
      sourceModule: "./module",
      isDefault: false,
      isNamespace: true,
    });
  });

  it("extracts aliased import with alias as importedName", () => {
    const tree = parseTS(`import { foo as bar } from "./module";`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(1);
    expect(imports[0].importedName).toBe("bar");
    expect(imports[0].sourceModule).toBe("./module");
    expect(imports[0].isDefault).toBe(false);
  });

  it("extracts type import", () => {
    const tree = parseTS(`import type { Foo } from "./module";`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(1);
    expect(imports[0].importedName).toBe("Foo");
    expect(imports[0].sourceModule).toBe("./module");
  });

  it("extracts re-export as import", () => {
    const tree = parseTS(`export { foo } from "./module";`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({
      importedName: "foo",
      sourceModule: "./module",
      isDefault: false,
      isNamespace: false,
    });
  });

  it("extracts mixed default + named imports", () => {
    const tree = parseTS(`import Foo, { bar, baz } from "./module";`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(3);
    const names = imports.map((i) => i.importedName);
    expect(names).toContain("Foo");
    expect(names).toContain("bar");
    expect(names).toContain("baz");

    const defaultImport = imports.find((i) => i.importedName === "Foo");
    expect(defaultImport?.isDefault).toBe(true);

    const namedImport = imports.find((i) => i.importedName === "bar");
    expect(namedImport?.isDefault).toBe(false);
  });

  it("extracts from fixture file with multiple import forms", () => {
    const content = readFileSync(resolve(FIXTURES, "imports-sample.ts"), "utf-8");
    const tree = parseTS(content);
    const imports = extractImports(tree.rootNode, "typescript");

    // Should have: foo, bar (named), Foo (default), ns (namespace),
    // bar2 (aliased), FooType (type), Default (default), named, another (named),
    // express (default from external), reExported (re-export)
    expect(imports.length).toBeGreaterThanOrEqual(10);

    const names = imports.map((i) => i.importedName);
    expect(names).toContain("foo");
    expect(names).toContain("bar");
    expect(names).toContain("Foo");
    expect(names).toContain("ns");
    expect(names).toContain("bar2");
    expect(names).toContain("express");
    expect(names).toContain("reExported");
  });

  it("handles external module import", () => {
    const tree = parseTS(`import express from "express";`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(1);
    expect(imports[0].importedName).toBe("express");
    expect(imports[0].sourceModule).toBe("express");
    expect(imports[0].isDefault).toBe(true);
  });

  it("returns empty array for file with no imports", () => {
    const tree = parseTS(`const x = 1;\nfunction foo() {}`);
    const imports = extractImports(tree.rootNode, "typescript");

    expect(imports).toHaveLength(0);
  });
});

describe("resolveImportPath", () => {
  it("returns null for external modules", () => {
    expect(resolveImportPath("express", "src/index.ts", FIXTURES)).toBeNull();
    expect(resolveImportPath("@scope/pkg", "src/index.ts", FIXTURES)).toBeNull();
  });

  it("resolves relative path to existing file with extension", () => {
    // imports-sample.ts exists in FIXTURES
    const result = resolveImportPath("./imports-sample", "dummy.ts", FIXTURES);
    expect(result).toBe("imports-sample.ts");
  });

  it("returns null for unresolvable relative paths", () => {
    const result = resolveImportPath("./nonexistent-file", "dummy.ts", FIXTURES);
    expect(result).toBeNull();
  });
});
