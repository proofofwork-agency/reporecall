#!/usr/bin/env npx tsx
/**
 * Benchmark runner — measures search quality against the Reporecall codebase
 * using the production pipeline and graded relevance annotations.
 *
 *   npx tsx benchmark.ts [--provider keyword|semantic] [--output path.json]
 */

import { writeFileSync } from 'fs'
import { join } from 'path'
import {
  runLiveBenchmark,
  printLiveResults,
} from './test/benchmark/live-runner.js'

type Provider = 'keyword' | 'semantic'

async function main() {
  const args = process.argv.slice(2)
  let outputPath: string | undefined
  let providerArg: Provider = 'keyword'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1]
      i++
    }
    if (args[i] === '--provider' && args[i + 1]) {
      providerArg = args[i + 1] as Provider
      i++
    }
  }

  const validProviders = ['keyword', 'semantic']
  if (!validProviders.includes(providerArg)) {
    console.error(`Invalid provider: ${providerArg}. Use: keyword or semantic`)
    process.exit(1)
  }

  const results = await runLiveBenchmark(providerArg)
  printLiveResults(results)

  const jsonPath = outputPath ?? join(process.cwd(), 'benchmark-results.json')
  writeFileSync(jsonPath, JSON.stringify({ timestamp: new Date().toISOString(), live: results }, null, 2))
  console.log(`\nResults written to: ${jsonPath}`)
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
