import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../../src/indexer/embedder.js";

// Unit tests for the CircuitBreaker class in isolation.

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    // threshold=3, cooldown=1000ms for fast tests
    cb = new CircuitBreaker(3, 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed and passes through successful calls", async () => {
    const result = await cb.call(async () => 42);
    expect(result).toBe(42);
    expect(cb.getState()).toBe("closed");
  });

  it("stays closed below failure threshold", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("boom");
    };

    for (let i = 0; i < 2; i++) {
      await expect(cb.call(fail)).rejects.toThrow("boom");
    }
    expect(cb.getState()).toBe("closed");
  });

  it("opens after hitting the failure threshold", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("service down");
    };

    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail)).rejects.toThrow();
    }
    expect(cb.getState()).toBe("open");
  });

  it("rejects immediately when open without calling the underlying fn", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("service down");
    };

    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail)).rejects.toThrow();
    }

    const spy = vi.fn(async () => "should not be called");
    await expect(cb.call(spy)).rejects.toThrow("Circuit breaker open");
    expect(spy).not.toHaveBeenCalled();
  });

  it("transitions to half-open after cooldown and probes", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("service down");
    };

    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail)).rejects.toThrow();
    }
    expect(cb.getState()).toBe("open");

    // Advance past cooldown
    vi.advanceTimersByTime(1001);

    // Next call should go through (half-open probe)
    const spy = vi.fn(async () => "ok");
    const result = await cb.call(spy);
    expect(result).toBe("ok");
    expect(spy).toHaveBeenCalledOnce();
    expect(cb.getState()).toBe("closed");
  });

  it("re-opens if the half-open probe fails", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("still down");
    };

    // Open the circuit
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail)).rejects.toThrow();
    }

    // Advance past cooldown
    vi.advanceTimersByTime(1001);

    // Probe fails — circuit should re-open
    await expect(cb.call(fail)).rejects.toThrow("still down");
    expect(cb.getState()).toBe("open");
  });

  it("reset() returns circuit to closed state", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("boom");
    };

    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail)).rejects.toThrow();
    }
    expect(cb.getState()).toBe("open");

    cb.reset();
    expect(cb.getState()).toBe("closed");

    const result = await cb.call(async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("error message includes remaining cooldown seconds", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("down");
    };

    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fail)).rejects.toThrow();
    }

    vi.advanceTimersByTime(400); // 600ms remaining
    const err = await cb.call(async () => "x").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Retry in \d+s/);
  });
});
