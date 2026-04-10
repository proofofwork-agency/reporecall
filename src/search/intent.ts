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
  queryMode: QueryMode;
  modeConfidence?: number;
  skipReason?: string;
}

export type QueryMode = "skip" | "lookup" | "trace" | "bug" | "architecture" | "change";

// ── Non-code patterns ─────────────────────────────────────────────
// Greetings, thanks, meta about Claude/AI, general chat.
// Each branch is anchored to match the FULL query (after trim/lowercase).
const NON_CODE_PATTERNS: RegExp[] = [
  // Greetings (exact)
  /^(hello|hi|hey|yo|sup|howdy|hola|good\s+(morning|afternoon|evening|night))(\s+there)?[\s!.?]*$/,
  // Greetings followed by conversational filler ("hello how are you", "hi there what's up")
  /^(hello|hi|hey|yo|sup|howdy|hola|good\s+(morning|afternoon|evening|night))(\s+there)?\s+(how|what|nice|hope|glad)\b/,
  // Standalone conversational openers
  /^how\s+are\s+(you|things|we|everyone)\b/,
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
  /\bhow\s+are\b/,
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
const CONCEPT_FAMILY_RE =
  /\b(auth|authentication|authorization|login|signin|signup|signout|session|oauth|token|credential|billing|payment|checkout|subscription|invoice|refund|upload|storage|media|file|bucket|generation|generate|render|image|queue|worker|job|webhook|routing|route|router|redirect|callback|permissions?|role|policy|search|retrieval|ranking|indexing|daemon|server|hook|hooks|logging|trace|audit)\b/;
const FILE_INVENTORY_RE = /\bwhich\s+files?\b|\ball\s+(?:the\s+)?files?\b/;
const WHOLE_SYSTEM_SCOPE_RE = /\b(full|entire|complete|end-to-end|across)\b|\bevery\s+step\b|\bfrom\s+.+\s+to\s+.+\b/;
const CROSS_CUTTING_EDIT_RE = /\b(add|instrument|trace|audit|update|change|logging?)\b/;
const WORKFLOW_LIFECYCLE_RE = /\b(save|saving|saved|publish|publishing|published|serialize|serialization|share|sharing)\b/;
const JOB_ORCHESTRATION_RE = /\b(poll|polling|status|queue|job|jobs|worker|workers)\b/;
const BOT_SYSTEM_RE = /\b(bot|telegram|discord|whatsapp)\b/;
const BILLING_RE = /\b(billing|checkout|portal|subscription|invoice|payment|credit|credits)\b/;
const GENERATION_RE = /\b(generate|generation|render|image|images|job|jobs|queue|worker|workers)\b/;
const LIFECYCLE_SYSTEM_RE = /\b(shutdown|startup|drain|close|teardown|boot|bootstrap)\b/;
const ARCHITECTURAL_QUESTION_RE = /^(what|how|explain|describe|show)\s+(is|does|are|do)?\s*(the\s+)?(architecture|design|structure|system|overview)/i;
const REDIRECT_DEBUG_RE =
  /(?:\b(success|failure|fail(?:ure)?)\b.*\bredirect\b|\bredirect\b.*\b(success|failure|fail(?:ure)?)\b)/;
const DIRECT_LOOKUP_RE = /^(show|find|where\s+is|open)\b/i;
const DIRECT_TRACE_RE = /^(trace|follow)\b(?!.*\b(full|entire|complete|end-to-end)\b)/i;
const STRUCTURED_TRACE_RE = /^(trace|follow)\b(?!.*\b(flow|workflow|lifecycle|pipeline|journey)\b).*?\bfrom\b.+\bto\b.+/i;
const EXPLICIT_TRACE_RE = /^(trace|follow)\b/i;
const INFRASTRUCTURE_TRACE_RE =
  /\b(mcp|stdio|cli|command|daemon|server|tool\s+registration|hook|hooks|http|endpoint|socket|transport|request\s+flow|registration)\b/i;
const LOOKUP_HINT_RE =
  /^(show|find|where\s+is|open|read|locate)\b|\b(path|file|symbol|class|function|type|interface|module|endpoint|implementation)\b/i;
const TRACE_RE =
  /\b(explain\s+how|how\s+does|how\s+do|how\s+are|walk\s+me\s+through|what\s+happens\s+(?:when|if)|who\s+calls|what\s+calls|called\s+by)\b/i;
const BUG_RE =
  /\b(why|how\s+is\s+this\s+possible|how\s+is\s+it\s+possible|shouldn'?t|supposed\s+to|unexpected|wrong|incorrect|broken|fails?|failing|failure|issues?|problems?|bugs?|not\s+supposed\s+to)\b/i;
const LONG_FORM_SYMPTOM_RE =
  /\b(flaky|forgets?|forgot|lost|missing|wrong\s+page|original\s+destination|queued\s+destination|pending\s+navigation|handoff)\b/i;
const CHANGE_RE =
  /\b(add|instrument|audit|log(?:ging)?|modify|change|update|refactor|wire(?:\s+up)?|hook(?:\s+up)?)\b/i;
const CHANGE_SCOPE_RE =
  /\b(every\s+step|across|throughout|full|entire|complete|all\s+files|all\s+steps)\b/i;
const IMPLEMENT_WHERE_RE = /\bwhere\s+should\s+i\s+implement\b/i;
const ARCHITECTURE_RE =
  /\b(which\s+files?\s+implement|which\s+files?\s+handle|all\s+files?\s+involved|end-to-end|across|architecture|design|structure|overview|full\s+flow|complete\s+workflow|entire\s+flow)\b/i;

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
    return {
      isCodeQuery: false,
      needsNavigation: false,
      queryMode: "skip",
      modeConfidence: 1,
      skipReason: "empty or too short",
    };
  }

  const lower = trimmed.toLowerCase();

  // Check non-code patterns
  for (const pattern of NON_CODE_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        isCodeQuery: false,
        needsNavigation: false,
        queryMode: "skip",
        modeConfidence: 1,
        skipReason: "non-code query",
      };
    }
  }

  const hasNavigationCue = NAVIGATION_PATTERNS.some((p) => p.test(lower));
  const hasWorkflowNoun = WORKFLOW_NOUN_RE.test(lower);
  const hasConceptFamily = CONCEPT_FAMILY_RE.test(lower);
  const looksLikeDirectLookup = DIRECT_LOOKUP_RE.test(trimmed);
  const looksLikeExplicitTrace = EXPLICIT_TRACE_RE.test(trimmed);
  const looksLikeStructuredInfrastructureTrace =
    STRUCTURED_TRACE_RE.test(trimmed) && INFRASTRUCTURE_TRACE_RE.test(lower);
  const looksLikeInfrastructureTrace =
    looksLikeExplicitTrace
    && INFRASTRUCTURE_TRACE_RE.test(lower)
    && /\bfrom\b.+\bto\b.+/.test(lower);
  const looksLikeDirectTrace =
    DIRECT_TRACE_RE.test(trimmed)
    || looksLikeStructuredInfrastructureTrace
    || looksLikeInfrastructureTrace;
  const hasFileInventoryCue = FILE_INVENTORY_RE.test(lower);
  const hasWholeSystemScope = WHOLE_SYSTEM_SCOPE_RE.test(lower);
  const hasCrossCuttingCue = CROSS_CUTTING_EDIT_RE.test(lower);
  const hasWorkflowLifecycleCue = WORKFLOW_LIFECYCLE_RE.test(lower);
  const hasJobOrchestrationCue = JOB_ORCHESTRATION_RE.test(lower);
  const hasBotSystemCue = BOT_SYSTEM_RE.test(lower);
  const mentionsBillingDomain = BILLING_RE.test(lower);
  const mentionsGenerationDomain = GENERATION_RE.test(lower);
  const hasCrossDomainBoundaryCue = /\b(before|after|during)\b/.test(lower);
  const hasBugCue = BUG_RE.test(lower);
  const hasLongFormSymptomCue =
    LONG_FORM_SYMPTOM_RE.test(lower)
    && /\b(auth|login|signin|signup|session|redirect|callback|route|router|navigation|protected|destination)\b/.test(lower);
  const hasTraceCue = TRACE_RE.test(lower);
  const hasArchitectureCue =
    ARCHITECTURE_RE.test(lower)
    || hasFileInventoryCue
    || ARCHITECTURAL_QUESTION_RE.test(lower)
    || (hasWorkflowNoun && hasWholeSystemScope)
    || (hasWorkflowNoun && hasWorkflowLifecycleCue)
    || (hasWorkflowNoun && hasJobOrchestrationCue)
    || (hasBotSystemCue && /\bhow\s+does\b.*\bwork\b/.test(lower))
    || (hasCrossDomainBoundaryCue && mentionsBillingDomain && mentionsGenerationDomain)
    || (!looksLikeDirectLookup && hasWorkflowNoun && hasConceptFamily)
    || (hasWholeSystemScope && LIFECYCLE_SYSTEM_RE.test(lower));
  const hasChangeCue =
    IMPLEMENT_WHERE_RE.test(lower)
    || (CHANGE_RE.test(lower) && (CHANGE_SCOPE_RE.test(lower) || hasWorkflowNoun || hasFileInventoryCue));

  const prefersBroadContext =
    hasFileInventoryCue
    || REDIRECT_DEBUG_RE.test(lower)
    || ARCHITECTURAL_QUESTION_RE.test(lower)
    || (hasNavigationCue && hasWholeSystemScope)
    || (hasWorkflowNoun && hasWholeSystemScope)
    || (hasWorkflowNoun && hasWorkflowLifecycleCue)
    || (hasWorkflowNoun && hasJobOrchestrationCue)
    || (hasBotSystemCue && /\bhow\s+does\b.*\bwork\b/.test(lower))
    || (hasCrossDomainBoundaryCue && mentionsBillingDomain && mentionsGenerationDomain)
    || (!looksLikeDirectLookup && hasWorkflowNoun && hasConceptFamily)
    || (hasWholeSystemScope && LIFECYCLE_SYSTEM_RE.test(lower))
    || (hasWholeSystemScope && hasCrossCuttingCue)
    || (hasFileInventoryCue && hasWorkflowNoun);
  const isChange = hasChangeCue && !looksLikeDirectLookup;
  const isArchitecture = hasArchitectureCue && !hasBugCue && !isChange && !looksLikeDirectTrace;
  const isBug = (hasBugCue || hasLongFormSymptomCue) && !looksLikeDirectLookup;
  const isTrace = looksLikeDirectTrace || hasTraceCue || (hasNavigationCue && !isArchitecture && !isBug && !isChange);
  const isLookup =
    looksLikeDirectLookup
    || (!isArchitecture && !isBug && !isChange && !isTrace && LOOKUP_HINT_RE.test(trimmed));

  let queryMode: QueryMode = "lookup";
  let modeConfidence = 0.65;
  if (isChange) {
    queryMode = "change";
    modeConfidence = 0.85;
  } else if (isBug) {
    queryMode = "bug";
    modeConfidence = 0.9;
  } else if (isArchitecture) {
    queryMode = "architecture";
    modeConfidence = 0.82;
  } else if (isTrace) {
    queryMode = "trace";
    modeConfidence = looksLikeDirectTrace ? 0.9 : 0.8;
  } else if (isLookup) {
    queryMode = "lookup";
    modeConfidence = looksLikeDirectLookup ? 0.92 : 0.72;
  }

  const needsNavigation = queryMode === "trace" || queryMode === "bug" || queryMode === "architecture" || queryMode === "change";

  return { isCodeQuery: true, needsNavigation, prefersBroadContext, queryMode, modeConfidence };
}
