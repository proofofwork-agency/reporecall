/**
 * Find the lines in a document that state a quantitative performance result, and
 * report whether each one carries a claims-registry marker.
 *
 * This lives in its own module so it can be tested. It previously did not, and it
 * silently stopped working: the percent pattern ended in `\b`, which requires a
 * word character on the far side of the boundary, and a percentage in prose is
 * followed by a space, a comma, or the end of the line. `75.4% fewer tokens` did
 * not match. `91.6% context precision` did not match. Only malformed strings like
 * `95.6%aaa` did. The registry kept validating the claims it already knew about,
 * so the gate looked healthy while the half that catches an *unregistered* number
 * appearing in the README never fired once.
 *
 * The regression test beside this file exists to make that specific failure loud.
 */

/** A line that asserts a quantitative performance result. */
export interface DetectedClaim {
  /** 1-indexed line number, matching what an editor shows. */
  lineNumber: number;
  /** The registry id from a `<!-- claim:id -->` marker, when the line has one. */
  marker?: string;
}

/**
 * A percentage, with no trailing `\b`.
 *
 * Deliberately permissive about what follows the `%` — that is the whole bug this
 * pattern used to have.
 */
const PERCENT = /\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*%/;

/** Vocabulary that makes a number a performance claim rather than a stray figure. */
const PERFORMANCE =
  /\b(token|recall|precision|accuracy|pollution|latency|response|saving|reduction|regression|improv)/i;

/**
 * Wording that marks a figure as something other than an assertion about this
 * release — a gate threshold, an illustration, a historical value.
 */
const NON_CLAIM =
  /\b(example|placeholder|target|threshold|gate|insufficient evidence|historical|reported)\b/i;

const MARKER = /<!--\s*claim:([a-z0-9_-]+)\s*-->/i;

/** Does this line assert a quantitative performance result? */
export function looksLikeQuantitativePerformanceClaim(line: string): boolean {
  return PERCENT.test(line) && PERFORMANCE.test(line);
}

/** Is this figure explicitly something other than a claim about this release? */
export function isClearlyNonClaim(line: string): boolean {
  return NON_CLAIM.test(line);
}

/**
 * Scan a document for quantitative performance claims.
 *
 * Fenced blocks are skipped: sample output and reproduction transcripts quote
 * figures without asserting them.
 */
export function findQuantitativeClaims(content: string): DetectedClaim[] {
  const found: DetectedClaim[] = [];
  let inFence = false;
  content.split(/\r?\n/).forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inFence || !looksLikeQuantitativePerformanceClaim(line) || isClearlyNonClaim(line)) {
      return;
    }
    found.push({ lineNumber: index + 1, marker: line.match(MARKER)?.[1] });
  });
  return found;
}
