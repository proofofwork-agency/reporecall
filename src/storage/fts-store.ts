import { resolve, dirname } from "path";
import { mkdirSync } from "fs";
import type Database from "better-sqlite3";
import { openSqliteWithRecovery } from "./sqlite-utils.js";
import { getLogger } from "../core/logger.js";

export interface FTSResult {
  id: string;
  rank: number;
}

function splitIdentifiers(text: string): string {
  // Split camelCase, PascalCase, snake_case, and kebab-case into separate words
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-./]/g, " ")
    .toLowerCase();
}

export class FTSStore {
  private db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = resolve(dataDir, "fts.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteWithRecovery(dbPath);
    this.init();
  }

  private init(): void {
    // Migration: detect old schema without raw_file_path and rebuild
    const tables = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'`
      )
      .get() as { name: string } | undefined;

    if (tables) {
      const cols = this.db
        .prepare(`PRAGMA table_xinfo(chunks_fts)`)
        .all() as Array<{ name: string }>;
      const hasRawFilePath = cols.some((c) => c.name === "raw_file_path");
      if (!hasRawFilePath) {
        getLogger().warn(
          "FTSStore schema migration: dropping old chunks_fts table (missing raw_file_path). Re-index required."
        );
        this.db.exec(`DROP TABLE chunks_fts`);
      }
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        id UNINDEXED,
        name,
        file_path,
        content,
        kind,
        raw_file_path UNINDEXED,
        tokenize = 'porter'
      );
    `);
  }

  upsert(chunk: {
    id: string;
    name: string;
    filePath: string;
    content: string;
    kind: string;
  }): void {
    // Delete existing entry if any
    this.db.prepare(`DELETE FROM chunks_fts WHERE id = ?`).run(chunk.id);
    this.db
      .prepare(
        `INSERT INTO chunks_fts (id, name, file_path, content, kind, raw_file_path)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        chunk.id,
        splitIdentifiers(chunk.name),
        splitIdentifiers(chunk.filePath),
        splitIdentifiers(chunk.content),
        chunk.kind,
        chunk.filePath
      );
  }

  removeByFile(filePath: string): void {
    this.db
      .prepare(`DELETE FROM chunks_fts WHERE raw_file_path = ?`)
      .run(filePath);
  }

  bulkRemoveByFiles(filePaths: string[]): void {
    if (filePaths.length === 0) return;
    const stmt = this.db.prepare(`DELETE FROM chunks_fts WHERE raw_file_path = ?`);
    this.db.transaction(() => {
      for (const filePath of filePaths) {
        stmt.run(filePath);
      }
    })();
  }

  search(query: string, limit: number = 50): FTSResult[] {
    const normalized = splitIdentifiers(query);
    const terms = normalized
      .replace(/['"*(){}[\]^~\\:]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"`);

    if (terms.length === 0) return [];

    // Try phrase match first for multi-word queries (better for debugging queries)
    if (terms.length > 1) {
      const phraseQuery = `"${normalized.replace(/['"*(){}[\]^~\\:]/g, " ").trim()}"`;
      const phraseResults = this.runFtsQuery(phraseQuery, limit);
      if (phraseResults.length > 0) {
        return phraseResults;
      }
    }

    // Try AND (all terms must match) for precision
    if (terms.length > 1) {
      const andQuery = terms.join(" AND ");
      const andResults = this.runFtsQuery(andQuery, limit);
      if (andResults.length > 0) {
        return andResults;
      }
    }

    // Fall back to OR for recall
    const orQuery = terms.join(" OR ");
    return this.runFtsQuery(orQuery, limit);
  }

  private runFtsQuery(ftsQuery: string, limit: number): FTSResult[] {
    const rows = this.db
      .prepare(
        `SELECT id, rank FROM chunks_fts
         WHERE chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{ id: string; rank: number }>;

    return rows.map((r) => ({ id: r.id, rank: r.rank }));
  }

  bulkUpsert(chunks: Array<{ id: string; name: string; filePath: string; content: string; kind: string }>): void {
    const deleteStmt = this.db.prepare(`DELETE FROM chunks_fts WHERE id = ?`);
    const insertStmt = this.db.prepare(
      `INSERT INTO chunks_fts (id, name, file_path, content, kind, raw_file_path)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const chunk of chunks) {
        deleteStmt.run(chunk.id);
        insertStmt.run(
          chunk.id,
          splitIdentifiers(chunk.name),
          splitIdentifiers(chunk.filePath),
          splitIdentifiers(chunk.content),
          chunk.kind,
          chunk.filePath
        );
      }
    })();
  }

  close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore checkpoint errors on close
    }
    this.db.close();
  }
}
