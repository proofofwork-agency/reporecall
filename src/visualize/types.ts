/**
 * Types for the Reporecall Lens architecture dashboard.
 */

export interface DashboardMeta {
  projectName: string;
  generatedAt: string;
  totalSymbols: number;
  totalFiles: number;
  totalEdges: number;
  graphDetails?: {
    included: boolean;
    reason: "within_limit" | "too_many_chunks";
    totalChunks: number;
    maxGraphChunks: number;
    edgeCount: number;
  };
  communityCount: number;
  wikiPageCount: number;
  businessPageCount: number;
  productAreaCount: number;
  hubCount: number;
  surpriseCount: number;
}

export interface MemberViz {
  name: string;
  kind: string;
  filePath: string;
  degree: number;
}

export interface CrossEdgeViz {
  targetCommunityId: string;
  targetLabel: string;
  count: number;
}

export interface CommunityViz {
  id: string;
  label: string;
  nodeCount: number;
  cohesion: number;
  color: string;
  members: MemberViz[];
  crossEdges: CrossEdgeViz[];
  wikiSlug: string | null;
}

export interface CallerCalleeViz {
  name: string;
  filePath: string;
  callType: string;
}

export interface HubViz {
  name: string;
  degree: number;
  filePath: string;
  communityId: string | null;
  communityLabel: string | null;
  communityColor: string;
  callers: CallerCalleeViz[];
  callees: CallerCalleeViz[];
  wikiMentions: string[];
}

export interface SurpriseViz {
  sourceName: string;
  sourceFile: string;
  targetName: string;
  targetFile: string;
  score: number;
  reasons: string[];
  sourceCommunity: string | null;
  targetCommunity: string | null;
}

export interface QuestionViz {
  type: string;
  question: string;
  why: string;
}

export interface WikiPageViz {
  name: string;
  pageType: string;
  description: string;
  summary: string;
  content: string;
  links: string[];
  backlinks: string[];
  relatedSymbols: string[];
  relatedFiles: string[];
  confidence: number;
  sourceCommit: string;
}

export interface WikiGraphNodeViz {
  name: string;
  pageType: string;
  title: string;
  summary: string;
  confidence: number;
  relatedFiles: string[];
  relatedSymbols: string[];
}

export interface WikiGraphEdgeViz {
  source: string;
  target: string;
  relation: string;
}

export interface BusinessPageViz {
  name: string;
  capability: string;
  displayName: string;
  description: string;
  summary: string;
  displaySummary: string;
  displayQuality: "high" | "medium" | "low" | "fallback";
  presentationSafe: boolean;
  presentationIssues: string[];
  actor: string;
  trigger: string;
  businessTerms: string[];
  userActions: string[];
  decisionPoints: string[];
  sideEffects: string[];
  businessOutcome: string;
  dataConcepts: string[];
  externalSystems: string[];
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  supportingFiles: string[];
  supportingSymbols: string[];
  technicalEvidence: {
    files: string[];
    symbols: string[];
  };
  links: string[];
  content: string;
}

export interface ProductAreaViz {
  id: string;
  name: string;
  displayName: string;
  areaKind: "fixed" | "discovered" | "fallback";
  summary: string;
  displaySummary: string;
  displayQuality: "high" | "medium" | "low" | "fallback";
  presentationSafe: boolean;
  presentationIssues: string[];
  businessTerms: string[];
  capabilities: string[];
  businessPages: string[];
  supportingFiles: string[];
  supportingSymbols: string[];
  technicalEvidence: {
    files: string[];
    symbols: string[];
  };
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
}

export interface DashboardData {
  meta: DashboardMeta;
  communities: CommunityViz[];
  hubs: HubViz[];
  surprises: SurpriseViz[];
  questions: QuestionViz[];
  wikiPages: WikiPageViz[];
  wikiGraphNodes: WikiGraphNodeViz[];
  wikiGraphEdges: WikiGraphEdgeViz[];
  businessPages: BusinessPageViz[];
  productAreas: ProductAreaViz[];
  /** community×community cross-edge counts for chord diagram */
  chordMatrix: number[][];
  /** community labels corresponding to chord matrix rows/columns */
  chordLabels: string[];
  /** community colors corresponding to chord matrix rows/columns */
  chordColors: string[];
}

export interface LensOptions {
  projectRoot: string;
  outputPath?: string;
  maxHubs?: number;
  maxSurprises?: number;
  maxCommunities?: number;
  json?: boolean;
  open?: boolean;
  /** Optional progress reporter so library callers can route messages instead of writing to console. */
  onProgress?: (level: "info" | "error", message: string) => void;
}
