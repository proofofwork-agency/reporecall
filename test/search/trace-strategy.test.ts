import { randomUUID } from "crypto";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { SeedCandidate, SeedResult } from "../../src/search/seed.js";
import { chunkToSearchResult } from "../../src/search/shared/mappers.js";
import { selectFocusedTraceBundle } from "../../src/search/trace-strategy.js";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import type { StoredChunk } from "../../src/storage/types.js";

function makeChunk(
  filePath: string,
  name: string,
  kind = "function_declaration"
): StoredChunk {
  return {
    id: randomUUID(),
    filePath,
    name,
    kind,
    startLine: 1,
    endLine: 20,
    content: `export function ${name}() {}`,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    isExported: true,
  };
}

function makeSeed(
  chunk: StoredChunk,
  overrides: Partial<SeedCandidate> = {}
): SeedCandidate {
  return {
    chunkId: chunk.id,
    name: chunk.name,
    filePath: chunk.filePath,
    kind: chunk.kind,
    confidence: 1,
    reason: "explicit_target",
    ...overrides,
  };
}

describe("selectFocusedTraceBundle", () => {
  const dirs: string[] = [];
  const stores: MetadataStore[] = [];

  afterEach(() => {
    // Close before unlinking: Windows refuses to delete a file that still has
    // an open handle, so leaking the sqlite connection turns cleanup into EBUSY.
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
    stores.length = 0;
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function createStore(chunks: StoredChunk[]): MetadataStore {
    const dir = join(tmpdir(), `trace-strategy-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const store = new MetadataStore(dir);
    stores.push(store);
    for (const chunk of chunks) {
      store.upsertFile(chunk.filePath, chunk.id);
      store.upsertChunk(chunk);
    }
    return store;
  }

  it("defers generic single-symbol navigation to the existing graph trace", () => {
    const validate = makeChunk("src/auth.ts", "validate");
    const decode = makeChunk("src/jwt.ts", "decode");
    const store = createStore([validate, decode]);
    const seed = makeSeed(validate, {
      reason: "fts_exact",
    });
    const seeds: SeedResult = { seeds: [seed], bestSeed: seed };
    const candidates = [validate, decode].map((chunk, index) =>
      chunkToSearchResult(chunk, 1 - index * 0.1)
    );

    expect(selectFocusedTraceBundle(
      "how does validate work?",
      candidates,
      candidates,
      seeds,
      store,
      5
    )).toEqual([]);
  });

  it("keeps an auth callback trace to the target, auth state, and app root", () => {
    const callback = makeChunk("src/pages/AuthCallback.tsx", "AuthCallback");
    const auth = makeChunk("src/pages/Auth.tsx", "Auth");
    const state = makeChunk("src/hooks/useAuth.tsx", "useAuth");
    const modal = makeChunk("src/components/AuthModal.tsx", "AuthModal");
    const app = makeChunk("src/App.tsx", "App");
    const chunks = [callback, auth, state, modal, app];
    const store = createStore(chunks);
    const seed = makeSeed(callback);
    const seeds: SeedResult = { seeds: [seed], bestSeed: seed };
    const candidates = chunks.map((chunk, index) => chunkToSearchResult(chunk, 1 - index * 0.1));

    const selected = selectFocusedTraceBundle(
      "trace AuthCallback redirect into the authenticated app",
      candidates,
      candidates,
      seeds,
      store,
      5
    );

    expect(selected.map((result) => result.filePath)).toEqual([
      "src/pages/AuthCallback.tsx",
      "src/hooks/useAuth.tsx",
      "src/App.tsx",
    ]);
    expect(selected.every((result) => result.selectionSource === "focused_trace")).toBe(true);
  });

  it("keeps a backend generation trace to the endpoint and its controller", () => {
    const endpoint = makeChunk(
      "supabase/functions/generate-image/index.ts",
      "generateImage"
    );
    const controller = makeChunk(
      "supabase/functions/storyboard-controller/index.ts",
      "storyboardController"
    );
    const hook = makeChunk("src/hooks/useStoryboardGeneration.ts", "useStoryboardGeneration");
    const chunks = [endpoint, controller, hook];
    const store = createStore(chunks);
    const seed = makeSeed(endpoint, {
      targetKind: "endpoint",
      resolvedAlias: "generate image",
    });
    const seeds: SeedResult = { seeds: [seed], bestSeed: seed };
    const candidates = chunks.map((chunk, index) => chunkToSearchResult(chunk, 1 - index * 0.1));

    const selected = selectFocusedTraceBundle(
      "trace the generate-image generation endpoint",
      candidates,
      candidates,
      seeds,
      store,
      5
    );

    expect(selected.map((result) => result.filePath)).toEqual([
      "supabase/functions/generate-image/index.ts",
      "supabase/functions/storyboard-controller/index.ts",
    ]);
  });

  it("keeps a caller-to-edge trace to the generation store, hook, and endpoint", () => {
    const endpoint = makeChunk(
      "supabase/functions/generate-image/index.ts",
      "generateImage"
    );
    const storeChunk = makeChunk(
      "src/stores/storyboardGenerationStore.ts",
      "storyboardGenerationStore"
    );
    const hook = makeChunk("src/hooks/useStoryboardGeneration.ts", "useStoryboardGeneration");
    const controller = makeChunk(
      "supabase/functions/storyboard-controller/index.ts",
      "storyboardController"
    );
    const chunks = [endpoint, storeChunk, hook, controller];
    const store = createStore(chunks);
    const seed = makeSeed(endpoint, {
      targetKind: "endpoint",
      resolvedAlias: "generate image",
    });
    const seeds: SeedResult = { seeds: [seed], bestSeed: seed };
    const candidates = chunks.map((chunk, index) => chunkToSearchResult(chunk, 1 - index * 0.1));

    const selected = selectFocusedTraceBundle(
      "which store and hook calls the generate-image edge function",
      candidates,
      candidates,
      seeds,
      store,
      5
    );

    expect(selected.map((result) => result.filePath)).toEqual([
      "src/stores/storyboardGenerationStore.ts",
      "src/hooks/useStoryboardGeneration.ts",
      "supabase/functions/generate-image/index.ts",
    ]);
  });
});
