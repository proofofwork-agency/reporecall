#!/usr/bin/env node

import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Node refuses to spawn Windows .cmd shims without a shell, so npm.cmd fails
// with EINVAL. npm hands its own JS entrypoint down in npm_execpath when it
// runs a script, so drive that with the current node binary and keep the shell
// out of it entirely; fall back to the shim behind a shell only if it is absent.
const npmExecPath = process.env.npm_execpath;
const npmEntrypoint = npmExecPath && /\.[cm]?js$/i.test(npmExecPath) ? npmExecPath : undefined;
const workspace = mkdtempSync(join(tmpdir(), "reporecall-packed-demo-"));
const installRoot = join(workspace, "install");
const packRoot = join(workspace, "package");
const tarballFlag = process.argv.indexOf("--tarball");
let tarball = tarballFlag >= 0
  ? resolve(process.argv[tarballFlag + 1] ?? "")
  : undefined;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
    env: { ...process.env, NO_COLOR: "1" },
    shell: options.shell ?? false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "spawn error"}):\n`
      + `${result.stderr || result.stdout || result.error?.message}`,
    );
  }
  return result.stdout;
}

function runNpm(args, options = {}) {
  if (npmEntrypoint) {
    return run(process.execPath, [npmEntrypoint, ...args], options);
  }
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

/**
 * Audit the dependency tree a *consumer* actually gets, not the one we develop
 * against.
 *
 * `npm audit` at the repo root is not the same measurement. The root
 * package.json carries an `overrides` block, and npm overrides apply only to the
 * project that declares them — they are not published and do not reach anyone
 * installing this package. So the repo can report zero advisories while a fresh
 * `npm install @proofofwork-agency/reporecall` reports several, which is exactly
 * what happened: the release gate was auditing a tree no user has.
 *
 * This install root is the closest thing we have to a real consumer, so audit it
 * here and print the result on every release. It fails only on `critical`,
 * because a high with no upstream fix available is a disclosure problem rather
 * than something a release can solve — see docs/release-verification.md. The
 * counts are always printed so an advisory can never become invisible again.
 */
function auditConsumerResolution(cwd) {
  const result = spawnSync(
    npmEntrypoint ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm",
    [...(npmEntrypoint ? [npmEntrypoint] : []), "audit", "--omit=dev", "--json"],
    {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, NO_COLOR: "1" },
      shell: !npmEntrypoint && process.platform === "win32",
    },
  );
  // A non-zero exit only means advisories were found, which is the normal case
  // here; the payload is still on stdout. Only unparseable output is a failure.
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `consumer audit produced no parseable JSON:\n${result.stderr || result.stdout}`,
    );
  }
  const counts = report.metadata?.vulnerabilities ?? {};
  const summary = ["critical", "high", "moderate", "low", "info"]
    .map((level) => `${level} ${counts[level] ?? 0}`)
    .join(", ");
  process.stdout.write(`  consumer-resolution advisories: ${summary}\n`);
  if ((counts.critical ?? 0) > 0) {
    throw new Error(
      `consumer install carries ${counts.critical} critical advisory/advisories — see docs/release-verification.md`,
    );
  }
}

try {
  mkdirSync(installRoot, { recursive: true });
  if (!tarball) {
    mkdirSync(packRoot, { recursive: true });
    const packed = JSON.parse(
      runNpm(["pack", "--json", "--pack-destination", packRoot]),
    );
    const filename = packed[0]?.filename;
    if (typeof filename !== "string") {
      throw new Error("npm pack did not report a tarball filename");
    }
    tarball = resolve(packRoot, filename);
  }
  if (!existsSync(tarball)) {
    throw new Error(`tarball not found: ${tarball}`);
  }

  runNpm(["init", "--yes"], { cwd: installRoot });
  runNpm(["install", "--no-audit", "--no-fund", tarball], {
    cwd: installRoot,
    timeout: 300_000,
  });

  auditConsumerResolution(installRoot);

  const binary = resolve(
    installRoot,
    "node_modules",
    "@proofofwork-agency",
    "reporecall",
    "dist",
    "memory.js",
  );
  run(
    process.execPath,
    [
      resolve(repoRoot, "scripts", "demo-project.mjs"),
      "--binary",
      binary,
    ],
    { timeout: 180_000 },
  );
  process.stdout.write(`✓ packed tarball install and demo flow\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
