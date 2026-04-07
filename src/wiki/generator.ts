/**
 * Deterministic wiki page generator.
 *
 * Reads from MetadataStore (communities, hub nodes, surprises, chunks)
 * and writes wiki pages as memory files with type=wiki. Runs during
 * index_codebase — no LLM needed.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { basename } from "path";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { MemoryIndexer } from "../memory/indexer.js";
import { writeManagedMemoryFile } from "../memory/files.js";
import { resolveAllLinks } from "./links.js";
import { getLogger } from "../core/logger.js";

export interface WikiGeneratorOptions {
  /** Directory to write wiki markdown files. */
  writableDir: string;
  /** Project root for git operations. */
  projectRoot: string;
  /** Max communities to generate pages for. Default 10. */
  maxCommunities?: number;
  /** Max hub nodes to generate pages for. Default 10. */
  maxHubs?: number;
  /** Max surprises to include. Default 10. */
  maxSurprises?: number;
}

export interface WikiGenerateResult {
  pagesWritten: number;
  pagesUpdated: number;
  communityPages: number;
  hubPages: number;
  surprisesPage: boolean;
}

export class WikiGenerator {
  private metadata: MetadataStore;
  private memoryStore: MemoryStore;
  private indexer: MemoryIndexer;
  private opts: Required<WikiGeneratorOptions>;

  constructor(
    metadata: MetadataStore,
    memoryStore: MemoryStore,
    indexer: MemoryIndexer,
    opts: WikiGeneratorOptions
  ) {
    this.metadata = metadata;
    this.memoryStore = memoryStore;
    this.indexer = indexer;
    this.opts = {
      maxCommunities: 10,
      maxHubs: 10,
      maxSurprises: 10,
      ...opts,
    };
  }

  async generateFromIndex(): Promise<WikiGenerateResult> {
    const log = getLogger();
    const sourceCommit = this.getHeadCommit();
    const result: WikiGenerateResult = {
      pagesWritten: 0,
      pagesUpdated: 0,
      communityPages: 0,
      hubPages: 0,
      surprisesPage: false,
    };

    // Build chunk-to-community map for community member lookup
    const chunks = this.metadata.getChunksLightweight();
    const chunkCommunityMap = new Map<string, string>();
    const communityChunks = new Map<string, Array<{ name: string; filePath: string; kind: string }>>();

    for (const chunk of chunks) {
      const communityId = this.metadata.getCommunityForChunk(chunk.name);
      if (communityId) {
        chunkCommunityMap.set(chunk.name, communityId);
        if (!communityChunks.has(communityId)) communityChunks.set(communityId, []);
        communityChunks.get(communityId)!.push({
          name: chunk.name,
          filePath: chunk.filePath,
          kind: chunk.kind,
        });
      }
    }

    // Generate community pages
    const communities = this.metadata.getAllCommunities(this.opts.maxCommunities);
    for (const community of communities) {
      if (!community.label) continue;
      const members = communityChunks.get(community.id) ?? [];
      if (members.length === 0) continue;

      const slug = `community-${slugify(community.label)}`;
      const files = uniqueValues(members.map((m) => m.filePath));
      const symbols = uniqueValues(members.map((m) => m.name)).slice(0, 20);

      const memberLines = members
        .slice(0, 30)
        .map((m) => `- \`${m.name}\` (${m.kind}) — \`${m.filePath}\``)
        .join("\n");

      const content = [
        `## Community: ${community.label}`,
        "",
        `**Nodes:** ${community.nodeCount} | **Cohesion:** ${community.cohesion.toFixed(2)}`,
        "",
        "### Key Members",
        memberLines,
        members.length > 30 ? `\n_...and ${members.length - 30} more_` : "",
      ].join("\n");

      const writeResult = this.writePage(slug, {
        description: `Code community: ${community.label} (${community.nodeCount} nodes, cohesion ${community.cohesion.toFixed(2)})`,
        pageType: "community",
        content,
        summary: `${community.label} — ${community.nodeCount} nodes, cohesion ${community.cohesion.toFixed(2)}`,
        relatedFiles: files.slice(0, 20),
        relatedSymbols: symbols,
        links: [],
        sourceCommit,
        confidence: 0.95,
      });

      if (writeResult === "written") {
        result.communityPages++;
        result.pagesWritten++;
      } else {
        result.pagesUpdated++;
      }
    }

    // Generate hub node pages
    const hubs = this.metadata.getGodNodes(this.opts.maxHubs);
    for (const hub of hubs) {
      const slug = `hub-${slugify(hub.name)}`;

      // Find which community this hub belongs to
      const communityId = hub.communityId;
      const communityInfo = communityId ? this.metadata.getCommunityInfo(communityId) : undefined;
      const communityLink = communityInfo?.label ? `community-${slugify(communityInfo.label)}` : null;

      const content = [
        `## Hub Node: ${hub.name}`,
        "",
        `**Degree:** ${hub.degree} connections | **File:** \`${hub.filePath}\``,
        communityInfo ? `**Community:** [[${communityLink}]] (${communityInfo.label})` : "",
        "",
        "This is one of the most connected symbols in the codebase.",
      ].filter(Boolean).join("\n");

      const links = communityLink ? [communityLink] : [];

      const writeResult = this.writePage(slug, {
        description: `Hub node: ${hub.name} (${hub.degree} edges) in ${hub.filePath}`,
        pageType: "hub",
        content,
        summary: `${hub.name} — ${hub.degree} connections, hub in ${basename(hub.filePath)}`,
        relatedFiles: [hub.filePath],
        relatedSymbols: [hub.name],
        links,
        sourceCommit,
        confidence: 0.95,
      });

      if (writeResult === "written") {
        result.hubPages++;
        result.pagesWritten++;
      } else {
        result.pagesUpdated++;
      }
    }

    // Generate surprises page (single page for all cross-community bridges)
    const surprises = this.metadata.getTopSurprises(this.opts.maxSurprises);
    if (surprises.length > 0) {
      const slug = "surprises-cross-module";

      const surpriseLines = surprises.map((s) => {
        const reasons = s.reasons?.length ? ` — ${s.reasons.join(", ")}` : "";
        return `- \`${s.sourceChunkId}\` → \`${s.targetChunkId}\` (score: ${s.score.toFixed(2)})${reasons}`;
      }).join("\n");

      const allFiles = new Set<string>();
      const allSymbols = new Set<string>();
      for (const s of surprises) {
        allSymbols.add(s.sourceChunkId);
        allSymbols.add(s.targetChunkId);
        const srcChunk = this.metadata.getChunk(s.sourceChunkId);
        const tgtChunk = this.metadata.getChunk(s.targetChunkId);
        if (srcChunk?.filePath) allFiles.add(srcChunk.filePath);
        if (tgtChunk?.filePath) allFiles.add(tgtChunk.filePath);
      }

      const content = [
        "## Surprising Cross-Module Connections",
        "",
        `${surprises.length} unexpected connections that bridge distant parts of the codebase:`,
        "",
        surpriseLines,
      ].join("\n");

      const writeResult = this.writePage(slug, {
        description: `${surprises.length} surprising cross-module connections in the codebase`,
        pageType: "module",
        content,
        summary: `${surprises.length} cross-module bridges — unexpected connections between distant subsystems`,
        relatedFiles: Array.from(allFiles).slice(0, 20),
        relatedSymbols: Array.from(allSymbols).slice(0, 20),
        links: [],
        sourceCommit,
        confidence: 0.90,
      });

      result.surprisesPage = true;
      if (writeResult === "written") {
        result.pagesWritten++;
      }
    }

    log.info(
      { pagesWritten: result.pagesWritten, communities: result.communityPages, hubs: result.hubPages },
      "Wiki generation complete"
    );

    return result;
  }

  private writePage(
    slug: string,
    input: {
      description: string;
      pageType: "community" | "hub" | "module" | "flow" | "exploration";
      content: string;
      summary: string;
      relatedFiles: string[];
      relatedSymbols: string[];
      links: string[];
      sourceCommit: string;
      confidence: number;
    }
  ): "written" | "skipped" {
    // Skip write if page exists and sourceCommit is unchanged.
    // sourceCommit lives in frontmatter (stripped from DB content), so read from disk.
    const existing = this.memoryStore.getByName(slug);
    if (existing && input.sourceCommit && existing.filePath) {
      const existingCommit = this.extractSourceCommitFromFile(existing.filePath);
      if (existingCommit && existingCommit === input.sourceCommit) return "skipped";
    }

    const allLinks = resolveAllLinks(input.links, input.content);

    const filePath = writeManagedMemoryFile(this.opts.writableDir, slug, {
      name: slug,
      description: input.description,
      memoryType: "wiki",
      class: "fact",
      scope: "project",
      status: "active",
      summary: input.summary,
      sourceKind: "generated",
      relatedFiles: input.relatedFiles,
      relatedSymbols: input.relatedSymbols,
      confidence: input.confidence,
      reason: "Auto-generated from codebase index",
      pageType: input.pageType,
      sourceLayer: "deterministic",
      links: allLinks,
      sourceCommit: input.sourceCommit,
      content: input.content,
    });

    // Index the file and update wiki links
    this.indexer.indexFile(filePath).catch((err) =>
      getLogger().warn({ err, slug }, "Wiki page indexing failed")
    );
    this.memoryStore.setWikiLinks(slug, allLinks);

    return "written";
  }

  private extractSourceCommitFromFile(filePath: string): string | undefined {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const match = raw.match(/sourceCommit:\s*"?([a-f0-9]+)"?/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private getHeadCommit(): string {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: this.opts.projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  }
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function uniqueValues(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
