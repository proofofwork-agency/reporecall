#!/usr/bin/env node

import { spawnSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binaryFlag = process.argv.indexOf("--binary");
const binary = binaryFlag >= 0
  ? resolve(process.argv[binaryFlag + 1] ?? "")
  : resolve(repoRoot, "dist", "memory.js");
const keep = process.argv.includes("--keep");

if (!existsSync(binary)) {
  throw new Error(`RepoRecall binary not found: ${binary}. Run npm run build first.`);
}

const workspace = mkdtempSync(join(tmpdir(), "reporecall-demo-"));
const project = join(workspace, "project");
const externalDir = join(workspace, "outside-project");
const evidenceFile = join(workspace, "evidence.json");

cpSync(resolve(repoRoot, "test", "fixtures", "demo-project"), project, {
  recursive: true,
});
mkdirSync(externalDir, { recursive: true });
writeFileSync(
  join(externalDir, "external-secret.ts"),
  'export const EXTERNAL_SECRET_SHOULD_NEVER_INDEX = "private";\n',
  "utf8",
);

// A directory junction works on Windows without developer-mode file symlink
// privileges; on Unix this is a normal directory symlink.
symlinkSync(
  externalDir,
  join(project, "src", "outside-link"),
  process.platform === "win32" ? "junction" : "dir",
);

function run(label, args) {
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: project,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status ?? "spawn error"}):\n`
      + `${result.stderr || result.stdout || result.error?.message}`,
    );
  }
  process.stdout.write(`✓ ${label}\n`);
  return result.stdout;
}

try {
  run("init", ["init", "--project", project, "--embedding-provider", "keyword"]);
  run("index", ["index", "--project", project, "--no-wiki"]);

  const search = run("search", [
    "search",
    "where is issueSessionToken used",
    "--project",
    project,
    "--limit",
    "5",
  ]);
  if (!search.includes("issueSessionToken")) {
    throw new Error("search did not retrieve the expected session evidence");
  }

  const escapedSearch = run("symlink escape search", [
    "search",
    "EXTERNAL_SECRET_SHOULD_NEVER_INDEX",
    "--project",
    project,
    "--limit",
    "5",
  ]);
  if (escapedSearch.includes("external-secret.ts")) {
    throw new Error("an out-of-root symlink target was indexed");
  }

  const evidenceText = run("stats --json --output", [
    "stats",
    "--project",
    project,
    "--json",
    "--output",
    evidenceFile,
  ]);
  const evidence = JSON.parse(evidenceText);
  const writtenEvidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
  if (evidence.schemaVersion !== "reporecall-evidence/v1") {
    throw new Error(`unexpected evidence schema: ${String(evidence.schemaVersion)}`);
  }
  if (evidence.status !== "measured" || evidence.index.files < 3) {
    throw new Error("stats did not report the indexed demo project");
  }
  if (
    evidence.privacy?.containsSource !== false
    || evidence.privacy?.containsPrompts !== false
    || evidence.privacy?.containsAbsolutePaths !== false
    || evidence.privacy?.containsFileNames !== false
  ) {
    throw new Error("evidence privacy contract was not preserved");
  }
  if (JSON.stringify(writtenEvidence) !== JSON.stringify(evidence)) {
    throw new Error("--output evidence differs from stdout JSON");
  }
  if (evidenceText.includes(project) || evidenceText.includes("session.ts")) {
    throw new Error("redacted evidence exposed a path or filename");
  }

  const doctor = run("doctor", ["doctor", "--project", project]);
  if (!doctor.includes("All checks passed")) {
    throw new Error("doctor did not report a healthy demo project");
  }

  process.stdout.write(`Demo project verified in ${project}\n`);
} finally {
  if (keep) {
    process.stdout.write(`Kept demo workspace: ${workspace}\n`);
  } else {
    rmSync(workspace, { recursive: true, force: true });
  }
}
