import type { TargetKind } from "../../storage/types.js";
import type { SearchResult } from "../types.js";
import { normalizeTargetText } from "../targets.js";
import { isTestFile, textMatchesQueryTerm } from "../utils.js";
import { type BroadWorkflowCandidate, type BroadFileCandidate, type BroadQueryProfile, type InventoryFileCandidate } from "./model.js";
import { ArchitectureStrategyLayer4 } from "./layer-4.js";

export class ArchitectureStrategyLayer5 extends ArchitectureStrategyLayer4 {
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

  /**
   * Select one strong file for each generic workflow role before score-only
   * filling. This prevents a high-scoring adjacent concern (auth in an upload
   * query, logging in an auth query) from consuming the whole context budget.
   */
  selectBroadBackboneCandidates(
    dominantFamily: string,
    profile: BroadQueryProfile,
    candidates: BroadFileCandidate[]
  ): BroadFileCandidate[] {
    type Role = {
      pattern: RegExp;
      layers?: string[];
      excludeLayers?: string[];
      pathPattern?: RegExp;
    };
    const rolesByFamily: Record<string, Role[]> = {
      generation: [
        {
          pattern: /\b(?:store|state).*(?:image|generate|generation|render)|(?:image|generate|generation|render).*(?:store|state)\b/,
          layers: ["state"],
        },
        {
          pattern: /\b(?:hook|use).*(?:image|generate|generation|render)|(?:image|generate|generation|render).*(?:hook|use)\b/,
          layers: ["state"],
        },
        {
          pattern: /\b(?:image|generate|generation|render|storyboard).*(?:controller)|(?:controller).*(?:image|generate|generation|render|storyboard)\b/,
          pathPattern: /controller/i,
        },
        {
          pattern: /\b(?:text\s*to\s*image|image\s*gen(?:eration)?|generate|generation|render).*(?:handler|service|orchestr)|(?:handler|service|orchestr).*(?:text\s*to\s*image|image\s*gen(?:eration)?|generate|generation|render)\b/,
        },
        {
          pattern: /\b(?:generate|generation|render|image)\b/,
          layers: ["backend"],
        },
        {
          pattern: /\b(?:text\s*to\s*image|image\s*gen(?:eration)?|generate|generation|render)\b/,
          layers: ["ui"],
        },
      ],
      storage: [
        { pattern: /\b(?:upload|ingest)\b/, layers: ["backend"] },
        { pattern: /\b(?:storage\s*(?:limit|utils?)|check\s*storage|bucket)\b/ },
        { pattern: /\b(?:write|put).*(?:object|blob|media)|(?:object|blob|media).*(?:write|put)\b/ },
        { pattern: /\b(?:upload|media).*(?:handler|service|store|node)|(?:handler|service|store|node).*(?:upload|media)\b/ },
      ],
      auth: [
        {
          pattern: /\b(?:auth|login|signin|signup)\b/,
          layers: ["ui"],
          excludeLayers: ["backend"],
          pathPattern: /(?:^|\/)(?:pages|screens|views)\/(?:Auth|Login|SignIn|SignUp)\.[jt]sx?$/i,
        },
        { pattern: /\bcallback\b/, pathPattern: /callback/i },
        { pattern: /\b(?:use\s*auth|auth\s*(?:store|state))\b/, layers: ["state"] },
        { pattern: /\b(?:auth|login|signin|signup).*(?:modal|dialog)|(?:modal|dialog).*(?:auth|login|signin|signup)\b/, layers: ["ui"] },
        {
          pattern: /\b(?:app|root|main|layout)\b/,
          pathPattern: /(?:^|\/)(?:App|_app|Root|Main|Layout)\.[jt]sx?$/i,
        },
        { pattern: /\bredirect\b/, pathPattern: /redirect/i },
      ],
      routing: [
        { pattern: /\b(?:protected|guard|route\s*protection)\b/ },
        { pattern: /\bcallback\b/, pathPattern: /callback/i },
        { pattern: /\b(?:redirect|pending\s*navigation|destination)\b/ },
        { pattern: /\b(?:use\s*auth|auth\s*(?:store|state))\b/, layers: ["state"] },
        {
          pattern: /\b(?:app|root|main|layout)\b/,
          pathPattern: /(?:^|\/)(?:App|_app|Root|Main|Layout)\.[jt]sx?$/i,
        },
      ],
      billing: [
        {
          pattern: /\b(?:stripe|payment).*(?:service)|(?:service).*(?:stripe|payment)\b/,
          pathPattern: /(?:^|\/)services?\//i,
        },
        { pattern: /\bcheckout\b/, layers: ["backend"], pathPattern: /checkout/i },
        { pattern: /\bportal\b/, layers: ["backend"], pathPattern: /portal/i },
        {
          pattern: /\bbilling\s*controller\b/,
          layers: ["backend"],
          pathPattern: /(?:^|\/)functions\/billing-controller\//i,
        },
        {
          pattern: /\b(?:billing|stripe|payment).*(?:controller)|(?:controller).*(?:billing|stripe|payment)\b/,
          pathPattern: /(?:^|\/)controllers?\//i,
        },
        {
          pattern: /\bbilling\s*service\b/,
          pathPattern: /(?:^|\/)services?\//i,
        },
        {
          pattern: /\b(?:billing|pricing|subscription)\b/,
          layers: ["ui"],
          pathPattern: /(?:^|\/)(?:pages|screens|views)\/(?:Billing|Pricing|Subscription)\.[jt]sx?$/i,
        },
        { pattern: /\b(?:upgrade|plan).*(?:option|selector)|(?:option|selector).*(?:upgrade|plan)\b/, layers: ["ui"] },
      ],
    };
    const roles = rolesByFamily[dominantFamily];
    if (!roles) return [];

    const ranked = [...candidates].sort((a, b) => {
      const answerFirstA = this.computeBroadWorkflowAnswerFirstPriority(a, profile, dominantFamily);
      const answerFirstB = this.computeBroadWorkflowAnswerFirstPriority(b, profile, dominantFamily);
      if (answerFirstA !== answerFirstB) return answerFirstB - answerFirstA;
      return b.score - a.score;
    });
    const selected: BroadFileCandidate[] = [];
    const seen = new Set<string>();

    for (const role of roles) {
      const match = ranked.find((candidate) => {
        if (seen.has(candidate.filePath) || candidate.callbackNoise) return false;
        if (role.layers && !role.layers.some((layer) => candidate.layers.includes(layer))) return false;
        if (role.excludeLayers?.some((layer) => candidate.layers.includes(layer))) return false;
        if (role.pathPattern && !role.pathPattern.test(candidate.filePath)) return false;
        const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
        if (!role.pattern.test(text)) return false;
        return this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
          || !!role.pathPattern;
      });
      if (!match) continue;
      const roleChunks = match.chunks
        .filter((chunk) =>
          role.pattern.test(normalizeTargetText(chunk.result.name))
        )
        .sort((a, b) => {
          if (a.directAnchorCount !== b.directAnchorCount) {
            return b.directAnchorCount - a.directAnchorCount;
          }
          if (a.phraseMatchCount !== b.phraseMatchCount) {
            return b.phraseMatchCount - a.phraseMatchCount;
          }
          return a.result.content.length - b.result.content.length;
        });
      const rolePrimary = roleChunks[0];
      const roleCandidate = rolePrimary
        ? {
            ...match,
            primary: rolePrimary,
            chunks: [
              rolePrimary,
              ...match.chunks.filter((chunk) => chunk.result.id !== rolePrimary.result.id),
            ],
          }
        : role.pathPattern
          ? this.focusBroadCandidateOnContent(match, role.pattern)
          : match;
      selected.push(
        roleCandidate.primary.result.content.length > 1_800
          ? this.focusBroadCandidateOnContent(roleCandidate, role.pattern)
          : roleCandidate
      );
      seen.add(match.filePath);
    }

    return selected;
  }

  focusBroadCandidateOnContent(
    candidate: BroadFileCandidate,
    pattern: RegExp,
    maxChars = 1_800
  ): BroadFileCandidate {
    const matchingChunk = candidate.chunks.find((chunk) =>
      pattern.test(normalizeTargetText(chunk.result.content))
    ) ?? candidate.primary;
    const content = matchingChunk.result.content;
    if (content.length <= maxChars) return candidate;

    const normalized = normalizeTargetText(content);
    const normalizedMatch = normalized.match(pattern);
    const rawNeedle = normalizedMatch?.[0]?.split(/\s+/)[0] ?? "";
    const rawMatchIndex = rawNeedle
      ? content.toLowerCase().indexOf(rawNeedle.toLowerCase())
      : -1;
    const center = rawMatchIndex >= 0 ? rawMatchIndex : 0;
    const start = Math.max(0, center - Math.floor(maxChars * 0.3));
    const end = Math.min(content.length, start + maxChars);
    const prefix = content.slice(0, start);
    const excerpt = content.slice(start, end);
    const startLine = matchingChunk.result.startLine + (prefix.match(/\n/g)?.length ?? 0);
    const endLine = startLine + (excerpt.match(/\n/g)?.length ?? 0);
    const focusedPrimary: BroadWorkflowCandidate = {
      ...matchingChunk,
      result: {
        ...matchingChunk.result,
        content: excerpt,
        startLine,
        endLine,
      },
    };
    return {
      ...candidate,
      primary: focusedPrimary,
      chunks: [
        focusedPrimary,
        ...candidate.chunks.filter((chunk) => chunk.result.id !== matchingChunk.result.id),
      ],
    };
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
    const inventoryBackbones = dominantFamily
      ? this.selectBroadBackboneCandidates(dominantFamily, profile, inventoryCandidates)
      : [];
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

    if (deferredReason) return [];
    const selectedEvidenceBackbones = selectedFiles.filter((candidate) => {
      const content = candidate.chunks
        .map((chunk) => chunk.result.content)
        .join("\n")
        .toLowerCase();
      return /\bpending\s*navigation\b|\bpendingnavigation\b/.test(content);
    });
    const orderedBackboneFiles = [
      ...inventoryBackbones,
      ...selectedEvidenceBackbones,
    ].filter((candidate, index, all) =>
      all.findIndex((item) => item.filePath === candidate.filePath) === index
    );
    const backboneOrder = new Map(
      orderedBackboneFiles.map((candidate, index) => [candidate.filePath, index])
    );
    const topSelectedScore = Math.max(
      0,
      ...selectedChunks.map((candidate) => Math.max(candidate.result.score, candidate.score))
    );
    return selectedChunks.map((candidate) => {
      const backboneIndex = backboneOrder.get(candidate.result.filePath);
      const backboneScore = backboneIndex === undefined
        ? 0
        : topSelectedScore * Math.max(0.62, 0.92 - backboneIndex * 0.08);
      const selectedScore = Math.max(candidate.result.score, candidate.score, backboneScore);
      return {
        ...candidate.result,
        hookScore: selectedScore,
        score: selectedScore,
      };
    });
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
      boost: number = 0,
      preferredBase?: BroadFileCandidate
    ) => {
      if (!allowTests && isTestFile(filePath)) return;
      const base = preferredBase
        ?? baseCandidates.find((candidate) => candidate.filePath === filePath)
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
            textMatchesQueryTerm(
              normalizeTargetText(`${next.filePath} ${next.primary.result.name}`),
              alias
            )
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
      if (
        source === "typed_target"
        && dominantFamily
        && !dominantAliasMatch
        && !base.matchedFamilies.includes(dominantFamily)
      ) {
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
      upsert(candidate.filePath, "typed_target", "file_module", 0.18, candidate);
    }
    if (dominantFamily) {
      for (const candidate of this.buildBroadBackboneFileCandidates(
        dominantFamily,
        profile,
        allowTests
      )) {
        upsert(candidate.filePath, "typed_target", "file_module", 0.34, candidate);
      }
    }
    const focusedInventoryTerms = new Set<string>();
    if (profile.tokens.includes("pending") && profile.tokens.includes("navigation")) {
      focusedInventoryTerms.add("pending navigation");
    }
    if (
      profile.tokens.includes("protection")
      || profile.tokens.includes("protected")
      || profile.tokens.includes("guard")
    ) {
      focusedInventoryTerms.add("route protection");
      focusedInventoryTerms.add("protected route");
    }
    for (const term of focusedInventoryTerms) {
      const hits = this.fts.search(term, 40);
      for (const chunk of this.metadata.getChunksByIds(hits.map((hit) => hit.id))) {
        const focusedBase = this.buildBroadFileCandidateFromFilePath(chunk.filePath, profile);
        upsert(chunk.filePath, "chunk", undefined, 0.42, focusedBase ?? undefined);
      }
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
}
