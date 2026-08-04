export function styles(): string {
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
.business-card .card-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; }
.business-card .card-body.collapsed { display: none; }
.product-area-card .card-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; }
.product-area-card .card-body.collapsed { display: none; }
@media (max-width: 800px) { .business-card .card-body { grid-template-columns: 1fr; } }
@media (max-width: 800px) { .product-area-card .card-body { grid-template-columns: 1fr; } }
.business-summary { grid-column: 1 / -1; color: #ccc; font-size: 13px; line-height: 1.6; padding-bottom: 4px; border-bottom: 1px solid #2a2a4e; }
.business-section h4 { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
.business-section p { font-size: 13px; color: #ccc; line-height: 1.5; }
.business-list { padding-left: 18px; font-size: 13px; color: #ccc; line-height: 1.5; }
.muted { color: #666; font-style: italic; }
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
.graph-warning { border-left-color: #EDC948; }
.badge-inline { display: inline-block; padding: 1px 6px; border: 1px solid #3a3a5e; border-radius: 3px; font-size: 10px; vertical-align: middle; }
.badge-wiki-inline { background: #1a2a3e; border-color: #3a5a7e; color: #7ab8e0; }
.empty-state { color: #555; font-style: italic; text-align: center; padding: 32px; }
.count { color: #666; font-weight: 400; }
</style>`;
}
