import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { runLiveBenchmark, printLiveResults } from "./live-runner.js";

const hasAnnotations = (() => {
  try {
    const ann = JSON.parse(readFileSync("benchmark/annotations.json", "utf-8"));
    return Array.isArray(ann.queries) && ann.queries.length >= 40;
  } catch { return false; }
})();

describe("live-repo benchmark", { timeout: 300_000 }, () => {
  it.skipIf(!hasAnnotations)("keyword mode achieves minimum IR thresholds", async () => {
    const results = await runLiveBenchmark("keyword");
    printLiveResults(results);

    // Regression floor — ~80% of observed values with production pipeline + concept bundles
    expect(results.meanNDCG10).toBeGreaterThanOrEqual(0.35);
    expect(results.meanMRR).toBeGreaterThanOrEqual(0.50);
    expect(results.meanMAP).toBeGreaterThanOrEqual(0.18);
    // Route accuracy
    expect(results.routeAccuracy).toBeGreaterThan(70);
    expect(results.totalQueries).toBeGreaterThanOrEqual(40);
  });
});
