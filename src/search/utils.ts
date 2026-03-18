/**
 * Common English stop words shared across search modules.
 * Union of words from seed.ts and ranker.ts to avoid duplicate definitions.
 */
export const STOP_WORDS = new Set([
  "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "need",
  "dare", "ought", "used", "to", "of", "in", "for", "on",
  "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "because", "but", "and",
  "if", "or", "while", "about", "what", "which", "who",
  "whom", "this", "that", "these", "those", "am", "an", "a",
  "it", "its", "my", "your", "his", "her", "our", "their",
  "return", "list",
]);

/**
 * Checks if a file path is a test/spec/fixture/benchmark/example file.
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(?:^|\/)(test|spec|__tests__|__fixtures__|fixtures|benchmark|examples)\//.test(lower)
    || /\.(test|spec)\.[^.]+$/.test(lower);
}
