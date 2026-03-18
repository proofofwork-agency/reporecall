import type Database from "better-sqlite3";
import type { StoredChunk, ChunkScoringInfo } from "./types.js";

/**
 * Lightweight chunk projection used by convention analysis.
 * Contains only the columns required — deliberately excludes `content`
 * to avoid loading multi-KB source text for every chunk when analysing
 * large repositories.
 */
export interface ChunkLightweight {
  filePath: string;
  name: string;
  kind: string;
  language: string;
  startLine: number;
  endLine: number;
  docstring?: string;
}

export class ChunkStore {
  private static readonly SQLITE_PARAM_LIMIT = 900;

  // Cached prepared statements — initialised in initSchema() after the schema
  // is guaranteed to exist.
  private upsertFileStmt!: Database.Statement;
  private deleteFileStmt!: Database.Statement;
  private deleteChunksByFileStmt!: Database.Statement;
  private upsertChunkStmt!: Database.Statement;
  private selectChunkByIdStmt!: Database.Statement;
  private selectAllChunksStmt!: Database.Statement;
  private selectChunksLightweightStmt!: Database.Statement;
  private selectFileCountStmt!: Database.Statement;
  private selectChunkCountStmt!: Database.Statement;
  private selectLanguageCountsStmt!: Database.Statement;
  private selectSiblingsStmt!: Database.Statement;
  private selectChunksByFilePathStmt!: Database.Statement;

  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_modified TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        docstring TEXT,
        parent_name TEXT,
        language TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        file_mtime TEXT,
        is_exported INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_name, file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_name ON chunks(name);
    `);

    // Migration: add file_mtime column if missing (for existing databases)
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "file_mtime")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN file_mtime TEXT");
    }
    if (!cols.some((c) => c.name === "is_exported")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN is_exported INTEGER NOT NULL DEFAULT 0");
    }

    // Prepare statements after schema is confirmed to exist.
    this.upsertFileStmt = this.db.prepare(
      `INSERT OR REPLACE INTO files (path, hash, last_modified) VALUES (?, ?, ?)`
    );
    this.deleteFileStmt = this.db.prepare(`DELETE FROM files WHERE path = ?`);
    this.deleteChunksByFileStmt = this.db.prepare(`DELETE FROM chunks WHERE file_path = ?`);
    this.upsertChunkStmt = this.db.prepare(
      `INSERT OR REPLACE INTO chunks
       (id, file_path, name, kind, start_line, end_line, content, docstring, parent_name, language, indexed_at, file_mtime, is_exported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.selectChunkByIdStmt = this.db.prepare(`SELECT * FROM chunks WHERE id = ?`);
    this.selectAllChunksStmt = this.db.prepare(`SELECT * FROM chunks`);
    this.selectChunksLightweightStmt = this.db.prepare(
      `SELECT file_path, name, kind, language, start_line, end_line, docstring FROM chunks`
    );
    this.selectFileCountStmt = this.db.prepare(`SELECT COUNT(*) as c FROM files`);
    this.selectChunkCountStmt = this.db.prepare(`SELECT COUNT(*) as c FROM chunks`);
    this.selectLanguageCountsStmt = this.db.prepare(
      `SELECT language, COUNT(*) as c FROM chunks GROUP BY language ORDER BY c DESC`
    );
    this.selectSiblingsStmt = this.db.prepare(
      `SELECT * FROM chunks
       WHERE parent_name = ? AND file_path = ? AND id != ?
       LIMIT ?`
    );
    this.selectChunksByFilePathStmt = this.db.prepare(
      `SELECT * FROM chunks WHERE file_path = ?
       AND kind != 'file' AND name != '<anonymous>'
       ORDER BY start_line ASC`
    );
  }

  upsertFile(path: string, hash: string): void {
    this.upsertFileStmt.run(path, hash, new Date().toISOString());
  }

  removeFile(path: string): void {
    this.deleteFileStmt.run(path);
    this.deleteChunksByFileStmt.run(path);
  }

  upsertChunk(chunk: StoredChunk): void {
    this.upsertChunkStmt.run(
      chunk.id,
      chunk.filePath,
      chunk.name,
      chunk.kind,
      chunk.startLine,
      chunk.endLine,
      chunk.content,
      chunk.docstring ?? null,
      chunk.parentName ?? null,
      chunk.language,
      chunk.indexedAt,
      chunk.fileMtime ?? null,
      chunk.isExported ? 1 : 0
    );
  }

  removeChunksForFile(filePath: string): void {
    this.deleteChunksByFileStmt.run(filePath);
  }

  getChunk(id: string): StoredChunk | undefined {
    const row = this.selectChunkByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRow(row);
  }

  getChunkScoringInfo(ids: string[]): ChunkScoringInfo[] {
    if (ids.length === 0) return [];
    const results: ChunkScoringInfo[] = [];
    for (let i = 0; i < ids.length; i += ChunkStore.SQLITE_PARAM_LIMIT) {
      const batch = ids.slice(i, i + ChunkStore.SQLITE_PARAM_LIMIT);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT id, file_path, name, kind, parent_name, indexed_at, file_mtime
           FROM chunks WHERE id IN (${placeholders})`
        )
        .all(...batch) as Array<Record<string, unknown>>;
      results.push(...rows.map((row) => ({
        id: row.id as string,
        filePath: row.file_path as string,
        name: row.name as string,
        kind: row.kind as string,
        parentName: (row.parent_name as string) ?? undefined,
        indexedAt: row.indexed_at as string,
        fileMtime: (row.file_mtime as string) ?? undefined,
      })));
    }
    return results;
  }

  getChunksByIds(ids: string[]): StoredChunk[] {
    if (ids.length === 0) return [];
    const results: StoredChunk[] = [];
    for (let i = 0; i < ids.length; i += ChunkStore.SQLITE_PARAM_LIMIT) {
      const batch = ids.slice(i, i + ChunkStore.SQLITE_PARAM_LIMIT);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
        .all(...batch) as Array<Record<string, unknown>>;
      results.push(...rows.map((row) => this.mapRow(row)));
    }
    return results;
  }

  getAllChunks(): StoredChunk[] {
    const rows = this.selectAllChunksStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  getChunksLightweight(): ChunkLightweight[] {
    const rows = this.selectChunksLightweightStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      filePath: row.file_path as string,
      name: row.name as string,
      kind: row.kind as string,
      language: row.language as string,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      docstring: (row.docstring as string) ?? undefined,
    }));
  }

  getFileCount(): number {
    return (this.selectFileCountStmt.get() as { c: number }).c;
  }

  getChunkCount(): number {
    return (this.selectChunkCountStmt.get() as { c: number }).c;
  }

  getLanguageCounts(): Record<string, number> {
    const langRows = this.selectLanguageCountsStmt.all() as Array<{ language: string; c: number }>;
    const languages: Record<string, number> = {};
    for (const row of langRows) {
      languages[row.language] = row.c;
    }
    return languages;
  }

  findChunksByNames(names: string[]): StoredChunk[] {
    if (names.length === 0) return [];
    const results: StoredChunk[] = [];
    for (let i = 0; i < names.length; i += ChunkStore.SQLITE_PARAM_LIMIT) {
      const batch = names.slice(i, i + ChunkStore.SQLITE_PARAM_LIMIT);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM chunks WHERE name IN (${placeholders})`)
        .all(...batch) as Array<Record<string, unknown>>;
      results.push(...rows.map((row) => this.mapRow(row)));
    }
    return results;
  }

  findSiblings(
    parentName: string,
    filePath: string,
    excludeId: string,
    limit = 5
  ): StoredChunk[] {
    const rows = this.selectSiblingsStmt.all(parentName, filePath, excludeId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  findChunksByFilePath(filePath: string): StoredChunk[] {
    const rows = this.selectChunksByFilePathStmt.all(filePath) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  bulkUpsertChunks(chunks: StoredChunk[]): void {
    this.db.transaction(() => {
      for (const chunk of chunks) {
        this.upsertChunkStmt.run(
          chunk.id,
          chunk.filePath,
          chunk.name,
          chunk.kind,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.docstring ?? null,
          chunk.parentName ?? null,
          chunk.language,
          chunk.indexedAt,
          chunk.fileMtime ?? null,
          chunk.isExported ? 1 : 0
        );
      }
    })();
  }

  private mapRow(row: Record<string, unknown>): StoredChunk {
    return {
      id: row.id as string,
      filePath: row.file_path as string,
      name: row.name as string,
      kind: row.kind as string,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      content: row.content as string,
      docstring: (row.docstring as string) ?? undefined,
      parentName: (row.parent_name as string) ?? undefined,
      language: row.language as string,
      indexedAt: row.indexed_at as string,
      fileMtime: (row.file_mtime as string) ?? undefined,
      isExported: (row.is_exported as number) === 1,
    };
  }
}
