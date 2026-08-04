import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  promises as fsPromises,
} from "fs";
import { resolve, dirname } from "path";
import xxhash from "xxhash-wasm";
import type { FileChange } from "./types.js";
import { getLogger } from "../core/logger.js";

export interface MerkleFileEntry {
  hash: string;
  mtimeMs: number;
  ctimeMs?: number;
  /** Recorded size; a mismatch always forces a re-hash. Absent on older state. */
  size?: number;
}

interface MerkleState {
  files: Record<string, string | MerkleFileEntry>; // relativePath -> contentHash (legacy) or { hash, mtimeMs, ctimeMs? }
}

let hasherPromise: ReturnType<typeof xxhash> | undefined;

async function getHasher() {
  if (!hasherPromise) hasherPromise = xxhash();
  return hasherPromise;
}

/** Extract hash from a state entry (supports both legacy string and new object format). */
function entryHash(entry: string | MerkleFileEntry): string {
  return typeof entry === "string" ? entry : entry.hash;
}

/** Extract mtimeMs from a state entry (returns 0 for legacy string entries). */
function entryMtime(entry: string | MerkleFileEntry): number {
  return typeof entry === "string" ? 0 : entry.mtimeMs;
}

/** Extract ctimeMs from a state entry (returns undefined for legacy/older entries). */
function entryCtime(entry: string | MerkleFileEntry): number | undefined {
  return typeof entry === "string" ? undefined : entry.ctimeMs;
}

/** Extract size from a state entry (returns undefined for legacy/older entries). */
function entrySize(entry: string | MerkleFileEntry): number | undefined {
  return typeof entry === "string" ? undefined : entry.size;
}

/**
 * How recently a file must have been written for its mtime to be worthless as a
 * change signal.
 *
 * Filesystem timestamps are coarse. The Windows system clock advances in ~15.6ms
 * steps, HFS+ stores whole seconds and FAT32 two-second steps, so two writes
 * inside one step share an mtime exactly. If we hash a file between those two
 * writes and record that shared mtime, the second write is invisible forever
 * after: the pre-filter in computeChanges sees a matching timestamp and skips
 * the file on every future scan. On Windows nothing else catches it either —
 * ctime is the creation time and does not move on modification, so a
 * length-preserving edit also keeps size identical and clears all three cheap
 * signals.
 *
 * A chunk that is stale while reporting itself fresh is the one failure the
 * Trust Contract must not have. So when the file we just hashed was written
 * within the coarsest granularity we might be sitting on, we persist mtimeMs 0 —
 * the same "do not trust this timestamp" sentinel that legacy string entries
 * already produce — and pay for one extra hash on the next scan instead.
 */
const MTIME_TRUST_WINDOW_MS = 2_000;

/**
 * The mtime to persist for a freshly hashed file: the real value, or 0 when the
 * file was written too recently for that value to be a reliable change signal.
 *
 * A future-dated mtime (clock skew, a bad archive) also lands in the untrusted
 * branch, which is the safe direction — it costs a hash, never a missed change.
 */
function persistableMtime(mtimeMs: number, observedAt: number): number {
  return observedAt - mtimeMs < MTIME_TRUST_WINDOW_MS ? 0 : mtimeMs;
}

export class MerkleTree {
  private state: MerkleState = { files: {} };
  private statePath: string;

  constructor(dataDir: string) {
    this.statePath = resolve(dataDir, "merkle.json");
    this.load();
  }

  private load(): void {
    if (existsSync(this.statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.statePath, "utf-8"));
        if (!parsed || typeof parsed !== 'object') {
          this.state = { files: {} };
        } else if (typeof parsed.files !== 'object' || parsed.files === null) {
          this.state = { files: {} };
        } else {
          this.state = parsed as MerkleState;
        }
      } catch {
        this.state = { files: {} };
      }
    }
  }

  save(): void {
    try {
      const dir = dirname(this.statePath);
      mkdirSync(dir, { recursive: true });
      const tmpPath = this.statePath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(this.state));
      renameSync(tmpPath, this.statePath);
    } catch (err) {
      // Log warning but don't throw — callers shouldn't fail on merkle save errors.
      // Stale-index recovery will handle the next startup.
      getLogger().warn({ err }, "[MerkleTree] Failed to save state");
    }
  }

  async computeChanges(
    files: Array<{ relativePath: string; absolutePath: string }>
  ): Promise<{ changes: FileChange[]; pendingState: Record<string, string | MerkleFileEntry> }> {
    const h = await getHasher();
    const changes: FileChange[] = [];
    const currentPaths = new Set<string>();
    // Start with a copy of current state
    const pendingState: Record<string, string | MerkleFileEntry> = { ...this.state.files };

    for (const file of files) {
      currentPaths.add(file.relativePath);
      try {
        const existing = this.state.files[file.relativePath];
        const existingHash = existing ? entryHash(existing) : undefined;
        const existingMtime = existing ? entryMtime(existing) : 0;
        const existingCtime = existing ? entryCtime(existing) : undefined;

        // Timestamp pre-filter: skip the expensive hash only when every cheap
        // signal matches. mtime alone is unreliable — `git checkout`, `touch -r`
        // and `cp`/rsync without `--times` rewrite contents while preserving it.
        // ctime cannot be reset from userspace on POSIX, so it catches those.
        //
        // On Windows, though, ctime is the *creation* time and never moves on a
        // modification, so it contributes nothing there. Size is therefore part
        // of the filter: it is free from the stat we already have, and it catches
        // a same-millisecond rewrite that changes length — which the timestamps
        // alone would wave through, leaving the file silently un-indexed.
        const stat = await fsPromises.stat(file.absolutePath);
        const existingSize = existing ? entrySize(existing) : undefined;
        if (
          existingHash
          && existingMtime > 0
          && stat.mtimeMs === existingMtime
          && (existingCtime === undefined || stat.ctimeMs === existingCtime)
          && (existingSize === undefined || stat.size === existingSize)
        ) {
          continue;
        }

        const content = await fsPromises.readFile(file.absolutePath, "utf-8");
        const hash = h.h64ToString(content);
        // Read the clock next to the hash, not once per batch: on a large repo a
        // single timestamp taken at the top of the loop would drift minutes away
        // from the files hashed at the end, and start calling their mtimes
        // trustworthy when they are not.
        const mtimeMs = persistableMtime(stat.mtimeMs, Date.now());

        if (!existingHash) {
          changes.push({ path: file.relativePath, type: "added", hash });
          pendingState[file.relativePath] = { hash, mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
        } else if (existingHash !== hash) {
          changes.push({ path: file.relativePath, type: "modified", hash });
          pendingState[file.relativePath] = { hash, mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
        } else {
          // Content unchanged but mtime/ctime changed — update cache
          pendingState[file.relativePath] = { hash, mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
        }
      } catch (err) {
        getLogger().warn({ err, path: file.relativePath }, "File disappeared during scan, skipping");
        continue;
      }
    }

    // Detect deleted files
    for (const existingPath of Object.keys(this.state.files)) {
      if (!currentPaths.has(existingPath)) {
        changes.push({ path: existingPath, type: "deleted" });
        delete pendingState[existingPath];
      }
    }

    return { changes, pendingState };
  }

  applyPendingState(pendingState: Record<string, string | MerkleFileEntry>): void {
    this.state.files = pendingState;
  }

  async updateHash(relativePath: string, absolutePath: string): Promise<void> {
    const h = await getHasher();
    const stat = await fsPromises.stat(absolutePath);
    const content = await fsPromises.readFile(absolutePath, "utf-8");
    this.state.files[relativePath] = {
      hash: h.h64ToString(content),
      mtimeMs: persistableMtime(stat.mtimeMs, Date.now()),
      ctimeMs: stat.ctimeMs,
      size: stat.size,
    };
  }

  removeFile(relativePath: string): void {
    delete this.state.files[relativePath];
  }

  clear(): void {
    this.state = { files: {} };
    try {
      unlinkSync(this.statePath);
    } catch {
      // ignore if file doesn't exist
    }
  }
}
