# Reporecall Context Layer and Competitor Comparison

This document compares Reporecall's current context, memory, wiki, MCP, and business-context layers with common paid and free AI coding tools.

## Mermaid Chart Status

The README Mermaid charts are up to date for the current `0.7.0` feature set.

They show:

- Hook, CLI, and MCP entry points.
- Intent classification.
- Code retrieval.
- Wiki evidence.
- Project memory.
- Capability evidence resolution.
- Product-area evidence.
- `reporecall explain --json`.
- `reporecall lens --json` and Lens HTML.
- Compact MCP tools.

## Positioning

Reporecall is not a direct replacement for Cursor, Windsurf, GitHub Copilot, Claude Code, or Codex.

Reporecall is best positioned as a local context engine for coding agents:

- It indexes a repository locally.
- It routes questions by intent.
- It selects source files with provenance.
- It adds graph, wiki, memory, and business-context layers.
- It exposes the result through hooks, compact MCP tools, `explain --json`, `lens --json`, and Lens HTML.

The main value is better context for agents, not model hosting or an AI editor UI.

## Context Layers

Reporecall's current context stack:

| Layer | Purpose |
| --- | --- |
| Intent classifier | Routes prompts as `lookup`, `trace`, `bug`, `architecture`, `change`, or `skip`. |
| Code retrieval | Uses local indexes and source chunks to find relevant implementation evidence. |
| Graph evidence | Uses imports, callers, callees, topology, hubs, and communities. |
| Wiki layer | Stores deterministic repo knowledge generated from topology and code evidence. |
| Capability evidence | Selects concrete files for flows and architecture questions with `selectionSource`, `selectionReason`, and `wikiPagesUsed`. |
| Business layer | Exposes `productAreas[]` with `areaKind`, `businessPages[]`, `productAreasUsed[]`, and `businessPagesUsed[]`. |
| Memory layer | Stores durable facts, rules, decisions, feedback, and working context. |
| Public surfaces | Claude hooks, compact MCP tools, `explain --json`, `lens --json`, and Lens HTML. |

## Competitor Matrix

| Tool | Context Layer | Memory / Rules | Code Graph | Business/Product Layer | Local-first | Best At |
| --- | --- | --- | --- | --- | --- | --- |
| Reporecall | Intent routing, local code chunks, graph, wiki, capability resolver, product areas | Persistent local memory, generated wiki, business pages | Imports, calls, topology, Lens | Yes: `productAreas[]`, `businessPages[]`, Lens/explain JSON | Yes | Supplying better repo context to agents |
| Cursor | Editor context, codebase indexing, agents, MCP | Project rules, user rules, generated memories | Some codebase awareness | No first-class product-area layer | Partly | Integrated AI editor workflow |
| Windsurf | IDE context, Cascade, local/remote indexing | Memories and rules | Codebase context engine | No first-class product-area layer | Partly; remote indexing exists for teams | AI IDE with agent workflow |
| Continue | Context providers, codebase/search providers, MCP | Configurable assistants and rules | Depends on providers | No built-in product layer | Strong open-source angle | Customizable OSS agent stack |
| Claude Code | Agent context, `CLAUDE.md`, hooks, MCP, skills | Memory files, `CLAUDE.md`, hooks, external MCP memory | Uses tools/LSP/MCP rather than owning a repo index | No built-in product-area export | Local agent, remote model | Autonomous coding agent |
| Codex CLI | CLI agent can inspect repo, edit files, and run commands | Instruction files and MCP/tool setup | Tool-driven | No built-in product-area export | Local agent, remote model | Terminal coding agent |
| GitHub Copilot | IDE/GitHub context, Enterprise codebase indexing | Custom instructions | Enterprise codebase indexing | No built-in business layer | No | Broad mainstream coding assistant |
| Sourcegraph Cody | Sourcegraph Search API and context engine | Sourcegraph/enterprise context | Strong cross-repo code search | No built-in business layer | Enterprise/cloud oriented | Large-org code search plus AI |
| Tabnine | IDE completions and chat grounded in codebase | Enterprise controls | Codebase-grounded assistance | No built-in business layer | Strong private/on-prem story | Secure enterprise assistant |
| Qodo | PR/code-review context engine | Rules and governance | Multi-repo awareness on Enterprise | No product-area map | SaaS and enterprise options | AI code review and SDLC governance |
| Greptile | Code review and chat with repo context | Custom context and learnings | Review-focused repo context | No product-area map | SaaS and enterprise options | AI code review with repository context |

## Paid Tools

### Cursor

Cursor is a full AI editor. It wins on UX, inline editing, agent workflow, cloud agents, and day-to-day developer ergonomics.

Reporecall is different:

- Cursor owns the editor experience.
- Reporecall owns a reusable context layer that can feed multiple agents.
- Cursor has rules and generated memories.
- Reporecall has deterministic source selection, wiki evidence, memory, and product-area exports.

Current official pricing includes Free, Pro at `$20/mo`, Pro+ at `$60/mo`, Ultra at `$200/mo`, and Teams at `$40/user/mo`.

### Windsurf

Windsurf is also an AI IDE. It has Cascade, context awareness, memories/rules, and remote indexing for team/enterprise setups.

Reporecall is stronger when you want:

- Local deterministic indexing.
- Tool-agnostic context exports.
- CLI Lens/explain business-context exports.
- A product/business layer over code evidence.

Windsurf is stronger when you want a complete editor and agent experience out of the box.

### GitHub Copilot

Copilot wins on distribution, IDE support, GitHub integration, and enterprise adoption.

Reporecall is stronger for:

- Local-first repository context.
- Auditable file selection.
- Business/product aggregation.
- Use across Claude, Codex, and MCP clients.

Copilot Enterprise can index an organization's codebase for deeper understanding, but it does not expose the same local wiki/memory/business context layer as Reporecall.

### Sourcegraph Cody

Cody is backed by Sourcegraph's code search and context engine. It is strong for large organizations and cross-repository search.

Reporecall is better suited when:

- You want local project-level context.
- You want an open MCP/JSON surface.
- You want business/product context generated from code evidence.

Sourcegraph is better suited when:

- You need enterprise-scale code search across many repositories.
- You already use Sourcegraph.

### Tabnine

Tabnine focuses on private, secure code assistance and enterprise deployment, including cloud, on-prem, and air-gapped options.

Reporecall is not a completion model or IDE assistant. It is a context layer. Tabnine can be a better fit for enterprise completion/chat deployments; Reporecall can still be useful as local context infrastructure.

### Qodo and Greptile

Qodo and Greptile are closer to code-review products than coding assistants.

They win on:

- PR review workflows.
- Review-specific UX.
- Enterprise governance.
- Review automation.

Reporecall wins on:

- Local codebase context.
- Agent-agnostic MCP and JSON APIs.
- Business/product context.
- Trace and architecture retrieval.

## Free and Open Options

### Continue

Continue is the closest open/customizable alternative. It has context providers for files, code, codebase snippets, folders, ripgrep search, docs, terminal output, and MCP.

Continue is strong when you want:

- Open-source IDE extensions.
- Bring-your-own-model setup.
- Custom context providers.
- Flexible agent configuration.

Reporecall complements Continue well:

- Continue can consume context.
- Reporecall can provide richer local repo context through MCP or JSON.
- Reporecall adds graph, wiki, memory, and business-product context that Continue does not provide by default.

### Claude Code and Codex CLI

Claude Code and Codex are agent runtimes, not primarily context-indexing products.

They can:

- inspect files;
- edit files;
- run commands;
- use MCP tools;
- follow instruction files.

Reporecall improves them by giving them:

- fewer broad searches;
- selected source files;
- missing-evidence metadata;
- durable project memory;
- wiki pages;
- product-area evidence.

## Reporecall Strengths

Reporecall is strongest when the problem is context quality.

Key strengths:

- Local-first indexing.
- No mandatory cloud embedding API.
- Intent-specific retrieval.
- Trace and architecture file coverage.
- Graph-aware evidence.
- Generated wiki pages.
- Durable memory.
- Business capability pages.
- Product-area aggregation.
- Compact MCP tools for code context, flow navigation, memory, refresh, and stats.
- `lens --json` and `explain --json` for external tools.
- Auditable provenance through `selectionSource`, `selectionReason`, and `wikiPagesUsed`.

## Reporecall Weaknesses

Reporecall is weaker than paid competitors in these areas:

- No full editor UI like Cursor or Windsurf.
- No model hosting.
- No autonomous cloud agent.
- No polished SaaS PR review workflow like Qodo or Greptile.
- No multi-repo enterprise search platform like Sourcegraph.
- Scoring remains heuristic and needs continued calibration.
- Lens is useful but not yet a hosted collaborative dashboard.

## Best Product Direction

Reporecall should not try to become another AI IDE.

The best direction is:

1. Stay local-first and generic.
2. Be the best context engine for coding agents.
3. Keep exposing stable public APIs through MCP and JSON.
4. Improve business/product aggregation without feeding generated business summaries back into core search as hard rules.
5. Make Lens a clear inspection/debugging surface for context quality.
6. Keep Claude/Codex/Continue/Cursor compatibility instead of binding to one client.

## Sources

- Cursor pricing: <https://cursor.com/pricing>
- GitHub Copilot pricing and Enterprise indexing: <https://github.com/features/copilot/plans>
- Sourcegraph Cody docs: <https://sourcegraph.com/docs/cody>
- Continue context providers: <https://docs.continue.dev/customize/custom-providers>
- Continue pricing: <https://www.continue.dev/pricing>
- Windsurf docs: <https://docs.windsurf.com/>
- Windsurf remote indexing: <https://docs.windsurf.com/context-awareness/remote-indexing>
- OpenAI Codex CLI docs: <https://developers.openai.com/codex/cli>
- Claude Max pricing: <https://claude.com/pricing/max>
- Claude Code hooks: <https://docs.claude.com/en/docs/claude-code/hooks>
- Claude Code configuration/context docs: <https://code.claude.com/docs/en/debug-your-config>
- Qodo pricing: <https://www.qodo.ai/pricing/>
- Greptile pricing: <https://www.greptile.com/pricing>
- Tabnine pricing: <https://www.tabnine.com/pricing/>
