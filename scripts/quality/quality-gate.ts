#!/usr/bin/env tsx
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "glob";
import { createCLI } from "../../src/cli/index.js";

type NodeStatus = "pending" | "passed" | "failed" | "frozen";

interface RetryRecord {
  attemptedAt: string;
  signature: string;
  rootCauseHypothesis: string;
  result: "passed" | "failed";
}

interface GraphNode {
  id: string;
  dependencies: string[];
  commands: string[];
  thresholds: Record<string, number>;
  evidencePaths: string[];
  inputGlobs: string[];
  inputFingerprint: string | null;
  status: NodeStatus;
  retryHistory: RetryRecord[];
}

interface ImprovementGraph {
  schemaVersion: string;
  retryPolicy: {
    requireNewRootCauseHypothesis: boolean;
    freezeAfterSameSignature: number;
    lowerGatesToPass: boolean;
  };
  nodes: GraphNode[];
}

interface ContractSnapshot {
  cliCommands: string[];
  additiveCliOptions: Record<string, string[]>;
  mcpTools: string[];
  package: Record<string, unknown>;
}

const root = process.cwd();
const graph = readJson<ImprovementGraph>("quality/improvement-graph.json");
const contracts = readJson<ContractSnapshot>("quality/contracts/v0.8.1.json");
const errors: string[] = [];

validateGraph(graph, errors);
validateContracts(contracts, errors);

const releaseIndex = process.argv.indexOf("--release");
const release = releaseIndex >= 0 ? process.argv[releaseIndex + 1] : undefined;
if (release) {
  const releaseNodeId = release === "v0.9" ? "v0.9_release" : release === "v1.0" ? "v1.0_release" : "";
  const releaseNode = graph.nodes.find((node) => node.id === releaseNodeId);
  if (!releaseNodeId || !releaseNode) {
    errors.push(`Unknown release gate: ${release}`);
  } else if (releaseNode.status !== "passed") {
    errors.push(`${release} release gate is ${releaseNode.status}; current evidence does not authorize release`);
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`quality gate: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`quality graph valid (${graph.nodes.length} nodes); compatibility contracts intact\n`);
}

function validateGraph(value: ImprovementGraph, output: string[]): void {
  if (value.schemaVersion !== "reporecall-improvement-graph/v1") {
    output.push(`unsupported graph schema ${value.schemaVersion}`);
  }
  if (value.retryPolicy.lowerGatesToPass) {
    output.push("retry policy must never allow lowering gates");
  }

  const byId = new Map(value.nodes.map((node) => [node.id, node]));
  if (byId.size !== value.nodes.length) output.push("graph node ids must be unique");

  for (const node of value.nodes) {
    if (node.commands.length === 0) output.push(`${node.id} has no gate commands`);
    if (Object.keys(node.thresholds).length === 0) output.push(`${node.id} has no thresholds`);
    if (node.evidencePaths.length === 0) output.push(`${node.id} has no evidence paths`);
    if (node.inputGlobs.length === 0) output.push(`${node.id} has no fingerprint inputs`);
    for (const dependency of node.dependencies) {
      if (!byId.has(dependency)) output.push(`${node.id} depends on missing node ${dependency}`);
    }

    const attemptsBySignature = groupBy(node.retryHistory, (attempt) => attempt.signature);
    for (const [signature, attempts] of attemptsBySignature) {
      const hypotheses = new Set(attempts.map((attempt) => attempt.rootCauseHypothesis.trim()));
      if (value.retryPolicy.requireNewRootCauseHypothesis && hypotheses.size !== attempts.length) {
        output.push(`${node.id} reused a root-cause hypothesis for ${signature}`);
      }
      if (
        attempts.filter((attempt) => attempt.result === "failed").length
          >= value.retryPolicy.freezeAfterSameSignature
        && node.status !== "frozen"
      ) {
        output.push(`${node.id} must be frozen after repeated ${signature} failures`);
      }
    }

    if (node.status === "passed") {
      const currentFingerprint = fingerprint(node.inputGlobs);
      if (node.inputFingerprint !== currentFingerprint) {
        output.push(`${node.id} evidence is stale (input fingerprint mismatch)`);
      }
      for (const evidencePath of node.evidencePaths) {
        if (!existsSync(resolve(root, evidencePath))) {
          output.push(`${node.id} is passed but evidence is missing: ${evidencePath}`);
        }
      }
      for (const dependency of node.dependencies) {
        if (byId.get(dependency)?.status !== "passed") {
          output.push(`${node.id} is passed while dependency ${dependency} is not`);
        }
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      output.push(`dependency cycle includes ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function validateContracts(snapshot: ContractSnapshot, output: string[]): void {
  const commandNames = createCLI().commands.map((command) => command.name());
  if (JSON.stringify(commandNames) !== JSON.stringify(snapshot.cliCommands)) {
    output.push(`CLI command contract changed: ${JSON.stringify(commandNames)}`);
  }
  for (const [commandName, requiredOptions] of Object.entries(snapshot.additiveCliOptions)) {
    const command = createCLI().commands.find((candidate) => candidate.name() === commandName);
    const flags = command?.options.map((option) => option.flags) ?? [];
    for (const required of requiredOptions) {
      if (!flags.includes(required)) output.push(`${commandName} is missing option ${required}`);
    }
  }

  const source = readFileSync(resolve(root, "src/daemon/mcp-server.ts"), "utf-8");
  for (const tool of snapshot.mcpTools) {
    if (!source.includes(`'${tool}'`)) output.push(`MCP tool contract missing ${tool}`);
  }

  const packageJson = readJson<Record<string, unknown>>("package.json");
  for (const [key, expected] of Object.entries(snapshot.package)) {
    if (JSON.stringify(packageJson[key]) !== JSON.stringify(expected)) {
      output.push(`package contract changed for ${key}`);
    }
  }
}

function fingerprint(patterns: string[]): string {
  const files = globSync(patterns, { cwd: root, nodir: true, dot: true }).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), "utf-8")) as T;
}
