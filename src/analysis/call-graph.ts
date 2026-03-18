import type Parser from "web-tree-sitter";

type SyntaxNode = Parser.SyntaxNode;

export interface CallEdge {
  sourceChunkId: string;
  targetName: string;
  receiver?: string;
  targetFilePath?: string;
  callType: "call" | "new" | "decorator" | "macro";
  filePath: string;
  line: number;
}

interface CalleeInfo {
  name: string;
  receiver?: string;
}

function inferCallType(nodeType: string): CallEdge["callType"] {
  if (nodeType === "new_expression" || nodeType === "object_creation_expression") return "new";
  if (nodeType === "decorator") return "decorator";
  if (nodeType === "macro_invocation") return "macro";
  return "call";
}

/**
 * Extracts the receiver (object/qualifier) from a member expression node.
 * For chained access like `this.authService.validate()`, returns the last
 * object before the final property — i.e. "authService".
 */
function extractReceiver(funcNode: SyntaxNode): string | undefined {
  const objectNode = funcNode.childForFieldName("object");
  if (!objectNode) return undefined;

  // For chained member access (e.g. this.sessions.set), take the last
  // object in the chain — the rightmost property before the final call.
  if (
    objectNode.type === "member_expression" ||
    objectNode.type === "field_expression" ||
    objectNode.type === "attribute"
  ) {
    const innerProp =
      objectNode.childForFieldName("property") ??
      objectNode.childForFieldName("field") ??
      objectNode.childForFieldName("attribute");
    if (innerProp) return innerProp.text;
  }

  return objectNode.text;
}

function extractCalleeInfo(node: SyntaxNode): CalleeInfo | undefined {
  // Try the "function" field first (common in many grammars)
  const funcNode = node.childForFieldName("function");
  if (funcNode) {
    // Handle obj.method() — extract "method" as name and "obj" as receiver
    if (funcNode.type === "member_expression" || funcNode.type === "field_expression" || funcNode.type === "attribute") {
      const prop = funcNode.childForFieldName("property") ?? funcNode.childForFieldName("field") ?? funcNode.childForFieldName("attribute");
      if (prop) {
        const receiver = extractReceiver(funcNode);
        return { name: prop.text, receiver };
      }
    }
    // Handle scoped calls like Foo::bar()
    if (funcNode.type === "scoped_identifier") {
      const name = funcNode.childForFieldName("name");
      if (name) {
        const pathNode = funcNode.childForFieldName("path");
        const receiver = pathNode?.text;
        return { name: name.text, receiver };
      }
    }
    // Simple identifier
    if (funcNode.type === "identifier" || funcNode.type === "type_identifier") {
      return { name: funcNode.text };
    }
    // Fallback: just use the text
    return { name: funcNode.text };
  }

  // For method_invocation (Java): node.childForFieldName("name")
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    const objectNode = node.childForFieldName("object");
    const receiver = objectNode?.text;
    return { name: nameNode.text, receiver };
  }

  // For decorators: first named child
  if (node.type === "decorator") {
    const child = node.firstNamedChild;
    if (child) {
      if (child.type === "identifier") return { name: child.text };
      // @module.decorator
      const attr = child.childForFieldName("attribute");
      if (attr) return { name: attr.text };
      return { name: child.text };
    }
  }

  // For macro_invocation (Rust): first child is the macro name
  if (node.type === "macro_invocation") {
    const child = node.firstNamedChild;
    if (child) return { name: child.text.replace(/!$/, "") };
  }

  // Fallback: first named child
  const first = node.firstNamedChild;
  if (first && (first.type === "identifier" || first.type === "type_identifier")) {
    return { name: first.text };
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
    const info = extractCalleeInfo(callNode);
    if (!info) continue;

    const callType = inferCallType(callNode.type);
    const line = callNode.startPosition.row + 1;
    // Intentional: dedup by receiver:targetName:callType per chunk — we record
    // one edge per unique call target per chunk, discarding line info for
    // repeated calls. This keeps the call graph compact without inflating
    // edge counts.
    const key = `${info.receiver ?? ""}:${info.name}:${callType}`;

    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({
      sourceChunkId: chunkId,
      targetName: info.name,
      receiver: info.receiver,
      callType,
      filePath,
      line,
    });
  }

  return edges;
}
