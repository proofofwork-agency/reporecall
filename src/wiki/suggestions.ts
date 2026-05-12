import type { Memory } from "../memory/types.js";

export interface WikiSuggestion {
  name: string;
  description: string;
  summary: string;
  confidence: number;
  score: number;
  matchedTerms: string[];
}

export interface WikiSuggestionStore {
  getByType(type: "wiki"): Memory[];
}

const GENERATED_PREFIXES = [
  "business",
  "product",
  "area",
  "related",
  "domain",
  "community",
  "hub",
  "surprises",
  "wiki",
  "module",
  "flow",
  "exploration",
];

const STOP_TERMS = new Set([
  ...GENERATED_PREFIXES,
  "page",
  "pages",
  "context",
  "capability",
  "capabilities",
  "behavior",
  "supporting",
  "general",
  "implementation",
  "detail",
]);

export function suggestWikiPages(
  store: WikiSuggestionStore,
  missingName: string,
  limit = 5
): WikiSuggestion[] {
  const queryTerms = tokenizeWikiName(missingName);
  if (queryTerms.length === 0) return [];

  return store
    .getByType("wiki")
    .map((page) => ({ page, score: scoreWikiSuggestion(page, queryTerms), matchedTerms: matchedTerms(page, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.page.confidence ?? 0) - (a.page.confidence ?? 0);
    })
    .slice(0, limit)
    .map((item) => ({
      name: item.page.name,
      description: item.page.description,
      summary: item.page.summary ?? item.page.description,
      confidence: item.page.confidence ?? 0,
      score: Number(item.score.toFixed(3)),
      matchedTerms: item.matchedTerms,
    }));
}

function scoreWikiSuggestion(page: Memory, queryTerms: string[]): number {
  const weightedText = [
    [page.name, 5],
    [page.summary ?? "", 3],
    [page.description, 2],
    [page.content, 1],
    [(page.relatedFiles ?? []).join(" "), 0.5],
    [(page.relatedSymbols ?? []).join(" "), 0.75],
  ] as Array<[string, number]>;
  let score = 0;
  for (const term of queryTerms) {
    for (const [text, weight] of weightedText) {
      const tokens = tokenizeWikiName(text);
      if (tokens.includes(term)) score += weight;
      else if (tokens.some((token) => term.length >= 4 && token.length >= 4 && (token.includes(term) || term.includes(token)))) {
        score += weight * 0.35;
      }
    }
  }
  if (page.name.startsWith("product-area-")) score += 0.5;
  if (page.name.startsWith("related-domain-")) score += 0.35;
  return score;
}

function matchedTerms(page: Memory, queryTerms: string[]): string[] {
  const textTerms = new Set(tokenizeWikiName([
    page.name,
    page.summary ?? "",
    page.description,
    page.content,
    ...(page.relatedSymbols ?? []),
  ].join(" ")));
  return queryTerms.filter((term) => textTerms.has(term));
}

function tokenizeWikiName(value: string): string[] {
  const terms = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !STOP_TERMS.has(term));
  return Array.from(new Set(terms));
}
