import { describe, expect, it } from "vitest";
import {
  buildRepoRecallEvidence,
  REPORECALL_EVIDENCE_SCHEMA_V1,
} from "../../src/evidence/schema.js";
import type { MetadataStore } from "../../src/storage/metadata-store.js";

function mockMetadata(stats: Record<string, string>): MetadataStore {
  return {
    getStats: () => ({
      totalFiles: 4,
      totalChunks: 12,
      languages: { typescript: 10, javascript: 2 },
    }),
    getStat: (key: string) => stats[key],
    getLatencyPercentiles: () => ({ avg: 21, p50: 13, p95: 55, count: 8 }),
  } as unknown as MetadataStore;
}

describe("RepoRecallEvidenceV1", () => {
  it("emits explicit insufficient evidence when the index is missing", () => {
    const evidence = buildRepoRecallEvidence(
      undefined,
      process.cwd(),
      new Date("2026-07-30T12:00:00.000Z"),
    );

    expect(evidence.schemaVersion).toBe(REPORECALL_EVIDENCE_SCHEMA_V1);
    expect(evidence.status).toBe("insufficient_evidence");
    expect(evidence.reason).toBe("index_missing");
    expect(evidence.latency.p95Ms).toEqual({
      value: null,
      sampleSize: 0,
      status: "insufficient_evidence",
    });
  });

  it("contains aggregate metrics without source, prompts, paths, or filenames", () => {
    const evidence = buildRepoRecallEvidence(
      mockMetadata({
        lastIndexedAt: "2026-07-30T11:00:00.000Z",
        hooksFireCount: "4",
        chunksServed: "12",
        totalTokensInjected: "800",
        route_lookup_count: "2",
        route_trace_count: "1",
        route_architecture_count: "1",
        fallbackCount: "0",
        errorCount: "1",
      }),
      process.cwd(),
      new Date("2026-07-30T12:00:00.000Z"),
    );

    expect(evidence.status).toBe("measured");
    expect(evidence.routing.total).toBe(4);
    expect(evidence.injection.averageTokensPerHook.value).toBe(200);
    expect(evidence.injection.averageChunksPerHook.value).toBe(3);
    expect(evidence.fallback.count.status).toBe("measured");
    expect(evidence.errors.count.value).toBe(1);
    expect(evidence.privacy).toEqual({
      redactedByDefault: true,
      containsSource: false,
      containsPrompts: false,
      containsAbsolutePaths: false,
      containsFileNames: false,
    });

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toContain("src/");
  });

  it("does not invent fallback or error measurements", () => {
    const evidence = buildRepoRecallEvidence(
      mockMetadata({ lastIndexedAt: "2026-07-30T11:00:00.000Z" }),
      process.cwd(),
    );

    expect(evidence.fallback.count.status).toBe("insufficient_evidence");
    expect(evidence.fallback.count.value).toBeNull();
    expect(evidence.errors.count.status).toBe("insufficient_evidence");
    expect(evidence.errors.count.value).toBeNull();
  });
});
