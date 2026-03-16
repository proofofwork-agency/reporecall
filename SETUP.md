# Setup Guide

## Prerequisites

- **Node.js** >= 18

## Installation

### 1. Clone and build

```bash
git clone <repo-url>
cd idea
npm install
npm run build
```

### 2. Initialize in your project

```bash
cd /path/to/your/project
reporecall init
```

This creates a `.memory/` directory with config and data files. Add `.memory/` to your `.gitignore`.

Embeddings run locally by default using a bundled model (~23MB, downloaded on first use). No external services needed.

### 3. Index your codebase

```bash
reporecall index
```

First run indexes everything. Subsequent runs use Merkle tree change detection and only re-index changed files.

### 4. Verify

```bash
reporecall stats
reporecall search "your search query"
reporecall conventions
```

## Running the Daemon

The daemon provides auto-reindexing on file changes and HTTP hooks for Claude Code:

```bash
reporecall serve
```

This starts:

- File watcher (chokidar) for automatic re-indexing
- HTTP server on `127.0.0.1:37222` for Claude Code hooks

### With MCP

```bash
reporecall serve --mcp
```

Adds MCP server on stdio alongside the HTTP server.

## Claude Code Integration

### Hook Configuration

`reporecall init` automatically configures hooks in `.claude/settings.json`.

Current behavior:

- hooks are written as `command` hooks, not raw `http` hooks
- the command reads the bearer token from `.memory/daemon.token` at runtime
- this avoids baking secrets into `settings.json` and works after the daemon starts

Representative generated shape:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "TOKEN=$(cat \"/absolute/path/to/project/.memory/daemon.token\" 2>/dev/null || echo \"\"); curl -s -X POST -H \"Authorization: Bearer $TOKEN\" -H \"Content-Type: application/json\" -d \"$(cat)\" \"http://127.0.0.1:37222/hooks/session-start\" 2>/dev/null || true"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "TOKEN=$(cat \"/absolute/path/to/project/.memory/daemon.token\" 2>/dev/null || echo \"\"); curl -s -X POST -H \"Authorization: Bearer $TOKEN\" -H \"Content-Type: application/json\" -d \"$(cat)\" \"http://127.0.0.1:37222/hooks/prompt-context\" 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

If you configure hooks manually, keep the token-read pattern and use the daemon port from `.memory/config.json` if you changed it from the default `37222`.

### MCP Configuration (Claude Desktop)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "reporecall": {
      "command": "node",
      "args": [
        "/absolute/path/to/dist/memory.js",
        "mcp",
        "--project",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

## Configuration Reference

All settings in `.memory/config.json` are optional. Defaults:

| Setting                 | Default                           | Description                                          |
| ----------------------- | --------------------------------- | ---------------------------------------------------- |
| `embeddingProvider`     | `"local"`                         | `"local"`, `"ollama"`, `"openai"`, or `"keyword"`    |
| `embeddingModel`        | `"Xenova/all-MiniLM-L6-v2"`       | Model name for embeddings                            |
| `embeddingDimensions`   | `384`                             | Embedding vector dimensions                          |
| `ollamaUrl`             | `"http://localhost:11434"`        | Ollama server URL                                    |
| `contextBudget`         | `4000`                            | Max tokens per prompt context injection              |
| `maxContextChunks`      | `0`                               | Dynamic chunk cap based on token budget (`0` = auto) |
| `sessionBudget`         | `2000`                            | Max tokens for session start context                 |
| `searchWeights.vector`  | `0.5`                             | Weight for vector similarity                         |
| `searchWeights.keyword` | `0.3`                             | Weight for keyword match                             |
| `searchWeights.recency` | `0.2`                             | Weight for recency                                   |
| `batchSize`             | `32`                              | Embedding batch size                                 |
| `maxFileSize`           | `102400`                          | Skip files larger than this (bytes)                  |
| `port`                  | `37222`                           | HTTP server port                                     |
| `debounceMs`            | `2000`                            | File watcher debounce                                |
| `graphExpansion`        | `true`                            | Enable call-graph-based context expansion            |
| `graphDiscountFactor`   | `0.6`                             | Score discount for graph-expanded chunks             |
| `siblingExpansion`      | `true`                            | Include sibling chunks from same parent              |
| `siblingDiscountFactor` | `0.4`                             | Score discount for sibling chunks                    |
| `reranking`             | `false`                           | Enable cross-encoder reranking                       |
| `rerankingModel`        | `"Xenova/ms-marco-MiniLM-L-6-v2"` | Model for reranking                                  |
| `rerankTopK`            | `25`                              | Number of candidates for reranking                   |

## Ignoring Files

Create `.memoryignore` in your project root (same syntax as `.gitignore`):

```
# Skip generated files
generated/
*.gen.ts

# Skip large data files
data/
fixtures/large/
```

The engine also respects `.gitignore` and has built-in ignores for `node_modules`, `.git`, `dist`, `build`, etc.

### Alternative: Ollama (free, local, GPU-accelerated)

```bash
# Install Ollama: https://ollama.ai
ollama serve
ollama pull mxbai-embed-large
reporecall init --embedding-provider ollama
```

### Alternative: OpenAI

```bash
export OPENAI_API_KEY="sk-..."
reporecall init --embedding-provider openai
```

Then in `.memory/config.json`:

```json
{
  "embeddingProvider": "openai",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDimensions": 1536
}
```

## Troubleshooting

### "Ollama is not running"

Only relevant if using `--embedding-provider ollama`:

```bash
ollama serve     # Start the Ollama daemon
ollama list      # Verify model is pulled
```

### Slow initial index

Large codebases take time on first index due to embedding generation. Use `--project` to limit scope or increase `batchSize` for faster throughput.

### Stale index

```bash
reporecall index     # Re-index (only changed files)
reporecall conventions --refresh   # Refresh conventions analysis
```

### Reset everything

Delete the `.memory/` directory and re-run `reporecall init && reporecall index`.