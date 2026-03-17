import type { MetadataStore } from "../storage/metadata-store.js";

type TreeMetadata = Pick<
  MetadataStore,
  "findCallers" | "findCallees" | "findChunksByNames" | "getChunksByIds"
> &
  Partial<Pick<MetadataStore, "findCalleesForChunk">>;

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

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(?:^|\/)(test|spec|__tests__|__fixtures__|fixtures|benchmark|examples)\//.test(lower)
    || /\.(test|spec)\.[^.]+$/.test(lower);
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
    return {
      chunkId: chosen.id,
      name: chosen.name,
      filePath: chosen.filePath,
      kind: chosen.kind,
    };
  }

  function buildDirection(
    dir: "up" | "down",
    sourceName: string,
    sourceChunkId: string,
    sourceFilePath: string,
    depth: number
  ): void {
    if (depth > maxDepth) return;
    if (totalNodes >= maxNodes) return;

    if (dir === "up") {
      const callers = metadata.findCallers(
        sourceName,
        maxBranchFactor * 2,
        sourceFilePath
      );
      callers.sort((a, b) => (isTestFile(a.filePath) ? 1 : 0) - (isTestFile(b.filePath) ? 1 : 0));
      for (const caller of callers) {
        if (totalNodes >= maxNodes) break;
        if (visited.has(caller.chunkId)) continue;

        visited.add(caller.chunkId);
        totalNodes++;

        // Look up chunk info for the caller to get its kind
        const callerChunks = metadata.getChunksByIds([caller.chunkId]);
        const callerKind =
          callerChunks.length > 0 ? callerChunks[0].kind : "unknown";

        const node: TreeNode = {
          chunkId: caller.chunkId,
          name: caller.callerName,
          filePath: caller.filePath,
          kind: callerKind,
          depth,
          direction: "up",
        };
        upTree.push(node);

        edges.push({
          from: caller.chunkId,
          to: sourceChunkId,
          callType: "call",
        });

        buildDirection(
          dir,
          caller.callerName,
          caller.chunkId,
          caller.filePath,
          depth + 1
        );
      }
    } else {
      const calleeRecords = metadata.findCalleesForChunk
        ? metadata.findCalleesForChunk(sourceChunkId, maxBranchFactor * 2)
        : metadata.findCallees(sourceName, maxBranchFactor * 2);

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
          depth,
          direction: "down",
        };
        downTree.push(node);

        edges.push({
          from: sourceChunkId,
          to: r.chunkId,
          callType: r.callType,
        });

        buildDirection(dir, r.name, r.chunkId, r.filePath, depth + 1);
      }
    }
  }

  if (direction === "up" || direction === "both") {
    buildDirection("up", seed.name, seed.chunkId, seed.filePath, 1);
  }

  if (direction === "down" || direction === "both") {
    buildDirection("down", seed.name, seed.chunkId, seed.filePath, 1);
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
