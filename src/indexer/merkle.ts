import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { promises as fsPromises } from "fs";
import { resolve, dirname } from "path";
import xxhash from "xxhash-wasm";
import type { FileChange } from "./types.js";
import { getLogger } from "../core/logger.js";

interface MerkleFileEntry {
  hash: string;
  mtimeMs: number;
}

interface MerkleState {
  files: Record<string, string | MerkleFileEntry>; // relativePath -> contentHash (legacy) or { hash, mtimeMs }
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

        // mtime pre-filter: if mtime hasn't changed, skip the expensive hash
        const stat = await fsPromises.stat(file.absolutePath);
        if (existingHash && existingMtime > 0 && stat.mtimeMs === existingMtime) {
          // mtime unchanged — file is assumed unmodified, skip hash computation
          continue;
        }

        const content = await fsPromises.readFile(file.absolutePath, "utf-8");
        const hash = h.h64ToString(content);

        if (!existingHash) {
          changes.push({ path: file.relativePath, type: "added", hash });
          pendingState[file.relativePath] = { hash, mtimeMs: stat.mtimeMs };
        } else if (existingHash !== hash) {
          changes.push({ path: file.relativePath, type: "modified", hash });
          pendingState[file.relativePath] = { hash, mtimeMs: stat.mtimeMs };
        } else {
          // Content unchanged but mtime changed — update mtime cache
          pendingState[file.relativePath] = { hash, mtimeMs: stat.mtimeMs };
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
      mtimeMs: stat.mtimeMs,
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
