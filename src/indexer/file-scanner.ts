import { glob } from "glob";
import { readFileSync, existsSync, openSync, readSync, closeSync, realpathSync } from "fs";
import { stat } from "fs/promises";
import { resolve, sep } from "path";
import ignore from "ignore";
import type { MemoryConfig } from "../core/config.js";
import { loadMemoryIgnore } from "../core/project.js";

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
  // Resolve projectRoot to its real path to handle platform symlinks (e.g., macOS /var -> /private/var)
  let projectRoot: string;
  try {
    projectRoot = realpathSync(config.projectRoot);
  } catch {
    projectRoot = config.projectRoot;
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
    if (ig.ignores(match)) continue;

    const absolutePath = resolve(projectRoot, match);
    try {
      // Verify real path is within project root (prevents symlink escapes)
      const realPath = realpathSync(absolutePath);
      if (!realPath.startsWith(projectRoot + sep) && realPath !== projectRoot) continue;

      const fileStat = await stat(absolutePath);
      if (fileStat.size > maxFileSize) continue;
      if (fileStat.size === 0) continue;

      if (isBinaryFile(absolutePath)) continue;

      files.push({
        absolutePath: realPath,
        relativePath: match,
        size: fileStat.size,
      });
    } catch {
      // skip files we can't stat or resolve
    }
  }

  return files;
}
