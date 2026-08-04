import type { StoredChunk } from "../../storage/types.js";
import type { SearchResult } from "../types.js";
import { GENERIC_QUERY_ACTION_TERMS, getQueryTermVariants, STOP_WORDS, type ExpandedQueryTerm } from "../utils.js";
import { normalizeTargetText } from "../targets.js";
import { TRACE_NOISE_TERMS } from "../shared/workflow-families.js";
import { chunkToSearchResult, isImplementationPath } from "../shared/mappers.js";
import { BUG_GATE_RE, BUG_STRUCTURAL_HINT_TERMS, BUG_NOISE_TERMS, BUG_SUBJECT_TAG_RULES } from "./model.js";
import { BugStrategyBase } from "./base.js";

export class BugStrategyLayer1 extends BugStrategyBase {
  protected getBugQueryVariants(term: string): string[] {
    const normalized = normalizeTargetText(term).trim();
    if (!normalized) return [];

    return Array.from(new Set(
      getQueryTermVariants(normalized).filter((variant) => {
        if (!variant) return false;
        if (variant === normalized) return true;
        if (variant.length < 5 && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant)) && !BUG_GATE_RE.test(variant)) {
          return false;
        }
        if (normalized.length >= 6 && variant.length === 4 && normalized.startsWith(variant)) return false;
        if (
          normalized.endsWith("ing")
          && variant === `${normalized.slice(0, -3)}er`
          && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant))
          && !BUG_GATE_RE.test(variant)
        ) {
          return false;
        }
        if (
          this.isBugStructuralHintTerm(variant)
          && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant))
          && !BUG_GATE_RE.test(variant)
        ) {
          return false;
        }
        return true;
      })
    ));
  }

  protected isBugStructuralHintTerm(term: string): boolean {
    const normalized = normalizeTargetText(term).trim();
    if (!normalized) return false;
    return BUG_STRUCTURAL_HINT_TERMS.has(normalized)
      || /^controll/.test(normalized)
      || /^implement/.test(normalized);
  }

  protected isUsefulBugSignalTerm(term: string): boolean {
    if (!term) return false;
    if (BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(term)) || BUG_GATE_RE.test(term)) return true;
    if (this.isBugStructuralHintTerm(term)) return false;
    if (term.length <= 4) return false;
    return true;
  }

  protected collectModeCompoundSemanticTerms(focusedExpanded: ExpandedQueryTerm[]): string[] {
    return focusedExpanded
      .filter((term) =>
        term.source === "semantic"
        && !!term.family
        && !term.generic
        && term.weight >= 0.72
        && (
          /[A-Z_]/.test(term.term)
          || normalizeTargetText(term.term).split(" ").filter(Boolean).length > 1
        )
        && normalizeTargetText(term.term).split(" ").filter(Boolean).length <= 2
      )
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !TRACE_NOISE_TERMS.has(term)
      );
  }

  protected isImplementationChunk(result: SearchResult): boolean {
    return this.isImplementationPath(result.filePath);
  }

  protected isImplementationPath(filePath: string): boolean {
    return isImplementationPath(filePath, this.config.implementationPaths ?? ["src/", "lib/", "bin/"]);
  }

  protected detectWorkflowLayers(lowerPath: string, lowerName: string): string[] {
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

  protected isUtilityLikePath(lowerPath: string, lowerName: string): boolean {
    return /(?:^|\/)(lib|shared|core|utils?|helpers?|types?)\//.test(lowerPath)
      || /\b(utils?|helpers?|types?|errors?)\b/.test(lowerName);
  }

  protected chunkToSearchResult(chunk: StoredChunk, score: number): SearchResult {
    return chunkToSearchResult(chunk, score);
  }

  protected mergeBroadResults(targetResults: SearchResult[], results: SearchResult[]): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const result of [...targetResults, ...results]) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) {
        byId.set(result.id, result);
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }
}
