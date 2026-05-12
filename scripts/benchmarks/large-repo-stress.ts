#!/usr/bin/env tsx

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import { loadConfig } from "../../src/core/config.js";
import { setLogLevel } from "../../src/core/logger.js";
import { extractDashboardData } from "../../src/visualize/data-extractor.js";
import { MemoryStore } from "../../src/storage/memory-store.js";

interface Args {
  files: number;
  changes: number;
  keep: boolean;
  quiet: boolean;
  output: string | null;
  topologyMaxChunks: number;
  lensMaxGraphChunks: number;
  sampleIntervalMs: number;
  maxHeapMb: number | null;
  maxRssMb: number | null;
  maxNoChangeFiles: number | null;
  maxLensMs: number | null;
  vacuumBeforeClose: boolean;
}

interface PhaseSample {
  label: string;
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  elapsedMs: number;
}

interface StressReport {
  root: string;
  files: number;
  changes: number;
  timingsMs: {
    initialIndex: number;
    noChangeIndex: number;
    changedIndex: number;
    lensExtract: number;
    total: number;
  };
  results: {
    initial: { filesProcessed: number; chunksCreated: number };
    noChange: { filesProcessed: number; chunksCreated: number };
    changed: { filesProcessed: number; chunksCreated: number };
    lensMeta: unknown;
  };
  memory: {
    peakHeapUsedMb: number;
    peakHeapTotalMb: number;
    peakRssMb: number;
    peakExternalMb: number;
    peakArrayBuffersMb: number;
    samples: PhaseSample[];
  };
}

export interface StressBudgetOptions {
  maxHeapMb?: number | null;
  maxRssMb?: number | null;
  maxNoChangeFiles?: number | null;
  maxLensMs?: number | null;
}

interface TimedResult<T> {
  result: T;
  ms: number;
}

export function evaluateStressBudgets(
  report: StressReport,
  budgets: StressBudgetOptions
): string[] {
  const failures: string[] = [];
  if (budgets.maxHeapMb !== null && budgets.maxHeapMb !== undefined && report.memory.peakHeapUsedMb > budgets.maxHeapMb) {
    failures.push(`peak heap ${report.memory.peakHeapUsedMb} MB exceeded budget ${budgets.maxHeapMb} MB`);
  }
  if (budgets.maxRssMb !== null && budgets.maxRssMb !== undefined && report.memory.peakRssMb > budgets.maxRssMb) {
    failures.push(`peak RSS ${report.memory.peakRssMb} MB exceeded budget ${budgets.maxRssMb} MB`);
  }
  if (
    budgets.maxNoChangeFiles !== null
    && budgets.maxNoChangeFiles !== undefined
    && report.results.noChange.filesProcessed > budgets.maxNoChangeFiles
  ) {
    failures.push(`no-change index processed ${report.results.noChange.filesProcessed} files, budget ${budgets.maxNoChangeFiles}`);
  }
  if (budgets.maxLensMs !== null && budgets.maxLensMs !== undefined && report.timingsMs.lensExtract > budgets.maxLensMs) {
    failures.push(`Lens extraction ${report.timingsMs.lensExtract} ms exceeded budget ${budgets.maxLensMs} ms`);
  }
  return failures;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.quiet) setLogLevel("error");

  const root = mkdtempSync(join(tmpdir(), "reporecall-large-repo-"));
  const started = performance.now();
  const samples: PhaseSample[] = [];
  let pipeline: IndexingPipeline | null = null;
  let memoryStore: MemoryStore | null = null;

  const sample = (label: string, forceGc = false): void => {
    if (forceGc && global.gc) global.gc();
    samples.push(readMemorySample(label, started));
  };

  const runPhase = async <T>(label: string, fn: () => Promise<T> | T): Promise<TimedResult<T>> => {
    sample(`${label}:start`);
    const interval = setInterval(() => sample(label), args.sampleIntervalMs);
    interval.unref?.();
    const phaseStarted = performance.now();
    try {
      const result = await fn();
      return { result, ms: performance.now() - phaseStarted };
    } finally {
      clearInterval(interval);
      sample(`${label}:end`);
    }
  };

  try {
    mkdirSync(join(root, ".memory"), { recursive: true });
    writeFileSync(
      join(root, ".memory", "config.json"),
      JSON.stringify({
        embeddingProvider: "keyword",
        extensions: [".ts"],
        ignorePatterns: ["node_modules", ".git", ".memory"],
        fileBatchSize: 24,
        embedBatchSize: 16,
        adaptiveBatching: true,
        topologyMaxChunks: args.topologyMaxChunks,
        maxChunkTextBytesPerWindow: 512 * 1024,
      }, null, 2),
      "utf-8"
    );

    sample("start", true);
    createSyntheticRepo(root, args.files);
    sample("generated", true);

    const config = loadConfig(root);
    pipeline = new IndexingPipeline(config);

    const initial = await runPhase("initial-index", () => pipeline!.indexAll());
    const noChange = await runPhase("no-change-index", () => pipeline!.indexAll());

    mutateSyntheticRepo(root, args.changes);
    sample("mutated", true);

    const changedPaths = Array.from({ length: args.changes }, (_, i) => `src/module-${i % args.files}.ts`);
    const changed = await runPhase("changed-index", () => pipeline!.indexChanged(changedPaths));

    memoryStore = new MemoryStore(config.dataDir);
    const lens = await runPhase("lens-extract", () => extractDashboardData(pipeline!.getMetadataStore(), memoryStore, {
      projectRoot: root,
      maxGraphChunks: args.lensMaxGraphChunks,
    }));

    if (args.vacuumBeforeClose && pipeline) {
      await pipeline.vacuum();
    }
    if (memoryStore) {
      memoryStore.close();
      memoryStore = null;
    }
    if (pipeline) {
      await pipeline.closeAsync();
      pipeline = null;
    }
    sample("post-close", true);

    const report = buildReport({
      root,
      files: args.files,
      changes: args.changes,
      started,
      samples,
      initial,
      noChange,
      changed,
      lens,
    });

    const json = JSON.stringify(report, null, 2);
    if (args.output) {
      writeFileSync(resolve(args.output), `${json}\n`, "utf-8");
    }
    console.log(json);

    const failures = evaluateStressBudgets(report, {
      maxHeapMb: args.maxHeapMb,
      maxRssMb: args.maxRssMb,
      maxNoChangeFiles: args.maxNoChangeFiles,
      maxLensMs: args.maxLensMs,
    });
    if (failures.length > 0) {
      for (const failure of failures) console.error(`[stress:large-repo] ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    if (args.vacuumBeforeClose && pipeline) {
      await pipeline.vacuum();
    }
    if (memoryStore) memoryStore.close();
    if (pipeline) await pipeline.closeAsync();
    if (!args.keep) rmSync(root, { recursive: true, force: true });
  }
}

function buildReport(input: {
  root: string;
  files: number;
  changes: number;
  started: number;
  samples: PhaseSample[];
  initial: TimedResult<{ filesProcessed: number; chunksCreated: number }>;
  noChange: TimedResult<{ filesProcessed: number; chunksCreated: number }>;
  changed: TimedResult<{ filesProcessed: number; chunksCreated: number }>;
  lens: TimedResult<{ meta: unknown }>;
}): StressReport {
  return {
    root: input.root,
    files: input.files,
    changes: input.changes,
    timingsMs: {
      initialIndex: Math.round(input.initial.ms),
      noChangeIndex: Math.round(input.noChange.ms),
      changedIndex: Math.round(input.changed.ms),
      lensExtract: Math.round(input.lens.ms),
      total: Math.round(performance.now() - input.started),
    },
    results: {
      initial: input.initial.result,
      noChange: input.noChange.result,
      changed: input.changed.result,
      lensMeta: input.lens.result.meta,
    },
    memory: {
      peakHeapUsedMb: Math.max(...input.samples.map((sample) => sample.heapUsedMb)),
      peakHeapTotalMb: Math.max(...input.samples.map((sample) => sample.heapTotalMb)),
      peakRssMb: Math.max(...input.samples.map((sample) => sample.rssMb)),
      peakExternalMb: Math.max(...input.samples.map((sample) => sample.externalMb)),
      peakArrayBuffersMb: Math.max(...input.samples.map((sample) => sample.arrayBuffersMb)),
      samples: input.samples,
    },
  };
}

function createSyntheticRepo(projectRoot: string, files: number): void {
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  for (let i = 0; i < files; i += 1) {
    const next = (i + 1) % files;
    writeFileSync(
      join(projectRoot, "src", `module-${i}.ts`),
      [
        `import { runModule${next} } from "./module-${next}";`,
        "",
        `export function runModule${i}(value: number): number {`,
        `  return value > ${i} ? runModule${next}(value - 1) : value + ${i};`,
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );
  }
}

function mutateSyntheticRepo(projectRoot: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const filePath = join(projectRoot, "src", `module-${i}.ts`);
    const current = readFileSync(filePath, "utf-8");
    writeFileSync(filePath, `${current}// changed ${i}\n`, "utf-8");
  }
}

function readMemorySample(label: string, started: number): PhaseSample {
  const usage = process.memoryUsage();
  return {
    label,
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    rssMb: toMb(usage.rss),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers),
    elapsedMs: Math.round(performance.now() - started),
  };
}

function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    files: 10_000,
    changes: 1_000,
    keep: false,
    quiet: false,
    output: null,
    topologyMaxChunks: 50_000,
    lensMaxGraphChunks: 50_000,
    sampleIntervalMs: 250,
    maxHeapMb: null,
    maxRssMb: null,
    maxNoChangeFiles: null,
    maxLensMs: null,
    vacuumBeforeClose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--files") args.files = Number(argv[++i]);
    else if (arg === "--changes") args.changes = Number(argv[++i]);
    else if (arg === "--output") args.output = argv[++i] ?? null;
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--topology-max-chunks") args.topologyMaxChunks = Number(argv[++i]);
    else if (arg === "--lens-max-graph-chunks") args.lensMaxGraphChunks = Number(argv[++i]);
    else if (arg === "--sample-interval-ms") args.sampleIntervalMs = Number(argv[++i]);
    else if (arg === "--max-heap-mb") args.maxHeapMb = Number(argv[++i]);
    else if (arg === "--max-rss-mb") args.maxRssMb = Number(argv[++i]);
    else if (arg === "--max-no-change-files") args.maxNoChangeFiles = Number(argv[++i]);
    else if (arg === "--max-lens-ms") args.maxLensMs = Number(argv[++i]);
    else if (arg === "--vacuum-before-close") args.vacuumBeforeClose = true;
  }
  if (!Number.isInteger(args.files) || args.files < 1) throw new Error("--files must be a positive integer");
  if (!Number.isInteger(args.changes) || args.changes < 0 || args.changes > args.files) {
    throw new Error("--changes must be an integer between 0 and --files");
  }
  if (!Number.isInteger(args.topologyMaxChunks) || args.topologyMaxChunks < 100) {
    throw new Error("--topology-max-chunks must be an integer >= 100");
  }
  if (!Number.isInteger(args.lensMaxGraphChunks) || args.lensMaxGraphChunks < 0) {
    throw new Error("--lens-max-graph-chunks must be a non-negative integer");
  }
  if (!Number.isInteger(args.sampleIntervalMs) || args.sampleIntervalMs < 50) {
    throw new Error("--sample-interval-ms must be an integer >= 50");
  }
  for (const [name, value] of [
    ["--max-heap-mb", args.maxHeapMb],
    ["--max-rss-mb", args.maxRssMb],
    ["--max-no-change-files", args.maxNoChangeFiles],
    ["--max-lens-ms", args.maxLensMs],
  ] as const) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative number`);
    }
  }
  return args;
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedFile === currentFile) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
