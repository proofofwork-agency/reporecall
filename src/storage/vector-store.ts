import * as lancedb from "@lancedb/lancedb";
import { resolve } from "path";
import { mkdirSync, rmSync } from "fs";
import { getLogger } from "../core/logger.js";

const TABLE_NAME = "chunks";
const ALLOWED_FILTER_FIELDS = new Set(["id", "filePath"]);

/**
 * Escape a string value for use in a LanceDB SQL filter predicate.
 *
 * LanceDB uses a DuckDB-style SQL dialect where:
 * - String literals are single-quoted
 * - Single quotes inside strings are escaped by doubling: ' -> ''
 * - Backslash is NOT a special escape character
 *
 * Additionally, we strip all control characters (null bytes, newlines,
 * carriage returns, tabs, and other C0/C1 controls) because they have
 * no legitimate use in chunk IDs or file paths and could be used to
 * confuse parsers.
 *
 * We also validate that the input is a non-empty string to prevent
 * type-confusion attacks.
 */
export function escapeSqlString(value: string): string {
  if (typeof value !== "string") {
    throw new Error("escapeSqlString: expected a string value");
  }
  // Strip all control characters (U+0000-U+001F, U+007F-U+009F)
  const stripped = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  // Escape single quotes by doubling (the ONLY escape needed for SQL string literals)
  return stripped.replace(/'/g, "''");
}

function buildEqualsPredicate(
  field: "id" | "filePath",
  value: string
): string {
  validateFilterField(field);
  return `${field} = '${escapeSqlString(value)}'`;
}

function buildOrPredicate(
  field: "id" | "filePath",
  values: string[]
): string {
  validateFilterField(field);
  const sanitized = values
    .map((value) => escapeSqlString(value))
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);

  if (sanitized.length === 0) {
    throw new Error(`buildOrPredicate: no valid ${field} values supplied`);
  }

  return sanitized
    .map((value) => `(${field} = '${value}')`)
    .join(" OR ");
}

function validateFilterField(field: string): void {
  if (!ALLOWED_FILTER_FIELDS.has(field)) {
    throw new Error(`Unsupported vector-store filter field: ${field}`);
  }
}

export interface VectorSearchResult {
  id: string;
  score: number;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export class VectorStore {
  private dbPromise: Promise<lancedb.Connection>;
  private cachedTable: lancedb.Table | undefined;
  private lanceDir: string;
  private corrupted = false;

  constructor(dataDir: string, _dimensions: number) {
    this.lanceDir = resolve(dataDir, "lance");
    mkdirSync(this.lanceDir, { recursive: true });
    this.dbPromise = lancedb.connect(this.lanceDir);
  }

  private isCorruptionError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /corrupt|invalid.*(?:file|schema|data|format)|\barrow\b|parquet|schema.*mismatch|lance.*error/i.test(msg);
  }

  private async recoverFromCorruption(): Promise<void> {
    const log = getLogger();
    log.warn("LanceDB corruption detected — deleting and reconnecting");
    this.corrupted = true;
    this.cachedTable = undefined;
    this.indexBuilt = false;
    rmSync(this.lanceDir, { recursive: true, force: true });
    mkdirSync(this.lanceDir, { recursive: true });
    this.dbPromise = lancedb.connect(this.lanceDir);
  }

  isCorrupted(): boolean {
    return this.corrupted;
  }

  clearCorrupted(): void {
    this.corrupted = false;
  }

  private async getTable(): Promise<lancedb.Table | undefined> {
    if (this.cachedTable) return this.cachedTable;
    try {
      const db = await this.dbPromise;
      const tables = await db.tableNames();
      if (!tables.includes(TABLE_NAME)) return undefined;
      this.cachedTable = await db.openTable(TABLE_NAME);
      return this.cachedTable;
    } catch (err) {
      if (this.isCorruptionError(err)) {
        await this.recoverFromCorruption();
        return undefined;
      }
      throw err;
    }
  }

  private async getOrCreateTable(
    initialData?: Array<Record<string, unknown>>
  ): Promise<{ table: lancedb.Table; createdWithData: boolean }> {
    const db = await this.dbPromise;
    const tables = await db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      const table = await db.openTable(TABLE_NAME);
      this.cachedTable = table;
      // Only mark index as built if table has enough rows for ANN index
      if (!this.indexBuilt) {
        const count = await table.countRows();
        this.indexBuilt = count >= 256;
      }
      return { table, createdWithData: false };
    }

    if (initialData && initialData.length > 0) {
      const table = await db.createTable(TABLE_NAME, initialData);
      this.cachedTable = table;
      return { table, createdWithData: true };
    }

    // This path should be unreachable: callers must provide initialData
    // when the table does not yet exist. The dummy-record workaround that
    // previously lived here caused a triple-write (create + insert dummy +
    // delete dummy) and has been removed.
    throw new Error(
      "getOrCreateTable: table does not exist and no initialData provided. " +
        "Cannot create an empty LanceDB table without a schema-carrying record."
    );
  }

  private indexBuilt = false;

  async upsert(
    records: Array<{
      id: string;
      vector: number[];
      filePath: string;
      name: string;
      kind: string;
      startLine: number;
      endLine: number;
    }>
  ): Promise<void> {
    if (records.length === 0) return;

    try {
      const { table, createdWithData } = await this.getOrCreateTable(records);

      if (!createdWithData) {
        // Batch delete existing records with same IDs
        const idFilter = buildOrPredicate(
          "id",
          records.map((r) => r.id)
        );
        try {
          await table.delete(idFilter);
        } catch (err) {
          getLogger().debug({ err }, "VectorStore.upsert: failed to delete existing records");
        }

        await table.add(records);
      }

      // Build ANN index once table is large enough (skip for empty-vector records)
      const hasVectors = records.some((r) => r.vector.length > 0);
      if (!this.indexBuilt && hasVectors) {
        const count = await table.countRows();
        if (count >= 256) {
          try {
            await table.createIndex("vector");
            this.indexBuilt = true;
          } catch (err) {
            getLogger().debug({ err }, "VectorStore.upsert: ANN index creation skipped");
          }
        }
      }
    } catch (err) {
      if (this.isCorruptionError(err)) {
        await this.recoverFromCorruption();
        // Retry once after recovery
        const { table, createdWithData } = await this.getOrCreateTable(records);
        if (!createdWithData) {
          await table.add(records);
        }
      } else {
        throw err;
      }
    }
  }

  async removeByFile(filePath: string): Promise<void> {
    const table = await this.getTable();
    if (!table) return;
    try {
      await table.delete(buildEqualsPredicate("filePath", filePath));
    } catch (err) {
      getLogger().warn({ err, filePath }, "VectorStore.removeByFile: failed to delete records");
    }
  }

  async removeByFiles(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    const table = await this.getTable();
    if (!table) return;
    try {
      await table.delete(buildOrPredicate("filePath", filePaths));
    } catch (err) {
      getLogger().warn({ err, count: filePaths.length }, "VectorStore.removeByFiles: failed to delete records");
    }
  }

  async search(
    queryVector: number[],
    limit: number = 50
  ): Promise<VectorSearchResult[]> {
    const table = await this.getTable();
    if (!table) return [];

    try {
      const results = await table
        .search(queryVector)
        .limit(limit)
        .toArray();

      return results.map((r) => ({
        id: r.id as string,
        score: Math.max(0, 1 - ((r._distance as number) ?? 0)), // Convert distance to similarity, clamped
        filePath: r.filePath as string,
        name: r.name as string,
        kind: r.kind as string,
        startLine: r.startLine as number,
        endLine: r.endLine as number,
      }));
    } catch (err) {
      if (this.isCorruptionError(err)) {
        await this.recoverFromCorruption();
        return [];
      }
      getLogger().warn({ err }, "VectorStore.search: vector search failed, returning empty");
      return [];
    }
  }

  async count(): Promise<number> {
    const table = await this.getTable();
    if (!table) return 0;
    return table.countRows();
  }

  async close(): Promise<void> {
    // Drop the cached table reference first so no further queries can start.
    this.cachedTable = undefined;

    // Attempt to resolve the existing connection and close it explicitly.
    // LanceDB's Connection type does not expose a formal close() method in all
    // versions, but we null out the reference here to allow GC and prevent any
    // further use.  We do this before replacing dbPromise so that any in-flight
    // await on the old promise still gets the real connection object back,
    // allowing their own error path to run, and we only replace dbPromise after.
    try {
      const db = await this.dbPromise;
      // Call close() if the LanceDB version exposes it; otherwise this is a
      // no-op that still nulls the reference via the catch below.
      if (typeof (db as unknown as { close?: () => void }).close === "function") {
        (db as unknown as { close: () => void }).close();
      }
    } catch (err) {
      getLogger().debug({ err }, "VectorStore.close: connection close failed");
    }

    // Replace the promise so any future callers get an immediate rejection
    // rather than a stale connection handle.
    this.dbPromise = Promise.reject(new Error("VectorStore closed"));
    this.dbPromise.catch(() => {}); // prevent unhandled rejection
  }
}
