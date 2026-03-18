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
  db.pragma("synchronous = NORMAL");      // Safe with WAL; faster than default FULL
  db.pragma("cache_size = -65536");        // 64MB cache instead of 2MB default
  db.pragma("temp_store = MEMORY");        // Temp tables in memory
  db.pragma("mmap_size = 268435456");      // 256MB memory-mapped I/O
  db.pragma("foreign_keys = ON");
  return db;
}

/** Current schema version — bump when adding migrations. */
export const SCHEMA_VERSION = 1;

/**
 * Returns the current user_version pragma value for the database.
 */
export function getSchemaVersion(db: Database.Database): number {
  const row = db.pragma("user_version", { simple: true });
  return typeof row === "number" ? row : 0;
}

/**
 * Sets the user_version pragma to the given version number.
 */
export function setSchemaVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`);
}

/**
 * Checks the current schema version and runs any pending migrations.
 * Each migration is a function keyed by the version it upgrades TO.
 * After all migrations run, user_version is set to SCHEMA_VERSION.
 *
 * @param db        - The SQLite database handle
 * @param migrations - Map from target version number to migration function.
 *                     Migration for version N upgrades from N-1 to N.
 */
export function migrateIfNeeded(
  db: Database.Database,
  migrations: Record<number, (db: Database.Database) => void>
): void {
  const current = getSchemaVersion(db);
  if (current >= SCHEMA_VERSION) return;

  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    const migrate = migrations[v];
    if (migrate) {
      migrate(db);
    }
  }
  setSchemaVersion(db, SCHEMA_VERSION);
}
