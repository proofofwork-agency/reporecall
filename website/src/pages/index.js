import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// Read the numbers straight out of the committed evidence artifacts rather than
// hard-coding them. A published figure that can drift from its own evidence is
// precisely the failure this project exists to prevent, so the marketing page is
// wired to the same artifacts `npm run quality:claims` validates. Re-run the
// benchmarks and this page updates itself; delete the evidence and the build
// fails loudly instead of shipping a stale number.
import contextCost from '../../../quality/evidence/context-cost.json';
import retrievalGates from '../../../quality/evidence/retrieval-gates.json';

const pct = (ratio, digits = 1) => `${(ratio * 100).toFixed(digits)}%`;
const int = (value) => Math.round(value).toLocaleString('en-US');

const COST = contextCost.aggregate;
const GATE_LABELS = {
  contextPrecision: 'Context precision',
  contextRecall: 'Context recall',
  pollutionRatio: 'Pollution ratio',
  routeAccuracy: 'Route accuracy',
  highConfidenceWrongRate: 'High-confidence-wrong',
  freshnessSignalingRate: 'Freshness signaling',
};

const PIPELINE = [
  {
    mark: 'prompt',
    text: '"why does the auth callback loop?"',
    note: 'You type. Nothing else happens yet.',
  },
  {
    mark: 'hook',
    text: 'UserPromptSubmit → Reporecall',
    note: 'Intent routed, index queried, evidence compressed.',
  },
  {
    mark: 'inject',
    text: '4 files · 1 call path · 2 memories · FRESH',
    note: 'Attached to the prompt before the model reads it.',
  },
  {
    mark: 'model',
    text: 'Claude / Codex answers',
    note: 'No exploration round-trips to buy the same context.',
  },
];

const FEATURES = [
  {
    icon: '↯',
    title: 'It arrives before the question does',
    body: 'A UserPromptSubmit hook pushes routed, compressed evidence into the prompt itself. The agent never has to decide to call a tool — which is exactly what the largest tools in this category still require.',
  },
  {
    icon: '⚑',
    title: 'It tells you when it might be wrong',
    body: 'Every response carries indexedCommit, a dirty-file count, and an explicit banner when the index is STALE or EMPTY. Staleness gets reported, never hidden behind a confident answer.',
  },
  {
    icon: '⌖',
    title: 'Routed, not just searched',
    body: 'Each query is classified — lookup, trace, architecture, change, bug — and sent to a strategy built for it. "Where is X" and "how does X flow" are not the same retrieval problem.',
  },
  {
    icon: '◫',
    title: 'Six tools, deliberately',
    body: 'search_context, search_code, explain_flow, memory, refresh_context, get_stats. A surface small enough for an agent to use correctly, with no destructive verbs on it.',
  },
  {
    icon: '⌸',
    title: 'Memory that outlives the session',
    body: 'Decisions, rules and project facts persist across sessions and are injected alongside code when they are actually relevant — not on every prompt regardless.',
  },
  {
    icon: '◈',
    title: 'Wiki and architecture lens',
    body: 'A generated wiki, business-context pages, and a single-file interactive dashboard built from your real call graph. Export it with lens --json.',
  },
];

const GATES = Object.entries(retrievalGates.gates).map(([key, gate]) => ({
  name: GATE_LABELS[key] ?? key,
  bar: `${gate.comparison} ${pct(gate.bar, 0)}`,
  value: pct(gate.measured),
}));

function Hero() {
  return (
    <header className="rrHero">
      <div className="container rrHeroInner">
        <div>
          <span className="rrEyebrow">
            <span className="rrPulse" aria-hidden="true" />
            Local-first context layer
          </span>
          <h1 className="rrHeroTitle">
            Your agent stops <em>guessing</em> at your codebase.
          </h1>
          <p className="rrHeroLead">
            Reporecall indexes your repo locally and pushes the right code, call
            paths and memory into <strong>every prompt</strong> through a hook —
            before Claude or Codex starts thinking. And on every response it tells
            you exactly how fresh that context is.
          </p>
          <div className="rrCta">
            <Link className="rrBtn rrBtnPrimary" to="/docs/installation">
              Get started →
            </Link>
            <Link className="rrBtn rrBtnGhost" to="/docs/intro">
              How it works
            </Link>
          </div>
          <div className="rrInstall">
            <span aria-hidden="true">$</span>
            <code>npm i -g @proofofwork-agency/reporecall</code>
          </div>
        </div>

        <div className="rrFlow" aria-label="What happens on a single prompt">
          <div className="rrFlowBar">
            <span className="rrDot" aria-hidden="true" />
            <span className="rrDot" aria-hidden="true" />
            <span className="rrDot" aria-hidden="true" />
            <span className="rrFlowTitle">one prompt, start to finish</span>
          </div>
          <div className="rrFlowBody">
            {PIPELINE.map((step) => (
              <div className="rrStep" key={step.mark}>
                <span className="rrStepMark">{step.mark}</span>
                <span>
                  {step.text}
                  <span className="rrStepNote">{step.note}</span>
                </span>
              </div>
            ))}
            <div className="rrLedger">
              <div>
                <span className="rrLedgerValue rrStruck">
                  {int(COST.medianBaselineTokens)}
                </span>
                <span className="rrLedgerLabel">tokens read whole</span>
              </div>
              <div>
                <span className="rrLedgerValue">
                  {int(COST.medianRepoRecallTokens)}
                </span>
                <span className="rrLedgerLabel">tokens injected</span>
              </div>
              <div>
                <span className="rrLedgerValue">
                  {COST.queriesWithCompleteEvidence}/{contextCost.fixture.queryCount}
                </span>
                <span className="rrLedgerLabel">evidence complete</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function Proof() {
  return (
    <section className="rrSection rrSectionAlt">
      <div className="container">
        <div className="rrSectionHead">
          <span className="rrKicker">Measured, not asserted</span>
          <h2 className="rrSectionTitle">
            Numbers you can reproduce on your own repo
          </h2>
          <p className="rrSectionLead">
            Getting the answering evidence in front of the model costs a median of{' '}
            {pct(COST.medianReductionRatio)} fewer tokens than reading the relevant
            files whole
            {/* claim:context_cost_median_reduction */}. Measured over{' '}
            {contextCost.fixture.queryCount} pre-registered queries against a real
            1,306-file codebase with{' '}
            <strong>zero model calls</strong>, so the result is deterministic and
            you can run it yourself.
          </p>
        </div>

        <div className="rrScroll">
          <table className="rrProof">
            <thead>
              <tr>
                <th>Retrieval gate</th>
                <th>Release bar</th>
                <th>Measured</th>
              </tr>
            </thead>
            <tbody>
              {GATES.map((gate) => (
                <tr key={gate.name}>
                  <td>{gate.name}</td>
                  <td className="rrBar">{gate.bar}</td>
                  <td className="rrMetric">{gate.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="rrCaption">
          Retrieval quality holds at these levels across the same cohort
          {/* claim:retrieval_gates */}. Both figures are backed by committed
          artifacts under <code>quality/evidence/</code> and registered in{' '}
          <code>quality/claims.json</code>, which CI validates on every push.
          <br />
          <strong>Scope, stated plainly:</strong> the token figure is
          context-assembly cost. It excludes reasoning tokens, tool-call overhead
          and multi-turn exploration, so it is not an end-to-end agent measurement
          — and we do not publish one, because we have not earned it yet.
          Unmeasured things report <code>insufficient_evidence</code> instead of a
          guess.
        </p>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section className="rrSection">
      <div className="container">
        <div className="rrSectionHead">
          <span className="rrKicker">What it actually does</span>
          <h2 className="rrSectionTitle">
            A context layer, not another tool to remember
          </h2>
        </div>
        <div className="rrGrid">
          {FEATURES.map((feature) => (
            <article className="rrCard" key={feature.title}>
              <div className="rrCardIcon" aria-hidden="true">
                {feature.icon}
              </div>
              <h3 className="rrCardTitle">{feature.title}</h3>
              <p className="rrCardBody">{feature.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section className="rrSection rrSectionAlt">
      <div className="container">
        <div className="rrSectionHead">
          <span className="rrKicker">The trust contract</span>
          <h2 className="rrSectionTitle">A stale index is worse than no index</h2>
          <p className="rrSectionLead">
            Confidently wrong context is the failure mode that actually costs you
            time. So Reporecall states its own freshness on every response and
            hands the agent the command to repair it. These are the three states
            you will see:
          </p>
          <div className="rrChips">
            <span className="rrChip rrChipFresh">
              FRESH · indexedCommit matches HEAD
            </span>
            <span className="rrChip rrChipStale">STALE · run refresh_context</span>
            <span className="rrChip rrChipEmpty">EMPTY · nothing indexed yet</span>
          </div>
        </div>
        <div className="rrGrid">
          <article className="rrCard">
            <h3 className="rrCardTitle">Runs on your machine</h3>
            <p className="rrCardBody">
              Indexing and retrieval are local, on SQLite and LanceDB, with{' '}
              <strong>zero cloud required by default</strong> and no recurring
              cost. Embeddings run locally unless you deliberately select the{' '}
              <code>openai</code> provider — the one case where content leaves
              your machine.
            </p>
          </article>
          <article className="rrCard">
            <h3 className="rrCardTitle">Works with what you already use</h3>
            <p className="rrCardBody">
              Claude Code through hooks, Codex and any MCP-compatible agent
              through the six-tool server. 22 languages via tree-sitter. Node 22
              or newer.
            </p>
          </article>
          <article className="rrCard">
            <h3 className="rrCardTitle">Held to its own gates</h3>
            <p className="rrCardBody">
              949 tests, a module and cycle gate, multi-OS CI, and a release gate
              that stays blocked when current proof is missing. The claims
              registry fails the build if a published number loses its evidence.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section className="rrClose">
      <div className="container">
        <h2 className="rrCloseTitle">Point it at your worst repository</h2>
        <p className="rrCloseLead">
          The gnarly one — high churn, half-remembered, too big to hold in your
          head. That is the case Reporecall is built for.
        </p>
        <div className="rrCta">
          <Link className="rrBtn rrBtnPrimary" to="/docs/installation">
            Install it →
          </Link>
          <Link
            className="rrBtn rrBtnGhost"
            to="https://github.com/proofofwork-agency/reporecall"
          >
            Read the source
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title="Local context + memory for coding agents"
      description={siteConfig.tagline}
    >
      <Hero />
      <Proof />
      <Features />
      <Trust />
      <Close />
    </Layout>
  );
}
