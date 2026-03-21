import { readFile, stat } from "fs/promises";
import { extname, relative } from "path";
import type Parser from "web-tree-sitter";
import { getLanguage, createParser, initTreeSitter } from "./tree-sitter.js";
import { getLanguageForExtension, type LanguageConfig } from "./languages.js";
import type { CodeChunk } from "./types.js";
import { extractCallEdges, type CallEdge } from "../analysis/call-graph.js";
import { extractImports, type RawImport } from "../analysis/imports.js";
import xxhash from "xxhash-wasm";

type SyntaxNode = Parser.SyntaxNode;

/**
 * Max lines stored per chunk. Longer functions are truncated in the stored
 * content (FTS + metadata) while the chunk's startLine/endLine still reflect
 * the full range so navigation works. This prevents BM25 from over-scoring
 * mega-functions that happen to contain scattered query terms.
 */
const MAX_CHUNK_LINES = 200;
const TRUNCATION_KEEP_LINES = 150;

let hasherPromise: Promise<Awaited<ReturnType<typeof xxhash>>> | undefined;

function getHasher() {
  if (!hasherPromise) hasherPromise = xxhash();
  return hasherPromise;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith('\n')
    ? content.split('\n').length - 1
    : content.split('\n').length;
}

function buildWholeFileChunk(
  id: string,
  relPath: string,
  content: string,
  language: string
): CodeChunk {
  return {
    id,
    filePath: relPath,
    name: relPath,
    kind: "file",
    content,
    startLine: 1,
    endLine: Math.max(1, countLines(content)),
    language,
  };
}

function extractName(node: SyntaxNode): string {
  const nameNode =
    node.childForFieldName("name") ??
    node.childForFieldName("declarator");

  if (nameNode) return nameNode.text;

  // For arrow functions assigned to variables: const foo = () => ...
  if (
    node.type === "arrow_function" &&
    node.parent?.type === "variable_declarator"
  ) {
    const varName = node.parent.childForFieldName("name");
    if (varName) return varName.text;
  }

  // For arrow/function values in object literals: { handleLogin: () => {} }
  // The parent is a "pair" node; extract the property key as the name.
  if (
    (node.type === "arrow_function" || node.type === "function") &&
    node.parent?.type === "pair"
  ) {
    const key = node.parent.childForFieldName("key");
    if (key) return key.text;
  }

  // For arrow/function callbacks passed directly to a call:
  //   Deno.serve(async (req) => { ... })  →  "serve_handler"
  //   app.get("/path", (req, res) => {})  →  "get_handler"
  if (
    (node.type === "arrow_function" || node.type === "function") &&
    node.parent?.type === "arguments"
  ) {
    const callExpr = node.parent.parent;
    if (callExpr?.type === "call_expression") {
      const fn = callExpr.childForFieldName("function");
      if (fn) {
        // member_expression: Deno.serve → "serve", app.get → "get"
        const calleeName =
          fn.type === "member_expression"
            ? fn.childForFieldName("property")?.text
            : fn.text;
        if (calleeName) return `${calleeName}_handler`;
      }
    }
  }

  // For export statements, try to get the name from the declaration
  if (node.type === "export_statement") {
    const decl = node.childForFieldName("declaration");
    if (decl) return extractName(decl);
  }

  // Kotlin: classes use type_identifier, functions use simple_identifier as direct children
  // Zig: test declarations have a string child with the test name
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "simple_identifier" || child.type === "type_identifier") {
      return child.text;
    }
    if (child.type === "string" && node.type === "test_declaration") {
      // Strip quotes from test name
      const text = child.text;
      return text.startsWith('"') ? text.slice(1, -1) : text;
    }
  }

  return "<anonymous>";
}

function extractDocstring(
  node: SyntaxNode,
  docTypes: string[]
): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev && docTypes.includes(prev.type)) {
    return prev.text;
  }
  return undefined;
}

/**
 * Checks if a syntax node is exported by walking up the parent chain
 * looking for an `export_statement` wrapper. Stops at function/class
 * boundaries to avoid false positives.
 */
function isExported(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === "export_statement") return true;
    // Don't walk past function/class boundaries
    if (
      ["function_declaration", "class_declaration", "method_definition", "arrow_function"].includes(
        current.type
      )
    ) {
      break;
    }
    current = current.parent;
  }
  return false;
}

function extractParentName(node: SyntaxNode): string | undefined {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "class_definition" ||
      current.type === "impl_item" ||
      current.type === "object_declaration"
    ) {
      const name = extractName(current);
      if (name !== "<anonymous>") return name;
    }
    current = current.parent;
  }
  return undefined;
}

const CONTAINER_TYPES = new Set([
  "class_declaration", "class_definition", "class_specifier",
  "class", "impl_item",
  "interface_declaration", "trait_item", "trait_definition",
  "protocol_declaration",
  "module", "namespace_definition",
  "object_declaration", "component",
]);

function walkForExtractables(
  node: SyntaxNode,
  config: LanguageConfig,
  results: SyntaxNode[]
): void {
  if (config.extractableTypes.includes(node.type)) {
    results.push(node);
    if (CONTAINER_TYPES.has(node.type)) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walkForExtractables(child, config, results);
      }
    }
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkForExtractables(child, config, results);
  }
}

export async function chunkFileWithCalls(
  filePath: string,
  projectRoot: string
): Promise<{ chunks: CodeChunk[]; callEdges: CallEdge[]; rawImports: RawImport[]; language: string | null }> {
  const MAX_CHUNK_FILE_SIZE = 1024 * 1024; // 1MB

  const ext = extname(filePath);
  const langInfo = getLanguageForExtension(ext);
  const relPath = relative(projectRoot, filePath);
  const h = await getHasher();

  // Guard against huge files blowing memory
  let fileSize: number;
  try {
    fileSize = (await stat(filePath)).size;
  } catch {
    return { chunks: [], callEdges: [], rawImports: [], language: null };
  }
  if (fileSize > MAX_CHUNK_FILE_SIZE) {
    const id = h.h64ToString(`${relPath}:file:0`);
    return {
      chunks: [{
        id, filePath: relPath, name: relPath, kind: "file",
        content: `[File too large: ${(fileSize / 1024).toFixed(0)}KB]`,
        startLine: 1, endLine: 1, language: ext.replace(".", ""),
      }],
      callEdges: [],
      rawImports: [],
      language: null,
    };
  }

  const content = await readFile(filePath, "utf-8");

  if (!langInfo) {
    const id = h.h64ToString(`${relPath}:file:0`);
    return {
      chunks: [
        {
          id,
          filePath: relPath,
          name: relPath,
          kind: "file",
          content,
          startLine: 1,
          endLine: Math.max(1, countLines(content)),
          language: ext.replace(".", ""),
        },
      ],
      callEdges: [],
      rawImports: [],
      language: null,
    };
  }

  const { language: langName, config } = langInfo;
  await initTreeSitter();
  const lang = await getLanguage(langName);

  if (!lang) {
    const id = h.h64ToString(`${relPath}:file:0`);
    return {
      chunks: [buildWholeFileChunk(id, relPath, content, langName)],
      callEdges: [],
      rawImports: [],
      language: langName,
    };
  }

  const parser = createParser(lang);
  let tree: Parser.Tree | null = null;
  try {
    tree = parser.parse(content);
  } catch {
    const id = h.h64ToString(`${relPath}:file:0`);
    return {
      chunks: [buildWholeFileChunk(id, relPath, content, langName)],
      callEdges: [],
      rawImports: [],
      language: langName,
    };
  }
  if (!tree) {
    const id = h.h64ToString(`${relPath}:file:0`);
    return {
      chunks: [buildWholeFileChunk(id, relPath, content, langName)],
      callEdges: [],
      rawImports: [],
      language: langName,
    };
  }

  const nodes: Parser.SyntaxNode[] = [];
  try {
    walkForExtractables(tree.rootNode, config, nodes);
  } catch {
    const id = h.h64ToString(`${relPath}:file:0`);
    return {
      chunks: [buildWholeFileChunk(id, relPath, content, langName)],
      callEdges: [],
      rawImports: [],
      language: langName,
    };
  }

  if (nodes.length === 0) {
    const id = h.h64ToString(`${relPath}:file:0`);
    // Still extract imports — the tree parsed fine, just no extractable nodes
    const tsJsLanguages = new Set(["typescript", "tsx", "javascript"]);
    const fallbackImports = tsJsLanguages.has(langName)
      ? extractImports(tree.rootNode, langName)
      : [];
    return {
      chunks: [buildWholeFileChunk(id, relPath, content, langName)],
      callEdges: [],
      rawImports: fallbackImports,
      language: langName,
    };
  }

  const chunks: CodeChunk[] = [];
  const allCallEdges: CallEdge[] = [];

  for (const node of nodes) {
    const name = extractName(node);
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const id = h.h64ToString(`${relPath}:${name}:${startLine}`);
    const lineCount = endLine - startLine + 1;

    let chunkContent = node.text;
    if (lineCount > MAX_CHUNK_LINES) {
      const lines = chunkContent.split("\n");
      const kept = lines.slice(0, TRUNCATION_KEEP_LINES);
      kept.push(`// ... truncated ${lineCount - TRUNCATION_KEEP_LINES} more lines (${lineCount} total) ...`);
      chunkContent = kept.join("\n");
    }

    chunks.push({
      id,
      filePath: relPath,
      name,
      kind: node.type,
      content: chunkContent,
      startLine,
      endLine,
      parentName: extractParentName(node),
      docstring: extractDocstring(node, config.docstringTypes),
      language: langName,
      isExported: isExported(node),
    });

    if (config.callNodeTypes) {
      const edges = extractCallEdges(node, id, relPath, config.callNodeTypes);
      allCallEdges.push(...edges);
    }
  }

  // Extract imports from TS/JS/TSX files
  const tsJsLanguages = new Set(["typescript", "tsx", "javascript"]);
  const rawImports = tsJsLanguages.has(langName)
    ? extractImports(tree.rootNode, langName)
    : [];

  return { chunks, callEdges: allCallEdges, rawImports, language: langName };
}
