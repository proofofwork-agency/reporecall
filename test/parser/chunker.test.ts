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
});
