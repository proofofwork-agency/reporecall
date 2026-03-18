#!/usr/bin/env node
/**
 * Reporecall smoke test
 *
 * Tests all 10 CLI commands and 11 MCP tools end-to-end.
 * Run from the project root:
 *
 *   node scripts/smoke-test.mjs
 *   npm run smoke
 *
 * Requirements:
 *   - dist/memory.js must exist (run `npm run build` first)
 *   - .memory/ must be initialised (run `node dist/memory.js index` first,
 *     or pass --skip-data-checks to skip commands that need an index)
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, rmSync, mkdirSync } from 'fs';

// ── helpers ──────────────────────────────────────────────────────────────────

const BINARY = 'dist/memory.js';
const PROJECT = '.';
const SERVE_PORT = 37299;
let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`  PASS  ${name}`);
  passed++;
}

function fail(name, reason) {
  console.error(`  FAIL  ${name}${reason ? ` — ${reason}` : ''}`);
  failed++;
}

/** Run a command synchronously, return { code, stdout, stderr }. */
function run(args, { input } = {}) {
  const result = spawnSync('node', [BINARY, ...args], {
    encoding: 'utf8',
    input,
    timeout: 30_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Poll a URL until it returns 200, or reject after `ms`. */
function waitForHttp(url, ms = 8000) {
  return new Promise(async (resolve, reject) => {
    const { default: http } = await import('http');
    const deadline = Date.now() + ms;
    function attempt() {
      const req = http.get(url, res => {
        res.resume();
        if (res.statusCode === 200) { resolve(res.statusCode); }
        else { scheduleRetry(); }
      });
      req.on('error', () => scheduleRetry());
      req.setTimeout(1000, () => { req.destroy(); scheduleRetry(); });
    }
    function scheduleRetry() {
      if (Date.now() > deadline) { reject(new Error(`${url} not ready after ${ms}ms`)); return; }
      setTimeout(attempt, 300);
    }
    attempt();
  });
}

// ── section header ────────────────────────────────────────────────────────────

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length - 4))}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// CLI COMMANDS
// ══════════════════════════════════════════════════════════════════════════════

section('CLI commands');

// 1. init ─────────────────────────────────────────────────────────────────────
{
  const tmpDir = '/tmp/rr-smoke-test-init';
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const r = run(['init', '--project', tmpDir, '--embedding-provider', 'keyword']);
  if (r.code !== 0) {
    fail('init', `exit ${r.code}\n${r.stderr}`);
  } else if (!existsSync(`${tmpDir}/.memory/config.json`)) {
    fail('init', '.memory/config.json not created');
  } else if (!existsSync(`${tmpDir}/.memoryignore`)) {
    fail('init', '.memoryignore not created');
  } else {
    pass('init');
  }

  rmSync(tmpDir, { recursive: true, force: true });
}

// 2. index ────────────────────────────────────────────────────────────────────
{
  const r = run(['index', '--project', PROJECT]);
  if (r.code !== 0) {
    fail('index', `exit ${r.code}`);
  } else if (!/indexed|no changes/i.test(r.stdout)) {
    fail('index', 'no progress output');
  } else {
    pass('index');
  }
}

// 3. search ───────────────────────────────────────────────────────────────────
{
  const r = run(['search', 'hybrid search retrieval', '--project', PROJECT, '--limit', '5']);
  if (r.code !== 0) {
    fail('search (plain)', `exit ${r.code}`);
  } else if (!/\[[\d.]+\]/.test(r.stdout)) {
    fail('search (plain)', 'no results in output');
  } else {
    pass('search (plain)');
  }

  const r2 = run(['search', 'intent classifier routing', '--project', PROJECT, '--budget', '500']);
  if (r2.code !== 0) {
    fail('search --budget', `exit ${r2.code}`);
  } else if (!r2.stdout.includes('chunks')) {
    fail('search --budget', 'no chunk count in output');
  } else {
    pass('search --budget');
  }
}

// 4. stats ────────────────────────────────────────────────────────────────────
{
  const r = run(['stats', '--project', PROJECT]);
  if (r.code !== 0) {
    fail('stats', `exit ${r.code}`);
  } else if (!/chunks/i.test(r.stdout)) {
    fail('stats', 'no chunk info in output');
  } else {
    pass('stats');
  }
}

// 5. graph ────────────────────────────────────────────────────────────────────
{
  const r = run(['graph', 'classifyIntent', '--project', PROJECT, '--both']);
  if (r.code !== 0) {
    fail('graph', `exit ${r.code}`);
  } else if (!/callers|callees|no edges/i.test(r.stdout)) {
    fail('graph', 'unexpected output');
  } else {
    pass('graph');
  }
}

// 6. conventions ──────────────────────────────────────────────────────────────
{
  const r = run(['conventions', '--project', PROJECT]);
  if (r.code !== 0) {
    fail('conventions', `exit ${r.code}`);
  } else if (!/camelCase|PascalCase|snake_case/i.test(r.stdout)) {
    fail('conventions', 'no naming info in output');
  } else {
    pass('conventions');
  }

  const rj = run(['conventions', '--project', PROJECT, '--json']);
  if (rj.code !== 0) {
    fail('conventions --json', `exit ${rj.code}`);
  } else {
    try {
      JSON.parse(rj.stdout);
      pass('conventions --json');
    } catch {
      fail('conventions --json', 'invalid JSON output');
    }
  }
}

// 7. doctor ───────────────────────────────────────────────────────────────────
{
  const r = run(['doctor', '--project', PROJECT]);
  if (r.code !== 0) {
    fail('doctor', `exit ${r.code}`);
  } else if (!/all checks passed|healthy/i.test(r.stdout)) {
    fail('doctor', 'unexpected output: ' + r.stdout.slice(0, 100));
  } else {
    pass('doctor');
  }
}

// 8. explain ──────────────────────────────────────────────────────────────────
{
  const r1 = run(['explain', 'how does the intent classifier work', '--project', PROJECT]);
  if (r1.code !== 0) {
    fail('explain (R1)', `exit ${r1.code}`);
  } else if (!/R1|R2/i.test(r1.stdout)) {
    fail('explain (R1)', 'expected R1 or R2 route, got: ' + r1.stdout.slice(0, 80));
  } else {
    pass('explain (R1/R2 navigational)');
  }

  const rskip = run(['explain', 'hello there', '--project', PROJECT]);
  if (rskip.code !== 0) {
    fail('explain (SKIP)', `exit ${rskip.code}`);
  } else if (!/skip/i.test(rskip.stdout)) {
    fail('explain (SKIP)', 'expected skip route, got: ' + rskip.stdout.slice(0, 80));
  } else {
    pass('explain (SKIP non-code)');
  }

  const rj = run(['explain', 'search hybrid retrieval', '--project', PROJECT, '--json']);
  if (rj.code !== 0) {
    fail('explain --json', `exit ${rj.code}`);
  } else {
    try {
      JSON.parse(rj.stdout);
      pass('explain --json');
    } catch {
      fail('explain --json', 'invalid JSON output');
    }
  }
}

// 9. serve ────────────────────────────────────────────────────────────────────
await (async () => {
  const proc = spawn('node', [BINARY, 'serve', '--project', PROJECT, '--port', String(SERVE_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let serveErr = null;
  proc.on('error', e => { serveErr = e; });

  // wait for HTTP readiness
  try {
    await waitForHttp(`http://127.0.0.1:${SERVE_PORT}/health`, 10_000);
  } catch (e) {
    proc.kill();
    fail('serve /health', e.message + (serveErr ? ` (spawn error: ${serveErr.message})` : ''));
    return;
  }

  // /health
  {
    const { default: http } = await import('http');
    const health = await new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${SERVE_PORT}/health`, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', e => resolve({ status: -1, error: e.message }));
    });
    if (health.status === 200) pass('serve /health');
    else fail('serve /health', `status ${health.status}`);
  }

  // /ready
  {
    const { default: http } = await import('http');
    const ready = await new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${SERVE_PORT}/ready`, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', e => resolve({ status: -1, error: e.message }));
    });
    if (ready.status === 200) pass('serve /ready');
    else fail('serve /ready', `status ${ready.status}`);
  }

  proc.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1000));
})();

// ══════════════════════════════════════════════════════════════════════════════
// MCP — initialize handshake
// ══════════════════════════════════════════════════════════════════════════════

section('MCP server');

await (async () => {
  const result = await new Promise(resolve => {
    const proc = spawn('node', [BINARY, 'mcp', '--project', PROJECT], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    proc.stdout.on('data', d => { buf += d.toString(); });
    proc.on('error', e => resolve({ error: e.message }));

    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' }
    }};
    proc.stdin.write(JSON.stringify(msg) + '\n');

    setTimeout(() => {
      proc.kill();
      resolve({ output: buf });
    }, 3000);
  });

  if (result.error) { fail('mcp initialize', result.error); return; }

  const lines = result.output.split('\n').filter(l => l.trim() && !l.startsWith('MCP'));
  if (lines.length === 0) { fail('mcp initialize', 'no output'); return; }

  try {
    const msg = JSON.parse(lines[0]);
    if (!msg.result?.protocolVersion) { fail('mcp initialize', 'no protocolVersion in result'); return; }
    pass('mcp initialize');
  } catch {
    fail('mcp initialize', 'invalid JSON: ' + lines[0].slice(0, 80));
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// MCP tools (via stdio JSON-RPC)
// ══════════════════════════════════════════════════════════════════════════════

section('MCP tools');

await (async () => {
  const proc = spawn('node', [BINARY, 'mcp', '--project', PROJECT], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let buf = '';
  const pending = new Map();
  let msgId = 1;

  proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim() || line.startsWith('MCP')) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* non-JSON line */ }
    }
  });

  function send(msg) { proc.stdin.write(JSON.stringify(msg) + '\n'); }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 10_000);
    });
  }

  // Handshake
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  const tools = [
    ['search_code',      { query: 'hybrid search retrieval' },                   false],
    ['get_stats',        {},                                                      false],
    ['find_callers',     { functionName: 'classifyIntent' },                     false],
    ['find_callees',     { functionName: 'classifyIntent' },                     false],
    ['resolve_seed',     { query: 'how does intent classifier work' },           false],
    ['build_stack_tree', { seed: 'classifyIntent', direction: 'both', depth: 2 }, false],
    ['get_imports',      { filePath: 'src/daemon/intent.ts' },                  false],
    ['get_symbol',       { name: 'classifyIntent' },                             false],
    ['explain_flow',     { query: 'how does intent classifier route queries' },  false],
    ['index_codebase',   {},                                                      false],
    // clear_index with confirm:false — graceful abort, not a crash
    ['clear_index',      { confirm: false },                                     true /* abortOk */],
  ];

  for (const [tool, args, abortOk] of tools) {
    try {
      const res = await call('tools/call', { name: tool, arguments: args });
      const isErr = res.result?.isError || res.error;
      // abortOk: any response (including an error message) counts as pass
      if (abortOk || !isErr) {
        pass(`mcp ${tool}`);
      } else {
        fail(`mcp ${tool}`, JSON.stringify(res.error || res.result?.content?.[0]?.text?.slice(0, 120)));
      }
    } catch (e) {
      fail(`mcp ${tool}`, e.message);
    }
  }

  proc.stdin.end();
  proc.kill();
})();

// ── summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'═'.repeat(54)}`);
console.log(`  ${passed}/${total} passed${failed > 0 ? `  (${failed} failed)` : '  ✓'}`);
console.log(`${'═'.repeat(54)}`);

process.exit(failed > 0 ? 1 : 0);
