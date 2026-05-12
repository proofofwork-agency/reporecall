import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, rmSync } from 'fs'
import { resolve } from 'path'
import { IndexingPipeline } from '../../src/indexer/pipeline.js'
import type { MemoryConfig } from '../../src/core/config.js'
import { resolveExplainResult } from '../../src/cli/explain.js'

const ROUTING_FIXTURES = resolve(import.meta.dirname, '..', 'fixtures', 'routing')
const TEST_PROJECT = resolve(import.meta.dirname, '..', '.test-explain-project')
const TEST_DATA = resolve(TEST_PROJECT, '.memory')

function makeConfig(): MemoryConfig {
  return {
    projectRoot: TEST_PROJECT,
    dataDir: TEST_DATA,
    embeddingProvider: 'keyword',
    embeddingModel: '',
    embeddingDimensions: 0,
    ollamaUrl: '',
    extensions: ['.ts'],
    ignorePatterns: ['node_modules', '.git', '.memory'],
    maxFileSize: 100 * 1024,
    batchSize: 32,
    contextBudget: 8000,
    maxContextChunks: 0,
    sessionBudget: 2000,
    searchWeights: { vector: 0, keyword: 0.7, recency: 0.3 },
    rrfK: 60,
    graphExpansion: false,
    graphDiscountFactor: 0.6,
    siblingExpansion: false,
    siblingDiscountFactor: 0.4,
    reranking: false,
    rerankingModel: '',
    rerankTopK: 25,
    codeBoostFactor: 1.5,
    testPenaltyFactor: 0.3,
    anonymousPenaltyFactor: 0.5,
    debounceMs: 2000,
    port: 37230,
    implementationPaths: ['src/', 'lib/', 'bin/'],
    factExtractors: [],
    conceptBundles: [],
  }
}

let pipeline: IndexingPipeline
let config: MemoryConfig

beforeAll(async () => {
  mkdirSync(resolve(TEST_PROJECT, 'src'), { recursive: true })
  cpSync(resolve(ROUTING_FIXTURES, 'src'), resolve(TEST_PROJECT, 'src'), {
    recursive: true,
  })

  config = makeConfig()
  pipeline = new IndexingPipeline(config)
  const result = await pipeline.indexAll()
  expect(result.filesProcessed).toBeGreaterThan(0)
}, 30000)

afterAll(() => {
  pipeline?.close()
  rmSync(TEST_PROJECT, { recursive: true, force: true })
})

describe('resolveExplainResult', () => {
  it('skips when sanitization removes the whole prompt', async () => {
    const result = await resolveExplainResult(
      'import { foo } from "bar"',
      config,
      {} as never
    )

    expect(result.queryMode).toBe('skip')
    expect(result.skipReason).toBe('empty query after sanitization')
    expect(result.tokensInjected).toBe(0)
    expect(result.chunksInjected).toBe(0)
  })

  it('uses the real navigational route with seeds for flow questions', async () => {
    const result = await resolveExplainResult(
      'how does validate work?',
      config,
      pipeline
    )

    expect(result.queryMode).toBe('trace')
    expect(result.seed?.name).toBe('validate')
    expect(result.seed?.confidence).toBeGreaterThanOrEqual(0.7)
    expect(result.resolvedTarget).toBeTruthy()
    expect(result.tokensInjected).toBeGreaterThan(0)
    expect(result.chunksInjected).toBeGreaterThan(0)
  })

  it('includes broad inventory diagnostics for file-set questions', async () => {
    const result = await resolveExplainResult(
      'which files implement the authentication flow',
      config,
      pipeline
    )

    expect(result.queryMode).toBe('architecture')
    expect(result.broadMode).toBe('inventory')
    expect(result.selectedFiles?.length ?? 0).toBeGreaterThan(0)
    expect(result.selectedFiles?.some((file) => file.filePath === 'src/auth.ts')).toBe(true)
  })

  it('includes product area matches in JSON explain results when wiki memory is available', async () => {
    const result = await resolveExplainResult(
      'which files implement authentication',
      config,
      pipeline,
      undefined,
      {
        getByType: (type: string) => type === 'wiki'
          ? [
              {
                name: 'business-user-authentication',
                description: 'Business capability view',
                summary: 'User Authentication grants protected access.',
                content: `## Capability
User Authentication

## Actor
Product user

## Trigger
User starts login or resumes a session.

## Business terms
- User
- Session

## User-visible actions
- Sign in.

## Business outcome
Protected access is granted.

## Business / Data Concepts
- User
- Session

## External systems
- Identity provider`,
                relatedFiles: ['src/auth.ts'],
                relatedSymbols: ['AuthService'],
                confidence: 0.88,
              },
            ]
          : [],
      } as any
    )

    expect(result.productAreasUsed[0]?.name).toBe('Product Area: Authentication')
    expect(result.businessPagesUsed[0]?.name).toBe('business-user-authentication')
  })
})
