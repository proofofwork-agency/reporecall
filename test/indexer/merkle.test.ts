import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { MerkleTree } from "../../src/indexer/merkle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory that is cleaned up after each test. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "merkle-test-"));
}

/** Write a text file and return its absolute path. */
function writeFile(dir: string, name: string, content: string): string {
  const absPath = resolve(dir, name);
  writeFileSync(absPath, content, "utf-8");
  return absPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MerkleTree", () => {
  let dataDir: string;
  let projectDir: string;
  let merkle: MerkleTree;

  beforeEach(() => {
    dataDir = makeTempDir();
    projectDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Fresh merkle tree — all files are detected as "added"
  // -------------------------------------------------------------------------
  describe("fresh tree (no prior state)", () => {
    it("reports every file as added when no prior state exists", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "export const a = 1;");
      const absB = writeFile(projectDir, "b.ts", "export const b = 2;");

      const { changes } = await merkle.computeChanges([
        { relativePath: "a.ts", absolutePath: absA },
        { relativePath: "b.ts", absolutePath: absB },
      ]);

      expect(changes).toHaveLength(2);

      const types = changes.map((c) => c.type);
      expect(types).toContain("added");
      expect(types.every((t) => t === "added")).toBe(true);
    });

    it("includes the content hash on each added change", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "main.ts", "const x = 42;");

      const { changes } = await merkle.computeChanges([
        { relativePath: "main.ts", absolutePath: absA },
      ]);

      expect(changes[0].hash).toBeDefined();
      expect(typeof changes[0].hash).toBe("string");
      expect(changes[0].hash!.length).toBeGreaterThan(0);
    });

    it("populates pendingState with all added files", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");

      const { pendingState } = await merkle.computeChanges([
        { relativePath: "a.ts", absolutePath: absA },
      ]);

      expect(pendingState["a.ts"]).toBeDefined();
    });

    it("returns an empty changes list when given no files", async () => {
      merkle = new MerkleTree(dataDir);

      const { changes, pendingState } = await merkle.computeChanges([]);

      expect(changes).toHaveLength(0);
      expect(Object.keys(pendingState)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: No changes — computing changes with the same files returns empty
  // -------------------------------------------------------------------------
  describe("second run with identical files", () => {
    it("returns zero changes after state has been applied and saved", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "export const a = 1;");
      const files = [{ relativePath: "a.ts", absolutePath: absA }];

      // First run — record state
      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);
      merkle.save();

      // Reload from disk to simulate a new process
      const merkle2 = new MerkleTree(dataDir);
      const { changes } = await merkle2.computeChanges(files);

      expect(changes).toHaveLength(0);
    });

    it("returns zero changes in the same instance after applyPendingState", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "unchanged.ts", "const x = 0;");
      const files = [{ relativePath: "unchanged.ts", absolutePath: absA }];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);

      // Second computeChanges in the same instance (no save, no reload)
      const { changes } = await merkle.computeChanges(files);
      expect(changes).toHaveLength(0);
    });

    it("persists hashes correctly across multiple files", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");
      const absB = writeFile(projectDir, "b.ts", "const b = 2;");
      const absC = writeFile(projectDir, "c.ts", "const c = 3;");

      const files = [
        { relativePath: "a.ts", absolutePath: absA },
        { relativePath: "b.ts", absolutePath: absB },
        { relativePath: "c.ts", absolutePath: absC },
      ];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);
      merkle.save();

      const merkle2 = new MerkleTree(dataDir);
      const { changes } = await merkle2.computeChanges(files);
      expect(changes).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: File modification — changing content is detected as "modified"
  // -------------------------------------------------------------------------
  describe("modified file detection", () => {
    it("reports a file as modified when its content changes", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "service.ts", "export const v = 1;");
      const files = [{ relativePath: "service.ts", absolutePath: absA }];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);
      merkle.save();

      // Overwrite the file with different content
      writeFile(projectDir, "service.ts", "export const v = 99; // changed");

      const merkle2 = new MerkleTree(dataDir);
      const { changes } = await merkle2.computeChanges(files);

      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("modified");
      expect(changes[0].path).toBe("service.ts");
    });

    it("includes a new hash on the modified change", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "mod.ts", "const x = 1;");
      const files = [{ relativePath: "mod.ts", absolutePath: absA }];

      const first = await merkle.computeChanges(files);
      const originalHash = first.changes[0].hash!;
      merkle.applyPendingState(first.pendingState);

      writeFile(projectDir, "mod.ts", "const x = 2;");

      const { changes } = await merkle.computeChanges(files);
      expect(changes[0].type).toBe("modified");
      expect(changes[0].hash).toBeDefined();
      expect(changes[0].hash).not.toBe(originalHash);
    });

    it("only marks the changed file as modified, leaving others unchanged", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");
      const absB = writeFile(projectDir, "b.ts", "const b = 2;");
      const files = [
        { relativePath: "a.ts", absolutePath: absA },
        { relativePath: "b.ts", absolutePath: absB },
      ];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);

      writeFile(projectDir, "b.ts", "const b = 999;");

      const { changes } = await merkle.computeChanges(files);
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe("b.ts");
      expect(changes[0].type).toBe("modified");
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: File deletion — removed files are detected as "deleted"
  // -------------------------------------------------------------------------
  describe("deleted file detection", () => {
    it("reports a file as deleted when it is absent from the next scan", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "present.ts", "const p = 1;");
      const absB = writeFile(projectDir, "gone.ts", "const g = 2;");

      const allFiles = [
        { relativePath: "present.ts", absolutePath: absA },
        { relativePath: "gone.ts", absolutePath: absB },
      ];

      const first = await merkle.computeChanges(allFiles);
      merkle.applyPendingState(first.pendingState);
      merkle.save();

      // Next scan omits "gone.ts"
      const remainingFiles = [
        { relativePath: "present.ts", absolutePath: absA },
      ];

      const merkle2 = new MerkleTree(dataDir);
      const { changes } = await merkle2.computeChanges(remainingFiles);

      const deleted = changes.filter((c) => c.type === "deleted");
      expect(deleted).toHaveLength(1);
      expect(deleted[0].path).toBe("gone.ts");
    });

    it("does not include a hash on deleted changes", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");
      const files = [{ relativePath: "a.ts", absolutePath: absA }];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);

      // Scan with empty list — file appears deleted
      const { changes } = await merkle.computeChanges([]);

      expect(changes[0].type).toBe("deleted");
      expect(changes[0].hash).toBeUndefined();
    });

    it("removes the deleted file from pendingState", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "temp.ts", "const t = 0;");
      const files = [{ relativePath: "temp.ts", absolutePath: absA }];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);

      const { pendingState } = await merkle.computeChanges([]);
      expect(pendingState["temp.ts"]).toBeUndefined();
    });

    it("can detect simultaneous additions and deletions in one pass", async () => {
      merkle = new MerkleTree(dataDir);

      const absOld = writeFile(projectDir, "old.ts", "const old = 1;");
      const first = await merkle.computeChanges([
        { relativePath: "old.ts", absolutePath: absOld },
      ]);
      merkle.applyPendingState(first.pendingState);

      const absNew = writeFile(projectDir, "new.ts", "const n = 2;");
      const { changes } = await merkle.computeChanges([
        { relativePath: "new.ts", absolutePath: absNew },
      ]);

      const added = changes.filter((c) => c.type === "added");
      const deleted = changes.filter((c) => c.type === "deleted");
      expect(added).toHaveLength(1);
      expect(added[0].path).toBe("new.ts");
      expect(deleted).toHaveLength(1);
      expect(deleted[0].path).toBe("old.ts");
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: removeFile — removes a single entry from in-memory state
  // -------------------------------------------------------------------------
  describe("removeFile", () => {
    it("causes the removed file to appear as added again on next computeChanges", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "tracked.ts", "const t = 1;");
      const files = [{ relativePath: "tracked.ts", absolutePath: absA }];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);

      // Remove from in-memory state
      merkle.removeFile("tracked.ts");

      const { changes } = await merkle.computeChanges(files);
      expect(changes).toHaveLength(1);
      expect(changes[0].type).toBe("added");
    });
  });

  // -------------------------------------------------------------------------
  // Test 6: updateHash — manually updating a file hash
  // -------------------------------------------------------------------------
  describe("updateHash", () => {
    it("records the file hash so subsequent computeChanges sees no change", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "updated.ts", "const u = 1;");

      await merkle.updateHash("updated.ts", absA);

      const { changes } = await merkle.computeChanges([
        { relativePath: "updated.ts", absolutePath: absA },
      ]);
      expect(changes).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 7: clear and save — clearing the merkle tree resets state
  // -------------------------------------------------------------------------
  describe("clear", () => {
    it("erases all in-memory state so every file appears as added again", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");
      const files = [{ relativePath: "a.ts", absolutePath: absA }];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);

      // Sanity check — no changes before clear
      const beforeClear = await merkle.computeChanges(files);
      expect(beforeClear.changes).toHaveLength(0);

      merkle.clear();

      // After clear every file should be "added" again
      const afterClear = await merkle.computeChanges(files);
      expect(afterClear.changes).toHaveLength(1);
      expect(afterClear.changes[0].type).toBe("added");
    });

    it("removes the persisted merkle.json file from disk", () => {
      merkle = new MerkleTree(dataDir);
      // save() writes the file; clear() should delete it
      merkle.save();

      const statePath = resolve(dataDir, "merkle.json");
      expect(existsSync(statePath)).toBe(true);

      merkle.clear();
      expect(existsSync(statePath)).toBe(false);
    });

    it("survives being cleared when no merkle.json exists yet", () => {
      merkle = new MerkleTree(dataDir);
      // clear() on a brand-new instance should not throw
      expect(() => merkle.clear()).not.toThrow();
    });

    it("reloads as empty after save then clear then reload", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");
      const files = [{ relativePath: "a.ts", absolutePath: absA }];

      const first = await merkle.computeChanges(files);
      merkle.applyPendingState(first.pendingState);
      merkle.save();
      merkle.clear();

      // A fresh instance should find no persisted state
      const merkle2 = new MerkleTree(dataDir);
      const { changes } = await merkle2.computeChanges(files);
      expect(changes[0].type).toBe("added");
    });
  });

  // -------------------------------------------------------------------------
  // Test 8: save / load round-trip
  // -------------------------------------------------------------------------
  describe("persistence (save and load)", () => {
    it("writes merkle.json to the data directory", async () => {
      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");
      const first = await merkle.computeChanges([
        { relativePath: "a.ts", absolutePath: absA },
      ]);
      merkle.applyPendingState(first.pendingState);
      merkle.save();

      const statePath = resolve(dataDir, "merkle.json");
      expect(existsSync(statePath)).toBe(true);
    });

    it("creates the data directory if it does not exist before saving", async () => {
      // Point to a nested path that does not yet exist
      const nested = resolve(dataDir, "deep", "nested");
      merkle = new MerkleTree(nested);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");
      const first = await merkle.computeChanges([
        { relativePath: "a.ts", absolutePath: absA },
      ]);
      merkle.applyPendingState(first.pendingState);

      // Should not throw even though the directory didn't exist
      expect(() => merkle.save()).not.toThrow();
      expect(existsSync(resolve(nested, "merkle.json"))).toBe(true);
    });

    it("recovers gracefully when merkle.json contains corrupt JSON", () => {
      // Write corrupt JSON before constructing the tree
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(resolve(dataDir, "merkle.json"), "{ not valid json {{{{", "utf-8");

      // Constructor must not throw; tree should start empty
      expect(() => {
        merkle = new MerkleTree(dataDir);
      }).not.toThrow();
    });

    it("treats a corrupt on-disk state as an empty tree (all files re-added)", async () => {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(resolve(dataDir, "merkle.json"), "CORRUPT", "utf-8");

      merkle = new MerkleTree(dataDir);

      const absA = writeFile(projectDir, "a.ts", "const a = 1;");
      const { changes } = await merkle.computeChanges([
        { relativePath: "a.ts", absolutePath: absA },
      ]);

      expect(changes[0].type).toBe("added");
    });
  });
});
