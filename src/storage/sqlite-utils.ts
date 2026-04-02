import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "fs";
import { spawnSync, type SpawnSyncReturns } from "child_process";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

interface SqliteRuntimeHealthOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  openProbe?: (dbPath: string) => Database.Database;
  runCommand?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      encoding: "utf8";
    }
  ) => SpawnSyncReturns<string>;
  log?: (message: string) => void;
}

function isAbiMismatchError(message: string): boolean {
  return /NODE_MODULE_VERSION|was compiled against a different Node\.js version|Could not locate the bindings file/i.test(message);
}

export function detectPreferredPackageManager(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): PackageManager {
  const userAgent = env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm/")) return "pnpm";
  if (userAgent.startsWith("yarn/")) return "yarn";
  if (userAgent.startsWith("bun/")) return "bun";
  if (userAgent.startsWith("npm/")) return "npm";

  if (existsSync(`${cwd}/pnpm-lock.yaml`)) return "pnpm";
  if (existsSync(`${cwd}/yarn.lock`)) return "yarn";
  if (existsSync(`${cwd}/bun.lockb`) || existsSync(`${cwd}/bun.lock`)) return "bun";
  if (existsSync(`${cwd}/package-lock.json`)) return "npm";
  return "npm";
}

function getRepairCommand(
  cwd: string,
  env: NodeJS.ProcessEnv
): { command: string; args: string[]; display: string } {
  const manager = detectPreferredPackageManager(cwd, env);
  switch (manager) {
    case "pnpm":
      return { command: "pnpm", args: ["rebuild", "better-sqlite3"], display: "pnpm rebuild better-sqlite3" };
    case "yarn":
      return { command: "yarn", args: ["rebuild", "better-sqlite3"], display: "yarn rebuild better-sqlite3" };
    case "bun":
      return { command: "bun", args: ["install"], display: "bun install" };
    case "npm":
    default:
      return { command: "npm", args: ["rebuild", "better-sqlite3"], display: "npm rebuild better-sqlite3" };
  }
}

function formatRepairOutput(result: SpawnSyncReturns<string>): string {
  const stdout = result.stdout?.trim();
  const stderr = result.stderr?.trim();
  return [stdout, stderr].filter(Boolean).join("\n");
}

function tryRepairSqliteRuntime(
  cwd: string,
  env: NodeJS.ProcessEnv,
  runCommand: NonNullable<SqliteRuntimeHealthOptions["runCommand"]>,
): { attempted: boolean; succeeded: boolean; display: string; output?: string } {
  const repair = getRepairCommand(cwd, env);
  const result = runCommand(repair.command, repair.args, {
    cwd,
    env,
    encoding: "utf8",
  });
  return {
    attempted: true,
    succeeded: result.status === 0,
    display: repair.display,
    output: formatRepairOutput(result),
  };
}

function formatAbiMismatchMessage(
  dbPath: string,
  message: string,
  repairResult?: { attempted: boolean; succeeded: boolean; display: string; output?: string }
): string {
  const lines = [
    `better-sqlite3 is not usable for this runtime while opening ${dbPath}.`,
    "This usually means node_modules was installed with a different package manager, Node version, or native ABI.",
  ];

  if (repairResult?.attempted) {
    if (repairResult.succeeded) {
      lines.push(
        `Reporecall attempted an automatic repair with: ${repairResult.display}`,
        "but the native binding is still unavailable in this process."
      );
    } else {
      lines.push(
        `Reporecall attempted an automatic repair with: ${repairResult.display}`,
        "but the repair command did not succeed."
      );
    }
    if (repairResult.output) {
      lines.push(`Repair output: ${repairResult.output}`);
    }
  }

  lines.push(
    "Fix it by reinstalling consistently, for example:",
    "  pnpm install --force",
    "or rebuild just the native binding:",
    "  pnpm rebuild better-sqlite3",
    `Original error: ${message}`,
  );
  return lines.join("\n");
}

function recoverFromAbiMismatch(
  dbPath: string,
  message: string,
  options: SqliteRuntimeHealthOptions,
): Database.Database {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const openProbe = options.openProbe ?? openWithPragmas;
  const runCommand = options.runCommand ?? ((command, args, spawnOptions) => spawnSync(command, args, { ...spawnOptions, timeout: 30_000 }));
  const repair = tryRepairSqliteRuntime(cwd, env, runCommand);

  if (repair.succeeded) {
    options.log?.(
      `[reporecall] Repaired better-sqlite3 native bindings with "${repair.display}" and retrying SQLite startup.`
    );
    try {
      return openProbe(dbPath);
    } catch (retryErr: unknown) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      if (isAbiMismatchError(retryMsg)) {
        throw new Error(formatAbiMismatchMessage(dbPath, retryMsg, repair));
      }
      throw retryErr;
    }
  }

  throw new Error(formatAbiMismatchMessage(dbPath, message, repair));
}

export function assertSqliteRuntimeHealthy(options: SqliteRuntimeHealthOptions = {}): void {
  const openProbe = options.openProbe ?? openWithPragmas;
  try {
    const db = openProbe(":memory:");
    db.close();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAbiMismatchError(msg)) {
      const repairedDb = recoverFromAbiMismatch(":memory:", msg, options);
      repairedDb.close();
      return;
    }
    throw err;
  }
}

/**
 * Opens a SQLite database with WAL mode and busy timeout.
 * On SQLITE_IOERR or SQLITE_CORRUPT, removes stale -wal/-shm sidecars and retries once.
 */
export function openSqliteWithRecovery(
  dbPath: string,
  options: SqliteRuntimeHealthOptions = {}
): Database.Database {
  const openProbe = options.openProbe ?? openWithPragmas;
  try {
    return openProbe(dbPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAbiMismatchError(msg)) {
      return recoverFromAbiMismatch(dbPath, msg, options);
    }
    if (msg.includes("SQLITE_IOERR") || msg.includes("SQLITE_CORRUPT")) {
      // Remove stale WAL/SHM sidecars and retry once
      for (const suffix of ["-wal", "-shm"]) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          // file may not exist
        }
      }
      return openProbe(dbPath);
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
