import { describe, it, expect } from "vitest";
import { IndexScheduler } from "../../src/daemon/scheduler.js";

// 3I: IndexScheduler

// Creates a mock pipeline that records calls.
function makeMockPipeline(): {
  pipeline: any;
  indexChangedCalls: string[][];
  removeFilesCalls: string[][];
} {
  const indexChangedCalls: string[][] = [];
  const removeFilesCalls: string[][] = [];

  const pipeline = {
    indexChanged: async (paths: string[]) => {
      indexChangedCalls.push([...paths]);
      return { filesProcessed: paths.length, chunksCreated: paths.length };
    },
    removeFiles: async (paths: string[]) => {
      removeFilesCalls.push([...paths]);
    },
  };

  return { pipeline, indexChangedCalls, removeFilesCalls };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
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

    await scheduler.drain();

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

    await scheduler.drain();

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

    await scheduler.drain();

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

    await scheduler.drain();

    expect(removeFilesCalls.length).toBe(0);
    const indexed = indexChangedCalls.flat();
    expect(indexed).toContain("src/new.ts");
    expect(indexed).toContain("src/modified.ts");
  });

  it("should process items enqueued during processing (re-flush)", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const indexChangedCalls: string[][] = [];
    let calls = 0;
    const pipeline = {
      indexChanged: async (paths: string[]) => {
        indexChangedCalls.push([...paths]);
        calls += 1;
        if (calls === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { filesProcessed: paths.length, chunksCreated: paths.length };
      },
      removeFiles: async () => undefined,
    };
    const scheduler = new IndexScheduler(pipeline as any);

    // First batch
    scheduler.enqueue([{ path: "src/file1.ts", type: "add" }]);

    await firstStarted.promise;
    scheduler.enqueue([{ path: "src/file2.ts", type: "add" }]);
    releaseFirst.resolve();

    await scheduler.drain();

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

    await scheduler.drain();

    // Should be indexed (change won over unlink), not deleted
    const indexed = indexChangedCalls.flat();
    expect(indexed).toContain("src/flip.ts");

    const removed = removeFilesCalls.flat();
    expect(removed).not.toContain("src/flip.ts");
  });
});
