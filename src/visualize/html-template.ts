/**
 * Generates a self-contained HTML dashboard for the Reporecall Lens.
 * Embeds D3.js from CDN, all data inlined as JSON, dark theme.
 *
 * Security note: All data originates from local SQLite stores (not user web input).
 * String values are escaped via esc() before DOM insertion. This file is opened
 * locally in a browser, not served to external users.
 */

import type { DashboardData } from "./types.js";

export function generateHTML(data: DashboardData): string {
  const dataJSON = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporecall Lens — ${escTpl(data.meta.projectName)}</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
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
  </nav>

  <main>
    <section id="tab-overview" class="tab-content active">
      <div class="legend-box">
        <strong>Overview</strong> — Bird's-eye view of your codebase structure. <strong>Symbols</strong> = functions, classes, and methods extracted from your code via AST parsing. <strong>Communities</strong> = clusters of tightly-coupled symbols detected by Louvain algorithm on the call graph. <strong>Call Edges</strong> = static function calls found in source. <strong>Hub Nodes</strong> = the most-connected symbols (changing these has the widest impact). <strong>Surprises</strong> = unexpected connections between distant modules. <strong>Wiki Pages</strong> = auto-generated documentation from the topology.
      </div>
      <div class="stats-row">
        <div class="stat-card"><div class="stat-value">${data.meta.totalSymbols}</div><div class="stat-label">Symbols</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.totalFiles}</div><div class="stat-label">Files</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.communityCount}</div><div class="stat-label">Communities</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.totalEdges}</div><div class="stat-label">Call Edges</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.hubCount}</div><div class="stat-label">Hub Nodes</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.surpriseCount}</div><div class="stat-label">Surprises</div></div>
        <div class="stat-card"><div class="stat-value">${data.meta.wikiPageCount}</div><div class="stat-label">Wiki Pages</div></div>
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
  </main>
</div>

${clientScript(dataJSON)}
</body>
</html>`;
}

function escTpl(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clientScript(dataJSON: string): string {
  return `<script>
var DATA = ${dataJSON};

function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.textContent;
}

document.querySelectorAll('.tab').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(s) { s.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach(function(s) {
    s.classList.toggle('active', s.id === 'tab-' + tabName);
  });
}

document.getElementById('global-search').addEventListener('input', function() {
  var q = this.value.toLowerCase().trim();
  var activeTab = document.querySelector('.tab-content.active');
  if (!activeTab) return;
  activeTab.querySelectorAll('[data-searchable]').forEach(function(el) {
    el.style.display = !q || el.dataset.searchable.toLowerCase().includes(q) ? '' : 'none';
  });
});

function renderChord() {
  var matrix = DATA.chordMatrix;
  var labels = DATA.chordLabels;
  var colors = DATA.chordColors;
  if (!matrix.length || matrix.every(function(row) { return row.every(function(v) { return v === 0; }); })) {
    document.getElementById('chord-container').textContent = 'No cross-community connections detected.';
    return;
  }
  var width = 500, height = 500;
  var outerRadius = Math.min(width, height) * 0.42;
  var innerRadius = outerRadius - 24;
  var svg = d3.select('#chord-container').append('svg')
    .attr('viewBox', [-width/2, -height/2, width, height].join(' '))
    .attr('width', '100%').attr('style', 'max-width:500px;margin:0 auto;display:block');
  var chordLayout = d3.chord().padAngle(0.05).sortSubgroups(d3.descending);
  var chords = chordLayout(matrix);
  var arc = d3.arc().innerRadius(innerRadius).outerRadius(outerRadius);
  var ribbon = d3.ribbon().radius(innerRadius - 1);
  var group = svg.append('g').selectAll('g').data(chords.groups).join('g');
  group.append('path').attr('d', arc)
    .attr('fill', function(d) { return colors[d.index]; })
    .attr('stroke', '#1a1a2e').attr('stroke-width', 1.5)
    .style('cursor', 'pointer')
    .on('click', function(e, d) {
      switchTab('communities');
      setTimeout(function() {
        var cid = DATA.communities[d.index] ? DATA.communities[d.index].id : '';
        var card = document.querySelector('[data-community-id="' + cid + '"]');
        if (card) { card.scrollIntoView({behavior:'smooth'}); toggleCard(card); }
      }, 100);
    }).append('title').text(function(d) {
      return labels[d.index] + ' (' + (DATA.communities[d.index] ? DATA.communities[d.index].nodeCount : 0) + ' nodes)';
    });
  group.append('text')
    .each(function(d) { d.angle = (d.startAngle + d.endAngle) / 2; })
    .attr('dy', '0.35em')
    .attr('transform', function(d) {
      return 'rotate(' + (d.angle * 180 / Math.PI - 90) + ')translate(' + (outerRadius + 8) + ')' + (d.angle > Math.PI ? 'rotate(180)' : '');
    })
    .attr('text-anchor', function(d) { return d.angle > Math.PI ? 'end' : 'start'; })
    .attr('fill', '#ccc').attr('font-size', '11px')
    .text(function(d) { var l = labels[d.index] || ''; return l.length > 20 ? l.slice(0,20) + '\\u2026' : l; });
  svg.append('g').attr('fill-opacity', 0.6).selectAll('path').data(chords).join('path')
    .attr('d', ribbon).attr('fill', function(d) { return colors[d.source.index]; })
    .attr('stroke', '#1a1a2e').attr('stroke-width', 0.5)
    .append('title').text(function(d) {
      return labels[d.source.index] + ' \\u2192 ' + labels[d.target.index] + ': ' + d.source.value + ' calls';
    });
}

function renderTopHubs() {
  var container = document.getElementById('top-hubs-list');
  DATA.hubs.slice(0, 8).forEach(function(h, i) {
    var el = document.createElement('div');
    el.className = 'top-item'; el.style.cursor = 'pointer';
    var rank = document.createElement('span'); rank.className = 'top-rank'; rank.textContent = String(i + 1); el.appendChild(rank);
    var dot = document.createElement('span'); dot.className = 'top-dot'; dot.style.background = h.communityColor; el.appendChild(dot);
    var name = document.createElement('span'); name.className = 'top-name'; name.textContent = h.name; el.appendChild(name);
    var metric = document.createElement('span'); metric.className = 'top-metric'; metric.textContent = h.degree + ' edges'; el.appendChild(metric);
    el.addEventListener('click', function() {
      switchTab('hubs');
      setTimeout(function() {
        var card = document.querySelector('[data-hub-name="' + h.name + '"]');
        if (card) { card.scrollIntoView({behavior:'smooth'}); toggleCard(card); }
      }, 100);
    });
    container.appendChild(el);
  });
}

function renderTopSurprises() {
  var container = document.getElementById('top-surprises-list');
  DATA.surprises.slice(0, 5).forEach(function(s) {
    var el = document.createElement('div');
    el.className = 'top-item'; el.style.cursor = 'pointer';
    var score = document.createElement('span');
    score.className = 'surprise-score score-' + (s.score >= 6 ? 'high' : s.score >= 4 ? 'med' : 'low');
    score.textContent = String(s.score); el.appendChild(score);
    var name = document.createElement('span'); name.className = 'top-name';
    name.textContent = s.sourceName + ' \\u2192 ' + s.targetName; el.appendChild(name);
    el.addEventListener('click', function() { switchTab('surprises'); });
    container.appendChild(el);
  });
}

function renderCommunities() {
  var container = document.getElementById('communities-list');
  DATA.communities.forEach(function(c) {
    var card = document.createElement('div');
    card.className = 'card'; card.dataset.communityId = c.id;
    card.dataset.searchable = c.label + ' ' + c.members.map(function(m) { return m.name; }).join(' ');
    var header = document.createElement('div'); header.className = 'card-header';
    var titleDiv = document.createElement('div'); titleDiv.className = 'card-title';
    var dot = document.createElement('span'); dot.className = 'color-dot'; dot.style.background = c.color; titleDiv.appendChild(dot);
    var h3 = document.createElement('h3'); h3.textContent = c.label; titleDiv.appendChild(h3);
    var nb = document.createElement('span'); nb.className = 'badge'; nb.textContent = c.nodeCount + ' nodes'; titleDiv.appendChild(nb);
    var cb = document.createElement('span'); cb.className = 'badge'; cb.textContent = 'cohesion ' + c.cohesion.toFixed(2); titleDiv.appendChild(cb);
    if (c.wikiSlug) {
      var wb = document.createElement('span'); wb.className = 'badge badge-wiki'; wb.textContent = 'wiki'; wb.style.cursor = 'pointer';
      wb.addEventListener('click', function(e) { e.stopPropagation(); showWikiPage(c.wikiSlug); }); titleDiv.appendChild(wb);
    }
    header.appendChild(titleDiv);
    var icon = document.createElement('span'); icon.className = 'expand-icon'; icon.textContent = '\\u25B8'; header.appendChild(icon);
    header.addEventListener('click', function() { toggleCard(card); }); card.appendChild(header);
    var body = document.createElement('div'); body.className = 'card-body collapsed';
    if (c.crossEdges.length > 0) {
      var crossDiv = document.createElement('div'); crossDiv.className = 'cross-edges';
      var ct = document.createElement('h4'); ct.textContent = 'Cross-Community Connections'; crossDiv.appendChild(ct);
      var maxCount = Math.max.apply(null, c.crossEdges.map(function(e) { return e.count; }));
      c.crossEdges.slice(0, 8).forEach(function(e) {
        var pct = Math.max(8, (e.count / maxCount) * 100);
        var tc = DATA.communities.find(function(x) { return x.id === e.targetCommunityId; });
        var color = tc ? tc.color : '#555';
        var row = document.createElement('div'); row.className = 'bar-row';
        var lbl = document.createElement('span'); lbl.className = 'bar-label'; lbl.textContent = e.targetLabel; row.appendChild(lbl);
        var track = document.createElement('div'); track.className = 'bar-track';
        var fill = document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = pct + '%'; fill.style.background = color;
        track.appendChild(fill); row.appendChild(track);
        var val = document.createElement('span'); val.className = 'bar-value'; val.textContent = String(e.count); row.appendChild(val);
        crossDiv.appendChild(row);
      });
      body.appendChild(crossDiv);
    }
    var table = document.createElement('table'); table.className = 'data-table member-table';
    var thead = document.createElement('thead'); thead.appendChild(createRow(['Symbol', 'Kind', 'File', 'Degree'], 'th')); table.appendChild(thead);
    var tbody = document.createElement('tbody');
    c.members.slice(0, 50).forEach(function(m) {
      var tr = document.createElement('tr');
      var td1 = document.createElement('td'); var code = document.createElement('code'); code.textContent = m.name; td1.appendChild(code); tr.appendChild(td1);
      var td2 = document.createElement('td'); td2.textContent = m.kind; tr.appendChild(td2);
      var td3 = document.createElement('td'); td3.className = 'file-cell'; td3.textContent = m.filePath; tr.appendChild(td3);
      var td4 = document.createElement('td'); td4.textContent = String(m.degree); tr.appendChild(td4);
      tbody.appendChild(tr);
    });
    if (c.members.length > 50) {
      var mr = document.createElement('tr'); var mtd = document.createElement('td'); mtd.colSpan = 4; mtd.className = 'more-row';
      mtd.textContent = '...and ' + (c.members.length - 50) + ' more'; mr.appendChild(mtd); tbody.appendChild(mr);
    }
    table.appendChild(tbody); body.appendChild(table); card.appendChild(body); container.appendChild(card);
  });
}

function renderHubs() {
  var container = document.getElementById('hubs-list');
  DATA.hubs.forEach(function(h) {
    var card = document.createElement('div'); card.className = 'card'; card.dataset.hubName = h.name;
    card.dataset.searchable = h.name + ' ' + h.filePath + ' ' + (h.communityLabel || '');
    var header = document.createElement('div'); header.className = 'card-header';
    var titleDiv = document.createElement('div'); titleDiv.className = 'card-title';
    var dot = document.createElement('span'); dot.className = 'color-dot'; dot.style.background = h.communityColor; titleDiv.appendChild(dot);
    var h3 = document.createElement('h3'); var nc = document.createElement('code'); nc.textContent = h.name; h3.appendChild(nc); titleDiv.appendChild(h3);
    var db = document.createElement('span'); db.className = 'badge'; db.textContent = h.degree + ' edges'; titleDiv.appendChild(db);
    if (h.communityLabel) {
      var clb = document.createElement('span'); clb.className = 'badge'; clb.style.borderColor = h.communityColor;
      clb.textContent = h.communityLabel; titleDiv.appendChild(clb);
    }
    header.appendChild(titleDiv);
    var icon = document.createElement('span'); icon.className = 'expand-icon'; icon.textContent = '\\u25B8'; header.appendChild(icon);
    header.addEventListener('click', function() { toggleCard(card); }); card.appendChild(header);
    var body = document.createElement('div'); body.className = 'card-body collapsed';
    var fd = document.createElement('div'); fd.className = 'hub-file'; fd.textContent = 'File: ';
    var fc = document.createElement('code'); fc.textContent = h.filePath; fd.appendChild(fc); body.appendChild(fd);
    var cols = document.createElement('div'); cols.className = 'hub-cols';
    cols.appendChild(buildCallList('Callers', h.callers));
    cols.appendChild(buildCallList('Callees', h.callees));
    body.appendChild(cols);
    if (h.wikiMentions.length > 0) {
      var wd = document.createElement('div'); wd.className = 'wiki-mentions';
      var wt = document.createElement('h4'); wt.textContent = 'Wiki Mentions'; wd.appendChild(wt);
      h.wikiMentions.forEach(function(w) {
        var b = document.createElement('span'); b.className = 'badge badge-wiki'; b.style.cursor = 'pointer'; b.textContent = w;
        b.addEventListener('click', function() { showWikiPage(w); }); wd.appendChild(b); wd.appendChild(document.createTextNode(' '));
      });
      body.appendChild(wd);
    }
    card.appendChild(body); container.appendChild(card);
  });
}

function buildCallList(title, items) {
  var col = document.createElement('div'); col.className = 'hub-col';
  var h4 = document.createElement('h4'); h4.textContent = title + ' (' + items.length + ')'; col.appendChild(h4);
  if (items.length === 0) {
    var p = document.createElement('p'); p.className = 'empty-state'; p.textContent = 'None found'; col.appendChild(p);
  } else {
    var ul = document.createElement('ul'); ul.className = 'call-list';
    items.forEach(function(c) {
      var li = document.createElement('li');
      var code = document.createElement('code'); code.textContent = c.name; li.appendChild(code);
      var ref = document.createElement('span'); ref.className = 'file-ref'; ref.textContent = ' ' + c.filePath; li.appendChild(ref);
      ul.appendChild(li);
    });
    col.appendChild(ul);
  }
  return col;
}

function renderSurprises() {
  var tbody = document.getElementById('surprises-body');
  DATA.surprises.forEach(function(s) {
    var tr = document.createElement('tr');
    tr.dataset.searchable = s.sourceName + ' ' + s.targetName + ' ' + s.reasons.join(' ');
    var td0 = document.createElement('td');
    var sb = document.createElement('span'); sb.className = 'surprise-score score-' + (s.score >= 6 ? 'high' : s.score >= 4 ? 'med' : 'low');
    sb.textContent = String(s.score); td0.appendChild(sb); tr.appendChild(td0);
    var td1 = document.createElement('td'); var sc = document.createElement('code'); sc.textContent = s.sourceName; td1.appendChild(sc);
    var sf = document.createElement('div'); sf.className = 'file-ref'; sf.textContent = s.sourceFile; td1.appendChild(sf); tr.appendChild(td1);
    var td2 = document.createElement('td'); td2.className = 'arrow-cell'; td2.textContent = '\\u2192'; tr.appendChild(td2);
    var td3 = document.createElement('td'); var tc = document.createElement('code'); tc.textContent = s.targetName; td3.appendChild(tc);
    var tf = document.createElement('div'); tf.className = 'file-ref'; tf.textContent = s.targetFile; td3.appendChild(tf); tr.appendChild(td3);
    var td4 = document.createElement('td'); td4.className = 'file-cell';
    td4.textContent = shortFile(s.sourceFile) + ' \\u2192 ' + shortFile(s.targetFile); tr.appendChild(td4);
    var td5 = document.createElement('td');
    s.reasons.forEach(function(r) {
      var tag = document.createElement('span'); tag.className = 'reason-tag'; tag.textContent = r;
      td5.appendChild(tag); td5.appendChild(document.createTextNode(' '));
    });
    tr.appendChild(td5); tbody.appendChild(tr);
  });
  document.querySelectorAll('#surprises-table th.sortable').forEach(function(th) {
    th.addEventListener('click', function() {
      var col = th.dataset.col;
      var rows = Array.from(tbody.querySelectorAll('tr'));
      var asc = th.classList.toggle('sort-asc');
      rows.sort(function(a, b) {
        var va, vb;
        if (col === 'score') { va = parseFloat(a.children[0].textContent); vb = parseFloat(b.children[0].textContent); }
        else if (col === 'source') { va = a.children[1].textContent; vb = b.children[1].textContent; }
        else { va = a.children[3].textContent; vb = b.children[3].textContent; }
        return asc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
      });
      rows.forEach(function(r) { tbody.appendChild(r); });
    });
  });
  var qList = document.getElementById('questions-list');
  DATA.questions.forEach(function(q) {
    var el = document.createElement('div'); el.className = 'question-card';
    el.dataset.searchable = q.question + ' ' + q.why;
    var tt = document.createElement('span'); tt.className = 'question-type'; tt.textContent = q.type; el.appendChild(tt);
    var qt = document.createElement('p'); qt.className = 'question-text'; qt.textContent = q.question; el.appendChild(qt);
    var wy = document.createElement('p'); wy.className = 'question-why'; wy.textContent = q.why; el.appendChild(wy);
    qList.appendChild(el);
  });
}

function renderWikiNav() {
  var nav = document.getElementById('wiki-nav');
  var groups = {};
  DATA.wikiPages.forEach(function(p) { if (!groups[p.pageType]) groups[p.pageType] = []; groups[p.pageType].push(p); });
  Object.keys(groups).sort().forEach(function(type) {
    var h = document.createElement('h4'); h.textContent = type; nav.appendChild(h);
    groups[type].forEach(function(p) {
      var item = document.createElement('div'); item.className = 'wiki-nav-item'; item.textContent = p.name;
      item.dataset.searchable = p.name + ' ' + p.description;
      item.addEventListener('click', function() { showWikiPage(p.name); }); nav.appendChild(item);
    });
  });
}

function showWikiPage(name) {
  switchTab('wiki');
  var page = DATA.wikiPages.find(function(p) { return p.name === name; });
  if (!page) return;
  var container = document.getElementById('wiki-page');
  while (container.firstChild) container.removeChild(container.firstChild);
  var h2 = document.createElement('h2'); h2.textContent = page.name; container.appendChild(h2);
  var meta = document.createElement('div'); meta.className = 'wiki-meta';
  var tb = document.createElement('span'); tb.className = 'badge'; tb.textContent = page.pageType; meta.appendChild(tb);
  if (page.confidence) { var cfb = document.createElement('span'); cfb.className = 'badge'; cfb.textContent = 'confidence ' + page.confidence.toFixed(2); meta.appendChild(cfb); }
  container.appendChild(meta);
  var desc = document.createElement('p'); desc.className = 'wiki-desc'; desc.textContent = page.description; container.appendChild(desc);
  var bodyDiv = document.createElement('div'); bodyDiv.className = 'wiki-body';
  renderMarkdownSafe(bodyDiv, page.content); container.appendChild(bodyDiv);
  if (page.relatedSymbols.length > 0) {
    var ss = document.createElement('div'); ss.className = 'wiki-section';
    var st = document.createElement('h3'); st.textContent = 'Related Symbols'; ss.appendChild(st);
    page.relatedSymbols.forEach(function(s) {
      var code = document.createElement('code'); code.className = 'symbol-link'; code.textContent = s;
      ss.appendChild(code); ss.appendChild(document.createTextNode(' '));
    });
    container.appendChild(ss);
  }
  if (page.links.length > 0) container.appendChild(buildWikiLinkSection('Links To', page.links));
  if (page.backlinks.length > 0) container.appendChild(buildWikiLinkSection('Pages That Link Here', page.backlinks));
  document.querySelectorAll('.wiki-nav-item').forEach(function(el) { el.classList.toggle('active', el.textContent === name); });
}

function buildWikiLinkSection(title, links) {
  var section = document.createElement('div'); section.className = 'wiki-section';
  var h3 = document.createElement('h3'); h3.textContent = title; section.appendChild(h3);
  links.forEach(function(l) {
    var b = document.createElement('span'); b.className = 'badge badge-wiki'; b.style.cursor = 'pointer'; b.textContent = l;
    b.addEventListener('click', function() { showWikiPage(l); }); section.appendChild(b); section.appendChild(document.createTextNode(' '));
  });
  return section;
}

function renderMarkdownSafe(container, md) {
  if (!md) return;
  var lines = md.split('\\n'); var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (line.startsWith('### ')) { var h = document.createElement('h4'); h.textContent = line.slice(4); container.appendChild(h); }
    else if (line.startsWith('## ')) { var h = document.createElement('h3'); h.textContent = line.slice(3); container.appendChild(h); }
    else if (line.startsWith('# ')) { var h = document.createElement('h2'); h.textContent = line.slice(2); container.appendChild(h); }
    else if (line.startsWith('- ')) {
      var ul = document.createElement('ul');
      while (i < lines.length && lines[i].startsWith('- ')) {
        var li = document.createElement('li'); renderInline(li, lines[i].slice(2)); ul.appendChild(li); i++;
      }
      container.appendChild(ul); continue;
    } else if (line.trim() !== '') {
      var p = document.createElement('p'); renderInline(p, line); container.appendChild(p);
    }
    i++;
  }
}

function renderInline(el, text) {
  var re = /(\\*\\*[^*]+\\*\\*|\\\`[^\\\`]+\\\`|\\[\\[[^\\]]+\\]\\])/g;
  var lastIdx = 0; var match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) el.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    var token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      var strong = document.createElement('strong'); strong.textContent = token.slice(2, -2); el.appendChild(strong);
    } else if (token.startsWith('\\\`') && token.endsWith('\\\`')) {
      var code = document.createElement('code'); code.textContent = token.slice(1, -1); el.appendChild(code);
    } else if (token.startsWith('[[') && token.endsWith(']]')) {
      var slug = token.slice(2, -2);
      var link = document.createElement('span'); link.className = 'badge badge-wiki'; link.style.cursor = 'pointer'; link.textContent = slug;
      link.addEventListener('click', (function(s) { return function() { showWikiPage(s); }; })(slug)); el.appendChild(link);
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) el.appendChild(document.createTextNode(text.slice(lastIdx)));
}

function toggleCard(card) {
  var body = card.querySelector('.card-body');
  var icon = card.querySelector('.expand-icon');
  var collapsed = body.classList.toggle('collapsed');
  icon.textContent = collapsed ? '\\u25B8' : '\\u25BE';
}

function createRow(cells, tag) {
  var tr = document.createElement('tr');
  cells.forEach(function(text) { var cell = document.createElement(tag || 'td'); cell.textContent = text; tr.appendChild(cell); });
  return tr;
}

function shortFile(f) {
  if (!f) return '';
  var parts = f.split('/');
  return parts.length > 2 ? '\\u2026/' + parts.slice(-2).join('/') : f;
}

renderChord(); renderTopHubs(); renderTopSurprises(); renderCommunities(); renderHubs(); renderSurprises(); renderWikiNav();
<\/script>`;
}

function styles(): string {
  return `<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f0f1a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
#app { max-width: 1400px; margin: 0 auto; padding: 0 24px 48px; }
header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid #2a2a4e; }
.header-left { display: flex; align-items: baseline; gap: 12px; }
header h1 { font-size: 20px; font-weight: 600; color: #fff; }
.project-name { color: #4E79A7; font-size: 14px; }
.header-right { display: flex; align-items: center; gap: 16px; }
.generated { font-size: 11px; color: #555; }
#global-search { background: #1a1a2e; border: 1px solid #2a2a4e; color: #e0e0e0; padding: 6px 12px; border-radius: 6px; font-size: 13px; width: 260px; outline: none; }
#global-search:focus { border-color: #4E79A7; }
#tabs { display: flex; gap: 4px; padding: 16px 0 0; border-bottom: 1px solid #2a2a4e; }
.tab { background: none; border: none; color: #888; padding: 8px 16px; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; transition: all 0.15s; }
.tab:hover { color: #ccc; }
.tab.active { color: #fff; border-bottom-color: #4E79A7; }
.tab-content { display: none; padding: 24px 0; }
.tab-content.active { display: block; }
.stats-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
.stat-card { background: #1a1a2e; border: 1px solid #2a2a4e; border-radius: 8px; padding: 16px 20px; min-width: 120px; text-align: center; }
.stat-value { font-size: 28px; font-weight: 700; color: #fff; }
.stat-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
.overview-grid { display: grid; grid-template-columns: 1fr 340px; gap: 24px; }
@media (max-width: 900px) { .overview-grid { grid-template-columns: 1fr; } }
.overview-panel { background: #1a1a2e; border: 1px solid #2a2a4e; border-radius: 8px; padding: 20px; }
.overview-panel h2 { font-size: 14px; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
.overview-sidebar { display: flex; flex-direction: column; gap: 24px; }
.panel-desc { font-size: 12px; color: #666; margin-bottom: 12px; }
#chord-container { min-height: 300px; }
.top-item { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-radius: 4px; font-size: 13px; }
.top-item:hover { background: #2a2a4e; }
.top-rank { color: #555; font-size: 11px; width: 18px; text-align: right; }
.top-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.top-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top-metric { color: #666; font-size: 11px; }
.surprise-score { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; min-width: 28px; text-align: center; }
.score-high { background: #5c1a1a; color: #ff6b6b; }
.score-med { background: #5c4a1a; color: #f0c040; }
.score-low { background: #1a3a2a; color: #60c080; }
.card { background: #1a1a2e; border: 1px solid #2a2a4e; border-radius: 8px; margin-bottom: 8px; overflow: hidden; }
.card-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; cursor: pointer; }
.card-header:hover { background: #1e1e36; }
.card-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.card-title h3 { font-size: 14px; font-weight: 600; color: #fff; }
.expand-icon { color: #555; font-size: 14px; }
.color-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.card-body { padding: 0 16px 16px; }
.card-body.collapsed { display: none; }
.badge { display: inline-block; padding: 2px 8px; border: 1px solid #3a3a5e; border-radius: 4px; font-size: 11px; color: #aaa; }
.badge-wiki { background: #1a2a3e; border-color: #3a5a7e; color: #7ab8e0; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th { text-align: left; padding: 8px 10px; color: #888; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #2a2a4e; }
.data-table td { padding: 6px 10px; border-bottom: 1px solid #1e1e36; }
.data-table tr:hover td { background: #1e1e36; }
.data-table code { color: #7ab8e0; font-size: 12px; }
.sortable { cursor: pointer; user-select: none; }
.sortable:hover { color: #ccc; }
.sort-asc::after { content: ' \\25B2'; font-size: 9px; }
.file-cell { color: #666; font-size: 11px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-ref { color: #555; font-size: 11px; }
.arrow-cell { color: #555; text-align: center; }
.more-row { text-align: center; color: #555; font-style: italic; }
.reason-tag { display: inline-block; padding: 1px 6px; background: #2a2a4e; border-radius: 3px; font-size: 11px; color: #aaa; margin: 1px; }
.member-table { margin-top: 12px; }
.cross-edges { margin-bottom: 16px; }
.cross-edges h4 { font-size: 12px; color: #888; margin-bottom: 8px; }
.bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.bar-label { font-size: 11px; color: #aaa; width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
.bar-track { flex: 1; height: 14px; background: #0f0f1a; border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; min-width: 4px; transition: width 0.3s; }
.bar-value { font-size: 11px; color: #666; width: 30px; }
.hub-file { font-size: 12px; color: #666; margin-bottom: 12px; }
.hub-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 700px) { .hub-cols { grid-template-columns: 1fr; } }
.hub-col h4 { font-size: 12px; color: #888; margin-bottom: 8px; }
.call-list { list-style: none; font-size: 12px; }
.call-list li { padding: 3px 0; display: flex; align-items: baseline; gap: 6px; }
.call-list code { color: #7ab8e0; }
.wiki-mentions { margin-top: 12px; }
.wiki-mentions h4 { font-size: 12px; color: #888; margin-bottom: 6px; }
.question-card { background: #1a1a2e; border: 1px solid #2a2a4e; border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; }
.question-type { display: inline-block; padding: 2px 8px; background: #2a2a4e; border-radius: 4px; font-size: 10px; text-transform: uppercase; color: #888; margin-bottom: 6px; }
.question-text { font-size: 13px; color: #e0e0e0; margin-bottom: 4px; }
.question-why { font-size: 12px; color: #666; }
.wiki-layout { display: grid; grid-template-columns: 240px 1fr; gap: 0; min-height: 500px; }
@media (max-width: 700px) { .wiki-layout { grid-template-columns: 1fr; } }
.wiki-sidebar { background: #1a1a2e; border: 1px solid #2a2a4e; border-radius: 8px 0 0 8px; padding: 16px; overflow-y: auto; max-height: 80vh; }
.wiki-sidebar h3 { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
.wiki-sidebar h4 { font-size: 11px; color: #666; text-transform: uppercase; margin-top: 12px; margin-bottom: 4px; }
.wiki-nav-item { padding: 4px 8px; border-radius: 4px; font-size: 12px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wiki-nav-item:hover { background: #2a2a4e; }
.wiki-nav-item.active { background: #2a3a5e; color: #7ab8e0; }
.wiki-content { background: #1a1a2e; border: 1px solid #2a2a4e; border-left: none; border-radius: 0 8px 8px 0; padding: 24px; overflow-y: auto; max-height: 80vh; }
.wiki-meta { display: flex; gap: 8px; margin: 8px 0 12px; }
.wiki-desc { font-size: 13px; color: #aaa; margin-bottom: 16px; }
.wiki-body { font-size: 13px; line-height: 1.7; color: #ccc; }
.wiki-body h2 { font-size: 18px; color: #fff; margin: 20px 0 8px; }
.wiki-body h3 { font-size: 15px; color: #eee; margin: 16px 0 6px; }
.wiki-body h4 { font-size: 13px; color: #ddd; margin: 12px 0 4px; }
.wiki-body code { background: #0f0f1a; padding: 1px 5px; border-radius: 3px; font-size: 12px; color: #7ab8e0; }
.wiki-body ul { padding-left: 20px; margin: 4px 0; }
.wiki-body li { margin: 2px 0; }
.wiki-body p { margin: 6px 0; }
.wiki-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid #2a2a4e; }
.wiki-section h3 { font-size: 13px; color: #888; text-transform: uppercase; margin-bottom: 8px; }
.symbol-link { display: inline-block; padding: 2px 6px; margin: 2px; background: #1a2a3e; border-radius: 3px; font-size: 12px; color: #7ab8e0; }
.legend-box { background: #141428; border: 1px solid #2a2a4e; border-left: 3px solid #4E79A7; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; font-size: 12px; line-height: 1.7; color: #999; }
.legend-box strong { color: #ccc; }
.legend-box em { color: #7ab8e0; font-style: normal; }
.badge-inline { display: inline-block; padding: 1px 6px; border: 1px solid #3a3a5e; border-radius: 3px; font-size: 10px; vertical-align: middle; }
.badge-wiki-inline { background: #1a2a3e; border-color: #3a5a7e; color: #7ab8e0; }
.empty-state { color: #555; font-style: italic; text-align: center; padding: 32px; }
.count { color: #666; font-weight: 400; }
</style>`;
}
