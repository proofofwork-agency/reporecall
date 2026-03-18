import type Database from "better-sqlite3";

export class StatsStore {
  // Cached prepared statements — initialised in initSchema() after the schema
  // is guaranteed to exist.
  private setStatStmt!: Database.Statement;
  private getStatStmt!: Database.Statement;
  private incrementRouteStatStmt!: Database.Statement;
  private incrementStatStmt!: Database.Statement;
  private insertLatencyStmt!: Database.Statement;
  private pruneLatenciesStmt!: Database.Statement;
  private countLatenciesStmt!: Database.Statement;
  private avgLatencyStmt!: Database.Statement;
  private allLatenciesAscStmt!: Database.Statement;

  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stats (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_latencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        latency_ms REAL NOT NULL
      );
    `);

    // Prepare statements after schema is confirmed to exist.
    this.setStatStmt = this.db.prepare(
      `INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)`
    );
    this.getStatStmt = this.db.prepare(`SELECT value FROM stats WHERE key = ?`);
    this.incrementRouteStatStmt = this.db.prepare(
      `INSERT INTO stats (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
    );
    this.incrementStatStmt = this.db.prepare(
      `INSERT INTO stats (key, value) VALUES (?, CAST(? AS TEXT))
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`
    );
    this.insertLatencyStmt = this.db.prepare(
      `INSERT INTO search_latencies (timestamp, latency_ms) VALUES (?, ?)`
    );
    // Prune old entries, keeping only the most recent 1000.
    // Uses a MIN(sub.id) boundary instead of NOT IN to avoid an O(n) scan.
    this.pruneLatenciesStmt = this.db.prepare(
      `DELETE FROM search_latencies WHERE id < (
        SELECT MIN(sub.id) FROM (
          SELECT id FROM search_latencies ORDER BY id DESC LIMIT 1000
        ) sub
      )`
    );
    this.countLatenciesStmt = this.db.prepare(
      `SELECT COUNT(*) as c FROM search_latencies`
    );
    this.avgLatencyStmt = this.db.prepare(
      `SELECT AVG(latency_ms) as a FROM search_latencies`
    );
    this.allLatenciesAscStmt = this.db.prepare(
      `SELECT latency_ms FROM search_latencies ORDER BY latency_ms ASC`
    );
  }

  setStat(key: string, value: string): void {
    this.setStatStmt.run(key, value);
  }

  getStat(key: string): string | undefined {
    const row = this.getStatStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  incrementRouteStat(route: "skip" | "R0" | "R1" | "R2"): void {
    const key = `route_${route}_count`;
    this.incrementRouteStatStmt.run(key);
  }

  incrementStat(key: string, delta: number = 1): void {
    this.incrementStatStmt.run(key, delta, delta);
  }

  recordLatency(latencyMs: number): void {
    this.db.transaction(() => {
      this.insertLatencyStmt.run(new Date().toISOString(), latencyMs);
      this.pruneLatenciesStmt.run();
    })();
  }

  getLatencyPercentiles(): { avg: number; p50: number; p95: number; count: number } {
    const count = (this.countLatenciesStmt.get() as { c: number }).c;

    if (count === 0) return { avg: 0, p50: 0, p95: 0, count: 0 };

    const avg = (this.avgLatencyStmt.get() as { a: number }).a;

    const rows = this.allLatenciesAscStmt.all() as Array<{ latency_ms: number }>;

    const p50Index = Math.floor(count * 0.5);
    const p95Index = Math.min(Math.floor(count * 0.95), count - 1);

    return {
      avg: Math.round(avg),
      p50: Math.round(rows[p50Index]?.latency_ms ?? 0),
      p95: Math.round(rows[p95Index]?.latency_ms ?? 0),
      count,
    };
  }
}
