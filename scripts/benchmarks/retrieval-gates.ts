#!/usr/bin/env tsx
/**
 * Emit a redacted, registrable evidence artifact from a project-context audit
 * report.
 *
 * The raw audit report carries per-query file paths from the measured
 * repository, which is usually private. This keeps only the aggregate gate
 * metrics and the cohort size, so the numbers can be published and registered in
 * quality/claims.json without leaking anything about the repository.
 *
 *   npm run benchmark:project-context -- --project <repo> --reporecall-only --output /tmp/audit
 *   npm run benchmark:retrieval-gates -- --report /tmp/audit.json --output quality/evidence/retrieval-gates.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

interface AuditSummary {
  totalQueries: number;
  reporecallOnlyPass: boolean;
  routeAccuracy: number;
  avgContextPrecision: number;
  avgContextRecall: number;
  avgPollutionRatio: number;
  avgTokenPollutionRatio: number;
  highConfidenceWrongRate: number;
  freshnessSignalingRate: number;
  routeBreakdown: Record<
    string,
    {
      queryCount: number;
      routeMatchRate: number;
      avgContextPrecision: number;
      avgContextRecall: number;
      avgPollutionRatio: number;
    }
  >;
}

let reportPath: string | undefined;
let outputPath: string | undefined;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const current = argv[index];
  const next = argv[index + 1];
  if (current === "--report" && next) { reportPath = resolve(next); index += 1; }
  else if (current === "--output" && next) { outputPath = resolve(next); index += 1; }
}
if (!reportPath) {
  process.stderr.write("usage: retrieval-gates --report <audit.json> [--output <evidence.json>]\n");
  process.exitCode = 1;
} else {
  const report = JSON.parse(readFileSync(reportPath, "utf-8")) as {
    summary: AuditSummary;
    metadata?: { mode?: string; createdAt?: string };
  };
  const summary = report.summary;
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as { version: string };

  // The gate definition lives in project-context-audit-lib buildSummary; these
  // bars are restated here so the artifact is self-describing.
  const gates = {
    contextPrecision: { measured: summary.avgContextPrecision, bar: 0.6, comparison: ">=" },
    contextRecall: { measured: summary.avgContextRecall, bar: 0.85, comparison: ">=" },
    pollutionRatio: { measured: summary.avgPollutionRatio, bar: 0.1, comparison: "<=" },
    routeAccuracy: { measured: summary.routeAccuracy, bar: 0.9, comparison: ">=" },
    highConfidenceWrongRate: { measured: summary.highConfidenceWrongRate, bar: 0, comparison: "==" },
    freshnessSignalingRate: { measured: summary.freshnessSignalingRate, bar: 1, comparison: "==" },
  };

  const artifact = {
    schemaVersion: "reporecall-evidence/v1" as const,
    evidenceKind: "retrieval-gates" as const,
    repoRecallVersion: packageJson.version,
    generatedAt: new Date().toISOString(),
    status: "measured" as const,
    method: {
      harness: "npm run benchmark:project-context -- --reporecall-only",
      gateSource: "scripts/benchmarks/project-context-audit-lib.ts buildSummary",
      mode: report.metadata?.mode ?? "reporecall-only",
      modelCalls: 0,
      note:
        "Deterministic retrieval measurement against a real repository. Redacted: " +
        "aggregate metrics and cohort size only, no query text, file names or source.",
    },
    // Redaction is the point of this script — the raw audit report is not publishable.
    privacy: {
      redactedByDefault: true as const,
      containsSource: false as const,
      containsPrompts: false as const,
      containsAbsolutePaths: false as const,
      containsFileNames: false as const,
      containsRepositoryName: false as const,
    },
    cohortSize: summary.totalQueries,
    pass: summary.reporecallOnlyPass,
    gates,
    tokenPollutionRatio: summary.avgTokenPollutionRatio,
    byRoute: Object.fromEntries(
      Object.entries(summary.routeBreakdown)
        .filter(([, stats]) => stats.queryCount > 0)
        .map(([route, stats]) => [
          route,
          {
            queryCount: stats.queryCount,
            routeMatchRate: stats.routeMatchRate,
            contextPrecision: stats.avgContextPrecision,
            contextRecall: stats.avgContextRecall,
            pollutionRatio: stats.avgPollutionRatio,
          },
        ])
    ),
  };

  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json, "utf-8");
  }
  process.stdout.write(
    `retrieval gates: ${artifact.pass ? "PASS" : "FAIL"} (${artifact.cohortSize} queries)\n` +
      Object.entries(gates)
        .map(([name, gate]) => `  ${name}: ${(gate.measured * 100).toFixed(1)}% ${gate.comparison} ${(gate.bar * 100).toFixed(0)}%`)
        .join("\n") +
      "\n"
  );
  process.exitCode = artifact.pass ? 0 : 1;
}
