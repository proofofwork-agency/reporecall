/**
 * Auto-capture wiki pages from MCP tool results.
 *
 * When explain_flow or build_stack_tree completes, the result
 * is automatically saved as a wiki page for future sessions.
 */

import { execFileSync } from "child_process";
import { writeManagedMemoryFile, safeMemorySlug } from "../memory/files.js";
import type { MemoryIndexer } from "../memory/indexer.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { resolveAllLinks } from "./links.js";
import { getLogger } from "../core/logger.js";

export interface AutoCaptureOptions {
  writableDir: string;
  projectRoot: string;
}

export class WikiAutoCapture {
  private writableDir: string;
  private projectRoot: string;
  private indexer: MemoryIndexer;
  private store: MemoryStore;

  constructor(
    indexer: MemoryIndexer,
    store: MemoryStore,
    opts: AutoCaptureOptions
  ) {
    this.indexer = indexer;
    this.store = store;
    this.writableDir = opts.writableDir;
    this.projectRoot = opts.projectRoot;
  }

  /**
   * Capture an explain_flow result as a wiki page.
   */
  async captureFlowResult(
    query: string,
    flowText: string,
    seedName: string,
    relatedFiles: string[],
    relatedSymbols: string[]
  ): Promise<string | null> {
    if (!flowText || flowText.length < 100) return null;

    const slug = `flow-${safeMemorySlug(seedName)}`;
    const sourceCommit = this.getHeadCommit();

    // Check if page already exists and is fresh enough
    const existing = this.store.getByName(slug);
    if (existing) {
      const existingCommit = this.extractSourceCommit(existing.content);
      if (existingCommit === sourceCommit) return null; // No code changes since last capture
    }

    const summary = `Flow trace: ${seedName} — ${query.slice(0, 100)}`;
    const content = [
      `## Flow: ${seedName}`,
      "",
      `**Query:** ${query}`,
      "",
      flowText,
    ].join("\n");

    const allLinks = resolveAllLinks([], content);

    const filePath = writeManagedMemoryFile(this.writableDir, slug, {
      name: slug,
      description: summary,
      memoryType: "wiki",
      class: "fact",
      scope: "project",
      status: "active",
      summary,
      sourceKind: "generated",
      relatedFiles: relatedFiles.slice(0, 20),
      relatedSymbols: relatedSymbols.slice(0, 20),
      confidence: 0.80,
      reason: "Auto-captured from explain_flow result",
      pageType: "flow",
      sourceLayer: "llm-enriched",
      links: allLinks,
      sourceCommit,
      content,
    });

    await this.indexer.indexFile(filePath);
    this.store.setWikiLinks(slug, allLinks);

    getLogger().info({ slug, seedName }, "Wiki page auto-captured from explain_flow");
    return slug;
  }

  /**
   * Capture a build_stack_tree result as a wiki page.
   */
  async captureTreeResult(
    query: string,
    seedName: string,
    treeText: string,
    relatedFiles: string[],
    relatedSymbols: string[]
  ): Promise<string | null> {
    if (!treeText || treeText.length < 50) return null;

    const slug = `exploration-${safeMemorySlug(seedName)}`;
    const sourceCommit = this.getHeadCommit();

    const existing = this.store.getByName(slug);
    if (existing) {
      const existingCommit = this.extractSourceCommit(existing.content);
      if (existingCommit === sourceCommit) return null;
    }

    const summary = `Call tree: ${seedName} — ${query.slice(0, 100)}`;
    const content = [
      `## Call Tree: ${seedName}`,
      "",
      `**Query:** ${query}`,
      "",
      treeText,
    ].join("\n");

    const allLinks = resolveAllLinks([], content);

    const filePath = writeManagedMemoryFile(this.writableDir, slug, {
      name: slug,
      description: summary,
      memoryType: "wiki",
      class: "fact",
      scope: "project",
      status: "active",
      summary,
      sourceKind: "generated",
      relatedFiles: relatedFiles.slice(0, 20),
      relatedSymbols: relatedSymbols.slice(0, 20),
      confidence: 0.75,
      reason: "Auto-captured from build_stack_tree result",
      pageType: "exploration",
      sourceLayer: "llm-enriched",
      links: allLinks,
      sourceCommit,
      content,
    });

    await this.indexer.indexFile(filePath);
    this.store.setWikiLinks(slug, allLinks);

    getLogger().info({ slug, seedName }, "Wiki page auto-captured from build_stack_tree");
    return slug;
  }

  private getHeadCommit(): string {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: this.projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  }

  private extractSourceCommit(content: string): string | undefined {
    const match = content.match(/sourceCommit:\s*"?([a-f0-9]+)"?/);
    return match?.[1];
  }
}
