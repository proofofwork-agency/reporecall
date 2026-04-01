import { describe, expect, it } from "vitest";
import { evaluatePreToolUse, type HookSessionSnapshot } from "../../src/hooks/pre-tool-use.js";

function makeSnapshot(overrides?: Partial<HookSessionSnapshot>): HookSessionSnapshot {
  return {
    sessionKey: "session-1",
    queryMode: "trace",
    deliveryMode: "code_context",
    contextStrength: "sufficient",
    injectedFiles: ["src/hooks/useAuth.tsx", "src/pages/AuthCallback.tsx"],
    selectedFiles: ["src/hooks/useAuth.tsx", "src/pages/AuthCallback.tsx"],
    query: "how does useAuth manage auth state changes",
    missingEvidence: [],
    recommendedNextReads: ["src/hooks/useAuth.tsx", "src/pages/AuthCallback.tsx"],
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("evaluatePreToolUse", () => {
  it("advises instead of blocking when rereading an injected file", () => {
    const result = evaluatePreToolUse(
      {
        sessionId: "session-1",
        toolName: "Read",
        toolInput: { file_path: "/tmp/project/src/hooks/useAuth.tsx" },
      },
      makeSnapshot()
    );

    expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain("already injected");
  });

  it("advises instead of blocking generic search for focused R1 code context", () => {
    const result = evaluatePreToolUse(
      {
        sessionId: "session-1",
        toolName: "Grep",
        toolInput: { pattern: "useAuth", path: "/tmp/project" },
      },
      makeSnapshot()
    );

    expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result.hookSpecificOutput.additionalContext).toContain("Recommended next reads");
  });

  it("allows exploration when broad delivery was deferred to summary-only", () => {
    const result = evaluatePreToolUse(
      {
        sessionId: "session-1",
        toolName: "Grep",
        toolInput: { pattern: "checkout", path: "/tmp/project" },
      },
      makeSnapshot({
        queryMode: "architecture",
        deliveryMode: "summary_only",
        contextStrength: "weak",
        injectedFiles: [],
        selectedFiles: [],
      })
    );

    expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result.hookSpecificOutput.additionalContext).toContain("summary-only");
  });

  it("nudges broad search harder when context is already sufficient", () => {
    const result = evaluatePreToolUse(
      {
        sessionId: "session-1",
        toolName: "Glob",
        toolInput: { pattern: "**/*.ts" },
      },
      makeSnapshot({
        missingEvidence: ["Runtime caller coverage is still incomplete."],
      })
    );

    expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain("sufficient");
    expect(result.hookSpecificOutput.additionalContext).toContain("Recommended next reads");
  });
});
