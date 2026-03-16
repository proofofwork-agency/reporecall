import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve, sep } from 'path'
import type { HybridSearch } from '../search/hybrid.js'
import type { IndexingPipeline } from '../indexer/pipeline.js'
import type { MetadataStore } from '../storage/metadata-store.js'
import type { MemoryConfig } from '../core/config.js'
import type { ReadWriteLock } from '../core/rwlock.js'
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
  return abs.startsWith(projectRoot + sep) || abs === projectRoot
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
        query: z.string().describe('Search query'),
        limit: z
          .number()
          .max(500)
          .optional()
          .describe('Max results (default 20)'),
        activeFiles: z
          .array(z.string())
          .optional()
          .describe('Currently open file paths for boosting')
      }
    },
    async ({ query, limit, activeFiles }) => {
      try {
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
      }
    },
    async ({ paths }) => {
      try {
        let result
        if (paths && paths.length > 0) {
          const safePaths = paths.filter((p: string) => isPathSafe(config.projectRoot, p))
          result = await pipeline.indexChanged(safePaths)
        } else {
          result = await pipeline.indexAll()
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
      inputSchema: {}
    },
    async () => {
      try {
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
          pipeline.closeAndClearMerkle()

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
            } catch {
              // ignore
            }
          }
          const lanceDir = resolve(config.dataDir, 'lance')
          try {
            rmSync(lanceDir, { recursive: true })
          } catch {
            // ignore
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
          .describe('Name of the function to find callers for'),
        limit: z.number().max(500).optional().describe('Max results (default 20)')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ functionName, limit }) => {
      try {
        const callers = search.findCallers(functionName, limit)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(callers, null, 2)
            }
          ]
        }
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
          .describe('Name of the function to find callees for'),
        limit: z.number().max(500).optional().describe('Max results (default 20)')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ functionName, limit }) => {
      try {
        const callees = search.findCallees(functionName, limit)
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(callees, null, 2)
            }
          ]
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  return server
}
