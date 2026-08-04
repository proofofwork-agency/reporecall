#!/usr/bin/env tsx
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

interface PilotEvidence {
  schemaVersion: "reporecall-pilot/v1";
  privacy: {
    redacted: true;
    manuallyShared: true;
    backgroundTelemetry: false;
  };
  durationWeeks: number;
  users: Array<{
    id: string;
    installSucceeded: boolean;
    timeToFirstValidContextMinutes: number;
    enabledInFinalTwoWeeks: boolean;
    prefersHardMultiFileTasks: boolean;
  }>;
  repositories: Array<{
    id: string;
    builderOwned: false;
    sourceFiles: number;
    codeLines: number;
  }>;
  pairedTasks: Array<{
    id: string;
    repositoryId: string;
    category: "lookup" | "bug" | "trace" | "architecture" | "change";
    rubricRegisteredBeforeRun: true;
    gradingBlinded: true;
    nativeCorrect: boolean;
    repoRecallCorrect: boolean;
    highConfidenceWrong: boolean;
    nativeToolRounds: number;
    repoRecallToolRounds: number;
    nativeInputTokens: number;
    repoRecallInputTokens: number;
  }>;
}

const path = resolve(process.cwd(), "quality/evidence/pilot-redacted.json");
if (!existsSync(path)) {
  process.stderr.write("pilot gate: no redacted pilot evidence; remain on 0.9.x\n");
  process.exitCode = 1;
} else {
  const evidence = JSON.parse(readFileSync(path, "utf-8")) as PilotEvidence;
  const errors: string[] = [];
  if (evidence.schemaVersion !== "reporecall-pilot/v1") errors.push("unsupported schema");
  if (
    !evidence.privacy?.redacted
    || !evidence.privacy.manuallyShared
    || evidence.privacy.backgroundTelemetry
  ) {
    errors.push("privacy contract is not satisfied");
  }
  if (evidence.durationWeeks < 4) errors.push("pilot duration is under four weeks");
  if (evidence.users.length < 5) errors.push("fewer than five users");
  if (evidence.repositories.length < 5) errors.push("fewer than five repositories");
  if (
    evidence.repositories.some(
      (repository) =>
        repository.builderOwned !== false
        || (repository.sourceFiles < 500 && repository.codeLines < 50_000),
    )
  ) {
    errors.push("repository independence or size gate failed");
  }
  if (evidence.pairedTasks.length < 100) errors.push("fewer than 100 paired tasks");
  if (
    evidence.pairedTasks.some(
      (task) => !task.rubricRegisteredBeforeRun || !task.gradingBlinded,
    )
  ) {
    errors.push("task pre-registration or blinded grading is incomplete");
  }

  const repoRecallCorrect = rate(evidence.pairedTasks.map((task) => task.repoRecallCorrect));
  const nativeCorrect = rate(evidence.pairedTasks.map((task) => task.nativeCorrect));
  if (repoRecallCorrect < nativeCorrect - 0.05) errors.push("correctness non-inferiority failed");
  if (rate(evidence.pairedTasks.map((task) => task.highConfidenceWrong)) > 0.05) {
    errors.push("high-confidence-wrong rate exceeds 5%");
  }
  if (evidence.users.some((user) => !user.installSucceeded)) errors.push("not all installs succeeded");
  if (median(evidence.users.map((user) => user.timeToFirstValidContextMinutes)) >= 10) {
    errors.push("median time to first context is not under ten minutes");
  }
  if (evidence.users.filter((user) => user.enabledInFinalTwoWeeks).length < 4) {
    errors.push("fewer than four users retained RepoRecall");
  }
  if (evidence.users.filter((user) => user.prefersHardMultiFileTasks).length < 4) {
    errors.push("fewer than four users prefer hard multi-file tasks");
  }

  const toolImprovement = improvement(
    evidence.pairedTasks.map((task) => task.nativeToolRounds),
    evidence.pairedTasks.map((task) => task.repoRecallToolRounds),
  );
  const tokenImprovement = improvement(
    evidence.pairedTasks.map((task) => task.nativeInputTokens),
    evidence.pairedTasks.map((task) => task.repoRecallInputTokens),
  );
  if (Math.max(toolImprovement, tokenImprovement) < 0.2) {
    errors.push("neither median tool rounds nor input tokens improved by 20%");
  }
  if (toolImprovement < -0.1 || tokenImprovement < -0.1) {
    errors.push("an efficiency metric regressed by more than 10%");
  }

  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`pilot gate: ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`pilot gate passed (${evidence.pairedTasks.length} paired tasks)\n`);
  }
}

function rate(values: boolean[]): number {
  return values.length === 0 ? 0 : values.filter(Boolean).length / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}

function improvement(baseline: number[], candidate: number[]): number {
  const baselineMedian = median(baseline);
  if (baselineMedian <= 0) return 0;
  return (baselineMedian - median(candidate)) / baselineMedian;
}
