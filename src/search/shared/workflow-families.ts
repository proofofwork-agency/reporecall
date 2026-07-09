export const INVENTORY_GENERIC_TARGET_ALIAS_TERMS = new Set([
  "route", "routes", "router", "routing", "navigation",
]);

export const INVENTORY_STRUCTURAL_TERMS = new Set([
  "which",
  "what",
  "list",
  "show",
  "file",
  "files",
  "implement",
  "implements",
  "handle",
  "handles",
  "power",
  "powers",
  "control",
  "controls",
  "cover",
  "covers",
  "full",
  "entire",
]);

export const TRACE_NOISE_TERMS = new Set([
  "path", "page", "pages", "include", "includes", "including",
  "start", "first", "then", "full", "intent",
]);

// Reconciled union of previously-divergent per-strategy copies.
export const ADJACENT_WORKFLOW_FAMILIES: Record<string, string[]> = {
  auth: ["routing", "permissions"],
  routing: ["auth", "permissions"],
  billing: ["auth", "generation"],
  storage: ["auth", "generation"],
  generation: ["storage", "queue", "billing", "workflow"],
  queue: ["generation", "workflow"],
  workflow: ["generation", "queue"],
  bot: ["webhook", "daemon"],
};
