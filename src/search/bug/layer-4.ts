import type { StoredChunk } from "../../storage/types.js";
import type { SearchResult } from "../types.js";
import { isTestFile, textMatchesQueryTerm } from "../utils.js";
import { BUG_GATE_RE, BUG_STRUCTURAL_NOISE_RE, type BugSubjectProfile, type BugSelectionDiagnostics, type BugLocalizationSelectionInput } from "./model.js";
import { BugStrategyLayer3 } from "./layer-3.js";

export abstract class BugStrategyLayer4 extends BugStrategyLayer3 {

  protected finalizeBugLocalizationSelection(
    input: BugLocalizationSelectionInput
  ): SearchResult[] {
    const {
      scored,
      maxFiles,
      featureMap,
      subjectProfile,
      structuralSupportIds,
      keywordResults,
      semanticSeedResults,
      anchoredSemanticSeedIds,
      getSignalsForResult,
    } = input;
    const selected: SearchResult[] = [];
    const seenFiles = new Set<string>();
    const primaryAnchorResults = keywordResults
      .filter((result) => this.hasBugAnchorSignals(getSignalsForResult(result)))
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
    const final = cappedPromoted.map((result) => {
      // Bug fix: preserve the real multiplicative evidence score instead of
      // overwriting it with a linear rank-based value (was Math.max(1, 3 - i*0.2)).
      // Downstream (assembleContext) only uses the score as a ratio relative to
      // the top result, so absolute values don't matter — the real signal must
      // survive. hookScore is bumped to at least the real score for consumers
      // that read it.
      return {
        ...result,
        hookScore: Math.max(result.hookScore ?? 0, result.score),
      };
    });
    return final;
  }

  /** Return the diagnostics produced by the last selectBugLocalizationBundle call. */
  get lastDiagnostics(): BugSelectionDiagnostics | null {
    return this._lastDiagnostics;
  }
  protected _lastDiagnostics: BugSelectionDiagnostics | null = null;

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
}
