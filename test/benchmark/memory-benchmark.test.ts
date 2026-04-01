/**
 * Deterministic Memory V1 benchmark — exercises indexing, retrieval, freshness,
 * lifecycle/compaction, routing, and prompt assembly without any API calls.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  readdirSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { MemoryStore } from "../../src/storage/memory-store.js";
import { MemoryIndexer } from "../../src/memory/indexer.js";
import { MemorySearch } from "../../src/memory/search.js";
import { assembleMemoryContext } from "../../src/memory/context.js";
import type {
  Memory,
  MemoryClass,
  MemoryRoute,
  MemoryScope,
  MemorySearchOptions,
  MemoryType,
} from "../../src/memory/types.js";
import { computeBenchmarkSuiteMetrics } from "./metrics.js";

interface SyntheticMemory {
  root: "claude" | "local";
  filename: string;
  name: string;
  description: string;
  type: MemoryType;
  class?: MemoryClass;
  scope?: MemoryScope;
  status?: "active" | "archived" | "superseded";
  summary?: string;
  fingerprint?: string;
  pinned?: boolean;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  confidence?: number;
  reason?: string;
  content: string;
  mtimeDaysAgo?: number;
  indexedDaysAgo?: number;
}

interface SearchTestCase {
  query: string;
  options?: MemorySearchOptions;
  expectedGrades: Record<string, number>;
  mustFind: string[];
  topResult?: string;
  expectedRoute: MemoryRoute;
  freshnessTop?: string;
}

const THRESHOLDS = {
  indexingMsPerMemoryMax: 50,
  recallMin: 0.9,
  ndcg10Min: 0.75,
  mrrMin: 0.6,
  mapMin: 0.7,
  avgSearchMsMax: 20,
  p95SearchMsMax: 40,
  routeAccuracyMin: 1,
  freshnessAccuracyMin: 1,
  assemblyMsMax: 5,
};

const CORPUS: SyntheticMemory[] = [
  {
    root: "claude",
    filename: "rule_commit_trailers",
    name: "rule_commit_trailers",
    description: "Do not add Co-Authored-By trailers to commits",
    type: "feedback",
    class: "rule",
    scope: "global",
    summary: "Skip Claude co-author trailers in git commits.",
    content:
      "Skip the Co-Authored-By trailer in all commit messages.\nOmit the trailer entirely when creating commits.",
  },
  {
    root: "local",
    filename: "rule_testing_real_db",
    name: "rule_testing_real_db",
    description: "Integration tests must use a real database",
    type: "feedback",
    class: "rule",
    scope: "global",
    summary: "Integration tests hit a real database, never mocks.",
    content:
      "Integration tests must hit a real database, not mocks.\nNever use jest.mock() for database connections in integration tests.",
  },
  {
    root: "claude",
    filename: "fact_user_backend",
    name: "fact_user_backend",
    description: "User is a senior backend engineer",
    type: "user",
    class: "fact",
    scope: "global",
    summary: "Senior Go and TypeScript backend engineer.",
    content:
      "Senior backend engineer with 10+ years of Go and TypeScript.\nExplain frontend changes using backend analogies first.",
  },
  {
    root: "claude",
    filename: "fact_release_deadline",
    name: "fact_release_deadline",
    description: "Release deadline is March 28, 2026",
    type: "project",
    class: "fact",
    scope: "project",
    summary: "Code freeze is March 28, 2026 at 17:00 UTC.",
    content:
      "All features must be complete by March 28, 2026.\nCode freeze is 2026-03-28 at 17:00 UTC and QA runs March 29-31.",
  },
  {
    root: "local",
    filename: "fact_auth_compliance_primary",
    name: "fact_auth_compliance_primary",
    description: "Auth middleware rewrite is compliance-driven",
    type: "project",
    class: "fact",
    scope: "project",
    summary: "Compliance requirements drive the auth rewrite.",
    fingerprint: "auth-compliance-shared",
    pinned: true,
    confidence: 0.92,
    relatedFiles: ["src/auth/session.ts"],
    relatedSymbols: ["validateSession", "persistToken"],
    content:
      "The auth middleware rewrite is required for compliance with session token storage rules.\nScope decisions should favor compliance over ergonomics.",
  },
  {
    root: "claude",
    filename: "fact_auth_compliance_shadow",
    name: "fact_auth_compliance_shadow",
    description: "Legacy auth rewrite note",
    type: "project",
    class: "fact",
    scope: "project",
    summary: "Older auth rewrite note kept for compatibility.",
    fingerprint: "auth-compliance-shared",
    confidence: 0.51,
    content:
      "Older auth rewrite note for session middleware.\nKept for historical reference, but less specific than the current compliance brief.",
  },
  {
    root: "claude",
    filename: "fact_reference_linear",
    name: "fact_reference_linear",
    description: "Pipeline bugs are tracked in Linear project INGEST",
    type: "reference",
    class: "fact",
    scope: "global",
    summary: "Use Linear project INGEST for ingestion bugs.",
    content:
      'Bug reports and ingestion pipeline issues are tracked in the Linear project "INGEST".',
  },
  {
    root: "local",
    filename: "episode_recent_outage",
    name: "episode_recent_outage",
    description: "Queue retry outage timeline for the current incident",
    type: "project",
    class: "episode",
    scope: "project",
    summary: "Queue retry outage timeline with the current worker fix.",
    reason: "Recent incident summary for on-call follow-up",
    content:
      "Queue retry outage timeline.\nQueue worker outage on the retry pipeline.\nFix involved worker restart and retry backoff tuning.",
  },
  {
    root: "claude",
    filename: "episode_stale_outage",
    name: "episode_stale_outage",
    description: "Queue retry outage timeline for the older incident",
    type: "project",
    class: "episode",
    scope: "project",
    summary: "Queue retry outage timeline from the older worker incident.",
    reason: "Historical incident note",
    content:
      "Queue retry outage timeline.\nQueue worker outage on the retry pipeline.\nOlder notes before the current backoff policy was added.",
    mtimeDaysAgo: 120,
    indexedDaysAgo: 120,
  },
  {
    root: "local",
    filename: "working_auth_branch",
    name: "working_auth_branch",
    description: "Current auth working set",
    type: "project",
    class: "working",
    scope: "branch",
    summary: "Branch auth focus with validateSession and token persistence.",
    relatedFiles: ["src/auth/session.ts", "src/auth/persist.ts"],
    relatedSymbols: ["validateSession", "persistToken"],
    confidence: 0.65,
    content:
      "Last query: tighten auth session handling\nCode route: R1\nRelevant symbols: validateSession, persistToken\nActive files: src/auth/session.ts, src/auth/persist.ts",
  },
];

const SEARCH_CASES: SearchTestCase[] = [
  {
    query: "commit message guidelines",
    options: { classes: ["rule"] },
    expectedGrades: { rule_commit_trailers: 3 },
    mustFind: ["rule_commit_trailers"],
    topResult: "rule_commit_trailers",
    expectedRoute: "M1",
  },
  {
    query: "database testing approach",
    options: { classes: ["rule"] },
    expectedGrades: { rule_testing_real_db: 3 },
    mustFind: ["rule_testing_real_db"],
    topResult: "rule_testing_real_db",
    expectedRoute: "M1",
  },
  {
    query: "who is the user and what are their skills",
    options: { classes: ["fact"], types: ["user"] },
    expectedGrades: { fact_user_backend: 3 },
    mustFind: ["fact_user_backend"],
    topResult: "fact_user_backend",
    expectedRoute: "M2",
  },
  {
    query: "project deadline and timeline",
    options: { classes: ["fact"], types: ["project"] },
    expectedGrades: { fact_release_deadline: 3 },
    mustFind: ["fact_release_deadline"],
    topResult: "fact_release_deadline",
    expectedRoute: "M2",
  },
  {
    query: "auth middleware compliance",
    options: { classes: ["fact"], types: ["project"] },
    expectedGrades: { fact_auth_compliance_primary: 3, fact_auth_compliance_shadow: 1 },
    mustFind: ["fact_auth_compliance_primary"],
    topResult: "fact_auth_compliance_primary",
    expectedRoute: "M2",
  },
  {
    query: "where are bugs tracked",
    options: { classes: ["fact"], types: ["reference"] },
    expectedGrades: { fact_reference_linear: 3 },
    mustFind: ["fact_reference_linear"],
    topResult: "fact_reference_linear",
    expectedRoute: "M2",
  },
  {
    query: "queue retry outage timeline",
    options: { classes: ["episode"] },
    expectedGrades: { episode_recent_outage: 3 },
    mustFind: ["episode_recent_outage"],
    topResult: "episode_recent_outage",
    expectedRoute: "M2",
    freshnessTop: "episode_recent_outage",
  },
  {
    query: "historical older worker incident notes",
    options: { classes: ["episode"] },
    expectedGrades: { episode_stale_outage: 3 },
    mustFind: ["episode_stale_outage"],
    topResult: "episode_stale_outage",
    expectedRoute: "M2",
  },
  {
    query: "current auth working set validateSession",
    options: {
      classes: ["working"],
      activeFiles: ["src/auth/session.ts"],
      topCodeSymbols: ["validateSession"],
    },
    expectedGrades: { working_auth_branch: 3 },
    mustFind: ["working_auth_branch"],
    topResult: "working_auth_branch",
    expectedRoute: "M1",
  },
];

describe("memory layer benchmark", { timeout: 120_000 }, () => {
  let dataDir: string;
  let claudeDir: string;
  let localDir: string;
  let store: MemoryStore;
  let indexer: MemoryIndexer;
  let search: MemorySearch;
  let initialIndexMs = 0;
  let compactionResult = { deduped: 0, archived: 0, superseded: 0 };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mem-bench-data-"));
    claudeDir = mkdtempSync(join(tmpdir(), "mem-bench-claude-"));
    localDir = mkdtempSync(join(tmpdir(), "mem-bench-local-"));

    for (const memory of CORPUS) {
      const targetDir = memory.root === "claude" ? claudeDir : localDir;
      const filePath = resolve(targetDir, `${memory.filename}.md`);
      writeFileSync(filePath, buildMemoryMarkdown(memory), "utf-8");
      if (memory.mtimeDaysAgo !== undefined) {
        const timestamp = daysAgo(memory.mtimeDaysAgo);
        utimesSync(filePath, timestamp, timestamp);
      }
    }

    writeFileSync(join(claudeDir, "MEMORY.md"), "# Claude Memory Index\n", "utf-8");
    writeFileSync(join(localDir, "MEMORY.md"), "# Local Memory Index\n", "utf-8");
    writeFileSync(join(localDir, "random_notes.md"), "plain text without frontmatter", "utf-8");

    store = new MemoryStore(dataDir);
    indexer = new MemoryIndexer(store, [claudeDir, localDir], {
      readOnlyDirs: [claudeDir],
      writableDirs: [localDir],
    });
    search = new MemorySearch(store);

    const start = performance.now();
    const result = await indexer.indexAll();
    initialIndexMs = performance.now() - start;

    expect(result.indexed).toBe(CORPUS.length);
    expect(result.errors).toBe(0);

    for (const memory of CORPUS) {
      if (memory.indexedDaysAgo === undefined) continue;
      const existing = store.getByName(memory.name);
      if (!existing) continue;
      store.upsert({
        ...existing,
        indexedAt: daysAgo(memory.indexedDaysAgo).toISOString(),
      });
    }
  });

  afterAll(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(localDir, { recursive: true, force: true });
  });

  describe("indexing", () => {
    it("indexes deterministic dual-root memories with all memory classes", () => {
      const all = store.getAll();
      const byClass = countBy(all, (memory) => memory.class ?? "fact");

      console.log(
        `  Indexing: ${all.length} memories in ${initialIndexMs.toFixed(1)}ms ` +
          `(${(initialIndexMs / all.length).toFixed(1)}ms/memory)`
      );

      expect(store.getCount()).toBe(CORPUS.length);
      expect(byClass.rule).toBe(2);
      expect(byClass.fact).toBe(5);
      expect(byClass.episode).toBe(2);
      expect(byClass.working).toBe(1);
    });

    it("marks Claude and local roots with distinct source kinds", () => {
      expect(store.getByName("rule_commit_trailers")?.sourceKind).toBe("claude_auto");
      expect(store.getByName("rule_testing_real_db")?.sourceKind).toBe("reporecall_local");
      expect(store.getByName("working_auth_branch")?.sourceKind).toBe("reporecall_local");
    });

    it("skips MEMORY.md and unchanged invalid files on re-index", async () => {
      const result = await indexer.indexAll();
      expect(result.indexed).toBe(0);
      expect(result.errors).toBe(0);
      expect(store.getCount()).toBe(CORPUS.length);
    });

    it("meets the indexing latency threshold", () => {
      expect(initialIndexMs / CORPUS.length).toBeLessThan(THRESHOLDS.indexingMsPerMemoryMax);
    });
  });

  describe("search quality", () => {
    let suiteMetrics = computeBenchmarkSuiteMetrics([]);
    let searchResults = new Map<string, ReturnType<MemorySearch["search"]> extends Promise<infer T> ? T : never>();

    beforeAll(async () => {
      const caseMetrics = [];
      searchResults = new Map();

      for (const testCase of SEARCH_CASES) {
        const started = performance.now();
        const results = await search.search(testCase.query, testCase.options);
        const latencyMs = performance.now() - started;
        searchResults.set(testCase.query, results);

        const grades = results.map((result) => testCase.expectedGrades[result.name] ?? 0);
        const ideal = Object.values(testCase.expectedGrades).sort((a, b) => b - a);
        const route = assembleMemoryContext(results, 600, { maxMemories: 3 }).route;

        caseMetrics.push({
          retrieved: grades,
          ideal,
          latencyMs,
          routeMatched: route === testCase.expectedRoute,
          freshnessMatched: testCase.freshnessTop
            ? results[0]?.name === testCase.freshnessTop
            : undefined,
        });
      }

      suiteMetrics = computeBenchmarkSuiteMetrics(caseMetrics);
      console.log(
        `  Search: recall ${(suiteMetrics.recall * 100).toFixed(1)}%, ` +
          `NDCG@10 ${suiteMetrics.ndcg10.toFixed(3)}, MRR ${suiteMetrics.mrr.toFixed(3)}, ` +
          `MAP ${suiteMetrics.map.toFixed(3)}, avg ${suiteMetrics.avgLatencyMs.toFixed(1)}ms, ` +
          `p95 ${suiteMetrics.p95LatencyMs.toFixed(1)}ms, route ${(suiteMetrics.routeAccuracy * 100).toFixed(1)}%`
      );
    });

    it("retrieves the expected memories across rule, fact, episode, and working queries", () => {
      for (const testCase of SEARCH_CASES) {
        const results = searchResults.get(testCase.query) ?? [];
        const resultNames = new Set(results.map((result) => result.name));
        for (const expected of testCase.mustFind) {
          expect(resultNames.has(expected), `${testCase.query} should include ${expected}`).toBe(true);
        }
        if (testCase.topResult) {
          expect(results[0]?.name).toBe(testCase.topResult);
        }
      }
    });

    it("meets deterministic retrieval and latency thresholds", () => {
      expect(suiteMetrics.recall).toBeGreaterThanOrEqual(THRESHOLDS.recallMin);
      expect(suiteMetrics.ndcg10).toBeGreaterThanOrEqual(THRESHOLDS.ndcg10Min);
      expect(suiteMetrics.mrr).toBeGreaterThanOrEqual(THRESHOLDS.mrrMin);
      expect(suiteMetrics.map).toBeGreaterThanOrEqual(THRESHOLDS.mapMin);
      expect(suiteMetrics.avgLatencyMs).toBeLessThan(THRESHOLDS.avgSearchMsMax);
      expect(suiteMetrics.p95LatencyMs).toBeLessThan(THRESHOLDS.p95SearchMsMax);
      expect(suiteMetrics.routeAccuracy).toBeGreaterThanOrEqual(THRESHOLDS.routeAccuracyMin);
      expect(suiteMetrics.freshnessAccuracy).toBeGreaterThanOrEqual(THRESHOLDS.freshnessAccuracyMin);
    });

    it("ranks fresher episodic memories above stale copies", async () => {
      const sharedResults = await search.search("queue retry outage timeline", { classes: ["episode"] });
      const historicalResults = await search.search("historical older worker incident notes", {
        classes: ["episode"],
      });

      expect(sharedResults[0]?.name).toBe("episode_recent_outage");
      expect(historicalResults[0]?.name).toBe("episode_stale_outage");
    });

    it("supports class and file/symbol aware working-memory retrieval", async () => {
      const results = await search.search("validateSession auth focus", {
        classes: ["working"],
        activeFiles: ["src/auth/session.ts"],
        topCodeSymbols: ["validateSession"],
      });

      expect(results[0]?.name).toBe("working_auth_branch");
      expect(results.every((result) => result.class === "working")).toBe(true);
    });
  });

  describe("context assembly", () => {
    it("returns M0 with no memories", () => {
      const context = assembleMemoryContext([], 300);
      expect(context.route).toBe("M0");
      expect(context.text).toBe("");
    });

    it("routes rule/working contexts to M1 and fact/episode contexts to M2", async () => {
      const m1Rule = assembleMemoryContext(
        await search.search("commit message guidelines", { classes: ["rule"] }),
        400,
        { maxMemories: 2 }
      );
      const m1Working = assembleMemoryContext(
        await search.search("current auth working set validateSession", {
          classes: ["working"],
          activeFiles: ["src/auth/session.ts"],
          topCodeSymbols: ["validateSession"],
        }),
        400,
        { maxMemories: 2 }
      );
      const m2Fact = assembleMemoryContext(
        await search.search("project deadline and timeline", { classes: ["fact"], types: ["project"] }),
        400,
        { maxMemories: 2 }
      );
      const m2Episode = assembleMemoryContext(
        await search.search("queue retry outage timeline", { classes: ["episode"] }),
        400,
        { maxMemories: 2 }
      );

      expect(m1Rule.route).toBe("M1");
      expect(m1Working.route).toBe("M1");
      expect(m2Fact.route).toBe("M2");
      expect(m2Episode.route).toBe("M2");
    });

    it("formats class labels and compresses fact memories while preserving working bodies", async () => {
      const factContext = assembleMemoryContext(
        await search.search("project deadline and timeline", { classes: ["fact"], types: ["project"] }),
        400
      );
      const workingContext = assembleMemoryContext(
        await search.search("current auth working set validateSession", {
          classes: ["working"],
          activeFiles: ["src/auth/session.ts"],
          topCodeSymbols: ["validateSession"],
        }),
        400
      );

      expect(factContext.text).toContain("## Memory guidance");
      expect(factContext.text).toContain("[Fact]");
      expect(factContext.text).not.toContain("QA runs March 29-31");

      expect(workingContext.text).toContain("[Working]");
      expect(workingContext.text).toContain("Active files: src/auth/session.ts, src/auth/persist.ts");
    });

    it("stays within token budgets and remains fast", async () => {
      const results = await search.search("queue retry outage timeline", {
        classes: ["episode"],
        statuses: ["active", "archived"],
      });
      const ctx100 = assembleMemoryContext(results, 100);
      const ctx400 = assembleMemoryContext(results, 400);

      const started = performance.now();
      for (let i = 0; i < 100; i++) {
        assembleMemoryContext(results, 400);
      }
      const elapsedMs = (performance.now() - started) / 100;

      console.log(`  Assembly: ${elapsedMs.toFixed(2)}ms per call`);

      expect(ctx100.tokenCount).toBeLessThanOrEqual(100);
      expect(ctx400.tokenCount).toBeLessThanOrEqual(400);
      expect(ctx100.memories.length).toBeLessThanOrEqual(ctx400.memories.length);
      expect(elapsedMs).toBeLessThan(THRESHOLDS.assemblyMsMax);
    });
  });

  describe("compaction and lifecycle", () => {
    it("supersedes duplicate facts and archives stale episodes", async () => {
      compactionResult = indexer.compact({ archiveEpisodeOlderThanDays: 30 });

      const kept = store.getByName("fact_auth_compliance_primary");
      const shadow = store.getByName("fact_auth_compliance_shadow");
      const staleEpisode = store.getByName("episode_stale_outage");

      expect(compactionResult.deduped).toBe(1);
      expect(compactionResult.superseded).toBe(1);
      expect(compactionResult.archived).toBe(1);

      expect(kept?.status).toBe("active");
      expect(shadow?.status).toBe("superseded");
      expect(shadow?.supersedesId).toBe(kept?.id);
      expect(staleEpisode?.status).toBe("archived");
      expect(staleEpisode?.reason).toContain("older than 30 days");

      const defaultEpisodeResults = await search.search("queue retry outage timeline", {
        classes: ["episode"],
      });
      const includeArchived = await search.search("queue retry outage timeline", {
        classes: ["episode"],
        statuses: ["active", "archived"],
      });

      expect(defaultEpisodeResults.map((result) => result.name)).toEqual(["episode_recent_outage"]);
      expect(includeArchived.map((result) => result.name)).toEqual(["episode_recent_outage"]);
      expect(store.getByName("episode_stale_outage")?.status).toBe("archived");
    });
  });

  describe("summary", () => {
    it("prints the deterministic Memory V1 benchmark scorecard", async () => {
      const all = store.getAll();
      const byClass = countBy(all, (memory) => memory.class ?? "fact");
      const byStatus = countBy(all, (memory) => memory.status ?? "active");

      console.log("\nMemory V1 benchmark");
      console.log(
        `  Corpus: ${all.length} memories across dual roots ` +
          `(rule=${byClass.rule}, fact=${byClass.fact}, episode=${byClass.episode}, working=${byClass.working})`
      );
      console.log(
        `  Lifecycle: active=${byStatus.active}, archived=${byStatus.archived}, superseded=${byStatus.superseded}`
      );
      console.log(
        `  Thresholds: index<${THRESHOLDS.indexingMsPerMemoryMax}ms/mem, ` +
          `recall>=${THRESHOLDS.recallMin}, NDCG@10>=${THRESHOLDS.ndcg10Min}, ` +
          `MRR>=${THRESHOLDS.mrrMin}, MAP>=${THRESHOLDS.mapMin}, ` +
          `search avg<${THRESHOLDS.avgSearchMsMax}ms, p95<${THRESHOLDS.p95SearchMsMax}ms, ` +
          `route>=${THRESHOLDS.routeAccuracyMin}, freshness>=${THRESHOLDS.freshnessAccuracyMin}`
      );
      console.log(
        `  Compaction: deduped=${compactionResult.deduped}, archived=${compactionResult.archived}, superseded=${compactionResult.superseded}`
      );

      expect(byClass.rule).toBe(2);
      expect(byStatus.archived).toBeGreaterThanOrEqual(1);
      expect(byStatus.superseded).toBeGreaterThanOrEqual(1);
    });
  });
});

function buildMemoryMarkdown(memory: SyntheticMemory): string {
  const lines = [
    "---",
    `name: ${yamlValue(memory.name)}`,
    `description: ${yamlValue(memory.description)}`,
    `type: ${yamlValue(memory.type)}`,
  ];

  if (memory.class) lines.push(`class: ${yamlValue(memory.class)}`);
  if (memory.scope) lines.push(`scope: ${yamlValue(memory.scope)}`);
  if (memory.status) lines.push(`status: ${yamlValue(memory.status)}`);
  if (memory.summary) lines.push(`summary: ${yamlValue(memory.summary)}`);
  if (memory.fingerprint) lines.push(`fingerprint: ${yamlValue(memory.fingerprint)}`);
  if (memory.pinned !== undefined) lines.push(`pinned: ${memory.pinned ? "true" : "false"}`);
  if (memory.relatedFiles?.length) {
    lines.push(`relatedFiles: ${yamlValue(JSON.stringify(memory.relatedFiles))}`);
  }
  if (memory.relatedSymbols?.length) {
    lines.push(`relatedSymbols: ${yamlValue(JSON.stringify(memory.relatedSymbols))}`);
  }
  if (memory.confidence !== undefined) lines.push(`confidence: ${memory.confidence.toFixed(3)}`);
  if (memory.reason) lines.push(`reason: ${yamlValue(memory.reason)}`);

  lines.push("---", "", memory.content, "");
  return lines.join("\n");
}

function yamlValue(value: string): string {
  return JSON.stringify(value);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function countBy<T extends string>(
  values: Memory[],
  selector: (value: Memory) => T
): Record<T, number> {
  return values.reduce(
    (acc, value) => {
      const key = selector(value);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    },
    {} as Record<T, number>
  );
}
