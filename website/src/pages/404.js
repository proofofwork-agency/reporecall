import React from 'react';
import Link from '@docusaurus/Link';
import Layout from '@theme/Layout';
import SearchBar from '@theme/SearchBar';

const DESTINATIONS = [
  {
    to: '/docs/intro',
    label: 'Introduction',
    detail: 'See what Reporecall injects and how the Trust Contract works.',
  },
  {
    to: '/docs/installation',
    label: 'Installation',
    detail: 'Install the CLI, initialize a project, and connect your agent.',
  },
  {
    to: '/docs/cli-reference',
    label: 'CLI reference',
    detail: 'Find every command, option, and operational workflow.',
  },
];

export default function NotFound() {
  return (
    <Layout
      title="Page not found"
      description="Search the Reporecall documentation or return to a known route."
    >
      <main className="rrNotFound">
        <div className="container rrNotFoundInner">
          <span className="rrEyebrow">404 · route not indexed</span>
          <h1 className="rrNotFoundTitle">This path returned no evidence.</h1>
          <p className="rrNotFoundLead">
            Search the local documentation index, or continue from one of the
            known entry points below.
          </p>

          <div className="rrNotFoundSearch" aria-label="Search documentation">
            <SearchBar />
          </div>

          <div className="rrNotFoundGrid">
            {DESTINATIONS.map((destination) => (
              <Link className="rrNotFoundCard" to={destination.to} key={destination.to}>
                <span>{destination.label}</span>
                <small>{destination.detail}</small>
                <strong aria-hidden="true">→</strong>
              </Link>
            ))}
          </div>
        </div>
      </main>
    </Layout>
  );
}
