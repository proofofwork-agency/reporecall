import { Command } from 'commander'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { IndexingPipeline } from '../indexer/pipeline.js'
import { OllamaEmbedder } from '../indexer/embedder.js'
import { assertSqliteRuntimeHealthy } from '../storage/sqlite-utils.js'
import { MemoryStore } from '../storage/memory-store.js'
import { createMemoryIndexer } from '../memory/indexer.js'
import { WikiGenerator } from '../wiki/generator.js'

function progressBar(current: number, total: number, width: number): string {
  if (total === 0) return '[' + ' '.repeat(width) + ']'
  const filled = Math.round((current / total) * width)
  const empty = width - filled
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']'
}

export function indexCommand(): Command {
  return new Command('index')
    .description("Index the current project's codebase")
    .option('--project <path>', 'Project root path')
    .option('--no-wiki', 'Skip deterministic wiki/business page generation')
    .action(async (options) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd())

      const config = loadConfig(projectRoot)
      assertSqliteRuntimeHealthy({
        cwd: projectRoot,
        log: (message) => process.stderr.write(`${message}\n`),
      })

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
          console.error(
            'Or switch to OpenAI: reporecall init --embedding-provider openai'
          )
          process.exit(1)
        }
      }

      if (config.embeddingProvider === 'keyword') {
        console.log('Using keyword-only mode (no embedding model)')
      }

      console.log(`Indexing project: ${projectRoot}`)

      const pipeline = new IndexingPipeline(config)

      try {
        const result = await pipeline.indexAll((progress) => {
          if (progress.phase === 'scanning') {
            process.stdout.write('\rScanning files...')
          } else if (progress.phase === 'chunking') {
            const pct =
              progress.total > 0
                ? Math.round((progress.current / progress.total) * 100)
                : 0
            const bar = progressBar(progress.current, progress.total, 20)
            process.stdout.write(
              `\rChunking: ${bar} ${pct}% (${progress.current}/${progress.total} files)`
            )
          } else if (progress.phase === 'embedding') {
            const pct =
              progress.total > 0
                ? Math.round((progress.current / progress.total) * 100)
                : 0
            const bar = progressBar(progress.current, progress.total, 20)
            process.stdout.write(
              `\rEmbedding: ${bar} ${pct}% (${progress.current}/${progress.total} chunks)`
            )
          } else if (progress.phase === 'storing') {
            process.stdout.write('\rStoring chunks...')
          } else if (progress.phase === 'done') {
            process.stdout.write('\r' + ' '.repeat(80) + '\r')
            console.log(progress.message)
          }
        })

        console.log(
          `\nDone: ${result.filesProcessed} files, ${result.chunksCreated} chunks`
        )

        if (options.wiki !== false && config.memory) {
          await generateWiki(pipeline, config, projectRoot)
        }
      } catch (err) {
        console.error(`\nIndexing failed: ${err}`)
        process.exit(1)
      } finally {
        // Use async teardown — the synchronous close() can race native
        // vector-store destructors (libc++abi mutex errors on exit).
        await pipeline.closeAsync()
      }
    })
}

async function generateWiki(
  pipeline: IndexingPipeline,
  config: ReturnType<typeof loadConfig>,
  projectRoot: string
): Promise<void> {
  const memoryDataDir = resolve(config.dataDir, 'memory-index')
  const memoryWritableDir = config.memoryWritableDir
  mkdirSync(memoryDataDir, { recursive: true })
  mkdirSync(memoryWritableDir, { recursive: true })

  const memoryStore = new MemoryStore(memoryDataDir)
  try {
    const memoryIndexer = createMemoryIndexer(memoryStore, projectRoot, {
      additionalDirs: config.memoryDirs,
      writableDir: memoryWritableDir,
    })
    const writableDir = memoryIndexer.getWritableDirs()[0]
    if (!writableDir) {
      return
    }
    const wikiGen = new WikiGenerator(
      pipeline.getMetadataStore(),
      memoryStore,
      memoryIndexer,
      { writableDir, projectRoot }
    )
    const res = await wikiGen.generateFromIndex()
    if (res.pagesWritten > 0) {
      console.log(
        `Wiki: generated ${res.pagesWritten} pages (${res.communityPages} communities, ${res.hubPages} hubs, ${res.businessPages} business)`
      )
    } else {
      console.log('Wiki: up to date')
    }
  } catch (err) {
    console.error(`Wiki generation failed: ${err}`)
  } finally {
    memoryStore.close()
  }
}
