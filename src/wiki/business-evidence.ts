export function shortOutcome(outcome: string): string {
  const compact = outcome.trim().replace(/\s+/g, " ");
  return compact.length > 100 ? `${compact.slice(0, 97)}...` : compact;
}

export function buildBusinessSafeEvidenceLines(input: {
  nodeCount: number;
  cohesion?: number;
  relatedFiles: string[];
  relatedSymbols: string[];
  linkedCommunities?: number;
}): string[] {
  const lines = [
    input.cohesion === undefined
      ? `- Based on ${input.nodeCount} source nodes from the code graph.`
      : `- Based on ${input.nodeCount} source nodes from a code graph community with cohesion ${input.cohesion.toFixed(2)}.`,
  ];
  if (input.linkedCommunities && input.linkedCommunities > 0) {
    lines.push(`- Aggregates evidence from ${input.linkedCommunities} related code graph communities.`);
  }
  if (input.relatedFiles.length > 0) {
    lines.push(`- Source evidence includes ${input.relatedFiles.length} file${input.relatedFiles.length === 1 ? "" : "s"}.`);
  }
  if (input.relatedSymbols.length > 0) {
    lines.push(`- Source evidence includes ${input.relatedSymbols.length} symbol${input.relatedSymbols.length === 1 ? "" : "s"}.`);
  }
  lines.push("- Technical file and symbol names are exposed separately as structured evidence fields.");
  return lines;
}
