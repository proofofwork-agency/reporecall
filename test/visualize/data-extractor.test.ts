import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractDashboardData } from "../../src/visualize/data-extractor.js";

describe("extractDashboardData", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "reporecall-viz-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("uses the target project root for the Lens project name", () => {
    const metadata: any = {
      getAllChunks: () => [],
      getAllResolvedCallEdges: () => [],
      getAllCommunities: () => [],
      getGodNodes: () => [],
      getTopSurprises: () => [],
      getSuggestedQuestions: () => [],
      getCommunityForChunk: () => undefined,
      getStats: () => ({ totalFiles: 0, totalChunks: 0, languages: {} }),
      findCallers: () => [],
      findCallees: () => [],
    };

    const data = extractDashboardData(metadata, null, {
      projectRoot: join(dataDir, "target-project"),
    });

    expect(data.meta.projectName).toBe("target-project");
  });

  it("skips graph-heavy chunk loading when the index exceeds the Lens graph cap", () => {
    let loadedAllChunks = false;
    let loadedResolvedEdges = false;
    const metadata: any = {
      getAllChunks: () => {
        loadedAllChunks = true;
        throw new Error("getAllChunks should not be called for oversized Lens graphs");
      },
      getAllResolvedCallEdges: () => {
        loadedResolvedEdges = true;
        throw new Error("getAllResolvedCallEdges should not be called for oversized Lens graphs");
      },
      getAllCommunities: () => [
        {
          id: "c_1",
          label: "Large module",
          nodeCount: 75_000,
          cohesion: 0.5,
          computedAt: new Date().toISOString(),
        },
      ],
      getGodNodes: () => [],
      getTopSurprises: () => [],
      getSuggestedQuestions: () => [],
      getCommunityForChunk: () => undefined,
      getStats: () => ({ totalFiles: 75_000, totalChunks: 75_000, languages: {} }),
      findCallers: () => [],
      findCallees: () => [],
    };

    const data = extractDashboardData(metadata, null, {
      maxGraphChunks: 10,
      projectRoot: join(dataDir, "large-project"),
    });

    expect(loadedAllChunks).toBe(false);
    expect(loadedResolvedEdges).toBe(false);
    expect(data.meta.totalSymbols).toBe(75_000);
    expect(data.meta.totalEdges).toBe(0);
    expect(data.meta.graphDetails).toEqual({
      included: false,
      reason: "too_many_chunks",
      totalChunks: 75_000,
      maxGraphChunks: 10,
      edgeCount: 0,
    });
    expect(data.communities).toHaveLength(1);
    expect(data.communities[0]!.members).toEqual([]);
  });

  it("extracts business pages separately from wiki pages", () => {
    const businessFile = join(dataDir, "business-user-authentication.md");
    writeFileSync(businessFile, `---
name: business-user-authentication
description: Business capability view
type: wiki
pageType: business
---

## Capability
User Authentication

## Actor
Authenticated user

## Trigger
User opens the auth flow.

## Business terms
- User
- Session

## User-visible actions
- Start an authenticated product session.

## Key decision points
- Validate the session.

## State changes and side effects
- Refresh session state.

## Business outcome
Protected access is granted.

## Business / Data Concepts
- User
- Session

## External systems
- OAuth identity provider

## Confidence
High confidence.
`, "utf-8");

    const communityFile = join(dataDir, "community-auth-flow.md");
    writeFileSync(communityFile, `---
name: community-auth-flow
description: Community page
type: wiki
pageType: community
---

## Community
Auth flow
`, "utf-8");

    const memoryStore: any = {
      getByType: () => [
        {
          name: "business-user-authentication",
          description: "Business capability view",
          summary: "User Authentication - protected access is granted.",
          content: `## Capability
User Authentication

## Actor
Authenticated user

## Trigger
User opens the auth flow.

## Business terms
- User
- Session

## User-visible actions
- Start an authenticated product session.

## Key decision points
- Validate the session.

## State changes and side effects
- Refresh session state.

## Business outcome
Protected access is granted.

## Business / Data Concepts
- User
- Session

## External systems
- OAuth identity provider

## Confidence
High confidence.`,
          filePath: businessFile,
          relatedFiles: ["src/pages/Auth.tsx"],
          relatedSymbols: ["useAuth"],
          confidence: 0.88,
        },
        {
          name: "community-auth-flow",
          description: "Community page",
          summary: "Auth flow community",
          content: "## Community\nAuth flow",
          filePath: communityFile,
          relatedFiles: [],
          relatedSymbols: [],
          confidence: 0.9,
        },
      ],
      getWikiLinks: () => [],
      getWikiBacklinks: () => [],
      getByName: () => undefined,
    };

    const metadata: any = {
      getAllChunks: () => [],
      getAllResolvedCallEdges: () => [],
      getAllCommunities: () => [],
      getGodNodes: () => [],
      getTopSurprises: () => [],
      getSuggestedQuestions: () => [],
      getCommunityForChunk: () => undefined,
      getStats: () => ({ totalFiles: 0, totalChunks: 0, languages: {} }),
      findCallers: () => [],
      findCallees: () => [],
    };

    const data = extractDashboardData(metadata, memoryStore);

    expect(data.wikiPages).toHaveLength(2);
    expect(data.businessPages).toHaveLength(1);
    expect(data.businessPages[0]!.capability).toBe("User Authentication");
    expect(data.businessPages[0]!.displayName).toBe("User Authentication");
    expect(data.businessPages[0]!.displaySummary).toContain("Protected access is granted");
    expect(data.businessPages[0]!.businessTerms).toEqual(["User", "Session"]);
    expect(data.businessPages[0]!.userActions).toEqual(["Start an authenticated product session."]);
    expect(data.businessPages[0]!.dataConcepts).toEqual(["User", "Session"]);
    expect(data.businessPages[0]!.externalSystems).toEqual(["OAuth identity provider"]);
    expect(data.meta.businessPageCount).toBe(1);
    expect(data.productAreas).toHaveLength(1);
    expect(data.productAreas[0]!.name).toBe("Product Area: Authentication");
    expect(data.productAreas[0]!.displayName).toBe("Authentication");
    expect(data.productAreas[0]!.capabilities).toEqual(["User Authentication"]);
    expect(data.productAreas[0]!.technicalEvidence.files).toEqual(["src/pages/Auth.tsx"]);
    expect(data.productAreas[0]!.technicalEvidence.symbols).toEqual(["useAuth"]);
    expect(data.meta.productAreaCount).toBe(1);
  });

  it("aggregates business pages into business-facing product areas", () => {
    const insightsFile = join(dataDir, "business-insights-search-and-filtering.md");
    writeFileSync(insightsFile, `---
name: business-insights-search-and-filtering
description: Business capability view
type: wiki
pageType: business
---

## Capability
Insights Search and Filtering

## Actor
Operator or customer reviewing product information

## Trigger
A user asks the product to find insight data.

## Business terms
- Insights
- Search
- Filter

## User-visible actions
- Find, filter, or review product insights.

## Business outcome
The product returns a narrowed view of insight data.

## Business / Data Concepts
- Insights
- Search
`, "utf-8");

    const importFile = join(dataDir, "business-customer-data-import.md");
    writeFileSync(importFile, `---
name: business-customer-data-import
description: Business capability view
type: wiki
pageType: business
---

## Capability
Customer Data Import

## Actor
Operator or integration providing data to the product

## Trigger
A user submits data that needs to be accepted.

## Business terms
- Customer
- Import

## User-visible actions
- Submit or import data so it becomes available in the product.

## Business outcome
The product accepts incoming data.

## Business / Data Concepts
- Customer
- Import
`, "utf-8");

    const memoryStore: any = {
      getByType: () => [
        {
          name: "business-insights-search-and-filtering",
          description: "Business capability view",
          summary: "Insights Search and Filtering - narrowed insight data.",
          content: readFixture(insightsFile),
          filePath: insightsFile,
          relatedFiles: ["src/insights/filter.ts"],
          relatedSymbols: ["BuildInsightsQueryString"],
          confidence: 0.82,
        },
        {
          name: "business-customer-data-import",
          description: "Business capability view",
          summary: "Customer Data Import - accepts incoming data.",
          content: readFixture(importFile),
          filePath: importFile,
          relatedFiles: ["src/imports/import-service.ts"],
          relatedSymbols: ["ImportOrchestrationService"],
          confidence: 0.8,
        },
      ],
      getWikiLinks: () => [],
      getWikiBacklinks: () => [],
      getByName: () => undefined,
    };

    const metadata: any = {
      getAllChunks: () => [],
      getAllResolvedCallEdges: () => [],
      getAllCommunities: () => [],
      getGodNodes: () => [],
      getTopSurprises: () => [],
      getSuggestedQuestions: () => [],
      getCommunityForChunk: () => undefined,
      getStats: () => ({ totalFiles: 0, totalChunks: 0, languages: {} }),
      findCallers: () => [],
      findCallees: () => [],
    };

    const data = extractDashboardData(metadata, memoryStore);

    expect(data.productAreas.map((area) => area.name)).toEqual([
      "Product Area: Insights",
      "Product Area: Import",
    ]);
    expect(data.productAreas[0]!.businessPages).toEqual(["business-insights-search-and-filtering"]);
    expect(data.productAreas[0]!.supportingSymbols).toContain("BuildInsightsQueryString");
    expect(data.productAreas[0]!.displaySummary).toContain("Insights Search and Filtering");
  });
});

function readFixture(path: string): string {
  return readFileSync(path, "utf-8").replace(/^---[\s\S]*?---\n/, "");
}
