import type { QueryMode } from "./intent.js";

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
  deliveryMode?: "code_context" | "summary_only";
}

export interface HookDebugRecord {
  queryMode: QueryMode;
  intentType: { isCodeQuery: boolean; needsNavigation: boolean };
  skipReason: string | null;
  injectedTokenCount: number;
  injectedChunkCount: number;
  seedCandidate: string | null;  // null until Phase 3
  confidence: number | null;     // null until Phase 3
  latencyMs: number;
  query: string;
  sanitizedQuery: string;
  memoryRoute?: "M0" | "M1" | "M2";
  memoryTokenCount?: number;
  memoryCount?: number;
  memoryNames?: string[];
  memoryDropped?: Array<{
    name: string;
    class: string;
    reason: string;
  }>;
  memoryBudgetUsed?: number;
  memoryBudgetTotal?: number;
  deliveryMode?: "code_context" | "summary_only";
  contextStrength?: "sufficient" | "partial" | "weak";
  executionSurface?: string;
  selectedFiles?: string[];
  missingEvidence?: string[];
  recommendedNextReads?: string[];
  dominantFamily?: string;
  familyConfidence?: number;
  deferredReason?: string;
}
