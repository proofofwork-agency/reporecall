import type { MemoryConfig } from "../../core/config.js";
import type { FTSStore } from "../../storage/fts-store.js";
import type { MetadataStore } from "../../storage/metadata-store.js";
import type { ChunkFeature } from "../../storage/types.js";
import type { SearchResult } from "../types.js";
import type { ExecutionSurfaceBias } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BUG_GATE_RE =
  /(?:\b(?:validate|valid|check|assert|verify|guard|compat|schema|allow|deny|reject|permission|connect|connection)\b|\b(?:validate|valid|check|assert|verify|guard|compat|schema|allow|deny|reject|permission|connect|connection|is|has|can|should)[A-Z_][a-zA-Z0-9_]*\b|\b(?:is|has|can|should)\s+(?:valid|allowed|enabled|disabled|ready|connected|authenticated|authorized|compatible|protected)\b)/i;

export const BUG_STRUCTURAL_NOISE_RE = /(?:^|\/)(docs?|documentation)\//i;

export const BUG_UI_NOISE_RE = /(registry|styles?|theme|tokens?|catalog|readme|guide|examples?)/i;

export const BUG_UI_LEAF_TERMS = new Set([
  "menu", "modal", "dialog", "popover", "tooltip", "button", "picker",
  "item", "card", "panel", "tile", "row", "list",
]);

export const BUG_GENERIC_TERMS = new Set([
  "possible", "supposed", "wrong", "incorrect", "unexpected", "broken",
  "fails", "failing", "failure", "issue", "problem", "bug", "possible",
]);

export const BUG_GENERIC_SEED_ALIAS_TERMS = new Set([
  "auth", "navigation", "callback", "provider", "session",
  "state", "page", "route", "pending", "destination",
]);

export const BUG_STRUCTURAL_ROLE_ALIAS_TERMS = new Set([
  "controller", "service", "handler", "provider", "manager", "state", "page",
]);

export const BUG_STRUCTURAL_HINT_TERMS = new Set([
  "control", "controls", "controlled", "controlling", "controll",
  "controller", "controllers",
  "service", "services",
  "handler", "handlers",
  "provider", "providers",
  "manager", "managers",
  "middleware",
  "adapter", "adapters",
  "boundary", "boundaries",
  "orchestrator", "orchestrators",
  "implementation", "implement", "implements", "implementing",
]);

export const BUG_NOISE_TERMS = new Set([
  "some", "they", "them", "their", "there", "thing", "things", "something", "anything",
  "seeing", "around", "sometimes", "feels", "somewhere", "first", "inspect", "trying",
  "getting", "users", "user", "during", "land", "lands", "bounced", "get", "go", "dont", "like",
  "another", "one", "people", "instead", "likely", "page", "pages",
  "exactly", "matter", "matters", "care", "understand", "want", "lets", "code", "runs", "run",
  "control", "controlling", "relevant", "relevance", "successfully", "suspect", "suspects", "seems", "seem",
  "wanted", "place", "places", "opens", "opened", "flaky",
]);

export const BUG_LOW_SPECIFICITY_TERMS = new Set([
  "node", "nodes", "item", "items", "data", "file", "files", "flow", "system", "app", "apps",
  "sign", "signing", "state", "controller", "controllers", "service", "services", "handler", "handlers",
  "provider", "providers", "manager", "managers",
]);

export const BUG_MECHANISM_ONLY_TERMS = new Set([
  "call", "calls", "caller", "calling",
  "check", "checks",
  "runtime", "stored", "store",
  "consumed", "consume", "consuming",
  "enforce", "enforces",
]);

export const BUG_AUTH_ROUTING_OFFDOMAIN_RE =
  /\b(billing|payment|checkout|invoice|credit|webhook|stripe|storage|upload|media|generation)\b/i;

export const BUG_CONNECTION_OFFDOMAIN_RE =
  /\b(auth|login|signin|session|token|oauth|billing|payment|credit|webhook|api|server|upload|storage|media|provider)\b/i;

export const BUG_SUBJECT_TAG_RULES: Array<{ tag: string; pattern: RegExp; relatedTags?: string[] }> = [
  { tag: "connection", pattern: /\b(edge|connect|connection|link|compat|compatible)\b/i, relatedTags: ["schema"] },
  { tag: "schema", pattern: /\b(schema|compat|compatible|type|types)\b/i, relatedTags: ["connection"] },
  { tag: "auth", pattern: /\b(auth|login|signin|signout|signing|authenticate|authenticated|authorization|authorize|authorized|session|token|oauth|credential)\b/i, relatedTags: ["routing", "permissions"] },
  { tag: "routing", pattern: /\b(route|router|navigation|redirect|callback|protected|pending|destination|handoff|return)\b/i, relatedTags: ["auth", "permissions"] },
  { tag: "billing", pattern: /\b(billing|checkout|subscription|invoice|payment|credit|portal)\b/i },
  { tag: "storage", pattern: /\b(storage|upload|bucket|blob|media)\b/i },
  { tag: "generation", pattern: /\b(generate|generation|image|render|regen|thumbnail|preview)\b/i },
];

export const MODE_EXPLICIT_LOGGING_RE = /\b(log|logger|logging|audit|instrument|instrumentation|telemetry|metrics?)\b/i;
export const MODE_EXPLICIT_WEBHOOK_RE = /\b(webhook|signature|payload|delivery|event)\b/i;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface QueryDecomposition {
  literalTerms: string[];
  normalizedVariants: string[];
  semanticVariants: string[];
  implementationTerms: string[];
  runtimeTerms: string[];
  architecturalTerms: string[];
  controlFlowTerms: string[];
  dataFlowTerms: string[];
  implementationHypotheses: string[];
  excludedTerms: string[];
}

export interface BugSubjectProfile {
  subjectTerms: string[];
  focusTerms: string[];
  primaryTags: Set<string>;
  relatedTags: Set<string>;
  decomposition: QueryDecomposition;
  negativeTerms: string[];
  surfaceBias: ExecutionSurfaceBias;
}

export interface BugContradictionDiagnostic {
  filePath: string;
  symbol: string;
  reasons: string[];
}

export interface BugCandidateDiagnostic {
  filePath: string;
  symbol: string;
  confidence: number;
  evidence: string[];
}

export interface BugScoredCandidate {
  result: SearchResult;
  score: number;
  keywordHit: boolean;
  semanticHit: boolean;
  callerHit: boolean;
  seedHit: boolean;
  strongDomainMatch: boolean;
  callsPredicateCount: number;
  contradictions: string[];
  feature: ChunkFeature | undefined;
  signals: BugCandidateSignals;
}

export interface BugSelectionDiagnostics {
  queryDecomposition: QueryDecomposition;
  searchStepsUsed: string[];
  subjectTerms: string[];
  primaryTags: string[];
  inputResults: Array<{ name: string; filePath: string; score: number }>;
  semanticSeedResults: Array<{ name: string; filePath: string; score: number }>;
  keywordResults: Array<{ name: string; filePath: string; score: number }>;
  callerResults: Array<{ name: string; filePath: string; score: number }>;
  neighborResults: Array<{ name: string; filePath: string; score: number }>;
  scored: Array<{
    name: string;
    filePath: string;
    score: number;
    keywordHit: boolean;
    semanticHit: boolean;
    callerHit: boolean;
    strongDomainMatch: boolean;
    callsPredicateCount: number;
  }>;
  topCandidates: BugCandidateDiagnostic[];
  contradictions: BugContradictionDiagnostic[];
  nextPivots: string[];
}

export interface BugCandidateSignals {
  rawLiteralMatches: number;
  literalMatches: number;
  pathNameSemanticMatches: number;
  semanticMatches: number;
  implementationMatches: number;
  runtimeMatches: number;
  architectureMatches: number;
  controlFlowMatches: number;
  dataFlowMatches: number;
  rawTermMatches: number;
  termMatches: number;
  pathNameTermMatches: number;
  primaryTagMatches: number;
  relatedTagMatches: number;
  negativeMatches: number;
  runtimeGateOverlap: boolean;
  strongDomainMatch: boolean;
  surfaceAlignment: number;
}

// ---------------------------------------------------------------------------
// Dependency callbacks – these are methods that live in HybridSearch but are
// needed by BugStrategy.  The caller passes them at construction time so that
// BugStrategy does not need to know about HybridSearch.
// ---------------------------------------------------------------------------

export interface BugStrategyDeps {
  metadata: MetadataStore;
  config: MemoryConfig;
  fts: FTSStore;
}

// ---------------------------------------------------------------------------
// BugStrategy class
// ---------------------------------------------------------------------------


export interface BugLocalizationSelectionInput {
  scored: BugScoredCandidate[];
  maxFiles: number;
  featureMap: Map<string, ChunkFeature>;
  subjectProfile: BugSubjectProfile;
  structuralSupportIds: Set<string>;
  keywordResults: SearchResult[];
  semanticSeedResults: SearchResult[];
  anchoredSemanticSeedIds: Set<string>;
  getSignalsForResult: (result: SearchResult) => BugCandidateSignals;
}
