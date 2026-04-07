import { Command } from "commander";
import { resolve } from "path";
import { mkdirSync, readFileSync } from "fs";
import { detectProjectRoot } from "../core/project.js";
import { loadConfig } from "../core/config.js";
import { IndexingPipeline } from "../indexer/pipeline.js";
import { HybridSearch } from "../search/hybrid.js";
import { createMCPServer } from "../daemon/mcp-server.js";
import { ReadWriteLock } from "../core/rwlock.js";
import { MemoryStore } from "../storage/memory-store.js";
import { createMemoryIndexer } from "../memory/indexer.js";
import { MemorySearch } from "../memory/search.js";
import { MemoryRuntime } from "../daemon/memory/runtime.js";
import { WikiGenerator } from "../wiki/generator.js";
import { WikiAutoCapture } from "../wiki/auto-capture.js";
import { setLogDestination, setLogLevel } from "../core/logger.js";
import { OllamaEmbedder } from "../indexer/embedder.js";

async function isDaemonRunning(port: number, dataDir: string): Promise<boolean> {
  try {
    let token: string | undefined;
    try {
      token = readFileSync(resolve(dataDir, "daemon.token"), "utf-8").trim();
    } catch {
      // No token file — daemon likely not running
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: controller.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return res.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

export function mcpCommand(): Command {
  return new Command("mcp")
    .description("Start MCP server (stdio transport)")
    .option("--project <path>", "Project root path")
    .option("--no-memory", "Disable the memory layer")
    .action(async (options) => {
      // Redirect console to stderr FIRST — before any code can write to stdout
      console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
      console.error = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
      setLogDestination("stderr");
      setLogLevel("silent");

      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd());

      const config = loadConfig(projectRoot);

      // Check if daemon is already running — warn about dual-process risk
      const daemonUp = await isDaemonRunning(config.port, config.dataDir);
      if (daemonUp) {
        console.error(
          `Warning: Reporecall daemon is already running on port ${config.port}. ` +
          `Running a standalone MCP process risks SQLite lock contention. ` +
          `Consider using "serve --mcp" instead to share the daemon's infrastructure.`
        );
      }

      // Health check for Ollama (mirrors serve.ts)
      if (config.embeddingProvider === "ollama") {
        const embedder = new OllamaEmbedder(
          config.embeddingModel,
          config.ollamaUrl,
          config.embeddingDimensions
        );
        const healthy = await embedder.healthCheck();
        if (!healthy) {
          console.error(
            "Error: Ollama is not running. Start it with: ollama serve"
          );
          process.exit(1);
        }
      }

      const pipeline = new IndexingPipeline(config);

      const rwLock = new ReadWriteLock();

      const search = new HybridSearch(
        pipeline.getEmbedder(),
        pipeline.getVectorStore(),
        pipeline.getFTSStore(),
        pipeline.getMetadataStore(),
        config,
        rwLock
      );

      // --- Memory layer initialization ---
      const memoryEnabled = config.memory && options.memory !== false;
      let memoryStore: MemoryStore | undefined;
      let memoryIndexer: ReturnType<typeof createMemoryIndexer> | undefined;
      let memorySearchInstance: MemorySearch | undefined;
      let memoryRuntime: MemoryRuntime | undefined;

      if (memoryEnabled) {
        const memoryDataDir = resolve(config.dataDir, "memory-index");
        mkdirSync(memoryDataDir, { recursive: true });
        memoryStore = new MemoryStore(memoryDataDir);
        memoryIndexer = createMemoryIndexer(
          memoryStore,
          projectRoot,
          {
            additionalDirs: config.memoryDirs,
            writableDir: config.memoryWritableDir,
          }
        );
        memorySearchInstance = new MemorySearch(memoryStore);
        memoryRuntime = new MemoryRuntime(memoryIndexer, memoryStore, {
          debounceMs: config.debounceMs,
          compactionHours: config.memoryCompactionHours,
          archiveDays: config.memoryArchiveDays,
          watchEnabled: config.memoryWatch,
          autoCreate: config.memoryAutoCreate,
          factPromotionThreshold: config.memoryFactPromotionThreshold,
          writableDir: config.memoryWritableDir,
          projectRoot,
          workingHistoryLimit: config.memoryWorkingHistoryLimit,
        });
        memoryRuntime.start().catch((err) => {
          console.error(`Memory indexing failed: ${err}`);
        });
      }

      // --- Wiki layer initialization ---
      let wikiGen: WikiGenerator | undefined;
      let wikiCapture: WikiAutoCapture | undefined;
      if (memoryEnabled && memoryStore && memoryIndexer) {
        const writableDir = memoryIndexer.getWritableDirs()[0];
        if (writableDir) {
          wikiGen = new WikiGenerator(
            pipeline.getMetadataStore(),
            memoryStore,
            memoryIndexer,
            { writableDir, projectRoot }
          );
          wikiCapture = new WikiAutoCapture(
            memoryIndexer,
            memoryStore,
            { writableDir, projectRoot }
          );
        }
      }

      const server = createMCPServer(
        search,
        pipeline,
        pipeline.getMetadataStore(),
        config,
        rwLock,
        memorySearchInstance,
        memoryIndexer,
        memoryStore,
        memoryRuntime,
        wikiGen,
        wikiCapture
      );

      await server.connect(
        new (await import("@modelcontextprotocol/sdk/server/stdio.js")).StdioServerTransport()
      );

      const shutdown = async () => {
        await server.close();
        await memoryRuntime?.stop();
        memoryStore?.close();
        await pipeline.closeAsync();
        process.exit(0);
      };

      // Windows: SIGTERM is not sent by Task Manager/services. Only SIGINT (Ctrl+C) works.
      // Node.js emulates SIGINT on Windows, so graceful shutdown via Ctrl+C is supported.
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
}
