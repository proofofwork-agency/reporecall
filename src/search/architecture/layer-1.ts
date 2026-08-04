import type { StoredChunk } from "../../storage/types.js";
import type { SearchResult } from "../types.js";
import { normalizeTargetText } from "../targets.js";
import { isTestFile } from "../utils.js";
import { chunkToSearchResult, isImplementationPath } from "../shared/mappers.js";
import { type CompiledConceptBundle, type BroadFileCandidate, type BroadQueryProfile } from "./model.js";
import { ArchitectureStrategyBase } from "./base.js";

export abstract class ArchitectureStrategyLayer1 extends ArchitectureStrategyBase {
  abstract scoreBroadWorkflowCandidate(
    result: SearchResult,
    profile: BroadQueryProfile
  ): import("./model.js").BroadWorkflowCandidate;

  detectWorkflowLayers(filePath: string, name: string): string[] {
    const layers: string[] = [];
    const lowerPath = filePath.toLowerCase();
    const lowerName = name.toLowerCase();
    const text = normalizeTargetText(`${filePath} ${name}`);

    if (/(?:^|\/)(src\/)?(pages|components|screens|views|app)\//.test(lowerPath) || /\b(page|modal|dialog|screen|view|layout)\b/.test(text)) {
      layers.push("ui");
    }
    if (/(?:^|\/)(hooks|store|state|session|context|providers?)\//.test(lowerPath) || /\b(use[a-z]|provider|session|state|context)\b/.test(lowerName)) {
      layers.push("state");
    }
    if (/\b(route|router|routing|redirect|callback|guard|protected|middleware)\b/.test(text)) {
      layers.push("routing");
    }
    if (/(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lowerPath) || /\b(api|server|handler|request|controller|service)\b/.test(text)) {
      layers.push("backend");
    }
    if (/(?:^|\/)(lib|shared|core|utils?)\//.test(lowerPath) || /\b(error|util|helper|type)\b/.test(text)) {
      layers.push("shared");
    }
    if (layers.length === 0) layers.push("core");
    return layers;
  }

  isUtilityLikePath(lowerPath: string, lowerName: string): boolean {
    return /(?:^|\/)(lib|shared|core|utils?|helpers?|types?)\//.test(lowerPath)
      || /\b(utils?|helpers?|types?|errors?)\b/.test(lowerName);
  }

  isObservabilitySidecarPath(lowerPath: string, lowerName: string): boolean {
    const text = `${lowerPath} ${lowerName}`;
    return /\b(metrics?|logger|logging|telemetry|audit|trace|rotating\s*log)\b/.test(text)
      || /(?:^|\/)(metrics|logger|logging|telemetry)\.ts$/.test(lowerPath)
      || /rotating-log/.test(lowerPath);
  }

  isBroadOrchestratorLikePath(lowerPath: string, lowerName: string): boolean {
    const text = `${lowerPath} ${lowerName}`;
    return /\b(orchestr|pipeline|engine|manager|router|dispatcher|coordinator|hybrid|core)\b/.test(text)
      || /(?:^|\/)(index|main|entry)\.[a-z0-9]+$/i.test(lowerPath);
  }

  // -------------------------------------------------------------------------
  // Import neighbors
  // -------------------------------------------------------------------------

  collectBroadImportNeighbors(filePath: string): string[] {
    const neighbors = new Set<string>();
    if (typeof this.metadata.getImportsForFile === "function") {
      for (const record of this.metadata.getImportsForFile(filePath)) {
        if (record.resolvedPath) neighbors.add(record.resolvedPath);
      }
    }
    if (typeof this.metadata.findImporterFiles === "function") {
      for (const importer of this.metadata.findImporterFiles(filePath)) {
        neighbors.add(importer);
      }
    }
    neighbors.delete(filePath);
    return Array.from(neighbors);
  }

  // -------------------------------------------------------------------------
  // Build file candidate from path
  // -------------------------------------------------------------------------

  buildBroadFileCandidateFromFilePath(
    filePath: string,
    profile: BroadQueryProfile
  ): BroadFileCandidate | null {
    if (isTestFile(filePath)) return null;
    const chunks = this.metadata
      .findChunksByFilePath(filePath)
      .filter((chunk) => chunk.kind !== "file")
      .map((chunk) => this.scoreBroadWorkflowCandidate(this.chunkToSearchResult(chunk, 0.5), profile))
      .sort((a, b) => b.score - a.score);
    if (chunks.length === 0) return null;

    const primary = chunks[0];
    if (!primary) return null;
    const layers = Array.from(new Set(chunks.flatMap((candidate) => candidate.layers)));
    const matchedFamilies = Array.from(new Set(chunks.flatMap((candidate) => candidate.matchedFamilies)));
    const directAnchorCount = Math.max(...chunks.map((candidate) => candidate.directAnchorCount));
    const coreAnchorCount = Math.max(...chunks.map((candidate) => candidate.coreAnchorCount));
    const phraseMatchCount = Math.max(...chunks.map((candidate) => candidate.phraseMatchCount));
    const callbackNoise = chunks.every((candidate) => candidate.callbackNoise);
    const utilityLike = primary.utilityLike && matchedFamilies.length === 0;
    const genericOnly = chunks.every((candidate) => candidate.genericOnly);
    const corroboratingChunks = chunks.filter((candidate) =>
      candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0 || candidate.matchedFamilies.length > 0
    ).length;
    const layerCoverage = layers.filter((layer) => layer !== "shared" && layer !== "core").length;

    let score = primary.score;
    score += Math.min(0.45, (corroboratingChunks - 1) * 0.12);
    score += Math.min(0.35, layerCoverage * 0.1);
    score += Math.min(0.28, matchedFamilies.length * 0.08);
    if (directAnchorCount >= 2) score += 0.2;
    if (profile.inventoryMode && coreAnchorCount === 0 && matchedFamilies.length === 0) score -= 0.55;
    if (profile.inventoryMode && coreAnchorCount > 0) score += Math.min(0.24, coreAnchorCount * 0.12);
    if (phraseMatchCount > 0) score += Math.min(0.25, phraseMatchCount * 0.12);
    if (utilityLike) score -= 0.2;
    if (callbackNoise) score -= 0.5;

    return {
      filePath,
      primary,
      chunks,
      score,
      layers,
      matchedFamilies,
      directAnchorCount,
      coreAnchorCount,
      phraseMatchCount,
      utilityLike,
      callbackNoise,
      genericOnly,
    };
  }

  // -------------------------------------------------------------------------
  // Merge broad results
  // -------------------------------------------------------------------------

  mergeBroadResults(targetResults: SearchResult[], results: SearchResult[]): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const result of [...targetResults, ...results]) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) {
        byId.set(result.id, result);
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }

  // -------------------------------------------------------------------------
  // Private helpers (duplicated from HybridSearch for self-containment)
  // -------------------------------------------------------------------------

  protected chunkToSearchResult(chunk: StoredChunk, score: number): SearchResult {
    return chunkToSearchResult(chunk, score);
  }

  protected isImplementationPath(filePath: string): boolean {
    return isImplementationPath(filePath, this.config.implementationPaths ?? ["src/", "lib/", "bin/"]);
  }

  protected getMatchedConceptBundles(query: string): CompiledConceptBundle[] {
    return this.conceptBundles.filter((bundle) => bundle.pattern.test(query));
  }

  protected selectConceptChunks(symbols: string[], maxChunks?: number): StoredChunk[] {
    const nameOrder = new Map(symbols.map((name, index) => [name, index]));
    const bestByName = new Map<string, StoredChunk>();

    for (const chunk of this.metadata.findChunksByNames(symbols)) {
      const existing = bestByName.get(chunk.name);
      if (!existing || this.compareConceptChunks(chunk, existing) < 0) {
        bestByName.set(chunk.name, chunk);
      }
    }

    const ordered = Array.from(bestByName.values()).sort((a, b) => {
      const orderDiff = (nameOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER)
        - (nameOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER);
      if (orderDiff !== 0) return orderDiff;
      return a.filePath.localeCompare(b.filePath);
    });
    return typeof maxChunks === "number" ? ordered.slice(0, maxChunks) : ordered;
  }

  protected compareConceptChunks(a: StoredChunk, b: StoredChunk): number {
    const implDiff = Number(this.isImplementationPath(b.filePath))
      - Number(this.isImplementationPath(a.filePath));
    if (implDiff !== 0) return implDiff;

    const testDiff = Number(isTestFile(a.filePath))
      - Number(isTestFile(b.filePath));
    if (testDiff !== 0) return testDiff;

    return a.filePath.localeCompare(b.filePath);
  }
}
