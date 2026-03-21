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
    resolveTargetAliases: vi.fn(() => []),
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

    expect(result).toEqual({ filePath: "src/auth.ts", resolutionSource: "import" });
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

    expect(result).toEqual({ filePath: "src/auth-service.ts", resolutionSource: "import" });
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
    expect(result).toEqual({ filePath: "src/app.ts", resolutionSource: "same_file" });
  });

  it("skips receiver lookup when receiver is 'self'", () => {
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
      { targetName: "validate", filePath: "src/app.ts", receiver: "self" },
      metadata
    );

    // Should fall through to same-file check since "self" is skipped
    expect(result).toEqual({ filePath: "src/app.ts", resolutionSource: "same_file" });
  });

  it("skips receiver lookup when receiver is 'super'", () => {
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
      { targetName: "validate", filePath: "src/app.ts", receiver: "super" },
      metadata
    );

    // Should fall through to same-file check since "super" is skipped
    expect(result).toEqual({ filePath: "src/app.ts", resolutionSource: "same_file" });
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

    expect(result).toEqual({ filePath: "src/utils.ts", resolutionSource: "same_file" });
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
    expect(result).toEqual({ filePath: "src/auth.ts", resolutionSource: "import" });
  });

  it("resolves literal-dispatch aliases to typed targets", () => {
    const metadata = createMockMetadata({ imports: [], chunks: [] });
    metadata.resolveTargetAliases.mockReturnValue([
      {
        target: {
          id: "endpoint:supabase/functions/generate-image/index.ts",
          kind: "endpoint",
          canonicalName: "generate-image",
          normalizedName: "generate image",
          filePath: "supabase/functions/generate-image/index.ts",
          ownerChunkId: "serve-handler",
          subsystem: "functions",
          confidence: 0.98,
        },
        alias: "generate-image",
        normalizedAlias: "generate image",
        source: "literal",
        weight: 0.95,
      },
    ]);

    const result = resolveCallTarget(
      {
        targetName: "invoke",
        filePath: "src/client.ts",
        literalTargets: ["generate-image"],
      },
      metadata
    );

    expect(result).toEqual({
      filePath: "supabase/functions/generate-image/index.ts",
      targetId: "endpoint:supabase/functions/generate-image/index.ts",
      targetKind: "endpoint",
      resolutionSource: "alias_literal",
    });
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
