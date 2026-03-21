#!/usr/bin/env node
/**
 * Benchmark: Reporecall hook context vs raw Grep/Read fallback
 *
 * Compares:
 * - Speed (ms)
 * - Token count (proxy for cost)
 * - Coverage (how many relevant symbols found)
 *
 * Assumes daemon is running on localhost:37222
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PORT = 37222;
const PROJECT = process.cwd();
const TOKEN = (() => {
  try { return readFileSync(resolve(PROJECT, '.memory/daemon.token'), 'utf-8').trim(); }
  catch { return ''; }
})();

// Approximate token count (4 chars per token)
function countTokens(text) {
  return Math.ceil(text.length / 4);
}

// Cost model: based on Claude Sonnet input pricing ($3/MTok)
function costUSD(tokens) {
  return (tokens / 1_000_000) * 3;
}

// ── Reporecall hook query ──────────────────────────────────────
async function queryReporecall(query) {
  const start = performance.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/hooks/prompt-context`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const elapsed = performance.now() - start;
  const data = await res.json();
  const context = data?.hookSpecificOutput?.additionalContext ?? '';
  return {
    method: 'Reporecall',
    query,
    elapsed: Math.round(elapsed),
    tokens: countTokens(context),
    textLength: context.length,
    context,
  };
}

// ── Grep-based search (simulating what Claude/Explore would do) ──
// This simulates 1 round of what an Explore agent or Claude would do:
// extract terms, grep for files, read matching lines.
// Real Explore does 3-8 rounds with LLM refinement between each.
function queryGrep(query) {
  const stopWords = new Set(['what', 'does', 'work', 'this', 'that', 'with', 'from',
    'have', 'been', 'will', 'when', 'where', 'which', 'their', 'about', 'would',
    'could', 'should', 'there', 'these', 'those', 'into', 'than', 'then', 'them',
    'some', 'more', 'most', 'also', 'each', 'make', 'like', 'over', 'such', 'take',
    'only', 'come', 'made', 'after', 'year', 'many', 'much', 'very', 'your', 'just',
    'know', 'find', 'explain', 'build', 'handle', 'call']);

  // Extract search terms: keep camelCase identifiers, split natural language
  const terms = query
    .replace(/[?.,!]/g, '')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !stopWords.has(t.toLowerCase()))
    // Prioritize camelCase/PascalCase identifiers (likely function names)
    .sort((a, b) => {
      const aIsCamel = /[a-z][A-Z]/.test(a) ? -1 : 0;
      const bIsCamel = /[a-z][A-Z]/.test(b) ? -1 : 0;
      return aIsCamel - bIsCamel;
    });

  const start = performance.now();
  let totalContext = '';
  let filesSearched = 0;

  for (const term of terms.slice(0, 3)) {
    try {
      // Step 1: grep for files containing the term (safe: no shell interpolation)
      const grepResult = execFileSync('grep', ['-rl', '--include=*.ts', '--include=*.js', term, 'src/'], {
        cwd: PROJECT, timeout: 5000, encoding: 'utf-8'
      }).trim();

      if (!grepResult) continue;
      const files = grepResult.split('\n').slice(0, 5);

      for (const file of files) {
        // Step 2: read matching lines with context (simulating Read tool)
        try {
          const content = execFileSync('grep', ['-n', '-C', '5', '-m', '20', term, file], {
            cwd: PROJECT, timeout: 5000, encoding: 'utf-8'
          }).trim();
          if (content) {
            totalContext += `\n// --- ${file} ---\n${content}\n`;
            filesSearched++;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const elapsed = performance.now() - start;

  return {
    method: 'Grep (simulated Explore)',
    query,
    elapsed: Math.round(elapsed),
    tokens: countTokens(totalContext),
    textLength: totalContext.length,
    filesSearched,
    context: totalContext,
  };
}

// ── Test queries ───────────────────────────────────────────────
const QUERIES = [
  // R1-style (specific function/flow)
  'how does deriveRoute work?',
  'explain the scoreFTSCandidate function',
  'what does handlePromptContext do?',
  'how does assembleFlowContext build the context?',

  // R2-style (broad/architectural)
  'explain the search routing architecture',
  'how does the MCP server handle tool calls?',
  'what is the indexing pipeline?',

  // R0-style (simple lookup)
  'what is MemoryConfig?',
  'find the buildStackTree function',

  // Edge cases
  'how does authentication work in the daemon?',
];

// ── Run benchmark ──────────────────────────────────────────────
console.log('='.repeat(80));
console.log('  BENCHMARK: Reporecall Hooks vs Raw Grep/Explore');
console.log('  Project:', PROJECT);
console.log('  Queries:', QUERIES.length);
console.log('='.repeat(80));
console.log();

const results = [];

for (const query of QUERIES) {
  process.stdout.write(`  "${query}"... `);

  const reporecall = await queryReporecall(query);
  const grep = queryGrep(query);

  results.push({ query, reporecall, grep });
  console.log(`done (RR: ${reporecall.elapsed}ms/${reporecall.tokens}tok, Grep: ${grep.elapsed}ms/${grep.tokens}tok)`);
}

console.log();
console.log('='.repeat(80));
console.log('  RESULTS');
console.log('='.repeat(80));
console.log();

// Summary table
const header = [
  'Query'.padEnd(45),
  'RR ms'.padStart(7),
  'RR tok'.padStart(8),
  'Grep ms'.padStart(8),
  'Grep tok'.padStart(9),
  'Speedup'.padStart(8),
  'Tok save'.padStart(9),
].join(' | ');
console.log(header);
console.log('-'.repeat(header.length));

let totalRRTime = 0, totalGrepTime = 0;
let totalRRTokens = 0, totalGrepTokens = 0;

for (const { query, reporecall, grep } of results) {
  totalRRTime += reporecall.elapsed;
  totalGrepTime += grep.elapsed;
  totalRRTokens += reporecall.tokens;
  totalGrepTokens += grep.tokens;

  const speedup = grep.elapsed > 0 ? `${(grep.elapsed / reporecall.elapsed).toFixed(1)}x` : 'N/A';
  const tokSave = grep.tokens > 0 ? `${((1 - reporecall.tokens / grep.tokens) * 100).toFixed(0)}%` : 'N/A';

  console.log([
    query.slice(0, 45).padEnd(45),
    `${reporecall.elapsed}`.padStart(7),
    `${reporecall.tokens}`.padStart(8),
    `${grep.elapsed}`.padStart(8),
    `${grep.tokens}`.padStart(9),
    speedup.padStart(8),
    tokSave.padStart(9),
  ].join(' | '));
}

console.log('-'.repeat(header.length));

// Totals
const avgSpeedup = totalGrepTime > 0 ? (totalGrepTime / totalRRTime).toFixed(1) : '?';
const avgTokenSave = totalGrepTokens > 0 ? ((1 - totalRRTokens / totalGrepTokens) * 100).toFixed(1) : '?';

console.log([
  'TOTAL'.padEnd(45),
  `${totalRRTime}`.padStart(7),
  `${totalRRTokens}`.padStart(8),
  `${totalGrepTime}`.padStart(8),
  `${totalGrepTokens}`.padStart(9),
  `${avgSpeedup}x`.padStart(8),
  `${avgTokenSave}%`.padStart(9),
].join(' | '));

console.log();
console.log('='.repeat(80));
console.log('  COST COMPARISON (Claude Sonnet @ $3/MTok input)');
console.log('='.repeat(80));
console.log();

const rrCostTotal = costUSD(totalRRTokens);
const grepCostTotal = costUSD(totalGrepTokens);
const perQueryRR = costUSD(totalRRTokens / QUERIES.length);
const perQueryGrep = costUSD(totalGrepTokens / QUERIES.length);

console.log(`  Reporecall:   $${rrCostTotal.toFixed(6)} total | $${perQueryRR.toFixed(6)}/query | ${totalRRTokens} tokens`);
console.log(`  Grep/Explore: $${grepCostTotal.toFixed(6)} total | $${perQueryGrep.toFixed(6)}/query | ${totalGrepTokens} tokens`);
console.log(`  Savings:      ${avgTokenSave}% fewer tokens | ${avgSpeedup}x faster`);
console.log();

// Note about Explore overhead
console.log('  NOTE: Real Explore agent overhead is HIGHER than this benchmark shows.');
console.log('  Explore spawns a Haiku subprocess that does 3-8 rounds of Grep/Read,');
console.log('  each round adding latency + model inference cost. This benchmark only');
console.log('  simulates the raw grep portion, not the LLM-in-the-loop overhead.');
console.log();

// Coverage comparison
console.log('='.repeat(80));
console.log('  COVERAGE QUALITY');
console.log('='.repeat(80));
console.log();

for (const { query, reporecall, grep } of results) {
  // Count unique file paths mentioned
  const rrFiles = new Set((reporecall.context.match(/[a-zA-Z0-9/_-]+\.(ts|js)/g) || []).map(f => f.replace(/^.*?src\//, 'src/')));
  const grepFiles = new Set((grep.context.match(/[a-zA-Z0-9/_-]+\.(ts|js)/g) || []).map(f => f.replace(/^.*?src\//, 'src/')));

  // Count function/class names
  const rrSymbols = new Set((reporecall.context.match(/(?:function|class|const|export)\s+(\w+)/g) || []));
  const grepSymbols = new Set((grep.context.match(/(?:function|class|const|export)\s+(\w+)/g) || []));

  const winner = reporecall.tokens < grep.tokens && rrSymbols.size >= grepSymbols.size
    ? 'Reporecall (less tokens, same+ coverage)'
    : reporecall.tokens < grep.tokens
      ? 'Reporecall (less tokens)'
      : rrSymbols.size > grepSymbols.size
        ? 'Reporecall (better coverage)'
        : 'Grep (more raw data)';

  console.log(`  Q: "${query}"`);
  console.log(`     RR:   ${rrFiles.size} files, ${rrSymbols.size} symbols, ${reporecall.tokens} tokens`);
  console.log(`     Grep: ${grepFiles.size} files, ${grepSymbols.size} symbols, ${grep.tokens} tokens`);
  console.log(`     Winner: ${winner}`);
  console.log();
}
