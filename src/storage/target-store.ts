import type Database from "better-sqlite3";
import type {
  ResolvedTargetAliasHit,
  StoredTarget,
  StoredTargetAlias,
  TargetKind,
} from "./types.js";

export class TargetStore {
  private static readonly SQLITE_PARAM_LIMIT = 900;

  private replaceTargetStmt!: Database.Statement;
  private replaceAliasStmt!: Database.Statement;
  private deleteTargetsStmt!: Database.Statement;
  private deleteAliasesStmt!: Database.Statement;
  private selectTargetByIdStmt!: Database.Statement;
  private selectTargetsByFilePathStmt!: Database.Statement;
  private selectTargetsByIdsStmt!: Database.Statement;
  private selectTargetsBySubsystemStmt!: Database.Statement;
  private selectAliasesByNormalizedStmt!: Database.Statement;

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

    const inPlaceholders = Array.from({ length: TargetStore.SQLITE_PARAM_LIMIT }, () => "?").join(",");
    this.selectTargetByIdStmt = this.db.prepare(`SELECT * FROM targets WHERE id = ?`);
    this.selectTargetsByFilePathStmt = this.db.prepare(
      `SELECT * FROM targets WHERE file_path = ? ORDER BY confidence DESC`
    );
    this.selectTargetsByIdsStmt = this.db.prepare(
      `SELECT * FROM targets WHERE id IN (${inPlaceholders})`
    );
    this.selectTargetsBySubsystemStmt = this.db.prepare(
      `SELECT * FROM targets WHERE subsystem IN (${inPlaceholders}) ORDER BY confidence DESC`
    );
    this.selectAliasesByNormalizedStmt = this.db.prepare(
      `SELECT
         t.*,
         a.alias,
         a.normalized_alias,
         a.source,
         a.weight
       FROM target_aliases a
       JOIN targets t ON t.id = a.target_id
       WHERE a.normalized_alias IN (${inPlaceholders})
       ORDER BY a.weight DESC, t.confidence DESC, LENGTH(a.normalized_alias) DESC`
    );
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
    const row = this.selectTargetByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.mapTarget(row) : undefined;
  }

  getTargetsByIds(ids: string[]): StoredTarget[] {
    if (ids.length === 0) return [];
    const results: StoredTarget[] = [];
    for (let i = 0; i < ids.length; i += TargetStore.SQLITE_PARAM_LIMIT) {
      const batch = ids.slice(i, i + TargetStore.SQLITE_PARAM_LIMIT);
      const rows = this.selectTargetsByIdsStmt.all(...this.padToLimit(batch)) as Array<Record<string, unknown>>;
      results.push(...rows.map((row) => this.mapTarget(row)));
    }
    return results;
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
    const kindSet = kinds && kinds.length > 0 ? new Set<TargetKind>(kinds) : null;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < normalizedAliases.length; i += TargetStore.SQLITE_PARAM_LIMIT) {
      const batch = normalizedAliases.slice(i, i + TargetStore.SQLITE_PARAM_LIMIT);
      const batchRows = this.selectAliasesByNormalizedStmt.all(...this.padToLimit(batch)) as Array<Record<string, unknown>>;
      rows.push(...batchRows);
    }

    const hits: ResolvedTargetAliasHit[] = [];
    for (const row of rows) {
      const target = this.mapTarget(row);
      if (kindSet && !kindSet.has(target.kind)) continue;
      hits.push({
        target,
        alias: row.alias as string,
        normalizedAlias: row.normalized_alias as string,
        source: row.source as StoredTargetAlias["source"],
        weight: row.weight as number,
      });
    }

    hits.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (b.target.confidence !== a.target.confidence) return b.target.confidence - a.target.confidence;
      return b.normalizedAlias.length - a.normalizedAlias.length;
    });
    return hits.slice(0, limit);
  }

  findTargetsByFilePath(filePath: string): StoredTarget[] {
    const rows = this.selectTargetsByFilePathStmt.all(filePath) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapTarget(row));
  }

  findTargetsBySubsystem(subsystems: string[], limit = 25): StoredTarget[] {
    if (subsystems.length === 0) return [];
    const results: StoredTarget[] = [];
    for (let i = 0; i < subsystems.length; i += TargetStore.SQLITE_PARAM_LIMIT) {
      const batch = subsystems.slice(i, i + TargetStore.SQLITE_PARAM_LIMIT);
      const rows = this.selectTargetsBySubsystemStmt.all(...this.padToLimit(batch)) as Array<Record<string, unknown>>;
      results.push(...rows.map((row) => this.mapTarget(row)));
    }
    results.sort((a, b) => b.confidence - a.confidence);
    return results.slice(0, limit);
  }

  private padToLimit(values: string[]): unknown[] {
    const bindings: unknown[] = values.slice();
    while (bindings.length < TargetStore.SQLITE_PARAM_LIMIT) bindings.push(null);
    return bindings;
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
