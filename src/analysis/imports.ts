import type Parser from "web-tree-sitter";
import { existsSync, statSync } from "fs";
import { resolve, dirname, isAbsolute, relative } from "path";

type SyntaxNode = Parser.SyntaxNode;

export interface RawImport {
  importedName: string;
  sourceModule: string;
  isDefault: boolean;
  isNamespace: boolean;
}

/**
 * Extract static imports from a tree-sitter AST root node.
 * Handles named, default, namespace, aliased, type imports, and re-exports.
 *
 * @param rootNode - The root node of the parsed tree
 * @param _language - The language name (reserved for future use)
 * @returns Array of raw import records
 */
export function extractImports(rootNode: SyntaxNode, _language: string): RawImport[] {
  const imports: RawImport[] = [];

  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.child(i);
    if (!node) continue;

    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      if (!sourceNode) continue;
      const sourceModule = stripQuotes(sourceNode.text);

      // Find the import clause — can be identifier, named_imports, or namespace_import
      for (let j = 0; j < node.childCount; j++) {
        const child = node.child(j);
        if (!child) continue;

        if (child.type === "import_clause") {
          extractFromImportClause(child, sourceModule, imports);
        }
      }
    }

    // Handle re-exports: export { foo } from "./module"
    if (node.type === "export_statement") {
      const sourceNode = node.childForFieldName("source");
      if (!sourceNode) continue;
      const sourceModule = stripQuotes(sourceNode.text);

      for (let j = 0; j < node.childCount; j++) {
        const child = node.child(j);
        if (!child) continue;

        if (child.type === "export_clause") {
          for (let k = 0; k < child.namedChildCount; k++) {
            const specifier = child.namedChild(k);
            if (!specifier) continue;
            if (specifier.type === "export_specifier") {
              const nameNode = specifier.childForFieldName("name");
              const aliasNode = specifier.childForFieldName("alias");
              const importedName = aliasNode ? aliasNode.text : (nameNode ? nameNode.text : specifier.text);
              imports.push({
                importedName,
                sourceModule,
                isDefault: false,
                isNamespace: false,
              });
            }
          }
        }
      }
    }
  }

  return imports;
}

function extractFromImportClause(
  clause: SyntaxNode,
  sourceModule: string,
  imports: RawImport[]
): void {
  for (let i = 0; i < clause.childCount; i++) {
    const child = clause.child(i);
    if (!child) continue;

    // Default import: import Foo from "./module"
    if (child.type === "identifier") {
      imports.push({
        importedName: child.text,
        sourceModule,
        isDefault: true,
        isNamespace: false,
      });
    }

    // Named imports: import { foo, bar } from "./module"
    if (child.type === "named_imports") {
      extractFromNamedImports(child, sourceModule, imports);
    }

    // Namespace import: import * as ns from "./module"
    if (child.type === "namespace_import") {
      const nameNode = findIdentifierChild(child);
      if (nameNode) {
        imports.push({
          importedName: nameNode.text,
          sourceModule,
          isDefault: false,
          isNamespace: true,
        });
      }
    }
  }
}

function extractFromNamedImports(
  namedImports: SyntaxNode,
  sourceModule: string,
  imports: RawImport[]
): void {
  for (let i = 0; i < namedImports.namedChildCount; i++) {
    const specifier = namedImports.namedChild(i);
    if (!specifier) continue;

    if (specifier.type === "import_specifier") {
      const nameNode = specifier.childForFieldName("name");
      const aliasNode = specifier.childForFieldName("alias");
      // If aliased, the importedName is the alias; otherwise it's the name
      const importedName = aliasNode ? aliasNode.text : (nameNode ? nameNode.text : specifier.text);
      imports.push({
        importedName,
        sourceModule,
        isDefault: false,
        isNamespace: false,
      });
    }
  }
}

function findIdentifierChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === "identifier") return child;
  }
  return null;
}

function stripQuotes(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const RESOLVE_INDEX_FILES = [
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

/**
 * Resolve a relative import path to an actual file path.
 * Returns null for external/package imports.
 *
 * @param sourceModule - The import source string (e.g., "./foo", "express")
 * @param importingFilePath - The file containing the import (relative to projectRoot)
 * @param projectRoot - The project root directory
 * @returns Resolved relative path or null
 */
export function resolveImportPath(
  sourceModule: string,
  importingFilePath: string,
  projectRoot: string
): string | null {
  // External modules: not a relative path
  if (!sourceModule.startsWith(".")) {
    return null;
  }

  const importingDir = dirname(
    isAbsolute(importingFilePath)
      ? importingFilePath
      : resolve(projectRoot, importingFilePath)
  );
  const basePath = resolve(importingDir, sourceModule);

  // Try exact path first
  if (existsSync(basePath) && !isDirectory(basePath)) {
    return normalizeToRelative(basePath, projectRoot);
  }

  // Try with extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = basePath + ext;
    if (existsSync(candidate)) {
      return normalizeToRelative(candidate, projectRoot);
    }
  }

  // Try index files (for directory imports)
  for (const indexFile of RESOLVE_INDEX_FILES) {
    const candidate = basePath + indexFile;
    if (existsSync(candidate)) {
      return normalizeToRelative(candidate, projectRoot);
    }
  }

  return null;
}

function normalizeToRelative(absPath: string, projectRoot: string): string {
  return relative(projectRoot, absPath).replace(/\\/g, "/");
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
