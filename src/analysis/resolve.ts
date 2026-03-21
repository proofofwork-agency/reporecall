import type { ImportRecord } from "../storage/import-store.js";
import type { ResolvedTargetAliasHit, StoredChunk, TargetKind } from "../storage/types.js";
import { buildLiteralAliasCandidates, normalizeTargetText } from "../search/targets.js";

const SELF_REFS = new Set(["this", "self", "super"]);

/**
 * Minimal interface for the metadata facade methods required by resolveCallTarget.
 * This avoids a hard dependency on MetadataStore, making the function easy to test.
 */
export interface ResolutionContext {
  findImportByName(name: string, filePath?: string): ImportRecord[];
  findChunksByNames(names: string[]): StoredChunk[];
  resolveTargetAliases(normalizedAliases: string[], limit?: number, kinds?: TargetKind[]): ResolvedTargetAliasHit[];
}

export interface ResolvedCallTarget {
  filePath: string;
  targetId?: string;
  targetKind?: TargetKind;
  resolutionSource: "import" | "same_file" | "alias_literal" | "alias_path" | "symbol";
}

/**
 * Resolves the target file path for a call edge at index time.
 *
 * Resolution algorithm (first match wins):
 * 1. Check imports for the target name — if found with a resolvedPath, return it.
 * 2. Check imports for the receiver (if present and not a self-reference (this, self, super)) — the method
 *    belongs to the imported module/class, so return the receiver's resolvedPath.
 * 3. Check same-file — look for a chunk with the target name in the same file.
 * 4. Fallback — return null.
 *
 * @param edge - The call edge to resolve
 * @param metadata - Resolution context providing import and chunk lookups
 * @returns The resolved file path or null if unresolvable
 */
export function resolveCallTarget(
  edge: { targetName: string; filePath: string; receiver?: string; literalTargets?: string[] },
  metadata: ResolutionContext
): ResolvedCallTarget | null {
  // 1. Check imports for target name
  const targetImports = metadata.findImportByName(edge.targetName, edge.filePath);
  for (const imp of targetImports) {
    if (imp.resolvedPath) {
      return { filePath: imp.resolvedPath, resolutionSource: "import" };
    }
  }

  // 2. Check imports for receiver (skip self-references)
  if (edge.receiver && !SELF_REFS.has(edge.receiver)) {
    const receiverImports = metadata.findImportByName(edge.receiver, edge.filePath);
    for (const imp of receiverImports) {
      if (imp.resolvedPath) {
        return { filePath: imp.resolvedPath, resolutionSource: "import" };
      }
    }
  }

  // 3. Check same-file: look for a chunk with the target name in the same file
  const matchingChunks = metadata.findChunksByNames([edge.targetName]);
  for (const chunk of matchingChunks) {
    if (chunk.filePath === edge.filePath) {
      return { filePath: edge.filePath, resolutionSource: "same_file" };
    }
  }

  // 4. Resolve literal-dispatch aliases such as invoke("generate-image")
  if (edge.literalTargets && edge.literalTargets.length > 0) {
    const aliasHits = metadata.resolveTargetAliases(buildLiteralAliasCandidates(edge.literalTargets), 8);
    const firstFileBacked = aliasHits.find((hit) => hit.target.kind !== "symbol") ?? aliasHits[0];
    if (firstFileBacked) {
      return {
        filePath: firstFileBacked.target.filePath,
        targetId: firstFileBacked.target.id,
        targetKind: firstFileBacked.target.kind,
        resolutionSource: "alias_literal",
      };
    }
  }

  // 5. Path/name alias fallback using the callee name itself (require minimum weight)
  const pathHits = metadata.resolveTargetAliases([normalizeTargetText(edge.targetName)], 8);
  const firstFileBacked = pathHits.find((hit) => hit.target.kind !== "symbol" && hit.weight >= 0.7);
  if (firstFileBacked) {
    return {
      filePath: firstFileBacked.target.filePath,
      targetId: firstFileBacked.target.id,
      targetKind: firstFileBacked.target.kind,
      resolutionSource: "alias_path",
    };
  }

  // 6. Fallback
  return null;
}
