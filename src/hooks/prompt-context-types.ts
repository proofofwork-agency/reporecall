import type { AssembledContext } from "../search/types.js";
import type { QueryMode } from "../search/intent.js";
import type { MemoryClass, MemoryRoute, MemorySearchResult } from "../memory/types.js";
import type { ExecutionSurface } from "../search/utils.js";
import type { BusinessContextPage, ProductAreaContext } from "../business/product-areas.js";
export interface PromptContextResult {
  context: AssembledContext | null;
  resolvedQueryMode: QueryMode;
  deliveryMode?: "code_context" | "summary_only";
  contextStrength?: "sufficient" | "partial" | "weak";
  executionSurface?: ExecutionSurface | "mixed";
  dominantFamily?: string;
  familyConfidence?: number;
  evidenceConfidence?: number;
  selectedFiles?: Array<{
    filePath: string;
    selectionSource: string;
    selectionReason?: string;
    wikiPagesUsed?: string[];
  }>;
  deferredReason?: string;
  missingEvidence?: string[];
  recommendedNextReads?: string[];
  advisoryText?: string;
  memoryRoute?: MemoryRoute;
  memoryTokenCount?: number;
  memoryCount?: number;
  memoryNames?: string[];
  memoryResults?: MemorySearchResult[];
  memorySelected?: Array<{
    name: string;
    class: MemoryClass;
    score: number;
    summary: string;
  }>;
  memoryDropped?: Array<{
    name: string;
    class: MemoryClass;
    reason: string;
  }>;
  memoryClassTokens?: Record<MemoryClass, number>;
  memoryClassCounts?: Record<MemoryClass, number>;
  memoryBudget?: {
    total: number;
    used: number;
    remaining: number;
    codeFloorRatio: number;
    classBudgets: Record<MemoryClass, number>;
  };
  capabilityEvidenceEnabled?: boolean;
  genericCapabilityHydrationEnabled?: boolean;
  genericCapabilityHydrated?: boolean;
  wikiTokenCount?: number;
  wikiPageCount?: number;
  wikiPageNames?: string[];
  wikiPagesUsed?: string[];
  productAreaTokenCount?: number;
  productAreasUsed?: ProductAreaContext[];
  businessPagesUsed?: BusinessContextPage[];
}
