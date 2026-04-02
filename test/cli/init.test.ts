import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { initCommand } from '../../src/cli/init.js'

// Run initCommand programmatically by invoking its action handler directly.
// We extract the action from the Commander Command object so that we can
// call it in-process without spawning a child process.
async function runInit(
  tmpDir: string,
  options: Record<string, string | boolean> = {}
): Promise<void> {
  const cmd = initCommand()
  // Commander stores the action handler; we invoke it with synthetic options.
  const defaults = {
    project: tmpDir,
    embeddingProvider: 'keyword',
    autostart: false,
    ...options,
  }
  // parseOptions returns a plain object — we can invoke the action directly
  // by calling the internal _actionHandler that Commander registers.
  // The cleanest way is to use cmd.parseAsync with fabricated argv.
  await cmd.parseAsync(
    [
      'node',
      'reporecall',
      '--project',
      tmpDir,
      '--embedding-provider',
      (defaults.embeddingProvider as string) ?? 'keyword',
    ],
    { from: 'node' }
  )
}

describe('initCommand — real file creation', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'reporecall-init-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates .memory/ directory', async () => {
    await runInit(tmpDir)
    expect(existsSync(resolve(tmpDir, '.memory'))).toBe(true)
  })

  it('creates config.json with correct default embeddingProvider', async () => {
    await runInit(tmpDir)
    const configPath = resolve(tmpDir, '.memory', 'config.json')
    expect(existsSync(configPath)).toBe(true)
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.embeddingProvider).toBe('keyword')
  })

  it('creates config.json reflecting --embedding-provider option', async () => {
    const cmd = initCommand()
    await cmd.parseAsync(
      ['node', 'reporecall', '--project', tmpDir, '--embedding-provider', 'local'],
      { from: 'node' }
    )
    const config = JSON.parse(
      readFileSync(resolve(tmpDir, '.memory', 'config.json'), 'utf-8')
    )
    expect(config.embeddingProvider).toBe('local')
  })

  it('creates .memoryignore file', async () => {
    await runInit(tmpDir)
    const ignorePath = resolve(tmpDir, '.memoryignore')
    expect(existsSync(ignorePath)).toBe(true)
    const content = readFileSync(ignorePath, 'utf-8')
    expect(content).toContain('memory indexing')
  })

  it('creates .claude/settings.json with SessionStart hook', async () => {
    await runInit(tmpDir)
    const settingsPath = resolve(tmpDir, '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks).toBeDefined()
    expect(Array.isArray(settings.hooks.SessionStart)).toBe(true)
    expect(settings.hooks.SessionStart.length).toBeGreaterThan(0)
    const sessionHook = settings.hooks.SessionStart[0]
    expect(sessionHook.hooks[0].type).toBe('command')
    expect(sessionHook.hooks[0].command).toContain('/hooks/session-start')
  })

  it('creates .claude/settings.json with UserPromptSubmit hook', async () => {
    await runInit(tmpDir)
    const settings = JSON.parse(
      readFileSync(resolve(tmpDir, '.claude', 'settings.json'), 'utf-8')
    )
    expect(Array.isArray(settings.hooks.UserPromptSubmit)).toBe(true)
    expect(settings.hooks.UserPromptSubmit.length).toBeGreaterThan(0)
    const promptHook = settings.hooks.UserPromptSubmit[0]
    expect(promptHook.hooks[0].command).toContain('/hooks/prompt-context')
  })

  it('does not generate Reporecall PreToolUse hooks', async () => {
    await runInit(tmpDir)
    const settings = JSON.parse(
      readFileSync(resolve(tmpDir, '.claude', 'settings.json'), 'utf-8')
    )
    expect(settings.hooks.PreToolUse).toBeUndefined()
  })

  it('hooks contain runtime token read and do not bake a static token', async () => {
    await runInit(tmpDir)
    const settings = JSON.parse(
      readFileSync(resolve(tmpDir, '.claude', 'settings.json'), 'utf-8')
    )
    const command = settings.hooks.SessionStart[0].hooks[0].command as string
    // Token is read at runtime from the token file using $CLAUDE_PROJECT_DIR
    // with a $PWD fallback for headless/sdk-cli sessions.
    expect(command).toContain('PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"')
    expect(command).toContain('TOKEN=$(cat')
    expect(command).toContain('$PROJECT_DIR')
    expect(command).toContain('.memory/daemon.token')
    expect(command).toContain('2>/dev/null || echo ""')
    // Bearer header is templated, not a literal value
    expect(command).toContain('Authorization: Bearer $TOKEN')
  })

  it('creates CLAUDE.md with Reporecall marker section', async () => {
    await runInit(tmpDir)
    const claudeMdPath = resolve(tmpDir, 'CLAUDE.md')
    expect(existsSync(claudeMdPath)).toBe(true)
    const content = readFileSync(claudeMdPath, 'utf-8')
    expect(content).toContain('<!-- reporecall -->')
    expect(content).toContain('## Reporecall')
  })

  it('does not duplicate config.json on re-init', async () => {
    await runInit(tmpDir)
    const configBefore = readFileSync(
      resolve(tmpDir, '.memory', 'config.json'),
      'utf-8'
    )
    // Second init — config.json should not be overwritten (existsSync guard)
    await runInit(tmpDir)
    const configAfter = readFileSync(
      resolve(tmpDir, '.memory', 'config.json'),
      'utf-8'
    )
    expect(configAfter).toBe(configBefore)
  })

  it('replaces existing Reporecall hooks without duplicating on re-init', async () => {
    await runInit(tmpDir)
    await runInit(tmpDir)
    const settings = JSON.parse(
      readFileSync(resolve(tmpDir, '.claude', 'settings.json'), 'utf-8')
    )
    // Exactly one Reporecall hook per event after two init runs
    expect(settings.hooks.SessionStart).toHaveLength(1)
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1)
    expect(settings.hooks.PreToolUse).toBeUndefined()
  })

  it('preserves non-Reporecall hooks in settings.json', async () => {
    // Pre-populate settings with a third-party hook
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(resolve(tmpDir, '.claude'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo external-hook' }] },
          ],
        },
      })
    )

    await runInit(tmpDir)

    const settings = JSON.parse(
      readFileSync(resolve(tmpDir, '.claude', 'settings.json'), 'utf-8')
    )
    // Both the external hook and the Reporecall hook must be present
    expect(settings.hooks.SessionStart).toHaveLength(2)
    const commands = settings.hooks.SessionStart.map(
      (h: any) => h.hooks[0].command as string
    )
    expect(commands.some((c: string) => c === 'echo external-hook')).toBe(true)
    expect(
      commands.some((c: string) => c.includes('/hooks/session-start'))
    ).toBe(true)
  })

  it('removes legacy Reporecall PreToolUse hooks when re-initializing', async () => {
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(resolve(tmpDir, '.claude'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Agent',
              hooks: [
                {
                  type: 'command',
                  command: 'echo "Reporecall context is injected via hooks"'
                }
              ]
            }
          ],
        },
      })
    )

    await runInit(tmpDir)

    const settings = JSON.parse(
      readFileSync(resolve(tmpDir, '.claude', 'settings.json'), 'utf-8')
    )
    expect(settings.hooks.PreToolUse).toBeUndefined()
  })

  it('preserves non-Reporecall PreToolUse hooks', async () => {
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(resolve(tmpDir, '.claude'), { recursive: true })
    writeFileSync(
      resolve(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: 'echo external-pretool'
                }
              ]
            }
          ],
        },
      })
    )

    await runInit(tmpDir)

    const settings = JSON.parse(
      readFileSync(resolve(tmpDir, '.claude', 'settings.json'), 'utf-8')
    )
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    const commands = settings.hooks.PreToolUse
      .flatMap((hook: any) => Array.isArray(hook.hooks) ? hook.hooks : [])
      .map((hook: any) => hook.command)
      .filter(Boolean)
    expect(commands).toContain('echo external-pretool')
  })

  it('creates .mcp.json with Reporecall server config', async () => {
    await runInit(tmpDir)
    const mcpJsonPath = resolve(tmpDir, '.mcp.json')
    expect(existsSync(mcpJsonPath)).toBe(true)
    const mcpConfig = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
    expect(mcpConfig.mcpServers).toBeDefined()
    expect(mcpConfig.mcpServers.reporecall).toBeDefined()
    expect(mcpConfig.mcpServers.reporecall.command).toBe(process.execPath)
    expect(mcpConfig.mcpServers.reporecall.args).toEqual([
      resolve(process.argv[1]),
      'mcp',
      '--project',
      tmpDir,
    ])
  })

  it('prefers the currently running CLI entry over a local package install', async () => {
    const { mkdirSync, writeFileSync } = await import('fs')
    const pkgDir = resolve(tmpDir, 'node_modules', '@proofofwork-agency', 'reporecall')
    mkdirSync(resolve(pkgDir, 'dist'), { recursive: true })
    writeFileSync(
      resolve(pkgDir, 'package.json'),
      JSON.stringify({ bin: { reporecall: 'dist/memory.js' } })
    )
    writeFileSync(resolve(pkgDir, 'dist', 'memory.js'), '// fake package entry\n')

    const customDistDir = resolve(tmpDir, 'custom-reporecall', 'dist')
    mkdirSync(customDistDir, { recursive: true })
    const customEntry = resolve(customDistDir, 'memory.js')
    writeFileSync(customEntry, '// fake custom dist entry\n')

    const originalArgv1 = process.argv[1]
    process.argv[1] = customEntry
    try {
      await runInit(tmpDir)
    } finally {
      process.argv[1] = originalArgv1
    }

    const mcpConfig = JSON.parse(
      readFileSync(resolve(tmpDir, '.mcp.json'), 'utf-8')
    )
    expect(mcpConfig.mcpServers.reporecall.args).toEqual([
      customEntry,
      'mcp',
      '--project',
      tmpDir,
    ])
  })

  it('preserves existing MCP servers when updating .mcp.json', async () => {
    // Pre-populate .mcp.json with an external server
    const { mkdirSync, writeFileSync } = await import('fs')
    writeFileSync(
      resolve(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          other: { command: 'echo', args: ['external'] },
        },
      })
    )

    await runInit(tmpDir)

    const mcpConfig = JSON.parse(
      readFileSync(resolve(tmpDir, '.mcp.json'), 'utf-8')
    )
    // Both external and Reporecall servers must be present
    expect(mcpConfig.mcpServers.other).toBeDefined()
    expect(mcpConfig.mcpServers.reporecall).toBeDefined()
  })
})
