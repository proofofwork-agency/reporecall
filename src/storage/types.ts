export interface StoredChunk {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
  docstring?: string;
  parentName?: string;
  language: string;
  indexedAt: string;
  fileMtime?: string;
  isExported?: boolean;
}

export interface ChunkScoringInfo {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  parentName?: string;
  indexedAt: string;
  fileMtime?: string;
  startLine: number;
  endLine: number;
}


