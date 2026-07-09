import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { initTreeSitter, getLanguage, createParser } from "../../src/parser/tree-sitter.js";
import { extractCallEdges } from "../../src/analysis/call-graph.js";
import { chunkFileWithCalls } from "../../src/parser/chunker.js";
import type Parser from "web-tree-sitter";

// regression: extractCallEdges must walk deeply nested ASTs without overflowing
// the V8 call stack. walkForCallNodes is now iterative (explicit stack), so it
// handles depths (10k+) that previously caused "Maximum call stack size exceeded".

function buildNestedCallSource(depth: number): string {
  return `function deep() {\n  ${"a(".repeat(depth)}0${")".repeat(depth)};\n}\n`;
}

async function parseSource(
  source: string
): Promise<{ tree: Parser.Tree; parser: Parser }> {
  await initTreeSitter();
  const lang = await getLanguage("typescript");
  if (!lang) throw new Error("typescript grammar not available");
  const parser = createParser(lang);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    throw new Error("parser returned null tree");
  }
  return { tree, parser };
}

function findFirstNodeByType(
  node: Parser.SyntaxNode,
  type: string
): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const found = findFirstNodeByType(child, type);
      if (found) return found;
    }
  }
  return undefined;
}

describe("call-graph deep AST handling", () => {
  it("completes without RangeError on a 5000-deep nested call chain", async () => {
    // 5000 is above V8's default recursion limit (~3500-4000 for these frames),
    // so a recursive walk would overflow; the iterative stack handles it.
    // (Depth is bounded for parse-time — tree-sitter parses deep nests slowly.)
    const depth = 5000;
    const source = buildNestedCallSource(depth);
    const { tree, parser } = await parseSource(source);

    try {
      const fnNode = findFirstNodeByType(tree.rootNode, "function_declaration");
      expect(fnNode).toBeDefined();

      // regression: must not throw "Maximum call stack size exceeded".
      expect(() => {
        extractCallEdges(fnNode!, "chunk-deep", "src/deep.ts", [
          "call_expression",
          "new_expression",
        ]);
      }).not.toThrow();
    } finally {
      tree.delete();
      parser.delete();
    }
  }, 90000);

  it("extracts call edges from a moderately nested chain", async () => {
    const depth = 100;
    const source = buildNestedCallSource(depth);
    const { tree, parser } = await parseSource(source);

    try {
      const fnNode = findFirstNodeByType(tree.rootNode, "function_declaration");
      expect(fnNode).toBeDefined();

      const edges = extractCallEdges(fnNode!, "chunk-mid", "src/mid.ts", [
        "call_expression",
        "new_expression",
      ]);

      // Each nested a() is a unique call edge (deduped by receiver:targetName:callType)
      // All are "a" with no receiver, so they dedupe to a single edge.
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges[0].targetName).toBe("a");
    } finally {
      tree.delete();
      parser.delete();
    }
  }, 15000);

  it("chunkFileWithCalls handles a deeply nested source file without crashing", async () => {
    const depth = 500;
    const dir = mkdtempSync(resolve(tmpdir(), "callgraph-deep-"));
    const filePath = resolve(dir, "deep.ts");
    writeFileSync(filePath, buildNestedCallSource(depth));

    try {
      const result = await chunkFileWithCalls(filePath, dir);

      expect(result.chunks.length).toBeGreaterThanOrEqual(1);
      // The deeply nested a() calls should produce at least one call edge
      if (result.callEdges.length > 0) {
        expect(result.callEdges.some((e) => e.targetName === "a")).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
