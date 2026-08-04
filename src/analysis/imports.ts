import type Parser from "web-tree-sitter";
import { statSync } from "fs";
import { resolve, dirname, isAbsolute } from "path";
import { resolveProjectPath } from "../core/path-safety.js";

type SyntaxNode = Parser.SyntaxNode;

export interface RawImport {
  importedName: string;
  sourceModule: string;
  isDefault: boolean;
  isNamespace: boolean;
}

/**
 * Extract static imports from a tree-sitter AST root node.
 * Dispatches on the parsed language. Each handler walks the top-level
 * statements of the root node (matching the original TS/JS behaviour) and
 * emits {@link RawImport} records describing the imported module path.
 *
 * @param rootNode - The root node of the parsed tree
 * @param language - The language name (e.g. "typescript", "python")
 * @returns Array of raw import records
 */
export function extractImports(rootNode: SyntaxNode, language: string): RawImport[] {
  const normalized = language.toLowerCase();
  if (normalized === "typescript" || normalized === "tsx" || normalized === "javascript") {
    return extractTypeScriptImports(rootNode);
  }
  if (normalized === "python") {
    return extractPythonImports(rootNode);
  }
  if (normalized === "rust") {
    return extractRustImports(rootNode);
  }
  if (normalized === "go") {
    return extractGoImports(rootNode);
  }
  if (normalized === "java") {
    return extractJavaImports(rootNode);
  }
  return [];
}

/**
 * TS/JS/TSX import extraction. Handles named, default, namespace, aliased,
 * type imports, and re-exports (`export { x } from "m"`,
 * `export * from "m"`, `export * as ns from "m"`).
 */
function extractTypeScriptImports(rootNode: SyntaxNode): RawImport[] {
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

    // Handle re-exports: `export { foo } from "./m"`,
    // `export * from "./m"`, and `export * as ns from "./m"`.
    if (node.type === "export_statement") {
      const sourceNode = node.childForFieldName("source");
      if (!sourceNode) continue;
      const sourceModule = stripQuotes(sourceNode.text);

      let sawExportClause = false;
      for (let j = 0; j < node.childCount; j++) {
        const child = node.child(j);
        if (!child) continue;

        if (child.type === "export_clause") {
          sawExportClause = true;
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

      // Namespace/barrel re-exports carry a `source` but no `export_clause`.
      if (!sawExportClause) {
        const nsMatch = node.text.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
        imports.push({
          importedName: nsMatch ? nsMatch[1]! : "*",
          sourceModule,
          isDefault: false,
          isNamespace: true,
        });
      }
    }
  }

  return imports;
}

/**
 * Python import extraction.
 * Handles `import a.b.c`, `import a.b as c`, `from m import x`,
 * `from m import x as y`, `from m import *`, and relative `from . import x`.
 * Only top-level statements are considered, matching the TS/JS handler.
 */
function extractPythonImports(rootNode: SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.child(i);
    if (!node) continue;

    if (node.type === "import_statement") {
      for (let j = 0; j < node.namedChildCount; j++) {
        const child = node.namedChild(j);
        if (!child) continue;

        if (child.type === "dotted_name") {
          imports.push({
            importedName: child.text,
            sourceModule: child.text,
            isDefault: false,
            isNamespace: true,
          });
        } else if (child.type === "aliased_import") {
          const nameNode = child.childForFieldName("name");
          const aliasNode = child.childForFieldName("alias");
          const sourceModule = nameNode ? nameNode.text : "";
          if (!sourceModule) continue;
          imports.push({
            importedName: aliasNode ? aliasNode.text : sourceModule,
            sourceModule,
            isDefault: false,
            isNamespace: true,
          });
        }
      }
    } else if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module");
      let sourceModule = moduleNode ? moduleNode.text : "";
      if (!sourceModule) {
        // Relative imports (`from . import x`) may not expose a named module
        // node across grammar versions; fall back to the raw text.
        const match = node.text.match(/(?:^|\n)\s*from\s+([.\w]+)\s+import\b/);
        sourceModule = match ? match[1]! : "";
      }
      if (!sourceModule) continue;

      for (let j = 0; j < node.namedChildCount; j++) {
        const child = node.namedChild(j);
        if (!child || child === moduleNode) continue;

        if (child.type === "dotted_name") {
          imports.push({
            importedName: child.text,
            sourceModule,
            isDefault: false,
            isNamespace: false,
          });
        } else if (child.type === "aliased_import") {
          const nameNode = child.childForFieldName("name");
          const aliasNode = child.childForFieldName("alias");
          const name = nameNode ? nameNode.text : "";
          if (!name) continue;
          imports.push({
            importedName: aliasNode ? aliasNode.text : name,
            sourceModule,
            isDefault: false,
            isNamespace: false,
          });
        } else if (child.type === "wildcard_import") {
          imports.push({
            importedName: "*",
            sourceModule,
            isDefault: false,
            isNamespace: true,
          });
        }
      }
    }
  }

  return imports;
}

/**
 * Rust `use` extraction (best-effort). Records the full `use` path as the
 * source module; grouped imports (`use foo::{a, b}`) are flattened to a single
 * namespace record. The single-target `use a::b::C;` form is grammar-stable.
 */
function extractRustImports(rootNode: SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.child(i);
    if (!node || node.type !== "use_declaration") continue;

    const arg = findChildOfType(node, "use_argument");
    if (!arg) continue;
    const sourceModule = arg.text.replace(/;$/, "").trim();
    const isGrouped = sourceModule.includes("{");
    const lastSegment = sourceModule.split("::").pop() ?? sourceModule;
    imports.push({
      importedName: isGrouped ? "*" : lastSegment,
      sourceModule,
      isDefault: false,
      isNamespace: true,
    });
  }

  return imports;
}

/**
 * Go import extraction. Handles single (`import "fmt"`) and grouped
 * (`import ( "fmt"; f "os" )`) forms, reading the quoted import path.
 */
function extractGoImports(rootNode: SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.child(i);
    if (!node || node.type !== "import_declaration") continue;

    for (let j = 0; j < node.namedChildCount; j++) {
      const child = node.namedChild(j);
      if (!child) continue;

      if (child.type === "import_spec") {
        addGoImportSpec(child, imports);
      } else if (child.type === "import_list") {
        for (let k = 0; k < child.namedChildCount; k++) {
          const spec = child.namedChild(k);
          if (spec?.type === "import_spec") addGoImportSpec(spec, imports);
        }
      } else if (child.type === "interpreted_string_literal") {
        imports.push({
          importedName: "*",
          sourceModule: stripQuotes(child.text),
          isDefault: false,
          isNamespace: true,
        });
      }
    }
  }

  return imports;
}

function addGoImportSpec(spec: SyntaxNode, imports: RawImport[]): void {
  const pathNode = spec.childForFieldName("path");
  if (!pathNode) return;
  const sourceModule = stripQuotes(pathNode.text);
  const nameNode = spec.childForFieldName("name");
  const importedName = nameNode ? nameNode.text : (sourceModule.split("/").pop() ?? sourceModule);
  imports.push({ importedName, sourceModule, isDefault: false, isNamespace: true });
}

/**
 * Java import extraction. Handles `import foo.bar.Baz;` and
 * `import foo.bar.*;`, reading the scoped identifier path.
 */
function extractJavaImports(rootNode: SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.child(i);
    if (!node || node.type !== "import_declaration") continue;

    const idNode = findChildOfType(node, "scoped_identifier");
    if (!idNode) continue;
    const sourceModule = idNode.text;
    const isWildcard = node.text.includes("*");
    imports.push({
      importedName: isWildcard ? "*" : (sourceModule.split(".").pop() ?? sourceModule),
      sourceModule,
      isDefault: false,
      isNamespace: isWildcard,
    });
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

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === type) return child;
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
  if (!sourceModule.startsWith(".") || isAbsolute(sourceModule)) {
    return null;
  }

  const importingDir = dirname(
    isAbsolute(importingFilePath)
      ? importingFilePath
      : resolve(projectRoot, importingFilePath)
  );
  const basePath = resolve(importingDir, sourceModule);

  // Try exact path first
  const exact = resolveProjectFile(projectRoot, basePath);
  if (exact) return exact;

  // Try with extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const resolvedFile = resolveProjectFile(projectRoot, basePath + ext);
    if (resolvedFile) return resolvedFile;
  }

  // Try index files (for directory imports)
  for (const indexFile of RESOLVE_INDEX_FILES) {
    const resolvedFile = resolveProjectFile(projectRoot, basePath + indexFile);
    if (resolvedFile) return resolvedFile;
  }

  return null;
}

function resolveProjectFile(projectRoot: string, candidate: string): string | null {
  const safePath = resolveProjectPath(projectRoot, candidate, "existing");
  if (!safePath || isDirectory(safePath.absolutePath)) return null;
  return safePath.posixRelativePath;
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
