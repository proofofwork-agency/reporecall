import { describe, it, expect, vi } from "vitest";
import { assembleFlowContext, assembleDeepRouteContext } from "../../src/search/context-assembler.js";
import type { SearchResult } from "../../src/search/types.js";
import type { StackTree, TreeNode } from "../../src/search/tree-builder.js";

function makeSeedNode(overrides?: Partial<TreeNode>): TreeNode {
  return {
    chunkId: "seed-1",
    name: "handleLogin",
    filePath: "src/auth/handler.ts",
    kind: "function_declaration",
    depth: 0,
    direction: "seed",
    ...overrides,
  };
}

function makeTreeNode(overrides: Partial<TreeNode> & { chunkId: string; direction: "up" | "down" }): TreeNode {
  return {
    name: "node",
    filePath: "src/file.ts",
    kind: "function_declaration",
    depth: 1,
    ...overrides,
  };
}

function makeTree(overrides?: Partial<StackTree>): StackTree {
  return {
    seed: makeSeedNode(),
    upTree: [],
    downTree: [],
    edges: [],
    nodeCount: 1,
    coverage: { utilization: 0, balance: 0, overall: 0 },
    ...overrides,
  };
}

function makeMetadata(chunkMap: Record<string, { id: string; filePath: string; name: string; kind: string; startLine: number; endLine: number; content: string; language: string; docstring?: string; parentName?: string; indexedAt: string }>) {
  return {
    getChunksByIds: (ids: string[]) =>
      ids.map((id) => chunkMap[id]).filter(Boolean),
  };
}

function makeChunk(id: string, name: string, content: string, overrides?: Record<string, unknown>) {
  return {
    id,
    filePath: `src/${name}.ts`,
    name,
    kind: "function_declaration",
    startLine: 1,
    endLine: 10,
    content,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("assembleFlowContext", () => {
  it("returns context with flow trace header", () => {
    const seed = makeSeedNode();
    const tree = makeTree({ seed });
    const metadata = makeMetadata({
      "seed-1": makeChunk("seed-1", "handleLogin", "function handleLogin(req, res) { validateCredentials(req.user, req.pass); }", {
        filePath: "src/auth/handler.ts",
        startLine: 45,
        endLine: 89,
      }),
    });

    const result = assembleFlowContext(tree, metadata as any, 10000);

    expect(result.text).toContain("## Relevant codebase context (flow trace)");
    expect(result.text).toContain("> Files included:");
    expect(result.text).toContain("> Seed:");
    expect(result.text).toContain("handleLogin");
  });

  it("includes seed section always", () => {
    const tree = makeTree();
    const metadata = makeMetadata({
      "seed-1": makeChunk("seed-1", "handleLogin", "function handleLogin() {}", {
        filePath: "src/auth/handler.ts",
        startLine: 45,
        endLine: 89,
      }),
    });

    const result = assembleFlowContext(tree, metadata as any, 10000);

    expect(result.text).toContain("### Seed");
    expect(result.text).toContain("handleLogin");
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("includes callers section when upTree has nodes", () => {
    const callerNode = makeTreeNode({
      chunkId: "caller-1",
      name: "routeHandler",
      filePath: "src/routes.ts",
      direction: "up",
      depth: 1,
    });
    const tree = makeTree({ upTree: [callerNode], nodeCount: 2 });
    const metadata = makeMetadata({
      "seed-1": makeChunk("seed-1", "handleLogin", "function handleLogin() {}", {
        filePath: "src/auth/handler.ts",
        startLine: 45,
        endLine: 89,
      }),
      "caller-1": makeChunk("caller-1", "routeHandler", "function routeHandler(req) { handleLogin(req); }", {
        filePath: "src/routes.ts",
        startLine: 10,
        endLine: 25,
      }),
    });

    const result = assembleFlowContext(tree, metadata as any, 10000);

    expect(result.text).toContain("### Callers");
    expect(result.text).toContain("routeHandler");
  });

  it("includes callees section when downTree has nodes", () => {
    const calleeNode = makeTreeNode({
      chunkId: "callee-1",
      name: "validateCredentials",
      filePath: "src/auth/validator.ts",
      direction: "down",
      depth: 1,
    });
    const tree = makeTree({ downTree: [calleeNode], nodeCount: 2 });
    const metadata = makeMetadata({
      "seed-1": makeChunk("seed-1", "handleLogin", "function handleLogin() {}", {
        filePath: "src/auth/handler.ts",
        startLine: 45,
        endLine: 89,
      }),
      "callee-1": makeChunk("callee-1", "validateCredentials", "function validateCredentials(user, pass) {}", {
        filePath: "src/auth/validator.ts",
        startLine: 5,
        endLine: 20,
      }),
    });

    const result = assembleFlowContext(tree, metadata as any, 10000);

    expect(result.text).toContain("### Callees");
    expect(result.text).toContain("validateCredentials");
  });

  it("respects token budget — seed always included, extras trimmed", () => {
    const callerNode = makeTreeNode({
      chunkId: "caller-1",
      name: "bigCaller",
      filePath: "src/routes.ts",
      direction: "up",
      depth: 1,
    });
    const calleeNode = makeTreeNode({
      chunkId: "callee-1",
      name: "bigCallee",
      filePath: "src/validator.ts",
      direction: "down",
      depth: 1,
    });
    const tree = makeTree({
      upTree: [callerNode],
      downTree: [calleeNode],
      nodeCount: 3,
    });

    // Very tiny budget — should only fit seed
    const metadata = makeMetadata({
      "seed-1": makeChunk("seed-1", "handleLogin", "function handleLogin() { return true; }", {
        filePath: "src/auth/handler.ts",
        startLine: 45,
        endLine: 89,
      }),
      "caller-1": makeChunk("caller-1", "bigCaller", "x".repeat(5000), {
        filePath: "src/routes.ts",
      }),
      "callee-1": makeChunk("callee-1", "bigCallee", "y".repeat(5000), {
        filePath: "src/validator.ts",
      }),
    });

    // Budget just enough for header + seed (~100 tokens), but not callers/callees
    const result = assembleFlowContext(tree, metadata as any, 150);

    expect(result.text).toContain("### Seed");
    expect(result.text).toContain("handleLogin");
    expect(result.tokenCount).toBeLessThanOrEqual(150);
  });

  it("returns chunks array with SearchResult-like objects", () => {
    const tree = makeTree();
    const metadata = makeMetadata({
      "seed-1": makeChunk("seed-1", "handleLogin", "function handleLogin() {}", {
        filePath: "src/auth/handler.ts",
        startLine: 45,
        endLine: 89,
      }),
    });

    const result = assembleFlowContext(tree, metadata as any, 10000);

    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    const seedChunk = result.chunks.find((c) => c.name === "handleLogin");
    expect(seedChunk).toBeDefined();
    expect(seedChunk!.filePath).toBe("src/auth/handler.ts");
    expect(seedChunk!.kind).toBe("function_declaration");
  });

  it("returns empty context when seed chunk missing from metadata", () => {
    const tree = makeTree({
      upTree: [
        makeTreeNode({ chunkId: "caller-1", direction: "up", name: "caller", depth: 1 }),
      ],
      nodeCount: 2,
    });
    // metadata has no chunks at all — seed is missing
    const metadata = makeMetadata({});

    const result = assembleFlowContext(tree, metadata as any, 10000);

    expect(result.text).toBe("");
    expect(result.tokenCount).toBe(0);
    expect(result.chunks).toHaveLength(0);
  });

  it("orders callers in reverse depth (entry point first)", () => {
    const caller1 = makeTreeNode({
      chunkId: "caller-1",
      name: "entryPoint",
      filePath: "src/entry.ts",
      direction: "up",
      depth: 2,
    });
    const caller2 = makeTreeNode({
      chunkId: "caller-2",
      name: "middleware",
      filePath: "src/middleware.ts",
      direction: "up",
      depth: 1,
    });
    const tree = makeTree({ upTree: [caller1, caller2], nodeCount: 3 });
    const metadata = makeMetadata({
      "seed-1": makeChunk("seed-1", "handleLogin", "function handleLogin() {}", {
        filePath: "src/auth/handler.ts",
        startLine: 45,
        endLine: 89,
      }),
      "caller-1": makeChunk("caller-1", "entryPoint", "function entryPoint() {}", {
        filePath: "src/entry.ts",
        startLine: 1,
        endLine: 10,
      }),
      "caller-2": makeChunk("caller-2", "middleware", "function middleware() {}", {
        filePath: "src/middleware.ts",
        startLine: 1,
        endLine: 10,
      }),
    });

    const result = assembleFlowContext(tree, metadata as any, 10000);

    // entryPoint (depth 2) should appear before middleware (depth 1) in the callers section
    // Search after "### Callers" to avoid matching file paths in the "Files included:" header
    const callersIdx = result.text.indexOf("### Callers");
    expect(callersIdx).toBeGreaterThan(-1);
    const afterCallers = result.text.slice(callersIdx);
    const entryIdx = afterCallers.indexOf("entryPoint");
    const middlewareIdx = afterCallers.indexOf("middleware");
    expect(entryIdx).toBeLessThan(middlewareIdx);
    // Seed section should come after callers section
    const seedIdx = result.text.indexOf("### Seed");
    expect(seedIdx).toBeGreaterThan(callersIdx);
  });
});

describe("assembleDeepRouteContext", () => {
  it("prepends low-confidence marker to the context", () => {
    const chunks: SearchResult[] = [
      {
        id: "c1",
        score: 0.9,
        filePath: "src/auth.ts",
        name: "authenticate",
        kind: "function_declaration",
        startLine: 1,
        endLine: 10,
        content: "function authenticate() {}",
        language: "typescript",
      },
    ];

    const result = assembleDeepRouteContext(chunks, 10000);

    expect(result.text).toContain("## Relevant codebase context (broad search)");
    expect(result.text).toContain("> Files included:");
    expect(result.text).toContain("Answer from this context first. If coverage is incomplete, Reporecall MCP tools can fill gaps.");
  });

  it("includes the regular chunk context after the marker", () => {
    const chunks: SearchResult[] = [
      {
        id: "c1",
        score: 0.9,
        filePath: "src/auth.ts",
        name: "authenticate",
        kind: "function_declaration",
        startLine: 1,
        endLine: 10,
        content: "function authenticate() {}",
        language: "typescript",
      },
    ];

    const result = assembleDeepRouteContext(chunks, 10000);

    expect(result.text).toContain("authenticate");
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty chunks when input is empty", () => {
    const result = assembleDeepRouteContext([], 10000);

    expect(result.text).toContain("## Relevant codebase context (broad search)");
    expect(result.chunks).toHaveLength(0);
  });
});
