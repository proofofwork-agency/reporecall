import type { StoredChunk } from "../storage/types.js";

export function tokenizeFlowAssemblyQuery(query?: string): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function countFlowQueryMatches(terms: string[], ...texts: Array<string | undefined>): number {
  if (terms.length === 0) return 0;
  const haystack = texts
    .filter((text): text is string => !!text)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]/g, " ");
  let count = 0;
  for (const term of terms) {
    const prefix = term.length >= 6 ? term.slice(0, 4) : term;
    if (haystack.includes(term) || (prefix.length >= 4 && haystack.includes(prefix))) count++;
  }
  return count;
}

function commonFlowPathPrefixLength(left: string, right: string): number {
  const leftParts = left.toLowerCase().split("/").filter(Boolean);
  const rightParts = right.toLowerCase().split("/").filter(Boolean);
  let count = 0;
  while (count < leftParts.length && count < rightParts.length && leftParts[count] === rightParts[count]) {
    count++;
  }
  return count;
}

export function inferFlowFamilies(queryTerms: string[]) {
  return {
    auth: queryTerms.some((term) => /^auth|token|session|login|signin|credential|callback|redirect|protect/.test(term)),
    generation: queryTerms.some((term) => /^image|generate|generation|render|shot|regen/.test(term)),
    billing: queryTerms.some((term) => /^bill|checkout|portal|subscription|invoice|payment|credit|customer/.test(term)),
    upload: queryTerms.some((term) => /^upload|storage|media|signed|bucket|file/.test(term)),
  };
}

export function scoreFlowChunkAffinity(
  chunk: StoredChunk,
  seedChunk: StoredChunk,
  queryTerms: string[],
  families: ReturnType<typeof inferFlowFamilies>,
  direction: "caller" | "callee",
  implementationFirst: boolean,
  callerFocused: boolean,
  nodeDepth: number = 99
): number {
  let score = 0;
  const sameFile = chunk.filePath === seedChunk.filePath;
  const prefix = commonFlowPathPrefixLength(seedChunk.filePath, chunk.filePath);
  const queryMatches = countFlowQueryMatches(
    queryTerms,
    chunk.filePath,
    chunk.name,
    chunk.parentName,
    chunk.docstring
  );
  const fileText = `${chunk.filePath} ${chunk.name} ${chunk.parentName ?? ""}`.toLowerCase();
  const sharedFile = /(?:^|\/)_shared\//.test(chunk.filePath);
  const seedInHooks = /(?:^|\/)hooks\//.test(seedChunk.filePath);
  const seedInEndpoint = /supabase\/functions\//.test(seedChunk.filePath);
  const candidateInUi = /(?:^|\/)(pages|components|routes)\//.test(chunk.filePath);
  const candidateInClient = /^src\//.test(chunk.filePath);

  if (sameFile) score += 140;
  score += prefix * 18;
  score += queryMatches * 35;

  if (implementationFirst) {
    if (direction === "callee") score += 8;
    if (direction === "caller") score -= 8;
  }
  if (callerFocused) {
    if (direction === "caller") score += 40;
    if (direction === "callee") score -= 10;
  }
  if (implementationFirst && direction === "caller" && !callerFocused) {
    if (seedInHooks && candidateInUi && queryMatches < 2) score -= 70;
    if (seedInEndpoint && candidateInClient && queryMatches < 2) score -= 75;
  }
  // Penalize generic workers and shared middleware when the query isn't about them
  if (/\/workers\//.test(chunk.filePath) && !queryTerms.some((t) => /\bworker\b/.test(t))) {
    score -= 150;
  }
  if (/\/(?:cors|rate[-_]?limit)[^/]*\./.test(chunk.filePath) && !queryTerms.some((t) => /\b(cors|rate|limit|middleware)\b/.test(t)) && queryMatches < 1) {
    score -= 100;
  }
  // For hook seeds: suppress callers with zero query-term overlap (they are just importers, not related)
  if (seedInHooks && direction === "caller" && queryMatches === 0) {
    score -= 100;
  }

  if (families.auth) {
    if (/(auth|callback|protected|session|login|signin|redirect|token)/.test(fileText)) score += 30;
    if (/(storage|analytics|project|dashboard|admin)/.test(fileText)) score -= 35;
    if (/(?:cors|rate[-_]?limit|logger)/.test(fileText)) score -= 25;
  }
  if (families.generation) {
    if (/(generate|generation|render|image|shot|regener)/.test(fileText)) score += 30;
    if (/(upload|storage|media|bucket)/.test(fileText)) score -= 25;
  }
  if (families.billing) {
    if (/(billing|checkout|portal|subscription|invoice|payment|customer|credit)/.test(fileText)) score += 28;
    if (/(analytics|dashboard|project)/.test(fileText)) score -= 20;
  }
  if (families.upload) {
    if (/(upload|storage|media|signed|bucket|file)/.test(fileText)) score += 24;
    if (families.auth && /auth/.test(fileText)) score += 18;
  }

  if (sharedFile && queryMatches === 0 && !families.auth && !families.billing && !families.generation && !families.upload) {
    score -= 22;
  }
  // Skip harsh penalty for direct neighbors (depth 1) — they're in the call graph and always relevant
  if (queryTerms.length > 0 && !sameFile && prefix < 2 && queryMatches === 0 && nodeDepth > 1) score -= 60;
  if (/schema|migration|fixture|example|test|spec/i.test(chunk.filePath)) score -= 120;

  return score;
}
