import { glob } from "glob";
import { readFileSync, existsSync, openSync, readSync, closeSync } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import ignore from "ignore";
import type { MemoryConfig } from "../core/config.js";
import { loadMemoryIgnore } from "../core/project.js";
import {
  canonicalizeProjectRoot,
  resolveProjectPath,
  toPosixPath,
} from "../core/path-safety.js";

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

const BINARY_CHECK_SIZE = 8192;

function isBinaryFile(absolutePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, "r");
    const buf = Buffer.alloc(BINARY_CHECK_SIZE);
    const bytesRead = readSync(fd, buf, 0, BINARY_CHECK_SIZE, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function scanFiles(config: MemoryConfig): Promise<ScannedFile[]> {
  const { extensions, ignorePatterns, maxFileSize } = config;
  let projectRoot: string;
  try {
    projectRoot = canonicalizeProjectRoot(config.projectRoot);
  } catch {
    return [];
  }

  // Build ignore filter
  const ig = ignore();

  // Load .gitignore
  const gitignorePath = resolve(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }

  // Load .memoryignore
  const memoryIgnorePatterns = loadMemoryIgnore(projectRoot);
  ig.add(memoryIgnorePatterns);

  // Add default ignore patterns
  ig.add(ignorePatterns);

  // Build glob pattern for extensions
  const extGlob =
    extensions.length === 1
      ? `**/*${extensions[0]}`
      : `**/*{${extensions.join(",")}}`;

  const matches = await glob(extGlob, {
    cwd: projectRoot,
    nodir: true,
    dot: false,
    follow: false,
  });

  const files: ScannedFile[] = [];
  for (const match of matches) {
    // `ignore` implements gitignore semantics and only understands forward
    // slashes, so a Windows separator makes every directory pattern
    // (`node_modules/**`) silently miss. Normalize before testing.
    if (ig.ignores(toPosixPath(match))) continue;

    const absolutePath = resolve(projectRoot, match);
    try {
      const safePath = resolveProjectPath(projectRoot, absolutePath, "existing");
      if (!safePath) continue;

      const fileStat = await stat(safePath.absolutePath);
      if (fileStat.size > maxFileSize) continue;
      if (fileStat.size === 0) continue;

      if (isBinaryFile(safePath.absolutePath)) continue;

      files.push({
        absolutePath: safePath.absolutePath,
        // Identity, not a filesystem argument: this value becomes the Merkle
        // state key and the chunk filePath, and is compared against
        // slash-separated paths from git, fixtures and queries. glob returns the
        // platform's separator, so take the portable form from the boundary.
        relativePath: safePath.posixRelativePath,
        size: fileStat.size,
      });
    } catch {
      // skip files we can't stat or resolve
    }
  }

  return files;
}
