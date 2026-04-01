import { Command } from 'commander'
import { resolve } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { isProcessAlive } from '../core/platform.js'
import { assertSqliteRuntimeHealthy } from '../storage/sqlite-utils.js'

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Diagnose common issues with Reporecall')
    .option('--project <path>', 'Project root path')
    .action(async (options) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd())

      const config = loadConfig(projectRoot)
      let issues = 0
      let warnings = 0

      console.log(`Reporecall Doctor\n`)
      console.log(`Project: ${projectRoot}`)
      console.log(`Data dir: ${config.dataDir}\n`)

      // Check 0: native SQLite binding health
      try {
        assertSqliteRuntimeHealthy({
          cwd: projectRoot,
          log: (message) => process.stderr.write(`${message}\n`),
        })
        console.log('✓ better-sqlite3 runtime is healthy')
      } catch (err) {
        console.log(`✗ ${err instanceof Error ? err.message : String(err)}`)
        issues++
      }

      // Check 1: Data directory exists
      if (!existsSync(config.dataDir)) {
        console.log("✗ Data directory not found. Run 'reporecall init' first.")
        issues++
      } else {
        console.log('✓ Data directory exists')
      }

      // Check 2: Metadata database
      const metaDb = resolve(config.dataDir, 'metadata.db')
      if (!existsSync(metaDb)) {
        console.log(
          "✗ Metadata database not found. Run 'reporecall index' to create it."
        )
        issues++
      } else {
        const size = statSync(metaDb).size
        if (size === 0) {
          console.log(
            '✗ Metadata database is empty (possibly corrupt). Delete .memory/ and re-index.'
          )
          issues++
        } else {
          console.log(
            `✓ Metadata database exists (${(size / 1024).toFixed(1)} KB)`
          )
        }
      }

      // Check 3: FTS database
      const ftsDb = resolve(config.dataDir, 'fts.db')
      if (!existsSync(ftsDb)) {
        console.log(
          "✗ FTS database not found. Run 'reporecall index' to create it."
        )
        issues++
      } else {
        console.log('✓ FTS database exists')
      }

      // Check 4: Lance directory
      const lanceDir = resolve(config.dataDir, 'lance')
      if (!existsSync(lanceDir)) {
        if (config.embeddingProvider !== 'keyword') {
          console.log(
            "✗ Vector store not found. Run 'reporecall index' to create it."
          )
          issues++
        } else {
          console.log('- Vector store not present (keyword mode — expected)')
        }
      } else {
        console.log('✓ Vector store exists')
      }

      // Check 5: Memory store
      const memoryDbPath = resolve(config.dataDir, 'memory-index', 'memories.db')
      if (existsSync(memoryDbPath)) {
        try {
          const { MemoryStore } = await import('../storage/memory-store.js')
          const memStore = new MemoryStore(resolve(config.dataDir, 'memory-index'))
          const memCount = memStore.getCount()
          const memSize = statSync(memoryDbPath).size
          console.log(
            `✓ Memory store healthy (${memCount} memor${memCount === 1 ? 'y' : 'ies'}, ${(memSize / 1024).toFixed(1)} KB)`
          )
          memStore.close()
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          console.log(`⚠ Memory store exists but could not be read: ${reason}`)
          warnings++
        }
      } else {
        console.log('- Memory store not present (no memories indexed)')
      }

      // Check 6: Embedding provider health
      if (config.embeddingProvider === 'ollama') {
        try {
          const response = await fetch(`${config.ollamaUrl}/api/tags`)
          if (response.ok) {
            console.log(`✓ Ollama is running at ${config.ollamaUrl}`)
          } else {
            console.log(`✗ Ollama responded with status ${response.status}`)
            issues++
          }
        } catch {
          console.log(
            `✗ Ollama is not running at ${config.ollamaUrl}. Start it with: ollama serve`
          )
          issues++
        }
      } else if (config.embeddingProvider === 'openai') {
        if (!process.env.OPENAI_API_KEY) {
          console.log('✗ OPENAI_API_KEY environment variable not set')
          issues++
        } else {
          console.log('✓ OpenAI API key is set')
        }
      } else if (config.embeddingProvider === 'local') {
        console.log(
          '✓ Using local embedding model (no external service needed)'
        )
      } else if (config.embeddingProvider === 'keyword') {
        console.log('- Keyword-only mode (no embeddings)')
      }

      // Check 7: Stale WAL files (suggest running daemon or re-indexing)
      const walFiles = ['metadata.db-wal', 'fts.db-wal']
      for (const wal of walFiles) {
        const walPath = resolve(config.dataDir, wal)
        if (existsSync(walPath)) {
          const walSize = statSync(walPath).size
          if (walSize > 10 * 1024 * 1024) {
            console.log(
              `⚠ Large WAL file: ${wal} (${(walSize / 1024 / 1024).toFixed(1)} MB) — consider restarting daemon`
            )
            warnings++
          }
        }
      }

      // Check 8: Daemon PID file
      const pidPath = resolve(config.dataDir, 'daemon.pid')
      if (existsSync(pidPath)) {
        try {
          const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
          if (isNaN(pid)) {
            console.log('⚠ Daemon PID file contains invalid data')
            warnings++
          } else {
            if (isProcessAlive(pid)) {
              console.log(`✓ Daemon is running (PID ${pid})`)
            } else {
              console.log(
                `⚠ Stale daemon PID file (PID ${pid} is not running). Safe to delete.`
              )
              warnings++
            }
          }
        } catch {
          console.log('⚠ Could not read daemon PID file')
          warnings++
        }
      } else {
        console.log('- Daemon is not running')
      }

      // Check 9: Config sanity
      const weightSum =
        config.searchWeights.vector +
        config.searchWeights.keyword +
        config.searchWeights.recency
      if (Math.abs(weightSum - 1.0) > 0.3) {
        console.log(
          `⚠ Search weights sum to ${weightSum.toFixed(2)} (expected ~1.0)`
        )
        warnings++
      } else {
        console.log('✓ Search weights are balanced')
      }

      // Check 10: package-manager consistency hint
      const packageLock = resolve(projectRoot, 'package-lock.json')
      const pnpmLock = resolve(projectRoot, 'pnpm-lock.yaml')
      if (existsSync(packageLock) && existsSync(pnpmLock)) {
        console.log('⚠ Both package-lock.json and pnpm-lock.yaml are present. Mixed installs can break native modules like better-sqlite3.')
        warnings++
      }

      // Summary
      console.log('')
      if (issues === 0 && warnings === 0) {
        console.log('All checks passed! Everything looks healthy.')
      } else {
        if (issues > 0) console.log(`${issues} issue(s) found.`)
        if (warnings > 0) console.log(`${warnings} warning(s) found.`)
      }

      if (issues > 0) process.exit(1)
    })
}
