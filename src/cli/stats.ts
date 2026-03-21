import { Command } from 'commander'
import { resolve } from 'path'
import { statSync, existsSync, readFileSync, readdirSync } from 'fs'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { isProcessAlive } from '../core/platform.js'
import { MetadataStore } from '../storage/metadata-store.js'
import { MemoryStore } from '../storage/memory-store.js'
import { resolveMemoryStatus } from '../memory/types.js'

export function statsCommand(): Command {
  return new Command('stats')
    .description('Show index statistics, session metrics, and daemon status')
    .option('--project <path>', 'Project root path')
    .action(async (options) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd())

      const config = loadConfig(projectRoot)

      if (!existsSync(resolve(config.dataDir, 'metadata.db'))) {
        console.log('No index found. Run "reporecall index" first.')
        return
      }

      const metadata = new MetadataStore(config.dataDir)
      const stats = metadata.getStats()
      const lastIndexed = metadata.getStat('lastIndexedAt')
      const hooksCount = metadata.getStat('hooksFireCount') ?? '0'
      const totalTokens = metadata.getStat('totalTokensInjected') ?? '0'

      // Calculate storage size
      let storageBytes = 0
      const files = ['metadata.db', 'fts.db']
      for (const f of files) {
        const p = resolve(config.dataDir, f)
        if (existsSync(p)) storageBytes += statSync(p).size
      }
      const lanceDir = resolve(config.dataDir, 'lance')
      if (existsSync(lanceDir)) {
        storageBytes += dirSize(lanceDir)
      }
      const memoryDb = resolve(config.dataDir, 'memory-index', 'memories.db')
      let memoryStore: MemoryStore | undefined
      let memoryFreshness: string | undefined
      let memoryTotals: {
        total: number
        active: number
        archived: number
        superseded: number
        pinned: number
      } | undefined
      if (existsSync(memoryDb)) {
        storageBytes += statSync(memoryDb).size
        try {
          memoryStore = new MemoryStore(resolve(config.dataDir, 'memory-index'))
          const memories = memoryStore.getAll()
          const newest = memories.reduce((acc, memory) => {
            const mtime = new Date(memory.fileMtime).getTime()
            return Number.isFinite(mtime) && mtime > acc ? mtime : acc
          }, 0)
          if (newest > 0) {
            memoryFreshness = formatTimeSince(new Date(newest))
          }
          memoryTotals = memories.reduce(
            (acc, memory) => {
              acc.total += 1
              const status = resolveMemoryStatus(memory)
              if (status === 'archived') acc.archived += 1
              else if (status === 'superseded') acc.superseded += 1
              else acc.active += 1
              if (memory.pinned) acc.pinned += 1
              return acc
            },
            { total: 0, active: 0, archived: 0, superseded: 0, pinned: 0 }
          )
        } catch {
          memoryStore = undefined
        }
      }

      // Format languages
      const totalChunks = stats.totalChunks || 1
      const langLines = Object.entries(stats.languages)
        .map(
          ([lang, count]) =>
            `${lang} (${((count / totalChunks) * 100).toFixed(0)}%)`
        )
        .join(', ')

      // Time since last indexed
      const timeSince = lastIndexed
        ? formatTimeSince(new Date(lastIndexed))
        : 'never'

      const chunksServed = metadata.getStat('chunksServed') ?? '0'
      const latency = metadata.getLatencyPercentiles()

      const tokensInjected = parseInt(totalTokens, 10)
      const chunksServedNum = parseInt(chunksServed, 10)
      const hooksNum = parseInt(hooksCount, 10)

      console.log(`Reporecall`)
      console.log(``)
      console.log(`Index:`)
      console.log(
        `  Chunks:       ${stats.totalChunks} across ${stats.totalFiles} files`
      )
      console.log(`  Languages:    ${langLines || 'none'}`)
      console.log(`  Storage:      ${formatBytes(storageBytes)}`)
      console.log(`  Last indexed: ${timeSince}`)
      console.log(``)

      console.log(`Session Stats:`)
      console.log(`  Hooks fired:         ${hooksCount}`)
      console.log(
        `  Chunks served:       ${Number(chunksServed).toLocaleString()}`
      )
      console.log(
        `  Tokens injected:     ${Number(totalTokens).toLocaleString()}`
      )
      if (hooksNum > 0) {
        const avgTokensPerQuery = Math.round(tokensInjected / hooksNum)
        console.log(
          `  Avg tokens/query:    ${avgTokensPerQuery.toLocaleString()}`
        )
      }
      if (chunksServedNum > 0 && hooksNum > 0) {
        const avgChunksPerQuery = (chunksServedNum / hooksNum).toFixed(1)
        console.log(`  Avg chunks/query:    ${avgChunksPerQuery}`)
      }
      // Memory stats
      const memoriesInjected = metadata.getStat('memoriesInjected') ?? '0'
      const memoryTokensInjected = metadata.getStat('memoryTokensInjected') ?? '0'
      const memoryHitCount = metadata.getStat('memoryHitCount') ?? '0'
      const memoryHitNum = parseInt(memoryHitCount, 10)
      const memoriesInjectedNum = parseInt(memoriesInjected, 10)
      const memoryTokensNum = parseInt(memoryTokensInjected, 10)

      if (memoryHitNum > 0 || existsSync(resolve(config.dataDir, 'memory-index', 'memories.db'))) {
        console.log(``)
        console.log(`Memory:`)
        console.log(`  Queries with memory:  ${memoryHitCount}${hooksNum > 0 ? ` (${((memoryHitNum / hooksNum) * 100).toFixed(0)}% hit rate)` : ''}`)
        console.log(`  Memories injected:    ${Number(memoriesInjected).toLocaleString()}`)
        console.log(`  Memory tokens:        ${Number(memoryTokensInjected).toLocaleString()}`)
        if (memoryHitNum > 0) {
          console.log(`  Avg tokens/hit:       ${Math.round(memoryTokensNum / memoryHitNum).toLocaleString()}`)
          console.log(`  Avg memories/hit:     ${(memoriesInjectedNum / memoryHitNum).toFixed(1)}`)
        }
        if (memoryFreshness) {
          console.log(`  Freshness:            newest update ${memoryFreshness} ago`)
        }
        if (memoryTotals) {
          console.log(`  Inventory:            ${memoryTotals.total} total (${memoryTotals.active} active, ${memoryTotals.archived} archived, ${memoryTotals.superseded} superseded, ${memoryTotals.pinned} pinned)`)
        }
        const classTokens = [
          ['rule', metadata.getStat('memoryTokens_rule'), metadata.getStat('memoryCount_rule')],
          ['working', metadata.getStat('memoryTokens_working'), metadata.getStat('memoryCount_working')],
          ['fact', metadata.getStat('memoryTokens_fact'), metadata.getStat('memoryCount_fact')],
          ['episode', metadata.getStat('memoryTokens_episode'), metadata.getStat('memoryCount_episode')],
        ] as const
        if (classTokens.some(([, tokens, count]) => Number(tokens ?? '0') > 0 || Number(count ?? '0') > 0)) {
          console.log(`  Avg tokens/class:`)
          for (const [label, tokens, count] of classTokens) {
            const countNum = Number(count ?? '0')
            const tokenNum = Number(tokens ?? '0')
            if (countNum > 0) {
              console.log(`    ${label}: ${Math.round(tokenNum / countNum).toLocaleString()} tokens`)
            }
          }
        }
        const memoryCompactionCount = metadata.getStat('memoryCompactionCount') ?? '0'
        const memoryArchivedCount = metadata.getStat('memoryArchivedCount') ?? '0'
        const memorySupersededCount = metadata.getStat('memorySupersededCount') ?? '0'
        if (Number(memoryCompactionCount) > 0 || Number(memoryArchivedCount) > 0 || Number(memorySupersededCount) > 0) {
          console.log(`  Compaction:`)
          console.log(`    Runs: ${memoryCompactionCount}`)
          console.log(`    Archived: ${memoryArchivedCount}`)
          console.log(`    Superseded: ${memorySupersededCount}`)
        }
      }

      if (latency.count > 0) {
        console.log(``)
        console.log(`Search Latency (${latency.count} queries):`)
        console.log(`  Avg:  ${latency.avg}ms`)
        console.log(`  p50:  ${latency.p50}ms`)
        console.log(`  p95:  ${latency.p95}ms`)
      }

      // Route breakdown
      const routeSkip = metadata.getStat('route_skip_count') ?? '0'
      const routeR0 = metadata.getStat('route_R0_count') ?? '0'
      const routeR1 = metadata.getStat('route_R1_count') ?? '0'
      const routeR2 = metadata.getStat('route_R2_count') ?? '0'
      const totalRoutes = parseInt(routeSkip, 10) + parseInt(routeR0, 10) + parseInt(routeR1, 10) + parseInt(routeR2, 10)
      if (totalRoutes > 0) {
        console.log(``)
        console.log(`Route Breakdown:`)
        console.log(`  Skipped (meta/non-code):  ${routeSkip}`)
        console.log(`  R0 (fast path):           ${routeR0}`)
        console.log(`  R1 (flow route):          ${routeR1}`)
        console.log(`  R2 (deep route):          ${routeR2}`)
      }

      // Check daemon status
      const pidPath = resolve(config.dataDir, 'daemon.pid')
      if (existsSync(pidPath)) {
        const pid = readFileSync(pidPath, 'utf-8').trim()
        if (isProcessAlive(parseInt(pid, 10))) {
          console.log(`\nDaemon: running (PID ${pid})`)
        } else {
          console.log(`\nDaemon: not running (stale PID file)`)
        }
      } else {
        console.log(`\nDaemon: not running`)
      }

      metadata.close()
      memoryStore?.close()
    })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds} seconds ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`
  return `${Math.floor(seconds / 86400)} days ago`
}

function dirSize(dir: string): number {
  let size = 0
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = resolve(dir, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        size += dirSize(fullPath)
      } else {
        size += stat.size
      }
    }
  } catch {
    // ignore
  }
  return size
}
