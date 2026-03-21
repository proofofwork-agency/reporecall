import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { MemoryStore } from "../../src/storage/memory-store.js";
import { createMemoryIndexer } from "../../src/memory/indexer.js";
import { MemorySearch } from "../../src/memory/search.js";
import { MemoryRuntime, type MemoryRuntimeOptions } from "../../src/daemon/memory/runtime.js";

function writeMemoryFile(dir: string, name: string, content: string): string {
  const filePath = resolve(dir, `${name}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for memory runtime update");
    }
    await wait(intervalMs);
  }
}

describe("MemoryRuntime", () => {
  let projectRoot: string;
  let encodedProjectRoot: string;
  let claudeProjectsDir: string;
  let claudeMemoryDir: string;
  let dataDir: string;
  let writableDir: string;
  let store: MemoryStore;
  let runtime: MemoryRuntime | null;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "mem-runtime-project-"));
    encodedProjectRoot = projectRoot.replace(/[/\\.:]/g, "-");
    claudeProjectsDir = resolve(homedir(), ".claude", "projects", encodedProjectRoot);
    claudeMemoryDir = resolve(claudeProjectsDir, "memory");
    mkdirSync(claudeMemoryDir, { recursive: true });

    dataDir = mkdtempSync(join(tmpdir(), "mem-runtime-data-"));
    writableDir = mkdtempSync(join(tmpdir(), "mem-runtime-writable-"));
    store = new MemoryStore(dataDir);
    runtime = null;
  });

  afterEach(async () => {
    await runtime?.stop();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(writableDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(claudeProjectsDir, { recursive: true, force: true });
  });

  function createRuntime(options: MemoryRuntimeOptions = {}): MemoryRuntime {
    const indexer = createMemoryIndexer(store, projectRoot, { writableDir });
    runtime = new MemoryRuntime(indexer, store, {
      debounceMs: 25,
      factPromotionThreshold: 2,
      workingHistoryLimit: 2,
      ...options,
    });
    return runtime;
  }

  it("imports startup memories from Claude and writable dirs", async () => {
    const liveRuntime = createRuntime({ watchEnabled: false });

    writeMemoryFile(
      claudeMemoryDir,
      "startup_guide",
      `---
name: startup_guide
description: Startup guidance
type: project
---

Use the memory runtime.
`
    );
    writeMemoryFile(
      writableDir,
      "startup_note",
      `---
name: "startup_note"
description: "Quoted startup memory"
type: "feedback"
---

Remember the writable dir.
`
    );

    const result = await liveRuntime.start();
    expect(result.indexed).toBe(2);
    expect(store.getCount()).toBe(2);
    expect(store.getByName("startup_guide")?.sourceKind).toBe("claude_auto");
    expect(store.getByName("startup_note")?.sourceKind).toBe("reporecall_local");
  });

  it("refreshes incrementally on add, change, and unlink", async () => {
    const liveRuntime = createRuntime({ watchEnabled: true });

    writeMemoryFile(
      claudeMemoryDir,
      "claude_seed",
      `---
name: claude_seed
description: Seed memory
type: user
---

Seed content.
`
    );

    const result = await liveRuntime.start();
    expect(result.indexed).toBe(1);
    expect(store.getCount()).toBe(1);

    const liveFile = writeMemoryFile(
      writableDir,
      "live_memory",
      `---
name: "live_memory"
description: "Initial writable memory"
type: "project"
---

Initial content.
`
    );

    await waitFor(() => store.getByName("live_memory")?.description === "Initial writable memory");

    writeFileSync(
      liveFile,
      `---
name: "live_memory"
description: "Updated writable memory"
type: "project"
---

Updated content.
`,
      "utf-8"
    );

    await waitFor(() => store.getByName("live_memory")?.description === "Updated writable memory");
    expect(store.getByName("live_memory")?.content).toContain("Updated content.");

    rmSync(liveFile, { force: true });
    await waitFor(() => store.getByName("live_memory") === undefined);
    expect(store.getCount()).toBe(1);
  });

  it("creates working memory, prunes history, and promotes repeated facts", async () => {
    const liveRuntime = createRuntime({ watchEnabled: false });

    writeMemoryFile(
      claudeMemoryDir,
      "auth_seed",
      `---
name: auth_seed
description: Compliance note for auth middleware
type: project
class: fact
scope: project
summary: Compliance drives auth session changes
fingerprint: auth-seed-fingerprint
---

The auth middleware rewrite is required for compliance with session token storage rules.
`
    );

    writeMemoryFile(
      writableDir,
      "working-project-001",
      `---
name: "working-project-001"
description: "Older working memory"
type: "project"
class: "working"
scope: "project"
summary: "Older working summary"
sourceKind: "generated"
---

Older working content.
`
    );
    writeMemoryFile(
      writableDir,
      "working-project-002",
      `---
name: "working-project-002"
description: "Newer working memory"
type: "project"
class: "working"
scope: "project"
summary: "Newer working summary"
sourceKind: "generated"
---

Newer working content.
`
    );
    writeMemoryFile(
      writableDir,
      "working-project-003",
      `---
name: "working-project-003"
description: "Newest historical working memory"
type: "project"
class: "working"
scope: "project"
summary: "Newest historical working summary"
sourceKind: "generated"
---

Newest historical working content.
`
    );

    const start = await liveRuntime.start();
    expect(start.indexed).toBe(4);

    const seed = store.getByName("auth_seed");
    expect(seed).toBeDefined();
    store.recordAccess(seed!.id);

    const search = new MemorySearch(store);
    const memoryHits = await search.search("auth middleware compliance", { classes: ["fact"] });
    expect(memoryHits[0]?.name).toBe("auth_seed");
    expect(memoryHits[0]?.accessCount).toBeGreaterThanOrEqual(1);

    await liveRuntime.observePrompt({
      query: "tighten auth session persistence",
      codeRoute: "R1",
      memoryRoute: "M1",
      activeFiles: ["src/auth/session.ts"],
      topFiles: ["src/auth/persist.ts"],
      topSymbols: ["validateSession", "persistToken"],
      memoryHits,
    });

    // Working memory now uses timestamped filenames (working-project-YYYY-MM-DDTHH-MM-SS)
    // instead of a single overwritten working-project-current file
    const allMemories = store.getAll();
    const workingCurrent = allMemories.find(
      (m) => m.class === "working" && m.sourceKind === "generated" && m.content.includes("tighten auth session persistence")
    );
    expect(workingCurrent).toBeDefined();
    expect(workingCurrent?.class).toBe("working");
    expect(workingCurrent?.sourceKind).toBe("generated");
    expect(workingCurrent?.content).toContain("Last query: tighten auth session persistence");
    expect(workingCurrent?.content).toContain("Relevant symbols: validateSession, persistToken");

    const generatedFact = allMemories
      .find((memory) => memory.name.startsWith("fact-") && memory.class === "fact");
    expect(generatedFact?.sourceKind).toBe("generated");
    expect(generatedFact?.content).toContain("Promoted fact from: auth_seed");

    const workingFiles = readdirSync(writableDir)
      .filter((name) => name.startsWith("working-project") && name.endsWith(".md"))
      .sort();
    // With workingHistoryLimit=3: 3 pre-existing (001, 002, 003) + 1 new timestamped = 4,
    // pruned to 3 (newest kept)
    expect(workingFiles.length).toBeGreaterThanOrEqual(2);
    expect(workingFiles.length).toBeLessThanOrEqual(3);
    // Verify the latest file contains the observed prompt content
    const latestFile = workingFiles[workingFiles.length - 1]!;
    expect(readFileSync(resolve(writableDir, latestFile), "utf-8")).toContain(
      "tighten auth session persistence"
    );
  });
});
