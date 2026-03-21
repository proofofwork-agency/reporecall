/**
 * Common English stop words shared across search modules.
 * Union of words from seed.ts and ranker.ts to avoid duplicate definitions.
 */
export const STOP_WORDS = new Set([
  "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "need",
  "dare", "ought", "used", "to", "of", "in", "for", "on",
  "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "because", "but", "and",
  "if", "or", "while", "about", "what", "which", "who",
  "whom", "this", "that", "these", "those", "am", "an", "a",
  "it", "its", "my", "your", "his", "her", "our", "their",
  "return", "list",
]);

const CODE_DELIMITER_RE = /[^a-z0-9_./-]+/;
const CAMEL_BOUNDARY_RE = /(?<!^)(?=[A-Z])/g;
const TEST_PATH_RE =
  /(?:^|\/)(test|tests|spec|__tests__|__fixtures__|fixtures|benchmark|examples|e2e|cypress|playwright|integration)\//;
const TEST_FILE_RE = /\.(test|spec|e2e)\.[^.]+$/;
const TEST_BASENAME_RE = /(?:^|\/)(?:benchmark|demo)\.[^/]+$/;
const CODE_ALIAS_SUFFIX_RE = /(tion|sion|ment|ance|ence|ality|ity|ing|izer|iser|able|ible)$/;
export const GENERIC_BROAD_TERMS = new Set([
  "flow",
  "workflow",
  "path",
  "pipeline",
  "journey",
  "step",
  "steps",
  "log",
  "logging",
  "trace",
  "handler",
  "service",
  "utils",
  "utility",
  "helpers",
  "types",
]);

type ExpansionSource = "original" | "morphological" | "semantic" | "corpus";

export interface ExpandedQueryTerm {
  term: string;
  weight: number;
  source: ExpansionSource;
  family?: string;
  generic?: boolean;
}

interface ConceptFamilyDefinition {
  family: string;
  anchors: string[];
  aliases: string[];
}

const CONCEPT_FAMILIES: ConceptFamilyDefinition[] = [
  {
    family: "auth",
    anchors: [
      "auth",
      "authentication",
      "authorization",
      "login",
      "signin",
      "signup",
      "signout",
      "session",
      "oauth",
      "token",
      "credential",
      "identity",
      "callback",
      "redirect",
      "guard",
      "protected",
    ],
    aliases: [
      "auth",
      "login",
      "signin",
      "sign_in",
      "signIn",
      "signup",
      "sign_up",
      "signUp",
      "signout",
      "sign_out",
      "signOut",
      "session",
      "getSession",
      "getsession",
      "onAuthStateChange",
      "onauthstatechange",
      "callback",
      "redirect",
      "protected",
      "guard",
      "oauth",
      "token",
      "credential",
      "identity",
    ],
  },
  {
    family: "config",
    anchors: ["config", "configuration", "settings", "env", "environment", "setup"],
    aliases: [
      "config",
      "configuration",
      "configure",
      "settings",
      "env",
      "environment",
      "setup",
      "bootstrap",
      "initialize",
      "init",
    ],
  },
  {
    family: "billing",
    anchors: ["billing", "payment", "invoice", "subscription", "checkout", "refund"],
    aliases: [
      "billing",
      "payment",
      "payments",
      "invoice",
      "subscription",
      "checkout",
      "refund",
      "charge",
      "plan",
      "pricing",
    ],
  },
  {
    family: "storage",
    anchors: ["storage", "upload", "download", "file", "blob", "bucket", "media"],
    aliases: [
      "storage",
      "upload",
      "download",
      "file",
      "files",
      "blob",
      "bucket",
      "media",
      "attachment",
      "object",
    ],
  },
  {
    family: "queue",
    anchors: ["queue", "job", "worker", "task", "retry", "scheduler", "schedule"],
    aliases: [
      "queue",
      "job",
      "jobs",
      "worker",
      "task",
      "retry",
      "scheduler",
      "schedule",
      "dispatch",
      "enqueue",
      "dequeue",
    ],
  },
  {
    family: "cache",
    anchors: ["cache", "caching", "invalidate", "memo", "redis"],
    aliases: ["cache", "cached", "caching", "invalidate", "memo", "memoize", "redis", "ttl"],
  },
  {
    family: "webhook",
    anchors: ["webhook", "callback", "event", "signature"],
    aliases: ["webhook", "callback", "event", "signature", "verify", "delivery", "payload"],
  },
  {
    family: "permissions",
    anchors: ["permission", "permissions", "role", "roles", "access", "policy", "policies"],
    aliases: [
      "permission",
      "permissions",
      "role",
      "roles",
      "access",
      "authorize",
      "authorization",
      "policy",
      "policies",
      "scope",
    ],
  },
  {
    family: "routing",
    anchors: ["route", "routing", "router", "navigation", "redirect", "callback"],
    aliases: [
      "route",
      "routes",
      "router",
      "routing",
      "navigation",
      "navigate",
      "redirect",
      "callback",
      "guard",
      "protected",
    ],
  },
  {
    family: "search",
    anchors: ["search", "query", "retrieval", "ranking", "rerank", "index", "indexing"],
    aliases: [
      "search",
      "query",
      "retrieval",
      "retrieve",
      "rank",
      "ranking",
      "rerank",
      "index",
      "indexing",
      "pipeline",
    ],
  },
  {
    family: "daemon",
    anchors: ["daemon", "server", "http", "hook", "hooks", "request", "prompt", "mcp", "stdio"],
    aliases: [
      "daemon",
      "server",
      "http",
      "hook",
      "hooks",
      "request",
      "prompt",
      "session",
      "serve",
      "mcp",
      "stdio",
    ],
  },
  {
    family: "logging",
    anchors: ["log", "logging", "trace", "audit", "instrument", "instrumentation"],
    aliases: [
      "log",
      "logger",
      "logging",
      "trace",
      "audit",
      "instrument",
      "instrumentation",
      "telemetry",
      "event",
      "metrics",
    ],
  },
  {
    family: "lifecycle",
    anchors: [
      "shutdown",
      "startup",
      "teardown",
      "drain",
      "close",
      "closing",
      "stop",
      "graceful",
      "lifecycle",
      "bootstrap",
      "boot",
    ],
    aliases: [
      "shutdown",
      "startup",
      "teardown",
      "drain",
      "close",
      "closeAsync",
      "closeasync",
      "closing",
      "stop",
      "stopped",
      "cleanup",
      "dispose",
      "bootstrap",
      "boot",
      "lifecycle",
      "graceful",
    ],
  },
];

function splitIdentifierTokens(value: string): string[] {
  return value
    .replace(CAMEL_BOUNDARY_RE, " ")
    .toLowerCase()
    .split(CODE_DELIMITER_RE)
    .filter(Boolean);
}

/**
 * Checks if a file path is a test/spec/fixture/benchmark/example file.
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return TEST_PATH_RE.test(lower) || TEST_FILE_RE.test(lower) || TEST_BASENAME_RE.test(lower);
}

export function tokenizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(CODE_DELIMITER_RE)
    .filter((term) => term.length >= 2);
}

function addExpandedTerm(
  destination: Map<string, ExpandedQueryTerm>,
  term: string,
  weight: number,
  source: ExpansionSource,
  family?: string
): void {
  const normalized = term.trim();
  if (!normalized || normalized.length < 2) return;
  const lower = normalized.toLowerCase();
  const generic = GENERIC_BROAD_TERMS.has(lower);
  const existing = destination.get(lower);
  if (!existing || weight > existing.weight) {
    destination.set(lower, { term: normalized, weight, source, family, generic });
    return;
  }
  if (!existing.family && family) {
    destination.set(lower, { ...existing, family, generic: existing.generic ?? generic });
  }
}

function phraseAwareAliases(query: string): Array<{ term: string; family?: string }> {
  const lower = query.toLowerCase();
  const aliases: Array<{ term: string; family?: string }> = [];

  if (/\bsign\s+in\b/.test(lower)) {
    aliases.push(
      { term: "signin", family: "auth" },
      { term: "sign_in", family: "auth" },
      { term: "signIn", family: "auth" }
    );
  }
  if (/\bsign\s+up\b/.test(lower)) {
    aliases.push(
      { term: "signup", family: "auth" },
      { term: "sign_up", family: "auth" },
      { term: "signUp", family: "auth" }
    );
  }
  if (/\bsign\s+out\b/.test(lower)) {
    aliases.push(
      { term: "signout", family: "auth" },
      { term: "sign_out", family: "auth" },
      { term: "signOut", family: "auth" }
    );
  }
  if (/\bauth(?:entication|orization)?\s+callback\b/.test(lower)) {
    aliases.push({ term: "callback", family: "auth" }, { term: "redirect", family: "routing" });
  }

  return aliases;
}

export function expandQueryTerms(queryOrTerms: string | string[]): ExpandedQueryTerm[] {
  const terms = Array.isArray(queryOrTerms) ? queryOrTerms : tokenizeQueryTerms(queryOrTerms);
  const expanded = new Map<string, ExpandedQueryTerm>();

  for (const rawTerm of terms) {
    const term = rawTerm.toLowerCase().trim();
    if (!term || STOP_WORDS.has(term)) continue;

    addExpandedTerm(expanded, term, 1, "original");
    for (const variant of getQueryTermVariants(term)) {
      if (variant !== term) {
        addExpandedTerm(expanded, variant, 0.86, "morphological");
      }
    }

    for (const family of CONCEPT_FAMILIES) {
      const matchesFamily = family.anchors.includes(term)
        || family.aliases.some((alias) => alias.toLowerCase() === term);
      if (!matchesFamily) continue;

      for (const alias of family.aliases) {
        const isSelf = alias.toLowerCase() === term;
        addExpandedTerm(expanded, alias, isSelf ? 1 : 0.72, isSelf ? "original" : "semantic", family.family);
        for (const variant of getQueryTermVariants(alias)) {
          if (variant !== alias.toLowerCase()) {
            addExpandedTerm(expanded, variant, 0.64, "semantic", family.family);
          }
        }
      }
    }
  }

  if (typeof queryOrTerms === "string") {
    for (const alias of phraseAwareAliases(queryOrTerms)) {
      addExpandedTerm(expanded, alias.term, 0.72, "semantic", alias.family);
    }
  }

  return Array.from(expanded.values()).sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
}

export function collectCorpusFamilyTerms(
  baseTerms: ExpandedQueryTerm[],
  candidates: Array<{ filePath: string; name: string }>
): ExpandedQueryTerm[] {
  if (candidates.length === 0) return [];

  const baseFamilies = new Set(baseTerms.map((term) => term.family).filter(Boolean));
  const tokenFiles = new Map<string, Set<string>>();

  for (const candidate of candidates.slice(0, 10)) {
    const fileKey = candidate.filePath;
    const tokens = new Set([
      ...splitIdentifierTokens(candidate.filePath.replace(/\.[^.]+$/, "")),
      ...splitIdentifierTokens(candidate.name),
    ]);
    for (const token of tokens) {
      if (token.length < 4 || STOP_WORDS.has(token) || GENERIC_BROAD_TERMS.has(token)) continue;
      const files = tokenFiles.get(token) ?? new Set<string>();
      files.add(fileKey);
      tokenFiles.set(token, files);
    }
  }

  const derived: ExpandedQueryTerm[] = [];
  for (const [token, files] of tokenFiles) {
    if (files.size < 2) continue;

    const matchedFamily = CONCEPT_FAMILIES.find((family) =>
      family.aliases.includes(token) || family.anchors.includes(token)
    )?.family;

    if (baseFamilies.size > 0 && matchedFamily && !baseFamilies.has(matchedFamily)) {
      continue;
    }

    derived.push({
      term: token,
      weight: matchedFamily ? 0.58 : 0.52,
      source: "corpus",
      family: matchedFamily,
      generic: GENERIC_BROAD_TERMS.has(token),
    });
  }

  return derived.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
}

/**
 * Expands natural-language query terms into likely code-facing variants.
 * Example: "authentication" -> ["authentication", "auth"].
 */
export function getQueryTermVariants(term: string): string[] {
  const normalized = term.toLowerCase().trim();
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);
  if (normalized.includes("_")) {
    variants.add(normalized.replace(/_/g, ""));
  }
  if (normalized.length >= 4 && normalized.endsWith("ing")) {
    variants.add(normalized.slice(0, -3));
  }
  // "embedding" → "embedder" (stem + "er")
  if (normalized.length >= 6 && normalized.endsWith("ing")) {
    variants.add(normalized.slice(0, -3) + "er");
  }
  // "embedder" → "embedding" (stem + "ing")
  if (normalized.length >= 5 && normalized.endsWith("er")) {
    variants.add(normalized.slice(0, -2) + "ing");
  }
  if (normalized.length >= 5 && normalized.endsWith("ion")) {
    variants.add(normalized.slice(0, -3));
  }
  if (normalized.length >= 6 && normalized.endsWith("ation")) {
    variants.add(normalized.replace(/ation$/, "ate"));
  }
  if (normalized.length >= 6 && CODE_ALIAS_SUFFIX_RE.test(normalized)) {
    variants.add(normalized.slice(0, 4));
  }
  return Array.from(variants);
}

/**
 * Returns true when text contains the raw query term or one of its code-facing variants.
 */
export function textMatchesQueryTerm(text: string, term: string): boolean {
  const lowerText = text.toLowerCase();
  return getQueryTermVariants(term).some((variant) => lowerText.includes(variant));
}
