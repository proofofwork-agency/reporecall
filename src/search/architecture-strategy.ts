/**
 * Architecture / broad-strategy module extracted from hybrid.ts.
 *
 * Contains all constants, types, and methods related to:
 *   - Broad workflow bundle selection
 *   - Broad inventory bundle selection
 *   - Broad query profile construction
 *   - Dominant family selection and neighborhood building
 *   - Broad file / target / concept candidate scoring
 *   - Broad selection confidence and deferral logic
 */

import type { MemoryConfig } from "../core/config.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { StoredChunk, TargetKind, ResolvedTargetAliasHit } from "../storage/types.js";
import type { SearchResult } from "./types.js";
import type { SeedResult } from "./seed.js";
import { resolveSeeds } from "./seed.js";
import { classifyIntent } from "./intent.js";
import { normalizeTargetText } from "./targets.js";
import {
  collectCorpusFamilyTerms,
  expandQueryTerms,
  GENERIC_BROAD_TERMS,
  GENERIC_QUERY_ACTION_TERMS,
  type ExpandedQueryTerm,
  inferQueryExecutionSurfaceBias,
  isTestFile,
  type ExecutionSurfaceBias,
  scoreExecutionSurfaceAlignment,
  detectExecutionSurfaces,
  STOP_WORDS,
  textMatchesQueryTerm,
  tokenizeQueryTerms,
} from "./utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BROAD_PHRASE_GENERIC_TERMS = GENERIC_BROAD_TERMS;

export const INVENTORY_GENERIC_TARGET_ALIAS_TERMS = new Set([
  "route", "routes", "router", "routing", "navigation",
]);

export const BROAD_INVENTORY_RE =
  /\b(?:which|what|list|show)\s+files\b|\bfiles?\s+(?:implement|handle|power|control|cover)\b/i;

export const INVENTORY_STRUCTURAL_TERMS = new Set([
  "which",
  "what",
  "list",
  "show",
  "file",
  "files",
  "implement",
  "implements",
  "handle",
  "handles",
  "power",
  "powers",
  "control",
  "controls",
  "cover",
  "covers",
  "full",
  "entire",
]);

export const SUBSYSTEM_INVENTORY_FAMILIES = new Set(["search"]);

export const STRICT_WORKFLOW_FAMILY_COHESION = new Set([
  "auth",
  "routing",
  "billing",
  "storage",
  "generation",
]);

export const ADJACENT_WORKFLOW_FAMILIES: Record<string, string[]> = {
  auth: ["routing", "permissions"],
  routing: ["auth", "permissions"],
  billing: ["auth"],
  storage: ["auth"],
  generation: ["storage"],
};

// ---------------------------------------------------------------------------
// Types / interfaces
// ---------------------------------------------------------------------------

export interface CompiledConceptBundle {
  kind: string;
  pattern: RegExp;
  symbols: string[];
  maxChunks: number;
}

export function compileConceptBundles(
  bundles: Array<{ kind: string; pattern: string; symbols: string[]; maxChunks: number }>
): CompiledConceptBundle[] {
  if (!bundles) return [];
  return bundles.map((b) => ({
    kind: b.kind,
    pattern: new RegExp(b.pattern, "i"),
    symbols: b.symbols,
    maxChunks: b.maxChunks,
  }));
}

export interface BroadWorkflowCandidate {
  result: SearchResult;
  score: number;
  layers: string[];
  matchedFamilies: string[];
  matchedWeight: number;
  genericOnly: boolean;
  utilityLike: boolean;
  directAnchorCount: number;
  coreAnchorCount: number;
  phraseMatchCount: number;
  callbackNoise: boolean;
}

export interface BroadTargetCandidate {
  result: SearchResult;
  score: number;
  subsystem?: string;
}

export interface BroadFileCandidate {
  filePath: string;
  primary: BroadWorkflowCandidate;
  chunks: BroadWorkflowCandidate[];
  score: number;
  layers: string[];
  matchedFamilies: string[];
  directAnchorCount: number;
  coreAnchorCount: number;
  phraseMatchCount: number;
  utilityLike: boolean;
  callbackNoise: boolean;
  genericOnly: boolean;
}

export interface BroadQueryProfile {
  expandedTerms: ExpandedQueryTerm[];
  anchorTerms: ExpandedQueryTerm[];
  familyTerms: ExpandedQueryTerm[];
  allowedFamilies: Set<string>;
  phrases: string[];
  tokens: string[];
  inventoryMode: boolean;
  lifecycleMode: boolean;
  workflowTraceMode: boolean;
  surfaceBias: ExecutionSurfaceBias;
}

export type BroadMode = "inventory" | "workflow";

export interface BroadSelectedFileDiagnostic {
  filePath: string;
  selectionSource: string;
}

export interface BroadSelectionDiagnostics {
  broadMode: BroadMode;
  dominantFamily?: string;
  deliveryMode: "code_context" | "summary_only";
  familyConfidence?: number;
  selectedFiles: BroadSelectedFileDiagnostic[];
  fallbackReason?: string;
  deferredReason?: string;
}

export interface InventoryFileCandidate extends BroadFileCandidate {
  selectionSource: string;
  targetKind?: TargetKind;
  importCorroboration: number;
  subsystemMatch: boolean;
}

// ---------------------------------------------------------------------------
// ArchitectureStrategy class
// ---------------------------------------------------------------------------

export class ArchitectureStrategy {
  private metadata: MetadataStore;
  private config: MemoryConfig;
  private fts: FTSStore;
  private conceptBundles: CompiledConceptBundle[];
  lastBroadSelection: BroadSelectionDiagnostics | null = null;

  constructor(deps: {
    metadata: MetadataStore;
    config: MemoryConfig;
    ftsStore: FTSStore;
  }) {
    this.metadata = deps.metadata;
    this.config = deps.config;
    this.fts = deps.ftsStore;
    this.conceptBundles = compileConceptBundles(deps.config.conceptBundles);
  }

  updateStores(metadata: MetadataStore, fts: FTSStore): void {
    this.metadata = metadata;
    this.fts = fts;
  }

  // -------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------

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
      return this.selectBroadInventoryBundle(profile, candidates, allowTests, maxContextChunks);
    }
    const baseFileCandidates = this.mergeBroadFileCandidates(
      this.buildBroadFileCandidates(candidates, profile),
      this.buildBroadConceptFileCandidates(query, profile, allowTests)
    );
    const fileCandidates = profile.lifecycleMode
      ? baseFileCandidates
      : this.mergeBroadFileCandidates(
          baseFileCandidates,
          this.buildBroadFamilyFileCandidates(profile, allowTests)
        );
    const dominantFamily = this.chooseDominantBroadFamily(profile, fileCandidates);
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
    const queryMentionsLogging = /\b(log|logging|trace|audit|instrument|instrumentation|telemetry)\b/i.test(query);
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

    const trySelectFile = (candidate: BroadFileCandidate | undefined) => {
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
      ) {
        return;
      }
      if (candidate.utilityLike && utilityCount >= 1) return;
      if (!profile.inventoryMode && !profile.lifecycleMode && selectedFiles.length < 3) {
        if (candidate.utilityLike) return;
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

    const orderedSelectedFiles = profile.inventoryMode
      ? selectedFiles
      : [...selectedFiles].sort((a, b) => {
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
          const aLayerDiversity = a.layers.some((layer) => !orderedSelectedFiles.flatMap((item) => item.layers).includes(layer)) ? 30 : 0;
          const bLayerDiversity = b.layers.some((layer) => !orderedSelectedFiles.flatMap((item) => item.layers).includes(layer)) ? 30 : 0;
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
      return results;
    }
    return finalChunks.length > 0
      ? finalChunks.map((candidate) => ({
          ...candidate.result,
          hookScore: candidate.score,
          score: Math.max(candidate.result.score, candidate.score),
        }))
      : results;
  }

  // -------------------------------------------------------------------------
  // Answer-first priority
  // -------------------------------------------------------------------------

  computeBroadWorkflowAnswerFirstPriority(
    candidate: BroadFileCandidate,
    profile: BroadQueryProfile,
    dominantFamily: string | null
  ): number {
    const answerFirstScoped =
      profile.surfaceBias.defaultUserFacing
      || profile.surfaceBias.explicitBackend
      || dominantFamily === "auth"
      || dominantFamily === "routing";
    if (!answerFirstScoped) return 0;

    const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
    const userFacingLayer = candidate.layers.some((layer) => layer === "ui" || layer === "routing" || layer === "state");
    const backendLayer = candidate.layers.includes("backend");
    const pureOperationalSurface =
      !userFacingLayer
      && (
        /(?:^|\/)(mcp|mcp-server)\//.test(candidate.filePath)
        || /(?:^|\/)(cli|commands?)\//.test(candidate.filePath)
        || /(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(candidate.filePath)
      );

    let priority = 0;

    if (
      profile.surfaceBias.defaultUserFacing
      && !profile.surfaceBias.explicitBackend
      && !profile.surfaceBias.explicitInfrastructure
    ) {
      if (userFacingLayer) priority += 80;
      if (candidate.layers.includes("routing")) priority += 28;
      if (candidate.layers.includes("state")) priority += 22;
      if (candidate.layers.includes("ui")) priority += 18;
      if (pureOperationalSurface) priority -= 70;
      if (backendLayer && !candidate.layers.includes("routing")) priority -= 24;
    } else if (profile.surfaceBias.explicitBackend) {
      if (backendLayer) priority += 34;
      if (userFacingLayer && !backendLayer) priority -= 20;
    }

    if (candidate.chunks.length <= 2) priority += 12;
    else if (candidate.chunks.length <= 4) priority += 6;
    else if (candidate.chunks.length >= 8) priority -= 10;

    priority += candidate.coreAnchorCount * 12;
    priority += candidate.directAnchorCount * 8;
    priority += candidate.phraseMatchCount * 6;

    if (candidate.utilityLike) priority -= 14;
    if (candidate.callbackNoise) priority -= 30;
    if (candidate.genericOnly) priority -= 24;

    if (dominantFamily === "auth" && !profile.surfaceBias.explicitBackend) {
      if (/\b(callback|redirect|protected|guard|session|signin|signup|login|auth)\b/.test(text)) {
        priority += 36;
      }
      if (/\b(provider|oauth|token|consent|client store|clientstore)\b/.test(text) && !candidate.layers.includes("routing")) {
        priority -= 28;
      }
    }

    if (dominantFamily === "routing") {
      if (/\b(callback|redirect|protected|guard|route|router|navigation|destination|handoff)\b/.test(text)) {
        priority += 22;
      }
      if (/\b(menu|drawer|keyboard|segment|tab|mobile)\b/.test(text)) {
        priority -= 18;
      }
    }

    return priority;
  }

  // -------------------------------------------------------------------------
  // Inventory bundle
  // -------------------------------------------------------------------------

  selectBroadInventoryBundle(
    profile: BroadQueryProfile,
    candidates: BroadWorkflowCandidate[],
    allowTests: boolean,
    maxContextChunks: number
  ): SearchResult[] {
    const dominantFamily = this.chooseDominantBroadFamily(
      profile,
      this.mergeBroadFileCandidates(
        this.buildBroadFileCandidates(candidates, profile),
        this.buildBroadFamilyFileCandidates(profile, allowTests)
      )
    );
    const inventoryCandidates = this.buildInventoryFileCandidates(profile, candidates, dominantFamily, allowTests);
    const selectedFiles = this.selectInventoryFiles(profile, inventoryCandidates, dominantFamily, maxContextChunks);
    const selectedChunks = selectedFiles
      .slice(0, Math.min(maxContextChunks, 8))
      .map((candidate) => candidate.primary);
    const familyConfidence = this.computeBroadSelectionConfidence(
      profile,
      "inventory",
      dominantFamily,
      selectedFiles
    );
    const deferredReason = this.shouldDeferBroadSelection(profile, "inventory", {
      dominantFamily,
      selectedFiles,
      familyConfidence,
    });
    const diagnosticSelectedFiles = deferredReason
      ? selectedFiles.slice(0, 3).map((candidate) => ({
          filePath: candidate.filePath,
          selectionSource: candidate.selectionSource,
        }))
      : Array.from(new Map(selectedChunks.map((candidate) => [candidate.result.filePath, candidate.result.filePath])).values())
          .map((filePath) => ({
            filePath,
            selectionSource: "inventory_bundle",
          }));

    this.lastBroadSelection = {
      broadMode: "inventory",
      dominantFamily: dominantFamily ?? undefined,
      deliveryMode: deferredReason ? "summary_only" : "code_context",
      familyConfidence,
      selectedFiles: diagnosticSelectedFiles,
      fallbackReason: selectedFiles.length === 0 ? "no_inventory_file_candidates" : undefined,
      deferredReason: deferredReason ?? undefined,
    };

    return selectedChunks.length > 0
      ? selectedChunks.map((candidate) => ({
          ...candidate.result,
          hookScore: candidate.score,
          score: Math.max(candidate.result.score, candidate.score),
        }))
      : candidates
          .slice(0, Math.min(maxContextChunks, 8))
          .map((candidate) => candidate.result);
  }

  // -------------------------------------------------------------------------
  // Inventory file candidates
  // -------------------------------------------------------------------------

  buildInventoryFileCandidates(
    profile: BroadQueryProfile,
    candidates: BroadWorkflowCandidate[],
    dominantFamily: string | null,
    allowTests: boolean
  ): InventoryFileCandidate[] {
    const baseCandidates = this.buildBroadFileCandidates(candidates, profile);
    const byPath = new Map<string, InventoryFileCandidate>();
    const dominantAliases = dominantFamily
      ? this.getBroadFamilyAliases(profile, dominantFamily)
      : [];
    const matchesAllowedFamilies = (base: BroadFileCandidate): boolean =>
      profile.allowedFamilies.size === 0
      || base.matchedFamilies.some((family) => profile.allowedFamilies.has(family));

    const upsert = (
      filePath: string,
      source: string,
      targetKind?: TargetKind,
      boost: number = 0
    ) => {
      if (!allowTests && isTestFile(filePath)) return;
      const base = baseCandidates.find((candidate) => candidate.filePath === filePath)
        ?? this.buildBroadFileCandidateFromFilePath(filePath, profile);
      if (!base || base.callbackNoise) return;

      const subsystemMatch = !!dominantFamily && filePath.includes(`/${dominantFamily}/`);
      const importCorroboration = this.countInventoryImportCorroboration(
        filePath,
        dominantFamily,
        baseCandidates
      );
      const sourceWeight =
        source === "typed_target" ? 0.9
          : source === "subsystem" ? 0.7
            : source === "import_neighbor" ? 0.28
              : 0;
      const allowedFamilyCoverage = profile.allowedFamilies.size > 0
        ? base.matchedFamilies.filter((family) => profile.allowedFamilies.has(family)).length
        : 0;
      const orchestratorLike = this.isBroadOrchestratorLikePath(
        filePath.toLowerCase(),
        base.primary.result.name.toLowerCase()
      );

      const next: InventoryFileCandidate = {
        ...base,
        selectionSource: source,
        targetKind,
        subsystemMatch,
        importCorroboration,
        score:
          base.score
          + boost
          + sourceWeight
          + (subsystemMatch ? 0.45 : 0)
          + Math.min(0.36, importCorroboration * 0.12)
          + (base.coreAnchorCount > 0 ? Math.min(0.4, base.coreAnchorCount * 0.14) : 0)
          + (allowedFamilyCoverage > 0 ? Math.min(0.42, allowedFamilyCoverage * 0.16) : 0)
          + (
            profile.workflowTraceMode
            && orchestratorLike
            && (allowedFamilyCoverage > 0 || base.coreAnchorCount > 0 || base.phraseMatchCount > 0)
              ? 0.26
              : 0
          )
          + (
            dominantFamily && base.matchedFamilies.includes(dominantFamily)
              ? 0.35
              : 0
          )
          - (
            source === "import_neighbor"
            && base.coreAnchorCount === 0
            && base.matchedFamilies.length === 0
              ? 0.6
              : 0
          )
          - (base.utilityLike ? 0.2 : 0)
          - (base.genericOnly && base.coreAnchorCount === 0 ? 0.4 : 0),
      };
      const dominantAliasMatch = dominantAliases.length === 0
        ? true
        : dominantAliases.some((alias) =>
            textMatchesQueryTerm(`${next.filePath} ${next.primary.result.name}`.toLowerCase(), alias)
          );

      if (
        dominantFamily
        && !next.subsystemMatch
        && !base.matchedFamilies.includes(dominantFamily)
        && !matchesAllowedFamilies(base)
        && source !== "import_neighbor"
      ) {
        return;
      }
      if (source === "typed_target" && dominantFamily && !dominantAliasMatch) {
        return;
      }

      const existing = byPath.get(filePath);
      if (!existing || next.score > existing.score) {
        byPath.set(filePath, next);
      }
    };

    for (const candidate of baseCandidates) {
      upsert(candidate.filePath, "chunk", undefined, 0);
    }

    for (const candidate of this.buildBroadFamilyFileCandidates(profile, allowTests)) {
      upsert(candidate.filePath, "typed_target", "file_module", 0.18);
    }

    if (dominantFamily && typeof this.metadata.findTargetsBySubsystem === "function") {
      for (const target of this.metadata.findTargetsBySubsystem([dominantFamily], 80)) {
        upsert(
          target.filePath,
          target.kind === "file_module" || target.kind === "endpoint" ? "typed_target" : "subsystem",
          target.kind,
          target.kind === "file_module" || target.kind === "endpoint" ? 0.2 : 0.1
        );
      }
    }
    if (profile.workflowTraceMode && profile.allowedFamilies.size > 1 && typeof this.metadata.findTargetsBySubsystem === "function") {
      for (const family of profile.allowedFamilies) {
        if (family === dominantFamily) continue;
        for (const target of this.metadata.findTargetsBySubsystem([family], 40)) {
          upsert(
            target.filePath,
            target.kind === "file_module" || target.kind === "endpoint" ? "typed_target" : "subsystem",
            target.kind,
            target.kind === "file_module" || target.kind === "endpoint" ? 0.14 : 0.08
          );
        }
      }
    }

    const dominantPaths = Array.from(byPath.values())
      .filter((candidate) =>
        dominantFamily
          ? candidate.subsystemMatch || candidate.matchedFamilies.includes(dominantFamily)
          : candidate.coreAnchorCount > 0 || candidate.matchedFamilies.length > 0
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((candidate) => candidate.filePath);

    for (const filePath of dominantPaths) {
      for (const neighbor of this.collectBroadImportNeighbors(filePath)) {
        upsert(neighbor, "import_neighbor");
      }
    }

    return Array.from(byPath.values())
      .filter((candidate) => !candidate.callbackNoise)
      .sort((a, b) => b.score - a.score);
  }

  countInventoryImportCorroboration(
    filePath: string,
    dominantFamily: string | null,
    baseCandidates: BroadFileCandidate[]
  ): number {
    const familyPaths = baseCandidates
      .filter((candidate) =>
        dominantFamily
          ? candidate.filePath.includes(`/${dominantFamily}/`) || candidate.matchedFamilies.includes(dominantFamily)
          : candidate.coreAnchorCount > 0 || candidate.matchedFamilies.length > 0
      )
      .slice(0, 12)
      .map((candidate) => candidate.filePath);
    if (familyPaths.length === 0) return 0;

    const neighbors = new Set(this.collectBroadImportNeighbors(filePath));
    let corroboration = 0;
    for (const familyPath of familyPaths) {
      if (familyPath === filePath || neighbors.has(familyPath)) corroboration++;
    }
    return corroboration;
  }

  // -------------------------------------------------------------------------
  // Inventory file selection
  // -------------------------------------------------------------------------

  selectInventoryFiles(
    profile: BroadQueryProfile,
    candidates: InventoryFileCandidate[],
    dominantFamily: string | null,
    maxContextChunks: number
  ): InventoryFileCandidate[] {
    const limit = Math.min(maxContextChunks, 8);
    const selected: InventoryFileCandidate[] = [];
    const seenFilePaths = new Set<string>();
    const preferLayered = dominantFamily === "auth" || dominantFamily === "routing" || dominantFamily === "permissions";
    const requireSameSubsystem = !!dominantFamily && SUBSYSTEM_INVENTORY_FAMILIES.has(dominantFamily);
    const queryMentionsLogging = profile.tokens.includes("log") || profile.tokens.includes("logging") || profile.tokens.includes("error");
    const queryMentionsProtection = profile.tokens.includes("protection") || profile.tokens.includes("protected") || profile.tokens.includes("guard");
    const queryMentionsPending = profile.tokens.includes("pending") || profile.tokens.includes("pendingnavigation");
    const routingInventoryBackbone = (candidate: InventoryFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      if (/\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)) return true;
      if (/\b(protected|guard|redirect|callback|auth|route|router)\b/.test(text)) return true;
      if (queryMentionsPending && /\bpending\b/.test(text)) return true;
      return false;
    };
    const routingInventoryNoise = (candidate: InventoryFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      return /\b(skip|keyboard|drawer|menu|mobile|floating|tab|a11y)\b/.test(text)
        && !/\b(protected|guard|redirect|callback|auth|pending|route|router)\b/.test(text);
    };
    const matchesAcceptedFamily = (candidate: InventoryFileCandidate): boolean => {
      if (!dominantFamily && profile.allowedFamilies.size === 0) return true;
      if (dominantFamily && (candidate.subsystemMatch || candidate.matchedFamilies.includes(dominantFamily))) return true;
      return profile.allowedFamilies.size > 1
        && candidate.matchedFamilies.some((family) => profile.allowedFamilies.has(family));
    };

    const trySelect = (candidate: InventoryFileCandidate | undefined) => {
      if (!candidate) return;
      if (seenFilePaths.has(candidate.filePath)) return;
      if (candidate.callbackNoise) return;
      if (
        candidate.selectionSource === "import_neighbor"
        && candidate.coreAnchorCount === 0
        && candidate.matchedFamilies.length === 0
      ) {
        return;
      }
      if (
        candidate.utilityLike
        && !queryMentionsLogging
        && selected.some((item) => item.utilityLike)
      ) {
        return;
      }
      selected.push(candidate);
      seenFilePaths.add(candidate.filePath);
    };

    const ranked = [...candidates].sort((a, b) => {
      if (profile.workflowTraceMode && profile.allowedFamilies.size > 1) {
        const aCoverage = a.matchedFamilies.filter((family) => profile.allowedFamilies.has(family)).length;
        const bCoverage = b.matchedFamilies.filter((family) => profile.allowedFamilies.has(family)).length;
        if (aCoverage !== bCoverage) return bCoverage - aCoverage;
      }
      const aFamily = dominantFamily && (a.subsystemMatch || a.matchedFamilies.includes(dominantFamily)) ? 1 : 0;
      const bFamily = dominantFamily && (b.subsystemMatch || b.matchedFamilies.includes(dominantFamily)) ? 1 : 0;
      if (aFamily !== bFamily) return bFamily - aFamily;
      if (dominantFamily === "routing" || (dominantFamily === "auth" && (queryMentionsProtection || queryMentionsPending))) {
        const aBackbone = routingInventoryBackbone(a) ? 1 : 0;
        const bBackbone = routingInventoryBackbone(b) ? 1 : 0;
        if (aBackbone !== bBackbone) return bBackbone - aBackbone;
        const aNoise = routingInventoryNoise(a) ? 1 : 0;
        const bNoise = routingInventoryNoise(b) ? 1 : 0;
        if (aNoise !== bNoise) return aNoise - bNoise;
      }
      if (a.selectionSource !== b.selectionSource) {
        const order = ["typed_target", "chunk", "subsystem", "import_neighbor"];
        return order.indexOf(a.selectionSource) - order.indexOf(b.selectionSource);
      }
      if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
      if (a.importCorroboration !== b.importCorroboration) return b.importCorroboration - a.importCorroboration;
      return b.score - a.score;
    });

    if (preferLayered) {
      const layers = ["ui", "state", "routing", "backend"];
      for (const layer of layers) {
        trySelect(
          ranked.find((candidate) =>
            candidate.layers.includes(layer)
            && matchesAcceptedFamily(candidate)
          )
        );
        if (selected.length >= limit) return selected;
      }
    }

    for (const candidate of ranked) {
      if (selected.length >= limit) break;
      if (
        requireSameSubsystem
        && !candidate.subsystemMatch
        && candidate.selectionSource !== "typed_target"
        && candidate.selectionSource !== "subsystem"
      ) {
        continue;
      }
      if (
        dominantFamily
        && candidate.selectionSource === "import_neighbor"
        && !matchesAcceptedFamily(candidate)
        && candidate.coreAnchorCount === 0
        && candidate.phraseMatchCount === 0
      ) {
        continue;
      }
      if (
        (dominantFamily || profile.allowedFamilies.size > 0)
        && !matchesAcceptedFamily(candidate)
        && candidate.importCorroboration === 0
      ) {
        continue;
      }
      trySelect(candidate);
    }

    return selected;
  }

  // -------------------------------------------------------------------------
  // Broad file candidates
  // -------------------------------------------------------------------------

  buildBroadFileCandidates(
    candidates: BroadWorkflowCandidate[],
    profile: BroadQueryProfile
  ): BroadFileCandidate[] {
    const groups = new Map<string, BroadWorkflowCandidate[]>();
    for (const candidate of candidates) {
      const existing = groups.get(candidate.result.filePath) ?? [];
      existing.push(candidate);
      groups.set(candidate.result.filePath, existing);
    }

    const fileCandidates: BroadFileCandidate[] = [];
    for (const [filePath, chunks] of groups) {
      const sorted = [...chunks].sort((a, b) => b.score - a.score);
      const primary = sorted[0];
      if (!primary) continue;
      const layers = Array.from(new Set(sorted.flatMap((candidate) => candidate.layers)));
      const matchedFamilies = Array.from(new Set(sorted.flatMap((candidate) => candidate.matchedFamilies)));
      const directAnchorCount = Math.max(...sorted.map((candidate) => candidate.directAnchorCount));
      const coreAnchorCount = Math.max(...sorted.map((candidate) => candidate.coreAnchorCount));
      const phraseMatchCount = Math.max(...sorted.map((candidate) => candidate.phraseMatchCount));
      const callbackNoise = sorted.every((candidate) => candidate.callbackNoise);
      const utilityLike = primary.utilityLike && matchedFamilies.length === 0;
      const genericOnly = sorted.every((candidate) => candidate.genericOnly);
      const corroboratingChunks = sorted.filter((candidate) =>
        candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0 || candidate.matchedFamilies.length > 0
      ).length;
      const layerCoverage = layers.filter((layer) => layer !== "shared" && layer !== "core").length;

      let score = primary.score;
      score += Math.min(0.45, (corroboratingChunks - 1) * 0.12);
      score += Math.min(0.35, layerCoverage * 0.1);
      score += Math.min(0.28, matchedFamilies.length * 0.08);
      if (directAnchorCount >= 2) score += 0.2;
      if (profile.inventoryMode && coreAnchorCount === 0 && matchedFamilies.length === 0) score -= 0.55;
      if (profile.inventoryMode && coreAnchorCount > 0) score += Math.min(0.24, coreAnchorCount * 0.12);
      if (phraseMatchCount > 0) score += Math.min(0.25, phraseMatchCount * 0.12);
      if (utilityLike) score -= 0.2;
      if (callbackNoise) score -= 0.5;
      if (profile.anchorTerms.length >= 3 && directAnchorCount === 0 && phraseMatchCount === 0) {
        score -= matchedFamilies.length > 0 ? 0.25 : 0.45;
      }

      fileCandidates.push({
        filePath,
        primary,
        chunks: sorted,
        score,
        layers,
        matchedFamilies,
        directAnchorCount,
        coreAnchorCount,
        phraseMatchCount,
        utilityLike,
        callbackNoise,
        genericOnly,
      });
    }

    return fileCandidates.sort((a, b) => b.score - a.score);
  }

  mergeBroadFileCandidates(
    primary: BroadFileCandidate[],
    secondary: BroadFileCandidate[]
  ): BroadFileCandidate[] {
    const byPath = new Map<string, BroadFileCandidate>();
    for (const candidate of [...primary, ...secondary]) {
      const existing = byPath.get(candidate.filePath);
      if (!existing || candidate.score > existing.score) {
        byPath.set(candidate.filePath, candidate);
      }
    }
    return Array.from(byPath.values()).sort((a, b) => b.score - a.score);
  }

  // -------------------------------------------------------------------------
  // Family file candidates
  // -------------------------------------------------------------------------

  buildBroadFamilyFileCandidates(
    profile: BroadQueryProfile,
    allowTests: boolean
  ): BroadFileCandidate[] {
    if (typeof this.metadata.resolveTargetAliases !== "function") return [];
    const aliases = Array.from(new Set(
      [
        ...profile.familyTerms.filter((term) =>
          (!term.family || profile.allowedFamilies.size === 0 || profile.allowedFamilies.has(term.family))
          && term.weight >= 0.68
          && (!profile.inventoryMode || !INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizeTargetText(term.term)))
        ),
        ...profile.anchorTerms.filter((term) => {
          if (term.family && profile.allowedFamilies.size > 0 && !profile.allowedFamilies.has(term.family)) {
            return false;
          }
          if (profile.inventoryMode && INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizeTargetText(term.term))) {
            return false;
          }
          if (term.generic) {
            return /^(mcp|auth|hook|http|stdio|daemon|cli)$/.test(term.term);
          }
          return profile.inventoryMode ? term.weight >= 0.86 : term.weight >= 0.72;
        }),
      ].map((term) => normalizeTargetText(term.term))
    ));
    if (aliases.length === 0) return [];

    const hitKinds: TargetKind[] = profile.inventoryMode
      ? ["file_module", "endpoint"]
      : ["file_module", "endpoint", "symbol"];
    const hits = this.metadata.resolveTargetAliases(aliases, 80, hitKinds);
    const byPath = new Map<string, BroadFileCandidate>();

    for (const hit of hits) {
      const filePath = hit.target.filePath;
      if (!allowTests && isTestFile(filePath)) continue;
      const candidate = this.buildBroadFileCandidateFromFilePath(filePath, profile);
      if (!candidate) continue;
      if (candidate.callbackNoise) continue;
      const boosted: BroadFileCandidate = {
        ...candidate,
        score: candidate.score + (hit.target.kind === "file_module" || hit.target.kind === "endpoint" ? 0.35 : 0.18),
      };
      const existing = byPath.get(filePath);
      if (!existing || boosted.score > existing.score) {
        byPath.set(filePath, boosted);
      }
    }

    return Array.from(byPath.values()).sort((a, b) => b.score - a.score);
  }

  // -------------------------------------------------------------------------
  // Dominant family
  // -------------------------------------------------------------------------

  chooseDominantBroadFamily(
    profile: BroadQueryProfile,
    fileCandidates: BroadFileCandidate[]
  ): string | null {
    if (profile.lifecycleMode) {
      const hasLifecycle = profile.anchorTerms.some((term) => term.family === "lifecycle")
        || profile.familyTerms.some((term) => term.family === "lifecycle")
        || fileCandidates.some((candidate) => candidate.matchedFamilies.includes("lifecycle"));
      if (hasLifecycle) return "lifecycle";
    }

    if (profile.allowedFamilies.size === 1) {
      return Array.from(profile.allowedFamilies)[0] ?? null;
    }

    const scores = new Map<string, number>();
    for (const term of profile.familyTerms) {
      if (!term.family) continue;
      scores.set(term.family, (scores.get(term.family) ?? 0) + term.weight);
    }
    for (const candidate of fileCandidates.slice(0, 12)) {
      for (const family of candidate.matchedFamilies) {
        scores.set(family, (scores.get(family) ?? 0) + candidate.score * 0.15);
      }
    }

    let bestFamily: string | null = null;
    let bestScore = -Infinity;
    for (const [family, score] of scores) {
      const backendSupport = fileCandidates
        .slice(0, 12)
        .filter((candidate) =>
          candidate.matchedFamilies.includes(family)
          && candidate.layers.includes("backend")
          && !candidate.utilityLike
          && !candidate.callbackNoise
        ).length;
      const adjustedScore =
        family === "logging" && scores.size > 1
          ? score * 0.72
          : score;
      const workflowAdjustedScore = profile.workflowTraceMode
        ? adjustedScore + backendSupport * 0.55
        : adjustedScore;
      if (workflowAdjustedScore > bestScore) {
        bestFamily = family;
        bestScore = workflowAdjustedScore;
      }
    }
    return bestFamily;
  }

  // -------------------------------------------------------------------------
  // Family alignment helpers
  // -------------------------------------------------------------------------

  isBroadCandidateFamilyAligned(
    profile: BroadQueryProfile,
    dominantFamily: string | null,
    candidate: BroadFileCandidate
  ): boolean {
    if (!dominantFamily) return candidate.coreAnchorCount > 0 || candidate.matchedFamilies.length > 0;
    if (candidate.filePath.includes(`/${dominantFamily}/`)) return true;
    if (candidate.matchedFamilies.includes(dominantFamily)) return true;
    if (
      profile.allowedFamilies.size > 1
      && candidate.matchedFamilies.some((family) => profile.allowedFamilies.has(family))
    ) {
      return true;
    }
    const aliases = this.getBroadFamilyAliases(profile, dominantFamily);
    if (aliases.length === 0) return false;
    const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
    return aliases.some((alias) => textMatchesQueryTerm(text, alias));
  }

  isStrictWorkflowFamilyCandidate(
    profile: BroadQueryProfile,
    dominantFamily: string,
    candidate: BroadFileCandidate
  ): boolean {
    const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
    const dominantAliases = this.getBroadFamilyAliases(profile, dominantFamily);
    const hasDominantAlias = dominantAliases.some((alias) => textMatchesQueryTerm(text, alias));
    const genericWorkflowSubsystem =
      /(?:^|\/)(flow|workflow|pipeline)(?:\/|$)/.test(candidate.filePath.toLowerCase())
      || /\b(workflow|pipeline)\b/.test(candidate.primary.result.name.toLowerCase());
    if (genericWorkflowSubsystem && !hasDominantAlias) {
      return false;
    }

    if (candidate.filePath.includes(`/${dominantFamily}/`)) return true;
    if (candidate.matchedFamilies.includes(dominantFamily)) {
      return candidate.directAnchorCount > 0
        || candidate.coreAnchorCount > 0
        || candidate.phraseMatchCount > 0
        || hasDominantAlias;
    }

    const adjacentFamilies = ADJACENT_WORKFLOW_FAMILIES[dominantFamily] ?? [];
    if (adjacentFamilies.some((family) => candidate.matchedFamilies.includes(family))) {
      if (dominantFamily === "auth") {
        const candidateText = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
        return candidate.layers.includes("routing")
          || candidate.layers.includes("state")
          || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)
          || /\b(route|router|routing|redirect|callback|guard|protected|destination|pending|navigation)\b/.test(candidateText);
      }
      if (dominantFamily === "routing") {
        return candidate.layers.includes("state")
          || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath);
      }
      return candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Confidence & deferral
  // -------------------------------------------------------------------------

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
      `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
    const hasStrongAnchor = (candidate: BroadFileCandidate, pattern: RegExp): boolean =>
      pattern.test(candidateText(candidate));

    if (dominantFamily === "generation") {
      const generationBackbone = alignedCandidates.filter((candidate) => {
        const text = candidate.filePath.toLowerCase();
        const hasGenPath = /\b(generate|generation|regener|render)\b/.test(text);
        return (candidate.layers.includes("backend") || candidate.layers.includes("state")) && hasGenPath;
      });
      if (generationBackbone.length < 2) return "missing_generation_backbone";
      const weakGenerationRatio = considered.filter((candidate) => {
        const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
        const hasStrongGenerationAnchor =
          /\b(generate|generation|regener|image|render|orchestrated)\b/.test(text);
        const sharedHelper = candidate.layers.every((layer) => layer === "shared" || layer === "core");
        const weakByName = !hasStrongGenerationAnchor && !sharedHelper;
        return weakByName || (sharedHelper && !hasStrongGenerationAnchor);
      }).length / considered.length;
      if (weakGenerationRatio > 0.3) return "weak_generation_bundle";
      if (mentionsGenerationDomain && mentionsFullTrace && mentionsUiBoundary) {
        const uiGeneration = alignedCandidates.filter((candidate) =>
          candidate.layers.includes("ui") && hasStrongAnchor(candidate, /\b(generate|generation|image|shot|render)\b/)
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
        Math.min(bundle.symbols.length, Math.max(bundle.maxChunks ?? 4, 6))
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
        bundle.symbols,
        Math.min(bundle.symbols.length, Math.max(bundle.maxChunks ?? 4, 6))
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

  buildBroadTargetAliasList(profile: BroadQueryProfile): string[] {
    const aliases = new Set<string>();
    const tokens = profile.tokens.filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
    const singleTokenAliases = profile.inventoryMode
      ? tokens.filter((term) =>
          !BROAD_PHRASE_GENERIC_TERMS.has(term)
          && !INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizeTargetText(term))
        )
      : tokens;

    for (const token of singleTokenAliases) aliases.add(normalizeTargetText(token));
    for (let i = 0; i < tokens.length; i++) {
      const bi = normalizeTargetText(tokens.slice(i, i + 2).join(" "));
      if (bi.split(" ").length === 2) aliases.add(bi);
      const tri = normalizeTargetText(tokens.slice(i, i + 3).join(" "));
      if (tri.split(" ").length === 3) aliases.add(tri);
    }

    const aliasTerms = profile.inventoryMode
      ? profile.anchorTerms
      : [...profile.anchorTerms, ...profile.familyTerms];
    for (const term of aliasTerms) {
      const normalizedTerm = normalizeTargetText(term.term);
      if (term.source === "semantic" && term.generic) continue;
      if (profile.inventoryMode && INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizedTerm)) continue;
      if (term.weight < 0.68) continue;
      aliases.add(normalizedTerm);
    }

    return Array.from(aliases).filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Target hit scoring
  // -------------------------------------------------------------------------

  scoreBroadTargetHit(
    hit: ResolvedTargetAliasHit,
    profile: BroadQueryProfile,
    allowTests: boolean
  ): BroadTargetCandidate | null {
    const target = hit.target;
    if (!allowTests && isTestFile(target.filePath)) return null;
    if (!target.ownerChunkId) return null;

    const chunk = this.metadata.getChunksByIds([target.ownerChunkId])[0];
    if (!chunk) return null;

    const text = normalizeTargetText(`${target.canonicalName} ${target.filePath} ${chunk.name}`);
    const lowerPath = target.filePath.toLowerCase();
    const lowerName = chunk.name.toLowerCase();
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const surfaceAlignment = scoreExecutionSurfaceAlignment(
      detectExecutionSurfaces(target.filePath, chunk.name, chunk.content),
      profile.surfaceBias
    );
    const directTerms = profile.anchorTerms.filter((term) => textMatchesQueryTerm(text, term.term));
    const semanticTerms = profile.familyTerms.filter((term) => textMatchesQueryTerm(text, term.term));
    const phraseMatches = profile.phrases.filter((phrase) => text.includes(phrase));
    const familyMatches = new Set(
      [...directTerms, ...semanticTerms]
        .map((term) => term.family)
        .filter((family): family is string => !!family)
    );

    const coreDirectTerms = directTerms.filter((term) => !term.generic);
    const hasDirectAnchor = directTerms.length > 0 || phraseMatches.length > 0;
    const utilityLike = this.isUtilityLikePath(lowerPath, lowerName);
    const callbackNoise = this.isCallbackNoiseTarget(lowerPath, lowerName, profile);
    const inventoryMentionsProtection = profile.inventoryMode
      && (profile.tokens.includes("protection") || profile.tokens.includes("protected") || profile.tokens.includes("guard"));
    const inventoryMentionsPending = profile.inventoryMode
      && (profile.tokens.includes("pending") || profile.tokens.includes("pendingnavigation"));
    const genericNavigationLeaf =
      /\b(skip|keyboard|navigation|drawer|menu|mobile|tab)\b/.test(text)
      && !/\b(protected|guard|redirect|callback|auth|pending|route|router)\b/.test(text);
    if (profile.inventoryMode && target.kind === "symbol" && coreDirectTerms.length === 0) return null;
    if (!hasDirectAnchor) {
      if (familyMatches.size === 0) return null;
      if (hit.source === "derived") return null;
      if (utilityLike || callbackNoise) return null;
      if (layers.every((layer) => layer === "shared" || layer === "core")) return null;
    }

    let score = hit.weight + target.confidence * 0.2;
    score += directTerms.reduce((sum, term) => sum + term.weight, 0) * 0.62;
    score += semanticTerms.reduce((sum, term) => sum + term.weight, 0) * 0.12;
    score += familyMatches.size * 0.12;
    score += phraseMatches.length * 0.5;

    if (target.kind === "file_module") score += 0.55;
    else if (target.kind === "endpoint") score += 0.65;
    else if (target.kind === "symbol") score += profile.inventoryMode ? -0.18 : /(class|function|method)/.test(chunk.kind) ? 0.18 : 0;
    else if (target.kind === "subsystem") score -= 0.12;

    if (hit.source === "slug" || hit.source === "file_path" || hit.source === "parent_dir") score += 0.18;
    if (hit.source === "derived") score -= 0.2;
    if (this.isImplementationPath(target.filePath)) score += 0.1;
    if (utilityLike) score -= hasDirectAnchor ? 0.08 : 0.35;
    if (callbackNoise) score -= 0.65;
    if ((inventoryMentionsProtection || inventoryMentionsPending) && genericNavigationLeaf) score -= 1.1;
    if (/constructor|describe|it|test/.test(chunk.name.toLowerCase())) score -= 0.4;
    if (directTerms.length >= 2) score += 0.28;
    if (familyMatches.size >= 2) score += 0.18;
    if (directTerms.length === 0 && semanticTerms.length <= 1 && familyMatches.size <= 1) score -= 0.32;
    score += surfaceAlignment * 0.45;

    return {
      result: this.chunkToSearchResult(chunk, score),
      score,
      subsystem: target.subsystem,
    };
  }

  // -------------------------------------------------------------------------
  // Workflow candidate scoring
  // -------------------------------------------------------------------------

  scoreBroadWorkflowCandidate(
    result: SearchResult,
    profile: BroadQueryProfile
  ): BroadWorkflowCandidate {
    let score = result.hookScore ?? result.score;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = `${lowerPath} ${lowerName}`;
    const contentText = result.content.toLowerCase().slice(0, 1600);
    const matchedTerms = profile.expandedTerms.filter((term) =>
      textMatchesQueryTerm(text, term.term)
      || (profile.inventoryMode && !term.generic && textMatchesQueryTerm(contentText, term.term))
    );
    const directMatches = profile.anchorTerms.filter((term) =>
      textMatchesQueryTerm(text, term.term)
      || (
        profile.inventoryMode
        && !term.generic
        && term.weight >= 0.82
        && textMatchesQueryTerm(contentText, term.term)
      )
    );
    const coreDirectMatches = directMatches.filter((term) => !term.generic);
    const phraseMatches = profile.phrases.filter((phrase) =>
      text.includes(phrase)
      || (profile.inventoryMode && phrase.split(" ").some((term) => !BROAD_PHRASE_GENERIC_TERMS.has(term)) && contentText.includes(phrase))
    );
    const matchedFamilies = Array.from(new Set(matchedTerms.map((term) => term.family).filter(Boolean))) as string[];
    const matchedWeight = matchedTerms.reduce((sum, term) => sum + term.weight, 0);
    const genericOnly = matchedTerms.length > 0 && matchedTerms.every((term) => term.generic);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const utilityLike = this.isUtilityLikePath(lowerPath, lowerName);
    const callbackNoise = this.isCallbackNoiseTarget(lowerPath, lowerName, profile);
    const orchestratorLike = this.isBroadOrchestratorLikePath(lowerPath, lowerName);
    const surfaceAlignment = scoreExecutionSurfaceAlignment(
      detectExecutionSurfaces(result.filePath, result.name, result.content),
      profile.surfaceBias
    );
    const queryNeedsOrchestrator =
      profile.workflowTraceMode
      || profile.tokens.includes("pipeline")
      || profile.tokens.includes("workflow")
      || profile.tokens.includes("full");

    if (matchedFamilies.length > 0) {
      score *= 1 + Math.min(0.45, matchedFamilies.length * 0.14);
    }
    if (matchedWeight > 1) {
      score *= 1 + Math.min(0.35, matchedWeight * 0.12);
    }
    if (directMatches.length > 0) {
      score *= 1 + Math.min(0.5, directMatches.length * 0.18);
    } else if (phraseMatches.length > 0) {
      score *= 1 + Math.min(0.4, phraseMatches.length * 0.18);
    } else if (matchedFamilies.length > 0) {
      score *= 0.72;
    } else {
      score *= 0.48;
    }
    if (profile.anchorTerms.length >= 3 && directMatches.length <= 1 && phraseMatches.length === 0) {
      score *= matchedFamilies.length > 0 ? 0.78 : 0.52;
    }
    if (profile.inventoryMode) {
      if (coreDirectMatches.length > 0) {
        score *= 1 + Math.min(0.4, coreDirectMatches.length * 0.16);
      } else if (matchedFamilies.length === 0) {
        score *= 0.4;
      } else {
        score *= 0.78;
      }
      if (result.filePath.startsWith("src/search/") || result.filePath.startsWith("src/indexer/")) {
        score *= 1.08;
      }
    }
    if (queryNeedsOrchestrator && orchestratorLike && (coreDirectMatches.length > 0 || matchedFamilies.length > 0 || profile.workflowTraceMode)) {
      score *= 1.16;
    }
    if (layers.some((layer) => layer === "ui" || layer === "state" || layer === "routing" || layer === "backend")) {
      score *= 1.08;
    }
    if (genericOnly) {
      score *= 0.62;
    }
    if (utilityLike && matchedFamilies.length === 0) {
      score *= 0.58;
    }
    if (callbackNoise) {
      score *= 0.32;
    }
    const userFacingLayer = layers.some((layer) => layer === "ui" || layer === "routing" || layer === "state");
    const pureOperationalSurface =
      !userFacingLayer
      && (/(?:^|\/)(mcp|mcp-server)\//.test(lowerPath) || /(?:^|\/)(cli|commands?)\//.test(lowerPath));
    if (
      profile.surfaceBias.defaultUserFacing
      && !profile.surfaceBias.explicitInfrastructure
      && !profile.surfaceBias.explicitBackend
    ) {
      if (pureOperationalSurface) {
        score *= coreDirectMatches.length > 0 || phraseMatches.length > 0 ? 0.24 : 0.12;
      } else if (userFacingLayer && (coreDirectMatches.length > 0 || phraseMatches.length > 0 || matchedFamilies.length > 0)) {
        score *= 1.14;
      }
    }
    if (
      profile.surfaceBias.explicitBackend
      && !profile.surfaceBias.explicitInfrastructure
      && !profile.surfaceBias.defaultUserFacing
    ) {
      const backendLayer = layers.includes("backend");
      const uiOnly = (layers.includes("ui") || layers.includes("state")) && !backendLayer;
      const backendPathAnchor =
        /(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lowerPath)
        || /\b(provider|credit|credits|request|response|endpoint|server)\b/.test(text);
      if (backendLayer && (coreDirectMatches.length > 0 || phraseMatches.length > 0 || matchedFamilies.length > 0 || profile.workflowTraceMode)) {
        score *= 1.18;
      }
      if (backendPathAnchor && (coreDirectMatches.length > 0 || phraseMatches.length > 0 || matchedFamilies.length > 0 || profile.workflowTraceMode)) {
        score *= 1.14;
      }
      if (uiOnly && coreDirectMatches.length <= 1 && phraseMatches.length === 0) {
        score *= 0.34;
      }
    }
    if (surfaceAlignment < 0) {
      score *= Math.max(0.08, 1 + surfaceAlignment * 0.3);
    } else if (surfaceAlignment > 0) {
      score *= 1 + Math.min(0.38, surfaceAlignment * 0.14);
    }

    return {
      result,
      score,
      layers,
      matchedFamilies,
      matchedWeight,
      genericOnly,
      utilityLike,
      directAnchorCount: directMatches.length,
      coreAnchorCount: coreDirectMatches.length,
      phraseMatchCount: phraseMatches.length,
      callbackNoise,
    };
  }

  // -------------------------------------------------------------------------
  // Query profile
  // -------------------------------------------------------------------------

  buildBroadQueryProfile(
    query: string,
    expandedTerms: ExpandedQueryTerm[] = expandQueryTerms(query)
  ): BroadQueryProfile {
    const queryMode = classifyIntent(query).queryMode;
    const surfaceBias = inferQueryExecutionSurfaceBias(query, queryMode);
    const explicitBackendWorkflow =
      surfaceBias.explicitBackend
      && (
        /\bend(?:\s+to\s+|\s*-\s*to\s*-?\s*)end\b/i.test(query)
        || /\bfrom\b[\s\S]{0,80}\bto\b/i.test(query)
        || /\b(provider|credit|credits|authentication|request|response|server|endpoint)\b/i.test(query)
      );
    const inventoryMode = BROAD_INVENTORY_RE.test(query) && !explicitBackendWorkflow;
    const lifecycleMode = /\b(shutdown|startup|drain|close|teardown|boot|bootstrap)\b/i.test(query);
    const workflowTraceMode =
      /\bend(?:\s+to\s+|\s*-\s*to\s*-?\s*)end\b/i.test(query)
      || /\bthrough\b/i.test(query)
      || /\bhandoff\b/i.test(query)
      || /\bfrom\b[\s\S]{0,80}\bto\b/i.test(query)
      || explicitBackendWorkflow;
    const shouldKeepTerm = (term: string): boolean =>
      (!inventoryMode || !INVENTORY_STRUCTURAL_TERMS.has(normalizeTargetText(term)))
      && !GENERIC_QUERY_ACTION_TERMS.has(normalizeTargetText(term));
    const filteredExpandedTerms = expandedTerms.filter((term) => shouldKeepTerm(term.term));
    const tokens = tokenizeQueryTerms(query)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
      .filter((term) => shouldKeepTerm(term));
    const anchorTerms = filteredExpandedTerms.filter((term) => {
      if (term.source !== "original" && term.source !== "morphological") return false;
      if (!term.generic) return true;
      return /^(mcp|auth|hook|http|api|rpc)$/.test(term.term);
    });
    const inferredFamilyScores = new Map<string, number>();
    for (const term of filteredExpandedTerms) {
      if (!term.family) continue;
      if (term.source === "corpus") continue;
      if (term.weight < 0.72) continue;
      inferredFamilyScores.set(term.family, (inferredFamilyScores.get(term.family) ?? 0) + term.weight);
    }
    let allowedFamilies = new Set(
      anchorTerms
        .map((term) => term.family)
        .filter((family): family is string => Boolean(family))
    );
    if (allowedFamilies.size === 0) {
      const rankedFamilies = Array.from(inferredFamilyScores.entries()).sort((a, b) => b[1] - a[1]);
      const topFamily = rankedFamilies[0]?.[0];
      if (topFamily) {
        allowedFamilies = new Set([topFamily]);
        if (inventoryMode || workflowTraceMode) {
          const topScore = rankedFamilies[0]?.[1] ?? 0;
          for (const [family, score] of rankedFamilies.slice(1)) {
            const adjacentFamilies = ADJACENT_WORKFLOW_FAMILIES[topFamily] ?? [];
            if (
              (adjacentFamilies.includes(family) || workflowTraceMode)
              && score >= Math.max(0.95, topScore * 0.55)
            ) {
              allowedFamilies.add(family);
            }
          }
        }
      }
    } else if (inventoryMode || workflowTraceMode) {
      for (const [family, score] of inferredFamilyScores) {
        if (allowedFamilies.has(family)) continue;
        const adjacentToAllowed = Array.from(allowedFamilies).some((allowed) =>
          (ADJACENT_WORKFLOW_FAMILIES[allowed] ?? []).includes(family)
        );
        if (!adjacentToAllowed && !workflowTraceMode) continue;
        const strongestAllowedScore = Array.from(allowedFamilies).reduce((max, allowed) => {
          const adjacentScore = inferredFamilyScores.get(allowed) ?? 0;
          return Math.max(max, adjacentScore);
        }, 0);
        if (score >= Math.max(0.95, strongestAllowedScore * 0.55)) {
          allowedFamilies.add(family);
        }
      }
    }
    if (workflowTraceMode && surfaceBias.explicitBackend) {
      const rankedFamilies = Array.from(inferredFamilyScores.entries()).sort((a, b) => b[1] - a[1]);
      const topScore = rankedFamilies[0]?.[1] ?? 0;
      for (const [family, score] of rankedFamilies) {
        if (allowedFamilies.has(family)) continue;
        if (score >= Math.max(0.9, topScore * 0.5)) {
          allowedFamilies.add(family);
        }
      }
      for (const family of ["auth", "billing", "generation", "storage"]) {
        if (inferredFamilyScores.has(family)) allowedFamilies.add(family);
      }
    }
    const familyTerms = filteredExpandedTerms.filter((term) => {
      if (term.source === "original" || term.source === "morphological") return false;
      if (term.generic) return false;
      if (term.weight < 0.68) return false;
      if (allowedFamilies.size > 0) {
        if (!term.family) return false;
        if (!allowedFamilies.has(term.family)) return false;
      }
      return true;
    });
    const phrases = this.buildBroadPhrases(tokens);

    return {
      expandedTerms: filteredExpandedTerms,
      anchorTerms,
      familyTerms,
      allowedFamilies,
      phrases,
      tokens,
      inventoryMode,
      lifecycleMode,
      workflowTraceMode,
      surfaceBias,
    };
  }

  // -------------------------------------------------------------------------
  // Suppression / phrases / callback noise
  // -------------------------------------------------------------------------

  shouldSuppressBroadResolvedTarget(query: string, seed: SeedResult["seeds"][number]): boolean {
    if (seed.reason !== "resolved_target") return false;
    if (!BROAD_INVENTORY_RE.test(query)) return false;
    const normalizedAlias = normalizeTargetText(seed.resolvedAlias ?? "");
    if (!INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizedAlias)) return false;
    const specificTerms = tokenizeQueryTerms(query)
      .map((term) => normalizeTargetText(term))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !INVENTORY_STRUCTURAL_TERMS.has(term)
        && !INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(term)
      );
    return specificTerms.length > 0;
  }

  buildBroadPhrases(tokens: string[]): string[] {
    const phrases = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      const pair = tokens.slice(i, i + 2);
      if (pair.length === 2 && pair.some((token) => !BROAD_PHRASE_GENERIC_TERMS.has(token))) {
        phrases.add(normalizeTargetText(pair.join(" ")));
      }
      const triple = tokens.slice(i, i + 3);
      if (triple.length === 3 && triple.some((token) => !BROAD_PHRASE_GENERIC_TERMS.has(token))) {
        phrases.add(normalizeTargetText(triple.join(" ")));
      }
    }
    return Array.from(phrases);
  }

  isCallbackNoiseTarget(
    lowerPath: string,
    lowerName: string,
    profile: BroadQueryProfile
  ): boolean {
    const text = `${lowerPath} ${lowerName}`;
    const mentionsCallback = profile.tokens.includes("callback");
    const mentionsNavigation = profile.tokens.includes("navigation") || profile.tokens.includes("route") || profile.tokens.includes("routing");
    const mentionsPerformance = profile.tokens.includes("performance");
    if (!mentionsCallback && /usecallback/.test(text)) return true;
    if (!mentionsPerformance && /\/performance\//.test(lowerPath)) return true;
    if (!mentionsNavigation && /\bnavigation\b/.test(text)) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Layer / path detection helpers
  // -------------------------------------------------------------------------

  detectWorkflowLayers(lowerPath: string, lowerName: string): string[] {
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

  isUtilityLikePath(lowerPath: string, lowerName: string): boolean {
    return /(?:^|\/)(lib|shared|core|utils?|helpers?|types?)\//.test(lowerPath)
      || /\b(utils?|helpers?|types?|errors?)\b/.test(lowerName);
  }

  isObservabilitySidecarPath(lowerPath: string, lowerName: string): boolean {
    const text = `${lowerPath} ${lowerName}`;
    return /\b(metrics?|logger|logging|telemetry|audit|trace|rotating\s*log)\b/.test(text)
      || /(?:^|\/)(metrics|logger|logging|telemetry)\.ts$/.test(lowerPath)
      || /rotating-log/.test(lowerPath);
  }

  isBroadOrchestratorLikePath(lowerPath: string, lowerName: string): boolean {
    const text = `${lowerPath} ${lowerName}`;
    return /\b(orchestr|pipeline|engine|manager|router|dispatcher|coordinator|hybrid|core)\b/.test(text)
      || /(?:^|\/)(index|main|entry)\.[a-z0-9]+$/i.test(lowerPath);
  }

  // -------------------------------------------------------------------------
  // Import neighbors
  // -------------------------------------------------------------------------

  collectBroadImportNeighbors(filePath: string): string[] {
    const neighbors = new Set<string>();
    if (typeof this.metadata.getImportsForFile === "function") {
      for (const record of this.metadata.getImportsForFile(filePath)) {
        if (record.resolvedPath) neighbors.add(record.resolvedPath);
      }
    }
    if (typeof this.metadata.findImporterFiles === "function") {
      for (const importer of this.metadata.findImporterFiles(filePath)) {
        neighbors.add(importer);
      }
    }
    neighbors.delete(filePath);
    return Array.from(neighbors);
  }

  // -------------------------------------------------------------------------
  // Build file candidate from path
  // -------------------------------------------------------------------------

  buildBroadFileCandidateFromFilePath(
    filePath: string,
    profile: BroadQueryProfile
  ): BroadFileCandidate | null {
    if (isTestFile(filePath)) return null;
    const chunks = this.metadata
      .findChunksByFilePath(filePath)
      .filter((chunk) => chunk.kind !== "file")
      .map((chunk) => this.scoreBroadWorkflowCandidate(this.chunkToSearchResult(chunk, 0.5), profile))
      .sort((a, b) => b.score - a.score);
    if (chunks.length === 0) return null;

    const primary = chunks[0];
    if (!primary) return null;
    const layers = Array.from(new Set(chunks.flatMap((candidate) => candidate.layers)));
    const matchedFamilies = Array.from(new Set(chunks.flatMap((candidate) => candidate.matchedFamilies)));
    const directAnchorCount = Math.max(...chunks.map((candidate) => candidate.directAnchorCount));
    const coreAnchorCount = Math.max(...chunks.map((candidate) => candidate.coreAnchorCount));
    const phraseMatchCount = Math.max(...chunks.map((candidate) => candidate.phraseMatchCount));
    const callbackNoise = chunks.every((candidate) => candidate.callbackNoise);
    const utilityLike = primary.utilityLike && matchedFamilies.length === 0;
    const genericOnly = chunks.every((candidate) => candidate.genericOnly);
    const corroboratingChunks = chunks.filter((candidate) =>
      candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0 || candidate.matchedFamilies.length > 0
    ).length;
    const layerCoverage = layers.filter((layer) => layer !== "shared" && layer !== "core").length;

    let score = primary.score;
    score += Math.min(0.45, (corroboratingChunks - 1) * 0.12);
    score += Math.min(0.35, layerCoverage * 0.1);
    score += Math.min(0.28, matchedFamilies.length * 0.08);
    if (directAnchorCount >= 2) score += 0.2;
    if (profile.inventoryMode && coreAnchorCount === 0 && matchedFamilies.length === 0) score -= 0.55;
    if (profile.inventoryMode && coreAnchorCount > 0) score += Math.min(0.24, coreAnchorCount * 0.12);
    if (phraseMatchCount > 0) score += Math.min(0.25, phraseMatchCount * 0.12);
    if (utilityLike) score -= 0.2;
    if (callbackNoise) score -= 0.5;

    return {
      filePath,
      primary,
      chunks,
      score,
      layers,
      matchedFamilies,
      directAnchorCount,
      coreAnchorCount,
      phraseMatchCount,
      utilityLike,
      callbackNoise,
      genericOnly,
    };
  }

  // -------------------------------------------------------------------------
  // Merge broad results
  // -------------------------------------------------------------------------

  mergeBroadResults(targetResults: SearchResult[], results: SearchResult[]): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const result of [...targetResults, ...results]) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) {
        byId.set(result.id, result);
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }

  // -------------------------------------------------------------------------
  // Private helpers (duplicated from HybridSearch for self-containment)
  // -------------------------------------------------------------------------

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

  private isImplementationPath(filePath: string): boolean {
    const lowerPath = filePath.toLowerCase();
    const implPaths = this.config.implementationPaths ?? ["src/", "lib/", "bin/"];
    if (implPaths.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()))) return true;
    return /(?:^|\/)(src|lib|bin|app|server|api|functions|handlers|controllers|services|supabase)\//.test(lowerPath);
  }

  private getMatchedConceptBundles(query: string): CompiledConceptBundle[] {
    return this.conceptBundles.filter((bundle) => bundle.pattern.test(query));
  }

  private selectConceptChunks(symbols: string[], maxChunks?: number): StoredChunk[] {
    const nameOrder = new Map(symbols.map((name, index) => [name, index]));
    const bestByName = new Map<string, StoredChunk>();

    for (const chunk of this.metadata.findChunksByNames(symbols)) {
      const existing = bestByName.get(chunk.name);
      if (!existing || this.compareConceptChunks(chunk, existing) < 0) {
        bestByName.set(chunk.name, chunk);
      }
    }

    const ordered = Array.from(bestByName.values()).sort((a, b) => {
      const orderDiff = (nameOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER)
        - (nameOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER);
      if (orderDiff !== 0) return orderDiff;
      return a.filePath.localeCompare(b.filePath);
    });
    return typeof maxChunks === "number" ? ordered.slice(0, maxChunks) : ordered;
  }

  private compareConceptChunks(a: StoredChunk, b: StoredChunk): number {
    const implDiff = Number(this.isImplementationPath(b.filePath))
      - Number(this.isImplementationPath(a.filePath));
    if (implDiff !== 0) return implDiff;

    const testDiff = Number(isTestFile(a.filePath))
      - Number(isTestFile(b.filePath));
    if (testDiff !== 0) return testDiff;

    return a.filePath.localeCompare(b.filePath);
  }
}
