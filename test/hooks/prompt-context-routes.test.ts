import { describe, it, expect, vi } from "vitest";
import { handlePromptContext, handlePromptContextDetailed } from "../../src/hooks/prompt-context.js";
import type { AssembledContext } from "../../src/search/types.js";

function makeAssembledContext(text = "## context", tokenCount = 50): AssembledContext {
  return {
    text,
    tokenCount,
    chunks: [
      {
        id: "c1",
        filePath: "src/app.ts",
        name: "main",
        kind: "function_declaration",
        startLine: 1,
        endLine: 5,
        content: "function main() {}",
        language: "typescript",
        score: 0.85,
      },
    ],
  };
}

function makeSearch(overrides?: Partial<any>): any {
  return {
    search: async () => [],
    searchWithContext: async () => makeAssembledContext(),
    hasConceptContext: () => false,
    findCallers: () => [],
    findCallees: () => [],
    updateStores: () => {},
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<any>): any {
  return {
    projectRoot: "/tmp/test",
    dataDir: "/tmp/test/.memory",
    contextBudget: 8000,
    ...overrides,
  };
}

describe("handlePromptContext — route integration", () => {
  it("R0 route uses existing searchWithContext behavior", async () => {
    let searchCalled = false;
    const search = makeSearch({
      searchWithContext: async () => {
        searchCalled = true;
        return makeAssembledContext("R0 context");
      },
    });

    const result = await handlePromptContext(
      "what is the main function",
      search,
      makeConfig(),
      undefined,
      undefined,
      "R0"
    );

    expect(searchCalled).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("R0 context");
  });

  it("undefined route falls back to R0 behavior", async () => {
    let searchCalled = false;
    const search = makeSearch({
      searchWithContext: async () => {
        searchCalled = true;
        return makeAssembledContext();
      },
    });

    const result = await handlePromptContext(
      "what is main",
      search,
      makeConfig()
    );

    expect(searchCalled).toBe(true);
    expect(result).not.toBeNull();
  });

  it("skip route returns null and does not search", async () => {
    let searchCalled = false;
    const search = makeSearch({
      searchWithContext: async () => {
        searchCalled = true;
        return makeAssembledContext();
      },
    });

    const result = await handlePromptContext(
      "what is main",
      search,
      makeConfig(),
      undefined,
      undefined,
      "skip"
    );

    expect(result).toBeNull();
    expect(searchCalled).toBe(false);
  });

  it("R1 route with metadata and fts calls flow assembly", async () => {
    // Mock metadata that returns chunks for seed resolution and tree building
    const metadata: any = {
      findChunksByNames: (names: string[]) => [
        {
          id: "seed-1",
          filePath: "src/auth/handler.ts",
          name: "handleLogin",
          kind: "function_declaration",
          startLine: 45,
          endLine: 89,
          content: "function handleLogin() {}",
          language: "typescript",
          indexedAt: new Date().toISOString(),
        },
      ],
      getChunk: (id: string) =>
        id === "seed-1"
          ? {
              id: "seed-1",
              filePath: "src/auth/handler.ts",
              name: "handleLogin",
              kind: "function_declaration",
              startLine: 45,
              endLine: 89,
              content: "function handleLogin() {}",
              language: "typescript",
              indexedAt: new Date().toISOString(),
            }
          : id === "caller-1"
            ? {
                id: "caller-1",
                filePath: "src/routes.ts",
                name: "routeHandler",
                kind: "function_declaration",
                startLine: 10,
                endLine: 25,
                content: "function routeHandler(req) { return handleLogin(req); }",
                language: "typescript",
                indexedAt: new Date().toISOString(),
              }
          : undefined,
      getChunksByIds: (ids: string[]) =>
        ids
          .map((id) =>
            id === "seed-1"
              ? {
                  id: "seed-1",
                  filePath: "src/auth/handler.ts",
                  name: "handleLogin",
                  kind: "function_declaration",
                  startLine: 45,
                  endLine: 89,
                  content: "function handleLogin() {}",
                  language: "typescript",
                  indexedAt: new Date().toISOString(),
                }
              : id === "caller-1"
                ? {
                    id: "caller-1",
                    filePath: "src/routes.ts",
                    name: "routeHandler",
                    kind: "function_declaration",
                    startLine: 10,
                    endLine: 25,
                    content: "function routeHandler(req) { return handleLogin(req); }",
                    language: "typescript",
                    indexedAt: new Date().toISOString(),
                  }
              : undefined
          )
          .filter(Boolean),
      findCallers: () => [{
        chunkId: "caller-1",
        filePath: "src/routes.ts",
        line: 12,
        callerName: "routeHandler",
      }],
      findCallees: () => [],
    };

    const fts: any = {
      search: () => [],
    };

    const search = makeSearch();

    const result = await handlePromptContext(
      "how does handleLogin work",
      search,
      makeConfig(),
      undefined,
      undefined,
      "R1",
      metadata,
      fts
    );

    expect(result).not.toBeNull();
    // Should contain flow trace header from assembleFlowContext
    expect(result!.text).toContain("flow trace");
  });

  it("R1 route degrades to R2 when tree coverage is weak", async () => {
    const metadata: any = {
      findChunksByNames: () => [
        {
          id: "seed-1",
          filePath: "src/auth/handler.ts",
          name: "handleLogin",
          kind: "function_declaration",
          startLine: 45,
          endLine: 89,
          content: "function handleLogin() {}",
          language: "typescript",
          indexedAt: new Date().toISOString(),
        },
      ],
      getChunk: () => undefined,
      getChunksByIds: (ids: string[]) =>
        ids
          .map((id) =>
            id === "seed-1"
              ? {
                  id: "seed-1",
                  filePath: "src/auth/handler.ts",
                  name: "handleLogin",
                  kind: "function_declaration",
                  startLine: 45,
                  endLine: 89,
                  content: "function handleLogin() {}",
                  language: "typescript",
                  indexedAt: new Date().toISOString(),
                }
              : undefined
          )
          .filter(Boolean),
      findCallers: () => [],
      findCallees: () => [],
    };

    const fts: any = {
      search: () => [],
    };

    const result = await handlePromptContextDetailed(
      "how does handleLogin work",
      makeSearch({
        searchWithContext: async () => makeAssembledContext("fallback context"),
      }),
      makeConfig(),
      undefined,
      undefined,
      "R1",
      metadata,
      fts
    );

    expect(result.resolvedRoute).toBe("R2");
    expect(result.context).not.toBeNull();
    expect(result.context!.text).toContain("low confidence");
  });

  it("R1 route falls through to R2 when seed confidence is low", async () => {
    const metadata: any = {
      findChunksByNames: () => [], // No matches -> low confidence
      getChunk: () => undefined,
      getChunksByIds: () => [],
      findCallers: () => [],
      findCallees: () => [],
    };

    const fts: any = {
      search: () => [], // No FTS results either
    };

    const search = makeSearch({
      searchWithContext: async () => makeAssembledContext("fallback context"),
    });

    const result = await handlePromptContext(
      "how does something work",
      search,
      makeConfig(),
      undefined,
      undefined,
      "R1",
      metadata,
      fts
    );

    expect(result).not.toBeNull();
    // Should fall through to R2 (deep route) since no seed found
    expect(result!.text).toContain("low confidence");
  });

  it("R2 route uses deep route context assembly", async () => {
    const search = makeSearch({
      searchWithContext: async () => makeAssembledContext("chunk context"),
    });

    const result = await handlePromptContext(
      "debug the broken flow",
      search,
      makeConfig(),
      undefined,
      undefined,
      "R2"
    );

    expect(result).not.toBeNull();
    expect(result!.text).toContain("low confidence");
    expect(result!.text).toContain("repository tools are allowed");
  });

  it("R1 without metadata/fts falls back to R0", async () => {
    let searchCalled = false;
    const search = makeSearch({
      searchWithContext: async () => {
        searchCalled = true;
        return makeAssembledContext("R0 fallback");
      },
    });

    const result = await handlePromptContext(
      "how does handleLogin work",
      search,
      makeConfig(),
      undefined,
      undefined,
      "R1"
      // No metadata or fts
    );

    expect(searchCalled).toBe(true);
    expect(result).not.toBeNull();
  });

  it("empty query still returns null regardless of route", async () => {
    const result = await handlePromptContext(
      "",
      makeSearch(),
      makeConfig(),
      undefined,
      undefined,
      "R1"
    );

    expect(result).toBeNull();
  });
});
