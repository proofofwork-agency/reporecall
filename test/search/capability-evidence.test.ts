import { describe, expect, it } from "vitest";
import {
  hasPrimaryCapabilityFamilyForQuery,
  hydrateCapabilityEvidenceFiles,
  resolveCapabilityEvidence,
  type CapabilityWikiPage,
} from "../../src/search/capability-evidence.js";
import type { SearchResult } from "../../src/search/types.js";
import type { StoredChunk } from "../../src/storage/types.js";

const now = new Date().toISOString();

function chunk(filePath: string, name: string, content = ""): StoredChunk {
  return {
    id: `${filePath}:${name}`,
    filePath,
    name,
    kind: "function_declaration",
    startLine: 1,
    endLine: 20,
    content: content || `export function ${name}() {}`,
    language: "typescript",
    indexedAt: now,
    isExported: true,
  };
}

function result(filePath: string, name: string, score = 1): SearchResult {
  const c = chunk(filePath, name);
  return {
    id: c.id,
    score,
    filePath,
    name,
    kind: c.kind,
    startLine: c.startLine,
    endLine: c.endLine,
    content: c.content,
    language: c.language,
  };
}

function makeMetadata(chunks: StoredChunk[]) {
  const byFile = new Map<string, StoredChunk[]>();
  for (const c of chunks) {
    const existing = byFile.get(c.filePath) ?? [];
    existing.push(c);
    byFile.set(c.filePath, existing);
  }
  return {
    findChunksByFilePath: (filePath: string) => byFile.get(filePath) ?? [],
    getAllChunks: () => chunks,
    getImportsForFile: () => [],
    findImporterFiles: () => [],
    findCallers: () => [],
    findCallees: () => [],
    findCalleesForChunk: () => [],
  };
}

function paths(files: Array<{ filePath: string }>): string[] {
  return files.map((file) => file.filePath);
}

describe("capability evidence resolver", () => {
  it("uses auth capability wiki related files plus mandatory route/session files", () => {
    const metadata = makeMetadata([
      chunk("src/pages/LoginPage.tsx", "LoginPage"),
      chunk("src/routes/OAuthCallbackPage.tsx", "OAuthCallbackPage"),
      chunk("src/state/sessionProvider.tsx", "SessionProvider"),
      chunk("src/components/LoginDialog.tsx", "LoginDialog"),
      chunk("src/routes/RequireSession.tsx", "RequireSession", "export function RequireSession() { return session guard; }"),
      chunk("src/main.tsx", "main", "SessionProvider RequireSession OAuthCallbackPage"),
    ]);
    const wikiPages: CapabilityWikiPage[] = [{
      name: "business-user-authentication",
      summary: "User authentication capability",
      relatedFiles: [
        "src/pages/LoginPage.tsx",
        "src/routes/OAuthCallbackPage.tsx",
        "src/state/sessionProvider.tsx",
        "src/routes/RequireSession.tsx",
      ],
      score: 0.9,
    }];

    const evidence = resolveCapabilityEvidence({
      query: "which files implement the authentication flow",
      queryMode: "architecture",
      topCodeChunks: [result("src/pages/LoginPage.tsx", "LoginPage")],
      wikiPages,
      metadata,
      maxFiles: 10,
    });

    expect(paths(evidence.files)).toEqual(expect.arrayContaining([
      "src/pages/LoginPage.tsx",
      "src/routes/OAuthCallbackPage.tsx",
      "src/state/sessionProvider.tsx",
      "src/components/LoginDialog.tsx",
      "src/routes/RequireSession.tsx",
      "src/main.tsx",
    ]));
    expect(evidence.files.find((file) => file.filePath === "src/state/sessionProvider.tsx")?.selectionSource).toBe("wiki_capability");
  });

  it("selects billing UI, services, controller, and server functions", () => {
    const metadata = makeMetadata([
      chunk("src/pages/AccountBilling.tsx", "AccountBilling"),
      chunk("src/services/paymentService.ts", "paymentService"),
      chunk("src/controllers/subscriptionController.ts", "subscriptionController"),
      chunk("server/functions/create-checkout-session/index.ts", "serve_handler"),
      chunk("server/functions/customer-portal/index.ts", "serve_handler"),
      chunk("server/functions/update-subscription/index.ts", "serve_handler"),
    ]);

    const evidence = resolveCapabilityEvidence({
      query: "trace the full billing portal and checkout flow from UI to edge function",
      queryMode: "trace",
      topCodeChunks: [result("src/pages/AccountBilling.tsx", "AccountBilling")],
      wikiPages: [{
        name: "business-credits-billing-and-pricing",
        relatedFiles: [
          "src/services/paymentService.ts",
          "src/controllers/subscriptionController.ts",
          "server/functions/create-checkout-session/index.ts",
          "server/functions/customer-portal/index.ts",
          "server/functions/update-subscription/index.ts",
        ],
      }],
      metadata,
      maxFiles: 10,
    });

    expect(paths(evidence.files)).toEqual(expect.arrayContaining([
      "src/pages/AccountBilling.tsx",
      "src/services/paymentService.ts",
      "src/controllers/subscriptionController.ts",
      "server/functions/create-checkout-session/index.ts",
      "server/functions/customer-portal/index.ts",
      "server/functions/update-subscription/index.ts",
    ]));
  });

  it("selects asset generation UI, state, and server orchestrators", () => {
    const metadata = makeMetadata([
      chunk("src/components/AssetGenerator.tsx", "AssetGenerator"),
      chunk("src/hooks/useAssetGeneration.ts", "useAssetGeneration"),
      chunk("src/store/generationStore.ts", "generationStore"),
      chunk("server/functions/render-controller/index.ts", "serve_handler"),
      chunk("server/functions/render-image/index.ts", "serve_handler"),
    ]);

    const evidence = resolveCapabilityEvidence({
      query: "trace image generation through the asset rendering flow",
      queryMode: "trace",
      topCodeChunks: [result("src/components/AssetGenerator.tsx", "AssetGenerator")],
      wikiPages: [{
        name: "business-media-generation-request",
        relatedFiles: [
          "src/hooks/useAssetGeneration.ts",
          "src/store/generationStore.ts",
          "server/functions/render-controller/index.ts",
          "server/functions/render-image/index.ts",
        ],
      }],
      metadata,
      maxFiles: 10,
    });

    expect(paths(evidence.files)).toEqual(expect.arrayContaining([
      "src/components/AssetGenerator.tsx",
      "src/hooks/useAssetGeneration.ts",
      "src/store/generationStore.ts",
      "server/functions/render-controller/index.ts",
      "server/functions/render-image/index.ts",
    ]));
  });

  it("selects upload media endpoint and shared auth/storage helpers", () => {
    const metadata = makeMetadata([
      chunk("server/functions/upload-file/index.ts", "serve_handler"),
      chunk("server/functions/_shared/request-auth.ts", "requireUser"),
      chunk("server/functions/_shared/storage-writer.ts", "writeMedia"),
      chunk("src/lib/media/uploadRequest.ts", "buildUploadRequest"),
    ]);

    const evidence = resolveCapabilityEvidence({
      query: "trace the full upload media flow from request auth to storage write",
      queryMode: "trace",
      topCodeChunks: [result("server/functions/upload-file/index.ts", "serve_handler")],
      wikiPages: [{
        name: "business-media-upload",
        relatedFiles: [
          "server/functions/_shared/request-auth.ts",
          "server/functions/_shared/storage-writer.ts",
          "src/lib/media/uploadRequest.ts",
        ],
      }],
      metadata,
      maxFiles: 10,
    });

    expect(paths(evidence.files)).toEqual(expect.arrayContaining([
      "server/functions/upload-file/index.ts",
      "server/functions/_shared/request-auth.ts",
      "server/functions/_shared/storage-writer.ts",
      "src/lib/media/uploadRequest.ts",
    ]));
  });

  it("includes capability evidence for lookup queries with a matching family signal", () => {
    const metadata = makeMetadata([chunk("src/state/sessionProvider.tsx", "SessionProvider")]);
    const evidence = resolveCapabilityEvidence({
      query: "where is the session provider defined",
      queryMode: "lookup",
      topCodeChunks: [result("src/state/sessionProvider.tsx", "SessionProvider")],
      wikiPages: [{ name: "business-user-authentication", relatedFiles: ["src/state/sessionProvider.tsx"] }],
      metadata,
    });
    expect(paths(evidence.files)).toContain("src/state/sessionProvider.tsx");
  });

  it("includes lookup evidence when no family but query anchors match the file path", () => {
    const metadata = makeMetadata([
      chunk("src/storage/fts-store.ts", "rebuildFtsIndex"),
    ]);
    const evidence = resolveCapabilityEvidence({
      query: "where is the fts rebuild scheduled",
      queryMode: "lookup",
      topCodeChunks: [result("src/storage/fts-store.ts", "rebuildFtsIndex")],
      wikiPages: [],
      metadata,
    });
    expect(hasPrimaryCapabilityFamilyForQuery("where is the fts rebuild scheduled")).toBe(false);
    expect(paths(evidence.files)).toContain("src/storage/fts-store.ts");
  });

  it("rejects lookup evidence when no family and query anchors miss the file path", () => {
    const metadata = makeMetadata([
      chunk("src/visualize/html-template.ts", "renderHtmlTemplate"),
    ]);
    const evidence = resolveCapabilityEvidence({
      query: "where is the fts rebuild scheduled",
      queryMode: "lookup",
      topCodeChunks: [result("src/visualize/html-template.ts", "renderHtmlTemplate")],
      wikiPages: [],
      metadata,
    });
    expect(paths(evidence.files)).not.toContain("src/visualize/html-template.ts");
    expect(evidence.files).toHaveLength(0);
  });

  it("rejects architecture evidence when no family and anchors miss the seed file", () => {
    const metadata = makeMetadata([
      chunk("src/visualize/html-template.ts", "renderHtmlTemplate"),
    ]);
    const evidence = resolveCapabilityEvidence({
      query: "which files implement the indexer pipeline",
      queryMode: "architecture",
      topCodeChunks: [result("src/visualize/html-template.ts", "renderHtmlTemplate")],
      wikiPages: [],
      metadata,
    });
    expect(paths(evidence.files)).not.toContain("src/visualize/html-template.ts");
  });

  it("uses generic query-anchored evidence for subsystem architecture without wiki pages", () => {
    const metadata = makeMetadata([
      chunk("src/modules/risk-scoring/risk-scoring.service.ts", "RiskScoringService"),
      chunk("src/modules/risk-scoring/lane-assigner.ts", "LaneAssigner"),
      chunk("src/modules/risk-scoring/scorers/classification.scorer.ts", "ClassificationScorer"),
      chunk("src/jobs/processors/risk-scoring.processor.ts", "RiskScoringProcessor"),
      chunk("src/jobs/producers/risk-scoring-pipeline.producer.ts", "RiskScoringPipelineProducer"),
      chunk("src/modules/search/search-bar.tsx", "SearchBar"),
    ]);

    const evidence = resolveCapabilityEvidence({
      query: "which files implement risk scoring, scorers, lane assignment, and the background pipeline",
      queryMode: "architecture",
      topCodeChunks: [result("src/jobs/processors/risk-scoring.processor.ts", "RiskScoringProcessor")],
      wikiPages: [],
      metadata,
      maxFiles: 10,
    });

    expect(hasPrimaryCapabilityFamilyForQuery("which files implement risk scoring")).toBe(false);
    expect(paths(evidence.files)).toEqual(expect.arrayContaining([
      "src/modules/risk-scoring/risk-scoring.service.ts",
      "src/modules/risk-scoring/lane-assigner.ts",
      "src/modules/risk-scoring/scorers/classification.scorer.ts",
      "src/jobs/processors/risk-scoring.processor.ts",
      "src/jobs/producers/risk-scoring-pipeline.producer.ts",
    ]));
    expect(paths(evidence.files)).not.toContain("src/modules/search/search-bar.tsx");
  });

  it("keeps product-flow queries on the primary capability family path", () => {
    expect(hasPrimaryCapabilityFamilyForQuery("trace the upload media flow")).toBe(true);
    expect(hasPrimaryCapabilityFamilyForQuery("which files implement authentication")).toBe(true);
    expect(hasPrimaryCapabilityFamilyForQuery("billing checkout portal flow")).toBe(true);
  });

  it("hydrates selected evidence files to real code chunks with provenance", () => {
    const metadata = makeMetadata([chunk("src/state/sessionProvider.tsx", "SessionProvider")]);
    const evidence = resolveCapabilityEvidence({
      query: "which files implement authentication",
      queryMode: "architecture",
      topCodeChunks: [],
      wikiPages: [{
        name: "business-user-authentication",
        summary: "Authentication session provider capability",
        relatedFiles: ["src/state/sessionProvider.tsx"],
      }],
      metadata,
    });
    const hydrated = hydrateCapabilityEvidenceFiles(metadata, evidence.files);
    expect(hydrated[0]?.filePath).toBe("src/state/sessionProvider.tsx");
    expect(hydrated[0]?.selectionSource).toBe("wiki_capability");
    expect(hydrated[0]?.wikiPagesUsed).toEqual(["business-user-authentication"]);
  });
});
