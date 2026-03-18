
<!-- reporecall -->
## Reporecall

When codebase context is injected via hooks (marked with "Relevant codebase context"), answer directly from that context. Do not attempt to read files or use tools to look up code that is already provided in the injected context. If the injected context is insufficient to answer, say so rather than guessing.

### Team Collaboration

Reporecall uses a **three-tier configuration pattern** for team collaboration:

**1. Global Settings** (`~/.claude/settings.json`)
- Your personal preferences across all projects
- Model choice, theme, keybindings, custom skills

**2. Project Shared** (`.claude/settings.json`, `.mcp.json`)
- Committed to git
- Team-wide hooks, MCP server configuration, project instructions
- Uses **`$CLAUDE_PROJECT_DIR`** environment variable so hooks work when teammates clone the repo to different machines
- `$CLAUDE_PROJECT_DIR` is automatically provided by Claude Code at hook runtime with the absolute path to the project root

**3. Local Overrides** (`.claude/settings.local.json`)
- **Gitignored** — never committed
- Machine-specific customizations: custom daemon port, network proxy, auth tokens, etc.
- Claude Code automatically merges your local settings over shared settings

### Setup for Teams

**First-time setup:**
```bash
git clone <repo>
cd <repo>
reporecall init
reporecall index
```

**What `reporecall init` does:**
- Creates `.memory/` for indexes and config
- Generates `.claude/settings.json` with `$CLAUDE_PROJECT_DIR` hooks (portable & reliable)
- Auto-generates `.mcp.json` with MCP server config
- `.mcp.json` is committed and syncs automatically. Hooks in `.claude/settings.json` are generated per-machine — each teammate runs `reporecall init` once after cloning.

**Machine-specific overrides:**
Create `.claude/settings.local.json` (gitignored):
```json
{
  "port": 37223,
  "embeddingProvider": "ollama"
}
```

Claude Code merges this over `.claude/settings.json`, so each team member can customize locally without affecting the shared config.

**Each teammate runs `reporecall init` once after cloning.** After that, no re-running is needed.
<!-- reporecall -->
