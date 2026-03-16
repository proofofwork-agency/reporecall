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
