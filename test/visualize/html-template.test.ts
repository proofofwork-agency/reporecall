import { describe, expect, it } from "vitest";
import { generateHTML } from "../../src/visualize/html-template.js";
import type { DashboardData } from "../../src/visualize/types.js";

describe("generateHTML", () => {
  it("renders business pages in the lens dashboard", () => {
    const data: DashboardData = {
      meta: {
        projectName: "Example",
        generatedAt: "2026-05-09T00:00:00.000Z",
        totalSymbols: 0,
        totalFiles: 0,
        totalEdges: 0,
        communityCount: 0,
        wikiPageCount: 1,
        businessPageCount: 1,
        productAreaCount: 1,
        hubCount: 0,
        surpriseCount: 0,
      },
      communities: [],
      hubs: [],
      surprises: [],
      questions: [],
      wikiPages: [
        {
          name: "business-user-authentication",
          pageType: "business",
          description: "Business capability view",
          summary: "User Authentication",
          content: "## Capability\nUser Authentication",
          links: [],
          backlinks: [],
          relatedSymbols: ["useAuth"],
          relatedFiles: ["src/auth.ts"],
          confidence: 0.88,
          sourceCommit: "abc123",
        },
      ],
      wikiGraphNodes: [],
      wikiGraphEdges: [],
      businessPages: [
        {
          name: "business-user-authentication",
          capability: "User Authentication",
          displayName: "User Authentication",
          description: "Business capability view",
          summary: "User Authentication - protected access.",
          displaySummary: "User Authentication: Protected access is granted.",
          actor: "Authenticated user",
          trigger: "User opens the auth flow.",
          businessTerms: ["User", "Session"],
          userActions: ["Start an authenticated product session."],
          decisionPoints: ["Validate the session."],
          sideEffects: ["Refresh session state."],
          businessOutcome: "Protected access is granted.",
          dataConcepts: ["User", "Session"],
          externalSystems: ["OAuth identity provider"],
          confidence: 0.88,
          confidenceLabel: "high",
          supportingFiles: ["src/auth.ts"],
          supportingSymbols: ["useAuth"],
          technicalEvidence: {
            files: ["src/auth.ts"],
            symbols: ["useAuth"],
          },
          links: [],
          content: "## Capability\nUser Authentication",
        },
      ],
      productAreas: [
        {
          id: "auth",
          name: "Product Area: Authentication",
          displayName: "Authentication",
          areaKind: "fixed",
          summary: "Authentication groups User Authentication.",
          displaySummary: "Authentication covers User Authentication.",
          businessTerms: ["User", "Session"],
          capabilities: ["User Authentication"],
          businessPages: ["business-user-authentication"],
          supportingFiles: ["src/auth.ts"],
          supportingSymbols: ["useAuth"],
          confidence: 0.9,
          confidenceLabel: "high",
          technicalEvidence: {
            files: ["src/auth.ts"],
            symbols: ["useAuth"],
          },
        },
      ],
      chordMatrix: [],
      chordLabels: [],
      chordColors: [],
    };

    const html = generateHTML(data);

    expect(html).toContain('data-tab="business"');
    expect(html).toContain('data-tab="product-areas"');
    expect(html).toContain("Product Areas");
    expect(html).toContain("Product Area: Authentication");
    expect(html).toContain("Business Capabilities");
    expect(html).toContain("Business Pages");
    expect(html).toContain("renderBusinessPages()");
    expect(html).toContain("User Authentication");
  });
});
