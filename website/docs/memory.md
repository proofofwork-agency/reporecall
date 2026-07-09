---
id: memory
title: Persistent Memory
sidebar_position: 7
---

# Persistent Memory

Reporecall maintains **persistent project memory** across sessions. Memories are Markdown files with frontmatter, stored locally and indexed separately from code. When relevant to a query, they are injected alongside code context — so an agent carries forward rules, decisions, and learned facts instead of rediscovering them every session.

Memory is **independent of the code index**: memory reads and writes work even when no code has been indexed yet.

## The model

Every memory is categorized along four axes. Frontmatter can set them explicitly; otherwise they are derived from the memory **type**.

### Type

The category of the memory.

| Type | Typical use |
| --- | --- |
| `user` | User preferences and instructions. |
| `feedback` | Corrections the user gave the agent ("don't do X"). |
| `project` | Project-specific facts and decisions. |
| `reference` | Reference material worth recalling. |

(`wiki` is an internal type used by generated pages.)

### Class

How the memory is retrieved and compacted.

| Class | Meaning |
| --- | --- |
| `rule` | Always-on guidance (highest priority in the budget). |
| `fact` | Durable project fact. |
| `episode` | A summarized past interaction; archived as it ages. |
| `working` | Transient working state. |

Default class by type: `feedback → rule`; `user`, `project`, `reference → fact`.

### Scope

Where the memory applies.

| Scope | Meaning |
| --- | --- |
| `global` | Applies across all projects. |
| `project` | Applies to this project. |
| `branch` | Applies to the current branch. |

Default scope by type: `feedback`, `user`, `reference → global`; `project → project`.

### Status

Lifecycle state: `active`, `archived`, or `superseded`. Compaction archives aging episodes and marks superseded records, while keeping pinned memories active.

## Working with memory

Agents use the single `memory` MCP tool with an `action`. (The CLAUDE.md template that `init` writes references `action=store|recall|forget`.)

### Recall

Retrieve memories relevant to the current task:

```json
{
  "name": "memory",
  "arguments": { "action": "recall", "query": "how do we name commits?", "limit": 5 }
}
```

Recall accepts filters: `types`, `classes`, `scopes`, `statuses`, `minConfidence`, and contextual boosters `activeFiles` / `topCodeFiles` / `topCodeSymbols`.

### Explain

See how recall would behave — selected memories, dropped memories, the route, and the budget split:

```json
{
  "name": "memory",
  "arguments": { "action": "explain", "query": "commit conventions", "tokenBudget": 500 }
}
```

### List

Enumerate stored memories, optionally filtered by `memoryType`, `memoryClass`, `memoryScope`, or `memoryStatus`:

```json
{ "name": "memory", "arguments": { "action": "list", "memoryClass": "rule" } }
```

### Store

Save context for future sessions. **Requires** `name`, `description`, `memoryType`, and `content`:

```json
{
  "name": "memory",
  "arguments": {
    "action": "store",
    "memoryType": "feedback",
    "memoryClass": "rule",
    "name": "no-coauthor-tag",
    "description": "Do not add Co-Authored-By tags to commits",
    "content": "# Commit policy\n\nDo not append Co-Authored-By trailers.",
    "pinned": true,
    "confidence": 0.9
  }
}
```

Storing writes a managed Markdown file into the writable memory directory (`.memory/reporecall-memories` by default) and indexes it. If a very similar memory already exists, the store is rejected with a warning suggesting you update the existing one (or reuse the same `name` to overwrite).

### Forget

Remove an outdated or incorrect memory by `name`:

```json
{ "name": "memory", "arguments": { "action": "forget", "name": "no-coauthor-tag" } }
```

Forget only deletes files inside allowed memory directories.

## Confidence, pinning & importance

Each memory carries scoring and lifecycle metadata:

- **`confidence`** (0–1) — used during retrieval ranking and compaction. Filter recall with `minConfidence`.
- **`pinned`** — pinned memories survive compaction and stay `active`.
- **`importance`** — a scoring weight (default 1.0).
- **`accessCount` / `lastAccessed`** — updated on retrieval; frequently-recalled facts can be promoted (after `memoryFactPromotionThreshold` repeats, default 3).
- **`supersedesId`** — lets a new memory explicitly replace an older one.

## How memories are injected

When Claude Code hooks are active, relevant memories are assembled **alongside** code context under a dedicated memory budget (`memoryBudget`, default 500 tokens), with per-class sub-budgets weighted toward `rule` and `fact`. A code floor (`memoryCodeFloorRatio`, default 0.8) guarantees code context is not crowded out. Recall records access so future ranking reflects real usage.

You can preview exactly what a prompt would inject — memories included, memories dropped, and the budget split — with:

```bash
reporecall explain "your question here"
```

## Storage & maintenance

- Managed memories live under `.memory/reporecall-memories/` as Markdown files; add more source directories with `memoryDirs`.
- The daemon watches memory directories live (`memoryWatch`) and runs compaction every `memoryCompactionHours` (default 6), archiving episodes older than `memoryArchiveDays` (default 30).
- `reporecall stats` reports memory inventory (total/active/archived/superseded/pinned), hit rate, tokens per class, and compaction counts.
- `reporecall doctor` confirms the memory store is readable.
