import { describe, expect, it } from "vitest";
import {
  buildBusinessContextFromMemoryStore,
  buildProductAreas,
  deriveBusinessDisplayName,
  evaluateBusinessPresentation,
  formatProductAreaContextForPrompt,
  queryBusinessContext,
  type BusinessContextPage,
} from "../../src/business/product-areas.js";

describe("product area business context", () => {
  it("groups business capability pages into product-facing areas", () => {
    const areas = buildProductAreas([
      businessPage({
        name: "business-insights-search-and-filtering",
        capability: "Insights Search and Filtering",
        businessTerms: ["Insights", "Search", "Filter"],
        supportingSymbols: ["BuildInsightsQueryString"],
      }),
      businessPage({
        name: "business-customer-data-import",
        capability: "Customer Data Import",
        businessTerms: ["Customer", "Import"],
        supportingSymbols: ["ImportOrchestrationService"],
      }),
    ]);

    expect(areas.map((area) => area.name)).toEqual([
      "Product Area: Insights",
      "Product Area: Import",
    ]);
    expect(areas.map((area) => area.areaKind)).toEqual(["fixed", "fixed"]);
    expect(areas[0]!.supportingSymbols).toContain("BuildInsightsQueryString");
  });

  it("discovers domain product areas from business terms without fixed family vocabulary", () => {
    const areas = buildProductAreas([
      businessPage({
        name: "business-risk-ranking-dashboard",
        capability: "Dashboard Risk Ranking",
        businessTerms: ["Risk Score", "Classification"],
        dataConcepts: ["Risk Score", "Classification"],
        supportingSymbols: ["BuildDashboardQueryString"],
      }),
      businessPage({
        name: "business-risk-score-export",
        capability: "Risk Score Export",
        businessTerms: ["Risk Score", "Export"],
        dataConcepts: ["Risk Score"],
        supportingSymbols: ["ExportRiskScoreReport"],
      }),
    ]);

    expect(areas[0]!.name).toBe("Product Area: Risk Score");
    expect(areas[0]!.areaKind).toBe("discovered");
    expect(areas[0]!.businessPages).toEqual([
      "business-risk-ranking-dashboard",
      "business-risk-score-export",
    ]);
  });

  it("keeps technical evidence explicit while exposing business display fields", () => {
    const areas = buildProductAreas([
      businessPage({
        name: "business-insights-pivot-state",
        capability: "Frontend: BuildInsightsQueryString, ParsePivotState",
        summary: "Frontend: BuildInsightsQueryString, ParsePivotState coordinates insight filtering.",
        businessTerms: ["Insights", "Filter"],
        dataConcepts: ["Insight", "Pivot"],
        supportingFiles: ["src/insights/build-query.ts"],
        supportingSymbols: ["BuildInsightsQueryString", "ParsePivotState"],
      }),
    ]);

    expect(areas[0]!.displayName).toBe("Insights");
    expect(areas[0]!.capabilities).toEqual(["Insights filtering and pivot views"]);
    expect(areas[0]!.displaySummary).toContain("Insights filtering and pivot views");
    expect(areas[0]!.presentationSafe).toBe(true);
    expect(areas[0]!.technicalEvidence).toEqual({
      files: ["src/insights/build-query.ts"],
      symbols: ["BuildInsightsQueryString", "ParsePivotState"],
    });
  });

  it("does not let supporting upload/file evidence steal an insights page", () => {
    const areas = buildProductAreas([
      businessPage({
        name: "business-insights-delivery",
        capability: "Insights Delivery",
        summary: "Returns a narrowed insight view for review.",
        businessTerms: ["Insights", "Dashboard", "Report"],
        dataConcepts: ["Insight", "Metric"],
        externalSystems: ["Object storage"],
        supportingFiles: ["src/upload/storage-writer.ts"],
        supportingSymbols: ["UploadFile", "WriteFile"],
      }),
      businessPage({
        name: "business-media-upload",
        capability: "Media Upload",
        businessTerms: ["Upload", "File"],
        dataConcepts: ["File", "Storage"],
        supportingFiles: ["src/upload.ts"],
      }),
    ]);

    const insights = areas.find((area) => area.name === "Product Area: Insights");
    const upload = areas.find((area) => area.name === "Product Area: Upload");

    expect(insights?.businessPages).toContain("business-insights-delivery");
    expect(upload?.businessPages).toEqual(["business-media-upload"]);
  });

  it("ranks fixed product areas over broad discovered areas for business context queries", () => {
    const context = {
      productAreas: buildProductAreas([
        businessPage({
          name: "business-insights-dashboard",
          capability: "Analytics Dashboard",
          summary: "Shows insight charts and reporting views.",
          businessTerms: ["Insights", "Dashboard", "Report"],
          dataConcepts: ["Insight", "Metric"],
        }),
        businessPage({
          name: "business-shared-risk-score",
          capability: "Risk Score Review",
          businessTerms: ["Risk Score"],
          dataConcepts: ["Risk Score"],
        }),
      ]),
      businessPages: [
        businessPage({
          name: "business-insights-dashboard",
          capability: "Analytics Dashboard",
          summary: "Shows insight charts and reporting views.",
          businessTerms: ["Insights", "Dashboard", "Report"],
          dataConcepts: ["Insight", "Metric"],
        }),
        businessPage({
          name: "business-shared-risk-score",
          capability: "Risk Score Review",
          businessTerms: ["Risk Score"],
          dataConcepts: ["Risk Score"],
        }),
      ],
    };

    const result = queryBusinessContext("insights dashboard risk score chart", context, 5);

    expect(result.productAreas[0]?.name).toBe("Product Area: Insights");
    expect(result.productAreas[0]?.areaKind).toBe("fixed");
  });

  it("keeps technical fallback pages unique but out of business-safe query results", () => {
    const page = businessPage({
      name: "business-shared-retry-helper",
      capability: "Backend: WithRetry, ProcessRequest",
      summary: "Backend: WithRetry, ProcessRequest coordinates retry helper work.",
      supportingSymbols: ["WithRetry", "ProcessRequest"],
      confidence: 0.65,
    });
    const context = {
      productAreas: buildProductAreas([page]),
      businessPages: [page],
    };

    expect(page.displayName).not.toBe("Supporting product behavior");
    expect(page.displayQuality).toBe("fallback");
    expect(page.presentationSafe).toBe(false);
    expect(queryBusinessContext("retry request", context, 5).businessPages).toEqual([]);
  });

  it("keeps product area summaries populated from safe child pages", () => {
    const areas = buildProductAreas([
      businessPage({
        name: "business-insights-dashboard",
        capability: "Analytics Dashboard",
        summary: "Shows insight charts and reporting views.",
        businessTerms: ["Insights", "Dashboard", "Report"],
        userActions: ["Review dashboard charts"],
        businessOutcome: "Users review insight charts and reports.",
        dataConcepts: ["Insight", "Metric", "Pivot"],
      }),
    ]);

    expect(areas[0]!.name).toBe("Product Area: Insights");
    expect(areas[0]!.presentationSafe).toBe(true);
    expect(areas[0]!.displaySummary).toContain("Analytics Dashboard");
    expect(areas[0]!.displaySummary).not.toMatch(/groups related product behavior inferred/i);
  });

  it("does not let unsafe fallback areas fill business context results", () => {
    const page = businessPage({
      name: "business-shared-runner",
      capability: "Backend: GenericServiceRunner",
      summary: "Generic service runner.",
      supportingSymbols: ["GenericServiceRunner"],
      confidence: 0.61,
    });
    const context = {
      productAreas: buildProductAreas([page]),
      businessPages: [page],
    };

    expect(context.productAreas[0]!.presentationSafe).toBe(false);
    expect(queryBusinessContext("generic runner", context, 5)).toEqual({
      productAreas: [],
      businessPages: [],
    });
  });

  it("queries product areas and business pages without exposing unrelated wiki pages", () => {
    const memoryStore = {
      getByType: () => [
        {
          name: "business-user-authentication",
          description: "Business capability view",
          summary: "User Authentication grants protected access.",
          content: `## Capability
User Authentication

## Actor
Product user

## Trigger
User starts login or resumes a session.

## Business terms
- User
- Session

## User-visible actions
- Sign in.

## Business outcome
Protected access is granted.

## Business / Data Concepts
- User
- Session

## External systems
- Identity provider`,
          relatedFiles: ["src/auth.ts"],
          relatedSymbols: ["useAuth"],
          confidence: 0.88,
        },
        {
          name: "community-auth-flow",
          description: "Community page",
          summary: "Technical auth community",
          content: "## Community\nAuth flow",
          relatedFiles: [],
          relatedSymbols: [],
          confidence: 0.9,
        },
      ],
    };

    const context = buildBusinessContextFromMemoryStore(memoryStore as any);
    const result = queryBusinessContext("login session authentication", context, 5);

    expect(context.businessPages).toHaveLength(1);
    expect(result.productAreas[0]!.name).toBe("Product Area: Authentication");
    expect(result.businessPages[0]!.name).toBe("business-user-authentication");
  });

  it("does not rank unrelated areas from generic implementation wording alone", () => {
    const context = {
      productAreas: buildProductAreas([
        businessPage({
          name: "business-customer-data-import",
          capability: "Customer Data Import",
          businessTerms: ["Customer", "Import"],
          supportingFiles: ["src/import.ts"],
        }),
      ]),
      businessPages: [
        businessPage({
          name: "business-customer-data-import",
          capability: "Customer Data Import",
          businessTerms: ["Customer", "Import"],
          supportingFiles: ["src/import.ts"],
        }),
      ],
    };

    const result = queryBusinessContext("which files implement authentication", context, 5);

    expect(result.productAreas).toEqual([]);
    expect(result.businessPages).toEqual([]);
  });

  it("lets a strongly-discovered domain area override a weak fixed match", () => {
    const areas = buildProductAreas([
      businessPage({
        name: "business-wallet-topup-pricing",
        capability: "Wallet Topup",
        summary: "Wallet topup keeps the operator balance positive.",
        businessTerms: ["Wallet Topup", "Wallet Topup", "Pricing"],
        dataConcepts: ["Wallet Topup", "Wallet Topup"],
      }),
    ]);

    expect(areas[0]!.areaKind).toBe("discovered");
    expect(areas[0]!.name).toBe("Product Area: Wallet Topup");
  });

  it("keeps the fixed match when the discovered margin is below the override threshold", () => {
    const areas = buildProductAreas([
      businessPage({
        name: "business-billing-pricing-portal",
        capability: "Billing Pricing Portal",
        summary: "Customers manage billing, pricing and subscription portal.",
        businessTerms: ["Billing", "Pricing", "Subscription", "Wallet Topup"],
        dataConcepts: ["Wallet Topup"],
      }),
    ]);

    expect(areas[0]!.areaKind).toBe("fixed");
    expect(areas[0]!.name).toBe("Product Area: Billing");
  });

  it("formats a compact prompt section for agent context", () => {
    const area = buildProductAreas([
      businessPage({
        name: "business-media-upload",
        capability: "Media Upload",
        businessTerms: ["Upload", "File"],
        supportingFiles: ["src/upload.ts"],
      }),
    ])[0]!;

    const text = formatProductAreaContextForPrompt([area], 1);

    expect(text).toContain("## Product area evidence");
    expect(text).toContain("Product Area: Upload");
    expect(text).toContain("Evidence files: src/upload.ts");
  });
});

function businessPage(overrides: Partial<BusinessContextPage>): BusinessContextPage {
  const capability = overrides.capability ?? "General Product Capability";
  const supportingFiles = overrides.supportingFiles ?? [];
  const supportingSymbols = overrides.supportingSymbols ?? [];
  const businessTerms = overrides.businessTerms ?? [];
  const dataConcepts = overrides.dataConcepts ?? [];
  const displayName = overrides.displayName ?? deriveBusinessDisplayName({
    name: overrides.name ?? "business-general",
    capability,
    businessTerms,
    dataConcepts,
    supportingSymbols,
  });
  const displaySummary = overrides.displaySummary ?? `${displayName}: The product completes the capability.`;
  const presentation = evaluateBusinessPresentation({
    name: overrides.name ?? "business-general",
    capability,
    displayName,
    displaySummary,
    businessTerms,
    userActions: overrides.userActions ?? [],
    businessOutcome: overrides.businessOutcome ?? "The product completes the capability.",
    dataConcepts,
    supportingSymbols,
    confidence: overrides.confidence ?? 0.82,
  });
  return {
    name: "business-general",
    capability,
    displayName,
    summary: "A product capability inferred from code evidence.",
    displaySummary,
    ...presentation,
    actor: "Product user",
    trigger: "A user action starts this capability.",
    businessTerms,
    userActions: [],
    businessOutcome: "The product completes the capability.",
    dataConcepts,
    externalSystems: [],
    confidence: 0.82,
    confidenceLabel: "high",
    supportingFiles,
    supportingSymbols,
    technicalEvidence: {
      files: supportingFiles,
      symbols: supportingSymbols,
    },
    links: [],
    ...overrides,
  };
}
