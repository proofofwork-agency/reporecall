#!/usr/bin/env node
/**
 * Reporecall smoke test
 *
 * Tests CLI commands and MCP tools end-to-end.
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
import { cpSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';

// ── helpers ──────────────────────────────────────────────────────────────────

const BINARY = 'dist/memory.js';
const PROJECT = '/tmp/rr-smoke-test-project';
const SERVE_PORT = 37299;
let passed = 0;
let failed = 0;

function setupSmokeProject() {
  if (existsSync(PROJECT)) rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  cpSync('src', `${PROJECT}/src`, { recursive: true });
  cpSync('bin', `${PROJECT}/bin`, { recursive: true });
  writeFileSync(`${PROJECT}/package.json`, JSON.stringify({ name: 'reporecall-smoke-project', type: 'module' }, null, 2));
  const init = spawnSync('node', [BINARY, 'init', '--project', PROJECT, '--embedding-provider', 'keyword'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (init.status !== 0) {
    throw new Error(`failed to initialize smoke project: ${init.stderr || init.stdout}`);
  }
}

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

setupSmokeProject();

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

  const r2 = run(['search', 'search_code', '--project', PROJECT, '--budget', '500']);
  if (r2.code !== 0) {
    fail('search --budget', `exit ${r2.code}`);
  } else if (!/src\/|chunks|context/i.test(r2.stdout)) {
    fail('search --budget', 'no context output');
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
    fail('explain (navigational)', `exit ${r1.code}`);
  } else if (!/Query mode:\s+(trace|architecture|lookup|change|bug)/i.test(r1.stdout)) {
    fail('explain (navigational)', 'expected a code query mode, got: ' + r1.stdout.slice(0, 80));
  } else {
    pass('explain (navigational)');
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

// 9. lens JSON ────────────────────────────────────────────────────────────────
{
  const r = run(['lens', '--project', PROJECT, '--json']);
  if (r.code !== 0) {
    fail('lens --json', `exit ${r.code}`);
  } else {
    try {
      const data = JSON.parse(r.stdout);
      if (!data.meta || !Array.isArray(data.wikiPages) || !Array.isArray(data.productAreas) || !Array.isArray(data.businessPages)) {
        fail('lens --json', 'missing expected top-level fields');
      } else {
        pass('lens --json');
      }
    } catch {
      fail('lens --json', 'invalid JSON output');
    }
  }
}

// 10. serve ───────────────────────────────────────────────────────────────────
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

  const exitPromise = new Promise(resolve => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });
  proc.kill('SIGTERM');
  const exitResult = await Promise.race([
    exitPromise,
    new Promise(resolve => setTimeout(() => resolve(null), 12_000)),
  ]);
  if (exitResult?.code === 0) {
    pass('serve graceful shutdown');
  } else {
    if (exitResult === null) proc.kill('SIGKILL');
    fail(
      'serve graceful shutdown',
      exitResult === null
        ? 'process did not exit within 12s'
        : `exit ${exitResult.code ?? `signal ${exitResult.signal}`}`,
    );
  }
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
      setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 30_000);
    });
  }

  // Handshake
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  // v0.8.0 public MCP surface = six tools. The standalone navigation, memory, and
  // business tools were folded into action-based tools (search_code, explain_flow,
  // memory). A JSON-RPC protocol error (unregistered tool or invalid params) always
  // fails; a graceful in-tool "no data" result is acceptable for data-dependent
  // action calls (abortOk), which a fresh keyword-indexed project may legitimately
  // return.
  const tools = [
    // Primary retrieval
    ['search_context',   { query: 'hybrid search retrieval' },                                                   false],
    ['search_code',      { query: 'hybrid search retrieval' },                                                   false],
    ['search_code',      { action: 'read_chunk', filePath: 'src/daemon/intent.ts', startLine: 1, endLine: 20 },  true],
    // Flow navigation (folded into explain_flow actions)
    ['explain_flow',     { query: 'how does intent classifier route queries' },                                  false],
    ['explain_flow',     { action: 'callers', functionName: 'classifyIntent' },                                  true],
    ['explain_flow',     { action: 'callees', functionName: 'classifyIntent' },                                  true],
    ['explain_flow',     { action: 'resolve_seed', query: 'how does intent classifier work' },                   true],
    ['explain_flow',     { action: 'stack_tree', seed: 'classifyIntent', direction: 'both', maxDepth: 2 },       true],
    ['explain_flow',     { action: 'imports', filePath: 'src/daemon/intent.ts' },                                true],
    ['explain_flow',     { action: 'symbol', name: 'classifyIntent' },                                           true],
    // Memory (folded into memory actions)
    ['memory',           { action: 'list' },                                                                     true],
    ['memory',           { action: 'recall', query: 'search indexing workflow' },                                true],
    // Freshness + stats
    ['refresh_context',  { includeStats: true },                                                                 false],
    ['get_stats',        {},                                                                                      false],
  ];

  for (const [tool, args, abortOk] of tools) {
    const name = args.action ? `mcp ${tool} ${args.action}` : `mcp ${tool}`;
    try {
      const res = await call('tools/call', { name: tool, arguments: args });
      if (res.error) {
        // Protocol error: tool not registered or invalid params — always a failure.
        fail(name, JSON.stringify(res.error).slice(0, 140));
      } else if (res.result?.isError && !abortOk) {
        fail(name, (res.result?.content?.[0]?.text || '').slice(0, 140));
      } else {
        pass(name);
      }
    } catch (e) {
      fail(name, e.message);
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

rmSync(PROJECT, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
