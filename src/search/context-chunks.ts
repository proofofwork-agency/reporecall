import type { SearchResult } from "./types.js";
import type { StoredChunk } from "../storage/types.js";

function longestBacktickRun(content: string): number {
  let longest = 0;
  let current = 0;
  for (const ch of content) {
    if (ch === "`") {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

export function formatChunk(result: SearchResult): string {
  const lang = result.language || "";
  const location = `Lines ${result.startLine}-${result.endLine}: ${result.kind} ${result.name}`;
  const fence = "`".repeat(Math.max(3, longestBacktickRun(result.content) + 1));
  return `${fence}${lang}\n// ${location}\n${result.content}\n${fence}\n`;
}

// --- Metadata-aware chunk type for hydration ---

export interface HydratableMetadata {
  getChunksByIds(ids: string[]): StoredChunk[];
}

export function storedChunkToSearchResult(chunk: StoredChunk, score: number = 1.0): SearchResult {
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
    language: chunk.language,
  };
}
