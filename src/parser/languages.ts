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
    extensions: [".cpp", ".hpp", ".cc", ".cxx"],
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
    extractableTypes: ["element"],
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
