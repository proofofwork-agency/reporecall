import type { ResolvedTargetAliasHit } from "../../storage/types.js";
import type { SearchResult } from "../types.js";
import type { SeedResult } from "../seed.js";
import { classifyIntent } from "../intent.js";
import { normalizeTargetText } from "../targets.js";
import { expandQueryTerms, GENERIC_QUERY_ACTION_TERMS, type ExpandedQueryTerm, inferQueryExecutionSurfaceBias, isTestFile, scoreExecutionSurfaceAlignment, detectExecutionSurfaces, STOP_WORDS, textMatchesQueryTerm, tokenizeQueryTerms } from "../utils.js";
import { INVENTORY_GENERIC_TARGET_ALIAS_TERMS, INVENTORY_STRUCTURAL_TERMS, ADJACENT_WORKFLOW_FAMILIES } from "../shared/workflow-families.js";
import { BROAD_PHRASE_GENERIC_TERMS, BROAD_INVENTORY_RE, type BroadWorkflowCandidate, type BroadTargetCandidate, type BroadQueryProfile } from "./model.js";
import { ArchitectureStrategyLayer1 } from "./layer-1.js";

export class ArchitectureStrategyLayer2 extends ArchitectureStrategyLayer1 {
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
    const layers = this.detectWorkflowLayers(target.filePath, chunk.name);
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
    const layers = this.detectWorkflowLayers(result.filePath, result.name);
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
}
