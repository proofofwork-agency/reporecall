import { Command } from "commander";
import { resolve } from "path";
import { mkdirSync } from "fs";
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
import { setLogDestination, setLogLevel } from "../core/logger.js";

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

      const server = createMCPServer(
        search,
        pipeline,
        pipeline.getMetadataStore(),
        config,
        rwLock,
        memorySearchInstance,
        memoryIndexer,
        memoryStore,
        memoryRuntime
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
