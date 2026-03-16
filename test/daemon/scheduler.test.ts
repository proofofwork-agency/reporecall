import { describe, it, expect } from "vitest";
import { IndexScheduler } from "../../src/daemon/scheduler.js";

// 3I: IndexScheduler

// Creates a mock pipeline that records calls and resolves after an optional delay
function makeMockPipeline(opts: {
  indexChangedDelay?: number;
  removeFilesDelay?: number;
} = {}): {
  pipeline: any;
  indexChangedCalls: string[][];
  removeFilesCalls: string[][];
} {
  const indexChangedCalls: string[][] = [];
  const removeFilesCalls: string[][] = [];

  const pipeline = {
    indexChanged: async (paths: string[]) => {
      if (opts.indexChangedDelay) {
        await new Promise((r) => setTimeout(r, opts.indexChangedDelay));
      }
      indexChangedCalls.push([...paths]);
      return { filesProcessed: paths.length, chunksCreated: paths.length };
    },
    removeFiles: async (paths: string[]) => {
      if (opts.removeFilesDelay) {
        await new Promise((r) => setTimeout(r, opts.removeFilesDelay));
      }
      removeFilesCalls.push([...paths]);
    },
  };

  return { pipeline, indexChangedCalls, removeFilesCalls };
}

// Wait for the scheduler's internal flush to finish
function waitForIdle(ms = 100): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("IndexScheduler (3I)", () => {
  it("should deduplicate same path enqueued twice within a single enqueue call", async () => {
    const { pipeline, indexChangedCalls } = makeMockPipeline();
    const scheduler = new IndexScheduler(pipeline as any);

    // Enqueue both add events in a single call — the Set deduplicates them
    scheduler.enqueue([
      { path: "src/app.ts", type: "add" },
      { path: "src/app.ts", type: "change" },
    ]);

    await waitForIdle(200);

    // Should only pass src/app.ts once to indexChanged
    const allPaths = indexChangedCalls.flat();
    const uniquePaths = new Set(allPaths);
    expect(uniquePaths.size).toBe(1);
    expect(uniquePaths.has("src/app.ts")).toBe(true);
  });

  it("should route unlink to deleteQueue and remove from indexQueue within one enqueue batch", async () => {
    const { pipeline, indexChangedCalls, removeFilesCalls } = makeMockPipeline();
    const scheduler = new IndexScheduler(pipeline as any);

    // Single enqueue batch: add two files, then unlink one
    // The Set mutation happens synchronously within enqueue(), so the unlink wins
    scheduler.enqueue([
      { path: "src/keep.ts", type: "add" },
      { path: "src/temp.ts", type: "add" },
      { path: "src/temp.ts", type: "unlink" },
    ]);

    await waitForIdle(200);

    // src/temp.ts was unlinked in the same batch, so it should go to deleteQueue
    const indexed = indexChangedCalls.flat();
    expect(indexed).toContain("src/keep.ts");
    expect(indexed).not.toContain("src/temp.ts");

    const removed = removeFilesCalls.flat();
    expect(removed).toContain("src/temp.ts");
  });

  it("should not call indexChanged when only unlink events are enqueued", async () => {
    const { pipeline, indexChangedCalls, removeFilesCalls } = makeMockPipeline();
    const scheduler = new IndexScheduler(pipeline as any);

    scheduler.enqueue([
      { path: "src/old.ts", type: "unlink" },
      { path: "src/gone.ts", type: "unlink" },
    ]);

    await waitForIdle(200);

    expect(indexChangedCalls.length).toBe(0);
    const removed = removeFilesCalls.flat();
    expect(removed).toContain("src/old.ts");
    expect(removed).toContain("src/gone.ts");
  });

  it("should not call removeFiles when only add/change events are enqueued", async () => {
    const { pipeline, indexChangedCalls, removeFilesCalls } = makeMockPipeline();
    const scheduler = new IndexScheduler(pipeline as any);

    scheduler.enqueue([
      { path: "src/new.ts", type: "add" },
      { path: "src/modified.ts", type: "change" },
    ]);

    await waitForIdle(200);

    expect(removeFilesCalls.length).toBe(0);
    const indexed = indexChangedCalls.flat();
    expect(indexed).toContain("src/new.ts");
    expect(indexed).toContain("src/modified.ts");
  });

  it("should process items enqueued during processing (re-flush)", async () => {
    // Use a delay to ensure second enqueue arrives while first is processing
    const { pipeline, indexChangedCalls } = makeMockPipeline({ indexChangedDelay: 80 });
    const scheduler = new IndexScheduler(pipeline as any);

    // First batch
    scheduler.enqueue([{ path: "src/file1.ts", type: "add" }]);

    // Wait a bit, then enqueue a second batch while first is processing
    await new Promise((r) => setTimeout(r, 20));
    scheduler.enqueue([{ path: "src/file2.ts", type: "add" }]);

    // Wait for both batches to complete
    await waitForIdle(400);

    const allIndexed = indexChangedCalls.flat();
    expect(allIndexed).toContain("src/file1.ts");
    expect(allIndexed).toContain("src/file2.ts");
  });

  it("should route change event to indexQueue and remove from deleteQueue in same batch", async () => {
    const { pipeline, indexChangedCalls, removeFilesCalls } = makeMockPipeline();
    const scheduler = new IndexScheduler(pipeline as any);

    // In a single batch: unlink first, then change — change should win
    scheduler.enqueue([
      { path: "src/flip.ts", type: "unlink" },
      { path: "src/flip.ts", type: "change" },
    ]);

    await waitForIdle(200);

    // Should be indexed (change won over unlink), not deleted
    const indexed = indexChangedCalls.flat();
    expect(indexed).toContain("src/flip.ts");

    const removed = removeFilesCalls.flat();
    expect(removed).not.toContain("src/flip.ts");
  });
});
