import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  assertSqliteRuntimeHealthy,
  detectPreferredPackageManager,
  openSqliteWithRecovery,
} from "../../src/storage/sqlite-utils.js";

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

describe("sqlite runtime repair", () => {
  it("prefers pnpm from user agent", () => {
    expect(
      detectPreferredPackageManager("/tmp/reporecall", {
        npm_config_user_agent: "pnpm/10.0.0 node/v22.0.0 darwin arm64",
      })
    ).toBe("pnpm");
  });

  it("attempts one repair and retries the health probe", () => {
    let opens = 0;
    const logs: string[] = [];

    expect(() =>
      assertSqliteRuntimeHealthy({
        cwd: process.cwd(),
        log: (message) => logs.push(message),
        openProbe: () => {
          opens += 1;
          if (opens === 1) {
            throw new Error(
              "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127."
            );
          }
          return { close() {} } as { close(): void };
        },
        runCommand: () =>
          ({
            status: 0,
            stdout: "rebuilt",
            stderr: "",
          }) as never,
      })
    ).not.toThrow();

    expect(opens).toBe(2);
    expect(logs[0]).toContain("Repaired better-sqlite3 native bindings");
  });

  it("surfaces a stronger error when repair does not recover the binding", () => {
    let opens = 0;

    expect(() =>
      assertSqliteRuntimeHealthy({
        cwd: process.cwd(),
        openProbe: () => {
          opens += 1;
          throw new Error(
            "Could not locate the bindings file. Tried: build/Release/better_sqlite3.node"
          );
        },
        runCommand: () =>
          ({
            status: 0,
            stdout: "rebuilt",
            stderr: "",
          }) as never,
      })
    ).toThrow(/attempted an automatic repair/i);

    expect(opens).toBe(2);
  });
});
