#!/usr/bin/env tsx
/**
 * Aggregate token and freshness evidence.
 *
 * This command deliberately does not estimate a native-tools baseline. A token
 * savings claim requires paired tasks with the same model/settings and fresh
 * sessions; without that artifact the result is "insufficient_evidence".
 */

import { existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import { detectProjectRoot } from "../../src/core/project.js";
import { loadConfig } from "../../src/core/config.js";
import { buildRepoRecallEvidence } from "../../src/evidence/schema.js";
import { MetadataStore } from "../../src/storage/metadata-store.js";

const args = process.argv.slice(2);
const projectIndex = args.indexOf("--project");
const outputIndex = args.indexOf("--output");
const projectRoot = projectIndex >= 0 && args[projectIndex + 1]
  ? resolve(args[projectIndex + 1])
  : detectProjectRoot(process.cwd());
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const config = loadConfig(projectRoot);
const hasIndex = existsSync(resolve(config.dataDir, "metadata.db"));
const metadata = hasIndex ? new MetadataStore(config.dataDir) : undefined;

try {
  const output = {
    ...buildRepoRecallEvidence(metadata, projectRoot),
    tokenSavings: {
      value: null,
      status: "insufficient_evidence",
      reason: "A paired native-tools and RepoRecall task artifact is required.",
    },
  };
  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (outputPath) writeFileSync(resolve(outputPath), json, "utf-8");
  process.stdout.write(json);
} finally {
  metadata?.close();
}
