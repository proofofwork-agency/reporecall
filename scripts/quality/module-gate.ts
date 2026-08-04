#!/usr/bin/env tsx
import { existsSync, readFileSync } from "fs";
import { dirname, relative, resolve } from "path";
import { globSync } from "glob";

const root = process.cwd();
const facadeLimit = 500;
const moduleLimit = 800;
const facadeFiles = new Set([
  "src/hooks/prompt-context.ts",
  "src/daemon/server.ts",
  "src/indexer/pipeline.ts",
  "src/search/hybrid.ts",
  "src/search/bug-strategy.ts",
  "src/search/architecture-strategy.ts",
]);
const sourceFiles = globSync("src/**/*.ts", { cwd: root, nodir: true }).sort();
const errors: string[] = [];

for (const file of sourceFiles) {
  const lines = nonCommentLines(readFileSync(resolve(root, file), "utf-8"));
  const limit = facadeFiles.has(file) ? facadeLimit : moduleLimit;
  if (lines > limit) errors.push(`${file} has ${lines} non-comment lines (max ${limit})`);
}

const edges = new Map<string, string[]>();
for (const file of sourceFiles) {
  const source = readFileSync(resolve(root, file), "utf-8");
  const dependencies: string[] = [];
  for (const match of source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]+from\s+)?["'](\.[^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier) continue;
    const candidate = resolve(dirname(resolve(root, file)), specifier.replace(/\.js$/, ".ts"));
    if (!existsSync(candidate)) continue;
    dependencies.push(relative(root, candidate).replaceAll("\\", "/"));
  }
  edges.set(file, dependencies);
}

const visited = new Set<string>();
const active = new Set<string>();
const stack: string[] = [];
const reported = new Set<string>();
const visit = (file: string): void => {
  if (active.has(file)) {
    const start = stack.indexOf(file);
    const cycle = [...stack.slice(start), file].join(" -> ");
    if (!reported.has(cycle)) {
      errors.push(`dependency cycle: ${cycle}`);
      reported.add(cycle);
    }
    return;
  }
  if (visited.has(file)) return;
  visited.add(file);
  active.add(file);
  stack.push(file);
  for (const dependency of edges.get(file) ?? []) visit(dependency);
  stack.pop();
  active.delete(file);
};
for (const file of sourceFiles) visit(file);

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`module gate: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`module gate passed (${sourceFiles.length} modules, no cycles)\n`);
}

function nonCommentLines(source: string): number {
  let inBlock = false;
  let count = 0;
  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
      if (!line) continue;
    }
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2);
      if (end < 0) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
      if (!line) continue;
    }
    count += 1;
  }
  return count;
}
