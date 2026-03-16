import Database from "better-sqlite3";
import { unlinkSync } from "fs";

/**
 * Opens a SQLite database with WAL mode and busy timeout.
 * On SQLITE_IOERR or SQLITE_CORRUPT, removes stale -wal/-shm sidecars and retries once.
 */
export function openSqliteWithRecovery(dbPath: string): Database.Database {
  try {
    return openWithPragmas(dbPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("SQLITE_IOERR") || msg.includes("SQLITE_CORRUPT")) {
      // Remove stale WAL/SHM sidecars and retry once
      for (const suffix of ["-wal", "-shm"]) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          // file may not exist
        }
      }
      return openWithPragmas(dbPath);
    }
    throw err;
  }
}

function openWithPragmas(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}
