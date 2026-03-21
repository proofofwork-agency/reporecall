import type { HybridSearch as _HybridSearch } from '../search/hybrid.js'
import type { MemoryConfig as _MemoryConfig } from '../core/config.js'
import type { MetadataStore } from '../storage/metadata-store.js'
import type { AssembledContext } from '../search/types.js'
import { countTokens } from '../search/context-assembler.js'

function formatConventionsSummary(metadata: MetadataStore): string {
  const conventions = metadata.getConventions()
  if (!conventions) return ''

  const lines: string[] = ['## Codebase Conventions']

  lines.push(
    `- Naming: functions use ${conventions.namingStyle.functions}, classes use ${conventions.namingStyle.classes}`
  )
  lines.push(`- Docstring coverage: ${conventions.docstringCoverage}%`)
  lines.push(
    `- Function length: avg ${conventions.averageFunctionLength} lines, median ${conventions.medianFunctionLength} lines`
  )
  lines.push(
    `- ${conventions.totalFunctions} functions, ${conventions.totalClasses} classes`
  )

  const langs = Object.entries(conventions.languageDistribution)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([lang, count]) => `${lang}(${count})`)
    .join(', ')
  if (langs) lines.push(`- Languages: ${langs}`)

  if (conventions.topCallTargets.length > 0) {
    lines.push(
      `- Most-used calls: ${conventions.topCallTargets.slice(0, 5).join(', ')}`
    )
  }

  return lines.join('\n') + '\n\n'
}

const MEMORY_BEHAVIOR_INSTRUCTION =
  '## Reporecall\n\n' +
  '> Answer from injected codebase context first. Use repository tools only if context is insufficient.\n\n'

export async function handleSessionStart(
  _search: _HybridSearch,
  _config: _MemoryConfig,
  metadata?: MetadataStore
): Promise<AssembledContext> {
  const text = MEMORY_BEHAVIOR_INSTRUCTION + (metadata ? formatConventionsSummary(metadata) : '')
  return {
    text,
    tokenCount: countTokens(text),
    chunks: [],
    routeStyle: 'standard',
  }
}
