import { getLogger } from "../core/logger.js";
import type { IndexingPipeline } from "../indexer/pipeline.js";
import type { ReadWriteLock } from "../core/rwlock.js";

export class IndexScheduler {
  private pipeline: IndexingPipeline;
  private queue: Set<string> = new Set();
  private deleteQueue: Set<string> = new Set();
  private processing = false;
  private flushScheduled = false;
  private lock: ReadWriteLock | undefined;

  constructor(pipeline: IndexingPipeline, lock?: ReadWriteLock) {
    this.pipeline = pipeline;
    this.lock = lock;
  }

  enqueue(
    changes: Array<{ path: string; type: "add" | "change" | "unlink" }>
  ): void {
    const log = getLogger();

    for (const change of changes) {
      if (change.type === "unlink") {
        this.deleteQueue.add(change.path);
        this.queue.delete(change.path);
      } else {
        this.queue.add(change.path);
        this.deleteQueue.delete(change.path);
      }
    }

    log.info(
      `Queued ${changes.length} changes (${this.queue.size} to index, ${this.deleteQueue.size} to delete)`
    );

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.processing) return;
    this.flushScheduled = true;
    // Use queueMicrotask to coalesce rapid enqueue calls
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.processing) return;
    if (this.queue.size === 0 && this.deleteQueue.size === 0) return;

    this.processing = true;
    const log = getLogger();

    try {
      const mutate = async (): Promise<void> => {
        if (this.deleteQueue.size > 0) {
          const paths = Array.from(this.deleteQueue);
          this.deleteQueue.clear();
          try {
            await this.pipeline.removeFiles(paths);
            log.info(`Removed ${paths.length} file(s)`);
          } catch (err) {
            for (const p of paths) this.deleteQueue.add(p);
            throw err;
          }
        }

        if (this.queue.size > 0) {
          const paths = Array.from(this.queue);
          this.queue.clear();
          try {
            const result = await this.pipeline.indexChanged(paths);
            log.info(
              `Indexed ${result.filesProcessed} changed file(s) (${result.chunksCreated} new chunks)`
            );
          } catch (err) {
            for (const p of paths) this.queue.add(p);
            throw err;
          }
        }
      };

      if (this.lock) {
        await this.lock.withWrite(mutate);
      } else {
        await mutate();
      }

      // Check for LanceDB corruption after flush
      const vs = this.pipeline.getVectorStore?.();
      if (vs?.isCorrupted()) {
        log.warn("LanceDB corruption detected, triggering full re-index");
        const reindex = async () => {
          vs.clearCorrupted();
          await this.pipeline.indexAll();
        };
        if (this.lock) {
          await this.lock.withWrite(reindex);
        } else {
          await reindex();
        }
      }
    } catch (err) {
      log.error(`Index scheduler error: ${err}`);
    } finally {
      this.processing = false;
      // If new items arrived during processing, flush again
      if (this.queue.size > 0 || this.deleteQueue.size > 0) {
        this.scheduleFlush();
      }
    }
  }
}
