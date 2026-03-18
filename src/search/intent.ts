/**
 * Pure regex/keyword-based intent classifier — zero LLM tokens.
 *
 * Determines whether a user query is about code (needs retrieval)
 * or is meta/chat (should be skipped), and whether navigational
 * context (flow/trace/debug) is needed.
 */

export interface QueryIntent {
  isCodeQuery: boolean;
  needsNavigation: boolean;
  skipReason?: string;
}

export type RouteDecision = "skip" | "R0" | "R1" | "R2";

// ── Non-code patterns ─────────────────────────────────────────────
// Greetings, thanks, meta about Claude/AI, general chat.
// Each branch is anchored to match the FULL query (after trim/lowercase).
const NON_CODE_PATTERNS: RegExp[] = [
  // Greetings
  /^(hello|hi|hey|yo|sup|howdy|hola|good\s+(morning|afternoon|evening|night))(\s+there)?[\s!.?]*$/,
  // Thanks
  /^(thanks|thank\s+you|thx|ty|cheers)[\s!.?]*$/,
  // Meta about Claude / AI / memory / reporecall
  /\b(are you|am i)\s+(using|with)\s+(memory|context|reporecall)\b/,
  /^what\s+(model|llm)\s+(are\s+you|is\s+this)[\s!.?]*$/,
  /^what\s+model\s+are\s+you\s+using[\s!.?]*$/,
  /^what\s+was\s+(in\s+the\s+)?injected(\s+(context|prompt|tokens?))?[\s!.?]*$/,
  /^how\s+many\s+tokens\s+(were|are|got)\s+(injected|used|sent)[\s!.?]*$/,
  /^did\s+reporecall\s+run[\s!.?]*$/,
  // General chat / conversation meta
  /^summarize\s+(our\s+)?conversation[\s!.?]*$/,
  /\bwhat\s+did\s+we\s+discuss\b/,
  /\btell\s+me\s+a\s+joke\b/,
];

// ── Navigation patterns ───────────────────────────────────────────
const NAVIGATION_PATTERNS: RegExp[] = [
  /\bexplain\s+how\b/,
  /\bhow\s+does\b/,
  /\bhow\s+do\b/,
  /\bhow\s+is\b/,
  /\bwalk\s+me\s+through\b/,
  /\bwhy\s+does\b/,
  /\bwhy\s+is\b/,
  /\bwhy\s+do\b/,
  /\bwhat\s+happens\s+(when|if)\b/,
  /\b(flow|trace|debug|broken|fail|failing|error)\b/,
  /\b(architecture|design)\b/,
  /\b(who|what)\s+calls\b/,
  /\bcalled\s+by\b/,
];

/**
 * Classify a user query into a {@link QueryIntent}.
 *
 * Critical rule: default to `isCodeQuery = true` on ambiguity.
 * A false-positive skip (suppressing retrieval on a real code question)
 * is far worse than a false-negative skip.
 */
export function classifyIntent(query: string): QueryIntent {
  const trimmed = query.trim();

  // Empty / very short queries
  if (trimmed.length < 3) {
    return { isCodeQuery: false, needsNavigation: false, skipReason: "empty or too short" };
  }

  const lower = trimmed.toLowerCase();

  // Check non-code patterns
  for (const pattern of NON_CODE_PATTERNS) {
    if (pattern.test(lower)) {
      return { isCodeQuery: false, needsNavigation: false, skipReason: "non-code query" };
    }
  }

  // Default: it's a code query. Check navigation.
  const needsNavigation = NAVIGATION_PATTERNS.some((p) => p.test(lower));

  return { isCodeQuery: true, needsNavigation };
}

/**
 * Derive a route decision from an intent and optional seed confidence.
 *
 * - `undefined` means seed resolution has not been attempted yet, so
 *   navigational queries temporarily stay on "R0".
 * - `null` means seed resolution ran but did not find a viable seed, so
 *   navigational queries should fall back to "R2".
 */
export function deriveRoute(
  intent: QueryIntent,
  seedConfidence?: number | null
): RouteDecision {
  if (!intent.isCodeQuery) return "skip";
  if (!intent.needsNavigation) return "R0";

  // Navigational query — route depends on seed confidence
  if (seedConfidence === undefined) return "R0";
  if (seedConfidence === null) return "R2";
  const threshold = 0.55;
  return seedConfidence >= threshold ? "R1" : "R2";
}
