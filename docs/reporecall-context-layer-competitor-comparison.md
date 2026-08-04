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

## The Trust Contract (Why Agents Can Rely on Us)

- Every hook injection and MCP result includes freshness metadata.
- Explicit empty/stale banners + `refresh_context` as the universal fix.
- `indexedCommit` + dirty file detection (not just "last indexed time").
- Memory layer works even when the code index is empty.
- Compact 6-tool surface after v0.8 (deliberate reduction in agent choice overload).

See `src/core/staleness.ts`, the daemon auto-refresh logic, and `src/daemon/mcp-server.ts`.

## Competitor Matrix (2026 Reality)

| Tool          | Retrieval + Compression      | Trust / Freshness Signals | Auto-Inject Hooks | Local + Zero-Infra | Adoption     | Notes |
|---------------|------------------------------|---------------------------|-------------------|--------------------|--------------|-------|
| **Reporecall** | Hybrid + intent + expand    | ✅ Full (banners + indexedCommit + auto-refresh) | ✅ Per-prompt    | ✅ Full           | 🔴 Nascent  | Best local bundle |
| CodeGraph     | Graph + FTS                 | ✅ Banner                | ❌               | ✅                | 🟢 established | Closest narrative twin |
| Cline         | Agentic file reads          | ⚠️ "always fresh" claim  | ❌               | ✅                | 🟢 established | Anti-index philosophy |
| Cognee        | Graph KG                    | ⚠️                      | ✅               | ✅                | 🟡 + funding| Same quadrant threat |
| Native Claude Code | Agentic grep             | ✅ (files are live)      | ✅ (it is the agent) | ✅             | 🌊 Default  | Biggest existential threat |
| Augment       | Cloud semantic              | ✅ real-time             | ❌               | ❌                | Well funded | Different (cloud) model |

**Key observation**: No other local OSS tool combines auto-injection + sophisticated compression + full trust signals + the complete stack.

## Honest Assessment

**We win on**:
- Local determinism + full bundle
- Auto-inject hooks (agents don't have to remember to call tools)
- Explicit, unavoidable freshness honesty
- Zero external infra for the core path

**We lose on**:
- Raw adoption and marketing volume
- Funding and team size
- Some memory sophistication (specialized memory tools go deeper)
- Scale on enormous monorepos (some cloud tools win here)

**Redundant for**:
- Small/familiar repos (native grep + agent tools are fine)
- Users who already love another context provider

See also the full competitive positioning document for threat tiers and graveyard examples.

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
