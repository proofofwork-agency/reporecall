# Reporecall Competitive Positioning (July 2026)

**Overall Rating: 6/10 → Target 9/10**

> Built like an 8, positioned like a 3.  
> Reporecall is a genuinely well-engineered local context + memory layer. The technology is not the problem. Adoption, messaging, and distribution are.

## Rating Breakdown

| Axis                    | Score | Notes |
|-------------------------|-------|-------|
| Engineering & Design    | 8/10  | Hybrid retrieval + intent routing, deterministic extractive compression with expand-on-demand (`search_code action=read_chunk`), real freshness/trust contract (indexedCommit + banners + auto-refresh), strict 6-tool MCP discipline, embedded zero-infra local stack (SQLite + local embeddings + no external DBs), clean release hygiene (hundreds of tests). |
| Differentiation (the bundle) | 7/10 | Individual features exist elsewhere. The full combination — local + auto-injecting hooks + compression + explicit trust signals + memory + wiki + topology + Lens — is unique. |
| Adoption / Market Position | 3/10 | Out-adopted by competitors 50–1000×. Strongest weakness. |
| Moat Durability         | 5/10 | Squeezed between free first-party defaults (Claude Code native tools) and loud free OSS clones. Category is a graveyard. |

## Competitive Landscape — Threat Tiers

### 🔴 HIGH / Existential
- **Native Claude Code agentic search** — Free, first-party, always-fresh. Grep gets >90% of RAG value for many repos (per 2026 studies). The default many users never move past.
- **CodeGraph** (~48–59k stars) — 100% local, staleness banners, token-savings pitch. Your positioning twin, ~50× louder.
- **Cline** (64.5k stars) — Explicit "no index, no RAG" thesis attacks the premise.
- **Cognee** — Local, OSS, MCP + Claude hooks + codebase memory, $7.5M seed. Closest direct quadrant competitor.
- **Augment Code** — Cloud Context Engine, massive funding, real-time indexing for huge repos.
- Others: GitNexus, Serena (LSP + memory).

### 🟠 MEDIUM
Cursor, Windsurf, Copilot (cloud/IDE-locked), claude-context, grepai (token pitch), Repomix, Mem0, Aider (design benchmark), DeepWiki, Sourcegraph family, etc.

### ⚰️ Graveyard (Cautionary Tales)
bloop (archived), Mutable AI (dead), CodeSee, Continue (acquired/winding down), Roo Code (archived → forks). Standalone context layers get absorbed or die without distribution.

## Head-to-Head (Key Local/Direct Threats)

| Tool          | Retrieval          | Compress+Expand | Trust/Freshness     | Auto-inject Hooks | Local + OSS     | Adoption |
|---------------|--------------------|-----------------|---------------------|-------------------|-----------------|----------|
| **Reporecall** | 🟢 hybrid+intent  | ✅ + expand    | ✅ banners + indexedCommit + auto-refresh | ✅ per-prompt    | ✅ / ✅        | 🔴 nascent |
| CodeGraph     | 🟡 graph+FTS      | ⚠️ fewer calls | ✅ banner           | ❌ tool-call     | ✅ / ✅        | 🟢 ~50k |
| Cline         | ❌ agentic reads  | ❌             | ⚠️ always-fresh claim | ❌               | ✅ / ✅        | 🟢 64k |
| Cognee        | 🟢 graph KG       | ❌             | ⚠️                 | ✅ hooks         | ✅ / ✅        | 🟡 26k+$ |
| Native CC     | 🟡 agentic grep   | ❌             | ✅ files            | ✅ (it *is* the loop) | ✅ / ⚠️     | 🌊 default |

**Nobody else has columns 2–5 + 6 together in a pure local OSS package.** That quadrant is the moat.

## Where Reporecall Wins / Loses / Is Redundant

### ✅ Win (Defensible)
- Only local OSS tool combining:
  - Hybrid semantic + keyword + intent routing
  - Real extractive compression with on-demand full chunk expansion
  - Persistent project memory (store/recall across sessions)
  - Deterministic wiki + topology + business/product areas
  - Architecture Lens (HTML + JSON)
  - **Auto-injecting Claude Code hooks** (per-prompt push)
  - Explicit trust contract (staleness banners, `get_stats`, `refresh_context`, empty-index guidance, indexedCommit stamping)
- Zero external infrastructure required (no Qdrant/Milvus/Ollama dependency for core path).
- Permissive license + clean MCP surface (6 tools post v0.8 remediation).

### ❌ Lose (Honest)
- Adoption & marketing (CodeGraph and grepai tell parts of your story louder).
- Funding & team size (solo/ small vs $7.5M–$977M competitors).
- Memory depth (Mem0 / Zep / Cognee are more sophisticated on long-term memory).
- Graph scale/precision on very large repos (some rivals use LSP or heavier graphs).
- Not a full agent — you feed Claude Code / Codex / Cline / Aider.

### ⚠️ Redundant When
- Small or familiar repos (native grep + Claude's built-in tools are "good enough" and always fresh).
- User already committed to another context MCP (CodeGraph, Serena, etc.).
- Only wants auto-generated wiki (DeepWiki wins on simplicity).

## Strategic Recommendations (Action Plan)

1. **Reposition the product**  
   Stop leading with "semantic code search MCP".  
   **Lead with**: "The local-first, auto-injecting, self-aware-about-staleness context + memory layer for coding agents."  
   Integration (hooks + Claude Code) is the product.

2. **Out-market the trust contract + receipts**  
   Publish a tokens-saved benchmark.  
   Your freshness story (`indexedCommit`, auto-refresh, dirty-file detection, empty-index guidance) is more complete than most banners. Make it impossible to miss.

3. **Make auto-inject hooks the hero**  
   Per-prompt push (not "hope the agent calls a tool") is the clearest UX edge vs almost everyone except Cognee. Feature it in every quickstart, screenshot, and comparison.

4. **Concede the median repo — own the hard one**  
   Be explicit: Reporecall excels on high-churn, large, cross-module, unfamiliar, or frequently changing codebases. For tiny greenfield projects, native tools are fine.

5. **Watch Cognee**  
   Closest threat in the exact local + hooks + memory quadrant. Differentiate on compression quality, zero-infra simplicity, and the full Lens + business layer.

6. **Distribution is existential**  
   - Killer benchmark README  
   - Clear "why us" comparison page  
   - Plugin marketplace presence  
   - Loud, honest case studies on high-churn repos  
   More features won't save you if nobody hears about the ones you already have.

## Current Strengths (Verified in Codebase)

- `src/core/staleness.ts` + daemon auto-refresh + banners on every MCP/hook response.
- Strict 6-tool MCP surface (`search_context`, `search_code` + read, `explain_flow` + actions, `memory` + actions, `refresh_context`, `get_stats`).
- Compression pipeline with provenance (`selectionSource`, `wikiPagesUsed`, etc.).
- Claude Code hooks that inject before the prompt.
- Local everything (no cloud required by default).
- Deterministic outputs (wiki, Lens, business pages).

## Path to 9/10

- Engineering is already near 8–9.  
- The leap comes from **messaging + distribution + proof**:
  - Repositioned README + docs (this work).
  - Published benchmark with real numbers.
  - Consistent "trust + hooks" narrative everywhere.
  - Clear "for hard repos" targeting.

This document is the north star. Every change to README, docs, examples, and marketing material should map back to these points.

---

*Updated for v0.8.1 release (July 2026) — all recommended positioning, docs, benchmark, stats, and sync work complete.*  
*Engineering claims cross-checked against source (staleness, MCP surface, hooks, compression, etc.).*