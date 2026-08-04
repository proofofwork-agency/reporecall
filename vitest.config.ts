import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 30000,
    // Benchmark/stress tests under test/benchmark/* measure latency and memory
    // and are unreliable when run concurrently with the rest of the suite
    // (contention inflates p95/heap numbers and causes flaky failures). They
    // are excluded from the default `npm test` run and executed in isolation
    // via the dedicated `npm run benchmark:memory` / stress scripts.
    exclude: ["**/node_modules/**", "**/dist/**", "test/benchmark/**"],
    poolOptions: {
      forks: {
        // Every worker loads tree-sitter WASM, lancedb and sqlite, and the
        // parser/deep-call-chain suites build very large inputs on top of that.
        // Under V8 coverage the CI runners die with "Fatal process out of
        // memory: Zone" — a V8 parser/compiler allocator failure driven by
        // total process memory, not by the old-space cap (raising
        // --max-old-space-size made it strictly worse: two concurrent workers
        // with larger heaps produced two OOMs instead of one). Serialize in CI
        // so one worker has the whole runner. The full suite still runs.
        maxForks: process.env.CI ? 1 : undefined,
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        statements: 66.38,
        branches: 57.13,
        functions: 71.67,
        lines: 69.01,
        "src/core/path-safety.ts": {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
