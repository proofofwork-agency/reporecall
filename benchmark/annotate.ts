#!/usr/bin/env npx tsx
/**
 * Annotation helper — generates draft relevance annotations for live-repo benchmarking.
 *
 * Usage:
 *   npx tsx benchmark/annotate.ts --project .
 *
 * For each query in benchmark/queries.json:
 *   1. Runs full pipeline: sanitizeQuery → classifyIntent → deriveRoute → resolveSeeds → search
 *   2. Prints top-20 results with rank, name, filePath, kind, score
 *   3. Outputs benchmark/annotations-draft.json with all chunk names pre-filled at grade 0
 *
 * The human then edits grades from 0 to the correct 0–3 values.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { IndexingPipeline } from "../src/indexer/pipeline.js";
import { HybridSearch } from "../src/search/hybrid.js";
import { sanitizeQuery } from "../src/daemon/server.js";
import { classifyIntent, deriveRoute } from "../src/search/intent.js";
import { resolveSeeds } from "../src/search/seed.js";
import { handlePromptContextDetailed } from "../src/hooks/prompt-context.js";
import { loadConfig } from "../src/core/config.js";

interface QueryEntry {
  query: string;
  expectedRoute: string;
  category: string;
  description?: string;
}

interface AnnotationQuery {
  id: string;
  query: string;
  category: string;
  expectedRoute: string;
  relevance: Record<string, number>;
}

async function main() {
  const args = process.argv.slice(2);
  let projectPath = ".";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectPath = args[i + 1];
      i++;
    }
  }

  const projectRoot = resolve(projectPath);
  const queriesPath = join(projectRoot, "benchmark", "queries.json");
  const outputPath = join(projectRoot, "benchmark", "annotations-draft.json");

  const queries: QueryEntry[] = JSON.parse(readFileSync(queriesPath, "utf-8"));
  const config = loadConfig(projectRoot);

  console.log(`Indexing ${projectRoot}...`);
  const pipeline = new IndexingPipeline(config);
  await pipeline.indexAll();

  const search = new HybridSearch(
    pipeline.getEmbedder(),
    pipeline.getVectorStore(),
    pipeline.getFTSStore(),
    pipeline.getMetadataStore(),
    config
  );

  const metadata = pipeline.getMetadataStore();
  const fts = pipeline.getFTSStore();

  const annotationQueries: AnnotationQuery[] = [];

  for (const entry of queries) {
    const sanitized = sanitizeQuery(entry.query);
    const queryText = sanitized || entry.query;
    const intent = classifyIntent(queryText);
    let route = deriveRoute(intent);

    if (intent.needsNavigation && route === "R0") {
      const seedResult = resolveSeeds(queryText, metadata, fts);
      route = deriveRoute(intent, seedResult.bestSeed?.confidence ?? null);
    }

    const id = entry.query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    if (route === "skip") {
      console.log(`\n[SKIP] "${entry.query}" → route=skip`);
      annotationQueries.push({
        id,
        query: entry.query,
        category: entry.category,
        expectedRoute: entry.expectedRoute,
        relevance: {},
      });
      continue;
    }

    const promptContext = await handlePromptContextDetailed(
      queryText, search, config, undefined, undefined, route, metadata, fts
    );
    const results = promptContext.context?.chunks ?? [];

    console.log(`\n━━━ "${entry.query}" ━━━`);
    console.log(`  Route: ${route} → ${promptContext.resolvedRoute} | Expected: ${entry.expectedRoute}`);
    console.log(`  Results: ${results.length}`);

    const relevance: Record<string, number> = {};

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const key =
        results.filter((x) => x.name === r.name).length > 1
          ? `${r.filePath}:${r.name}`
          : r.name;

      console.log(
        `    ${String(i + 1).padStart(2)}. ${key.padEnd(50)} ${r.kind.padEnd(12)}`
      );
      relevance[key] = 0;
    }

    annotationQueries.push({
      id,
      query: entry.query,
      category: entry.category,
      expectedRoute: entry.expectedRoute,
      relevance,
    });
  }

  const draft = {
    corpus: "reporecall",
    version: "0.2.1",
    annotatedAt: new Date().toISOString().split("T")[0],
    scale: {
      "0": "not relevant",
      "1": "marginally relevant",
      "2": "relevant",
      "3": "highly relevant",
    },
    queries: annotationQueries,
  };

  writeFileSync(outputPath, JSON.stringify(draft, null, 2));
  console.log(`\nDraft annotations written to: ${outputPath}`);
  console.log("Edit the relevance grades (0-3) manually, then save as annotations.json");

  pipeline.close();
}

main().catch((err) => {
  console.error("Annotation failed:", err);
  process.exit(1);
});
