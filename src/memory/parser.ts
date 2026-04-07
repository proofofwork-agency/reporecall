import type { MemoryType } from "./types.js";
import type {
  MemoryClass,
  MemoryScope,
  MemorySourceKind,
  MemoryStatus,
} from "./types.js";

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference", "wiki"]);
const VALID_CLASSES = new Set<MemoryClass>(["rule", "fact", "episode", "working"]);
const VALID_SCOPES = new Set<MemoryScope>(["global", "project", "branch"]);
const VALID_STATUS = new Set<MemoryStatus>(["active", "archived", "superseded"]);
const VALID_SOURCE_KINDS = new Set<MemorySourceKind>([
  "claude_auto",
  "reporecall_local",
  "generated",
]);
const VALID_PAGE_TYPES = new Set<WikiPageType>(["community", "hub", "module", "flow", "exploration"]);
const VALID_SOURCE_LAYERS = new Set<WikiSourceLayer>(["deterministic", "llm-enriched"]);

export type WikiPageType = "community" | "hub" | "module" | "flow" | "exploration";
export type WikiSourceLayer = "deterministic" | "llm-enriched";

export interface ParsedMemory {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  class?: MemoryClass;
  scope?: MemoryScope;
  status?: MemoryStatus;
  summary?: string;
  sourceKind?: MemorySourceKind;
  fingerprint?: string;
  pinned?: boolean;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  supersedesId?: string;
  confidence?: number;
  reason?: string;
  /** Wiki-specific: page category */
  pageType?: WikiPageType;
  /** Wiki-specific: how the page was generated */
  sourceLayer?: WikiSourceLayer;
  /** Wiki-specific: [[slug]] interlinks to other wiki pages */
  links?: string[];
  /** Wiki-specific: git commit SHA when page was written */
  sourceCommit?: string;
}

/**
 * Parse a memory markdown file. Returns null if the file doesn't have
 * valid frontmatter with required fields.
 */
export function parseMemoryFile(raw: string): ParsedMemory | null {
  // Match YAML frontmatter between --- delimiters
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1] ?? "";
  const content = (match[2] ?? "").trim();

  // Parse YAML fields (simple key: value parsing — no need for a full YAML parser)
  const fields = new Map<string, string>();
  for (const line of frontmatter.split("\n")) {
    const kv = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (kv && kv[1] && kv[2]) {
      fields.set(kv[1], normalizeScalar(kv[2]));
    }
  }

  const name = fields.get("name");
  const description = fields.get("description");
  const type = fields.get("type") as MemoryType | undefined;

  if (!name || !description || !type) return null;
  if (!VALID_TYPES.has(type)) return null;
  if (!content) return null;

  const classValue = fields.get("class") as MemoryClass | undefined;
  const scope = fields.get("scope") as MemoryScope | undefined;
  const status = fields.get("status") as MemoryStatus | undefined;
  const sourceKind = fields.get("sourceKind") as MemorySourceKind | undefined;
  const summary = fields.get("summary");
  const fingerprint = fields.get("fingerprint");
  const supersedesId = fields.get("supersedesId");
  const reason = fields.get("reason");
  const pinned = parseBoolean(fields.get("pinned"));
  const confidence = parseNumber(fields.get("confidence"));

  const relatedFiles = parseList(fields.get("relatedFiles"));
  const relatedSymbols = parseList(fields.get("relatedSymbols"));

  // Wiki-specific fields (only parsed for type=wiki, ignored otherwise)
  const pageType = fields.get("pageType") as WikiPageType | undefined;
  const sourceLayer = fields.get("sourceLayer") as WikiSourceLayer | undefined;
  const links = parseList(fields.get("links"));
  const sourceCommit = fields.get("sourceCommit");

  return {
    name,
    description,
    type,
    content,
    class: classValue && VALID_CLASSES.has(classValue) ? classValue : undefined,
    scope: scope && VALID_SCOPES.has(scope) ? scope : undefined,
    status: status && VALID_STATUS.has(status) ? status : undefined,
    summary,
    sourceKind: sourceKind && VALID_SOURCE_KINDS.has(sourceKind) ? sourceKind : undefined,
    fingerprint,
    pinned,
    relatedFiles,
    relatedSymbols,
    supersedesId,
    confidence,
    reason,
    pageType: pageType && VALID_PAGE_TYPES.has(pageType) ? pageType : undefined,
    sourceLayer: sourceLayer && VALID_SOURCE_LAYERS.has(sourceLayer) ? sourceLayer : undefined,
    links,
    sourceCommit,
  };
}

function normalizeScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first === '"' && last === '"') {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
  }
  if (first === "'" && last === "'") {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

function parseBoolean(raw?: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (/^(true|1|yes|on)$/i.test(raw)) return true;
  if (/^(false|0|no|off)$/i.test(raw)) return false;
  return undefined;
}

function parseNumber(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseList(raw?: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
          .filter((item) => item.length > 0);
      }
    } catch {
      // Fall back to comma-separated parsing below.
    }
  }

  return trimmed
    .split(/[,;\n]/)
    .map((item) => normalizeScalar(item).trim())
    .filter((item) => item.length > 0);
}
