import type { QueryMode } from "../search/intent.js";

export interface HookSessionSnapshot {
  sessionKey: string;
  queryMode: QueryMode;
  deliveryMode: "code_context" | "summary_only";
  contextStrength: "sufficient" | "partial" | "weak";
  executionSurface?: string;
  injectedFiles: string[];
  selectedFiles?: string[];
  query?: string;
  missingEvidence?: string[];
  recommendedNextReads?: string[];
  updatedAt: number;
}

export interface PreToolUseHookInput {
  sessionId?: string;
  transcriptPath?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

export interface PreToolUseHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
    additionalContext?: string;
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function matchesInjectedFile(candidate: string, injected: string): boolean {
  const left = normalizePath(candidate);
  const right = normalizePath(injected);
  return left === right || left.endsWith(`/${right}`);
}

function isSearchLikeBash(command: string): boolean {
  return /\b(rg|grep|find|fd|ls|tree)\b/.test(command.toLowerCase());
}

function isExplorerAgent(toolInput?: Record<string, unknown>): boolean {
  const prompt = `${String(toolInput?.prompt ?? "")} ${String(toolInput?.description ?? "")}`.toLowerCase();
  return /\b(explore|search|find|locate|grep|glob|scan|list files|inspect codebase|read files)\b/.test(prompt);
}

function isReporecallTool(toolName?: string): boolean {
  return typeof toolName === "string" && toolName.startsWith("mcp__reporecall__");
}

function summarizeFiles(files: string[]): string {
  const shown = files.slice(0, 4);
  const suffix = files.length > shown.length ? ` (+${files.length - shown.length} more)` : "";
  return shown.join(", ") + suffix;
}

function getSelectedFiles(snapshot: HookSessionSnapshot): string[] {
  return snapshot.selectedFiles?.length ? snapshot.selectedFiles : snapshot.injectedFiles;
}

function isNarrowRead(toolName: string, toolInput: Record<string, unknown>, snapshot: HookSessionSnapshot): boolean {
  if (toolName !== "Read") return false;
  const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
  if (!filePath) return false;
  return getSelectedFiles(snapshot).some((selected) => matchesInjectedFile(filePath, selected))
    || (snapshot.recommendedNextReads ?? []).some((selected) => matchesInjectedFile(filePath, selected));
}

function summarizeMissingEvidence(snapshot: HookSessionSnapshot): string {
  const missing = snapshot.missingEvidence ?? [];
  if (missing.length === 0) return "No obvious evidence gap is currently flagged.";
  return missing.join(" ");
}

export function evaluatePreToolUse(
  input: PreToolUseHookInput,
  snapshot?: HookSessionSnapshot
): PreToolUseHookOutput {
  const toolName = input.toolName ?? "";
  const toolInput = input.toolInput ?? {};

  if (!snapshot) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "No injected Reporecall context is active for this session.",
        additionalContext: "No cached Reporecall context is active for this session. If you need code search, prefer Reporecall MCP tools before generic grep or glob.",
      },
    };
  }

  if (isReporecallTool(toolName)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Reporecall MCP expansion is allowed.",
      },
    };
  }

  const selectedFiles = getSelectedFiles(snapshot);
  const fileSummary = selectedFiles.length > 0 ? summarizeFiles(selectedFiles) : "none";
  const summaryOnly = snapshot.deliveryMode === "summary_only";
  const focusedCodeContext = snapshot.deliveryMode === "code_context" && selectedFiles.length > 0;
  const recommendedReads = snapshot.recommendedNextReads?.length
    ? summarizeFiles(snapshot.recommendedNextReads)
    : fileSummary;

  if (toolName === "Read") {
    const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
    if (focusedCodeContext && filePath && selectedFiles.some((injected) => matchesInjectedFile(filePath, injected))) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Reporecall already injected \`${filePath}\`. Prefer the injected context before rereading the same file.`,
          additionalContext: `Reporecall already selected: ${fileSummary}. Start there first; only reread if the excerpt is insufficient.`,
        },
      };
    }

    if (focusedCodeContext && snapshot.contextStrength === "sufficient" && !isNarrowRead(toolName, toolInput, snapshot)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Reporecall already injected sufficient context. Prefer the recommended next reads before opening unrelated files.",
          additionalContext: `Recommended next reads: ${recommendedReads}. Missing evidence summary: ${summarizeMissingEvidence(snapshot)}`,
        },
      };
    }
  }

  const searchLikeTool =
    toolName === "Grep"
    || toolName === "Glob"
    || (toolName === "Bash" && typeof toolInput.command === "string" && isSearchLikeBash(toolInput.command))
    || (toolName === "Agent" && isExplorerAgent(toolInput));

  if (searchLikeTool) {
    if (summaryOnly) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Broad code injection was deferred.",
          additionalContext: `Reporecall injected summary-only guidance, so expansion is expected. Start with these likely reads: ${recommendedReads}. Missing evidence summary: ${summarizeMissingEvidence(snapshot)}`,
        },
      };
    }

    if (
      focusedCodeContext
      && snapshot.contextStrength === "sufficient"
      && (snapshot.queryMode === "lookup" || snapshot.queryMode === "trace" || snapshot.queryMode === "bug")
    ) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `Reporecall already injected sufficient ${snapshot.queryMode} code context. Prefer those files first before broad search.`,
          additionalContext: `Selected files: ${fileSummary}. Recommended next reads: ${recommendedReads}. Missing evidence summary: ${summarizeMissingEvidence(snapshot)}`,
        },
      };
    }

    if (focusedCodeContext && (snapshot.queryMode === "architecture" || snapshot.queryMode === "change")) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: snapshot.contextStrength === "sufficient"
            ? "Reporecall already injected a coherent representative bundle."
            : "Reporecall already injected a partial representative bundle.",
          additionalContext: `Selected files: ${fileSummary}. Recommended next reads: ${recommendedReads}. Missing evidence summary: ${summarizeMissingEvidence(snapshot)}`,
        },
      };
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Tool use allowed.",
    },
  };
}
