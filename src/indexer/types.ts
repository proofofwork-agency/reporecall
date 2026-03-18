import type { CodeChunk } from "../parser/types.js";

export interface IndexedChunk extends CodeChunk {
  vector: number[];
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions(): number;
  /** Whether this provider produces real embeddings. NullEmbedder returns false. */
  isEnabled(): boolean;
}

export type FileChange =
  | { path: string; type: 'added' | 'modified'; hash: string }
  | { path: string; type: 'deleted' }

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  lastIndexedAt: string;
  languages: Record<string, number>;
  storageBytes: number;
}
