import type Database from "better-sqlite3";
import type { CallEdge } from "../analysis/call-graph.js";

export class CallEdgeStore {
  private insertStmt!: Database.Statement;
  private deleteByFileStmt!: Database.Statement;
  private findCallersStmt!: Database.Statement;
  private findCallersByTargetIdStmt!: Database.Statement;
  private findCallersWithFileStmt!: Database.Statement;
  private findCalleesStmt!: Database.Statement;
  private findCalleesForChunkStmt!: Database.Statement;
  private getTopCallTargetsStmt!: Database.Statement;
  private clearStmt!: Database.Statement;
  private getAllResolvedStmt!: Database.Statement;

  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS call_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_chunk_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        call_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        receiver TEXT,
        target_file_path TEXT,
        target_id TEXT,
        target_kind TEXT,
        resolution_source TEXT
      );
    `);

    // Migration: add columns if they don't exist (for existing databases)
    const cols = this.db.prepare("PRAGMA table_info(call_edges)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "receiver")) {
      this.db.exec("ALTER TABLE call_edges ADD COLUMN receiver TEXT");
    }
    if (!cols.some((c) => c.name === "target_file_path")) {
      this.db.exec("ALTER TABLE call_edges ADD COLUMN target_file_path TEXT");
    }
    if (!cols.some((c) => c.name === "target_id")) {
      this.db.exec("ALTER TABLE call_edges ADD COLUMN target_id TEXT");
    }
    if (!cols.some((c) => c.name === "target_kind")) {
      this.db.exec("ALTER TABLE call_edges ADD COLUMN target_kind TEXT");
    }
    if (!cols.some((c) => c.name === "resolution_source")) {
      this.db.exec("ALTER TABLE call_edges ADD COLUMN resolution_source TEXT");
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_call_edges_source ON call_edges(source_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_call_edges_target ON call_edges(target_name);
      CREATE INDEX IF NOT EXISTS idx_call_edges_target_file ON call_edges(target_name, target_file_path);
      CREATE INDEX IF NOT EXISTS idx_call_edges_target_id ON call_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_call_edges_file ON call_edges(file_path);
    `);

    // Cache prepared statements
    this.insertStmt = this.db.prepare(
      `INSERT INTO call_edges
       (source_chunk_id, target_name, call_type, file_path, line, receiver, target_file_path, target_id, target_kind, resolution_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.deleteByFileStmt = this.db.prepare(`DELETE FROM call_edges WHERE file_path = ?`);
    this.findCallersStmt = this.db.prepare(
      `SELECT ce.source_chunk_id, ce.file_path, ce.line, ce.receiver, c.name as caller_name, c.kind as caller_kind
       FROM call_edges ce
       LEFT JOIN chunks c ON c.id = ce.source_chunk_id
       WHERE ce.target_name = ?
       LIMIT ?`
    );
    this.findCallersByTargetIdStmt = this.db.prepare(
      `SELECT ce.source_chunk_id, ce.file_path, ce.line, ce.receiver, c.name as caller_name, c.kind as caller_kind
       FROM call_edges ce
       LEFT JOIN chunks c ON c.id = ce.source_chunk_id
       WHERE ce.target_id = ?
       LIMIT ?`
    );
    this.findCallersWithFileStmt = this.db.prepare(
      `SELECT ce.source_chunk_id, ce.file_path, ce.line, ce.receiver, c.name as caller_name, c.kind as caller_kind
       FROM call_edges ce
       LEFT JOIN chunks c ON c.id = ce.source_chunk_id
       WHERE ce.target_name = ?
         AND (ce.target_file_path = ? OR ce.target_file_path IS NULL)
       ORDER BY CASE WHEN ce.target_file_path = ? THEN 0 ELSE 1 END, ce.line ASC
       LIMIT ?`
    );
    this.findCalleesStmt = this.db.prepare(
      `SELECT ce.target_name, ce.call_type, ce.line, ce.file_path, ce.receiver, ce.target_file_path, ce.target_id, ce.target_kind, ce.resolution_source
       FROM call_edges ce
       JOIN chunks c ON c.id = ce.source_chunk_id
       WHERE c.name = ?
       LIMIT ?`
    );
    this.findCalleesForChunkStmt = this.db.prepare(
      `SELECT ce.target_name, ce.call_type, ce.line, ce.file_path, ce.receiver, ce.target_file_path, ce.target_id, ce.target_kind, ce.resolution_source
       FROM call_edges ce
       WHERE ce.source_chunk_id = ?
       LIMIT ?`
    );
    this.getTopCallTargetsStmt = this.db.prepare(
      `SELECT target_name, COUNT(*) as c FROM call_edges GROUP BY target_name ORDER BY c DESC LIMIT ?`
    );
    this.clearStmt = this.db.prepare(`DELETE FROM call_edges`);
    this.getAllResolvedStmt = this.db.prepare(
      `SELECT source_chunk_id, target_name, target_file_path, target_id, call_type, resolution_source, file_path
       FROM call_edges WHERE target_name IS NOT NULL`
    );
  }

  upsertCallEdges(edges: CallEdge[]): void {
    if (edges.length === 0) return;
    const filePaths = [...new Set(edges.map(e => e.filePath))];
    this.db.transaction(() => {
      for (const fp of filePaths) this.deleteByFileStmt.run(fp);
      for (const edge of edges) {
        this.insertStmt.run(
          edge.sourceChunkId,
          edge.targetName,
          edge.callType,
          edge.filePath,
          edge.line,
          edge.receiver ?? null,
          edge.targetFilePath ?? null,
          edge.targetId ?? null,
          edge.targetKind ?? null,
          edge.resolutionSource ?? null
        );
      }
    })();
  }

  removeCallEdgesForFile(filePath: string): void {
    this.deleteByFileStmt.run(filePath);
  }

  findCallers(
    targetName: string,
    limit = 20,
    targetFilePath?: string,
    targetId?: string
  ): Array<{ chunkId: string; filePath: string; line: number; callerName: string; callerKind?: string; receiver?: string }> {
    const rows = (
      targetId
        ? this.findCallersByTargetIdStmt.all(targetId, limit)
        : targetFilePath
        ? this.findCallersWithFileStmt.all(targetName, targetFilePath, targetFilePath, limit)
        : this.findCallersStmt.all(targetName, limit)
    ) as Array<{
      source_chunk_id: string;
      file_path: string;
      line: number;
      receiver: string | null;
      caller_name: string | null;
      caller_kind: string | null;
    }>;

    return rows.map((r) => ({
      chunkId: r.source_chunk_id,
      filePath: r.file_path,
      line: r.line,
      callerName: r.caller_name ?? "<unknown>",
      ...(r.caller_kind != null ? { callerKind: r.caller_kind } : {}),
      ...(r.receiver != null ? { receiver: r.receiver } : {}),
    }));
  }

  findCallees(
    sourceName: string,
    limit = 20
  ): Array<{ targetName: string; callType: string; line: number; filePath: string; receiver?: string; targetFilePath?: string; targetId?: string; targetKind?: string; resolutionSource?: string }> {
    const rows = this.findCalleesStmt.all(sourceName, limit) as Array<{
      target_name: string;
      call_type: string;
      line: number;
      file_path: string;
      receiver: string | null;
      target_file_path: string | null;
      target_id: string | null;
      target_kind: string | null;
      resolution_source: string | null;
    }>;

    return rows.map((r) => ({
      targetName: r.target_name,
      callType: r.call_type,
      line: r.line,
      filePath: r.file_path,
      ...(r.receiver != null ? { receiver: r.receiver } : {}),
      ...(r.target_file_path != null ? { targetFilePath: r.target_file_path } : {}),
      ...(r.target_id != null ? { targetId: r.target_id } : {}),
      ...(r.target_kind != null ? { targetKind: r.target_kind } : {}),
      ...(r.resolution_source != null ? { resolutionSource: r.resolution_source } : {}),
    }));
  }

  findCalleesForChunk(
    sourceChunkId: string,
    limit = 20
  ): Array<{ targetName: string; callType: string; line: number; filePath: string; receiver?: string; targetFilePath?: string; targetId?: string; targetKind?: string; resolutionSource?: string }> {
    const rows = this.findCalleesForChunkStmt.all(sourceChunkId, limit) as Array<{
      target_name: string;
      call_type: string;
      line: number;
      file_path: string;
      receiver: string | null;
      target_file_path: string | null;
      target_id: string | null;
      target_kind: string | null;
      resolution_source: string | null;
    }>;

    return rows.map((r) => ({
      targetName: r.target_name,
      callType: r.call_type,
      line: r.line,
      filePath: r.file_path,
      ...(r.receiver != null ? { receiver: r.receiver } : {}),
      ...(r.target_file_path != null ? { targetFilePath: r.target_file_path } : {}),
      ...(r.target_id != null ? { targetId: r.target_id } : {}),
      ...(r.target_kind != null ? { targetKind: r.target_kind } : {}),
      ...(r.resolution_source != null ? { resolutionSource: r.resolution_source } : {}),
    }));
  }

  getTopCallTargets(limit = 10): string[] {
    const rows = this.getTopCallTargetsStmt.all(limit) as Array<{ target_name: string; c: number }>;
    return rows.map((r) => r.target_name);
  }

  getAllResolvedEdges(): Array<{
    sourceChunkId: string;
    targetName: string;
    targetFilePath: string | null;
    targetId: string | null;
    callType: string;
    resolutionSource: string | null;
    filePath: string;
  }> {
    const rows = this.getAllResolvedStmt.all() as Array<{
      source_chunk_id: string;
      target_name: string;
      target_file_path: string | null;
      target_id: string | null;
      call_type: string;
      resolution_source: string | null;
      file_path: string;
    }>;
    return rows.map(r => ({
      sourceChunkId: r.source_chunk_id,
      targetName: r.target_name,
      targetFilePath: r.target_file_path,
      targetId: r.target_id,
      callType: r.call_type,
      resolutionSource: r.resolution_source,
      filePath: r.file_path,
    }));
  }

  clearAll(): void {
    this.clearStmt.run();
  }
}
