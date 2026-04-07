import { watch, type FSWatcher as ChokidarWatcher } from "chokidar";
import { relative, extname, resolve } from "path";
import { readFileSync, existsSync } from "fs";
import ignore from "ignore";
import type { MemoryConfig } from "../core/config.js";
import { loadMemoryIgnore } from "../core/project.js";
import { getLogger } from "../core/logger.js";

const MAX_PENDING = 10_000;

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
  private callback: WatcherCallback;

  constructor(config: MemoryConfig, callback: WatcherCallback) {
    this.config = config;
    this.callback = callback;
  }

  start(): void {
    const extensionSet = new Set(this.config.extensions);

    // Build ignore matcher matching file-scanner.ts behavior
    const ig = ignore();
    const gitignorePath = resolve(this.config.projectRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      ig.add(readFileSync(gitignorePath, "utf-8"));
    }
    ig.add(loadMemoryIgnore(this.config.projectRoot));
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

    this.watcher = watch(this.config.projectRoot, {
      ignored: watchIgnored,
      persistent: true,
      ignoreInitial: true,
    });

    const handleEvent = (
      eventType: "add" | "change" | "unlink",
      filePath: string
    ) => {
      const ext = extname(filePath);
      if (!extensionSet.has(ext)) return;

      const relPath = relative(this.config.projectRoot, filePath);
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

      // Debounce
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        const changes = [...this.pendingChanges];
        this.pendingChanges = [];
        this.callback(changes);
      }, this.config.debounceMs);
    };

    this.watcher.on("add", (p) => handleEvent("add", p));
    this.watcher.on("change", (p) => handleEvent("change", p));
    this.watcher.on("unlink", (p) => handleEvent("unlink", p));
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.watcher?.close();
  }
}
