import type { StoredChunk } from "../../storage/types.js";
import type { SearchResult } from "../types.js";

export function chunkToSearchResult(chunk: StoredChunk, score: number): SearchResult {
  return {
    id: chunk.id,
    score,
    filePath: chunk.filePath,
    name: chunk.name,
    kind: chunk.kind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    docstring: chunk.docstring,
    parentName: chunk.parentName,
    language: chunk.language ?? "",
  };
}

export function isImplementationPath(
  filePath: string,
  implementationPaths: string[] = ["src/", "lib/", "bin/"],
): boolean {
  const lowerPath = filePath.toLowerCase();
  if (implementationPaths.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()))) return true;
  return /(?:^|\/)(src|lib|bin|app|server|api|functions|handlers|controllers|services|supabase)\//.test(lowerPath);
}
