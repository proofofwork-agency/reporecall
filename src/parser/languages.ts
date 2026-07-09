export interface LanguageConfig {
  extensions: string[];
  wasmName: string;
  extractableTypes: string[];
  docstringTypes: string[];
  callNodeTypes?: string[];
}

export const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  typescript: {
    extensions: [".ts"],
    wasmName: "tree-sitter-typescript",
    extractableTypes: [
      "function_declaration",
      "arrow_function",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["call_expression", "new_expression"],
  },
  tsx: {
    extensions: [".tsx"],
    wasmName: "tree-sitter-tsx",
    extractableTypes: [
      "function_declaration",
      "arrow_function",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["call_expression", "new_expression"],
  },
  javascript: {
    extensions: [".js", ".jsx"],
    wasmName: "tree-sitter-javascript",
    extractableTypes: [
      "function_declaration",
      "arrow_function",
      "method_definition",
      "class_declaration",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["call_expression", "new_expression"],
  },
  python: {
    extensions: [".py"],
    wasmName: "tree-sitter-python",
    extractableTypes: [
      "function_definition",
      "class_definition",
      "decorated_definition",
    ],
    docstringTypes: ["expression_statement"],
    callNodeTypes: ["call", "decorator"],
  },
  go: {
    extensions: [".go"],
    wasmName: "tree-sitter-go",
    extractableTypes: [
      "function_declaration",
      "method_declaration",
      "type_declaration",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["call_expression"],
  },
  rust: {
    extensions: [".rs"],
    wasmName: "tree-sitter-rust",
    extractableTypes: [
      "function_item",
      "impl_item",
      "struct_item",
      "enum_item",
      "trait_item",
    ],
    docstringTypes: ["line_comment", "block_comment"],
    callNodeTypes: ["call_expression", "macro_invocation"],
  },
  java: {
    extensions: [".java"],
    wasmName: "tree-sitter-java",
    extractableTypes: [
      "method_declaration",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
    ],
    docstringTypes: ["block_comment"],
    callNodeTypes: ["method_invocation", "object_creation_expression"],
  },
  ruby: {
    extensions: [".rb"],
    wasmName: "tree-sitter-ruby",
    extractableTypes: [
      "method",
      "singleton_method",
      "class",
      "module",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["call", "method_call"],
  },
  css: {
    extensions: [".css", ".scss"],
    wasmName: "tree-sitter-css",
    extractableTypes: ["rule_set", "media_statement", "keyframes_statement"],
    docstringTypes: ["comment"],
  },
  c: {
    extensions: [".c", ".h"],
    wasmName: "tree-sitter-c",
    extractableTypes: [
      "function_definition",
      "struct_specifier",
      "enum_specifier",
      "type_definition",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["call_expression"],
  },
  cpp: {
    extensions: [".cpp", ".hpp", ".cc", ".cxx", ".hh", ".hxx", ".hcc"],
    wasmName: "tree-sitter-cpp",
    extractableTypes: [
      "function_definition",
      "class_specifier",
      "struct_specifier",
      "enum_specifier",
      "namespace_definition",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["call_expression"],
  },
  csharp: {
    extensions: [".cs"],
    wasmName: "tree-sitter-c_sharp",
    extractableTypes: [
      "method_declaration",
      "class_declaration",
      "interface_declaration",
      "struct_declaration",
      "enum_declaration",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["invocation_expression", "object_creation_expression"],
  },
  php: {
    extensions: [".php"],
    wasmName: "tree-sitter-php",
    extractableTypes: [
      "function_definition",
      "method_declaration",
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["function_call_expression", "method_call_expression"],
  },
  swift: {
    extensions: [".swift"],
    wasmName: "tree-sitter-swift",
    extractableTypes: [
      "function_declaration",
      "class_declaration",
      "struct_declaration",
      "protocol_declaration",
      "enum_declaration",
    ],
    docstringTypes: ["comment"],
    callNodeTypes: ["call_expression"],
  },
  kotlin: {
    extensions: [".kt", ".kts"],
    wasmName: "tree-sitter-kotlin",
    extractableTypes: [
      "function_declaration",
      "class_declaration",
      "object_declaration",
      "interface_declaration",
    ],
    docstringTypes: ["multiline_comment"],
    callNodeTypes: ["call_expression"],
  },
  scala: {
    extensions: [".scala"],
    wasmName: "tree-sitter-scala",
    extractableTypes: [
      "function_definition",
      "class_definition",
      "object_definition",
      "trait_definition",
    ],
    docstringTypes: ["block_comment"],
    callNodeTypes: ["call_expression"],
  },
  zig: {
    extensions: [".zig"],
    wasmName: "tree-sitter-zig",
    extractableTypes: ["function_declaration", "test_declaration"],
    docstringTypes: ["doc_comment", "line_comment"],
  },
  bash: {
    extensions: [".sh", ".bash"],
    wasmName: "tree-sitter-bash",
    extractableTypes: ["function_definition"],
    docstringTypes: ["comment"],
  },
  lua: {
    extensions: [".lua"],
    wasmName: "tree-sitter-lua",
    extractableTypes: [
      "function_definition_statement",
      "local_function_definition_statement",
    ],
    docstringTypes: ["comment"],
  },
  html: {
    extensions: [".html", ".htm"],
    wasmName: "tree-sitter-html",
    // Only chunk semantic top-level blocks that carry real content.
    // The generic "element" node matches EVERY tag, which produced hundreds
    // of junk <div>/<span> chunks per page.
    extractableTypes: ["script_element", "style_element"],
    docstringTypes: ["comment"],
  },
  vue: {
    extensions: [".vue"],
    wasmName: "tree-sitter-vue",
    extractableTypes: [
      "component",
      "script_element",
      "template_element",
      "style_element",
    ],
    docstringTypes: ["comment"],
  },
  toml: {
    extensions: [".toml"],
    wasmName: "tree-sitter-toml",
    extractableTypes: ["table", "table_array_element"],
    docstringTypes: ["comment"],
  },
};

export function getLanguageForExtension(
  ext: string
): { language: string; config: LanguageConfig } | undefined {
  for (const [language, config] of Object.entries(LANGUAGE_CONFIGS)) {
    if (config.extensions.includes(ext)) {
      return { language, config };
    }
  }
  return undefined;
}

/**
 * Markers that are unambiguously C++ (the C grammar has no `namespace`,
 * `template`, `class`, `std::`, scope resolution `::`, access specifiers, or
 * C++ standard-library headers). C++ grammar is a near-superset of C, so a
 * false positive (parsing real C as C++) is low-risk, while the reverse
 * (parsing C++ with the C grammar) silently produces error nodes.
 */
const CPP_MARKER_RE =
  /(?:\bnamespace\b|\btemplate\s*<|\bclass\s+[A-Za-z_]\w*|\bpublic:|\bprivate:|\bprotected:|\busing\s+namespace\b|\btypename\b|\bcout\b|\bcin\b|\bendl\b|\w+::\w|#include\s*<(?:vector|string|map|set|unordered_map|unordered_set|list|deque|queue|stack|tuple|array|bitset|memory|algorithm|functional|utility|regex|thread|mutex|atomic|chrono|iostream|fstream|sstream)>)/;

/**
 * Cheap content sniff: tests only the first ~4KB of a file for C++ markers.
 */
export function looksLikeCpp(content: string): boolean {
  return CPP_MARKER_RE.test(content.slice(0, 4096));
}

/**
 * Resolve a language from a file extension, optionally using content to
 * disambiguate. `.h` headers map to C by default but are very commonly C++ in
 * modern codebases; when content is supplied and looks like C++, the C++
 * grammar is used instead to avoid silent parse errors.
 */
export function resolveLanguage(
  ext: string,
  content?: string
): { language: string; config: LanguageConfig } | undefined {
  const base = getLanguageForExtension(ext);
  if (ext === ".h" && base?.language === "c" && content && looksLikeCpp(content)) {
    const cpp = LANGUAGE_CONFIGS.cpp;
    if (cpp) return { language: "cpp", config: cpp };
  }
  return base;
}
