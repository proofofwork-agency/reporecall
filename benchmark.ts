#!/usr/bin/env npx tsx
/**
 * Standalone benchmark runner: npx tsx benchmark.ts [--size small|medium|large|all]
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  runBenchmark,
  printResults,
  resultsToJson,
  type BenchmarkResults,
  type CodebaseSize
} from './test/benchmark/runner.js'

async function main() {
  const args = process.argv.slice(2)
  let sizeArg = 'all'
  let outputPath: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--size' && args[i + 1]) {
      sizeArg = args[i + 1]
      i++
    }
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1]
      i++
    }
  }

  const validSizes = ['small', 'medium', 'large', 'all']
  if (!validSizes.includes(sizeArg)) {
    console.error(`Invalid size: ${sizeArg}. Use: small, medium, large, or all`)
    process.exit(1)
  }

  const sizes: CodebaseSize[] =
    sizeArg === 'all' ? ['small', 'medium', 'large'] : [sizeArg as CodebaseSize]

  const benchmarkRoot = join(tmpdir(), `reporecall-benchmark-${Date.now()}`)
  mkdirSync(benchmarkRoot, { recursive: true })

  console.log('╔══════════════════════════════════════════════════╗')
  console.log('║         Reporecall — Mode Benchmark             ║')
  console.log('╠══════════════════════════════════════════════════╣')
  console.log(`║  Sizes: ${sizes.join(', ').padEnd(40)}║`)
  console.log(`║  Modes: baseline, keyword, semantic              ║`)
  console.log('╚══════════════════════════════════════════════════╝')
  console.log('')

  const allResults: BenchmarkResults[] = []

  for (const size of sizes) {
    console.log(`\n━━━ Benchmarking ${size} codebase ━━━`)
    const dir = join(benchmarkRoot, size)
    mkdirSync(dir, { recursive: true })

    const results = await runBenchmark(size, dir)
    allResults.push(results)
  }

  // Print formatted results
  printResults(allResults)

  // Write JSON results
  const jsonPath = outputPath ?? join(process.cwd(), 'benchmark-results.json')
  writeFileSync(jsonPath, JSON.stringify(resultsToJson(allResults), null, 2))
  console.log(`\nResults written to: ${jsonPath}`)

  // Cleanup
  rmSync(benchmarkRoot, { recursive: true, force: true })
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
