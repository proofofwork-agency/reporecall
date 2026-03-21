import { describe, expect, it } from "vitest";
import { assembleMemoryContext } from "../../src/memory/context.js";
import type { MemorySearchResult } from "../../src/memory/types.js";

function makeResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    id: "test-id",
    score: 0.5,
    name: "test_memory",
    description: "A test memory",
    type: "feedback",
    content: "Test content.",
    filePath: "/tmp/memory/test.md",
    indexedAt: new Date().toISOString(),
    fileMtime: new Date().toISOString(),
    ...overrides,
  };
}

describe("assembleMemoryContext", () => {
  it("returns empty for no memories", () => {
    const result = assembleMemoryContext([], 500);
    expect(result.text).toBe("");
    expect(result.tokenCount).toBe(0);
    expect(result.memories).toHaveLength(0);
  });

  it("assembles single memory with correct format", () => {
    const result = assembleMemoryContext(
      [makeResult({ name: "feedback_testing", type: "feedback", content: "Use real DB." })],
      500
    );

    expect(result.text).toContain("## Memories");
    expect(result.text).toContain("[Rule] feedback_testing");
    expect(result.text).toContain("A test memory");
    expect(result.tokenCount).toBeGreaterThan(0);
    expect(result.memories).toHaveLength(1);
  });

  it("uses correct type labels", () => {
    const types = [
      { type: "user" as const, label: "Fact" },
      { type: "feedback" as const, label: "Rule" },
      { type: "project" as const, label: "Fact" },
      { type: "reference" as const, label: "Fact" },
    ];

    for (const { type, label } of types) {
      const result = assembleMemoryContext(
        [makeResult({ type, name: `${type}_mem` })],
        500
      );
      expect(result.text).toContain(`[${label}]`);
    }
  });

  it("respects token budget", () => {
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeResult({
        id: `mem-${i}`,
        name: `memory_${i}`,
        content: "This is a reasonably long content block that takes up tokens. ".repeat(5),
      })
    );

    // Very small budget
    const result = assembleMemoryContext(memories, 100);
    expect(result.memories.length).toBeLessThan(20);
    expect(result.tokenCount).toBeLessThanOrEqual(100);
  });

  it("includes multiple memories within budget", () => {
    const memories = [
      makeResult({ id: "1", name: "mem_1", content: "Short." }),
      makeResult({ id: "2", name: "mem_2", content: "Also short." }),
      makeResult({ id: "3", name: "mem_3", content: "Tiny." }),
    ];

    const result = assembleMemoryContext(memories, 2000);
    expect(result.memories).toHaveLength(3);
  });
});
