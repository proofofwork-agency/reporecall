/**
 * Wiki context assembly for always-on injection.
 *
 * Formats wiki search results into token-budgeted markdown
 * for injection alongside code context in prompt-context hook.
 */

import type { MemorySearchResult } from "../memory/types.js";
import { resolveMemorySummary } from "../memory/types.js";
import { countTokens } from "../search/context-assembler.js";

export interface AssembledWikiContext {
  text: string;
  tokenCount: number;
  pageCount: number;
  pageNames: string[];
}

/**
 * Assemble wiki search results into markdown for injection.
 * Formats as a compact "Wiki knowledge" section.
 */
export function assembleWikiContext(
  results: MemorySearchResult[],
  tokenBudget: number,
  maxPages = 3
): AssembledWikiContext | null {
  if (results.length === 0 || tokenBudget <= 0) return null;

  const lines: string[] = ["## Wiki knowledge", ""];
  let usedTokens = countTokens(lines.join("\n"));
  const included: string[] = [];

  for (const result of results.slice(0, maxPages)) {
    const summary = resolveMemorySummary(result);
    const pageType = (result as unknown as Record<string, unknown>).pageType as string | undefined;
    const typeTag = pageType ? `[${pageType}]` : "";

    // For top result, include overview section if available
    const isTop = included.length === 0;
    let entry: string;

    if (isTop && result.content) {
      // Extract first section (## Overview or first paragraph)
      const overviewMatch = result.content.match(/^## (?:Overview|Community|Hub Node|Surprising)[^\n]*\n([\s\S]*?)(?=\n## |$)/);
      const overview = overviewMatch
        ? overviewMatch[0].trim()
        : result.content.split("\n\n").slice(0, 2).join("\n\n").trim();

      const overviewTokens = countTokens(overview);
      if (usedTokens + overviewTokens + 20 <= tokenBudget) {
        entry = `### ${result.name} ${typeTag}\n${overview}`;
      } else {
        entry = `- **${result.name}** ${typeTag} — ${summary}`;
      }
    } else {
      entry = `- **${result.name}** ${typeTag} — ${summary}`;
    }

    const entryTokens = countTokens(entry);
    if (usedTokens + entryTokens > tokenBudget) break;

    lines.push(entry);
    lines.push("");
    usedTokens += entryTokens;
    included.push(result.name);
  }

  if (included.length === 0) return null;

  const text = lines.join("\n");
  return {
    text,
    tokenCount: countTokens(text),
    pageCount: included.length,
    pageNames: included,
  };
}
