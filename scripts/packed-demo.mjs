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
