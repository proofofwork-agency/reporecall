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

export interface ChunkFeature {
  chunkId: string;
  filePath: string;
  returnsBoolean: boolean;
  branchCount: number;
  guardCount: number;
  throwsCount: number;
  earlyReturnCount: number;
  callsPredicateCount: number;
  callerCount: number;
  calleeCount: number;
  isPredicate: boolean;
  isValidator: boolean;
  isGuard: boolean;
  isController: boolean;
  isRegistry: boolean;
  isUiComponent: boolean;
  writesState: boolean;
  writesNetwork: boolean;
  writesStorage: boolean;
  docLike: boolean;
  testLike: boolean;
}

export interface FileFeature {
  filePath: string;
  predicateCount: number;
  validatorCount: number;
  guardCount: number;
  controllerCount: number;
  registryCount: number;
  uiComponentCount: number;
  writesStateCount: number;
  writesNetworkCount: number;
  writesStorageCount: number;
  docLike: boolean;
  testLike: boolean;
}

export interface ChunkTag {
  chunkId: string;
  filePath: string;
  tag: string;
  weight: number;
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
