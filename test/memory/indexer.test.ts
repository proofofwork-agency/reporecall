import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { MemoryStore } from "../../src/storage/memory-store.js";
import { MemoryIndexer, createMemoryIndexer, discoverClaudeMemoryDir } from "../../src/memory/indexer.js";

function writeMemoryFile(dir: string, name: string, content: string): string {
  const filePath = resolve(dir, `${name}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("MemoryIndexer", () => {
  let dataDir: string;
  let memoryDir: string;
  let store: MemoryStore;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mem-idx-data-"));
    memoryDir = mkdtempSync(join(tmpdir(), "mem-idx-files-"));
    store = new MemoryStore(dataDir);
    indexer = new MemoryIndexer(store, [memoryDir]);
  });

  afterEach(async () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(memoryDir, { recursive: true, force: true });
  });

  it("indexes a valid memory file", async () => {
    writeMemoryFile(
      memoryDir,
      "feedback_testing",
      `---
name: feedback_testing
description: Use real DB in integration tests
type: feedback
---

Do not mock the database in tests.
`
    );

    const result = await indexer.indexAll();
    expect(result.indexed).toBe(1);
    expect(result.errors).toBe(0);

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("feedback_testing");
    expect(all[0]!.type).toBe("feedback");
  });

  it("skips files without valid frontmatter", async () => {
    writeMemoryFile(memoryDir, "invalid", "Just plain text, no frontmatter.");

    const result = await indexer.indexAll();
    expect(result.indexed).toBe(0);
    expect(store.getCount()).toBe(0);
  });

  it("skips MEMORY.md index file", async () => {
    writeMemoryFile(
      memoryDir,
      "MEMORY",
      `# Memory Index

- [feedback_testing.md](feedback_testing.md)
`
    );

    const result = await indexer.indexAll();
    expect(result.indexed).toBe(0);
  });

  it("removes stale memories whose files are deleted", async () => {
    const filePath = writeMemoryFile(
      memoryDir,
      "old_memory",
      `---
name: old_memory
description: This will be deleted
type: project
---

Old content.
`
    );

    await indexer.indexAll();
    expect(store.getCount()).toBe(1);

    // Delete the file
    rmSync(filePath);

    const result = await indexer.indexAll();
    expect(result.removed).toBe(1);
    expect(store.getCount()).toBe(0);
  });

  it("skips unchanged files on re-index", async () => {
    writeMemoryFile(
      memoryDir,
      "stable",
      `---
name: stable_memory
description: Does not change
type: user
---

Stable content.
`
    );

    const first = await indexer.indexAll();
    expect(first.indexed).toBe(1);

    // Re-index without changes
    const second = await indexer.indexAll();
    expect(second.indexed).toBe(0);
  });

  it("indexes multiple files from multiple directories", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "mem-idx-files2-"));

    writeMemoryFile(
      memoryDir,
      "mem1",
      `---
name: mem1
description: First memory
type: user
---

Content 1.
`
    );

    writeMemoryFile(
      dir2,
      "mem2",
      `---
name: mem2
description: Second memory
type: feedback
---

Content 2.
`
    );

    const multiIndexer = new MemoryIndexer(store, [memoryDir, dir2]);
    const result = await multiIndexer.indexAll();
    expect(result.indexed).toBe(2);
    expect(store.getCount()).toBe(2);

    rmSync(dir2, { recursive: true, force: true });
  });

  it("removes a memory by file path", async () => {
    const filePath = writeMemoryFile(
      memoryDir,
      "removable",
      `---
name: removable
description: Will be removed
type: reference
---

Remove me.
`
    );

    await indexer.indexAll();
    expect(store.getCount()).toBe(1);

    const removed = await indexer.removeByFilePath(filePath);
    expect(removed).toBe(true);
    expect(store.getCount()).toBe(0);
  });

  it("indexes writable and Claude import memory directories with metadata defaults", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mem-proj-"));
    const tempHome = mkdtempSync(join(tmpdir(), "mem-home-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    let dataDir = "";
    let localStore: MemoryStore | undefined;

    try {
      process.env.HOME = tempHome;
      process.env.USERPROFILE = tempHome;

      const claudeDir = resolve(
        tempHome,
        ".claude",
        "projects",
        projectRoot.replace(/[/\\.:]/g, "-"),
        "memory"
      );
      const writableDir = resolve(projectRoot, ".memory", "reporecall-memories");
      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(writableDir, { recursive: true });

      writeMemoryFile(
        claudeDir,
        "claude_memory",
        `---
name: claude_memory
description: Imported Claude memory
type: feedback
---

Imported content.
`
      );

      writeMemoryFile(
        writableDir,
        "local_memory",
        `---
name: local_memory
description: Local generated memory
type: project
---

Local content.
`
      );

      dataDir = mkdtempSync(join(tmpdir(), "mem-idx-data-writable-"));
      localStore = new MemoryStore(dataDir);
      const localIndexer = createMemoryIndexer(localStore, projectRoot);

      expect(discoverClaudeMemoryDir(projectRoot)).toBe(claudeDir);
      expect(localIndexer.getWritableDirs()).toContain(writableDir);

      const result = await localIndexer.indexAll();
      expect(result.indexed).toBe(2);

      const imported = localStore.getByName("claude_memory");
      const local = localStore.getByName("local_memory");
      expect(imported).not.toBeUndefined();
      expect(local).not.toBeUndefined();
      expect(imported!.sourceKind).toBe("claude_auto");
      expect(imported!.class).toBe("rule");
      expect(imported!.status).toBe("active");
      expect(local!.sourceKind).toBe("reporecall_local");
      expect(local!.class).toBe("fact");
      expect(local!.scope).toBe("project");

    } finally {
      localStore?.close();
      if (dataDir) {
        rmSync(dataDir, { recursive: true, force: true });
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
