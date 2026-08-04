import type { SeedResult } from "./seed.js";
import type { BugStrategy } from "./bug-strategy.js";
import {
  BUG_GENERIC_SEED_ALIAS_TERMS,
  BUG_LOW_SPECIFICITY_TERMS,
  BUG_STRUCTURAL_NOISE_RE,
  BUG_STRUCTURAL_ROLE_ALIAS_TERMS,
} from "./bug-strategy.js";
import { extractTraceSalientTerms, getTraceFocusedExpandedTerms } from "./trace-strategy.js";
import { normalizeTargetText } from "./targets.js";
import { GENERIC_BROAD_TERMS, GENERIC_QUERY_ACTION_TERMS, textMatchesQueryTerm } from "./utils.js";
export function filterSeedsForMode(
bugStrategy: BugStrategy,
  query: string,
  seedResult: SeedResult,
  queryMode: "lookup" | "trace" | "bug" | "architecture" | "change" | "skip"
): SeedResult {
  if (queryMode !== "bug" && queryMode !== "trace" && queryMode !== "architecture" && queryMode !== "change") {
    return seedResult;
  }

  const focusTerms = queryMode === "bug"
    ? bugStrategy.extractBugSalientTerms(query)
    : extractTraceSalientTerms(query);
  const familyTerms = (queryMode === "bug"
    ? bugStrategy.getModeFocusedExpandedTerms(query, "bug")
    : getTraceFocusedExpandedTerms(query)
  )
    .filter((term) => term.family && !term.generic && term.weight >= 0.72)
    .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean));
  const bugProfile = queryMode === "bug"
    ? bugStrategy.buildBugSubjectProfile(focusTerms, query)
    : null;
  const handoffPrompt = bugProfile ? bugStrategy.isBugRedirectHandoffPrompt(bugProfile) : false;
  const schemaPrompt = bugProfile
    ? bugProfile.subjectTerms.some((term) => ["migration", "migrations", "schema", "sql", "table", "column", "database", "db"].includes(term))
      || bugProfile.primaryTags.has("storage")
      || bugProfile.primaryTags.has("billing")
    : false;

  const filteredSeeds = seedResult.seeds.filter((seed) => {
    const seedText = `${seed.filePath} ${seed.name} ${seed.resolvedAlias ?? ""}`;
    const lowerSeedText = seedText.toLowerCase();
    const normalizedSeedText = normalizeTargetText(seedText);
    const normalizedNameTokens = normalizeTargetText(seed.name).split(" ").filter(Boolean);
    const leadingToken = normalizedNameTokens[0] ?? "";
    const focusMatch = focusTerms.some((term) => textMatchesQueryTerm(seedText, term));
    const familyMatch = familyTerms.some((term) => textMatchesQueryTerm(seedText, term));

    if (
      queryMode === "bug"
      && !schemaPrompt
      && (/(?:^|\/)(migrations?|schema)\//.test(seed.filePath.toLowerCase()) || /\.sql$/i.test(seed.filePath))
    ) {
      return false;
    }

    if (
      queryMode === "bug"
      && handoffPrompt
      && /\b(navigation|drawer|menu|segment|mobile|keyboard|floating|tab|skip|signout|logout)\b/.test(lowerSeedText)
      && !/\b(protected|guard|redirect|callback|auth|route|router|destination|pending|session)\b/.test(lowerSeedText)
    ) {
      return false;
    }
    if (
      queryMode === "bug"
      && handoffPrompt
      && /(?:^|\/)(src\/)?(components|pages|views|screens)\//.test(seed.filePath.toLowerCase())
      && /\b(auth|login|signin|signup)\b/.test(normalizedSeedText)
      && !/\b(callback|redirect|protected|guard|pending|destination|route|router|session|return)\b/.test(normalizedSeedText)
    ) {
      return false;
    }

      if (
        queryMode === "bug"
        && !focusMatch
        && !familyMatch
        && seed.reason !== "explicit_target"
        && BUG_STRUCTURAL_ROLE_ALIAS_TERMS.has(normalizeTargetText(seed.resolvedAlias ?? seed.name))
      ) {
        return false;
      }

    if (
      queryMode === "bug"
      && seed.reason !== "explicit_target"
      && normalizeTargetText(seed.resolvedAlias ?? seed.name).split(" ").length <= 1
      && BUG_LOW_SPECIFICITY_TERMS.has(normalizeTargetText(seed.resolvedAlias ?? seed.name))
      && BUG_STRUCTURAL_NOISE_RE.test(seed.filePath.toLowerCase())
      && !familyMatch
    ) {
      return false;
    }

    if (
      seed.reason === "explicit_target"
      && GENERIC_QUERY_ACTION_TERMS.has(leadingToken)
      && !focusMatch
      && !familyMatch
    ) {
      return false;
    }

    if (
      (seed.reason === "explicit_target" || seed.reason === "resolved_target")
      && familyTerms.length > 0
      && !focusMatch
      && !familyMatch
    ) {
      return false;
    }

    if (
      (queryMode === "architecture" || queryMode === "change")
      && seed.reason === "explicit_target"
      && (/^(what|where|which|when|why|how)$/i.test(seed.name) || /^(what|where|which|when|why|how)[A-Z_]/.test(seed.name))
    ) {
      return false;
    }

    return true;
  });

  if (filteredSeeds.length === 0) return seedResult;
  const rankedSeeds = [...filteredSeeds].sort((a, b) => {
    const explicitDiff =
      Number(b.reason === "explicit_target") - Number(a.reason === "explicit_target");
    if (explicitDiff !== 0) return explicitDiff;

    const scoreSeed = (seed: SeedResult["seeds"][number]): number => {
      const seedText = `${seed.filePath} ${seed.name} ${seed.resolvedAlias ?? ""}`;
      const focusMatches = focusTerms.filter((term) => textMatchesQueryTerm(seedText, term)).length;
      const familyMatches = familyTerms.filter((term) => textMatchesQueryTerm(seedText, term)).length;
      const aliasTokens = normalizeTargetText(seed.resolvedAlias ?? seed.name).split(" ").filter(Boolean);
      const aliasIsGeneric = aliasTokens.length === 1
        && (
          GENERIC_BROAD_TERMS.has(aliasTokens[0] ?? "")
          || GENERIC_QUERY_ACTION_TERMS.has(aliasTokens[0] ?? "")
          || BUG_GENERIC_SEED_ALIAS_TERMS.has(aliasTokens[0] ?? "")
        );
      const genericResolvedFilePenalty =
        seed.reason === "resolved_target"
        && seed.targetKind === "file_module"
        && aliasIsGeneric
          ? (queryMode === "trace" ? 3.4 : queryMode === "architecture" || queryMode === "change" ? 2.8 : 0)
          : 0;
      const compoundBonus = /[A-Z_]/.test(seed.name) ? 1.5 : aliasTokens.length >= 2 ? 1 : 0;
      const reasonBonus =
        seed.reason === "explicit_target" ? 1.4
          : seed.reason === "fts_exact" ? 1.2
            : seed.targetKind === "symbol" ? 1.1
              : seed.targetKind === "file_module" ? 0.8
                : 0.5;
      return focusMatches * 5 + familyMatches * 3 + compoundBonus + reasonBonus - (aliasIsGeneric ? 2.2 : 0) - genericResolvedFilePenalty;
    };
    const diff = scoreSeed(b) - scoreSeed(a);
    if (Math.abs(diff) > 0.01) return diff;
    return b.confidence - a.confidence;
  });
  return {
    seeds: rankedSeeds,
    bestSeed: rankedSeeds[0] ?? null,
  };
}
