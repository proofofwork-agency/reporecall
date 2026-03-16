import { Command } from 'commander'
import { resolve } from 'path'
import { statSync, existsSync, readFileSync, readdirSync } from 'fs'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { MetadataStore } from '../storage/metadata-store.js'

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
      if (latency.count > 0) {
        console.log(``)
        console.log(`Search Latency (${latency.count} queries):`)
        console.log(`  Avg:  ${latency.avg}ms`)
        console.log(`  p50:  ${latency.p50}ms`)
        console.log(`  p95:  ${latency.p95}ms`)
      }

      // Check daemon status
      const pidPath = resolve(config.dataDir, 'daemon.pid')
      if (existsSync(pidPath)) {
        const pid = readFileSync(pidPath, 'utf-8').trim()
        try {
          process.kill(parseInt(pid, 10), 0)
          console.log(`\nDaemon: running (PID ${pid})`)
        } catch {
          console.log(`\nDaemon: not running (stale PID file)`)
        }
      } else {
        console.log(`\nDaemon: not running`)
      }

      metadata.close()
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
