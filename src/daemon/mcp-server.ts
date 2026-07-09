import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve, sep } from 'path'
import { realpathSync, unlinkSync, mkdirSync, rmSync } from 'fs'
import { readFile } from 'fs/promises'
import type { HybridSearch } from '../search/hybrid.js'
import type { IndexingPipeline } from '../indexer/pipeline.js'
import type { MetadataStore } from '../storage/metadata-store.js'
import { type MemoryConfig, resolveContextBudget } from '../core/config.js'
import type { ReadWriteLock } from '../core/rwlock.js'
import { resolveSeeds } from '../search/seed.js'
import { buildStackTree } from '../search/tree-builder.js'
import { assembleFlowContext } from '../search/context-assembler.js'
import { createRequire } from 'module'
import type { MemorySearch } from '../memory/search.js'
import type { MemoryIndexer } from '../memory/indexer.js'
import type { MemoryClass, MemoryScope, MemoryStatus, MemoryType } from '../memory/types.js'
import type { MemoryStore } from '../storage/memory-store.js'
import { resolveMemoryClass, resolveMemoryScope, resolveMemoryStatus, resolveMemorySummary } from '../memory/types.js'
import { assembleMemoryContext } from '../memory/context.js'
import type { MemoryRuntime } from './memory/runtime.js'
import { writeManagedMemoryFile, safeMemorySlug } from '../memory/files.js'
import type { WikiGenerator } from '../wiki/generator.js'
import type { WikiAutoCapture } from '../wiki/auto-capture.js'
import { checkPageStaleness } from '../wiki/staleness.js'
import { resolveAllLinks } from '../wiki/links.js'
import { suggestWikiPages } from '../wiki/suggestions.js'
import { buildBusinessContextFromMemoryStore, queryBusinessContext } from '../business/product-areas.js'
import { extractDashboardData } from '../visualize/data-extractor.js'
import type { DashboardData } from '../visualize/types.js'
import type { StoredChunk } from '../storage/types.js'
import { getLogger } from '../core/logger.js'
import { banner, clearFreshnessCache, computeFreshness, type IndexFreshness } from '../core/staleness.js'

const require = createRequire(import.meta.url)

function loadVersion(): string {
  try {
    return require('../../package.json').version
  } catch {
    try {
      return require('../package.json').version
    } catch {
      return 'unknown'
    }
  }
}

const version = loadVersion()
const PUBLIC_MCP_TOOLS = new Set([
  'search_context',
  'search_code',
  'explain_flow',
  'memory',
  'refresh_context',
  'get_stats',
])

const EMPTY_INDEX_EXEMPT_TOOLS = new Set(['get_stats', 'memory'])

function isPathSafe(projectRoot: string, p: string): boolean {
  const abs = resolve(projectRoot, p)
  if (!abs.startsWith(projectRoot + sep) && abs !== projectRoot) return false
  try {
    const realRoot = realpathSync(projectRoot)
    const realAbs = realpathSync(abs)
    return realAbs.startsWith(realRoot + sep) || realAbs === realRoot
  } catch {
    // Path does not exist yet — lexical check already passed
    return true
  }
}

function errorResult(err: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    ],
    isError: true
  }
}

interface ToolTextContent {
  type: 'text'
  text: string
}

interface ToolResultLike {
  content?: ToolTextContent[]
  isError?: boolean
  [key: string]: unknown
}

function emptyIndexPayload(freshness: IndexFreshness): Record<string, unknown> {
  return {
    banner: banner(freshness),
    message: 'Reporecall index is empty; no code context is available.',
    hint: 'run refresh_context or `reporecall index`',
    staleness: freshness
  }
}

function payloadWithStaleness(payload: unknown, freshness: IndexFreshness): Record<string, unknown> {
  const line = banner(freshness)
  const shaped = Array.isArray(payload)
    ? { results: payload, count: payload.length }
    : payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : { message: String(payload) }

  return {
    ...(line ? { banner: line } : {}),
    ...shaped,
    staleness: freshness
  }
}

function textResult(payload: Record<string, unknown>): ToolResultLike {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ]
  }
}

function addStalenessToResult(result: ToolResultLike, freshness: IndexFreshness): ToolResultLike {
  const first = result.content?.[0]
  if (!first || first.type !== 'text') {
    return textResult(payloadWithStaleness({ message: 'No text response returned by tool' }, freshness))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(first.text)
  } catch {
    parsed = { message: first.text }
  }

  const nextContent = [...(result.content ?? [])]
  nextContent[0] = {
    ...first,
    text: JSON.stringify(payloadWithStaleness(parsed, freshness), null, 2)
  }
  return {
    ...result,
    content: nextContent
  }
}

function shapeCodeChunk(chunk: StoredChunk) {
  return {
    id: chunk.id,
    name: chunk.name,
    filePath: chunk.filePath,
    kind: chunk.kind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    language: chunk.language,
    content: chunk.content,
    docstring: chunk.docstring,
    parentName: chunk.parentName,
  }
}

function findBestChunkByLocation(
  metadata: MetadataStore,
  filePath: string | undefined,
  startLine: number | undefined,
  endLine: number | undefined
): StoredChunk | undefined {
  if (!filePath) return undefined
  const chunks = metadata.findChunksByFilePath(filePath)
  if (chunks.length === 0) return undefined
  if (startLine === undefined && endLine === undefined) return chunks[0]

  const start = startLine ?? endLine ?? 1
  const end = endLine ?? startLine ?? start
  const overlapping = chunks
    .filter((chunk) => chunk.startLine <= end && chunk.endLine >= start)
    .sort((a, b) => {
      const aContains = a.startLine <= start && a.endLine >= end ? 0 : 1
      const bContains = b.startLine <= start && b.endLine >= end ? 0 : 1
      const aDistance = Math.abs(a.startLine - start) + Math.abs(a.endLine - end)
      const bDistance = Math.abs(b.startLine - start) + Math.abs(b.endLine - end)
      return aContains - bContains || aDistance - bDistance
    })
  return overlapping[0]
}

function shapeLensData(
  data: DashboardData,
  options: {
    includeWikiContent?: boolean
    includeBusinessPages?: boolean
    includeGraph?: boolean
  }
): DashboardData {
  const includeWikiContent = options.includeWikiContent === true
  const includeBusinessPages = options.includeBusinessPages !== false
  const includeGraph = options.includeGraph !== false

  return {
    ...data,
    communities: includeGraph ? data.communities : [],
    hubs: includeGraph ? data.hubs : [],
    surprises: includeGraph ? data.surprises : [],
    questions: includeGraph ? data.questions : [],
    wikiPages: data.wikiPages.map((page) => ({
      ...page,
      content: includeWikiContent ? page.content : ''
    })),
    wikiGraphNodes: includeGraph ? data.wikiGraphNodes : [],
    wikiGraphEdges: includeGraph ? data.wikiGraphEdges : [],
    businessPages: includeBusinessPages
      ? data.businessPages.map((page) => ({
          ...page,
          content: includeWikiContent ? page.content : ''
        }))
      : [],
    productAreas: includeBusinessPages ? data.productAreas : [],
    chordMatrix: includeGraph ? data.chordMatrix : [],
    chordLabels: includeGraph ? data.chordLabels : [],
    chordColors: includeGraph ? data.chordColors : []
  }
}

function memoryClassBudgets(tokenBudget: number): Record<MemoryClass, number> {
  return {
    rule: Math.floor(tokenBudget * 0.35),
    working: Math.floor(tokenBudget * 0.2),
    fact: Math.floor(tokenBudget * 0.3),
    episode: Math.floor(tokenBudget * 0.15),
  }
}

export function createMCPServer(
  search: HybridSearch,
  pipeline: IndexingPipeline,
  initialMetadata: MetadataStore,
  config: MemoryConfig,
  lock?: ReadWriteLock,
  memorySearch?: MemorySearch,
  memoryIndexer?: MemoryIndexer,
  memoryStore?: MemoryStore,
  memoryRuntime?: MemoryRuntime,
  wikiGenerator?: WikiGenerator,
  wikiAutoCapture?: WikiAutoCapture
): McpServer {
  let metadata = initialMetadata
  const server = new McpServer({
    name: 'reporecall',
    version
  })

  const registerTool = ((name: string, toolConfig: any, handler: any) => {
    if (!PUBLIC_MCP_TOOLS.has(name)) return undefined as any
    return (server.registerTool as any)(name, toolConfig, async (...callArgs: unknown[]) => {
      const readOnly = toolConfig.annotations?.readOnlyHint === true
      if (!readOnly) return handler(...callArgs)

      const freshness = computeFreshness(metadata, config.projectRoot)
      if (freshness.level === 'empty' && !EMPTY_INDEX_EXEMPT_TOOLS.has(name)) {
        return textResult(emptyIndexPayload(freshness))
      }

      const result = await handler(...callArgs) as ToolResultLike
      if (result.isError) return result
      return addStalenessToResult(result, freshness)
    })
  }) as McpServer['registerTool']

  const indexAndRegenerateWiki = async (paths?: string[]) => {
    let index: unknown
    if (paths && paths.length > 0) {
      const safePaths = paths.filter((p: string) => isPathSafe(config.projectRoot, p))
      index = await pipeline.indexChanged(safePaths)
    } else {
      index = await pipeline.indexAll()
    }
    clearFreshnessCache()

    let wiki: unknown = null
    if (wikiGenerator) {
      try {
        wiki = await wikiGenerator.generateFromIndex()
      } catch (err) {
        getLogger().warn({ err }, 'Wiki generation after index failed')
      }
    }

    return { index, wiki }
  }

  registerTool(
    'search_code',
    {
      description: 'Search raw code chunks or read an exact indexed chunk. Use action=search for raw hits, action=read_chunk with chunkId or filePath/line range for full source. Returns staleness on search/read responses.',
      inputSchema: {
        action: z.enum(['search', 'read_chunk']).optional().describe('Operation to run (default: search)'),
        query: z.string().min(1).optional().describe('Search query for action=search'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max results (default 20)'),
        activeFiles: z
          .array(z.string())
          .optional()
          .describe('Currently open file paths for boosting'),
        chunkId: z.string().min(1).optional().describe('Exact chunk id for action=read_chunk'),
        filePath: z.string().min(1).optional().describe('Indexed project-relative file path for action=read_chunk'),
        startLine: z.number().int().min(1).optional().describe('Start line for file path lookup'),
        endLine: z.number().int().min(1).optional().describe('End line for file path lookup')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ action, query, limit, activeFiles, chunkId, filePath, startLine, endLine }) => {
      try {
        const doSearch = async () => {
          if ((action ?? 'search') === 'read_chunk') {
            const chunk = chunkId
              ? metadata.getChunk(chunkId)
              : findBestChunkByLocation(metadata, filePath, startLine, endLine)

            if (!chunk) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ error: 'chunk not found', chunkId, filePath, startLine, endLine }, null, 2)
                  }
                ],
                isError: true
              }
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ action: 'read_chunk', chunk: shapeCodeChunk(chunk) }, null, 2)
                }
              ]
            }
          }

          if (!query) throw new Error('query is required for search_code action=search')
          const results = await search.search(query, { limit, activeFiles })
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    action: 'search',
                    results: results.map((r) => ({
                      name: r.name,
                      id: r.id,
                      filePath: r.filePath,
                      kind: r.kind,
                      startLine: r.startLine,
                      endLine: r.endLine,
                      score: r.score,
                      content: r.content,
                      docstring: r.docstring,
                      parentName: r.parentName,
                      language: r.language
                    })),
                    count: results.length
                  },
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(doSearch) : doSearch()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'search_context',
    {
      description:
        'Return assembled, token-budgeted code context for a multi-file question. Uses Reporecall routing and evidence compression; compressed entries can be expanded with search_code action=read_chunk.',
      inputSchema: {
        query: z.string().min(1).describe('Natural language codebase question'),
        tokenBudget: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Optional context token budget; defaults to configured auto budget'),
        activeFiles: z
          .array(z.string())
          .optional()
          .describe('Currently open file paths for boosting')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query, tokenBudget, activeFiles }) => {
      try {
        const doSearchContext = async () => {
          const budget = tokenBudget ?? resolveContextBudget(
            config.contextBudget,
            metadata.getStats().totalChunks
          )
          const context = await search.searchWithContext(query, budget, activeFiles)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    text: context.text,
                    tokenCount: context.tokenCount,
                    chunksIncluded: context.chunks.length,
                    routeStyle: context.routeStyle,
                    deliveryMode: context.deliveryMode,
                    selectedFiles: [...new Set(context.chunks.map((chunk) => chunk.filePath))],
                    chunks: context.chunks.map((chunk) => ({
                      id: chunk.id,
                      name: chunk.name,
                      filePath: chunk.filePath,
                      kind: chunk.kind,
                      startLine: chunk.startLine,
                      endLine: chunk.endLine,
                      score: chunk.score,
                      language: chunk.language,
                    })),
                    compression: context.compression,
                  },
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(doSearchContext) : doSearchContext()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'read_code_chunk',
    {
      description: 'Read the full original source for a code chunk by chunkId, or by file path and line range.',
      inputSchema: {
        chunkId: z.string().min(1).optional().describe('Exact chunk id from search_code or compressed context'),
        filePath: z.string().min(1).optional().describe('Indexed project-relative file path'),
        startLine: z.number().int().min(1).optional().describe('Start line for file path lookup'),
        endLine: z.number().int().min(1).optional().describe('End line for file path lookup')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ chunkId, filePath, startLine, endLine }) => {
      try {
        const readChunk = async () => {
          const chunk = chunkId
            ? metadata.getChunk(chunkId)
            : findBestChunkByLocation(metadata, filePath, startLine, endLine)

          if (!chunk) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'chunk not found', chunkId, filePath, startLine, endLine }, null, 2)
                }
              ],
              isError: true
            }
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(shapeCodeChunk(chunk), null, 2)
              }
            ]
          }
        }
        return lock ? await lock.withRead(readChunk) : readChunk()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'index_codebase',
    {
      description: 'Index or re-index the codebase. Also regenerates deterministic wiki/business pages when the wiki layer is enabled.',
      inputSchema: {
        paths: z
          .array(z.string().max(4096))
          .max(1000)
          .optional()
          .describe('Specific file paths to re-index (omit for full index)')
      },
      annotations: { destructiveHint: true }
    },
    async ({ paths }) => {
      try {
        const refreshed = lock
          ? await lock.withWrite(() => indexAndRegenerateWiki(paths))
          : await indexAndRegenerateWiki(paths)

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ...(refreshed.index as Record<string, unknown>), wiki: refreshed.wiki })
            }
          ]
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'refresh_context',
    {
      description:
        'Refresh Reporecall context for external tools: re-index code, regenerate deterministic wiki/business pages when enabled, and return optional updated stats.',
      inputSchema: {
        paths: z
          .array(z.string().max(4096))
          .max(1000)
          .optional()
          .describe('Specific file paths to refresh (omit for full project refresh)'),
        includeStats: z
          .boolean()
          .optional()
          .describe('Include updated index statistics in the response (default true)')
      },
      annotations: { destructiveHint: true }
    },
    async ({ paths, includeStats }) => {
      try {
        const refreshed = lock
          ? await lock.withWrite(() => indexAndRegenerateWiki(paths))
          : await indexAndRegenerateWiki(paths)
        const stats = includeStats === false
          ? undefined
          : {
              ...metadata.getStats(),
              lastIndexedAt: metadata.getStat('lastIndexedAt')
            }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                index: refreshed.index,
                wiki: refreshed.wiki,
                stats: stats ?? null
              }, null, 2)
            }
          ]
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'get_lens_data',
    {
      description:
        'Return current Reporecall Lens JSON from the existing index. Read-only; call refresh_context first when fresh indexing/wiki generation is required.',
      inputSchema: {
        maxCommunities: z.number().int().min(1).max(100).optional().describe('Max communities to include (default 20)'),
        maxHubs: z.number().int().min(1).max(100).optional().describe('Max hub nodes to include (default 15)'),
        maxSurprises: z.number().int().min(1).max(100).optional().describe('Max surprise edges to include (default 20)'),
        includeWikiContent: z.boolean().optional().describe('Include raw wiki/business markdown content (default false)'),
        includeBusinessPages: z.boolean().optional().describe('Include businessPages[] and productAreas[] (default true)'),
        includeGraph: z.boolean().optional().describe('Include graph-heavy topology and wiki graph arrays (default true)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ maxCommunities, maxHubs, maxSurprises, includeWikiContent, includeBusinessPages, includeGraph }) => {
      try {
        const doLens = () => {
          const data = extractDashboardData(metadata, memoryStore ?? null, {
            projectRoot: config.projectRoot,
            maxCommunities,
            maxHubs,
            maxSurprises
          })
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  shapeLensData(data, { includeWikiContent, includeBusinessPages, includeGraph }),
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doLens()) : doLens()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'get_stats',
    {
      description: 'Get index statistics, conventions, and latency info',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async () => {
      try {
        const doStats = () => {
          const stats = metadata.getStats()
          const conventions = metadata.getConventions()
          const latency = metadata.getLatencyPercentiles()
          const lastIndexed = metadata.getStat('lastIndexedAt')
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { ...stats, lastIndexedAt: lastIndexed, conventions, latency },
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doStats()) : doStats()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'clear_index',
    {
      description: 'Clear all indexed data',
      inputSchema: {
        confirm: z.boolean().describe('Must be true to proceed')
      },
      annotations: { destructiveHint: true }
    },
    async ({ confirm }) => {
      try {
        if (!confirm) {
          return {
            content: [
              { type: 'text' as const, text: 'Aborted: confirm must be true' }
            ]
          }
        }

        const doClear = async () => {
          // Close stores and wipe merkle state before deleting files
          await pipeline.closeAndClearMerkle()

          const files = [
            'metadata.db',
            'metadata.db-wal',
            'metadata.db-shm',
            'fts.db',
            'fts.db-wal',
            'fts.db-shm'
          ]
          for (const f of files) {
            try {
              rmSync(resolve(config.dataDir, f))
            } catch (e: unknown) {
              if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
            }
          }
          const lanceDir = resolve(config.dataDir, 'lance')
          try {
            rmSync(lanceDir, { recursive: true })
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
          }

          // Reinitialize pipeline with fresh stores so subsequent calls work
          await pipeline.reinit()

          // Update search to use the new store instances (awaits the write lock).
          await search.updateStores(
            pipeline.getVectorStore(),
            pipeline.getFTSStore(),
            pipeline.getMetadataStore()
          )

          // Update metadata reference for get_stats tool
          metadata = pipeline.getMetadataStore()
          clearFreshnessCache()
        }

        if (lock) {
          await lock.withWrite(doClear)
        } else {
          await doClear()
        }

        return {
          content: [{ type: 'text' as const, text: 'Index cleared successfully' }]
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'find_callers',
    {
      description: 'Find functions that call a given function',
      inputSchema: {
        functionName: z
          .string()
          .min(1)
          .describe('Name of the function to find callers for'),
        limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ functionName, limit }) => {
      try {
        const doFind = () => {
          const callers = search.findCallers(functionName, limit)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(callers, null, 2)
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doFind()) : doFind()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'find_callees',
    {
      description: 'Find functions called by a given function',
      inputSchema: {
        functionName: z
          .string()
          .min(1)
          .describe('Name of the function to find callees for'),
        limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ functionName, limit }) => {
      try {
        const doFind = () => {
          const callees = search.findCallees(functionName, limit)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(callees, null, 2)
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doFind()) : doFind()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'resolve_seed',
    {
      description:
        'Resolve a query to seed candidates for stack tree building. Returns ranked code symbols that best match the query.',
      inputSchema: {
        query: z.string().min(1).describe('Natural language query or code symbol name')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query }) => {
      try {
        const doResolve = () => {
          const ftsStore = pipeline.getFTSStore()
          const result = resolveSeeds(query, metadata, ftsStore)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    bestSeed: result.bestSeed,
                    candidates: result.seeds,
                    count: result.seeds.length
                  },
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doResolve()) : doResolve()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'build_stack_tree',
    {
      description:
        'Build a bidirectional call tree from a seed function/method. Shows callers (who invokes it) and callees (what it invokes).',
      inputSchema: {
        seed: z
          .string()
          .min(1)
          .describe('Function or method name to use as the tree seed'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum tree depth (default: 2)'),
        direction: z
          .enum(['up', 'down', 'both'])
          .optional()
          .describe('Tree direction (default: both)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ seed, depth, direction }) => {
      try {
        const doBuild = () => {
          const ftsStore = pipeline.getFTSStore()
          const seedResult = resolveSeeds(seed, metadata, ftsStore)
          if (!seedResult.bestSeed) {
            return null
          }

          const tree = buildStackTree(metadata, {
            seed: seedResult.bestSeed,
            direction: direction ?? 'both',
            maxDepth: depth ?? 2,
            maxBranchFactor: 3,
            maxNodes: 24
          })

          const allNodes = [tree.seed, ...tree.upTree, ...tree.downTree]
          return {
            tree,
            seedName: seedResult.bestSeed.name,
            relatedFiles: [...new Set(allNodes.map(n => n.filePath).filter(Boolean))],
            relatedSymbols: [...new Set(allNodes.map(n => n.name))]
          }
        }
        const built = lock ? await lock.withRead(async () => doBuild()) : doBuild()
        if (!built) {
          return {
            content: [{ type: 'text' as const, text: `No matching code symbol found for "${seed}"` }]
          }
        }

        const treeJson = JSON.stringify(
          {
            seed: built.tree.seed,
            upTree: built.tree.upTree,
            downTree: built.tree.downTree,
            edges: built.tree.edges,
            nodeCount: built.tree.nodeCount,
            coverage: built.tree.coverage
          },
          null,
          2
        )

        // Fire-and-forget wiki auto-capture
        if (wikiAutoCapture) {
          wikiAutoCapture.captureTreeResult(
            seed, built.seedName, treeJson,
            built.relatedFiles, built.relatedSymbols
          ).catch(err => getLogger().warn({ err }, 'Wiki auto-capture (tree) failed'))
        }

        return {
          content: [{ type: 'text' as const, text: treeJson }]
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'get_imports',
    {
      description:
        'Get import statements for a file. Shows what modules/symbols a file imports.',
      inputSchema: {
        filePath: z
          .string()
          .min(1)
          .describe('Relative file path (e.g., src/auth/handler.ts)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ filePath }) => {
      try {
        if (!isPathSafe(config.projectRoot, filePath)) {
          return errorResult(new Error('Path outside project root'))
        }

        const doGet = () => {
          const imports = metadata.getImportsForFile(filePath)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    filePath,
                    imports: imports.map((i) => ({
                      name: i.importedName,
                      from: i.sourceModule,
                      resolvedPath: i.resolvedPath,
                      isDefault: i.isDefault,
                      isNamespace: i.isNamespace
                    })),
                    count: imports.length
                  },
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doGet()) : doGet()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'get_symbol',
    {
      description:
        'Look up code symbols (functions, classes, methods) by name. Returns matching chunks with file path, lines, and kind.',
      inputSchema: {
        name: z.string().min(1).describe('Symbol name to look up (e.g., "authenticate", "UserService")')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ name }) => {
      try {
        const doGet = () => {
          const matches = metadata.findChunksByNames([name])
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    symbol: name,
                    matches: matches.map((m) => ({
                      name: m.name,
                      kind: m.kind,
                      filePath: m.filePath,
                      startLine: m.startLine,
                      endLine: m.endLine,
                      content: m.content,
                      parentName: m.parentName,
                      language: m.language
                    })),
                    count: matches.length
                  },
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doGet()) : doGet()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  registerTool(
    'explain_flow',
    {
      description:
        'Code navigation verb tool. action=flow returns assembled call-flow context; callers/callees/stack_tree/imports/symbol/resolve_seed return focused graph or symbol details.',
      inputSchema: {
        action: z
          .enum(['flow', 'callers', 'callees', 'stack_tree', 'imports', 'symbol', 'resolve_seed'])
          .optional()
          .describe('Navigation action to run (default: flow)'),
        query: z.string().min(1).optional().describe('Natural language query or function/symbol name'),
        functionName: z.string().min(1).optional().describe('Function name for callers/callees'),
        name: z.string().min(1).optional().describe('Symbol name for action=symbol'),
        seed: z.string().min(1).optional().describe('Function or method name for action=stack_tree'),
        filePath: z.string().min(1).optional().describe('Relative file path for action=imports'),
        limit: z.number().int().min(1).max(500).optional().describe('Max results for callers/callees (default 20)'),
        direction: z
          .enum(['up', 'down', 'both'])
          .optional()
          .describe('Tree direction (default: both)'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum tree depth (default: 2)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ action, query, functionName, name, seed, filePath, limit, direction, maxDepth }) => {
      try {
        const doExplain = () => {
          const selectedAction = action ?? 'flow'
          if (selectedAction === 'callers') {
            const target = functionName ?? query ?? name
            if (!target) throw new Error('functionName or query is required for explain_flow action=callers')
            const callers = search.findCallers(target, limit)
            return {
              action: selectedAction,
              payload: { functionName: target, callers, count: callers.length },
              relatedFiles: callers.map((caller) => caller.filePath).filter(Boolean),
              relatedSymbols: callers.map((caller) => caller.callerName).filter(Boolean),
            }
          }

          if (selectedAction === 'callees') {
            const target = functionName ?? query ?? name
            if (!target) throw new Error('functionName or query is required for explain_flow action=callees')
            const callees = search.findCallees(target, limit)
            return {
              action: selectedAction,
              payload: { functionName: target, callees, count: callees.length },
              relatedFiles: callees.map((callee) => callee.filePath).filter(Boolean),
              relatedSymbols: callees.map((callee) => callee.targetName).filter(Boolean),
            }
          }

          if (selectedAction === 'imports') {
            if (!filePath) throw new Error('filePath is required for explain_flow action=imports')
            if (!isPathSafe(config.projectRoot, filePath)) throw new Error('Path outside project root')
            const imports = metadata.getImportsForFile(filePath)
            return {
              action: selectedAction,
              payload: {
                filePath,
                imports: imports.map((i) => ({
                  name: i.importedName,
                  from: i.sourceModule,
                  resolvedPath: i.resolvedPath,
                  isDefault: i.isDefault,
                  isNamespace: i.isNamespace
                })),
                count: imports.length
              },
              relatedFiles: imports.map((i) => i.resolvedPath).filter((p): p is string => Boolean(p)),
              relatedSymbols: imports.map((i) => i.importedName).filter(Boolean),
            }
          }

          if (selectedAction === 'symbol') {
            const symbolName = name ?? query
            if (!symbolName) throw new Error('name or query is required for explain_flow action=symbol')
            const matches = metadata.findChunksByNames([symbolName])
            return {
              action: selectedAction,
              payload: {
                symbol: symbolName,
                matches: matches.map((m) => ({
                  name: m.name,
                  kind: m.kind,
                  filePath: m.filePath,
                  startLine: m.startLine,
                  endLine: m.endLine,
                  content: m.content,
                  parentName: m.parentName,
                  language: m.language
                })),
                count: matches.length
              },
              relatedFiles: matches.map((m) => m.filePath),
              relatedSymbols: matches.map((m) => m.name),
            }
          }

          const ftsStore = pipeline.getFTSStore()
          const seedQuery = selectedAction === 'stack_tree'
            ? seed ?? query ?? name
            : query ?? seed ?? name
          if (!seedQuery) throw new Error('query or seed is required for explain_flow')
          const seedResult = resolveSeeds(seedQuery, metadata, ftsStore)
          if (selectedAction === 'resolve_seed') {
            return {
              action: selectedAction,
              payload: {
                bestSeed: seedResult.bestSeed,
                candidates: seedResult.seeds,
                count: seedResult.seeds.length
              },
              relatedFiles: seedResult.seeds.map((candidate) => candidate.filePath).filter(Boolean),
              relatedSymbols: seedResult.seeds.map((candidate) => candidate.name).filter(Boolean),
            }
          }
          if (!seedResult.bestSeed) {
            return null
          }

          const tree = buildStackTree(metadata, {
            seed: seedResult.bestSeed,
            direction: direction ?? 'both',
            maxDepth: maxDepth ?? 2,
            maxBranchFactor: 3,
            maxNodes: 24,
            query: seedQuery
          })

          if (selectedAction === 'stack_tree') {
            const allNodes = [tree.seed, ...tree.upTree, ...tree.downTree]
            return {
              action: selectedAction,
              payload: {
                seed: tree.seed,
                upTree: tree.upTree,
                downTree: tree.downTree,
                edges: tree.edges,
                nodeCount: tree.nodeCount,
                coverage: tree.coverage
              },
              capture: {
                type: 'tree' as const,
                seedQuery,
                seedName: seedResult.bestSeed.name,
              },
              relatedFiles: [...new Set(allNodes.map(n => n.filePath).filter(Boolean))],
              relatedSymbols: [...new Set(allNodes.map(n => n.name))],
            }
          }

          const flowBudget = resolveContextBudget(
            config.contextBudget,
            metadata.getStats().totalChunks
          )
          const flowContext = assembleFlowContext(
            tree,
            metadata,
            flowBudget,
            seedQuery,
            {
              contextCompressionEnabled: config.contextCompressionEnabled,
              contextCompressionMode: config.contextCompressionMode,
              contextCompressionPreserveTopChunks: config.contextCompressionPreserveTopChunks,
              contextCompressionMinChunkTokens: config.contextCompressionMinChunkTokens,
              contextCompressionTargetRatio: config.contextCompressionTargetRatio,
            }
          )

          const allNodes = [tree.seed, ...tree.upTree, ...tree.downTree]
          return {
            action: 'flow',
            payload: {
              seed: {
                name: seedResult.bestSeed.name,
                filePath: seedResult.bestSeed.filePath,
                kind: seedResult.bestSeed.kind,
                confidence: seedResult.bestSeed.confidence
              },
              tree: {
                nodeCount: tree.nodeCount,
                upCount: tree.upTree.length,
                downCount: tree.downTree.length,
                coverage: tree.coverage
              },
              flowContext: flowContext.text,
              tokenCount: flowContext.tokenCount,
              chunksIncluded: flowContext.chunks.length,
              compression: flowContext.compression
            },
            capture: {
              type: 'flow' as const,
              query: seedQuery,
              seedName: seedResult.bestSeed.name,
              text: flowContext.text,
            },
            relatedFiles: [...new Set(flowContext.chunks.map(c => c.filePath).filter(Boolean))],
            relatedSymbols: [...new Set(allNodes.map(n => n.name))]
          }
        }
        const explained = lock ? await lock.withRead(async () => doExplain()) : doExplain()
        if (!explained) {
          return {
            content: [{ type: 'text' as const, text: `No matching code symbol found for "${query ?? seed ?? name ?? functionName ?? ''}"` }]
          }
        }

        const flowJson = JSON.stringify(
          {
            action: explained.action,
            ...explained.payload,
          },
          null,
          2
        )

        if (wikiAutoCapture && explained.capture?.type === 'flow') {
          wikiAutoCapture.captureFlowResult(
            explained.capture.query, explained.capture.text, explained.capture.seedName,
            explained.relatedFiles, explained.relatedSymbols
          ).catch(err => getLogger().warn({ err }, 'Wiki auto-capture (flow) failed'))
        }
        if (wikiAutoCapture && explained.capture?.type === 'tree') {
          wikiAutoCapture.captureTreeResult(
            explained.capture.seedQuery, explained.capture.seedName, flowJson,
            explained.relatedFiles, explained.relatedSymbols
          ).catch(err => getLogger().warn({ err }, 'Wiki auto-capture (tree) failed'))
        }

        return {
          content: [{ type: 'text' as const, text: flowJson }]
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  // --- Memory tools (only registered when memory layer is available) ---

  if (memorySearch && memoryIndexer) {
    registerTool(
      'memory',
      {
        description:
          'Project memory verb tool. Use action=recall|explain|list for reads and action=store|forget for explicit memory writes. Memory is independent of the code index.',
        inputSchema: {
          action: z
            .enum(['recall', 'explain', 'list', 'store', 'forget'])
            .describe('Memory action to run'),
          query: z.string().min(1).optional().describe('Search query for recall/explain'),
          limit: z.number().int().min(1).max(50).optional().describe('Max results'),
          tokenBudget: z.number().min(0).optional().describe('Memory token budget for action=explain'),
          types: z.array(z.enum(['user', 'feedback', 'project', 'reference'])).optional().describe('Filter by memory type'),
          classes: z.array(z.enum(['rule', 'fact', 'episode', 'working'])).optional().describe('Filter by memory class'),
          scopes: z.array(z.enum(['global', 'project', 'branch'])).optional().describe('Filter by memory scope'),
          statuses: z.array(z.enum(['active', 'archived', 'superseded'])).optional().describe('Filter by memory status'),
          activeFiles: z.array(z.string()).optional().describe('Active file paths for contextual boosting'),
          topCodeFiles: z.array(z.string()).optional().describe('Top code file paths for contextual boosting'),
          topCodeSymbols: z.array(z.string()).optional().describe('Top code symbols for contextual boosting'),
          minConfidence: z.number().min(0).max(1).optional().describe('Minimum confidence score'),
          memoryType: z.enum(['user', 'feedback', 'project', 'reference']).optional().describe('Memory type for list/store'),
          memoryClass: z.enum(['rule', 'fact', 'episode', 'working']).optional().describe('Memory class for list/store'),
          memoryScope: z.enum(['global', 'project', 'branch']).optional().describe('Memory scope for list/store'),
          memoryStatus: z.enum(['active', 'archived', 'superseded']).optional().describe('Memory status for list/store'),
          name: z.string().min(1).max(200).optional().describe('Memory name for store/forget'),
          description: z.string().min(1).max(500).optional().describe('One-line memory description for store'),
          content: z.string().min(1).optional().describe('Memory markdown content for store'),
          summary: z.string().max(500).optional().describe('Optional compressed summary for store'),
          sourceKind: z.enum(['claude_auto', 'reporecall_local', 'generated']).optional().describe('Optional source kind for store'),
          pinned: z.boolean().optional().describe('Whether the stored memory should stay pinned'),
          relatedFiles: z.array(z.string()).optional().describe('Related file paths for store'),
          relatedSymbols: z.array(z.string()).optional().describe('Related symbols for store'),
          supersedesId: z.string().optional().describe('Superseded memory ID for store'),
          confidence: z.number().min(0).max(1).optional().describe('Confidence score for store'),
          reason: z.string().max(500).optional().describe('Lifecycle or compaction reason for store'),
        }
      },
      async ({
        action,
        query,
        limit,
        tokenBudget,
        types,
        classes,
        scopes,
        statuses,
        activeFiles,
        topCodeFiles,
        topCodeSymbols,
        minConfidence,
        memoryType,
        memoryClass,
        memoryScope,
        memoryStatus,
        name,
        description,
        content,
        summary,
        sourceKind,
        pinned,
        relatedFiles,
        relatedSymbols,
        supersedesId,
        confidence,
        reason
      }) => {
        try {
          if (action === 'recall') {
            if (!query) throw new Error('query is required for memory action=recall')
            const doRecall = async () => {
              const results = await memorySearch.search(query, {
                limit,
                types: types as MemoryType[] | undefined,
                classes: classes as MemoryClass[] | undefined,
                scopes: scopes as MemoryScope[] | undefined,
                statuses: statuses as MemoryStatus[] | undefined,
                activeFiles,
                topCodeFiles,
                topCodeSymbols,
                minConfidence,
              })
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      action: 'recall',
                      memories: results.map((r) => ({
                        name: r.name,
                        description: r.description,
                        type: r.type,
                        class: r.class,
                        scope: r.scope,
                        status: r.status,
                        summary: r.summary,
                        confidence: r.confidence,
                        content: r.content,
                        score: r.score,
                        filePath: r.filePath
                      })),
                      count: results.length
                    }, null, 2)
                  }
                ]
              }
            }
            return lock ? await lock.withRead(doRecall) : doRecall()
          }

          if (action === 'explain') {
            if (!query) throw new Error('query is required for memory action=explain')
            const doExplain = async () => {
              const budget = tokenBudget ?? 500
              const results = await memorySearch.search(query, {
                limit: limit ?? 8,
                types: types as MemoryType[] | undefined,
                classes: classes as MemoryClass[] | undefined,
                scopes: scopes as MemoryScope[] | undefined,
                statuses: statuses as MemoryStatus[] | undefined,
                activeFiles,
                topCodeFiles,
                topCodeSymbols,
                minConfidence,
              })
              const assembled = assembleMemoryContext(results, budget, {
                classBudgets: memoryClassBudgets(budget),
              })
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      action: 'explain',
                      route: assembled.route,
                      budget: assembled.budget,
                      selected: assembled.memories.map((memory) => ({
                        name: memory.name,
                        class: resolveMemoryClass(memory),
                        scope: resolveMemoryScope(memory),
                        status: resolveMemoryStatus(memory),
                        summary: resolveMemorySummary(memory),
                        score: memory.score,
                        filePath: memory.filePath,
                      })),
                      dropped: assembled.dropped.map((memory) => ({
                        name: memory.name,
                        class: memory.class ?? resolveMemoryClass(memory),
                        reason: memory.dropReason,
                        filePath: memory.filePath,
                      })),
                      text: assembled.text,
                      tokenCount: assembled.tokenCount,
                    }, null, 2)
                  }
                ]
              }
            }
            return lock ? await lock.withRead(doExplain) : doExplain()
          }

          if (action === 'list') {
            const doList = () => {
              if (!memoryStore) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({ action: 'list', memories: [], count: 0 })
                    }
                  ]
                }
              }
              const memories = memoryType
                ? memoryStore.getByType(memoryType as MemoryType)
                : memoryStore.getAll()
              const filtered = memories.filter((memory) => {
                if (memoryClass && resolveMemoryClass(memory) !== memoryClass) return false
                if (memoryScope && resolveMemoryScope(memory) !== memoryScope) return false
                if (memoryStatus && resolveMemoryStatus(memory) !== memoryStatus) return false
                return true
              })
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      action: 'list',
                      memories: filtered.map((m) => ({
                        name: m.name,
                        type: m.type,
                        class: resolveMemoryClass(m),
                        scope: resolveMemoryScope(m),
                        status: resolveMemoryStatus(m),
                        description: m.description,
                        summary: resolveMemorySummary(m),
                        accessCount: m.accessCount,
                        lastAccessed: m.lastAccessed,
                        importance: m.importance,
                        pinned: m.pinned,
                        sourceKind: m.sourceKind,
                        confidence: m.confidence,
                        relatedFiles: m.relatedFiles,
                        relatedSymbols: m.relatedSymbols,
                        supersedesId: m.supersedesId,
                        reason: m.reason,
                        filePath: m.filePath
                      })),
                      count: filtered.length
                    }, null, 2)
                  }
                ]
              }
            }
            return lock ? await lock.withRead(async () => doList()) : doList()
          }

          if (action === 'store') {
            if (!name) throw new Error('name is required for memory action=store')
            if (!description) throw new Error('description is required for memory action=store')
            if (!memoryType) throw new Error('memoryType is required for memory action=store')
            if (!content) throw new Error('content is required for memory action=store')
            const doStore = async (): Promise<{ content: Array<{ type: 'text'; text: string }> } | { __filePath: string }> => {
              const writableDirs = memoryIndexer.getWritableDirs()
              if (writableDirs.length === 0) {
                throw new Error('No memory directory configured')
              }

              const targetDir = writableDirs[0]!
              mkdirSync(targetDir, { recursive: true })

              if (memoryStore) {
                const existing = memoryStore.getByName(name)
                if (!existing) {
                  const similar = memoryStore.search(name, 5)
                  const nameLower = name.toLowerCase()
                  const blocked = similar.find((match) => {
                    const existingMem = memoryStore.get(match.id)
                    if (!existingMem || existingMem.name === name) return false
                    if (match.rank > -25) return false
                    const existingLower = existingMem.name.toLowerCase()
                    const overlapLen = Math.max(10, Math.floor(Math.max(existingLower.length, nameLower.length) * 0.40))
                    const nameOverlap =
                      existingLower.includes(nameLower.slice(0, overlapLen)) ||
                      nameLower.includes(existingLower.slice(0, overlapLen))
                    return nameOverlap
                  })
                  if (blocked) {
                    const existingMem = memoryStore.get(blocked.id)!
                    return {
                      content: [
                        {
                          type: 'text' as const,
                          text: JSON.stringify({
                            action: 'store',
                            stored: false,
                            warning: `Similar memory already exists: "${existingMem.name}". Consider updating that memory instead, or use the same name to overwrite.`,
                            existingName: existingMem.name,
                            existingDescription: existingMem.description
                          })
                        }
                      ]
                    }
                  }
                }
              }

              const safeName = name
                .replace(/[^a-zA-Z0-9_-]/g, '_')
                .toLowerCase()
                .slice(0, 100)

              const filePath = writeManagedMemoryFile(targetDir, safeName, {
                name,
                description,
                memoryType,
                content,
                class: memoryClass,
                scope: memoryScope,
                status: memoryStatus,
                summary,
                sourceKind,
                pinned,
                relatedFiles,
                relatedSymbols,
                supersedesId,
                confidence,
                reason,
              })
              await memoryIndexer.indexFile(filePath)
              return { __filePath: filePath }
            }

            const outcome = lock ? await lock.withWrite(doStore) : await doStore()
            if ('__filePath' in outcome) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ action: 'store', stored: true, filePath: outcome.__filePath, name })
                  }
                ]
              }
            }
            return outcome
          }

          if (action === 'forget') {
            if (!name) throw new Error('name is required for memory action=forget')
            const doForget = async () => {
              const match = memoryStore
                ? memoryStore.getByName(name)
                : (await memorySearch.search(name, { limit: 5 })).find(
                    (r) => r.name === name || r.name.toLowerCase() === name.toLowerCase()
                  )

              if (!match) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `No memory found with name "${name}"`
                    }
                  ]
                }
              }

              const memDirs = memoryIndexer.getMemoryDirs()
              const abs = resolve(match.filePath)
              const pathAllowed = memDirs.some((dir) => {
                return abs.startsWith(dir + sep) || abs === dir
              })
              if (!pathAllowed) {
                return {
                  content: [{ type: 'text' as const, text: `Memory file path is outside allowed directories` }]
                }
              }
              try {
                unlinkSync(abs)
              } catch {
                // File may already be gone.
              }

              await memoryIndexer.removeByFilePath(abs)

              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      action: 'forget',
                      forgotten: true,
                      name: match.name,
                      filePath: match.filePath
                    })
                  }
                ]
              }
            }

            return lock ? await lock.withWrite(doForget) : doForget()
          }

          return errorResult(new Error(`Unsupported memory action: ${action}`))
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'recall_memories',
      {
        description:
          'Search project and user memories using local keyword retrieval. Returns relevant memories from prior sessions.',
        inputSchema: {
          query: z.string().min(1).describe('Search query for memory recall'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe('Max results (default 10)'),
          types: z
            .array(z.enum(['user', 'feedback', 'project', 'reference']))
            .optional()
            .describe('Filter by memory type'),
          classes: z
            .array(z.enum(['rule', 'fact', 'episode', 'working']))
            .optional()
            .describe('Filter by memory class'),
          scopes: z
            .array(z.enum(['global', 'project', 'branch']))
            .optional()
            .describe('Filter by memory scope'),
          statuses: z
            .array(z.enum(['active', 'archived', 'superseded']))
            .optional()
            .describe('Filter by memory status'),
          activeFiles: z.array(z.string()).optional().describe('Active file paths for contextual boosting'),
          topCodeFiles: z.array(z.string()).optional().describe('Top code file paths for contextual boosting'),
          topCodeSymbols: z.array(z.string()).optional().describe('Top code symbols for contextual boosting'),
          minConfidence: z.number().min(0).max(1).optional().describe('Minimum confidence score'),
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ query, limit, types, classes, scopes, statuses, activeFiles, topCodeFiles, topCodeSymbols, minConfidence }) => {
        try {
          const doSearch = async () => {
            const results = await memorySearch.search(query, {
              limit,
              types: types as MemoryType[] | undefined,
              classes: classes as MemoryClass[] | undefined,
              scopes: scopes as MemoryScope[] | undefined,
              statuses: statuses as MemoryStatus[] | undefined,
              activeFiles,
              topCodeFiles,
              topCodeSymbols,
              minConfidence,
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    results.map((r) => ({
                      name: r.name,
                      description: r.description,
                      type: r.type,
                      class: r.class,
                      scope: r.scope,
                      status: r.status,
                      summary: r.summary,
                      confidence: r.confidence,
                      content: r.content,
                      score: r.score,
                      filePath: r.filePath
                    })),
                    null,
                    2
                  )
                }
              ]
            }
          }
          return lock ? await lock.withRead(doSearch) : doSearch()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'explain_memory',
      {
        description:
          'Explain how memory recall would behave for a query, including selected memories, dropped memories, route, and budget split.',
        inputSchema: {
          query: z.string().min(1).describe('Search query for memory explanation'),
          limit: z.number().int().min(1).max(50).optional().describe('Max results (default 8)'),
          tokenBudget: z.number().min(0).optional().describe('Memory token budget (default 500)'),
          types: z.array(z.enum(['user', 'feedback', 'project', 'reference'])).optional().describe('Filter by memory type'),
          classes: z.array(z.enum(['rule', 'fact', 'episode', 'working'])).optional().describe('Filter by memory class'),
          scopes: z.array(z.enum(['global', 'project', 'branch'])).optional().describe('Filter by memory scope'),
          statuses: z.array(z.enum(['active', 'archived', 'superseded'])).optional().describe('Filter by memory status'),
          activeFiles: z.array(z.string()).optional().describe('Active file paths for contextual boosting'),
          topCodeFiles: z.array(z.string()).optional().describe('Top code file paths for contextual boosting'),
          topCodeSymbols: z.array(z.string()).optional().describe('Top code symbols for contextual boosting'),
          minConfidence: z.number().min(0).max(1).optional().describe('Minimum confidence score'),
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ query, limit, tokenBudget, types, classes, scopes, statuses, activeFiles, topCodeFiles, topCodeSymbols, minConfidence }) => {
        try {
          const doExplain = async () => {
            const results = await memorySearch.search(query, {
              limit: limit ?? 8,
              types: types as MemoryType[] | undefined,
              classes: classes as MemoryClass[] | undefined,
              scopes: scopes as MemoryScope[] | undefined,
              statuses: statuses as MemoryStatus[] | undefined,
              activeFiles,
              topCodeFiles,
              topCodeSymbols,
              minConfidence,
            })
            const assembled = assembleMemoryContext(results, tokenBudget ?? 500, {
              classBudgets: memoryClassBudgets(tokenBudget ?? 500),
            })

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      route: assembled.route,
                      budget: assembled.budget,
                      selected: assembled.memories.map((memory) => ({
                        name: memory.name,
                        class: resolveMemoryClass(memory),
                        scope: resolveMemoryScope(memory),
                        status: resolveMemoryStatus(memory),
                        summary: resolveMemorySummary(memory),
                        score: memory.score,
                        filePath: memory.filePath,
                      })),
                      dropped: assembled.dropped.map((memory) => ({
                        name: memory.name,
                        class: memory.class ?? resolveMemoryClass(memory),
                        reason: memory.dropReason,
                        filePath: memory.filePath,
                      })),
                      text: assembled.text,
                      tokenCount: assembled.tokenCount,
                    },
                    null,
                    2
                  )
                }
              ]
            }
          }
          return lock ? await lock.withRead(doExplain) : doExplain()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'compact_memories',
      {
        description:
          'Refresh and compact memory indexes. Falls back to a safe refresh if the compactor is not available.',
        inputSchema: {
          confirm: z.boolean().describe('Must be true to proceed')
        },
        annotations: { destructiveHint: true }
      },
      async ({ confirm }) => {
        try {
          if (!confirm) {
            return {
              content: [
                { type: 'text' as const, text: 'Aborted: confirm must be true' }
              ]
            }
          }

          const doCompact = async () => {
            const result = memoryRuntime
              ? memoryRuntime.compact(config.memoryArchiveDays)
              : memoryIndexer.compact({
                  archiveEpisodeOlderThanDays: config.memoryArchiveDays
                })
            memoryIndexer.regenerateIndex()
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ compacted: true, result }, null, 2)
                }
              ]
            }
          }

          return lock ? await lock.withWrite(doCompact) : doCompact()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'clear_working_memory',
      {
        description:
          'Clear generated working memory entries from the local managed store.',
        inputSchema: {
          confirm: z.boolean().describe('Must be true to proceed')
        },
        annotations: { destructiveHint: true }
      },
      async ({ confirm }) => {
        try {
          if (!confirm) {
            return {
              content: [
                { type: 'text' as const, text: 'Aborted: confirm must be true' }
              ]
            }
          }

          const doClear = async () => {
            if (memoryRuntime) {
              const cleared = await memoryRuntime.clearWorkingMemory()
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ cleared }, null, 2)
                  }
                ]
              }
            }

            if (!memoryStore) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ cleared: 0, reason: 'No memory store available' }, null, 2)
                  }
                ]
              }
            }

            const workingMemories = memoryStore.getAll().filter((memory) => {
              const sourceKind = memory.sourceKind ?? 'generated'
              return resolveMemoryClass(memory) === 'working' && (sourceKind === 'generated' || sourceKind === 'claude_auto')
            })

            let cleared = 0
            for (const memory of workingMemories) {
              memoryStore.remove(memory.id)
              cleared += 1
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ cleared }, null, 2)
                }
              ]
            }
          }

          return lock ? await lock.withWrite(doClear) : doClear()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'store_memory',
      {
        description:
          'Create or update a memory file. The memory will be indexed for future recall.',
        inputSchema: {
          name: z.string().min(1).max(200).describe('Memory name (used as filename)'),
          description: z
            .string()
            .min(1)
            .max(500)
            .describe('One-line description of the memory'),
          memoryType: z
            .enum(['user', 'feedback', 'project', 'reference'])
            .describe('Memory category'),
          content: z.string().min(1).describe('Memory content (markdown)'),
          class: z
            .enum(['rule', 'fact', 'episode', 'working'])
            .optional()
            .describe('Optional memory class'),
          scope: z
            .enum(['global', 'project', 'branch'])
            .optional()
            .describe('Optional memory scope'),
          status: z
            .enum(['active', 'archived', 'superseded'])
            .optional()
            .describe('Optional lifecycle status'),
          summary: z.string().max(500).optional().describe('Optional compressed summary'),
          sourceKind: z
            .enum(['claude_auto', 'reporecall_local', 'generated'])
            .optional()
            .describe('Optional source kind'),
          pinned: z.boolean().optional().describe('Whether the memory should stay pinned'),
          relatedFiles: z.array(z.string()).optional().describe('Related file paths'),
          relatedSymbols: z.array(z.string()).optional().describe('Related symbols'),
          supersedesId: z.string().optional().describe('Superseded memory ID'),
          confidence: z.number().min(0).max(1).optional().describe('Confidence score'),
          reason: z.string().max(500).optional().describe('Lifecycle or compaction reason'),
        },
        annotations: { destructiveHint: true }
      },
      async ({ name, description, memoryType, content, class: memoryClass, scope, status, summary, sourceKind, pinned, relatedFiles, relatedSymbols, supersedesId, confidence, reason }) => {
        // The consolidation check AND the write must run together under the
        // write lock. Previously the check ran unlocked, so two concurrent
        // stores of similar-named memories both passed the check and both wrote.
        const doStore = async (): Promise<{ content: Array<{ type: 'text'; text: string }> } | { __filePath: string }> => {
          const writableDirs = memoryIndexer.getWritableDirs()
          if (writableDirs.length === 0) {
            throw new Error('No memory directory configured')
          }

          const targetDir = writableDirs[0]!
          mkdirSync(targetDir, { recursive: true })

          // Consolidation check: warn if a memory with similar name exists
          if (memoryStore) {
            const existing = memoryStore.getByName(name)
            if (!existing) {
              const similar = memoryStore.search(name, 5)
              const nameLower = name.toLowerCase()
              const blocked = similar.find((match) => {
                const existingMem = memoryStore.get(match.id)
                if (!existingMem || existingMem.name === name) return false
                if (match.rank > -25) return false
                const existingLower = existingMem.name.toLowerCase()
                const overlapLen = Math.max(10, Math.floor(Math.max(existingLower.length, nameLower.length) * 0.40))
                const nameOverlap =
                  existingLower.includes(nameLower.slice(0, overlapLen)) ||
                  nameLower.includes(existingLower.slice(0, overlapLen))
                return nameOverlap
              })
              if (blocked) {
                const existingMem = memoryStore.get(blocked.id)!
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({
                        stored: false,
                        warning: `Similar memory already exists: "${existingMem.name}". Consider updating that memory instead, or use the same name to overwrite.`,
                        existingName: existingMem.name,
                        existingDescription: existingMem.description
                      })
                    }
                  ]
                }
              }
            }
          }

          const safeName = name
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .toLowerCase()
            .slice(0, 100)

          const filePath = writeManagedMemoryFile(targetDir, safeName, {
            name,
            description,
            memoryType,
            content,
            class: memoryClass,
            scope,
            status,
            summary,
            sourceKind,
            pinned,
            relatedFiles,
            relatedSymbols,
            supersedesId,
            confidence,
            reason,
          })
          await memoryIndexer.indexFile(filePath)
          return { __filePath: filePath }
        }

        try {
          const outcome = lock ? await lock.withWrite(doStore) : await doStore()
          if ('__filePath' in outcome) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ stored: true, filePath: outcome.__filePath, name })
                }
              ]
            }
          }
          return outcome
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'forget_memory',
      {
        description:
          'Delete a memory by name. Removes the file and its index entries.',
        inputSchema: {
          name: z.string().min(1).describe('Name of the memory to forget')
        },
        annotations: { destructiveHint: true }
      },
      async ({ name }) => {
        try {
          const doForget = async () => {
            // Exact name lookup first, fall back to search if store unavailable
            const match = memoryStore
              ? memoryStore.getByName(name)
              : (await memorySearch.search(name, { limit: 5 })).find(
                  (r) => r.name === name || r.name.toLowerCase() === name.toLowerCase()
                )

            if (!match) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No memory found with name "${name}"`
                  }
                ]
              }
            }

            // Delete the file — validate path is within allowed directories
            const memDirs = memoryIndexer.getMemoryDirs()
            const abs = resolve(match.filePath)
            const pathAllowed = memDirs.some((dir) => {
              return abs.startsWith(dir + sep) || abs === dir
            })
            if (!pathAllowed) {
              return {
                content: [{ type: 'text' as const, text: `Memory file path is outside allowed directories` }]
              }
            }
            try {
              unlinkSync(abs)
            } catch {
              // File may already be gone
            }

            // Remove from index
            await memoryIndexer.removeByFilePath(abs)

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    forgotten: true,
                    name: match.name,
                    filePath: match.filePath
                  })
                }
              ]
            }
          }

          return lock ? await lock.withWrite(doForget) : doForget()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'list_memories',
      {
        description:
          'List all stored memories with metadata. Optionally filter by type.',
        inputSchema: {
          memoryType: z
            .enum(['user', 'feedback', 'project', 'reference'])
            .optional()
            .describe('Filter by memory type'),
          memoryClass: z
            .enum(['rule', 'fact', 'episode', 'working'])
            .optional()
            .describe('Filter by memory class'),
          memoryScope: z
            .enum(['global', 'project', 'branch'])
            .optional()
            .describe('Filter by memory scope'),
          memoryStatus: z
            .enum(['active', 'archived', 'superseded'])
            .optional()
            .describe('Filter by memory status'),
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ memoryType, memoryClass, memoryScope, memoryStatus }) => {
        try {
          const doList = () => {
            if (!memoryStore) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({ memories: [], count: 0 })
                  }
                ]
              }
            }
            const memories = memoryType
              ? memoryStore.getByType(memoryType as MemoryType)
              : memoryStore.getAll()
            const filtered = memories.filter((memory) => {
              if (memoryClass && resolveMemoryClass(memory) !== memoryClass) return false
              if (memoryScope && resolveMemoryScope(memory) !== memoryScope) return false
              if (memoryStatus && resolveMemoryStatus(memory) !== memoryStatus) return false
              return true
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      memories: filtered.map((m) => ({
                        name: m.name,
                        type: m.type,
                        class: resolveMemoryClass(m),
                        scope: resolveMemoryScope(m),
                        status: resolveMemoryStatus(m),
                        description: m.description,
                        summary: resolveMemorySummary(m),
                        accessCount: m.accessCount,
                        lastAccessed: m.lastAccessed,
                        importance: m.importance,
                        pinned: m.pinned,
                        sourceKind: m.sourceKind,
                        confidence: m.confidence,
                        relatedFiles: m.relatedFiles,
                        relatedSymbols: m.relatedSymbols,
                        supersedesId: m.supersedesId,
                        reason: m.reason,
                        filePath: m.filePath
                      })),
                      count: filtered.length
                    },
                    null,
                    2
                  )
                }
              ]
            }
          }
          return lock ? await lock.withRead(async () => doList()) : doList()
        } catch (err) {
          return errorResult(err)
        }
      }
    )
  }

  // --- Topology analysis tools ------------------------------------------------

  registerTool(
    'get_communities',
    {
      description:
        'Get detected code communities (clusters of tightly-coupled modules). Returns community IDs, member counts, cohesion scores, and labels.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Max communities to return (default: 20)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ limit }) => {
      try {
        const doGet = () => {
          const communities = metadata.getAllCommunities(limit ?? 20);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ communities, count: communities.length }, null, 2)
            }]
          };
        };
        return lock ? await lock.withRead(async () => doGet()) : doGet();
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  registerTool(
    'get_hub_nodes',
    {
      description:
        'Get the most connected nodes (god nodes / architectural hubs) in the call graph. These are functions or classes with the highest number of call relationships.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max hub nodes to return (default: 10)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ limit }) => {
      try {
        const doGet = () => {
          const godNodes = metadata.getGodNodes(limit ?? 10);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ hubNodes: godNodes, count: godNodes.length }, null, 2)
            }]
          };
        };
        return lock ? await lock.withRead(async () => doGet()) : doGet();
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  registerTool(
    'get_surprises',
    {
      description:
        'Get surprising cross-module connections in the codebase — edges that bridge structurally distant communities, cross execution surfaces, or involve weakly-resolved targets.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max surprising connections to return (default: 10)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ limit }) => {
      try {
        const doGet = () => {
          const surprises = metadata.getTopSurprises(limit ?? 10);
          const enriched = surprises.map(s => {
            const sourceChunk = metadata.getChunk(s.sourceChunkId);
            const targetChunk = metadata.getChunk(s.targetChunkId);
            return {
              source: { name: sourceChunk?.name ?? s.sourceChunkId, filePath: sourceChunk?.filePath },
              target: { name: targetChunk?.name ?? s.targetChunkId, filePath: targetChunk?.filePath },
              score: s.score,
              reasons: s.reasons,
              relation: s.relation,
            };
          });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ surprises: enriched, count: enriched.length }, null, 2)
            }]
          };
        };
        return lock ? await lock.withRead(async () => doGet()) : doGet();
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  registerTool(
    'suggest_investigations',
    {
      description:
        'Get suggested investigation questions based on codebase topology — weak resolution edges, bridge nodes, hub nodes with uncertain relationships, isolated code, and low-cohesion modules.',
      inputSchema: {
        limit: z.number().int().min(1).max(20).optional().describe('Max questions to return (default: 7)')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ limit }) => {
      try {
        const doGet = () => {
          const questions = metadata.getSuggestedQuestions(limit ?? 7);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ questions, count: questions.length }, null, 2)
            }]
          };
        };
        return lock ? await lock.withRead(async () => doGet()) : doGet();
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // --- Business context tools (registered when memory store is available) ---

  if (memoryStore) {
    registerTool(
      'list_product_areas',
      {
        description:
          'List product-area aggregates inferred from business wiki pages. Use this for business-facing navigation before drilling into source evidence.',
        inputSchema: {
          limit: z.number().int().min(1).max(50).optional().describe('Max product areas to return (default: 20)'),
          includeUnsafe: z.boolean().optional().describe('Include fallback or low-presentation-quality areas for diagnostics (default: false)')
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ limit, includeUnsafe }) => {
        try {
          const doList = () => {
            const context = buildBusinessContextFromMemoryStore(memoryStore)
            const productAreas = context.productAreas
              .filter(area => includeUnsafe || area.presentationSafe)
              .slice(0, limit ?? 20)
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  productAreas,
                  count: productAreas.length,
                  total: context.productAreas.length,
                  safeTotal: context.productAreas.filter(area => area.presentationSafe).length,
                  businessPageCount: context.businessPages.length
                }, null, 2)
              }]
            }
          }
          return lock ? await lock.withRead(async () => doList()) : doList()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'business_context_query',
      {
        description:
          'Find product areas and business capability pages relevant to a query. Returns business-facing context plus supporting files and symbols.',
        inputSchema: {
          query: z.string().min(1).describe('Business or feature query'),
          limit: z.number().int().min(1).max(20).optional().describe('Max product areas and pages to return (default: 5)')
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ query, limit }) => {
        try {
          const doQuery = () => {
            const context = buildBusinessContextFromMemoryStore(memoryStore)
            const result = queryBusinessContext(query, context, limit ?? 5)
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  query,
                  productAreas: result.productAreas,
                  businessPages: result.businessPages,
                  productAreaCount: result.productAreas.length,
                  businessPageCount: result.businessPages.length,
                  totalProductAreas: context.productAreas.length,
                  totalBusinessPages: context.businessPages.length
                }, null, 2)
              }]
            }
          }
          return lock ? await lock.withRead(async () => doQuery()) : doQuery()
        } catch (err) {
          return errorResult(err)
        }
      }
    )
  }

  // --- Wiki tools (registered when memory store is available) ---

  if (memoryStore && memorySearch && memoryIndexer) {
    registerTool(
      'wiki_query',
      {
        description:
          'Search wiki pages by keyword. Returns matching wiki pages with summaries. Use this to find existing codebase knowledge before exploring from scratch.',
        inputSchema: {
          query: z.string().min(1).describe('Search query for wiki pages'),
          limit: z.number().int().min(1).max(20).optional().describe('Max results (default: 5)')
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ query, limit }) => {
        const run = async () => {
          const results = await memorySearch.search(query, {
            types: ['wiki'],
            limit: limit ?? 5
          })
          const pages = results.map(r => ({
            name: r.name,
            description: r.description,
            score: r.score,
            summary: r.summary ?? r.description,
            relatedFiles: r.relatedFiles?.slice(0, 5),
            relatedSymbols: r.relatedSymbols?.slice(0, 5)
          }))
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ pages, count: pages.length }, null, 2) }]
          }
        }
        try {
          // Hold the read lock so concurrent wiki_write/store_memory cannot
          // mutate the store mid-query.
          return lock ? await lock.withRead(run) : await run()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'wiki_read',
      {
        description:
          'Read a wiki page by name, or list all wiki pages if no name is given.',
        inputSchema: {
          name: z.string().optional().describe('Wiki page name (omit to list all pages)')
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ name }) => {
        const run = async () => {
          if (name) {
            const page = memoryStore.getByName(name)
            if (!page || page.type !== 'wiki') {
              const suggestions = suggestWikiPages(memoryStore, name, 5)
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    status: 'not_found',
                    name,
                    message: `Wiki page "${name}" was not found. It may have been renamed, merged, or removed during wiki regeneration.`,
                    suggestions
                  }, null, 2)
                }]
              }
            }
            const links = memoryStore.getWikiLinks(name)
            const backlinks = memoryStore.getWikiBacklinks(name)
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  name: page.name,
                  description: page.description,
                  content: page.content,
                  relatedFiles: page.relatedFiles,
                  relatedSymbols: page.relatedSymbols,
                  links,
                  backlinks,
                  confidence: page.confidence
                }, null, 2)
              }]
            }
          }

          // List all wiki pages
          const all = memoryStore.getByType('wiki')
          const index = all.map(p => ({
            name: p.name,
            description: p.description,
            summary: p.summary ?? p.description
          }))
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ pages: index, count: index.length }, null, 2) }]
          }
        }
        try {
          return lock ? await lock.withRead(run) : await run()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'wiki_write',
      {
        description:
          'Create or update a wiki page manually. Use this to persist codebase knowledge that should be available in future sessions.',
        inputSchema: {
          name: z.string().min(1).describe('Page name (will be slugified)'),
          description: z.string().min(1).describe('One-line summary of the page'),
          content: z.string().min(10).describe('Markdown content for the page'),
          relatedFiles: z.array(z.string()).optional().describe('Related file paths'),
          relatedSymbols: z.array(z.string()).optional().describe('Related symbol names'),
          pageType: z.enum(['community', 'hub', 'module', 'flow', 'exploration']).optional().describe('Page type (default: exploration)')
        },
        annotations: { readOnlyHint: false }
      },
      async ({ name, description, content, relatedFiles, relatedSymbols, pageType }) => {
        const run = async () => {
          const writableDir = memoryIndexer.getWritableDirs()[0]
          if (!writableDir) {
            return errorResult(new Error('No writable memory directory configured'))
          }

          const slug = `wiki-${safeMemorySlug(name)}`
          const allLinks = resolveAllLinks([], content)

          const filePath = writeManagedMemoryFile(writableDir, slug, {
            name: slug,
            description,
            memoryType: 'wiki',
            class: 'fact',
            scope: 'project',
            status: 'active',
            summary: description,
            sourceKind: 'claude_auto',
            relatedFiles: (relatedFiles ?? []).slice(0, 20),
            relatedSymbols: (relatedSymbols ?? []).slice(0, 20),
            confidence: 0.85,
            reason: 'Manually created wiki page',
            pageType: pageType ?? 'exploration',
            sourceLayer: 'llm-enriched',
            links: allLinks,
            sourceCommit: '',
            content
          })

          await memoryIndexer.indexFile(filePath)
          memoryStore.setWikiLinks(slug, allLinks)

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ slug, filePath, links: allLinks }) }]
          }
        }
        try {
          // Serialize writes with other mutating memory tools.
          return lock ? await lock.withWrite(run) : await run()
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    registerTool(
      'wiki_check_staleness',
      {
        description:
          'Check if wiki pages are stale (referenced files changed since page was written). Optionally check a specific page or all pages.',
        inputSchema: {
          name: z.string().optional().describe('Wiki page name (omit to check all pages)')
        },
        annotations: { readOnlyHint: true, idempotentHint: true }
      },
      async ({ name }) => {
        const run = async () => {
          const pages = name
            ? [memoryStore.getByName(name)].filter((p): p is NonNullable<typeof p> => p != null && p.type === 'wiki')
            : memoryStore.getByType('wiki')

          const results = await Promise.all(pages.map(async page => {
            // sourceCommit is in frontmatter, which is stripped from page.content.
            // Read the raw file from disk to extract it.
            let sourceCommit = ''
            try {
              const raw = await readFile(page.filePath, 'utf-8')
              const match = raw.match(/sourceCommit:\s*"?([a-f0-9]+)"?/)
              sourceCommit = match?.[1] ?? ''
            } catch { /* file may not exist */ }
            return checkPageStaleness(
              page.name,
              sourceCommit,
              page.relatedFiles ?? [],
              config.projectRoot
            )
          }))

          const staleCount = results.filter(r => r.stale).length
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ results, total: results.length, stale: staleCount }, null, 2)
            }]
          }
        }
        try {
          return lock ? await lock.withRead(run) : await run()
        } catch (err) {
          return errorResult(err)
        }
      }
    )
  }

  return server
}
