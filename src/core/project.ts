import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export function detectProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    if (
      existsSync(resolve(dir, "package.json")) ||
      existsSync(resolve(dir, ".git")) ||
      existsSync(resolve(dir, "Cargo.toml")) ||
      existsSync(resolve(dir, "go.mod")) ||
      existsSync(resolve(dir, "pyproject.toml"))
    ) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return startDir;
    dir = parent;
  }
}

export function loadMemoryIgnore(projectRoot: string): string[] {
  const ignorePath = resolve(projectRoot, ".memoryignore");
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
