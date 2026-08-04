import { basename } from "path";
import type { CommunityRecord, GodNodeRecord, SurpriseRecord } from "../storage/metadata-store.js";
import { slugify } from "../core/strings.js";
import { buildBusinessSafeEvidenceLines, shortOutcome } from "./business-evidence.js";

export interface BusinessCommunityMember {
  name: string;
  filePath: string;
  kind: string;
  startLine?: number;
  endLine?: number;
}

export interface BusinessPageDraft {
  slug: string;
  title: string;
  description: string;
  summary: string;
  content: string;
  relatedFiles: string[];
  relatedSymbols: string[];
  businessTerms: string[];
  userActions: string[];
  dataConcepts: string[];
  externalSystems: string[];
  links: string[];
  confidence: number;
}

interface BusinessCommunitySource {
  community: CommunityRecord;
  members: BusinessCommunityMember[];
  hubs: GodNodeRecord[];
  surprises: SurpriseRecord[];
}

interface CapabilityFamily {
  id: string;
  title: string;
  actor: string;
  trigger: string;
  outcome: string;
  /** Strict tokens (exact match, post-camelCase-split). Count-distinct >=3 or >=1 + path hint. */
  keywords: string[];
  /** Directory / filename tokens that indicate the family is organised as its own surface. */
  pathHints: string[];
}

interface FamilyMatch {
  family: CapabilityFamily;
  distinctKeywordMatches: number;
  hasPathHint: boolean;
}

// Noise tokens that must not contribute to family matching or narrative derivation.
// Keep this list reserved for genuinely generic engineering nouns — domain tokens like
// "workflow" belong in a capability family, not here.
const GENERIC_TOKENS = new Set([
  "src", "lib", "app", "server", "api", "utils", "helper", "helpers", "index",
  "component", "components", "page", "pages", "service", "services", "handler",
  "handlers", "core", "common", "types", "client", "clients", "provider",
  "providers", "model", "models", "route", "routes", "controller", "controllers",
  "command", "commands", "module", "modules",
]);

const TECHNICAL_TITLE_TOKENS = new Set([
  "adapter", "api", "builder", "build", "class", "client", "command", "config",
  "component", "controller", "dialog", "factory", "formatter", "form", "handler", "helper", "helpers", "impl",
  "implementation", "index", "mapper", "module", "orchestration", "orchestrator",
  "modal", "page", "parser", "processor", "provider", "query", "repository", "request", "response",
  "router", "schema", "screen", "service", "services", "store", "string", "type", "types",
  "util", "utils", "validator",
]);

const PRODUCT_TERMS = new Set([
  "account", "analytics", "asset", "billing", "checkout", "client", "customer",
  "dashboard", "file", "flow", "import", "insight", "insights", "invoice", "job",
  "media", "message", "notification", "payment", "pricing", "report", "reports",
  "search", "session", "subscription", "upload", "user", "workflow",
]);

const CAPABILITY_FAMILIES: CapabilityFamily[] = [
  {
    id: "auth",
    title: "User Authentication",
    actor: "Authenticated user or OAuth client",
    trigger: "A login, signup, callback, or session refresh request enters the system.",
    outcome: "The product decides whether a person or client can enter the protected experience and what session state should be established next.",
    keywords: ["auth", "login", "signup", "signin", "signout", "session", "oauth", "callback", "password", "credential", "protected"],
    pathHints: ["auth", "authentication", "authorization", "login", "signup", "signin", "signout", "session", "identity", "oauth"],
  },
  {
    id: "generation",
    title: "Media Generation Request",
    actor: "Product user requesting generated output",
    trigger: "A prompt, asset, or generation request is submitted through the app or an API edge function.",
    outcome: "The product turns a request into generated media, tracks status, and returns a result the user can consume.",
    keywords: ["generate", "generation", "image", "video", "media", "prompt", "render", "upscale", "asset"],
    pathHints: ["generate", "generation", "media", "render", "image", "images", "video", "videos", "asset", "assets"],
  },
  {
    id: "flow",
    title: "Published Flow Execution",
    actor: "Creator or end user running a saved workflow",
    trigger: "A workflow is created, published, executed, or resumed from a product surface.",
    outcome: "The product turns a configured flow into a runnable experience and coordinates the steps needed to complete it.",
    keywords: ["flow", "workflow", "workflows", "publish", "published", "execution", "execute", "editor"],
    pathHints: ["flow", "flows", "workflow", "workflows", "pipeline", "pipelines", "editor", "execution"],
  },
  {
    id: "bot",
    title: "Bot and Messaging Operations",
    actor: "Chat user or external messaging platform",
    trigger: "A bot command, webhook, or inbound message arrives from an external channel.",
    outcome: "The product interprets the inbound command, dispatches it to the right capability, and responds through the external channel.",
    keywords: ["bot", "telegram", "message", "webhook", "chat", "slack", "discord"],
    pathHints: ["bot", "bots", "chat", "chats", "telegram", "discord", "slack", "webhook", "webhooks", "messaging"],
  },
  {
    id: "billing",
    title: "Credits, Billing, and Pricing",
    actor: "Paying user or billing subsystem",
    trigger: "A purchase, pricing lookup, credit deduction, or quota check happens before work is allowed to continue.",
    outcome: "The product decides whether expensive actions can proceed and keeps commercial state aligned with usage.",
    keywords: ["credit", "credits", "billing", "pricing", "subscription", "quota", "balance", "payment", "invoice", "stripe", "checkout"],
    pathHints: ["billing", "payment", "payments", "credit", "credits", "subscription", "subscriptions", "checkout", "pricing", "invoice", "invoices", "stripe"],
  },
  {
    id: "jobs",
    title: "Async Job Tracking",
    actor: "Background worker or polling client",
    trigger: "A long-running job is queued, polled, retried, or marked complete.",
    outcome: "The product keeps asynchronous work observable and exposes status updates back to the requesting surface.",
    keywords: ["job", "jobs", "queue", "worker", "workers", "poll", "retry"],
    pathHints: ["job", "jobs", "queue", "queues", "worker", "workers", "background"],
  },
];

export function buildBusinessPages(
  sources: BusinessCommunitySource[],
  maxPages: number
): BusinessPageDraft[] {
  const pages: BusinessPageDraft[] = [];

  pages.push(...buildAggregateCapabilityPages(sources));

  for (const source of sources) {
    if (pages.length >= maxPages) break;
    if (!shouldGenerateBusinessPage(source.community.label)) continue;
    if (source.members.length === 0) continue;

    const effectiveMembers = filterBusinessMembers(source.members);
    const effectiveHubs = filterBusinessHubs(source.hubs);
    if (effectiveMembers.length === 0 && effectiveHubs.length === 0) continue;
    const narrowed: BusinessCommunitySource = { ...source, members: effectiveMembers, hubs: effectiveHubs };

    const terms = collectTerms(narrowed);
    const pathTokens = collectPathTokens(narrowed);
    const match = selectFamily(terms, pathTokens);
    const family = match?.family ?? null;

    const title = family?.title ?? deriveGenericTitle(source.community.label, effectiveMembers, terms);
    const actor = family?.actor ?? deriveGenericActor(terms);
    const trigger = family?.trigger ?? deriveGenericTrigger(title, effectiveMembers);
    const outcome = family?.outcome ?? deriveGenericOutcome(title, effectiveMembers);
    const decisionPoints = deriveDecisionPoints(terms, title);
    const sideEffects = deriveSideEffects(terms, title);
    const businessTerms = deriveBusinessTerms(terms, title);
    const userActions = deriveUserActions(terms, title);
    const dataConcepts = deriveDataConcepts(terms, title);
    const externalSystems = deriveExternalSystems(terms);
    const confidence = deriveConfidence(narrowed, match);
    const confidenceNote = confidence >= 0.8
      ? "High confidence: the capability framing is strongly supported by filenames, symbols, and graph structure."
      : confidence >= 0.68
        ? "Medium confidence: the capability framing is likely correct, but some supporting evidence is inferred from naming patterns."
        : "Low confidence: this is a bounded business interpretation of the supporting code, not a definitive product spec.";

    const communitySlug = source.community.label ? `community-${slugify(source.community.label)}` : null;
    const hubLinks = effectiveHubs.slice(0, 3).map((hub) => `hub-${slugify(hub.name)}`);
    const links = [communitySlug, ...hubLinks].filter((value): value is string => !!value);
    const relatedFiles = unique(
      effectiveMembers
        .map((member) => member.filePath)
        .filter((filePath) => !isLowSignalFile(filePath))
    ).slice(0, 8);
    const relatedSymbols = unique([
      ...effectiveMembers.map((member) => member.name),
      ...effectiveHubs.map((hub) => hub.name),
    ].filter((symbol) => !isLowSignalSymbol(symbol))).slice(0, 12);
    const evidenceLines = buildBusinessSafeEvidenceLines({
      nodeCount: source.community.nodeCount,
      cohesion: source.community.cohesion,
      relatedFiles,
      relatedSymbols,
    });

    if (source.surprises.length > 0) {
      const bridgeClause = source.surprises.length === 1 ? "bridge connects" : "bridges connect";
      evidenceLines.push(
        `- **Cross-boundary pressure:** ${source.surprises.length} surprising ${bridgeClause} this capability to distant subsystems.`
      );
    }

    const content = [
      `## Capability`,
      title,
      "",
      "## Actor",
      actor,
      "",
      "## Trigger",
      trigger,
      "",
      "## Business terms",
      ...businessTerms.map((line) => `- ${line}`),
      "",
      "## User-visible actions",
      ...userActions.map((line) => `- ${line}`),
      "",
      "## Key decision points",
      ...decisionPoints.map((line) => `- ${line}`),
      "",
      "## State changes and side effects",
      ...sideEffects.map((line) => `- ${line}`),
      "",
      "## Business outcome",
      outcome,
      "",
      "## Business / Data Concepts",
      ...dataConcepts.map((line) => `- ${line}`),
      "",
      ...(externalSystems.length > 0
        ? ["## External systems", ...externalSystems.map((line) => `- ${line}`), ""]
        : []),
      "## Evidence quality",
      ...evidenceLines,
      "",
      "## Confidence",
      confidenceNote,
    ].join("\n");

    pages.push({
      slug: `business-${slugify(title)}`,
      title,
      description: `Business capability view for ${title.toLowerCase()}`,
      summary: `${title} — ${shortOutcome(outcome)}`,
      content,
      relatedFiles,
      relatedSymbols,
      businessTerms,
      userActions,
      dataConcepts,
      externalSystems,
      links,
      confidence,
    });
  }

  return dedupeBySlug(pages);
}

function buildAggregateCapabilityPages(sources: BusinessCommunitySource[]): BusinessPageDraft[] {
  const pages: BusinessPageDraft[] = [];
  const effectiveSources = sources
    .map((source) => ({
      source,
      members: filterBusinessMembers(source.members),
      hubs: filterBusinessHubs(source.hubs),
    }))
    .filter((entry) => entry.members.length > 0 || entry.hubs.length > 0);

  for (const family of CAPABILITY_FAMILIES) {
    const members: BusinessCommunityMember[] = [];
    const hubs: GodNodeRecord[] = [];
    const communityLinks: string[] = [];
    const surprises: SurpriseRecord[] = [];

    for (const entry of effectiveSources) {
      const matchingMembers = entry.members.filter((member) => matchesFamilyEvidence(family, member.name, member.filePath));
      const matchingHubs = entry.hubs.filter((hub) => matchesFamilyEvidence(family, hub.name, hub.filePath));
      if (matchingMembers.length === 0 && matchingHubs.length === 0) continue;
      members.push(...matchingMembers);
      hubs.push(...matchingHubs);
      surprises.push(...entry.source.surprises);
      if (entry.source.community.label) {
        communityLinks.push(`community-${slugify(entry.source.community.label)}`);
      }
    }

    const relatedFiles = unique(
      members
        .sort((a, b) => scoreFamilyEvidence(family, b.name, b.filePath) - scoreFamilyEvidence(family, a.name, a.filePath))
        .map((member) => member.filePath)
        .filter((filePath) => !isLowSignalFile(filePath))
    ).slice(0, 8);
    const relatedSymbols = unique([
      ...members
        .sort((a, b) => scoreFamilyEvidence(family, b.name, b.filePath) - scoreFamilyEvidence(family, a.name, a.filePath))
        .map((member) => member.name),
      ...hubs.map((hub) => hub.name),
    ].filter((symbol) => !isLowSignalSymbol(symbol))).slice(0, 12);

    if (relatedFiles.length < 2 && relatedSymbols.length < 2) continue;

    const terms = new Set<string>();
    for (const member of members) addTokensTo(terms, `${member.name} ${member.filePath}`);
    for (const hub of hubs) addTokensTo(terms, `${hub.name} ${hub.filePath}`);
    const decisionPoints = deriveDecisionPoints(terms, family.title);
    const sideEffects = deriveSideEffects(terms, family.title);
    const businessTerms = deriveBusinessTerms(terms, family.title);
    const userActions = deriveUserActions(terms, family.title);
    const dataConcepts = deriveDataConcepts(terms, family.title);
    const externalSystems = deriveExternalSystems(terms);
    const confidence = Math.min(0.94, 0.78 + Math.min(relatedFiles.length * 0.015, 0.08) + Math.min(relatedSymbols.length * 0.01, 0.05));
    const confidenceNote = confidence >= 0.8
      ? "High confidence: this capability page is aggregated across matching filenames, symbols, and graph communities."
      : "Medium confidence: this capability page is aggregated from naming and graph evidence.";
    const links = unique(communityLinks).slice(0, 4);
    const evidenceLines = buildBusinessSafeEvidenceLines({
      nodeCount: members.length + hubs.length,
      relatedFiles,
      relatedSymbols,
      linkedCommunities: links.length,
    });

    if (surprises.length > 0) {
      evidenceLines.push(
        `- **Cross-boundary pressure:** ${surprises.length} surprising bridge${surprises.length === 1 ? "" : "s"} connect this capability to distant subsystems.`
      );
    }

    const content = [
      "## Capability",
      family.title,
      "",
      "## Actor",
      family.actor,
      "",
      "## Trigger",
      family.trigger,
      "",
      "## Business terms",
      ...businessTerms.map((line) => `- ${line}`),
      "",
      "## User-visible actions",
      ...userActions.map((line) => `- ${line}`),
      "",
      "## Key decision points",
      ...decisionPoints.map((line) => `- ${line}`),
      "",
      "## State changes and side effects",
      ...sideEffects.map((line) => `- ${line}`),
      "",
      "## Business outcome",
      family.outcome,
      "",
      "## Business / Data Concepts",
      ...dataConcepts.map((line) => `- ${line}`),
      "",
      ...(externalSystems.length > 0
        ? ["## External systems", ...externalSystems.map((line) => `- ${line}`), ""]
        : []),
      "## Evidence quality",
      ...evidenceLines,
      "",
      "## Confidence",
      confidenceNote,
    ].join("\n");

    pages.push({
      slug: `business-${slugify(family.title)}`,
      title: family.title,
      description: `Business capability view for ${family.title.toLowerCase()}`,
      summary: `${family.title} — ${shortOutcome(family.outcome)}`,
      content,
      relatedFiles,
      relatedSymbols,
      businessTerms,
      userActions,
      dataConcepts,
      externalSystems,
      links,
      confidence,
    });
  }

  return pages;
}

function matchesFamilyEvidence(family: CapabilityFamily, symbol: string, filePath: string): boolean {
  return scoreFamilyEvidence(family, symbol, filePath) >= 12;
}

function scoreFamilyEvidence(family: CapabilityFamily, symbol: string, filePath: string): number {
  const terms = new Set<string>();
  addTokensTo(terms, `${symbol} ${filePath}`);
  const evidenceText = `${symbol} ${filePath}`.toLowerCase();
  let score = 0;
  for (const keyword of family.keywords) {
    if (terms.has(keyword)) score += 6;
  }
  const pathTerms = new Set<string>();
  for (const segment of filePath.split("/")) addTokensTo(pathTerms, segment);
  for (const hint of family.pathHints) {
    if (pathTerms.has(hint)) score += 10;
  }
  if (family.id === "auth") {
    // Claude Code hook lifecycle filenames (kebab-case, well-defined event names)
    // are tool infrastructure — they mention "session"/"prompt"/etc. in passing
    // but are never user-authentication code. Anchored on lifecycle filenames so
    // downstream React `src/hooks/useAuth.tsx` files still classify correctly.
    const isClaudeHookFile = /\/hooks\/(session-start|pre-tool-use|post-tool-use|user-prompt-submit|prompt-context|stop|subagent-stop|notification)\b/i.test(filePath);
    if (!isClaudeHookFile && /\/hooks?\//i.test(filePath) && /\b(auth|session|login|signin|oauth|credential)\b/i.test(evidenceText)) score += 18;
    if (/\b(modal|form|dialog|screen|page|route|guard|callback|protected)\b/i.test(evidenceText) && /\b(auth|login|signin|session|oauth)\b/i.test(evidenceText)) score += 16;
    if (/\b(client|adapter|provider|context|store)\b/i.test(evidenceText) && /\b(auth|session|token|oauth|identity)\b/i.test(evidenceText)) score += 12;
    if (isClaudeHookFile || /(mcp-server|cli\/|e2e|tests?|spec|mock|\/indexer\/|\/search\/|\/business\/|\/wiki\/)/i.test(filePath)) score -= 18;
  }
  if (family.id === "billing") {
    if (/\b(service|client|adapter|controller|handler|webhook)\b/i.test(evidenceText) && /\b(billing|payment|stripe|checkout|subscription|invoice|credit)\b/i.test(evidenceText)) score += 18;
    if (/\b(page|screen|component|modal|form|portal)\b/i.test(evidenceText) && /\b(billing|pricing|checkout|subscription|invoice|credit)\b/i.test(evidenceText)) score += 16;
    if (/\b(ledger|balance|quota|price|plan)\b/i.test(evidenceText)) score += 10;
  }
  if (family.id === "generation") {
    if (/\b(function|handler|controller|service|worker|pipeline)\b/i.test(evidenceText) && /\b(generate|generation|render|image|video|media|asset)\b/i.test(evidenceText)) score += 18;
    if (/\b(flow|workflow|editor|component|page|screen)\b/i.test(evidenceText) && /\b(image|video|media|asset|prompt|render)\b/i.test(evidenceText)) score += 14;
    if (/\b(prompt|upscale|transform|asset)\b/i.test(evidenceText)) score += 8;
  }
  return score;
}

function shouldGenerateBusinessPage(label: string | null): boolean {
  if (!label) return true;
  const normalized = label.toLowerCase();
  return !normalized.startsWith("test:") && !normalized.startsWith("scripts:");
}

/**
 * Extract strict, exact-match-safe tokens from a community. Splits camelCase so
 * identifiers like `handleAuthCallback` yield the discrete tokens `handle`,
 * `auth`, `callback`. Used by the family matcher (exact-token lookup) and by
 * narrative helpers (substring fallback through `hasAny`).
 */
function collectTerms(source: BusinessCommunitySource): Set<string> {
  const set = new Set<string>();
  const raw = [
    source.community.label ?? "",
    ...source.members.flatMap((member) => [member.name, member.filePath, basename(member.filePath)]),
    ...source.hubs.flatMap((hub) => [hub.name, hub.filePath]),
  ];
  for (const value of raw) {
    addTokensTo(set, value);
  }
  return set;
}

/**
 * Extract tokens from directory + filename segments only (not symbol names),
 * used to gate high-confidence family matches behind folder-structure evidence.
 */
function collectPathTokens(source: BusinessCommunitySource): Set<string> {
  const set = new Set<string>();
  const files = unique([
    ...source.members.map((m) => m.filePath),
    ...source.hubs.map((h) => h.filePath),
  ]);
  for (const file of files) {
    const parts = file.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      // Strip the extension from the final segment before tokenising.
      const seg = isLast ? parts[i]!.replace(/\.[^.]+$/, "") : parts[i]!;
      addTokensTo(set, seg);
    }
  }
  return set;
}

function addTokensTo(set: Set<string>, value: string): void {
  // 1. lowerCase → UPPERCASE boundary: handleAuth → handle Auth
  // 2. ACRONYM → Word boundary: XMLParser → XML Parser
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  for (const part of normalized.split(/[^a-z0-9]+/)) {
    const trimmed = part.trim();
    if (trimmed.length >= 3 && !GENERIC_TOKENS.has(trimmed)) {
      set.add(trimmed);
    }
  }
}

function filterBusinessMembers(members: BusinessCommunityMember[]): BusinessCommunityMember[] {
  return members.filter((member) =>
    !isLowSignalFile(member.filePath)
    && !isMetadataFile(member.filePath)
    && !isLowSignalSymbol(member.name)
  );
}

function filterBusinessHubs(hubs: GodNodeRecord[]): GodNodeRecord[] {
  return hubs.filter((hub) =>
    !isLowSignalFile(hub.filePath)
    && !isMetadataFile(hub.filePath)
    && !isLowSignalSymbol(hub.name)
  );
}

/**
 * Select the best-matching capability family for a community.
 *
 * A family qualifies iff:
 *   1. a path hint matches (folder/file naming corroborates the family) AND
 *      at least 2 distinct exact keyword matches exist, OR
 *   2. at least 3 *distinct* exact keyword matches exist (fallback for
 *      flat-layout codebases without folder conventions).
 *
 * The >=2 threshold for path-hint matches prevents a single ambiguous token
 * (e.g. "session" meaning CLI-session, not auth-session) from acting as both
 * the path hint and sole keyword evidence.
 *
 * Path-hint-backed matches always beat keyword-only matches in ranking.
 */
function selectFamily(terms: Set<string>, pathTokens: Set<string>): FamilyMatch | null {
  let best: FamilyMatch | null = null;
  let bestStrength = 0;

  for (const family of CAPABILITY_FAMILIES) {
    const distinctKeywordMatches = family.keywords.filter((kw) => terms.has(kw)).length;
    const hasPathHint = family.pathHints.some((hint) => pathTokens.has(hint));

    const qualifies =
      (hasPathHint && distinctKeywordMatches >= 2)
      || distinctKeywordMatches >= 3;
    if (!qualifies) continue;

    // Path-hint bonus must dominate keyword count so an evidence-backed match
    // always outranks a keyword-only one regardless of token spread.
    const strength = distinctKeywordMatches + (hasPathHint ? 10 : 0);
    if (strength > bestStrength) {
      best = { family, distinctKeywordMatches, hasPathHint };
      bestStrength = strength;
    }
  }

  return best;
}

function deriveGenericTitle(label: string | null, members: BusinessCommunityMember[], terms: Set<string>): string {
  const productTitle = deriveProductTitle(terms);
  if (productTitle) return productTitle;

  const cleanedLabel = cleanBusinessLabel(label ?? "");
  if (cleanedLabel && !isMostlyTechnicalLabel(cleanedLabel)) {
    return titleCase(cleanedLabel);
  }

  const firstFile = members[0]?.filePath ?? "";
  const parts = firstFile.split("/").filter(Boolean);
  const anchor = parts.length >= 2 ? parts[parts.length - 2] : basename(firstFile, ".ts");
  const cleanedAnchor = cleanBusinessLabel(anchor || "core");
  if (cleanedAnchor && !isMostlyTechnicalLabel(cleanedAnchor)) {
    return `${titleCase(cleanedAnchor)} Capability`;
  }
  return "Product Workflow Coordination";
}

function cleanBusinessLabel(label: string): string {
  const cleaned = label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/^\s*(?:[A-Za-z0-9]+\s+)?(?:backend|frontend)\s*:\s*/i, "")
    .replace(/^[a-z]+:\s*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b(service|controller|handler|builder|query|string|orchestration|orchestrator|processor|adapter|client|repository|module|utils?|helpers?|modal|dialog|component|screen|page|form)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function deriveProductTitle(terms: Set<string>): string | null {
  if (hasAny(terms, ["user", "users", "account", "accounts", "role", "roles", "member", "members"])) {
    return "Account and User Management";
  }
  if (hasAny(terms, ["insight", "insights"])) {
    if (hasAny(terms, ["query", "search", "filter", "string"])) return "Insights Search and Filtering";
    if (hasAny(terms, ["report", "dashboard", "analytics"])) return "Insights Reporting";
    return "Insights Delivery";
  }
  if (hasAny(terms, ["import", "ingest", "intake"])) {
    if (hasAny(terms, ["customer", "client"])) return "Customer Data Import";
    if (hasAny(terms, ["file", "upload", "asset"])) return "File Import Workflow";
    return "Data Import Coordination";
  }
  if (hasAny(terms, ["report", "reports"])) return "Report Management";
  if (hasAny(terms, ["dashboard", "analytics"])) return "Analytics Dashboard";
  if (hasAny(terms, ["search", "filter", "query"])) return "Search and Filtering";
  if (hasAny(terms, ["notification", "notify"])) return "User Notifications";
  return null;
}

function isMostlyTechnicalLabel(label: string): boolean {
  const tokens = label
    .split(/[^A-Za-z0-9]+/)
    .flatMap(splitIdentifierToken)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);
  if (tokens.length === 0) return true;
  const productCount = tokens.filter((token) => PRODUCT_TERMS.has(token)).length;
  const technicalCount = tokens.filter((token) => TECHNICAL_TITLE_TOKENS.has(token)).length;
  return productCount === 0 || technicalCount >= Math.max(2, productCount + 1);
}

function splitIdentifierToken(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
}

function deriveGenericActor(terms: Set<string>): string {
  if (hasAny(terms, ["insight", "insights", "dashboard", "report", "analytics"])) return "Operator or customer reviewing product information";
  if (hasAny(terms, ["import", "ingest", "intake"])) return "Operator or integration providing data to the product";
  if (hasAny(terms, ["cli", "mcp", "oauth", "api"])) return "External client or authenticated integration";
  if (hasAny(terms, ["bot", "telegram", "message", "chat"])) return "External messaging user";
  if (hasAny(terms, ["admin", "dashboard", "editor", "publish"])) return "Internal operator or creator";
  if (hasAny(terms, ["job", "worker", "queue"])) return "Background worker and requesting client";
  return "Product user interacting with a visible capability";
}

function deriveGenericTrigger(title: string, members: BusinessCommunityMember[]): string {
  const terms = new Set<string>();
  for (const member of members) addTokensTo(terms, `${member.name} ${member.filePath}`);
  if (hasAny(terms, ["insight", "insights", "query", "search", "filter"])) {
    return "A user or integration asks the product to find, filter, or prepare insight data.";
  }
  if (hasAny(terms, ["import", "ingest", "intake"])) {
    return "A user, operator, or integration submits data that needs to be accepted into the product.";
  }
  if (hasAny(terms, ["report", "dashboard", "analytics"])) {
    return "A user opens a reporting or analytics surface that needs current product information.";
  }
  return `A user, operator, or integration starts the ${title.toLowerCase()} flow.`;
}

function deriveGenericOutcome(title: string, members: BusinessCommunityMember[]): string {
  const terms = new Set<string>();
  for (const member of members) addTokensTo(terms, `${member.name} ${member.filePath}`);
  if (hasAny(terms, ["insight", "insights", "query", "search", "filter"])) {
    return "The product returns a narrowed, business-relevant view of insight data that can be reviewed or acted on.";
  }
  if (hasAny(terms, ["import", "ingest", "intake"])) {
    return "The product accepts incoming data, coordinates validation or processing, and makes the imported information available to later workflows.";
  }
  if (hasAny(terms, ["report", "dashboard", "analytics"])) {
    return "The product presents business information in a form that supports review, follow-up, or operational decisions.";
  }
  return `The product completes the ${title.toLowerCase()} flow and produces a user-visible result or state transition.`;
}

function deriveDecisionPoints(terms: Set<string>, title: string): string[] {
  const points: string[] = [];

  if (hasAny(terms, ["insight", "insights", "query", "search", "filter"])) {
    points.push("Determines which product information should be included, filtered, or prepared for review.");
  }
  if (hasAny(terms, ["import", "ingest", "intake"])) {
    points.push("Determines whether incoming data is complete enough to be accepted into the product workflow.");
  }
  if (hasAny(terms, ["validate", "validator", "check", "verify", "guard", "schema"])) {
    points.push("Validates incoming input and chooses whether the request can continue safely.");
  }
  if (hasAny(terms, ["auth", "oauth", "token", "session", "password", "protected"])) {
    points.push("Determines identity, session state, and whether the caller is allowed into the next step.");
  }
  if (hasAny(terms, ["credit", "price", "pricing", "quota", "balance", "billing"])) {
    points.push("Checks commercial eligibility before expensive or irreversible work is committed.");
  }
  if (hasAny(terms, ["route", "dispatch", "command", "webhook", "handler"])) {
    points.push("Routes the request or event to the correct downstream handler for the requested capability.");
  }
  if (hasAny(terms, ["job", "queue", "poll", "status", "retry", "publish", "execute"])) {
    points.push("Chooses whether work should run immediately, asynchronously, or return status for a later step.");
  }

  if (points.length === 0) {
    points.push(`Determines whether the ${title.toLowerCase()} request can continue and what business state should change next.`);
  }

  return points.slice(0, 4);
}

function deriveSideEffects(terms: Set<string>, title: string): string[] {
  const effects: string[] = [];

  if (hasAny(terms, ["insight", "insights", "query", "search", "filter"])) {
    effects.push("Prepares filtered product information for review, reporting, or downstream action.");
  }
  if (hasAny(terms, ["import", "ingest", "intake"])) {
    effects.push("Turns submitted data into product state that later workflows can read or process.");
  }
  if (hasAny(terms, ["save", "store", "write", "update", "persist", "create"])) {
    effects.push("Stores or updates product state that later steps depend on.");
  }
  if (hasAny(terms, ["generate", "image", "video", "media", "render", "upload"])) {
    effects.push("Creates or transforms generated assets that become part of the user-facing result.");
  }
  if (hasAny(terms, ["message", "webhook", "send", "bot", "reply"])) {
    effects.push("Sends responses or callbacks to an external surface after the request is processed.");
  }
  if (hasAny(terms, ["auth", "session", "token", "login", "signup"])) {
    effects.push("Creates, refreshes, or clears authentication state that controls future access.");
  }
  if (hasAny(terms, ["job", "queue", "status", "publish", "execute"])) {
    effects.push("Creates execution records or updates run status so the product can track progress.");
  }

  if (effects.length === 0) {
    effects.push(`Updates product state or prepares output for the ${title.toLowerCase()} flow.`);
  }

  return effects.slice(0, 4);
}

function deriveBusinessTerms(terms: Set<string>, title: string): string[] {
  const preferred = [
    "account", "user", "customer", "client", "session", "subscription", "invoice", "payment",
    "credit", "quota", "balance", "pricing", "checkout", "workflow", "flow", "job", "status",
    "message", "webhook", "prompt", "media", "asset", "file", "upload", "import", "insights",
    "search", "filter", "report", "dashboard", "analytics",
  ];
  const selected = preferred.filter((term) => hasAny(terms, [term])).map(titleCase);
  if (selected.length > 0) return unique(selected).slice(0, 8);

  const titleTerms = title
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !TECHNICAL_TITLE_TOKENS.has(term.toLowerCase()));
  return unique(titleTerms.length ? titleTerms : [title]).slice(0, 6);
}

function deriveUserActions(terms: Set<string>, title: string): string[] {
  const actions: string[] = [];
  if (hasAny(terms, ["insight", "insights", "query", "search", "filter"])) {
    actions.push("Find, filter, or review product insights.");
  }
  if (hasAny(terms, ["import", "ingest", "intake"])) {
    actions.push("Submit or import data so it becomes available in the product.");
  }
  if (hasAny(terms, ["auth", "login", "signin", "signup", "session"])) {
    actions.push("Start, continue, or end an authenticated product session.");
  }
  if (hasAny(terms, ["checkout", "payment", "subscription", "invoice", "credit", "pricing"])) {
    actions.push("Review commercial state and complete a purchase, plan, or usage decision.");
  }
  if (hasAny(terms, ["generate", "image", "video", "media", "prompt", "render", "asset"])) {
    actions.push("Submit creative input and receive generated or transformed media.");
  }
  if (hasAny(terms, ["upload", "file", "storage", "bucket"])) {
    actions.push("Provide files or media that become part of a product workflow.");
  }
  if (hasAny(terms, ["publish", "execute", "workflow", "flow", "editor"])) {
    actions.push("Configure, publish, or run a workflow from a product surface.");
  }
  if (hasAny(terms, ["message", "chat", "bot", "webhook"])) {
    actions.push("Send or receive messages through an external communication channel.");
  }
  if (hasAny(terms, ["job", "queue", "status", "poll", "retry"])) {
    actions.push("Track progress for work that may complete asynchronously.");
  }
  if (actions.length === 0) {
    actions.push(`Use the ${title.toLowerCase()} capability and observe its resulting state or output.`);
  }
  return actions.slice(0, 4);
}

function deriveDataConcepts(terms: Set<string>, title: string): string[] {
  const conceptTerms = [
    "account", "user", "customer", "client", "session", "token", "credential", "role",
    "plan", "subscription", "invoice", "payment", "credit", "quota", "balance", "price",
    "prompt", "asset", "media", "image", "video", "file", "upload", "bucket",
    "workflow", "flow", "step", "execution", "job", "queue", "status", "message",
    "import", "insights", "report", "dashboard", "analytics", "search", "filter",
  ];
  const concepts = conceptTerms.filter((term) => hasAny(terms, [term])).map(titleCase);
  if (concepts.length > 0) return unique(concepts).slice(0, 10);
  return [`${title} state`, `${title} request`, `${title} result`];
}

function deriveExternalSystems(terms: Set<string>): string[] {
  const systems: Array<[string, string[]]> = [
    ["Stripe", ["stripe", "checkout", "invoice", "payment"]],
    ["OAuth identity provider", ["oauth", "identity", "openid", "sso"]],
    ["Supabase", ["supabase"]],
    ["Object storage", ["storage", "bucket", "s3", "blob"]],
    ["Messaging platform", ["telegram", "slack", "discord", "webhook", "bot"]],
    ["Jira", ["jira"]],
    ["GitHub", ["github"]],
  ];
  return systems
    .filter(([, keywords]) => hasAny(terms, keywords))
    .map(([label]) => label)
    .slice(0, 6);
}

function deriveConfidence(source: BusinessCommunitySource, match: FamilyMatch | null): number {
  const fileCount = unique(source.members.map((member) => member.filePath)).length;
  const symbolCount = unique(source.members.map((member) => member.name)).length;
  let confidence = 0.56;

  if (match) {
    if (match.hasPathHint) {
      // Folder structure + keywords ⇒ strong evidence, allow high confidence
      confidence += 0.16 + Math.min(match.distinctKeywordMatches * 0.02, 0.08);
    } else {
      // Keyword-only fallback: smaller boost, capped at medium
      confidence += 0.06;
    }
  }
  if (fileCount >= 3) confidence += 0.06;
  if (symbolCount >= 5) confidence += 0.04;
  if (source.hubs.length > 0) confidence += 0.04;
  if (source.surprises.length > 0) confidence += 0.02;

  // Keyword-only matches are capped at 0.72 ("medium") — we will not confidently
  // label a capability we couldn't corroborate from folder/file naming.
  const ceiling = match && !match.hasPathHint ? 0.72 : 0.93;
  return Math.max(0.55, Math.min(ceiling, confidence));
}

function titleCase(input: string): string {
  return input
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0] ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function hasAny(terms: Set<string>, candidates: string[]): boolean {
  for (const candidate of candidates) {
    if (terms.has(candidate)) return true;
    for (const term of terms) {
      if (term.includes(candidate) || candidate.includes(term)) return true;
    }
  }
  return false;
}

function isLowSignalFile(filePath: string): boolean {
  return /(^|\/)(__tests__|test|tests|fixtures)(\/|$)|\.(test|spec)\.[a-z]+$/i.test(filePath);
}

/**
 * Documentation, config, manifest, and lockfile paths. Used to strip communities
 * whose only members are package.json/CLAUDE.md/etc. from business-page generation,
 * because such "communities" have no business capability to translate.
 */
function isMetadataFile(filePath: string): boolean {
  const base = basename(filePath).toLowerCase();
  // Documentation
  if (/\.(md|mdx|markdown|txt|rst|adoc)$/.test(base)) return true;
  // Package manifests
  if (/^package(-lock)?\.json$/.test(base)) return true;
  if (base === "bower.json" || base === "composer.json") return true;
  // Lockfiles
  if (/^(yarn|pnpm|bun|shrinkwrap)(-|\.)?lock(\.json|\.yaml|b)?$/.test(base)) return true;
  // TypeScript configs
  if (/^tsconfig(\..+)?\.json$/.test(base)) return true;
  // JS build/tool configs
  if (/\.config\.(js|ts|mjs|cjs|mts|cts|json)$/.test(base)) return true;
  if (/^(babel|webpack|rollup|vite|vitest|tsup|jest|postcss|tailwind|next|nuxt|svelte|astro|eslint|prettier|stylelint)\.config\..+$/.test(base)) return true;
  // Dotfile configs
  if (/^\.(gitignore|gitattributes|editorconfig|npmignore|dockerignore|env)(\..+)?$/.test(base)) return true;
  if (/^\.(eslintrc|prettierrc|babelrc|stylelintrc|nvmrc|node-version)(\..+)?$/.test(base)) return true;
  // Standard metadata files
  if (/^(license|readme|changelog|contributing|authors|copying|code_of_conduct|security|notice)(\..+)?$/.test(base)) return true;
  return false;
}

function isLowSignalSymbol(name: string): boolean {
  return /^(test|describe|beforeeach|aftereach|render|forwardref_handler|test_handler|describe_handler)$/i.test(name);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function dedupeBySlug(pages: BusinessPageDraft[]): BusinessPageDraft[] {
  const best = new Map<string, BusinessPageDraft>();
  for (const page of pages) {
    const existing = best.get(page.slug);
    if (!existing || scoreBusinessPageDraft(page) > scoreBusinessPageDraft(existing)) {
      best.set(page.slug, page);
    }
  }
  return Array.from(best.values());
}

function scoreBusinessPageDraft(page: BusinessPageDraft): number {
  const text = `${page.slug} ${page.title} ${page.relatedFiles.join(" ")} ${page.relatedSymbols.join(" ")}`.toLowerCase();
  let score = page.confidence * 100 + page.relatedFiles.length + page.relatedSymbols.length * 0.5;

  const family = CAPABILITY_FAMILIES.find((candidate) => page.slug === `business-${slugify(candidate.title)}`);
  if (family) {
    const symbolText = page.relatedSymbols.join(" ");
    const familyEvidenceScore = page.relatedFiles.reduce(
      (sum, filePath) => sum + Math.min(30, scoreFamilyEvidence(family, symbolText, filePath)),
      0
    );
    score += Math.min(60, familyEvidenceScore / 2);
  }
  if (/(docs\/|e2e|tests?|spec|mock|fixture|mcp-server|cli\/)/.test(text)) score -= 20;

  return score;
}
