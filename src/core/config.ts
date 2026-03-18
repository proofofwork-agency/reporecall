import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod";
import safe from "safe-regex2";
import { getLogger } from "./logger.js";
import { LANGUAGE_CONFIGS } from "../parser/languages.js";

export interface MemoryConfig {
  projectRoot: string;
  dataDir: string;
  embeddingProvider: "local" | "ollama" | "openai" | "keyword";
  embeddingModel: string;
  embeddingDimensions: number;
  ollamaUrl: string;
  extensions: string[];
  ignorePatterns: string[];
  maxFileSize: number;
  batchSize: number;
  contextBudget: number;
  maxContextChunks: number;
  sessionBudget: number;
  searchWeights: {
    vector: number;
    keyword: number;
    recency: number;
  };
  rrfK: number;
  graphExpansion: boolean;
  graphDiscountFactor: number;
  siblingExpansion: boolean;
  siblingDiscountFactor: number;
  reranking: boolean;
  rerankingModel: string;
  rerankTopK: number;
  codeBoostFactor: number;
  testPenaltyFactor: number;
  anonymousPenaltyFactor: number;
  debounceMs: number;
  port: number;
  implementationPaths: string[];
  factExtractors: Array<{ keyword: string; pattern: string; label: string }>;
  conceptBundles: Array<{
    kind: string;
    pattern: string;
    symbols: string[];
    maxChunks: number;
  }>;
}

// M-config: Zod schema for user-configurable fields
const UserConfigSchema = z.object({
  embeddingProvider: z.enum(["local", "ollama", "openai", "keyword"]).optional(),
  embeddingModel: z.string().optional(),
  embeddingDimensions: z.number().int().min(1).optional(),
  ollamaUrl: z.string().url().refine((u) => {
    const h = new URL(u).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  }, { message: "ollamaUrl must point to localhost (use localhost, 127.0.0.1, or [::1])" }).optional(),
  extensions: z.array(z.string()).optional(),
  ignorePatterns: z.array(z.string()).optional(),
  maxFileSize: z.number().positive().optional(),
  batchSize: z.number().positive().optional(),
  contextBudget: z.number().positive().optional(),
  maxContextChunks: z.number().min(0).optional(),
  sessionBudget: z.number().positive().optional(),
  searchWeights: z.object({
    vector: z.number().min(0).max(1).optional(),
    keyword: z.number().min(0).max(1).optional(),
    recency: z.number().min(0).max(1).optional(),
  }).optional(),
  rrfK: z.number().positive().optional(),
  graphExpansion: z.boolean().optional(),
  graphDiscountFactor: z.number().min(0).max(1).optional(),
  siblingExpansion: z.boolean().optional(),
  siblingDiscountFactor: z.number().min(0).max(1).optional(),
  reranking: z.boolean().optional(),
  rerankingModel: z.string().optional(),
  rerankTopK: z.number().positive().optional(),
  codeBoostFactor: z.number().optional(),
  testPenaltyFactor: z.number().optional(),
  anonymousPenaltyFactor: z.number().optional(),
  debounceMs: z.number().positive().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  implementationPaths: z.array(z.string()).optional(),
  factExtractors: z.array(z.object({
    keyword: z.string(),
    pattern: z.string().refine((p) => {
      try { new RegExp(p); return true; } catch { return false; }
    }, { message: "Invalid regex syntax" }),
    label: z.string(),
  })).optional(),
  conceptBundles: z.array(z.object({
    kind: z.string(),
    pattern: z.string().refine((p) => {
      try { new RegExp(p, "i"); return true; } catch { return false; }
    }, { message: "Invalid regex syntax" }),
    symbols: z.array(z.string()).min(1),
    maxChunks: z.number().int().min(1).default(4),
  })).optional(),
}).strict();

const DEFAULT_EXTENSIONS = Array.from(
  new Set([
    ...Object.values(LANGUAGE_CONFIGS).flatMap((config) => config.extensions),
    ".json",
    ".md",
    ".sql",
    ".svelte",
  ])
);

const DEFAULTS: Omit<MemoryConfig, "projectRoot" | "dataDir"> = {
  embeddingProvider: "local",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  embeddingDimensions: 384,
  ollamaUrl: "http://localhost:11434",
  extensions: DEFAULT_EXTENSIONS,
  ignorePatterns: [
    "node_modules", ".git", ".memory", "dist", "build", "target",
    "__pycache__", ".next", ".nuxt", "vendor", "coverage",
    "*.min.js", "*.min.css", "*.map", "*.lock", "package-lock.json",
  ],
  maxFileSize: 100 * 1024,
  batchSize: 32,
  contextBudget: 4000,
  maxContextChunks: 0,
  sessionBudget: 2000,
  searchWeights: { vector: 0.5, keyword: 0.3, recency: 0.2 },
  rrfK: 60,
  graphExpansion: true,
  graphDiscountFactor: 0.6,
  siblingExpansion: true,
  siblingDiscountFactor: 0.4,
  reranking: false,
  rerankingModel: "Xenova/ms-marco-MiniLM-L-6-v2",
  rerankTopK: 25,
  codeBoostFactor: 1.5,
  testPenaltyFactor: 0.3,
  anonymousPenaltyFactor: 0.5,
  debounceMs: 2000,
  port: 37222,
  implementationPaths: ["src/", "lib/", "bin/"],
  factExtractors: [],
  conceptBundles: [
    {
      kind: "ast",
      pattern: "\\b(ast|tree[- ]?sitter)\\b",
      symbols: ["initTreeSitter", "createParser", "chunkFileWithCalls", "walkForExtractables", "extractName"],
      maxChunks: 4,
    },
    {
      kind: "call_graph",
      pattern: "\\bcall\\s+graph\\b|\\bwho\\s+calls\\b|\\bcalled\\s+by\\b|\\bcaller(?:s)?\\b|\\bcallee(?:s)?\\b",
      symbols: ["extractCallEdges", "extractCalleeInfo", "extractReceiver", "graphCommand", "buildStackTree"],
      maxChunks: 4,
    },
    {
      kind: "search_pipeline",
      pattern: "\\bsearch\\s+pipeline\\b|\\bretrieval\\s+pipeline\\b|\\bintent\\s+classification\\s+route\\b|\\bhybrid\\s+search\\b|\\bsearch\\s+routing\\b|\\bquery\\s+routing\\b|\\broute\\s+selection\\b",
      symbols: ["classifyIntent", "deriveRoute", "handlePromptContextDetailed", "searchWithContext", "search", "resolveSeeds"],
      maxChunks: 5,
    },
    {
      kind: "storage",
      pattern: "\\bstorage\\s+layer\\b|\\bstorage\\s+design\\b|\\bdata\\s+stores?\\b|\\bpersist",
      symbols: ["MetadataStore", "FTSStore", "ChunkStore", "CallEdgeStore", "ImportStore", "StatsStore", "ConventionsStore"],
      maxChunks: 5,
    },
    {
      kind: "daemon",
      pattern: "\\bdaemon\\b|\\bhttp\\s+server\\b|\\bserver\\s+architect",
      symbols: ["createDaemonServer", "handlePromptContext", "sanitizeQuery", "IndexScheduler"],
      maxChunks: 4,
    },
    {
      kind: "embedding",
      pattern: "\\bembedding\\s+(provider|handled|across)\\b|\\bembedder\\b|\\bvector\\s+encod",
      symbols: ["EmbeddingProvider", "LocalEmbedder", "NullEmbedder", "OllamaEmbedder", "createEmbedder"],
      maxChunks: 4,
    },
    {
      kind: "cli",
      pattern: "\\bcli\\b|\\bcommand\\s+struct|\\bcommand\\s+line\\b",
      symbols: ["createCLI", "initCommand", "searchCommand", "serveCommand", "explainCommand", "mcpCommand"],
      maxChunks: 5,
    },
    {
      kind: "context_assembly",
      pattern: "\\btoken\\s+budget\\b|\\bcontext\\s+assembl|\\bbudget\\s+strat",
      symbols: ["assembleContext", "assembleConceptContext", "assembleDeepRouteContext", "AssembledContext", "countTokens"],
      maxChunks: 5,
    },
  ],
};

export function loadConfig(projectRoot: string): MemoryConfig {
  const dataDir = resolve(projectRoot, ".memory");
  const configPath = resolve(dataDir, "config.json");

  let userConfig: z.infer<typeof UserConfigSchema> = {};
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const result = UserConfigSchema.safeParse(raw);
      if (result.success) {
        userConfig = result.data;
      } else {
        getLogger().warn(`Config validation failed: ${result.error.message}. Using defaults.`);
      }
    } catch (err) {
      getLogger().warn(`Failed to parse config at ${configPath}: ${err}. Using defaults.`);
    }
  }

  const merged = {
    ...DEFAULTS,
    ...userConfig,
    projectRoot,
    dataDir,
    searchWeights: {
      ...DEFAULTS.searchWeights,
      ...(userConfig.searchWeights ?? {}),
    },
    // Append user conceptBundles to defaults (dedup by kind)
    conceptBundles: (() => {
      const base = DEFAULTS.conceptBundles;
      const user = userConfig.conceptBundles;
      if (!user || user.length === 0) return base;
      const baseKinds = new Set(base.map((b) => b.kind));
      const overrides = user.filter((u) => baseKinds.has(u.kind));
      const additions = user.filter((u) => !baseKinds.has(u.kind));
      // Replace defaults that share a kind with user overrides, keep the rest
      const merged = base.map((b) => {
        const override = overrides.find((o) => o.kind === b.kind);
        return override ?? b;
      });
      return [...merged, ...additions];
    })(),
  };

  // Validate search weight sum
  const weightSum = merged.searchWeights.vector + merged.searchWeights.keyword + merged.searchWeights.recency;
  if (weightSum < 0.01) {
    getLogger().warn(`Search weights sum to ${weightSum} — all results will score near zero. Consider adjusting searchWeights.`);
  } else if (Math.abs(weightSum - 1.0) > 0.3) {
    getLogger().warn(`Search weights sum to ${weightSum.toFixed(2)} (expected ~1.0). Results may be skewed.`);
  }

  // Validate factExtractor patterns: reject unsafe regex
  if (merged.factExtractors && merged.factExtractors.length > 0) {
    const log = getLogger();
    merged.factExtractors = merged.factExtractors.filter((ext) => {
      try {
        new RegExp(ext.pattern);
      } catch (err) {
        log.warn(`Rejected factExtractor pattern "${ext.pattern}": invalid syntax — ${err}`);
        return false;
      }
      if (!safe(ext.pattern)) {
        log.warn(`Rejected factExtractor pattern "${ext.pattern}": potential ReDoS (exponential backtracking)`);
        return false;
      }
      return true;
    });
  }

  // Validate conceptBundle patterns: reject unsafe regex (same protection as factExtractors)
  if (merged.conceptBundles && merged.conceptBundles.length > 0) {
    const log = getLogger();
    merged.conceptBundles = merged.conceptBundles.filter((bundle) => {
      if (!safe(bundle.pattern)) {
        log.warn(`Rejected conceptBundle pattern "${bundle.pattern}" (kind: ${bundle.kind}): potential ReDoS (exponential backtracking)`);
        return false;
      }
      return true;
    });
  }

  // H-1: Never load API keys from config file — env var only
  if ("openaiApiKey" in (userConfig as Record<string, unknown>)) {
    getLogger().warn("openaiApiKey in config file is ignored for security. Use OPENAI_API_KEY env var.");
  }

  return merged;
}
