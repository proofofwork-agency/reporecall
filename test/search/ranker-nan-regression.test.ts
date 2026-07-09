import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../../src/search/ranker.js";

function makeVector(...ids: string[]) {
  return ids.map((id, i) => ({ id, score: 1 - i * 0.1 }));
}

function makeKeyword(...ids: string[]) {
  return ids.map((id, i) => ({ id, rank: i + 1 }));
}

describe("reciprocalRankFusion — malformed recency date must not cascade NaN", () => {
  // regression: a single malformed date in chunkDates previously yielded NaN,
  // corrupting the entire result set via the non-transitive sort comparator.
  it("produces only finite scores and a strictly descending result set", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const ranked = reciprocalRankFusion(
      makeVector("a", "b", "c"),
      makeKeyword("a", "b", "c"),
      {
        vectorWeight: 0.5,
        keywordWeight: 0.3,
        recencyWeight: 0.5,
        k: 60,
        chunkDates: new Map([
          ["a", "not-a-date"],
          ["b", recent],
          ["c", recent],
        ]),
      }
    );

    for (const item of ranked) {
      expect(Number.isFinite(item.score)).toBe(true);
    }

    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  it("drops the malformed-date item's recency boost without zeroing its base score", () => {
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const ranked = reciprocalRankFusion(
      makeVector("a", "b"),
      makeKeyword("a", "b"),
      {
        vectorWeight: 0.5,
        keywordWeight: 0.3,
        recencyWeight: 0.5,
        k: 60,
        chunkDates: new Map([
          ["a", "not-a-date"],
          ["b", recent],
        ]),
      }
    );

    const a = ranked.find((r) => r.id === "a")!;
    expect(Number.isFinite(a.score)).toBe(true);
    expect(a.score).toBeGreaterThan(0);
  });
});

describe("reciprocalRankFusion — k validation fallback", () => {
  // regression: a non-positive / non-finite k produced Infinity or negative
  // RRF scores; it must fall back to the canonical 60.
  for (const badK of [-1, 0, NaN]) {
    it(`falls back to k=60 for k=${badK}`, () => {
      const ranked = reciprocalRankFusion(
        makeVector("a", "b"),
        makeKeyword("a", "b"),
        {
          vectorWeight: 0.5,
          keywordWeight: 0.3,
          recencyWeight: 0,
          k: badK,
        }
      );

      expect(ranked.length).toBe(2);
      for (const item of ranked) {
        expect(Number.isFinite(item.score)).toBe(true);
        expect(item.score).toBeGreaterThan(0);
      }
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
      }
    });
  }
});
