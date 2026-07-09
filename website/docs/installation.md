---
id: installation
title: Installation & Quick Start
sidebar_position: 2
---

# Installation & Quick Start

## Requirements

- **Node.js >= 20** (see `engines` in `package.json`).
- A Unix-compatible shell for Claude Code hooks. On Windows the generated hooks use `curl`/`cat`, so **Git Bash or WSL must be on your PATH**.
- No cloud account or API key is required for the default (local) provider.

## Install

Install globally from npm:

```bash
npm install -g @proofofwork-agency/reporecall
```

This installs two binaries, both pointing at the same CLI:

- **`reporecall`** — the canonical command name (use this).
- **`memory`** — an alias. It may collide with other global installs, so prefer `reporecall`.

Verify the install:

```bash
reporecall --version
```

### Using npx (no global install)

Every command also works through `npx`:

```bash
npx @proofofwork-agency/reporecall init
npx @proofofwork-agency/reporecall index
```

## Quick Start

Run these from the root of the project you want to index.

### 1. Initialize

```bash
reporecall init
```

`init` writes project configuration only — it does **not** index code. It creates:

- `.memory/config.json` and `.memoryignore`
- `.claude/settings.json` hook entries (`SessionStart`, `UserPromptSubmit`)
- a Reporecall section appended to `CLAUDE.md`
- `.mcp.json` with a `reporecall` MCP server entry

Choose an embedding provider at init time if you want something other than the local default:

```bash
reporecall init --embedding-provider keyword   # FTS-only, no model download
reporecall init --embedding-provider ollama     # local Ollama server
reporecall init --embedding-provider openai      # OpenAI embeddings (needs OPENAI_API_KEY)
```

### 2. Index

Build the index. This also generates the deterministic wiki/business pages at the end of the pass:

```bash
reporecall index
```

Output looks roughly like:

```text
Indexing project: /path/to/your/project
Chunking: [████████████████████] 100% (312/312 files)
Done: 312 files, 4821 chunks
Wiki: generated 22 pages (14 communities, 6 hubs, 2 business)
```

Pass `--no-wiki` to skip wiki/business generation (useful in CI):

```bash
reporecall index --no-wiki
```

### 3. First search / explain

Search the index directly:

```bash
reporecall search "checkout session"
```

Or dry-run the retrieval pipeline to see how a prompt is routed and what would be injected:

```bash
reporecall explain "which files implement authentication?"
```

`explain` prints the chosen query mode, the resolved seed, token/chunk counts, and the selected chunks — a fast way to sanity-check retrieval. Add `--json` for a machine-readable diagnostic.

### 4. (Optional) Run the daemon

For live, hook-injected context in Claude Code, start the daemon. It runs an incremental index on startup, generates wiki pages, and keeps the index fresh through a file watcher:

```bash
reporecall serve
```

The daemon listens on `http://127.0.0.1:37222` by default and exposes `/health` and `/ready` probes.

### 5. (Optional) Open the architecture lens

```bash
reporecall lens --serve --open
```

## MCP client setup

`reporecall init` auto-generates `.mcp.json` in the project root. The generated entry launches the stdio MCP server with the resolved Node binary and the absolute path to the CLI entry point:

```json
{
  "mcpServers": {
    "reporecall": {
      "command": "/path/to/node",
      "args": ["/abs/path/to/dist/memory.js", "mcp", "--project", "/abs/path/to/project"]
    }
  }
}
```

You can write the equivalent entry by hand for any MCP client. A portable form using the installed bin:

```json
{
  "mcpServers": {
    "reporecall": {
      "command": "reporecall",
      "args": ["mcp", "--project", "${PROJECT_ROOT}"]
    }
  }
}
```

Or invoke Node against the package entry point directly:

```json
{
  "mcpServers": {
    "reporecall": {
      "command": "node",
      "args": ["./dist/memory.js", "mcp", "--project", "${PROJECT_ROOT}"]
    }
  }
}
```

:::note
`${PROJECT_ROOT}` in the two hand-written examples above is a placeholder — replace it with your MCP client's variable syntax or a literal absolute path. The `reporecall init`-generated `.mcp.json` always writes a literal absolute project path.
:::

### Claude Code

`init` already wires Claude Code end to end (hooks + `.mcp.json`). When `reporecall serve` is running, hooks call the local daemon:

| Hook | What Reporecall returns |
| --- | --- |
| `SessionStart` | Project guidance and memory instructions. |
| `UserPromptSubmit` | Relevant codebase context for the current prompt. |

### Codex and other MCP clients

Codex and other agents use the open MCP/CLI surfaces rather than Claude Code hooks. Start the stdio server:

```bash
reporecall mcp --project .
```

If a daemon is already running for the same project, prefer sharing it with `reporecall serve --mcp` instead of starting a second standalone MCP process (to avoid SQLite lock contention).

## Verify your setup

```bash
reporecall doctor
```

`doctor` checks the native SQLite runtime, the data directory, metadata/FTS/vector stores, the memory store, embedding-provider health (including whether `OPENAI_API_KEY` is set for the `openai` provider), stale WAL files, daemon status, and search-weight balance.
