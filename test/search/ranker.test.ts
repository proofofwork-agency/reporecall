import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../../src/search/ranker.js";

function makeVector(...ids: string[]) {
  return ids.map((id, i) => ({ id, score: 1 - i * 0.1 }));
}

function makeKeyword(...ids: string[]) {
  return ids.map((id, i) => ({ id, rank: i + 1 }));
}

const BASE_OPTS = {
  vectorWeight: 0.5,
  keywordWeight: 0.3,
  recencyWeight: 0,
  k: 60,
};

describe("reciprocalRankFusion — test penalty", () => {
  const testPaths = [
    "test/foo.test.ts",
    "spec/bar.spec.ts",
    "__tests__/baz.ts",
    "benchmark/runner.ts",
    "e2e/helpers/auth.ts",
    "src/utils.test.ts",
    "lib/helper.spec.js",
  ];

  for (const path of testPaths) {
    it(`applies penalty to ${path}`, () => {
      const ranked = reciprocalRankFusion(
        makeVector("a", "b"),
        makeKeyword("a", "b"),
        {
          ...BASE_OPTS,
          chunkFilePaths: new Map([
            ["a", path],
            ["b", "src/core.ts"],
          ]),
          testPenaltyFactor: 0.3,
        }
      );
      const scoreA = ranked.find((r) => r.id === "a")!.score;
      const scoreB = ranked.find((r) => r.id === "b")!.score;
      // Both start with same base score; test penalty should push a below b
      expect(scoreA).toBeLessThan(scoreB);
    });
  }

  const extraTestPaths = [
    "examples/demo.ts",
    "benchmark.ts",
    "fixtures/data.json",
    "__fixtures__/mock.ts",
    "demo.js",
  ];

  for (const path of extraTestPaths) {
    it(`applies penalty to ${path}`, () => {
      const ranked = reciprocalRankFusion(
        makeVector("a", "b"),
        makeKeyword("a", "b"),
        {
          ...BASE_OPTS,
          chunkFilePaths: new Map([
            ["a", path],
            ["b", "src/core.ts"],
          ]),
          testPenaltyFactor: 0.3,
        }
      );
      const scoreA = ranked.find((r) => r.id === "a")!.score;
      const scoreB = ranked.find((r) => r.id === "b")!.score;
      expect(scoreA).toBeLessThan(scoreB);
    });
  }

  it("does not penalize src/benchmark-utils.ts", () => {
    const ranked = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([["a", "src/benchmark-utils.ts"]]),
        testPenaltyFactor: 0.3,
      }
    );
    const noPenalty = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      { ...BASE_OPTS }
    );
    expect(ranked[0].score).toBe(noPenalty[0].score);
  });

  it("does not penalize src/ paths", () => {
    const ranked = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([["a", "src/foo.ts"]]),
        testPenaltyFactor: 0.3,
      }
    );
    // Score should equal base RRF (no penalty applied)
    const noPenalty = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      { ...BASE_OPTS }
    );
    expect(ranked[0].score).toBe(noPenalty[0].score);
  });

  it("factor of 1.0 is a no-op", () => {
    const ranked = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([["a", "test/foo.test.ts"]]),
        testPenaltyFactor: 1.0,
      }
    );
    const noPenalty = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      { ...BASE_OPTS }
    );
    expect(ranked[0].score).toBe(noPenalty[0].score);
  });
});

describe("reciprocalRankFusion — anonymous penalty", () => {
  it("applies penalty to <anonymous> chunks", () => {
    const ranked = reciprocalRankFusion(
      makeVector("a", "b"),
      makeKeyword("a", "b"),
      {
        ...BASE_OPTS,
        chunkNames: new Map([
          ["a", "<anonymous>"],
          ["b", "fetchData"],
        ]),
        anonymousPenaltyFactor: 0.5,
      }
    );
    const scoreA = ranked.find((r) => r.id === "a")!.score;
    const scoreB = ranked.find((r) => r.id === "b")!.score;
    expect(scoreA).toBeLessThan(scoreB);
  });

  it("does not penalize named chunks", () => {
    const ranked = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      {
        ...BASE_OPTS,
        chunkNames: new Map([["a", "fetchData"]]),
        anonymousPenaltyFactor: 0.5,
      }
    );
    const noPenalty = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      { ...BASE_OPTS }
    );
    expect(ranked[0].score).toBe(noPenalty[0].score);
  });

  it("factor of 1.0 is a no-op", () => {
    const ranked = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      {
        ...BASE_OPTS,
        chunkNames: new Map([["a", "<anonymous>"]]),
        anonymousPenaltyFactor: 1.0,
      }
    );
    const noPenalty = reciprocalRankFusion(
      makeVector("a"),
      makeKeyword("a"),
      { ...BASE_OPTS }
    );
    expect(ranked[0].score).toBe(noPenalty[0].score);
  });
});

describe("reciprocalRankFusion — query-term path boost", () => {
  it("boosts chunks whose directory path matches query terms", () => {
    const ranked = reciprocalRankFusion(
      makeVector("a", "b"),
      makeKeyword("a", "b"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([
          ["a", "supabase/functions/generate-storyboard-orchestrated/index.ts"],
          ["b", "src/editor/components/waveform.ts"],
        ]),
        chunkNames: new Map([
          ["a", "handler"],
          ["b", "waveformWorker"],
        ]),
        queryTerms: ["storyboard", "orchestrator"],
      }
    );
    const scoreA = ranked.find((r) => r.id === "a")!.score;
    const scoreB = ranked.find((r) => r.id === "b")!.score;
    // "storyboard" matches a's path → 1.3x boost; b has no match
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it("boosts natural-language auth terms via code-facing aliases", () => {
    const ranked = reciprocalRankFusion(
      makeVector("flow", "auth"),
      makeKeyword("flow", "auth"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([
          ["flow", "src/lib/flow/flowService.ts"],
          ["auth", "src/hooks/useAuth.tsx"],
        ]),
        chunkNames: new Map([
          ["flow", "stripBunnyCDNSigningParams"],
          ["auth", "AuthProvider"],
        ]),
        queryTerms: ["add", "every", "step", "authentication", "flow", "log", "message"],
      }
    );
    const topId = ranked[0]?.id;
    expect(topId).toBe("auth");
  });
});

describe("reciprocalRankFusion — low coverage ratio dampens boost", () => {
  it("dampens query-term boost when coverage ratio < 0.5", () => {
    // 7 query terms, chunk matches only 2 via substring → ratio 2/7 = 0.28
    const ranked = reciprocalRankFusion(
      makeVector("a", "b"),
      makeKeyword("a", "b"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([
          ["a", "src/lib/flow/flowservice.ts"],
          ["b", "src/auth/middleware.ts"],
        ]),
        chunkNames: new Map([
          ["a", "stripBunnyCDNSigningParams"],
          ["b", "handler"],
        ]),
        queryTerms: ["add", "every", "step", "authentication", "flow", "log", "message"],
      }
    );
    const scoreA = ranked.find((r) => r.id === "a")!.score;
    const scoreB = ranked.find((r) => r.id === "b")!.score;
    // "a" matches "flow" (path) and "sign" is NOT a query term — only "flow" matches
    // With 1/7 coverage, boost should be dampened heavily
    // scoreA should NOT dominate scoreB despite the path match
    expect(scoreA / scoreB).toBeLessThan(1.3);
  });
});

describe("reciprocalRankFusion — stacked penalties", () => {
  it("both penalties stack (0.3 × 0.5 = 0.15x)", () => {
    const ranked = reciprocalRankFusion(
      makeVector("a", "b"),
      makeKeyword("a", "b"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([
          ["a", "test/foo.test.ts"],
          ["b", "src/core.ts"],
        ]),
        chunkNames: new Map([
          ["a", "<anonymous>"],
          ["b", "fetchData"],
        ]),
        testPenaltyFactor: 0.3,
        anonymousPenaltyFactor: 0.5,
      }
    );
    const scoreA = ranked.find((r) => r.id === "a")!.score;
    const scoreB = ranked.find((r) => r.id === "b")!.score;
    // a gets 0.3 * 0.5 = 0.15x; b gets no penalty
    // With same base scores, a should be ~15% of b
    expect(scoreA / scoreB).toBeCloseTo(0.15, 1);
  });
});

describe("reciprocalRankFusion — broad query mode", () => {
  it("penalizes generic-only broad matches against family-aligned results", () => {
    const ranked = reciprocalRankFusion(
      makeVector("generic", "family"),
      makeKeyword("generic", "family"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([
          ["generic", "src/lib/flow/flowService.ts"],
          ["family", "src/pages/AuthCallback.tsx"],
        ]),
        chunkNames: new Map([
          ["generic", "flowHandler"],
          ["family", "AuthCallback"],
        ]),
        queryTerms: ["add", "to", "every", "step", "in", "the", "authentication", "flow", "a", "log", "message"],
        broadQuery: true,
      }
    );

    expect(ranked[0]?.id).toBe("family");
  });

  it("keeps exact identifier routing stable when broad mode is off", () => {
    const ranked = reciprocalRankFusion(
      makeVector("explicit", "broad"),
      makeKeyword("explicit", "broad"),
      {
        ...BASE_OPTS,
        chunkFilePaths: new Map([
          ["explicit", "src/search/pipeline.ts"],
          ["broad", "src/lib/flow/flowService.ts"],
        ]),
        chunkNames: new Map([
          ["explicit", "searchPipeline"],
          ["broad", "flowHandler"],
        ]),
        queryTerms: ["where", "is", "searchPipeline"],
      }
    );

    expect(ranked[0]?.id).toBe("explicit");
  });
});
