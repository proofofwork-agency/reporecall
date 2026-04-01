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

export const GENERIC_QUERY_ACTION_TERMS = new Set([
  "work",
  "works",
  "working",
  "show",
  "inspect",
  "read",
  "start",
  "trace",
  "traces",
  "tracing",
  "traced",
  "full",
  "complete",
  "entire",
  "overall",
  "across",
  "system",
]);

export type ExecutionSurface =
  | "ui"
  | "routing"
  | "state"
  | "backend"
  | "cli"
  | "mcp"
  | "infra"
  | "shared";

export interface ExecutionSurfaceBias {
  preferred: ExecutionSurface[];
  suppressed: ExecutionSurface[];
  defaultUserFacing: boolean;
  explicitInfrastructure: boolean;
  explicitBackend: boolean;
  explicitUi: boolean;
  explicitRouting: boolean;
}

const EXEC_SURFACE_UI_RE = /\b(page|pages|screen|screens|view|views|modal|dialog|component|components|layout|ui)\b/;
const EXEC_SURFACE_ROUTING_RE = /\b(route|routes|router|routing|redirect|redirects|callback|callbacks|protected|guard|guards|navigation|navigate|pending|destination|handoff|return)\b/;
const EXEC_SURFACE_STATE_RE = /\b(hook|hooks|state|store|stores|session|sessions|context|provider|providers)\b/;
const EXEC_SURFACE_BACKEND_RE = /\b(api|endpoint|endpoints|request|requests|response|responses|server|servers|function|functions|handler|handlers|controller|controllers|webhook|bearer|header|headers|upload|uploads|bucket|storage)\b/;
const EXEC_SURFACE_CLI_RE = /\b(cli|command|commands|terminal|shell)\b/;
const EXEC_SURFACE_MCP_RE = /\b(mcp|stdio|transport|tool registration|tooling bridge)\b/;
const EXEC_SURFACE_INFRA_RE = /\b(daemon|socket|http|worker|scheduler|runtime|transport|protocol|bridge|hook|hooks)\b/;
const EXEC_SURFACE_AUTH_RE = /\b(auth|authentication|authorization|login|signin|signout|session|oauth|credential|token)\b/;

function uniqueSurfaces(values: ExecutionSurface[]): ExecutionSurface[] {
  return Array.from(new Set(values));
}

function normalizeExecutionSurfaceText(value: string): string {
  return splitIdentifierTokens(value).join(" ").trim();
}

export function detectExecutionSurfaces(
  filePath: string,
  name = "",
  content = ""
): ExecutionSurface[] {
  const lowerPath = filePath.toLowerCase();
  const text = normalizeExecutionSurfaceText(`${filePath} ${name} ${content.slice(0, 400)}`);
  const surfaces: ExecutionSurface[] = [];

  if (/(?:^|\/)(src\/)?(pages|components|screens|views|app)\//.test(lowerPath) || EXEC_SURFACE_UI_RE.test(text)) {
    surfaces.push("ui");
  }
  if (EXEC_SURFACE_ROUTING_RE.test(text) || /middleware/.test(lowerPath)) {
    surfaces.push("routing");
  }
  if (/(?:^|\/)(hooks|store|stores|state|context|providers?)\//.test(lowerPath) || EXEC_SURFACE_STATE_RE.test(text)) {
    surfaces.push("state");
  }
  if (/(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lowerPath) || EXEC_SURFACE_BACKEND_RE.test(text)) {
    surfaces.push("backend");
  }
  if (/(?:^|\/)(cli|commands?)\//.test(lowerPath) || EXEC_SURFACE_CLI_RE.test(text)) {
    surfaces.push("cli");
  }
  if (/(?:^|\/)(mcp|mcp-server)\//.test(lowerPath) || EXEC_SURFACE_MCP_RE.test(text)) {
    surfaces.push("mcp");
  }
  if (/(?:^|\/)(daemon|bridge|protocol|transports?)\//.test(lowerPath) || EXEC_SURFACE_INFRA_RE.test(text)) {
    surfaces.push("infra");
  }
  if (/(?:^|\/)(lib|shared|core|utils?|helpers?)\//.test(lowerPath)) {
    surfaces.push("shared");
  }
  if (surfaces.length === 0) surfaces.push("shared");

  return uniqueSurfaces(surfaces);
}

export function inferQueryExecutionSurfaceBias(
  query: string,
  queryMode?: string
): ExecutionSurfaceBias {
  const normalized = normalizeExecutionSurfaceText(query);
  const explicitInfrastructure = EXEC_SURFACE_MCP_RE.test(normalized)
    || EXEC_SURFACE_CLI_RE.test(normalized)
    || /\b(daemon|transport|protocol|tool registration|socket|bridge|stdio|streamable http)\b/.test(normalized);
  const explicitBackend =
    /\b(api|endpoint|endpoints|bearer|header|headers|webhook|upload|uploads|server|function|functions|controller|controllers|handler|handlers)\b/.test(normalized)
    || /\b(token missing|missing token|bearer token|auth header|http request|server path|server flow|request authentication|request auth|provider call|upstream provider|quota check|rate limit)\b/.test(normalized);
  const explicitUi = EXEC_SURFACE_UI_RE.test(normalized);
  const explicitRouting = EXEC_SURFACE_ROUTING_RE.test(normalized);
  const authLike = EXEC_SURFACE_AUTH_RE.test(normalized);
  const defaultUserFacing =
    authLike
    && !explicitInfrastructure
    && !explicitBackend
    && (explicitUi || explicitRouting || queryMode === "architecture" || queryMode === "bug" || queryMode === "change" || queryMode === "trace");

  const preferred: ExecutionSurface[] = [];
  const suppressed: ExecutionSurface[] = [];

  if (explicitInfrastructure) {
    preferred.push("infra", "mcp", "cli", "backend");
    if (!explicitUi && !explicitRouting) suppressed.push("ui");
  } else if (explicitBackend) {
    preferred.push("backend");
    suppressed.push("cli", "mcp");
    if (!explicitUi && !explicitRouting) suppressed.push("ui");
  } else if (defaultUserFacing || explicitUi || explicitRouting) {
    preferred.push("ui", "routing", "state");
    suppressed.push("cli", "mcp", "infra");
  }

  if (queryMode === "trace" && explicitInfrastructure) {
    preferred.push("infra", "mcp", "cli");
  }
  if (queryMode === "architecture" && defaultUserFacing) {
    preferred.push("ui", "routing", "state");
  }

  return {
    preferred: uniqueSurfaces(preferred),
    suppressed: uniqueSurfaces(suppressed).filter((surface) => !preferred.includes(surface)),
    defaultUserFacing,
    explicitInfrastructure,
    explicitBackend,
    explicitUi,
    explicitRouting,
  };
}

export function scoreExecutionSurfaceAlignment(
  candidateSurfaces: Iterable<ExecutionSurface>,
  bias: ExecutionSurfaceBias
): number {
  if (!bias) return 0;
  const surfaces = new Set(candidateSurfaces);
  let score = 0;

  const preferredMatches = bias.preferred.filter((surface) => surfaces.has(surface)).length;
  const suppressedMatches = bias.suppressed.filter((surface) => surfaces.has(surface)).length;

  if (preferredMatches > 0) score += Math.min(2.1, preferredMatches * 0.75);
  if (suppressedMatches > 0 && preferredMatches === 0) score -= Math.min(2.4, suppressedMatches * 0.9);

  if (
    bias.defaultUserFacing
    && (surfaces.has("cli") || surfaces.has("mcp") || surfaces.has("infra"))
    && !surfaces.has("ui")
    && !surfaces.has("routing")
    && !surfaces.has("state")
  ) {
    score -= 1.6;
  }

  if (
    bias.explicitInfrastructure
    && (surfaces.has("cli") || surfaces.has("mcp") || surfaces.has("infra"))
  ) {
    score += 0.8;
  }

  if (
    bias.explicitBackend
    && surfaces.has("backend")
    && !surfaces.has("cli")
    && !surfaces.has("mcp")
  ) {
    score += 0.6;
  }

  return score;
}

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
      "authenticate",
      "authenticated",
      "login",
      "signin",
      "signup",
      "signout",
      "session",
      "oauth",
      "token",
      "credential",
      "identity",
      "authenticate",
      "authenticated",
      "callback",
      "redirect",
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
    anchors: ["storage", "upload", "download", "blob", "bucket", "media"],
    aliases: [
      "storage",
      "upload",
      "download",
      "blob",
      "bucket",
      "media",
      "attachment",
      "object",
    ],
  },
  {
    family: "generation",
    anchors: ["generation", "generate", "generated", "regeneration", "render", "rendering", "image"],
    aliases: [
      "generation",
      "generate",
      "generated",
      "regeneration",
      "render",
      "rendering",
      "image",
      "images",
      "generator",
      "generateImage",
      "generate_image",
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
    anchors: ["route", "routing", "router", "navigation", "redirect", "callback", "protection", "pending", "destination", "handoff"],
    aliases: [
      "route",
      "routes",
      "router",
      "routing",
      "navigation",
      "navigate",
      "redirect",
      "callback",
      "pending",
      "destination",
      "handoff",
      "guard",
      "protected",
      "protection",
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
    .replace(/[’']/g, "")
    .split(CODE_DELIMITER_RE)
    .map((term) => term.replace(/^[_./-]+|[_./-]+$/g, ""))
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
  if (/\bsigning\s+in\b/.test(lower)) {
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
  if (/\broute\s+protection\b/.test(lower) || /\bprotected\s+route\b/.test(lower)) {
    aliases.push(
      { term: "protectedRoute", family: "auth" },
      { term: "protected_route", family: "auth" },
      { term: "protected", family: "auth" },
      { term: "guard", family: "routing" }
    );
  }
  if (/\bpending\s+navigation\b/.test(lower)) {
    aliases.push(
      { term: "pendingNavigation", family: "auth" },
      { term: "pending_navigation", family: "auth" },
      { term: "redirect", family: "routing" }
    );
  }
  if (/\blogged\s+out\b/.test(lower) || /\bwhile\s+logged\s+out\b/.test(lower)) {
    aliases.push(
      { term: "protected", family: "auth" },
      { term: "guard", family: "routing" }
    );
  }
  if (/\bauthenticat(?:e|ed|ing)\b/.test(lower) || /\blog(?:ged)?\s+in\b/.test(lower)) {
    aliases.push(
      { term: "session", family: "auth" },
      { term: "signin", family: "auth" },
      { term: "redirect", family: "routing" }
    );
  }
  if (
    /\b(original|queued|pending)\s+destination\b/.test(lower)
    || /\breturn\s+to\b.*\b(destination|route|page)\b/.test(lower)
    || /\bpreserv(?:e|es|ing)\b.*\b(destination|redirect)\b/.test(lower)
  ) {
    aliases.push(
      { term: "pendingNavigation", family: "auth" },
      { term: "pending_navigation", family: "auth" },
      { term: "destination", family: "routing" },
      { term: "redirect", family: "routing" }
    );
  }
  if (/\bhandoff\b/.test(lower)) {
    aliases.push(
      { term: "redirect", family: "routing" },
      { term: "callback", family: "routing" },
      { term: "destination", family: "routing" }
    );
  }
  if (/\bimage\s+generation\b/.test(lower)) {
    aliases.push(
      { term: "generate_image", family: "generation" },
      { term: "generateImage", family: "generation" }
    );
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
  if (normalized.length >= 5 && normalized.endsWith("ies")) {
    variants.add(normalized.slice(0, -3) + "y");
  }
  if (normalized.length >= 5 && normalized.endsWith("es")) {
    variants.add(normalized.slice(0, -2));
  }
  if (normalized.length >= 4 && normalized.endsWith("s") && !normalized.endsWith("ss")) {
    variants.add(normalized.slice(0, -1));
  }
  return Array.from(variants);
}

/**
 * Returns true when text contains the raw query term or one of its code-facing variants.
 */
export function textMatchesQueryTerm(text: string, term: string): boolean {
  const normalizedText = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim();
  const compactText = normalizedText.replace(/\s+/g, "");

  return getQueryTermVariants(term).some((variant) => {
    const lowerVariant = variant.toLowerCase();
    const boundaryPattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(lowerVariant)}(?=$|[^a-z0-9])`, "i");
    if (boundaryPattern.test(normalizedText)) return true;

    const compactVariant = lowerVariant.replace(/[^a-z0-9]+/g, "");
    if (compactVariant.length < 8) return false;
    return compactText.includes(compactVariant);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
