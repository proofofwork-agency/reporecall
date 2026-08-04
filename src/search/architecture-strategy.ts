import type { SearchResult } from "./types.js";
import { normalizeTargetText } from "./targets.js";
import { isTestFile } from "./utils.js";
import { chunkToSearchResult } from "./shared/mappers.js";
import { ArchitectureStrategyLayer6 } from "./architecture/layer-6.js";

export * from "./architecture/model.js";

export class ArchitectureStrategy extends ArchitectureStrategyLayer6 {
  compactGenerationBackbone(
    query: string,
    results: SearchResult[]
  ): SearchResult[] {
    const normalizedQuery = normalizeTargetText(query);
    const generationQuery =
      /\b(image|storyboard|shot)\b/.test(normalizedQuery)
      && /\b(generate|generation|regenerate|regeneration|render)\b/.test(normalizedQuery);
    if (!generationQuery) return results;

    const hydrated: SearchResult[] = [];
    if (typeof this.metadata.resolveTargetAliases === "function") {
      const hits = this.metadata.resolveTargetAliases(
        ["storyboard generation", "storyboard controller", "generate image"],
        60,
        ["file_module", "endpoint", "symbol"]
      );
      for (const hit of hits) {
        const filePath = hit.target.filePath;
        if (isTestFile(filePath)) continue;
        const chunks = hit.target.ownerChunkId
          ? this.metadata.getChunksByIds([hit.target.ownerChunkId])
          : this.metadata.findChunksByFilePath(filePath);
        const chunk = chunks
          .filter((candidate) => candidate.kind !== "file")
          .sort((a, b) => {
            const aSpan = a.endLine - a.startLine;
            const bSpan = b.endLine - b.startLine;
            return bSpan - aSpan;
          })[0];
        if (chunk) hydrated.push(chunkToSearchResult(chunk, 0.8));
      }
    }

    const candidates = new Map<string, SearchResult>();
    for (const result of [...results, ...hydrated]) {
      const existing = candidates.get(result.filePath);
      if (!existing || result.score > existing.score) candidates.set(result.filePath, result);
    }
    const values = Array.from(candidates.values());
    const findRole = (pathPattern: RegExp, textPattern: RegExp): SearchResult | undefined =>
      values.find((candidate) =>
        pathPattern.test(candidate.filePath)
        && textPattern.test(normalizeTargetText(`${candidate.filePath} ${candidate.name}`))
      );
    const store = findRole(
      /(?:^|\/)(?:store|stores|state)\//i,
      /\b(storyboard|shot).*(generation|generate|regenerate)|(generation|generate|regenerate).*(storyboard|shot)\b/
    );
    const hook = findRole(
      /(?:^|\/)hooks?\//i,
      /\b(storyboard|shot).*(generation|generate|regenerate)|(generation|generate|regenerate).*(storyboard|shot)\b/
    );
    const controller = values.find((candidate) =>
      /(?:^|\/)storyboard-controller(?:\/|$)/i.test(candidate.filePath)
    );
    const generationEndpoint = values.find((candidate) =>
      /(?:^|\/)generate-image(?:\/|$)/i.test(candidate.filePath)
    );
    const compact = [store, hook, controller, generationEndpoint]
      .filter((candidate): candidate is SearchResult => !!candidate);
    if (compact.length < 3 || !controller || !generationEndpoint) return results;

    return compact.map((result, index) => ({
      ...result,
      score: Math.max(0.65, 1 - index * 0.08),
      hookScore: Math.max(0.65, 1 - index * 0.08),
      selectionSource: "workflow_bundle",
      selectionReason: "cohesive_generation_backbone",
    }));
  }
}
