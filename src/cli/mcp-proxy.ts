/**
 * MCP Proxy — an MCP server backed by HTTP calls to the running daemon.
 *
 * Instead of loading its own IndexingPipeline, HybridSearch, and MemoryStore
 * (which duplicates the daemon and risks SQLite corruption due to no shared
 * ReadWriteLock), this proxy forwards every MCP tool call to the daemon's
 * HTTP API.
 *
 * Usage:
 *   import { createProxyMCPServer } from './mcp-proxy.js'
 *   const server = createProxyMCPServer({ port: 4111, dataDir: '...' })
 *   await server.connect(new StdioServerTransport())
 *
 * NOTE: The preferred approach is `serve --mcp` which runs the MCP server
 * in-process with the daemon. This proxy exists as a lightweight alternative
 * when the daemon is already running and you need a separate MCP stdio process
 * (e.g., for clients that cannot use the `serve` command directly).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readFileSync } from 'fs'
import { resolve } from 'path'

interface ProxyConfig {
  port: number
  dataDir: string
}

function loadDaemonToken(dataDir: string): string | undefined {
  try {
    return readFileSync(resolve(dataDir, 'daemon.token'), 'utf-8').trim()
  } catch {
    return undefined
  }
}

async function callDaemon(
  config: ProxyConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const token = loadDaemonToken(config.dataDir)
  const url = `http://127.0.0.1:${config.port}/mcp/tool-call`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ tool: toolName, arguments: args }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text()
      return {
        content: [{ type: 'text', text: `Daemon error (${res.status}): ${body}` }],
        isError: true,
      }
    }

    const json = (await res.json()) as {
      content?: Array<{ type: 'text'; text: string }>
      isError?: boolean
    }
    return {
      content: json.content ?? [{ type: 'text', text: JSON.stringify(json) }],
      isError: json.isError,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Failed to reach daemon at ${url}: ${message}` }],
      isError: true,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function createProxyMCPServer(config: ProxyConfig): McpServer {
  const server = new McpServer({
    name: 'reporecall-proxy',
    version: '1.0.0',
  })

  // Helper to register a proxy tool that forwards to the daemon
  function proxyTool(
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    annotations?: Record<string, boolean>
  ) {
    server.registerTool(
      name,
      { description, inputSchema, annotations },
      async (args: Record<string, unknown>) => callDaemon(config, name, args)
    )
  }

  // --- Code search & indexing tools ---

  proxyTool(
    'search_code',
    'Search the codebase using hybrid vector + keyword search',
    {
      query: z.string().min(1).describe('Search query'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)'),
      activeFiles: z.array(z.string()).optional().describe('Currently open file paths for boosting'),
    },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'index_codebase',
    'Index or re-index the codebase',
    {
      paths: z.array(z.string().max(4096)).max(1000).optional().describe('Specific file paths to re-index (omit for full index)'),
    },
    { destructiveHint: true }
  )

  proxyTool(
    'get_stats',
    'Get index statistics, conventions, and latency info',
    {},
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'clear_index',
    'Clear all indexed data',
    { confirm: z.boolean().describe('Must be true to proceed') },
    { destructiveHint: true }
  )

  // --- Call graph tools ---

  proxyTool(
    'find_callers',
    'Find functions that call a given function',
    {
      functionName: z.string().min(1).describe('Name of the function to find callers for'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)'),
    },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'find_callees',
    'Find functions called by a given function',
    {
      functionName: z.string().min(1).describe('Name of the function to find callees for'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)'),
    },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'resolve_seed',
    'Resolve a query to seed candidates for stack tree building',
    { query: z.string().min(1).describe('Natural language query or code symbol name') },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'build_stack_tree',
    'Build a bidirectional call tree from a seed function/method',
    {
      seed: z.string().min(1).describe('Function or method name to use as the tree seed'),
      depth: z.number().int().min(1).max(10).optional().describe('Maximum tree depth (default: 2)'),
      direction: z.enum(['up', 'down', 'both']).optional().describe('Tree direction (default: both)'),
    },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'get_imports',
    'Get import statements for a file',
    { filePath: z.string().min(1).describe('Relative file path (e.g., src/auth/handler.ts)') },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'get_symbol',
    'Look up code symbols (functions, classes, methods) by name',
    { name: z.string().min(1).describe('Symbol name to look up') },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'explain_flow',
    'Explain the call flow around a query or function name',
    {
      query: z.string().min(1).describe('Natural language query or function name'),
      direction: z.enum(['up', 'down', 'both']).optional().describe('Tree direction (default: both)'),
      maxDepth: z.number().int().min(1).max(10).optional().describe('Maximum tree depth (default: 2)'),
    },
    { readOnlyHint: true, idempotentHint: true }
  )

  // --- Memory tools ---

  proxyTool(
    'recall_memories',
    'Search project and user memories using local keyword retrieval',
    {
      query: z.string().min(1).describe('Search query for memory recall'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
      types: z.array(z.enum(['user', 'feedback', 'project', 'reference'])).optional().describe('Filter by memory type'),
      classes: z.array(z.enum(['rule', 'fact', 'episode', 'working'])).optional().describe('Filter by memory class'),
      scopes: z.array(z.enum(['global', 'project', 'branch'])).optional().describe('Filter by memory scope'),
      statuses: z.array(z.enum(['active', 'archived', 'superseded'])).optional().describe('Filter by memory status'),
      activeFiles: z.array(z.string()).optional().describe('Active file paths for contextual boosting'),
      topCodeFiles: z.array(z.string()).optional().describe('Top code file paths for contextual boosting'),
      topCodeSymbols: z.array(z.string()).optional().describe('Top code symbols for contextual boosting'),
      minConfidence: z.number().min(0).max(1).optional().describe('Minimum confidence score'),
    },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'explain_memory',
    'Explain how memory recall would behave for a query',
    {
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
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'compact_memories',
    'Refresh and compact memory indexes',
    { confirm: z.boolean().describe('Must be true to proceed') },
    { destructiveHint: true }
  )

  proxyTool(
    'clear_working_memory',
    'Clear generated working memory entries from the local managed store',
    { confirm: z.boolean().describe('Must be true to proceed') },
    { destructiveHint: true }
  )

  proxyTool(
    'store_memory',
    'Create or update a memory file',
    {
      name: z.string().min(1).max(200).describe('Memory name (used as filename)'),
      description: z.string().min(1).max(500).describe('One-line description of the memory'),
      memoryType: z.enum(['user', 'feedback', 'project', 'reference']).describe('Memory category'),
      content: z.string().min(1).describe('Memory content (markdown)'),
      class: z.enum(['rule', 'fact', 'episode', 'working']).optional().describe('Optional memory class'),
      scope: z.enum(['global', 'project', 'branch']).optional().describe('Optional memory scope'),
      status: z.enum(['active', 'archived', 'superseded']).optional().describe('Optional lifecycle status'),
      summary: z.string().max(500).optional().describe('Optional compressed summary'),
      sourceKind: z.enum(['claude_auto', 'reporecall_local', 'generated']).optional().describe('Optional source kind'),
      pinned: z.boolean().optional().describe('Whether the memory should stay pinned'),
      relatedFiles: z.array(z.string()).optional().describe('Related file paths'),
      relatedSymbols: z.array(z.string()).optional().describe('Related symbols'),
      supersedesId: z.string().optional().describe('Superseded memory ID'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence score'),
      reason: z.string().max(500).optional().describe('Lifecycle or compaction reason'),
    },
    { destructiveHint: true }
  )

  proxyTool(
    'forget_memory',
    'Delete a memory by name',
    { name: z.string().min(1).describe('Name of the memory to forget') },
    { destructiveHint: true }
  )

  proxyTool(
    'list_memories',
    'List all stored memories with metadata',
    {
      memoryType: z.enum(['user', 'feedback', 'project', 'reference']).optional().describe('Filter by memory type'),
      memoryClass: z.enum(['rule', 'fact', 'episode', 'working']).optional().describe('Filter by memory class'),
      memoryScope: z.enum(['global', 'project', 'branch']).optional().describe('Filter by memory scope'),
      memoryStatus: z.enum(['active', 'archived', 'superseded']).optional().describe('Filter by memory status'),
    },
    { readOnlyHint: true, idempotentHint: true }
  )

  // --- Topology analysis tools ---

  proxyTool(
    'get_communities',
    'Get detected code communities (clusters of tightly-coupled modules)',
    { limit: z.number().int().min(1).max(100).optional().describe('Max communities to return (default: 20)') },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'get_hub_nodes',
    'Get the most connected nodes (architectural hubs) in the call graph',
    { limit: z.number().int().min(1).max(50).optional().describe('Max hub nodes to return (default: 10)') },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'get_surprises',
    'Get surprising cross-module connections in the codebase',
    { limit: z.number().int().min(1).max(50).optional().describe('Max surprising connections to return (default: 10)') },
    { readOnlyHint: true, idempotentHint: true }
  )

  proxyTool(
    'suggest_investigations',
    'Get suggested investigation questions based on codebase topology',
    { limit: z.number().int().min(1).max(20).optional().describe('Max questions to return (default: 7)') },
    { readOnlyHint: true, idempotentHint: true }
  )

  return server
}
