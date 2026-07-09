import { execFileSync } from "child_process";
import { statSync } from "fs";
import { resolve } from "path";

export type FreshnessLevel = "fresh" | "stale" | "empty";

export interface IndexFreshness {
  lastIndexedAt: string | null;
  indexedCommit: string | null;
  currentCommit: string | null;
  dirtyFiles: number | null;
  level: FreshnessLevel;
}

export interface FreshnessMetadata {
  getStats(): { totalChunks: number };
  getStat(key: string): string | undefined;
}

export interface FreshnessOptions {
  now?: () => number;
  ttlMs?: number;
}

interface CacheEntry {
  key: string;
  computedAt: number;
  value: IndexFreshness;
}

const DEFAULT_TTL_MS = 5_000;
let cache: CacheEntry | null = null;

function normalizeStat(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function runGit(projectRoot: string, args: string[], trim = true): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return trim ? output.trim() : output;
  } catch {
    return null;
  }
}

export function resolveCurrentCommit(projectRoot: string): string | null {
  const commit = runGit(projectRoot, ["rev-parse", "HEAD"]);
  return commit ? commit : null;
}

function parsePorcelainPath(line: string): string | null {
  const raw = line.slice(3);
  if (!raw) return null;
  const renamed = raw.split(" -> ");
  return renamed[renamed.length - 1] ?? raw;
}

function countFilesChangedSince(projectRoot: string, lastIndexedAt: string | null): number | null {
  const output = runGit(projectRoot, ["status", "--porcelain"], false);
  if (output === null) return null;
  const lastIndexedMs = lastIndexedAt ? Date.parse(lastIndexedAt) : Number.NaN;
  const countAllDirty = Number.isNaN(lastIndexedMs);
  let dirty = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const path = parsePorcelainPath(line);
    if (!path) continue;

    try {
      const fileStat = statSync(resolve(projectRoot, path));
      if (countAllDirty || fileStat.mtimeMs > lastIndexedMs) dirty += 1;
    } catch {
      dirty += 1;
    }
  }

  return dirty;
}

export function clearFreshnessCache(): void {
  cache = null;
}

export function computeFreshness(
  metadata: FreshnessMetadata,
  projectRoot: string,
  options: FreshnessOptions = {}
): IndexFreshness {
  const now = options.now?.() ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const stats = metadata.getStats();
  const lastIndexedAt = normalizeStat(metadata.getStat("lastIndexedAt"));
  const indexedCommit = normalizeStat(metadata.getStat("indexedCommit"));
  const cacheKey = [
    projectRoot,
    stats.totalChunks,
    lastIndexedAt ?? "",
    indexedCommit ?? "",
  ].join("\0");

  if (cache && cache.key === cacheKey && now - cache.computedAt < ttlMs) {
    return cache.value;
  }

  const currentCommit = resolveCurrentCommit(projectRoot);
  const dirtyFiles = countFilesChangedSince(projectRoot, lastIndexedAt);
  let level: FreshnessLevel = "fresh";

  if (stats.totalChunks === 0 || !lastIndexedAt) {
    level = "empty";
  } else if (
    (currentCommit !== null && indexedCommit !== currentCommit)
    || (dirtyFiles !== null && dirtyFiles > 0)
  ) {
    level = "stale";
  }

  const value: IndexFreshness = {
    lastIndexedAt,
    indexedCommit,
    currentCommit,
    dirtyFiles,
    level,
  };
  cache = { key: cacheKey, computedAt: now, value };
  return value;
}

function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
}

function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : "never";
}

export function banner(freshness: IndexFreshness): string | null {
  if (freshness.level === "fresh") return null;

  if (freshness.level === "empty") {
    return "⚠ reporecall index EMPTY: no indexed code context is available. Run refresh_context or `reporecall index`.";
  }

  const reasons: string[] = [];
  const current = shortCommit(freshness.currentCommit);
  const indexed = shortCommit(freshness.indexedCommit);
  if (current && indexed && current !== indexed) {
    reasons.push(`repo has moved (HEAD ${current} ≠ indexed ${indexed})`);
  } else if (current && !indexed) {
    reasons.push(`repo has HEAD ${current} but the index has no recorded commit`);
  }

  if (freshness.dirtyFiles !== null && freshness.dirtyFiles > 0) {
    reasons.push(`${freshness.dirtyFiles} file${freshness.dirtyFiles === 1 ? "" : "s"} changed since last index`);
  }

  const reason = reasons.length > 0 ? `, ${reasons.join("; ")}` : "";
  return `⚠ reporecall index STALE: last indexed ${formatDate(freshness.lastIndexedAt)}${reason}. Results may be wrong; run refresh_context.`;
}
