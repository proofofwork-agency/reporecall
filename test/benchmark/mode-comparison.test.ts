import { describe, it, afterAll } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runBenchmark, printResults, type BenchmarkResults } from "./runner.js";

const BENCHMARK_ROOT = join(tmpdir(), `memory-benchmark-${Date.now()}`);

describe("mode comparison benchmark", { timeout: 300_000 }, () => {
  const allResults: BenchmarkResults[] = [];

  afterAll(() => {
    if (allResults.length > 0) {
      printResults(allResults);
    }
    rmSync(BENCHMARK_ROOT, { recursive: true, force: true });
  });

  for (const size of ["small", "medium", "large"] as const) {
    it(`benchmarks ${size} codebase`, async () => {
      const dir = join(BENCHMARK_ROOT, size);
      mkdirSync(dir, { recursive: true });
      const results = await runBenchmark(size, dir);
      allResults.push(results);
    });
  }
});
