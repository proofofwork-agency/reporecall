export function clientScript(dataJSON: string): string {
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

function renderBusinessPages() {
  var container = document.getElementById('business-list');
  if (!container) return;
  if (!DATA.businessPages.length) {
    var empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No business capability pages generated for this index.';
    container.appendChild(empty);
    return;
  }
  DATA.businessPages.forEach(function(page) {
    var card = document.createElement('div');
    card.className = 'card business-card';
    card.dataset.searchable = [
      page.capability,
      page.displayName,
      page.summary,
      page.displaySummary,
      page.actor,
      page.trigger,
      page.businessOutcome,
      page.businessTerms.join(' '),
      page.userActions.join(' '),
      page.dataConcepts.join(' '),
      page.externalSystems.join(' '),
      page.supportingFiles.join(' ')
    ].join(' ');

    var header = document.createElement('div');
    header.className = 'card-header';
    var titleDiv = document.createElement('div');
    titleDiv.className = 'card-title';
    var h3 = document.createElement('h3');
    h3.textContent = page.displayName || page.capability || page.name;
    titleDiv.appendChild(h3);
    var confidence = document.createElement('span');
    confidence.className = 'badge';
    confidence.textContent = (page.confidenceLabel || 'unknown') + ' confidence';
    titleDiv.appendChild(confidence);
    var filesBadge = document.createElement('span');
    filesBadge.className = 'badge';
    filesBadge.textContent = page.supportingFiles.length + ' files';
    titleDiv.appendChild(filesBadge);
    var wikiBadge = document.createElement('span');
    wikiBadge.className = 'badge badge-wiki';
    wikiBadge.style.cursor = 'pointer';
    wikiBadge.textContent = 'wiki';
    wikiBadge.addEventListener('click', function(e) {
      e.stopPropagation();
      showWikiPage(page.name);
    });
    titleDiv.appendChild(wikiBadge);
    header.appendChild(titleDiv);
    var icon = document.createElement('span');
    icon.className = 'expand-icon';
    icon.textContent = '\\u25B8';
    header.appendChild(icon);
    header.addEventListener('click', function() { toggleCard(card); });
    card.appendChild(header);

    var body = document.createElement('div');
    body.className = 'card-body collapsed';
    var summary = document.createElement('p');
    summary.className = 'business-summary';
    summary.textContent = page.displaySummary || page.summary || page.description;
    body.appendChild(summary);
    body.appendChild(buildBusinessField('Actor', page.actor));
    body.appendChild(buildBusinessField('Trigger', page.trigger));
    body.appendChild(buildBusinessField('Outcome', page.businessOutcome));
    body.appendChild(buildBusinessList('User Actions', page.userActions));
    body.appendChild(buildBusinessList('Decision Points', page.decisionPoints));
    body.appendChild(buildBusinessTags('Business Terms', page.businessTerms));
    body.appendChild(buildBusinessTags('Data Concepts', page.dataConcepts));
    body.appendChild(buildBusinessTags('External Systems', page.externalSystems));
    body.appendChild(buildBusinessFiles(page.supportingFiles));
    card.appendChild(body);
    container.appendChild(card);
  });
}

function renderProductAreas() {
  var container = document.getElementById('product-areas-list');
  if (!container) return;
  if (!DATA.productAreas.length) {
    var empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No product areas generated for this index.';
    container.appendChild(empty);
    return;
  }
  DATA.productAreas.forEach(function(area) {
    var card = document.createElement('div');
    card.className = 'card product-area-card';
    card.dataset.searchable = [
      area.name,
      area.displayName,
      area.summary,
      area.displaySummary,
      area.businessTerms.join(' '),
      area.capabilities.join(' '),
      area.businessPages.join(' '),
      area.supportingFiles.join(' ')
    ].join(' ');

    var header = document.createElement('div');
    header.className = 'card-header';
    var titleDiv = document.createElement('div');
    titleDiv.className = 'card-title';
    var h3 = document.createElement('h3');
    h3.textContent = area.displayName || area.name;
    titleDiv.appendChild(h3);
    var confidence = document.createElement('span');
    confidence.className = 'badge';
    confidence.textContent = area.confidenceLabel + ' confidence';
    titleDiv.appendChild(confidence);
    var kind = document.createElement('span');
    kind.className = 'badge';
    kind.textContent = (area.areaKind || 'fixed') + ' area';
    titleDiv.appendChild(kind);
    var pages = document.createElement('span');
    pages.className = 'badge';
    pages.textContent = area.businessPages.length + ' pages';
    titleDiv.appendChild(pages);
    header.appendChild(titleDiv);
    var icon = document.createElement('span');
    icon.className = 'expand-icon';
    icon.textContent = '\\u25B8';
    header.appendChild(icon);
    header.addEventListener('click', function() { toggleCard(card); });
    card.appendChild(header);

    var body = document.createElement('div');
    body.className = 'card-body collapsed';
    var summary = document.createElement('p');
    summary.className = 'business-summary';
    summary.textContent = area.displaySummary || area.summary;
    body.appendChild(summary);
    body.appendChild(buildBusinessTags('Business Terms', area.businessTerms));
    body.appendChild(buildBusinessList('Capabilities', area.capabilities));
    body.appendChild(buildProductAreaPages(area.businessPages));
    body.appendChild(buildBusinessFiles(area.supportingFiles));
    card.appendChild(body);
    container.appendChild(card);
  });
}

function buildProductAreaPages(pages) {
  var section = document.createElement('div');
  section.className = 'business-section';
  var h = document.createElement('h4');
  h.textContent = 'Business Pages';
  section.appendChild(h);
  if (!pages.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'None found';
    section.appendChild(p);
    return section;
  }
  pages.forEach(function(pageName) {
    var tag = document.createElement('span');
    tag.className = 'badge badge-wiki';
    tag.style.cursor = 'pointer';
    tag.textContent = pageName;
    tag.addEventListener('click', function() { showWikiPage(pageName); });
    section.appendChild(tag);
    section.appendChild(document.createTextNode(' '));
  });
  return section;
}

function buildBusinessField(label, value) {
  var section = document.createElement('div');
  section.className = 'business-section';
  var h = document.createElement('h4');
  h.textContent = label;
  section.appendChild(h);
  var p = document.createElement('p');
  p.textContent = value || 'None found';
  section.appendChild(p);
  return section;
}

function buildBusinessList(label, items) {
  var section = document.createElement('div');
  section.className = 'business-section';
  var h = document.createElement('h4');
  h.textContent = label;
  section.appendChild(h);
  if (!items.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'None found';
    section.appendChild(p);
    return section;
  }
  var ul = document.createElement('ul');
  ul.className = 'business-list';
  items.forEach(function(item) {
    var li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  });
  section.appendChild(ul);
  return section;
}

function buildBusinessTags(label, items) {
  var section = document.createElement('div');
  section.className = 'business-section';
  var h = document.createElement('h4');
  h.textContent = label;
  section.appendChild(h);
  if (!items.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'None found';
    section.appendChild(p);
    return section;
  }
  items.forEach(function(item) {
    var tag = document.createElement('span');
    tag.className = 'reason-tag';
    tag.textContent = item;
    section.appendChild(tag);
    section.appendChild(document.createTextNode(' '));
  });
  return section;
}

function buildBusinessFiles(files) {
  var section = document.createElement('div');
  section.className = 'business-section';
  var h = document.createElement('h4');
  h.textContent = 'Supporting Files';
  section.appendChild(h);
  if (!files.length) {
    var p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'None found';
    section.appendChild(p);
    return section;
  }
  var ul = document.createElement('ul');
  ul.className = 'call-list';
  files.slice(0, 12).forEach(function(file) {
    var li = document.createElement('li');
    var code = document.createElement('code');
    code.textContent = file;
    li.appendChild(code);
    ul.appendChild(li);
  });
  if (files.length > 12) {
    var more = document.createElement('li');
    more.className = 'muted';
    more.textContent = '...and ' + (files.length - 12) + ' more';
    ul.appendChild(more);
  }
  section.appendChild(ul);
  return section;
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

renderChord(); renderTopHubs(); renderTopSurprises(); renderCommunities(); renderHubs(); renderSurprises(); renderWikiNav(); renderProductAreas(); renderBusinessPages();
</script>`;
}
