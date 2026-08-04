import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalizeProjectRoot,
  isProjectPathSafe,
  resolveProjectPath,
  toPosixPath,
} from "../../src/core/path-safety.js";

describe("project path safety", () => {
  let sandbox: string;
  let projectRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "reporecall-path-safety-"));
    projectRoot = join(sandbox, "project");
    outsideRoot = join(sandbox, "project-prefix-collision");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(join(projectRoot, "src", "inside.ts"), "export const inside = true;\n");
    writeFileSync(join(outsideRoot, "outside.ts"), "export const outside = true;\n");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("accepts existing relative and absolute targets", () => {
    const relativeResult = resolveProjectPath(projectRoot, "src/inside.ts");
    const absoluteResult = resolveProjectPath(
      projectRoot,
      join(projectRoot, "src", "inside.ts"),
    );

    expect(relativeResult?.relativePath).toBe(join("src", "inside.ts"));
    expect(relativeResult?.exists).toBe(true);
    expect(absoluteResult).toEqual(relativeResult);
  });

  it("accepts the project root itself", () => {
    const result = resolveProjectPath(projectRoot, ".");
    expect(result?.absolutePath).toBe(canonicalizeProjectRoot(projectRoot));
    expect(result?.relativePath).toBe("");
  });

  it("blocks traversal and prefix-collision paths", () => {
    expect(resolveProjectPath(projectRoot, "../project-prefix-collision/outside.ts")).toBeNull();
    expect(resolveProjectPath(projectRoot, join(outsideRoot, "outside.ts"))).toBeNull();
    expect(isProjectPathSafe(projectRoot, "../project-prefix-collision/outside.ts")).toBe(false);
  });

  it("canonicalizes a symlinked project root", () => {
    const linkedRoot = join(sandbox, "linked-project");
    symlinkSync(projectRoot, linkedRoot, "dir");

    const result = resolveProjectPath(linkedRoot, "src/inside.ts");
    expect(result?.projectRoot).toBe(canonicalizeProjectRoot(projectRoot));
    expect(result?.relativePath).toBe(join("src", "inside.ts"));
  });

  it("allows symlinks that resolve to an in-root target", () => {
    symlinkSync(
      join(projectRoot, "src", "inside.ts"),
      join(projectRoot, "src", "alias.ts"),
      "file",
    );

    const result = resolveProjectPath(projectRoot, "src/alias.ts");
    expect(result?.absolutePath).toBe(join(canonicalizeProjectRoot(projectRoot), "src", "inside.ts"));
    expect(result?.relativePath).toBe(join("src", "inside.ts"));
  });

  it("blocks file and directory symlinks that escape", () => {
    symlinkSync(
      join(outsideRoot, "outside.ts"),
      join(projectRoot, "src", "outside-alias.ts"),
      "file",
    );
    symlinkSync(outsideRoot, join(projectRoot, "escaped-dir"), "dir");

    expect(resolveProjectPath(projectRoot, "src/outside-alias.ts")).toBeNull();
    expect(resolveProjectPath(projectRoot, "escaped-dir/outside.ts")).toBeNull();
  });

  it("allows missing descendants only in allow-missing mode", () => {
    const target = join("src", "generated", "nested", "new.ts");
    expect(resolveProjectPath(projectRoot, target, "existing")).toBeNull();

    const result = resolveProjectPath(projectRoot, target, "allow-missing");
    expect(result?.exists).toBe(false);
    expect(result?.relativePath).toBe(target);
    expect(result?.absolutePath).toBe(resolve(canonicalizeProjectRoot(projectRoot), target));
  });

  it("canonicalizes the nearest existing ancestor for missing descendants", () => {
    mkdirSync(join(projectRoot, "real-parent"), { recursive: true });
    symlinkSync(join(projectRoot, "real-parent"), join(projectRoot, "linked-parent"), "dir");

    const result = resolveProjectPath(
      projectRoot,
      join("linked-parent", "future", "new.ts"),
      "allow-missing",
    );
    expect(result?.relativePath).toBe(join("real-parent", "future", "new.ts"));
  });

  it("blocks missing descendants beneath an escaping symlink", () => {
    symlinkSync(outsideRoot, join(projectRoot, "escaped-parent"), "dir");

    expect(
      resolveProjectPath(
        projectRoot,
        join("escaped-parent", "future", "new.ts"),
        "allow-missing",
      ),
    ).toBeNull();
  });

  it("rejects dangling symlinks in both modes", () => {
    const dangling = join(projectRoot, "dangling");
    symlinkSync(join(outsideRoot, "missing"), dangling, "dir");

    expect(resolveProjectPath(projectRoot, dangling, "existing")).toBeNull();
    expect(resolveProjectPath(projectRoot, join(dangling, "new.ts"), "allow-missing")).toBeNull();
  });

  it("supports allow-missing deletion paths without false rejection", () => {
    const deletedPath = join(projectRoot, "src", "deleted.ts");
    const result = resolveProjectPath(projectRoot, deletedPath, "allow-missing");

    expect(result?.relativePath).toBe(relative(projectRoot, deletedPath));
    expect(result?.exists).toBe(false);
  });

  it("rejects paths when the project root is missing", () => {
    const missingRoot = join(sandbox, "missing-root");
    expect(resolveProjectPath(missingRoot, "src/new.ts", "allow-missing")).toBeNull();
    expect(isProjectPathSafe(missingRoot, "src/new.ts", "allow-missing")).toBe(false);
  });

  it("exposes a portable relative path alongside the platform one", () => {
    const nested = join(projectRoot, "src", "nested.ts");
    writeFileSync(nested, "export const nested = 1;\n");

    const result = resolveProjectPath(projectRoot, nested, "existing");

    // Identity form: never carries a platform separator, on any host.
    expect(result?.posixRelativePath).toBe("src/nested.ts");
    expect(result?.posixRelativePath).not.toContain("\\");
  });

  describe("toPosixPath", () => {
    // The separator is injected so both branches are covered on either host.
    it("rewrites separators when the platform uses backslashes", () => {
      expect(toPosixPath("lib\\util\\helper.ts", "\\")).toBe("lib/util/helper.ts");
    });

    it("leaves values untouched when the platform uses forward slashes", () => {
      // On POSIX a backslash is a legal filename character, so rewriting it
      // would merge two genuinely distinct files.
      expect(toPosixPath("lib/util/helper.ts", "/")).toBe("lib/util/helper.ts");
      expect(toPosixPath("odd\\name.ts", "/")).toBe("odd\\name.ts");
    });
  });
});
