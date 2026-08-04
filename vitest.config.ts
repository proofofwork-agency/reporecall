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
        // Every worker loads tree-sitter WASM, lancedb and sqlite, so peak
        // memory scales with worker count. At the default of one fork per core
        // the 4-core CI runners die with "Fatal process out of memory: Zone"
        // once V8 coverage instrumentation is added on top. Cap concurrency in
        // CI only — the whole suite still runs, just less of it at once.
        maxForks: process.env.CI ? 2 : undefined,
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
