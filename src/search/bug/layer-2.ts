import type { ChunkFeature } from "../../storage/types.js";
import { expandQueryTerms, GENERIC_QUERY_ACTION_TERMS, textMatchesQueryTerm, type ExpandedQueryTerm } from "../utils.js";
import { normalizeTargetText } from "../targets.js";
import { ADJACENT_WORKFLOW_FAMILIES, TRACE_NOISE_TERMS } from "../shared/workflow-families.js";
import { BUG_UI_LEAF_TERMS, BUG_NOISE_TERMS, BUG_LOW_SPECIFICITY_TERMS, BUG_MECHANISM_ONLY_TERMS, BUG_AUTH_ROUTING_OFFDOMAIN_RE, BUG_CONNECTION_OFFDOMAIN_RE, BUG_SUBJECT_TAG_RULES, MODE_EXPLICIT_LOGGING_RE, MODE_EXPLICIT_WEBHOOK_RE, type BugSubjectProfile, type BugCandidateSignals } from "./model.js";
import { BugStrategyLayer1 } from "./layer-1.js";

export class BugStrategyLayer2 extends BugStrategyLayer1 {
  isBugGateLike(
    result: { filePath: string; name: string; content: string },
    feature?: {
      isPredicate?: boolean;
      isValidator?: boolean;
      isGuard?: boolean;
      returnsBoolean?: boolean;
      callsPredicateCount?: number;
      branchCount?: number;
      guardCount?: number;
      isController?: boolean;
      isRegistry?: boolean;
      isUiComponent?: boolean;
    }
  ): boolean {
    const text = `${result.filePath} ${result.name} ${result.content.slice(0, 1200)}`;
    return !!feature?.isPredicate
      || !!feature?.isValidator
      || !!feature?.isGuard
      || !!feature?.returnsBoolean
      || !!feature?.isController
      || /(?:validate|check|assert|verify|guard|predicate|compat|schema|reject|allow|controller|service|handler|orchestr)/i.test(text);
  }

  isBugOrchestratorCandidate(
    result: { filePath: string; name: string; content: string },
    feature?: {
      isController?: boolean;
      callsPredicateCount?: number;
      branchCount?: number;
      writesState?: boolean;
      writesNetwork?: boolean;
      writesStorage?: boolean;
    }
  ): boolean {
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    return !!feature?.isController
      || ((feature?.callsPredicateCount ?? 0) > 0 && (feature?.branchCount ?? 0) > 0)
      || (!!(feature?.writesState || feature?.writesNetwork || feature?.writesStorage) && /(controller|service|handler|provider|manager|workflow|pipeline|orchestr)/.test(text));
  }

  isBugLeafUiLike(result: { filePath: string; name: string }): boolean {
    const normalized = normalizeTargetText(`${result.filePath} ${result.name}`);
    return normalized.split(/\s+/).some((token) => BUG_UI_LEAF_TERMS.has(token));
  }

  getBugCandidateFamilies(result: { filePath: string; name: string }): Set<string> {
    const text = `${result.filePath} ${result.name}`;
    return new Set(
      BUG_SUBJECT_TAG_RULES
        .filter((rule) => rule.pattern.test(text))
        .map((rule) => rule.tag)
    );
  }

  isBugGenericNavigationLeaf(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals,
    profile: BugSubjectProfile
  ): boolean {
    if (!(profile.primaryTags.has("routing") || profile.relatedTags.has("routing"))) return false;
    if (this.isBugRedirectBackboneCandidate(result, signals)) return false;
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    const isNavigationNamed =
      /\bnavigation\b/.test(text)
      || /\b(drawer|menu|tab|segment|keyboard|mobile|floating|skip)\b/.test(text);
    if (!isNavigationNamed) return false;
    const hasStrongRedirectAnchor =
      /\b(protected|guard|redirect|callback|auth|route|router|destination|pending)\b/.test(text)
      || signals.rawLiteralMatches > 1
      || signals.pathNameTermMatches > 1;
    return !hasStrongRedirectAnchor;
  }

  isBugRedirectHandoffPrompt(profile: BugSubjectProfile): boolean {
    if (!(profile.primaryTags.has("auth") || profile.primaryTags.has("routing") || profile.relatedTags.has("routing"))) {
      return false;
    }
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
      ...profile.decomposition.semanticVariants,
    ]);
    return [
      "redirect", "callback", "protected", "guard", "pending",
      "destination", "handoff", "route", "router", "navigation",
      "session", "signin", "auth",
    ].some((term) => focus.has(term));
  }

  isBugAuthRoutingPrompt(profile: BugSubjectProfile): boolean {
    return profile.primaryTags.has("auth")
      || profile.primaryTags.has("routing")
      || profile.relatedTags.has("auth")
      || profile.relatedTags.has("routing");
  }

  isBugFrontendAuthRoutingHandoffPrompt(profile: BugSubjectProfile): boolean {
    if (!this.isBugAuthRoutingPrompt(profile)) return false;
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
    ]);
    const hasHandoffIntent = [
      "redirect", "callback", "protected", "pending", "destination",
      "handoff", "navigation", "route", "router", "return", "logged", "page",
    ].some((term) => focus.has(term));
    const backendIntent = [
      "request", "response", "api", "server", "endpoint", "bearer",
      "token", "header", "upload", "storage", "media", "webhook",
      "billing", "credit", "queue", "worker",
    ].some((term) => focus.has(term));
    return hasHandoffIntent && !backendIntent;
  }

  isBugBackendRequestPrompt(profile: BugSubjectProfile): boolean {
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
    ]);
    const backendRequestIntent = [
      "request", "response", "api", "server", "endpoint", "bearer",
      "token", "header", "upload", "storage", "media", "webhook",
      "bucket", "blob",
    ].some((term) => focus.has(term));
    return backendRequestIntent && !this.isBugFrontendAuthRoutingHandoffPrompt(profile);
  }

  isBugRedirectNoiseCandidate(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals,
    profile: BugSubjectProfile
  ): boolean {
    if (!this.isBugRedirectHandoffPrompt(profile)) return false;
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    const hasRedirectBackbone =
      /\b(protected|guard|redirect|callback|auth|route|router|destination|pending|session)\b/.test(text)
      || signals.pathNameTermMatches > 1;
    if (/\b(signout|logout)\b/.test(text) && !hasRedirectBackbone) return true;
    if (
      /\b(navigation|drawer|menu|segment|mobile|keyboard|floating|tab|skip)\b/.test(text)
      && !hasRedirectBackbone
      && signals.rawLiteralMatches <= 1
    ) {
      return true;
    }
    return false;
  }

  isBugOffDomainBackendCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugRedirectHandoffPrompt(profile) && !this.isBugAuthRoutingPrompt(profile)) return false;
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const backendLike =
      /(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(result.filePath.toLowerCase())
      || /\b(controller|handler|service|endpoint)\b/.test(text);
    if (!backendLike) return false;
    const authRoutingAnchored =
      /\b(auth|login|signin|signout|authenticate|authenticated|session|token|oauth|callback|redirect|protected|guard|route|router|navigation|pending|destination|handoff|return)\b/.test(text)
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
    return !authRoutingAnchored;
  }

  isBugFrontendHandoffNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const handoffAnchored =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals);
    const authRoutingAnchored =
      handoffAnchored
      || (
        /\b(auth|login|signin|signout|authenticate|authenticated|session)\b/.test(text)
        && /\b(callback|redirect|protected|guard|route|router|pending|destination|return)\b/.test(text)
      )
      || (signals.pathNameTermMatches > 0 && signals.primaryTagMatches > 0);
    const genericCallbackUtility =
      /\bcallback\b/.test(text)
      && (layers.includes("shared") || layers.includes("core"))
      && !/\b(auth|login|signin|session|redirect|protected|guard|route|router|destination|pending|return)\b/.test(text);
    if (genericCallbackUtility) return true;
    if (layers.includes("backend") && !layers.includes("routing") && !handoffAnchored) return true;
    if (layers.includes("ui") && !layers.includes("routing") && !authRoutingAnchored) return true;
    return false;
  }

  isBugMigrationNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    const lowerPath = result.filePath.toLowerCase();
    if (!/(?:^|\/)(migrations?|schema)\//.test(lowerPath) && !/\.sql$/i.test(lowerPath)) return false;
    const schemaPrompt =
      profile.subjectTerms.some((term) => ["migration", "migrations", "schema", "sql", "table", "column", "database", "db"].includes(term))
      || profile.primaryTags.has("storage")
      || profile.primaryTags.has("billing")
      || profile.primaryTags.has("schema");
    return !schemaPrompt && signals.pathNameTermMatches <= 1 && signals.rawLiteralMatches <= 1;
  }

  isBugRedirectBackboneCandidate(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    if (/\b(protected|guard|redirect|callback|auth|route|router|destination|pending|return|session|signin|login|navigation|app)\b/.test(text)) {
      return true;
    }
    return signals.pathNameTermMatches > 1;
  }

  hasBugHandoffSpecificAnchor(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    return /\b(callback|redirect|protected|guard|pending|destination|route|router|return)\b/.test(text)
      || signals.pathNameTermMatches > 1;
  }

  getBugSpecificSubjectTerms(profile: BugSubjectProfile): string[] {
    return profile.subjectTerms.filter((term) =>
      term.length >= 4
      && !BUG_NOISE_TERMS.has(term)
      && !BUG_LOW_SPECIFICITY_TERMS.has(term)
      && !BUG_MECHANISM_ONLY_TERMS.has(term)
      && !this.isBugStructuralHintTerm(term)
    );
  }

  hasBugSpecificSubjectAnchor(
    result: { filePath: string; name: string; content?: string },
    profile: BugSubjectProfile
  ): boolean {
    const terms = this.getBugSpecificSubjectTerms(profile);
    if (terms.length === 0) return false;
    const text = `${result.filePath} ${result.name} ${result.content?.slice(0, 1200) ?? ""}`;
    return terms.some((term) => textMatchesQueryTerm(text, term));
  }

  hasBugFrontendAuthAnchor(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    return /\b(auth|login|signin|signout|authenticate|authenticated|session|oauth|token)\b/.test(text)
      || signals.primaryTagMatches > 0
      || signals.rawLiteralMatches > 0;
  }

  hasBugFrontendRoutingAnchor(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    return this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals);
  }

  hasBugFrontendAuthRoutingPair(
    result: { filePath: string; name: string },
    signals: BugCandidateSignals
  ): boolean {
    return this.hasBugFrontendAuthAnchor(result, signals)
      && this.hasBugFrontendRoutingAnchor(result, signals);
  }

  needsDedicatedBugGateCompanion(profile: BugSubjectProfile): boolean {
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
      ...profile.decomposition.semanticVariants,
    ]);
    return profile.primaryTags.has("connection")
      || profile.primaryTags.has("schema")
      || focus.has("runtime")
      || focus.has("caller")
      || focus.has("compatibility")
      || focus.has("compatible");
  }

  isBugGenericAuthEntryCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const authEntryLike = /\b(auth|login|signin|signup)\b/.test(text);
    const handoffAnchor = this.hasBugHandoffSpecificAnchor(result, signals);
    return authEntryLike && layers.includes("ui") && !handoffAnchor;
  }

  isBugGenericStateSupportNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const authRoutingAnchor =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals)
      || /\b(auth|login|signin|session)\b/.test(text);
    return (layers.includes("state") || layers.includes("shared"))
      && !layers.includes("routing")
      && !authRoutingAnchor;
  }

  isBugUnrelatedExecutionNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const executionLike = /\b(execution|workflow|processor|retry|executor|job|queue|worker)\b/.test(text);
    if (!executionLike) return false;
    const authRoutingAnchor =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || /\b(auth|login|signin|session|callback|redirect|protected|guard|route|router)\b/.test(text);
    return !authRoutingAnchor;
  }

  isBugCrossDomainNoiseCandidate(
    result: { filePath: string; name: string; content?: string },
    profile: BugSubjectProfile,
    signals: BugCandidateSignals
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name} ${result.content?.slice(0, 800) ?? ""}`);
    const hasStrongLocalAnchor =
      signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0
      || signals.rawLiteralMatches > 0
      || this.hasBugSpecificSubjectAnchor(result, profile);

    if (this.isBugAuthRoutingPrompt(profile)) {
      if (this.hasBugHandoffSpecificAnchor(result, signals) || this.isBugRedirectBackboneCandidate(result, signals)) {
        return false;
      }
      return BUG_AUTH_ROUTING_OFFDOMAIN_RE.test(text) && !this.hasBugFrontendAuthRoutingPair(result, signals);
    }

    if (profile.primaryTags.has("connection") || profile.primaryTags.has("schema")) {
      const connectionAnchored =
        hasStrongLocalAnchor
        || /\b(connect|connection|compat|compatible|schema|edge|handle|link|editor|flow)\b/.test(text);
      return BUG_CONNECTION_OFFDOMAIN_RE.test(text) && !connectionAnchored;
    }

    return false;
  }

  hasBugAnchorSignals(signals: BugCandidateSignals): boolean {
    return signals.rawTermMatches > 0
      || signals.semanticMatches > 0
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
  }

  hasBugDirectAnchorSignals(signals: BugCandidateSignals): boolean {
    return signals.rawLiteralMatches > 0
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
  }

  hasBugMechanismAnchorSignals(
    signals: BugCandidateSignals,
    profile: BugSubjectProfile
  ): boolean {
    if (this.hasBugDirectAnchorSignals(signals)) return true;
    if (signals.pathNameSemanticMatches === 0) return false;
    return profile.primaryTags.has("connection")
      || profile.primaryTags.has("schema")
      || profile.primaryTags.has("routing");
  }

  isStrongBugAnchorCandidate(
    result: { filePath: string; name: string; content: string },
    signals: BugCandidateSignals,
    feature?: ChunkFeature,
    profile?: BugSubjectProfile
  ): boolean {
    return ((profile ? this.hasBugMechanismAnchorSignals(signals, profile) : this.hasBugDirectAnchorSignals(signals)) || signals.implementationMatches > 0 || signals.runtimeMatches > 0)
      && this.isBugGateLike(result, feature);
  }

  // =========================================================================
  // Mode-focused expanded terms (shared with trace, but bug path uses it)
  // =========================================================================

  getModeFocusedExpandedTerms(
    query: string,
    queryMode: "bug" | "trace"
  ): ExpandedQueryTerm[] {
    const expanded = expandQueryTerms(query);
    const explicitLogging = MODE_EXPLICIT_LOGGING_RE.test(query);
    const explicitWebhook = MODE_EXPLICIT_WEBHOOK_RE.test(query);
    const familyScores = new Map<string, number>();

    for (const term of expanded) {
      if (!term.family) continue;
      if (term.source !== "original" && term.source !== "morphological") continue;
      const normalized = normalizeTargetText(term.term);
      if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) continue;
      familyScores.set(term.family, (familyScores.get(term.family) ?? 0) + term.weight);
    }

    const rankedFamilies = Array.from(familyScores.entries()).sort((a, b) => b[1] - a[1]);
    const topScore = rankedFamilies[0]?.[1] ?? 0;
    const allowedFamilies = new Set<string>();
    for (const [family, score] of rankedFamilies) {
      if (score < Math.max(0.86, topScore * 0.55)) continue;
      allowedFamilies.add(family);
      for (const adjacent of ADJACENT_WORKFLOW_FAMILIES[family] ?? []) {
        allowedFamilies.add(adjacent);
      }
    }
    if (!explicitLogging) allowedFamilies.delete("logging");
    if (!explicitWebhook && (allowedFamilies.has("auth") || allowedFamilies.has("routing"))) {
      allowedFamilies.delete("webhook");
    }

    return expanded.filter((term) => {
      const normalized = normalizeTargetText(term.term);
      if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) return false;
      if (queryMode === "bug" && BUG_NOISE_TERMS.has(normalized)) return false;
      if (queryMode === "trace" && TRACE_NOISE_TERMS.has(normalized)) return false;
      if (!term.family) {
        return term.source === "original" || term.source === "morphological" || !term.generic;
      }
      if (allowedFamilies.size === 0) {
        if (term.family === "logging" && !explicitLogging) return false;
        if (term.family === "webhook" && !explicitWebhook) return false;
        return true;
      }
      if (allowedFamilies.has(term.family)) return true;
      if (
        queryMode === "bug"
        && (term.source === "original" || term.source === "morphological")
        && !term.generic
        && normalized.length >= 4
        && !BUG_LOW_SPECIFICITY_TERMS.has(normalized)
      ) {
        return true;
      }
      return false;
    });
  }

  // =========================================================================
  // Internal helpers (private)
  // =========================================================================
}
