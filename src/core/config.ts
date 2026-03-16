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
}

// M-config: Zod schema for user-configurable fields
const UserConfigSchema = z.object({
  embeddingProvider: z.enum(["local", "ollama", "openai", "keyword"]).optional(),
  embeddingModel: z.string().optional(),
  embeddingDimensions: z.number().int().min(1).optional(),
  ollamaUrl: z.string().url().optional(),
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

  // H-1: Never load API keys from config file — env var only
  if ((userConfig as any).openaiApiKey) {
    getLogger().warn("openaiApiKey in config file is ignored for security. Use OPENAI_API_KEY env var.");
  }

  return merged;
}
