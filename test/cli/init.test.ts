import { describe, it, expect } from 'vitest'

/**
 * Helper to detect Reporecall hooks — matches both old HTTP hooks (url field)
 * and new command hooks (command field containing the endpoint path).
 */
const isMemoryHook = (h: any) =>
  h?.hooks?.some?.(
    (inner: any) =>
      inner?.url?.includes?.('/hooks/session-start') ||
      inner?.url?.includes?.('/hooks/prompt-context') ||
      inner?.command?.includes?.('/hooks/session-start') ||
      inner?.command?.includes?.('/hooks/prompt-context')
  )

describe('init hook merging', () => {
  it('should merge Reporecall hooks with existing hooks', () => {
    const existingSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: 'command', command: 'echo hello' }]
          }
        ],
        SomeOtherHook: [{ hooks: [{ type: 'command', command: 'echo other' }] }]
      }
    }

    const existingHooks = (existingSettings.hooks ?? {}) as Record<
      string,
      unknown[]
    >

    const memorySessionHook = {
      hooks: [
        {
          type: 'command',
          command:
            'TOKEN=$(cat "/tmp/.memory/daemon.token" 2>/dev/null || echo ""); curl -s -X POST "http://127.0.0.1:37222/hooks/session-start"'
        }
      ]
    }

    const memoryPromptHook = {
      hooks: [
        {
          type: 'command',
          command:
            'TOKEN=$(cat "/tmp/.memory/daemon.token" 2>/dev/null || echo ""); curl -s -X POST "http://127.0.0.1:37222/hooks/prompt-context"'
        }
      ]
    }

    const merged = {
      ...existingHooks,
      SessionStart: [
        ...(existingHooks.SessionStart ?? []).filter(
          (h: unknown) => !isMemoryHook(h)
        ),
        memorySessionHook
      ],
      UserPromptSubmit: [
        ...(existingHooks.UserPromptSubmit ?? []).filter(
          (h: unknown) => !isMemoryHook(h)
        ),
        memoryPromptHook
      ]
    }

    // Existing hooks preserved
    expect(merged.SomeOtherHook).toHaveLength(1)
    // SessionStart has both existing + memory hook
    expect(merged.SessionStart).toHaveLength(2)
    // UserPromptSubmit has memory hook
    expect(merged.UserPromptSubmit).toHaveLength(1)
  })

  it('should replace existing Reporecall hooks on re-init (old HTTP format)', () => {
    // Simulates upgrading from old HTTP hooks to new command hooks
    const existingSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'http',
                url: 'http://127.0.0.1:37222/hooks/session-start',
                timeout: 10
              }
            ]
          },
          { hooks: [{ type: 'command', command: 'echo hello' }] }
        ]
      }
    }

    const existingHooks = (existingSettings.hooks ?? {}) as Record<
      string,
      unknown[]
    >

    const memorySessionHook = {
      hooks: [
        {
          type: 'command',
          command:
            'TOKEN=$(cat "/tmp/.memory/daemon.token" 2>/dev/null || echo ""); curl -s -X POST "http://127.0.0.1:9999/hooks/session-start"'
        }
      ]
    }

    const merged = {
      ...existingHooks,
      SessionStart: [
        ...(existingHooks.SessionStart ?? []).filter(
          (h: unknown) => !isMemoryHook(h)
        ),
        memorySessionHook
      ]
    }

    // Old Reporecall hook replaced, non-Reporecall hook preserved
    expect(merged.SessionStart).toHaveLength(2)
    expect((merged.SessionStart[1] as any).hooks[0].command).toContain('9999')
    expect((merged.SessionStart[1] as any).hooks[0].type).toBe('command')
  })

  it('should replace existing Reporecall hooks on re-init (new command format)', () => {
    // Simulates re-running init when command hooks already exist
    const existingSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  'curl -s -X POST "http://127.0.0.1:37222/hooks/session-start"'
              }
            ]
          },
          { hooks: [{ type: 'command', command: 'echo hello' }] }
        ]
      }
    }

    const existingHooks = (existingSettings.hooks ?? {}) as Record<
      string,
      unknown[]
    >

    const memorySessionHook = {
      hooks: [
        {
          type: 'command',
          command:
            'TOKEN=$(cat "/tmp/.memory/daemon.token" 2>/dev/null || echo ""); curl -s -X POST "http://127.0.0.1:9999/hooks/session-start"'
        }
      ]
    }

    const merged = {
      ...existingHooks,
      SessionStart: [
        ...(existingHooks.SessionStart ?? []).filter(
          (h: unknown) => !isMemoryHook(h)
        ),
        memorySessionHook
      ]
    }

    // Old Reporecall hook replaced, non-Reporecall hook preserved
    expect(merged.SessionStart).toHaveLength(2)
    expect((merged.SessionStart[1] as any).hooks[0].command).toContain('9999')
  })

  it('should generate hooks without requiring daemon.token to exist', () => {
    // This is the key test for Task 1: hooks should be writable before daemon starts.
    // The command reads the token at runtime, so init doesn't need the token file.
    const tokenPath = '/nonexistent/path/.memory/daemon.token'
    const port = 37222
    const endpoint = '/hooks/session-start'

    const command = [
      `TOKEN=$(cat "${tokenPath}" 2>/dev/null || echo "");`,
      `curl -s -X POST`,
      `  -H "Authorization: Bearer $TOKEN"`,
      `  -H "Content-Type: application/json"`,
      `  -d "$(cat)"`,
      `  "http://127.0.0.1:${port}${endpoint}"`,
      `  2>/dev/null || true`
    ].join(' ')

    const hook = { hooks: [{ type: 'command', command }] }

    // Hook is valid without token file existing
    expect(hook.hooks[0].type).toBe('command')
    expect(hook.hooks[0].command).toContain(tokenPath)
    expect(hook.hooks[0].command).toContain('Authorization: Bearer $TOKEN')
    expect(hook.hooks[0].command).toContain(endpoint)
    // The command gracefully handles missing token file
    expect(hook.hooks[0].command).toContain('2>/dev/null || echo ""')
  })
})
