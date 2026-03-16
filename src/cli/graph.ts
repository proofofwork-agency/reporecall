import { Command } from 'commander'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { MetadataStore } from '../storage/metadata-store.js'

export function graphCommand(): Command {
  return new Command('graph')
    .description('Show call graph for a function or method')
    .argument('<name>', 'Function or method name')
    .option('--project <path>', 'Project root path')
    .option('--callers', 'Show who calls this function')
    .option('--callees', 'Show what this function calls')
    .option('--both', 'Show both callers and callees (default)')
    .option('--limit <n>', 'Max results per direction', '20')
    .action(async (name: string, options) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd())

      const config = loadConfig(projectRoot)

      if (!existsSync(resolve(config.dataDir, 'metadata.db'))) {
        console.log('No index found. Run "reporecall index" first.')
        return
      }

      const metadata = new MetadataStore(config.dataDir)
      try {
        const limit = parseInt(options.limit, 10)
        const showCallers =
          options.callers ||
          options.both ||
          (!options.callers && !options.callees)
        const showCallees =
          options.callees ||
          options.both ||
          (!options.callers && !options.callees)

        if (showCallers) {
          const callers = metadata.findCallers(name, limit)
          console.log(`\nCallers of "${name}" (${callers.length}):`)
          if (callers.length === 0) {
            console.log('  (none found)')
          } else {
            for (const caller of callers) {
              console.log(
                `  ${caller.callerName} @ ${caller.filePath}:${caller.line}`
              )
            }
          }
        }

        if (showCallees) {
          const callees = metadata.findCallees(name, limit)
          console.log(`\nCallees of "${name}" (${callees.length}):`)
          if (callees.length === 0) {
            console.log('  (none found)')
          } else {
            for (const callee of callees) {
              console.log(
                `  ${callee.targetName} [${callee.callType}] @ ${callee.filePath}:${callee.line}`
              )
            }
          }
        }
      } finally {
        metadata.close()
      }
    })
}
