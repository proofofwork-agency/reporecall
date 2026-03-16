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
  siblingExpansion?: boolean;
  rerank?: boolean;
  signal?: AbortSignal;
}

export interface AssembledContext {
  text: string;
  tokenCount: number;
  chunks: SearchResult[];
}
