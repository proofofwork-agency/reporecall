import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import type {
  MemoryClass,
  MemoryScope,
  MemorySourceKind,
  MemoryStatus,
  MemoryType,
} from "./types.js";
import type { WikiPageType, WikiSourceLayer } from "./parser.js";

export interface ManagedMemoryInput {
  name: string;
  description: string;
  memoryType: MemoryType;
  content: string;
  class?: MemoryClass;
  scope?: MemoryScope;
  status?: MemoryStatus;
  summary?: string;
  sourceKind?: MemorySourceKind;
  fingerprint?: string;
  pinned?: boolean;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  supersedesId?: string;
  confidence?: number;
  reason?: string;
  /** Wiki-specific fields */
  pageType?: WikiPageType;
  sourceLayer?: WikiSourceLayer;
  links?: string[];
  sourceCommit?: string;
}

export function safeMemorySlug(name: string): string {
  const slug = name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 100);
  return slug || "memory";
}

export function buildMemoryMarkdown(input: ManagedMemoryInput): string {
  const lines = [
    "---",
    `name: ${yamlString(input.name)}`,
    `description: ${yamlString(input.description)}`,
    `type: ${yamlString(input.memoryType)}`,
  ];

  if (input.class) lines.push(`class: ${yamlString(input.class)}`);
  if (input.scope) lines.push(`scope: ${yamlString(input.scope)}`);
  if (input.status) lines.push(`status: ${yamlString(input.status)}`);
  if (input.summary) lines.push(`summary: ${yamlString(input.summary)}`);
  if (input.sourceKind) lines.push(`sourceKind: ${yamlString(input.sourceKind)}`);
  if (input.fingerprint) lines.push(`fingerprint: ${yamlString(input.fingerprint)}`);
  if (input.pinned !== undefined) lines.push(`pinned: ${input.pinned ? "true" : "false"}`);
  if (input.relatedFiles && input.relatedFiles.length > 0) {
    lines.push(`relatedFiles: ${yamlString(JSON.stringify(input.relatedFiles))}`);
  }
  if (input.relatedSymbols && input.relatedSymbols.length > 0) {
    lines.push(`relatedSymbols: ${yamlString(JSON.stringify(input.relatedSymbols))}`);
  }
  if (input.supersedesId) lines.push(`supersedesId: ${yamlString(input.supersedesId)}`);
  if (input.confidence !== undefined) lines.push(`confidence: ${Number(input.confidence).toFixed(3)}`);
  if (input.reason) lines.push(`reason: ${yamlString(input.reason)}`);
  if (input.pageType) lines.push(`pageType: ${yamlString(input.pageType)}`);
  if (input.sourceLayer) lines.push(`sourceLayer: ${yamlString(input.sourceLayer)}`);
  if (input.links && input.links.length > 0) {
    lines.push(`links: ${yamlString(JSON.stringify(input.links))}`);
  }
  if (input.sourceCommit) lines.push(`sourceCommit: ${yamlString(input.sourceCommit)}`);

  lines.push("---", "", input.content.trim(), "");
  return lines.join("\n");
}

export function writeManagedMemoryFile(
  dir: string,
  fileStem: string,
  input: ManagedMemoryInput
): string {
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `${safeMemorySlug(fileStem)}.md`);
  writeFileSync(filePath, buildMemoryMarkdown(input), "utf-8");
  return filePath;
}

function yamlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}
