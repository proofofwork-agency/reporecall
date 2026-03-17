import type { HybridSearch } from '../search/hybrid.js'
import type { MemoryConfig } from '../core/config.js'
import type { MetadataStore } from '../storage/metadata-store.js'
import type { AssembledContext } from '../search/types.js'

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
  '## Reporecall Behavior\n\n' +
  '> When codebase context is injected via hooks, treat it as the primary source for that prompt. ' +
  'For normal and flow-route bundles, answer from the injected context first and avoid repository tools unless the bundle is missing a required detail. ' +
  'For low-confidence bundles, repository tools are allowed.\n\n'

export async function handleSessionStart(
  search: HybridSearch,
  config: MemoryConfig,
  metadata?: MetadataStore
): Promise<AssembledContext> {
  const context = await search.searchWithContext(
    'project architecture main entry point overview',
    config.sessionBudget
  )

  const prefix =
    MEMORY_BEHAVIOR_INSTRUCTION +
    (metadata ? formatConventionsSummary(metadata) : '')

  if (prefix) {
    return {
      ...context,
      text: prefix + context.text
    }
  }

  return context
}
