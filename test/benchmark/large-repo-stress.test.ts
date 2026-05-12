import { describe, expect, it } from "vitest";
import { evaluateStressBudgets } from "../../scripts/benchmarks/large-repo-stress.js";

function makeReport(overrides: any = {}): any {
  return {
    timingsMs: {
      lensExtract: 25,
      ...overrides.timingsMs,
    },
    results: {
      noChange: {
        filesProcessed: 0,
        chunksCreated: 0,
        ...overrides.results?.noChange,
      },
    },
    memory: {
      peakHeapUsedMb: 128,
      peakRssMb: 512,
      ...overrides.memory,
    },
  };
}

describe("large-repo stress budgets", () => {
  it("passes when all measured values are within budget", () => {
    const failures = evaluateStressBudgets(makeReport(), {
      maxHeapMb: 256,
      maxRssMb: 768,
      maxNoChangeFiles: 0,
      maxLensMs: 100,
    });

    expect(failures).toEqual([]);
  });

  it("reports every exceeded budget", () => {
    const failures = evaluateStressBudgets(
      makeReport({
        timingsMs: { lensExtract: 250 },
        results: { noChange: { filesProcessed: 3 } },
        memory: { peakHeapUsedMb: 300, peakRssMb: 900 },
      }),
      {
        maxHeapMb: 256,
        maxRssMb: 768,
        maxNoChangeFiles: 0,
        maxLensMs: 100,
      }
    );

    expect(failures).toHaveLength(4);
    expect(failures.join("\n")).toContain("peak heap 300 MB exceeded budget 256 MB");
    expect(failures.join("\n")).toContain("peak RSS 900 MB exceeded budget 768 MB");
    expect(failures.join("\n")).toContain("no-change index processed 3 files, budget 0");
    expect(failures.join("\n")).toContain("Lens extraction 250 ms exceeded budget 100 ms");
  });
});
