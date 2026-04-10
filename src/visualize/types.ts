/**
 * Types for the Reporecall Lens architecture dashboard.
 */

export interface DashboardMeta {
  projectName: string;
  generatedAt: string;
  totalSymbols: number;
  totalFiles: number;
  totalEdges: number;
  communityCount: number;
  wikiPageCount: number;
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

export interface DashboardData {
  meta: DashboardMeta;
  communities: CommunityViz[];
  hubs: HubViz[];
  surprises: SurpriseViz[];
  questions: QuestionViz[];
  wikiPages: WikiPageViz[];
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
}
