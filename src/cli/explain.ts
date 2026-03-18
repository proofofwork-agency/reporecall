import { Command } from 'commander'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { loadConfig, type MemoryConfig } from '../core/config.js'
import { detectProjectRoot } from '../core/project.js'
import { sanitizeQuery } from '../daemon/server.js'
import { handlePromptContextDetailed } from '../hooks/prompt-context.js'
import { IndexingPipeline } from '../indexer/pipeline.js'
import { HybridSearch } from '../search/hybrid.js'
import { classifyIntent, deriveRoute, type RouteDecision } from '../search/intent.js'
import { resolveSeeds, type SeedResult } from '../search/seed.js'

function formatRoute(route: RouteDecision): string {
  switch (route) {
    case 'skip':
      return 'skip (meta/non-code prompt)'
    case 'R1':
      return 'R1 (flow route)'
    case 'R2':
      return 'R2 (deep route)'
    default:
      return 'R0 (fast path)'
  }
}

export interface ExplainResult {
  route: RouteDecision
  intent: ReturnType<typeof classifyIntent>
  sanitizedQuery: string
  skipReason?: string
  seed: {
    name: string
    filePath: string
    kind: string
    confidence: number
    reason: string
  } | null
  seedCandidates: Array<{
    name: string
    filePath: string
    kind: string
    confidence: number
    reason: string
  }>
  tokensInjected: number
  chunksInjected: number
  chunks: Array<{
    name: string
    kind: string
    filePath: string
    lines: string
    score: number
  }>
}

export async function resolveExplainResult(
  query: string,
  config: MemoryConfig,
  pipeline: Pick<
    IndexingPipeline,
    'getMetadataStore' | 'getFTSStore' | 'getEmbedder' | 'getVectorStore'
  >
): Promise<ExplainResult> {
  const sanitized = sanitizeQuery(query)

  if (!sanitized) {
    return {
      route: 'skip',
      intent: {
        isCodeQuery: false,
        needsNavigation: false,
        skipReason: 'empty query after sanitization',
      },
      sanitizedQuery: sanitized,
      skipReason: 'empty query after sanitization',
      seed: null,
      seedCandidates: [],
      tokensInjected: 0,
      chunksInjected: 0,
      chunks: [],
    }
  }

  const intent = classifyIntent(sanitized)
  const metadata = pipeline.getMetadataStore()
  const fts = pipeline.getFTSStore()

  let seedResult: SeedResult | null = null
  let route = deriveRoute(intent)

  if (intent.needsNavigation) {
    seedResult = resolveSeeds(sanitized, metadata, fts)
    route = deriveRoute(intent, seedResult.bestSeed?.confidence ?? null)
  }

  if (route === 'skip') {
    return {
      route,
      intent,
      sanitizedQuery: sanitized,
      skipReason: intent.skipReason ?? 'non-code query',
      seed: null,
      seedCandidates: [],
      tokensInjected: 0,
      chunksInjected: 0,
      chunks: [],
    }
  }

  const search = new HybridSearch(
    pipeline.getEmbedder(),
    pipeline.getVectorStore(),
    fts,
    metadata,
    config
  )

  const promptContext = await handlePromptContextDetailed(
    sanitized,
    search,
    config,
    undefined,
    undefined,
    route,
    metadata,
    fts
  )
  route = promptContext.resolvedRoute
  const context = promptContext.context

  const bestSeed = seedResult?.bestSeed ?? null
  const seedCandidates =
    seedResult?.seeds.slice(0, 5).map((seed) => ({
      name: seed.name,
      filePath: seed.filePath,
      kind: seed.kind,
      confidence: Number(seed.confidence.toFixed(2)),
      reason: seed.reason,
    })) ?? []

  return {
    route,
    intent,
    sanitizedQuery: sanitized,
    seed: bestSeed
      ? {
          name: bestSeed.name,
          filePath: bestSeed.filePath,
          kind: bestSeed.kind,
          confidence: Number(bestSeed.confidence.toFixed(2)),
          reason: bestSeed.reason,
        }
      : null,
    seedCandidates,
    tokensInjected: context?.tokenCount ?? 0,
    chunksInjected: context?.chunks.length ?? 0,
    chunks:
      context?.chunks.map((chunk) => ({
        name: chunk.name,
        kind: chunk.kind,
        filePath: chunk.filePath,
        lines: `${chunk.startLine}-${chunk.endLine}`,
        score: Number(chunk.score.toFixed(3)),
      })) ?? [],
  }
}

export function explainCommand(): Command {
  return new Command('explain')
    .description(
      'Dry-run the retrieval pipeline for a query, showing the chosen route and injected context'
    )
    .argument('<query>', 'The query to explain')
    .option('--project <path>', 'Project root path')
    .option('--json', 'Output as JSON')
    .action(async (query: string, options) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd())

      const config = loadConfig(projectRoot)

      if (!existsSync(resolve(config.dataDir, 'metadata.db'))) {
        console.log('No index found. Run "reporecall index" first.')
        return
      }

      const pipeline = new IndexingPipeline(config)

      try {
        const result = await resolveExplainResult(query, config, pipeline)

        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        console.log(`Route:          ${formatRoute(result.route)}`)
        console.log(
          `Intent:         code=${result.intent.isCodeQuery}, navigation=${result.intent.needsNavigation}`
        )
        console.log(`Sanitized:      ${result.sanitizedQuery || '(empty)'}`)
        if (result.seed) {
          console.log(
            `Seed:           ${result.seed.name} (${result.seed.kind}, ${result.seed.filePath}) confidence=${result.seed.confidence.toFixed(2)} reason=${result.seed.reason}`
          )
        } else {
          console.log('Seed:           (none)')
        }
        if (result.skipReason) {
          console.log(`Skip reason:    ${result.skipReason}`)
        }
        console.log(`Tokens:         ${result.tokensInjected.toLocaleString()}`)
        console.log(`Chunks:         ${result.chunksInjected}`)

        if (result.seedCandidates.length > 1) {
          console.log('')
          console.log('Seed candidates:')
          for (let i = 0; i < result.seedCandidates.length; i++) {
            const seed = result.seedCandidates[i]
            if (!seed) continue
            console.log(
              `  ${i + 1}. ${seed.name} (${seed.kind}, ${seed.filePath}) confidence=${seed.confidence.toFixed(2)}`
            )
          }
        }

        if (result.chunks.length > 0) {
          console.log('')
          console.log('Chunks:')
          for (let i = 0; i < result.chunks.length; i++) {
            const chunk = result.chunks[i]
            if (!chunk) continue
            console.log(
              `  ${i + 1}. ${chunk.name} (${chunk.kind}, ${chunk.filePath}:${chunk.lines}) score=${chunk.score.toFixed(2)}`
            )
          }
        }
      } catch (err) {
        console.error(`Explain failed: ${err}`)
        process.exit(1)
      } finally {
        pipeline.close()
      }
    })
}
