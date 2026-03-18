import type { ImportRecord } from "../storage/import-store.js";
import type { StoredChunk } from "../storage/types.js";

const SELF_REFS = new Set(["this", "self", "super"]);

/**
 * Minimal interface for the metadata facade methods required by resolveCallTarget.
 * This avoids a hard dependency on MetadataStore, making the function easy to test.
 */
export interface ResolutionContext {
  findImportByName(name: string, filePath?: string): ImportRecord[];
  findChunksByNames(names: string[]): StoredChunk[];
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
  edge: { targetName: string; filePath: string; receiver?: string },
  metadata: ResolutionContext
): string | null {
  // 1. Check imports for target name
  const targetImports = metadata.findImportByName(edge.targetName, edge.filePath);
  for (const imp of targetImports) {
    if (imp.resolvedPath) return imp.resolvedPath;
  }

  // 2. Check imports for receiver (skip self-references)
  if (edge.receiver && !SELF_REFS.has(edge.receiver)) {
    const receiverImports = metadata.findImportByName(edge.receiver, edge.filePath);
    for (const imp of receiverImports) {
      if (imp.resolvedPath) return imp.resolvedPath;
    }
  }

  // 3. Check same-file: look for a chunk with the target name in the same file
  const matchingChunks = metadata.findChunksByNames([edge.targetName]);
  for (const chunk of matchingChunks) {
    if (chunk.filePath === edge.filePath) return edge.filePath;
  }

  // 4. Fallback
  return null;
}
