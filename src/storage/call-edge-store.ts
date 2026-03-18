import type Database from "better-sqlite3";
import type { CallEdge } from "../analysis/call-graph.js";

export class CallEdgeStore {
  private insertStmt!: Database.Statement;
  private deleteStmt!: Database.Statement;
  private removeFileStmt!: Database.Statement;
  private findCallersStmt!: Database.Statement;
  private findCallersWithFileStmt!: Database.Statement;
  private findCalleesStmt!: Database.Statement;
  private findCalleesForChunkStmt!: Database.Statement;

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
        target_file_path TEXT
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_call_edges_source ON call_edges(source_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_call_edges_target ON call_edges(target_name);
      CREATE INDEX IF NOT EXISTS idx_call_edges_target_file ON call_edges(target_name, target_file_path);
      CREATE INDEX IF NOT EXISTS idx_call_edges_file ON call_edges(file_path);
    `);

    // Cache prepared statements
    this.insertStmt = this.db.prepare(
      `INSERT INTO call_edges (source_chunk_id, target_name, call_type, file_path, line, receiver, target_file_path) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.deleteStmt = this.db.prepare(`DELETE FROM call_edges WHERE file_path = ?`);
    this.removeFileStmt = this.db.prepare(`DELETE FROM call_edges WHERE file_path = ?`);
    this.findCallersStmt = this.db.prepare(
      `SELECT ce.source_chunk_id, ce.file_path, ce.line, ce.receiver, c.name as caller_name, c.kind as caller_kind
       FROM call_edges ce
       LEFT JOIN chunks c ON c.id = ce.source_chunk_id
       WHERE ce.target_name = ?
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
      `SELECT ce.target_name, ce.call_type, ce.line, ce.file_path, ce.receiver, ce.target_file_path
       FROM call_edges ce
       JOIN chunks c ON c.id = ce.source_chunk_id
       WHERE c.name = ?
       LIMIT ?`
    );
    this.findCalleesForChunkStmt = this.db.prepare(
      `SELECT ce.target_name, ce.call_type, ce.line, ce.file_path, ce.receiver, ce.target_file_path
       FROM call_edges ce
       WHERE ce.source_chunk_id = ?
       LIMIT ?`
    );
  }

  upsertCallEdges(edges: CallEdge[]): void {
    if (edges.length === 0) return;
    const filePaths = [...new Set(edges.map(e => e.filePath))];
    this.db.transaction(() => {
      for (const fp of filePaths) this.deleteStmt.run(fp);
      for (const edge of edges) {
        this.insertStmt.run(edge.sourceChunkId, edge.targetName, edge.callType, edge.filePath, edge.line, edge.receiver ?? null, edge.targetFilePath ?? null);
      }
    })();
  }

  removeCallEdgesForFile(filePath: string): void {
    this.removeFileStmt.run(filePath);
  }

  findCallers(
    targetName: string,
    limit = 20,
    targetFilePath?: string
  ): Array<{ chunkId: string; filePath: string; line: number; callerName: string; callerKind?: string; receiver?: string }> {
    const rows = (
      targetFilePath
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
  ): Array<{ targetName: string; callType: string; line: number; filePath: string; receiver?: string; targetFilePath?: string }> {
    const rows = this.findCalleesStmt.all(sourceName, limit) as Array<{
      target_name: string;
      call_type: string;
      line: number;
      file_path: string;
      receiver: string | null;
      target_file_path: string | null;
    }>;

    return rows.map((r) => ({
      targetName: r.target_name,
      callType: r.call_type,
      line: r.line,
      filePath: r.file_path,
      ...(r.receiver != null ? { receiver: r.receiver } : {}),
      ...(r.target_file_path != null ? { targetFilePath: r.target_file_path } : {}),
    }));
  }

  findCalleesForChunk(
    sourceChunkId: string,
    limit = 20
  ): Array<{ targetName: string; callType: string; line: number; filePath: string; receiver?: string; targetFilePath?: string }> {
    const rows = this.findCalleesForChunkStmt.all(sourceChunkId, limit) as Array<{
      target_name: string;
      call_type: string;
      line: number;
      file_path: string;
      receiver: string | null;
      target_file_path: string | null;
    }>;

    return rows.map((r) => ({
      targetName: r.target_name,
      callType: r.call_type,
      line: r.line,
      filePath: r.file_path,
      ...(r.receiver != null ? { receiver: r.receiver } : {}),
      ...(r.target_file_path != null ? { targetFilePath: r.target_file_path } : {}),
    }));
  }

  getTopCallTargets(limit = 10): string[] {
    const rows = this.db
      .prepare(
        `SELECT target_name, COUNT(*) as c FROM call_edges GROUP BY target_name ORDER BY c DESC LIMIT ?`
      )
      .all(limit) as Array<{ target_name: string; c: number }>;
    return rows.map((r) => r.target_name);
  }
}
