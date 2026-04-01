import type Database from "better-sqlite3";
import type { ChunkFeature, ChunkTag, FileFeature, StoredChunk } from "./types.js";

export class SemanticStore {
  private replaceChunkFeatureStmt!: Database.Statement;
  private replaceFileFeatureStmt!: Database.Statement;
  private insertChunkTagStmt!: Database.Statement;
  private deleteChunkFeaturesByFileStmt!: Database.Statement;
  private deleteFileFeaturesByFileStmt!: Database.Statement;
  private deleteChunkTagsByFileStmt!: Database.Statement;
  private selectPredicateLikeChunksStmt!: Database.Statement;
  private selectChunkFeaturesByIdsSql = `SELECT * FROM chunk_features WHERE chunk_id IN (__IDS__)`;
  private selectChunkTagsByIdsSql = `SELECT chunk_id, file_path, tag, weight FROM chunk_tags WHERE chunk_id IN (__IDS__) ORDER BY weight DESC, tag ASC`;
  private selectFileFeaturesSql = `SELECT * FROM file_features WHERE file_path IN (__IDS__)`;
  private clearChunkFeaturesStmt!: Database.Statement;
  private clearFileFeaturesStmt!: Database.Statement;
  private clearChunkTagsStmt!: Database.Statement;

  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_features (
        chunk_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        returns_boolean INTEGER NOT NULL DEFAULT 0,
        branch_count INTEGER NOT NULL DEFAULT 0,
        guard_count INTEGER NOT NULL DEFAULT 0,
        throws_count INTEGER NOT NULL DEFAULT 0,
        early_return_count INTEGER NOT NULL DEFAULT 0,
        calls_predicate_count INTEGER NOT NULL DEFAULT 0,
        caller_count INTEGER NOT NULL DEFAULT 0,
        callee_count INTEGER NOT NULL DEFAULT 0,
        is_predicate INTEGER NOT NULL DEFAULT 0,
        is_validator INTEGER NOT NULL DEFAULT 0,
        is_guard INTEGER NOT NULL DEFAULT 0,
        is_controller INTEGER NOT NULL DEFAULT 0,
        is_registry INTEGER NOT NULL DEFAULT 0,
        is_ui_component INTEGER NOT NULL DEFAULT 0,
        writes_state INTEGER NOT NULL DEFAULT 0,
        writes_network INTEGER NOT NULL DEFAULT 0,
        writes_storage INTEGER NOT NULL DEFAULT 0,
        doc_like INTEGER NOT NULL DEFAULT 0,
        test_like INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS file_features (
        file_path TEXT PRIMARY KEY,
        predicate_count INTEGER NOT NULL DEFAULT 0,
        validator_count INTEGER NOT NULL DEFAULT 0,
        guard_count INTEGER NOT NULL DEFAULT 0,
        controller_count INTEGER NOT NULL DEFAULT 0,
        registry_count INTEGER NOT NULL DEFAULT 0,
        ui_component_count INTEGER NOT NULL DEFAULT 0,
        writes_state_count INTEGER NOT NULL DEFAULT 0,
        writes_network_count INTEGER NOT NULL DEFAULT 0,
        writes_storage_count INTEGER NOT NULL DEFAULT 0,
        doc_like INTEGER NOT NULL DEFAULT 0,
        test_like INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS chunk_tags (
        chunk_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        tag TEXT NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY (chunk_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_chunk_features_file ON chunk_features(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunk_features_roles ON chunk_features(is_predicate, is_validator, is_guard);
      CREATE INDEX IF NOT EXISTS idx_chunk_features_flags ON chunk_features(doc_like, test_like, is_registry, is_ui_component);
      CREATE INDEX IF NOT EXISTS idx_file_features_flags ON file_features(doc_like, test_like);
      CREATE INDEX IF NOT EXISTS idx_chunk_tags_tag ON chunk_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_chunk_tags_file ON chunk_tags(file_path);
    `);

    this.replaceChunkFeatureStmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunk_features
      (chunk_id, file_path, returns_boolean, branch_count, guard_count, throws_count, early_return_count,
       calls_predicate_count, caller_count, callee_count, is_predicate, is_validator, is_guard, is_controller,
       is_registry, is_ui_component, writes_state, writes_network, writes_storage, doc_like, test_like)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.replaceFileFeatureStmt = this.db.prepare(`
      INSERT OR REPLACE INTO file_features
      (file_path, predicate_count, validator_count, guard_count, controller_count, registry_count, ui_component_count,
       writes_state_count, writes_network_count, writes_storage_count, doc_like, test_like)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertChunkTagStmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunk_tags (chunk_id, file_path, tag, weight) VALUES (?, ?, ?, ?)
    `);
    this.deleteChunkFeaturesByFileStmt = this.db.prepare(`DELETE FROM chunk_features WHERE file_path = ?`);
    this.deleteFileFeaturesByFileStmt = this.db.prepare(`DELETE FROM file_features WHERE file_path = ?`);
    this.deleteChunkTagsByFileStmt = this.db.prepare(`DELETE FROM chunk_tags WHERE file_path = ?`);
    this.selectPredicateLikeChunksStmt = this.db.prepare(`
      SELECT c.*
      FROM chunks c
      JOIN chunk_features cf ON cf.chunk_id = c.id
      WHERE (cf.is_predicate = 1 OR cf.is_validator = 1 OR cf.is_guard = 1 OR cf.branch_count >= 2)
        AND cf.doc_like = 0
        AND cf.test_like = 0
      ORDER BY
        (cf.is_validator + cf.is_guard + cf.is_predicate) DESC,
        (cf.guard_count + cf.branch_count + cf.calls_predicate_count) DESC,
        c.start_line ASC
      LIMIT ?
    `);
    this.clearChunkFeaturesStmt = this.db.prepare(`DELETE FROM chunk_features`);
    this.clearFileFeaturesStmt = this.db.prepare(`DELETE FROM file_features`);
    this.clearChunkTagsStmt = this.db.prepare(`DELETE FROM chunk_tags`);
  }

  replaceChunkFeatures(features: ChunkFeature[]): void {
    if (features.length === 0) return;
    const filePaths = [...new Set(features.map((feature) => feature.filePath))];
    this.db.transaction(() => {
      for (const filePath of filePaths) this.deleteChunkFeaturesByFileStmt.run(filePath);
      for (const feature of features) {
        this.replaceChunkFeatureStmt.run(
          feature.chunkId,
          feature.filePath,
          feature.returnsBoolean ? 1 : 0,
          feature.branchCount,
          feature.guardCount,
          feature.throwsCount,
          feature.earlyReturnCount,
          feature.callsPredicateCount,
          feature.callerCount,
          feature.calleeCount,
          feature.isPredicate ? 1 : 0,
          feature.isValidator ? 1 : 0,
          feature.isGuard ? 1 : 0,
          feature.isController ? 1 : 0,
          feature.isRegistry ? 1 : 0,
          feature.isUiComponent ? 1 : 0,
          feature.writesState ? 1 : 0,
          feature.writesNetwork ? 1 : 0,
          feature.writesStorage ? 1 : 0,
          feature.docLike ? 1 : 0,
          feature.testLike ? 1 : 0
        );
      }
    })();
  }

  replaceFileFeatures(features: FileFeature[]): void {
    if (features.length === 0) return;
    const filePaths = [...new Set(features.map((feature) => feature.filePath))];
    this.db.transaction(() => {
      for (const filePath of filePaths) this.deleteFileFeaturesByFileStmt.run(filePath);
      for (const feature of features) {
        this.replaceFileFeatureStmt.run(
          feature.filePath,
          feature.predicateCount,
          feature.validatorCount,
          feature.guardCount,
          feature.controllerCount,
          feature.registryCount,
          feature.uiComponentCount,
          feature.writesStateCount,
          feature.writesNetworkCount,
          feature.writesStorageCount,
          feature.docLike ? 1 : 0,
          feature.testLike ? 1 : 0
        );
      }
    })();
  }

  replaceChunkTags(tags: ChunkTag[]): void {
    if (tags.length === 0) return;
    const filePaths = [...new Set(tags.map((tag) => tag.filePath))];
    this.db.transaction(() => {
      for (const filePath of filePaths) this.deleteChunkTagsByFileStmt.run(filePath);
      for (const tag of tags) {
        this.insertChunkTagStmt.run(tag.chunkId, tag.filePath, tag.tag, tag.weight);
      }
    })();
  }

  removeByFile(filePath: string): void {
    this.deleteChunkFeaturesByFileStmt.run(filePath);
    this.deleteFileFeaturesByFileStmt.run(filePath);
    this.deleteChunkTagsByFileStmt.run(filePath);
  }

  getChunkFeaturesByIds(chunkIds: string[]): ChunkFeature[] {
    if (chunkIds.length === 0) return [];
    return this.queryInBatches(chunkIds, this.selectChunkFeaturesByIdsSql).map((row) => this.mapChunkFeature(row));
  }

  getChunkTagsByIds(chunkIds: string[]): ChunkTag[] {
    if (chunkIds.length === 0) return [];
    return this.queryInBatches(chunkIds, this.selectChunkTagsByIdsSql).map((row) => ({
      chunkId: row.chunk_id as string,
      filePath: row.file_path as string,
      tag: row.tag as string,
      weight: row.weight as number,
    }));
  }

  getFileFeatures(filePaths: string[]): FileFeature[] {
    if (filePaths.length === 0) return [];
    return this.queryInBatches(filePaths, this.selectFileFeaturesSql).map((row) => this.mapFileFeature(row));
  }

  findPredicateLikeChunks(limit = 80): StoredChunk[] {
    const rows = this.selectPredicateLikeChunksStmt.all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
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
    }));
  }

  clearAll(): void {
    this.db.transaction(() => {
      this.clearChunkTagsStmt.run();
      this.clearFileFeaturesStmt.run();
      this.clearChunkFeaturesStmt.run();
    })();
  }

  private mapChunkFeature(row: Record<string, unknown>): ChunkFeature {
    return {
      chunkId: row.chunk_id as string,
      filePath: row.file_path as string,
      returnsBoolean: (row.returns_boolean as number) === 1,
      branchCount: row.branch_count as number,
      guardCount: row.guard_count as number,
      throwsCount: row.throws_count as number,
      earlyReturnCount: row.early_return_count as number,
      callsPredicateCount: row.calls_predicate_count as number,
      callerCount: row.caller_count as number,
      calleeCount: row.callee_count as number,
      isPredicate: (row.is_predicate as number) === 1,
      isValidator: (row.is_validator as number) === 1,
      isGuard: (row.is_guard as number) === 1,
      isController: (row.is_controller as number) === 1,
      isRegistry: (row.is_registry as number) === 1,
      isUiComponent: (row.is_ui_component as number) === 1,
      writesState: (row.writes_state as number) === 1,
      writesNetwork: (row.writes_network as number) === 1,
      writesStorage: (row.writes_storage as number) === 1,
      docLike: (row.doc_like as number) === 1,
      testLike: (row.test_like as number) === 1,
    };
  }

  private mapFileFeature(row: Record<string, unknown>): FileFeature {
    return {
      filePath: row.file_path as string,
      predicateCount: row.predicate_count as number,
      validatorCount: row.validator_count as number,
      guardCount: row.guard_count as number,
      controllerCount: row.controller_count as number,
      registryCount: row.registry_count as number,
      uiComponentCount: row.ui_component_count as number,
      writesStateCount: row.writes_state_count as number,
      writesNetworkCount: row.writes_network_count as number,
      writesStorageCount: row.writes_storage_count as number,
      docLike: (row.doc_like as number) === 1,
      testLike: (row.test_like as number) === 1,
    };
  }

  private queryInBatches(
    ids: string[],
    sqlTemplate: string
  ): Array<Record<string, unknown>> {
    const SQLITE_PARAM_LIMIT = 900;
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < ids.length; i += SQLITE_PARAM_LIMIT) {
      const batch = ids.slice(i, i + SQLITE_PARAM_LIMIT);
      const placeholders = batch.map(() => "?").join(",");
      const sql = sqlTemplate.replace("__IDS__", placeholders);
      const rows = this.db.prepare(sql).all(...batch) as Array<Record<string, unknown>>;
      results.push(...rows);
    }
    return results;
  }
}
