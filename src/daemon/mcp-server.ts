import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
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
import type { MemoryStore } from '../storage/memory-store.js'
import type { MemoryRuntime } from './memory/runtime.js'
import type { WikiGenerator } from '../wiki/generator.js'
import type { WikiAutoCapture } from '../wiki/auto-capture.js'
import type { StoredChunk } from '../storage/types.js'
import { getLogger } from '../core/logger.js'
import { banner, clearFreshnessCache, computeFreshness, type IndexFreshness } from '../core/staleness.js'
import { isProjectPathSafe } from '../core/path-safety.js'
import { registerMemoryTool } from './mcp-memory-tool.js'

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

export function createMCPServer(
  search: HybridSearch,
  pipeline: IndexingPipeline,
  initialMetadata: MetadataStore,
  config: MemoryConfig,
  lock?: ReadWriteLock,
  memorySearch?: MemorySearch,
  memoryIndexer?: MemoryIndexer,
  memoryStore?: MemoryStore,
  _memoryRuntime?: MemoryRuntime,
  wikiGenerator?: WikiGenerator,
  wikiAutoCapture?: WikiAutoCapture
): McpServer {
  let metadata = initialMetadata
  const server = new McpServer({
    name: 'reporecall',
    version
  })

  type PublicToolConfig = {
    annotations?: { readOnlyHint?: boolean }
    [key: string]: unknown
  }
  type PublicToolHandler = (...callArgs: unknown[]) => unknown
  const rawRegisterTool = server.registerTool.bind(server) as unknown as (
    name: string,
    toolConfig: PublicToolConfig,
    handler: PublicToolHandler,
  ) => unknown
  const registerTool = ((name: string, toolConfig: PublicToolConfig, handler: PublicToolHandler) => {
    if (!PUBLIC_MCP_TOOLS.has(name)) return undefined
    return rawRegisterTool(name, toolConfig, async (...callArgs: unknown[]) => {
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
  }) as unknown as McpServer['registerTool']

  const indexAndRegenerateWiki = async (paths?: string[]) => {
    let index: unknown
    if (paths && paths.length > 0) {
      const safePaths = paths.filter((p: string) => isProjectPathSafe(config.projectRoot, p, 'existing'))
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
    'get_stats',
    {
      description: 'Get index statistics, conventions, latency, AND explicit freshness/trust info (use this first)',
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
          const storage = metadata.getStorageStats()
          const freshness = computeFreshness(metadata, config.projectRoot)
          const trust = {
            banner: banner(freshness),
            indexedCommit: freshness.indexedCommit,
            currentCommit: freshness.currentCommit,
            dirtyFiles: freshness.dirtyFiles,
            level: freshness.level,
            lastIndexedAt: freshness.lastIndexedAt
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { 
                    ...stats, 
                    lastIndexedAt: lastIndexed, 
                    conventions, 
                    latency, 
                    storage,
                    trust   // ← explicit trust contract data
                  },
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
            if (!isProjectPathSafe(config.projectRoot, filePath, 'allow-missing')) throw new Error('Path outside project root')
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


  if (memorySearch && memoryIndexer) {
    registerMemoryTool({ registerTool, lock, memorySearch, memoryIndexer, memoryStore })
  }

  return server
}
