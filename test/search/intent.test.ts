import { describe, it, expect } from "vitest";
import { classifyIntent, deriveRoute } from "../../src/search/intent.js";
import type { QueryIntent } from "../../src/search/intent.js";

// ── Helpers ───────────────────────────────────────────────────────

function expectSkip(query: string) {
  const intent = classifyIntent(query);
  expect(intent.isCodeQuery, `"${query}" should NOT be a code query`).toBe(false);
  expect(deriveRoute(intent)).toBe("skip");
}

function expectR0(query: string) {
  const intent = classifyIntent(query);
  expect(intent.isCodeQuery, `"${query}" should be a code query`).toBe(true);
  expect(intent.needsNavigation, `"${query}" should NOT need navigation`).toBe(false);
  expect(deriveRoute(intent)).toBe("R0");
}

function expectNav(query: string) {
  const intent = classifyIntent(query);
  expect(intent.isCodeQuery, `"${query}" should be a code query`).toBe(true);
  expect(intent.needsNavigation, `"${query}" should need navigation`).toBe(true);
  // Without seed confidence, navigational queries default to R0
  expect(deriveRoute(intent)).toBe("R0");
}

// ── Skip (meta / non-code) ───────────────────────────────────────

describe("classifyIntent — skip (non-code)", () => {
  const skipCases = [
    "hello",
    "hi",
    "hi there",
    "hey",
    "hey!",
    "good morning",
    "good afternoon",
    "good evening",
    "thanks",
    "thank you",
    "thanks!",
    "am I using memory?",
    "are you using memory",
    "what was in the injected tokens?",
    "what was injected",
    "did reporecall run?",
    "what model are you?",
    "summarize our conversation",
    "how many tokens were injected?",
    "how many tokens were used",
    "what did we discuss",
    "tell me a joke",
    "",
    "  ",
    "hi",
    "yo",
  ];

  for (const q of skipCases) {
    it(`skips "${q}"`, () => expectSkip(q));
  }

  it("sets skipReason for empty queries", () => {
    const intent = classifyIntent("");
    expect(intent.skipReason).toBe("empty or too short");
  });

  it("sets skipReason for non-code queries", () => {
    const intent = classifyIntent("hello");
    expect(intent.skipReason).toBe("non-code query");
  });
});

// ── R0 (direct code queries) ─────────────────────────────────────

describe("classifyIntent — R0 (direct code)", () => {
  const r0Cases = [
    "show me the AST graph",
    "where is validateToken?",
    "what does sanitizeQuery do?",
    "find the CallEdgeStore class",
    "show me the search pipeline",
    "what is MemoryConfig?",
    "list all MCP tools",
    "read src/daemon/server.ts",
    "show the imports in parser.ts",
    "what types are exported from search/types.ts?",
    "find usages of reciprocalRankFusion",
    "where is the vitest config?",
  ];

  for (const q of r0Cases) {
    it(`routes "${q}" to R0`, () => expectR0(q));
  }
});

// ── Navigational (needsNavigation = true) ─────────────────────────

describe("classifyIntent — navigational", () => {
  const navCases = [
    "how does auth work?",
    "how does the search pipeline flow?",
    "how do hooks get registered?",
    "how is the call graph built?",
    "why does AuthService.login fail?",
    "why is the call graph noisy?",
    "why do tests timeout?",
    "what happens when a hook fires?",
    "what happens if the index is stale?",
    "trace the request from hook to assembly",
    "who calls findCallers?",
    "what calls reciprocalRankFusion?",
    "called by the daemon",
    "debug the token counting issue",
    "the search is broken",
    "failing tests in indexer",
    "there's an error in the parser",
    "explain the architecture",
    "describe the design of the chunker",
  ];

  for (const q of navCases) {
    it(`marks "${q}" as navigational`, () => expectNav(q));
  }
});

// ── Edge cases that must NOT skip ─────────────────────────────────

describe("classifyIntent — edge cases (must NOT skip)", () => {
  const mustNotSkip = [
    "how does this project handle authentication?",
    "what does this codebase do?",
    "fix the bug in auth",
    "write tests for search",
    "refactor the chunker",
    "add error handling to the parser",
    "improve the search ranking",
    "update the hook system",
    "can you explain the indexer module?",
    "show me how the daemon works",
    "how many tokens does countTokens reserve?",
    "what was injected into middleware.ts?",
  ];

  for (const q of mustNotSkip) {
    it(`does NOT skip "${q}"`, () => {
      const intent = classifyIntent(q);
      expect(intent.isCodeQuery, `"${q}" should be a code query`).toBe(true);
    });
  }
});

// ── deriveRoute with seedConfidence ───────────────────────────────

describe("deriveRoute — with seedConfidence", () => {
  it("returns skip for non-code", () => {
    expect(deriveRoute({ isCodeQuery: false, needsNavigation: false })).toBe("skip");
  });

  it("returns R0 for direct code query", () => {
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: false })).toBe("R0");
  });

  it("returns R0 for navigational without seedConfidence", () => {
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: true })).toBe("R0");
  });

  it("returns R1 when seedConfidence >= 0.55", () => {
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: true }, 0.55)).toBe("R1");
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: true }, 0.7)).toBe("R1");
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: true }, 0.95)).toBe("R1");
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: true }, 1.0)).toBe("R1");
  });

  it("returns R2 when seedConfidence < 0.55", () => {
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: true }, 0.54)).toBe("R2");
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: true }, 0.5)).toBe("R2");
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: true }, 0.0)).toBe("R2");
  });

  it("0.55 is the exact boundary for navigational R1", () => {
    const nav: QueryIntent = { isCodeQuery: true, needsNavigation: true };
    expect(deriveRoute(nav, 0.55)).toBe("R1");
    expect(deriveRoute(nav, 0.5499)).toBe("R2");
  });

  it("returns R0 for non-navigational even with seedConfidence", () => {
    expect(deriveRoute({ isCodeQuery: true, needsNavigation: false }, 0.9)).toBe("R0");
  });
});
