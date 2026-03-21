import { Command } from 'commander'
import { resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { IndexingPipeline } from '../indexer/pipeline.js'
import { HybridSearch } from '../search/hybrid.js'
import { MemoryStore } from '../storage/memory-store.js'
import { MemorySearch } from '../memory/search.js'
import { assembleMemoryContext } from '../memory/context.js'

export function searchCommand(): Command {
  return new Command('search')
    .description(
      'Search the codebase index. Use --budget for token-limited context assembly.'
    )
    .argument('<query>', 'Search query')
    .option('--project <path>', 'Project root path')
    .option('--limit <n>', 'Max results', '10')
    .option('--budget [tokens]', 'Token budget for context (omit value for auto)')
    .option('--max-chunks <n>', 'Max context chunks per query')
    .option('--no-memory', 'Disable the memory layer')
    .action(async (query, options) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd())

      const config = loadConfig(projectRoot)
      const pipeline = new IndexingPipeline(config)

      const search = new HybridSearch(
        pipeline.getEmbedder(),
        pipeline.getVectorStore(),
        pipeline.getFTSStore(),
        pipeline.getMetadataStore(),
        config
      )

      // Initialize memory layer (only if enabled and index exists)
      const memoryEnabled = config.memory && options.memory !== false
      let memoryStore: MemoryStore | undefined
      let memorySearchInstance: MemorySearch | undefined

      if (memoryEnabled) {
        const memoryDataDir = resolve(config.dataDir, 'memory-index')
        mkdirSync(memoryDataDir, { recursive: true })
        if (existsSync(resolve(memoryDataDir, 'memories.db'))) {
          memoryStore = new MemoryStore(memoryDataDir)
          memorySearchInstance = new MemorySearch(memoryStore)
        }
      }

      try {
        // If --budget is specified, use searchWithContext for token-budgeted results
        if (options.budget !== undefined) {
          let budget: number | undefined
          if (options.budget !== true) {
            // Explicit number: --budget 5000
            const parsed = parseInt(options.budget, 10)
            if (isNaN(parsed) || parsed < 1) {
              console.error('Error: --budget must be a positive integer or omitted for auto')
              process.exit(1)
            }
            budget = parsed
          }
          // budget=undefined → searchWithContext uses auto via resolveContextBudget
          if (options.maxChunks !== undefined) {
            const parsed = parseInt(options.maxChunks, 10)
            if (!isNaN(parsed) && parsed >= 0) config.maxContextChunks = parsed
          }

          // Memory search first, then code gets remaining budget
          const totalBudget = budget ?? config.contextBudget
          const memoryBudget = config.memoryBudget ?? 500
          const memResults = memorySearchInstance
            ? await memorySearchInstance.search(query, { limit: 10 })
            : []
          const memContext = assembleMemoryContext(memResults, memoryBudget)
          const codeBudget = totalBudget - (memContext.tokenCount || 0)

          const context = await search.searchWithContext(query, codeBudget > 0 ? codeBudget : totalBudget)

          if (context.chunks.length === 0 && memContext.memories.length === 0) {
            console.log('No results found.')
            console.log(
              'Make sure the index exists — run "reporecall index" first.'
            )
            return
          }

          // Output memory context first, then code
          if (memContext.text) {
            console.log(memContext.text)
            console.log('')
          }
          console.log(context.text)
          console.log(
            `\n(${context.chunks.length} chunks, ${context.tokenCount} tokens` +
            (memContext.memories.length > 0 ? `, ${memContext.memories.length} memories, ${memContext.tokenCount} mem tokens` : '') +
            ')'
          )

          // Record access for recalled memories
          if (memorySearchInstance) {
            for (const mem of memContext.memories) {
              try { memorySearchInstance.recordAccess(mem.id); } catch { /* non-fatal */ }
            }
          }
          return
        }

        const results = await search.search(query, {
          limit: parseInt(options.limit, 10)
        })

        if (results.length === 0) {
          console.log('No results found.')
          console.log(
            'Make sure the index exists — run "reporecall index" first.'
          )
          return
        }

        for (const result of results) {
          const score = result.score.toFixed(3)
          const loc = `${result.filePath}:${result.startLine}-${result.endLine}`
          console.log(`\n[${score}] ${result.kind} ${result.name}`)
          console.log(`       ${loc}`)
          if (result.parentName) {
            console.log(`       in ${result.parentName}`)
          }
          // Show first 3 lines of content
          const lines = result.content.split('\n').slice(0, 3)
          for (const line of lines) {
            console.log(`       ${line}`)
          }
          if (result.content.split('\n').length > 3) {
            console.log('       ...')
          }
        }
      } catch (err) {
        console.error(`Search failed: ${err}`)
        process.exit(1)
      } finally {
        memoryStore?.close()
        await pipeline.closeAsync()
      }
    })
}
