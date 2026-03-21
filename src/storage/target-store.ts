import type Database from "better-sqlite3";
import type {
  ResolvedTargetAliasHit,
  StoredTarget,
  StoredTargetAlias,
  TargetKind,
} from "./types.js";

export class TargetStore {
  private replaceTargetStmt!: Database.Statement;
  private replaceAliasStmt!: Database.Statement;
  private deleteTargetsStmt!: Database.Statement;
  private deleteAliasesStmt!: Database.Statement;

  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        owner_chunk_id TEXT,
        subsystem TEXT,
        confidence REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS target_aliases (
        target_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        source TEXT NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY (target_id, normalized_alias, source),
        FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_targets_kind ON targets(kind);
      CREATE INDEX IF NOT EXISTS idx_targets_name ON targets(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_targets_file ON targets(file_path);
      CREATE INDEX IF NOT EXISTS idx_targets_subsystem ON targets(subsystem);
      CREATE INDEX IF NOT EXISTS idx_target_aliases_lookup ON target_aliases(normalized_alias, weight DESC);
    `);

    this.replaceTargetStmt = this.db.prepare(
      `INSERT OR REPLACE INTO targets
       (id, kind, canonical_name, normalized_name, file_path, owner_chunk_id, subsystem, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.replaceAliasStmt = this.db.prepare(
      `INSERT OR REPLACE INTO target_aliases
       (target_id, alias, normalized_alias, source, weight)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.deleteTargetsStmt = this.db.prepare(`DELETE FROM targets`);
    this.deleteAliasesStmt = this.db.prepare(`DELETE FROM target_aliases`);
  }

  replaceAll(targets: StoredTarget[], aliases: StoredTargetAlias[]): void {
    this.db.transaction(() => {
      this.deleteAliasesStmt.run();
      this.deleteTargetsStmt.run();
      for (const target of targets) {
        this.replaceTargetStmt.run(
          target.id,
          target.kind,
          target.canonicalName,
          target.normalizedName,
          target.filePath,
          target.ownerChunkId ?? null,
          target.subsystem ?? null,
          target.confidence
        );
      }
      for (const alias of aliases) {
        this.replaceAliasStmt.run(
          alias.targetId,
          alias.alias,
          alias.normalizedAlias,
          alias.source,
          alias.weight
        );
      }
    })();
  }

  findTargetById(id: string): StoredTarget | undefined {
    const row = this.db.prepare(`SELECT * FROM targets WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.mapTarget(row) : undefined;
  }

  getTargetsByIds(ids: string[]): StoredTarget[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM targets WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapTarget(row));
  }

  clearAll(): void {
    this.db.transaction(() => {
      this.deleteAliasesStmt.run();
      this.deleteTargetsStmt.run();
    })();
  }

  resolveAliases(
    normalizedAliases: string[],
    limit = 25,
    kinds?: TargetKind[]
  ): ResolvedTargetAliasHit[] {
    if (normalizedAliases.length === 0) return [];
    const aliasPlaceholders = normalizedAliases.map(() => "?").join(",");
    const kindClause = kinds && kinds.length > 0
      ? ` AND t.kind IN (${kinds.map(() => "?").join(",")})`
      : "";
    const rows = this.db
      .prepare(
        `SELECT
           t.*,
           a.alias,
           a.normalized_alias,
           a.source,
           a.weight
         FROM target_aliases a
         JOIN targets t ON t.id = a.target_id
         WHERE a.normalized_alias IN (${aliasPlaceholders})${kindClause}
         ORDER BY a.weight DESC, t.confidence DESC, LENGTH(a.normalized_alias) DESC
         LIMIT ?`
      )
      .all(
        ...normalizedAliases,
        ...(kinds ?? []),
        limit
      ) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      target: this.mapTarget(row),
      alias: row.alias as string,
      normalizedAlias: row.normalized_alias as string,
      source: row.source as StoredTargetAlias["source"],
      weight: row.weight as number,
    }));
  }

  findTargetsByFilePath(filePath: string): StoredTarget[] {
    const rows = this.db
      .prepare(`SELECT * FROM targets WHERE file_path = ? ORDER BY confidence DESC`)
      .all(filePath) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapTarget(row));
  }

  findTargetsBySubsystem(subsystems: string[], limit = 25): StoredTarget[] {
    if (subsystems.length === 0) return [];
    const placeholders = subsystems.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM targets
         WHERE subsystem IN (${placeholders})
         ORDER BY confidence DESC
         LIMIT ?`
      )
      .all(...subsystems, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapTarget(row));
  }

  private mapTarget(row: Record<string, unknown>): StoredTarget {
    return {
      id: row.id as string,
      kind: row.kind as TargetKind,
      canonicalName: row.canonical_name as string,
      normalizedName: row.normalized_name as string,
      filePath: row.file_path as string,
      ownerChunkId: (row.owner_chunk_id as string) ?? undefined,
      subsystem: (row.subsystem as string) ?? undefined,
      confidence: Number(row.confidence),
    };
  }
}
