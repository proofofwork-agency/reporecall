import type Database from "better-sqlite3";

export class StatsStore {
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
  }

  setStat(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  getStat(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM stats WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  recordLatency(latencyMs: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO search_latencies (timestamp, latency_ms) VALUES (?, ?)`
        )
        .run(new Date().toISOString(), latencyMs);

      // Prune old entries, keeping only the most recent 1000
      this.db
        .prepare(
          `DELETE FROM search_latencies WHERE id NOT IN (
          SELECT id FROM search_latencies ORDER BY id DESC LIMIT 1000
        )`
        )
        .run();
    })();
  }

  getLatencyPercentiles(): { avg: number; p50: number; p95: number; count: number } {
    const count = (
      this.db.prepare(`SELECT COUNT(*) as c FROM search_latencies`).get() as {
        c: number;
      }
    ).c;

    if (count === 0) return { avg: 0, p50: 0, p95: 0, count: 0 };

    const avg = (
      this.db
        .prepare(`SELECT AVG(latency_ms) as a FROM search_latencies`)
        .get() as { a: number }
    ).a;

    const rows = this.db
      .prepare(
        `SELECT latency_ms FROM search_latencies ORDER BY latency_ms ASC`
      )
      .all() as Array<{ latency_ms: number }>;

    const p50Index = Math.floor(count * 0.5);
    const p95Index = Math.min(Math.floor(count * 0.95), count - 1);

    return {
      avg: Math.round(avg),
      p50: Math.round(rows[p50Index].latency_ms),
      p95: Math.round(rows[p95Index].latency_ms),
      count,
    };
  }
}
