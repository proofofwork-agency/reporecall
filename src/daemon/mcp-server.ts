import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve, sep } from 'path'
import { realpathSync } from 'fs'
import type { HybridSearch } from '../search/hybrid.js'
import type { IndexingPipeline } from '../indexer/pipeline.js'
import type { MetadataStore } from '../storage/metadata-store.js'
import { type MemoryConfig, resolveContextBudget } from '../core/config.js'
import type { ReadWriteLock } from '../core/rwlock.js'
import { resolveSeeds } from '../search/seed.js'
import { buildStackTree } from '../search/tree-builder.js'
import { assembleFlowContext } from '../search/context-assembler.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

function loadVersion(): string {
  try {
    return require('../../package.json').version
  } catch {
    try {
      return require('../package.json').version
    } catch {
      return '0.1.0'
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

export function createMCPServer(
  search: HybridSearch,
  pipeline: IndexingPipeline,
  initialMetadata: MetadataStore,
  config: MemoryConfig,
  lock?: ReadWriteLock
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
            maxNodes: 24
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

  return server
}
