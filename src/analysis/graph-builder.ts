import type { MetadataStore } from "../storage/metadata-store.js";

export interface GraphNode {
  chunkId: string;
  name: string;
  filePath: string;
  kind: string;
  degree: number;
}

export interface EdgeData {
  relation: string;
  resolutionSource?: string;
  callType?: string;
}

export interface AdjacencyGraph {
  nodes: Map<string, GraphNode>;
  /** source → target → edge data (bidirectional: both directions stored) */
  adjacency: Map<string, Map<string, EdgeData>>;
  nodeCount: number;
  edgeCount: number;
}

/**
 * Build an in-memory undirected adjacency graph from the call_edges table.
 * Resolves target names to chunk IDs using name + file path matching
 * (same resolution strategy as tree-builder.ts).
 */
export function buildAdjacencyGraph(metadata: MetadataStore): AdjacencyGraph {
  const allChunks = metadata.getAllChunks();
  const nodes = new Map<string, GraphNode>();

  // Build lookup indexes for name resolution
  const chunksByName = new Map<string, typeof allChunks>();

  for (const chunk of allChunks) {
    nodes.set(chunk.id, {
      chunkId: chunk.id,
      name: chunk.name,
      filePath: chunk.filePath,
      kind: chunk.kind,
      degree: 0,
    });

    if (!chunksByName.has(chunk.name)) chunksByName.set(chunk.name, []);
    chunksByName.get(chunk.name)!.push(chunk);
  }

  const adjacency = new Map<string, Map<string, EdgeData>>();
  let edgeCount = 0;

  const resolvedEdges = metadata.getAllResolvedCallEdges();

  for (const edge of resolvedEdges) {
    const sourceId = edge.sourceChunkId;
    if (!nodes.has(sourceId)) continue;

    // Resolve target: match by name, prefer exact file path match, then same file as caller
    const candidates = chunksByName.get(edge.targetName);
    if (!candidates || candidates.length === 0) continue;

    let targetChunk = candidates[0]!;
    if (edge.targetFilePath) {
      const exactFile = candidates.find(c => c.filePath === edge.targetFilePath);
      if (exactFile) targetChunk = exactFile;
    }
    if (!targetChunk) continue;
    // Fallback: prefer same file as caller
    if (candidates.length > 1 && !edge.targetFilePath) {
      const sourceNode = nodes.get(sourceId);
      const sameFile = candidates.find(c => c.filePath === sourceNode?.filePath);
      if (sameFile) targetChunk = sameFile;
    }

    const targetId = targetChunk.id;
    if (sourceId === targetId) continue;

    const edgeData: EdgeData = {
      relation: "calls",
      resolutionSource: edge.resolutionSource ?? undefined,
      callType: edge.callType,
    };

    // Add forward direction
    if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Map());
    if (!adjacency.get(sourceId)!.has(targetId)) {
      adjacency.get(sourceId)!.set(targetId, edgeData);
      edgeCount++;
    }

    // Add reverse direction (undirected)
    if (!adjacency.has(targetId)) adjacency.set(targetId, new Map());
    if (!adjacency.get(targetId)!.has(sourceId)) {
      adjacency.get(targetId)!.set(sourceId, { ...edgeData, relation: "called_by" });
    }
  }

  // Compute degrees
  for (const [nodeId, neighbors] of adjacency) {
    const node = nodes.get(nodeId);
    if (node) node.degree = neighbors.size;
  }

  return { nodes, adjacency, nodeCount: nodes.size, edgeCount };
}
