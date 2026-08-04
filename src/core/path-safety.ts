import {
  lstatSync,
  realpathSync,
} from "fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "path";

export type ProjectPathMode = "existing" | "allow-missing";

export interface SafeProjectPath {
  /** Canonical, real path of the project root. */
  projectRoot: string;
  /** Canonical target path, including a normalized missing suffix when allowed. */
  absolutePath: string;
  /** Project-relative path using the current platform's separators. */
  relativePath: string;
  /** Whether the complete target existed when it was checked. */
  exists: boolean;
}

/**
 * Resolve a project root through the filesystem. A missing root is never a
 * usable security boundary, so callers get a normal filesystem error.
 */
export function canonicalizeProjectRoot(projectRoot: string): string {
  return realpathSync(resolve(projectRoot));
}

/**
 * Resolve a path against a canonical project boundary.
 *
 * Existing targets are checked through realpath, which blocks file and
 * directory symlink escapes. In allow-missing mode, the nearest existing
 * ancestor is resolved first and the missing suffix is then reattached. This
 * supports create/delete events without trusting a symlinked parent.
 *
 * Returns null for paths outside the boundary, missing paths in `existing`
 * mode, dangling symlinks, and paths whose nearest existing ancestor cannot be
 * resolved.
 */
export function resolveProjectPath(
  projectRoot: string,
  targetPath: string,
  mode: ProjectPathMode = "existing",
): SafeProjectPath | null {
  let canonicalRoot: string;
  try {
    canonicalRoot = canonicalizeProjectRoot(projectRoot);
  } catch {
    return null;
  }

  const candidate = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(canonicalRoot, targetPath);

  const resolvedTarget = resolveTarget(candidate, mode);
  if (!resolvedTarget) return null;
  if (!isContained(canonicalRoot, resolvedTarget.absolutePath)) return null;

  return {
    projectRoot: canonicalRoot,
    absolutePath: resolvedTarget.absolutePath,
    relativePath: relative(canonicalRoot, resolvedTarget.absolutePath),
    exists: resolvedTarget.exists,
  };
}

export function isProjectPathSafe(
  projectRoot: string,
  targetPath: string,
  mode: ProjectPathMode = "existing",
): boolean {
  return resolveProjectPath(projectRoot, targetPath, mode) !== null;
}

function resolveTarget(
  candidate: string,
  mode: ProjectPathMode,
): { absolutePath: string; exists: boolean } | null {
  try {
    return { absolutePath: realpathSync(candidate), exists: true };
  } catch {
    if (mode === "existing") return null;
  }

  const missingSegments: string[] = [];
  let ancestor = candidate;

  while (true) {
    try {
      // lstat deliberately treats a dangling symlink as existing. realpath
      // then fails below, rejecting it instead of treating it as a normal
      // missing directory.
      lstatSync(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      missingSegments.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }

  let canonicalAncestor: string;
  try {
    canonicalAncestor = realpathSync(ancestor);
  } catch {
    return null;
  }

  return {
    absolutePath: resolve(canonicalAncestor, ...missingSegments),
    exists: false,
  };
}

function isContained(projectRoot: string, targetPath: string): boolean {
  const rel = relative(projectRoot, targetPath);
  return (
    rel === ""
    || (
      rel !== ".."
      && !rel.startsWith(`..${sep}`)
      && !isAbsolute(rel)
    )
  );
}
