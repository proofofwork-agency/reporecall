import { describe, it, expect } from "vitest";
import { detectCommunities, type CommunityResult } from "../../src/analysis/community-detection.js";
import type { AdjacencyGraph, GraphNode, EdgeData } from "../../src/analysis/graph-builder.js";

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

describe("detectCommunities", () => {
  it("returns empty for empty graph", () => {
    const graph: AdjacencyGraph = { nodes: new Map(), adjacency: new Map(), nodeCount: 0, edgeCount: 0 };
    const result = detectCommunities(graph);
    expect(result.communities.size).toBe(0);
    expect(result.membership.size).toBe(0);
  });

  it("assigns isolates to singleton communities", () => {
    const graph = makeGraph(
      [
        { id: "a", name: "funcA", filePath: "a.ts" },
        { id: "b", name: "funcB", filePath: "b.ts" },
      ],
      [] // no edges
    );
    const result = detectCommunities(graph);
    expect(result.communities.size).toBe(2);
    expect(result.membership.get("a")).toBeDefined();
    expect(result.membership.get("b")).toBeDefined();
    expect(result.membership.get("a")).not.toBe(result.membership.get("b"));
    // Singleton cohesion = 1.0
    for (const [, score] of result.cohesion) {
      expect(score).toBe(1.0);
    }
  });

  it("detects two distinct communities in a barbell graph", () => {
    // Barbell: two cliques connected by a single bridge edge
    const graph = makeGraph(
      [
        { id: "a1", name: "a1", filePath: "group-a/a1.ts" },
        { id: "a2", name: "a2", filePath: "group-a/a2.ts" },
        { id: "a3", name: "a3", filePath: "group-a/a3.ts" },
        { id: "b1", name: "b1", filePath: "group-b/b1.ts" },
        { id: "b2", name: "b2", filePath: "group-b/b2.ts" },
        { id: "b3", name: "b3", filePath: "group-b/b3.ts" },
      ],
      [
        // Clique A
        ["a1", "a2"], ["a1", "a3"], ["a2", "a3"],
        // Clique B
        ["b1", "b2"], ["b1", "b3"], ["b2", "b3"],
        // Bridge
        ["a1", "b1"],
      ]
    );

    const result = detectCommunities(graph);

    // Should detect at least 2 communities
    expect(result.communities.size).toBeGreaterThanOrEqual(2);

    // All nodes should be assigned
    expect(result.membership.size).toBe(6);

    // a-nodes should be in the same community
    const commA = result.membership.get("a1");
    expect(result.membership.get("a2")).toBe(commA);
    expect(result.membership.get("a3")).toBe(commA);

    // b-nodes should be in the same community
    const commB = result.membership.get("b1");
    expect(result.membership.get("b2")).toBe(commB);
    expect(result.membership.get("b3")).toBe(commB);

    // The two communities should be different
    expect(commA).not.toBe(commB);
  });

  it("community 0 is the largest", () => {
    const graph = makeGraph(
      [
        { id: "a1", name: "a1", filePath: "a.ts" },
        { id: "a2", name: "a2", filePath: "a.ts" },
        { id: "a3", name: "a3", filePath: "a.ts" },
        { id: "a4", name: "a4", filePath: "a.ts" },
        { id: "b1", name: "b1", filePath: "b.ts" },
        { id: "b2", name: "b2", filePath: "b.ts" },
      ],
      [
        ["a1", "a2"], ["a1", "a3"], ["a1", "a4"], ["a2", "a3"], ["a3", "a4"],
        ["b1", "b2"],
        ["a1", "b1"],
      ]
    );
    const result = detectCommunities(graph);
    const comm0Members = result.communities.get(0) ?? [];
    for (const [, members] of result.communities) {
      expect(comm0Members.length).toBeGreaterThanOrEqual(members.length);
    }
  });

  it("generates labels from top degree nodes", () => {
    const graph = makeGraph(
      [
        { id: "hub", name: "AuthService", filePath: "auth.ts" },
        { id: "leaf1", name: "validate", filePath: "auth.ts" },
        { id: "leaf2", name: "hashPassword", filePath: "auth.ts" },
      ],
      [["hub", "leaf1"], ["hub", "leaf2"]]
    );
    const result = detectCommunities(graph);
    // At least one label should contain "AuthService" (the hub)
    const labels = [...result.labels.values()];
    expect(labels.some(l => l.includes("AuthService"))).toBe(true);
  });

  it("computes cohesion correctly", () => {
    // Triangle = 3 edges out of 3 possible = 1.0 cohesion
    const graph = makeGraph(
      [
        { id: "a", name: "a", filePath: "a.ts" },
        { id: "b", name: "b", filePath: "b.ts" },
        { id: "c", name: "c", filePath: "c.ts" },
      ],
      [["a", "b"], ["b", "c"], ["a", "c"]]
    );
    const result = detectCommunities(graph);
    // If all in one community, cohesion should be 1.0
    if (result.communities.size === 1) {
      expect(result.cohesion.get(0)).toBe(1.0);
    }
  });
});
