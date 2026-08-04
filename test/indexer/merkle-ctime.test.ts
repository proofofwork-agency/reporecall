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

/**
 * Write a file and backdate it past MerkleTree's mtime trust window.
 *
 * MerkleTree deliberately refuses to trust the mtime of a file it hashed moments
 * after that file was written, because coarse filesystem timestamps let a second
 * write share the same mtime. Every test below is about what the *timestamp
 * pre-filter* does, so each one has to get past that refusal first — otherwise
 * the pre-filter is never consulted and the test passes without exercising the
 * thing it names.
 */
function writeSettledFile(dir: string, name: string, content: string): string {
  const absPath = writeFile(dir, name, content);
  const settled = new Date(Date.now() - 60_000);
  utimesSync(absPath, settled, settled);
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
    const absA = writeSettledFile(projectDir, "checkout.ts", "export const v = 1;");
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
    const absA = writeSettledFile(projectDir, "sized.ts", "const a = 1;\n");
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
    const absA = writeSettledFile(projectDir, "stable.ts", "const stable = true;");
    const files = [{ relativePath: "stable.ts", absolutePath: absA }];

    const first = await merkle.computeChanges(files);
    merkle.applyPendingState(first.pendingState);

    const { changes } = await merkle.computeChanges(files);
    expect(changes).toHaveLength(0);
  });

  // regression: a length-preserving second write inside one filesystem timestamp
  // step is invisible to mtime, to size, and — on Windows, where ctime is the
  // creation time — to ctime as well. The only defence is refusing to trust the
  // timestamp of a file that was written moments before we hashed it, so these
  // two pin that decision directly rather than through a race.
  it("records a just-written file as timestamp-untrusted so the next scan re-hashes it", async () => {
    const merkle = new MerkleTree(dataDir);
    const absA = writeFile(projectDir, "fresh.ts", "const fresh = 1;");

    const first = await merkle.computeChanges([{ relativePath: "fresh.ts", absolutePath: absA }]);

    const entry = first.pendingState["fresh.ts"] as { mtimeMs: number };
    expect(entry.mtimeMs).toBe(0);
  });

  it("records the real mtime once the file is older than the trust window", async () => {
    const merkle = new MerkleTree(dataDir);
    const absA = writeSettledFile(projectDir, "settled.ts", "const settled = 1;");
    const settledMtime = statSync(absA).mtimeMs;

    const first = await merkle.computeChanges([{ relativePath: "settled.ts", absolutePath: absA }]);

    const entry = first.pendingState["settled.ts"] as { mtimeMs: number };
    expect(entry.mtimeMs).toBe(settledMtime);
  });
});
