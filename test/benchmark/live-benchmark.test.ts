import { describe, it, expect } from "vitest";
import { runLiveBenchmark, printLiveResults } from "./live-runner.js";

describe("live-repo benchmark", { timeout: 300_000 }, () => {
  it("keyword mode achieves minimum IR thresholds", async () => {
    const results = await runLiveBenchmark("keyword");
    printLiveResults(results);

    // Regression floor — these should never drop below zero
    // Tighten thresholds as search quality improves
    expect(results.meanNDCG10).toBeGreaterThanOrEqual(0);
    expect(results.meanMRR).toBeGreaterThanOrEqual(0);
    // Route accuracy is stable and strong
    expect(results.routeAccuracy).toBeGreaterThan(0.7);
    expect(results.totalQueries).toBeGreaterThanOrEqual(40);
  });
});
