import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve, sep } from 'path'
import { realpathSync, unlinkSync, mkdirSync } from 'fs'
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
import { writeManagedMemoryFile } from '../memory/files.js'

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
  memoryRuntime?: MemoryRuntime
): McpServer {
  let metadata = initialMetadata
  const server = new McpServer({
    name: 'reporecall',
    version
  })

  server.registerTool(
    'search_code',
    {
      description: 'Search the codebase using hybrid vector + keyword search',
      inputSchema: {
        query: z.string().min(1).describe('Search query'),
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
          .describe('Currently open file paths for boosting')
      },
      annotations: { readOnlyHint: true, idempotentHint: true }
    },
    async ({ query, limit, activeFiles }) => {
      try {
        const doSearch = async () => {
          const results = await search.search(query, { limit, activeFiles })
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  results.map((r) => ({
                    name: r.name,
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

  server.registerTool(
    'index_codebase',
    {
      description: 'Index or re-index the codebase',
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
        let result: unknown
        const doIndex = async () => {
          if (paths && paths.length > 0) {
            const safePaths = paths.filter((p: string) => isPathSafe(config.projectRoot, p))
            result = await pipeline.indexChanged(safePaths)
          } else {
            result = await pipeline.indexAll()
          }
        }

        if (lock) {
          await lock.withWrite(doIndex)
        } else {
          await doIndex()
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result)
            }
          ]
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.registerTool(
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

  server.registerTool(
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

          const { rmSync } = await import('fs')
          const { resolve } = await import('path')
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

          // Update search to use the new store instances
          search.updateStores(
            pipeline.getVectorStore(),
            pipeline.getFTSStore(),
            pipeline.getMetadataStore()
          )

          // Update metadata reference for get_stats tool
          metadata = pipeline.getMetadataStore()
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No matching code symbol found for "${seed}"`
                }
              ]
            }
          }

          const tree = buildStackTree(metadata, {
            seed: seedResult.bestSeed,
            direction: direction ?? 'both',
            maxDepth: depth ?? 2,
            maxBranchFactor: 3,
            maxNodes: 24
          })

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    seed: tree.seed,
                    upTree: tree.upTree,
                    downTree: tree.downTree,
                    edges: tree.edges,
                    nodeCount: tree.nodeCount,
                    coverage: tree.coverage
                  },
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doBuild()) : doBuild()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    'explain_flow',
    {
      description:
        'Explain the call flow around a query or function name. Resolves a seed symbol, builds a bidirectional call tree, and returns assembled flow context with callers, seed, and callees.',
      inputSchema: {
        query: z.string().min(1).describe('Natural language query or function name'),
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
    async ({ query, direction, maxDepth }) => {
      try {
        const doExplain = () => {
          const ftsStore = pipeline.getFTSStore()
          const seedResult = resolveSeeds(query, metadata, ftsStore)
          if (!seedResult.bestSeed) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No matching code symbol found for "${query}"`
                }
              ]
            }
          }

          const tree = buildStackTree(metadata, {
            seed: seedResult.bestSeed,
            direction: direction ?? 'both',
            maxDepth: maxDepth ?? 2,
            maxBranchFactor: 3,
            maxNodes: 24,
            query
          })

          const flowBudget = resolveContextBudget(
            config.contextBudget,
            metadata.getStats().totalChunks
          )
          const flowContext = assembleFlowContext(
            tree,
            metadata,
            flowBudget,
            query
          )

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
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
                    chunksIncluded: flowContext.chunks.length
                  },
                  null,
                  2
                )
              }
            ]
          }
        }
        return lock ? await lock.withRead(async () => doExplain()) : doExplain()
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  // --- Memory tools (only registered when memory layer is available) ---

  if (memorySearch && memoryIndexer) {
    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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
        try {
          const writableDirs = memoryIndexer.getWritableDirs()
          if (writableDirs.length === 0) {
            return errorResult(new Error('No memory directory configured'))
          }

          const targetDir = writableDirs[0]!
          mkdirSync(targetDir, { recursive: true })

          // Consolidation check: warn if a memory with similar name exists
          if (memoryStore) {
            const existing = memoryStore.getByName(name)
            if (existing) {
              // Same name — will overwrite (existing behavior)
            } else {
              // Check FTS for genuinely similar content — only block if both
              // name overlap AND strong FTS rank indicate a real duplicate.
              // Previous logic blocked on ANY FTS match, causing false positives
              // (e.g., "DUTO node types" blocked by "Reporecall Benchmark Results").
              const similar = memoryStore.search(name, 5)
              const nameLower = name.toLowerCase()
              const blocked = similar.find((match) => {
                const existingMem = memoryStore.get(match.id)
                if (!existingMem || existingMem.name === name) return false
                // Require strong FTS rank — BM25 inflates in small corpus (10-20 memories),
                // so -25 is a genuinely strong match, not just a token overlap.
                if (match.rank > -25) return false
                // Require substantial name character overlap (≥40% of the longer name)
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

          // Write and index atomically under the write lock
          const doIndex = async () => {
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
            return filePath
          }
          let filePath: string
          if (lock) {
            filePath = await lock.withWrite(doIndex)
          } else {
            filePath = await doIndex()
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ stored: true, filePath, name })
              }
            ]
          }
        } catch (err) {
          return errorResult(err)
        }
      }
    )

    server.registerTool(
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

    server.registerTool(
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

  return server
}
