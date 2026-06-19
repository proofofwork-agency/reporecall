import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { MerkleTree } from "../../src/indexer/merkle.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "merkle-ctime-test-"));
}

function writeFile(dir: string, name: string, content: string): string {
  const absPath = resolve(dir, name);
  writeFileSync(absPath, content, "utf-8");
  return absPath;
}

describe("MerkleTree mtime+ctime cache fix", () => {
  let dataDir: string;
  let projectDir: string;

  beforeEach(() => {
    dataDir = makeTempDir();
    projectDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  // regression: Phase 0 — a content change must not be masked by an unchanged mtime
  it("detects a content change even when mtime is forcibly preserved (git-checkout / touch -r)", async () => {
    const merkle = new MerkleTree(dataDir);
    const absA = writeFile(projectDir, "checkout.ts", "export const v = 1;");
    const files = [{ relativePath: "checkout.ts", absolutePath: absA }];

    const first = await merkle.computeChanges(files);
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0].type).toBe("added");
    merkle.applyPendingState(first.pendingState);
    merkle.save();

    const beforeStat = statSync(absA);
    const preservedAtime = beforeStat.atimeMs;
    const preservedMtime = beforeStat.mtimeMs;

    // Rewrite content, then restore the original mtime/atime like `touch -r` / `git checkout`.
    writeFile(projectDir, "checkout.ts", "export const v = 999; // rewrote content");
    utimesSync(absA, new Date(preservedAtime), new Date(preservedMtime));

    const merkle2 = new MerkleTree(dataDir);
    const { changes } = await merkle2.computeChanges(files);

    const entry = changes.find((c) => c.path === "checkout.ts");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("modified");
  });

  it("detects a size-changing rewrite with mtime preserved via utimes", async () => {
    const merkle = new MerkleTree(dataDir);
    const absA = writeFile(projectDir, "sized.ts", "const a = 1;\n");
    const files = [{ relativePath: "sized.ts", absolutePath: absA }];

    const first = await merkle.computeChanges(files);
    expect(first.changes[0].type).toBe("added");
    merkle.applyPendingState(first.pendingState);

    const beforeStat = statSync(absA);
    const preservedAtime = beforeStat.atimeMs;
    const preservedMtime = beforeStat.mtimeMs;

    writeFile(projectDir, "sized.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    utimesSync(absA, new Date(preservedAtime), new Date(preservedMtime));

    const { changes } = await merkle.computeChanges(files);
    const entry = changes.find((c) => c.path === "sized.ts");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("modified");
  });

  it("still skips a genuinely unchanged file (mtime + ctime both stable)", async () => {
    const merkle = new MerkleTree(dataDir);
    const absA = writeFile(projectDir, "stable.ts", "const stable = true;");
    const files = [{ relativePath: "stable.ts", absolutePath: absA }];

    const first = await merkle.computeChanges(files);
    merkle.applyPendingState(first.pendingState);

    const { changes } = await merkle.computeChanges(files);
    expect(changes).toHaveLength(0);
  });
});
