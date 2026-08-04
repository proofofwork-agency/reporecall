import type { SearchResult } from "../types.js";
import { normalizeTargetText } from "../targets.js";
import { isTestFile, textMatchesQueryTerm } from "../utils.js";
import { type BroadWorkflowCandidate, type BroadTargetCandidate, type BroadFileCandidate, type BroadQueryProfile, type BroadMode } from "./model.js";
import { ArchitectureStrategyLayer2 } from "./layer-2.js";

export abstract class ArchitectureStrategyLayer3 extends ArchitectureStrategyLayer2 {
  abstract isBroadCandidateFamilyAligned(
    profile: BroadQueryProfile,
    dominantFamily: string | null,
    candidate: BroadFileCandidate
  ): boolean;

  computeBroadSelectionConfidence(
    profile: BroadQueryProfile,
    mode: BroadMode,
    dominantFamily: string | null,
    candidates: BroadFileCandidate[]
  ): number {
    if (candidates.length === 0) return 0;
    const considered = candidates.slice(0, Math.min(6, candidates.length));
    const alignedCandidates = considered.filter((candidate) =>
      this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
    );
    const familyAligned = alignedCandidates.length / considered.length;
    const alignedNonUtilityRatio = alignedCandidates.filter((candidate) =>
      !candidate.utilityLike
      && !candidate.callbackNoise
      && !candidate.genericOnly
    ).length / considered.length;
    const anchorStrength = considered.reduce((sum, candidate) => sum + Math.min(1, (
      candidate.coreAnchorCount * 0.45
      + candidate.directAnchorCount * 0.2
      + candidate.phraseMatchCount * 0.2
      + (candidate.matchedFamilies.length > 0 ? 0.15 : 0)
    )), 0) / considered.length;
    const lowNoiseRatio = considered.filter((candidate) => !candidate.utilityLike && !candidate.callbackNoise && !candidate.genericOnly).length / considered.length;
    const sharedHeavyRate = considered.filter((candidate) =>
      candidate.layers.every((layer) => layer === "shared" || layer === "core")
    ).length / considered.length;
    const offFamilyNoiseRate = considered.filter((candidate) =>
      !this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
      && (
        candidate.utilityLike
        || candidate.genericOnly
        || candidate.layers.every((layer) => layer === "shared" || layer === "core")
      )
    ).length / considered.length;
    const backendBackboneRatio = considered.filter((candidate) =>
      this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
      && candidate.layers.includes("backend")
      && !candidate.utilityLike
    ).length / considered.length;
    const layerCoverage = new Set(
      considered.flatMap((candidate) => candidate.layers.filter((layer) => layer !== "shared" && layer !== "core"))
    ).size;
    const layerScore = mode === "workflow"
      ? Math.min(1, layerCoverage / 3)
      : Math.min(1, considered.length / 4);

    let score =
      (dominantFamily ? 0.1 : 0)
      + familyAligned * 0.26
      + alignedNonUtilityRatio * 0.2
      + anchorStrength * 0.18
      + lowNoiseRatio * 0.12
      + layerScore * 0.08
      + backendBackboneRatio * (mode === "workflow" ? 0.08 : 0.04)
      - offFamilyNoiseRate * 0.22
      - sharedHeavyRate * 0.12;

    if (mode === "inventory" && profile.allowedFamilies.size > 1) {
      const multiFamilyCoverage = considered.filter((candidate) =>
        candidate.matchedFamilies.some((family) => profile.allowedFamilies.has(family))
      ).length / considered.length;
      score += multiFamilyCoverage * 0.05;
      if (profile.workflowTraceMode) {
        score += multiFamilyCoverage * 0.08;
      }
    }

    return Number(Math.max(0, Math.min(1, score)).toFixed(3));
  }

  shouldDeferBroadSelection(
    profile: BroadQueryProfile,
    mode: BroadMode,
    diagnostics: {
      dominantFamily: string | null;
      selectedFiles: BroadFileCandidate[];
      familyConfidence: number;
    }
  ): string | null {
    const { dominantFamily, selectedFiles, familyConfidence } = diagnostics;
    if (selectedFiles.length === 0) return mode === "inventory" ? "no_inventory_candidates" : "no_workflow_candidates";
    if (!dominantFamily && !profile.lifecycleMode) return "no_dominant_family";

    const limit = mode === "inventory" ? 0.8 : 0.72;
    if (familyConfidence < limit) return "low_family_confidence";

    if (mode === "inventory" && selectedFiles.length < 3) return "insufficient_inventory_coverage";

    const highNoiseRate = selectedFiles.filter((candidate) => candidate.utilityLike || candidate.callbackNoise || candidate.genericOnly).length / selectedFiles.length;
    if (highNoiseRate > 0.34) return "high_noise_bundle";

    const considered = selectedFiles.slice(0, Math.min(mode === "inventory" ? 6 : 5, selectedFiles.length));
    const alignedCandidates = considered.filter((candidate) =>
      this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
    );
    const alignedRatio = alignedCandidates.length / considered.length;
    if (alignedRatio < (mode === "inventory" ? 0.8 : 0.6)) return "low_family_cohesion";

    const alignedBackbone = alignedCandidates.filter((candidate) =>
      !candidate.utilityLike
      && !candidate.callbackNoise
      && !candidate.genericOnly
      && !candidate.layers.every((layer) => layer === "shared" || layer === "core")
    );
    if (alignedBackbone.length < (mode === "inventory" ? 3 : 2)) return "weak_family_backbone";

    const queryText = profile.tokens.join(" ");
    const mentionsUploadDomain = /\b(upload|storage|media|signed|bucket|write)\b/.test(queryText);
    const mentionsBillingDomain = /\b(billing|checkout|portal|subscription|invoice|payment|credit)\b/.test(queryText);
    const mentionsGenerationDomain = /\b(generate|generation|image|shot|render|regen)\b/.test(queryText);
    const mentionsFullTrace = /\b(full|trace|flow)\b/.test(queryText);
    const mentionsUiBoundary = /\b(ui|request|edge|storage|write)\b/.test(queryText);

    const candidateText = (candidate: BroadFileCandidate): string =>
      normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
    const hasStrongAnchor = (candidate: BroadFileCandidate, pattern: RegExp): boolean =>
      pattern.test(candidateText(candidate));

    if (dominantFamily === "generation") {
      const generationBackbone = alignedCandidates.filter((candidate) => {
        const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
        const hasGenPath = /\b(generate|generation|regener|render|text\s+to\s+image|image)\b/.test(text);
        return (candidate.layers.includes("backend") || candidate.layers.includes("state")) && hasGenPath;
      });
      if (generationBackbone.length < 2) return "missing_generation_backbone";
      const weakGenerationRatio = considered.filter((candidate) => {
        const text = candidateText(candidate);
        const hasStrongGenerationAnchor =
          /\b(generate|generation|regener|image|render|orchestrated)\b/.test(text);
        const sharedHelper = candidate.layers.every((layer) => layer === "shared" || layer === "core");
        const weakByName = !hasStrongGenerationAnchor && !sharedHelper;
        return weakByName || (sharedHelper && !hasStrongGenerationAnchor);
      }).length / considered.length;
      if (weakGenerationRatio > 0.3) return "weak_generation_bundle";
      if (mentionsGenerationDomain && mentionsFullTrace && mentionsUiBoundary) {
        const uiGeneration = alignedCandidates.filter((candidate) =>
          (
            candidate.layers.includes("ui")
            || candidate.layers.includes("state")
          )
          && hasStrongAnchor(candidate, /\b(generate|generation|image|shot|render)\b/)
        );
        if (uiGeneration.length < 1) return "missing_generation_layers";
        const helperHeavyRatio = considered.filter((candidate) => {
          const text = candidateText(candidate);
          return /(?:logger|share|progress|client|analytics)/.test(text)
            && !/\bgenerate\b/.test(text);
        }).length / considered.length;
        if (helperHeavyRatio > 0.25) return "helper_heavy_generation_bundle";
      }
    }

    if (dominantFamily === "routing") {
      const authRoutingBackbone = alignedCandidates.filter((candidate) =>
        candidate.layers.includes("routing")
        || candidate.layers.includes("state")
        || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)
      );
      if (authRoutingBackbone.length < 2) return "missing_routing_backbone";
      const genericNavigationRatio = considered.filter((candidate) => {
        const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
        return /navigation/.test(text)
          && !/\b(protected|guard|redirect|callback|auth|route|router)\b/.test(text);
      }).length / considered.length;
      if (genericNavigationRatio > 0.34) return "generic_navigation_bundle";
    }

    if (dominantFamily === "auth") {
      const authBackbone = alignedCandidates.filter((candidate) => {
        const text = candidateText(candidate);
        return /\b(auth|login|signin|signup|signout|session|callback|redirect|protected|guard|token|oauth)\b/.test(text)
          && (
            candidate.layers.includes("ui")
            || candidate.layers.includes("state")
            || candidate.layers.includes("routing")
            || candidate.layers.includes("backend")
            || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)
          );
      });
      if (authBackbone.length < 2) return "missing_auth_backbone";

      const flowNoiseRatio = considered.filter((candidate) => {
        const text = candidateText(candidate);
        return /(?:^|\/)src\/lib\/flow\//.test(candidate.filePath)
          || (/\bworkflow|flow\b/.test(text)
            && !/\b(auth|login|signin|signup|signout|session|callback|redirect|protected|guard|token|oauth)\b/.test(text));
      }).length / considered.length;
      if (flowNoiseRatio > 0.25) return "flow_noise_auth_bundle";
    }

    if (mentionsBillingDomain) {
      const billingBackbone = alignedCandidates.filter((candidate) => {
        const text = candidateText(candidate);
        return /\b(billing|checkout|portal|subscription|invoice|payment|credit)\b/.test(text)
          && (
            candidate.layers.includes("backend")
            || candidate.layers.includes("state")
            || /(?:^|\/)src\/pages\//.test(candidate.filePath)
            || /controller/.test(text)
          );
      });
      if (billingBackbone.length < 2) return "missing_billing_backbone";

      const widgetHeavyRatio = considered.filter((candidate) => {
        const text = candidateText(candidate);
        return /(?:^|\/)src\/components\//.test(candidate.filePath)
          && /\b(card|prompt|history|options|analytics)\b/.test(text)
          && !/\b(page|modal|dialog|layout)\b/.test(text);
      }).length / considered.length;
      if (widgetHeavyRatio > 0.4) return "widget_heavy_billing_bundle";
    }

    if (mentionsUploadDomain) {
      const uploadBackbone = alignedCandidates.filter((candidate) => {
        const text = candidateText(candidate);
        return /\b(upload|storage|media|signed|bucket|write)\b/.test(text)
          && (candidate.layers.includes("backend") || candidate.layers.includes("state"));
      });
      if (uploadBackbone.length < 2) return "missing_upload_backbone";

      const offUploadUiRatio = considered.filter((candidate) => {
        const text = candidateText(candidate);
        const uploadAnchored = /\b(upload|storage|media|signed|bucket|write)\b/.test(text);
        return candidate.layers.includes("ui") && !uploadAnchored;
      }).length / considered.length;
      if (offUploadUiRatio > 0.34) return "weak_upload_bundle";
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Dominant family neighborhood
  // -------------------------------------------------------------------------

  buildDominantFamilyNeighborhood(
    family: string,
    profile: BroadQueryProfile,
    fileCandidates: BroadFileCandidate[],
    allowTests: boolean
  ): BroadFileCandidate[] {
    const aliases = this.getBroadFamilyAliases(profile, family);
    const matchesFamily = (candidate: BroadFileCandidate): boolean => {
      if (candidate.matchedFamilies.includes(family)) return true;
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      return aliases.some((alias) => textMatchesQueryTerm(text, alias));
    };

    const byPath = new Map(fileCandidates.map((candidate) => [candidate.filePath, candidate]));
    const neighborhoodPaths = new Set<string>();
    const seedCandidates = fileCandidates.filter((candidate) => matchesFamily(candidate));
    for (const candidate of seedCandidates.slice(0, 8)) {
      neighborhoodPaths.add(candidate.filePath);
      for (const neighborPath of this.collectBroadImportNeighbors(candidate.filePath)) {
        neighborhoodPaths.add(neighborPath);
      }
    }

    if (typeof this.metadata.findTargetsBySubsystem === "function") {
      for (const target of this.metadata.findTargetsBySubsystem([family], 30)) {
        if (!allowTests && isTestFile(target.filePath)) continue;
        neighborhoodPaths.add(target.filePath);
      }
    }

    const neighbors: BroadFileCandidate[] = [];
    for (const filePath of neighborhoodPaths) {
      const candidate = byPath.get(filePath) ?? this.buildBroadFileCandidateFromFilePath(filePath, profile);
      if (!candidate) continue;
      if (candidate.callbackNoise) continue;
      if (
        !matchesFamily(candidate)
        && (profile.inventoryMode ? candidate.coreAnchorCount : candidate.directAnchorCount) === 0
        && candidate.phraseMatchCount === 0
      ) {
        continue;
      }
      const boosted = {
        ...candidate,
        score: candidate.score + (matchesFamily(candidate) ? 0.36 : profile.inventoryMode ? 0.06 : 0.12),
      };
      const existing = byPath.get(filePath);
      if (!existing || boosted.score > existing.score) {
        byPath.set(filePath, boosted);
      }
      neighbors.push(boosted);
    }

    const scoped = Array.from(byPath.values()).filter((candidate) =>
      matchesFamily(candidate)
      || neighborhoodPaths.has(candidate.filePath)
      || (profile.inventoryMode ? candidate.coreAnchorCount : candidate.directAnchorCount) > 0
      || candidate.phraseMatchCount > 0
    );

    return scoped.sort((a, b) => b.score - a.score);
  }

  getBroadFamilyAliases(profile: BroadQueryProfile, family: string): string[] {
    return Array.from(new Set(
      [...profile.anchorTerms, ...profile.familyTerms]
        .filter((term) => term.family === family)
        .map((term) => term.term)
    ));
  }

  // -------------------------------------------------------------------------
  // Expand selected broad files
  // -------------------------------------------------------------------------

  expandSelectedBroadFiles(
    files: BroadFileCandidate[],
    maxContextChunks: number,
    profile: BroadQueryProfile,
    allFileCandidates: BroadFileCandidate[]
  ): BroadWorkflowCandidate[] {
    const limit = Math.min(maxContextChunks, 8);
    const selected: BroadWorkflowCandidate[] = [];
    const seenIds = new Set<string>();
    const selectedFilePaths = new Set<string>();
    const fileCandidateByPath = new Map(allFileCandidates.map((candidate) => [candidate.filePath, candidate]));

    for (const file of files) {
      if (selected.length >= limit) break;
      const primary = file.primary;
      if (seenIds.has(primary.result.id)) continue;
      selected.push(primary);
      seenIds.add(primary.result.id);
      selectedFilePaths.add(file.filePath);
    }

    if (!profile.inventoryMode) {
      for (const file of files) {
        if (selected.length >= limit) break;
        const secondary = file.chunks.find((candidate) =>
          candidate.result.id !== file.primary.result.id
          && !seenIds.has(candidate.result.id)
          && (candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0)
        );
        if (!secondary) continue;
        selected.push(secondary);
        seenIds.add(secondary.result.id);
      }
    }

    if (profile.inventoryMode) {
      return selected;
    }

    const neighborFiles: BroadFileCandidate[] = [];
    for (const file of files) {
      if (neighborFiles.length >= limit) break;
      for (const neighborPath of this.collectBroadImportNeighbors(file.filePath)) {
        if (selectedFilePaths.has(neighborPath)) continue;
        const neighbor = fileCandidateByPath.get(neighborPath)
          ?? this.buildBroadFileCandidateFromFilePath(neighborPath, profile);
        if (!neighbor) continue;
        if (neighbor.callbackNoise) continue;
        if (
          (profile.inventoryMode ? neighbor.coreAnchorCount : neighbor.directAnchorCount) === 0
          && neighbor.phraseMatchCount === 0
          && neighbor.matchedFamilies.length === 0
        ) {
          continue;
        }
        if (
          profile.allowedFamilies.size > 0
          && neighbor.matchedFamilies.length > 0
          && !neighbor.matchedFamilies.some((family) => profile.allowedFamilies.has(family))
        ) {
          continue;
        }
        neighborFiles.push(neighbor);
      }
    }

    neighborFiles
      .sort((a, b) => b.score - a.score)
      .forEach((file) => {
        if (selected.length >= limit) return;
        if (selectedFilePaths.has(file.filePath)) return;
        selected.push(file.primary);
        seenIds.add(file.primary.result.id);
        selectedFilePaths.add(file.filePath);
      });

    return selected;
  }

  // -------------------------------------------------------------------------
  // Target results
  // -------------------------------------------------------------------------

  buildBroadTargetResults(
    query: string,
    allowTests: boolean,
    profile?: BroadQueryProfile
  ): SearchResult[] {
    if (!this.metadata.resolveTargetAliases) return [];

    const resolvedProfile = profile ?? this.buildBroadQueryProfile(query);
    const aliases = this.buildBroadTargetAliasList(resolvedProfile);
    const hits = [
      ...this.metadata.resolveTargetAliases(aliases, 120, ["file_module", "endpoint"]),
      ...this.metadata.resolveTargetAliases(aliases, 160, ["symbol", "subsystem"]),
    ];
    const candidates = new Map<string, BroadTargetCandidate>();

    for (const hit of hits) {
      const candidate = this.scoreBroadTargetHit(hit, resolvedProfile, allowTests);
      if (!candidate) continue;
      const current = candidates.get(candidate.result.id);
      if (!current || candidate.score > current.score) {
        candidates.set(candidate.result.id, candidate);
      }
    }

    return Array.from(candidates.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 16)
      .map((candidate) => ({
        ...candidate.result,
        score: candidate.score,
        hookScore: candidate.score,
      }));
  }

  // -------------------------------------------------------------------------
  // Concept results
  // -------------------------------------------------------------------------

  buildBroadConceptResults(
    query: string,
    allowTests: boolean,
    profile: BroadQueryProfile
  ): SearchResult[] {
    if (profile.inventoryMode) return [];

    const bundles = this.getMatchedConceptBundles(query);
    if (bundles.length === 0) return [];

    const selected = new Map<string, SearchResult>();
    const lowerQuery = query.toLowerCase();

    for (const bundle of bundles) {
      const bonus =
        bundle.kind === "search_pipeline" ? 1.15
        : bundle.kind === "daemon" ? 1.1
        : bundle.kind === "lifecycle" ? 1.8
        : bundle.kind === "context_assembly" ? 1.05
        : 1.0;
      const chunks = this.selectConceptChunks(
        bundle.symbols,
        // Bug fix: Math.min (not Math.max) so a small configured maxChunks is
        // honored rather than silently bumped to 6.
        Math.min(bundle.symbols.length, Math.min(bundle.maxChunks ?? 4, 6))
      );

      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (!chunk) continue;
        if (!allowTests && isTestFile(chunk.filePath)) continue;
        const base = this.chunkToSearchResult(chunk, 2 - index * 0.05 + bonus);
        const scored = this.scoreBroadWorkflowCandidate(base, profile);
        let score = Math.max(base.score, scored.score + 0.45) + bonus;
        if (lowerQuery.includes("end-to-end") || lowerQuery.includes("complete workflow")) {
          score += 0.18;
        }
        if (bundle.kind === "lifecycle" && /\b(storage|daemon|server|pipeline|scheduler)\b/.test(lowerQuery)) {
          score += 0.24;
        }
        if (this.isImplementationPath(chunk.filePath)) {
          score += 0.08;
        }
        const enriched: SearchResult = {
          ...base,
          score,
          hookScore: score,
        };
        const existing = selected.get(enriched.id);
        if (!existing || enriched.score > existing.score) {
          selected.set(enriched.id, enriched);
        }
      }
    }

    return Array.from(selected.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
  }

  buildBroadConceptFileCandidates(
    query: string,
    profile: BroadQueryProfile,
    allowTests: boolean
  ): BroadFileCandidate[] {
    if (profile.inventoryMode) return [];

    const bundles = this.getMatchedConceptBundles(query);
    if (bundles.length === 0) return [];

    const byPath = new Map<string, BroadFileCandidate>();
    for (const bundle of bundles) {
      const chunks = this.selectConceptChunks(
        // Bug fix: Math.min (not Math.max) so a small configured maxChunks is
        // honored rather than silently bumped to 6.
        bundle.symbols,
        Math.min(bundle.symbols.length, Math.min(bundle.maxChunks ?? 4, 6))
      );
      const hitsByPath = new Map<string, number>();
      for (const chunk of chunks) {
        if (!allowTests && isTestFile(chunk.filePath)) continue;
        hitsByPath.set(chunk.filePath, (hitsByPath.get(chunk.filePath) ?? 0) + 1);
      }

      for (const [filePath, count] of hitsByPath) {
        const candidate = this.buildBroadFileCandidateFromFilePath(filePath, profile);
        if (!candidate || candidate.callbackNoise) continue;
        const boosted: BroadFileCandidate = {
          ...candidate,
          score:
            candidate.score
            + (bundle.kind === "lifecycle" ? 1.25 : 0.7)
            + Math.min(0.45, (count - 1) * 0.18),
        };
        const existing = byPath.get(filePath);
        if (!existing || boosted.score > existing.score) {
          byPath.set(filePath, boosted);
        }
      }
    }

    return Array.from(byPath.values()).sort((a, b) => b.score - a.score);
  }

  // -------------------------------------------------------------------------
  // Target alias list
  // -------------------------------------------------------------------------
}
