import { unlinkSync, mkdirSync } from 'fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ReadWriteLock } from '../core/rwlock.js'
import type { MemorySearch } from '../memory/search.js'
import type { MemoryIndexer } from '../memory/indexer.js'
import type { MemoryClass, MemoryScope, MemoryStatus, MemoryType } from '../memory/types.js'
import type { MemoryStore } from '../storage/memory-store.js'
import { resolveMemoryClass, resolveMemoryScope, resolveMemoryStatus, resolveMemorySummary } from '../memory/types.js'
import { assembleMemoryContext } from '../memory/context.js'
import { writeManagedMemoryFile } from '../memory/files.js'
import { resolveProjectPath } from '../core/path-safety.js'
interface RegisterMemoryToolOptions {
  registerTool: McpServer['registerTool']
  lock?: ReadWriteLock
  memorySearch: MemorySearch
  memoryIndexer: MemoryIndexer
  memoryStore?: MemoryStore
}

function errorResult(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
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

export function registerMemoryTool({
  registerTool,
  lock,
  memorySearch,
  memoryIndexer,
  memoryStore,
}: RegisterMemoryToolOptions): void {
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
            const safeMemoryPath = memDirs
              .map((dir) => resolveProjectPath(dir, match.filePath, 'existing'))
              .find((candidate) => candidate !== null)
            if (!safeMemoryPath) {
              return {
                content: [{ type: 'text' as const, text: `Memory file path is outside allowed directories` }]
              }
            }
            try {
              unlinkSync(safeMemoryPath.absolutePath)
            } catch {
              // File may already be gone.
            }

            await memoryIndexer.removeByFilePath(safeMemoryPath.absolutePath)

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
}
}
