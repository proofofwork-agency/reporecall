import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { banner, clearFreshnessCache, computeFreshness, resolveCurrentCommit } from "../../src/core/staleness.js";

interface MockMetadata {
  stats: { totalChunks: number };
  values: Record<string, string | undefined>;
  getStats(): { totalChunks: number };
  getStat(key: string): string | undefined;
}

function metadata(totalChunks: number, values: Record<string, string | undefined> = {}): MockMetadata {
  return {
    stats: { totalChunks },
    values,
    getStats() {
      return this.stats;
    },
    getStat(key: string) {
      return this.values[key];
    },
  };
}

function run(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function commit(projectRoot: string, name: string, content: string): string {
  writeFileSync(join(projectRoot, name), content);
  run(projectRoot, ["add", name]);
  run(projectRoot, ["-c", "user.name=Reporecall Test", "-c", "user.email=test@example.com", "commit", "-m", `commit ${name}`]);
  return resolveCurrentCommit(projectRoot) ?? "";
}

describe("index staleness", () => {
  let projectRoot: string;

  beforeEach(() => {
    clearFreshnessCache();
    projectRoot = mkdtempSync(join(tmpdir(), "reporecall-staleness-"));
  });

  afterEach(() => {
    clearFreshnessCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("reports empty when no chunks are indexed", () => {
    const freshness = computeFreshness(metadata(0, {
      lastIndexedAt: "2026-04-02T00:00:00.000Z",
      indexedCommit: "abc123",
    }), projectRoot, { ttlMs: 0 });

    expect(freshness.level).toBe("empty");
    expect(banner(freshness)).toContain("reporecall index EMPTY");
  });

  it("reports fresh when the indexed commit matches HEAD", () => {
    run(projectRoot, ["init"]);
    const head = commit(projectRoot, "a.ts", "export const a = 1;\n");

    const freshness = computeFreshness(metadata(1, {
      lastIndexedAt: "2026-04-02T00:00:00.000Z",
      indexedCommit: head,
    }), projectRoot, { ttlMs: 0 });

    expect(freshness.level).toBe("fresh");
    expect(freshness.currentCommit).toBe(head);
    expect(freshness.dirtyFiles).toBe(0);
    expect(banner(freshness)).toBeNull();
  });

  it("reports stale when HEAD has moved since indexing", () => {
    run(projectRoot, ["init"]);
    const indexedCommit = commit(projectRoot, "a.ts", "export const a = 1;\n");
    const currentCommit = commit(projectRoot, "b.ts", "export const b = 2;\n");

    const freshness = computeFreshness(metadata(2, {
      lastIndexedAt: "2026-04-02T00:00:00.000Z",
      indexedCommit,
    }), projectRoot, { ttlMs: 0 });

    expect(freshness.level).toBe("stale");
    expect(freshness.indexedCommit).toBe(indexedCommit);
    expect(freshness.currentCommit).toBe(currentCommit);
    expect(banner(freshness)).toContain("repo has moved");
  });

  it("ignores dirty files already covered by lastIndexedAt", () => {
    run(projectRoot, ["init"]);
    const head = commit(projectRoot, "a.ts", "export const a = 1;\n");
    const filePath = join(projectRoot, "a.ts");
    writeFileSync(filePath, "export const alreadyIndexed = true;\n");
    const indexedMtime = new Date("2026-04-02T00:00:00.000Z");
    utimesSync(filePath, indexedMtime, indexedMtime);

    const freshness = computeFreshness(metadata(1, {
      lastIndexedAt: "2026-04-03T00:00:00.000Z",
      indexedCommit: head,
    }), projectRoot, { ttlMs: 0 });

    expect(freshness.level).toBe("fresh");
    expect(freshness.dirtyFiles).toBe(0);
  });

  it("reports stale when tracked files are edited after the index", () => {
    run(projectRoot, ["init"]);
    const head = commit(projectRoot, "a.ts", "export const a = 1;\n");
    writeFileSync(join(projectRoot, "a.ts"), "export const a = 2;\n");

    const freshness = computeFreshness(metadata(1, {
      lastIndexedAt: "2000-01-01T00:00:00.000Z",
      indexedCommit: head,
    }), projectRoot, { ttlMs: 0 });

    expect(freshness.level).toBe("stale");
    expect(freshness.dirtyFiles).toBe(1);
    expect(banner(freshness)).toContain("1 file changed since last index");
  });

  it("reports stale when untracked files are created after the index", () => {
    run(projectRoot, ["init"]);
    const head = commit(projectRoot, "a.ts", "export const a = 1;\n");
    writeFileSync(join(projectRoot, "new.ts"), "export const next = 2;\n");

    const freshness = computeFreshness(metadata(1, {
      lastIndexedAt: "2000-01-01T00:00:00.000Z",
      indexedCommit: head,
    }), projectRoot, { ttlMs: 0 });

    expect(freshness.level).toBe("stale");
    expect(freshness.dirtyFiles).toBe(1);
  });

  it("reports stale when tracked files are deleted", () => {
    run(projectRoot, ["init"]);
    const head = commit(projectRoot, "a.ts", "export const a = 1;\n");
    unlinkSync(join(projectRoot, "a.ts"));

    const freshness = computeFreshness(metadata(1, {
      lastIndexedAt: new Date().toISOString(),
      indexedCommit: head,
    }), projectRoot, { ttlMs: 0 });

    expect(freshness.level).toBe("stale");
    expect(freshness.dirtyFiles).toBe(1);
  });

  it("fails soft in non-git directories", () => {
    const freshness = computeFreshness(metadata(1, {
      lastIndexedAt: "2026-04-02T00:00:00.000Z",
    }), projectRoot, { ttlMs: 0 });

    expect(freshness.level).toBe("fresh");
    expect(freshness.currentCommit).toBeNull();
    expect(freshness.dirtyFiles).toBeNull();
  });
});
