export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryClass = "rule" | "fact" | "episode" | "working";
export type MemoryScope = "global" | "project" | "branch";
export type MemoryStatus = "active" | "archived" | "superseded";
export type MemorySourceKind = "claude_auto" | "reporecall_local" | "generated";
export type MemoryRoute = "M0" | "M1" | "M2";

export interface MemoryMetadata {
  /** Memory class used for retrieval and compaction */
  class: MemoryClass;
  /** Scope of the memory */
  scope: MemoryScope;
  /** Lifecycle state */
  status: MemoryStatus;
  /** Compressed prompt-ready summary */
  summary: string;
  /** Provenance of the memory file */
  sourceKind: MemorySourceKind;
  /** Stable hash used for dedupe */
  fingerprint: string;
  /** Whether the memory should survive compaction */
  pinned: boolean;
  /** Related file paths encoded as an array */
  relatedFiles: string[];
  /** Related symbols encoded as an array */
  relatedSymbols: string[];
  /** Memory ID this record supersedes, if any */
  supersedesId: string;
  /** Confidence score used during compaction and retrieval */
  confidence: number;
  /** Human-readable compaction or lifecycle reason */
  reason: string;
}

export interface Memory {
  /** Stable ID derived from the file path */
  id: string;
  /** Human-readable name from frontmatter */
  name: string;
  /** One-line description from frontmatter */
  description: string;
  /** Memory category */
  type: MemoryType;
  /** Memory metadata class */
  class?: MemoryClass;
  /** Memory scope */
  scope?: MemoryScope;
  /** Memory lifecycle status */
  status?: MemoryStatus;
  /** Prompt-ready summary */
  summary?: string;
  /** Origin of the memory file */
  sourceKind?: MemorySourceKind;
  /** Stable content hash used for dedupe */
  fingerprint?: string;
  /** Whether this memory is pinned */
  pinned?: boolean;
  /** Related file paths */
  relatedFiles?: string[];
  /** Related symbol names */
  relatedSymbols?: string[];
  /** Superseded memory ID */
  supersedesId?: string;
  /** Confidence score for ranking and compaction */
  confidence?: number;
  /** Lifecycle/compaction reason */
  reason?: string;
  /** Full markdown content (body after frontmatter) */
  content: string;
  /** Absolute path to the source .md file */
  filePath: string;
  /** ISO timestamp of last indexing */
  indexedAt: string;
  /** ISO timestamp of file modification */
  fileMtime: string;
  /** Number of times this memory has been retrieved (default 0) */
  accessCount: number;
  /** ISO timestamp of last retrieval (default "") */
  lastAccessed: string;
  /** Importance weight for scoring (default 1.0) */
  importance: number;
  /** Comma-separated tags for filtering (default "") */
  tags: string;
}

export interface MemorySearchResult {
  id: string;
  score: number;
  name: string;
  description: string;
  type: MemoryType;
  class?: MemoryClass;
  scope?: MemoryScope;
  status?: MemoryStatus;
  summary?: string;
  sourceKind?: MemorySourceKind;
  fingerprint?: string;
  pinned?: boolean;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  supersedesId?: string;
  confidence?: number;
  reason?: string;
  content: string;
  filePath: string;
  indexedAt: string;
  fileMtime: string;
  accessCount: number;
  lastAccessed: string;
  importance: number;
  tags: string;
}

export interface MemorySearchOptions {
  limit?: number;
  types?: MemoryType[];
  minScore?: number;
  classes?: MemoryClass[];
  scopes?: MemoryScope[];
  statuses?: MemoryStatus[];
  minConfidence?: number;
  activeFiles?: string[];
  topCodeFiles?: string[];
  topCodeSymbols?: string[];
}

export interface MemoryCompactionOptions {
  /** Archive episode memories older than this many days. Defaults to 30. */
  archiveEpisodeOlderThanDays?: number;
  /** Keep pinned memories active during compaction. Defaults to true. */
  keepPinned?: boolean;
}

export interface MemoryCompactionResult {
  deduped: number;
  archived: number;
  superseded: number;
}

const TYPE_TO_CLASS: Record<MemoryType, MemoryClass> = {
  feedback: "rule",
  user: "fact",
  project: "fact",
  reference: "fact",
};

const TYPE_TO_SCOPE: Record<MemoryType, MemoryScope> = {
  feedback: "global",
  user: "global",
  project: "project",
  reference: "global",
};

export function resolveMemoryClass(
  memory: Pick<Memory | MemorySearchResult, "class" | "type">
): MemoryClass {
  return memory.class ?? TYPE_TO_CLASS[memory.type] ?? "fact";
}

export function resolveMemoryStatus(
  memory: Pick<Memory | MemorySearchResult, "status">
): MemoryStatus {
  return memory.status ?? "active";
}

export function resolveMemoryScope(
  memory: Pick<Memory | MemorySearchResult, "scope" | "type">
): MemoryScope {
  return memory.scope ?? TYPE_TO_SCOPE[memory.type] ?? "project";
}

export function resolveMemorySummary(
  memory: Pick<Memory | MemorySearchResult, "summary" | "description" | "content">
): string {
  return (memory.summary ?? memory.description ?? memory.content ?? "").trim();
}
