import { describe, expect, it, vi } from "vitest";
import { resolveCallTarget } from "../../src/analysis/resolve.js";
import type { ImportRecord } from "../../src/storage/import-store.js";
import type { StoredChunk } from "../../src/storage/types.js";

/**
 * Minimal mock for the MetadataStore facade methods used by resolveCallTarget.
 */
function createMockMetadata(opts: {
  imports?: ImportRecord[];
  chunks?: StoredChunk[];
}) {
  return {
    findImportByName: vi.fn((name: string, filePath?: string) => {
      return (opts.imports ?? []).filter(
        (i) =>
          i.importedName === name &&
          (filePath === undefined || i.filePath === filePath)
      );
    }),
    findChunksByNames: vi.fn((names: string[]) => {
      return (opts.chunks ?? []).filter((c) => names.includes(c.name));
    }),
  };
}

describe("resolveCallTarget", () => {
  it("resolves via import when target name matches an import", () => {
    const metadata = createMockMetadata({
      imports: [
        {
          filePath: "src/app.ts",
          importedName: "validate",
          sourceModule: "./auth",
          resolvedPath: "src/auth.ts",
          isDefault: false,
          isNamespace: false,
        },
      ],
    });

    const result = resolveCallTarget(
      { targetName: "validate", filePath: "src/app.ts" },
      metadata
    );

    expect(result).toBe("src/auth.ts");
    expect(metadata.findImportByName).toHaveBeenCalledWith(
      "validate",
      "src/app.ts"
    );
  });

  it("resolves via receiver import (authService.validate)", () => {
    const metadata = createMockMetadata({
      imports: [
        {
          filePath: "src/app.ts",
          importedName: "authService",
          sourceModule: "./auth-service",
          resolvedPath: "src/auth-service.ts",
          isDefault: true,
          isNamespace: false,
        },
      ],
    });

    const result = resolveCallTarget(
      {
        targetName: "validate",
        filePath: "src/app.ts",
        receiver: "authService",
      },
      metadata
    );

    expect(result).toBe("src/auth-service.ts");
  });

  it("skips receiver lookup when receiver is 'this'", () => {
    const metadata = createMockMetadata({
      imports: [],
      chunks: [
        {
          id: "c1",
          filePath: "src/app.ts",
          name: "validate",
          kind: "method_definition",
          startLine: 10,
          endLine: 20,
          content: "validate() {}",
          language: "typescript",
          indexedAt: "2026-01-01",
        },
      ],
    });

    const result = resolveCallTarget(
      { targetName: "validate", filePath: "src/app.ts", receiver: "this" },
      metadata
    );

    // Should fall through to same-file check since "this" is skipped
    expect(result).toBe("src/app.ts");
  });

  it("resolves same-file when chunk exists in the same file", () => {
    const metadata = createMockMetadata({
      imports: [],
      chunks: [
        {
          id: "c1",
          filePath: "src/utils.ts",
          name: "helperFn",
          kind: "function_declaration",
          startLine: 1,
          endLine: 5,
          content: "function helperFn() {}",
          language: "typescript",
          indexedAt: "2026-01-01",
        },
      ],
    });

    const result = resolveCallTarget(
      { targetName: "helperFn", filePath: "src/utils.ts" },
      metadata
    );

    expect(result).toBe("src/utils.ts");
    expect(metadata.findChunksByNames).toHaveBeenCalledWith(["helperFn"]);
  });

  it("returns null when no resolution is found", () => {
    const metadata = createMockMetadata({ imports: [], chunks: [] });

    const result = resolveCallTarget(
      { targetName: "unknownFn", filePath: "src/app.ts" },
      metadata
    );

    expect(result).toBeNull();
  });

  it("does not match same-file chunk if chunk is in a different file", () => {
    const metadata = createMockMetadata({
      imports: [],
      chunks: [
        {
          id: "c1",
          filePath: "src/other.ts",
          name: "helperFn",
          kind: "function_declaration",
          startLine: 1,
          endLine: 5,
          content: "function helperFn() {}",
          language: "typescript",
          indexedAt: "2026-01-01",
        },
      ],
    });

    const result = resolveCallTarget(
      { targetName: "helperFn", filePath: "src/app.ts" },
      metadata
    );

    expect(result).toBeNull();
  });

  it("prefers import resolution over same-file", () => {
    const metadata = createMockMetadata({
      imports: [
        {
          filePath: "src/app.ts",
          importedName: "validate",
          sourceModule: "./auth",
          resolvedPath: "src/auth.ts",
          isDefault: false,
          isNamespace: false,
        },
      ],
      chunks: [
        {
          id: "c1",
          filePath: "src/app.ts",
          name: "validate",
          kind: "function_declaration",
          startLine: 1,
          endLine: 5,
          content: "function validate() {}",
          language: "typescript",
          indexedAt: "2026-01-01",
        },
      ],
    });

    const result = resolveCallTarget(
      { targetName: "validate", filePath: "src/app.ts" },
      metadata
    );

    // Import takes priority
    expect(result).toBe("src/auth.ts");
  });

  it("skips import without resolvedPath and falls through", () => {
    const metadata = createMockMetadata({
      imports: [
        {
          filePath: "src/app.ts",
          importedName: "React",
          sourceModule: "react",
          resolvedPath: null,
          isDefault: true,
          isNamespace: false,
        },
      ],
      chunks: [],
    });

    const result = resolveCallTarget(
      { targetName: "React", filePath: "src/app.ts" },
      metadata
    );

    expect(result).toBeNull();
  });
});
