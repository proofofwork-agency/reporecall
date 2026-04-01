import { Command } from 'commander'
import { resolve } from 'path'
import {
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  mkdirSync,
  readFileSync
} from 'fs'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { getLogger, setLogDestination, setLogLevel } from '../core/logger.js'
import { IndexingPipeline } from '../indexer/pipeline.js'
import { HybridSearch } from '../search/hybrid.js'
import { FileWatcher } from '../daemon/watcher.js'
import { IndexScheduler } from '../daemon/scheduler.js'
import { createDaemonServer } from '../daemon/server.js'
import { ReadWriteLock } from '../core/rwlock.js'
import { isProcessAlive } from '../core/platform.js'
import { OllamaEmbedder } from '../indexer/embedder.js'
import { createMCPServer } from '../daemon/mcp-server.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { MemoryStore } from '../storage/memory-store.js'
import { createMemoryIndexer } from '../memory/indexer.js'
import { MemorySearch } from '../memory/search.js'
import { MemoryRuntime } from '../daemon/memory/runtime.js'
import { assertSqliteRuntimeHealthy } from '../storage/sqlite-utils.js'

export function serveCommand(): Command {
  return new Command('serve')
    .description('Start the Reporecall daemon (indexer + HTTP server)')
    .option('--project <path>', 'Project root path')
    .option('--port <n>', 'HTTP port')
    .option('--mcp', 'Also start MCP server on stdio')
    .option(
      '--max-chunks <n>',
      'Max context chunks per query (0 = dynamic)'
    )
    .option('--debug', 'Enable debug logging for hook/retrieval diagnostics')
    .option('--no-memory', 'Disable the memory layer')
    .action(async (options) => {
      // Redirect console to stderr FIRST when MCP mode is active,
      // before any code can write to stdout and corrupt the JSON-RPC stream
      if (options.mcp) {
        console.log = (...args: unknown[]) =>
          process.stderr.write(args.join(' ') + '\n')
        console.error = (...args: unknown[]) =>
          process.stderr.write(args.join(' ') + '\n')
        setLogDestination('stderr')
      }

      if (options.debug) {
        setLogLevel('debug')
      }

      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd())

      const config = loadConfig(projectRoot)
      assertSqliteRuntimeHealthy({
        cwd: projectRoot,
        log: (message) => process.stderr.write(`${message}\n`),
      })
      if (options.port) {
        const parsed = parseInt(options.port, 10)
        if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
          console.error('Error: --port must be a number between 1 and 65535')
          process.exit(1)
        }
        config.port = parsed
      }
      if (options.maxChunks !== undefined) {
        const parsed = parseInt(options.maxChunks, 10)
        if (!isNaN(parsed) && parsed >= 0) config.maxContextChunks = parsed
      }

      // Health check for Ollama
      if (config.embeddingProvider === 'ollama') {
        const embedder = new OllamaEmbedder(
          config.embeddingModel,
          config.ollamaUrl,
          config.embeddingDimensions
        )
        const healthy = await embedder.healthCheck()
        if (!healthy) {
          console.error(
            'Error: Ollama is not running. Start it with: ollama serve'
          )
          process.exit(1)
        }
      }

      mkdirSync(config.dataDir, { recursive: true })

      // Advisory lock on PID file to prevent concurrent starts
      const pidPath = resolve(config.dataDir, 'daemon.pid')
      let pidFd: number | undefined

      try {
        // Try to open exclusively first (fast path — no existing file)
        try {
          pidFd = openSync(pidPath, 'wx')
        } catch {
          // File exists — check if the process is still alive
          const existingContent = readFileSync(pidPath, 'utf-8').trim()
          const oldPid = parseInt(existingContent, 10)
          if (!isNaN(oldPid)) {
            if (isProcessAlive(oldPid)) {
              console.error(
                `Error: Daemon already running (PID ${oldPid}). Stop it first.`
              )
              process.exit(1)
            } else {
              // Process is dead — stale PID file. Clean up sidecars.
              getLogger().warn(
                { oldPid },
                'Stale daemon PID detected, cleaning up sidecars'
              )
              const sidecarFiles = [
                resolve(config.dataDir, 'metadata.db-wal'),
                resolve(config.dataDir, 'metadata.db-shm'),
                resolve(config.dataDir, 'fts.db-wal'),
                resolve(config.dataDir, 'fts.db-shm'),
                resolve(config.dataDir, 'memory-index', 'memories.db-wal'),
                resolve(config.dataDir, 'memory-index', 'memories.db-shm'),
              ]
              for (const f of sidecarFiles) {
                try {
                  unlinkSync(f)
                } catch {
                  /* may not exist */
                }
              }
            }
          }
          // Delete stale PID file, then retry atomic exclusive open
          try {
            unlinkSync(pidPath)
          } catch {
            /* may already be gone */
          }
          try {
            pidFd = openSync(pidPath, 'wx')
          } catch {
            console.error(
              'Error: Another daemon started during stale PID recovery.'
            )
            process.exit(1)
          }
        }

        // Write our PID
        const pidStr = process.pid.toString()
        writeSync(pidFd, pidStr, 0, 'utf-8')
        // Keep the file descriptor open as an advisory lock
        // (closing it signals we're done)
      } catch (err) {
        console.error(`Failed to acquire PID lock: ${err}`)
        process.exit(1)
      }

      if (config.embeddingProvider === 'keyword') {
        console.log('Using keyword-only mode (no embedding model)')
      }

      console.log(`Reporecall daemon starting for: ${projectRoot}`)
      console.log(`Data directory: ${config.dataDir}`)

      // Initial index
      const pipeline = new IndexingPipeline(config)

      // Report existing index state before running the incremental update
      const existingStats = pipeline.getMetadataStore().getStats()
      if (existingStats.totalChunks > 0) {
        console.log(
          `Loaded existing index: ${existingStats.totalFiles} files, ${existingStats.totalChunks} chunks`
        )
      } else {
        console.log('Starting fresh: no existing index found')
      }
      console.log('Running incremental index update...')

      const progressWrite = options.mcp
        ? (msg: string) => process.stderr.write(msg)
        : (msg: string) => process.stdout.write(msg)

      try {
        const result = await pipeline.indexAll((progress) => {
          if (progress.phase === 'scanning') {
            progressWrite('\r  Scanning files...')
          } else if (progress.phase === 'chunking') {
            progressWrite(
              `\r  Chunking: ${progress.current}/${progress.total} files`
            )
          } else if (progress.phase === 'embedding') {
            progressWrite(
              `\r  Embedding: ${progress.current}/${progress.total} chunks`
            )
          } else if (progress.phase === 'storing') {
            progressWrite('\r  Storing...')
          } else if (progress.phase === 'done') {
            progressWrite('\r')
            console.log(`  ${progress.message}`)
          }
        })
        if (result.filesProcessed > 0 || result.chunksCreated > 0) {
          console.log(
            `Index updated: ${result.filesProcessed} files processed, ${result.chunksCreated} chunks created`
          )
        } else {
          console.log('Index up to date: no changes detected')
        }
      } catch (err) {
        console.error(`Initial index failed: ${err}`)
        console.error('Daemon will continue without initial index.')
      }

      // Pre-warm embedder (non-blocking)
      if (config.embeddingProvider === 'local') {
        pipeline.getEmbedder().embed(['warmup']).catch(() => {})
      }

      // Set up search with read-write lock
      const rwLock = new ReadWriteLock()
      const search = new HybridSearch(
        pipeline.getEmbedder(),
        pipeline.getVectorStore(),
        pipeline.getFTSStore(),
        pipeline.getMetadataStore(),
        config,
        rwLock
      )

      // --- Memory layer initialization ---
      const memoryEnabled = config.memory && options.memory !== false
      let memoryStore: MemoryStore | undefined
      let memoryIndexer: ReturnType<typeof createMemoryIndexer> | undefined
      let memorySearchInstance: MemorySearch | undefined
      let memoryRuntime: MemoryRuntime | undefined

      if (memoryEnabled) {
        const memoryDataDir = resolve(config.dataDir, 'memory-index')
        const memoryWritableDir = config.memoryWritableDir
        mkdirSync(memoryDataDir, { recursive: true })
        mkdirSync(memoryWritableDir, { recursive: true })
        memoryStore = new MemoryStore(memoryDataDir)
        memoryIndexer = createMemoryIndexer(
          memoryStore,
          projectRoot,
          {
            additionalDirs: config.memoryDirs,
            writableDir: memoryWritableDir,
          }
        )
        memorySearchInstance = new MemorySearch(memoryStore)

        memoryRuntime = new MemoryRuntime(memoryIndexer, memoryStore, {
          debounceMs: config.debounceMs,
          compactionHours: config.memoryCompactionHours,
          archiveDays: config.memoryArchiveDays,
          watchEnabled: config.memoryWatch,
          autoCreate: config.memoryAutoCreate,
          factPromotionThreshold: config.memoryFactPromotionThreshold,
          writableDir: memoryWritableDir,
          projectRoot,
          workingHistoryLimit: config.memoryWorkingHistoryLimit,
        })

        const watchedMemoryDirs = memoryIndexer.getMemoryDirs()
        if (watchedMemoryDirs.length > 0) {
          console.log(`Memory layer: scanning ${watchedMemoryDirs.length} director${watchedMemoryDirs.length === 1 ? 'y' : 'ies'}`)
          try {
            const result = await memoryRuntime.start()
            if (result.indexed > 0 || result.removed > 0) {
              console.log(
                `Memory layer: ${result.indexed} memories indexed, ${result.removed} stale removed`
              )
            } else {
              const total = memoryStore!.getCount()
              if (total > 0) {
                console.log(`Memory layer: ${total} memories up to date`)
              } else {
                console.log('Memory layer: no memories found')
              }
            }
          } catch (err) {
            console.error(`Memory layer failed to start: ${err}`)
            await memoryRuntime.stop().catch(() => {})
            memoryRuntime = undefined
          }
        } else {
          console.log('Memory layer: no memory directories found')
        }
      } else {
        console.log('Memory layer: disabled')
      }

      // Track actual FTS initialization state via a mutable container so that
      // re-index events after startup can update the flag and the server closure
      // will observe the new value without a restart.
      const ftsState = { initialized: false }
      try {
        // If FTSStore constructor succeeded (no throw), FTS is ready
        pipeline.getFTSStore().search('__probe__', 1)
        ftsState.initialized = true
      } catch {
        // FTS not ready yet; will be re-probed after successful index operations
      }

      // Start file watcher — re-probe FTS after each flush so that a recovery
      // re-index (e.g. after a corrupted startup) makes the server aware.
      const scheduler = new IndexScheduler(pipeline, rwLock)
      const watcher = new FileWatcher(config, (changes) => {
        console.log(`File changes detected: ${changes.length} files`)
        scheduler.enqueue(changes)
        if (!ftsState.initialized) {
          try {
            pipeline.getFTSStore().search('__probe__', 1)
            ftsState.initialized = true
          } catch {
            // Still not ready
          }
        }
      })
      watcher.start()
      console.log('File watcher active')

      // Start HTTP server
      const { server, metrics } = createDaemonServer(
        config,
        search,
        pipeline.getMetadataStore(),
        {
          get ftsInitialized() { return ftsState.initialized },
          debugMode: !!options.debug,
          get ftsStore() { return ftsState.initialized ? pipeline.getFTSStore() : undefined },
          memorySearch: memorySearchInstance,
          memoryRuntime
        }
      )

      const tokenPath = resolve(config.dataDir, 'daemon.token')

      server.listen(config.port, '127.0.0.1', () => {
        console.log(`HTTP server listening on http://127.0.0.1:${config.port}`)
        console.log('\nReady. Reporecall hooks will auto-inject context.')

        if (options.debug) {
          const log = getLogger()
          log.debug(
            {
              port: config.port,
              projectRoot,
              embeddingProvider: config.embeddingProvider,
              embeddingModel: config.embeddingModel,
              contextBudget: config.contextBudget,
              sessionBudget: config.sessionBudget
            },
            'daemon started with debug logging'
          )
        }
      })

      // Optionally start MCP server on stdio
      let mcpServer: McpServer | undefined
      if (options.mcp) {
        mcpServer = createMCPServer(
          search,
          pipeline,
          pipeline.getMetadataStore(),
          config,
          rwLock,
          memorySearchInstance,
          memoryIndexer,
          memoryStore,
          memoryRuntime
        )

        const { StdioServerTransport } =
          await import('@modelcontextprotocol/sdk/server/stdio.js')
        await mcpServer.connect(new StdioServerTransport())
        console.log('MCP server running on stdio')
      }

      // Graceful shutdown
      let shuttingDown = false
      const shutdown = async () => {
        if (shuttingDown) return
        shuttingDown = true
        const log = getLogger()
        log.info('Shutting down...')

        // Safety timeout: force exit if graceful shutdown hangs
        const forceExitTimer = setTimeout(() => {
          log.error('Graceful shutdown timed out after 10s, forcing exit')
          process.exit(1)
        }, 10000)
        forceExitTimer.unref()

        try {
          // Step 1: Stop accepting new connections; wait for in-flight requests
          // to drain with a 5s timeout so we don't wait forever.
          await new Promise<void>((res) => {
            const drainTimer = setTimeout(() => {
              log.warn(
                'HTTP server drain timeout (5s); proceeding with shutdown'
              )
              res()
            }, 5000)
            server.close(() => {
              clearTimeout(drainTimer)
              res()
            })
          })

          // Step 2: Stop scheduler and drain pending jobs
          scheduler.stop()
          await scheduler.drain()

          // Step 3: Stop file watcher (no more change events)
          await watcher.stop()

          // Step 4: Stop memory runtime before closing the store
          await memoryRuntime?.stop()

          // Step 5: Close MCP server if running
          if (mcpServer) {
            await mcpServer.close()
          }

          // Step 6: Destroy metrics collector (stop timers, disable histogram)
          metrics.destroy()

          // Step 7: Close memory store
          memoryStore?.close()

          // Step 8: Close all stores in order (FTS, metadata, vector via pipeline)
          // Await vector store close to prevent native library teardown race
          // that can cause libc++abi mutex errors on process exit.
          await pipeline.closeAsync()

          // Step 9: Clean up SQLite WAL sidecars for a clean next startup
          const memoryIndexDir = memoryEnabled ? resolve(config.dataDir, 'memory-index') : null
          const sidecarFiles = [
            resolve(config.dataDir, 'metadata.db-wal'),
            resolve(config.dataDir, 'metadata.db-shm'),
            resolve(config.dataDir, 'fts.db-wal'),
            resolve(config.dataDir, 'fts.db-shm'),
            ...(memoryIndexDir ? [
              resolve(memoryIndexDir, 'memories.db-wal'),
              resolve(memoryIndexDir, 'memories.db-shm'),
            ] : []),
          ]
          for (const f of sidecarFiles) {
            try {
              unlinkSync(f)
            } catch {
              /* may not exist */
            }
          }
        } catch (err) {
          log.error({ err }, 'Error during shutdown')
        }

        // Step 10: Remove PID file and release advisory lock
        if (pidFd !== undefined) {
          try {
            closeSync(pidFd)
          } catch {
            /* ignore */
          }
        }
        try {
          unlinkSync(pidPath)
        } catch {
          // ignore — may have already been removed
        }

        // Step 11: Remove token file
        try {
          unlinkSync(tokenPath)
        } catch (err) {
          log.warn(
            { err, tokenPath },
            'Failed to remove token file on shutdown'
          )
        }

        // Step 12: Flush pino logger before exiting to ensure all log lines are written
        log.flush()

        // All handles closed/unreffed — Node.js will exit naturally.
        // forceExitTimer is .unref()'d so it won't prevent exit,
        // but will fire after 10s if something hangs.
        // NOT calling process.exit(0) avoids libc++abi native
        // addon destructor races.
      }

      // Windows: SIGTERM is not sent by Task Manager/services. Only SIGINT (Ctrl+C) works.
      // Node.js emulates SIGINT on Windows, so graceful shutdown via Ctrl+C is supported.
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      // Prevent unhandled promise rejections from crashing the process noisily
      process.on('unhandledRejection', (reason) => {
        getLogger().error({ reason }, 'Unhandled promise rejection')
      })
    })
}
