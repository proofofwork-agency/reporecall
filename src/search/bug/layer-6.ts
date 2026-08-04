import type { ChunkFeature } from "../../storage/types.js";
import type { SearchResult } from "../types.js";
import type { SeedResult } from "../seed.js";
import { GENERIC_BROAD_TERMS, GENERIC_QUERY_ACTION_TERMS, textMatchesQueryTerm } from "../utils.js";
import { normalizeTargetText } from "../targets.js";
import { INVENTORY_GENERIC_TARGET_ALIAS_TERMS } from "../shared/workflow-families.js";
import { BUG_GATE_RE, BUG_STRUCTURAL_NOISE_RE, BUG_UI_NOISE_RE, BUG_GENERIC_TERMS, type BugScoredCandidate, type BugSelectionDiagnostics, type BugCandidateSignals } from "./model.js";
import { BugStrategyLayer5 } from "./layer-5.js";

export class BugStrategyLayer6 extends BugStrategyLayer5 {
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
    // Precompute tags, features, and signals per candidate to avoid repeated
    // per-filter metadata lookups and signal recomputation.
    const tagCache = new Map<string, string[]>();
    const featureCache = new Map<string, ChunkFeature | undefined>();
    const signalCache = new Map<string, BugCandidateSignals>();
    {
      const candidateIds = Array.from(new Set<string>([
        ...keywordResults.map((r) => r.id),
        ...semanticSeedResults.map((r) => r.id),
        ...results.map((r) => r.id),
      ]));
      for (const tag of this.metadata.getChunkTagsByIds(candidateIds)) {
        const list = tagCache.get(tag.chunkId);
        if (list) list.push(tag.tag); else tagCache.set(tag.chunkId, [tag.tag]);
      }
      for (const feature of this.metadata.getChunkFeaturesByIds(candidateIds)) {
        featureCache.set(feature.chunkId, feature);
      }
    }
    const getTagsForResult = (result: SearchResult): string[] => {
      let tags = tagCache.get(result.id);
      if (tags === undefined) {
        tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
        tagCache.set(result.id, tags);
      }
      return tags;
    };
    const getFeatureForResult = (result: SearchResult): ChunkFeature | undefined => {
      if (featureCache.has(result.id)) return featureCache.get(result.id);
      const feature = this.metadata.getChunkFeaturesByIds([result.id])[0];
      featureCache.set(result.id, feature);
      return feature;
    };
    const getSignalsForResult = (result: SearchResult): BugCandidateSignals => {
      let signals = signalCache.get(result.id);
      if (signals === undefined) {
        signals = this.getBugCandidateSignals(
          { filePath: result.filePath, name: result.name, content: result.content },
          subjectProfile,
          getTagsForResult(result)
        );
        signalCache.set(result.id, signals);
      }
      return signals;
    };
    const strongKeywordAnchorResults = keywordResults.filter((result) => {
      const signals = getSignalsForResult(result);
      const feature = getFeatureForResult(result);
      return this.isStrongBugAnchorCandidate(result, signals, feature, subjectProfile);
    });
    const strongSemanticAnchorResults = semanticSeedResults.filter((result) => {
      const signals = getSignalsForResult(result);
      const feature = getFeatureForResult(result);
      return this.isStrongBugAnchorCandidate(result, signals, feature, subjectProfile);
    });
    const filteredSemanticSeedResults = strongKeywordAnchorResults.length > 0
      ? semanticSeedResults.filter((result) => {
          const signals = getSignalsForResult(result);
          const feature = getFeatureForResult(result);
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
        .filter((result) => this.hasBugAnchorSignals(getSignalsForResult(result)))
        .map((result) => result.id)
    );
    const keywordFocused = keywordResults.filter((result) => {
      const signals = getSignalsForResult(result);
      return signals.pathNameTermMatches > 0
        || signals.primaryTagMatches > 0
        || signals.implementationMatches > 0
        || signals.runtimeMatches > 0;
    });
    const genericDomainResults = results.filter((result) => {
      const signals = getSignalsForResult(result);
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
        const feature = featureMap.get(result.id);
        const signals = getSignalsForResult(result);
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
    return this.finalizeBugLocalizationSelection({
      scored,
      maxFiles,
      featureMap,
      subjectProfile,
      structuralSupportIds,
      keywordResults,
      semanticSeedResults,
      anchoredSemanticSeedIds,
      getSignalsForResult,
    });
  }
}
