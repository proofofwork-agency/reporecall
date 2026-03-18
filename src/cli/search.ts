import { Command } from 'commander'
import { resolve } from 'path'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { IndexingPipeline } from '../indexer/pipeline.js'
import { HybridSearch } from '../search/hybrid.js'

export function searchCommand(): Command {
  return new Command('search')
    .description(
      'Search the codebase index. Use --budget for token-limited context assembly.'
    )
    .argument('<query>', 'Search query')
    .option('--project <path>', 'Project root path')
    .option('--limit <n>', 'Max results', '10')
    .option('--budget <tokens>', 'Token budget for context')
    .option('--max-chunks <n>', 'Max context chunks per query')
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

      try {
        // If --budget is specified, use searchWithContext for token-budgeted results
        if (options.budget) {
          const budget = parseInt(options.budget, 10)
          if (options.maxChunks !== undefined) {
            const parsed = parseInt(options.maxChunks, 10)
            if (!isNaN(parsed)) config.maxContextChunks = parsed
          }
          const context = await search.searchWithContext(query, budget)

          if (context.chunks.length === 0) {
            console.log('No results found.')
            console.log(
              'Make sure the index exists — run "reporecall index" first.'
            )
            return
          }

          console.log(context.text)
          console.log(
            `\n(${context.chunks.length} chunks, ${context.tokenCount} tokens)`
          )
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
        pipeline.close()
      }
    })
}
