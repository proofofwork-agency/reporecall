import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

const features = [
  {
    title: 'Local & offline-first',
    body: 'Indexes and serves your codebase entirely on your machine with SQLite + LanceDB. No code leaves your laptop.',
  },
  {
    title: 'Intent-routed retrieval',
    body: 'Classifies each query — lookup, trace, architecture, change, bug — and routes it to the right retrieval strategy.',
  },
  {
    title: 'Six-tool MCP surface',
    body: 'A lean, action-based MCP API: search_context, search_code, explain_flow, memory, refresh_context, get_stats.',
  },
  {
    title: 'Persistent memory',
    body: 'Store and recall decisions, patterns, and project context across sessions — injected alongside code automatically.',
  },
  {
    title: 'Wiki & architecture lens',
    body: 'Auto-generated wiki, business-context pages, and an interactive architecture dashboard built from your call graph.',
  },
  {
    title: 'Freshness honesty',
    body: 'Staleness metadata and repair guidance on every response, with automatic re-indexing of stale indexes.',
  },
];

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout title="Home" description={siteConfig.tagline}>
      <header className={clsx('hero', 'heroBanner')}>
        <div className="container">
          <h1 className="heroTitle">{siteConfig.title}</h1>
          <p className="heroSubtitle">{siteConfig.tagline}</p>
          <div className="heroButtons">
            <Link className="button button--primary button--lg" to="/docs/intro">
              Get Started →
            </Link>
            <Link className="button button--outline button--lg" to="/docs/mcp-tools">
              MCP Tools
            </Link>
          </div>
          <div className="heroInstall">
            <code>npm i -g @proofofwork-agency/reporecall</code>
          </div>
        </div>
      </header>
      <main>
        <section className="featuresSection">
          <div className="container">
            <div className="row">
              {features.map((f, i) => (
                <div className="col col--4" key={i}>
                  <div className="featureCard">
                    <h3>{f.title}</h3>
                    <p>{f.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
