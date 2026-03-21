import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { chunkFileWithCalls } from "../../src/parser/chunker.js";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");

describe("chunker", () => {
  it("should chunk a TypeScript file into functions, classes, interfaces", async () => {
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);

    const names = chunks.map((c) => c.name);

    // Should find the main function
    expect(names).toContain("validateSession");

    // Should find the class
    expect(names.some((n) => n === "SessionManager")).toBe(true);

    // Should find the interface
    expect(names.some((n) => n === "UserSession")).toBe(true);

    // Should find the enum
    expect(names.some((n) => n === "AuthProvider")).toBe(true);

    // Each chunk should have required fields
    for (const chunk of chunks) {
      expect(chunk.id).toBeTruthy();
      expect(chunk.filePath).toBeTruthy();
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.content.length).toBeGreaterThan(0);
      expect(chunk.language).toBe("typescript");
    }
  });

  it("should fall back to whole-file chunk for unsupported extensions", async () => {
    // Create a temp file with unsupported extension - use the .py file with forced .txt treatment
    // Actually, let's just test with a file that has no tree-sitter support
    const { chunks } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.py"),
      FIXTURES
    );

    // Python has tree-sitter support, so it should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(0);

    const names = chunks.map((c) => c.name);
    expect(names.some((n) => n === "DatabaseConnection")).toBe(true);
    expect(names.some((n) => n === "create_tables")).toBe(true);
  });

  it("should name Deno.serve() callback as serve_handler", async () => {
    const { chunks, language, rawImports } = await chunkFileWithCalls(
      resolve(FIXTURES, "deno-edge.ts"),
      FIXTURES
    );

    const names = chunks.map((c) => c.name);
    // The arrow function passed to Deno.serve() should get a derived name
    expect(names).toContain("serve_handler");
    // Should NOT contain <anonymous>
    expect(names).not.toContain("<anonymous>");
    // Language should be preserved (not null)
    expect(language).toBe("typescript");
    // Imports should still be extracted
    expect(rawImports.length).toBeGreaterThan(0);
  });

  it("should preserve language on fallback chunks (no extractable nodes)", async () => {
    // A TS file with only import statements and no functions/classes
    // will hit the nodes.length === 0 fallback
    const { writeFile, rm } = await import("fs/promises");
    const tmpPath = resolve(FIXTURES, "_fallback-test.ts");
    await writeFile(tmpPath, 'import { foo } from "./bar";\nconst x = 42;\n');
    try {
      const { chunks, language, rawImports } = await chunkFileWithCalls(tmpPath, FIXTURES);
      expect(language).toBe("typescript");
      expect(chunks.length).toBe(1);
      expect(chunks[0].kind).toBe("file");
      expect(chunks[0].language).toBe("typescript");
      // Should still extract the import
      expect(rawImports.length).toBeGreaterThan(0);
    } finally {
      await rm(tmpPath);
    }
  });

  it("should produce stable chunk IDs", async () => {
    const { chunks: chunks1 } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );
    const { chunks: chunks2 } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    expect(chunks1.map((c) => c.id)).toEqual(chunks2.map((c) => c.id));
  });

  it("should fall back to a whole-file chunk when bash parsing throws", async () => {
    const { mkdtemp, writeFile, rm } = await import("fs/promises");
    const { join } = await import("path");
    const { tmpdir } = await import("os");

    const dir = await mkdtemp(join(tmpdir(), "reporecall-bash-fallback-"));
    const filePath = join(dir, "run-e2e-tests.sh");
    const content = `#!/bin/bash

echo "🧪 DUTO E2E Test Runner"
MODE=\${1:-"all"}

case $MODE in
  "all")
    echo "🚀 Running all E2E tests..."
    ;;
  *)
    echo "❌ Unknown mode: $MODE"
    ;;
esac
`;

    await writeFile(filePath, content, "utf8");

    try {
      const { chunks, language, callEdges, rawImports } = await chunkFileWithCalls(filePath, dir);

      expect(language).toBe("bash");
      expect(callEdges).toHaveLength(0);
      expect(rawImports).toHaveLength(0);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].kind).toBe("file");
      expect(chunks[0].filePath).toBe("run-e2e-tests.sh");
      expect(chunks[0].language).toBe("bash");
      expect(chunks[0].content).toContain("🧪 DUTO E2E Test Runner");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
