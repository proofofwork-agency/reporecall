import { watch, type FSWatcher as ChokidarWatcher } from "chokidar";
import { extname, resolve } from "path";
import { readFileSync, existsSync } from "fs";
import ignore from "ignore";
import type { MemoryConfig } from "../core/config.js";
import { loadMemoryIgnore } from "../core/project.js";
import { getLogger } from "../core/logger.js";
import {
  canonicalizeProjectRoot,
  resolveProjectPath,
} from "../core/path-safety.js";

const MAX_PENDING = 10_000;
// Hard upper bound on how long a burst of events can be coalesced before a
// flush is forced. Without this, sustained activity (builds, git checkouts)
// keeps resetting the trailing-edge debounce timer and the callback never fires.
const MAX_WAIT_MS = 5_000;

export type WatcherCallback = (
  changes: Array<{ path: string; type: "add" | "change" | "unlink" }>
) => void;

export class FileWatcher {
  private watcher: ChokidarWatcher | undefined;
  private config: MemoryConfig;
  private pendingChanges: Array<{
    path: string;
    type: "add" | "change" | "unlink";
  }> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  private callback: WatcherCallback;
  private stopped = false;

  constructor(config: MemoryConfig, callback: WatcherCallback) {
    this.config = config;
    this.callback = callback;
  }

  start(): void {
    this.stopped = false;
    const extensionSet = new Set(this.config.extensions);
    let projectRoot: string;
    try {
      projectRoot = canonicalizeProjectRoot(this.config.projectRoot);
    } catch (err) {
      getLogger().warn({ err }, "FileWatcher project root is unavailable");
      return;
    }

    // Build ignore matcher matching file-scanner.ts behavior
    const ig = ignore();
    const gitignorePath = resolve(projectRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      ig.add(readFileSync(gitignorePath, "utf-8"));
    }
    ig.add(loadMemoryIgnore(projectRoot));
    ig.add(this.config.ignorePatterns);

    // Derive watcher ignore patterns from config to stay in sync with file-scanner
    const watchIgnored: Array<string | RegExp> = [
      /(^|[/\\])\./,   // dotfiles
      "**/.git/**",
      "**/.memory/**",
      ...this.config.ignorePatterns.map((p) =>
        p.startsWith("*") ? `**/${p}` : `**/${p}/**`
      ),
    ];

    this.watcher = watch(projectRoot, {
      ignored: watchIgnored,
      persistent: true,
      ignoreInitial: true,
      // Recursive fs.watch uses fsevents on macOS. Closing that native handle
      // can block the event loop indefinitely on substantial repositories.
      // Polling is slower but shuts down deterministically and is still bounded
      // by the existing debounce window.
      usePolling: process.platform === "darwin",
      interval: 1_000,
      binaryInterval: 2_000,
    });

    const handleEvent = (
      eventType: "add" | "change" | "unlink",
      filePath: string
    ) => {
      if (this.stopped) return;
      const safePath = resolveProjectPath(
        projectRoot,
        filePath,
        eventType === "unlink" ? "allow-missing" : "existing",
      );
      if (!safePath) {
        getLogger().warn({ filePath, eventType }, "FileWatcher blocked path outside project root");
        return;
      }

      const ext = extname(safePath.posixRelativePath);
      if (!extensionSet.has(ext)) return;

      const relPath = safePath.posixRelativePath;
      if (ig.ignores(relPath)) return;

      if (this.pendingChanges.length >= MAX_PENDING) {
        const drop = Math.max(1, Math.floor(MAX_PENDING * 0.1));
        this.pendingChanges.splice(0, drop);
        getLogger().warn(
          { dropped: drop, maxPending: MAX_PENDING },
          `FileWatcher backpressure: dropped ${drop} oldest pending events`
        );
      }

      this.pendingChanges.push({ path: relPath, type: eventType });

      // Trailing-edge debounce: coalesce rapid bursts. The maxWaitTimer guards
      // against indefinite postponement under sustained activity by forcing a
      // flush after MAX_WAIT_MS regardless of ongoing events.
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        const changes = [...this.pendingChanges];
        this.pendingChanges = [];
        this.callback(changes);
      }, this.config.debounceMs);
      if (!this.maxWaitTimer) {
        this.maxWaitTimer = setTimeout(() => {
          this.maxWaitTimer = undefined;
          if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
          }
          if (this.pendingChanges.length > 0) {
            const changes = [...this.pendingChanges];
            this.pendingChanges = [];
            this.callback(changes);
          }
        }, MAX_WAIT_MS);
      }
    };

    this.watcher.on("add", (p) => handleEvent("add", p));
    this.watcher.on("change", (p) => handleEvent("change", p));
    this.watcher.on("unlink", (p) => handleEvent("unlink", p));

    // Persistent error handler so chokidar errors (EMFILE, EACCES) are logged
    // instead of crashing the process as unhandled exceptions.
    this.watcher.on("error", (err: unknown) => {
      getLogger().warn({ err }, "FileWatcher error (non-fatal)");
    });
  }

  async stop(): Promise<void> {
    this.prepareToStop();
    await this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * Quiesce callbacks and timers before the native watcher is closed.
   * This is also useful to stop new work immediately when a caller owns the
   * final resource-release sequence.
   */
  prepareToStop(): void {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = undefined;
    this.maxWaitTimer = undefined;
    this.pendingChanges = [];
  }
}
