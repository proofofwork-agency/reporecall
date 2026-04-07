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
  private retryCount = new Map<string, number>();
  private readonly MAX_RETRIES = 3;
  private readonly MAX_QUEUE_SIZE = 50_000;
  private stopped = false;
  private flushDoneCallbacks: Array<() => void> = [];

  constructor(pipeline: IndexingPipeline, lock?: ReadWriteLock) {
    this.pipeline = pipeline;
    this.lock = lock;
  }

  stop(): void {
    this.stopped = true;
  }

  drain(): Promise<void> {
    if (!this.processing && !this.flushScheduled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.flushDoneCallbacks.push(resolve);
    });
  }

  enqueue(
    changes: Array<{ path: string; type: "add" | "change" | "unlink" }>
  ): void {
    if (this.stopped) return;
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

    // Bound queue sizes to prevent unbounded memory growth
    if (this.queue.size > this.MAX_QUEUE_SIZE) {
      const evicted = this.queue.size - this.MAX_QUEUE_SIZE;
      const kept = Array.from(this.queue).slice(-this.MAX_QUEUE_SIZE);
      this.queue = new Set(kept);
      log.warn(`Index queue exceeded ${this.MAX_QUEUE_SIZE}, evicted ${evicted} oldest entries`);
    }
    if (this.deleteQueue.size > this.MAX_QUEUE_SIZE) {
      const evicted = this.deleteQueue.size - this.MAX_QUEUE_SIZE;
      const kept = Array.from(this.deleteQueue).slice(-this.MAX_QUEUE_SIZE);
      this.deleteQueue = new Set(kept);
      log.warn(`Delete queue exceeded ${this.MAX_QUEUE_SIZE}, evicted ${evicted} oldest entries`);
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
            for (const p of paths) this.retryCount.delete(p);
          } catch (err) {
            for (const p of paths) {
              const count = (this.retryCount.get(p) ?? 0) + 1;
              if (count > this.MAX_RETRIES) {
                log.error({ path: p, retries: count }, `Dead-lettered after ${this.MAX_RETRIES} retries`);
                this.retryCount.delete(p);
              } else {
                this.retryCount.set(p, count);
                this.deleteQueue.add(p);
              }
            }
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
            for (const p of paths) this.retryCount.delete(p);
          } catch (err) {
            for (const p of paths) {
              const count = (this.retryCount.get(p) ?? 0) + 1;
              if (count > this.MAX_RETRIES) {
                log.error({ path: p, retries: count }, `Dead-lettered after ${this.MAX_RETRIES} retries`);
                this.retryCount.delete(p);
              } else {
                this.retryCount.set(p, count);
                this.queue.add(p);
              }
            }
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

      // Notify drain() waiters that flush is complete
      const cbs = this.flushDoneCallbacks;
      this.flushDoneCallbacks = [];
      for (const cb of cbs) cb();

      // If new items arrived during processing, flush again
      if (this.queue.size > 0 || this.deleteQueue.size > 0) {
        this.scheduleFlush();
      }
    }
  }
}
