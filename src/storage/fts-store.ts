import { resolve, dirname } from "path";
import { mkdirSync } from "fs";
import type Database from "better-sqlite3";
import { openSqliteWithRecovery } from "./sqlite-utils.js";
import { getLogger } from "../core/logger.js";
import { GENERIC_BROAD_TERMS, STOP_WORDS } from "../search/utils.js";

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
  private upsertDeleteStmt!: Database.Statement;
  private upsertInsertStmt!: Database.Statement;
  private removeByFileStmt!: Database.Statement;
  private searchStmt!: Database.Statement;
  private countStmt!: Database.Statement;
  private clearStmt!: Database.Statement;
  private _totalDocs: number | null = null;
  private _dfCache = new Map<string, number>();

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

    // Cache prepared statements
    this.upsertDeleteStmt = this.db.prepare(`DELETE FROM chunks_fts WHERE id = ?`);
    this.upsertInsertStmt = this.db.prepare(
      `INSERT INTO chunks_fts (id, name, file_path, content, kind, raw_file_path)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.removeByFileStmt = this.db.prepare(`DELETE FROM chunks_fts WHERE raw_file_path = ?`);
    this.searchStmt = this.db.prepare(
      `SELECT id, rank FROM chunks_fts
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    );
    this.countStmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM chunks_fts WHERE chunks_fts MATCH ?`
    );
    this.clearStmt = this.db.prepare(`DELETE FROM chunks_fts`);
  }

  upsert(chunk: {
    id: string;
    name: string;
    filePath: string;
    content: string;
    kind: string;
  }): void {
    this.db.transaction(() => {
      this.upsertDeleteStmt.run(chunk.id);
      this.upsertInsertStmt.run(
        chunk.id,
        splitIdentifiers(chunk.name),
        splitIdentifiers(chunk.filePath),
        splitIdentifiers(chunk.content),
        chunk.kind,
        chunk.filePath
      );
    })();
    this._totalDocs = null;
    this._dfCache.clear();
  }

  removeByFile(filePath: string): void {
    this.removeByFileStmt.run(filePath);
    this._totalDocs = null;
    this._dfCache.clear();
  }

  bulkRemoveByFiles(filePaths: string[]): void {
    if (filePaths.length === 0) return;
    this.db.transaction(() => {
      for (const filePath of filePaths) {
        this.removeByFileStmt.run(filePath);
      }
    })();
    this._totalDocs = null;
    this._dfCache.clear();
  }

  search(query: string, limit: number = 50): FTSResult[] {
    const normalized = splitIdentifiers(query);
    const allTerms = normalized
      .replace(/['"*(){}[\]^~\\:]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0);

    // Strip stop words; fall back to all terms if everything is a stop word
    const contentTerms = allTerms.filter(
      (w) => w.length >= 2 && !STOP_WORDS.has(w.toLowerCase())
    );
    const terms = contentTerms.length > 0 ? contentTerms : allTerms;
    if (terms.length === 0) return [];

    // 1. Phrase match
    if (terms.length > 1) {
      const r = this.runFtsQuery(`"${terms.join(" ")}"`, limit);
      if (r.length > 0) return r;
    }

    // 1.5. CamelCase compound phrase anchor.
    // The FTS index stores split identifiers: "saveFlowToDatabase" → "save flow to database".
    // So "saveFlow" in the query → phrase "save flow" → selectively anchors on those docs.
    // This beats the rarest-term step because "save" and "flow" individually are common,
    // but "save flow" as an adjacent phrase is rare and specific.
    const camelPhrases = query
      .split(/\s+/)
      .filter((w) => /[a-z][A-Z]/.test(w)) // true camelCase (lowercase→uppercase transition)
      .map((w) => {
        const sanitized = w.replace(/['"*(){}[\]^~\\:]/g, "");
        return splitIdentifiers(sanitized).trim();
      });

    for (const phrase of camelPhrases) {
      if (!phrase.includes(" ")) continue; // single token, no compound to anchor on
      // Scope to name field and exclude file-level chunks (SQL migrations, whole-file docs).
      // "saveFlow" → name:"save flow" NOT kind:file  → hits saveFlowToDatabase but not saved_flows migrations.
      const r = this.runFtsQuery(`name:"${phrase}" NOT kind:file`, limit);
      if (r.length > 0) return r;
      // Fallback: full-text phrase (catches identifiers in content but not in a function name).
      const r2 = this.runFtsQuery(`"${phrase}"`, limit);
      if (r2.length > 0) return r2;
    }

    // 2. Anchor on rarest term + OR the rest
    // Finds chunks containing the most discriminative term, ranked by how many others match
    if (terms.length > 1) {
      const anchor = this.rarestTerm(terms);
      if (anchor !== null) {
        const rest = terms.filter((t) => t !== anchor).map((t) => `"${t}"`);
        const q =
          rest.length > 0
            ? `"${anchor}" AND (${rest.join(" OR ")})`
            : `"${anchor}"`;
        const r = this.runFtsQuery(q, limit);
        if (r.length > 0) return r;
      }
    }

    // 3. Selective OR fallback: keep real anchors, drop only high-DF generic
    // broad terms, and replace zero-DF terms with a prefix expansion. This
    // reduces domain-overloaded floods like "flow" without discarding common
    // but meaningful subsystem anchors such as "search" or "daemon".
    const total = this.getTotalDocs();
    const maxDf = total > 0 ? Math.floor(total * 0.15) : Infinity;
    const expanded: string[] = [];

    for (const term of terms) {
      const df = this.getDocFreq(term);
      const isHighDf = df > maxDf;
      const isGenericBroadTerm = GENERIC_BROAD_TERMS.has(term);
      const allowExact = df > 0 && (!isHighDf || !isGenericBroadTerm);

      if (allowExact) expanded.push(`"${term}"`);
      if ((df === 0 || allowExact) && term.length >= 6) {
        expanded.push(`"${term.slice(0, 4)}*"`);
      }
      if (df === 0 && term.length >= 4 && term.length < 6) {
        expanded.push(`"${term.slice(0, 4)}*"`);
      }
    }

    if (expanded.length === 0) {
      for (const term of terms) {
        expanded.push(`"${term}"`);
        if (term.length >= 6) expanded.push(`"${term.slice(0, 4)}*"`);
      }
    }
    return this.runFtsQuery(expanded.join(" OR "), limit);
  }

  // Returns the term with the lowest doc frequency if it's under 15% of total docs, else null.
  private rarestTerm(terms: string[]): string | null {
    const total = this.getTotalDocs();
    if (total === 0) return null;
    const maxDf = Math.floor(total * 0.15);
    let rarest: string | null = null;
    let lowestDf = Infinity;
    for (const term of terms) {
      const df = this.getDocFreq(term);
      if (df < lowestDf) {
        lowestDf = df;
        rarest = term;
      }
    }
    return lowestDf <= maxDf ? rarest : null;
  }

  private getTotalDocs(): number {
    if (this._totalDocs === null) {
      const row = this.db
        .prepare(`SELECT COUNT(*) as cnt FROM chunks_fts`)
        .get() as { cnt: number };
      this._totalDocs = row.cnt;
    }
    return this._totalDocs;
  }

  private getDocFreq(term: string): number {
    const cached = this._dfCache.get(term);
    if (cached !== undefined) return cached;
    try {
      const row = this.countStmt.get(`"${term}"`) as { cnt: number };
      if (this._dfCache.size >= 256) {
        const oldest = this._dfCache.keys().next().value;
        if (oldest !== undefined) this._dfCache.delete(oldest);
      }
      this._dfCache.set(term, row.cnt);
      return row.cnt;
    } catch {
      return 0;
    }
  }

  private runFtsQuery(ftsQuery: string, limit: number): FTSResult[] {
    try {
      const rows = this.searchStmt.all(ftsQuery, limit) as Array<{
        id: string;
        rank: number;
      }>;
      return rows.map((r) => ({ id: r.id, rank: r.rank }));
    } catch {
      return [];
    }
  }

  bulkUpsert(
    chunks: Array<{
      id: string;
      name: string;
      filePath: string;
      content: string;
      kind: string;
    }>
  ): void {
    this.db.transaction(() => {
      for (const chunk of chunks) {
        this.upsertDeleteStmt.run(chunk.id);
        this.upsertInsertStmt.run(
          chunk.id,
          splitIdentifiers(chunk.name),
          splitIdentifiers(chunk.filePath),
          splitIdentifiers(chunk.content),
          chunk.kind,
          chunk.filePath
        );
      }
    })();
    this._totalDocs = null;
    this._dfCache.clear();
  }

  resetAll(): void {
    this.clearStmt.run();
    this._totalDocs = null;
    this._dfCache.clear();
  }

  getDb(): Database.Database {
    return this.db;
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
