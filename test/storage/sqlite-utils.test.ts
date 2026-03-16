import { describe, it, expect, afterEach } from "vitest";
import { openSqliteWithRecovery } from "../../src/storage/sqlite-utils.js";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

function tmpDbPath(): string {
  const dir = join(tmpdir(), `sqlite-utils-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

function cleanup(dbPath: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe("openSqliteWithRecovery", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) cleanup(p);
    paths.length = 0;
  });

  it("opens a clean database normally", () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);
    const db = openSqliteWithRecovery(dbPath);
    expect(db).toBeDefined();
    db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY)").run();
    db.close();
  });

  it("recovers when .db-shm contains garbage", () => {
    const dbPath = tmpDbPath();
    paths.push(dbPath);

    // Create a valid database first, then close it
    const db1 = openSqliteWithRecovery(dbPath);
    db1.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY)").run();
    db1.close();

    // Write garbage to the shm file to simulate corruption
    writeFileSync(dbPath + "-shm", Buffer.alloc(64, 0xff));

    // Should recover by deleting sidecars and retrying
    const db2 = openSqliteWithRecovery(dbPath);
    expect(db2).toBeDefined();
    // Table should still exist (data is in the main db file)
    const rows = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").all();
    expect(rows).toHaveLength(1);
    db2.close();
  });

  it("rethrows non-SQLITE errors", () => {
    // Passing a directory as the db path should throw a non-SQLITE error
    const dir = join(tmpdir(), `sqlite-utils-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    expect(() => openSqliteWithRecovery(dir)).toThrow();
  });
});
