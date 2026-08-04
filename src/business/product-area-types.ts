export type PresentationQuality = "high" | "medium" | "low" | "fallback";

export interface BusinessContextPage {
  name: string;
  capability: string;
  displayName: string;
  summary: string;
  displaySummary: string;
  displayQuality: PresentationQuality;
  presentationSafe: boolean;
  presentationIssues: string[];
  actor: string;
  trigger: string;
  businessTerms: string[];
  userActions: string[];
  businessOutcome: string;
  dataConcepts: string[];
  externalSystems: string[];
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  supportingFiles: string[];
  supportingSymbols: string[];
  technicalEvidence: TechnicalEvidence;
  links: string[];
}

export interface ProductAreaContext {
  id: string;
  name: string;
  displayName: string;
  areaKind: "fixed" | "discovered" | "fallback";
  summary: string;
  displaySummary: string;
  displayQuality: PresentationQuality;
  presentationSafe: boolean;
  presentationIssues: string[];
  businessTerms: string[];
  capabilities: string[];
  businessPages: string[];
  supportingFiles: string[];
  supportingSymbols: string[];
  technicalEvidence: TechnicalEvidence;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
}

export interface TechnicalEvidence {
  files: string[];
  symbols: string[];
}
