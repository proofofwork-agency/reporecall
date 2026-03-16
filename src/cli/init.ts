import { Command } from 'commander'
import { resolve } from 'path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { detectProjectRoot } from '../core/project.js'
import { loadConfig } from '../core/config.js'
import { homedir } from 'os'

export function initCommand(): Command {
  return new Command('init')
    .description(
      'Initialize Reporecall for the current project. Creates .memory/ dir, Claude Code hooks, and CLAUDE.md instructions.'
    )
    .option(
      '--autostart',
      'Register macOS launch agent for auto-start on login'
    )
    .option(
      '--embedding-provider <provider>',
      'Embedding provider (local, ollama, openai, or keyword)',
      'local'
    )
    .option('--project <path>', 'Project root path')
    .action(async (options) => {
      const projectRoot = options.project
        ? resolve(options.project)
        : detectProjectRoot(process.cwd())

      console.log(`Initializing Reporecall for: ${projectRoot}`)

      // Create .memory directory
      const dataDir = resolve(projectRoot, '.memory')
      mkdirSync(dataDir, { recursive: true })

      // Write default config
      const configPath = resolve(dataDir, 'config.json')
      if (!existsSync(configPath)) {
        writeFileSync(
          configPath,
          JSON.stringify(
            { embeddingProvider: options.embeddingProvider },
            null,
            2
          )
        )
        console.log(`  Created ${configPath}`)
      }

      // Create .memoryignore if it doesn't exist
      const ignorePath = resolve(projectRoot, '.memoryignore')
      if (!existsSync(ignorePath)) {
        writeFileSync(
          ignorePath,
          '# Add patterns to exclude from memory indexing\n# Uses same syntax as .gitignore\n'
        )
        console.log(`  Created ${ignorePath}`)
      }

      // Set up Claude Code hooks
      const claudeDir = resolve(projectRoot, '.claude')
      mkdirSync(claudeDir, { recursive: true })
      const settingsPath = resolve(claudeDir, 'settings.json')

      let settings: Record<string, unknown> = {}
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        } catch {
          // start fresh
        }
      }

      let configPort = 37222
      let configDataDir = dataDir
      try {
        const config = loadConfig(projectRoot)
        configPort = config.port
        configDataDir = config.dataDir
      } catch {
        // use default port
      }

      // Token file path — hooks read this at runtime so they work even if
      // the daemon hasn't started yet (the token file is created on daemon start).
      const tokenPath = resolve(configDataDir, 'daemon.token')

      const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>

      // Build shell command hooks that read the bearer token at runtime.
      // This avoids baking the token into settings.json at init time, which
      // would fail if the daemon hasn't started yet (token file doesn't exist).
      const buildCurlHook = (
        endpoint: string
      ): { hooks: { type: string; command: string }[] } => {
        // The command reads the token from disk each time it fires.
        // If the token file is absent (daemon not started), $TOKEN is empty
        // and the header becomes "Authorization: Bearer " — the daemon
        // will reject it, which is safe.
        const safeTokenPath = escapeShell(tokenPath)
        const command = [
          `TOKEN=$(cat "${safeTokenPath}" 2>/dev/null || echo "");`,
          `curl -s -X POST`,
          `  -H "Authorization: Bearer $TOKEN"`,
          `  -H "Content-Type: application/json"`,
          `  -d "$(cat)"`,
          `  "http://127.0.0.1:${configPort}${endpoint}"`,
          `  2>/dev/null || true`
        ].join(' ')

        return {
          hooks: [{ type: 'command', command }]
        }
      }

      const memorySessionHook = buildCurlHook('/hooks/session-start')
      const memoryPromptHook = buildCurlHook('/hooks/prompt-context')

      // Merge hook entries instead of overwriting (#38)
      const sessionHooks = existingHooks.SessionStart ?? []
      const promptHooks = existingHooks.UserPromptSubmit ?? []

      // Remove any existing Reporecall hooks before re-adding.
      // Matches both old-style HTTP hooks (url field) and new command hooks (curl command).
      const isMemoryHook = (h: any) =>
        h?.hooks?.some?.(
          (inner: any) =>
            inner?.url?.includes?.('/hooks/session-start') ||
            inner?.url?.includes?.('/hooks/prompt-context') ||
            inner?.command?.includes?.('/hooks/session-start') ||
            inner?.command?.includes?.('/hooks/prompt-context')
        )

      settings.hooks = {
        ...existingHooks,
        SessionStart: [
          ...sessionHooks.filter((h: unknown) => !isMemoryHook(h)),
          memorySessionHook
        ],
        UserPromptSubmit: [
          ...promptHooks.filter((h: unknown) => !isMemoryHook(h)),
          memoryPromptHook
        ]
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
      console.log(`  Created Claude Code hooks in ${settingsPath}`)

      // Add Reporecall instruction to CLAUDE.md
      const claudeMdPath = resolve(projectRoot, 'CLAUDE.md')
      const MEMORY_MARKER = '<!-- reporecall -->'
      const MEMORY_SECTION = `
${MEMORY_MARKER}
## Reporecall

When codebase context is injected via hooks (marked with "Relevant codebase context"), answer directly from that context. Do not attempt to read files or use tools to look up code that is already provided in the injected context. If the injected context is insufficient to answer, say so rather than guessing.
${MEMORY_MARKER}`

      let claudeMd = ''
      if (existsSync(claudeMdPath)) {
        claudeMd = readFileSync(claudeMdPath, 'utf-8')
      }

      if (!claudeMd.includes(MEMORY_MARKER)) {
        // Append memory section
        writeFileSync(claudeMdPath, claudeMd + MEMORY_SECTION + '\n')
        console.log(`  Added Reporecall instructions to CLAUDE.md`)
      } else {
        // Replace existing memory section
        const markerRegex = new RegExp(
          `\\n?${MEMORY_MARKER}[\\s\\S]*?${MEMORY_MARKER}`,
          'g'
        )
        claudeMd = claudeMd.replace(markerRegex, MEMORY_SECTION)
        writeFileSync(claudeMdPath, claudeMd)
        console.log(`  Updated Reporecall instructions in CLAUDE.md`)
      }

      // Auto-start with macOS launch agent
      if (options.autostart) {
        setupLaunchAgent(projectRoot)
      }

      console.log('\nDone! Next steps:')
      console.log('  1. Index your codebase: reporecall index')
      console.log('  2. Start daemon: reporecall serve')
      console.log(
        '  Or use --autostart to have it start automatically on login.'
      )
      if (options.embeddingProvider === 'keyword') {
        console.log('\n  Using keyword-only mode (no model download required).')
        console.log(
          '  For semantic search: --embedding-provider local|ollama|openai'
        )
      } else {
        console.log(
          '\n  Using local embeddings (no external services required).'
        )
        console.log(
          '  For alternatives: --embedding-provider ollama|openai|keyword'
        )
      }
    })
}

// Shell-escape characters that are special inside double-quoted strings
function escapeShell(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
}

// H-2: XML-escape interpolated values in plist to prevent injection
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function setupLaunchAgent(projectRoot: string): void {
  const label = `com.proofofworks.reporecall.${projectRoot.replace(/[/\\]/g, '-').replace(/^-/, '')}`
  const plistDir = resolve(homedir(), 'Library', 'LaunchAgents')
  mkdirSync(plistDir, { recursive: true })
  const plistPath = resolve(plistDir, `${label}.plist`)

  const logDir = resolve(homedir(), '.memory', 'logs')
  mkdirSync(logDir, { recursive: true })

  // Find the Reporecall binary
  const reporecallBin = resolve(
    projectRoot,
    'node_modules',
    '.bin',
    'reporecall'
  )
  const memoryAliasBin = resolve(projectRoot, 'node_modules', '.bin', 'memory')
  const fallbackBin = 'npx'

  const selectedBin = existsSync(reporecallBin)
    ? reporecallBin
    : existsSync(memoryAliasBin)
      ? memoryAliasBin
      : null
  const useFallback = !selectedBin
  const programArgs = useFallback
    ? `    <array>
      <string>${escapeXml(fallbackBin)}</string>
      <string>reporecall</string>
      <string>serve</string>
      <string>--project</string>
      <string>${escapeXml(projectRoot)}</string>
    </array>`
    : `    <array>
      <string>${escapeXml(selectedBin!)}</string>
      <string>serve</string>
      <string>--project</string>
      <string>${escapeXml(projectRoot)}</string>
    </array>`

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
${programArgs}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(resolve(logDir, 'daemon.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(resolve(logDir, 'daemon.log'))}</string>
    <key>WorkingDirectory</key>
    <string>${escapeXml(projectRoot)}</string>
</dict>
</plist>`

  writeFileSync(plistPath, plist)
  console.log(`  Created launch agent: ${plistPath}`)
  console.log(`  To start now: launchctl load ${plistPath}`)
}
