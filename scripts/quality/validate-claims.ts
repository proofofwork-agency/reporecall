#!/usr/bin/env tsx
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

interface Claim {
  id: string;
  location: string;
  artifact: string;
  repoRecallVersion: string;
  fixture: string;
  fixtureHash: string;
  cohortSize: number;
  measuredAt: string;
}

interface ClaimsRegistry {
  schemaVersion: string;
  currentVersion: string;
  maximumAgeDays: number;
  files: string[];
  claims: Claim[];
}

const root = process.cwd();
const registry = readJson<ClaimsRegistry>("quality/claims.json");
const packageJson = readJson<{ version: string }>("package.json");
const errors: string[] = [];
const byId = new Map(registry.claims.map((claim) => [claim.id, claim]));

if (registry.schemaVersion !== "reporecall-claims/v1") {
  errors.push(`unsupported registry schema ${registry.schemaVersion}`);
}
if (registry.currentVersion !== packageJson.version) {
  errors.push(`registry version ${registry.currentVersion} does not match package ${packageJson.version}`);
}
if (byId.size !== registry.claims.length) errors.push("claim ids must be unique");

for (const file of registry.files) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    errors.push(`claim source is missing: ${file}`);
    continue;
  }
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  let inFence = false;
  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inFence || !looksLikeQuantitativePerformanceClaim(line) || isClearlyNonClaim(line)) return;
    const marker = line.match(/<!--\s*claim:([a-z0-9_-]+)\s*-->/i)?.[1];
    if (!marker) {
      errors.push(`${file}:${index + 1} quantitative claim has no registry marker`);
    } else if (!byId.has(marker)) {
      errors.push(`${file}:${index + 1} references unknown claim ${marker}`);
    }
  });
}

for (const claim of registry.claims) {
  if (claim.repoRecallVersion !== packageJson.version) {
    errors.push(`${claim.id} references version ${claim.repoRecallVersion}, not ${packageJson.version}`);
  }
  if (!claim.artifact || !existsSync(resolve(root, claim.artifact))) {
    errors.push(`${claim.id} benchmark artifact is missing`);
  }
  if (!claim.fixture || !existsSync(resolve(root, claim.fixture))) {
    errors.push(`${claim.id} fixture is missing`);
  } else if (sha256(claim.fixture) !== claim.fixtureHash) {
    errors.push(`${claim.id} fixture hash is stale`);
  }
  if (!Number.isInteger(claim.cohortSize) || claim.cohortSize < 1) {
    errors.push(`${claim.id} cohort size must be a positive integer`);
  }
  const measuredAt = Date.parse(claim.measuredAt);
  const ageMs = Date.now() - measuredAt;
  if (!Number.isFinite(measuredAt) || ageMs > registry.maximumAgeDays * 86_400_000) {
    errors.push(`${claim.id} measurement is missing or stale`);
  }
  if (!claim.location.includes(":")) errors.push(`${claim.id} needs a file:line location`);
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`claims registry: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`claims registry valid (${registry.claims.length} supported quantitative claims)\n`);
}

function looksLikeQuantitativePerformanceClaim(line: string): boolean {
  const percent = /\b\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*%\b/;
  const performance = /\b(token|recall|precision|accuracy|pollution|latency|response|saving|reduction|regression|improv)/i;
  return percent.test(line) && performance.test(line);
}

function isClearlyNonClaim(line: string): boolean {
  return /\b(example|placeholder|target|threshold|gate|insufficient evidence|historical|reported)\b/i.test(line);
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")}`;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), "utf-8")) as T;
}
