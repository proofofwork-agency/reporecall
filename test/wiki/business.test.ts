import { describe, expect, it } from "vitest";
import { buildBusinessPages } from "../../src/wiki/business.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(opts: {
  id?: string;
  label?: string;
  nodeCount?: number;
  cohesion?: number;
  members: { name: string; filePath: string; kind?: string }[];
  hubs?: { chunkId?: string; name: string; filePath: string; degree?: number; communityId?: string }[];
  surprises?: { sourceChunkId?: string; targetChunkId?: string; score?: number; reasons?: string[]; relation?: string | null; computedAt?: string }[];
}) {
  return {
    community: {
      id: opts.id ?? "c-test",
      label: opts.label ?? "test community",
      nodeCount: opts.nodeCount ?? opts.members.length + (opts.hubs?.length ?? 0),
      cohesion: opts.cohesion ?? 0.75,
      computedAt: new Date().toISOString(),
    },
    members: opts.members.map((m) => ({
      name: m.name,
      filePath: m.filePath,
      kind: m.kind ?? "function_declaration",
    })),
    hubs: (opts.hubs ?? []).map((h) => ({
      chunkId: h.chunkId ?? "hub-1",
      name: h.name,
      filePath: h.filePath,
      degree: h.degree ?? 10,
      communityId: h.communityId ?? opts.id ?? "c-test",
    })),
    surprises: (opts.surprises ?? []).map((s) => ({
      sourceChunkId: s.sourceChunkId ?? "s1",
      targetChunkId: s.targetChunkId ?? "t1",
      score: s.score ?? 0.9,
      reasons: s.reasons ?? ["cross-boundary"],
      relation: s.relation ?? null,
      computedAt: s.computedAt ?? new Date().toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Positive path: every capability family
// ---------------------------------------------------------------------------

describe("buildBusinessPages", () => {
  it("derives an authentication capability from code evidence", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-auth",
        label: "auth flow",
        nodeCount: 8,
        cohesion: 0.83,
        members: [
          { name: "handleLogin", filePath: "src/pages/Auth.tsx" },
          { name: "handleAuthCallback", filePath: "src/pages/AuthCallback.tsx" },
          { name: "ProtectedRoute", filePath: "src/components/ProtectedRoute.tsx" },
        ],
        hubs: [{ chunkId: "h1", name: "useAuth", filePath: "src/hooks/useAuth.tsx", degree: 12 }],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe("business-user-authentication");
    expect(pages[0]!.content).toContain("## Actor");
    expect(pages[0]!.content).toContain("Authenticated user or OAuth client");
    expect(pages[0]!.content).toContain("## Business terms");
    expect(pages[0]!.content).toContain("## User-visible actions");
    expect(pages[0]!.content).toContain("## Business / Data Concepts");
    expect(pages[0]!.content).toContain("## Business outcome");
    expect(pages[0]!.businessTerms).toContain("User");
    expect(pages[0]!.userActions.join(" ")).toContain("authenticated product session");
    expect(pages[0]!.dataConcepts).toContain("User");
    expect(pages[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("derives a media generation capability", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-gen",
        label: "image generation",
        members: [
          { name: "generateImage", filePath: "src/generation/generateImage.ts" },
          { name: "renderAsset", filePath: "src/generation/render.ts" },
          { name: "upscalePrompt", filePath: "src/media/upscale.ts" },
        ],
        hubs: [{ name: "mediaPipeline", filePath: "src/generation/pipeline.ts" }],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe("business-media-generation-request");
    expect(pages[0]!.content).toContain("Product user requesting generated output");
    expect(pages[0]!.content).toContain("## Business outcome");
    expect(pages[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("derives a published flow execution capability", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-flow",
        label: "workflow engine",
        members: [
          { name: "publishWorkflow", filePath: "src/workflows/publish.ts" },
          { name: "executeWorkflow", filePath: "src/workflows/execute.ts" },
          { name: "openFlowEditor", filePath: "src/editor/editor.ts" },
        ],
        hubs: [{ name: "runFlow", filePath: "src/workflows/runtime.ts" }],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe("business-published-flow-execution");
    expect(pages[0]!.content).toContain("Creator or end user running a saved workflow");
    expect(pages[0]!.content).toContain("## Business outcome");
    expect(pages[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("derives a bot and messaging capability", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-bot",
        label: "telegram bot",
        members: [
          { name: "handleTelegramWebhook", filePath: "src/bot/telegram.ts" },
          { name: "dispatchMessage", filePath: "src/bot/dispatcher.ts" },
          { name: "sendChatReply", filePath: "src/chat/reply.ts" },
        ],
        hubs: [{ name: "botRouter", filePath: "src/bot/index.ts" }],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe("business-bot-and-messaging-operations");
    expect(pages[0]!.content).toContain("Chat user or external messaging platform");
    expect(pages[0]!.content).toContain("## Business outcome");
    expect(pages[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("derives a billing and pricing capability", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-billing",
        label: "billing and credits",
        members: [
          { name: "chargeCredits", filePath: "src/billing/stripe.ts" },
          { name: "lookupPricing", filePath: "src/billing/pricing.ts" },
          { name: "createCheckoutSession", filePath: "src/checkout/session.ts" },
        ],
        hubs: [{ name: "updateBalance", filePath: "src/billing/ledger.ts" }],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe("business-credits-billing-and-pricing");
    expect(pages[0]!.content).toContain("Paying user or billing subsystem");
    expect(pages[0]!.content).toContain("## Business outcome");
    expect(pages[0]!.externalSystems).toContain("Stripe");
    expect(pages[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("derives an async job tracking capability", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-jobs",
        label: "background jobs",
        members: [
          { name: "enqueueJob", filePath: "src/jobs/queue.ts" },
          { name: "runWorker", filePath: "src/jobs/worker.ts" },
          { name: "pollJobStatus", filePath: "src/jobs/status.ts" },
        ],
        hubs: [{ name: "retryJob", filePath: "src/jobs/retry.ts" }],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe("business-async-job-tracking");
    expect(pages[0]!.content).toContain("Background worker or polling client");
    expect(pages[0]!.content).toContain("## Business outcome");
    expect(pages[0]!.confidence).toBeGreaterThan(0.7);
  });

  // -------------------------------------------------------------------------
  // Negative path: dev-tool vocabulary must not trip product families
  // -------------------------------------------------------------------------

  it("does not produce an auth page for a memory-store community", () => {
    // Symbol names contain "session" (1 auth keyword) but file paths have
    // no auth path hints — should NOT qualify for auth family (needs pathHint + 1
    // OR 3+ distinct keywords).
    const pages = buildBusinessPages([
      makeSource({
        id: "c-memory",
        label: "memory storage",
        members: [
          { name: "storeSession", filePath: "src/memory/memory-store.ts" },
          { name: "loadRecord", filePath: "src/memory/chunk-store.ts" },
          { name: "forgetEntry", filePath: "src/memory/record-store.ts" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).not.toBe("business-user-authentication");
    expect(pages[0]!.confidence).toBeLessThan(0.7);
  });

  it("does not produce a media-generation page for a wiki generator community", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-wiki",
        label: "wiki generator",
        members: [
          { name: "generateWikiPages", filePath: "src/wiki/generator.ts" },
          { name: "renderMarkdown", filePath: "src/wiki/pages.ts" },
          { name: "buildWikiContent", filePath: "src/wiki/context.ts" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).not.toBe("business-media-generation-request");
    expect(pages[0]!.confidence).toBeLessThanOrEqual(0.72);
  });

  it("does not produce a flow page for a daemon/storage community", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-daemon",
        label: "daemon internals",
        members: [
          { name: "buildFlowSummary", filePath: "src/daemon/mcp-server.ts" },
          { name: "flowCache", filePath: "src/storage/metadata-store.ts" },
          { name: "bootstrapDaemon", filePath: "src/daemon/index.ts" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).not.toBe("business-published-flow-execution");
  });

  it("does not produce an auth page for reporecall hook/indexer infra symbols", () => {
    // Tool-internal symbols inside src/hooks/, src/indexer/, src/search/ that
    // happen to mention session/credentials must NOT cross the auth family
    // threshold — they are dev infra, not authentication code.
    const pages = buildBusinessPages([
      makeSource({
        id: "c-tool-infra",
        label: "session hooks",
        members: [
          { name: "onSessionStart", filePath: "src/hooks/session-start.ts" },
          { name: "loadCredentials", filePath: "src/indexer/credentials.ts" },
          { name: "lookupSessionToken", filePath: "src/search/intent.ts" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).not.toBe("business-user-authentication");
  });

  it("still classifies downstream React useAuth hooks as auth", () => {
    // Regression for the v0.7.1 anti-pattern fix: the auth negative regex used
    // to demote any path containing `/hooks/`, which incorrectly suppressed
    // legitimate downstream React `src/hooks/useAuth.tsx`. The demotion is now
    // anchored on Claude Code lifecycle filenames so React auth hooks still
    // classify as user authentication.
    const pages = buildBusinessPages([
      makeSource({
        id: "c-react-auth",
        label: "react auth flow",
        members: [
          { name: "useAuth", filePath: "src/hooks/useAuth.tsx" },
          { name: "useSession", filePath: "src/hooks/useSession.tsx" },
          { name: "handleLogin", filePath: "src/pages/Login.tsx" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe("business-user-authentication");
    expect(pages[0]!.relatedFiles).toContain("src/hooks/useAuth.tsx");
  });

  // -------------------------------------------------------------------------
  // Weak generic cluster stays bounded (existing test, now with helper)
  // -------------------------------------------------------------------------

  it("keeps weak generic clusters bounded", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-generic",
        label: "shared helpers",
        nodeCount: 3,
        cohesion: 0.41,
        members: [
          { name: "buildPayload", filePath: "src/lib/helpers/buildPayload.ts" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.content).toContain("## Confidence");
    expect(pages[0]!.content).toContain("bounded business interpretation");
    expect(pages[0]!.confidence).toBeLessThan(0.7);
  });

  // -------------------------------------------------------------------------
  // Metadata filter
  // -------------------------------------------------------------------------

  it("skips communities whose only members are metadata files", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-meta",
        label: "project config",
        members: [
          { name: "claudeRoot", filePath: "CLAUDE.md" },
          { name: "pkgRoot", filePath: "package.json" },
          { name: "tsConfig", filePath: "tsconfig.json" },
          { name: "readmeRoot", filePath: "README.md" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(0);
  });

  it("keeps business API fields additive for downstream tools", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-intake",
        label: "customer report upload",
        members: [
          { name: "uploadCustomerReport", filePath: "src/uploads/report-upload.ts" },
          { name: "storeUploadedFile", filePath: "src/storage/files.ts" },
          { name: "showUploadStatus", filePath: "src/reports/status.ts" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.businessTerms.length).toBeGreaterThan(0);
    expect(pages[0]!.userActions.length).toBeGreaterThan(0);
    expect(pages[0]!.dataConcepts).toEqual(expect.arrayContaining(["File", "Upload"]));
    expect(pages[0]!.content).toContain("## Business / Data Concepts");
  });

  it("translates technical insight query symbols into product-facing capability language", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-insights",
        label: "BuildInsightsQueryString",
        members: [
          { name: "BuildInsightsQueryString", filePath: "src/insights/build-query-string.ts" },
          { name: "applyInsightsFilters", filePath: "src/insights/filter-insights.ts" },
          { name: "renderInsightsDashboard", filePath: "src/insights/dashboard.tsx" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toBe("Insights Search and Filtering");
    expect(pages[0]!.slug).toBe("business-insights-search-and-filtering");
    expect(pages[0]!.summary).not.toContain("BuildInsightsQueryString");
    expect(pages[0]!.content).toContain("Find, filter, or review product insights.");
    expect(pages[0]!.content).not.toContain("## Capability\nBuildInsightsQueryString");
    expect(pages[0]!.relatedSymbols).toContain("BuildInsightsQueryString");
  });

  it("translates orchestration service names into business import language", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-import",
        label: "ImportOrchestrationService",
        members: [
          { name: "ImportOrchestrationService", filePath: "src/imports/import-orchestration-service.ts" },
          { name: "validateImportPayload", filePath: "src/imports/validate-import.ts" },
          { name: "persistImportedCustomers", filePath: "src/customers/imported-customers.ts" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toBe("Customer Data Import");
    expect(pages[0]!.slug).toBe("business-customer-data-import");
    expect(pages[0]!.summary).not.toContain("ImportOrchestrationService");
    expect(pages[0]!.content).toContain("Submit or import data so it becomes available in the product.");
    expect(pages[0]!.content).not.toContain("## Capability\nImportOrchestrationService");
    expect(pages[0]!.relatedSymbols).toContain("ImportOrchestrationService");
  });

  it("does not expose frontend service/modal labels as business capability content", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-account-ui",
        label: "Example Frontend: UsersService, EditUserModal",
        members: [
          { name: "UsersService", filePath: "src/account/users-service.ts" },
          { name: "EditUserModal", filePath: "src/account/edit-user-modal.tsx" },
          { name: "saveUserRole", filePath: "src/account/user-role.ts" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toBe("Account and User Management");
    expect(pages[0]!.slug).toBe("business-account-and-user-management");
    expect(pages[0]!.summary).not.toContain("UsersService");
    expect(pages[0]!.content).not.toContain("Example Frontend");
    expect(pages[0]!.content).not.toContain("UsersService");
    expect(pages[0]!.content).not.toContain("EditUserModal");
    expect(pages[0]!.relatedSymbols).toContain("UsersService");
  });

  it("strips metadata files from mixed communities but keeps real files", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-mixed",
        label: "auth flow",
        members: [
          { name: "handleLogin", filePath: "src/pages/Auth.tsx" },
          { name: "pkgRoot", filePath: "package.json" },
          { name: "readmeRoot", filePath: "README.md" },
          { name: "useAuth", filePath: "src/hooks/useAuth.tsx" },
        ],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.relatedFiles).toContain("src/pages/Auth.tsx");
    expect(pages[0]!.relatedFiles).not.toContain("package.json");
    expect(pages[0]!.relatedFiles).not.toContain("README.md");
  });

  // -------------------------------------------------------------------------
  // Grammar regression: bridge connects / bridges connect
  // -------------------------------------------------------------------------

  it("uses singular grammar for 1 surprise bridge", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-auth",
        label: "auth flow",
        members: [
          { name: "handleLogin", filePath: "src/pages/Auth.tsx" },
          { name: "handleAuthCallback", filePath: "src/pages/AuthCallback.tsx" },
          { name: "ProtectedRoute", filePath: "src/components/ProtectedRoute.tsx" },
        ],
        surprises: [{}],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.content).toContain("1 surprising bridge connects");
    expect(pages[0]!.content).not.toContain("bridge connect this");
  });

  it("uses plural grammar for multiple surprise bridges", () => {
    const pages = buildBusinessPages([
      makeSource({
        id: "c-auth",
        label: "auth flow",
        members: [
          { name: "handleLogin", filePath: "src/pages/Auth.tsx" },
          { name: "handleAuthCallback", filePath: "src/pages/AuthCallback.tsx" },
          { name: "ProtectedRoute", filePath: "src/components/ProtectedRoute.tsx" },
        ],
        surprises: [{}, {}],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    expect(pages[0]!.content).toContain("2 surprising bridges connect");
    expect(pages[0]!.content).not.toContain("bridges connects");
  });

  // -------------------------------------------------------------------------
  // Confidence ceiling: keyword-only match capped at 0.72
  // -------------------------------------------------------------------------

  it("caps keyword-only family matches at medium confidence (0.72)", () => {
    // All members in src/core/ with generic filenames — no auth path hints.
    // Symbol names carry 4+ distinct auth keywords, qualifying via the >=3
    // keyword fallback. With 5 files, 1 hub, and 5+ symbols the base formula
    // would exceed 0.72 if not for the keyword-only ceiling.
    const pages = buildBusinessPages([
      makeSource({
        id: "c-ceiling",
        label: "core module",
        members: [
          { name: "handleAuth", filePath: "src/core/module-a.ts" },
          { name: "checkLogin", filePath: "src/core/module-b.ts" },
          { name: "refreshSession", filePath: "src/core/module-c.ts" },
          { name: "validatePassword", filePath: "src/core/module-d.ts" },
          { name: "authorizeUser", filePath: "src/core/module-e.ts" },
        ],
        hubs: [{ name: "authBridge", filePath: "src/core/bridge.ts" }],
      }),
    ], 10);

    expect(pages).toHaveLength(1);
    // Keyword-only match ceiling
    expect(pages[0]!.confidence).toBeLessThanOrEqual(0.72);
    // Should still be classified as auth (keyword fallback with >=3 distinct)
    expect(pages[0]!.slug).toBe("business-user-authentication");
  });
});
