import { basename } from "path";
import type { AdjacencyGraph, GraphNode } from "./graph-builder.js";
import type { CommunityResult } from "./community-detection.js";
import { detectExecutionSurfaces } from "../search/utils.js";
import type {
  GodNodeRecord,
  SurpriseRecord,
  SuggestedQuestion,
} from "../storage/community-store.js";

// --- Constants ported from graphify-3 analyze.py ---
const TEST_FILE_RE = /[/\\](test|__tests__|spec|__spec__|fixtures|__fixtures__)[/\\]|\.(test|spec)\.[jt]sx?$/i;

// Resolution source → surprise weight (replaces AMBIGUOUS/INFERRED/EXTRACTED)
// Lowered alias_path from 3→1 because many normal cross-module deps use alias_path resolution
const RESOLUTION_SURPRISE: Record<string, number> = {
  alias_path: 1,
  alias_literal: 2,
  symbol: 2,
  import: 0,
  same_file: 0,
};

// Generic names that are too common to be meaningful hubs or surprise endpoints
const NOISE_NAMES = new Set([
  "get", "set", "add", "remove", "delete", "update", "create", "find",
  "log", "error", "warn", "info", "debug", "close", "open", "init",
  "run", "start", "stop", "reset", "clear", "push", "pop", "map",
  "filter", "reduce", "forEach", "toString", "valueOf", "constructor",
  "describe_handler", "test", "it", "expect", "describe",
  // Utility hubs that inflate degree but carry no architectural meaning
  "getLogger", "loadConfig", "resolve", "join", "parse", "stringify",
  "fetch", "send", "emit", "on", "off", "once", "listen",
  "search",  // too generic as a name (appears as vector-store method)
  "call", "apply", "bind", "then", "catch", "finally",
  "main", "handle", "process", "execute", "dispatch",
]);

// Minimum name length to be considered a meaningful node
const MIN_HUB_NAME_LENGTH = 4;

// --- God Nodes ---

function isFileNode(node: GraphNode): boolean {
  const name = node.name;
  const fileName = basename(node.filePath);
  // Name matches file name without extension
  const stem = fileName.replace(/\.[^.]+$/, "");
  if (name === fileName || name === stem) return true;
  // Method stubs: .foo()
  if (name.startsWith(".") && name.endsWith("()")) return true;
  return false;
}

function isTestFile(filePath: string): boolean {
  return TEST_FILE_RE.test(filePath);
}

export function findGodNodes(
  graph: AdjacencyGraph,
  communityResult?: CommunityResult,
  topN = 10
): GodNodeRecord[] {
  const sorted = [...graph.nodes.values()]
    .filter(n =>
      !isFileNode(n)
      && !isTestFile(n.filePath)
      && n.name !== "<anonymous>"
      && n.degree > 0
      && !NOISE_NAMES.has(n.name)
      && n.name.length >= MIN_HUB_NAME_LENGTH
    )
    .sort((a, b) => b.degree - a.degree);

  const result: GodNodeRecord[] = [];
  for (const node of sorted) {
    if (result.length >= topN) break;
    result.push({
      chunkId: node.chunkId,
      name: node.name,
      filePath: node.filePath,
      degree: node.degree,
      communityId: communityResult?.membership.get(node.chunkId)?.toString() ?? null,
    });
  }
  return result;
}

// --- Surprise Scoring ---

interface SurpriseCandidate {
  sourceId: string;
  targetId: string;
  score: number;
  reasons: string[];
  relation: string;
}

function topLevelDir(filePath: string): string {
  const parts = filePath.split("/");
  // Skip leading src/ to get meaningful directory
  if (parts[0] === "src" && parts.length > 1) return parts[1] ?? parts[0] ?? "";
  return parts[0] ?? "";
}

function surpriseScore(
  graph: AdjacencyGraph,
  sourceId: string,
  targetId: string,
  edgeResolutionSource: string | undefined,
  communityResult: CommunityResult
): SurpriseCandidate | null {
  const source = graph.nodes.get(sourceId);
  const target = graph.nodes.get(targetId);
  if (!source || !target) return null;
  if (isFileNode(source) || isFileNode(target)) return null;
  if (isTestFile(source.filePath) || isTestFile(target.filePath)) return null;
  if (NOISE_NAMES.has(source.name) || NOISE_NAMES.has(target.name)) return null;

  // Suppress connections involving major hubs — these are expected architectural wiring, not surprising.
  // Anything touching a high-degree node (>15) is a core dependency, not an anomaly.
  if (source.degree > 15 || target.degree > 15) return null;

  let score = 0;
  const reasons: string[] = [];

  // 1. Resolution source bonus
  const resScore = RESOLUTION_SURPRISE[edgeResolutionSource ?? "import"] ?? 1;
  score += resScore;
  if (resScore >= 2) {
    reasons.push(`weakly-resolved connection (${edgeResolutionSource})`);
  }

  // 2. Cross-directory bonus
  const srcDir = topLevelDir(source.filePath);
  const tgtDir = topLevelDir(target.filePath);
  if (srcDir !== tgtDir) {
    score += 2;
    reasons.push(`crosses directories (${srcDir} ↔ ${tgtDir})`);
  }

  // 3. Cross-community bonus
  const srcComm = communityResult.membership.get(sourceId);
  const tgtComm = communityResult.membership.get(targetId);
  if (srcComm !== undefined && tgtComm !== undefined && srcComm !== tgtComm) {
    score += 1;
    reasons.push(`bridges communities ${srcComm} → ${tgtComm}`);
  }

  // 4. Cross execution-surface bonus
  const srcSurfaces = detectExecutionSurfaces(source.filePath, source.name);
  const tgtSurfaces = detectExecutionSurfaces(target.filePath, target.name);
  if (srcSurfaces.length > 0 && tgtSurfaces.length > 0) {
    const overlap = srcSurfaces.some(s => tgtSurfaces.includes(s));
    if (!overlap) {
      score += 2;
      reasons.push(`crosses execution surfaces (${srcSurfaces[0]} ↔ ${tgtSurfaces[0]})`);
    }
  }

  // 5. Peripheral → hub bonus
  const minDeg = Math.min(source.degree, target.degree);
  const maxDeg = Math.max(source.degree, target.degree);
  if (minDeg <= 2 && maxDeg >= 5) {
    score += 1;
    const peripheral = source.degree <= 2 ? source.name : target.name;
    const hub = source.degree >= 5 ? source.name : target.name;
    reasons.push(`peripheral ${peripheral} reaches hub ${hub}`);
  }

  if (score === 0 || reasons.length === 0) return null;

  return {
    sourceId,
    targetId,
    score,
    reasons,
    relation: "calls",
  };
}

export function findSurprises(
  graph: AdjacencyGraph,
  communityResult: CommunityResult,
  topN = 10
): SurpriseRecord[] {
  const now = new Date().toISOString();
  const candidates: SurpriseCandidate[] = [];
  const seenPairs = new Set<string>();

  for (const [sourceId, targets] of graph.adjacency) {
    for (const [targetId, edgeData] of targets) {
      // Deduplicate undirected pairs
      const key = sourceId < targetId ? `${sourceId}\0${targetId}` : `${targetId}\0${sourceId}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);

      // Skip same-file edges (not surprising)
      const sourceNode = graph.nodes.get(sourceId);
      const targetNode = graph.nodes.get(targetId);
      if (sourceNode && targetNode && sourceNode.filePath === targetNode.filePath) continue;

      const candidate = surpriseScore(
        graph, sourceId, targetId,
        edgeData.resolutionSource, communityResult
      );
      if (candidate) candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates.slice(0, topN).map(c => ({
    sourceChunkId: c.sourceId,
    targetChunkId: c.targetId,
    score: c.score,
    reasons: c.reasons,
    relation: c.relation,
    computedAt: now,
  }));
}

// --- Suggested Questions ---

/**
 * Compute betweenness centrality approximation.
 * For performance, we sample up to 100 nodes as sources for BFS.
 */
function approximateBetweenness(graph: AdjacencyGraph, sampleSize = 100): Map<string, number> {
  const centrality = new Map<string, number>();
  for (const id of graph.nodes.keys()) centrality.set(id, 0);

  const nodeIds = [...graph.nodes.keys()];
  const samples = nodeIds.length <= sampleSize
    ? nodeIds
    : nodeIds.filter((_, i) => i % Math.ceil(nodeIds.length / sampleSize) === 0);

  for (const source of samples) {
    // BFS from source
    const dist = new Map<string, number>();
    const paths = new Map<string, number>();
    const stack: string[] = [];
    const predecessors = new Map<string, string[]>();

    dist.set(source, 0);
    paths.set(source, 1);
    const queue = [source];
    let qi = 0;

    while (qi < queue.length) {
      const v = queue[qi++]!;
      stack.push(v);
      const dv = dist.get(v)!;
      const pv = paths.get(v)!;
      const neighbors = graph.adjacency.get(v);
      if (!neighbors) continue;

      for (const w of neighbors.keys()) {
        if (!dist.has(w)) {
          dist.set(w, dv + 1);
          queue.push(w);
        }
        if (dist.get(w) === dv + 1) {
          paths.set(w, (paths.get(w) ?? 0) + pv);
          if (!predecessors.has(w)) predecessors.set(w, []);
          predecessors.get(w)!.push(v);
        }
      }
    }

    // Accumulate
    const delta = new Map<string, number>();
    for (const id of graph.nodes.keys()) delta.set(id, 0);

    while (stack.length) {
      const w = stack.pop()!;
      const preds = predecessors.get(w) ?? [];
      for (const v of preds) {
        const d = (delta.get(v) ?? 0) + ((paths.get(v)! / paths.get(w)!) * (1 + (delta.get(w) ?? 0)));
        delta.set(v, d);
      }
      if (w !== source) {
        centrality.set(w, (centrality.get(w) ?? 0) + (delta.get(w) ?? 0));
      }
    }
  }

  // Normalize
  const scale = samples.length > 0 ? 1 / samples.length : 1;
  for (const [id, val] of centrality) centrality.set(id, val * scale);

  return centrality;
}

export function suggestQuestions(
  graph: AdjacencyGraph,
  communityResult: CommunityResult,
  topN = 7
): SuggestedQuestion[] {
  const questions: SuggestedQuestion[] = [];

  // Type 1: Weakly-resolved edges — only interesting ones (cross-directory, not hub-to-hub)
  const MAX_WEAK_QUESTIONS = 2;
  let weakCount = 0;
  for (const [sourceId, targets] of graph.adjacency) {
    if (weakCount >= MAX_WEAK_QUESTIONS || questions.length >= topN) break;
    for (const [targetId, edgeData] of targets) {
      if (weakCount >= MAX_WEAK_QUESTIONS || questions.length >= topN) break;
      const rs = edgeData.resolutionSource;
      if (rs === "symbol" || rs === "alias_path") {
        const srcNode = graph.nodes.get(sourceId);
        const tgtNode = graph.nodes.get(targetId);
        if (!srcNode || !tgtNode) continue;
        if (NOISE_NAMES.has(srcNode.name) || NOISE_NAMES.has(tgtNode.name)) continue;
        if (isTestFile(srcNode.filePath) || isTestFile(tgtNode.filePath)) continue;
        // Only flag weak edges that cross directories (same-dir weak edges are usually fine)
        if (topLevelDir(srcNode.filePath) === topLevelDir(tgtNode.filePath)) continue;
        // Skip connections involving major hubs (expected core wiring)
        if (srcNode.degree > 15 || tgtNode.degree > 15) continue;
        questions.push({
          type: "weak_resolution",
          question: `What is the exact relationship between \`${srcNode.name}\` and \`${tgtNode.name}\`?`,
          why: `Edge resolved via ${rs} across ${topLevelDir(srcNode.filePath)} ↔ ${topLevelDir(tgtNode.filePath)} — may not reflect actual runtime behavior`,
        });
        weakCount++;
      }
    }
  }

  // Type 2: Bridge nodes (high betweenness)
  if (questions.length < topN && graph.edgeCount > 5) {
    const betweenness = approximateBetweenness(graph);
    const bridges = [...betweenness.entries()]
      .filter(([id]) => {
        const n = graph.nodes.get(id);
        return n && !isFileNode(n) && !isTestFile(n.filePath) && !NOISE_NAMES.has(n.name) && betweenness.get(id)! > 0;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    for (const [bridgeId] of bridges) {
      if (questions.length >= topN) break;
      const bridgeName = graph.nodes.get(bridgeId)?.name ?? bridgeId;
      const bridgeComm = communityResult.membership.get(bridgeId);
      const neighborComms = new Set<number>();
      const neighbors = graph.adjacency.get(bridgeId);
      if (neighbors) {
        for (const nId of neighbors.keys()) {
          const nc = communityResult.membership.get(nId);
          if (nc !== undefined && nc !== bridgeComm) neighborComms.add(nc);
        }
      }
      if (neighborComms.size > 0) {
        const commLabels = [...neighborComms].map(c => communityResult.labels.get(c) ?? `community ${c}`);
        questions.push({
          type: "bridge_node",
          question: `Why does \`${bridgeName}\` connect ${commLabels.join(" and ")}?`,
          why: `High betweenness centrality — bridges structurally distant modules`,
        });
      }
    }
  }

  // Type 3: Hub nodes with weakly-resolved edges
  if (questions.length < topN) {
    const hubs = [...graph.nodes.values()]
      .filter(n => !isFileNode(n) && !isTestFile(n.filePath) && n.degree > 0)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 5);

    for (const hub of hubs) {
      if (questions.length >= topN) break;
      const neighbors = graph.adjacency.get(hub.chunkId);
      if (!neighbors) continue;
      const weakEdges: string[] = [];
      for (const [targetId, data] of neighbors) {
        if (data.resolutionSource === "symbol" || data.resolutionSource === "alias_path") {
          weakEdges.push(graph.nodes.get(targetId)?.name ?? targetId);
        }
      }
      if (weakEdges.length >= 2) {
        questions.push({
          type: "verify_inferred",
          question: `Are the ${weakEdges.length} weakly-resolved relationships involving \`${hub.name}\` (e.g., with \`${weakEdges[0]}\` and \`${weakEdges[1]}\`) actually correct?`,
          why: `Hub node with ${weakEdges.length} edges resolved via symbol/alias — may include false positives`,
        });
      }
    }
  }

  // Type 4: Isolated/weakly-connected nodes
  if (questions.length < topN) {
    const isolated = [...graph.nodes.values()]
      .filter(n => n.degree <= 1 && !isFileNode(n) && !isTestFile(n.filePath) && n.name !== "<anonymous>")
      .slice(0, 5);

    if (isolated.length > 0) {
      const names = isolated.map(n => `\`${n.name}\``).join(", ");
      questions.push({
        type: "isolated_nodes",
        question: `What connects ${names} to the rest of the system?`,
        why: `${isolated.length} weakly-connected nodes found — possible documentation gaps or missing edges`,
      });
    }
  }

  // Type 5: Low-cohesion communities
  if (questions.length < topN) {
    for (const [cid, members] of communityResult.communities) {
      if (questions.length >= topN) break;
      if (members.length < 5) continue;
      const cohesion = communityResult.cohesion.get(cid) ?? 0;
      if (cohesion < 0.15) {
        const label = communityResult.labels.get(cid) ?? `community ${cid}`;
        questions.push({
          type: "low_cohesion",
          question: `Should "${label}" be split into smaller modules?`,
          why: `Cohesion score ${cohesion} — nodes are weakly interconnected`,
        });
      }
    }
  }

  return questions.slice(0, topN);
}

// --- Graph Diff ---

export interface GraphDiffResult {
  newNodes: Array<{ chunkId: string; name: string }>;
  removedNodes: Array<{ chunkId: string; name: string }>;
  communityChanges: Array<{ chunkId: string; name: string; oldCommunity: number; newCommunity: number }>;
  summary: string;
}

export function graphDiff(
  oldMembership: Map<string, number>,
  newMembership: Map<string, number>,
  nodeNames: Map<string, string>
): GraphDiffResult {
  const newNodes: Array<{ chunkId: string; name: string }> = [];
  const removedNodes: Array<{ chunkId: string; name: string }> = [];
  const communityChanges: Array<{ chunkId: string; name: string; oldCommunity: number; newCommunity: number }> = [];

  for (const [id, comm] of newMembership) {
    if (!oldMembership.has(id)) {
      newNodes.push({ chunkId: id, name: nodeNames.get(id) ?? id });
    } else if (oldMembership.get(id) !== comm) {
      communityChanges.push({
        chunkId: id,
        name: nodeNames.get(id) ?? id,
        oldCommunity: oldMembership.get(id)!,
        newCommunity: comm,
      });
    }
  }

  for (const [id] of oldMembership) {
    if (!newMembership.has(id)) {
      removedNodes.push({ chunkId: id, name: nodeNames.get(id) ?? id });
    }
  }

  const parts: string[] = [];
  if (newNodes.length > 0) parts.push(`${newNodes.length} new node${newNodes.length !== 1 ? "s" : ""}`);
  if (removedNodes.length > 0) parts.push(`${removedNodes.length} removed node${removedNodes.length !== 1 ? "s" : ""}`);
  if (communityChanges.length > 0) parts.push(`${communityChanges.length} community change${communityChanges.length !== 1 ? "s" : ""}`);

  return {
    newNodes,
    removedNodes,
    communityChanges,
    summary: parts.length > 0 ? parts.join(", ") : "no structural changes",
  };
}
