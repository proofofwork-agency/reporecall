import type Parser from "web-tree-sitter";

type SyntaxNode = Parser.SyntaxNode;

export interface CallEdge {
  sourceChunkId: string;
  targetName: string;
  callType: "call" | "new" | "decorator" | "macro";
  filePath: string;
  line: number;
}

function inferCallType(nodeType: string): CallEdge["callType"] {
  if (nodeType === "new_expression" || nodeType === "object_creation_expression") return "new";
  if (nodeType === "decorator") return "decorator";
  if (nodeType === "macro_invocation") return "macro";
  return "call";
}

function extractCalleeName(node: SyntaxNode): string | undefined {
  // Try the "function" field first (common in many grammars)
  const funcNode = node.childForFieldName("function");
  if (funcNode) {
    // Handle obj.method() — extract just "method"
    if (funcNode.type === "member_expression" || funcNode.type === "field_expression" || funcNode.type === "attribute") {
      const prop = funcNode.childForFieldName("property") ?? funcNode.childForFieldName("field") ?? funcNode.childForFieldName("attribute");
      if (prop) return prop.text;
    }
    // Handle scoped calls like Foo::bar()
    if (funcNode.type === "scoped_identifier") {
      const name = funcNode.childForFieldName("name");
      if (name) return name.text;
    }
    // Simple identifier
    if (funcNode.type === "identifier" || funcNode.type === "type_identifier") {
      return funcNode.text;
    }
    // Fallback: just use the text
    return funcNode.text;
  }

  // For method_invocation (Java): node.childForFieldName("name")
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // For decorators: first named child
  if (node.type === "decorator") {
    const child = node.firstNamedChild;
    if (child) {
      if (child.type === "identifier") return child.text;
      // @module.decorator
      const attr = child.childForFieldName("attribute");
      if (attr) return attr.text;
      return child.text;
    }
  }

  // For macro_invocation (Rust): first child is the macro name
  if (node.type === "macro_invocation") {
    const child = node.firstNamedChild;
    if (child) return child.text.replace(/!$/, "");
  }

  // Fallback: first named child
  const first = node.firstNamedChild;
  if (first && (first.type === "identifier" || first.type === "type_identifier")) {
    return first.text;
  }

  return undefined;
}

function walkForCallNodes(
  node: SyntaxNode,
  callNodeTypes: string[],
  results: SyntaxNode[]
): void {
  if (callNodeTypes.includes(node.type)) {
    results.push(node);
    // Don't recurse into call nodes to avoid double-counting nested calls
    // at this level — but we do want nested calls as separate edges
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkForCallNodes(child, callNodeTypes, results);
  }
}

export function extractCallEdges(
  node: SyntaxNode,
  chunkId: string,
  filePath: string,
  callNodeTypes: string[]
): CallEdge[] {
  const callNodes: SyntaxNode[] = [];
  walkForCallNodes(node, callNodeTypes, callNodes);

  const edges: CallEdge[] = [];
  const seen = new Set<string>();

  for (const callNode of callNodes) {
    const targetName = extractCalleeName(callNode);
    if (!targetName) continue;

    const callType = inferCallType(callNode.type);
    const line = callNode.startPosition.row + 1;
    // Intentional: dedup by targetName:callType per chunk — we record one edge
    // per unique call target per chunk, discarding line info for repeated calls.
    // This keeps the call graph compact without inflating edge counts.
    const key = `${targetName}:${callType}`;

    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({
      sourceChunkId: chunkId,
      targetName,
      callType,
      filePath,
      line,
    });
  }

  return edges;
}
