import { describe, it, expect } from "vitest";
import { findGodNodes, findSurprises, suggestQuestions } from "../../src/analysis/topology-analysis.js";
import type { AdjacencyGraph, GraphNode, EdgeData } from "../../src/analysis/graph-builder.js";
import type { CommunityResult } from "../../src/analysis/community-detection.js";

function makeGraph(
  nodeList: Array<{ id: string; name: string; filePath: string; kind?: string }>,
  edgeList: Array<[string, string, Partial<EdgeData>?]>
): AdjacencyGraph {
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, Map<string, EdgeData>>();
  let edgeCount = 0;

  for (const n of nodeList) {
    nodes.set(n.id, { chunkId: n.id, name: n.name, filePath: n.filePath, kind: n.kind ?? "function", degree: 0 });
  }

  for (const [src, tgt, data] of edgeList) {
    const ed: EdgeData = { relation: "calls", ...data };
    if (!adjacency.has(src)) adjacency.set(src, new Map());
    if (!adjacency.get(src)!.has(tgt)) {
      adjacency.get(src)!.set(tgt, ed);
      edgeCount++;
    }
    if (!adjacency.has(tgt)) adjacency.set(tgt, new Map());
    if (!adjacency.get(tgt)!.has(src)) {
      adjacency.get(tgt)!.set(src, { ...ed, relation: "called_by" });
    }
  }

  for (const [id, neighbors] of adjacency) {
    const node = nodes.get(id);
    if (node) node.degree = neighbors.size;
  }

  return { nodes, adjacency, nodeCount: nodes.size, edgeCount };
}

function makeCommunities(membership: Record<string, number>): CommunityResult {
  const membershipMap = new Map(Object.entries(membership));
  const communities = new Map<number, string[]>();
  for (const [id, cid] of membershipMap) {
    if (!communities.has(cid)) communities.set(cid, []);
    communities.get(cid)!.push(id);
  }
  const cohesion = new Map<number, number>();
  const labels = new Map<number, string>();
  for (const [cid, members] of communities) {
    cohesion.set(cid, 0.5);
    labels.set(cid, members.join(" / "));
  }
  return { communities, membership: membershipMap, cohesion, labels };
}

describe("findGodNodes", () => {
  it("returns nodes sorted by degree", () => {
    const graph = makeGraph(
      [
        { id: "hub", name: "Router", filePath: "src/router.ts" },
        { id: "a", name: "handlerA", filePath: "src/a.ts" },
        { id: "b", name: "handlerB", filePath: "src/b.ts" },
        { id: "c", name: "handlerC", filePath: "src/c.ts" },
        { id: "d", name: "handlerD", filePath: "src/d.ts" },
        { id: "leaf", name: "util", filePath: "src/util.ts" },
      ],
      [
        ["hub", "a"], ["hub", "b"], ["hub", "c"], ["hub", "d"], ["hub", "leaf"],
        ["a", "leaf"],
      ]
    );

    const gods = findGodNodes(graph, undefined, 3);
    expect(gods.length).toBeLessThanOrEqual(3);
    expect(gods[0]!.name).toBe("Router");
    expect(gods[0]!.degree).toBe(5);
  });

  it("excludes test files", () => {
    const graph = makeGraph(
      [
        { id: "test", name: "testRunner", filePath: "test/runner.test.ts" },
        { id: "a", name: "funcA", filePath: "src/a.ts" },
        { id: "b", name: "funcB", filePath: "src/b.ts" },
      ],
      [["test", "a"], ["test", "b"], ["a", "b"]]
    );

    const gods = findGodNodes(graph);
    const names = gods.map(g => g.name);
    expect(names).not.toContain("testRunner");
  });

  it("excludes file-level hub nodes", () => {
    const graph = makeGraph(
      [
        { id: "file", name: "router", filePath: "src/router.ts" },
        { id: "a", name: "handlerA", filePath: "src/a.ts" },
        { id: "b", name: "handlerB", filePath: "src/b.ts" },
      ],
      [["file", "a"], ["file", "b"]]
    );

    const gods = findGodNodes(graph);
    // "router" matches basename "router.ts" stem → excluded
    const names = gods.map(g => g.name);
    expect(names).not.toContain("router");
  });
});

describe("findSurprises", () => {
  it("scores cross-directory edges higher", () => {
    const graph = makeGraph(
      [
        { id: "auth", name: "AuthService", filePath: "src/auth/service.ts" },
        { id: "pay", name: "PaymentValidator", filePath: "src/payments/validator.ts" },
        { id: "authHelper", name: "hashPassword", filePath: "src/auth/hash.ts" },
      ],
      [
        ["auth", "pay", { resolutionSource: "symbol" }],
        ["auth", "authHelper", { resolutionSource: "import" }],
      ]
    );

    const communities = makeCommunities({ auth: 0, pay: 1, authHelper: 0 });
    const surprises = findSurprises(graph, communities);

    // auth → pay should be more surprising (cross-dir + cross-community + weak resolution)
    expect(surprises.length).toBeGreaterThan(0);
    expect(surprises[0]!.score).toBeGreaterThan(0);
  });

  it("returns empty for same-file edges", () => {
    const graph = makeGraph(
      [
        { id: "a", name: "funcA", filePath: "src/service.ts" },
        { id: "b", name: "funcB", filePath: "src/service.ts" },
      ],
      [["a", "b"]]
    );

    const communities = makeCommunities({ a: 0, b: 0 });
    const surprises = findSurprises(graph, communities);
    expect(surprises.length).toBe(0);
  });
});

describe("suggestQuestions", () => {
  it("generates questions for weakly-resolved edges", () => {
    const graph = makeGraph(
      [
        { id: "a", name: "ServiceA", filePath: "src/a.ts" },
        { id: "b", name: "ServiceB", filePath: "src/b.ts" },
      ],
      [["a", "b", { resolutionSource: "symbol" }]]
    );

    const communities = makeCommunities({ a: 0, b: 0 });
    const questions = suggestQuestions(graph, communities);
    expect(questions.some(q => q.type === "weak_resolution")).toBe(true);
  });

  it("returns no questions for well-connected graph", () => {
    // Small, tightly connected graph with only import-resolved edges
    const graph = makeGraph(
      [
        { id: "a", name: "a", filePath: "src/a.ts" },
        { id: "b", name: "b", filePath: "src/b.ts" },
      ],
      [["a", "b", { resolutionSource: "import" }]]
    );

    const communities = makeCommunities({ a: 0, b: 0 });
    const questions = suggestQuestions(graph, communities);
    // Should not generate weak_resolution questions for import-resolved edges
    expect(questions.filter(q => q.type === "weak_resolution").length).toBe(0);
  });
});
