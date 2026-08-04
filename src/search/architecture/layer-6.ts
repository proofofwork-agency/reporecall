import type { SearchResult } from "../types.js";
import type { SeedResult } from "../seed.js";
import { resolveSeeds } from "../seed.js";
import { classifyIntent } from "../intent.js";
import { normalizeTargetText } from "../targets.js";
import { collectCorpusFamilyTerms, expandQueryTerms, isTestFile } from "../utils.js";
import { STRICT_WORKFLOW_FAMILY_COHESION, type BroadFileCandidate } from "./model.js";
import { ArchitectureStrategyLayer5 } from "./layer-5.js";

export abstract class ArchitectureStrategyLayer6 extends ArchitectureStrategyLayer5 {
  abstract compactGenerationBackbone(query: string, results: SearchResult[]): SearchResult[];

  selectBroadWorkflowBundle(
    query: string,
    results: SearchResult[],
    seedResult?: SeedResult,
    maxContextChunks: number = 8
  ): SearchResult[] {
    const queryMode = classifyIntent(query).queryMode;
    const isChangeMode = queryMode === "change";
    const isCrossCuttingChangeQuery =
      /\b(every\s+step|across|throughout|full|entire|complete|end-to-end|all\s+steps)\b/i.test(query);
    const allowTests = /\btest|spec|fixture|mock|e2e\b/i.test(query);
    const seeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    const baseTerms = expandQueryTerms(query);
    const baseProfile = this.buildBroadQueryProfile(query, baseTerms);
    const conceptResults = this.buildBroadConceptResults(query, allowTests, baseProfile);
    const targetResults = this.mergeBroadResults(
      conceptResults,
      this.buildBroadTargetResults(query, allowTests, baseProfile)
    );
    const corpusTerms = collectCorpusFamilyTerms(
      baseTerms,
      [
        ...targetResults.slice(0, 8).map((result) => ({ filePath: result.filePath, name: result.name })),
        ...results.slice(0, 10).map((result) => ({ filePath: result.filePath, name: result.name })),
        ...seeds.seeds.slice(0, 6).map((seed) => ({ filePath: seed.filePath, name: seed.name })),
      ]
    );
    const expandedTerms = [
      ...baseTerms,
      ...corpusTerms.filter((term) =>
        !term.family || baseProfile.allowedFamilies.size === 0 || baseProfile.allowedFamilies.has(term.family)
      ),
    ];
    const profile = this.buildBroadQueryProfile(query, expandedTerms);
    const mergedResults = this.mergeBroadResults(targetResults, results);
    const candidates = mergedResults
      .filter((result) => allowTests || !isTestFile(result.filePath))
      .filter((result) => result.kind !== "file")
      .map((result) => this.scoreBroadWorkflowCandidate(result, profile))
      .sort((a, b) => b.score - a.score);
    if (profile.inventoryMode) {
      return this.compactGenerationBackbone(
        query,
        this.selectBroadInventoryBundle(profile, candidates, allowTests, maxContextChunks)
      );
    }
    const baseFileCandidates = this.mergeBroadFileCandidates(
      this.buildBroadFileCandidates(candidates, profile),
      this.buildBroadConceptFileCandidates(query, profile, allowTests)
    );
    const initialFileCandidates = profile.lifecycleMode
      ? baseFileCandidates
      : this.mergeBroadFileCandidates(
          baseFileCandidates,
          this.buildBroadFamilyFileCandidates(profile, allowTests)
        );
    const dominantFamily = this.chooseDominantBroadFamily(profile, initialFileCandidates);
    const fileCandidates = dominantFamily && !profile.lifecycleMode
      ? this.mergeBroadFileCandidates(
          initialFileCandidates,
          this.buildBroadBackboneFileCandidates(dominantFamily, profile, allowTests)
        )
      : initialFileCandidates;
    const scopedFileCandidates = dominantFamily && !profile.lifecycleMode
      ? this.buildDominantFamilyNeighborhood(dominantFamily, profile, fileCandidates, allowTests)
      : fileCandidates;
    const rankedWorkflowCandidates = [...scopedFileCandidates].sort((a, b) => {
      const aAnswerFirst = this.computeBroadWorkflowAnswerFirstPriority(a, profile, dominantFamily);
      const bAnswerFirst = this.computeBroadWorkflowAnswerFirstPriority(b, profile, dominantFamily);
      if (aAnswerFirst !== bAnswerFirst) return bAnswerFirst - aAnswerFirst;
      return b.score - a.score;
    });

    const selectedFiles: BroadFileCandidate[] = [];
    const seenFilePaths = new Set<string>();
    let utilityCount = 0;
    let observabilityCount = 0;
    const queryMentionsLogging = /\b(log|logging|tracing|audit|instrument|instrumentation|telemetry)\b/i.test(query);
    const isBillingBackboneFile = (candidate: BroadFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      if (!/\b(billing|checkout|portal|subscription|invoice|payment|credit|stripe)\b/.test(text)) return false;
      if (/(?:^|\/)src\/pages\//.test(candidate.filePath)) return true;
      if (/(?:controller|service)/.test(text)) return true;
      if (candidate.layers.includes("backend") || candidate.layers.includes("state")) return true;
      if (/(?:^|\/)supabase\/functions\//.test(candidate.filePath)) return true;
      return false;
    };
    const isRoutingBackboneFile = (candidate: BroadFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      if (/\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)) return true;
      if (/\b(protected|guard|redirect|callback|router|route)\b/.test(text)) return true;
      if (/(?:^|\/)src\/lib\/navigation\.ts$/.test(candidate.filePath)) return true;
      return false;
    };
    const isRoutingUiNoise = (candidate: BroadFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      return /\b(keyboard|drawer|menu|mobile|floating|tab)\b/.test(text);
    };
    const isLifecycleFile = (candidate: BroadFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      return /\b(close|shutdown|drain|stop|serve|scheduler|pipeline)\b/.test(text);
    };
    const isObservabilityFile = (candidate: BroadFileCandidate): boolean =>
      this.isObservabilitySidecarPath(
        candidate.filePath.toLowerCase(),
        candidate.primary.result.name.toLowerCase()
      );
    const dominantFamilyNeighbors = dominantFamily && !profile.lifecycleMode
      ? new Set(
          scopedFileCandidates
            .filter((candidate) => candidate.matchedFamilies.includes(dominantFamily))
            .flatMap((candidate) => this.collectBroadImportNeighbors(candidate.filePath))
        )
      : new Set<string>();
    const isDominantFamilyFile = (candidate: BroadFileCandidate): boolean =>
      !!dominantFamily
      && (
        candidate.matchedFamilies.includes(dominantFamily)
        || candidate.filePath.includes(`/${dominantFamily}/`)
      );
    const requireStrictWorkflowFamilyAlignment =
      !profile.inventoryMode
      && !profile.lifecycleMode
      && !!dominantFamily
      && STRICT_WORKFLOW_FAMILY_COHESION.has(dominantFamily);
    const backboneCandidates = dominantFamily && !profile.lifecycleMode
      ? this.selectBroadBackboneCandidates(
          dominantFamily,
          profile,
          this.mergeBroadFileCandidates(scopedFileCandidates, fileCandidates)
        )
      : [];

    const trySelectFile = (
      candidate: BroadFileCandidate | undefined,
      verifiedBackbone = false
    ) => {
      if (!candidate) return;
      if (seenFilePaths.has(candidate.filePath)) return;
      if (candidate.callbackNoise) return;
      const candidateText = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
      const authUserFacingBackbone =
        dominantFamily === "auth"
        && profile.surfaceBias.defaultUserFacing
        && !profile.surfaceBias.explicitBackend
        && (
          candidate.layers.includes("state")
          || candidate.layers.includes("routing")
          || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)
        )
        && /\b(auth|session|signin|signup|login|callback|redirect|protected|guard|provider)\b/.test(candidateText);
      if (
        requireStrictWorkflowFamilyAlignment
        && !this.isStrictWorkflowFamilyCandidate(profile, dominantFamily!, candidate)
        && !verifiedBackbone
      ) {
        return;
      }
      if (candidate.utilityLike && utilityCount >= 1) return;
      if (!profile.inventoryMode && !profile.lifecycleMode && selectedFiles.length < 3) {
        if (candidate.utilityLike && !verifiedBackbone) return;
        if (queryMentionsLogging && isObservabilityFile(candidate)) return;
      }
      if (!profile.inventoryMode && !profile.lifecycleMode && queryMentionsLogging) {
        if (isObservabilityFile(candidate) && observabilityCount >= 1) return;
      }
      if (profile.inventoryMode) {
        if (
          candidate.coreAnchorCount === 0
          && candidate.matchedFamilies.length === 0
          && !dominantFamilyNeighbors.has(candidate.filePath)
        ) {
          return;
        }
      } else if (
        candidate.directAnchorCount === 0
        && candidate.phraseMatchCount === 0
        && candidate.matchedFamilies.length === 0
        && !authUserFacingBackbone
        && !verifiedBackbone
      ) {
        return;
      }
      selectedFiles.push(candidate);
      seenFilePaths.add(candidate.filePath);
      if (candidate.utilityLike) utilityCount++;
      if (isObservabilityFile(candidate)) observabilityCount++;
    };

    if (profile.inventoryMode) {
      const rankedInventoryCandidates = [...scopedFileCandidates].sort((a, b) => {
        const aFamily = dominantFamily && a.matchedFamilies.includes(dominantFamily) ? 1 : 0;
        const bFamily = dominantFamily && b.matchedFamilies.includes(dominantFamily) ? 1 : 0;
        if (aFamily !== bFamily) return bFamily - aFamily;
        const aSubsystem = dominantFamily && a.filePath.includes(`/${dominantFamily}/`) ? 1 : 0;
        const bSubsystem = dominantFamily && b.filePath.includes(`/${dominantFamily}/`) ? 1 : 0;
        if (aSubsystem !== bSubsystem) return bSubsystem - aSubsystem;
        if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
        if (a.phraseMatchCount !== b.phraseMatchCount) return b.phraseMatchCount - a.phraseMatchCount;
        return b.score - a.score;
      });

      for (const candidate of rankedInventoryCandidates) {
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
        if (dominantFamily && !isDominantFamilyFile(candidate)) continue;
        trySelectFile(candidate);
      }
    } else if (profile.lifecycleMode) {
      const rankedLifecycleCandidates = [...scopedFileCandidates].sort((a, b) => {
        const aConcept = a.matchedFamilies.includes("lifecycle") ? 1 : 0;
        const bConcept = b.matchedFamilies.includes("lifecycle") ? 1 : 0;
        if (aConcept !== bConcept) return bConcept - aConcept;
        const aLifecycle = isLifecycleFile(a) ? 1 : 0;
        const bLifecycle = isLifecycleFile(b) ? 1 : 0;
        if (aLifecycle !== bLifecycle) return bLifecycle - aLifecycle;
        if (a.directAnchorCount !== b.directAnchorCount) return b.directAnchorCount - a.directAnchorCount;
        if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
        if (a.phraseMatchCount !== b.phraseMatchCount) return b.phraseMatchCount - a.phraseMatchCount;
        if (a.utilityLike !== b.utilityLike) return a.utilityLike ? 1 : -1;
        return b.score - a.score;
      });

      for (const candidate of rankedLifecycleCandidates) {
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
        if (!isLifecycleFile(candidate) && candidate.directAnchorCount === 0 && candidate.phraseMatchCount === 0) {
          continue;
        }
        trySelectFile(candidate);
      }
    } else {
      for (const candidate of backboneCandidates) {
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
        trySelectFile(candidate, true);
      }

      const layerPriority = ["ui", "state", "routing", "backend", "shared", "core"];
      for (const layer of layerPriority) {
        for (const candidate of rankedWorkflowCandidates) {
          if (
            !candidate.layers.includes(layer)
            || (
              candidate.directAnchorCount === 0
              && candidate.phraseMatchCount === 0
              && candidate.matchedFamilies.length === 0
            )
          ) {
            continue;
          }
          const countBefore = selectedFiles.length;
          trySelectFile(candidate);
          if (selectedFiles.length > countBefore) break;
        }
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
      }
    }

    if (isChangeMode) {
      const selectedLayers = new Set(selectedFiles.flatMap((candidate) => candidate.layers));
      const changeExpansionLimit = Math.min(maxContextChunks, 4);
      const rankedChangeCandidates = [...scopedFileCandidates].sort((a, b) => {
        const aDominant = dominantFamily && (
          a.matchedFamilies.includes(dominantFamily) || a.filePath.includes(`/${dominantFamily}/`)
        ) ? 1 : 0;
        const bDominant = dominantFamily && (
          b.matchedFamilies.includes(dominantFamily) || b.filePath.includes(`/${dominantFamily}/`)
        ) ? 1 : 0;
        if (aDominant !== bDominant) return bDominant - aDominant;
        const aLayerDiversity = a.layers.some((layer) => !selectedLayers.has(layer)) ? 1 : 0;
        const bLayerDiversity = b.layers.some((layer) => !selectedLayers.has(layer)) ? 1 : 0;
        if (aLayerDiversity !== bLayerDiversity) return bLayerDiversity - aLayerDiversity;
        const aSignals = a.coreAnchorCount * 4 + a.directAnchorCount * 3 + a.phraseMatchCount * 2;
        const bSignals = b.coreAnchorCount * 4 + b.directAnchorCount * 3 + b.phraseMatchCount * 2;
        if (aSignals !== bSignals) return bSignals - aSignals;
        return b.score - a.score;
      });

      for (const candidate of rankedChangeCandidates) {
        if (selectedFiles.length >= changeExpansionLimit) break;
        if (seenFilePaths.has(candidate.filePath)) continue;
        const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
        if (queryMentionsLogging && isObservabilityFile(candidate) && selectedFiles.length < 3) continue;
        if (
          dominantFamily === "auth"
          && !/\b(auth|login|signin|session|callback|redirect|protected|guard)\b/.test(text)
          && !candidate.matchedFamilies.includes("auth")
          && !candidate.matchedFamilies.includes("routing")
        ) {
          continue;
        }
        trySelectFile(candidate);
        for (const layer of candidate.layers) selectedLayers.add(layer);
      }

      if (dominantFamily === "auth" && selectedFiles.length < changeExpansionLimit) {
        const authFallbackCandidates = this.mergeBroadFileCandidates(
          [...scopedFileCandidates],
          [...fileCandidates]
        )
          .filter((candidate) => !seenFilePaths.has(candidate.filePath))
          .filter((candidate) => {
            const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
            return /\b(auth|login|signin|session|callback|redirect|protected|guard)\b/.test(text)
              || candidate.matchedFamilies.includes("auth")
              || candidate.matchedFamilies.includes("routing");
          })
          .sort((a, b) => {
            const aText = normalizeTargetText(`${a.filePath} ${a.primary.result.name}`);
            const bText = normalizeTargetText(`${b.filePath} ${b.primary.result.name}`);
            const aBackbone = /\b(callback|redirect|protected|guard|auth|signin|login)\b/.test(aText) ? 100 : 0;
            const bBackbone = /\b(callback|redirect|protected|guard|auth|signin|login)\b/.test(bText) ? 100 : 0;
            const aLayerDiversity = a.layers.some((layer) => !selectedLayers.has(layer)) ? 35 : 0;
            const bLayerDiversity = b.layers.some((layer) => !selectedLayers.has(layer)) ? 35 : 0;
            return (bBackbone + bLayerDiversity + b.score) - (aBackbone + aLayerDiversity + a.score);
          });
        for (const candidate of authFallbackCandidates) {
          if (selectedFiles.length >= changeExpansionLimit) break;
          trySelectFile(candidate);
          for (const layer of candidate.layers) selectedLayers.add(layer);
        }
      }

      if (
        isCrossCuttingChangeQuery
        && (dominantFamily === "auth" || dominantFamily === "routing")
        && selectedFiles.length < changeExpansionLimit
      ) {
        const authRoutingChangeCandidates = this.mergeBroadFileCandidates(
          [...scopedFileCandidates],
          [...fileCandidates]
        )
          .filter((candidate) => !seenFilePaths.has(candidate.filePath))
          .filter((candidate) => {
            const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
            return /\b(auth|login|signin|session|callback|redirect|protected|guard|route|router|pending|destination)\b/.test(text)
              || candidate.matchedFamilies.includes("auth")
              || candidate.matchedFamilies.includes("routing");
          })
          .filter((candidate) => !isObservabilityFile(candidate))
          .sort((a, b) => {
            const aText = normalizeTargetText(`${a.filePath} ${a.primary.result.name}`);
            const bText = normalizeTargetText(`${b.filePath} ${b.primary.result.name}`);
            const aBackbone = /\b(callback|redirect|protected|guard|pending|destination)\b/.test(aText) ? 110 : 0;
            const bBackbone = /\b(callback|redirect|protected|guard|pending|destination)\b/.test(bText) ? 110 : 0;
            const aLayerDiversity = a.layers.some((layer) => !selectedLayers.has(layer)) ? 40 : 0;
            const bLayerDiversity = b.layers.some((layer) => !selectedLayers.has(layer)) ? 40 : 0;
            const aUiRouting = a.layers.includes("routing") || a.layers.includes("ui") ? 20 : 0;
            const bUiRouting = b.layers.includes("routing") || b.layers.includes("ui") ? 20 : 0;
            return (bBackbone + bLayerDiversity + bUiRouting + b.score)
              - (aBackbone + aLayerDiversity + aUiRouting + a.score);
          });
        for (const candidate of authRoutingChangeCandidates) {
          if (selectedFiles.length >= changeExpansionLimit) break;
          trySelectFile(candidate);
          for (const layer of candidate.layers) selectedLayers.add(layer);
        }
      }
    }

    if (!profile.inventoryMode) {
      for (const candidate of rankedWorkflowCandidates) {
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
        if (
          candidate.callbackNoise
          || (
            profile.anchorTerms.length >= 3
            && candidate.directAnchorCount <= 1
            && candidate.phraseMatchCount === 0
            && candidate.matchedFamilies.length === 0
          )
        ) {
          continue;
        }
        if (
          candidate.genericOnly
          && candidate.matchedFamilies.length === 0
            && candidate.layers.every((layer) => layer === "shared" || layer === "core")
        ) {
          continue;
        }
        trySelectFile(candidate);
      }
    }

    const backboneOrder = new Map(
      backboneCandidates.map((candidate, index) => [candidate.filePath, index])
    );
    const orderedSelectedFiles = profile.inventoryMode
      ? selectedFiles
      : [...selectedFiles].sort((a, b) => {
          const aBackboneOrder = backboneOrder.get(a.filePath);
          const bBackboneOrder = backboneOrder.get(b.filePath);
          if (aBackboneOrder !== undefined || bBackboneOrder !== undefined) {
            if (aBackboneOrder === undefined) return 1;
            if (bBackboneOrder === undefined) return -1;
            if (aBackboneOrder !== bBackboneOrder) return aBackboneOrder - bBackboneOrder;
          }
          const aAnswerFirst = this.computeBroadWorkflowAnswerFirstPriority(a, profile, dominantFamily);
          const bAnswerFirst = this.computeBroadWorkflowAnswerFirstPriority(b, profile, dominantFamily);
          if (aAnswerFirst !== bAnswerFirst) return bAnswerFirst - aAnswerFirst;
          const aDominant = dominantFamily && (
            a.matchedFamilies.includes(dominantFamily) || a.filePath.includes(`/${dominantFamily}/`)
          ) ? 1 : 0;
          const bDominant = dominantFamily && (
            b.matchedFamilies.includes(dominantFamily) || b.filePath.includes(`/${dominantFamily}/`)
          ) ? 1 : 0;
          if (aDominant !== bDominant) return bDominant - aDominant;
          if (dominantFamily === "billing") {
            const aBackbone = isBillingBackboneFile(a) ? 1 : 0;
            const bBackbone = isBillingBackboneFile(b) ? 1 : 0;
            if (aBackbone !== bBackbone) return bBackbone - aBackbone;
          }
          if (dominantFamily === "routing") {
            const aBackbone = isRoutingBackboneFile(a) ? 1 : 0;
            const bBackbone = isRoutingBackboneFile(b) ? 1 : 0;
            if (aBackbone !== bBackbone) return bBackbone - aBackbone;
            const aNoise = isRoutingUiNoise(a) ? 1 : 0;
            const bNoise = isRoutingUiNoise(b) ? 1 : 0;
            if (aNoise !== bNoise) return aNoise - bNoise;
          }
          if (queryMentionsLogging) {
            const aObservability = isObservabilityFile(a) ? 1 : 0;
            const bObservability = isObservabilityFile(b) ? 1 : 0;
            if (aObservability !== bObservability) return aObservability - bObservability;
          }
          if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
          if (a.directAnchorCount !== b.directAnchorCount) return b.directAnchorCount - a.directAnchorCount;
          if (a.phraseMatchCount !== b.phraseMatchCount) return b.phraseMatchCount - a.phraseMatchCount;
          if (a.utilityLike !== b.utilityLike) return a.utilityLike ? 1 : -1;
          return b.score - a.score;
        });

    if (
      isChangeMode
      && isCrossCuttingChangeQuery
      && (dominantFamily === "auth" || dominantFamily === "routing")
      && orderedSelectedFiles.length < Math.min(maxContextChunks, 4)
    ) {
      const orderedSeen = new Set(orderedSelectedFiles.map((candidate) => candidate.filePath));
      const orderedSelectedLayers = new Set(orderedSelectedFiles.flatMap((item) => item.layers));
      const supplementalAuthRoutingFiles = this.mergeBroadFileCandidates(
        [...scopedFileCandidates],
        [...fileCandidates]
      )
        .filter((candidate) => !orderedSeen.has(candidate.filePath))
        .filter((candidate) => {
          const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
          return /\b(callback|redirect|protected|guard|pending|destination|auth|login|signin|session|route|router)\b/.test(text)
            || candidate.matchedFamilies.includes("auth")
            || candidate.matchedFamilies.includes("routing");
        })
        .filter((candidate) => !isObservabilityFile(candidate))
        .sort((a, b) => {
          const aText = normalizeTargetText(`${a.filePath} ${a.primary.result.name}`);
          const bText = normalizeTargetText(`${b.filePath} ${b.primary.result.name}`);
          const aBackbone = /\b(callback|redirect|protected|guard|pending|destination)\b/.test(aText) ? 120 : 0;
          const bBackbone = /\b(callback|redirect|protected|guard|pending|destination)\b/.test(bText) ? 120 : 0;
          const aLayerDiversity = a.layers.some((layer) => !orderedSelectedLayers.has(layer)) ? 30 : 0;
          const bLayerDiversity = b.layers.some((layer) => !orderedSelectedLayers.has(layer)) ? 30 : 0;
          return (bBackbone + bLayerDiversity + b.score) - (aBackbone + aLayerDiversity + a.score);
        })
        .slice(0, Math.min(maxContextChunks, 4) - orderedSelectedFiles.length);
      orderedSelectedFiles.push(...supplementalAuthRoutingFiles);
    }

    const selectedChunks = this.expandSelectedBroadFiles(orderedSelectedFiles, maxContextChunks, profile, scopedFileCandidates);
    const fallbackInventoryChunks = profile.inventoryMode && selectedChunks.length === 0
      ? scopedFileCandidates
          .filter((candidate) =>
            dominantFamily
              ? isDominantFamilyFile(candidate)
              : candidate.coreAnchorCount > 0 || candidate.matchedFamilies.length > 0
          )
          .slice(0, Math.min(maxContextChunks, 8))
          .map((candidate) => candidate.primary)
      : [];

    const finalChunks = selectedChunks.length > 0 ? selectedChunks : fallbackInventoryChunks;
    const familyConfidence = this.computeBroadSelectionConfidence(
      profile,
      "workflow",
      dominantFamily,
      orderedSelectedFiles
    );
    const deferredReason = this.shouldDeferBroadSelection(profile, "workflow", {
      dominantFamily,
      selectedFiles: orderedSelectedFiles,
      familyConfidence,
    });
    const diagnosticSelectedFiles = deferredReason
      ? orderedSelectedFiles.slice(0, 3).map((candidate) => ({
          filePath: candidate.filePath,
          selectionSource: "workflow_bundle",
        }))
      : Array.from(new Set(finalChunks.map((candidate) => candidate.result.filePath))).map((filePath) => ({
          filePath,
          selectionSource: "workflow_bundle",
        }));
    this.lastBroadSelection = {
      broadMode: "workflow",
      dominantFamily: dominantFamily ?? undefined,
      deliveryMode: deferredReason ? "summary_only" : "code_context",
      familyConfidence,
      selectedFiles: diagnosticSelectedFiles,
      fallbackReason: finalChunks.length === 0 ? "no_workflow_file_candidates" : undefined,
      deferredReason: deferredReason ?? undefined,
    };

    if (deferredReason) {
      return [];
    }
    const topSelectedScore = Math.max(
      0,
      ...finalChunks.map((candidate) => Math.max(candidate.result.score, candidate.score))
    );
    const workflowResults = finalChunks.map((candidate) => {
      const backboneIndex = backboneOrder.get(candidate.result.filePath);
      const backboneScore = backboneIndex === undefined
        ? 0
        : topSelectedScore * Math.max(0.55, 0.9 - backboneIndex * 0.08);
      const selectedScore = Math.max(candidate.result.score, candidate.score, backboneScore);
      return {
        ...candidate.result,
        hookScore: selectedScore,
        score: selectedScore,
      };
    });
    return this.compactGenerationBackbone(query, workflowResults);
  }

}
