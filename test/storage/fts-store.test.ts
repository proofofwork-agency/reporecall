import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FTSStore } from "../../src/storage/fts-store.js";

describe("FTSStore", () => {
  let dataDir: string;
  let store: FTSStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mem-fts-"));
    store = new FTSStore(dataDir);
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps a single exact phrase match instead of falling back to broad OR search", () => {
    store.bulkUpsert([
      {
        id: "css",
        name: "styles.css",
        filePath: "src/styles.css",
        content: '.alpha::after { content: "CSS_UNIQUE_TOKEN"; }',
        kind: "rule_set",
      },
      {
        id: "ruby",
        name: "main.rb",
        filePath: "src/main.rb",
        content: 'def alpha; "RB_UNIQUE_TOKEN"; end',
        kind: "method",
      },
    ]);

    const results = store.search("CSS_UNIQUE_TOKEN", 10);
    expect(results.map((r) => r.id)).toEqual(["css"]);
  });

  it("keeps a single all-terms match for multi-word queries", () => {
    store.bulkUpsert([
      {
        id: "vue",
        name: "App.vue",
        filePath: "src/App.vue",
        content: '<template><div>VUE UNIQUE TOKEN</div></template>',
        kind: "component",
      },
      {
        id: "ts",
        name: "index.ts",
        filePath: "src/index.ts",
        content: "const value = 'token';",
        kind: "function_declaration",
      },
    ]);

    const results = store.search("VUE UNIQUE TOKEN", 10);
    expect(results.map((r) => r.id)).toEqual(["vue"]);
  });

  it("filters stop words so AND doesn't fail on natural language queries", () => {
    store.bulkUpsert([
      {
        id: "auth-modal",
        name: "AuthModal.tsx",
        filePath: "src/components/AuthModal.tsx",
        content: "authentication flow step log message login modal",
        kind: "function_declaration",
      },
      {
        id: "video-handler",
        name: "videoEraserHandler.ts",
        filePath: "src/handlers/videoEraserHandler.ts",
        content: "video eraser handler flow processing step",
        kind: "function_declaration",
      },
    ]);

    // "add to every step in the authentication flow a log message"
    // "authentication" is the rarest term → anchor query finds auth-modal
    const results = store.search(
      "add to every step in the authentication flow a log message",
      10
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("auth-modal");
  });

  it("anchors on rarest term for long NL queries with many terms", () => {
    store.bulkUpsert([
      {
        id: "auth-service",
        name: "authService.ts",
        filePath: "src/services/authService.ts",
        content: "authentication step validate credentials",
        kind: "function_declaration",
      },
      {
        id: "unrelated",
        name: "utils.ts",
        filePath: "src/utils.ts",
        content: "helper utility format string",
        kind: "function_declaration",
      },
    ]);

    // "authentication" is rare (1 doc) — anchor + OR rest should find auth-service
    const results = store.search(
      "add step authentication flow log message handler",
      10
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("auth-service");
  });

  it("expands abbreviations in OR fallback for long terms", () => {
    store.bulkUpsert([
      {
        id: "auth-hook",
        name: "useAuth.tsx",
        filePath: "src/hooks/useAuth.tsx",
        content: "auth provider context login logout",
        kind: "function_declaration",
      },
    ]);

    // "authentication" (>= 6 chars) should also try "auth*" prefix in OR fallback
    const results = store.search("authentication", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("auth-hook");
  });

  it("filters non-selective terms from AND queries using index-driven selectivity", () => {
    // Create many chunks where common terms (log, step, flow, message) appear frequently
    // but "authentication" is rare — selectivity should keep only "authentication"
    const chunks = [];
    for (let i = 0; i < 20; i++) {
      chunks.push({
        id: `common-${i}`,
        name: `file${i}.ts`,
        filePath: `src/file${i}.ts`,
        content: `log step flow message handler process data chunk ${i}`,
        kind: "function_declaration",
      });
    }
    // Add one chunk with "authentication" (selective term)
    chunks.push({
      id: "auth-chunk",
      name: "auth.ts",
      filePath: "src/auth.ts",
      content: "authentication login credential verify step flow",
      kind: "function_declaration",
    });
    store.bulkUpsert(chunks);

    // NL query: common terms dominate without selectivity
    // With selectivity, "authentication" is the discriminative term
    const results = store.search(
      "add to every step in the authentication flow a log message",
      10
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("auth-chunk");
  });

  it("skips AND and goes to OR when all terms are non-selective", () => {
    const chunks = [];
    for (let i = 0; i < 20; i++) {
      chunks.push({
        id: `chunk-${i}`,
        name: `file${i}.ts`,
        filePath: `src/file${i}.ts`,
        content: `data handler process service utility ${i}`,
        kind: "function_declaration",
      });
    }
    store.bulkUpsert(chunks);

    // All query terms appear in most chunks — should not crash, falls through to OR
    const results = store.search("data handler process", 10);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("selective OR drops high-DF generic broad terms but keeps subsystem anchors", () => {
    const chunks = [];
    for (let i = 0; i < 20; i++) {
      chunks.push({
        id: `flow-${i}`,
        name: `flowNode${i}.ts`,
        filePath: `src/flow/node${i}.ts`,
        content: `flow handler service log trace step ${i}`,
        kind: "function_declaration",
      });
    }
    chunks.push({
      id: "auth-search",
      name: "searchAuthFlow.ts",
      filePath: "src/search/searchAuthFlow.ts",
      content: "search authentication login session routing pipeline",
      kind: "function_declaration",
    });
    store.bulkUpsert(chunks);

    const results = store.search("search authentication flow", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("auth-search");
  });

  it("invalidates df cache after upsert", () => {
    store.bulkUpsert([
      {
        id: "only-chunk",
        name: "auth.ts",
        filePath: "src/auth.ts",
        content: "authentication login",
        kind: "function_declaration",
      },
    ]);

    // Search to populate cache
    const r1 = store.search("authentication", 10);
    expect(r1.length).toBe(1);

    // Add more chunks — cache should invalidate
    const newChunks = [];
    for (let i = 0; i < 10; i++) {
      newChunks.push({
        id: `new-${i}`,
        name: `f${i}.ts`,
        filePath: `src/f${i}.ts`,
        content: `authentication helper ${i}`,
        kind: "function_declaration",
      });
    }
    store.bulkUpsert(newChunks);

    // "authentication" is now common — selectivity should adapt
    const r2 = store.search("authentication", 10);
    expect(r2.length).toBeGreaterThan(1);
  });

  it("uses camelCase compound phrase to anchor R1-style queries (saveFlow → 'save flow' phrase)", () => {
    // "save" and "flow" individually are common — rarest-term anchor would fail.
    // But "saveFlow" in the query → phrase "save flow" → only hits saveFlowToDatabase.
    const chunks: Array<{
      id: string;
      name: string;
      filePath: string;
      content: string;
      kind: string;
    }> = [
      {
        id: "saveflow-chunk",
        name: "saveFlowToDatabase",
        filePath: "src/flows/saveFlowToDatabase.ts",
        content: "async function saveFlowToDatabase(flowId) { await db.save(flowId); }",
        kind: "function_declaration",
      },
      {
        id: "autosave-chunk",
        name: "showAutoSaveToast",
        filePath: "src/ui/showAutoSaveToast.ts",
        content: "function showAutoSaveToast() { toast.show('Auto-saved'); }",
        kind: "function_declaration",
      },
    ];
    // 20 noise chunks with "save" so "save" is very common (>15% threshold)
    for (let i = 0; i < 20; i++) {
      chunks.push({
        id: `noise-${i}`,
        name: `handler${i}.ts`,
        filePath: `src/handlers/handler${i}.ts`,
        // "save" appears here but "save flow" (adjacent) does NOT
        content: `auto save toast handler notification ${i}`,
        kind: "function_declaration",
      });
    }
    store.bulkUpsert(chunks);

    const results = store.search("how does saveFlow work", 10);
    expect(results.length).toBeGreaterThan(0);
    // The camelCase phrase anchor "save flow" must find saveFlowToDatabase first,
    // not showAutoSaveToast which only has "save" but not "save flow" adjacent.
    expect(results[0].id).toBe("saveflow-chunk");
  });

  it("handles queries with only stop words gracefully", () => {
    store.bulkUpsert([
      {
        id: "file1",
        name: "test.ts",
        filePath: "src/test.ts",
        content: "the is are was",
        kind: "function_declaration",
      },
    ]);

    // All stop words — should not crash, falls back to OR of original terms
    const results = store.search("the is are", 10);
    // May or may not find results, but should not throw
    expect(Array.isArray(results)).toBe(true);
  });
});
