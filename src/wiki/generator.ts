/**
 * Deterministic wiki page generator.
 *
 * Reads from MetadataStore (communities, hub nodes, surprises, chunks)
 * and writes wiki pages as memory files with type=wiki. Runs during
 * index/refresh completion — no LLM needed.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, rmSync } from "fs";
import { basename } from "path";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { MemoryIndexer } from "../memory/indexer.js";
import { writeManagedMemoryFile } from "../memory/files.js";
import { resolveAllLinks } from "./links.js";
import { getLogger } from "../core/logger.js";
import { buildBusinessPages } from "./business.js";
import { slugify } from "../core/strings.js";

const WIKI_GENERATOR_VERSION = "deterministic-wiki-v3-business-presentation";
const GENERATED_WIKI_PREFIXES = /^(business-|community-|hub-|surprises-)/;

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
  businessPages: number;
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
    const generatedNames = new Set<string>();
    const result: WikiGenerateResult = {
      pagesWritten: 0,
      pagesUpdated: 0,
      communityPages: 0,
      hubPages: 0,
      businessPages: 0,
      surprisesPage: false,
    };

    // Build chunk-to-community map for community member lookup
    const chunks = this.metadata.getAllChunks();
    const chunkCommunityMap = new Map<string, string>();
    const communityChunks = new Map<string, Array<{ name: string; filePath: string; kind: string }>>();
    const chunkIdCommunityMap = new Map<string, string>();

    for (const chunk of chunks) {
      const communityId = this.metadata.getCommunityForChunk(chunk.id);
      if (communityId) {
        chunkCommunityMap.set(chunk.name, communityId);
        chunkIdCommunityMap.set(chunk.id, communityId);
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
    const hubs = this.metadata.getGodNodes(this.opts.maxHubs);
    const hubsByCommunity = new Map<string, typeof hubs>();
    for (const hub of hubs) {
      if (!hub.communityId) continue;
      if (!hubsByCommunity.has(hub.communityId)) hubsByCommunity.set(hub.communityId, []);
      hubsByCommunity.get(hub.communityId)!.push(hub);
    }

    const surprises = this.metadata.getTopSurprises(this.opts.maxSurprises);
    const surprisesByCommunity = new Map<string, typeof surprises>();
    for (const surprise of surprises) {
      const sourceCommunity = chunkIdCommunityMap.get(surprise.sourceChunkId);
      const targetCommunity = chunkIdCommunityMap.get(surprise.targetChunkId);
      for (const communityId of [sourceCommunity, targetCommunity]) {
        if (!communityId) continue;
        if (!surprisesByCommunity.has(communityId)) surprisesByCommunity.set(communityId, []);
        surprisesByCommunity.get(communityId)!.push(surprise);
      }
    }

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

      const writeResult = await this.writePage(slug, {
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
      generatedNames.add(slug);

      if (writeResult === "written") {
        result.communityPages++;
        result.pagesWritten++;
      } else if (writeResult === "updated") {
        result.pagesUpdated++;
      }
    }

    // Generate hub node pages
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

      const writeResult = await this.writePage(slug, {
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
      generatedNames.add(slug);

      if (writeResult === "written") {
        result.hubPages++;
        result.pagesWritten++;
      } else if (writeResult === "updated") {
        result.pagesUpdated++;
      }
    }

    const businessPages = buildBusinessPages(
      communities.map((community) => ({
        community,
        members: communityChunks.get(community.id) ?? [],
        hubs: hubsByCommunity.get(community.id) ?? [],
        surprises: surprisesByCommunity.get(community.id) ?? [],
      })),
      this.opts.maxCommunities
    );

    for (const businessPage of businessPages) {
      const writeResult = await this.writePage(businessPage.slug, {
        description: businessPage.description,
        pageType: "business",
        content: businessPage.content,
        summary: businessPage.summary,
        relatedFiles: businessPage.relatedFiles,
        relatedSymbols: businessPage.relatedSymbols,
        links: businessPage.links,
        sourceCommit,
        confidence: businessPage.confidence,
      });
      generatedNames.add(businessPage.slug);

      if (writeResult === "written") {
        result.businessPages++;
        result.pagesWritten++;
      } else if (writeResult === "updated") {
        result.pagesUpdated++;
      }
    }

    // Generate surprises page (single page for all cross-community bridges)
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

      const writeResult = await this.writePage(slug, {
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
      generatedNames.add(slug);

      result.surprisesPage = true;
      if (writeResult === "written") {
        result.pagesWritten++;
      } else if (writeResult === "updated") {
        result.pagesUpdated++;
      }
    }

    this.removeStaleGeneratedPages(generatedNames);

    log.info(
      { pagesWritten: result.pagesWritten, communities: result.communityPages, hubs: result.hubPages, business: result.businessPages },
      "Wiki generation complete"
    );

    return result;
  }

  private async writePage(
    slug: string,
    input: {
      description: string;
      pageType: "community" | "hub" | "module" | "flow" | "exploration" | "business";
      content: string;
      summary: string;
      relatedFiles: string[];
      relatedSymbols: string[];
      links: string[];
      sourceCommit: string;
      confidence: number;
    }
  ): Promise<"written" | "updated" | "skipped"> {
    const fingerprint = this.pageFingerprint(input);

    // Skip write only if both the source commit and generated output match.
    // This lets generator/schema changes refresh wiki pages even when the
    // indexed code commit did not change.
    const existing = this.memoryStore.getByName(slug);
    if (existing && input.sourceCommit && existing.filePath) {
      const existingCommit = this.extractSourceCommitFromFile(existing.filePath);
      const existingFingerprint = existing.fingerprint || this.extractFrontmatterValue(existing.filePath, "fingerprint");
      if (existingCommit && existingCommit === input.sourceCommit && existingFingerprint === fingerprint) return "skipped";
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
      fingerprint,
      relatedFiles: input.relatedFiles,
      relatedSymbols: input.relatedSymbols,
      confidence: input.confidence,
      reason: "Auto-generated from codebase index",
      pageType: input.pageType,
      sourceLayer: "deterministic",
      links: allLinks,
      sourceCommit: input.sourceCommit,
      generatorVersion: WIKI_GENERATOR_VERSION,
      content: input.content,
    });

    // Index the file and update wiki links — await so indexing completes before
    // removeStaleGeneratedPages() runs, avoiding a deletion-vs-indexing race.
    await this.indexer.indexFile(filePath).catch((err) =>
      getLogger().warn({ err, slug }, "Wiki page indexing failed")
    );
    this.memoryStore.setWikiLinks(slug, allLinks);

    return existing ? "updated" : "written";
  }

  private removeStaleGeneratedPages(currentNames: Set<string>): void {
    for (const memory of this.memoryStore.getByType("wiki")) {
      if (currentNames.has(memory.name)) continue;
      if (!GENERATED_WIKI_PREFIXES.test(memory.name)) continue;
      if (memory.sourceKind !== "generated") continue;

      const sourceLayer = this.extractFrontmatterValue(memory.filePath, "sourceLayer");
      const pageType = this.extractFrontmatterValue(memory.filePath, "pageType");
      const deterministic = sourceLayer === "deterministic" || (!sourceLayer && !pageType);
      if (!deterministic) continue;

      try {
        rmSync(memory.filePath, { force: true });
      } catch {
        // The DB row may outlive the markdown file after manual cleanup.
      }
      this.memoryStore.removeWikiLinks(memory.name);
      this.memoryStore.remove(memory.id);
    }
  }

  private pageFingerprint(input: {
    pageType: "community" | "hub" | "module" | "flow" | "exploration" | "business";
    content: string;
    summary: string;
    relatedFiles: string[];
    relatedSymbols: string[];
    links: string[];
  }): string {
    return createHash("sha256")
      .update(WIKI_GENERATOR_VERSION)
      .update("\0")
      .update(JSON.stringify({
        pageType: input.pageType,
        content: input.content,
        summary: input.summary,
        relatedFiles: input.relatedFiles,
        relatedSymbols: input.relatedSymbols,
        links: input.links,
      }))
      .digest("hex")
      .slice(0, 24);
  }

  private extractSourceCommitFromFile(filePath: string): string | undefined {
    return this.extractFrontmatterValue(filePath, "sourceCommit");
  }

  private extractFrontmatterValue(filePath: string, key: string): string | undefined {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const match = raw.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, "m"));
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

function uniqueValues(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
