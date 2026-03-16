import type { MetadataStore, ChunkLightweight } from "../storage/metadata-store.js";

export interface ConventionsReport {
  namingStyle: {
    functions: "camelCase" | "snake_case" | "PascalCase" | "mixed";
    classes: "camelCase" | "snake_case" | "PascalCase" | "mixed";
  };
  docstringCoverage: number;
  averageFunctionLength: number;
  medianFunctionLength: number;
  topCallTargets: string[];
  languageDistribution: Record<string, number>;
  totalFunctions: number;
  totalClasses: number;
}

const FUNCTION_KINDS = new Set([
  "function_declaration", "function_definition", "function_item",
  "arrow_function", "method_definition", "method_declaration",
  "method", "singleton_method", "function_signature", "method_signature",
  "FnProto", "local_function",
]);

const CLASS_KINDS = new Set([
  "class_declaration", "class_definition", "class_specifier",
  "class", "struct_item", "struct_specifier", "struct_declaration",
  "interface_declaration", "trait_item", "trait_definition",
  "protocol_declaration", "object_declaration", "object_definition",
  "module", "enum_declaration", "enum_item", "enum_specifier",
]);

function isCamelCase(name: string): boolean {
  return /^[a-z][a-zA-Z0-9]*$/.test(name);
}

function isSnakeCase(name: string): boolean {
  return /^_?[a-z][a-z0-9_]*$/.test(name) && name.includes("_");
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

function classifyNaming(names: string[]): ConventionsReport["namingStyle"]["functions"] {
  if (names.length === 0) return "mixed";

  let camel = 0, snake = 0, pascal = 0;
  for (const name of names) {
    if (name === "<anonymous>" || name.length <= 1) continue;
    if (isCamelCase(name)) camel++;
    else if (isSnakeCase(name)) snake++;
    else if (isPascalCase(name)) pascal++;
  }

  const total = camel + snake + pascal;
  if (total === 0) return "mixed";

  if (camel / total >= 0.6) return "camelCase";
  if (snake / total >= 0.6) return "snake_case";
  if (pascal / total >= 0.6) return "PascalCase";
  return "mixed";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function analyzeConventions(metadata: MetadataStore): ConventionsReport {
  const allChunks: ChunkLightweight[] = metadata.getChunksLightweight();

  const functionNames: string[] = [];
  const classNames: string[] = [];
  const functionLengths: number[] = [];
  let functionsWithDocstring = 0;
  let classesWithDocstring = 0;
  const languageCounts: Record<string, number> = {};

  for (const chunk of allChunks) {
    // Language distribution
    languageCounts[chunk.language] = (languageCounts[chunk.language] ?? 0) + 1;

    const isFunction = FUNCTION_KINDS.has(chunk.kind);
    const isClass = CLASS_KINDS.has(chunk.kind);

    if (isFunction) {
      functionNames.push(chunk.name);
      functionLengths.push(chunk.endLine - chunk.startLine + 1);
      if (chunk.docstring) functionsWithDocstring++;
    }

    if (isClass) {
      classNames.push(chunk.name);
      if (chunk.docstring) classesWithDocstring++;
    }
  }

  const totalDocstringable = functionNames.length + classNames.length;
  const totalWithDocstring = functionsWithDocstring + classesWithDocstring;
  const docstringCoverage = totalDocstringable > 0
    ? Math.round((totalWithDocstring / totalDocstringable) * 100)
    : 0;

  const avgLength = functionLengths.length > 0
    ? Math.round(functionLengths.reduce((a, b) => a + b, 0) / functionLengths.length)
    : 0;

  // Top call targets from call_edges
  const topCallTargets = metadata.getTopCallTargets(10);

  return {
    namingStyle: {
      functions: classifyNaming(functionNames),
      classes: classifyNaming(classNames),
    },
    docstringCoverage,
    averageFunctionLength: avgLength,
    medianFunctionLength: Math.round(median(functionLengths)),
    topCallTargets,
    languageDistribution: languageCounts,
    totalFunctions: functionNames.length,
    totalClasses: classNames.length,
  };
}
