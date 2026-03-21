/**
 * Memory context assembly — formats retrieved memories for injection
 * into the prompt-context hook response.
 *
 * Follows the same token-budgeted assembly pattern as context-assembler.ts
 * but with memory-specific formatting.
 */

import { countTokens } from "../search/context-assembler.js";
import {
  type MemoryClass,
  type MemoryRoute,
  type MemorySearchResult,
  resolveMemoryClass,
  resolveMemorySummary,
} from "./types.js";

const CLASS_LABELS: Record<MemoryClass, string> = {
  rule: "Rule",
  fact: "Fact",
  episode: "Episode",
  working: "Working",
};

const CLASS_PRIORITY: Record<MemoryClass, number> = {
  rule: 0,
  working: 1,
  fact: 2,
  episode: 3,
};

export interface AssembledMemoryContext {
  text: string;
  tokenCount: number;
  memories: MemorySearchResult[];
  dropped: Array<MemorySearchResult & { dropReason: string }>;
  route: MemoryRoute;
  classTokens: Record<MemoryClass, number>;
  classCounts: Record<MemoryClass, number>;
  budget: {
    total: number;
    used: number;
    remaining: number;
    codeFloorRatio: number;
    classBudgets: Record<MemoryClass, number>;
  };
}

export interface MemoryAssemblyOptions {
  classBudgets?: Partial<Record<MemoryClass, number>>;
  codeFloorRatio?: number;
  maxMemories?: number;
}

/**
 * Assemble memory search results into a token-budgeted context block.
 *
 * Output format:
 * ```
 * ## Memories
 *
 * ### [Guidance] feedback_no_coauthor
 * Do not add Co-Authored-By Claude tag to commits
 *
 * Content here...
 *
 * ### [User context] user_role
 * ...
 * ```
 */
export function assembleMemoryContext(
  memories: MemorySearchResult[],
  tokenBudget: number,
  options?: MemoryAssemblyOptions
): AssembledMemoryContext {
  if (memories.length === 0) {
    return {
      text: "",
      tokenCount: 0,
      memories: [],
      dropped: [],
      route: "M0",
      classTokens: {
        rule: 0,
        fact: 0,
        episode: 0,
        working: 0,
      },
      classCounts: {
        rule: 0,
        fact: 0,
        episode: 0,
        working: 0,
      },
      budget: {
        total: tokenBudget,
        used: 0,
        remaining: tokenBudget,
        codeFloorRatio: options?.codeFloorRatio ?? 0.8,
        classBudgets: normalizeClassBudgets(tokenBudget, options?.classBudgets),
      },
    };
  }

  const header = "## Memories\n\n";
  let totalTokens = countTokens(header);

  const included: MemorySearchResult[] = [];
  const dropped: Array<MemorySearchResult & { dropReason: string }> = [];
  const parts: string[] = [header];
  const classBudgets = normalizeClassBudgets(tokenBudget, options?.classBudgets);
  const classBudgetRemaining: Record<MemoryClass, number> = { ...classBudgets };
  const classTokens: Record<MemoryClass, number> = {
    rule: 0,
    fact: 0,
    episode: 0,
    working: 0,
  };
  const classCounts: Record<MemoryClass, number> = {
    rule: 0,
    fact: 0,
    episode: 0,
    working: 0,
  };

  // Compute compression threshold: memories below 50% of top score use compressed format.
  const topScore = memories.length > 0 ? memories[0]!.score : 0;
  const compressionThreshold = topScore * 0.5;
  const sorted = [...memories].sort((a, b) => {
    const classDelta = CLASS_PRIORITY[resolveMemoryClass(a)] - CLASS_PRIORITY[resolveMemoryClass(b)];
    if (classDelta !== 0) return classDelta;
    return b.score - a.score;
  });

  for (const memory of sorted) {
    const memoryClass = resolveMemoryClass(memory);
    const label = CLASS_LABELS[memoryClass];
    const useCompressed = shouldCompressMemory(memory, compressionThreshold);
    const section = useCompressed
      ? formatMemoryCompressed(memory, label)
      : formatMemory(memory, label);
    const sectionTokens = countTokens(section);
    const memoryClassBudget = classBudgetRemaining[memoryClass] ?? 0;

    if (options?.maxMemories && included.length >= options.maxMemories) {
      dropped.push({ ...memory, dropReason: "max memory count reached" });
      continue;
    }

    if (totalTokens + sectionTokens > tokenBudget) {
      dropped.push({ ...memory, dropReason: "token budget exhausted" });
      continue;
    }

    if (memoryClassBudget < sectionTokens) {
      dropped.push({ ...memory, dropReason: `${memoryClass} budget exhausted` });
      continue;
    }

    totalTokens += sectionTokens;
    classBudgetRemaining[memoryClass] = Math.max(0, memoryClassBudget - sectionTokens);
    classTokens[memoryClass] += sectionTokens;
    classCounts[memoryClass] += 1;
    included.push(memory);
    parts.push(section);
  }

  if (included.length === 0) {
    return {
      text: "",
      tokenCount: 0,
      memories: [],
      dropped,
      route: "M0",
      classTokens,
      classCounts,
      budget: {
        total: tokenBudget,
        used: 0,
        remaining: tokenBudget,
        codeFloorRatio: options?.codeFloorRatio ?? 0.8,
        classBudgets,
      },
    };
  }

  return {
    text: parts.join("\n"),
    tokenCount: totalTokens,
    memories: included,
    dropped,
    route: resolveMemoryRoute(included),
    classTokens,
    classCounts,
    budget: {
      total: tokenBudget,
      used: totalTokens,
      remaining: Math.max(0, tokenBudget - totalTokens),
      codeFloorRatio: options?.codeFloorRatio ?? 0.8,
      classBudgets,
    },
  };
}

function formatMemory(memory: MemorySearchResult, label: string): string {
  const summary = resolveMemorySummary(memory);
  const memoryClass = resolveMemoryClass(memory);
  if (memoryClass !== "working") {
    return `### [${label}] ${memory.name} — ${summary || memory.description}\n`;
  }

  const body = compactWorkingBody(memory.content);
  return body
    ? `### [${label}] ${memory.name}\n${summary || memory.description}\n\n${body}\n`
    : `### [${label}] ${memory.name} — ${summary || memory.description}\n`;
}

function formatMemoryCompressed(memory: MemorySearchResult, label: string): string {
  const summary = resolveMemorySummary(memory);
  return `### [${label}] ${memory.name} — ${summary || memory.description}\n`;
}

function normalizeClassBudgets(
  tokenBudget: number,
  budgets?: Partial<Record<MemoryClass, number>>
): Record<MemoryClass, number> {
  const defaultBudget = Math.max(0, tokenBudget);
  return {
    rule: budgets?.rule ?? defaultBudget,
    fact: budgets?.fact ?? defaultBudget,
    episode: budgets?.episode ?? defaultBudget,
    working: budgets?.working ?? defaultBudget,
  };
}

function shouldCompressMemory(memory: MemorySearchResult, compressionThreshold: number): boolean {
  const memoryClass = resolveMemoryClass(memory);
  if (memoryClass === "episode" || memoryClass === "fact") return true;
  return memory.score < compressionThreshold;
}

function resolveMemoryRoute(memories: MemorySearchResult[]): MemoryRoute {
  if (memories.length === 0) return "M0";
  const classes = new Set(memories.map((m) => resolveMemoryClass(m)));
  if (classes.has("fact") || classes.has("episode")) return "M2";
  if (classes.has("rule") || classes.has("working")) return "M1";
  return "M0";
}

function compactWorkingBody(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 4)
    .join("\n");
}
