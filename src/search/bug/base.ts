import type { MemoryConfig } from "../../core/config.js";
import type { FTSStore } from "../../storage/fts-store.js";
import type { MetadataStore } from "../../storage/metadata-store.js";
import { type BugStrategyDeps } from "./model.js";

export class BugStrategyBase {
  protected metadata: MetadataStore;
  protected config: MemoryConfig;
  // Stored for updateStores symmetry with other strategy classes.
  // Not read internally today but callers may need it in the future.
  protected _fts: FTSStore;

  constructor(deps: BugStrategyDeps) {
    this.metadata = deps.metadata;
    this.config = deps.config;
    this._fts = deps.fts;
  }

  /** Allow updating stores after hot-reload / rebuild. */
  updateStores(metadata: MetadataStore, fts: FTSStore): void {
    this.metadata = metadata;
    this._fts = fts;
  }

  /** Expose the FTS store for callers that need it. */
  get fts(): FTSStore {
    return this._fts;
  }

  // =========================================================================
  // Public entry-points (matching HybridSearch method signatures)
  // =========================================================================
}
