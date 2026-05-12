import { describe, expect, it } from "vitest";
import { suggestWikiPages } from "../../src/wiki/suggestions.js";

describe("wiki page suggestions", () => {
  it("suggests replacement pages for stale generated slugs", () => {
    const store = {
      getByType: () => [
        wikiPage({
          name: "product-area-insights",
          summary: "Insights covers analytics dashboards and reporting.",
          content: "Dashboard charts and reports help users review metrics.",
          confidence: 0.86,
        }),
        wikiPage({
          name: "related-domain-dashboard",
          summary: "Dashboard domain page with chart concepts.",
          content: "Charts, metrics, and dashboard views.",
          confidence: 0.78,
        }),
        wikiPage({
          name: "business-upload",
          summary: "Upload accepts incoming files.",
          content: "File intake and storage.",
          confidence: 0.82,
        }),
      ],
    };

    const suggestions = suggestWikiPages(store, "business-analytics-dashboard", 3);

    expect(suggestions.map((page) => page.name)).toEqual(expect.arrayContaining([
      "product-area-insights",
      "related-domain-dashboard",
    ]));
    expect(suggestions[0]!.matchedTerms).toContain("dashboard");
  });
});

function wikiPage(overrides: any): any {
  return {
    id: overrides.name,
    name: overrides.name,
    description: overrides.summary,
    summary: overrides.summary,
    content: overrides.content,
    type: "wiki",
    filePath: `/tmp/${overrides.name}.md`,
    relatedFiles: [],
    relatedSymbols: [],
    confidence: overrides.confidence ?? 0.8,
  };
}
