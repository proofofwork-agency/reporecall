export interface SearchResult {
  id: string;
  score: number;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
  docstring?: string;
  parentName?: string;
  language: string;
  hookScore?: number;
}

export interface SearchOptions {
  limit?: number;
  tokenBudget?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  recencyWeight?: number;
  activeFiles?: string[];
  graphExpansion?: boolean;
  graphTopN?: number;
  siblingExpansion?: boolean;
  rerank?: boolean;
  signal?: AbortSignal;
}

export interface AssembledContext {
  text: string;
  tokenCount: number;
  chunks: SearchResult[];
  routeStyle?: "standard" | "concept" | "flow" | "deep";
}

export interface HookDebugRecord {
  route: "skip" | "R0" | "R1" | "R2";
  intentType: { isCodeQuery: boolean; needsNavigation: boolean };
  skipReason: string | null;
  injectedTokenCount: number;
  injectedChunkCount: number;
  seedCandidate: string | null;  // null until Phase 3
  confidence: number | null;     // null until Phase 3
  latencyMs: number;
  query: string;
  sanitizedQuery: string;
}
