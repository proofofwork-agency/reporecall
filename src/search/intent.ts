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
  prefersBroadContext?: boolean;
  skipReason?: string;
}

export type RouteDecision = "skip" | "R0" | "R1" | "R2";

// ── Non-code patterns ─────────────────────────────────────────────
// Greetings, thanks, meta about Claude/AI, general chat.
// Each branch is anchored to match the FULL query (after trim/lowercase).
const NON_CODE_PATTERNS: RegExp[] = [
  // Greetings (exact)
  /^(hello|hi|hey|yo|sup|howdy|hola|good\s+(morning|afternoon|evening|night))(\s+there)?[\s!.?]*$/,
  // Greetings followed by conversational filler ("hello how are you", "hi there what's up")
  /^(hello|hi|hey|yo|sup|howdy|hola|good\s+(morning|afternoon|evening|night))(\s+there)?\s+(how|what|nice|hope|glad)\b/,
  // Standalone conversational openers
  /^how\s+are\s+you\b/,
  /^what('s|\s+is)\s+(up|new|good)\b/,
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
  // Short vague directives with no code-specific nouns — conversational,
  // not worth searching the index for.
  /^(ok|okay|sure|yes|no|yep|nope|yea|yeah|nah|got\s+it|understood|sounds\s+good|go\s+ahead|do\s+it|perfect|great|lgtm|nice|cool|alright)[\s!.?]*$/,
  /^(don'?t\s+break\s+what\s+work(s|ed))\b/,
  /^(please\s+)?(continue|proceed|go\s+on|carry\s+on|keep\s+going|move\s+on)[\s!.?]*$/,
  /^(make|build|create)\s+(a\s+)?new\s+dist[\s!.?]*$/,
  /^(we\s+have|there'?s|there\s+is)\s+a\s+new\s+(dist|build|version)[\s.,!?]*$/,
  /^(check|verify|confirm)\s+(if\s+|that\s+)?(it|that|this)\s+(work(s|ed)|is\s+(ok|good|fine|correct))[\s!.?]*$/,
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
  /\b(flow|workflow|trace|debug|broken|fail|failing|error)\b/,
  /\b(audit|instrument|logging?|trace)\b/,
  /\b(change|update)\b.*\b(flow|workflow|lifecycle|path|pipeline|journey|files?)\b/,
  /\b(architecture|design)\b/,
  /\b(who|what)\s+calls\b/,
  /\bcalled\s+by\b/,
];

const WORKFLOW_NOUN_RE = /\b(flow|workflow|lifecycle|pipeline|journey|request flow)\b/;
const FILE_INVENTORY_RE = /\bwhich\s+files?\b|\ball\s+(?:the\s+)?files?\b/;
const WHOLE_SYSTEM_SCOPE_RE = /\b(full|entire|complete|end-to-end|across)\b|\bevery\s+step\b|\bfrom\s+.+\s+to\s+.+\b/;
const CROSS_CUTTING_EDIT_RE = /\b(add|instrument|trace|audit|update|change|logging?)\b/;
const LIFECYCLE_SYSTEM_RE = /\b(shutdown|startup|drain|close|teardown|boot|bootstrap)\b/;
const ARCHITECTURAL_QUESTION_RE = /^(what|how|explain|describe|show)\s+(is|does|are|do)?\s*(the\s+)?(architecture|design|structure|system|overview)/i;
const REDIRECT_DEBUG_RE =
  /(?:\b(success|failure|fail(?:ure)?)\b.*\bredirect\b|\bredirect\b.*\b(success|failure|fail(?:ure)?)\b)/;

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

  const hasNavigationCue = NAVIGATION_PATTERNS.some((p) => p.test(lower));
  const hasWorkflowNoun = WORKFLOW_NOUN_RE.test(lower);
  const hasFileInventoryCue = FILE_INVENTORY_RE.test(lower);
  const hasWholeSystemScope = WHOLE_SYSTEM_SCOPE_RE.test(lower);
  const hasCrossCuttingCue = CROSS_CUTTING_EDIT_RE.test(lower);

  const prefersBroadContext =
    hasFileInventoryCue
    || REDIRECT_DEBUG_RE.test(lower)
    || ARCHITECTURAL_QUESTION_RE.test(lower)
    || (hasNavigationCue && hasWholeSystemScope)
    || (hasWorkflowNoun && hasWholeSystemScope)
    || (hasWholeSystemScope && LIFECYCLE_SYSTEM_RE.test(lower))
    || (hasWholeSystemScope && hasCrossCuttingCue)
    || (hasFileInventoryCue && hasWorkflowNoun);
  const needsNavigation = hasNavigationCue || prefersBroadContext;

  return { isCodeQuery: true, needsNavigation, prefersBroadContext };
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
  if (intent.prefersBroadContext) return "R2";

  // Navigational query — route depends on seed confidence
  if (seedConfidence === undefined) return "R0";
  if (seedConfidence === null) return "R2";
  const threshold = 0.40;
  if (seedConfidence >= threshold) return "R1";
  // Below threshold: seed was found but too weak — fall back to R0 keyword lookup.
  // R2 is reserved for seedConfidence === null (no seed found at all).
  return "R0";
}
