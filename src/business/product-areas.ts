import type { Memory } from "../memory/types.js";
import { slugify, extractSectionText, extractBulletSection, humanizeSlug } from "../core/strings.js";

export type PresentationQuality = "high" | "medium" | "low" | "fallback";

export interface BusinessContextPage {
  name: string;
  capability: string;
  displayName: string;
  summary: string;
  displaySummary: string;
  displayQuality: PresentationQuality;
  presentationSafe: boolean;
  presentationIssues: string[];
  actor: string;
  trigger: string;
  businessTerms: string[];
  userActions: string[];
  businessOutcome: string;
  dataConcepts: string[];
  externalSystems: string[];
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  supportingFiles: string[];
  supportingSymbols: string[];
  technicalEvidence: TechnicalEvidence;
  links: string[];
}

export interface ProductAreaContext {
  id: string;
  name: string;
  displayName: string;
  areaKind: "fixed" | "discovered" | "fallback";
  summary: string;
  displaySummary: string;
  displayQuality: PresentationQuality;
  presentationSafe: boolean;
  presentationIssues: string[];
  businessTerms: string[];
  capabilities: string[];
  businessPages: string[];
  supportingFiles: string[];
  supportingSymbols: string[];
  technicalEvidence: TechnicalEvidence;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
}

export interface TechnicalEvidence {
  files: string[];
  symbols: string[];
}

interface ProductAreaDefinition {
  id: string;
  name: string;
  coreKeywords: string[];
  keywords: string[];
}

/**
 * A discovered candidate must beat the fixed match by this many points to
 * displace it. Matches the existing scoring grain (rankProductAreaMatches
 * uses +3 per core keyword; rankDiscoveredAreaCandidates uses base weights
 * of 1, 2, and 4 with frequency bonuses of +2). Set high enough that a
 * single-token coincidence cannot flip a long-established fixed area.
 */
const DISCOVERED_OVERRIDE_MARGIN = 3;

const PRODUCT_AREA_DEFINITIONS: ProductAreaDefinition[] = [
  { id: "insights", name: "Product Area: Insights", coreKeywords: ["insight", "insights", "analytics", "dashboard", "chart", "report", "reports"], keywords: ["insight", "insights", "analytics", "dashboard", "chart", "metric", "report", "reports", "search", "filter"] },
  { id: "search", name: "Product Area: Search and Filtering", coreKeywords: ["search", "filter", "filters"], keywords: ["search", "filter", "filters", "query", "queries", "sort"] },
  { id: "upload", name: "Product Area: Upload", coreKeywords: ["upload", "uploads"], keywords: ["upload", "uploads", "file", "files", "storage", "bucket"] },
  { id: "import", name: "Product Area: Import", coreKeywords: ["import", "imports", "ingest", "intake"], keywords: ["import", "imports", "ingest", "intake", "normalize", "normalizer", "record", "records", "csv"] },
  { id: "billing", name: "Product Area: Billing", coreKeywords: ["billing", "payment", "checkout", "invoice", "subscription", "pricing", "credit"], keywords: ["billing", "payment", "payments", "checkout", "invoice", "subscription", "pricing", "credit", "credits", "quota"] },
  { id: "auth", name: "Product Area: Authentication", coreKeywords: ["auth", "authentication", "login", "signin", "signup", "session", "oauth"], keywords: ["auth", "authentication", "login", "signin", "signup", "session", "oauth", "credential", "protected"] },
  { id: "workflow", name: "Product Area: Workflows", coreKeywords: ["flow", "workflow", "workflows", "publish", "execution", "execute"], keywords: ["flow", "workflow", "workflows", "publish", "execution", "execute", "step", "steps"] },
  { id: "generation", name: "Product Area: Media Generation", coreKeywords: ["generate", "generation", "image", "video", "render"], keywords: ["generate", "generation", "image", "video", "render", "prompt", "media", "asset"] },
  { id: "messaging", name: "Product Area: Messaging", coreKeywords: ["message", "messages", "chat", "bot", "webhook"], keywords: ["message", "messages", "chat", "bot", "webhook", "telegram", "slack", "discord"] },
  { id: "jobs", name: "Product Area: Jobs", coreKeywords: ["job", "jobs", "queue", "worker"], keywords: ["job", "jobs", "queue", "worker", "poll", "retry", "status", "background"] },
];

const BUSINESS_QUERY_STOP_TERMS = new Set([
  "which", "what", "where", "when", "does", "this", "that", "there", "with", "from",
  "file", "files", "code", "source", "module", "modules", "class", "classes", "function", "functions",
  "implement", "implements", "implemented", "implementation", "using", "used", "show", "list", "find",
  "trace", "explain", "work", "works", "product", "area", "areas", "capability", "capabilities",
]);

const PRODUCT_AREA_GENERIC_TERMS = new Set([
  ...BUSINESS_QUERY_STOP_TERMS,
  "account", "accounts", "action", "actions", "active", "admin", "analytics", "app", "apps",
  "asset", "assets", "background", "bucket", "callback", "channel", "client", "clients",
  "component", "components", "credential", "customer", "customers", "dashboard", "data",
  "edge", "email", "event", "events", "external", "file", "files", "filter", "filters",
  "flow", "flows", "general", "identity", "image", "images", "import", "imports", "inbound",
  "info", "input", "inputs", "integration", "job", "jobs", "login", "media", "message",
  "messages", "object", "operator", "output", "outputs", "page", "pages", "payment",
  "platform", "pricing", "prompt", "protected", "queue", "query", "record", "records",
  "render", "report", "reports", "request", "requests", "response", "result", "results",
  "route", "search", "service", "session", "sessions", "status", "storage", "subscription",
  "surface", "system", "user", "users", "workflow", "workflows",
]);

const GENERIC_PRESENTATION_LABELS = new Set([
  "supporting product behavior",
  "related product behavior",
  "implementation detail",
  "general product behavior",
  "product behavior",
]);

const TECHNICAL_PRESENTATION_TERMS = /\b(?:service|controller|repository|handler|processor|provider|middleware|factory|client|builder|parser)\b/i;

interface DiscoveredAreaCandidate {
  id: string;
  name: string;
  score: number;
  phrase: string;
}

export interface BusinessContext {
  productAreas: ProductAreaContext[];
  businessPages: BusinessContextPage[];
}

export interface MemoryLikeStore {
  getByType(type: "wiki"): Memory[];
}

export function buildBusinessContextFromMemoryStore(memoryStore: MemoryLikeStore): BusinessContext {
  const businessPages = memoryStore
    .getByType("wiki")
    .filter((page) => page.name.startsWith("business-") || page.content.includes("\n## Capability\n"))
    .map(memoryToBusinessPage)
    .filter((page) => page.capability.length > 0);
  return {
    businessPages,
    productAreas: buildProductAreas(businessPages),
  };
}

export function buildProductAreas(businessPages: BusinessContextPage[]): ProductAreaContext[] {
  const grouped = new Map<string, { definition: ProductAreaDefinition; pages: BusinessContextPage[]; score: number }>();
  const discovered = new Map<string, { candidate: DiscoveredAreaCandidate; pages: BusinessContextPage[]; score: number }>();
  const fallback = new Map<string, BusinessContextPage[]>();
  const phraseFrequency = buildDomainPhraseFrequency(businessPages);

  for (const page of businessPages) {
    const matches = rankProductAreaMatches(page);
    const discoveredCandidate = rankDiscoveredAreaCandidates(page, phraseFrequency)[0];
    const fixedMatch = matches[0];

    if (fixedMatch) {
      const useDiscoveredOverride =
        discoveredCandidate != null
        && shouldUseDiscoveredArea(discoveredCandidate, fixedMatch)
        && discoveredCandidate.score >= fixedMatch.score + DISCOVERED_OVERRIDE_MARGIN;

      if (!useDiscoveredOverride) {
        const existing = grouped.get(fixedMatch.definition.id) ?? { definition: fixedMatch.definition, pages: [], score: 0 };
        existing.pages.push(page);
        existing.score += fixedMatch.score;
        grouped.set(fixedMatch.definition.id, existing);
        continue;
      }
    }

    if (discoveredCandidate && shouldUseDiscoveredArea(discoveredCandidate, fixedMatch)) {
      const existing = discovered.get(discoveredCandidate.id) ?? { candidate: discoveredCandidate, pages: [], score: 0 };
      existing.pages.push(page);
      existing.score += discoveredCandidate.score;
      discovered.set(discoveredCandidate.id, existing);
      continue;
    }

    const fallbackName = deriveFallbackProductAreaName(page);
    if (!fallback.has(fallbackName)) fallback.set(fallbackName, []);
    fallback.get(fallbackName)!.push(page);
  }

  const areas: ProductAreaContext[] = [];
  for (const group of grouped.values()) {
    areas.push(toProductArea(group.definition.name, group.definition.id, "fixed", group.pages, group.score));
  }
  for (const group of discovered.values()) {
    areas.push(toProductArea(group.candidate.name, group.candidate.id, "discovered", group.pages, group.score));
  }
  for (const [name, pages] of fallback) {
    areas.push(toProductArea(name, slugify(name), "fallback", pages, pages.length));
  }

  return areas
    .filter((area) => area.businessPages.length > 0)
    .sort((a, b) => {
      if (Number(b.presentationSafe) !== Number(a.presentationSafe)) {
        return Number(b.presentationSafe) - Number(a.presentationSafe);
      }
      if (areaKindPriority(b.areaKind) !== areaKindPriority(a.areaKind)) {
        return areaKindPriority(b.areaKind) - areaKindPriority(a.areaKind);
      }
      if (b.businessPages.length !== a.businessPages.length) return b.businessPages.length - a.businessPages.length;
      return b.confidence - a.confidence;
    });
}

export function queryBusinessContext(
  query: string,
  context: BusinessContext,
  limit = 5
): { productAreas: ProductAreaContext[]; businessPages: BusinessContextPage[] } {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.size === 0) return { productAreas: [], businessPages: [] };
  const productAreas = context.productAreas
    .filter((area) => area.presentationSafe)
    .map((area) => ({ area, score: scoreProductArea(queryTokens, area) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return areaKindPriority(b.area.areaKind) - areaKindPriority(a.area.areaKind);
    })
    .filter(uniqueScoredBy((item) => `${item.area.id}:${normalizePresentationKey(item.area.displayName)}`))
    .slice(0, limit)
    .map((item) => item.area);
  const businessPages = context.businessPages
    .filter((page) => page.presentationSafe)
    .map((page) => ({ page, score: scoreBusinessPage(queryTokens, page) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return presentationQualityPriority(b.page.displayQuality) - presentationQualityPriority(a.page.displayQuality);
    })
    .filter(uniqueScoredBy((item) => normalizePresentationKey(item.page.displayName)))
    .filter(uniqueScoredBy((item) => item.page.name))
    .slice(0, limit)
    .map((item) => item.page);
  return { productAreas, businessPages };
}

export function formatProductAreaContextForPrompt(areas: ProductAreaContext[], maxAreas = 2): string | null {
  const selected = areas.filter((area) => area.presentationSafe).slice(0, maxAreas);
  if (selected.length === 0) return null;
  const lines = ["## Product area evidence"];
  for (const area of selected) {
    const capabilities = area.capabilities.slice(0, 3).join(", ");
    const files = area.supportingFiles.slice(0, 3).join(", ");
    lines.push(`- **Product Area: ${area.displayName}** (${area.confidenceLabel}): ${area.displaySummary}`);
    if (capabilities) lines.push(`  Capabilities: ${capabilities}`);
    if (files) lines.push(`  Evidence files: ${files}`);
  }
  return lines.join("\n");
}

function memoryToBusinessPage(page: Memory): BusinessContextPage {
  const capability = firstNonEmpty(extractSectionText(page.content, "Capability"), humanizeSlug(page.name));
  const summary = page.summary ?? page.description;
  const businessTerms = extractBulletSection(page.content, "Business terms");
  const userActions = extractBulletSection(page.content, "User-visible actions");
  const businessOutcome = firstNonEmpty(extractSectionText(page.content, "Business outcome"), summary);
  const dataConcepts = extractBulletSection(page.content, "Business / Data Concepts");
  const supportingFiles = page.relatedFiles ?? [];
  const supportingSymbols = page.relatedSymbols ?? [];
  const displayName = deriveBusinessDisplayName({
    name: page.name,
    capability,
    businessTerms,
    dataConcepts,
    supportingSymbols,
  });
  const displaySummary = deriveBusinessDisplaySummary({
    displayName,
    summary,
    businessOutcome,
    userActions,
    dataConcepts,
  });
  const presentation = evaluateBusinessPresentation({
    name: page.name,
    capability,
    displayName,
    displaySummary,
    businessTerms,
    userActions,
    businessOutcome,
    dataConcepts,
    supportingSymbols,
    confidence: page.confidence ?? 0,
  });
  return {
    name: page.name,
    capability,
    displayName,
    summary,
    displaySummary,
    ...presentation,
    actor: firstNonEmpty(extractSectionText(page.content, "Actor"), "Product user"),
    trigger: firstNonEmpty(extractSectionText(page.content, "Trigger"), "A request enters this capability."),
    businessTerms,
    userActions,
    businessOutcome,
    dataConcepts,
    externalSystems: extractBulletSection(page.content, "External systems"),
    confidence: page.confidence ?? 0,
    confidenceLabel: (page.confidence ?? 0) >= 0.8 ? "high" : (page.confidence ?? 0) >= 0.68 ? "medium" : "low",
    supportingFiles,
    supportingSymbols,
    technicalEvidence: toTechnicalEvidence(supportingFiles, supportingSymbols),
    links: [],
  };
}

function rankProductAreaMatches(page: BusinessContextPage): Array<{ definition: ProductAreaDefinition; score: number }> {
  const tokens = tokenizeProductAreaAssignmentEvidence(page);
  return PRODUCT_AREA_DEFINITIONS
    .map((definition) => {
      if (
        definition.id === "search"
        && ["insight", "insights", "analytics", "dashboard", "chart", "report", "reports"].some((token) => tokens.has(token))
      ) {
        return { definition, score: 0, coreScore: 0 };
      }
      const coreScore = definition.coreKeywords.reduce((sum, keyword) => sum + (tokens.has(keyword) ? 1 : 0), 0);
      const supportScore = definition.keywords.reduce((sum, keyword) => sum + (tokens.has(keyword) ? 1 : 0), 0);
      if (
        definition.id === "insights" &&
        !hasAny(tokens, ["insight", "insights", "analytics"]) &&
        coreScore < 2
      ) {
        return { definition, score: 0, coreScore: 0 };
      }
      return { definition, score: coreScore * 3 + supportScore, coreScore };
    })
    .filter((match) => match.coreScore > 0 && match.score >= 4)
    .sort((a, b) => b.score - a.score);
}

function tokenizeProductAreaAssignmentEvidence(page: BusinessContextPage): Set<string> {
  return tokenize([
    page.name,
    page.capability,
    page.displayName,
    page.summary,
    page.displaySummary,
    page.businessOutcome,
    ...page.businessTerms,
    ...page.dataConcepts,
  ].join(" "));
}

function tokenizeBusinessPage(page: BusinessContextPage): Set<string> {
  return tokenize([
    page.name,
    page.capability,
    page.displayName,
    page.summary,
    page.displaySummary,
    page.actor,
    page.trigger,
    page.businessOutcome,
    ...page.businessTerms,
    ...page.userActions,
    ...page.dataConcepts,
    ...page.externalSystems,
    ...page.supportingFiles,
    ...page.supportingSymbols,
  ].join(" "));
}

function tokenize(value: string): Set<string> {
  const expanded = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  const tokens = expanded
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length >= 3 || /^[A-Z0-9]{2,}$/.test(token))
    .map((token) => token.toLowerCase());
  return new Set(tokens);
}

function tokenizeQuery(value: string): Set<string> {
  return new Set([...tokenize(value)].filter((token) => !BUSINESS_QUERY_STOP_TERMS.has(token)));
}

function scoreProductArea(queryTokens: Set<string>, area: ProductAreaContext): number {
  const directTokens = tokenize([
    area.name,
    area.displayName,
    area.summary,
    area.displaySummary,
    ...area.businessTerms,
    ...area.capabilities,
    ...area.businessPages,
  ].join(" "));
  const supportTokens = tokenize([
    ...area.supportingFiles,
    ...area.supportingSymbols,
  ].join(" "));

  let score = overlapScore(queryTokens, directTokens);
  score += overlapScore(queryTokens, supportTokens) * 0.25;

  const directExactMatches = exactOverlapCount(queryTokens, directTokens);

  if (area.areaKind === "fixed") score += Math.min(score * 0.2, 2) + directExactMatches * 1.5;
  if (area.areaKind === "discovered") {
    const directOverlap = overlapScore(queryTokens, tokenize([area.name, ...area.businessTerms, ...area.capabilities].join(" ")));
    if (directOverlap > 0) score += Math.min(directOverlap * 0.25, 1);
    else score *= 0.75;
    if (directExactMatches < Math.min(3, queryTokens.size)) score *= 0.75;
  }
  if (area.areaKind === "fallback") score *= 0.7;

  return score;
}

function scoreBusinessPage(queryTokens: Set<string>, page: BusinessContextPage): number {
  return overlapScore(queryTokens, tokenizeBusinessPage(page));
}

function overlapScore(queryTokens: Set<string>, textTokens: Set<string>): number {
  let score = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) score += 2;
    else {
      for (const candidate of textTokens) {
        if (candidate.length >= 4 && token.length >= 4 && (candidate.includes(token) || token.includes(candidate))) {
          score += 0.5;
          break;
        }
      }
    }
  }
  return score;
}

function exactOverlapCount(queryTokens: Set<string>, textTokens: Set<string>): number {
  let count = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) count++;
  }
  return count;
}

function deriveFallbackProductAreaName(page: BusinessContextPage): string {
  const discovered = rankDiscoveredAreaCandidates(page, new Map())[0];
  const source = discovered?.phrase || page.capability || humanizeSlug(page.name);
  const words = source
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length >= 3 && !PRODUCT_AREA_GENERIC_TERMS.has(word.toLowerCase()))
    .slice(0, 3)
    .join(" ");
  return `Product Area: ${words ? titleCase(words) : "General Product"}`;
}

function buildDomainPhraseFrequency(pages: BusinessContextPage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const candidate of collectDomainPhraseCandidates(page)) {
      seen.add(candidate.phrase.toLowerCase());
    }
    for (const phrase of seen) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return counts;
}

function rankDiscoveredAreaCandidates(
  page: BusinessContextPage,
  phraseFrequency: Map<string, number>
): DiscoveredAreaCandidate[] {
  const scores = new Map<string, { phrase: string; score: number }>();
  for (const candidate of collectDomainPhraseCandidates(page)) {
    const key = candidate.phrase.toLowerCase();
    const existing = scores.get(key) ?? { phrase: candidate.phrase, score: 0 };
    existing.score += candidate.weight + Math.min((phraseFrequency.get(key) ?? 1) - 1, 3) * 2;
    scores.set(key, existing);
  }

  return [...scores.values()]
    .filter((candidate) => candidate.score >= 5)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return tokenCount(b.phrase) - tokenCount(a.phrase);
    })
    .map((candidate) => ({
      id: `domain:${slugify(candidate.phrase)}`,
      name: `Product Area: ${titleCase(candidate.phrase)}`,
      score: candidate.score,
      phrase: candidate.phrase,
    }));
}

function shouldUseDiscoveredArea(
  discovered: DiscoveredAreaCandidate,
  fixed: { definition: ProductAreaDefinition; score: number } | undefined
): boolean {
  if (!fixed) return true;
  if (discovered.score >= fixed.score + 2) return true;
  return discovered.score >= 8 && tokenCount(discovered.phrase) >= 2 && fixed.score < 9;
}

function collectDomainPhraseCandidates(page: BusinessContextPage): Array<{ phrase: string; weight: number }> {
  const candidates: Array<{ phrase: string; weight: number }> = [];
  for (const term of page.businessTerms) addDomainCandidate(candidates, term, 4);
  for (const concept of page.dataConcepts) addDomainCandidate(candidates, concept, 4);
  addDomainCandidate(candidates, page.capability, 2);
  addDomainCandidate(candidates, page.businessOutcome, 1);
  for (const action of page.userActions) addDomainCandidate(candidates, action, 1);
  for (const symbol of page.supportingSymbols) {
    const humanized = symbol.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
    addDomainCandidate(candidates, humanized, 1);
  }
  return candidates;
}

function addDomainCandidate(candidates: Array<{ phrase: string; weight: number }>, raw: string, weight: number): void {
  const clean = normalizeDomainPhrase(raw);
  if (!clean) return;
  candidates.push({ phrase: clean, weight });
}

function normalizeDomainPhrase(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const meaningful = words
    .map((word) => word.toLowerCase())
    .filter((word) => (word.length >= 3 || /^[a-z0-9]{2,}$/.test(word)) && !PRODUCT_AREA_GENERIC_TERMS.has(word));
  if (meaningful.length === 0 || meaningful.length > 4) return "";
  if (!meaningful.some((word) => !PRODUCT_AREA_GENERIC_TERMS.has(word))) return "";
  return meaningful.slice(0, 4).join(" ");
}

function tokenCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function areaKindPriority(kind: ProductAreaContext["areaKind"]): number {
  if (kind === "fixed") return 3;
  if (kind === "discovered") return 2;
  return 1;
}

function presentationQualityPriority(quality: PresentationQuality): number {
  if (quality === "high") return 4;
  if (quality === "medium") return 3;
  if (quality === "low") return 2;
  return 1;
}

function normalizePresentationKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueScoredBy<T>(keyFn: (value: T) => string): (value: T) => boolean {
  const seen = new Set<string>();
  return (value) => {
    const key = keyFn(value);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function toProductArea(
  name: string,
  id: string,
  areaKind: ProductAreaContext["areaKind"],
  pages: BusinessContextPage[],
  score: number
): ProductAreaContext {
  const uniquePages = uniqueBy(pages, (page) => page.name);
  const displayName = name.replace(/^Product Area:\s*/i, "");
  const capabilities = unique(uniquePages.map((page) => page.displayName || page.capability)).slice(0, 8);
  const businessTerms = unique(uniquePages.flatMap((page) => page.businessTerms)).slice(0, 10);
  const supportingFiles = unique(uniquePages.flatMap((page) => page.supportingFiles)).slice(0, 12);
  const supportingSymbols = unique(uniquePages.flatMap((page) => page.supportingSymbols)).slice(0, 12);
  const displaySummary = summarizeProductAreaDisplay(displayName, uniquePages);
  const avgConfidence = uniquePages.reduce((sum, page) => sum + page.confidence, 0) / Math.max(1, uniquePages.length);
  const confidence = Math.max(0.55, Math.min(0.94, avgConfidence + Math.min(score * 0.01, 0.08)));
  const presentation = evaluateProductAreaPresentation({
    id,
    name,
    displayName,
    displaySummary,
    areaKind,
    businessTerms,
    capabilities,
    pages: uniquePages,
    confidence,
  });
  return {
    id,
    name,
    displayName,
    areaKind,
    summary: summarizeProductArea(name, capabilities),
    displaySummary,
    ...presentation,
    businessTerms,
    capabilities,
    businessPages: uniquePages.map((page) => page.name),
    supportingFiles,
    supportingSymbols,
    technicalEvidence: toTechnicalEvidence(supportingFiles, supportingSymbols),
    confidence,
    confidenceLabel: confidence >= 0.8 ? "high" : confidence >= 0.68 ? "medium" : "low",
  };
}

function summarizeProductArea(name: string, capabilities: string[]): string {
  const label = name.replace(/^Product Area:\s*/i, "");
  if (capabilities.length === 0) return `${label} groups related product capabilities inferred from code evidence.`;
  return `${label} groups ${capabilities.slice(0, 3).join(", ")}${capabilities.length > 3 ? ", and related capabilities" : ""}.`;
}

function summarizeProductAreaDisplay(label: string, pages: BusinessContextPage[]): string {
  const presentablePages = pages.filter((page) => page.presentationSafe);
  const sourcePages = presentablePages.length > 0 ? presentablePages : pages;
  const capabilities = unique(sourcePages.map((page) => page.displayName || page.capability).filter((value) => !isGenericPresentationLabel(value))).slice(0, 4);
  const outcomes = unique(sourcePages.map((page) => cleanBusinessText(page.businessOutcome)).filter(isUsefulBusinessSentence)).slice(0, 2);
  const actions = unique(sourcePages.flatMap((page) => page.userActions.map(cleanBusinessText)).filter(isUsefulBusinessSentence)).slice(0, 2);
  const concepts = unique(sourcePages.flatMap((page) => page.dataConcepts.map(cleanDisplayTitle)).filter((value) => value && !isGenericPresentationLabel(value))).slice(0, 3);
  if (capabilities.length > 0 && actions.length > 0) {
    return `${label} covers ${capabilities.slice(0, 3).join(", ")} so users can ${lowercaseSentence(actions[0]!)}.`;
  }
  if (capabilities.length > 0 && outcomes.length > 0) {
    return `${label} covers ${capabilities.slice(0, 3).join(", ")}. ${outcomes[0]}`;
  }
  if (capabilities.length > 0) {
    return `${label} covers ${capabilities.slice(0, 3).join(", ")}${capabilities.length > 3 ? ", and related behavior" : ""}.`;
  }
  if (concepts.length > 0) return `${label} covers ${concepts.join(", ")}.`;
  return `${label} groups related product behavior inferred from code evidence.`;
}

interface BusinessDisplayInput {
  name?: string;
  capability: string;
  businessTerms: string[];
  dataConcepts: string[];
  supportingSymbols: string[];
}

export function deriveBusinessDisplayName(input: BusinessDisplayInput): string {
  const raw = firstNonEmpty(input.capability, input.name ? humanizeSlug(input.name) : "");
  if (isTechnicalCapabilityLabel(raw)) return humanizeTechnicalCapability(raw, input);
  return cleanDisplayTitle(raw);
}

export function evaluateBusinessPresentation(input: {
  name: string;
  capability: string;
  displayName: string;
  displaySummary: string;
  businessTerms: string[];
  userActions: string[];
  businessOutcome: string;
  dataConcepts: string[];
  supportingSymbols: string[];
  confidence: number;
}): { displayQuality: PresentationQuality; presentationSafe: boolean; presentationIssues: string[] } {
  const issues: string[] = [];
  const evidenceText = [
    input.name,
    input.capability,
    input.displayName,
    input.displaySummary,
    input.businessOutcome,
    ...input.businessTerms,
    ...input.dataConcepts,
    ...input.supportingSymbols,
  ].join(" ");
  const domainSignals = countDomainSignals([
    input.displayName,
    input.businessOutcome,
    ...input.businessTerms,
    ...input.dataConcepts,
  ]);

  if (isGenericPresentationLabel(input.displayName)) issues.push("generic_display_name");
  if (TECHNICAL_PRESENTATION_TERMS.test(input.displayName)) issues.push("technical_display_name");
  if (/\b(?:backend|frontend):/i.test(input.displayName) || /[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|mdx?|ya?ml)\b/i.test(input.displayName)) {
    issues.push("technical_display_name");
  }
  if (isGenericPresentationSummary(input.displaySummary)) issues.push("generic_display_summary");
  if (domainSignals < 2) issues.push("thin_business_signal");
  if (
    (TECHNICAL_PRESENTATION_TERMS.test(cleanBusinessText(evidenceText)) || isTechnicalCapabilityLabel(input.capability)) &&
    (domainSignals < 2 || input.businessTerms.length + input.dataConcepts.length === 0)
  ) {
    issues.push("technical_evidence_dominates");
  }

  const blocking = issues.some((issue) =>
    issue === "generic_display_name" ||
    issue === "technical_display_name" ||
    issue === "technical_evidence_dominates"
  );
  const displayQuality: PresentationQuality = blocking
    ? "fallback"
    : issues.length === 0 && input.confidence >= 0.8
      ? "high"
      : issues.length <= 1 && domainSignals >= 2
        ? "medium"
        : "low";

  return {
    displayQuality,
    presentationSafe: !blocking && displayQuality !== "fallback",
    presentationIssues: unique(issues),
  };
}

function evaluateProductAreaPresentation(input: {
  id: string;
  name: string;
  displayName: string;
  displaySummary: string;
  areaKind: ProductAreaContext["areaKind"];
  businessTerms: string[];
  capabilities: string[];
  pages: BusinessContextPage[];
  confidence: number;
}): { displayQuality: PresentationQuality; presentationSafe: boolean; presentationIssues: string[] } {
  const issues: string[] = [];
  const safePages = input.pages.filter((page) => page.presentationSafe);
  const domainSignals = countDomainSignals([
    input.displayName,
    input.displaySummary,
    ...input.businessTerms,
    ...input.capabilities,
  ]);

  if (isGenericPresentationLabel(input.displayName)) issues.push("generic_display_name");
  if (isGenericPresentationSummary(input.displaySummary)) issues.push("generic_display_summary");
  if (input.pages.length > 0 && safePages.length === 0) issues.push("no_safe_child_pages");
  if (domainSignals < 2) issues.push("thin_business_signal");
  if (input.areaKind === "fallback") issues.push("fallback_area");

  const blocking = issues.includes("generic_display_name") || issues.includes("no_safe_child_pages");
  const displayQuality: PresentationQuality = blocking
    ? "fallback"
    : input.areaKind === "fixed" && issues.length <= 1 && input.confidence >= 0.68
      ? "high"
      : input.areaKind === "discovered" && issues.length <= 1
        ? "medium"
        : issues.length <= 2 && safePages.length > 0
          ? "low"
          : "fallback";

  return {
    displayQuality,
    presentationSafe: !blocking && displayQuality !== "fallback",
    presentationIssues: unique(issues),
  };
}

function deriveBusinessDisplaySummary(input: {
  displayName: string;
  summary: string;
  businessOutcome: string;
  userActions: string[];
  dataConcepts: string[];
}): string {
  const outcome = cleanBusinessText(input.businessOutcome);
  if (isUsefulBusinessSentence(outcome)) return `${input.displayName}: ${outcome}`;
  const action = input.userActions.map(cleanBusinessText).find(isUsefulBusinessSentence);
  if (action) return `${input.displayName}: Users can ${lowercaseSentence(action)}.`;
  const summary = cleanBusinessText(input.summary);
  if (isUsefulBusinessSentence(summary)) return summary;
  const concepts = input.dataConcepts.map(cleanDisplayTitle).filter(Boolean).slice(0, 3);
  if (concepts.length > 0) return `${input.displayName}: Supports ${concepts.join(", ")}.`;
  return `${input.displayName}: Product behavior inferred from code evidence.`;
}

function isTechnicalCapabilityLabel(value: string): boolean {
  return /\b(?:backend|frontend):/i.test(value)
    || /`[^`]+`/.test(value)
    || /\b(?:service|controller|repository|handler|processor|provider|middleware|modal|store|query|string|parser|builder|factory|client)\b/i.test(splitTechnicalWords(value))
    || /[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]+/.test(value)
    || /\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|mdx?|ya?ml)\b/i.test(value);
}

function humanizeTechnicalCapability(value: string, input: BusinessDisplayInput): string {
  const evidence = tokenize([
    value,
    ...input.businessTerms,
    ...input.dataConcepts,
    ...input.supportingSymbols.map(splitTechnicalWords),
  ].join(" "));

  if (hasAny(evidence, ["insight", "insights"]) && hasAny(evidence, ["query", "filter", "filters", "pivot", "search", "state"])) {
    return "Insights filtering and pivot views";
  }
  if (hasAny(evidence, ["insight", "insights", "analytics"]) && hasAny(evidence, ["dashboard", "chart", "charts", "report", "reports", "metric", "metrics"])) {
    return "Analytics dashboard behavior";
  }
  if (hasAny(evidence, ["classification", "classify", "score", "scoring", "risk", "rank", "ranking"])) {
    return "Classification and scoring behavior";
  }
  if (hasAny(evidence, ["upload", "uploads", "import", "imports", "file", "files", "storage", "intake"])) {
    return "Upload and import behavior";
  }
  if (hasAny(evidence, ["account", "accounts", "user", "users", "organization", "organizations", "role", "roles", "member", "members"])) {
    return "Account and user management";
  }
  if (hasAny(evidence, ["billing", "payment", "payments", "subscription", "checkout", "invoice", "pricing", "credit", "credits"])) {
    return "Billing and subscription behavior";
  }
  if (hasAny(evidence, ["auth", "authentication", "login", "signin", "signup", "session", "oauth", "credential", "credentials"])) {
    return "Authentication and session behavior";
  }
  if (hasAny(evidence, ["workflow", "workflows", "flow", "step", "steps", "template", "mapping", "configuration"])) {
    return "Workflow configuration behavior";
  }

  const phrase = firstDomainPhrase(input.businessTerms, input.dataConcepts);
  return phrase ? `${phrase} behavior` : fallbackBusinessDisplayName(value, input);
}

function firstDomainPhrase(businessTerms: string[], dataConcepts: string[]): string {
  for (const value of [...businessTerms, ...dataConcepts]) {
    const cleaned = cleanDisplayTitle(value);
    const tokenized = tokenize(cleaned);
    if (cleaned && [...tokenized].some((token) => !PRODUCT_AREA_GENERIC_TERMS.has(token))) return cleaned;
  }
  return "";
}

function fallbackBusinessDisplayName(value: string, input: BusinessDisplayInput): string {
  const candidates = [
    input.name ? humanizeSlug(input.name) : "",
    value,
    ...input.supportingSymbols.map(splitTechnicalWords),
  ];
  for (const candidate of candidates) {
    const phrase = normalizeDisplayPhrase(candidate);
    if (phrase) return `${titleCase(phrase)} behavior`;
  }
  return "General product behavior";
}

function normalizeDisplayPhrase(raw: string): string {
  const words = splitTechnicalWords(raw)
    .replace(/^business\s+/i, "")
    .replace(/\b(?:backend|frontend)\b/gi, " ")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) =>
      (word.length >= 3 || /^[a-z0-9]{2,}$/.test(word)) &&
      !PRODUCT_AREA_GENERIC_TERMS.has(word) &&
      !["business", "supporting", "related", "behavior", "general"].includes(word)
    );
  const uniqueWords = unique(words).slice(0, 4);
  if (uniqueWords.length === 0) return "";
  return uniqueWords.join(" ");
}

function isGenericPresentationLabel(value: string): boolean {
  return GENERIC_PRESENTATION_LABELS.has(value.trim().toLowerCase());
}

function isGenericPresentationSummary(value: string): boolean {
  const cleaned = value.trim().toLowerCase();
  return cleaned.length === 0
    || /^.+:\s*product behavior inferred from code evidence\.?$/.test(cleaned)
    || /^.+\s+groups related product behavior inferred from code evidence\.?$/.test(cleaned)
    || /^.+:\s*the product completes the capability\.?$/.test(cleaned);
}

function countDomainSignals(values: string[]): number {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of tokenize(value)) {
      if (!PRODUCT_AREA_GENERIC_TERMS.has(token) && !GENERIC_PRESENTATION_LABELS.has(token)) tokens.add(token);
    }
  }
  return tokens.size;
}

function cleanDisplayTitle(value: string): string {
  const cleaned = cleanBusinessText(value)
    .replace(/^Product Area:\s*/i, "")
    .replace(/\b(?:backend|frontend):\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return titleCase(splitTechnicalWords(cleaned));
}

function cleanBusinessText(value: string): string {
  return splitTechnicalWords(value)
    .replace(/`[^`\s]*\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|mdx?|ya?ml)(?::\d+(?:-\d+)?)?`/gi, "the product implementation")
    .replace(/\b(?:src|apps|packages|backend|frontend)\/[A-Za-z0-9_./-]+/gi, "the product implementation")
    .replace(/\b(?:backend|frontend):\s*/gi, "")
    .replace(/\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|json|mdx?|ya?ml)\b/gi, "the product implementation")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTechnicalWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
}

function isUsefulBusinessSentence(value: string): boolean {
  if (!value) return false;
  if (/^(supporting product behavior|related product behavior|general product behavior|implementation detail)\.?$/i.test(value)) return false;
  return !/\b(?:service|controller|repository|handler|processor)\b/i.test(value);
}

function lowercaseSentence(value: string): string {
  if (!value) return value;
  return `${value[0]!.toLowerCase()}${value.slice(1).replace(/\.$/, "")}`;
}

function hasAny(tokens: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.has(candidate));
}

function toTechnicalEvidence(files: string[], symbols: string[]): TechnicalEvidence {
  return {
    files: unique(files),
    symbols: unique(symbols),
  };
}

function firstNonEmpty(primary: string, fallback: string): string {
  return primary.trim() || fallback;
}

function titleCase(input: string): string {
  const smallWords = new Set(["and", "or", "of", "for", "to", "in", "on", "with"]);
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      if (!part[0]) return part;
      if (index > 0 && smallWords.has(part.toLowerCase())) return part.toLowerCase();
      if (part.length === 2 || /\d/.test(part)) return part.toUpperCase();
      return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
