import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { chunkFileWithCalls } from "../../src/parser/chunker.js";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");

describe("call edge receiver extraction", () => {
  it("should extract receiver for member expressions in TypeScript", async () => {
    // sample.ts has this.sessions.set(), this.sessions.get(), this.sessions.delete()
    // The SessionManager methods call this.sessions.set/get/delete
    const { callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    // this.sessions.set() -> receiver: "sessions", name: "set"
    const setEdges = callEdges.filter((e) => e.targetName === "set");
    expect(setEdges.length).toBeGreaterThan(0);
    expect(setEdges[0].receiver).toBe("sessions");

    // this.sessions.get() -> receiver: "sessions", name: "get"
    const getEdges = callEdges.filter((e) => e.targetName === "get");
    expect(getEdges.length).toBeGreaterThan(0);
    expect(getEdges[0].receiver).toBe("sessions");

    // this.sessions.delete() -> receiver: "sessions", name: "delete"
    const deleteEdges = callEdges.filter((e) => e.targetName === "delete");
    expect(deleteEdges.length).toBeGreaterThan(0);
    expect(deleteEdges[0].receiver).toBe("sessions");
  });

  it("should have undefined receiver for simple function calls", async () => {
    const { callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    // decodeToken() is a simple call — no receiver
    const decodeEdges = callEdges.filter((e) => e.targetName === "decodeToken");
    expect(decodeEdges.length).toBeGreaterThan(0);
    expect(decodeEdges[0].receiver).toBeUndefined();
  });

  it("should extract receiver for chained member access (last object in chain)", async () => {
    const { callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    // JSON.parse() -> receiver: "JSON", name: "parse"
    const parseEdges = callEdges.filter((e) => e.targetName === "parse");
    expect(parseEdges.length).toBeGreaterThan(0);
    expect(parseEdges[0].receiver).toBe("JSON");

    // token.split() -> receiver: "token", name: "split"
    const splitEdges = callEdges.filter((e) => e.targetName === "split");
    expect(splitEdges.length).toBeGreaterThan(0);
    expect(splitEdges[0].receiver).toBe("token");
  });

  it("should extract receiver for Date.now()", async () => {
    const { callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    const nowEdges = callEdges.filter((e) => e.targetName === "now");
    expect(nowEdges.length).toBeGreaterThan(0);
    expect(nowEdges[0].receiver).toBe("Date");
  });

  it("should have undefined receiver for new expressions with simple constructor", async () => {
    const { callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    // new Date() -> callType: "new", receiver: undefined
    const dateEdges = callEdges.filter(
      (e) => e.targetName === "Date" && e.callType === "new"
    );
    expect(dateEdges.length).toBeGreaterThan(0);
    expect(dateEdges[0].receiver).toBeUndefined();
  });

  it("should include receiver in dedup key", async () => {
    const { callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    // Date.now() and new Date() should both be present — different receiver/callType
    const dateNow = callEdges.filter(
      (e) => e.targetName === "now" && e.receiver === "Date"
    );
    const newDate = callEdges.filter(
      (e) => e.targetName === "Date" && e.callType === "new"
    );
    expect(dateNow.length).toBeGreaterThan(0);
    expect(newDate.length).toBeGreaterThan(0);
  });
});

describe("call edge receiver in Python", () => {
  it("should extract receiver for method calls", async () => {
    const { callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.py"),
      FIXTURES
    );

    // Python method calls should have receivers
    // We expect at least some edges to have a receiver
    const withReceiver = callEdges.filter((e) => e.receiver !== undefined);
    expect(withReceiver.length).toBeGreaterThan(0);
  });
});
