import { basename, dirname, extname } from "path";
import type {
  ResolvedTargetAliasHit,
  StoredChunk,
  StoredTarget,
  StoredTargetAlias,
  TargetAliasSource,
  TargetKind,
} from "../storage/types.js";
import { STOP_WORDS, expandQueryTerms, getQueryTermVariants, isTestFile, tokenizeQueryTerms } from "./utils.js";

export const INDEX_FORMAT_VERSION = "0.3.0-targets";

const CODE_DELIMITER_RE = /[^a-z0-9]+/g;
const PATH_LIKE_TARGET_RE = /\b[\w./-]+\b/g;
const SLUG_RE = /\b[a-z0-9]+(?:[-_][a-z0-9]+)+\b/g;
const INDEX_FILE_RE = /^index\.[^.]+$/i;
const GENERIC_FILE_STEMS = new Set(["index", "types", "type", "utils", "util", "helpers", "helper", "constants", "fixtures", "fixture", "mock", "mocks", "demo", "demos"]);
const ENDPOINT_DIR_HINT_RE = /(?:^|\/)(api|apis|route|routes|function|functions|endpoint|endpoints|handler|handlers|controller|controllers)\//i;
const EXPLICIT_TARGET_RE = /\b(?:show|trace|explain|debug|fix|where|find)\b/i;
const IMPLEMENTATION_PATH_HINTS = new Set(["src", "lib", "bin", "app", "server", "services", "supabase"]);
const GENERIC_ALIAS_TERMS = new Set(["callback", "function", "handler", "service", "route", "routing", "request", "session", "process", "files", "results", "result", "tool", "tools", "server", "handle", "prompt", "storage"]);

export interface ResolvedTargetCandidate {
  target: StoredTarget;
  alias: string;
  normalizedAlias: string;
  source: TargetAliasSource | "query" | "subsystem";
  confidence: number;
  phrase: string;
}

function splitIdentifierTokens(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_.:/-]+/g, " ")
    .toLowerCase()
    .split(CODE_DELIMITER_RE)
    .filter(Boolean);
}

export function normalizeTargetText(value: string): string {
  return splitIdentifierTokens(value).join(" ").trim();
}

function toKebabCase(tokens: string[]): string {
  return tokens.join("-");
}

function toSnakeCase(tokens: string[]): string {
  return tokens.join("_");
}

function toCamelCase(tokens: string[]): string {
  if (tokens.length === 0) return "";
  return tokens[0] + tokens.slice(1).map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join("");
}

function deriveMorphAliases(token: string): string[] {
  const aliases = new Set<string>();
  const normalized = token.toLowerCase();
  if (normalized.length < 3) return [];
  if (normalized.endsWith("ing") && normalized.length >= 6) {
    aliases.add(normalized.slice(0, -3));
  }
  if (normalized.endsWith("er") && normalized.length >= 5) {
    const stem = normalized.slice(0, -2);
    aliases.add(stem);
    aliases.add(`${stem}ing`);
  }
  if (normalized.endsWith("ion") && normalized.length >= 6) {
    aliases.add(normalized.slice(0, -3));
  }
  return Array.from(aliases);
}

function addAlias(
  aliases: Map<string, StoredTargetAlias>,
  targetId: string,
  alias: string,
  source: TargetAliasSource,
  weight: number
): void {
  const normalizedAlias = normalizeTargetText(alias);
  if (!normalizedAlias || normalizedAlias.length < 2) return;
  const key = `${targetId}:${normalizedAlias}:${source}`;
  const existing = aliases.get(key);
  if (existing && existing.weight >= weight) return;
  aliases.set(key, {
    targetId,
    alias,
    normalizedAlias,
    source,
    weight,
  });
}

function buildAliasSet(
  targetId: string,
  alias: string,
  source: TargetAliasSource,
  weight: number,
  aliases: Map<string, StoredTargetAlias>
): void {
  addAlias(aliases, targetId, alias, source, weight);
  const tokens = splitIdentifierTokens(alias);
  if (tokens.length === 0) return;
  addAlias(aliases, targetId, tokens.join(" "), source, weight);
  addAlias(aliases, targetId, toKebabCase(tokens), source, weight - 0.02);
  addAlias(aliases, targetId, toSnakeCase(tokens), source, weight - 0.03);
  addAlias(aliases, targetId, toCamelCase(tokens), source, weight - 0.04);
  for (const token of tokens) {
    if (token.length >= 3 && !STOP_WORDS.has(token)) {
      addAlias(aliases, targetId, token, source, Math.max(0.45, weight - 0.2));
      for (const morph of deriveMorphAliases(token)) {
        addAlias(aliases, targetId, morph, "derived", Math.max(0.38, weight - 0.24));
      }
    }
  }
}

function deriveSubsystem(filePath: string, implementationPaths: string[]): string | undefined {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;

  for (const prefix of implementationPaths) {
    const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "").toLowerCase();
    const prefixParts = normalizedPrefix.split("/").filter(Boolean);
    const matchesPrefix = prefixParts.every((part, index) => parts[index]?.toLowerCase() === part);
    if (!matchesPrefix) continue;
    const subsystem = parts[prefixParts.length];
    if (subsystem && subsystem !== filePath) {
      return subsystem.toLowerCase();
    }
  }

  const first = parts[0]?.toLowerCase();
  const second = parts[1]?.toLowerCase();
  if (first && IMPLEMENTATION_PATH_HINTS.has(first) && second) {
    return second;
  }
  if (first && parts.length >= 2) {
    return first;
  }
  return undefined;
}

function chooseOwnerChunk(
  chunks: StoredChunk[],
  canonicalHint?: string,
  options?: { preferHandler?: boolean }
): StoredChunk | undefined {
  const nonTest = chunks.filter((chunk) => !isTestFile(chunk.filePath) && chunk.kind !== "file" && chunk.name !== "<anonymous>");
  const pool = nonTest.length > 0 ? nonTest : chunks;
  const hint = canonicalHint ? normalizeTargetText(canonicalHint) : "";
  return [...pool].sort((a, b) => {
    const aServeHandler = a.name === "serve_handler" ? 1 : 0;
    const bServeHandler = b.name === "serve_handler" ? 1 : 0;
    if (options?.preferHandler && aServeHandler !== bServeHandler) return bServeHandler - aServeHandler;
    const aName = normalizeTargetText(a.name);
    const bName = normalizeTargetText(b.name);
    const aHint = hint && (aName === hint || aName.includes(hint)) ? 1 : 0;
    const bHint = hint && (bName === hint || bName.includes(hint)) ? 1 : 0;
    if (aHint !== bHint) return bHint - aHint;
    const aExport = a.isExported ? 1 : 0;
    const bExport = b.isExported ? 1 : 0;
    if (aExport !== bExport) return bExport - aExport;
    const aHandler = /(^|_)(serve|handle|handler)\b/.test(a.name) ? 1 : 0;
    const bHandler = /(^|_)(serve|handle|handler)\b/.test(b.name) ? 1 : 0;
    if (aHandler !== bHandler) return bHandler - aHandler;
    const aFn = /(function|method|export_statement|class)/.test(a.kind) ? 1 : 0;
    const bFn = /(function|method|export_statement|class)/.test(b.kind) ? 1 : 0;
    if (aFn !== bFn) return bFn - aFn;
    return a.startLine - b.startLine;
  })[0];
}

function buildSymbolTarget(chunk: StoredChunk, subsystem?: string): StoredTarget {
  return {
    id: `symbol:${chunk.id}`,
    kind: "symbol",
    canonicalName: chunk.name,
    normalizedName: normalizeTargetText(chunk.name),
    filePath: chunk.filePath,
    ownerChunkId: chunk.id,
    subsystem,
    confidence: chunk.isExported ? 0.98 : 0.9,
  };
}

function buildFileBackedTarget(
  filePath: string,
  chunks: StoredChunk[],
  subsystem: string | undefined
): StoredTarget | undefined {
  const fileName = basename(filePath);
  const isIndexFile = INDEX_FILE_RE.test(fileName);
  const parent = basename(dirname(filePath));
  const stem = basename(filePath, extname(filePath));
  const canonicalName = isIndexFile ? parent : stem;
  if (!canonicalName || canonicalName === "." || canonicalName === fileName) return undefined;
  if (!isIndexFile && GENERIC_FILE_STEMS.has(canonicalName.toLowerCase())) return undefined;
  const kind: TargetKind = isIndexFile && ENDPOINT_DIR_HINT_RE.test(filePath) ? "endpoint" : "file_module";
  const owner = chooseOwnerChunk(chunks, canonicalName, { preferHandler: kind === "endpoint" });
  return {
    id: `${kind}:${filePath}`,
    kind,
    canonicalName,
    normalizedName: normalizeTargetText(canonicalName),
    filePath,
    ownerChunkId: owner?.id,
    subsystem,
    confidence: kind === "endpoint" ? 0.98 : 0.92,
  };
}

function buildSubsystemTarget(subsystem: string, chunks: StoredChunk[]): StoredTarget | undefined {
  const owner = chooseOwnerChunk(chunks, subsystem);
  if (!owner) return undefined;
  return {
    id: `subsystem:${subsystem}`,
    kind: "subsystem",
    canonicalName: subsystem,
    normalizedName: normalizeTargetText(subsystem),
    filePath: owner.filePath,
    ownerChunkId: owner.id,
    subsystem,
    confidence: 0.84,
  };
}

export function buildTargetCatalog(
  chunks: StoredChunk[],
  implementationPaths: string[]
): { targets: StoredTarget[]; aliases: StoredTargetAlias[] } {
  const targets = new Map<string, StoredTarget>();
  const aliases = new Map<string, StoredTargetAlias>();
  const chunksByFile = new Map<string, StoredChunk[]>();
  const chunksBySubsystem = new Map<string, StoredChunk[]>();

  for (const chunk of chunks) {
    const fileChunks = chunksByFile.get(chunk.filePath) ?? [];
    fileChunks.push(chunk);
    chunksByFile.set(chunk.filePath, fileChunks);

    const subsystem = deriveSubsystem(chunk.filePath, implementationPaths);
    if (subsystem) {
      const subsystemChunks = chunksBySubsystem.get(subsystem) ?? [];
      subsystemChunks.push(chunk);
      chunksBySubsystem.set(subsystem, subsystemChunks);
    }

    if (chunk.kind === "file" || chunk.name === "<anonymous>") continue;
    const symbolTarget = buildSymbolTarget(chunk, subsystem);
    targets.set(symbolTarget.id, symbolTarget);
    buildAliasSet(symbolTarget.id, chunk.name, "symbol", 1, aliases);
    buildAliasSet(symbolTarget.id, chunk.filePath, "file_path", 0.62, aliases);
    if (chunk.parentName) {
      buildAliasSet(symbolTarget.id, `${chunk.parentName}.${chunk.name}`, "derived", 0.72, aliases);
    }
  }

  for (const [filePath, fileChunks] of chunksByFile.entries()) {
    const subsystem = deriveSubsystem(filePath, implementationPaths);
    const fileTarget = buildFileBackedTarget(filePath, fileChunks, subsystem);
    if (!fileTarget) continue;
    targets.set(fileTarget.id, fileTarget);
    buildAliasSet(fileTarget.id, fileTarget.canonicalName, INDEX_FILE_RE.test(basename(filePath)) ? "parent_dir" : "file_path", 0.96, aliases);
    buildAliasSet(fileTarget.id, filePath, "file_path", 0.78, aliases);
    buildAliasSet(fileTarget.id, basename(dirname(filePath)), "slug", 0.94, aliases);
    if (!INDEX_FILE_RE.test(basename(filePath))) {
      buildAliasSet(fileTarget.id, basename(filePath, extname(filePath)), "slug", 0.94, aliases);
    }
  }

  for (const [subsystem, subsystemChunks] of chunksBySubsystem.entries()) {
    const subsystemTarget = buildSubsystemTarget(subsystem, subsystemChunks);
    if (!subsystemTarget) continue;
    targets.set(subsystemTarget.id, subsystemTarget);
    buildAliasSet(subsystemTarget.id, subsystem, "derived", 0.86, aliases);
    for (const morph of deriveMorphAliases(subsystem)) {
      buildAliasSet(subsystemTarget.id, morph, "derived", 0.74, aliases);
    }
  }

  return {
    targets: Array.from(targets.values()),
    aliases: Array.from(aliases.values()),
  };
}

function extractPhraseCandidates(query: string): string[] {
  const lower = query.toLowerCase();
  const phrases = new Set<string>();

  for (const match of lower.matchAll(SLUG_RE)) {
    phrases.add(match[0]);
  }
  for (const match of lower.matchAll(PATH_LIKE_TARGET_RE)) {
    const candidate = match[0];
    if (candidate.includes("/") || candidate.includes("-") || candidate.includes("_") || /\.(ts|tsx|js|jsx|py|go|rs|java|rb|cpp|c|h)$/i.test(candidate)) {
      phrases.add(candidate);
    }
  }

  const tokens = tokenizeQueryTerms(lower).filter((term) => !STOP_WORDS.has(term));
  for (const token of tokens) {
    phrases.add(token);
  }
  for (let i = 0; i < tokens.length; i++) {
    const bi = tokens.slice(i, i + 2).join(" ");
    if (bi.split(" ").length === 2) phrases.add(bi);
    const tri = tokens.slice(i, i + 3).join(" ");
    if (tri.split(" ").length === 3) phrases.add(tri);
  }

  for (const term of expandQueryTerms(query)) {
    phrases.add(term.term);
  }

  return Array.from(phrases).filter((phrase) => phrase.length >= 2);
}

function scoreResolvedHit(
  query: string,
  phrase: string,
  hit: ResolvedTargetAliasHit,
  queryTerms: ReturnType<typeof expandQueryTerms>
): number {
  const normalizedPhrase = normalizeTargetText(phrase);
  const normalizedQuery = normalizeTargetText(query);
  const targetText = `${hit.target.normalizedName} ${normalizeTargetText(hit.target.filePath)}`;
  let score = hit.weight;
  const queryDirectlyMentionsAlias = normalizedQuery.includes(hit.normalizedAlias);
  const queryDirectlyMentionsTarget = normalizedQuery.includes(hit.target.normalizedName);
  const queryTermMatches = queryTerms.filter((term) => targetText.includes(term.term.toLowerCase()));
  const queryFamilyMatches = new Set(queryTermMatches.map((term) => term.family).filter(Boolean));

  if (normalizedPhrase === hit.target.normalizedName || normalizedPhrase === hit.normalizedAlias) {
    score += 0.22;
  }
  if (queryDirectlyMentionsAlias) {
    score += 0.08;
  }
  if (queryDirectlyMentionsTarget) {
    score += 0.16;
  }
  if (EXPLICIT_TARGET_RE.test(query) && (hit.target.kind === "endpoint" || hit.target.kind === "file_module")) {
    score += 0.08;
  }
  if (/\bwhere\b.*\bimplement/.test(query) && (hit.target.kind === "endpoint" || hit.target.kind === "file_module")) {
    score += 0.12;
  }
  if (/\bhow\s+does\b/.test(query) && hit.target.kind === "endpoint") {
    score += 0.1;
  }
  if (hit.target.kind === "subsystem") {
    score += 0.02;
  }
  if (hit.source === "derived" && !queryDirectlyMentionsAlias) {
    score *= 0.72;
  }
  if (queryTerms.length >= 3 && !queryDirectlyMentionsAlias && queryFamilyMatches.size === 0 && queryTermMatches.length <= 1) {
    score *= 0.7;
  }
  if (GENERIC_ALIAS_TERMS.has(hit.normalizedAlias)) {
    if (queryFamilyMatches.size === 0 && queryTermMatches.length <= 1) {
      score *= 0.48;
    }
  }
  if (hit.target.kind === "subsystem" && !queryDirectlyMentionsAlias && !queryDirectlyMentionsTarget) {
    score *= 0.58;
  }
  return Math.min(0.995, score + (hit.target.confidence * 0.06));
}

export function resolveTargetsForQuery(
  query: string,
  lookup: Pick<
    import("../storage/metadata-store.js").MetadataStore,
    "resolveTargetAliases"
  >
): ResolvedTargetCandidate[] {
  const queryTerms = expandQueryTerms(query);
  const phrases = extractPhraseCandidates(query);
  const normalizedAliases = Array.from(new Set(phrases.map((phrase) => normalizeTargetText(phrase)).filter(Boolean)));
  const hits = [
    ...lookup.resolveTargetAliases(normalizedAliases, 40, ["endpoint", "file_module"]),
    ...lookup.resolveTargetAliases(normalizedAliases, 60, ["symbol", "subsystem"]),
  ];
  const byTarget = new Map<string, ResolvedTargetCandidate>();

  for (const hit of hits) {
    const phrase = phrases.find((candidate) => normalizeTargetText(candidate) === hit.normalizedAlias) ?? hit.alias;
    const confidence = scoreResolvedHit(query.toLowerCase(), phrase.toLowerCase(), hit, queryTerms);
    const current = byTarget.get(hit.target.id);
    if (!current || confidence > current.confidence) {
      byTarget.set(hit.target.id, {
        target: hit.target,
        alias: hit.alias,
        normalizedAlias: hit.normalizedAlias,
        source: hit.source,
        confidence,
        phrase,
      });
    }
  }

  return Array.from(byTarget.values())
    .sort((a, b) => b.confidence - a.confidence || b.alias.length - a.alias.length)
    .slice(0, 12);
}

export function buildLiteralAliasCandidates(values: string[]): string[] {
  const aliases = new Set<string>();
  for (const value of values) {
    aliases.add(normalizeTargetText(value));
    for (const variant of getQueryTermVariants(value)) {
      aliases.add(normalizeTargetText(variant));
    }
  }
  return Array.from(aliases).filter(Boolean);
}

export function sameNormalizedTarget(a: string, b: string): boolean {
  return normalizeTargetText(a) === normalizeTargetText(b);
}

export function isIndexFilePath(filePath: string): boolean {
  return INDEX_FILE_RE.test(basename(filePath));
}

export function fileStem(filePath: string): string {
  return basename(filePath, extname(filePath));
}
