import type { HybridSearch } from "../search/hybrid.js";
import type { MemoryConfig } from "../core/config.js";
import type { AssembledContext } from "../search/types.js";

export async function handlePromptContext(
  query: string,
  search: HybridSearch,
  config: MemoryConfig,
  activeFiles?: string[],
  signal?: AbortSignal
): Promise<AssembledContext | null> {
  if (!query.trim()) return null;

  return search.searchWithContext(query, config.contextBudget, activeFiles, signal);
}
