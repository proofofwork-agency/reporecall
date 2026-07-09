import { describe, it, expect } from "vitest";
import {
  compressEvidenceChunk,
  type EvidenceCompressionOptions,
} from "../../src/search/evidence-compressor.js";
import type { SearchResult } from "../../src/search/types.js";

function makeChunk(over: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "chk1",
    score: 1,
    filePath: "src/auth.ts",
    name: "authenticate",
    kind: "function",
    startLine: 10,
    endLine: 14,
    content: [
      "export function authenticate(user: string, token: string) {",
      "  if (!token) throw new Error('invalid token');",
      "  return verify(token);",
      "}",
    ].join("\n"),
    language: "typescript",
    ...over,
  };
}

const FULL_OPTIONS: EvidenceCompressionOptions = {
  query: "authenticate token",
  minChunkTokens: 0,
  targetRatio: 1,
};

function countEvidenceLines(text: string): number {
  const matches = text.match(/^  - L\d+: /gm);
  return matches ? matches.length : 0;
}

describe("compressEvidenceChunk", () => {
  it("returns a well-formed result with the required-options path", () => {
    const result = compressEvidenceChunk(makeChunk(), FULL_OPTIONS);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    expect(["code", "search_result", "config_or_data", "text"]).toContain(result.strategy);
    expect(result.strategy).toBe("code");
    expect(result.originalRef.chunkId).toBe("chk1");
    expect(result.originalRef.filePath).toBe("src/auth.ts");
    expect(result.originalRef.name).toBe("authenticate");
    expect(result.text).toContain("strategy: code");
  });

  it("exposes at least one selected evidence line for matching query terms", () => {
    const result = compressEvidenceChunk(makeChunk(), FULL_OPTIONS);
    expect(countEvidenceLines(result.text)).toBeGreaterThan(0);
    expect(result.text).toContain("authenticate");
  });

  it("caps selected evidence lines at the code-strategy limit (8)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      // Each line mentions the chunk name so it scores and becomes a candidate.
      lines.push(`export function authenticate_step_${i}() { return ${i}; }`);
    }
    const chunk = makeChunk({ content: lines.join("\n"), endLine: 10 + lines.length - 1 });

    const result = compressEvidenceChunk(chunk, FULL_OPTIONS);
    expect(countEvidenceLines(result.text)).toBeLessThanOrEqual(8);
  });

  it("does not crash with query only (no minChunkTokens/targetRatio semantics exercised)", () => {
    const result = compressEvidenceChunk(makeChunk(), {
      query: "authenticate",
      minChunkTokens: 0,
      targetRatio: 1,
    });
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("falls back to a summary line when no evidence line scores", () => {
    const chunk = makeChunk({
      content: "    \n    \n",
      name: "authenticate",
    });
    const result = compressEvidenceChunk(chunk, {
      query: undefined,
      minChunkTokens: 0,
      targetRatio: 1,
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain("chunkId");
  });
});
