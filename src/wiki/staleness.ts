/**
 * Wiki page staleness detection via git diff.
 *
 * Compares a page's sourceCommit against HEAD to detect
 * whether referenced files have changed since the page was written.
 */

import { execFileSync } from "child_process";
import type { WikiStalenessResult } from "./types.js";

/**
 * Check if a wiki page is stale by comparing its sourceCommit
 * against HEAD. A page is stale if any of its relatedFiles
 * appear in the git diff.
 */
export function checkPageStaleness(
  name: string,
  sourceCommit: string,
  relatedFiles: string[],
  projectRoot: string
): WikiStalenessResult {
  if (!sourceCommit || relatedFiles.length === 0) {
    return { name, stale: false, sourceCommit, changedFiles: [] };
  }

  try {
    const diffOutput = execFileSync(
      "git",
      ["diff", "--name-only", `${sourceCommit}..HEAD`],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();

    if (!diffOutput) {
      return { name, stale: false, sourceCommit, changedFiles: [] };
    }

    const changedFiles = new Set(diffOutput.split("\n").filter(Boolean));
    const overlap = relatedFiles.filter((f) => changedFiles.has(f));

    return {
      name,
      stale: overlap.length > 0,
      sourceCommit,
      changedFiles: overlap,
    };
  } catch {
    // git diff failed (e.g., sourceCommit no longer exists)
    return { name, stale: true, sourceCommit, changedFiles: [] };
  }
}
