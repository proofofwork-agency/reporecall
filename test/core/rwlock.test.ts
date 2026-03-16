import { describe, it, expect } from "vitest";
import { ReadWriteLock } from "../../src/core/rwlock.js";

describe("ReadWriteLock", () => {
  it("allows concurrent reads", async () => {
    const lock = new ReadWriteLock();
    const log: string[] = [];

    await Promise.all([
      lock.withRead(async () => {
        log.push("r1-start");
        await delay(20);
        log.push("r1-end");
      }),
      lock.withRead(async () => {
        log.push("r2-start");
        await delay(20);
        log.push("r2-end");
      }),
    ]);

    // Both readers should start before either ends
    expect(log.indexOf("r1-start")).toBeLessThan(log.indexOf("r1-end"));
    expect(log.indexOf("r2-start")).toBeLessThan(log.indexOf("r2-end"));
    // Both should have started (concurrent)
    expect(log.slice(0, 2).sort()).toEqual(["r1-start", "r2-start"]);
  });

  it("write blocks reads and other writes", async () => {
    const lock = new ReadWriteLock();
    const log: string[] = [];

    // Start a write, then attempt a read and another write
    const p1 = lock.withWrite(async () => {
      log.push("w1-start");
      await delay(30);
      log.push("w1-end");
    });

    // Give microtask a chance to acquire the write lock
    await delay(5);

    const p2 = lock.withRead(async () => {
      log.push("r1-start");
      log.push("r1-end");
    });

    const p3 = lock.withWrite(async () => {
      log.push("w2-start");
      log.push("w2-end");
    });

    await Promise.all([p1, p2, p3]);

    // Write 1 should complete before read or write 2 starts
    expect(log.indexOf("w1-end")).toBeLessThan(log.indexOf("r1-start"));
    expect(log.indexOf("w1-end")).toBeLessThan(log.indexOf("w2-start"));
  });

  it("writer-preferring: pending write blocks new readers", async () => {
    const lock = new ReadWriteLock();
    const log: string[] = [];

    // Acquire a read lock first
    const p1 = lock.withRead(async () => {
      log.push("r1-start");
      await delay(30);
      log.push("r1-end");
    });

    await delay(5);

    // Queue a write (will wait for r1 to finish)
    const p2 = lock.withWrite(async () => {
      log.push("w1-start");
      await delay(10);
      log.push("w1-end");
    });

    await delay(5);

    // Queue a second read — should be blocked by pending writer
    const p3 = lock.withRead(async () => {
      log.push("r2-start");
      log.push("r2-end");
    });

    await Promise.all([p1, p2, p3]);

    // r2 should start after w1 completes (writer-preferring)
    expect(log.indexOf("w1-end")).toBeLessThan(log.indexOf("r2-start"));
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
