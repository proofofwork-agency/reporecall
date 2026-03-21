/**
 * MemoryStore — SQLite storage + FTS5 for Claude Code memory files.
 *
 * Follows the same patterns as ChunkStore and FTSStore:
 * - Prepared statements cached at init
 * - Transactional bulk operations
 * - FTS5 with porter stemming for keyword search
 * - Schema migrations via PRAGMA table_info
 */

import { resolve, dirname } from "path";
import { mkdirSync } from "fs";
import type Database from "better-sqlite3";
import { openSqliteWithRecovery } from "./sqlite-utils.js";
import type {
  Memory,
  MemoryCompactionOptions,
  MemoryCompactionResult,
  MemoryClass,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  MemorySourceKind,
} from "../memory/types.js";

export interface MemoryFTSResult {
  id: string;
  rank: number;
}

/** Common stop words filtered from FTS5 queries to prevent over-matching */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "am",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "they",
  "this", "that", "these", "those", "what", "which", "who", "whom",
  "how", "when", "where", "why",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about",
  "into", "through", "during", "before", "after", "above", "below",
  "and", "but", "or", "nor", "not", "so", "if", "then", "than",
  "no", "yes", "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "only", "own", "same", "just", "also",
  "use", "used", "using", "make", "made", "get", "set", "let",
  "work", "works", "working", "need", "needs", "want", "like",
  "know", "think", "look", "give", "take", "come", "go", "see",
  "team", "file", "code", "way", "thing", "new", "old", "good", "bad",
]);

function splitIdentifiers(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-./]/g, " ")
    .toLowerCase();
}

function stringifyList(values: string[] | undefined): string {
  return JSON.stringify(values ?? []);
}

function parseStoredList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
        .filter((item) => item.length > 0);
    }
  } catch {
    // Fall through to delimiter splitting.
  }

  return trimmed
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseStoredBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (/^(true|1|yes|on)$/i.test(value)) return true;
    if (/^(false|0|no|off)$/i.test(value)) return false;
  }
  return fallback;
}

function parseStoredNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function defaultClassForType(type: MemoryType): MemoryClass {
  switch (type) {
    case "feedback":
      return "rule";
    case "user":
      return "fact";
    case "project":
      return "fact";
    case "reference":
      return "fact";
  }
}

function defaultScopeForType(type: MemoryType): MemoryScope {
  switch (type) {
    case "feedback":
      return "global";
    case "user":
      return "global";
    case "project":
      return "project";
    case "reference":
      return "global";
  }
}

function defaultSourceKindFromPath(filePath: string): MemorySourceKind {
  return filePath.includes("/reporecall-memories/") || filePath.includes("\\reporecall-memories\\")
    ? "reporecall_local"
    : "claude_auto";
}

type ResolvedMemory = Omit<
  Memory,
  | "class"
  | "scope"
  | "status"
  | "summary"
  | "sourceKind"
  | "fingerprint"
  | "pinned"
  | "relatedFiles"
  | "relatedSymbols"
  | "supersedesId"
  | "confidence"
  | "reason"
> & {
  class: MemoryClass;
  scope: MemoryScope;
  status: MemoryStatus;
  summary: string;
  sourceKind: MemorySourceKind;
  fingerprint: string;
  pinned: boolean;
  relatedFiles: string[];
  relatedSymbols: string[];
  supersedesId: string;
  confidence: number;
  reason: string;
};

export class MemoryStore {
  private db: Database.Database;

  // Metadata prepared statements
  private upsertStmt!: Database.Statement;
  private deleteStmt!: Database.Statement;
  private selectByIdStmt!: Database.Statement;
  private selectAllStmt!: Database.Statement;
  private selectByTypeStmt!: Database.Statement;
  private selectCountStmt!: Database.Statement;
  private selectByFilePathStmt!: Database.Statement;
  private recordAccessStmt!: Database.Statement;
  private selectByNameStmt!: Database.Statement;
  private updateMetadataStmt!: Database.Statement;
  private selectByFingerprintStmt!: Database.Statement;

  // FTS prepared statements
  private ftsDeleteStmt!: Database.Statement;
  private ftsInsertStmt!: Database.Statement;
  private ftsSearchStmt!: Database.Statement;

  constructor(dataDir: string) {
    const dbPath = resolve(dataDir, "memories.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteWithRecovery(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        type TEXT NOT NULL,
        memory_class TEXT NOT NULL DEFAULT 'fact',
        memory_scope TEXT NOT NULL DEFAULT 'project',
        memory_status TEXT NOT NULL DEFAULT 'active',
        memory_summary TEXT NOT NULL DEFAULT '',
        source_kind TEXT NOT NULL DEFAULT 'claude_auto',
        fingerprint TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        related_files TEXT NOT NULL DEFAULT '[]',
        related_symbols TEXT NOT NULL DEFAULT '[]',
        supersedes_id TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        reason TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        indexed_at TEXT NOT NULL,
        file_mtime TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_name ON memories(name);
      CREATE INDEX IF NOT EXISTS idx_memories_file_path ON memories(file_path);
    `);

    // Migrate: add new columns if missing
    const columns = this.db.pragma("table_info(memories)") as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));
    if (!colNames.has("access_count")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0`);
    }
    if (!colNames.has("last_accessed")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN last_accessed TEXT DEFAULT ''`);
    }
    if (!colNames.has("importance")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN importance REAL DEFAULT 1.0`);
    }
    if (!colNames.has("tags")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN tags TEXT DEFAULT ''`);
    }
    if (!colNames.has("memory_class")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN memory_class TEXT DEFAULT 'fact'`);
    }
    if (!colNames.has("memory_scope")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN memory_scope TEXT DEFAULT 'project'`);
    }
    if (!colNames.has("memory_status")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN memory_status TEXT DEFAULT 'active'`);
    }
    if (!colNames.has("memory_summary")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN memory_summary TEXT DEFAULT ''`);
    }
    if (!colNames.has("source_kind")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN source_kind TEXT DEFAULT 'claude_auto'`);
    }
    if (!colNames.has("fingerprint")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN fingerprint TEXT DEFAULT ''`);
    }
    if (!colNames.has("pinned")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER DEFAULT 0`);
    }
    if (!colNames.has("related_files")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN related_files TEXT DEFAULT '[]'`);
    }
    if (!colNames.has("related_symbols")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN related_symbols TEXT DEFAULT '[]'`);
    }
    if (!colNames.has("supersedes_id")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN supersedes_id TEXT DEFAULT ''`);
    }
    if (!colNames.has("confidence")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN confidence REAL DEFAULT 0.5`);
    }
    if (!colNames.has("reason")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN reason TEXT DEFAULT ''`);
    }

    // FTS5 table for keyword search (includes tags for auto-generated terms).
    // FTS5 tables can't be ALTERed, so we detect schema drift and recreate.
    let needsFtsRebuild = false;
    const ftsExists = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories_fts'`
    ).get() as { name: string } | undefined;
    if (ftsExists) {
      // Check if the tags column exists via PRAGMA
      const cols = this.db.prepare(`PRAGMA table_xinfo(memories_fts)`).all() as Array<{ name: string }>;
      const expectedColumns = new Set([
        "id",
        "name",
        "description",
        "memory_summary",
        "content",
        "type",
        "memory_class",
        "memory_scope",
        "memory_status",
        "source_kind",
        "fingerprint",
        "tags",
        "related_files",
        "related_symbols",
        "reason",
      ]);
      const present = new Set(cols.map((c) => c.name));
      const hasAllColumns = Array.from(expectedColumns).every((column) => present.has(column));
      if (!hasAllColumns) {
        this.db.transaction(() => {
          this.db.exec(`DROP TABLE IF EXISTS memories_fts`);
        })();
        needsFtsRebuild = true;
      }
    } else {
      needsFtsRebuild = true;
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        name,
        description,
        memory_summary,
        content,
        type,
        memory_class,
        memory_scope,
        memory_status,
        source_kind,
        fingerprint,
        tags,
        related_files,
        related_symbols,
        reason,
        tokenize = 'porter'
      );
    `);

    // If we recreated the FTS table, repopulate from the memories table
    if (needsFtsRebuild) {
      const rows = this.db.prepare(`
        SELECT
          id,
          name,
          description,
          memory_summary,
          content,
          type,
          memory_class,
          memory_scope,
          memory_status,
          source_kind,
          fingerprint,
          tags,
          related_files,
          related_symbols,
          reason
        FROM memories
      `).all() as Array<Record<string, unknown>>;
      const insertFts = this.db.prepare(
        `INSERT INTO memories_fts (
          id, name, description, memory_summary, content, type, memory_class, memory_scope, memory_status, source_kind, fingerprint, tags, related_files, related_symbols, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const rebuild = this.db.transaction(() => {
        for (const row of rows) {
          insertFts.run(
            row.id,
            splitIdentifiers(String(row.name ?? "")),
            splitIdentifiers(String(row.description ?? "")),
            splitIdentifiers(String(row.memory_summary ?? "")),
            splitIdentifiers(String(row.content ?? "")),
            String(row.type ?? ""),
            splitIdentifiers(String(row.memory_class ?? "")),
            splitIdentifiers(String(row.memory_scope ?? "")),
            splitIdentifiers(String(row.memory_status ?? "")),
            splitIdentifiers(String(row.source_kind ?? "")),
            splitIdentifiers(String(row.fingerprint ?? "")),
            splitIdentifiers(String(row.tags ?? "")),
            splitIdentifiers(String(row.related_files ?? "")),
            splitIdentifiers(String(row.related_symbols ?? "")),
            splitIdentifiers(String(row.reason ?? ""))
          );
        }
      });
      rebuild();
    }

    // Prepare statements
    this.upsertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO memories
       (id, name, description, type, memory_class, memory_scope, memory_status, memory_summary, source_kind, fingerprint, pinned, related_files, related_symbols, supersedes_id, confidence, reason, content, file_path, indexed_at, file_mtime, access_count, last_accessed, importance, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.deleteStmt = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    this.selectByIdStmt = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
    this.selectAllStmt = this.db.prepare(`SELECT * FROM memories ORDER BY indexed_at DESC`);
    this.selectByTypeStmt = this.db.prepare(
      `SELECT * FROM memories WHERE type = ? ORDER BY indexed_at DESC`
    );
    this.selectCountStmt = this.db.prepare(`SELECT COUNT(*) as c FROM memories`);
    this.selectByFilePathStmt = this.db.prepare(`SELECT * FROM memories WHERE file_path = ?`);
    this.recordAccessStmt = this.db.prepare(
      `UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`
    );
    this.selectByNameStmt = this.db.prepare(`SELECT * FROM memories WHERE name = ? LIMIT 1`);
    this.updateMetadataStmt = this.db.prepare(
      `UPDATE memories SET
        memory_class = ?,
        memory_scope = ?,
        memory_status = ?,
        memory_summary = ?,
        source_kind = ?,
        fingerprint = ?,
        pinned = ?,
        related_files = ?,
        related_symbols = ?,
        supersedes_id = ?,
        confidence = ?,
        reason = ?
       WHERE id = ?`
    );
    this.selectByFingerprintStmt = this.db.prepare(`SELECT * FROM memories WHERE fingerprint = ?`);

    this.ftsDeleteStmt = this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`);
    this.ftsInsertStmt = this.db.prepare(
      `INSERT INTO memories_fts (
        id, name, description, memory_summary, content, type, memory_class, memory_scope, memory_status, source_kind, fingerprint, tags, related_files, related_symbols, reason
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.ftsSearchStmt = this.db.prepare(
      `SELECT id, rank FROM memories_fts
       WHERE memories_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    );
  }

  upsert(memory: Memory): void {
    const normalized = this.normalizeMemory(memory);
    this.db.transaction(() => {
      this.upsertStmt.run(
        normalized.id,
        normalized.name,
        normalized.description,
        normalized.type,
        normalized.class,
        normalized.scope,
        normalized.status,
        normalized.summary,
        normalized.sourceKind,
        normalized.fingerprint,
        normalized.pinned ? 1 : 0,
        stringifyList(normalized.relatedFiles),
        stringifyList(normalized.relatedSymbols),
        normalized.supersedesId,
        normalized.confidence,
        normalized.reason,
        normalized.content,
        normalized.filePath,
        normalized.indexedAt,
        normalized.fileMtime,
        normalized.accessCount,
        normalized.lastAccessed,
        normalized.importance,
        normalized.tags
      );

      // Update FTS
      this.ftsDeleteStmt.run(normalized.id);
      this.ftsInsertStmt.run(
        normalized.id,
        splitIdentifiers(normalized.name),
        splitIdentifiers(normalized.description),
        splitIdentifiers(normalized.summary),
        splitIdentifiers(normalized.content),
        normalized.type,
        splitIdentifiers(normalized.class),
        splitIdentifiers(normalized.scope),
        splitIdentifiers(normalized.status),
        splitIdentifiers(normalized.sourceKind),
        splitIdentifiers(normalized.fingerprint),
        splitIdentifiers(normalized.tags),
        splitIdentifiers(stringifyList(normalized.relatedFiles)),
        splitIdentifiers(stringifyList(normalized.relatedSymbols)),
        splitIdentifiers(normalized.reason)
      );
    })();
  }

  remove(id: string): void {
    this.db.transaction(() => {
      this.deleteStmt.run(id);
      this.ftsDeleteStmt.run(id);
    })();
  }

  get(id: string): Memory | undefined {
    const row = this.selectByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  getByFilePath(filePath: string): Memory | undefined {
    const row = this.selectByFilePathStmt.get(filePath) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  getAll(): Memory[] {
    const rows = this.selectAllStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  getByType(type: MemoryType): Memory[] {
    const rows = this.selectByTypeStmt.all(type) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  getCount(): number {
    return (this.selectCountStmt.get() as { c: number }).c;
  }

  /**
   * FTS5 keyword search over memories.
   * Tries phrase match -> AND -> OR (same strategy as FTSStore).
   */
  search(query: string, limit: number = 20): MemoryFTSResult[] {
    const normalized = splitIdentifiers(query);
    const terms = normalized
      .replace(/['"*(){}[\]^~\\:]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()))
      .map((w) => `"${w}"`);

    if (terms.length === 0) return [];

    // Phrase match for multi-word queries
    if (terms.length > 1) {
      const phraseQuery = `"${normalized.replace(/['"*(){}[\]^~\\:]/g, " ").trim()}"`;
      const phraseResults = this.runFtsQuery(phraseQuery, limit);
      if (phraseResults.length > 0) return phraseResults;
    }

    // AND match
    if (terms.length > 1) {
      const andQuery = terms.join(" AND ");
      const andResults = this.runFtsQuery(andQuery, limit);
      if (andResults.length > 0) return andResults;
    }

    // OR fallback
    const orQuery = terms.join(" OR ");
    return this.runFtsQuery(orQuery, limit);
  }

  private runFtsQuery(ftsQuery: string, limit: number): MemoryFTSResult[] {
    try {
      const rows = this.ftsSearchStmt.all(ftsQuery, limit) as Array<{
        id: string;
        rank: number;
      }>;
      return rows.map((r) => ({ id: r.id, rank: r.rank }));
    } catch {
      // FTS query syntax error — return empty
      return [];
    }
  }

  /**
   * Find memories with similar names (for dedup).
   */
  findByName(name: string): Memory[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE name = ?`)
      .all(name) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  recordAccess(id: string): void {
    this.recordAccessStmt.run(new Date().toISOString(), id);
  }

  updateMetadata(id: string, patch: Partial<Memory>): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const merged = this.normalizeMemory({
      ...existing,
      ...patch,
      id,
      filePath: patch.filePath ?? existing.filePath,
    });

    this.db.transaction(() => {
      this.updateMetadataStmt.run(
        merged.class,
        merged.scope,
        merged.status,
        merged.summary,
        merged.sourceKind,
        merged.fingerprint,
        merged.pinned ? 1 : 0,
        stringifyList(merged.relatedFiles),
        stringifyList(merged.relatedSymbols),
        merged.supersedesId,
        merged.confidence,
        merged.reason,
        merged.id
      );
      this.ftsDeleteStmt.run(merged.id);
      this.ftsInsertStmt.run(
        merged.id,
        splitIdentifiers(merged.name),
        splitIdentifiers(merged.description),
        splitIdentifiers(merged.summary),
        splitIdentifiers(merged.content),
        merged.type,
        splitIdentifiers(merged.class),
        splitIdentifiers(merged.scope),
        splitIdentifiers(merged.status),
        splitIdentifiers(merged.sourceKind),
        splitIdentifiers(merged.fingerprint),
        splitIdentifiers(merged.tags),
        splitIdentifiers(stringifyList(merged.relatedFiles)),
        splitIdentifiers(stringifyList(merged.relatedSymbols)),
        splitIdentifiers(merged.reason)
      );
    })();

    return true;
  }

  archive(id: string, reason: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.updateMetadata(id, {
      status: "archived",
      reason,
    });
    return true;
  }

  supersede(id: string, supersedesId: string, reason: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.updateMetadata(id, {
      status: "superseded",
      supersedesId,
      reason,
    });
    return true;
  }

  findByFingerprint(fingerprint: string): Memory[] {
    const rows = this.selectByFingerprintStmt.all(fingerprint) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  compact(options: MemoryCompactionOptions = {}): MemoryCompactionResult {
    const archiveEpisodeOlderThanDays = options.archiveEpisodeOlderThanDays ?? 30;
    const keepPinned = options.keepPinned ?? true;
    const rows = this.getAll();
    let deduped = 0;
    let archived = 0;
    let superseded = 0;

    const byFingerprint = new Map<string, Memory[]>();
    for (const memory of rows) {
      if (!memory.fingerprint) continue;
      const bucket = byFingerprint.get(memory.fingerprint) ?? [];
      bucket.push(memory);
      byFingerprint.set(memory.fingerprint, bucket);
    }

    for (const [, memories] of byFingerprint) {
      if (memories.length < 2) continue;

      const sorted = memories.slice().sort((a, b) => {
        if (keepPinned && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.status !== b.status) return a.status === "active" ? -1 : 1;
        const aConfidence = a.confidence ?? 0;
        const bConfidence = b.confidence ?? 0;
        if (bConfidence !== aConfidence) return bConfidence - aConfidence;
        if (b.accessCount !== a.accessCount) return b.accessCount - a.accessCount;
        return new Date(b.indexedAt).getTime() - new Date(a.indexedAt).getTime();
      });

      const keep = sorted[0];
      if (!keep) continue;

      for (const memory of sorted.slice(1)) {
        if (memory.id === keep.id) continue;
        if (memory.status !== "superseded") {
          this.supersede(memory.id, keep.id, `Superseded by ${keep.name} during fingerprint compaction`);
          deduped++;
          superseded++;
        }
      }
    }

    const now = Date.now();
    const archiveAfterMs = archiveEpisodeOlderThanDays * 24 * 60 * 60 * 1000;
    for (const memory of rows) {
      if (memory.status !== "active") continue;
      if (keepPinned && memory.pinned) continue;
      if (memory.class !== "episode") continue;
      const ageMs = now - new Date(memory.indexedAt).getTime();
      if (ageMs <= archiveAfterMs) continue;
      this.archive(memory.id, `Archived episode older than ${archiveEpisodeOlderThanDays} days`);
      archived++;
    }

    return { deduped, archived, superseded };
  }

  getByName(name: string): Memory | undefined {
    const row = this.selectByNameStmt.get(name) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore checkpoint errors on close
    }
    this.db.close();
  }

  private mapRow(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      type: row.type as MemoryType,
      class: this.mapClass(row.memory_class, row.type as MemoryType),
      scope: this.mapScope(row.memory_scope, row.type as MemoryType),
      status: this.mapStatus(row.memory_status),
      summary: (row.memory_summary as string) ?? "",
      sourceKind: this.mapSourceKind(row.source_kind, row.file_path as string),
      fingerprint: (row.fingerprint as string) ?? "",
      pinned: parseStoredBoolean(row.pinned, false),
      relatedFiles: parseStoredList(row.related_files),
      relatedSymbols: parseStoredList(row.related_symbols),
      supersedesId: (row.supersedes_id as string) ?? "",
      confidence: parseStoredNumber(row.confidence, 0.5),
      reason: (row.reason as string) ?? "",
      content: row.content as string,
      filePath: row.file_path as string,
      indexedAt: row.indexed_at as string,
      fileMtime: row.file_mtime as string,
      accessCount: (row.access_count as number) ?? 0,
      lastAccessed: (row.last_accessed as string) ?? "",
      importance: (row.importance as number) ?? 1.0,
      tags: (row.tags as string) ?? "",
    };
  }

  private normalizeMemory(memory: Memory): ResolvedMemory {
    return {
      ...memory,
      class: memory.class ?? defaultClassForType(memory.type),
      scope: memory.scope ?? defaultScopeForType(memory.type),
      status: memory.status ?? "active",
      summary: memory.summary ?? "",
      sourceKind: memory.sourceKind ?? defaultSourceKindFromPath(memory.filePath),
      fingerprint: memory.fingerprint ?? "",
      pinned: memory.pinned ?? false,
      relatedFiles: memory.relatedFiles ?? [],
      relatedSymbols: memory.relatedSymbols ?? [],
      supersedesId: memory.supersedesId ?? "",
      confidence: memory.confidence ?? 0.5,
      reason: memory.reason ?? "",
      accessCount: memory.accessCount ?? 0,
      lastAccessed: memory.lastAccessed ?? "",
      importance: memory.importance ?? 1.0,
      tags: memory.tags ?? "",
    } as ResolvedMemory;
  }

  private mapClass(value: unknown, type: MemoryType): MemoryClass {
    if (value === "rule" || value === "fact" || value === "episode" || value === "working") {
      return value;
    }
    return defaultClassForType(type);
  }

  private mapScope(value: unknown, type: MemoryType): MemoryScope {
    if (value === "global" || value === "project" || value === "branch") {
      return value;
    }
    return defaultScopeForType(type);
  }

  private mapStatus(value: unknown): MemoryStatus {
    if (value === "active" || value === "archived" || value === "superseded") {
      return value;
    }
    return "active";
  }

  private mapSourceKind(value: unknown, filePath: string): MemorySourceKind {
    if (value === "claude_auto" || value === "reporecall_local" || value === "generated") {
      return value;
    }
    return defaultSourceKindFromPath(filePath);
  }
}
