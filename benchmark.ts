#!/usr/bin/env npx tsx
/**
 * Standalone benchmark runner:
 *   npx tsx benchmark.ts [--size small|medium|large|all] [--mode synthetic|live|both] [--provider keyword|semantic]
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
import {
  runLiveBenchmark,
  printLiveResults,
  type LiveBenchmarkResults
} from './test/benchmark/live-runner.js'

type BenchmarkMode = 'synthetic' | 'live' | 'both'
type Provider = 'keyword' | 'semantic'

async function main() {
  const args = process.argv.slice(2)
  let sizeArg = 'all'
  let outputPath: string | undefined
  let modeArg: BenchmarkMode = 'both'
  let providerArg: Provider = 'keyword'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--size' && args[i + 1]) {
      sizeArg = args[i + 1]
      i++
    }
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1]
      i++
    }
    if (args[i] === '--mode' && args[i + 1]) {
      modeArg = args[i + 1] as BenchmarkMode
      i++
    }
    if (args[i] === '--provider' && args[i + 1]) {
      providerArg = args[i + 1] as Provider
      i++
    }
  }

  const validModes = ['synthetic', 'live', 'both']
  if (!validModes.includes(modeArg)) {
    console.error(`Invalid mode: ${modeArg}. Use: synthetic, live, or both`)
    process.exit(1)
  }

  const validProviders = ['keyword', 'semantic']
  if (!validProviders.includes(providerArg)) {
    console.error(`Invalid provider: ${providerArg}. Use: keyword or semantic`)
    process.exit(1)
  }

  const runSynthetic = modeArg === 'synthetic' || modeArg === 'both'
  const runLive = modeArg === 'live' || modeArg === 'both'

  // JSON output structure
  const jsonOutput: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
  }

  // ─── Synthetic benchmark ───

  if (runSynthetic) {
    const validSizes = ['small', 'medium', 'large', 'all']
    if (!validSizes.includes(sizeArg)) {
      console.error(`Invalid size: ${sizeArg}. Use: small, medium, large, or all`)
      process.exit(1)
    }

    const sizes: CodebaseSize[] =
      sizeArg === 'all' ? ['small', 'medium', 'large'] : [sizeArg as CodebaseSize]

    const benchmarkRoot = join(tmpdir(), `reporecall-benchmark-${Date.now()}`)
    mkdirSync(benchmarkRoot, { recursive: true })

    console.log('╔══════════════════════════════════════════════════════════════╗')
    console.log('║         Reporecall — v0.2.0 Synthetic Benchmark            ║')
    console.log('╠══════════════════════════════════════════════════════════════╣')
    console.log(`║  Sizes: ${sizes.join(', ').padEnd(52)}║`)
    console.log(`║  Modes: baseline, keyword, semantic | Routes: skip, R0, R1, R2 ║`)
    console.log('╚══════════════════════════════════════════════════════════════╝')
    console.log('')

    const allResults: BenchmarkResults[] = []

    for (const size of sizes) {
      console.log(`\n━━━ Benchmarking ${size} codebase ━━━`)
      const dir = join(benchmarkRoot, size)
      mkdirSync(dir, { recursive: true })

      const results = await runBenchmark(size, dir)
      allResults.push(results)
    }

    printResults(allResults)
    jsonOutput.results = resultsToJson(allResults).results

    rmSync(benchmarkRoot, { recursive: true, force: true })
  }

  // ─── Live-repo benchmark ───

  if (runLive) {
    console.log('\n')
    const liveResults = await runLiveBenchmark(providerArg)
    printLiveResults(liveResults)
    jsonOutput.live = liveResults
  }

  // Write JSON results
  const jsonPath = outputPath ?? join(process.cwd(), 'benchmark-results.json')
  writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2))
  console.log(`\nResults written to: ${jsonPath}`)
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
