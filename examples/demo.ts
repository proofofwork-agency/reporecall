#!/usr/bin/env npx tsx
/**
 * Demo: Using @proofofwork-agency/reporecall as a library
 *
 * This script shows how to programmatically:
 *   1. Load config & detect the project root
 *   2. Index a full codebase
 *   3. Search the index
 *   4. Assemble token-budgeted context for an LLM
 *   5. Explore the call graph
 *   6. Analyze coding conventions
 *
 * For speed and zero external setup, the demo forces keyword-only mode at
 * runtime even if the project config is set to local, Ollama, or OpenAI
 * embeddings.
 *
 * Usage:
 *   npx tsx examples/demo.ts                     # index + search current project
 *   npx tsx examples/demo.ts /path/to/project    # index + search another project
 *   npx tsx examples/demo.ts . "search query"    # custom search query
 */

import {
  loadConfig,
  detectProjectRoot,
  IndexingPipeline,
  HybridSearch,
  analyzeConventions
} from '../src/index.js'

// ── Helpers ────────────────────────────────────────────────────────────

function hr(title: string) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${'─'.repeat(60)}\n`)
}

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const targetDir = process.argv[2] || '.'
  const query = process.argv[3] || 'hybrid search'

  // 1. Detect project root & load config
  hr('1. Project Detection & Config')
  const projectRoot = detectProjectRoot(targetDir)
  console.log(`Project root: ${projectRoot}`)

  const config = loadConfig(projectRoot)
  console.log(`Data dir:     ${config.dataDir}`)
  console.log(
    `Embedding:    ${config.embeddingProvider} (${config.embeddingDimensions}d)`
  )
  console.log(`Extensions:   ${config.extensions.length} file types`)

  // Force keyword-only mode for a fast, dependency-light demo.
  config.embeddingProvider = 'keyword'
  config.embeddingDimensions = 0
  config.searchWeights = { vector: 0, keyword: 0.7, recency: 0.3 }
  console.log(`\n(Using keyword mode for fast demo)`)

  // 2. Index the codebase
  hr('2. Indexing')
  const pipeline = new IndexingPipeline(config)
  const t0 = performance.now()

  const result = await pipeline.indexAll((progress) => {
    if (progress.phase === 'scanning') {
      process.stdout.write(`\r  Scanning files...`)
    } else if (progress.phase === 'chunking') {
      process.stdout.write(
        `\r  Chunking: ${progress.current}/${progress.total} files`
      )
    } else if (progress.phase === 'storing') {
      process.stdout.write(`\r  Storing chunks...`)
    }
  })

  console.log(
    `\r  Indexed ${result.filesProcessed} files, ${result.chunksCreated} chunks in ${elapsed(t0)}`
  )

  // 3. Search
  hr(`3. Search: "${query}"`)
  const search = new HybridSearch(
    pipeline.getEmbedder(),
    pipeline.getVectorStore(),
    pipeline.getFTSStore(),
    pipeline.getMetadataStore(),
    config
  )

  const t1 = performance.now()
  const results = await search.search(query, { limit: 5 })
  console.log(`  Found ${results.length} results in ${elapsed(t1)}\n`)

  for (const r of results) {
    const score = r.score.toFixed(3)
    const loc = `${r.filePath}:${r.startLine}-${r.endLine}`
    const preview = r.content.split('\n')[0].slice(0, 80)
    console.log(`  [${score}] ${r.kind} ${r.name || '<anonymous>'}`)
    console.log(`          ${loc}`)
    console.log(`          ${preview}...`)
    console.log()
  }

  // 4. Token-budgeted context assembly
  hr('4. Context Assembly (2000 token budget)')
  const t2 = performance.now()
  const context = await search.searchWithContext(query, 2000)

  console.log(
    `  Assembled ${context.tokenCount} tokens from ${context.chunks.length} chunks in ${elapsed(t2)}`
  )
  console.log(`\n  --- Context preview (first 500 chars) ---`)
  console.log(context.text.slice(0, 500))
  if (context.text.length > 500) console.log('  ...(truncated)')

  // 5. Call graph exploration
  hr('5. Call Graph')
  const fnName = results[0]?.name || 'loadConfig'
  const callers = search.findCallers(fnName, 5)
  const callees = search.findCallees(fnName, 5)

  console.log(`  Function: ${fnName}`)
  console.log(`  Callers (${callers.length}):`)
  for (const c of callers.slice(0, 5)) {
    console.log(`    <- ${c.callerName || '?'} @ ${c.filePath}:${c.line}`)
  }
  console.log(`  Callees (${callees.length}):`)
  for (const c of callees.slice(0, 5)) {
    console.log(
      `    -> ${c.targetName} [${c.callType}] @ ${c.filePath}:${c.line}`
    )
  }

  // 6. Conventions analysis
  hr('6. Conventions')
  const metadata = pipeline.getMetadataStore()
  const conventions = analyzeConventions(metadata)

  console.log(
    `  Naming:     functions=${conventions.namingStyle.functions}, classes=${conventions.namingStyle.classes}`
  )
  console.log(
    `  Docstrings: ${conventions.docstringCoverage.toFixed(0)}% coverage`
  )
  console.log(
    `  Functions:  ${conventions.totalFunctions} total, avg ${conventions.averageFunctionLength.toFixed(0)} lines`
  )
  console.log(`  Classes:    ${conventions.totalClasses} total`)
  console.log(
    `  Languages:  ${Object.entries(conventions.languageDistribution)
      .map(([l, n]) => `${l}(${n})`)
      .join(', ')}`
  )
  console.log(
    `  Top calls:  ${conventions.topCallTargets.slice(0, 5).join(', ')}`
  )

  // Cleanup
  pipeline.close()

  hr('Done!')
  console.log('  Reporecall is ready to use as a library.')
  console.log(
    "  Import from '@proofofwork-agency/reporecall' and wire it into your own tools.\n"
  )
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
