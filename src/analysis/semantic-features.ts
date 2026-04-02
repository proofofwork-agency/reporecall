import type { CallEdge } from "./call-graph.js";
import type { ChunkFeature, ChunkTag, FileFeature } from "../storage/types.js";
import type { CodeChunk } from "../parser/types.js";

const SUBJECT_TAG_RULES: Array<{ tag: string; pattern: RegExp }> = [
  { tag: "auth", pattern: /\b(auth|login|signin|signout|oauth|session|token|credential)\b/i },
  { tag: "routing", pattern: /\b(route|router|redirect|navigation|callback|protected)\b/i },
  { tag: "billing", pattern: /\b(billing|checkout|subscription|invoice|payment|credit|portal|stripe)\b/i },
  { tag: "storage", pattern: /\b(storage|upload|bucket|media|file|signed url|blob)\b/i },
  { tag: "generation", pattern: /\b(generate|generation|image|render|queue|worker|thumbnail|preview)\b/i },
  { tag: "validation", pattern: /\b(validate|validation|check|assert|verify|guard)\b/i },
  { tag: "permissions", pattern: /\b(permission|role|policy|allow|deny|reject|protect)\b/i },
  { tag: "connection", pattern: /\b(connect|connection|edge|handle|link)\b/i },
  { tag: "schema", pattern: /\b(schema|compat|compatible|type matrix)\b/i },
];

const BOOLEAN_RETURN_RE = /:\s*boolean\b|=>\s*boolean\b|\breturn\s+(true|false)\b/;
const BRANCH_RE = /\bif\s*\(|\belse\s+if\b|\bswitch\s*\(|\bcase\s+/g;
const THROW_RE = /\bthrow\b/g;
const EARLY_RETURN_RE = /\breturn\s+(true|false|null|undefined)\b/g;
const NETWORK_RE = /\b(fetch|axios|request|client\.(get|post|put|patch|delete)|send|serve)\b/;
const STORAGE_RE = /\b(select|insert|update|delete|localStorage|sessionStorage|writeFile|readFile|bucket|from\()\b/;
const STATE_RE = /\b(set[A-Z][A-Za-z0-9_]*|dispatch|setState|store\.(set|update)|zustand|reducer)\b/;
const CONTROLLER_RE = /\b(controller|service|handler)\b/;
const REGISTRY_RE = /\b(registry|catalog|index|map of)\b/;
const UI_RE = /(?:^|\/)(components|pages)\//i;
const DOC_RE = /(?:^|\/)(docs?|documentation)\//i;
const TEST_RE = /(?:^|\/)(__tests__|test|tests|spec|specs|fixtures|mocks)\//i;

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function countGuardClauses(content: string): number {
  const head = content.split("\n").slice(0, 40).join("\n");
  return head.match(/\bif\s*\([^)]+\)\s*(?:\{?\s*)?(?:return|throw)\b/g)?.length ?? 0;
}

function normalizeTagWeight(
  chunk: CodeChunk,
  _tag: string,
  pattern: RegExp
): number {
  const fileAndName = `${chunk.filePath} ${chunk.name}`;
  if (pattern.test(fileAndName)) return 1;
  if (pattern.test(chunk.content.slice(0, 800))) return 0.65;
  return 0;
}

export function extractSemanticFeatures(
  chunks: Array<CodeChunk & { indexedAt: string; fileMtime?: string }>,
  callEdges: CallEdge[],
  callerCounts: Map<string, number>
): {
  chunkFeatures: ChunkFeature[];
  fileFeatures: FileFeature[];
  chunkTags: ChunkTag[];
} {
  const calleeCountByChunk = new Map<string, number>();
  const predicateCallCountByChunk = new Map<string, number>();

  for (const edge of callEdges) {
    calleeCountByChunk.set(edge.sourceChunkId, (calleeCountByChunk.get(edge.sourceChunkId) ?? 0) + 1);
    if (/^(is|has|can|should|are|validate|check|assert|verify|guard)/i.test(edge.targetName)) {
      predicateCallCountByChunk.set(
        edge.sourceChunkId,
        (predicateCallCountByChunk.get(edge.sourceChunkId) ?? 0) + 1
      );
    }
  }

  const chunkFeatures: ChunkFeature[] = [];
  const chunkTags: ChunkTag[] = [];
  const fileFeatureAccumulator = new Map<string, FileFeature>();

  for (const chunk of chunks) {
    const lowerContent = chunk.content.toLowerCase();
    const branchCount = countMatches(lowerContent, BRANCH_RE);
    const throwsCount = countMatches(lowerContent, THROW_RE);
    const earlyReturnCount = countMatches(lowerContent, EARLY_RETURN_RE);
    const guardCount = countGuardClauses(lowerContent);
    const isFunctionLike = /\b(function|method|arrow|generator|lexical)\b/.test(chunk.kind);
    const docLike = DOC_RE.test(chunk.filePath) || /\.(md|mdx|txt)$/i.test(chunk.filePath);
    const testLike = TEST_RE.test(chunk.filePath) || /\.(test|spec)\.[^.]+$/i.test(chunk.filePath);
    const isUiComponent = UI_RE.test(chunk.filePath) || (chunk.language === "tsx" && /^[A-Z]/.test(chunk.name));
    const isReactLike = isUiComponent || /^use[A-Z]/.test(chunk.name);
    const isRegistry = REGISTRY_RE.test(chunk.filePath) || REGISTRY_RE.test(chunk.name);
    const returnsBoolean = isFunctionLike && BOOLEAN_RETURN_RE.test(chunk.content);
    const isPredicate = !docLike
      && !testLike
      && !isRegistry
      && isFunctionLike
      && !isReactLike
      && (/^(is|has|can|should|are)[A-Z_]/.test(chunk.name) || (returnsBoolean && branchCount > 0));
    const isValidator = !docLike
      && !testLike
      && !isUiComponent
      && isFunctionLike
      && /(validate|check|assert|verify|compat)/i.test(chunk.name);
    const isGuard = !docLike
      && !testLike
      && isFunctionLike
      && !isReactLike
      && /(guard|allow|deny|reject|protect)/i.test(chunk.name);
    const isController = !docLike && !testLike && (CONTROLLER_RE.test(chunk.filePath) || CONTROLLER_RE.test(chunk.name));
    const writesState = STATE_RE.test(chunk.content);
    const writesNetwork = NETWORK_RE.test(chunk.content);
    const writesStorage = STORAGE_RE.test(chunk.content);

    const feature: ChunkFeature = {
      chunkId: chunk.id,
      filePath: chunk.filePath,
      returnsBoolean,
      branchCount,
      guardCount,
      throwsCount,
      earlyReturnCount,
      callsPredicateCount: predicateCallCountByChunk.get(chunk.id) ?? 0,
      callerCount: callerCounts.get(chunk.id) ?? 0,
      calleeCount: calleeCountByChunk.get(chunk.id) ?? 0,
      isPredicate,
      isValidator,
      isGuard,
      isController,
      isRegistry,
      isUiComponent,
      writesState,
      writesNetwork,
      writesStorage,
      docLike,
      testLike,
    };
    chunkFeatures.push(feature);

    const fileFeature = fileFeatureAccumulator.get(chunk.filePath) ?? {
      filePath: chunk.filePath,
      predicateCount: 0,
      validatorCount: 0,
      guardCount: 0,
      controllerCount: 0,
      registryCount: 0,
      uiComponentCount: 0,
      writesStateCount: 0,
      writesNetworkCount: 0,
      writesStorageCount: 0,
      docLike: false,
      testLike: false,
    };
    fileFeature.predicateCount += isPredicate ? 1 : 0;
    fileFeature.validatorCount += isValidator ? 1 : 0;
    fileFeature.guardCount += isGuard ? 1 : 0;
    fileFeature.controllerCount += isController ? 1 : 0;
    fileFeature.registryCount += isRegistry ? 1 : 0;
    fileFeature.uiComponentCount += isUiComponent ? 1 : 0;
    fileFeature.writesStateCount += writesState ? 1 : 0;
    fileFeature.writesNetworkCount += writesNetwork ? 1 : 0;
    fileFeature.writesStorageCount += writesStorage ? 1 : 0;
    fileFeature.docLike = fileFeature.docLike || docLike;
    fileFeature.testLike = fileFeature.testLike || testLike;
    fileFeatureAccumulator.set(chunk.filePath, fileFeature);

    for (const rule of SUBJECT_TAG_RULES) {
      const weight = normalizeTagWeight(chunk, rule.tag, rule.pattern);
      if (weight > 0) {
        chunkTags.push({
          chunkId: chunk.id,
          filePath: chunk.filePath,
          tag: rule.tag,
          weight,
        });
      }
    }

    if (isPredicate || isValidator || isGuard) {
      chunkTags.push({
        chunkId: chunk.id,
        filePath: chunk.filePath,
        tag: "decision",
        weight: 0.9,
      });
    }
  }

  return {
    chunkFeatures,
    fileFeatures: Array.from(fileFeatureAccumulator.values()),
    chunkTags,
  };
}
