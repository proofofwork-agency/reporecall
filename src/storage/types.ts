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

export type TargetKind = "symbol" | "file_module" | "endpoint" | "route" | "subsystem";

export type TargetAliasSource =
  | "symbol"
  | "file_path"
  | "parent_dir"
  | "slug"
  | "literal"
  | "derived";

export interface StoredTarget {
  id: string;
  kind: TargetKind;
  canonicalName: string;
  normalizedName: string;
  filePath: string;
  ownerChunkId?: string;
  subsystem?: string;
  confidence: number;
}

export interface StoredTargetAlias {
  targetId: string;
  alias: string;
  normalizedAlias: string;
  source: TargetAliasSource;
  weight: number;
}

export interface ResolvedTargetAliasHit {
  target: StoredTarget;
  alias: string;
  normalizedAlias: string;
  source: TargetAliasSource;
  weight: number;
}

