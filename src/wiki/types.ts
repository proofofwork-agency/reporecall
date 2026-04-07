/**
 * Wiki layer types for Reporecall.
 *
 * Wiki pages are memories with `type: "wiki"`. These types extend
 * the memory system with wiki-specific concepts.
 */

export type { WikiPageType, WikiSourceLayer } from "../memory/parser.js";

/** A link between two wiki pages (persisted in wiki_links table). */
export interface WikiLink {
  fromName: string;
  toName: string;
}

/** Result from wiki staleness detection. */
export interface WikiStalenessResult {
  name: string;
  stale: boolean;
  sourceCommit: string;
  changedFiles: string[];
}

/** Input for writing a wiki page via the file system. */
export interface WikiPageInput {
  name: string;
  description: string;
  pageType: import("../memory/parser.js").WikiPageType;
  sourceLayer: import("../memory/parser.js").WikiSourceLayer;
  content: string;
  summary: string;
  relatedFiles: string[];
  relatedSymbols: string[];
  links: string[];
  sourceCommit: string;
  confidence: number;
}
