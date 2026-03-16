import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { promises as fsPromises } from "fs";
import { resolve, dirname } from "path";
import xxhash from "xxhash-wasm";
import type { FileChange } from "./types.js";
import { getLogger } from "../core/logger.js";

interface MerkleState {
  files: Record<string, string>; // relativePath -> contentHash
}

let hasherPromise: ReturnType<typeof xxhash> | undefined;

async function getHasher() {
  if (!hasherPromise) hasherPromise = xxhash();
  return hasherPromise;
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
        this.state = JSON.parse(readFileSync(this.statePath, "utf-8"));
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
  ): Promise<{ changes: FileChange[]; pendingState: Record<string, string> }> {
    const h = await getHasher();
    const changes: FileChange[] = [];
    const currentPaths = new Set<string>();
    // Start with a copy of current state
    const pendingState = { ...this.state.files };

    for (const file of files) {
      currentPaths.add(file.relativePath);
      try {
        const content = await fsPromises.readFile(file.absolutePath, "utf-8");
        const hash = h.h64ToString(content);
        const existingHash = this.state.files[file.relativePath];

        if (!existingHash) {
          changes.push({ path: file.relativePath, type: "added", hash });
          pendingState[file.relativePath] = hash;
        } else if (existingHash !== hash) {
          changes.push({ path: file.relativePath, type: "modified", hash });
          pendingState[file.relativePath] = hash;
        }
        // unchanged files are skipped
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

  applyPendingState(pendingState: Record<string, string>): void {
    this.state.files = pendingState;
  }

  async updateHash(relativePath: string, absolutePath: string): Promise<void> {
    const h = await getHasher();
    const content = await fsPromises.readFile(absolutePath, "utf-8");
    this.state.files[relativePath] = h.h64ToString(content);
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
