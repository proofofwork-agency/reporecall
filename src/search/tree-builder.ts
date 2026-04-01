import type { MetadataStore } from "../storage/metadata-store.js";
import { isTestFile } from "./utils.js";

type TreeMetadata = Pick<
  MetadataStore,
  "findCallers" | "findCallees" | "findChunksByNames" | "getChunksByIds"
> &
  Partial<Pick<MetadataStore, "findCalleesForChunk" | "findImporterFiles" | "findChunksByFilePath" | "findTargetById" | "getImportsForFile">>;

export interface TreeOptions {
  seed: { chunkId: string; name: string; filePath: string; kind: string; targetId?: string; targetKind?: string };
  direction?: "up" | "down" | "both";
  maxDepth?: number;
  maxBranchFactor?: number;
  maxNodes?: number;
  query?: string;
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

type TraversalProfile = "balanced" | "implementation" | "callers";

const IMPLEMENTATION_FLOW_RE =
  /\b(how\s+does|how\s+do|how\s+is|why\s+does|why\s+is|what\s+happens|work|works|working|implemented|implementation|fail|fails|failing|failure|error|broken)\b/i;
const CALLER_FLOW_RE =
  /\b(who|what)\s+calls\b|\bcalled\s+by\b|\bwhere\s+is\b.*\bused\b|\busage\b/i;

function getTraversalProfile(query?: string): TraversalProfile {
  if (!query?.trim()) return "balanced";
  if (CALLER_FLOW_RE.test(query)) return "callers";
  if (IMPLEMENTATION_FLOW_RE.test(query)) return "implementation";
  return "balanced";
}

function splitPathSegments(filePath: string): string[] {
  return filePath.toLowerCase().split("/").filter(Boolean);
}

function tokenizeFlowQuery(query?: string): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function countQueryMatches(terms: string[], ...texts: Array<string | undefined>): number {
  if (terms.length === 0) return 0;
  const haystack = texts
    .filter((text): text is string => !!text)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]/g, " ");
  let count = 0;
  for (const term of terms) {
    const prefix = term.length >= 6 ? term.slice(0, 4) : term;
    if (haystack.includes(term) || (prefix.length >= 4 && haystack.includes(prefix))) count++;
  }
  return count;
}

function isSchemaOrDocNoise(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(?:^|\/)(migrations?|fixtures?|examples?|docs?|reports?)\//.test(lower)
    || /\.(sql|md|mdx|txt)$/i.test(lower);
}

function commonPathPrefixLength(left: string, right: string): number {
  const leftParts = splitPathSegments(left);
  const rightParts = splitPathSegments(right);
  let count = 0;
  while (count < leftParts.length && count < rightParts.length && leftParts[count] === rightParts[count]) {
    count++;
  }
  return count;
}

function scoreCallerCandidate(
  seedFilePath: string,
  caller: { filePath: string; callerName: string; callerKind?: string }
): number {
  let score = 0;
  if (!isTestFile(caller.filePath)) score += 100;
  score += commonPathPrefixLength(seedFilePath, caller.filePath) * 10;
  if (caller.filePath === seedFilePath) score += 20;
  if (caller.callerKind && /function|method|class/.test(caller.callerKind)) score += 4;
  if (/describe|it|test/.test(caller.callerName.toLowerCase())) score -= 50;
  return score;
}

function shouldKeepImplementationCaller(
  seedFilePath: string,
  callerFilePath: string,
  callerName: string,
  queryTerms: string[],
  seedTargetKind?: string
): boolean {
  if (callerFilePath === seedFilePath) return true;
  if (isTestFile(callerFilePath)) return false;
  if (isSchemaOrDocNoise(callerFilePath)) return false;

  const affinity = commonPathPrefixLength(seedFilePath, callerFilePath);
  const queryMatches = countQueryMatches(queryTerms, callerFilePath, callerName);
  const callerText = `${callerFilePath} ${callerName}`.toLowerCase();
  const authFocused = queryTerms.some((term) => /^auth|token|session|login|signin|credential|callback|redirect|protect/.test(term));
  const generationFocused = queryTerms.some((term) => /^image|generate|generation|render|shot/.test(term));

  if (queryMatches >= 2) return true;
  if ((seedTargetKind === "endpoint" || seedTargetKind === "file_module") && affinity >= 2 && queryMatches >= 1) {
    return true;
  }
  if (authFocused && affinity >= 2 && /(auth|callback|protected|session|login|signin|redirect)/.test(callerText)) {
    return true;
  }
  if (generationFocused && affinity >= 2 && /(generate|generation|render|image|shot)/.test(callerText)) {
    return true;
  }
  return false;
}

function scoreSameFileSibling(
  seedKind: string,
  chunk: { filePath: string; name: string; kind: string }
): number {
  let score = 0;
  if (!isTestFile(chunk.filePath)) score += 100;
  if (seedKind === "class_declaration" && /method_definition|function_declaration/.test(chunk.kind)) score += 20;
  if (/constructor|describe|it|test/.test(chunk.name.toLowerCase())) score -= 25;
  return score;
}

function shouldKeepImplementationNeighbor(
  seedFilePath: string,
  candidateFilePath: string,
  candidateName: string,
  queryTerms: string[],
  seedTargetKind?: string,
  explicitResolution: boolean = false
): boolean {
  if (candidateFilePath === seedFilePath) return true;
  if (isTestFile(candidateFilePath)) return false;
  if (isSchemaOrDocNoise(candidateFilePath)) return false;

  const affinity = commonPathPrefixLength(seedFilePath, candidateFilePath);
  const queryMatches = countQueryMatches(queryTerms, candidateFilePath, candidateName);
  const sharedFile = /(?:^|\/)_shared\//.test(candidateFilePath);
  const authFocused = queryTerms.some((term) => /^auth|token|session|login|signin|credential|request|authenticate/.test(term));

  if (affinity >= 3) return true;
  if ((seedTargetKind === "endpoint" || seedTargetKind === "file_module") && sharedFile && queryMatches === 0) {
    return false;
  }
  if (authFocused && /(?:cors|rate[-_]?limit|logger)/i.test(candidateFilePath)) {
    return false;
  }
  if (explicitResolution && affinity >= 1) return true;
  if (affinity >= 2 && queryMatches >= 1) return true;
  if (queryMatches >= 2) return true;
  if ((seedTargetKind === "endpoint" || seedTargetKind === "file_module") && sharedFile) {
    return affinity >= 2 && queryMatches >= 1;
  }
  return false;
}

function scoreImportedNeighbor(
  seedFilePath: string,
  resolvedPath: string,
  importedName: string,
  queryTerms: string[]
): number {
  let score = 0;
  score += commonPathPrefixLength(seedFilePath, resolvedPath) * 10;
  score += countQueryMatches(queryTerms, resolvedPath, importedName) * 25;
  if (/(?:^|\/)_shared\//.test(resolvedPath)) score += 5;
  if (queryTerms.some((term) => /^auth|token|session|login|signin|credential|request|authenticate/.test(term))) {
    if (/auth/i.test(`${resolvedPath} ${importedName}`)) score += 25;
    if (/(?:cors|rate[-_]?limit|logger)/i.test(`${resolvedPath} ${importedName}`)) score -= 18;
  }
  if (isSchemaOrDocNoise(resolvedPath)) score -= 100;
  return score;
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
    query,
  } = options;
  const traversalProfile = getTraversalProfile(query);
  const queryTerms = tokenizeFlowQuery(query);
  const upDepthLimit = traversalProfile === "implementation" ? Math.min(1, maxDepth) : maxDepth;
  const downDepthLimit = traversalProfile === "callers" ? Math.min(1, maxDepth) : maxDepth;
  const upBranchLimit = traversalProfile === "implementation" ? Math.max(2, maxBranchFactor - 1) : maxBranchFactor;
  const downBranchLimit = traversalProfile === "callers" ? Math.max(2, maxBranchFactor - 1) : maxBranchFactor;

  const visited = new Set<string>([seed.chunkId]);
  const upTree: TreeNode[] = [];
  const downTree: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  let totalNodes = 1;

  function resolveCalleeChunkId(
    targetName: string,
    sourceFilePath: string,
    targetFilePath?: string,
    targetId?: string
  ): { chunkId: string; name: string; filePath: string; kind: string } | null {
    if (targetId && metadata.findTargetById) {
      const target = metadata.findTargetById(targetId);
      if (target?.ownerChunkId) {
        const chunk = metadata.getChunksByIds([target.ownerChunkId])[0];
        if (chunk) {
          return {
            chunkId: chunk.id,
            name: chunk.name,
            filePath: chunk.filePath,
            kind: chunk.kind,
          };
        }
      }
    }
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

    while (currentDepth <= upDepthLimit && totalNodes < maxNodes && frontier.length > 0) {
      // Collect all callers for the entire frontier at this depth
      const pendingCallers: Array<{
        caller: { chunkId: string; filePath: string; line: number; callerName: string };
        sourceChunkId: string;
      }> = [];

      for (const source of frontier) {
        // Pass targetId only for non-symbol targets (endpoint, file_module).
        // Symbol targets use IDs like "symbol:<chunkId>" which are never stored
        // in call_edges.target_id — those edges are resolved via import path,
        // not alias lookup — so passing a symbol targetId would match nothing.
        const edgeTargetId =
          source.chunkId === startChunkId
          && seed.targetId
          && seed.targetKind !== "symbol"
            ? seed.targetId
            : undefined;
        const callers = metadata.findCallers(
          source.name,
          upBranchLimit * 3,
          source.filePath,
          edgeTargetId
        );
        const realCallers = callers.filter((caller) => !isTestFile(caller.filePath));
        const callerPool =
          traversalProfile === "implementation" && realCallers.length === 0
            ? []
            : (realCallers.length > 0 ? realCallers : callers);
        const filteredCallerPool =
          traversalProfile === "implementation"
            ? callerPool.filter((caller) =>
                shouldKeepImplementationCaller(
                  seed.filePath,
                  caller.filePath,
                  caller.callerName,
                  queryTerms,
                  seed.targetKind
                )
              )
            : callerPool;
        const uniqueCallers = new Map<string, typeof callerPool[number]>();
        for (const caller of filteredCallerPool) {
          const existing = uniqueCallers.get(caller.filePath);
          if (!existing || scoreCallerCandidate(seed.filePath, caller) > scoreCallerCandidate(seed.filePath, existing)) {
            uniqueCallers.set(caller.filePath, caller);
          }
        }
        const rankedCallers = Array.from(uniqueCallers.values())
          .sort((a, b) => scoreCallerCandidate(seed.filePath, b) - scoreCallerCandidate(seed.filePath, a))
          .slice(0, upBranchLimit);

        for (const caller of rankedCallers) {
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

    while (currentDepth <= downDepthLimit && totalNodes < maxNodes && frontier.length > 0) {
      const nextFrontier: Array<{ name: string; chunkId: string; filePath: string }> = [];

      for (const source of frontier) {
        if (totalNodes >= maxNodes) break;

        const calleeRecords = metadata.findCalleesForChunk
          ? metadata.findCalleesForChunk(source.chunkId, maxBranchFactor * 2)
          : metadata.findCallees(source.name, downBranchLimit * 2);

        const callees = calleeRecords.sort((a, b) => {
          const aResolved = a.targetId || a.targetFilePath ? 1 : 0;
          const bResolved = b.targetId || b.targetFilePath ? 1 : 0;
          return bResolved - aResolved;
        });

        const resolved: Array<{
          targetName: string;
          callType: string;
          chunkId: string;
          name: string;
          filePath: string;
          kind: string;
          explicitResolution: boolean;
        }> = [];

        for (const callee of callees.slice(0, downBranchLimit * 2)) {
          const match = resolveCalleeChunkId(
            callee.targetName,
            callee.filePath,
            callee.targetFilePath,
            callee.targetId
          );
          if (match) {
            resolved.push({
              targetName: callee.targetName,
              callType: callee.callType,
              explicitResolution: !!callee.targetId || !!callee.targetFilePath,
              ...match,
            });
          }
        }
        const realResolved = resolved.filter((node) => !isTestFile(node.filePath));
        const resolvedPool = realResolved.length > 0 ? realResolved : resolved;
        const filteredResolvedPool =
          traversalProfile === "implementation"
            ? resolvedPool.filter((node) =>
                shouldKeepImplementationNeighbor(
                  seed.filePath,
                  node.filePath,
                  `${node.name} ${node.targetName}`,
                  queryTerms,
                  seed.targetKind,
                  node.explicitResolution
                )
              )
            : resolvedPool;
        const candidatePool =
          traversalProfile === "implementation"
            ? filteredResolvedPool
            : resolvedPool;
        const uniqueResolved = new Map<string, typeof resolvedPool[number]>();
        for (const node of candidatePool) {
          const existing = uniqueResolved.get(node.filePath);
          if (!existing) {
            uniqueResolved.set(node.filePath, node);
            continue;
          }
          const existingSameFile = existing.filePath === seed.filePath ? 1 : 0;
          const currentSameFile = node.filePath === seed.filePath ? 1 : 0;
          if (currentSameFile > existingSameFile) {
            uniqueResolved.set(node.filePath, node);
          }
        }
        const rankedResolved = Array.from(uniqueResolved.values())
          .sort((a, b) => {
            const aSameFile = a.filePath === seed.filePath ? 1 : 0;
            const bSameFile = b.filePath === seed.filePath ? 1 : 0;
            const aAffinity = commonPathPrefixLength(seed.filePath, a.filePath);
            const bAffinity = commonPathPrefixLength(seed.filePath, b.filePath);
            return (bSameFile - aSameFile) || (bAffinity - aAffinity);
          })
          .slice(0, downBranchLimit);

        for (const r of rankedResolved) {
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

  function addSameFileSeedSiblings(): void {
    if (!metadata.findChunksByFilePath) return;
    const shouldExpandSameFile =
      seed.targetKind === "endpoint"
      || seed.targetKind === "file_module"
      || (traversalProfile === "implementation" && seed.kind === "class_declaration");
    if (!shouldExpandSameFile) return;
    const fileChunks = metadata.findChunksByFilePath(seed.filePath)
      .filter((chunk) => chunk.id !== seed.chunkId && !isTestFile(chunk.filePath))
      .sort((a, b) => scoreSameFileSibling(seed.kind, b) - scoreSameFileSibling(seed.kind, a))
      .slice(0, traversalProfile === "implementation" ? 3 : maxBranchFactor);
    for (const chunk of fileChunks) {
      if (totalNodes >= maxNodes) break;
      if (visited.has(chunk.id)) continue;
      visited.add(chunk.id);
      totalNodes++;
      downTree.push({
        chunkId: chunk.id,
        name: chunk.name,
        filePath: chunk.filePath,
        kind: chunk.kind,
        depth: 1,
        direction: "down",
      });
      edges.push({
        from: seed.chunkId,
        to: chunk.id,
        callType: "module",
      });
    }
  }

  function addMatchingImportedNeighbors(): void {
    if (!metadata.getImportsForFile || !metadata.findChunksByFilePath) return;
    if (traversalProfile !== "implementation") return;

    const imports = metadata.getImportsForFile(seed.filePath)
      .filter((record) => !!record.resolvedPath && !isTestFile(record.resolvedPath!))
      .filter((record) => !isSchemaOrDocNoise(record.resolvedPath!));
    if (imports.length === 0) return;

    const rankedImports = imports
      .map((record) => ({
        record,
        score: scoreImportedNeighbor(
          seed.filePath,
          record.resolvedPath!,
          record.importedName,
          queryTerms
        ),
      }))
      .filter((item) => item.score >= 25)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const item of rankedImports) {
      if (totalNodes >= maxNodes) break;
      const resolvedPath = item.record.resolvedPath!;
      const chunks = metadata.findChunksByFilePath(resolvedPath);
      const rep = chunks.find((chunk) => chunk.name === item.record.importedName) ?? chunks[0];
      if (!rep || visited.has(rep.id)) continue;

      visited.add(rep.id);
      totalNodes++;
      downTree.push({
        chunkId: rep.id,
        name: rep.name,
        filePath: rep.filePath,
        kind: rep.kind,
        depth: 1,
        direction: "down",
      });
      edges.push({
        from: seed.chunkId,
        to: rep.id,
        callType: "import",
      });
    }
  }

  if (direction === "up" || direction === "both") {
    buildUpBFS(seed.name, seed.chunkId, seed.filePath);
  }

  addSameFileSeedSiblings();
  addMatchingImportedNeighbors();

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
