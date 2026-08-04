import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logWarnWithStack, toErrorMessage } from "../../src/core/errors.js";
import { isProcessAlive } from "../../src/core/platform.js";
import { detectProjectRoot, loadMemoryIgnore } from "../../src/core/project.js";
import { extractWikiLinks, resolveAllLinks } from "../../src/wiki/links.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("core utility contracts", () => {
  it("normalizes Error and non-Error values into messages", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom");
    expect(toErrorMessage({ code: "FAILED" })).toBe("[object Object]");
  });

  it("logs warning context and a debug stack without dropping fields", () => {
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
    };
    const error = new Error("failed");

    logWarnWithStack(logger as never, error, { operation: "index" }, "index failed");

    expect(logger.warn).toHaveBeenCalledWith(
      { err: error, operation: "index" },
      "index failed"
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ stack: error.stack, operation: "index" }),
      "index failed"
    );
  });

  it("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("detects a project root from a nested directory", () => {
    const root = makeTemporaryDirectory("reporecall-project-root-");
    const nested = join(root, "src", "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "package.json"), "{}\n");

    expect(detectProjectRoot(nested)).toBe(root);
  });

  it("loads memory-ignore entries while removing comments and blank lines", () => {
    const root = makeTemporaryDirectory("reporecall-memory-ignore-");
    writeFileSync(
      join(root, ".memoryignore"),
      "# generated\n\n dist/** \ncoverage/**\n"
    );

    expect(loadMemoryIgnore(root)).toEqual(["dist/**", "coverage/**"]);
    expect(loadMemoryIgnore(join(root, "missing"))).toEqual([]);
  });
});

describe("wiki link contracts", () => {
  it("extracts and deduplicates bracketed wiki links", () => {
    expect(extractWikiLinks("See [[auth-flow]], [[billing_2]], and [[auth-flow]]."))
      .toEqual(["auth-flow", "billing_2"]);
  });

  it("merges frontmatter and body links without duplicates", () => {
    expect(resolveAllLinks(["auth-flow", "manual"], "See [[auth-flow]] and [[routing]]."))
      .toEqual(["auth-flow", "manual", "routing"]);
  });
});
