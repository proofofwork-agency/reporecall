/**
 * Generates a self-contained HTML dashboard for the Reporecall Lens.
 * Embeds D3.js from CDN, all data inlined as JSON, dark theme.
 *
 * Security note: All data originates from local SQLite stores (not user web input).
 * String values are escaped via esc() before DOM insertion. This file is opened
 * locally in a browser, not served to external users.
 */

import type { DashboardData } from "./types.js";
import { clientScript } from "./html-client-script.js";
import { styles } from "./html-styles.js";

export function generateHTML(data: DashboardData): string {
  const dataJSON = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");
  const graphNotice = data.meta.graphDetails && !data.meta.graphDetails.included
    ? `<div class="legend-box graph-warning"><strong>Graph details skipped</strong> — Lens skipped graph-heavy chunk and call-edge loading because this index has ${data.meta.graphDetails.totalChunks} symbols and the graph cap is ${data.meta.graphDetails.maxGraphChunks}. Core stats, wiki, and business context remain available.</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporecall Lens — ${escTpl(data.meta.projectName)}</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
${styles()}
</head>
<body>
<div id="app">
  <header>
    <div class="header-left">
      <h1>Reporecall Lens</h1>
      <span class="project-name">${escTpl(data.meta.projectName)}</span>
    </div>
    <div class="header-right">
      <input type="text" id="global-search" placeholder="Search symbols, wiki, files..." autocomplete="off" />
      <span class="generated">${new Date(data.meta.generatedAt).toLocaleString()}</span>
    </div>
  </header>

  <nav id="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="communities">Communities</button>
    <button class="tab" data-tab="hubs">Hubs</button>
    <button class="tab" data-tab="surprises">Surprises</button>
    <button class="tab" data-tab="wiki">Wiki</button>
    <button class="tab" data-tab="product-areas">Product Areas</button>
    <button class="tab" data-tab="business">Business</button>
  </nav>

  <main>
    <section id="tab-overview" class="tab-content active">
      <div class="legend-box">
        <strong>Overview</strong> — Bird's-eye view of your codebase structure. <strong>Symbols</strong> = functions, classes, and methods extracted from your code via AST parsing. <strong>Communities</strong> = clusters of tightly-coupled symbols detected by Louvain algorithm on the call graph. <strong>Call Edges</strong> = static function calls found in source. <strong>Hub Nodes</strong> = the most-connected symbols (changing these has the widest impact). <strong>Surprises</strong> = unexpected connections between distant modules. <strong>Wiki Pages</strong> = auto-generated documentation from the topology.
      </div>
      ${graphNotice}
      <div class="stats-row">
        <div class="stat-card"><div class="stat-value">${data.meta.totalSymbols}</div><div class="stat-label">Symbols</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.totalFiles}</div><div class="stat-label">Files</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.communityCount}</div><div class="stat-label">Communities</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.totalEdges}</div><div class="stat-label">Call Edges</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.hubCount}</div><div class="stat-label">Hub Nodes</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.surpriseCount}</div><div class="stat-label">Surprises</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.wikiPageCount}</div><div class="stat-label">Wiki Pages</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.productAreaCount}</div><div class="stat-label">Product Areas</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.businessPageCount}</div><div class="stat-label">Business Pages</div></div>
      </div>

      <div class="overview-grid">
        <div class="overview-panel">
          <h2>Community Connections</h2>
          <p class="panel-desc">Each colored arc represents a community (cluster of related code). Ribbons connecting arcs show how many function calls cross between communities. Thicker ribbons = more cross-calls. Click an arc to jump to that community's detail page.</p>
          <div id="chord-container"></div>
        </div>
        <div class="overview-panel overview-sidebar">
          <div>
            <h2>Top Hubs</h2>
            <div id="top-hubs-list"></div>
          </div>
          <div>
            <h2>Top Surprises</h2>
            <div id="top-surprises-list"></div>
          </div>
        </div>
      </div>
    </section>

    <section id="tab-communities" class="tab-content">
      <h2>Communities <span class="count">(${data.communities.length})</span></h2>
      <div class="legend-box">
        <strong>What are communities?</strong> Louvain algorithm detects clusters of symbols that call each other more than they call outside code. Each card is one cluster. <strong>Cohesion</strong> = ratio of internal edges to maximum possible (higher = tighter cluster). <strong>Cross-Community Connections</strong> = how many calls go from this community to others (bar chart). <strong>Degree</strong> = number of call edges for a symbol. Click a card to expand its member table.
      </div>
      <div id="communities-list"></div>
    </section>

    <section id="tab-hubs" class="tab-content">
      <h2>Hub Nodes <span class="count">(${data.hubs.length})</span></h2>
      <div class="legend-box">
        <strong>What are hub nodes?</strong> Symbols with the most connections in the call graph — the load-bearing walls of your codebase. Changing a hub affects the most code. <strong>Degree</strong> = total callers + callees. <strong>Callers</strong> = functions that invoke this hub. <strong>Callees</strong> = functions this hub invokes. The <span class="badge-inline badge-wiki-inline">wiki</span> badge links to the auto-generated wiki page for deeper context.
      </div>
      <div id="hubs-list"></div>
    </section>

    <section id="tab-surprises" class="tab-content">
      <h2>Surprising Connections <span class="count">(${data.surprises.length})</span></h2>
      <div class="legend-box">
        <strong>What are surprises?</strong> Call edges that cross architectural boundaries in unexpected ways. <strong>Score</strong> = severity (higher = more surprising): <span class="surprise-score score-high">6+</span> high — crosses major boundaries, <span class="surprise-score score-med">4-5</span> medium — crosses modules, <span class="surprise-score score-low">1-3</span> low — minor. <strong>Reasons</strong> explain why: <em>weakly-resolved</em> = not a direct import, <em>crosses directories</em> = different top-level folders, <em>crosses communities</em> = bridges Louvain clusters, <em>crosses execution surfaces</em> = different architectural layers (e.g. server vs browser). <strong>Suggested Investigations</strong> are auto-generated questions about structural weak spots.
      </div>
      <table id="surprises-table" class="data-table">
        <thead>
          <tr>
            <th class="sortable" data-col="score">Score</th>
            <th class="sortable" data-col="source">Source</th>
            <th></th>
            <th class="sortable" data-col="target">Target</th>
            <th>Files</th>
            <th>Reasons</th>
          </tr>
        </thead>
        <tbody id="surprises-body"></tbody>
      </table>

      <div id="questions-section" style="margin-top:32px">
        <h2>Suggested Investigations <span class="count">(${data.questions.length})</span></h2>
        <div id="questions-list"></div>
      </div>
    </section>

    <section id="tab-wiki" class="tab-content">
      <div class="legend-box">
        <strong>What is the wiki?</strong> Auto-generated knowledge pages from your codebase topology — no manual authoring needed. Page types: <strong>community</strong> = documents a code cluster and its members, <strong>hub</strong> = documents a high-connection symbol, <strong>module</strong> = cross-module surprise connections, <strong>flow</strong>/<strong>exploration</strong> = saved call traces. <strong>Confidence</strong> = how reliably the data was extracted (1.0 = directly from AST). Pages link to each other via [[wikilinks]] and track which symbols and files they relate to.
      </div>
      <div class="wiki-layout">
        <div class="wiki-sidebar">
          <h3>Wiki Pages</h3>
          <div id="wiki-nav"></div>
        </div>
        <div class="wiki-content">
          <div id="wiki-page">
            <p class="empty-state">Select a wiki page from the sidebar.</p>
          </div>
        </div>
      </div>
    </section>

    <section id="tab-product-areas" class="tab-content">
      <h2>Product Areas <span class="count">(${data.productAreas.length})</span></h2>
      <div class="legend-box">
        <strong>What are product areas?</strong> Business-facing groups over generated business pages. They give planning tools and non-code users a higher-level entry point before drilling into capability pages and supporting files.
      </div>
      <div id="product-areas-list"></div>
    </section>

    <section id="tab-business" class="tab-content">
      <h2>Business Capabilities <span class="count">(${data.businessPages.length})</span></h2>
      <div class="legend-box">
        <strong>What are business pages?</strong> Product-facing capability views generated from code evidence. They summarize actors, triggers, decisions, outcomes, data concepts, external systems, and supporting files. They are useful for planning and dashboard tools, but the source code remains the evidence of record.
      </div>
      <div id="business-list"></div>
    </section>
  </main>
</div>

${clientScript(dataJSON)}
</body>
</html>`;
}

function escTpl(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
