/**
 * MemoryIndexer — scans Claude Code memory directories, parses .md files,
 * extracts tags, and stores them in MemoryStore with FTS5 indexing.
 *
 * Zero LLM cost: Claude already writes structured .md files with frontmatter.
 * We just parse, auto-tag, and index via FTS5.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from "fs";
import { resolve, extname, basename, sep } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { getLogger } from "../core/logger.js";
import { parseMemoryFile } from "./parser.js";
import type {
  Memory,
  MemoryClass,
  MemoryCompactionOptions,
  MemoryCompactionResult,
  MemoryScope,
  MemorySourceKind,
  MemoryType,
} from "./types.js";
import type { MemoryStore } from "../storage/memory-store.js";

/**
 * Discover the Claude Code memory directory for a project.
 *
 * Claude Code stores memories at:
 *   ~/.claude/projects/-{projectRoot-encoded}/memory/
 *
 * where the encoding replaces `/` with `-`.
 */
export function discoverClaudeMemoryDir(projectRoot: string): string | null {
  // Claude Code encodes paths by replacing all path separators, dots, and colons
  // with hyphens. This works cross-platform: the leading / on Unix becomes the
  // leading -, and Windows drive letters like C: become C-.
  const home = homedir();

  // Try the given path first, then the resolved realpath.
  // On macOS, /tmp → /private/tmp, so Claude Code may use either encoding.
  const candidates = [projectRoot];
  try {
    const real = realpathSync(projectRoot);
    if (real !== projectRoot) candidates.push(real);
  } catch { /* path may not exist yet */ }

  for (const root of candidates) {
    const encoded = root.replace(/[/\\.:]/g, "-");
    const memoryDir = resolve(home, ".claude", "projects", encoded, "memory");
    try {
      const stat = statSync(memoryDir);
      if (stat.isDirectory()) return memoryDir;
    } catch {
      // Directory doesn't exist
    }
  }

  return null;
}

/**
 * Generate a stable memory ID from the file path.
 */
function memoryId(filePath: string): string {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
}

/**
 * Scan a directory for .md memory files (non-recursive).
 * Skips MEMORY.md (the index file).
 */
function scanMemoryFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => {
        if (extname(f).toLowerCase() !== ".md") return false;
        if (f.toUpperCase() === "MEMORY.MD") return false;
        return true;
      })
      .map((f) => resolve(dir, f));
  } catch {
    return [];
  }
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((p) => resolve(p))));
}

function isPathInsideDir(filePath: string, dir: string): boolean {
  const absFilePath = resolve(filePath);
  const absDir = resolve(dir);
  return absFilePath === absDir || absFilePath.startsWith(absDir + sep);
}

function defaultClassForType(type: MemoryType): MemoryClass {
  switch (type) {
    case "feedback":
      return "rule";
    case "user":
      return "fact";
    case "project":
      return "fact";
    case "reference":
      return "fact";
  }
}

function defaultScopeForType(type: MemoryType): MemoryScope {
  switch (type) {
    case "feedback":
      return "global";
    case "user":
      return "global";
    case "project":
      return "project";
    case "reference":
      return "global";
  }
}

function inferSourceKind(filePath: string, readOnlyDirs: string[]): MemorySourceKind {
  for (const dir of readOnlyDirs) {
    if (isPathInsideDir(filePath, dir)) return "claude_auto";
  }
  return "reporecall_local";
}

function defaultConfidence(sourceKind: MemorySourceKind, memoryClass: MemoryClass): number {
  if (sourceKind === "claude_auto") return 0.8;
  if (memoryClass === "working") return 0.65;
  return 0.7;
}

function fingerprintForMemory(name: string, description: string, content: string): string {
  return createHash("sha256")
    .update(name)
    .update("\0")
    .update(description)
    .update("\0")
    .update(content)
    .digest("hex");
}

function compactSummary(name: string, description: string): string {
  return description.trim() || name.trim();
}

export interface MemoryIndexResult {
  indexed: number;
  removed: number;
  errors: number;
}

export interface MemoryIndexerOptions {
  projectRoot?: string;
  writableDirs?: string[];
  readOnlyDirs?: string[];
}

export interface CreateMemoryIndexerOptions {
  additionalDirs?: string[];
  writableDir?: string;
}

export class MemoryIndexer {
  private store: MemoryStore;
  private memoryDirs: string[];
  private writableDirs: string[];
  private readOnlyDirs: string[];

  constructor(
    store: MemoryStore,
    memoryDirs: string[],
    options: MemoryIndexerOptions = {}
  ) {
    this.store = store;
    this.memoryDirs = memoryDirs;
    this.writableDirs = dedupePaths(options.writableDirs ?? []);
    this.readOnlyDirs = dedupePaths(options.readOnlyDirs ?? []);
  }

  /**
   * Full scan: index all memory files, remove stale entries.
   */
  async indexAll(): Promise<MemoryIndexResult> {
    const log = getLogger();
    let indexed = 0;
    let removed = 0;
    let errors = 0;

    // Collect all current memory file paths
    const allFiles = new Set<string>();
    for (const dir of this.memoryDirs) {
      for (const filePath of scanMemoryFiles(dir)) {
        allFiles.add(filePath);
      }
    }

    // Index each file
    for (const filePath of allFiles) {
      try {
        const wasIndexed = await this.indexFile(filePath);
        if (wasIndexed) indexed++;
      } catch (err) {
        log.warn({ err, filePath }, "Failed to index memory file");
        errors++;
      }
    }

    // Remove stale entries (memories whose files no longer exist)
    const existingMemories = this.store.getAll();
    for (const memory of existingMemories) {
      if (!allFiles.has(memory.filePath)) {
        this.store.remove(memory.id);
        removed++;
        log.debug({ id: memory.id, name: memory.name }, "Removed stale memory");
      }
    }

    log.info({ indexed, removed, errors, total: allFiles.size }, "Memory indexing complete");
    return { indexed, removed, errors };
  }

  /**
   * Index a single memory file. Returns true if it was indexed/updated.
   * Skips if the file hasn't changed since last index.
   */
  async indexFile(filePath: string): Promise<boolean> {
    const log = getLogger();

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return false;
    }

    const id = memoryId(filePath);
    const fileMtime = stat.mtime.toISOString();

    // Check if already indexed with same mtime
    const existing = this.store.get(id);
    if (existing && existing.fileMtime === fileMtime) {
      return false;
    }

    // Read and parse
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseMemoryFile(raw);
    if (!parsed) {
      log.debug({ filePath }, "Skipping memory file — invalid frontmatter");
      return false;
    }

    const sourceKind = parsed.sourceKind ?? inferSourceKind(filePath, this.readOnlyDirs);
    const memoryClass = parsed.class ?? defaultClassForType(parsed.type);
    const scope = parsed.scope ?? defaultScopeForType(parsed.type);
    const status = parsed.status ?? "active";
    const summary = parsed.summary ?? compactSummary(parsed.name, parsed.description);
    const fingerprint = parsed.fingerprint ?? fingerprintForMemory(parsed.name, parsed.description, parsed.content);
    const pinned = parsed.pinned ?? false;
    const relatedFiles = parsed.relatedFiles ?? [];
    const relatedSymbols = parsed.relatedSymbols ?? [];
    const supersedesId = parsed.supersedesId ?? "";
    const confidence = parsed.confidence ?? defaultConfidence(sourceKind, memoryClass);
    const reason = parsed.reason ?? "";

    // Auto-generate tags from content for FTS enrichment
    const autoTags = extractTags(parsed.content, parsed.description, summary);

    const memory: Memory = {
      id,
      name: parsed.name,
      description: parsed.description,
      type: parsed.type,
      class: memoryClass,
      scope,
      status,
      summary,
      sourceKind,
      fingerprint,
      pinned,
      relatedFiles,
      relatedSymbols,
      supersedesId,
      confidence,
      reason,
      content: parsed.content,
      filePath,
      indexedAt: new Date().toISOString(),
      fileMtime,
      accessCount: existing?.accessCount ?? 0,
      lastAccessed: existing?.lastAccessed ?? "",
      importance: existing?.importance ?? 1.0,
      tags: autoTags,
    };

    // Store metadata + FTS (tags are indexed in FTS5 for broader recall)
    this.store.upsert(memory);

    log.debug(
      { id, name: parsed.name, type: parsed.type, updated: !!existing },
      existing ? "Updated memory" : "Indexed new memory"
    );
    return true;
  }

  /**
   * Remove a memory by its file path.
   */
  async removeByFilePath(filePath: string): Promise<boolean> {
    const id = memoryId(filePath);
    const existing = this.store.get(id);
    if (!existing) return false;

    this.store.remove(id);
    return true;
  }

  /**
   * Compact indexed memories using storage-layer primitives.
   */
  compact(options?: MemoryCompactionOptions): MemoryCompactionResult {
    return this.store.compact(options);
  }

  /**
   * Regenerate MEMORY.md index file in each memory directory.
   * Reads all memories from the store, sorted by importance desc,
   * and writes one-line links. Truncates to 190 entries to stay under 200 lines.
   */
  regenerateIndex(): void {
    const memories = this.store.getAll();
    // Sort by importance desc, then by name
    memories.sort((a, b) => (b.importance ?? 1.0) - (a.importance ?? 1.0) || a.name.localeCompare(b.name));

    const maxEntries = 190;

    const dirsToWrite = this.writableDirs.length > 0
      ? this.writableDirs
      : this.memoryDirs.filter((dir) => !this.readOnlyDirs.some((readOnlyDir) => isPathInsideDir(dir, readOnlyDir)));

    for (const dir of dirsToWrite) {
      try {
        // Only include memories that belong to this directory
        const dirMemories = memories.filter(
          (m) => m.filePath.startsWith(dir + sep)
        );
        const entries = dirMemories.slice(0, maxEntries);

        const lines: string[] = ["# Memory Index", ""];
        for (const mem of entries) {
          const filename = basename(mem.filePath);
          lines.push(`- [${filename}](${filename}) — ${mem.description}`);
        }
        lines.push(""); // trailing newline

        const indexPath = resolve(dir, "MEMORY.md");
        writeFileSync(indexPath, lines.join("\n"), "utf-8");
      } catch {
        // Non-fatal: directory may not exist
      }
    }
  }

  /**
   * Get all discovered memory directories.
   */
  getMemoryDirs(): string[] {
    return this.memoryDirs;
  }

  /**
   * Get writable memory directories for generated indexes.
   */
  getWritableDirs(): string[] {
    return this.writableDirs.length > 0 ? this.writableDirs : this.memoryDirs;
  }
}

/**
 * Create a MemoryIndexer with auto-discovered Claude memory directories.
 */
/**
 * Extract tags from memory content for FTS enrichment.
 *
 * Pulls out key terms that bridge the vocabulary gap between
 * how memories are written and how users query them.
 * E.g., a memory about "SOC2 audit" gets tagged with "security compliance".
 */
const TAG_PATTERNS: Array<{ pattern: RegExp; tags: string[] }> = [
  { pattern: /\bSOC\s*2\b/i, tags: ["security", "compliance", "audit"] },
  { pattern: /\bGDPR\b/i, tags: ["security", "compliance", "privacy"] },
  { pattern: /\bOWASP\b/i, tags: ["security", "vulnerability"] },
  { pattern: /\bJWT\b/i, tags: ["auth", "authentication", "token", "security"] },
  { pattern: /\bOAuth\b/i, tags: ["auth", "authentication", "security"] },
  { pattern: /\bbcrypt\b/i, tags: ["auth", "password", "security", "encryption"] },
  { pattern: /\bencrypt/i, tags: ["security", "encryption"] },
  { pattern: /\brate.?limit/i, tags: ["performance", "security", "throttle"] },
  { pattern: /\bmigration/i, tags: ["database", "schema"] },
  { pattern: /\bSQL\b/i, tags: ["database", "query"] },
  { pattern: /\bRedis\b/i, tags: ["database", "cache", "performance"] },
  { pattern: /\bpino\b/i, tags: ["logging", "observability"] },
  { pattern: /\bconsole\.log\b/i, tags: ["logging"] },
  { pattern: /\bCI\b|\bCD\b|\bpipeline\b/i, tags: ["deploy", "ci"] },
  { pattern: /\bdeploy/i, tags: ["deploy", "release"] },
  { pattern: /\bLinear\b/i, tags: ["tracking", "ticket", "issue"] },
  { pattern: /\bJira\b/i, tags: ["tracking", "ticket", "issue"] },
  { pattern: /\bGrafana\b/i, tags: ["monitoring", "observability", "dashboard"] },
  { pattern: /\blatency\b/i, tags: ["performance", "monitoring"] },
  { pattern: /\btest/i, tags: ["testing"] },
  { pattern: /\bmock/i, tags: ["testing", "mock"] },
  { pattern: /\bintegration\b/i, tags: ["testing", "integration"] },
  { pattern: /\bPR\b|\bpull.?request/i, tags: ["review", "pr", "workflow"] },
  { pattern: /\bfeature.?flag/i, tags: ["deploy", "release", "feature"] },
];

function extractTags(content: string, description: string, summary = ""): string {
  const text = [content, description, summary].join(" ");
  const tags = new Set<string>();

  for (const { pattern, tags: newTags } of TAG_PATTERNS) {
    if (pattern.test(text)) {
      for (const tag of newTags) {
        tags.add(tag);
      }
    }
  }

  return Array.from(tags).join(" ");
}

/**
 * Create a MemoryIndexer with auto-discovered Claude memory directories.
 */
export function createMemoryIndexer(
  store: MemoryStore,
  projectRoot: string,
  options?: string[] | CreateMemoryIndexerOptions
): MemoryIndexer {
  const dirs: string[] = [];
  const writableDirs: string[] = [];
  const readOnlyDirs: string[] = [];
  const normalizedOptions = Array.isArray(options)
    ? { additionalDirs: options, writableDir: undefined, treatAdditionalAsWritable: true }
    : {
        additionalDirs: options?.additionalDirs,
        writableDir: options?.writableDir,
        treatAdditionalAsWritable: false,
      };

  // Auto-discover Claude Code memory directory
  const claudeDir = discoverClaudeMemoryDir(projectRoot);
  if (claudeDir) {
    dirs.push(claudeDir);
    readOnlyDirs.push(claudeDir);
  }

  const writableDir = normalizedOptions.writableDir
    ? resolve(normalizedOptions.writableDir)
    : resolve(projectRoot, ".memory", "reporecall-memories");
  mkdirSync(writableDir, { recursive: true });
  dirs.push(writableDir);
  writableDirs.push(writableDir);

  // Add any explicitly configured directories
  if (normalizedOptions.additionalDirs) {
    dirs.push(...normalizedOptions.additionalDirs);
    if (normalizedOptions.treatAdditionalAsWritable) {
      writableDirs.push(...normalizedOptions.additionalDirs);
    } else {
      readOnlyDirs.push(...normalizedOptions.additionalDirs);
    }
  }

  return new MemoryIndexer(store, dedupePaths(dirs), {
    projectRoot,
    writableDirs: dedupePaths(writableDirs),
    readOnlyDirs: dedupePaths(readOnlyDirs),
  });
}
