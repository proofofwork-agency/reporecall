import type Database from "better-sqlite3";
import type { CallEdge } from "../analysis/call-graph.js";

export class CallEdgeStore {
  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS call_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_chunk_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        call_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_call_edges_source ON call_edges(source_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_call_edges_target ON call_edges(target_name);
    `);
  }

  upsertCallEdges(edges: CallEdge[]): void {
    if (edges.length === 0) return;
    const filePaths = [...new Set(edges.map(e => e.filePath))];
    const del = this.db.prepare(`DELETE FROM call_edges WHERE file_path = ?`);
    const ins = this.db.prepare(
      `INSERT INTO call_edges (source_chunk_id, target_name, call_type, file_path, line) VALUES (?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const fp of filePaths) del.run(fp);
      for (const edge of edges) {
        ins.run(edge.sourceChunkId, edge.targetName, edge.callType, edge.filePath, edge.line);
      }
    })();
  }

  removeCallEdgesForFile(filePath: string): void {
    this.db.prepare(`DELETE FROM call_edges WHERE file_path = ?`).run(filePath);
  }

  findCallers(
    targetName: string,
    limit = 20
  ): Array<{ chunkId: string; filePath: string; line: number; callerName: string }> {
    const rows = this.db
      .prepare(
        `SELECT ce.source_chunk_id, ce.file_path, ce.line, c.name as caller_name
         FROM call_edges ce
         LEFT JOIN chunks c ON c.id = ce.source_chunk_id
         WHERE ce.target_name = ?
         LIMIT ?`
      )
      .all(targetName, limit) as Array<{
        source_chunk_id: string;
        file_path: string;
        line: number;
        caller_name: string | null;
      }>;

    return rows.map((r) => ({
      chunkId: r.source_chunk_id,
      filePath: r.file_path,
      line: r.line,
      callerName: r.caller_name ?? "<unknown>",
    }));
  }

  findCallees(
    sourceName: string,
    limit = 20
  ): Array<{ targetName: string; callType: string; line: number; filePath: string }> {
    const rows = this.db
      .prepare(
        `SELECT ce.target_name, ce.call_type, ce.line, ce.file_path
         FROM call_edges ce
         JOIN chunks c ON c.id = ce.source_chunk_id
         WHERE c.name = ?
         LIMIT ?`
      )
      .all(sourceName, limit) as Array<{
        target_name: string;
        call_type: string;
        line: number;
        file_path: string;
      }>;

    return rows.map((r) => ({
      targetName: r.target_name,
      callType: r.call_type,
      line: r.line,
      filePath: r.file_path,
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
