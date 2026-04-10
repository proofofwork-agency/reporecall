/**
 * Extracts dashboard data from MetadataStore and MemoryStore
 * for the Reporecall Lens architecture dashboard.
 */

import { basename } from "path";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { buildAdjacencyGraph } from "../analysis/graph-builder.js";
import type {
  DashboardData,
  DashboardMeta,
  CommunityViz,
  HubViz,
  SurpriseViz,
  QuestionViz,
  WikiPageViz,
  MemberViz,
  CrossEdgeViz,
  CallerCalleeViz,
} from "./types.js";

const COMMUNITY_COLORS = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
];

interface ExtractOptions {
  maxCommunities?: number;
  maxHubs?: number;
  maxSurprises?: number;
}

export function extractDashboardData(
  metadata: MetadataStore,
  memoryStore: MemoryStore | null,
  opts: ExtractOptions = {}
): DashboardData {
  const maxCommunities = opts.maxCommunities ?? 20;
  const maxHubs = opts.maxHubs ?? 15;
  const maxSurprises = opts.maxSurprises ?? 20;

  // --- Build adjacency graph for degree/cross-edge computation ---
  const graph = buildAdjacencyGraph(metadata);

  // --- Communities ---
  const rawCommunities = metadata.getAllCommunities(maxCommunities);
  const allChunks = metadata.getAllChunks();

  // Build chunk→community and community→chunks maps (use chunk.id for DB lookup)
  const chunkCommunityMap = new Map<string, string>();
  const communityChunks = new Map<string, Array<{ name: string; filePath: string; kind: string }>>();
  for (const chunk of allChunks) {
    const cid = metadata.getCommunityForChunk(chunk.id);
    if (cid) {
      chunkCommunityMap.set(chunk.name, cid);
      if (!communityChunks.has(cid)) communityChunks.set(cid, []);
      communityChunks.get(cid)!.push(chunk);
    }
  }

  // Assign colors to communities
  const communityColorMap = new Map<string, string>();
  rawCommunities.forEach((c, i) => {
    communityColorMap.set(c.id, COMMUNITY_COLORS[i % COMMUNITY_COLORS.length]!);
  });

  // Build chord matrix (community×community cross-edge counts)
  const communityIds = rawCommunities.map((c) => c.id);
  const communityIdxMap = new Map(communityIds.map((id, i) => [id, i]));
  const n = communityIds.length;
  const chordMatrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0) as number[]);

  // Count cross-community edges from adjacency graph
  for (const [sourceId, neighbors] of graph.adjacency) {
    const sourceNode = graph.nodes.get(sourceId);
    if (!sourceNode) continue;
    const srcCommunity = chunkCommunityMap.get(sourceNode.name);
    if (!srcCommunity) continue;
    const srcIdx = communityIdxMap.get(srcCommunity);
    if (srcIdx === undefined) continue;

    for (const [targetId, edge] of neighbors) {
      if (edge.relation !== "calls") continue; // only count forward direction
      const targetNode = graph.nodes.get(targetId);
      if (!targetNode) continue;
      const tgtCommunity = chunkCommunityMap.get(targetNode.name);
      if (!tgtCommunity || tgtCommunity === srcCommunity) continue;
      const tgtIdx = communityIdxMap.get(tgtCommunity);
      if (tgtIdx === undefined) continue;
      chordMatrix[srcIdx]![tgtIdx]!++;
    }
  }

  // Build community viz objects
  const communities: CommunityViz[] = rawCommunities.map((c, i) => {
    const members = communityChunks.get(c.id) ?? [];
    const memberViz: MemberViz[] = members
      .map((m) => ({
        name: m.name,
        kind: m.kind,
        filePath: m.filePath,
        degree: graph.nodes.get(
          // Find the graph node by name match
          Array.from(graph.nodes.values()).find((gn) => gn.name === m.name && gn.filePath === m.filePath)?.chunkId ?? ""
        )?.degree ?? 0,
      }))
      .sort((a, b) => b.degree - a.degree);

    // Cross-community edges for this community
    const crossEdges: CrossEdgeViz[] = [];
    const row = chordMatrix[i]!;
    for (let j = 0; j < n; j++) {
      const count = row[j]! + (chordMatrix[j]?.[i] ?? 0);
      if (count > 0 && j !== i) {
        crossEdges.push({
          targetCommunityId: communityIds[j]!,
          targetLabel: rawCommunities[j]?.label ?? `c_${j}`,
          count,
        });
      }
    }
    crossEdges.sort((a, b) => b.count - a.count);

    // Check if there's a wiki page for this community
    let wikiSlug: string | null = null;
    if (c.label) {
      const slug = `community-${slugify(c.label)}`;
      if (memoryStore) {
        const existing = memoryStore.getByName(slug);
        if (existing) wikiSlug = slug;
      }
    }

    return {
      id: c.id,
      label: c.label ?? `Community ${c.id}`,
      nodeCount: c.nodeCount,
      cohesion: c.cohesion,
      color: communityColorMap.get(c.id) ?? "#888",
      members: memberViz,
      crossEdges,
      wikiSlug,
    };
  });

  // --- Hub nodes ---
  const rawHubs = metadata.getGodNodes(maxHubs);
  const hubs: HubViz[] = rawHubs.map((h) => {
    const callerRows = metadata.findCallers(h.name, 15);
    const calleeRows = metadata.findCallees(h.name, 15);

    const callers: CallerCalleeViz[] = callerRows.map((c) => ({
      name: c.callerName,
      filePath: c.filePath,
      callType: "call",
    }));

    const callees: CallerCalleeViz[] = calleeRows.map((c) => ({
      name: c.targetName,
      filePath: c.filePath,
      callType: c.callType,
    }));

    const communityLabel = h.communityId
      ? rawCommunities.find((c) => c.id === h.communityId)?.label ?? null
      : null;

    // Find wiki pages that mention this hub
    const wikiMentions: string[] = [];
    if (memoryStore) {
      const wikiPages = memoryStore.getByType("wiki");
      for (const page of wikiPages) {
        if (page.relatedSymbols?.includes(h.name)) {
          wikiMentions.push(page.name);
        }
      }
    }

    return {
      name: h.name,
      degree: h.degree,
      filePath: h.filePath,
      communityId: h.communityId,
      communityLabel,
      communityColor: h.communityId ? communityColorMap.get(h.communityId) ?? "#888" : "#888",
      callers,
      callees,
      wikiMentions,
    };
  });

  // --- Surprises ---
  const rawSurprises = metadata.getTopSurprises(maxSurprises);
  const surprises: SurpriseViz[] = rawSurprises.map((s) => {
    // Resolve chunk names and files
    const srcNode = Array.from(graph.nodes.values()).find((n) => n.chunkId === s.sourceChunkId);
    const tgtNode = Array.from(graph.nodes.values()).find((n) => n.chunkId === s.targetChunkId);

    return {
      sourceName: srcNode?.name ?? s.sourceChunkId,
      sourceFile: srcNode?.filePath ?? "",
      targetName: tgtNode?.name ?? s.targetChunkId,
      targetFile: tgtNode?.filePath ?? "",
      score: s.score,
      reasons: s.reasons ?? [],
      sourceCommunity: srcNode ? chunkCommunityMap.get(srcNode.name) ?? null : null,
      targetCommunity: tgtNode ? chunkCommunityMap.get(tgtNode.name) ?? null : null,
    };
  });

  // --- Questions ---
  const rawQuestions = metadata.getSuggestedQuestions(10);
  const questions: QuestionViz[] = rawQuestions
    .filter((q) => q.question)
    .map((q) => ({
      type: q.type,
      question: q.question!,
      why: q.why,
    }));

  // --- Wiki pages ---
  const wikiPages: WikiPageViz[] = [];
  if (memoryStore) {
    const rawPages = memoryStore.getByType("wiki");
    for (const page of rawPages) {
      const links = memoryStore.getWikiLinks(page.name);
      const backlinks = memoryStore.getWikiBacklinks(page.name);

      // Extract pageType from content or name pattern
      let pageType = "unknown";
      if (page.name.startsWith("community-")) pageType = "community";
      else if (page.name.startsWith("hub-")) pageType = "hub";
      else if (page.name.startsWith("surprises-")) pageType = "module";
      else if (page.name.startsWith("flow-")) pageType = "flow";
      else if (page.name.startsWith("exploration-")) pageType = "exploration";

      wikiPages.push({
        name: page.name,
        pageType,
        description: page.description,
        summary: page.summary ?? "",
        content: page.content,
        links,
        backlinks,
        relatedSymbols: page.relatedSymbols ?? [],
        relatedFiles: page.relatedFiles ?? [],
        confidence: page.confidence ?? 0,
        sourceCommit: "", // extracted from frontmatter on disk, not stored in DB
      });
    }
  }

  // --- Meta ---
  const stats = metadata.getStats();
  const meta: DashboardMeta = {
    projectName: basename(process.cwd()),
    generatedAt: new Date().toISOString(),
    totalSymbols: stats.totalChunks,
    totalFiles: stats.totalFiles,
    totalEdges: graph.edgeCount,
    communityCount: rawCommunities.length,
    wikiPageCount: wikiPages.length,
    hubCount: rawHubs.length,
    surpriseCount: rawSurprises.length,
  };

  return {
    meta,
    communities,
    hubs,
    surprises,
    questions,
    wikiPages,
    chordMatrix,
    chordLabels: rawCommunities.map((c) => c.label ?? `c_${c.id}`),
    chordColors: rawCommunities.map((c) => communityColorMap.get(c.id) ?? "#888"),
  };
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
