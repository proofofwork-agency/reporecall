/**
 * Public API for the Reporecall Lens architecture dashboard.
 */

import { resolve } from "path";
import { writeFileSync } from "fs";
import { detectProjectRoot } from "../core/project.js";
import { loadConfig } from "../core/config.js";
import { MetadataStore } from "../storage/metadata-store.js";
import { MemoryStore } from "../storage/memory-store.js";
import { WikiGenerator } from "../wiki/generator.js";
import { createMemoryIndexer } from "../memory/indexer.js";
import { extractDashboardData } from "./data-extractor.js";
import { generateHTML } from "./html-template.js";
import type { LensOptions, DashboardData } from "./types.js";

export type { DashboardData, LensOptions };

export async function generateVisualization(opts: LensOptions): Promise<{
  outputPath: string;
  data: DashboardData;
}> {
  const projectRoot = opts.projectRoot || detectProjectRoot(process.cwd());
  const config = loadConfig(projectRoot);

  const metadata = new MetadataStore(config.dataDir);
  let memoryStore: MemoryStore | null = null;
  try {
    memoryStore = new MemoryStore(config.dataDir);
  } catch {
    // Memory store may not exist if wiki/memory features aren't used
  }

  try {
    // Generate wiki pages from existing topology data before extracting dashboard
    if (memoryStore) {
      try {
        const indexer = createMemoryIndexer(memoryStore, projectRoot);
        const writableDir = resolve(config.dataDir, "reporecall-memories");
        const wikiGen = new WikiGenerator(metadata, memoryStore, indexer, {
          writableDir,
          projectRoot,
          maxCommunities: opts.maxCommunities ?? 20,
          maxHubs: opts.maxHubs ?? 15,
          maxSurprises: opts.maxSurprises ?? 20,
        });
        const wikiResult = await wikiGen.generateFromIndex();
        if (wikiResult.pagesWritten > 0) {
          console.log(
            `  Wiki: ${wikiResult.pagesWritten} pages written ` +
            `(${wikiResult.communityPages} communities, ${wikiResult.hubPages} hubs` +
            `${wikiResult.surprisesPage ? ", 1 surprises page" : ""})`
          );
        }
      } catch (err) {
        // Wiki generation is best-effort; continue with dashboard
        console.log("  Wiki generation skipped:", (err as Error).message);
      }
    }

    const data = extractDashboardData(metadata, memoryStore, {
      maxCommunities: opts.maxCommunities,
      maxHubs: opts.maxHubs,
      maxSurprises: opts.maxSurprises,
    });

    const outputPath = opts.outputPath || resolve(config.dataDir, "lens.html");

    if (!opts.json) {
      const html = generateHTML(data);
      writeFileSync(outputPath, html, "utf-8");
    }

    return { outputPath, data };
  } finally {
    metadata.close();
    if (memoryStore) {
      memoryStore.close();
    }
  }
}
