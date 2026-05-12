import type { MetadataStore } from "../storage/metadata-store.js";
import type { StoredChunk } from "../storage/types.js";
import type { MemorySearchResult } from "../memory/types.js";
import type { QueryMode } from "./intent.js";
import type { SearchResult } from "./types.js";
import { isTestFile, textMatchesQueryTerm, tokenizeQueryTerms, STOP_WORDS, GENERIC_BROAD_TERMS, GENERIC_QUERY_ACTION_TERMS } from "./utils.js";
import { normalizeTargetText } from "./targets.js";

export type CapabilitySelectionSource =
  | "direct_match"
  | "wiki_capability"
  | "import_neighbor"
  | "call_neighbor"
  | "mandatory_flow_step";

export type CapabilitySelectionReason =
  | "direct_match"
  | "wiki_related_file"
  | "import_neighbor"
  | "call_neighbor"
  | "mandatory_flow_step";

export interface CapabilityWikiPage {
  name: string;
  summary?: string;
  score?: number;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  content?: string;
}

export interface CapabilityEvidenceFile {
  filePath: string;
  score: number;
  selectionSource: CapabilitySelectionSource;
  selectionReason: CapabilitySelectionReason;
  wikiPagesUsed: string[];
}

export interface CapabilityEvidenceResult {
  files: CapabilityEvidenceFile[];
  wikiPagesUsed: string[];
  missingEvidence: string[];
}

type CapabilityMetadata = Partial<Pick<
  MetadataStore,
  "findChunksByFilePath" | "getAllChunks" | "getImportsForFile" | "findImporterFiles" | "findCallers" | "findCallees" | "findCalleesForChunk"
>>;

interface MutableEvidenceFile extends CapabilityEvidenceFile {
  reasons: Set<CapabilitySelectionReason>;
  sources: Set<CapabilitySelectionSource>;
  wikiPageSet: Set<string>;
}

interface CapabilityFamilies {
  auth: boolean;
  billing: boolean;
  generation: boolean;
  upload: boolean;
}

const SOURCE_PRIORITY: CapabilitySelectionSource[] = [
  "direct_match",
  "wiki_capability",
  "mandatory_flow_step",
  "import_neighbor",
  "call_neighbor",
];

const REASON_PRIORITY: CapabilitySelectionReason[] = [
  "direct_match",
  "wiki_related_file",
  "mandatory_flow_step",
  "import_neighbor",
  "call_neighbor",
];
const GENERIC_CAPABILITY_QUERY_TERMS = new Set([
  "api",
  "background",
  "browsing",
  "build",
  "building",
  "computed",
  "customer",
  "data",
  "end",
  "enforce",
  "file",
  "files",
  "from",
  "implement",
  "implements",
  "implemented",
  "implementation",
  "into",
  "flow",
  "workflow",
  "full",
  "generation",
  "request",
  "requests",
  "served",
  "show",
  "through",
  "to",
  "main",
  "work",
  "works",
  "which",
]);

const CAPABILITY_SCORE = {
  queryTermPathSymbol: 6,
  queryTermContent: 1,
  familyPathSymbol: 34,
  familyContentWeak: 10,
  authContentWeak: 4,
  authUiLayer: 20,
  authStateLayer: 28,
  authRootEntry: 46,
  authEndpointPenalty: -12,
  authCliPenalty: -42,
  authBackendPenalty: -32,
  authBillingPenalty: -30,
  billingUiLayer: 16,
  billingServiceLayer: 22,
  billingEndpointLayer: 20,
  generationQueryTerm: 28,
  generationEndpointLayer: 20,
  generationServiceLayer: 16,
  generationStateLayer: 14,
  generationUiLayer: 10,
  generationArchivedPenalty: -28,
  generationWrongMediaPenalty: -18,
  uploadPathSymbol: 32,
  uploadExactEndpoint: 120,
  uploadExactOther: 50,
  uploadEndpointLayer: 24,
  uploadServiceLayer: 14,
  uploadSharedLayer: 18,
  uploadUiLayer: 10,
  testPenalty: -70,
  archivedPenalty: -70,
  docPenalty: -45,
} as const;

export function shouldUseCapabilityEvidence(queryMode: QueryMode): boolean {
  return queryMode === "trace"
    || queryMode === "architecture"
    || queryMode === "change"
    || queryMode === "lookup";
}

/**
 * Non-generic query tokens used to verify that a chunk file path shares
 * meaningful overlap with the user's query. Mirrors the filter set used in
 * `lookup-strategy.ts:extractQueryAnchors` so the two layers gate identically.
 */
function extractQueryAnchors(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) =>
      t.length >= 3
      && !STOP_WORDS.has(t)
      && !GENERIC_BROAD_TERMS.has(t)
      && !GENERIC_QUERY_ACTION_TERMS.has(t)
    );
}

export function hasPrimaryCapabilityFamilyForQuery(query: string): boolean {
  return primaryCapabilityFamily(inferCapabilityFamilies(query)) !== null;
}

export function shouldHydrateGenericCapabilityEvidence(query: string, queryMode: QueryMode): boolean {
  if (queryMode === "architecture" || queryMode === "change") return true;
  return /\b(?:which|what|list|show)\s+files\b|\bfiles?\s+(?:implement|handle|power|control|cover)\b/i.test(query);
}

export function resolveCapabilityEvidence(input: {
  query: string;
  queryMode: QueryMode;
  topCodeChunks: SearchResult[];
  wikiPages?: CapabilityWikiPage[];
  metadata: CapabilityMetadata;
  maxFiles?: number;
}): CapabilityEvidenceResult {
  const { query, queryMode, topCodeChunks, metadata } = input;
  const maxFiles = input.maxFiles ?? 10;
  if (!shouldUseCapabilityEvidence(queryMode)) {
    return { files: [], wikiPagesUsed: [], missingEvidence: [] };
  }

  const allowTests = /\b(test|tests|spec|e2e|fixture|mock)\b/i.test(query);
  const families = inferCapabilityFamilies(query);
  const entries = new Map<string, MutableEvidenceFile>();
  const seedFiles = new Set<string>();

  const upsert = (
    filePath: string | undefined | null,
    score: number,
    selectionSource: CapabilitySelectionSource,
    selectionReason: CapabilitySelectionReason,
    wikiPageName?: string
  ) => {
    if (!filePath) return;
    if (!allowTests && isTestFile(filePath)) return;
    const fileChunks = findFileChunks(metadata, filePath);
    if (!fileChunks.some((chunk) => chunk.kind !== "file")) return;
    const adjustedScore = score + scoreCapabilityFile(query, filePath, fileChunks, families);
    const existing = entries.get(filePath);
    if (!existing) {
      const next: MutableEvidenceFile = {
        filePath,
        score: adjustedScore,
        selectionSource,
        selectionReason,
        wikiPagesUsed: wikiPageName ? [wikiPageName] : [],
        reasons: new Set([selectionReason]),
        sources: new Set([selectionSource]),
        wikiPageSet: new Set(wikiPageName ? [wikiPageName] : []),
      };
      entries.set(filePath, next);
      return;
    }
    existing.score = Math.max(existing.score, adjustedScore);
    existing.reasons.add(selectionReason);
    existing.sources.add(selectionSource);
    if (wikiPageName) existing.wikiPageSet.add(wikiPageName);
    existing.selectionSource = bestSource(existing.sources);
    existing.selectionReason = bestReason(existing.reasons);
    existing.wikiPagesUsed = Array.from(existing.wikiPageSet).sort();
  };

  for (const chunk of topCodeChunks.slice(0, 12)) {
    if (
      (queryMode === "architecture" || queryMode === "change" || queryMode === "lookup")
      && !hasPrimaryFamilySignal(query, chunk.filePath, findFileChunks(metadata, chunk.filePath), families)
    ) {
      continue;
    }
    seedFiles.add(chunk.filePath);
    upsert(chunk.filePath, 72 + Math.min(20, chunk.score * 6), "direct_match", "direct_match");
  }

  const useWikiRelatedFiles = true;
  const relevantWikiPages = useWikiRelatedFiles ? (input.wikiPages ?? [])
    .filter((page) => isWikiPageRelevant(query, page))
    .slice(0, 4) : [];
  for (const page of relevantWikiPages) {
    for (const filePath of page.relatedFiles ?? []) {
      seedFiles.add(filePath);
      upsert(filePath, 66 + Math.min(18, (page.score ?? 0) * 20), "wiki_capability", "wiki_related_file", page.name);
    }
  }

  for (const filePath of findMandatoryFlowFiles(query, queryMode, metadata, families)) {
    seedFiles.add(filePath);
    upsert(filePath, 80, "mandatory_flow_step", "mandatory_flow_step");
  }

  const neighborSeeds = Array.from(seedFiles).slice(0, 10);
  for (const filePath of neighborSeeds) {
    for (const neighbor of collectImportNeighbors(metadata, filePath)) {
      upsert(neighbor, 24, "import_neighbor", "import_neighbor");
    }
  }

  for (const chunk of topCodeChunks.slice(0, 8)) {
    for (const caller of metadata.findCallers?.(chunk.name, 8, chunk.filePath, chunk.id) ?? []) {
      upsert(caller.filePath, 22, "call_neighbor", "call_neighbor");
    }
    for (const callee of metadata.findCalleesForChunk?.(chunk.id, 8) ?? []) {
      upsert(callee.targetFilePath ?? callee.filePath, 22, "call_neighbor", "call_neighbor");
    }
    for (const callee of metadata.findCallees?.(chunk.name, 8) ?? []) {
      upsert(callee.targetFilePath ?? callee.filePath, 18, "call_neighbor", "call_neighbor");
    }
  }

  const files = Array.from(entries.values())
    .map((entry) => ({
      filePath: entry.filePath,
      score: Number(entry.score.toFixed(3)),
      selectionSource: bestSource(entry.sources),
      selectionReason: bestReason(entry.reasons),
      wikiPagesUsed: Array.from(entry.wikiPageSet).sort(),
    }))
    .filter((entry) => entry.selectionSource !== "import_neighbor" || entry.score >= 42)
    .filter((entry) => entry.selectionSource !== "call_neighbor" || entry.score >= 40)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, maxFiles);

  return {
    files,
    wikiPagesUsed: Array.from(new Set(files.flatMap((file) => file.wikiPagesUsed))).sort(),
    missingEvidence: buildCapabilityMissingEvidence(queryMode, files, families),
  };
}

export function hydrateCapabilityEvidenceFiles(
  metadata: CapabilityMetadata,
  files: CapabilityEvidenceFile[],
  existingFiles: Set<string> = new Set(),
  maxFiles = 8
): SearchResult[] {
  const hydrated: SearchResult[] = [];
  for (const file of files) {
    if (hydrated.length >= maxFiles) break;
    if (existingFiles.has(file.filePath)) continue;
    const chunk = selectBestChunkForEvidence(findFileChunks(metadata, file.filePath));
    if (!chunk) continue;
    hydrated.push(storedChunkToSearchResult(chunk, Math.max(0.2, file.score / 100), file));
  }
  return hydrated;
}

export function isBusinessWikiPage(page: Pick<MemorySearchResult, "name" | "content" | "filePath">): boolean {
  return page.name.startsWith("business-") || /^---[\s\S]*?\npageType:\s*"?business"?/m.test(page.content);
}

function inferCapabilityFamilies(query: string): CapabilityFamilies {
  const normalized = normalizeTargetText(query);
  return {
    auth: /\b(auth|authentication|authorization|login|signin|signup|signout|session|oauth|token|credential|protected|guard|callback|redirect)\b/.test(normalized),
    billing: /\b(billing|checkout|portal|subscription|invoice|payment|credit|credits|customer|pricing|plan)\b/.test(normalized),
    generation: /\b(image|images|generation|generate|render|renders|asset|assets|regen|regenerate|media generation)\b/.test(normalized),
    upload: /\b(upload|storage|media upload|uploaded|bucket|signed url|storage write|request auth)\b/.test(normalized),
  };
}

function isWikiPageRelevant(query: string, page: CapabilityWikiPage): boolean {
  const terms = queryTerms(query).filter((term) => !GENERIC_CAPABILITY_QUERY_TERMS.has(term));
  if (terms.length === 0) return true;
  const text = normalizeTargetText([
    page.name,
    page.summary ?? "",
    page.content ?? "",
    ...(page.relatedFiles ?? []),
    ...(page.relatedSymbols ?? []),
  ].join(" "));
  const matches = terms.filter((term) => textMatchesQueryTerm(text, term)).length;
  const business = page.name.startsWith("business-");
  if (business) return matches > 0;
  return matches >= 2;
}

function queryTerms(query: string): string[] {
  return tokenizeQueryTerms(query)
    .map((term) => normalizeTargetText(term))
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
}

function scoreCapabilityFile(
  query: string,
  filePath: string,
  chunks: StoredChunk[],
  families: CapabilityFamilies
): number {
  const terms = queryTerms(query);
  const symbolText = chunks.slice(0, 12).map((chunk) => `${chunk.name} ${chunk.parentName ?? ""}`).join(" ");
  const contentPreview = [...chunks]
    .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))
    .slice(0, 3)
    .map((chunk) => chunk.content.slice(0, 1200))
    .join(" ");
  const pathSymbolText = normalizeTargetText(`${filePath} ${symbolText}`);
  const contentText = normalizeTargetText(contentPreview);
  const text = `${pathSymbolText} ${contentText}`.trim();
  const lowerPath = filePath.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (textMatchesQueryTerm(pathSymbolText, term)) score += CAPABILITY_SCORE.queryTermPathSymbol;
    else if (textMatchesQueryTerm(contentText, term)) score += CAPABILITY_SCORE.queryTermContent;
  }
  if (families.auth) {
    const normalizedQuery = normalizeTargetText(query);
    const authTerms = /\b(auth|login|signin|signup|signout|oauth|protected|redirect|credential)\b/;
    const authConditionalTerms = /\b(callback|redirect|token|session|guard)\b/;
    const authPathSymbolMatch = authTerms.test(pathSymbolText)
      || (/\b(callback|redirect|token|session|guard)\b/.test(normalizedQuery) && authConditionalTerms.test(pathSymbolText));
    const authContentMatch = authTerms.test(contentText)
      || (/\b(callback|redirect|token|session|guard)\b/.test(normalizedQuery) && authConditionalTerms.test(contentText));
    if (authPathSymbolMatch) score += CAPABILITY_SCORE.familyPathSymbol;
    else if (authContentMatch) score += CAPABILITY_SCORE.authContentWeak;
    if (isUiLayer(lowerPath)) score += CAPABILITY_SCORE.authUiLayer;
    if (isStateLayer(lowerPath, pathSymbolText)) score += CAPABILITY_SCORE.authStateLayer;
    if (isRootEntry(lowerPath) && (authPathSymbolMatch || authContentMatch)) score += CAPABILITY_SCORE.authRootEntry;
    if (isEndpointLayer(lowerPath) && !/\b(endpoint|server|function|api|edge)\b/.test(normalizedQuery)) score += CAPABILITY_SCORE.authEndpointPenalty;
    if (/\b(cli|command|terminal)\b/.test(pathSymbolText) && !/\b(cli|command|terminal)\b/.test(normalizedQuery)) score += CAPABILITY_SCORE.authCliPenalty;
    if (/(?:^|\/)(mcp-server|server|api|backend)\//.test(lowerPath) && !/\b(mcp|server|api|backend|endpoint|function)\b/.test(normalizedQuery)) score += CAPABILITY_SCORE.authBackendPenalty;
    if (/\b(billing|invoice|subscription|checkout|payment)\b/.test(pathSymbolText)) score += CAPABILITY_SCORE.authBillingPenalty;
  }
  if (families.billing) {
    const billingTerms = /\b(billing|checkout|portal|subscription|invoice|payment|credit|customer|pricing|plan)\b/;
    if (billingTerms.test(pathSymbolText)) score += CAPABILITY_SCORE.familyPathSymbol;
    else if (billingTerms.test(contentText)) score += CAPABILITY_SCORE.familyContentWeak;
    for (const term of ["checkout", "portal", "subscription", "billing"]) {
      if (new RegExp(`\\b${term}\\b`).test(normalizeTargetText(query)) && new RegExp(`\\b${term}\\b`).test(pathSymbolText)) score += CAPABILITY_SCORE.familyPathSymbol;
    }
    if (isUiLayer(lowerPath)) score += CAPABILITY_SCORE.billingUiLayer;
    if (isServiceLayer(lowerPath, pathSymbolText)) score += CAPABILITY_SCORE.billingServiceLayer;
    if (isEndpointLayer(lowerPath)) score += CAPABILITY_SCORE.billingEndpointLayer;
  }
  if (families.generation) {
    const generationTerms = /\b(image|images|generation|generate|render|asset|regen|regenerate)\b/;
    if (generationTerms.test(pathSymbolText)) score += CAPABILITY_SCORE.familyPathSymbol;
    else if (generationTerms.test(contentText)) score += CAPABILITY_SCORE.familyContentWeak;
    for (const term of ["storyboard", "image", "generate", "generation", "render"]) {
      if (new RegExp(`\\b${term}\\b`).test(normalizeTargetText(query)) && new RegExp(`\\b${term}\\b`).test(pathSymbolText)) score += CAPABILITY_SCORE.generationQueryTerm;
    }
    if (isEndpointLayer(lowerPath)) score += CAPABILITY_SCORE.generationEndpointLayer;
    if (isServiceLayer(lowerPath, pathSymbolText)) score += CAPABILITY_SCORE.generationServiceLayer;
    if (isStateLayer(lowerPath, pathSymbolText)) score += CAPABILITY_SCORE.generationStateLayer;
    if (isUiLayer(lowerPath)) score += CAPABILITY_SCORE.generationUiLayer;
    if (/\b_archived\b|(?:^|\/)archive(?:d)?\//.test(lowerPath)) score += CAPABILITY_SCORE.generationArchivedPenalty;
    if (/\bimage\b/.test(normalizeTargetText(query)) && /\b(audio|video)\b/.test(pathSymbolText) && !/\bimage\b/.test(pathSymbolText)) score += CAPABILITY_SCORE.generationWrongMediaPenalty;
  }
  if (families.upload) {
    const uploadTerms = /\b(upload|storage|media|signed|bucket|file|request|auth|write)\b/;
    if (uploadTerms.test(pathSymbolText)) score += CAPABILITY_SCORE.uploadPathSymbol;
    else if (uploadTerms.test(contentText)) score += CAPABILITY_SCORE.familyContentWeak;
    if (/\bupload\b/.test(normalizeTargetText(query)) && /\bupload\b/.test(pathSymbolText)) score += isEndpointLayer(lowerPath) ? CAPABILITY_SCORE.uploadExactEndpoint : CAPABILITY_SCORE.uploadExactOther;
    if (isEndpointLayer(lowerPath)) score += CAPABILITY_SCORE.uploadEndpointLayer;
    if (isServiceLayer(lowerPath, pathSymbolText)) score += CAPABILITY_SCORE.uploadServiceLayer;
    if (isSharedLayer(lowerPath, pathSymbolText)) score += CAPABILITY_SCORE.uploadSharedLayer;
    if (isUiLayer(lowerPath)) score += CAPABILITY_SCORE.uploadUiLayer;
  }
  if (!primaryCapabilityFamily(families)) {
    score += scoreQueryAnchoredFile(query, filePath, chunks);
  }
  score += scoreGenericLayerFit(filePath, text);
  if (isTestFile(filePath)) score += CAPABILITY_SCORE.testPenalty;
  if (/(?:^|\/)_archived\/|(?:^|\/)archive(?:d)?\//i.test(filePath)) score += CAPABILITY_SCORE.archivedPenalty;
  if (/\.(md|mdx|txt|sql)$/i.test(filePath) || /(?:^|\/)(docs?|reports?|migrations?)\//i.test(filePath)) score += CAPABILITY_SCORE.docPenalty;
  return score;
}

function isUiLayer(lowerPath: string): boolean {
  return /(?:^|\/)(pages|components|screens|views|routes?|layouts?)\//.test(lowerPath);
}

function isStateLayer(lowerPath: string, normalizedText: string): boolean {
  return /(?:^|\/)(hooks|store|state|context|providers?)\//.test(lowerPath)
    || /\b(hook|provider|context|store|state|session)\b/.test(normalizedText);
}

function isServiceLayer(lowerPath: string, normalizedText: string): boolean {
  return /(?:^|\/)(services?|clients?|repositories?|adapters?|controllers?)\//.test(lowerPath)
    || /\b(service|client|repository|adapter|controller)\b/.test(normalizedText);
}

function isEndpointLayer(lowerPath: string): boolean {
  return /(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lowerPath);
}

function isSharedLayer(lowerPath: string, normalizedText: string): boolean {
  return /(?:^|\/)(_shared|shared|lib|utils?|helpers?)\//.test(lowerPath)
    || /\b(helper|util|shared|client|service)\b/.test(normalizedText);
}

function isRootEntry(lowerPath: string): boolean {
  if (/(?:^|\/)(functions?|api|server|backend)\//.test(lowerPath)) return false;
  return /^(?:src\/)?(?:main|index|app|root|layout)\.(tsx|jsx|ts|js)$/.test(lowerPath)
    || /^(?:apps?\/[^/]+\/)?app\/(?:root|layout)\.(tsx|jsx|ts|js)$/.test(lowerPath);
}

function scoreGenericLayerFit(filePath: string, normalizedText: string): number {
  const lowerPath = filePath.toLowerCase();
  let score = 0;
  if (/(?:^|\/)(pages|components|screens|views|app)\//.test(lowerPath)) score += 10;
  if (/(?:^|\/)(hooks|store|state|context|providers?)\//.test(lowerPath) || /\b(use|provider|state|store|context)\b/.test(normalizedText)) score += 12;
  if (/(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lowerPath) || /\b(controller|handler|endpoint|service)\b/.test(normalizedText)) score += 14;
  if (/(?:^|\/)(_shared|shared|lib|utils?|helpers?)\//.test(lowerPath) || /\b(helper|util|shared|client|service)\b/.test(normalizedText)) score += 8;
  return score;
}

function findMandatoryFlowFiles(
  query: string,
  queryMode: QueryMode,
  metadata: CapabilityMetadata,
  families: CapabilityFamilies
): string[] {
  const files = new Set<string>();
  for (const chunk of getAllChunks(metadata)) files.add(chunk.filePath);
  const primary = primaryCapabilityFamily(families);
  const broad = queryMode === "architecture" || queryMode === "change" || /\b(full|from|through|which\s+files?|all\s+files?|flow|workflow|end[- ]?to[- ]?end)\b/i.test(query);
  if (!primary) {
    return findQueryAnchoredFlowFiles(query, metadata, broad ? 10 : 6);
  }
  const limit = broad ? 8 : 3;
  const threshold = broad ? 42 : 48;
  return Array.from(files)
    .map((filePath) => ({
      filePath,
      score: scoreCapabilityFile(query, filePath, findFileChunks(metadata, filePath), families),
    }))
    .filter((candidate) => hasPrimaryFamilySignal(query, candidate.filePath, findFileChunks(metadata, candidate.filePath), families))
    .filter((candidate) => candidate.score >= threshold)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, limit)
    .map((candidate) => candidate.filePath);
}

function findQueryAnchoredFlowFiles(
  query: string,
  metadata: CapabilityMetadata,
  limit: number
): string[] {
  const files = new Set<string>();
  for (const chunk of getAllChunks(metadata)) files.add(chunk.filePath);
  const candidates = Array.from(files)
    .map((filePath) => {
      const chunks = findFileChunks(metadata, filePath);
      return {
        filePath,
        chunks,
        score: scoreQueryAnchoredFile(query, filePath, chunks) + scoreGenericLayerFit(
          filePath,
          normalizeTargetText(`${filePath} ${chunks.slice(0, 8).map((chunk) => chunk.name).join(" ")}`)
        ),
      };
    })
    .filter((candidate) => candidate.chunks.some((chunk) => chunk.kind !== "file"))
    .filter((candidate) => candidate.score >= 34)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

  const selected: string[] = [];
  const roleCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const role = classifyGenericFlowRole(candidate.filePath);
    const duplicateRoleLimit = role === "core" ? 3 : 2;
    const roleCount = roleCounts.get(role) ?? 0;
    if (roleCount >= duplicateRoleLimit && selected.length >= Math.max(4, Math.floor(limit / 2))) continue;
    selected.push(candidate.filePath);
    roleCounts.set(role, roleCount + 1);
  }
  return selected;
}

function scoreQueryAnchoredFile(
  query: string,
  filePath: string,
  chunks: StoredChunk[]
): number {
  const terms = meaningfulCapabilityTerms(query);
  if (terms.length === 0) return 0;
  const normalizedQuery = normalizeTargetText(query);
  const symbolText = chunks.slice(0, 16).map((chunk) => `${chunk.name} ${chunk.parentName ?? ""}`).join(" ");
  const contentPreview = [...chunks]
    .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))
    .slice(0, 4)
    .map((chunk) => chunk.content.slice(0, 1000))
    .join(" ");
  const pathSymbolText = normalizeTargetText(`${filePath} ${symbolText}`);
  const contentText = normalizeTargetText(contentPreview);
  const phrases = meaningfulCapabilityPhrases(query);
  let score = 0;
  let pathTermMatches = 0;
  let contentTermMatches = 0;

  for (const term of terms) {
    if (textMatchesQueryTerm(pathSymbolText, term)) {
      pathTermMatches++;
      score += 10;
    } else if (textMatchesQueryTerm(contentText, term)) {
      contentTermMatches++;
      score += 2;
    }
  }

  for (const phrase of phrases) {
    if (pathSymbolText.includes(phrase)) score += 28;
    else if (contentText.includes(phrase)) score += 7;
  }

  const pathCoverage = pathTermMatches / terms.length;
  const totalCoverage = (pathTermMatches + contentTermMatches) / terms.length;
  score += Math.min(30, pathCoverage * 30);
  score += Math.min(12, totalCoverage * 12);

  const lowerPath = filePath.toLowerCase();
  const role = classifyGenericFlowRole(lowerPath);
  if (role !== "core") score += 8;
  if (/\b(api|request|endpoint|controller)\b/.test(normalizedQuery) && role === "controller") score += 18;
  if (/\b(service|calculate|computed|served|suggestions?)\b/.test(normalizedQuery) && role === "service") score += 14;
  if (/\b(background|job|pipeline|processing|orchestration|orchestrate|chunk)\b/.test(normalizedQuery) && (role === "processor" || role === "producer")) score += 24;
  if (/\b(scorer|scorers|scoring|assignment|assigner|lane)\b/.test(normalizedQuery) && (role === "scorer" || /\b(assigner|scorer)\b/.test(pathSymbolText))) score += 26;
  if (/\b(guard|access|scoped|scope|organization|auth)\b/.test(normalizedQuery) && (role === "guard" || role === "decorator")) score += 22;
  if (/\b(export|csv|excel|pdf)\b/.test(normalizedQuery) && role === "exporter") score += 22;
  if (/\b(ui|page|component|browsing|browser)\b/.test(normalizedQuery) && isUiLayer(lowerPath)) score += 12;
  if (/\b(client|api)\b/.test(normalizedQuery) && /\b(client)\b/.test(pathSymbolText)) score += 10;
  if (/\b(repository|database|lookup)\b/.test(normalizedQuery) && /\b(repository|lookup)\b/.test(pathSymbolText)) score += 10;

  if (pathTermMatches === 0 && phrases.every((phrase) => !pathSymbolText.includes(phrase))) {
    score -= 18;
  }
  if (/(?:^|\/)(docs?|tech-analysis|reports?|migrations?|prisma\/migrations)\//i.test(filePath)) {
    score -= 35;
  }
  return score;
}

function meaningfulCapabilityTerms(query: string): string[] {
  return Array.from(new Set(
    queryTerms(query)
      .filter((term) => term.length >= 3)
      .filter((term) => !GENERIC_CAPABILITY_QUERY_TERMS.has(term))
  ));
}

function meaningfulCapabilityPhrases(query: string): string[] {
  const terms = tokenizeQueryTerms(query)
    .map((term) => normalizeTargetText(term))
    .filter((term) => term.length >= 3)
    .filter((term) => !STOP_WORDS.has(term))
    .filter((term) => !GENERIC_CAPABILITY_QUERY_TERMS.has(term));
  const phrases = new Set<string>();
  for (let index = 0; index < terms.length - 1; index++) {
    phrases.add(`${terms[index]} ${terms[index + 1]}`);
    if (index < terms.length - 2) {
      phrases.add(`${terms[index]} ${terms[index + 1]} ${terms[index + 2]}`);
    }
  }
  return Array.from(phrases);
}

function classifyGenericFlowRole(filePath: string): string {
  const lowerPath = filePath.toLowerCase();
  if (/\b(controller|route|handler)\b/.test(lowerPath)) return "controller";
  if (/\b(processor|worker|consumer)\b/.test(lowerPath)) return "processor";
  if (/\b(producer|publisher|queue)\b/.test(lowerPath)) return "producer";
  if (/\b(scorer|assigner)\b/.test(lowerPath)) return "scorer";
  if (/\b(exporter|export)\b/.test(lowerPath)) return "exporter";
  if (/\b(guard|middleware)\b/.test(lowerPath)) return "guard";
  if (/\b(decorator)\b/.test(lowerPath)) return "decorator";
  if (/\b(service|orchestrat|manager|builder|engine)\b/.test(lowerPath)) return "service";
  if (/\b(client|api)\b/.test(lowerPath)) return "client";
  if (/\b(repository|repo|storage)\b/.test(lowerPath)) return "repository";
  if (/(?:^|\/)(components|pages|app|views|screens)\//.test(lowerPath)) return "ui";
  if (/(?:^|\/)(hooks|stores?|state|context)\//.test(lowerPath)) return "state";
  return "core";
}

function hasPrimaryFamilySignal(
  query: string,
  filePath: string,
  chunks: StoredChunk[],
  families: CapabilityFamilies
): boolean {
  const primary = primaryCapabilityFamily(families);
  if (!primary) {
    const anchors = extractQueryAnchors(query);
    if (anchors.length < 2) return false;
    const haystack = filePath.toLowerCase();
    let matched = 0;
    for (const anchor of anchors) {
      if (haystack.includes(anchor)) {
        matched += 1;
        if (matched >= 2) return true;
      }
    }
    return false;
  }
  const pathSymbolText = normalizeTargetText(`${filePath} ${chunks.slice(0, 5).map((chunk) => `${chunk.name} ${chunk.parentName ?? ""}`).join(" ")}`);
  const longestContentText = normalizeTargetText([...chunks]
    .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))
    .slice(0, 3)
    .map((chunk) => chunk.content.slice(0, 1200))
    .join(" "));
  const queryText = normalizeTargetText(query);
  if (primary === "auth") {
    if (/\b(auth|login|signin|signup|signout|oauth|protected|redirect|credential)\b/.test(pathSymbolText)) return true;
    if (/\b(callback|token|session|guard)\b/.test(queryText) && /\b(callback|token|session|guard)\b/.test(pathSymbolText)) return true;
    if (isRootEntry(filePath.toLowerCase()) && /\b(auth|login|signin|signup|signout|oauth|protected|redirect|credential|callback|session|guard)\b/.test(longestContentText)) return true;
    return false;
  }
  if (primary === "billing") {
    return /\b(billing|checkout|portal|subscription|invoice|payment|credit|customer|pricing|plan)\b/.test(pathSymbolText);
  }
  if (primary === "generation") {
    return /\b(image|images|generation|generate|render|asset|regen|regenerate)\b/.test(pathSymbolText)
      || (/\bstoryboard\b/.test(queryText) && /\bstoryboard\b/.test(pathSymbolText));
  }
  if (primary === "upload") {
    return /\b(upload|storage|media|signed|bucket|request|write)\b/.test(pathSymbolText);
  }
  return true;
}

function primaryCapabilityFamily(families: CapabilityFamilies): keyof CapabilityFamilies | null {
  if (families.upload) return "upload";
  if (families.generation) return "generation";
  if (families.billing) return "billing";
  if (families.auth) return "auth";
  return null;
}

function collectImportNeighbors(
  metadata: CapabilityMetadata,
  filePath: string
): string[] {
  const neighbors = new Set<string>();
  for (const record of metadata.getImportsForFile?.(filePath) ?? []) {
    if (record.resolvedPath) neighbors.add(record.resolvedPath);
  }
  for (const importer of metadata.findImporterFiles?.(filePath) ?? []) neighbors.add(importer);
  neighbors.delete(filePath);
  return Array.from(neighbors);
}

function findFileChunks(metadata: CapabilityMetadata, filePath: string): StoredChunk[] {
  return metadata.findChunksByFilePath?.(filePath) ?? [];
}

function getAllChunks(metadata: CapabilityMetadata): StoredChunk[] {
  return metadata.getAllChunks?.() ?? [];
}

function selectBestChunkForEvidence(chunks: StoredChunk[]): StoredChunk | null {
  const candidates = chunks.filter((chunk) => chunk.kind !== "file");
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const aExport = a.isExported ? 1 : 0;
    const bExport = b.isExported ? 1 : 0;
    if (aExport !== bExport) return bExport - aExport;
    const aSpan = a.endLine - a.startLine;
    const bSpan = b.endLine - b.startLine;
    return aSpan - bSpan || a.startLine - b.startLine;
  })[0] ?? null;
}

function storedChunkToSearchResult(
  chunk: StoredChunk,
  score: number,
  evidence: CapabilityEvidenceFile
): SearchResult {
  return {
    id: chunk.id,
    score,
    filePath: chunk.filePath,
    name: chunk.name,
    kind: chunk.kind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    docstring: chunk.docstring,
    parentName: chunk.parentName,
    language: chunk.language,
    hookScore: score,
    selectionSource: evidence.selectionSource,
    selectionReason: evidence.selectionReason,
    wikiPagesUsed: evidence.wikiPagesUsed,
  };
}

function bestSource(sources: Set<CapabilitySelectionSource>): CapabilitySelectionSource {
  for (const source of SOURCE_PRIORITY) {
    if (sources.has(source)) return source;
  }
  return "direct_match";
}

function bestReason(reasons: Set<CapabilitySelectionReason>): CapabilitySelectionReason {
  for (const reason of REASON_PRIORITY) {
    if (reasons.has(reason)) return reason;
  }
  return "direct_match";
}

function buildCapabilityMissingEvidence(
  queryMode: QueryMode,
  files: CapabilityEvidenceFile[],
  families: CapabilityFamilies
): string[] {
  if (queryMode === "lookup") return [];
  const missing: string[] = [];
  const paths = files.map((file) => file.filePath).join(" ").toLowerCase();
  if (files.length === 0) {
    missing.push("Capability evidence resolver found no concrete implementation files.");
    return missing;
  }
  if ((families.auth || families.billing || families.generation || families.upload) && files.length < 3) {
    missing.push("Capability evidence covers fewer than three flow files.");
  }
  if (families.auth && !hasAnyLayer(paths, [
    /(?:^|\/)(pages|components|screens|views|routes?|router|layouts?)\//,
    /\b(auth|login|signin|session|provider|context|store|state|guard|protected|callback|redirect|token)\b/,
  ])) {
    missing.push("Authentication flow may still miss UI, routing, or session/state files.");
  }
  if (families.billing && !hasAnyLayer(paths, [
    /(?:^|\/)(pages|components|screens|views)\//,
    /(?:^|\/)(services?|controllers?|handlers?|functions?|api|server|backend)\//,
    /\b(billing|checkout|portal|subscription|invoice|payment|customer|pricing|plan)\b/,
  ])) {
    missing.push("Billing flow may still miss UI, service, or endpoint files.");
  }
  if (families.generation && !/(generation|generate|render|image|asset)/.test(paths)) {
    missing.push("Generation flow may still miss rendering or generation orchestrators.");
  }
  if (families.upload && !hasAnyLayer(paths, [
    /\b(upload|storage|media|bucket|request|signed|write)\b/,
    /(?:^|\/)(_shared|shared|lib|utils?|helpers?|services?|controllers?|handlers?|functions?|api|server|backend)\//,
  ])) {
    missing.push("Upload flow may still miss request auth or storage write helpers.");
  }
  return missing;
}

function hasAnyLayer(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}
