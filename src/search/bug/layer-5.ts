import type { SearchResult } from "../types.js";
import type { SeedResult } from "../seed.js";
import { GENERIC_BROAD_TERMS, GENERIC_QUERY_ACTION_TERMS, getQueryTermVariants, inferQueryExecutionSurfaceBias, isTestFile, STOP_WORDS } from "../utils.js";
import { normalizeTargetText } from "../targets.js";
import { INVENTORY_GENERIC_TARGET_ALIAS_TERMS } from "../shared/workflow-families.js";
import { BUG_GENERIC_SEED_ALIAS_TERMS, BUG_STRUCTURAL_ROLE_ALIAS_TERMS, BUG_NOISE_TERMS, BUG_LOW_SPECIFICITY_TERMS, BUG_SUBJECT_TAG_RULES, type QueryDecomposition, type BugSubjectProfile } from "./model.js";
import { BugStrategyLayer4 } from "./layer-4.js";

export class BugStrategyLayer5 extends BugStrategyLayer4 {
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
}
