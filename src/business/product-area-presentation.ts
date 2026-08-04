import { humanizeSlug } from "../core/strings.js";
import { PRODUCT_AREA_GENERIC_TERMS, tokenize } from "./product-area-language.js";
import type { BusinessContextPage, PresentationQuality, ProductAreaContext, TechnicalEvidence } from "./product-area-types.js";
const GENERIC_PRESENTATION_LABELS = new Set([
  "supporting product behavior",
  "related product behavior",
  "implementation detail",
  "general product behavior",
  "product behavior",
]);

const TECHNICAL_PRESENTATION_TERMS = /\b(?:service|controller|repository|handler|processor|provider|middleware|factory|client|builder|parser)\b/i;

export function summarizeProductArea(name: string, capabilities: string[]): string {
  const label = name.replace(/^Product Area:\s*/i, "");
  if (capabilities.length === 0) return `${label} groups related product capabilities inferred from code evidence.`;
  return `${label} groups ${capabilities.slice(0, 3).join(", ")}${capabilities.length > 3 ? ", and related capabilities" : ""}.`;
}

export function summarizeProductAreaDisplay(label: string, pages: BusinessContextPage[]): string {
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

export function evaluateProductAreaPresentation(input: {
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

export function deriveBusinessDisplaySummary(input: {
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
  // Note: deliberately NOT matching bare camelCase identifiers. The word-boundary
  // technical-suffix check below already catches genuine technical camelCase
  // (e.g. "orderService" -> "order Service" -> "service"); a generic camelCase
  // pattern would false-positive on legitimate business names like "productId".
  return /\b(?:backend|frontend):/i.test(value)
    || /`[^`]+`/.test(value)
    || /\b(?:service|controller|repository|handler|processor|provider|middleware|modal|store|query|string|parser|builder|factory|client)\b/i.test(splitTechnicalWords(value))
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
    // tokenize() yields single lowercase words, so a per-token membership test
    // against the multi-word GENERIC_PRESENTATION_LABELS could never match.
    // Guard at the whole-value level instead: a value that is itself a generic
    // presentation label contributes no domain signal.
    if (isGenericPresentationLabel(value)) continue;
    for (const token of tokenize(value)) {
      if (!PRODUCT_AREA_GENERIC_TERMS.has(token)) tokens.add(token);
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

export function hasAny(tokens: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => tokens.has(candidate));
}

export function toTechnicalEvidence(files: string[], symbols: string[]): TechnicalEvidence {
  return {
    files: unique(files),
    symbols: unique(symbols),
  };
}

export function firstNonEmpty(primary: string, fallback: string): string {
  return primary.trim() || fallback;
}

export function titleCase(input: string): string {
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

export function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function uniqueBy<T>(values: T[], keyFn: (value: T) => string): T[] {
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
