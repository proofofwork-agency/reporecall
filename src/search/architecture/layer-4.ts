import type { TargetKind } from "../../storage/types.js";
import { normalizeTargetText } from "../targets.js";
import { isTestFile, textMatchesQueryTerm } from "../utils.js";
import { INVENTORY_GENERIC_TARGET_ALIAS_TERMS, ADJACENT_WORKFLOW_FAMILIES } from "../shared/workflow-families.js";
import { SUBSYSTEM_INVENTORY_FAMILIES, type BroadWorkflowCandidate, type BroadFileCandidate, type BroadQueryProfile, type InventoryFileCandidate } from "./model.js";
import { ArchitectureStrategyLayer3 } from "./layer-3.js";

export abstract class ArchitectureStrategyLayer4 extends ArchitectureStrategyLayer3 {
  abstract selectBroadBackboneCandidates(
    dominantFamily: string,
    profile: BroadQueryProfile,
    candidates: BroadFileCandidate[]
  ): BroadFileCandidate[];
  abstract focusBroadCandidateOnContent(
    candidate: BroadFileCandidate,
    pattern: RegExp,
    maxChars?: number
  ): BroadFileCandidate;

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

    if (dominantFamily === "routing" && queryMentionsPending) {
      const pendingCandidates = ranked
        .filter((candidate) => {
          if (!candidate.layers.some((layer) => layer === "ui" || layer === "routing")) return false;
          const content = candidate.chunks
            .map((chunk) => chunk.result.content)
            .join("\n")
            .toLowerCase();
          return /\bpending\s*navigation\b|\bpendingnavigation\b/.test(content);
        })
        .sort((a, b) => {
          const aText = normalizeTargetText(`${a.filePath} ${a.primary.result.name}`);
          const bText = normalizeTargetText(`${b.filePath} ${b.primary.result.name}`);
          const aCallback = /\bcallback\b/.test(aText) ? 1 : 0;
          const bCallback = /\bcallback\b/.test(bText) ? 1 : 0;
          if (aCallback !== bCallback) return bCallback - aCallback;
          const aPage = /(?:^|\/)(?:pages|screens|views)\//.test(a.filePath) ? 1 : 0;
          const bPage = /(?:^|\/)(?:pages|screens|views)\//.test(b.filePath) ? 1 : 0;
          if (aPage !== bPage) return bPage - aPage;
          const countPendingMentions = (candidate: InventoryFileCandidate): number => {
            const content = candidate.chunks
              .map((chunk) => chunk.result.content)
              .join("\n")
              .toLowerCase();
            return content.match(/\bpending\s*navigation\b|\bpendingnavigation\b/g)?.length ?? 0;
          };
          const aMentions = countPendingMentions(a);
          const bMentions = countPendingMentions(b);
          if (aMentions !== bMentions) return bMentions - aMentions;
          if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
          return b.score - a.score;
        });
      const protectedCandidate = ranked
        .filter((candidate) =>
          /\b(?:protected|guard|route\s*protection)\b/.test(
            normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`)
          )
        )
        .sort((a, b) => {
          const aText = normalizeTargetText(`${a.filePath} ${a.primary.result.name}`);
          const bText = normalizeTargetText(`${b.filePath} ${b.primary.result.name}`);
          const aExact = /\b(?:protected|route\s*protection)\b/.test(aText) ? 1 : 0;
          const bExact = /\b(?:protected|route\s*protection)\b/.test(bText) ? 1 : 0;
          if (aExact !== bExact) return bExact - aExact;
          const aRouting = a.layers.includes("routing") ? 1 : 0;
          const bRouting = b.layers.includes("routing") ? 1 : 0;
          if (aRouting !== bRouting) return bRouting - aRouting;
          return b.score - a.score;
        })[0];
      trySelect(protectedCandidate);
      for (const candidate of pendingCandidates.slice(0, 3)) {
        const focused = this.focusBroadCandidateOnContent(
          candidate,
          /\bpending\s*navigation\b|\bpendingnavigation\b/i
        );
        trySelect({
          ...candidate,
          primary: focused.primary,
          chunks: focused.chunks,
        });
      }
    }

    if (dominantFamily) {
      const backboneFiles = this.selectBroadBackboneCandidates(
        dominantFamily,
        profile,
        candidates
      );
      for (const backbone of backboneFiles) {
        const candidate = candidates.find((item) => item.filePath === backbone.filePath);
        trySelect(candidate
          ? {
              ...candidate,
              primary: backbone.primary,
              chunks: backbone.chunks,
            }
          : undefined);
        if (selected.length >= limit) return selected;
      }
    }

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

  buildBroadBackboneFileCandidates(
    dominantFamily: string,
    profile: BroadQueryProfile,
    allowTests: boolean
  ): BroadFileCandidate[] {
    const roleAliases: Record<string, string[]> = {
      generation: [
        "generation",
        "image generation",
        "image generator",
        "generate image",
        "text to image",
        "text to image node",
        "text to image handler",
        "generation handler",
        "render",
      ],
      storage: [
        "upload media",
        "upload media node",
        "upload handler",
        "storage limit",
        "storage utils",
        "bucket",
        "object store",
      ],
      auth: [
        "auth",
        "login",
        "auth callback",
        "auth modal",
        "auth state",
        "use auth",
        "protected route",
        "session",
        "app",
      ],
      routing: [
        "protected route",
        "route guard",
        "auth callback",
        "use auth",
        "redirect",
        "pending navigation",
        "router",
        "app",
      ],
      billing: [
        "billing",
        "billing page",
        "checkout",
        "stripe checkout",
        "customer portal",
        "stripe portal",
        "stripe service",
        "subscription",
        "payment service",
      ],
    };
    const namePrefixes: Record<string, string[]> = {
      generation: ["generate", "regenerate", "render", "imageGeneration", "textToImage"],
      storage: ["upload", "storage", "checkStorage", "writeObject", "putObject"],
      auth: ["auth", "login", "signIn", "useAuth", "session", "protected"],
      routing: ["route", "router", "redirect", "protected", "guard", "navigate"],
      billing: ["billing", "checkout", "portal", "subscription", "payment", "stripe"],
    };
    const aliases = roleAliases[dominantFamily] ?? [];
    const prefixes = namePrefixes[dominantFamily] ?? [];
    if (aliases.length === 0 && prefixes.length === 0) return [];

    const paths = new Map<string, number>();
    if (typeof this.metadata.resolveTargetAliases === "function" && aliases.length > 0) {
      const hits = this.metadata.resolveTargetAliases(
        aliases.map((alias) => normalizeTargetText(alias)),
        120,
        ["file_module", "endpoint", "symbol"]
      );
      for (const hit of hits) {
        paths.set(hit.target.filePath, Math.max(paths.get(hit.target.filePath) ?? 0, 0.38));
      }
    }
    if (typeof this.metadata.findChunksByNamePrefixes === "function" && prefixes.length > 0) {
      for (const chunk of this.metadata.findChunksByNamePrefixes(prefixes, 120)) {
        paths.set(chunk.filePath, Math.max(paths.get(chunk.filePath) ?? 0, 0.3));
      }
    }

    const candidates: BroadFileCandidate[] = [];
    for (const [filePath, boost] of paths) {
      if (!allowTests && isTestFile(filePath)) continue;
      const candidate = this.buildBroadFileCandidateFromFilePath(filePath, profile);
      if (!candidate || candidate.callbackNoise) continue;
      const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
      if (
        !aliases.some((alias) => textMatchesQueryTerm(text, alias))
        && !this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
      ) {
        continue;
      }
      candidates.push({ ...candidate, score: candidate.score + boost });
    }
    return candidates.sort((a, b) => b.score - a.score);
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

    // Broad trace queries often mention several adjacent concerns (for example,
    // request auth while describing an upload). Keep the explicitly named
    // workload as the dominant family instead of letting generic transition
    // terms such as "flow" or a boundary concern win by aggregate expansion.
    const queryText = profile.tokens.join(" ");
    const explicitDomainFamilies: Array<[string, RegExp]> = [
      ["billing", /\b(?:billing|checkout|portal|subscription|invoice|payment|credit)\b/],
      ["generation", /\b(?:generate|generation|regenerate|regeneration|render|image generation)\b/],
      ["storage", /\b(?:upload|storage|bucket|object store|media write)\b/],
      ["auth", /\b(?:auth|authentication|login|signin|signup|session|oauth)\b/],
      ["routing", /\b(?:routing|router|route protection|protected route|redirect|navigation)\b/],
    ];
    for (const [family, pattern] of explicitDomainFamilies) {
      if (pattern.test(queryText)) return family;
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
    const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
    return aliases.some((alias) => textMatchesQueryTerm(text, alias));
  }

  isStrictWorkflowFamilyCandidate(
    profile: BroadQueryProfile,
    dominantFamily: string,
    candidate: BroadFileCandidate
  ): boolean {
    const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
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
}
