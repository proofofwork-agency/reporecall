import { Command } from 'commander'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { MetadataStore } from '../storage/metadata-store.js'
import { analyzeConventions } from '../analysis/conventions.js'

export function conventionsCommand(): Command {
  return new Command('conventions')
    .description('Show detected coding conventions')
    .option('--project <path>', 'Project root path')
    .option('--json', 'Output as JSON')
    .option('--refresh', 'Re-analyze conventions from current index')
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
      try {
        let report = options.refresh ? undefined : metadata.getConventions()

        if (!report) {
          report = analyzeConventions(metadata)
          metadata.setConventions(report)
        }

        if (options.json) {
          console.log(JSON.stringify(report, null, 2))
          return
        }

        console.log('Coding Conventions\n')

        console.log('Naming Style:')
        console.log(`  Functions: ${report.namingStyle.functions}`)
        console.log(`  Classes:   ${report.namingStyle.classes}`)
        console.log('')

        console.log('Code Metrics:')
        console.log(`  Total functions:    ${report.totalFunctions}`)
        console.log(`  Total classes:      ${report.totalClasses}`)
        console.log(`  Docstring coverage: ${report.docstringCoverage}%`)
        console.log(
          `  Avg function length:    ${report.averageFunctionLength} lines`
        )
        console.log(
          `  Median function length: ${report.medianFunctionLength} lines`
        )
        console.log('')

        const langs = Object.entries(report.languageDistribution).sort(
          ([, a], [, b]) => b - a
        )
        if (langs.length > 0) {
          console.log('Language Distribution:')
          for (const [lang, count] of langs) {
            console.log(`  ${lang}: ${count} chunks`)
          }
          console.log('')
        }

        if (report.topCallTargets.length > 0) {
          console.log('Most Called Functions:')
          for (const name of report.topCallTargets) {
            console.log(`  ${name}`)
          }
        }
      } finally {
        metadata.close()
      }
    })
}
