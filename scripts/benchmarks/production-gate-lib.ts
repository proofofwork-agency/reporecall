import { readFileSync } from "fs";

export type BenchmarkMode = "lookup" | "trace" | "bug" | "architecture" | "change" | "skip";
export type PromptVerdict = "pass" | "partial" | "fail";

export interface ProductionQuery {
  id: string;
  query: string;
  expectedMode?: BenchmarkMode;
  relevance: Record<string, number>;
  mustInclude?: string[];
  mustNotInclude?: string[];
}

export interface ProductionSuite {
  id: string;
  projectRoot: string;
  queries: ProductionQuery[];
}

export interface ProductionFixture {
  version: string;
  generatedAt: string;
  suites: ProductionSuite[];
}

export interface ExplainLikeResult {
  queryMode?: string;
  route?: string;
  selectedFiles?: Array<{ filePath: string }>;
  chunks?: Array<{ filePath: string }>;
}

export interface PromptScore {
  verdict: PromptVerdict;
  numericScore: number;
  selectedFiles: string[];
  modeMatched: boolean | null;
  relevantHits: string[];
  missingMustInclude: string[];
  mustNotIncludeHits: string[];
  weightedRecall: number;
  precision: number;
}

export function loadProductionFixture(path: string): ProductionFixture {
  return JSON.parse(readFileSync(path, "utf8")) as ProductionFixture;
}

export function extractSelectedFiles(result: ExplainLikeResult): string[] {
  if (Array.isArray(result.selectedFiles) && result.selectedFiles.length > 0) {
    return Array.from(new Set(result.selectedFiles.map((item) => item.filePath)));
  }
  if (Array.isArray(result.chunks) && result.chunks.length > 0) {
    return Array.from(new Set(result.chunks.map((item) => item.filePath)));
  }
  return [];
}

export function normalizeMode(result: ExplainLikeResult): string | null {
  if (result.queryMode) return result.queryMode;
  if (result.route === "R0") return "lookup";
  if (result.route === "R1") return "trace";
  if (result.route === "R2") return "architecture";
  if (result.route === "skip") return "skip";
  return null;
}

export function scorePromptResult(
  query: ProductionQuery,
  result: ExplainLikeResult
): PromptScore {
  const selectedFiles = extractSelectedFiles(result);
  const relevantFiles = Object.keys(query.relevance);
  const totalRelevantWeight = relevantFiles.reduce((sum, filePath) => sum + (query.relevance[filePath] ?? 0), 0);
  const relevantHits = selectedFiles.filter((filePath) => relevantFiles.includes(filePath));
  const relevantWeight = relevantHits.reduce((sum, filePath) => sum + (query.relevance[filePath] ?? 0), 0);
  const precision = selectedFiles.length > 0 ? relevantHits.length / selectedFiles.length : 0;
  const weightedRecall = totalRelevantWeight > 0 ? relevantWeight / totalRelevantWeight : 0;
  const missingMustInclude = (query.mustInclude ?? []).filter((filePath) => !selectedFiles.includes(filePath));
  const mustNotIncludeHits = (query.mustNotInclude ?? []).filter((pattern) =>
    selectedFiles.some((filePath) => filePath.includes(pattern))
  );
  const normalizedMode = normalizeMode(result);
  const modeMatched = query.expectedMode ? normalizedMode === query.expectedMode : null;

  let verdict: PromptVerdict = "fail";
  let numericScore = 0;

  const fullMustInclude = (query.mustInclude?.length ?? 0) === 0 || missingMustInclude.length === 0;
  const anyMustInclude = (query.mustInclude ?? []).some((filePath) => selectedFiles.includes(filePath));

  if (
    relevantHits.length > 0
    && weightedRecall >= 0.5
    && precision >= 0.5
    && mustNotIncludeHits.length === 0
    && fullMustInclude
    && modeMatched !== false
  ) {
    verdict = "pass";
    numericScore = 1;
  } else if (
    relevantHits.length > 0
    && weightedRecall >= 0.2
    && precision >= 0.2
    && mustNotIncludeHits.length <= 1
    && (fullMustInclude || anyMustInclude || (query.mustInclude?.length ?? 0) === 0)
  ) {
    verdict = "partial";
    numericScore = 0.5;
  }

  return {
    verdict,
    numericScore,
    selectedFiles,
    modeMatched,
    relevantHits,
    missingMustInclude,
    mustNotIncludeHits,
    weightedRecall,
    precision,
  };
}
