/**
 * Paired context-cost measurement.
 *
 * Measures ONE thing, deterministically and without any model calls: how many
 * tokens it costs to put the evidence needed to answer a question in front of a
 * model, with Reporecall versus without it.
 *
 * - candidate (Reporecall): the tokens Reporecall actually injects for the query.
 * - baseline (no Reporecall): the tokens an agent pays to read the files that
 *   genuinely contain the answer, whole — which is what grep-then-read does.
 *   The baseline is deliberately generous to the no-Reporecall case: it counts
 *   ONLY the known-relevant files, never the wrong files a real search would
 *   also open, so the measured saving is a floor rather than a best case.
 *
 * A query only counts if Reporecall actually delivered every `mustInclude` file.
 * Otherwise dropping evidence would register as a saving, which would make the
 * number worthless.
 *
 * This is NOT an end-to-end agent token measurement. It does not model reasoning
 * tokens, tool-call overhead, or multi-turn exploration, and it must never be
 * described as "total tokens saved". A full paired agentic run against the same
 * fixture is the separate, more expensive artifact.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, relative, resolve } from "path";
import { spawnSync } from "child_process";
import { countTokens } from "../../src/search/context-assembler.js";

export interface ContextCostQuery {
  id: string;
  query: string;
  expectedRoute?: string;
  category?: string;
  relevance?: Record<string, number>;
  mustInclude?: string[];
}

export interface ContextCostRow {
  id: string;
  category: string;
  /** Tokens Reporecall injected for this query. */
  repoRecallTokens: number;
  /** Tokens to read every known-relevant file whole. */
  baselineTokens: number;
  /** Files whose full contents make up the baseline. */
  baselineFiles: string[];
  /** Reporecall delivered every mustInclude file. */
  evidenceComplete: boolean;
  /** Per-query reduction, only meaningful when evidenceComplete. */
  reductionRatio: number | null;
  skippedReason?: string;
}

export interface ContextCostReport {
  schemaVersion: "reporecall-evidence/v1";
  evidenceKind: "paired-context-cost";
  repoRecallVersion: string;
  generatedAt: string;
  status: "measured" | "insufficient_evidence";
  reason?: string;
  method: {
    modelCalls: 0;
    baseline: string;
    candidate: string;
    correctnessGuard: string;
    limitation: string;
    tokenizer: string;
  };
  privacy: {
    redactedByDefault: true;
    containsSource: false;
    containsPrompts: false;
    containsAbsolutePaths: false;
    containsFileNames: boolean;
  };
  fixture: { path: string; queryCount: number };
  cohortSize: number;
  aggregate: {
    /** Median-based, matching quality/pilot's committed statistic. */
    medianBaselineTokens: number | null;
    medianRepoRecallTokens: number | null;
    medianReductionRatio: number | null;
    meanReductionRatio: number | null;
    totalBaselineTokens: number;
    totalRepoRecallTokens: number;
    totalReductionRatio: number | null;
    queriesWithCompleteEvidence: number;
    queriesSkipped: number;
  };
  perRoute: Record<string, { count: number; medianReductionRatio: number | null }>;
  rows: ContextCostRow[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function reduction(baseline: number, candidate: number): number | null {
  if (baseline <= 0) return null;
  return (baseline - candidate) / baseline;
}

function readFixture(path: string): ContextCostQuery[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (Array.isArray(parsed)) return parsed as ContextCostQuery[];
  const record = parsed as Record<string, unknown>;
  const list = record.queries ?? record.cases ?? Object.values(record)[0];
  if (!Array.isArray(list)) throw new Error(`fixture ${path} has no query array`);
  return list as ContextCostQuery[];
}

interface ExplainResult {
  tokensInjected?: number;
  selectedFiles?: Array<{ filePath: string }>;
}

function runExplain(binary: string, projectRoot: string, query: string): ExplainResult | null {
  const result = spawnSync(
    process.execPath,
    [binary, "explain", "--project", projectRoot, "--json", query],
    { encoding: "utf-8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }
  );
  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout) as ExplainResult;
  } catch {
    return null;
  }
}

/** Tokens to read a repo-relative file whole. Missing files contribute nothing. */
function fullFileTokens(projectRoot: string, relativePath: string): number {
  const absolute = resolve(projectRoot, relativePath);
  if (!existsSync(absolute)) return 0;
  try {
    return countTokens(readFileSync(absolute, "utf-8"));
  } catch {
    return 0;
  }
}

export function measureContextCost(options: {
  projectRoot: string;
  fixturePath: string;
  binary: string;
  repoRecallVersion: string;
  includeFileNames?: boolean;
}): ContextCostReport {
  const { projectRoot, fixturePath, binary, repoRecallVersion } = options;
  const includeFileNames = options.includeFileNames ?? false;
  const queries = readFixture(fixturePath);
  const rows: ContextCostRow[] = [];

  for (const query of queries) {
    const relevantFiles = Object.keys(query.relevance ?? {});
    const mustInclude = query.mustInclude ?? relevantFiles;
    const category = query.expectedRoute ?? query.category ?? "unknown";

    if (relevantFiles.length === 0) {
      rows.push({
        id: query.id,
        category,
        repoRecallTokens: 0,
        baselineTokens: 0,
        baselineFiles: [],
        evidenceComplete: false,
        reductionRatio: null,
        skippedReason: "fixture declares no relevant files",
      });
      continue;
    }

    const explained = runExplain(binary, projectRoot, query.query);
    if (!explained || typeof explained.tokensInjected !== "number") {
      rows.push({
        id: query.id,
        category,
        repoRecallTokens: 0,
        baselineTokens: 0,
        baselineFiles: [],
        evidenceComplete: false,
        reductionRatio: null,
        skippedReason: "explain produced no usable result",
      });
      continue;
    }

    const selected = new Set((explained.selectedFiles ?? []).map((file) => file.filePath));
    const evidenceComplete = mustInclude.every((required) =>
      [...selected].some((got) => got === required || got.endsWith(`/${required}`))
    );

    const baselineTokens = relevantFiles.reduce(
      (total, file) => total + fullFileTokens(projectRoot, file),
      0
    );
    const repoRecallTokens = explained.tokensInjected;

    rows.push({
      id: query.id,
      category,
      repoRecallTokens,
      baselineTokens,
      baselineFiles: includeFileNames ? relevantFiles : [],
      evidenceComplete,
      reductionRatio: evidenceComplete ? reduction(baselineTokens, repoRecallTokens) : null,
      skippedReason: evidenceComplete ? undefined : "reporecall omitted a mustInclude file",
    });
  }

  const counted = rows.filter((row) => row.evidenceComplete && row.reductionRatio !== null);
  const ratios = counted.map((row) => row.reductionRatio as number);
  const totalBaseline = counted.reduce((sum, row) => sum + row.baselineTokens, 0);
  const totalCandidate = counted.reduce((sum, row) => sum + row.repoRecallTokens, 0);

  const perRoute: ContextCostReport["perRoute"] = {};
  for (const row of counted) {
    perRoute[row.category] ??= { count: 0, medianReductionRatio: null };
    perRoute[row.category].count += 1;
  }
  for (const route of Object.keys(perRoute)) {
    perRoute[route].medianReductionRatio = median(
      counted.filter((row) => row.category === route).map((row) => row.reductionRatio as number)
    );
  }

  return {
    schemaVersion: "reporecall-evidence/v1",
    evidenceKind: "paired-context-cost",
    repoRecallVersion,
    generatedAt: new Date().toISOString(),
    status: counted.length > 0 ? "measured" : "insufficient_evidence",
    reason: counted.length > 0 ? undefined : "no query produced complete evidence",
    method: {
      modelCalls: 0,
      baseline:
        "sum of whole-file tokens for the fixture's known-relevant files (grep-then-read), " +
        "counting only known-relevant files and never the wrong files a real search would also open",
      candidate: "tokens Reporecall injects for the same query (reporecall explain --json)",
      correctnessGuard:
        "a query is counted only when Reporecall delivered every mustInclude file, so omitting evidence cannot register as a saving",
      limitation:
        "context-assembly cost only; excludes reasoning tokens, tool-call overhead and multi-turn exploration. Not an end-to-end agent token measurement.",
      tokenizer: "tiktoken via src/search/context-assembler.countTokens",
    },
    privacy: {
      redactedByDefault: true,
      containsSource: false,
      containsPrompts: false,
      containsAbsolutePaths: false,
      containsFileNames: includeFileNames,
    },
    // Repo-relative: the privacy block promises no absolute paths.
    fixture: { path: relative(process.cwd(), fixturePath) || fixturePath, queryCount: queries.length },
    cohortSize: counted.length,
    aggregate: {
      medianBaselineTokens: median(counted.map((row) => row.baselineTokens)),
      medianRepoRecallTokens: median(counted.map((row) => row.repoRecallTokens)),
      medianReductionRatio: median(ratios),
      meanReductionRatio:
        ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
      totalBaselineTokens: totalBaseline,
      totalRepoRecallTokens: totalCandidate,
      totalReductionRatio: reduction(totalBaseline, totalCandidate),
      queriesWithCompleteEvidence: counted.length,
      queriesSkipped: rows.length - counted.length,
    },
    perRoute,
    rows,
  };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function renderSummary(report: ContextCostReport): string {
  const aggregate = report.aggregate;
  const lines = [
    `context cost: ${report.status}`,
    `  cohort:            ${report.cohortSize}/${report.fixture.queryCount} queries with complete evidence`,
    `  median baseline:   ${aggregate.medianBaselineTokens ?? "n/a"} tokens (read relevant files whole)`,
    `  median reporecall: ${aggregate.medianRepoRecallTokens ?? "n/a"} tokens (injected)`,
    `  median reduction:  ${pct(aggregate.medianReductionRatio)}`,
    `  total reduction:   ${pct(aggregate.totalReductionRatio)} (${aggregate.totalBaselineTokens} -> ${aggregate.totalRepoRecallTokens})`,
    `  skipped:           ${aggregate.queriesSkipped}`,
  ];
  for (const [route, stats] of Object.entries(report.perRoute)) {
    lines.push(`  ${route}: n=${stats.count} median reduction ${pct(stats.medianReductionRatio)}`);
  }
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<void> {
  let projectRoot = process.cwd();
  let fixturePath = resolve("benchmark/project-context-queries.json");
  let outputPath: string | undefined;
  let binary = resolve("dist/memory.js");
  let includeFileNames = false;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--project" && next) { projectRoot = resolve(next); index += 1; }
    else if (current === "--fixture" && next) { fixturePath = resolve(next); index += 1; }
    else if (current === "--output" && next) { outputPath = resolve(next); index += 1; }
    else if (current === "--binary" && next) { binary = resolve(next); index += 1; }
    else if (current === "--include-file-names") { includeFileNames = true; }
  }

  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as { version: string };
  const report = measureContextCost({
    projectRoot,
    fixturePath,
    binary,
    repoRecallVersion: packageJson.version,
    includeFileNames,
  });

  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  }
  process.stdout.write(`${renderSummary(report)}\n`);
  process.exitCode = report.status === "measured" ? 0 : 1;
}
