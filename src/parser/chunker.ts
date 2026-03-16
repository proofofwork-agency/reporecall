import { readFile, stat } from "fs/promises";
import { extname, relative } from "path";
import type Parser from "web-tree-sitter";
import { getLanguage, createParser, initTreeSitter } from "./tree-sitter.js";
import { getLanguageForExtension, type LanguageConfig } from "./languages.js";
import type { CodeChunk } from "./types.js";
import { extractCallEdges, type CallEdge } from "../analysis/call-graph.js";
import xxhash from "xxhash-wasm";

type SyntaxNode = Parser.SyntaxNode;

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

  // For export statements, try to get the name from the declaration
  if (node.type === "export_statement") {
    const decl = node.childForFieldName("declaration");
    if (decl) return extractName(decl);
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

function extractParentName(node: SyntaxNode): string | undefined {
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "class_definition" ||
      current.type === "impl_item"
    ) {
      const name = current.childForFieldName("name");
      if (name) return name.text;
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
  "component",
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
): Promise<{ chunks: CodeChunk[]; callEdges: CallEdge[] }> {
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
    return { chunks: [], callEdges: [] };
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
    };
  }

  const { language: langName, config } = langInfo;
  await initTreeSitter();
  const lang = await getLanguage(langName);

  if (!lang) {
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
          language: langName,
        },
      ],
      callEdges: [],
    };
  }

  const parser = createParser(lang);
  const tree = parser.parse(content);
  if (!tree) {
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
          language: langName,
        },
      ],
      callEdges: [],
    };
  }

  const nodes: Parser.SyntaxNode[] = [];
  walkForExtractables(tree.rootNode, config, nodes);

  if (nodes.length === 0) {
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
          language: langName,
        },
      ],
      callEdges: [],
    };
  }

  const chunks: CodeChunk[] = [];
  const allCallEdges: CallEdge[] = [];

  for (const node of nodes) {
    const name = extractName(node);
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const id = h.h64ToString(`${relPath}:${name}:${startLine}`);

    chunks.push({
      id,
      filePath: relPath,
      name,
      kind: node.type,
      content: node.text,
      startLine,
      endLine,
      parentName: extractParentName(node),
      docstring: extractDocstring(node, config.docstringTypes),
      language: langName,
    });

    if (config.callNodeTypes) {
      const edges = extractCallEdges(node, id, relPath, config.callNodeTypes);
      allCallEdges.push(...edges);
    }
  }

  return { chunks, callEdges: allCallEdges };
}
