import { resolve, dirname } from "path";
import { mkdirSync } from "fs";
import type Database from "better-sqlite3";
import type { StoredChunk, ChunkScoringInfo } from "./types.js";
import type { CallEdge } from "../analysis/call-graph.js";
import type { ConventionsReport } from "../analysis/conventions.js";
import { openSqliteWithRecovery } from "./sqlite-utils.js";
import { ChunkStore } from "./chunk-store.js";
import { CallEdgeStore } from "./call-edge-store.js";
import { StatsStore } from "./stats-store.js";
import { ConventionsStore } from "./conventions-store.js";
import { ImportStore } from "./import-store.js";
import type { ImportRecord } from "./import-store.js";

// Re-export focused stores and types for consumers
export { ChunkStore, type ChunkLightweight } from "./chunk-store.js";
export { CallEdgeStore } from "./call-edge-store.js";
export { StatsStore } from "./stats-store.js";
export { ConventionsStore } from "./conventions-store.js";
export { ImportStore, type ImportRecord } from "./import-store.js";

/**
 * Facade that composes the focused stores (ChunkStore, CallEdgeStore,
 * StatsStore, ConventionsStore) behind the original MetadataStore API.
 * All methods delegate to the appropriate sub-store, preserving full
 * backward compatibility for existing callers.
 */
export class MetadataStore {
  private db: Database.Database;
  private chunks: ChunkStore;
  private callEdges: CallEdgeStore;
  private stats: StatsStore;
  private conventions: ConventionsStore;
  private imports: ImportStore;

  constructor(dataDir: string) {
    const dbPath = resolve(dataDir, "metadata.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openSqliteWithRecovery(dbPath);
    this.chunks = new ChunkStore(this.db);
    this.callEdges = new CallEdgeStore(this.db);
    this.stats = new StatsStore(this.db);
    this.conventions = new ConventionsStore(this.stats);
    this.imports = new ImportStore(this.db);

    this.chunks.initSchema();
    this.callEdges.initSchema();
    this.stats.initSchema();
    this.imports.initSchema();
  }

  // --- Chunk delegation -------------------------------------------------------

  upsertFile(path: string, hash: string): void {
    this.chunks.upsertFile(path, hash);
  }

  removeFile(path: string): void {
    this.db.transaction(() => {
      this.chunks.removeFile(path);
      this.callEdges.removeCallEdgesForFile(path);
      this.imports.removeImportsForFile(path);
    })();
  }

  upsertChunk(chunk: StoredChunk): void {
    this.chunks.upsertChunk(chunk);
  }

  removeChunksForFile(filePath: string): void {
    this.chunks.removeChunksForFile(filePath);
  }

  getChunk(id: string): StoredChunk | undefined {
    return this.chunks.getChunk(id);
  }

  getChunkScoringInfo(ids: string[]): ChunkScoringInfo[] {
    return this.chunks.getChunkScoringInfo(ids);
  }

  getChunksByIds(ids: string[]): StoredChunk[] {
    return this.chunks.getChunksByIds(ids);
  }

  getAllChunks(): StoredChunk[] {
    return this.chunks.getAllChunks();
  }

  getChunksLightweight() {
    return this.chunks.getChunksLightweight();
  }

  getStats(): {
    totalFiles: number;
    totalChunks: number;
    languages: Record<string, number>;
  } {
    return {
      totalFiles: this.chunks.getFileCount(),
      totalChunks: this.chunks.getChunkCount(),
      languages: this.chunks.getLanguageCounts(),
    };
  }

  findChunksByNames(names: string[]): StoredChunk[] {
    return this.chunks.findChunksByNames(names);
  }

  findSiblings(
    parentName: string,
    filePath: string,
    excludeId: string,
    limit?: number
  ): StoredChunk[] {
    return this.chunks.findSiblings(parentName, filePath, excludeId, limit);
  }

  bulkUpsertChunks(chunks: StoredChunk[]): void {
    this.chunks.bulkUpsertChunks(chunks);
  }

  // --- Stats delegation -------------------------------------------------------

  setStat(key: string, value: string): void {
    this.stats.setStat(key, value);
  }

  getStat(key: string): string | undefined {
    return this.stats.getStat(key);
  }

  incrementRouteStat(route: "skip" | "R0" | "R1" | "R2"): void {
    this.stats.incrementRouteStat(route);
  }

  incrementStat(key: string, delta: number = 1): void {
    this.stats.incrementStat(key, delta);
  }

  recordLatency(latencyMs: number): void {
    this.stats.recordLatency(latencyMs);
  }

  getLatencyPercentiles(): { avg: number; p50: number; p95: number; count: number } {
    return this.stats.getLatencyPercentiles();
  }

  // --- Call edges delegation --------------------------------------------------

  upsertCallEdges(edges: CallEdge[]): void {
    this.callEdges.upsertCallEdges(edges);
  }

  removeCallEdgesForFile(filePath: string): void {
    this.callEdges.removeCallEdgesForFile(filePath);
  }

  findCallers(
    targetName: string,
    limit?: number,
    targetFilePath?: string
  ): Array<{ chunkId: string; filePath: string; line: number; callerName: string; receiver?: string }> {
    return this.callEdges.findCallers(targetName, limit, targetFilePath);
  }

  findCallees(
    sourceName: string,
    limit?: number
  ): Array<{ targetName: string; callType: string; line: number; filePath: string; receiver?: string; targetFilePath?: string }> {
    return this.callEdges.findCallees(sourceName, limit);
  }

  findCalleesForChunk(
    sourceChunkId: string,
    limit?: number
  ): Array<{ targetName: string; callType: string; line: number; filePath: string; receiver?: string; targetFilePath?: string }> {
    return this.callEdges.findCalleesForChunk(sourceChunkId, limit);
  }

  getTopCallTargets(limit?: number): string[] {
    return this.callEdges.getTopCallTargets(limit);
  }

  // --- Conventions delegation -------------------------------------------------

  setConventions(report: ConventionsReport): void {
    this.conventions.setConventions(report);
  }

  getConventions(): ConventionsReport | undefined {
    return this.conventions.getConventions();
  }

  // --- Imports delegation -----------------------------------------------------

  upsertImports(records: ImportRecord[]): void {
    this.imports.upsertImports(records);
  }

  getImportsForFile(filePath: string): ImportRecord[] {
    return this.imports.getImportsForFile(filePath);
  }

  findImporterFiles(resolvedPath: string): string[] {
    return this.imports.findImporterFiles(resolvedPath);
  }

  findImportByName(name: string, filePath?: string): ImportRecord[] {
    return this.imports.findImportByName(name, filePath);
  }

  findChunksByFilePath(filePath: string): StoredChunk[] {
    return this.chunks.findChunksByFilePath(filePath);
  }

  removeImportsForFile(filePath: string): void {
    this.imports.removeImportsForFile(filePath);
  }

  // --- Lifecycle --------------------------------------------------------------

  close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // ignore checkpoint errors on close
    }
    this.db.close();
  }
}
