/**
 * Bug localization strategy extracted from HybridSearch.
 *
 * Contains all bug-specific constants, interfaces, predicate methods,
 * retrieval builders, scoring logic, and the final bundle selection.
 *
 * The class is designed so that HybridSearch can later delegate to it
 * without changing public signatures.
 */

import type { MemoryConfig } from "../core/config.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { ChunkFeature, StoredChunk } from "../storage/types.js";
import type { SearchResult } from "./types.js";
import type { SeedResult } from "./seed.js";
import {
  detectExecutionSurfaces,
  expandQueryTerms,
  GENERIC_BROAD_TERMS,
  GENERIC_QUERY_ACTION_TERMS,
  getQueryTermVariants,
  inferQueryExecutionSurfaceBias,
  isTestFile,
  scoreExecutionSurfaceAlignment,
  STOP_WORDS,
  textMatchesQueryTerm,
  tokenizeQueryTerms,
  type ExpandedQueryTerm,
  type ExecutionSurfaceBias,
} from "./utils.js";
import { normalizeTargetText } from "./targets.js";

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

const MODE_EXPLICIT_LOGGING_RE = /\b(log|logger|logging|audit|instrument|instrumentation|telemetry|metrics?)\b/i;
const MODE_EXPLICIT_WEBHOOK_RE = /\b(webhook|signature|payload|delivery|event)\b/i;

const ADJACENT_WORKFLOW_FAMILIES: Record<string, string[]> = {
  auth: ["routing", "permissions"],
  routing: ["auth", "permissions"],
  billing: ["auth"],
  storage: ["auth"],
  generation: ["storage"],
};

const INVENTORY_GENERIC_TARGET_ALIAS_TERMS = new Set(["route", "routes", "router", "routing", "navigation"]);

// Imported via re-export so the trace noise set is only needed internally
const TRACE_NOISE_TERMS = new Set(["path", "page", "pages", "include", "includes", "including", "start", "first", "then", "full", "intent"]);

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

export class BugStrategy {
  private metadata: MetadataStore;
  private config: MemoryConfig;
  // Stored for updateStores symmetry with other strategy classes.
  // Not read internally today but callers may need it in the future.
  private _fts: FTSStore;

  constructor(deps: BugStrategyDeps) {
    this.metadata = deps.metadata;
    this.config = deps.config;
    this._fts = deps.fts;
  }

  /** Allow updating stores after hot-reload / rebuild. */
  updateStores(metadata: MetadataStore, fts: FTSStore): void {
    this.metadata = metadata;
    this._fts = fts;
  }

  /** Expose the FTS store for callers that need it. */
  get fts(): FTSStore {
    return this._fts;
  }

  // =========================================================================
  // Public entry-points (matching HybridSearch method signatures)
  // =========================================================================

  buildBugSubjectProfile(queryTerms: string[], rawQuery = ""): BugSubjectProfile {
    const rawSignalTerms = this.collectBugRawSignalTerms(rawQuery);
    const allTerms = Array.from(new Set([...queryTerms, ...rawSignalTerms]));
    const normalizedSourceTerms = Array.from(new Set(
      allTerms
        .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
        .filter((term) =>
          term.length >= 2
          && !STOP_WORDS.has(term)
          && !BUG_NOISE_TERMS.has(term)
          && !BUG_LOW_SPECIFICITY_TERMS.has(term)
          && !this.isBugStructuralHintTerm(term)
          && this.isUsefulBugSignalTerm(term)
        )
    ));
    const literalTerms = Array.from(new Set(
      normalizedSourceTerms
        .filter((term) => term.length >= 3)
    ));
    const subjectTerms = Array.from(new Set(
      normalizedSourceTerms
        .flatMap((term) => this.getBugQueryVariants(term))
        .filter((term) =>
          term.length >= 3
          && !STOP_WORDS.has(term)
          && !BUG_NOISE_TERMS.has(term)
          && !BUG_LOW_SPECIFICITY_TERMS.has(term)
        )
    ));
    const primaryTags = new Set<string>();
    const relatedTags = new Set<string>();

    for (const rule of BUG_SUBJECT_TAG_RULES) {
      if (!subjectTerms.some((term) => rule.pattern.test(term)) && !rule.pattern.test(rawQuery)) continue;
      primaryTags.add(rule.tag);
      for (const related of rule.relatedTags ?? []) relatedTags.add(related);
    }

    const negativeTerms = this.extractNegatedPromptTerms(rawQuery);
    const decomposition = this.buildBugQueryDecomposition(
      literalTerms,
      subjectTerms,
      primaryTags,
      relatedTags,
      negativeTerms
    );
    const focusTerms = decomposition.normalizedVariants.filter((term) =>
      !BUG_LOW_SPECIFICITY_TERMS.has(term) && !negativeTerms.includes(term)
    );

    return {
      subjectTerms,
      focusTerms: focusTerms.length > 0 ? focusTerms : decomposition.normalizedVariants,
      primaryTags,
      relatedTags,
      decomposition,
      negativeTerms,
      surfaceBias: inferQueryExecutionSurfaceBias(rawQuery, "bug"),
    };
  }

  buildBugQueryDecomposition(
    literalTerms: string[],
    subjectTerms: string[],
    primaryTags: Set<string>,
    relatedTags: Set<string>,
    negativeTerms: string[]
  ): QueryDecomposition {
    const normalizedVariants = Array.from(new Set(
      subjectTerms.flatMap((term) => getQueryTermVariants(term))
        .filter((term) => term.length >= 3 && !STOP_WORDS.has(term) && !BUG_NOISE_TERMS.has(term))
    ));
    const tagTerms = Array.from(new Set([...primaryTags, ...relatedTags]));
    const semanticVariants = Array.from(new Set(
      tagTerms.flatMap((tag) => {
        switch (tag) {
          case "connection":
            return ["link", "relationship", "compatibility", "edge"];
          case "schema":
            return ["contract", "compatibility"];
          case "auth":
            return ["session", "credential", "token", "identity"];
          case "routing":
            return ["redirect", "navigation", "guard", "middleware"];
          case "storage":
            return ["persist", "write", "bucket", "blob"];
          case "billing":
            return ["charge", "invoice", "subscription", "checkout"];
          case "generation":
            return ["render", "worker", "queue", "job"];
          default:
            return [];
        }
      })
    ));
    const implementationTerms = Array.from(new Set([
      ...(tagTerms.includes("validation") || tagTerms.includes("schema") ? ["validate", "check", "assert", "compat"] : []),
      ...(tagTerms.includes("connection") ? ["guard", "predicate", "schema"] : []),
      ...(tagTerms.includes("auth") ? ["middleware", "provider", "guard", "session"] : []),
      ...(tagTerms.includes("routing") ? ["redirect", "middleware", "callback"] : []),
      ...(tagTerms.includes("storage") ? ["write", "persist", "adapter"] : []),
      "validator",
      "guard",
    ].filter((term, index, items) => term.length >= 3 && items.indexOf(term) === index)));
    const runtimeTerms = Array.from(new Set([
      "return false",
      "throw new",
      "reject",
      "allow",
      "error",
      "state",
      "request",
      "response",
    ]));
    const architecturalTerms = Array.from(new Set([
      "controller",
      "service",
      "adapter",
      "store",
      "middleware",
      "provider",
      "schema",
      "api",
      "boundary",
      "orchestrator",
    ]));
    const controlFlowTerms = ["guard", "predicate", "branch", "condition", "return false", "throw"];
    const dataFlowTerms = ["input", "output", "state", "payload", "request", "response", "config"];
    const implementationHypotheses = [
      "A runtime validator or guard is allowing or rejecting the behavior.",
      "An orchestrator/controller is calling a predicate or compatibility check in the wrong place.",
      "A schema, adapter, or state boundary is missing or bypassing validation.",
    ];

    return {
      literalTerms,
      normalizedVariants,
      semanticVariants,
      implementationTerms,
      runtimeTerms,
      architecturalTerms,
      controlFlowTerms,
      dataFlowTerms,
      implementationHypotheses,
      excludedTerms: negativeTerms,
    };
  }

  buildBugSeedResults(seedResult: SeedResult | undefined, profile: BugSubjectProfile): SearchResult[] {
    if (!seedResult?.seeds?.length) return [];

    const chunks = this.metadata.getChunksByIds(seedResult.seeds.map((seed) => seed.chunkId));
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(chunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
    );

    return seedResult.seeds
      .slice(0, 4)
      .map((seed) => {
        const chunk = chunkMap.get(seed.chunkId);
        if (!chunk || isTestFile(chunk.filePath) || !this.isImplementationPath(chunk.filePath)) return null;
        const feature = featureMap.get(chunk.id);
        const tags = this.metadata.getChunkTagsByIds([chunk.id]).map((tag) => tag.tag);
        const signals = this.getBugCandidateSignals(
          { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
          profile,
          tags
        );
        const candidateFamilies = this.getBugCandidateFamilies(chunk);
        const familyOverlap = Array.from(candidateFamilies).filter((family) =>
          profile.primaryTags.has(family) || profile.relatedTags.has(family)
        ).length;
        const normalizedAlias = normalizeTargetText(seed.resolvedAlias ?? seed.name);
        const aliasTokens = normalizedAlias.split(" ").filter(Boolean);
        const resolvedFile =
          seed.targetKind === "file_module"
          || seed.resolutionSource === "file_path";
        const seedSpecificity =
          signals.pathNameTermMatches
          + signals.primaryTagMatches
          + signals.rawLiteralMatches
          + familyOverlap;

        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0) return null;
        if (signals.surfaceAlignment <= -1.4 && signals.pathNameTermMatches === 0 && signals.primaryTagMatches === 0) return null;
        if (this.isBugRedirectNoiseCandidate(chunk, signals, profile)) return null;
        if (this.isBugFrontendHandoffNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugGenericAuthEntryCandidate(chunk, profile, signals)) return null;
        if (this.isBugGenericStateSupportNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugOffDomainBackendCandidate(chunk, profile, signals)) return null;
        if (this.isBugCrossDomainNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugUnrelatedExecutionNoiseCandidate(chunk, profile, signals)) return null;
        if (
          aliasTokens.length <= 1
          && (
            GENERIC_BROAD_TERMS.has(normalizedAlias)
            || INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizedAlias)
            || GENERIC_QUERY_ACTION_TERMS.has(normalizedAlias)
            || BUG_GENERIC_SEED_ALIAS_TERMS.has(normalizedAlias)
          )
          && signals.pathNameTermMatches === 0
          && signals.rawLiteralMatches === 0
          && seed.reason !== "explicit_target"
        ) {
          return null;
        }
        if (
          seed.reason !== "explicit_target"
          && aliasTokens.length <= 1
          && BUG_STRUCTURAL_ROLE_ALIAS_TERMS.has(normalizedAlias)
          && familyOverlap === 0
          && signals.pathNameTermMatches <= 1
          && signals.rawLiteralMatches <= 1
          && signals.primaryTagMatches === 0
        ) {
          return null;
        }
        if (
          seed.reason === "explicit_target"
          && aliasTokens.length > 0
          && GENERIC_QUERY_ACTION_TERMS.has(aliasTokens[0] ?? "")
          && signals.pathNameTermMatches === 0
          && signals.rawLiteralMatches === 0
        ) {
          return null;
        }
        if (
          seed.reason !== "explicit_target"
          && !resolvedFile
          && seedSpecificity === 0
        ) {
          return null;
        }
        if (
          profile.primaryTags.size >= 2
          && familyOverlap === 0
          && signals.pathNameTermMatches === 0
          && signals.rawLiteralMatches === 0
          && seed.reason !== "explicit_target"
        ) {
          return null;
        }

        let score = 7 + seed.confidence * 3;
        if (seed.reason === "explicit_target") score += 2;
        if (resolvedFile) score += 1.4;
        score += Math.min(2.4, seedSpecificity * 0.65);
        if (this.isBugGateLike(chunk, feature)) score += 1.5;
        if (this.isBugOrchestratorCandidate(chunk, feature)) score += 1.1;
        score += signals.surfaceAlignment * 0.9;

        return this.chunkToSearchResult(chunk, score);
      })
      .filter((chunk): chunk is SearchResult => chunk !== null);
  }

  buildBugStructuralSupportResults(profile: BugSubjectProfile): SearchResult[] {
    if (!this.metadata.resolveTargetAliases) return [];

    const aliases = this.isBugAuthRoutingPrompt(profile)
      ? ["auth callback", "callback", "protected route", "redirect", "pending destination", "destination"]
      : (profile.primaryTags.has("connection") || profile.primaryTags.has("schema"))
        ? ["connection schema", "compatibility schema", "edge", "handle", "editor", "flow"]
        : [];
    if (aliases.length === 0) return [];

    const hits = [
      ...this.metadata.resolveTargetAliases(aliases, 60, ["file_module"]),
      ...this.metadata.resolveTargetAliases(aliases, 60, ["symbol"]),
    ];
    const byId = new Map<string, SearchResult>();

    for (const hit of hits) {
      const ownerChunkId = hit.target.ownerChunkId
        ?? this.metadata.findChunksByFilePath(hit.target.filePath)[0]?.id;
      if (!ownerChunkId) continue;
      const chunk = this.metadata.getChunksByIds([ownerChunkId])[0];
      if (!chunk || isTestFile(chunk.filePath) || !this.isImplementationPath(chunk.filePath)) continue;
      const tags = this.metadata.getChunkTagsByIds([chunk.id]).map((tag) => tag.tag);
      const signals = this.getBugCandidateSignals(
        { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
        profile,
        tags
      );
      if (this.isBugCrossDomainNoiseCandidate(chunk, profile, signals)) continue;

      let score = 8 + hit.weight * 2.2;
      if (this.isBugAuthRoutingPrompt(profile)) {
        if (this.hasBugHandoffSpecificAnchor(chunk, signals)) score += 3.2;
        if (this.isBugRedirectBackboneCandidate(chunk, signals)) score += 2.4;
      }
      if (profile.primaryTags.has("connection") || profile.primaryTags.has("schema")) {
        if (signals.pathNameTermMatches > 0) score += 3.1;
        if (signals.primaryTagMatches > 0) score += 2.8;
        if (this.hasBugSpecificSubjectAnchor(chunk, profile)) score += 1.8;
      }

      const existing = byId.get(chunk.id);
      const candidate = this.chunkToSearchResult(chunk, score);
      if (!existing || candidate.score > existing.score) byId.set(chunk.id, candidate);
    }

    return Array.from(byId.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  buildBugKeywordResults(results: SearchResult[], profile: BugSubjectProfile): SearchResult[] {
    const bestByFile = new Map<string, SearchResult>();
    for (const result of results.slice(0, 30)) {
      if (isTestFile(result.filePath) || !this.isImplementationPath(result.filePath)) continue;
      const representative = this.promoteBugRepresentativeChunk(result, profile);
      const existing = bestByFile.get(representative.filePath);
      if (!existing || representative.score > existing.score) {
        bestByFile.set(representative.filePath, representative);
      }
    }

    const promotedByFile = Array.from(bestByFile.values());
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(promotedByFile.map((result) => result.id)).map((feature) => [feature.chunkId, feature])
    );
    const tagMap = new Map<string, string[]>();
    for (const tag of this.metadata.getChunkTagsByIds(promotedByFile.map((result) => result.id))) {
      const existing = tagMap.get(tag.chunkId) ?? [];
      existing.push(tag.tag);
      tagMap.set(tag.chunkId, existing);
    }

    const scoredResults: Array<SearchResult | null> = promotedByFile
      .map((representative) => {
        const feature = featureMap.get(representative.id);
        const tags = tagMap.get(representative.id) ?? [];
        const signals = this.getBugCandidateSignals(
          { filePath: representative.filePath, name: representative.name, content: representative.content },
          profile,
          tags
        );
        const strongPathMatch = signals.pathNameTermMatches > 0 || signals.primaryTagMatches > 0;
        const gateLike = this.isBugGateLike(representative, feature);
        const contradictions = this.collectBugContradictions(representative, feature, signals);

        if (feature?.docLike || feature?.testLike) return null;
        if (this.isBugGenericNavigationLeaf(representative, signals, profile)) return null;
        if (this.isBugRedirectNoiseCandidate(representative, signals, profile)) return null;
        if (this.isBugMigrationNoiseCandidate(representative, profile, signals)) return null;
        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0) return null;
        if (signals.surfaceAlignment <= -1.5 && !gateLike && !strongPathMatch) return null;
        if (contradictions.includes("registry_without_runtime") && !gateLike) return null;
        if (contradictions.includes("ui_wrapper_without_runtime") && !gateLike) return null;
        if (profile.primaryTags.size > 0 && !(strongPathMatch || gateLike || signals.implementationMatches > 0 || signals.runtimeMatches > 0)) return null;

        let score = representative.score;
        if (strongPathMatch) score += 2.6;
        if (gateLike) score += 2.1;
        if (signals.literalMatches > 0) score += Math.min(1.2, signals.literalMatches * 0.3);
        if (signals.semanticMatches > 0) score += Math.min(1, signals.semanticMatches * 0.25);
        if (signals.implementationMatches > 0) score += Math.min(1.5, signals.implementationMatches * 0.35);
        if (signals.runtimeMatches > 0) score += Math.min(1.2, signals.runtimeMatches * 0.25);
        if (signals.architectureMatches > 0) score += Math.min(0.8, signals.architectureMatches * 0.15);
        if (signals.controlFlowMatches > 0) score += Math.min(0.8, signals.controlFlowMatches * 0.18);
        if (signals.relatedTagMatches > 0) score += Math.min(0.5, signals.relatedTagMatches * 0.15);
        score += signals.surfaceAlignment * 1.15;
        if ((feature?.callsPredicateCount ?? 0) > 0) score += Math.min(1.2, (feature?.callsPredicateCount ?? 0) * 0.2);
        if ((feature?.branchCount ?? 0) > 0) score += Math.min(0.8, (feature?.branchCount ?? 0) * 0.08);
        score -= Math.min(2, contradictions.length * 0.45);
        score -= Math.min(3, signals.negativeMatches * 1.25);

        return {
          ...representative,
          score,
          hookScore: Math.max(representative.hookScore ?? representative.score, score),
        };
      });

    return scoredResults
      .filter((result): result is SearchResult => result !== null)
      .sort((a, b) => b.score - a.score);
  }

  selectBugLocalizationBundle(
    query: string,
    results: SearchResult[],
    maxContextChunks: number = 6,
    seedResult?: SeedResult
  ): SearchResult[] {
    const queryTerms = this.extractBugSalientTerms(query);
    const subjectTerms = queryTerms.filter((term) => !BUG_GENERIC_TERMS.has(term));
    const subjectProfile = this.buildBugSubjectProfile(subjectTerms, query);
    const seedAnchorIds = new Set(
      (seedResult?.seeds ?? [])
        .filter((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target")
        .filter((seed) => {
          const normalizedAlias = normalizeTargetText(seed.resolvedAlias ?? seed.name);
          const aliasTokens = normalizedAlias.split(" ").filter(Boolean);
          if (
            aliasTokens.length <= 1
            && (
              GENERIC_BROAD_TERMS.has(normalizedAlias)
              || INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizedAlias)
              || GENERIC_QUERY_ACTION_TERMS.has(normalizedAlias)
            )
          ) {
            return false;
          }
          if (
            seed.reason === "explicit_target"
            && GENERIC_QUERY_ACTION_TERMS.has(aliasTokens[0] ?? "")
          ) {
            return false;
          }
          const seedText = `${seed.filePath} ${seed.name} ${seed.resolvedAlias ?? ""}`;
          const matches = subjectProfile.focusTerms.filter((term) => textMatchesQueryTerm(seedText, term)).length;
          if (matches >= 2) return true;
          return matches >= 1 && seed.reason === "explicit_target";
        })
        .map((seed) => seed.chunkId)
    );
    const maxFiles = Math.min(3, maxContextChunks);
    const semanticSeedResults = this.buildBugPredicateResults(subjectProfile);
    const structuralSupportResults = this.buildBugStructuralSupportResults(subjectProfile);
    const seedResults = this.buildBugSeedResults(seedResult, subjectProfile);
    const keywordResults = this.buildBugKeywordResults(results, subjectProfile);
    const strongKeywordAnchorResults = keywordResults.filter((result) => {
      const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
      const feature = this.metadata.getChunkFeaturesByIds([result.id])[0];
      const signals = this.getBugCandidateSignals(
        { filePath: result.filePath, name: result.name, content: result.content },
        subjectProfile,
        tags
      );
      return this.isStrongBugAnchorCandidate(result, signals, feature, subjectProfile);
    });
    const strongSemanticAnchorResults = semanticSeedResults.filter((result) => {
      const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
      const feature = this.metadata.getChunkFeaturesByIds([result.id])[0];
      const signals = this.getBugCandidateSignals(
        { filePath: result.filePath, name: result.name, content: result.content },
        subjectProfile,
        tags
      );
      return this.isStrongBugAnchorCandidate(result, signals, feature, subjectProfile);
    });
    const filteredSemanticSeedResults = strongKeywordAnchorResults.length > 0
      ? semanticSeedResults.filter((result) => {
          const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
          const feature = this.metadata.getChunkFeaturesByIds([result.id])[0];
          const signals = this.getBugCandidateSignals(
            { filePath: result.filePath, name: result.name, content: result.content },
            subjectProfile,
            tags
          );
          return signals.pathNameTermMatches > 0
            || signals.primaryTagMatches > 0
            || this.isStrongBugAnchorCandidate(result, signals, feature, subjectProfile);
        })
      : semanticSeedResults;
    const callerSeedResults = strongKeywordAnchorResults.length > 0
      ? strongKeywordAnchorResults
      : strongSemanticAnchorResults;
    const hasStrongKeywordAnchors = strongKeywordAnchorResults.length > 0;
    const callerResults = this.buildBugCallerResults(
      callerSeedResults.length > 0
        ? callerSeedResults
        : this.mergeBroadResults(semanticSeedResults, keywordResults),
      subjectProfile
    );
    const neighborResults = this.buildBugNeighborResults(
      hasStrongKeywordAnchors
        ? [...strongKeywordAnchorResults, ...callerResults]
        : [...semanticSeedResults, ...keywordResults, ...callerResults],
      subjectProfile
    );
    const semanticSeedIds = new Set(semanticSeedResults.map((result) => result.id));
    const structuralSupportIds = new Set(structuralSupportResults.map((result) => result.id));
    const seedResultIds = new Set(seedResults.map((result) => result.id));
    const keywordIds = new Set(keywordResults.map((result) => result.id));
    const callerIds = new Set(callerResults.map((result) => result.id));
    const neighborIds = new Set(neighborResults.map((result) => result.id));
    const anchoredSemanticSeedIds = new Set(
      semanticSeedResults
        .filter((result) => {
          const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
          const signals = this.getBugCandidateSignals(
            { filePath: result.filePath, name: result.name, content: result.content },
            subjectProfile,
            tags
          );
          return this.hasBugAnchorSignals(signals);
        })
        .map((result) => result.id)
    );
    const keywordFocused = keywordResults.filter((result) => {
      const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
      const signals = this.getBugCandidateSignals(
        { filePath: result.filePath, name: result.name, content: result.content },
        subjectProfile,
        tags
      );
      return signals.pathNameTermMatches > 0
        || signals.primaryTagMatches > 0
        || signals.implementationMatches > 0
        || signals.runtimeMatches > 0;
    });
    const genericDomainResults = results.filter((result) => {
      const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
      const signals = this.getBugCandidateSignals(
        { filePath: result.filePath, name: result.name, content: result.content },
        subjectProfile,
        tags
      );
      if (subjectProfile.primaryTags.size === 0) {
        return signals.literalMatches + signals.semanticMatches + signals.implementationMatches + signals.runtimeMatches > 0
          || signals.runtimeGateOverlap;
      }
      return signals.strongDomainMatch || signals.runtimeGateOverlap;
    });
    const preAugmentedResults = subjectProfile.primaryTags.size > 0 && keywordFocused.length > 0
      ? this.mergeBroadResults(
          this.mergeBroadResults(neighborResults, callerResults),
          keywordFocused
        )
      : this.mergeBroadResults(filteredSemanticSeedResults, genericDomainResults);
    const augmentedResults = this.mergeBroadResults(
      structuralSupportResults,
      this.mergeBroadResults(seedResults, preAugmentedResults)
    );
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(augmentedResults.map((result) => result.id)).map((feature) => [feature.chunkId, feature])
    );

    const scored: BugScoredCandidate[] = augmentedResults
      .map((result) => {
        const lowerPath = result.filePath.toLowerCase();
        const lowerName = result.name.toLowerCase();
        const lowerContent = result.content.toLowerCase();
        const combined = `${lowerPath} ${lowerName} ${lowerContent.slice(0, 1200)}`;
        const fileBase = lowerPath.split("/").pop() ?? lowerPath;
        const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
        const feature = featureMap.get(result.id);
        const signals = this.getBugCandidateSignals(
          { filePath: result.filePath, name: result.name, content: result.content },
          subjectProfile,
          tags
        );
        const candidateFamilies = this.getBugCandidateFamilies(result);
        const matchedPrimaryFamilyCount = Array.from(candidateFamilies).filter((family) =>
          subjectProfile.primaryTags.has(family)
        ).length;
        const matchedRelatedFamilyCount = Array.from(candidateFamilies).filter((family) =>
          subjectProfile.relatedTags.has(family)
        ).length;
        const hasSpecificSubjectAnchor = this.hasBugSpecificSubjectAnchor(result, subjectProfile);
        const graphExpanded =
          keywordIds.has(result.id) || callerIds.has(result.id) || neighborIds.has(result.id) || seedResultIds.has(result.id);
        const structuralAnchorHit =
          signals.literalMatches > 0
          || signals.pathNameTermMatches > 0
          || signals.primaryTagMatches > 0
          || signals.relatedTagMatches > 0;
        const directStructuralAnchorHit =
          signals.pathNameTermMatches > 0
          || signals.primaryTagMatches > 0;
        const genericRuntimeHelper =
          /^(create|invoke|handle|handler|process|run|execute|load|update|fetch|submit|callback|memo)/.test(lowerName)
          || /\bcreate[_\s]?handler\b/.test(lowerName);
        const contradictions = this.collectBugContradictions(result, feature, signals);
        if (contradictions.includes("doc_or_test_like")) return null;
        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0 && !callerIds.has(result.id)) return null;
        if (
          this.isBugFrontendHandoffNoiseCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          return null;
        }
        if (
          this.isBugOffDomainBackendCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          return null;
        }
        if (
          this.isBugCrossDomainNoiseCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        if (
          this.isBugRedirectHandoffPrompt(subjectProfile)
          && !this.hasBugHandoffSpecificAnchor(result, signals)
          && !this.isBugRedirectBackboneCandidate(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        if (
          this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          && !this.hasBugHandoffSpecificAnchor(result, signals)
          && !this.isBugRedirectBackboneCandidate(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && !signals.strongDomainMatch
          && !graphExpanded
          && signals.implementationMatches === 0
          && signals.runtimeMatches === 0
        ) {
          return null;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && !this.hasBugMechanismAnchorSignals(signals, subjectProfile)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        let score = result.score;

        if (BUG_STRUCTURAL_NOISE_RE.test(lowerPath) || /\.mdx?$/i.test(lowerPath)) score *= 0.05;
        if (BUG_UI_NOISE_RE.test(fileBase) && !BUG_GATE_RE.test(combined)) score *= 0.25;
        if (/(?:^|\/)styles?\//.test(lowerPath)) score *= 0.2;
        if (/registry/i.test(result.name) && !BUG_GATE_RE.test(combined)) score *= 0.3;
        if (this.isImplementationChunk(result)) score *= 1.12;
        if (seedAnchorIds.has(result.id)) score *= 3.8;
        if (seedResultIds.has(result.id)) score *= 1.85;
        if (structuralSupportIds.has(result.id)) score *= 2.35;
        if (
          seedResultIds.has(result.id)
          && (signals.pathNameTermMatches > 0 || signals.primaryTagMatches > 0)
        ) {
          score *= 1.45;
        }
        if (anchoredSemanticSeedIds.has(result.id)) score *= 1.45;
        else if (semanticSeedIds.has(result.id)) score *= 1.12;
        if (keywordIds.has(result.id)) score *= 1.8;
        if (callerIds.has(result.id)) score *= 1.7;
        if (neighborIds.has(result.id)) score *= 1.35;
        if (
          hasStrongKeywordAnchors
          && !keywordIds.has(result.id)
          && !callerIds.has(result.id)
          && !this.hasBugAnchorSignals(signals)
        ) {
          score *= 0.22;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && !structuralAnchorHit
          && !callerIds.has(result.id)
          && !semanticSeedIds.has(result.id)
        ) {
          score *= 0.18;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && genericRuntimeHelper
          && !directStructuralAnchorHit
          && !callerIds.has(result.id)
          && !semanticSeedIds.has(result.id)
        ) {
          score *= 0.08;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && semanticSeedIds.has(result.id)
          && !directStructuralAnchorHit
          && signals.primaryTagMatches === 0
          && signals.pathNameTermMatches === 0
          && signals.literalMatches === 0
        ) {
          score *= 0.02;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && keywordIds.has(result.id)
          && !structuralAnchorHit
          && signals.literalMatches === 0
          && signals.semanticMatches === 0
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          score *= 0.08;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && candidateFamilies.size > 0
          && !Array.from(candidateFamilies).some((family) =>
            subjectProfile.primaryTags.has(family) || subjectProfile.relatedTags.has(family)
          )
          && signals.rawLiteralMatches === 0
          && signals.pathNameTermMatches === 0
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.08;
        }
        if (
          subjectProfile.primaryTags.size >= 2
          && matchedPrimaryFamilyCount === 0
          && matchedRelatedFamilyCount === 0
          && signals.pathNameTermMatches === 0
          && signals.rawLiteralMatches === 0
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        if (subjectProfile.primaryTags.size >= 2 && matchedPrimaryFamilyCount >= 2) score *= 1.45;
        else if (
          subjectProfile.primaryTags.size >= 2
          && matchedPrimaryFamilyCount === 1
          && !seedResultIds.has(result.id)
        ) {
          score *= 0.55;
        }
        if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)) {
          if (matchedPrimaryFamilyCount >= 2) score *= 1.4;
          else if (
            matchedPrimaryFamilyCount === 1
            && !callerIds.has(result.id)
            && !neighborIds.has(result.id)
            && !seedAnchorIds.has(result.id)
          ) {
            score *= 0.08;
          } else if (
            matchedPrimaryFamilyCount === 0
            && !callerIds.has(result.id)
            && !neighborIds.has(result.id)
            && !seedAnchorIds.has(result.id)
          ) {
            score *= 0.02;
          }
        }
        if (
          (subjectProfile.primaryTags.has("connection") || subjectProfile.primaryTags.has("schema"))
          && !hasSpecificSubjectAnchor
          && matchedPrimaryFamilyCount === 0
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.02;
        }
        if (this.isBugRedirectNoiseCandidate(result, signals, subjectProfile)) score *= 0.04;
        if (
          this.isBugGenericNavigationLeaf(result, signals, subjectProfile)
          && !seedAnchorIds.has(result.id)
          && !callerIds.has(result.id)
        ) {
          score *= 0.04;
        }
        if (
          this.isBugGenericStateSupportNoiseCandidate(result, subjectProfile, signals)
          && !seedAnchorIds.has(result.id)
          && !callerIds.has(result.id)
        ) {
          score *= 0.03;
        }
        if (
          this.isBugUnrelatedExecutionNoiseCandidate(result, subjectProfile, signals)
          && !seedAnchorIds.has(result.id)
          && !neighborIds.has(result.id)
        ) {
          score *= callerIds.has(result.id) ? 0.08 : 0.03;
        }
        if (
          this.isBugFrontendHandoffNoiseCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.02;
        }
        if (
          this.isBugOffDomainBackendCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.04;
        }
        if (
          this.isBugCrossDomainNoiseCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.03;
        }
        if (
          this.isBugRedirectHandoffPrompt(subjectProfile)
          && /\b(protected|guard|redirect|callback|auth|route|router|destination|pending|session)\b/.test(combined)
        ) {
          score *= 1.35;
        }
        if (
          this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          && !this.hasBugHandoffSpecificAnchor(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.05;
        }
        if (
          this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          && !this.hasBugFrontendAuthRoutingPair(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.04;
        }
        if (
          this.isBugRedirectHandoffPrompt(subjectProfile)
          && !this.isBugRedirectBackboneCandidate(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.02;
        }
        if (
          this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          && callerIds.has(result.id)
          && !this.hasBugFrontendAuthRoutingPair(result, signals)
        ) {
          score *= 0.08;
        }
        if (this.isBugMigrationNoiseCandidate(result, subjectProfile, signals)) score *= 0.01;
        if (feature?.isValidator) score *= 1.85;
        if (feature?.isGuard) score *= 1.55;
        if (feature?.isPredicate) score *= 1.45;
        if (feature?.returnsBoolean) score *= 1.35;
        if ((feature?.callsPredicateCount ?? 0) > 0) score *= 1 + Math.min(0.8, (feature?.callsPredicateCount ?? 0) * 0.08);
        if ((feature?.branchCount ?? 0) > 0) score *= 1 + Math.min(0.4, (feature?.branchCount ?? 0) * 0.03);
        if (BUG_GATE_RE.test(combined)) score *= 1.75;
        if (/\b(return\s+false|return\s+true|throw\s+new|if\s*\(|switch\s*\(|case\s+)/.test(lowerContent)) score *= 1.15;
        if (signals.implementationMatches > 0) score *= 1 + Math.min(0.35, signals.implementationMatches * 0.08);
        if (signals.runtimeMatches > 0) score *= 1 + Math.min(0.3, signals.runtimeMatches * 0.07);
        if (signals.architectureMatches > 0) score *= 1 + Math.min(0.25, signals.architectureMatches * 0.05);
        if (signals.controlFlowMatches > 0) score *= 1 + Math.min(0.25, signals.controlFlowMatches * 0.06);
        if (signals.dataFlowMatches > 0) score *= 1 + Math.min(0.2, signals.dataFlowMatches * 0.04);
        if (this.isBugOrchestratorCandidate(result, feature)) score *= 1.45;
        const anchoredCallerReference = callerIds.has(result.id)
          && keywordResults.some((anchor) => result.content.includes(anchor.name));
        if (anchoredCallerReference) score *= 1.35;
        if (callerIds.has(result.id) && this.isBugLeafUiLike(result)) score *= 0.72;
        if (
          callerIds.has(result.id)
          && subjectProfile.primaryTags.size > 0
          && !anchoredCallerReference
          && signals.literalMatches === 0
          && signals.semanticMatches === 0
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          score *= 0.62;
        }
        if (contradictions.includes("registry_without_runtime")) score *= 0.2;
        if (contradictions.includes("ui_wrapper_without_runtime")) score *= 0.18;
        if (contradictions.includes("passive_declaration")) score *= 0.16;
        if (contradictions.includes("lexical_only")) score *= 0.65;

        if (signals.termMatches > 0) score *= 1 + Math.min(0.45, signals.termMatches * 0.12);
        if (signals.pathNameTermMatches > 0) score *= 1 + Math.min(0.8, signals.pathNameTermMatches * 0.2);
        if (signals.primaryTagMatches > 0) score *= 1 + Math.min(0.6, signals.primaryTagMatches * 0.18);
        if (signals.relatedTagMatches > 0) score *= 1 + Math.min(0.2, signals.relatedTagMatches * 0.08);
        if (signals.negativeMatches > 0) score *= Math.max(0.04, 1 - signals.negativeMatches * 0.55);
        if (
          subjectProfile.primaryTags.size > 0
          && (feature?.writesState || feature?.writesStorage)
          && signals.primaryTagMatches === 0
          && signals.pathNameTermMatches === 0
          && signals.literalMatches === 0
          && !callerIds.has(result.id)
        ) {
          score *= 0.2;
        }
        if (
          subjectProfile.subjectTerms.length >= 2
          && !signals.strongDomainMatch
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= signals.termMatches === 0 ? 0.05 : 0.18;
        } else if (
          subjectProfile.subjectTerms.length > 0
          && !signals.strongDomainMatch
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.18;
        }
        if (result.kind.includes("function") || result.kind.includes("method")) score *= 1.15;
        if (result.kind === "file") score *= 0.7;

        return {
          result,
          score,
          keywordHit: keywordIds.has(result.id),
          semanticHit: semanticSeedIds.has(result.id),
          callerHit: callerIds.has(result.id),
          seedHit: seedResultIds.has(result.id),
          strongDomainMatch: signals.strongDomainMatch,
          callsPredicateCount: feature?.callsPredicateCount ?? 0,
          contradictions,
          feature,
          signals,
        };
      })
      .filter((candidate): candidate is BugScoredCandidate => candidate !== null)
      .sort((a, b) => b.score - a.score);

    const diagnostics: BugSelectionDiagnostics = {
      queryDecomposition: subjectProfile.decomposition,
      searchStepsUsed: ["literal", "vector", "ast", "runtime-path", "query reformulation fusion", "graph expansion", "neighborhood expansion", "contradiction check"],
      subjectTerms,
      primaryTags: Array.from(subjectProfile.primaryTags),
      inputResults: results.slice(0, 8).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      semanticSeedResults: semanticSeedResults.slice(0, 5).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      keywordResults: keywordResults.slice(0, 5).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      callerResults: callerResults.slice(0, 5).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      neighborResults: neighborResults.slice(0, 5).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      scored: scored.slice(0, 8).map((item) => ({
        name: item.result.name,
        filePath: item.result.filePath,
        score: item.score,
        keywordHit: item.keywordHit,
        semanticHit: item.semanticHit,
        callerHit: item.callerHit,
        seedHit: item.seedHit,
        strongDomainMatch: item.strongDomainMatch,
        callsPredicateCount: item.callsPredicateCount,
      })),
      topCandidates: scored.slice(0, 5).map((item, index) => ({
        filePath: item.result.filePath,
        symbol: item.result.name,
        confidence: Math.max(15, Math.round((item.score / (scored[0]?.score || 1)) * 100) - index * 4),
        evidence: [
          ...(item.keywordHit ? ["literal_or_symbol_hit"] : []),
          ...(item.semanticHit ? ["runtime_feature_hit"] : []),
          ...(item.callerHit ? ["graph_caller_hit"] : []),
          ...(item.seedHit ? ["seed_anchor_hit"] : []),
          ...(item.signals.implementationMatches > 0 ? ["implementation_term_match"] : []),
          ...(item.signals.runtimeMatches > 0 ? ["runtime_term_match"] : []),
          ...(this.isBugOrchestratorCandidate(item.result, item.feature) ? ["orchestrator_candidate"] : []),
        ],
      })),
      contradictions: scored
        .filter((item) => item.contradictions.length > 0)
        .slice(0, 5)
        .map((item) => ({
          filePath: item.result.filePath,
          symbol: item.result.name,
          reasons: item.contradictions,
        })),
      nextPivots: Array.from(new Set([
        ...Array.from(new Set(
          [...keywordResults, ...semanticSeedResults]
            .filter((result) => result.kind.includes("function") || result.kind.includes("method"))
            .slice(0, 2)
            .map((result) => `expand direct callers of ${result.name}`)
        )),
        ...(scored[0] ? [`inspect executable neighbors in ${scored[0].result.filePath}`] : []),
        "compare top runtime candidates against registry/ui-wrapper contradictions",
      ])).slice(0, 3),
    };

    this._lastDiagnostics = diagnostics;

    // -- Selection phase ---
    const selected: SearchResult[] = [];
    const seenFiles = new Set<string>();
    const primaryAnchorResults = keywordResults
      .filter((result) => {
        const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
        const signals = this.getBugCandidateSignals(
          { filePath: result.filePath, name: result.name, content: result.content },
          subjectProfile,
          tags
        );
        return this.hasBugAnchorSignals(signals);
      })
      .filter((result) => result.kind.includes("function") || result.kind.includes("method"))
      .slice(0, 2);
    const anchorGateNames = Array.from(new Set(
      [
        ...primaryAnchorResults,
        ...semanticSeedResults.filter((result) => anchoredSemanticSeedIds.has(result.id)),
      ]
        .filter((result) => result.kind.includes("function") || result.kind.includes("method"))
        .map((result) => result.name)
    )).slice(0, 3);
    const bestScoredByFile = new Map<string, typeof scored[number]>();
    for (const candidate of scored) {
      const existing = bestScoredByFile.get(candidate.result.filePath);
      if (!existing || candidate.score > existing.score) {
        bestScoredByFile.set(candidate.result.filePath, candidate);
      }
    }
    const takeCandidate = (candidate: typeof scored[number] | undefined) => {
      if (!candidate) return;
      if (selected.length >= maxFiles) return;
      if (seenFiles.has(candidate.result.filePath)) return;
      const lowerPath = candidate.result.filePath.toLowerCase();
      if ((BUG_STRUCTURAL_NOISE_RE.test(lowerPath) || /\.mdx?$/i.test(lowerPath)) && selected.length > 0) return;
      selected.push({
        ...candidate.result,
        hookScore: candidate.score,
        score: Math.max(candidate.result.score, candidate.score),
      });
      seenFiles.add(candidate.result.filePath);
    };

    const handoffPrimaryCandidate = this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
      ? [...scored]
          .filter((candidate) => structuralSupportIds.has(candidate.result.id) || candidate.seedHit || candidate.keywordHit)
          .filter((candidate) => candidate.strongDomainMatch)
          .filter((candidate) => this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals))
          .filter((candidate) => this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals))
          .filter((candidate) => !this.isBugGenericAuthEntryCandidate(candidate.result, subjectProfile, candidate.signals))
          .filter((candidate) => !this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
          .sort((a, b) => {
            const aLayers = this.detectWorkflowLayers(a.result.filePath.toLowerCase(), a.result.name.toLowerCase());
            const bLayers = this.detectWorkflowLayers(b.result.filePath.toLowerCase(), b.result.name.toLowerCase());
            const aRouting = aLayers.includes("routing") ? 80 : 0;
            const bRouting = bLayers.includes("routing") ? 80 : 0;
            const aState = aLayers.includes("state") ? 35 : 0;
            const bState = bLayers.includes("state") ? 35 : 0;
            const aPair = this.hasBugFrontendAuthRoutingPair(a.result, a.signals) ? 160 : 0;
            const bPair = this.hasBugFrontendAuthRoutingPair(b.result, b.signals) ? 160 : 0;
            const aSignal = a.signals.pathNameTermMatches * 60 + a.signals.primaryTagMatches * 50 + a.signals.rawLiteralMatches * 35;
            const bSignal = b.signals.pathNameTermMatches * 60 + b.signals.primaryTagMatches * 50 + b.signals.rawLiteralMatches * 35;
            return (bPair + bRouting + bState + bSignal + b.score) - (aPair + aRouting + aState + aSignal + a.score);
          })[0]
      : undefined;
    const primarySeedCandidate = [...scored]
      .filter((candidate) => candidate.seedHit && candidate.strongDomainMatch)
      .filter((candidate) =>
        !this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
        || (
          !this.isBugGenericAuthEntryCandidate(candidate.result, subjectProfile, candidate.signals)
          && !this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals)
          && !this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals)
          && (
            this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals)
            || this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
            || candidate.signals.pathNameTermMatches > 0
            || candidate.signals.primaryTagMatches > 0
          )
        )
      )
      .sort((a, b) => {
        const aSpecificity = a.signals.pathNameTermMatches * 90 + a.signals.primaryTagMatches * 70 + a.signals.rawLiteralMatches * 50;
        const bSpecificity = b.signals.pathNameTermMatches * 90 + b.signals.primaryTagMatches * 70 + b.signals.rawLiteralMatches * 50;
        const aGate = this.isBugGateLike(a.result, a.feature) ? 50 : 0;
        const bGate = this.isBugGateLike(b.result, b.feature) ? 50 : 0;
        return (bSpecificity + bGate + b.score) - (aSpecificity + aGate + a.score);
      })[0];
    const initialFallbackCandidate = [...scored].find((candidate) => {
      if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)) {
        if (this.isBugGenericAuthEntryCandidate(candidate.result, subjectProfile, candidate.signals)) return false;
        if (this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals)) return false;
        if (this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals)) return false;
        return this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals)
          || this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
          || candidate.signals.pathNameTermMatches > 0
          || candidate.signals.primaryTagMatches > 0;
      }
      return candidate.keywordHit && candidate.strongDomainMatch;
    }) ?? scored.find((candidate) => candidate.semanticHit && candidate.strongDomainMatch);
    takeCandidate(
      handoffPrimaryCandidate
      ?? primarySeedCandidate
      ?? [...scored].find((candidate) => structuralSupportIds.has(candidate.result.id) && candidate.strongDomainMatch)
      ?? initialFallbackCandidate
    );
    if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile) && selected.length < 2) {
      const structuralCallbackCandidate = [...scored]
        .filter((candidate) => structuralSupportIds.has(candidate.result.id))
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) => this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals))
        .sort((a, b) => b.score - a.score)[0];
      takeCandidate(structuralCallbackCandidate);
    }
    if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile) && selected.length < 2) {
      const callbackBackboneCandidate = [...scored]
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) => candidate.strongDomainMatch || candidate.keywordHit || candidate.seedHit)
        .filter((candidate) => this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals))
        .filter((candidate) => !this.isBugFrontendHandoffNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals))
        .sort((a, b) => {
          const aText = `${a.result.filePath} ${a.result.name}`.toLowerCase();
          const bText = `${b.result.filePath} ${b.result.name}`.toLowerCase();
          const aCallback = /\b(callback|redirect|pending|destination|return)\b/.test(aText) ? 140 : 0;
          const bCallback = /\b(callback|redirect|pending|destination|return)\b/.test(bText) ? 140 : 0;
          const aAnchor = a.signals.pathNameTermMatches * 45 + a.signals.primaryTagMatches * 30;
          const bAnchor = b.signals.pathNameTermMatches * 45 + b.signals.primaryTagMatches * 30;
          return (bCallback + bAnchor + b.score) - (aCallback + aAnchor + a.score);
        })[0];
      takeCandidate(callbackBackboneCandidate);
    }
    const primarySelectedIsGate = selected[0]
      ? this.isBugGateLike(selected[0], featureMap.get(selected[0].id))
      : false;
    const primarySelectedIsOrchestrator = selected[0]
      ? this.isBugOrchestratorCandidate(selected[0], featureMap.get(selected[0].id))
      : false;
    if (primarySelectedIsOrchestrator && !primarySelectedIsGate) {
      takeCandidate(
        [...scored]
          .filter((candidate) =>
            !seenFiles.has(candidate.result.filePath)
            && candidate.strongDomainMatch
            && this.isBugGateLike(candidate.result, candidate.feature)
            && (
              candidate.signals.pathNameTermMatches > 0
              || candidate.signals.rawLiteralMatches > 0
              || candidate.signals.primaryTagMatches > 0
              || candidate.seedHit
            )
          )
          .sort((a, b) => {
            const aSignalScore =
              a.signals.pathNameTermMatches * 60
              + a.signals.primaryTagMatches * 50
              + a.signals.implementationMatches * 20
              + a.signals.runtimeMatches * 16
              + (a.seedHit ? 30 : 0)
              + a.score;
            const bSignalScore =
              b.signals.pathNameTermMatches * 60
              + b.signals.primaryTagMatches * 50
              + b.signals.implementationMatches * 20
              + b.signals.runtimeMatches * 16
              + (b.seedHit ? 30 : 0)
              + b.score;
            return bSignalScore - aSignalScore;
          })[0]
      );
    }
    if (selected.length < 2 && this.needsDedicatedBugGateCompanion(subjectProfile)) {
      const structuralGateCandidate = [...scored]
        .filter((candidate) => structuralSupportIds.has(candidate.result.id))
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) => this.isBugGateLike(candidate.result, candidate.feature) || candidate.signals.pathNameTermMatches > 0 || candidate.signals.primaryTagMatches > 0)
        .sort((a, b) => b.score - a.score)[0];
      takeCandidate(structuralGateCandidate);
    }
    if (selected.length < 2 && this.needsDedicatedBugGateCompanion(subjectProfile)) {
      takeCandidate(
        [...scored]
          .filter((candidate) =>
        !seenFiles.has(candidate.result.filePath)
        && !candidate.feature?.isUiComponent
        && candidate.strongDomainMatch
        && this.isBugGateLike(candidate.result, candidate.feature)
        && (
          this.hasBugSpecificSubjectAnchor(candidate.result, subjectProfile)
          || candidate.signals.primaryTagMatches > 0
          || candidate.signals.pathNameTermMatches > 0
          || this.hasBugDirectAnchorSignals(candidate.signals)
          || this.hasBugMechanismAnchorSignals(candidate.signals, subjectProfile)
          || candidate.seedHit
        )
      )
          .sort((a, b) => {
            const aDirect = this.hasBugDirectAnchorSignals(a.signals) ? 90 : 0;
            const bDirect = this.hasBugDirectAnchorSignals(b.signals) ? 90 : 0;
            const aMechanism = this.hasBugMechanismAnchorSignals(a.signals, subjectProfile) ? 60 : 0;
            const bMechanism = this.hasBugMechanismAnchorSignals(b.signals, subjectProfile) ? 60 : 0;
            const aSignal = a.signals.pathNameTermMatches * 70 + a.signals.primaryTagMatches * 60 + a.signals.semanticMatches * 24;
            const bSignal = b.signals.pathNameTermMatches * 70 + b.signals.primaryTagMatches * 60 + b.signals.semanticMatches * 24;
            return (bDirect + bMechanism + bSignal + b.score) - (aDirect + aMechanism + aSignal + a.score);
          })[0]
      );
    }
    const callerAnchorCandidates = [...scored]
      .filter((candidate) =>
        candidate.callerHit
        && !seenFiles.has(candidate.result.filePath)
        && (!primarySelectedIsGate || !(candidate.feature?.isValidator || candidate.feature?.isGuard || candidate.feature?.isPredicate))
        && (
          !this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          || this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals)
          || this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
        )
      );
    const nonLeafCallerAnchorCandidates = callerAnchorCandidates.filter(
      (candidate) => !this.isBugLeafUiLike(candidate.result)
    );
    const anchorCallerCandidate = (nonLeafCallerAnchorCandidates.length > 0
      ? nonLeafCallerAnchorCandidates
      : callerAnchorCandidates)
      .sort((a, b) => {
        const aAnchorRefs = anchorGateNames.filter((gateName) => a.result.content.includes(gateName)).length;
        const bAnchorRefs = anchorGateNames.filter((gateName) => b.result.content.includes(gateName)).length;
        const aDomain = a.signals.literalMatches + a.signals.semanticMatches + a.signals.termMatches + a.signals.pathNameTermMatches + a.signals.primaryTagMatches;
        const bDomain = b.signals.literalMatches + b.signals.semanticMatches + b.signals.termMatches + b.signals.pathNameTermMatches + b.signals.primaryTagMatches;
        const aControl = (a.feature?.branchCount ?? 0) + (a.feature?.callsPredicateCount ?? 0);
        const bControl = (b.feature?.branchCount ?? 0) + (b.feature?.callsPredicateCount ?? 0);
        const aMechanismPenalty = (a.feature?.isValidator || a.feature?.isGuard || a.feature?.isPredicate) ? 45 : 0;
        const bMechanismPenalty = (b.feature?.isValidator || b.feature?.isGuard || b.feature?.isPredicate) ? 45 : 0;
        const aUiPenalty = a.feature?.isUiComponent && aDomain === 0 ? 500 : 0;
        const bUiPenalty = b.feature?.isUiComponent && bDomain === 0 ? 500 : 0;
        const aLeafPenalty = this.isBugLeafUiLike(a.result) ? 120 : 0;
        const bLeafPenalty = this.isBugLeafUiLike(b.result) ? 120 : 0;
        return (bAnchorRefs * 120 + bDomain * 24 + bControl * 6 + b.score - bMechanismPenalty - bUiPenalty - bLeafPenalty)
          - (aAnchorRefs * 120 + aDomain * 24 + aControl * 6 + a.score - aMechanismPenalty - aUiPenalty - aLeafPenalty);
      })[0];
    if (this.isBugAuthRoutingPrompt(subjectProfile) && selected.length < 2) {
      const authRoutingSupportCandidate = [...scored]
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) => candidate.strongDomainMatch)
        .filter((candidate) =>
          this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
          || this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals)
        )
        .filter((candidate) => !this.isBugGenericNavigationLeaf(candidate.result, candidate.signals, subjectProfile))
        .filter((candidate) => !this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals))
        .sort((a, b) => {
          const aText = `${a.result.filePath} ${a.result.name}`.toLowerCase();
          const bText = `${b.result.filePath} ${b.result.name}`.toLowerCase();
          const aBackbone = this.isBugRedirectBackboneCandidate(a.result, a.signals) ? 110 : 0;
          const bBackbone = this.isBugRedirectBackboneCandidate(b.result, b.signals) ? 110 : 0;
          const aHandoff = this.hasBugHandoffSpecificAnchor(a.result, a.signals) ? 80 : 0;
          const bHandoff = this.hasBugHandoffSpecificAnchor(b.result, b.signals) ? 80 : 0;
          const aAnchor = a.signals.pathNameTermMatches * 35 + a.signals.primaryTagMatches * 35 + a.signals.rawLiteralMatches * 20;
          const bAnchor = b.signals.pathNameTermMatches * 35 + b.signals.primaryTagMatches * 35 + b.signals.rawLiteralMatches * 20;
          const aPenalty = /\b(generate|storage|upload|billing|credit|pricing|service-status)\b/.test(aText) ? 140 : 0;
          const bPenalty = /\b(generate|storage|upload|billing|credit|pricing|service-status)\b/.test(bText) ? 140 : 0;
          return (bBackbone + bHandoff + bAnchor + b.score - bPenalty)
            - (aBackbone + aHandoff + aAnchor + a.score - aPenalty);
        })[0];
      takeCandidate(authRoutingSupportCandidate);
    }
    takeCandidate(anchorCallerCandidate);
    if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile) && selected.length < 2) {
      const primaryLayers = selected[0]
        ? this.detectWorkflowLayers(selected[0].filePath.toLowerCase(), selected[0].name.toLowerCase())
        : [];
      const handoffSupportCandidate = [...scored]
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) =>
          candidate.strongDomainMatch
          || this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
        )
        .filter((candidate) =>
          this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
          || candidate.seedHit
          || candidate.keywordHit
          || candidate.callerHit
        )
        .filter((candidate) => this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals))
        .filter((candidate) => !this.isBugFrontendHandoffNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugGenericAuthEntryCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
        .sort((a, b) => {
          const aLayers = this.detectWorkflowLayers(a.result.filePath.toLowerCase(), a.result.name.toLowerCase());
          const bLayers = this.detectWorkflowLayers(b.result.filePath.toLowerCase(), b.result.name.toLowerCase());
          const aText = `${a.result.filePath} ${a.result.name}`.toLowerCase();
          const bText = `${b.result.filePath} ${b.result.name}`.toLowerCase();
          const aBackbone = this.isBugRedirectBackboneCandidate(a.result, a.signals) ? 180 : 0;
          const bBackbone = this.isBugRedirectBackboneCandidate(b.result, b.signals) ? 180 : 0;
          const aRouting = aLayers.includes("routing") ? 120 : 0;
          const bRouting = bLayers.includes("routing") ? 120 : 0;
          const aState = aLayers.includes("state") ? 70 : 0;
          const bState = bLayers.includes("state") ? 70 : 0;
          const aUi = aLayers.includes("ui") ? 30 : 0;
          const bUi = bLayers.includes("ui") ? 30 : 0;
          const aDiversity = aLayers.some((layer) => !primaryLayers.includes(layer)) ? 45 : 0;
          const bDiversity = bLayers.some((layer) => !primaryLayers.includes(layer)) ? 45 : 0;
          const aAnchor = /\b(callback|redirect|protected|guard|pending|destination|auth|session|route|router|navigation)\b/.test(aText) ? 90 : 0;
          const bAnchor = /\b(callback|redirect|protected|guard|pending|destination|auth|session|route|router|navigation)\b/.test(bText) ? 90 : 0;
          const aSignal = a.signals.pathNameTermMatches * 40 + a.signals.primaryTagMatches * 40 + a.signals.rawLiteralMatches * 25;
          const bSignal = b.signals.pathNameTermMatches * 40 + b.signals.primaryTagMatches * 40 + b.signals.rawLiteralMatches * 25;
          const aUtilityPenalty = this.isUtilityLikePath(a.result.filePath.toLowerCase(), a.result.name.toLowerCase()) ? 80 : 0;
          const bUtilityPenalty = this.isUtilityLikePath(b.result.filePath.toLowerCase(), b.result.name.toLowerCase()) ? 80 : 0;
          return (bBackbone + bRouting + bState + bUi + bDiversity + bAnchor + bSignal + b.score - bUtilityPenalty)
            - (aBackbone + aRouting + aState + aUi + aDiversity + aAnchor + aSignal + a.score - aUtilityPenalty);
        })[0];
      takeCandidate(handoffSupportCandidate);
    }
    takeCandidate(
      (() => {
        const callerCandidate = scored.find((candidate) =>
          candidate.callerHit
          && candidate.strongDomainMatch
          && !seenFiles.has(candidate.result.filePath)
          && (!primarySelectedIsGate || !(candidate.feature?.isValidator || candidate.feature?.isGuard || candidate.feature?.isPredicate))
        );
        return callerCandidate ? bestScoredByFile.get(callerCandidate.result.filePath) ?? callerCandidate : undefined;
      })()
    );

    const hasFocusedBugPair =
      selected.length >= 2
      && primarySelectedIsGate
      && !!anchorCallerCandidate
      && seenFiles.has(anchorCallerCandidate.result.filePath);

    for (const candidate of scored) {
      if (hasFocusedBugPair) break;
      if (selected.length >= maxFiles) break;
      if (
        primarySelectedIsOrchestrator
        && !primarySelectedIsGate
        && !seenFiles.has(candidate.result.filePath)
        && candidate.signals.pathNameTermMatches === 0
        && candidate.signals.rawLiteralMatches === 0
        && candidate.signals.primaryTagMatches === 0
        && !candidate.callerHit
        && !candidate.seedHit
      ) {
        continue;
      }
      takeCandidate(candidate);
    }

    const promoted = selected.map((result) => {
      const feature = featureMap.get(result.id);
      if (
        (result.kind.includes("function") || result.kind.includes("method"))
        && this.isBugOrchestratorCandidate(result, feature)
        && anchorGateNames.some((gateName) => result.content.includes(gateName))
      ) {
        return result;
      }
      return this.promoteBugRepresentativeChunk(result, subjectProfile);
    });
    const cappedPromoted = this.isBugBackendRequestPrompt(subjectProfile)
      ? promoted.slice(0, 1)
      : promoted;
    const final = cappedPromoted.map((result, index) => {
      const normalizedScore = Math.max(1, 3 - index * 0.2);
      return {
        ...result,
        score: normalizedScore,
        hookScore: Math.max(result.hookScore ?? 0, normalizedScore),
      };
    });
    return final;
  }

  /** Return the diagnostics produced by the last selectBugLocalizationBundle call. */
  get lastDiagnostics(): BugSelectionDiagnostics | null {
    return this._lastDiagnostics;
  }
  private _lastDiagnostics: BugSelectionDiagnostics | null = null;

  buildBugPredicateResults(profile: BugSubjectProfile): SearchResult[] {
    const chunks = this.metadata.findPredicateLikeChunks(240);
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(chunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
    );
    const tagMap = new Map<string, string[]>();
    for (const tag of this.metadata.getChunkTagsByIds(chunks.map((chunk) => chunk.id))) {
      const existing = tagMap.get(tag.chunkId) ?? [];
      existing.push(tag.tag);
      tagMap.set(tag.chunkId, existing);
    }

    return chunks
      .filter((chunk) => !isTestFile(chunk.filePath))
      .filter((chunk) => this.isImplementationPath(chunk.filePath))
      .map((chunk) => {
        const feature = featureMap.get(chunk.id);
        if (!feature) return null;
        if (feature.docLike || feature.testLike) return null;
        const tags = tagMap.get(chunk.id) ?? [];
        const signals = this.getBugCandidateSignals(
          { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
          profile,
          tags
        );
        const anchored = this.hasBugMechanismAnchorSignals(signals, profile) || (profile.primaryTags.size === 0 && signals.relatedTagMatches > 0);
        const strictConnectionPrompt = profile.primaryTags.has("connection") || profile.primaryTags.has("schema");
        if (profile.focusTerms.length >= 2 && !signals.strongDomainMatch && signals.implementationMatches === 0 && signals.runtimeMatches === 0) return null;
        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0) return null;
        if (profile.focusTerms.length > 0 && !anchored) return null;
        if (
          strictConnectionPrompt
          && !this.hasBugSpecificSubjectAnchor(chunk, profile)
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          return null;
        }
        if (feature.isRegistry && !signals.strongDomainMatch) return null;
        if (feature.isUiComponent && !signals.strongDomainMatch && signals.runtimeMatches === 0) return null;
        if (this.isBugRedirectNoiseCandidate(chunk, signals, profile)) return null;
        if (this.isBugFrontendHandoffNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugOffDomainBackendCandidate(chunk, profile, signals)) return null;
        if (this.isBugCrossDomainNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugMigrationNoiseCandidate(chunk, profile, signals)) return null;

        let score = 2.5;
        if (feature.isValidator) score += 2;
        if (feature.isGuard) score += 1.8;
        if (feature.isPredicate) score += 1.4;
        score += Math.min(1.6, signals.termMatches * 0.45);
        score += Math.min(1.2, signals.implementationMatches * 0.3 + signals.runtimeMatches * 0.25);
        score += Math.min(1.8, signals.pathNameTermMatches * 0.7);
        score += Math.min(1.8, signals.primaryTagMatches * 0.7);
        score += Math.min(0.5, signals.relatedTagMatches * 0.2);
        score += Math.min(1.2, feature.branchCount * 0.1 + feature.guardCount * 0.25);
        score += Math.min(0.8, feature.callsPredicateCount * 0.2);
        score += signals.runtimeGateOverlap ? 1.5 : 0;
        if (feature.isController) score += 0.8;
        if (feature.writesState || feature.writesNetwork || feature.writesStorage) score += 0.2;
        if (feature.isRegistry) score -= 1.2;
        if (feature.isUiComponent && !signals.strongDomainMatch) score -= 1.2;
        score -= Math.min(3, signals.negativeMatches * 1.2);

        return this.chunkToSearchResult(chunk, score);
      })
      .filter((chunk): chunk is SearchResult => !!chunk)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }

  buildBugCallerResults(results: SearchResult[], profile: BugSubjectProfile): SearchResult[] {
    const gateCandidates = results
      .filter((result) => BUG_GATE_RE.test(`${result.filePath} ${result.name}`))
      .filter((result) => {
        const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
        const signals = this.getBugCandidateSignals(
          { filePath: result.filePath, name: result.name, content: result.content },
          profile,
          tags
        );
        return this.hasBugMechanismAnchorSignals(signals, profile);
      })
      .filter((result) => result.kind.includes("function") || result.kind.includes("method"))
      .slice(0, 8);

    const callerScores = new Map<string, number>();
    for (const result of gateCandidates) {
      let gateScore = 6.5;
      if (BUG_GATE_RE.test(`${result.filePath} ${result.name}`)) gateScore += 1.5;
      if (result.hookScore) gateScore += Math.min(1.5, result.hookScore * 0.08);
      const callers = this.metadata.findCallers(result.name, 4, result.filePath);
      for (const caller of callers) {
        const current = callerScores.get(caller.chunkId) ?? 0;
        callerScores.set(caller.chunkId, Math.max(current, gateScore));
      }
    }

    const callerChunks = this.metadata.getChunksByIds(Array.from(callerScores.keys()));
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(callerChunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
    );
    return callerChunks
      .filter((chunk) => !isTestFile(chunk.filePath))
      .filter((chunk) => this.isImplementationPath(chunk.filePath))
      .map((chunk, index) => {
        const feature = featureMap.get(chunk.id);
        const tags = this.metadata.getChunkTagsByIds([chunk.id]).map((tag) => tag.tag);
        const signals = this.getBugCandidateSignals(
          { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
          profile,
          tags
        );
        if (
          (profile.primaryTags.has("connection") || profile.primaryTags.has("schema"))
          && !this.hasBugSpecificSubjectAnchor(chunk, profile)
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          return null;
        }
        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0) return null;
        if (this.isBugRedirectNoiseCandidate(chunk, signals, profile)) return null;
        if (this.isBugFrontendHandoffNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugOffDomainBackendCandidate(chunk, profile, signals)) return null;
        if (this.isBugCrossDomainNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugMigrationNoiseCandidate(chunk, profile, signals)) return null;
        let score = (callerScores.get(chunk.id) ?? 6.5) - index * 0.05;
        score += Math.min(1.8, (feature?.callsPredicateCount ?? 0) * 0.25);
        score += Math.min(1.2, (feature?.branchCount ?? 0) * 0.08 + (feature?.guardCount ?? 0) * 0.18);
        if (signals.pathNameTermMatches > 0) score += 1.2;
        if (signals.primaryTagMatches > 0) score += 1.2;
        if (signals.implementationMatches > 0) score += Math.min(1.4, signals.implementationMatches * 0.3);
        if (signals.runtimeMatches > 0) score += Math.min(1.1, signals.runtimeMatches * 0.25);
        if (signals.runtimeGateOverlap) score += 0.8;
        if (this.isBugOrchestratorCandidate(chunk, feature)) score += 1.2;
        if (feature?.isUiComponent && !signals.strongDomainMatch) score -= 1.2;
        return this.chunkToSearchResult(chunk, score);
      })
      .filter((chunk): chunk is SearchResult => chunk !== null)
      .sort((a, b) => b.score - a.score);
  }

  buildBugNeighborResults(results: SearchResult[], profile: BugSubjectProfile): SearchResult[] {
    const byFile = new Map<string, SearchResult[]>();
    for (const result of results) {
      const existing = byFile.get(result.filePath) ?? [];
      existing.push(result);
      byFile.set(result.filePath, existing);
    }

    const neighbors: SearchResult[] = [];
    for (const [filePath] of byFile) {
      const fileChunks = this.metadata.findChunksByFilePath(filePath);
      const localFeatures = new Map(
        this.metadata.getChunkFeaturesByIds(fileChunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
      );
      const ranked = fileChunks
        .map((chunk) => {
          const feature = localFeatures.get(chunk.id);
          if (!feature || feature.docLike || feature.testLike) return null;
          const tags = this.metadata.getChunkTagsByIds([chunk.id]).map((tag) => tag.tag);
          const signals = this.getBugCandidateSignals(
            { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
            profile,
            tags
          );
          let score = 0;
          if (feature.isValidator) score += 2.1;
          if (feature.isGuard) score += 1.8;
          if (feature.isPredicate) score += 1.2;
          score += Math.min(1.7, feature.branchCount * 0.12 + feature.guardCount * 0.3 + feature.callsPredicateCount * 0.25);
          score += Math.min(1.3, signals.termMatches * 0.5);
          score += Math.min(1.2, signals.implementationMatches * 0.3 + signals.runtimeMatches * 0.25);
          score += Math.min(1.8, signals.pathNameTermMatches * 0.8);
          score += Math.min(1.8, signals.primaryTagMatches * 0.8);
        if (signals.runtimeGateOverlap) score += 1.2;
        score += signals.surfaceAlignment * 0.9;
        return score > 0
            ? this.chunkToSearchResult(chunk, 5 + score)
            : null;
        })
        .filter((chunk): chunk is SearchResult => !!chunk)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      neighbors.push(...ranked);
    }

    return neighbors;
  }

  promoteBugRepresentativeChunk(result: SearchResult, profile: BugSubjectProfile): SearchResult {
    const fileChunks = this.metadata.findChunksByFilePath(result.filePath);
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(fileChunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
    );
    const tagMap = new Map<string, string[]>();
    for (const tag of this.metadata.getChunkTagsByIds(fileChunks.map((chunk) => chunk.id))) {
      const existing = tagMap.get(tag.chunkId) ?? [];
      existing.push(tag.tag);
      tagMap.set(tag.chunkId, existing);
    }
    const originalFeature = featureMap.get(result.id);
    const originalSignals = this.getBugCandidateSignals(
      { filePath: result.filePath, name: result.name, content: result.content },
      profile,
      tagMap.get(result.id) ?? []
    );
    const candidates = fileChunks
      .filter((chunk) => chunk.kind !== "file")
      .map((chunk) => {
        const feature = featureMap.get(chunk.id);
        const tags = tagMap.get(chunk.id) ?? [];
        const combinedRaw = `${chunk.filePath} ${chunk.name} ${chunk.content.slice(0, 1200)}`;
        const combined = combinedRaw.toLowerCase();
        const signals = this.getBugCandidateSignals(
          { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
          profile,
          tags
        );
        if (
          (profile.primaryTags.has("connection") || profile.primaryTags.has("schema"))
          && !this.hasBugSpecificSubjectAnchor(chunk, profile)
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          return null;
        }
        let score = 0;
        if (BUG_GATE_RE.test(combined)) score += 2.2;
        if (/(valid|validate|check|compat|connect|connection|guard|schema|reject|allow)/i.test(chunk.name)) score += 1.8;
        const termMatches = profile.subjectTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
        score += termMatches * 0.35;
        if (/\breturn\s+(true|false)\b/.test(combined)) score += 0.6;
        if (/\b(if|switch)\s*\(/.test(combined)) score += 0.4;
        if (chunk.kind.includes("function") || chunk.kind.includes("method")) score += 2.2;
        if (chunk.kind.includes("type") || chunk.kind.includes("interface")) score -= 1.4;
        if (feature?.isValidator) score += 2.6;
        if (feature?.isGuard) score += 1.9;
        if (feature?.isPredicate) score += 1.5;
        if (feature?.returnsBoolean) score += 1.2;
        if (feature?.isController) score += 1;
        score += Math.min(1.6, (feature?.callsPredicateCount ?? 0) * 0.35);
        score += Math.min(1.2, (feature?.branchCount ?? 0) * 0.08 + (feature?.guardCount ?? 0) * 0.18);
        score += Math.min(1.2, signals.implementationMatches * 0.3 + signals.runtimeMatches * 0.25);
        if (signals.pathNameTermMatches > 0) score += Math.min(2.4, signals.pathNameTermMatches * 0.7);
        if (signals.primaryTagMatches > 0) score += Math.min(2.4, signals.primaryTagMatches * 0.8);
        if (signals.runtimeGateOverlap) score += 1.1;
        score += signals.surfaceAlignment * 0.9;
        if (chunk.kind.includes("type") || chunk.kind.includes("interface")) score -= 4.5;
        if (feature?.isUiComponent && !signals.strongDomainMatch && signals.runtimeMatches === 0) score -= 3;
        if (feature?.isRegistry && !signals.strongDomainMatch) score -= 3;
        if (!signals.strongDomainMatch && signals.implementationMatches === 0 && signals.runtimeMatches === 0) score -= 2.5;
        return { chunk, score };
      })
      .filter((candidate): candidate is { chunk: StoredChunk; score: number } => candidate !== null)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0]?.chunk;
    if (!best || candidates[0]!.score <= 0) return result;
    const bestFeature = featureMap.get(best.id);
    if (
      this.isBugOrchestratorCandidate(result, originalFeature)
      && (result.kind.includes("function") || result.kind.includes("method"))
      && (
        (
          originalSignals.pathNameTermMatches > 0
          && originalSignals.strongDomainMatch
          && ((originalFeature?.callsPredicateCount ?? 0) > 0 || (originalFeature?.branchCount ?? 0) > 1)
        )
        || !this.isBugGateLike({ filePath: best.filePath, name: best.name, content: best.content }, bestFeature)
      )
    ) {
      return result;
    }

    return this.chunkToSearchResult(best, Math.max(result.score, result.hookScore ?? result.score));
  }

  // =========================================================================
  // Retrieval query builders
  // =========================================================================

  buildBugRetrievalQuery(query: string): string {
    const subjectTerms = this.extractBugSalientTerms(query)
      .filter((term) => term.length >= 3 && !BUG_GENERIC_TERMS.has(term));
    const profile = this.buildBugSubjectProfile(subjectTerms, query);
    const expanded = new Set<string>([
      ...profile.focusTerms,
      ...profile.decomposition.semanticVariants,
      ...profile.decomposition.implementationTerms,
    ]);
    for (const tag of profile.primaryTags) expanded.add(tag);
    for (const tag of profile.relatedTags) expanded.add(tag);
    if (this.isBugFrontendAuthRoutingHandoffPrompt(profile)) {
      for (const term of ["callback", "protected", "guard", "pending", "destination", "route"]) {
        expanded.add(term);
      }
    }
    if (profile.primaryTags.has("connection") || profile.primaryTags.has("schema")) {
      for (const term of ["schema", "compat", "edge", "handle", "editor", "flow"]) {
        expanded.add(term);
      }
    }
    return Array.from(expanded).slice(0, 8).join(" ") || query;
  }

  buildBugRetrievalQueries(query: string): string[] {
    const subjectTerms = this.extractBugSalientTerms(query)
      .filter((term) => term.length >= 3 && !BUG_GENERIC_TERMS.has(term));
    const profile = this.buildBugSubjectProfile(subjectTerms, query);
    const familyTerms = Array.from(new Set([
      ...profile.primaryTags,
      ...profile.relatedTags,
    ]));
    const focusQuery = Array.from(new Set([
      ...profile.focusTerms.slice(0, 4),
      ...familyTerms.slice(0, 2),
      ...profile.decomposition.implementationTerms.slice(0, 2),
    ])).slice(0, 8).join(" ");
    const mechanismQuery = Array.from(new Set([
      ...profile.focusTerms.slice(0, 3),
      ...profile.decomposition.implementationTerms.slice(0, 3),
      ...profile.decomposition.controlFlowTerms.slice(0, 2),
    ])).slice(0, 8).join(" ");
    const runtimeQuery = Array.from(new Set([
      ...profile.focusTerms.slice(0, 2),
      ...familyTerms.slice(0, 2),
      ...profile.decomposition.runtimeTerms.slice(0, 2),
      ...profile.decomposition.architecturalTerms.slice(0, 2),
    ])).slice(0, 8).join(" ");
    const bridgeQuery = this.isBugFrontendAuthRoutingHandoffPrompt(profile)
      ? Array.from(new Set([
          ...profile.focusTerms.slice(0, 3),
          "callback",
          "protected",
          "pending",
          "destination",
          "route",
          "guard",
        ])).slice(0, 8).join(" ")
      : (profile.primaryTags.has("connection") || profile.primaryTags.has("schema"))
        ? Array.from(new Set([
            ...profile.focusTerms.slice(0, 3),
            "schema",
            "compat",
            "edge",
            "handle",
            "editor",
            "flow",
          ])).slice(0, 8).join(" ")
        : "";

    return Array.from(new Set([
      this.buildBugRetrievalQuery(query),
      focusQuery,
      mechanismQuery,
      runtimeQuery,
      bridgeQuery,
    ].filter((candidate) => candidate.trim().length > 0)));
  }

  // =========================================================================
  // Salient term extraction
  // =========================================================================

  extractBugSalientTerms(query: string): string[] {
    const focusedExpanded = this.getModeFocusedExpandedTerms(query, "bug");
    const semanticAnchors = this.collectModeCompoundSemanticTerms(focusedExpanded);
    const negativeTerms = new Set(this.extractNegatedPromptTerms(query));
    const explicitCompoundTerms = tokenizeQueryTerms(query)
      .filter((term) => /[-_/]/.test(term))
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !negativeTerms.has(term)
      );
    const rawTerms = tokenizeQueryTerms(query)
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !negativeTerms.has(term)
      );
    const originalAnchors = focusedExpanded
      .filter((term) =>
        (term.source === "original" || term.source === "morphological")
        && !term.generic
        && term.weight >= 0.72
      )
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !BUG_LOW_SPECIFICITY_TERMS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !negativeTerms.has(term)
      );

    const prioritized = Array.from(new Set([
      ...explicitCompoundTerms,
      ...originalAnchors,
      ...rawTerms.filter((term) => !BUG_LOW_SPECIFICITY_TERMS.has(term) && !GENERIC_QUERY_ACTION_TERMS.has(term)),
      ...semanticAnchors,
    ])).filter((term) =>
      term.length >= 3
      && !STOP_WORDS.has(term)
      && !BUG_NOISE_TERMS.has(term)
      && !negativeTerms.has(term)
    );

    if (semanticAnchors.length >= 2) {
      const focused = prioritized.filter((term) =>
        semanticAnchors.includes(term)
        || originalAnchors.includes(term)
        || (!BUG_LOW_SPECIFICITY_TERMS.has(term) && term.length >= 5)
      );
      return Array.from(new Set(focused)).slice(0, 12);
    }

    return prioritized.slice(0, 12);
  }

  extractNegatedPromptTerms(query: string): string[] {
    if (!query) return [];

    const collected = new Set<string>();
    const patterns = [
      /\bdo not care about\s+([^.;,\n]+?)(?=\s+(?:but|and)\s+|[.;,\n]|$)/gi,
      /\bdon't care about\s+([^.;,\n]+?)(?=\s+(?:but|and)\s+|[.;,\n]|$)/gi,
      /\bwithout\s+([^.;,\n]+?)(?=\s+(?:but|and)\s+|[.;,\n]|$)/gi,
      /\bnot\s+the\s+([^.;,\n]+?)(?=\s+(?:but|and)\s+|[.;,\n]|$)/gi,
    ];

    for (const pattern of patterns) {
      for (const match of query.matchAll(pattern)) {
        const clause = match[1] ?? "";
        for (const term of tokenizeQueryTerms(clause).flatMap((token) =>
          normalizeTargetText(token).split(" ").filter(Boolean)
        )) {
          if (
            term.length >= 3
            && !STOP_WORDS.has(term)
            && !BUG_NOISE_TERMS.has(term)
            && !GENERIC_QUERY_ACTION_TERMS.has(term)
          ) {
            collected.add(term);
          }
        }
      }
    }

    return Array.from(collected);
  }

  collectBugRawSignalTerms(rawQuery: string): string[] {
    if (!rawQuery) return [];

    const negativeTerms = new Set(this.extractNegatedPromptTerms(rawQuery));
    const rawTokens = tokenizeQueryTerms(rawQuery);
    const pathLikeTerms = rawTokens
      .filter((term) => /[-_/]/.test(term))
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean));
    const expanded = expandQueryTerms(rawQuery);
    const familyAnchors = expanded
      .filter((term) =>
        term.source === "original"
        && !!term.family
        && !term.generic
        && term.weight >= 0.72
      )
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean));
    const mechanismTerms = rawTokens
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 4
        && !STOP_WORDS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !BUG_LOW_SPECIFICITY_TERMS.has(term)
        && this.isUsefulBugSignalTerm(term)
        && !BUG_GENERIC_TERMS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !negativeTerms.has(term)
      )
      .filter((term) =>
        BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(term))
        || BUG_GATE_RE.test(term)
        || familyAnchors.includes(term)
      );

    return Array.from(new Set([
      ...pathLikeTerms,
      ...familyAnchors,
      ...mechanismTerms,
    ])).filter((term) =>
      term.length >= 3
      && !STOP_WORDS.has(term)
      && !BUG_NOISE_TERMS.has(term)
      && !this.isBugStructuralHintTerm(term)
      && !negativeTerms.has(term)
    );
  }

  collectBugContradictions(
    result: SearchResult,
    feature: ReturnType<MetadataStore["getChunkFeaturesByIds"]>[number] | undefined,
    signals: {
      literalMatches: number;
      semanticMatches: number;
      implementationMatches: number;
      runtimeMatches: number;
      pathNameTermMatches: number;
      strongDomainMatch: boolean;
    }
  ): string[] {
    const reasons: string[] = [];
    if (feature?.docLike || feature?.testLike || BUG_STRUCTURAL_NOISE_RE.test(result.filePath.toLowerCase())) reasons.push("doc_or_test_like");
    if (feature?.isRegistry && !signals.strongDomainMatch) reasons.push("registry_without_runtime");
    if (feature?.isUiComponent && !signals.strongDomainMatch && signals.runtimeMatches === 0) reasons.push("ui_wrapper_without_runtime");
    if ((result.kind.includes("type") || result.kind.includes("interface")) && signals.runtimeMatches === 0) reasons.push("passive_declaration");
    if (signals.literalMatches + signals.semanticMatches > 0 && signals.implementationMatches + signals.runtimeMatches === 0) reasons.push("lexical_only");
    return reasons;
  }

  getBugCandidateSignals(
    result: { filePath: string; name: string; content: string },
    profile: BugSubjectProfile,
    tags: string[] = []
  ): BugCandidateSignals {
    const pathNameTextRaw = `${result.filePath} ${result.name}`;
    const pathNameTextNormalized = normalizeTargetText(pathNameTextRaw);
    const combinedRaw = `${result.filePath} ${result.name} ${result.content.slice(0, 1200)}`;
    const effectiveTerms = profile.focusTerms.length > 0 ? profile.focusTerms : profile.subjectTerms;
    const anchorTerms = effectiveTerms.filter((term) =>
      !this.isBugStructuralHintTerm(term)
      || BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(term))
      || BUG_GATE_RE.test(term)
    );
    const rawLiteralMatches = profile.decomposition.literalTerms.filter((term) =>
      textMatchesQueryTerm(combinedRaw, term)
    ).length;
    const literalMatches = profile.decomposition.literalTerms.filter((term) =>
      textMatchesQueryTerm(combinedRaw, term) || tags.some((tag) => textMatchesQueryTerm(tag, term))
    ).length;
    const pathNameSemanticMatches = profile.decomposition.semanticVariants.filter((term) =>
      textMatchesQueryTerm(pathNameTextRaw, term) || textMatchesQueryTerm(pathNameTextNormalized, term)
    ).length;
    const semanticMatches = profile.decomposition.semanticVariants.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const implementationMatches = profile.decomposition.implementationTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const runtimeMatches = profile.decomposition.runtimeTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const architectureMatches = profile.decomposition.architecturalTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const controlFlowMatches = profile.decomposition.controlFlowTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const dataFlowMatches = profile.decomposition.dataFlowTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const rawTermMatches = anchorTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const termMatches = anchorTerms.filter((term) =>
      textMatchesQueryTerm(combinedRaw, term) || tags.some((tag) => textMatchesQueryTerm(tag, term))
    ).length;
    const pathNameTermMatches = anchorTerms.filter((term) => textMatchesQueryTerm(pathNameTextRaw, term)).length;
    const primaryTagMatches = BUG_SUBJECT_TAG_RULES.filter((rule) =>
      profile.primaryTags.has(rule.tag) && (rule.pattern.test(pathNameTextRaw) || rule.pattern.test(pathNameTextNormalized))
    ).length;
    const relatedTagMatches = tags.filter((tag) => profile.relatedTags.has(tag)).length;
    const negativeMatches = (profile.negativeTerms ?? []).filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const runtimeGateOverlap = BUG_GATE_RE.test(combinedRaw);
    const surfaceAlignment = scoreExecutionSurfaceAlignment(
      detectExecutionSurfaces(result.filePath, result.name, result.content),
      profile.surfaceBias
    );
    const directDomainEvidence =
      rawLiteralMatches > 0
      || semanticMatches > 0
      || pathNameTermMatches > 0
      || primaryTagMatches > 0;
    const strongDomainMatch = profile.primaryTags.size > 0
      ? (
          directDomainEvidence
          || (runtimeGateOverlap && semanticMatches > 0)
        )
      : (
          literalMatches > 0
          || semanticMatches > 0
          || pathNameTermMatches > 0
          || primaryTagMatches > 0
          || relatedTagMatches > 0
          || implementationMatches > 0
          || runtimeMatches > 0
          || architectureMatches > 0
          || controlFlowMatches > 0
          || dataFlowMatches > 0
          || runtimeGateOverlap
        );

    return {
      rawLiteralMatches,
      literalMatches,
      pathNameSemanticMatches,
      semanticMatches,
      implementationMatches,
      runtimeMatches,
      architectureMatches,
      controlFlowMatches,
      dataFlowMatches,
      rawTermMatches,
      termMatches,
      pathNameTermMatches,
      primaryTagMatches,
      relatedTagMatches,
      negativeMatches,
      runtimeGateOverlap,
      strongDomainMatch,
      surfaceAlignment,
    };
  }

  // =========================================================================
  // Predicate / signal helpers
  // =========================================================================

  isBugGateLike(
    result: { filePath: string; name: string; content: string },
    feature?: {
      isPredicate?: boolean;
      isValidator?: boolean;
      isGuard?: boolean;
      returnsBoolean?: boolean;
      callsPredicateCount?: number;
      branchCount?: number;
      guardCount?: number;
      isController?: boolean;
      isRegistry?: boolean;
      isUiComponent?: boolean;
    }
  ): boolean {
    const text = `${result.filePath} ${result.name} ${result.content.slice(0, 1200)}`;
    return !!feature?.isPredicate
      || !!feature?.isValidator
      || !!feature?.isGuard
      || !!feature?.returnsBoolean
      || !!feature?.isController
      || /(?:validate|check|assert|verify|guard|predicate|compat|schema|reject|allow|controller|service|handler|orchestr)/i.test(text);
  }

  isBugOrchestratorCandidate(
    result: { filePath: string; name: string; content: string },
    feature?: {
      isController?: boolean;
      callsPredicateCount?: number;
      branchCount?: number;
      writesState?: boolean;
      writesNetwork?: boolean;
      writesStorage?: boolean;
    }
  ): boolean {
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    return !!feature?.isController
      || ((feature?.callsPredicateCount ?? 0) > 0 && (feature?.branchCount ?? 0) > 0)
      || (!!(feature?.writesState || feature?.writesNetwork || feature?.writesStorage) && /(controller|service|handler|provider|manager|workflow|pipeline|orchestr)/.test(text));
  }

  isBugLeafUiLike(result: { filePath: string; name: string }): boolean {
    const normalized = normalizeTargetText(`${result.filePath} ${result.name}`);
    return normalized.split(/\s+/).some((token) => BUG_UI_LEAF_TERMS.has(token));
  }

  getBugCandidateFamilies(result: { filePath: string; name: string }): Set<string> {
    const text = `${result.filePath} ${result.name}`;
    return new Set(
      BUG_SUBJECT_TAG_RULES
        .filter((rule) => rule.pattern.test(text))
        .map((rule) => rule.tag)
    );
  }

  isBugGenericNavigationLeaf(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals,
    profile: BugSubjectProfile
  ): boolean {
    if (!(profile.primaryTags.has("routing") || profile.relatedTags.has("routing"))) return false;
    if (this.isBugRedirectBackboneCandidate(result, signals)) return false;
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    const isNavigationNamed =
      /\bnavigation\b/.test(text)
      || /\b(drawer|menu|tab|segment|keyboard|mobile|floating|skip)\b/.test(text);
    if (!isNavigationNamed) return false;
    const hasStrongRedirectAnchor =
      /\b(protected|guard|redirect|callback|auth|route|router|destination|pending)\b/.test(text)
      || signals.rawLiteralMatches > 1
      || signals.pathNameTermMatches > 1;
    return !hasStrongRedirectAnchor;
  }

  isBugRedirectHandoffPrompt(profile: BugSubjectProfile): boolean {
    if (!(profile.primaryTags.has("auth") || profile.primaryTags.has("routing") || profile.relatedTags.has("routing"))) {
      return false;
    }
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
      ...profile.decomposition.semanticVariants,
    ]);
    return [
      "redirect", "callback", "protected", "guard", "pending",
      "destination", "handoff", "route", "router", "navigation",
      "session", "signin", "auth",
    ].some((term) => focus.has(term));
  }

  isBugAuthRoutingPrompt(profile: BugSubjectProfile): boolean {
    return profile.primaryTags.has("auth")
      || profile.primaryTags.has("routing")
      || profile.relatedTags.has("auth")
      || profile.relatedTags.has("routing");
  }

  isBugFrontendAuthRoutingHandoffPrompt(profile: BugSubjectProfile): boolean {
    if (!this.isBugAuthRoutingPrompt(profile)) return false;
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
    ]);
    const hasHandoffIntent = [
      "redirect", "callback", "protected", "pending", "destination",
      "handoff", "navigation", "route", "router", "return", "logged", "page",
    ].some((term) => focus.has(term));
    const backendIntent = [
      "request", "response", "api", "server", "endpoint", "bearer",
      "token", "header", "upload", "storage", "media", "webhook",
      "billing", "credit", "queue", "worker",
    ].some((term) => focus.has(term));
    return hasHandoffIntent && !backendIntent;
  }

  isBugBackendRequestPrompt(profile: BugSubjectProfile): boolean {
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
    ]);
    const backendRequestIntent = [
      "request", "response", "api", "server", "endpoint", "bearer",
      "token", "header", "upload", "storage", "media", "webhook",
      "bucket", "blob",
    ].some((term) => focus.has(term));
    return backendRequestIntent && !this.isBugFrontendAuthRoutingHandoffPrompt(profile);
  }

  isBugRedirectNoiseCandidate(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals,
    profile: BugSubjectProfile
  ): boolean {
    if (!this.isBugRedirectHandoffPrompt(profile)) return false;
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    const hasRedirectBackbone =
      /\b(protected|guard|redirect|callback|auth|route|router|destination|pending|session)\b/.test(text)
      || signals.pathNameTermMatches > 1;
    if (/\b(signout|logout)\b/.test(text) && !hasRedirectBackbone) return true;
    if (
      /\b(navigation|drawer|menu|segment|mobile|keyboard|floating|tab|skip)\b/.test(text)
      && !hasRedirectBackbone
      && signals.rawLiteralMatches <= 1
    ) {
      return true;
    }
    return false;
  }

  isBugOffDomainBackendCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugRedirectHandoffPrompt(profile) && !this.isBugAuthRoutingPrompt(profile)) return false;
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const backendLike =
      /(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(result.filePath.toLowerCase())
      || /\b(controller|handler|service|endpoint)\b/.test(text);
    if (!backendLike) return false;
    const authRoutingAnchored =
      /\b(auth|login|signin|signout|authenticate|authenticated|session|token|oauth|callback|redirect|protected|guard|route|router|navigation|pending|destination|handoff|return)\b/.test(text)
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
    return !authRoutingAnchored;
  }

  isBugFrontendHandoffNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const handoffAnchored =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals);
    const authRoutingAnchored =
      handoffAnchored
      || (
        /\b(auth|login|signin|signout|authenticate|authenticated|session)\b/.test(text)
        && /\b(callback|redirect|protected|guard|route|router|pending|destination|return)\b/.test(text)
      )
      || (signals.pathNameTermMatches > 0 && signals.primaryTagMatches > 0);
    const genericCallbackUtility =
      /\bcallback\b/.test(text)
      && (layers.includes("shared") || layers.includes("core"))
      && !/\b(auth|login|signin|session|redirect|protected|guard|route|router|destination|pending|return)\b/.test(text);
    if (genericCallbackUtility) return true;
    if (layers.includes("backend") && !layers.includes("routing") && !handoffAnchored) return true;
    if (layers.includes("ui") && !layers.includes("routing") && !authRoutingAnchored) return true;
    return false;
  }

  isBugMigrationNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    const lowerPath = result.filePath.toLowerCase();
    if (!/(?:^|\/)(migrations?|schema)\//.test(lowerPath) && !/\.sql$/i.test(lowerPath)) return false;
    const schemaPrompt =
      profile.subjectTerms.some((term) => ["migration", "migrations", "schema", "sql", "table", "column", "database", "db"].includes(term))
      || profile.primaryTags.has("storage")
      || profile.primaryTags.has("billing")
      || profile.primaryTags.has("schema");
    return !schemaPrompt && signals.pathNameTermMatches <= 1 && signals.rawLiteralMatches <= 1;
  }

  isBugRedirectBackboneCandidate(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    if (/\b(protected|guard|redirect|callback|auth|route|router|destination|pending|return|session|signin|login|navigation|app)\b/.test(text)) {
      return true;
    }
    return signals.pathNameTermMatches > 1;
  }

  hasBugHandoffSpecificAnchor(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    return /\b(callback|redirect|protected|guard|pending|destination|route|router|return)\b/.test(text)
      || signals.pathNameTermMatches > 1;
  }

  getBugSpecificSubjectTerms(profile: BugSubjectProfile): string[] {
    return profile.subjectTerms.filter((term) =>
      term.length >= 4
      && !BUG_NOISE_TERMS.has(term)
      && !BUG_LOW_SPECIFICITY_TERMS.has(term)
      && !BUG_MECHANISM_ONLY_TERMS.has(term)
      && !this.isBugStructuralHintTerm(term)
    );
  }

  hasBugSpecificSubjectAnchor(
    result: { filePath: string; name: string; content?: string },
    profile: BugSubjectProfile
  ): boolean {
    const terms = this.getBugSpecificSubjectTerms(profile);
    if (terms.length === 0) return false;
    const text = `${result.filePath} ${result.name} ${result.content?.slice(0, 1200) ?? ""}`;
    return terms.some((term) => textMatchesQueryTerm(text, term));
  }

  hasBugFrontendAuthAnchor(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    return /\b(auth|login|signin|signout|authenticate|authenticated|session|oauth|token)\b/.test(text)
      || signals.primaryTagMatches > 0
      || signals.rawLiteralMatches > 0;
  }

  hasBugFrontendRoutingAnchor(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    return this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals);
  }

  hasBugFrontendAuthRoutingPair(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    return this.hasBugFrontendAuthAnchor(result, signals)
      && this.hasBugFrontendRoutingAnchor(result, signals);
  }

  needsDedicatedBugGateCompanion(profile: BugSubjectProfile): boolean {
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
      ...profile.decomposition.semanticVariants,
    ]);
    return profile.primaryTags.has("connection")
      || profile.primaryTags.has("schema")
      || focus.has("runtime")
      || focus.has("caller")
      || focus.has("compatibility")
      || focus.has("compatible");
  }

  isBugGenericAuthEntryCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const authEntryLike = /\b(auth|login|signin|signup)\b/.test(text);
    const handoffAnchor = this.hasBugHandoffSpecificAnchor(result, signals);
    return authEntryLike && layers.includes("ui") && !handoffAnchor;
  }

  isBugGenericStateSupportNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const authRoutingAnchor =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals)
      || /\b(auth|login|signin|session)\b/.test(text);
    return (layers.includes("state") || layers.includes("shared"))
      && !layers.includes("routing")
      && !authRoutingAnchor;
  }

  isBugUnrelatedExecutionNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const executionLike = /\b(execution|workflow|processor|retry|executor|job|queue|worker)\b/.test(text);
    if (!executionLike) return false;
    const authRoutingAnchor =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || /\b(auth|login|signin|session|callback|redirect|protected|guard|route|router)\b/.test(text);
    return !authRoutingAnchor;
  }

  isBugCrossDomainNoiseCandidate(
    result: { filePath: string; name: string; content?: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name} ${result.content?.slice(0, 800) ?? ""}`);
    const hasStrongLocalAnchor =
      signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0
      || signals.rawLiteralMatches > 0
      || this.hasBugSpecificSubjectAnchor(result, profile);

    if (this.isBugAuthRoutingPrompt(profile)) {
      if (this.hasBugHandoffSpecificAnchor(result, signals) || this.isBugRedirectBackboneCandidate(result, signals)) {
        return false;
      }
      return BUG_AUTH_ROUTING_OFFDOMAIN_RE.test(text) && !this.hasBugFrontendAuthRoutingPair(result, signals);
    }

    if (profile.primaryTags.has("connection") || profile.primaryTags.has("schema")) {
      const connectionAnchored =
        hasStrongLocalAnchor
        || /\b(connect|connection|compat|compatible|schema|edge|handle|link|editor|flow)\b/.test(text);
      return BUG_CONNECTION_OFFDOMAIN_RE.test(text) && !connectionAnchored;
    }

    return false;
  }

  hasBugAnchorSignals(signals: BugCandidateSignals): boolean {
    return signals.rawTermMatches > 0
      || signals.semanticMatches > 0
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
  }

  hasBugDirectAnchorSignals(signals: BugCandidateSignals): boolean {
    return signals.rawLiteralMatches > 0
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
  }

  hasBugMechanismAnchorSignals(
    signals: BugCandidateSignals,
    profile: BugSubjectProfile
  ): boolean {
    if (this.hasBugDirectAnchorSignals(signals)) return true;
    if (signals.pathNameSemanticMatches === 0) return false;
    return profile.primaryTags.has("connection")
      || profile.primaryTags.has("schema")
      || profile.primaryTags.has("routing");
  }

  isStrongBugAnchorCandidate(
    result: { filePath: string; name: string; content: string },
    signals: BugCandidateSignals,
    feature?: ChunkFeature,
    profile?: BugSubjectProfile
  ): boolean {
    return ((profile ? this.hasBugMechanismAnchorSignals(signals, profile) : this.hasBugDirectAnchorSignals(signals)) || signals.implementationMatches > 0 || signals.runtimeMatches > 0)
      && this.isBugGateLike(result, feature);
  }

  // =========================================================================
  // Mode-focused expanded terms (shared with trace, but bug path uses it)
  // =========================================================================

  getModeFocusedExpandedTerms(
    query: string,
    queryMode: "bug" | "trace"
  ): ExpandedQueryTerm[] {
    const expanded = expandQueryTerms(query);
    const explicitLogging = MODE_EXPLICIT_LOGGING_RE.test(query);
    const explicitWebhook = MODE_EXPLICIT_WEBHOOK_RE.test(query);
    const familyScores = new Map<string, number>();

    for (const term of expanded) {
      if (!term.family) continue;
      if (term.source !== "original" && term.source !== "morphological") continue;
      const normalized = normalizeTargetText(term.term);
      if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) continue;
      familyScores.set(term.family, (familyScores.get(term.family) ?? 0) + term.weight);
    }

    const rankedFamilies = Array.from(familyScores.entries()).sort((a, b) => b[1] - a[1]);
    const topScore = rankedFamilies[0]?.[1] ?? 0;
    const allowedFamilies = new Set<string>();
    for (const [family, score] of rankedFamilies) {
      if (score < Math.max(0.86, topScore * 0.55)) continue;
      allowedFamilies.add(family);
      for (const adjacent of ADJACENT_WORKFLOW_FAMILIES[family] ?? []) {
        allowedFamilies.add(adjacent);
      }
    }
    if (!explicitLogging) allowedFamilies.delete("logging");
    if (!explicitWebhook && (allowedFamilies.has("auth") || allowedFamilies.has("routing"))) {
      allowedFamilies.delete("webhook");
    }

    return expanded.filter((term) => {
      const normalized = normalizeTargetText(term.term);
      if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) return false;
      if (queryMode === "bug" && BUG_NOISE_TERMS.has(normalized)) return false;
      if (queryMode === "trace" && TRACE_NOISE_TERMS.has(normalized)) return false;
      if (!term.family) {
        return term.source === "original" || term.source === "morphological" || !term.generic;
      }
      if (allowedFamilies.size === 0) {
        if (term.family === "logging" && !explicitLogging) return false;
        if (term.family === "webhook" && !explicitWebhook) return false;
        return true;
      }
      if (allowedFamilies.has(term.family)) return true;
      if (
        queryMode === "bug"
        && (term.source === "original" || term.source === "morphological")
        && !term.generic
        && normalized.length >= 4
        && !BUG_LOW_SPECIFICITY_TERMS.has(normalized)
      ) {
        return true;
      }
      return false;
    });
  }

  // =========================================================================
  // Internal helpers (private)
  // =========================================================================

  private getBugQueryVariants(term: string): string[] {
    const normalized = normalizeTargetText(term).trim();
    if (!normalized) return [];

    return Array.from(new Set(
      getQueryTermVariants(normalized).filter((variant) => {
        if (!variant) return false;
        if (variant === normalized) return true;
        if (variant.length < 5 && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant)) && !BUG_GATE_RE.test(variant)) {
          return false;
        }
        if (normalized.length >= 6 && variant.length === 4 && normalized.startsWith(variant)) return false;
        if (
          normalized.endsWith("ing")
          && variant === `${normalized.slice(0, -3)}er`
          && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant))
          && !BUG_GATE_RE.test(variant)
        ) {
          return false;
        }
        if (
          this.isBugStructuralHintTerm(variant)
          && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant))
          && !BUG_GATE_RE.test(variant)
        ) {
          return false;
        }
        return true;
      })
    ));
  }

  private isBugStructuralHintTerm(term: string): boolean {
    const normalized = normalizeTargetText(term).trim();
    if (!normalized) return false;
    return BUG_STRUCTURAL_HINT_TERMS.has(normalized)
      || /^controll/.test(normalized)
      || /^implement/.test(normalized);
  }

  private isUsefulBugSignalTerm(term: string): boolean {
    if (!term) return false;
    if (BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(term)) || BUG_GATE_RE.test(term)) return true;
    if (this.isBugStructuralHintTerm(term)) return false;
    if (term.length <= 4) return false;
    return true;
  }

  private collectModeCompoundSemanticTerms(focusedExpanded: ExpandedQueryTerm[]): string[] {
    return focusedExpanded
      .filter((term) =>
        term.source === "semantic"
        && !!term.family
        && !term.generic
        && term.weight >= 0.72
        && (
          /[A-Z_]/.test(term.term)
          || normalizeTargetText(term.term).split(" ").filter(Boolean).length > 1
        )
        && normalizeTargetText(term.term).split(" ").filter(Boolean).length <= 2
      )
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !TRACE_NOISE_TERMS.has(term)
      );
  }

  private isImplementationChunk(result: SearchResult): boolean {
    return this.isImplementationPath(result.filePath);
  }

  private isImplementationPath(filePath: string): boolean {
    const lowerPath = filePath.toLowerCase();
    const implPaths = this.config.implementationPaths ?? ["src/", "lib/", "bin/"];
    if (implPaths.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()))) return true;
    return /(?:^|\/)(src|lib|bin|app|server|api|functions|handlers|controllers|services|supabase)\//.test(lowerPath);
  }

  private detectWorkflowLayers(lowerPath: string, lowerName: string): string[] {
    const layers: string[] = [];
    const text = `${lowerPath} ${lowerName}`;

    if (/(?:^|\/)(src\/)?(pages|components|screens|views|app)\//.test(lowerPath) || /\b(page|modal|dialog|screen|view|layout)\b/.test(text)) {
      layers.push("ui");
    }
    if (/(?:^|\/)(hooks|store|state|session|context|providers?)\//.test(lowerPath) || /\b(use[a-z]|provider|session|state|context)\b/.test(lowerName)) {
      layers.push("state");
    }
    if (/\b(route|router|routing|redirect|callback|guard|protected|middleware)\b/.test(text)) {
      layers.push("routing");
    }
    if (/(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lowerPath) || /\b(api|server|handler|request|controller|service)\b/.test(text)) {
      layers.push("backend");
    }
    if (/(?:^|\/)(lib|shared|core|utils?)\//.test(lowerPath) || /\b(error|util|helper|type)\b/.test(text)) {
      layers.push("shared");
    }
    if (layers.length === 0) layers.push("core");
    return layers;
  }

  private isUtilityLikePath(lowerPath: string, lowerName: string): boolean {
    return /(?:^|\/)(lib|shared|core|utils?|helpers?|types?)\//.test(lowerPath)
      || /\b(utils?|helpers?|types?|errors?)\b/.test(lowerName);
  }

  private chunkToSearchResult(chunk: StoredChunk, score: number): SearchResult {
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
      language: chunk.language ?? "",
    };
  }

  private mergeBroadResults(targetResults: SearchResult[], results: SearchResult[]): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const result of [...targetResults, ...results]) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) {
        byId.set(result.id, result);
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }
}
