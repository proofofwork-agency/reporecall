import { createRequire } from "module";
import { platform, arch } from "os";
import type { MetadataStore } from "../storage/metadata-store.js";
import { computeFreshness } from "../core/staleness.js";

export const REPORECALL_EVIDENCE_SCHEMA_V1 = "reporecall-evidence/v1" as const;

export type EvidenceStatus = "measured" | "insufficient_evidence";

export interface EvidenceMetric {
  value: number | null;
  sampleSize: number;
  status: EvidenceStatus;
}

export interface RepoRecallEvidenceV1 {
  schemaVersion: typeof REPORECALL_EVIDENCE_SCHEMA_V1;
  evidenceKind: "aggregate-stats";
  repoRecallVersion: string;
  generatedAt: string;
  status: EvidenceStatus;
  reason?: "index_missing";
  environment: {
    nodeMajor: number;
    platform: NodeJS.Platform;
    arch: string;
  };
  privacy: {
    redactedByDefault: true;
    containsSource: false;
    containsPrompts: false;
    containsAbsolutePaths: false;
    containsFileNames: false;
  };
  freshness: {
    level: "fresh" | "stale" | "empty";
    dirtyFiles: number | null;
    hasIndexedCommit: boolean;
    hasCurrentCommit: boolean;
  };
  index: {
    files: number;
    chunks: number;
    languageCounts: Record<string, number>;
  };
  routing: {
    total: number;
    counts: {
      skip: number;
      lookup: number;
      trace: number;
      bug: number;
      architecture: number;
      change: number;
    };
  };
  latency: {
    averageMs: EvidenceMetric;
    p50Ms: EvidenceMetric;
    p95Ms: EvidenceMetric;
  };
  injection: {
    hookCount: number;
    chunksServed: number;
    tokensInjected: number;
    averageTokensPerHook: EvidenceMetric;
    averageChunksPerHook: EvidenceMetric;
  };
  fallback: {
    count: EvidenceMetric;
  };
  errors: {
    count: EvidenceMetric;
  };
}

export function buildRepoRecallEvidence(
  metadata: MetadataStore | undefined,
  projectRoot: string,
  generatedAt = new Date(),
): RepoRecallEvidenceV1 {
  const version = loadRepoRecallVersion();
  const environment = {
    nodeMajor: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10),
    platform: platform(),
    arch: arch(),
  };
  const privacy = {
    redactedByDefault: true,
    containsSource: false,
    containsPrompts: false,
    containsAbsolutePaths: false,
    containsFileNames: false,
  } as const;

  if (!metadata) {
    const missingMetric = insufficientMetric();
    return {
      schemaVersion: REPORECALL_EVIDENCE_SCHEMA_V1,
      evidenceKind: "aggregate-stats",
      repoRecallVersion: version,
      generatedAt: generatedAt.toISOString(),
      status: "insufficient_evidence",
      reason: "index_missing",
      environment,
      privacy,
      freshness: {
        level: "empty",
        dirtyFiles: null,
        hasIndexedCommit: false,
        hasCurrentCommit: false,
      },
      index: { files: 0, chunks: 0, languageCounts: {} },
      routing: {
        total: 0,
        counts: {
          skip: 0,
          lookup: 0,
          trace: 0,
          bug: 0,
          architecture: 0,
          change: 0,
        },
      },
      latency: {
        averageMs: missingMetric,
        p50Ms: missingMetric,
        p95Ms: missingMetric,
      },
      injection: {
        hookCount: 0,
        chunksServed: 0,
        tokensInjected: 0,
        averageTokensPerHook: missingMetric,
        averageChunksPerHook: missingMetric,
      },
      fallback: { count: missingMetric },
      errors: { count: missingMetric },
    };
  }

  const stats = metadata.getStats();
  const freshness = computeFreshness(metadata, projectRoot);
  const latency = metadata.getLatencyPercentiles();
  const hookCount = readCount(metadata, "hooksFireCount");
  const chunksServed = readCount(metadata, "chunksServed");
  const tokensInjected = readCount(metadata, "totalTokensInjected");
  const routingCounts = {
    skip: readCount(metadata, "route_skip_count"),
    lookup: readCount(metadata, "route_lookup_count"),
    trace: readCount(metadata, "route_trace_count"),
    bug: readCount(metadata, "route_bug_count"),
    architecture: readCount(metadata, "route_architecture_count"),
    change: readCount(metadata, "route_change_count"),
  };

  return {
    schemaVersion: REPORECALL_EVIDENCE_SCHEMA_V1,
    evidenceKind: "aggregate-stats",
    repoRecallVersion: version,
    generatedAt: generatedAt.toISOString(),
    status: "measured",
    environment,
    privacy,
    freshness: {
      level: freshness.level,
      dirtyFiles: freshness.dirtyFiles,
      hasIndexedCommit: Boolean(freshness.indexedCommit),
      hasCurrentCommit: Boolean(freshness.currentCommit),
    },
    index: {
      files: stats.totalFiles,
      chunks: stats.totalChunks,
      languageCounts: stats.languages,
    },
    routing: {
      total: Object.values(routingCounts).reduce((sum, count) => sum + count, 0),
      counts: routingCounts,
    },
    latency: {
      averageMs: measuredWhenSampled(latency.avg, latency.count),
      p50Ms: measuredWhenSampled(latency.p50, latency.count),
      p95Ms: measuredWhenSampled(latency.p95, latency.count),
    },
    injection: {
      hookCount,
      chunksServed,
      tokensInjected,
      averageTokensPerHook: hookCount > 0
        ? measuredMetric(tokensInjected / hookCount, hookCount)
        : insufficientMetric(),
      averageChunksPerHook: hookCount > 0
        ? measuredMetric(chunksServed / hookCount, hookCount)
        : insufficientMetric(),
    },
    fallback: {
      count: optionalCounterMetric(metadata, "fallbackCount"),
    },
    errors: {
      count: optionalCounterMetric(metadata, "errorCount"),
    },
  };
}

function loadRepoRecallVersion(): string {
  const require = createRequire(import.meta.url);
  for (const candidate of ["../../package.json", "../package.json"]) {
    try {
      return (require(candidate) as { version?: string }).version ?? "unknown";
    } catch {
      // Try the layout used by the next build target.
    }
  }
  return "unknown";
}

function readCount(metadata: MetadataStore, key: string): number {
  const value = Number(metadata.getStat(key) ?? "0");
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalCounterMetric(metadata: MetadataStore, key: string): EvidenceMetric {
  const raw = metadata.getStat(key);
  if (raw === undefined) return insufficientMetric();
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? measuredMetric(value, 1)
    : insufficientMetric();
}

function measuredWhenSampled(value: number, sampleSize: number): EvidenceMetric {
  return sampleSize > 0
    ? measuredMetric(value, sampleSize)
    : insufficientMetric();
}

function measuredMetric(value: number, sampleSize: number): EvidenceMetric {
  return { value, sampleSize, status: "measured" };
}

function insufficientMetric(): EvidenceMetric {
  return { value: null, sampleSize: 0, status: "insufficient_evidence" };
}
