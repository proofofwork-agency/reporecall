import { execFileSync } from "child_process";
import { existsSync, readdirSync, rmSync } from "fs";
import { extname, basename, resolve } from "path";
import { watch, type FSWatcher } from "chokidar";
import { getLogger } from "../../core/logger.js";
import { writeManagedMemoryFile } from "../../memory/files.js";
import type { MemoryIndexer, MemoryIndexResult } from "../../memory/indexer.js";
import type { MemorySearchResult, MemoryType } from "../../memory/types.js";
import { resolveMemoryClass } from "../../memory/types.js";
import type { MemoryStore } from "../../storage/memory-store.js";

type MemoryFileEventType = "add" | "change" | "unlink";

interface PendingMemoryChange {
  path: string;
  type: MemoryFileEventType;
}

export interface MemoryRuntimeOptions {
  debounceMs?: number;
  compactionHours?: number;
  archiveDays?: number;
  watchEnabled?: boolean;
  autoCreate?: boolean;
  factPromotionThreshold?: number;
  writableDir?: string | null;
  projectRoot?: string;
  workingHistoryLimit?: number;
}

export interface ObservePromptInput {
  query: string;
  codeRoute: string;
  memoryRoute?: string;
  activeFiles?: string[];
  topFiles?: string[];
  topSymbols?: string[];
  memoryHits?: MemorySearchResult[];
}

export class MemoryRuntime {
  private indexer: MemoryIndexer;
  private store: MemoryStore;
  private debounceMs: number;
  private watchEnabled: boolean;
  private autoCreate: boolean;
  private factPromotionThreshold: number;
  private writableDir: string | null;
  private projectRoot: string | undefined;
  private workingHistoryLimit: number;
  private watcher: FSWatcher | undefined;
  private watchedDirs: string[] = [];
  private pendingChanges: PendingMemoryChange[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private compactionTimer: ReturnType<typeof setInterval> | undefined;
  private processing = false;
  private stopped = false;
  private flushDoneCallbacks: Array<() => void> = [];
  private lastCompaction: { at: string; result: { deduped: number; archived: number; superseded: number } } | null = null;
  private lastFlushCompaction = 0;
  private static FLUSH_COMPACT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(indexer: MemoryIndexer, store: MemoryStore, options?: MemoryRuntimeOptions) {
    this.indexer = indexer;
    this.store = store;
    this.debounceMs = options?.debounceMs ?? 1000;
    this.watchEnabled = options?.watchEnabled ?? true;
    this.autoCreate = options?.autoCreate ?? true;
    this.factPromotionThreshold = options?.factPromotionThreshold ?? 3;
    this.writableDir = options?.writableDir ?? indexer.getWritableDirs()[0] ?? null;
    this.projectRoot = options?.projectRoot;
    this.workingHistoryLimit = options?.workingHistoryLimit ?? 3;
    const compactionHours = options?.compactionHours ?? 6;
    if (compactionHours > 0) {
      this.compactionTimer = setInterval(() => {
        try {
          this.compact(options?.archiveDays);
        } catch (err) {
          getLogger().warn({ err }, "Memory compaction timer failed");
        }
      }, compactionHours * 60 * 60 * 1000).unref();
    }
  }

  getMemoryDirs(): string[] {
    return [...this.watchedDirs];
  }

  async start(): Promise<MemoryIndexResult> {
    this.watchedDirs = Array.from(
      new Set(this.indexer.getMemoryDirs().filter((dir) => existsSync(dir)))
    );
    const result = await this.indexer.indexAll();
    this.compact();
    if (this.watchedDirs.length === 0 || !this.watchEnabled) {
      return result;
    }

    await this.startWatcher();
    return result;
  }

  async stop(): Promise<void> {
    if (this.compactionTimer) {
      clearInterval(this.compactionTimer);
      this.compactionTimer = undefined;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    await this.watcher?.close();
    this.watcher = undefined;
    this.stopped = true;

    if (this.pendingChanges.length > 0) {
      await this.flush(true);
    }

    await this.drain();
  }

  drain(): Promise<void> {
    if (!this.processing && !this.debounceTimer && this.pendingChanges.length === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.flushDoneCallbacks.push(resolve);
    });
  }

  getLastCompaction(): { at: string; result: { deduped: number; archived: number; superseded: number } } | null {
    return this.lastCompaction;
  }

  compact(archiveDays = 30): { deduped: number; archived: number; superseded: number } {
    const result = this.indexer.compact({ archiveEpisodeOlderThanDays: archiveDays });
    this.lastCompaction = { at: new Date().toISOString(), result };
    return result;
  }

  async observePrompt(input: ObservePromptInput): Promise<void> {
    if (!this.autoCreate || !this.writableDir) return;

    try {
      await this.upsertWorkingMemory(input);
      if (input.memoryHits?.length) {
        await this.promoteFacts(input.memoryHits);
      }
    } catch (err) {
      getLogger().warn({ err }, "Automatic memory creation failed");
    }
  }

  async clearWorkingMemory(): Promise<number> {
    if (!this.writableDir) return 0;
    let removed = 0;
    for (const memory of this.store.getAll()) {
      if (resolveMemoryClass(memory) !== "working") continue;
      if (!memory.filePath.startsWith(this.writableDir)) continue;
      try {
        rmSync(memory.filePath, { force: true });
      } catch {
        // best effort
      }
      const deleted = await this.indexer.removeByFilePath(memory.filePath);
      if (deleted) removed++;
    }
    return removed;
  }

  private async startWatcher(): Promise<void> {
    if (this.watchedDirs.length === 0) return;

    const log = getLogger();
    this.watcher = watch(this.watchedDirs, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
    });

    const handleEvent = (type: MemoryFileEventType, filePath: string): void => {
      if (this.stopped) return;
      if (extname(filePath).toLowerCase() !== ".md") return;
      if (basename(filePath).toUpperCase() === "MEMORY.MD") return;

      this.pendingChanges.push({ path: filePath, type });

      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        void this.flush();
      }, this.debounceMs);
    };

    this.watcher.on("add", (filePath) => handleEvent("add", filePath));
    this.watcher.on("change", (filePath) => handleEvent("change", filePath));
    this.watcher.on("unlink", (filePath) => handleEvent("unlink", filePath));

    await new Promise<void>((resolve, reject) => {
      this.watcher?.once("ready", () => {
        log.info(
          { dirs: this.watchedDirs },
          "Memory runtime watcher started"
        );
        resolve();
      });
      this.watcher?.once("error", reject);
    });
  }

  private async flush(force = false): Promise<void> {
    if (this.processing) return;
    if (!force && this.stopped) return;
    if (this.pendingChanges.length === 0) return;

    this.processing = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    const log = getLogger();

    try {
      const changes = [...this.pendingChanges];
      this.pendingChanges = [];

      let indexed = 0;
      let removed = 0;

      for (const change of changes) {
        if (change.type === "unlink") {
          const ok = await this.indexer.removeByFilePath(change.path);
          if (ok) removed++;
          continue;
        }

        const ok = await this.indexer.indexFile(change.path);
        if (ok) indexed++;
      }

      if (indexed > 0 || removed > 0) {
        log.info(
          { indexed, removed, pending: this.pendingChanges.length },
          "Memory runtime refresh complete"
        );
        const now = Date.now();
        if (now - this.lastFlushCompaction > MemoryRuntime.FLUSH_COMPACT_INTERVAL_MS) {
          try {
            this.compact();
            this.lastFlushCompaction = now;
          } catch (err) {
            log.warn({ err }, "Memory compaction after refresh failed");
          }
        }
      }
    } catch (err) {
      log.error({ err }, "Memory runtime refresh failed");
    } finally {
      this.processing = false;
      const callbacks = this.flushDoneCallbacks;
      this.flushDoneCallbacks = [];
      for (const cb of callbacks) cb();

      if (!this.stopped && this.pendingChanges.length > 0) {
        this.debounceTimer = setTimeout(() => {
          void this.flush();
        }, this.debounceMs);
      }
    }
  }

  private async upsertWorkingMemory(input: ObservePromptInput): Promise<void> {
    if (!this.writableDir) return;

    const branch = this.detectBranch();
    const scope = branch ? "branch" : "project";
    const topFiles = uniq([...(input.activeFiles ?? []), ...(input.topFiles ?? [])]).slice(0, 5);
    const topSymbols = uniq(input.topSymbols ?? []).slice(0, 8);
    const memoryNames = uniq((input.memoryHits ?? []).map((memory) => memory.name)).slice(0, 5);
    const summary = [
      branch ? `Branch ${branch}` : "Project working set",
      `route ${input.codeRoute}`,
      input.memoryRoute ? `memory ${input.memoryRoute}` : null,
      topFiles[0] ? `focus ${basename(topFiles[0])}` : null,
    ].filter(Boolean).join(" | ");

    const contentLines = [
      `Last query: ${input.query.trim()}`,
      `Code route: ${input.codeRoute}`,
      input.memoryRoute ? `Memory route: ${input.memoryRoute}` : "",
      branch ? `Branch: ${branch}` : "",
      topFiles.length > 0 ? `Active files: ${topFiles.join(", ")}` : "",
      topSymbols.length > 0 ? `Relevant symbols: ${topSymbols.join(", ")}` : "",
      memoryNames.length > 0 ? `Memory hits: ${memoryNames.join(", ")}` : "",
    ].filter((line) => line.length > 0);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileStem = branch ? `working-${branch}-${timestamp}` : `working-project-${timestamp}`;
    const filePath = writeManagedMemoryFile(this.writableDir, fileStem, {
      name: fileStem,
      description: "Auto-generated working memory for the latest prompt",
      memoryType: "project",
      class: "working",
      scope,
      status: "active",
      summary,
      sourceKind: "generated",
      relatedFiles: topFiles,
      relatedSymbols: topSymbols,
      confidence: 0.65,
      reason: "Auto-generated from daemon prompt activity",
      content: contentLines.join("\n"),
    });
    await this.indexer.indexFile(filePath);
    this.pruneWorkingHistory(branch);
  }

  private async promoteFacts(memories: MemorySearchResult[]): Promise<void> {
    if (!this.writableDir) return;

    for (const memory of memories) {
      const memoryClass = resolveMemoryClass(memory);
      if (memoryClass !== "rule" && memoryClass !== "fact") continue;
      if (memory.sourceKind === "generated") continue;
      const projectedAccessCount = (memory.accessCount ?? 0) + 1;
      if (projectedAccessCount < this.factPromotionThreshold) continue;

      const stem = `fact-${memory.fingerprint?.slice(0, 12) || memory.name}`;
      const filePath = writeManagedMemoryFile(this.writableDir, stem, {
        name: stem,
        description: `Promoted fact from ${memory.name}`,
        memoryType: derivePromotedType(memory.type),
        class: "fact",
        scope: memory.scope ?? "project",
        status: "active",
        summary: memory.summary ?? memory.description,
        sourceKind: "generated",
        fingerprint: memory.fingerprint,
        pinned: memory.pinned ?? false,
        relatedFiles: memory.relatedFiles ?? [],
        relatedSymbols: memory.relatedSymbols ?? [],
        confidence: Math.max(0.7, memory.confidence ?? 0.7),
        reason: `Promoted after repeated retrieval from ${memory.name}`,
        content: [
          `Promoted fact from: ${memory.name}`,
          memory.summary ?? memory.description,
          "",
          memory.content.trim(),
        ].join("\n"),
      });
      await this.indexer.indexFile(filePath);
    }
  }

  private pruneWorkingHistory(branch: string | null): void {
    if (!this.writableDir || this.workingHistoryLimit < 1) return;
    const safeBranch = branch?.replace(/[^a-zA-Z0-9_.-]/g, "_") ?? null;
    const prefix = safeBranch ? `working-${safeBranch}` : "working-project";
    const files = readdirSync(this.writableDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".md"))
      .sort()
      .reverse();
    for (const file of files.slice(this.workingHistoryLimit)) {
      try {
        rmSync(resolve(this.writableDir, file), { force: true });
      } catch {
        // best effort
      }
    }
  }

  private detectBranch(): string | null {
    if (!this.projectRoot) return null;
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return branch && branch !== "HEAD" ? branch : null;
    } catch {
      return null;
    }
  }
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function derivePromotedType(type: MemoryType): MemoryType {
  return type === "feedback" ? "feedback" : "project";
}
