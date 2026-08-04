import type { MetadataStore } from "../../storage/metadata-store.js";
import type { SearchResult } from "../types.js";
import { detectExecutionSurfaces, expandQueryTerms, GENERIC_QUERY_ACTION_TERMS, scoreExecutionSurfaceAlignment, STOP_WORDS, textMatchesQueryTerm, tokenizeQueryTerms } from "../utils.js";
import { normalizeTargetText } from "../targets.js";
import { BUG_GATE_RE, BUG_STRUCTURAL_NOISE_RE, BUG_GENERIC_TERMS, BUG_NOISE_TERMS, BUG_LOW_SPECIFICITY_TERMS, BUG_SUBJECT_TAG_RULES, type BugSubjectProfile, type BugCandidateSignals } from "./model.js";
import { BugStrategyLayer2 } from "./layer-2.js";

export abstract class BugStrategyLayer3 extends BugStrategyLayer2 {
  abstract buildBugSubjectProfile(queryTerms: string[], rawQuery?: string): BugSubjectProfile;

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
}
