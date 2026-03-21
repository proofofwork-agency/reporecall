import { describe, expect, it } from "vitest";
import type { StoredChunk } from "../../src/storage/types.js";
import {
  buildLiteralAliasCandidates,
  buildTargetCatalog,
  normalizeTargetText,
  resolveTargetsForQuery,
} from "../../src/search/targets.js";

function makeChunk(overrides: Partial<StoredChunk> & { id: string; name: string; filePath: string }): StoredChunk {
  return {
    kind: "function_declaration",
    startLine: 1,
    endLine: 10,
    content: `function ${overrides.name}() {}`,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("targets", () => {
  it("normalizes kebab, snake, camel, and spaced forms to the same alias", () => {
    expect(normalizeTargetText("generate-image")).toBe("generate image");
    expect(normalizeTargetText("generate_image")).toBe("generate image");
    expect(normalizeTargetText("generateImage")).toBe("generate image");
    expect(normalizeTargetText("generate image")).toBe("generate image");
  });

  it("builds endpoint targets for index.ts parent directories", () => {
    const chunks = [
      makeChunk({
        id: "serve-handler",
        name: "serve_handler",
        filePath: "supabase/functions/generate-image/index.ts",
      }),
    ];

    const catalog = buildTargetCatalog(chunks, ["src/", "lib/", "bin/"]);
    const endpoint = catalog.targets.find((target) => target.kind === "endpoint");

    expect(endpoint).toBeDefined();
    expect(endpoint?.canonicalName).toBe("generate-image");
    expect(endpoint?.filePath).toBe("supabase/functions/generate-image/index.ts");
    expect(catalog.aliases.some((alias) => alias.targetId === endpoint?.id && alias.normalizedAlias === "generate image")).toBe(true);
  });

  it("builds file-module targets for named implementation files", () => {
    const chunks = [
      makeChunk({
        id: "mcp-server",
        name: "createMCPServer",
        filePath: "src/daemon/mcp-server.ts",
      }),
    ];

    const catalog = buildTargetCatalog(chunks, ["src/", "lib/", "bin/"]);
    const fileModule = catalog.targets.find((target) => target.id === "file_module:src/daemon/mcp-server.ts");

    expect(fileModule).toBeDefined();
    expect(fileModule?.canonicalName).toBe("mcp-server");
    expect(catalog.aliases.some((alias) => alias.targetId === fileModule?.id && alias.normalizedAlias === "mcp server")).toBe(true);
  });

  it("resolves subsystem targets from query nouns like indexing", () => {
    const chunks = [
      makeChunk({
        id: "indexing-pipeline",
        name: "IndexingPipeline",
        filePath: "src/indexer/pipeline.ts",
        kind: "class_declaration",
      }),
    ];

    const catalog = buildTargetCatalog(chunks, ["src/", "lib/", "bin/"]);
    const hits = resolveTargetsForQuery("why does indexing fail", {
      resolveTargetAliases(normalizedAliases: string[]) {
        return catalog.aliases
          .filter((alias) => normalizedAliases.includes(alias.normalizedAlias))
          .map((alias) => ({
            target: catalog.targets.find((target) => target.id === alias.targetId)!,
            alias: alias.alias,
            normalizedAlias: alias.normalizedAlias,
            source: alias.source,
            weight: alias.weight,
          }));
      },
    } as never);

    expect(hits.some((hit) => hit.target.kind === "subsystem" && hit.target.canonicalName === "indexer")).toBe(true);
  });

  it("prefers directly mentioned file-module targets over derived subsystem expansions", () => {
    const chunks = [
      makeChunk({
        id: "mcp-server",
        name: "createMCPServer",
        filePath: "src/daemon/mcp-server.ts",
      }),
      makeChunk({
        id: "stats-store",
        name: "StatsStore",
        filePath: "src/storage/stats-store.ts",
        kind: "class_declaration",
      }),
    ];

    const catalog = buildTargetCatalog(chunks, ["src/", "lib/", "bin/"]);
    const hits = resolveTargetsForQuery("how does the MCP server handle tool calls?", {
      resolveTargetAliases(normalizedAliases: string[]) {
        return catalog.aliases
          .filter((alias) => normalizedAliases.includes(alias.normalizedAlias))
          .map((alias) => ({
            target: catalog.targets.find((target) => target.id === alias.targetId)!,
            alias: alias.alias,
            normalizedAlias: alias.normalizedAlias,
            source: alias.source,
            weight: alias.weight,
          }));
      },
    } as never);

    expect(hits[0]?.target.id).toBe("file_module:src/daemon/mcp-server.ts");
  });

  it("builds literal candidates for string-dispatch edges", () => {
    const aliases = buildLiteralAliasCandidates(["generate-image", "storyboard_controller"]);
    expect(aliases).toContain("generate image");
    expect(aliases).toContain("storyboard controller");
  });
});
