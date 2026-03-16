import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanFiles } from "../../src/indexer/file-scanner.js";
import type { MemoryConfig } from "../../src/core/config.js";

function makeConfig(
  projectRoot: string,
  overrides?: Partial<MemoryConfig>
): MemoryConfig {
  return {
    projectRoot,
    dataDir: join(projectRoot, ".memory"),
    embeddingProvider: "keyword",
    embeddingModel: "",
    embeddingDimensions: 0,
    ollamaUrl: "",
    extensions: [".ts", ".js"],
    ignorePatterns: ["node_modules", ".git", ".memory"],
    maxFileSize: 100 * 1024,
    batchSize: 32,
    contextBudget: 4000,
    maxContextChunks: 0,
    sessionBudget: 2000,
    searchWeights: { vector: 0.5, keyword: 0.3, recency: 0.2 },
    rrfK: 60,
    graphExpansion: false,
    graphDiscountFactor: 0.6,
    siblingExpansion: false,
    siblingDiscountFactor: 0.4,
    reranking: false,
    rerankingModel: "",
    rerankTopK: 25,
    codeBoostFactor: 1.5,
    testPenaltyFactor: 0.3,
    anonymousPenaltyFactor: 0.5,
    debounceMs: 2000,
    port: 37222,
    implementationPaths: ["src/"],
    factExtractors: [],
    ...overrides,
  };
}

describe("file-scanner — empty repository", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-scanner-empty-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array when the directory has no matching files", async () => {
    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toEqual([]);
  });

  it("returns an empty array when only non-matching extensions exist", async () => {
    writeFileSync(join(tmpDir, "README.md"), "# hello");
    writeFileSync(join(tmpDir, "data.json"), "{}");
    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toEqual([]);
  });
});

describe("file-scanner — binary file detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-scanner-binary-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("excludes a .ts file that contains a null byte", async () => {
    // Embed a null byte in otherwise text-like content
    const binaryContent = Buffer.concat([
      Buffer.from("export function foo() {"),
      Buffer.from([0x00]),
      Buffer.from("}"),
    ]);
    writeFileSync(join(tmpDir, "binary.ts"), binaryContent);

    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toEqual([]);
  });

  it("includes a .ts file that has no null bytes", async () => {
    writeFileSync(
      join(tmpDir, "normal.ts"),
      "export function greet(name: string): string { return name; }\n"
    );

    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("normal.ts");
  });

  it("excludes binary but keeps a sibling text file", async () => {
    const binaryContent = Buffer.concat([
      Buffer.from("data"),
      Buffer.from([0x00, 0x01, 0x02]),
    ]);
    writeFileSync(join(tmpDir, "asset.ts"), binaryContent);
    writeFileSync(join(tmpDir, "utils.ts"), "export const x = 1;\n");

    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("utils.ts");
  });
});

describe("file-scanner — symlink handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-scanner-symlink-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "completes without hanging when a circular directory symlink exists",
    async () => {
      // Create a real file so we can verify the scan returns normally
      writeFileSync(join(tmpDir, "index.ts"), "export const v = 1;\n");

      // Create a circular symlink: loop -> tmpDir (the project root itself)
      try {
        symlinkSync(tmpDir, join(tmpDir, "loop"), "dir");
      } catch {
        // If symlink creation fails (e.g., restricted environment), skip the
        // circular-loop part but still assert the scan completes.
      }

      const files = await scanFiles(makeConfig(tmpDir));

      // The scanner uses follow:false so symlinked dirs are not traversed.
      // index.ts must still be found; loop/ must not cause the process to hang.
      const relPaths = files.map((f) => f.relativePath);
      expect(relPaths).toContain("index.ts");
      // Symlinked entries should not appear in results
      expect(relPaths.every((p) => !p.startsWith("loop"))).toBe(true);
    },
    // Generous ceiling — if follow:false were broken the test would hang, so
    // the timeout acts as a safety net that converts a hang into a failure.
    10_000
  );

  it("does not follow a symlink pointing to a real file outside the project", async () => {
    // Point a .ts symlink at an actual file in a sibling temp directory
    const otherDir = mkdtempSync(join(tmpdir(), "mem-scanner-other-"));
    try {
      writeFileSync(join(otherDir, "external.ts"), "export const y = 2;\n");
      writeFileSync(join(tmpDir, "local.ts"), "export const x = 1;\n");

      try {
        symlinkSync(
          join(otherDir, "external.ts"),
          join(tmpDir, "linked.ts"),
          "file"
        );
      } catch {
        // Symlink creation may be restricted; proceed with just local.ts
      }

      const files = await scanFiles(makeConfig(tmpDir));
      // Symlinks pointing outside the project root are excluded by realpath check
      const relPaths = files.map((f) => f.relativePath);
      expect(relPaths).toContain("local.ts");
      expect(relPaths).not.toContain("linked.ts");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("file-scanner — size limit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-scanner-size-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips a file whose size exceeds maxFileSize", async () => {
    // maxFileSize = 50 bytes; write a file larger than that
    const largeContent = "x".repeat(100);
    writeFileSync(join(tmpDir, "big.ts"), largeContent);

    const files = await scanFiles(makeConfig(tmpDir, { maxFileSize: 50 }));
    expect(files).toEqual([]);
  });

  it("includes a file whose size is exactly at the limit", async () => {
    // 20 bytes of content; limit is 20 bytes (size must be <= maxFileSize, not <)
    const content = "export const x = 1;\n"; // exactly 20 bytes
    expect(Buffer.byteLength(content)).toBe(20);
    writeFileSync(join(tmpDir, "exact.ts"), content);

    // Limit set to the exact file size — scanner condition is size > maxFileSize,
    // so a file equal to the limit should be included.
    const files = await scanFiles(
      makeConfig(tmpDir, { maxFileSize: Buffer.byteLength(content) })
    );
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("exact.ts");
  });

  it("includes small files and excludes oversized ones from the same scan", async () => {
    const smallContent = "export const a = 1;\n"; // 20 bytes
    const bigContent = "z".repeat(200);

    writeFileSync(join(tmpDir, "small.ts"), smallContent);
    writeFileSync(join(tmpDir, "large.ts"), bigContent);

    const files = await scanFiles(makeConfig(tmpDir, { maxFileSize: 100 }));
    const relPaths = files.map((f) => f.relativePath);

    expect(relPaths).toContain("small.ts");
    expect(relPaths).not.toContain("large.ts");
  });
});

describe("file-scanner — empty files", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-scanner-empty-file-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips a zero-byte .ts file", async () => {
    writeFileSync(join(tmpDir, "empty.ts"), "");

    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toEqual([]);
  });

  it("skips zero-byte files but includes non-empty sibling", async () => {
    writeFileSync(join(tmpDir, "empty.ts"), "");
    writeFileSync(join(tmpDir, "nonempty.ts"), "export const z = 3;\n");

    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("nonempty.ts");
  });

  it("skips all files in a directory of only empty files", async () => {
    writeFileSync(join(tmpDir, "a.ts"), "");
    writeFileSync(join(tmpDir, "b.js"), "");
    writeFileSync(join(tmpDir, "c.ts"), "");

    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toEqual([]);
  });
});

describe("file-scanner — ignore patterns", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-scanner-ignore-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("respects ignorePatterns from config", async () => {
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFileSync(
      join(tmpDir, "node_modules", "lib.ts"),
      "export const n = 1;\n"
    );
    writeFileSync(join(tmpDir, "index.ts"), "export const i = 2;\n");

    const files = await scanFiles(makeConfig(tmpDir));
    const relPaths = files.map((f) => f.relativePath);

    expect(relPaths).toContain("index.ts");
    expect(relPaths.some((p) => p.startsWith("node_modules"))).toBe(false);
  });

  it("respects .gitignore when present", async () => {
    writeFileSync(join(tmpDir, ".gitignore"), "dist/\n");
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFileSync(join(tmpDir, "dist", "bundle.ts"), "export const b = 1;\n");
    writeFileSync(join(tmpDir, "src.ts"), "export const s = 1;\n");

    const files = await scanFiles(makeConfig(tmpDir));
    const relPaths = files.map((f) => f.relativePath);

    expect(relPaths).toContain("src.ts");
    expect(relPaths.some((p) => p.startsWith("dist"))).toBe(false);
  });

  it("respects .memoryignore when present", async () => {
    writeFileSync(join(tmpDir, ".memoryignore"), "generated/\n");
    mkdirSync(join(tmpDir, "generated"), { recursive: true });
    writeFileSync(
      join(tmpDir, "generated", "schema.ts"),
      "export const g = 1;\n"
    );
    writeFileSync(join(tmpDir, "app.ts"), "export const a = 1;\n");

    const files = await scanFiles(makeConfig(tmpDir));
    const relPaths = files.map((f) => f.relativePath);

    expect(relPaths).toContain("app.ts");
    expect(relPaths.some((p) => p.startsWith("generated"))).toBe(false);
  });
});

describe("file-scanner — ScannedFile shape", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-scanner-shape-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns correct absolutePath, relativePath, and size for a found file", async () => {
    const content = "export const hello = 'world';\n";
    writeFileSync(join(tmpDir, "hello.ts"), content);

    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toHaveLength(1);

    const file = files[0];
    expect(file.absolutePath).toBe(join(realpathSync(tmpDir), "hello.ts"));
    expect(file.relativePath).toBe("hello.ts");
    expect(file.size).toBe(Buffer.byteLength(content));
  });

  it("returns relative paths for nested files", async () => {
    mkdirSync(join(tmpDir, "lib", "util"), { recursive: true });
    writeFileSync(
      join(tmpDir, "lib", "util", "helper.ts"),
      "export const h = 1;\n"
    );

    const files = await scanFiles(makeConfig(tmpDir));
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe("lib/util/helper.ts");
  });
});
