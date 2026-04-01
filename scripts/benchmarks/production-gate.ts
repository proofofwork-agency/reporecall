#!/usr/bin/env tsx
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  extractSelectedFiles,
  loadProductionFixture,
  scorePromptResult,
  type ExplainLikeResult,
  type ProductionFixture,
} from "./production-gate-lib.js";

interface VariantConfig {
  label: string;
  scriptPath: string;
}

function parseArgs(args: string[]) {
  const parsed = {
    fixture: "benchmark/production-queries.json",
    compareInstalled: true,
    packageName: "@proofofwork-agency/reporecall",
    packageVersion: "",
    output: "",
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value === "--fixture") parsed.fixture = args[index + 1] ?? parsed.fixture;
    if (value === "--no-compare-installed") parsed.compareInstalled = false;
    if (value === "--package") parsed.packageName = args[index + 1] ?? parsed.packageName;
    if (value === "--version") parsed.packageVersion = args[index + 1] ?? parsed.packageVersion;
    if (value === "--output") parsed.output = args[index + 1] ?? parsed.output;
  }

  return parsed;
}

function installedVersionFromPackageJson(): string {
  const pkg = JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], { encoding: "utf8" }));
  return pkg.version;
}

function installPublishedScript(packageName: string, packageVersion: string): string {
  const tempRoot = mkdtempSync(join(tmpdir(), "reporecall-production-gate-"));
  execFileSync("npm", ["init", "-y"], {
    cwd: tempRoot,
    stdio: "ignore",
  });
  execFileSync("npm", ["install", `${packageName}@${packageVersion}`], {
    cwd: tempRoot,
    stdio: "ignore",
  });
  return join(tempRoot, "node_modules", ...packageName.split("/"), "dist", "memory.js");
}

function runExplain(scriptPath: string, projectRoot: string, query: string): ExplainLikeResult {
  const stdout = execFileSync(
    "node",
    [scriptPath, "explain", "--project", projectRoot, "--json", query],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  return JSON.parse(stdout) as ExplainLikeResult;
}

function runVariant(fixture: ProductionFixture, variant: VariantConfig) {
  const suites = fixture.suites.map((suite) => {
    const queries = suite.queries.map((query) => {
      const projectRoot = resolve(process.cwd(), suite.projectRoot);
      const explain = runExplain(variant.scriptPath, projectRoot, query.query);
      const score = scorePromptResult(query, explain);
      return {
        id: query.id,
        query: query.query,
        expectedMode: query.expectedMode,
        explain,
        score,
      };
    });
    const totalScore = queries.reduce((sum, query) => sum + query.score.numericScore, 0);
    return {
      id: suite.id,
      totalQueries: suite.queries.length,
      totalScore,
      maxScore: suite.queries.length,
      passCount: queries.filter((query) => query.score.verdict === "pass").length,
      partialCount: queries.filter((query) => query.score.verdict === "partial").length,
      failCount: queries.filter((query) => query.score.verdict === "fail").length,
      queries,
    };
  });

  return {
    label: variant.label,
    suites,
    totalScore: suites.reduce((sum, suite) => sum + suite.totalScore, 0),
    maxScore: suites.reduce((sum, suite) => sum + suite.maxScore, 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixture = loadProductionFixture(resolve(process.cwd(), args.fixture));
  const localVariant: VariantConfig = {
    label: "local",
    scriptPath: resolve(process.cwd(), "dist/memory.js"),
  };

  const variants: VariantConfig[] = [localVariant];
  let installedTempRoot: string | null = null;

  if (args.compareInstalled) {
    const version = args.packageVersion || installedVersionFromPackageJson();
    const scriptPath = installPublishedScript(args.packageName, version);
    installedTempRoot = scriptPath.split("/node_modules/")[0] ?? null;
    variants.push({
      label: `installed:${version}`,
      scriptPath,
    });
  }

  const results = variants.map((variant) => runVariant(fixture, variant));
  const output = {
    fixture: args.fixture,
    generatedAt: new Date().toISOString(),
    results,
  };

  if (args.output) {
    writeFileSync(resolve(process.cwd(), args.output), JSON.stringify(output, null, 2));
  }

  for (const result of results) {
    const percent = result.maxScore > 0 ? (result.totalScore / result.maxScore) * 100 : 0;
    console.log(`\n${result.label}: ${result.totalScore.toFixed(1)}/${result.maxScore} (${percent.toFixed(1)}%)`);
    for (const suite of result.suites) {
      console.log(`  ${suite.id}: P ${suite.passCount} | PP ${suite.partialCount} | F ${suite.failCount}`);
    }
  }

  if (results.length === 2) {
    const [left, right] = results;
    console.log(`\nWinner: ${left.totalScore >= right.totalScore ? left.label : right.label}`);
    for (let suiteIndex = 0; suiteIndex < left.suites.length; suiteIndex += 1) {
      const leftSuite = left.suites[suiteIndex];
      const rightSuite = right.suites[suiteIndex];
      if (!leftSuite || !rightSuite) continue;
      for (let queryIndex = 0; queryIndex < leftSuite.queries.length; queryIndex += 1) {
        const leftQuery = leftSuite.queries[queryIndex];
        const rightQuery = rightSuite.queries[queryIndex];
        if (!leftQuery || !rightQuery || leftQuery.score.numericScore === rightQuery.score.numericScore) continue;
        const winner = leftQuery.score.numericScore > rightQuery.score.numericScore ? left.label : right.label;
        console.log(`  ${winner} better: ${leftQuery.id}`);
      }
    }
  }

  if (installedTempRoot) {
    rmSync(installedTempRoot, { recursive: true, force: true });
  }
}

void main();
