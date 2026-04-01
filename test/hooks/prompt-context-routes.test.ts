import { describe, it, expect, vi } from "vitest";
import { handlePromptContext, handlePromptContextDetailed } from "../../src/hooks/prompt-context.js";
import type { AssembledContext } from "../../src/search/types.js";
import type { SeedResult } from "../../src/search/seed.js";

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
    prepareSeedResult: (_query: string, _queryMode: string, seedResult?: SeedResult) => seedResult ?? { bestSeed: null, seeds: [] },
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
  it("adds advisory metadata for strong focused context", async () => {
    const result = await handlePromptContextDetailed(
      "how does main work",
      makeSearch({
        searchWithContext: async () => makeAssembledContext("## src/app.ts\nfunction main() {}", 80),
      }),
      makeConfig(),
      undefined,
      undefined,
      "trace"
    );

    expect(result.contextStrength).toBe("partial");
    expect(result.recommendedNextReads).toContain("src/app.ts");
    expect(result.advisoryText).toContain("Reporecall Guidance");
  });

  it("lookup mode uses existing searchWithContext behavior", async () => {
    let searchCalled = false;
    const search = makeSearch({
      searchWithContext: async () => {
        searchCalled = true;
        return makeAssembledContext("lookup context");
      },
    });

    const result = await handlePromptContext(
      "what is the main function",
      search,
      makeConfig(),
      undefined,
      undefined,
      "lookup"
    );

    expect(searchCalled).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("lookup context");
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

  it("trace mode with caller-shaped query and metadata returns focused context", async () => {
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
      "where is handleLogin used",
      search,
      makeConfig(),
      undefined,
      undefined,
      "trace",
      metadata,
      fts
    );

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Relevant codebase context");
    expect(result!.text).toContain("Files included:");
  });

  it("trace mode degrades to broader focused context when tree coverage is weak", async () => {
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
      "trace",
      metadata,
      fts
    );

    expect(result.resolvedQueryMode).toBe("trace");
    expect(result.context).not.toBeNull();
    expect(result.context!.text).toContain("Relevant codebase context");
  });

  it("trace mode falls through to broader focused context when seed confidence is low", async () => {
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
      "trace",
      metadata,
      fts
    );

    expect(result).not.toBeNull();
    expect(result!.text).toContain("Relevant codebase context");
  });

  it("bug mode uses deep route context assembly", async () => {
    const search = makeSearch({
      searchWithContext: async () => makeAssembledContext("chunk context"),
    });

    const result = await handlePromptContext(
      "debug the broken flow",
      search,
      makeConfig(),
      undefined,
      undefined,
      "bug"
    );

    expect(result).not.toBeNull();
    expect(result!.text).toContain("chunk context");
  });

  it("trace mode without metadata/fts falls back to direct context search", async () => {
    let searchCalled = false;
    const search = makeSearch({
      searchWithContext: async () => {
        searchCalled = true;
        return makeAssembledContext("trace fallback");
      },
    });

    const result = await handlePromptContext(
      "how does handleLogin work",
      search,
      makeConfig(),
      undefined,
      undefined,
      "trace"
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
      "trace"
    );

    expect(result).toBeNull();
  });

  it("skips memory lookup for normal code queries when code context exists", async () => {
    const memorySearch = {
      search: vi.fn(async () => {
        throw new Error("memory search should not run");
      }),
    };

    const result = await handlePromptContextDetailed(
      "show AuthCallback",
      makeSearch({
        searchWithContext: async () => makeAssembledContext("code context"),
      }),
      makeConfig({ memory: true, memoryBudget: 500 }),
      undefined,
      undefined,
      "lookup",
      undefined,
      undefined,
      undefined,
      undefined,
      memorySearch as any
    );

    expect(memorySearch.search).not.toHaveBeenCalled();
    expect(result.context).not.toBeNull();
    expect(result.memoryCount).toBe(0);
    expect(result.memoryRoute).toBe("M0");
  });

  it("skips memory lookup for summary-only code queries", async () => {
    const memorySearch = {
      search: vi.fn(async () => {
        throw new Error("memory search should not run");
      }),
    };

    const result = await handlePromptContextDetailed(
      "how does auth flow work?",
      makeSearch({
        searchWithContext: async () => ({
          text: "## Reporecall Summary\nNo code context injected.",
          tokenCount: 40,
          chunks: [],
          deliveryMode: "summary_only",
        }),
        getLastBroadSelectionDiagnostics: () => ({
          broadMode: "workflow",
          dominantFamily: "auth",
          deliveryMode: "summary_only",
          selectedFiles: [],
          deferredReason: "flow_noise_auth_bundle",
        }),
      }),
      makeConfig({ memory: true, memoryBudget: 500 }),
      undefined,
      undefined,
      "architecture",
      undefined,
      undefined,
      undefined,
      undefined,
      memorySearch as any
    );

    expect(memorySearch.search).not.toHaveBeenCalled();
    expect(result.memoryCount).toBe(0);
    expect(result.memoryRoute).toBe("M0");
    expect(result.deliveryMode).toBe("summary_only");
  });

  it("trace mode does not append generic related seeds that were not directly requested", async () => {
    const timestamp = new Date().toISOString();
    const seedChunk = {
      id: "seed",
      filePath: "supabase/functions/generate-image/index.ts",
      name: "serve_handler",
      kind: "arrow_function",
      startLine: 40,
      endLine: 200,
      content: "const serve_handler = async () => {};",
      language: "typescript",
      indexedAt: timestamp,
    };
    const helperChunk = {
      id: "helper",
      filePath: "supabase/functions/generate-image/index.ts",
      name: "isInternalServiceRequest",
      kind: "function_declaration",
      startLine: 20,
      endLine: 38,
      content: "function isInternalServiceRequest() {}",
      language: "typescript",
      indexedAt: timestamp,
    };
    const docsChunk = {
      id: "docs",
      filePath: "docs/AUTOMATIC_WORKFLOW_GENERATION.md",
      name: "docs/AUTOMATIC_WORKFLOW_GENERATION.md",
      kind: "file",
      startLine: 1,
      endLine: 30,
      content: "# automatic workflow generation",
      language: "markdown",
      indexedAt: timestamp,
    };
    const generationHook = {
      id: "generation-hook",
      filePath: "src/hooks/useStoryboardGeneration.ts",
      name: "useGenerateShotImage",
      kind: "function_declaration",
      startLine: 100,
      endLine: 130,
      content: "export function useGenerateShotImage() {}",
      language: "typescript",
      indexedAt: timestamp,
    };

    const metadata: any = {
      findChunksByNames: () => [],
      getChunk: () => undefined,
      getChunksByIds: (ids: string[]) =>
        [seedChunk, helperChunk, docsChunk, generationHook].filter((chunk) => ids.includes(chunk.id)),
      findChunksByFilePath: (filePath: string) =>
        [seedChunk, helperChunk, docsChunk, generationHook].filter((chunk) => chunk.filePath === filePath),
      findCallers: () => [],
      findCallees: () => [],
      findCalleesForChunk: () => [],
    };

    const seedResult: SeedResult = {
      bestSeed: {
        chunkId: "seed",
        name: "serve_handler",
        filePath: "supabase/functions/generate-image/index.ts",
        kind: "arrow_function",
        confidence: 0.99,
        reason: "resolved_target",
        targetId: "endpoint:supabase/functions/generate-image/index.ts",
        targetKind: "endpoint",
        resolvedAlias: "generate-image",
        resolutionSource: "parent_dir",
      },
      seeds: [
        {
          chunkId: "seed",
          name: "serve_handler",
          filePath: "supabase/functions/generate-image/index.ts",
          kind: "arrow_function",
          confidence: 0.99,
          reason: "resolved_target",
          targetId: "endpoint:supabase/functions/generate-image/index.ts",
          targetKind: "endpoint",
          resolvedAlias: "generate-image",
          resolutionSource: "parent_dir",
        },
        {
          chunkId: "docs",
          name: "docs/AUTOMATIC_WORKFLOW_GENERATION.md",
          filePath: "docs/AUTOMATIC_WORKFLOW_GENERATION.md",
          kind: "file",
          confidence: 0.99,
          reason: "resolved_target",
          targetId: "file_module:docs/AUTOMATIC_WORKFLOW_GENERATION.md",
          targetKind: "file_module",
          resolvedAlias: "generation",
          resolutionSource: "file_path",
        },
        {
          chunkId: "generation-hook",
          name: "useGenerateShotImage",
          filePath: "src/hooks/useStoryboardGeneration.ts",
          kind: "function_declaration",
          confidence: 0.99,
          reason: "resolved_target",
          targetId: "file_module:src/hooks/useStoryboardGeneration.ts",
          targetKind: "file_module",
          resolvedAlias: "generation",
          resolutionSource: "file_path",
        },
      ],
    };

    const result = await handlePromptContextDetailed(
      "how does generate-image work",
      makeSearch(),
      makeConfig(),
      undefined,
      undefined,
      "trace",
      metadata,
      { search: () => [] } as any,
      seedResult
    );

    expect(result.resolvedQueryMode).toBe("trace");
    expect(result.context?.text).toContain("supabase/functions/generate-image/index.ts");
    expect(result.context?.text).not.toContain("docs/AUTOMATIC_WORKFLOW_GENERATION.md");
    expect(result.context?.text).not.toContain("src/hooks/useStoryboardGeneration.ts");
  });

  it("trace mode explicit hook targets do not append single-token auth file modules", async () => {
    const timestamp = new Date().toISOString();
    const seedChunk = {
      id: "seed",
      filePath: "src/hooks/useAuth.tsx",
      name: "useAuth",
      kind: "function_declaration",
      startLine: 91,
      endLine: 93,
      content: "export function useAuth() {}",
      language: "typescript",
      indexedAt: timestamp,
    };
    const authPage = {
      id: "auth-page",
      filePath: "src/pages/Auth.tsx",
      name: "Auth",
      kind: "function_declaration",
      startLine: 6,
      endLine: 41,
      content: "export function Auth() { useAuth(); }",
      language: "typescript",
      indexedAt: timestamp,
    };
    const authCallback = {
      id: "auth-callback",
      filePath: "src/pages/AuthCallback.tsx",
      name: "AuthCallback",
      kind: "function_declaration",
      startLine: 12,
      endLine: 175,
      content: "export function AuthCallback() { useAuth(); }",
      language: "typescript",
      indexedAt: timestamp,
    };
    const helperChunk = {
      id: "helper",
      filePath: "src/hooks/useAuth.tsx",
      name: "syncAuthState",
      kind: "function_declaration",
      startLine: 70,
      endLine: 90,
      content: "function syncAuthState() {}",
      language: "typescript",
      indexedAt: timestamp,
    };

    const metadata: any = {
      findChunksByNames: () => [],
      getChunk: () => undefined,
      getChunksByIds: (ids: string[]) => [seedChunk, authPage, authCallback, helperChunk].filter((chunk) => ids.includes(chunk.id)),
      findChunksByFilePath: (filePath: string) => [seedChunk, authPage, authCallback, helperChunk].filter((chunk) => chunk.filePath === filePath),
      findCallers: () => [{
        chunkId: "helper",
        filePath: "src/hooks/useAuth.tsx",
        line: 72,
        callerName: "syncAuthState",
      }],
      findCallees: () => [],
      findCalleesForChunk: () => [],
    };

    const seedResult: SeedResult = {
      bestSeed: {
        chunkId: "seed",
        name: "useAuth",
        filePath: "src/hooks/useAuth.tsx",
        kind: "function_declaration",
        confidence: 0.95,
        reason: "explicit_target",
      },
      seeds: [
        {
          chunkId: "seed",
          name: "useAuth",
          filePath: "src/hooks/useAuth.tsx",
          kind: "function_declaration",
          confidence: 0.95,
          reason: "explicit_target",
        },
        {
          chunkId: "auth-page",
          name: "Auth",
          filePath: "src/pages/Auth.tsx",
          kind: "function_declaration",
          confidence: 0.99,
          reason: "resolved_target",
          targetId: "file_module:src/pages/Auth.tsx",
          targetKind: "file_module",
          resolvedAlias: "auth",
          resolutionSource: "file_path",
        },
        {
          chunkId: "auth-callback",
          name: "AuthCallback",
          filePath: "src/pages/AuthCallback.tsx",
          kind: "function_declaration",
          confidence: 0.99,
          reason: "resolved_target",
          targetId: "file_module:src/pages/AuthCallback.tsx",
          targetKind: "file_module",
          resolvedAlias: "auth",
          resolutionSource: "file_path",
        },
      ],
    };

    const result = await handlePromptContextDetailed(
      "how does useAuth manage auth state changes",
      makeSearch(),
      makeConfig(),
      undefined,
      undefined,
      "trace",
      metadata,
      { search: () => [] } as any,
      seedResult
    );

    expect(result.resolvedQueryMode).toBe("trace");
    expect(result.context?.text).toContain("src/hooks/useAuth.tsx");
    expect(result.context?.text).not.toContain("src/pages/Auth.tsx");
    expect(result.context?.text).not.toContain("src/pages/AuthCallback.tsx");
  });
});
