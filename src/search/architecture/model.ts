import type { TargetKind } from "../../storage/types.js";
import type { SearchResult } from "../types.js";
import {
  GENERIC_BROAD_TERMS,
  type ExpandedQueryTerm,
  type ExecutionSurfaceBias,
} from "../utils.js";
export {
  INVENTORY_GENERIC_TARGET_ALIAS_TERMS,
  INVENTORY_STRUCTURAL_TERMS,
  ADJACENT_WORKFLOW_FAMILIES,
} from "../shared/workflow-families.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BROAD_PHRASE_GENERIC_TERMS = GENERIC_BROAD_TERMS;

export const BROAD_INVENTORY_RE =
  /\b(?:which|what|list|show)\s+files\b|\bfiles?\s+(?:implement|handle|power|control|cover)\b/i;

export const SUBSYSTEM_INVENTORY_FAMILIES = new Set(["search"]);

export const STRICT_WORKFLOW_FAMILY_COHESION = new Set([
  "auth",
  "routing",
  "billing",
  "storage",
  "generation",
  "workflow",
]);

// ---------------------------------------------------------------------------
// Types / interfaces
// ---------------------------------------------------------------------------

export interface CompiledConceptBundle {
  kind: string;
  pattern: RegExp;
  symbols: string[];
  maxChunks: number;
}

export function compileConceptBundles(
  bundles: Array<{ kind: string; pattern: string; symbols: string[]; maxChunks: number }>
): CompiledConceptBundle[] {
  if (!bundles) return [];
  return bundles.map((b) => ({
    kind: b.kind,
    pattern: new RegExp(b.pattern, "i"),
    symbols: b.symbols,
    maxChunks: b.maxChunks,
  }));
}

export interface BroadWorkflowCandidate {
  result: SearchResult;
  score: number;
  layers: string[];
  matchedFamilies: string[];
  matchedWeight: number;
  genericOnly: boolean;
  utilityLike: boolean;
  directAnchorCount: number;
  coreAnchorCount: number;
  phraseMatchCount: number;
  callbackNoise: boolean;
}

export interface BroadTargetCandidate {
  result: SearchResult;
  score: number;
  subsystem?: string;
}

export interface BroadFileCandidate {
  filePath: string;
  primary: BroadWorkflowCandidate;
  chunks: BroadWorkflowCandidate[];
  score: number;
  layers: string[];
  matchedFamilies: string[];
  directAnchorCount: number;
  coreAnchorCount: number;
  phraseMatchCount: number;
  utilityLike: boolean;
  callbackNoise: boolean;
  genericOnly: boolean;
}

export interface BroadQueryProfile {
  expandedTerms: ExpandedQueryTerm[];
  anchorTerms: ExpandedQueryTerm[];
  familyTerms: ExpandedQueryTerm[];
  allowedFamilies: Set<string>;
  phrases: string[];
  tokens: string[];
  inventoryMode: boolean;
  lifecycleMode: boolean;
  workflowTraceMode: boolean;
  surfaceBias: ExecutionSurfaceBias;
}

export type BroadMode = "inventory" | "workflow";

export interface BroadSelectedFileDiagnostic {
  filePath: string;
  selectionSource: string;
}

export interface BroadSelectionDiagnostics {
  broadMode: BroadMode;
  dominantFamily?: string;
  deliveryMode: "code_context" | "summary_only";
  familyConfidence?: number;
  selectedFiles: BroadSelectedFileDiagnostic[];
  fallbackReason?: string;
  deferredReason?: string;
}

export interface InventoryFileCandidate extends BroadFileCandidate {
  selectionSource: string;
  targetKind?: TargetKind;
  importCorroboration: number;
  subsystemMatch: boolean;
}

// ---------------------------------------------------------------------------
// ArchitectureStrategy class
// ---------------------------------------------------------------------------
