import { describe, expect, it } from "vitest";
import {
  auditRouteFromQueryMode,
  auditExitCode,
  buildSummary,
  computeContextMetrics,
  extractClaudeToolUses,
  parseInjectedFilesFromContext,
  renderMarkdownReport,
  splitContextSections,
  type AuditQueryResult,
  type ProjectContextAuditReport,
} from "../../scripts/benchmarks/project-context-audit-lib.js";

function makeAuditResult(pollutionRatio: number): AuditQueryResult {
  return {
    id: `pollution-${pollutionRatio}`,
    query: "trace the authentication flow",
    expectedRoute: "R1",
    category: "auth",
    directExplain: {
      ok: true,
      route: "R1",
      selectedFiles: ["src/hooks/useAuth.tsx"],
    },
    hookContext: {
      ok: true,
      freshnessLevel: "fresh",
      route: "R1",
      files: ["src/hooks/useAuth.tsx"],
      sections: [],
      text: "",
      tokensInjected: 10,
      chunksInjected: 1,
    },
    contextMetrics: {
      routeMatch: true,
      contextPrecision: 1,
      contextRecall: 1,
      mustIncludeHitRate: 1,
      mustNotIncludeViolation: false,
      pollutionRatio,
      tokenPollutionRatio: pollutionRatio,
      explorerUsed: false,
      redundantExplorerUsed: false,
      contextFailed: false,
      legitimateGap: false,
      highConfidenceWrong: false,
      relevantInjectedFiles: ["src/hooks/useAuth.tsx"],
      irrelevantInjectedFiles: [],
      missingRelevantFiles: [],
      mustIncludeMisses: [],
      mustNotIncludeHits: [],
    },
    reporecallVsControlTokenDelta: 0,
    reporecallVsControlToolDelta: 0,
  };
}

describe("project context audit helpers", () => {
  it("maps current query modes onto the versioned audit routes", () => {
    expect(auditRouteFromQueryMode("skip")).toBe("skip");
    expect(auditRouteFromQueryMode("lookup")).toBe("R0");
    expect(auditRouteFromQueryMode("trace")).toBe("R1");
    expect(auditRouteFromQueryMode("architecture")).toBe("R2");
    expect(auditRouteFromQueryMode("bug")).toBe("R2");
    expect(auditRouteFromQueryMode("change")).toBe("R2");
    expect(auditRouteFromQueryMode("unknown")).toBeUndefined();
  });

  it("parses injected files from hook context headers and file sections", () => {
    const text = [
      "## Relevant codebase context",
      "",
      "> Files included: src/pages/Auth.tsx, src/hooks/useAuth.tsx (+1 more)",
      "",
      "### src/pages/Auth.tsx",
      "auth code",
      "",
      "### src/hooks/useAuth.tsx",
      "hook code",
      "",
      "### src/App.tsx",
      "app code",
    ].join("\n");

    expect(parseInjectedFilesFromContext(text)).toEqual([
      "src/pages/Auth.tsx",
      "src/hooks/useAuth.tsx",
      "src/App.tsx",
    ]);
    expect(splitContextSections(text).map((section) => section.filePath)).toEqual([
      "src/pages/Auth.tsx",
      "src/hooks/useAuth.tsx",
      "src/App.tsx",
    ]);
  });

  it("extracts Claude tool uses and classifies explorer behavior", () => {
    const events = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/tmp/project/src/hooks/useAuth.tsx" } },
            { type: "tool_use", name: "Bash", input: { command: "rg -n pendingNavigation src" } },
            { type: "tool_use", name: "mcp__reporecall__search_code", input: { query: "auth flow" } },
          ],
        },
      },
    ] as Array<Record<string, unknown>>;

    const tools = extractClaudeToolUses(events, "/tmp/project", "/tmp/project");
    expect(tools.map((tool) => tool.classification)).toEqual([
      "reader",
      "explorer",
      "reporecall",
    ]);
    expect(tools[0]?.filePaths).toEqual(["src/hooks/useAuth.tsx"]);
  });

  it("computes pollution and legitimate-gap metrics", () => {
    const metrics = computeContextMetrics({
      expectedRoute: "R2",
      actualRoute: "R2",
      injectedFiles: [
        "src/pages/Auth.tsx",
        "src/hooks/useAuth.tsx",
        "src/components/flow/LogNode.tsx",
      ],
      sections: [
        { filePath: "src/pages/Auth.tsx", text: "a", tokens: 10 },
        { filePath: "src/hooks/useAuth.tsx", text: "b", tokens: 20 },
        { filePath: "src/components/flow/LogNode.tsx", text: "c", tokens: 30 },
      ],
      relevance: {
        "src/pages/Auth.tsx": 3,
        "src/hooks/useAuth.tsx": 3,
        "src/pages/AuthCallback.tsx": 2,
      },
      mustInclude: ["src/pages/Auth.tsx", "src/pages/AuthCallback.tsx"],
      mustNotInclude: ["src/components/flow/"],
      claudeRun: {
        mode: "claude_with_reporecall",
        blocked: false,
        ok: true,
        toolUses: [],
        openedFiles: ["src/pages/AuthCallback.tsx"],
        explorerUsed: true,
        redundantExplorerUsed: false,
        contextFailed: true,
      },
    });

    expect(metrics.routeMatch).toBe(true);
    expect(metrics.contextPrecision).toBeCloseTo(0.667, 3);
    expect(metrics.contextRecall).toBeCloseTo(0.667, 3);
    expect(metrics.mustIncludeHitRate).toBeCloseTo(0.5, 3);
    expect(metrics.mustNotIncludeViolation).toBe(true);
    expect(metrics.pollutionRatio).toBeCloseTo(0.333, 3);
    expect(metrics.tokenPollutionRatio).toBeCloseTo(0.5, 3);
    expect(metrics.legitimateGap).toBe(true);
    expect(metrics.highConfidenceWrong).toBe(false);
  });

  it("flags strong code context that misses required evidence", () => {
    const metrics = computeContextMetrics({
      expectedRoute: "R2",
      actualRoute: "R2",
      deliveryMode: "code_context",
      confidence: 0.92,
      injectedFiles: ["src/pages/Auth.tsx"],
      sections: [{ filePath: "src/pages/Auth.tsx", text: "auth", tokens: 4 }],
      relevance: {
        "src/pages/Auth.tsx": 3,
        "src/hooks/useAuth.tsx": 3,
      },
      mustInclude: ["src/pages/Auth.tsx", "src/hooks/useAuth.tsx"],
    });

    expect(metrics.highConfidenceWrong).toBe(true);
    expect(metrics.mustIncludeMisses).toEqual(["src/hooks/useAuth.tsx"]);
  });

  it("enforces a maximum average context pollution ratio of ten percent", () => {
    const atGate = [
      ...Array.from({ length: 9 }, () => makeAuditResult(0)),
      makeAuditResult(1),
    ];
    const aboveGate = [
      ...Array.from({ length: 8 }, () => makeAuditResult(0)),
      makeAuditResult(1),
    ];

    expect(buildSummary(atGate).avgPollutionRatio).toBe(0.1);
    expect(buildSummary(atGate).reporecallOnlyPass).toBe(true);
    expect(buildSummary(aboveGate).avgPollutionRatio).toBe(0.111);
    expect(buildSummary(aboveGate).reporecallOnlyPass).toBe(false);
  });

  it("fails the process gate when deterministic retrieval thresholds fail", () => {
    const report = {
      metadata: { mode: "reporecall-only" },
      summary: { reporecallOnlyPass: false, claudeE2ePass: null },
    } as ProjectContextAuditReport;

    expect(auditExitCode(report)).toBe(1);
    report.summary.reporecallOnlyPass = true;
    expect(auditExitCode(report)).toBe(0);
    report.metadata.mode = "full";
    report.summary.claudeE2ePass = false;
    expect(auditExitCode(report)).toBe(1);
  });

  it("renders a markdown report from aggregated results", () => {
    const query = {
      id: "auth-flow",
      query: "which files implement the authentication flow",
      expectedRoute: "R2",
      category: "auth",
      directExplain: { ok: true, route: "R2", selectedFiles: ["src/pages/Auth.tsx"] },
      hookContext: {
        ok: true,
        freshnessLevel: "fresh",
        route: "R2",
        files: ["src/pages/Auth.tsx"],
        sections: [],
        text: "",
        tokensInjected: 42,
        chunksInjected: 1,
      },
      contextMetrics: {
        routeMatch: true,
        contextPrecision: 1,
        contextRecall: 1,
        mustIncludeHitRate: 1,
        mustNotIncludeViolation: false,
        pollutionRatio: 0,
        tokenPollutionRatio: 0,
        explorerUsed: false,
        redundantExplorerUsed: false,
        contextFailed: false,
        legitimateGap: false,
        highConfidenceWrong: false,
        relevantInjectedFiles: ["src/pages/Auth.tsx"],
        irrelevantInjectedFiles: [],
        missingRelevantFiles: [],
        mustIncludeMisses: [],
        mustNotIncludeHits: [],
      },
      reporecallVsControlTokenDelta: 0,
      reporecallVsControlToolDelta: 0,
    } satisfies AuditQueryResult;

    const report = {
      metadata: {
        ideaRoot: "/idea",
        projectRoot: "/project",
        ideaGitSha: "abc",
        ideaGitTag: "v0.3.3",
        projectGitSha: "def",
        createdAt: "2026-03-23T00:00:00.000Z",
        mode: "reporecall-only",
      },
      health: {
        distExists: true,
        projectExists: true,
        mcpConfigExists: true,
        mcpConfigResolvesReporecall: true,
        claudeCliAvailable: true,
        claudeAuthReady: false,
        explainRunnable: true,
        daemonHealthy: true,
        daemonStartedByAudit: false,
        hookHealthy: true,
        blockedReasons: ["claude_not_logged_in"],
      },
      summary: buildSummary([query]),
      queries: [query],
    } satisfies ProjectContextAuditReport;

    const markdown = renderMarkdownReport(report);
    expect(report.summary.freshnessSignalingRate).toBe(1);
    expect(report.summary.reporecallOnlyPass).toBe(true);
    expect(markdown).toContain("# Project Context Audit");
    expect(markdown).toContain("Fresh/stale/empty signaling: 100%");
    expect(markdown).toContain("Claude E2E pass: BLOCKED");
    expect(markdown).toContain("auth-flow");
  });
});
