import { describe, it, expect } from "vitest";
import {
  isImplementationPath,
  isImplementationChunk,
  prioritizeForHookContext,
} from "../../src/search/context-prioritization.js";
import type { SearchResult } from "../../src/search/types.js";
import type { MemoryConfig } from "../../src/core/config.js";
import type { MetadataStore } from "../../src/storage/metadata-store.js";

function makeResult(over: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "c1",
    score: 1,
    filePath: "src/foo.ts",
    name: "foo",
    kind: "function",
    startLine: 1,
    endLine: 10,
    content: "",
    language: "typescript",
    ...over,
  };
}

const minimalConfig = {
  implementationPaths: ["src/", "lib/", "bin/"],
  testPenaltyFactor: 0.5,
} as unknown as MemoryConfig;

const noMetadata = {} as MetadataStore;

describe("isImplementationPath", () => {
  it("returns true for source files under default implementation paths", () => {
    expect(isImplementationPath("src/foo.ts")).toBe(true);
    expect(isImplementationPath("lib/util.ts")).toBe(true);
    expect(isImplementationPath("bin/run.ts")).toBe(true);
  });

  it("returns true for implementation dirs matched anywhere in the path", () => {
    expect(isImplementationPath("packages/app/src/index.ts")).toBe(true);
    expect(isImplementationPath("server/handlers/route.ts")).toBe(true);
  });

  it("returns false for tests and node_modules under defaults", () => {
    expect(isImplementationPath("test/foo.test.ts")).toBe(false);
    expect(isImplementationPath("node_modules/x/index.ts")).toBe(false);
    expect(isImplementationPath("docs/readme.md")).toBe(false);
  });

  it("respects a custom implementationPaths argument", () => {
    // Path matches only via the custom prefix, not the built-in regex.
    expect(isImplementationPath("custom/foo.ts", ["custom/"])).toBe(true);
    expect(isImplementationPath("custom/foo.ts", ["other/"])).toBe(false);
    expect(isImplementationPath("custom/foo.ts", ["custom/", "other/"])).toBe(true);
  });
});

describe("isImplementationChunk", () => {
  it("delegates to isImplementationPath using the chunk's filePath", () => {
    expect(isImplementationChunk(makeResult({ filePath: "src/a.ts" }))).toBe(true);
    expect(isImplementationChunk(makeResult({ filePath: "test/a.test.ts" }))).toBe(false);
  });

  it("forwards a custom implementationPaths argument", () => {
    expect(
      isImplementationChunk(makeResult({ filePath: "custom/a.ts" }), ["custom/"])
    ).toBe(true);
    expect(
      isImplementationChunk(makeResult({ filePath: "custom/a.ts" }), ["other/"])
    ).toBe(false);
  });
});

describe("prioritizeForHookContext", () => {
  it("returns a deterministic, stable order across repeated calls", () => {
    const results = [
      makeResult({ id: "a", filePath: "src/a.ts", name: "a", score: 1 }),
      makeResult({ id: "b", filePath: "src/b.ts", name: "b", score: 1 }),
    ];

    const first = prioritizeForHookContext("a b", results, minimalConfig, undefined, noMetadata);
    const second = prioritizeForHookContext("a b", results, minimalConfig, undefined, noMetadata);

    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
    expect(first).toHaveLength(results.length);
  });

  it("attaches a finite hookScore to every result and sorts by it descending", () => {
    const results = [
      makeResult({ id: "doc", filePath: "docs/readme.md", name: "readme", score: 5 }),
      makeResult({ id: "impl", filePath: "src/auth.ts", name: "authenticate", score: 5 }),
    ];

    const ordered = prioritizeForHookContext("authenticate", results, minimalConfig, undefined, noMetadata);

    for (const r of ordered) {
      expect(typeof r.hookScore).toBe("number");
      expect(Number.isFinite(r.hookScore)).toBe(true);
    }
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i - 1]!.hookScore!).toBeGreaterThanOrEqual(ordered[i]!.hookScore!);
    }
  });

  it("ranks an implementation chunk above a doc chunk with equal base score", () => {
    const results = [
      makeResult({ id: "doc", filePath: "docs/readme.md", name: "readme", score: 5 }),
      makeResult({ id: "impl", filePath: "src/auth.ts", name: "authenticate", score: 5 }),
    ];

    const ordered = prioritizeForHookContext("authenticate", results, minimalConfig, undefined, noMetadata);

    expect(ordered[0]!.id).toBe("impl");
  });

  it("does not throw and preserves the input length with empty results", () => {
    const ordered = prioritizeForHookContext("anything", [], minimalConfig, undefined, noMetadata);
    expect(ordered).toEqual([]);
  });
});
