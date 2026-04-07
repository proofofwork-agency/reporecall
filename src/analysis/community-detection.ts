import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { AdjacencyGraph } from "./graph-builder.js";

const MAX_COMMUNITY_FRACTION = 0.25;
const MIN_SPLIT_SIZE = 10;

export interface CommunityResult {
  /** communityId → sorted list of chunkIds */
  communities: Map<number, string[]>;
  /** chunkId → communityId */
  membership: Map<string, number>;
  /** communityId → cohesion score (0–1) */
  cohesion: Map<number, number>;
  /** communityId → human-readable label */
  labels: Map<number, string>;
}

/**
 * Detect communities in the adjacency graph using Louvain modularity optimization.
 * Ports graphify-3's cluster.py logic:
 *  1. Isolates → singleton communities
 *  2. Run Louvain on connected subgraph
 *  3. Split oversized communities (>25% of nodes)
 *  4. Re-index by size descending (community 0 = largest)
 *  5. Compute cohesion per community
 */
export function detectCommunities(
  adjGraph: AdjacencyGraph,
  opts?: { maxCommunityFraction?: number; minSplitSize?: number }
): CommunityResult {
  const maxFrac = opts?.maxCommunityFraction ?? MAX_COMMUNITY_FRACTION;
  const minSplit = opts?.minSplitSize ?? MIN_SPLIT_SIZE;

  if (adjGraph.nodeCount === 0) {
    return { communities: new Map(), membership: new Map(), cohesion: new Map(), labels: new Map() };
  }

  // Build graphology graph from adjacency
  const g = new Graph({ type: "undirected", multi: false });

  for (const [id, node] of adjGraph.nodes) {
    g.addNode(id, { name: node.name, filePath: node.filePath, kind: node.kind });
  }

  // Track unique edges (undirected, so only add once per pair)
  const addedEdges = new Set<string>();
  for (const [source, targets] of adjGraph.adjacency) {
    for (const [target, data] of targets) {
      const key = source < target ? `${source}\0${target}` : `${target}\0${source}`;
      if (addedEdges.has(key)) continue;
      if (!g.hasNode(source) || !g.hasNode(target)) continue;
      addedEdges.add(key);
      try {
        g.addEdge(source, target, { relation: data.relation });
      } catch {
        // duplicate edge — skip
      }
    }
  }

  if (g.size === 0) {
    // No edges — every node is its own community
    return buildSingletonResult(adjGraph);
  }

  // Find isolates (degree 0)
  const isolates: string[] = [];
  const connected: string[] = [];
  g.forEachNode((node) => {
    if (g.degree(node) === 0) isolates.push(node);
    else connected.push(node);
  });

  // Run Louvain on connected subgraph
  const raw = new Map<number, string[]>();

  if (connected.length > 0) {
    // louvain assigns community to each node as a node attribute
    let communityMap: Record<string, number>;
    try {
      communityMap = louvain(g);
    } catch {
      return buildSingletonResult(adjGraph);
    }

    // Build raw communities from connected nodes only
    for (const nodeId of connected) {
      const cid = communityMap[nodeId] as number;
      if (!raw.has(cid)) raw.set(cid, []);
      raw.get(cid)!.push(nodeId);
    }
  }

  // Add isolates as singleton communities
  let nextCid = raw.size > 0 ? Math.max(...raw.keys()) + 1 : 0;
  for (const iso of isolates) {
    raw.set(nextCid++, [iso]);
  }

  // Split oversized communities
  const maxSize = Math.max(minSplit, Math.floor(adjGraph.nodeCount * maxFrac));
  const splitCommunities: string[][] = [];

  for (const [, members] of raw) {
    if (members.length > maxSize) {
      const subs = splitCommunity(g, members);
      for (const sub of subs) splitCommunities.push(sub);
    } else {
      splitCommunities.push(members);
    }
  }

  // Re-index by size descending (community 0 = largest)
  splitCommunities.sort((a, b) => b.length - a.length);

  const communities = new Map<number, string[]>();
  const membership = new Map<string, number>();
  const cohesionMap = new Map<number, number>();
  const labels = new Map<number, string>();

  for (let i = 0; i < splitCommunities.length; i++) {
    const members = splitCommunities[i]!.sort();
    communities.set(i, members);
    for (const m of members) membership.set(m, i);
    cohesionMap.set(i, computeCohesion(g, members));
    labels.set(i, generateLabel(adjGraph, members));
  }

  return { communities, membership, cohesion: cohesionMap, labels };
}

function splitCommunity(g: Graph, nodes: string[]): string[][] {
  // Build subgraph and re-run Louvain
  const sub = new Graph({ type: "undirected", multi: false });
  const nodeSet = new Set(nodes);

  for (const n of nodes) {
    if (g.hasNode(n)) sub.addNode(n, g.getNodeAttributes(n));
  }

  g.forEachEdge((_edge, _attrs, source, target) => {
    if (nodeSet.has(source) && nodeSet.has(target) && sub.hasNode(source) && sub.hasNode(target)) {
      try { sub.addEdge(source, target, _attrs); } catch { /* dup */ }
    }
  });

  if (sub.size === 0) {
    // No internal edges — each node is its own community
    return nodes.map(n => [n]);
  }

  try {
    const communityMap = louvain(sub);
    const subComms = new Map<number, string[]>();
    for (const n of nodes) {
      const cid = communityMap[n] as number;
      if (!subComms.has(cid)) subComms.set(cid, []);
      subComms.get(cid)!.push(n);
    }

    if (subComms.size <= 1) return [nodes.sort()];
    return [...subComms.values()].map(members => members.sort());
  } catch {
    return [nodes.sort()];
  }
}

/**
 * Cohesion = actual_internal_edges / possible_internal_edges.
 * Mirrors graphify-3's cohesion_score().
 */
function computeCohesion(g: Graph, members: string[]): number {
  const n = members.length;
  if (n <= 1) return 1.0;

  const memberSet = new Set(members);
  let actualEdges = 0;

  g.forEachEdge((_edge, _attrs, source, target) => {
    if (memberSet.has(source) && memberSet.has(target)) actualEdges++;
  });

  const possible = (n * (n - 1)) / 2;
  if (possible === 0) return 0;
  return Math.round((actualEdges / possible) * 100) / 100;
}

/**
 * Generate a human-readable label from common directory + top non-generic nodes by degree.
 */
function generateLabel(adjGraph: AdjacencyGraph, members: string[]): string {
  // Find dominant directory
  const dirCounts = new Map<string, number>();
  for (const id of members) {
    const node = adjGraph.nodes.get(id);
    if (!node) continue;
    const parts = node.filePath.split("/");
    // Use second-level dir under src/ or first-level dir
    const dir = parts[0] === "src" && parts.length > 1 ? `src/${parts[1]}` : parts[0] ?? "";
    if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }
  const sortedDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);
  // Filter out test/scripts dirs for label purposes — they add noise
  const srcDirs = sortedDirs.filter(([d]) => !d.startsWith("test") && !d.startsWith("scripts"));
  const labelDirs = srcDirs.length > 0 ? srcDirs : sortedDirs;
  const topDir = labelDirs[0];
  // Only use dir prefix if it covers >40% of members (truly dominant), otherwise show top 2
  let dominantDir = "";
  if (topDir && topDir[1] > members.length * 0.4) {
    dominantDir = topDir[0];
  } else if (labelDirs.length >= 2) {
    dominantDir = `${labelDirs[0]![0]}+${labelDirs[1]![0]}`;
  } else if (topDir) {
    dominantDir = topDir[0];
  }

  // Pick top meaningful names (skip generic ones)
  const GENERIC = new Set(["get", "set", "add", "remove", "close", "open", "log", "error",
    "constructor", "describe_handler", "init", "run", "start", "stop", "clear", "reset",
    "getLogger", "loadConfig", "resolve", "search", "fetch", "send",
    "emit", "on", "off", "once", "listen", "parse", "stringify",
    "call", "apply", "bind", "then", "catch", "finally",
    "main", "handle", "process", "execute", "dispatch"]);
  const topNames = members
    .map(id => ({ name: adjGraph.nodes.get(id)?.name ?? id, degree: adjGraph.nodes.get(id)?.degree ?? 0 }))
    .filter(n => !GENERIC.has(n.name) && n.name.length >= 3 && n.name !== "<anonymous>")
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 2)
    .map(n => n.name);

  if (dominantDir && topNames.length > 0) {
    return `${dominantDir}: ${topNames.join(", ")}`;
  }
  return topNames.length > 0 ? topNames.join(" / ") : (dominantDir || (members[0] ?? "unknown"));
}

function buildSingletonResult(adjGraph: AdjacencyGraph): CommunityResult {
  const communities = new Map<number, string[]>();
  const membership = new Map<string, number>();
  const cohesion = new Map<number, number>();
  const labels = new Map<number, string>();

  let i = 0;
  for (const [id, node] of adjGraph.nodes) {
    communities.set(i, [id]);
    membership.set(id, i);
    cohesion.set(i, 1.0);
    labels.set(i, node.name);
    i++;
  }
  return { communities, membership, cohesion, labels };
}
