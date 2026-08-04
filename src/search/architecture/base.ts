import type { MemoryConfig } from "../../core/config.js";
import type { MetadataStore } from "../../storage/metadata-store.js";
import type { FTSStore } from "../../storage/fts-store.js";
import { compileConceptBundles, type BroadSelectionDiagnostics, type CompiledConceptBundle } from "./model.js";

export class ArchitectureStrategyBase {
  protected metadata: MetadataStore;
  protected config: MemoryConfig;
  protected fts: FTSStore;
  protected conceptBundles: CompiledConceptBundle[];
  lastBroadSelection: BroadSelectionDiagnostics | null = null;

  constructor(deps: {
    metadata: MetadataStore;
    config: MemoryConfig;
    ftsStore: FTSStore;
  }) {
    this.metadata = deps.metadata;
    this.config = deps.config;
    this.fts = deps.ftsStore;
    this.conceptBundles = compileConceptBundles(deps.config.conceptBundles);
  }

  updateStores(metadata: MetadataStore, fts: FTSStore): void {
    this.metadata = metadata;
    this.fts = fts;
  }
}
