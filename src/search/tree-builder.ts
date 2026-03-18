import type { MetadataStore } from "../storage/metadata-store.js";
import { isTestFile } from "./utils.js";

type TreeMetadata = Pick<
  MetadataStore,
  "findCallers" | "findCallees" | "findChunksByNames" | "getChunksByIds"
> &
  Partial<Pick<MetadataStore, "findCalleesForChunk" | "findImporterFiles" | "findChunksByFilePath">>;

export interface TreeOptions {
  seed: { chunkId: string; name: string; filePath: string; kind: string };
  direction?: "up" | "down" | "both";
  maxDepth?: number;
  maxBranchFactor?: number;
  maxNodes?: number;
}

export interface TreeNode {
  chunkId: string;
  name: string;
  filePath: string;
  kind: string;
  depth: number;
  direction: "up" | "down" | "seed";
}

export interface TreeEdge {
  from: string;
  to: string;
  callType: string;
}

export interface CoverageScore {
  /** Fraction of maxNodes budget used: (nodeCount - 1) / maxNodes */
  utilization: number;
  /** 0 = one direction only, 1 = balanced up/down */
  balance: number;
  /** Combined score: weighted average of utilization and balance */
  overall: number;
}

export interface StackTree {
  seed: TreeNode;
  upTree: TreeNode[];
  downTree: TreeNode[];
  edges: TreeEdge[];
  nodeCount: number;
  coverage: CoverageScore;
}

/**
 * Builds a bidirectional call tree starting from a seed chunk.
 * Walks callers (up) and/or callees (down) using the call-edge graph
 * stored in MetadataStore.
 *
 * @param metadata - MetadataStore instance for querying chunks and call edges
 * @param options  - Tree construction options (seed, direction, limits)
 * @returns A StackTree with the seed, up/down subtrees, edges, and total node count
 */
export function buildStackTree(
  metadata: TreeMetadata,
  options: TreeOptions
): StackTree {
  const {
    seed,
    direction = "both",
    maxDepth = 2,
    maxBranchFactor = 3,
    maxNodes = 24,
  } = options;

  const visited = new Set<string>([seed.chunkId]);
  const upTree: TreeNode[] = [];
  const downTree: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  let totalNodes = 1;

  function resolveCalleeChunkId(
    targetName: string,
    sourceFilePath: string,
    targetFilePath?: string
  ): { chunkId: string; name: string; filePath: string; kind: string } | null {
    const matches = metadata.findChunksByNames([targetName]);
    if (matches.length === 0) return null;

    // Resolution order: exact target_file_path match → same file as caller → first match
    if (targetFilePath) {
      const exactFile = matches.find((m) => m.filePath === targetFilePath);
      if (exactFile) {
        return {
          chunkId: exactFile.id,
          name: exactFile.name,
          filePath: exactFile.filePath,
          kind: exactFile.kind,
        };
      }
    }

    const sameFile = matches.find((m) => m.filePath === sourceFilePath);
    const chosen = sameFile ?? matches[0];
    if (!chosen) return null;
    return {
      chunkId: chosen.id,
      name: chosen.name,
      filePath: chosen.filePath,
      kind: chosen.kind,
    };
  }

  /** BFS-based upward traversal that batches getChunksByIds per level. */
  function buildUpBFS(
    startName: string,
    startChunkId: string,
    startFilePath: string
  ): void {
    // Queue entries: nodes whose callers we need to explore at the next depth
    let frontier: Array<{ name: string; chunkId: string; filePath: string }> = [
      { name: startName, chunkId: startChunkId, filePath: startFilePath },
    ];
    let currentDepth = 1;

    while (currentDepth <= maxDepth && totalNodes < maxNodes && frontier.length > 0) {
      // Collect all callers for the entire frontier at this depth
      const pendingCallers: Array<{
        caller: { chunkId: string; filePath: string; line: number; callerName: string };
        sourceChunkId: string;
      }> = [];

      for (const source of frontier) {
        const callers = metadata.findCallers(
          source.name,
          maxBranchFactor * 2,
          source.filePath
        );
        callers.sort((a, b) => (isTestFile(a.filePath) ? 1 : 0) - (isTestFile(b.filePath) ? 1 : 0));
        for (const caller of callers) {
          if (visited.has(caller.chunkId)) continue;
          pendingCallers.push({ caller, sourceChunkId: source.chunkId });
        }
      }

      if (pendingCallers.length === 0) break;

      // Batch-fetch chunk info for all callers at this level
      const callerIds = pendingCallers.map((p) => p.caller.chunkId);
      const callerChunks = metadata.getChunksByIds(callerIds);
      const kindMap = new Map(callerChunks.map((c) => [c.id, c.kind]));

      const nextFrontier: Array<{ name: string; chunkId: string; filePath: string }> = [];

      for (const { caller, sourceChunkId: srcId } of pendingCallers) {
        if (totalNodes >= maxNodes) break;
        if (visited.has(caller.chunkId)) continue;

        visited.add(caller.chunkId);
        totalNodes++;

        const callerKind = kindMap.get(caller.chunkId) ?? "unknown";

        const node: TreeNode = {
          chunkId: caller.chunkId,
          name: caller.callerName,
          filePath: caller.filePath,
          kind: callerKind,
          depth: currentDepth,
          direction: "up",
        };
        upTree.push(node);

        edges.push({
          from: caller.chunkId,
          to: srcId,
          callType: "call",
        });

        nextFrontier.push({
          name: caller.callerName,
          chunkId: caller.chunkId,
          filePath: caller.filePath,
        });
      }

      frontier = nextFrontier;
      currentDepth++;
    }
  }

  /** BFS-based downward traversal that processes callees level by level. */
  function buildDownBFS(
    startName: string,
    startChunkId: string
  ): void {
    let frontier: Array<{ name: string; chunkId: string; filePath: string }> = [
      { name: startName, chunkId: startChunkId, filePath: seed.filePath },
    ];
    let currentDepth = 1;

    while (currentDepth <= maxDepth && totalNodes < maxNodes && frontier.length > 0) {
      const nextFrontier: Array<{ name: string; chunkId: string; filePath: string }> = [];

      for (const source of frontier) {
        if (totalNodes >= maxNodes) break;

        const calleeRecords = metadata.findCalleesForChunk
          ? metadata.findCalleesForChunk(source.chunkId, maxBranchFactor * 2)
          : metadata.findCallees(source.name, maxBranchFactor * 2);

        const callees = calleeRecords.sort((a, b) => {
          const aResolved = a.targetFilePath ? 1 : 0;
          const bResolved = b.targetFilePath ? 1 : 0;
          return bResolved - aResolved;
        });

        const resolved: Array<{
          targetName: string;
          callType: string;
          chunkId: string;
          name: string;
          filePath: string;
          kind: string;
        }> = [];

        for (const callee of callees) {
          const match = resolveCalleeChunkId(
            callee.targetName,
            callee.filePath,
            callee.targetFilePath
          );
          if (match) {
            resolved.push({
              targetName: callee.targetName,
              callType: callee.callType,
              ...match,
            });
          }
        }

        resolved.sort((a, b) => (isTestFile(a.filePath) ? 1 : 0) - (isTestFile(b.filePath) ? 1 : 0));

        for (const r of resolved) {
          if (totalNodes >= maxNodes) break;
          if (visited.has(r.chunkId)) continue;

          visited.add(r.chunkId);
          totalNodes++;

          const node: TreeNode = {
            chunkId: r.chunkId,
            name: r.name,
            filePath: r.filePath,
            kind: r.kind,
            depth: currentDepth,
            direction: "down",
          };
          downTree.push(node);

          edges.push({
            from: source.chunkId,
            to: r.chunkId,
            callType: r.callType,
          });

          nextFrontier.push({
            name: r.name,
            chunkId: r.chunkId,
            filePath: r.filePath,
          });
        }
      }

      frontier = nextFrontier;
      currentDepth++;
    }
  }

  if (direction === "up" || direction === "both") {
    buildUpBFS(seed.name, seed.chunkId, seed.filePath);
  }

  if (direction === "down" || direction === "both") {
    buildDownBFS(seed.name, seed.chunkId);
  }

  // Import-level fallback: if call graph produced no edges, resolve facade/dispatch patterns
  // by finding files that import the seed's file and adding their representative chunk as
  // a depth-1 "up" node with edgeKind "import".
  if (totalNodes <= 1 && metadata.findImporterFiles && metadata.findChunksByFilePath) {
    const importerFiles = metadata
      .findImporterFiles(seed.filePath)
      .filter((f) => !isTestFile(f))
      .slice(0, 3);

    for (const importerFile of importerFiles) {
      if (totalNodes >= maxNodes) break;
      const chunks = metadata.findChunksByFilePath(importerFile);
      const rep = chunks[0];
      if (!rep) continue;
      if (visited.has(rep.id)) continue;

      visited.add(rep.id);
      totalNodes++;

      upTree.push({
        chunkId: rep.id,
        name: rep.name,
        filePath: rep.filePath,
        kind: rep.kind,
        depth: 1,
        direction: "up",
      });

      edges.push({
        from: rep.id,
        to: seed.chunkId,
        callType: "import",
      });
    }
  }

  const seedNode: TreeNode = {
    chunkId: seed.chunkId,
    name: seed.name,
    filePath: seed.filePath,
    kind: seed.kind,
    depth: 0,
    direction: "seed",
  };

  // Coverage scoring
  const utilization = maxNodes > 1 ? (totalNodes - 1) / (maxNodes - 1) : 0;
  const upCount = upTree.length;
  const downCount = downTree.length;
  const total = upCount + downCount;
  const balance = total > 0 ? 1 - Math.abs(upCount - downCount) / total : 0;
  const overall = 0.7 * utilization + 0.3 * balance;

  return {
    seed: seedNode,
    upTree,
    downTree,
    edges,
    nodeCount: totalNodes,
    coverage: {
      utilization: +utilization.toFixed(3),
      balance: +balance.toFixed(3),
      overall: +overall.toFixed(3),
    },
  };
}
