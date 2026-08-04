import { describe, it, expect } from "vitest";
import { searchWikiPages } from "../../src/hooks/prompt-context-enrichment.js";
import type { MemorySearchResult } from "../../src/memory/types.js";

function makeWikiPage(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    score: 0.9,
    name: "hub-updatenode",
    description: "Hub page for UpdateNode",
    type: "wiki",
    status: "active",
    summary: "One of the most connected symbols in the codebase.",
    content: "## Hub Node\nUpdateNode is a hub.",
    // Nonexistent path: the business-page probe reads this file and treats an
    // unreadable page as non-business, which is what we want here.
    filePath: "/nonexistent/.memory/memories/hub-updatenode.md",
    indexedAt: "2026-08-04T00:00:00.000Z",
    fileMtime: "2026-08-04T00:00:00.000Z",
    accessCount: 0,
    lastAccessed: "2026-08-04T00:00:00.000Z",
    importance: 1,
    tags: "",
    relatedFiles: ["src/components/flow/nodes/UpdateNode.tsx"],
    ...overrides,
  };
}

function makeMemorySearch(results: MemorySearchResult[]): any {
  return { search: async () => results };
}

describe("searchWikiPages — wiki relevance on precise lookups", () => {
  it("drops a wiki page that is not anchored to the injected code on a lookup", async () => {
    // "where is subscription-update implemented" must not pull in the UpdateNode
    // hub just because both share the token "update".
    const assembled = await searchWikiPages(
      "where is subscription-update implemented",
      makeMemorySearch([makeWikiPage()]),
      400,
      {
        queryMode: "lookup",
        topCodeFiles: ["supabase/functions/subscription-update/index.ts"],
      }
    );

    expect(assembled?.text ?? "").toBe("");
    expect(assembled?.pageNames ?? []).toEqual([]);
  });

  it("keeps a wiki page anchored to a file we actually inject", async () => {
    const assembled = await searchWikiPages(
      "where is subscription-update implemented",
      makeMemorySearch([
        makeWikiPage({
          name: "hub-subscriptionupdate",
          relatedFiles: ["supabase/functions/subscription-update/index.ts"],
        }),
      ]),
      400,
      {
        queryMode: "lookup",
        topCodeFiles: ["supabase/functions/subscription-update/index.ts"],
      }
    );

    expect(assembled?.pageNames).toEqual(["hub-subscriptionupdate"]);
  });

  it("still injects broad overview pages for architecture queries", async () => {
    // Breadth queries are the case overview pages exist for, so the anchor
    // requirement must not apply there.
    const assembled = await searchWikiPages(
      "how does the upload media flow work",
      makeMemorySearch([makeWikiPage()]),
      400,
      {
        queryMode: "architecture",
        topCodeFiles: ["supabase/functions/upload-media/index.ts"],
      }
    );

    expect(assembled?.pageNames).toEqual(["hub-updatenode"]);
  });

  it("keeps a page with no file anchor — no anchor is not evidence of irrelevance", async () => {
    const assembled = await searchWikiPages(
      "where is subscription-update implemented",
      makeMemorySearch([makeWikiPage({ name: "community-billing", relatedFiles: [] })]),
      400,
      {
        queryMode: "lookup",
        topCodeFiles: ["supabase/functions/subscription-update/index.ts"],
      }
    );

    expect(assembled?.pageNames).toEqual(["community-billing"]);
  });
});
