import { spawn, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { loadConfig } from "../../src/core/config.js";
import { countTokens } from "../../src/search/context-assembler.js";
import { mean, rate } from "../../test/benchmark/metrics.js";

export type AuditRoute = "skip" | "R0" | "R1" | "R2";

export interface ProjectContextAuditQuery {
  id: string;
  query: string;
  expectedRoute: AuditRoute;
  category: string;
  relevance: Record<string, number>;
  relevantSymbols?: string[];
  mustInclude?: string[];
  mustNotInclude?: string[];
}

export interface ProjectContextAuditFixture {
  version: string;
  generatedAt: string;
  projectRoot: string;
  queries: ProjectContextAuditQuery[];
}

export interface PreflightStatus {
  distExists: boolean;
  projectExists: boolean;
  mcpConfigExists: boolean;
  mcpConfigResolvesReporecall: boolean;
  claudeCliAvailable: boolean;
  claudeAuthReady: boolean;
  explainRunnable: boolean;
  daemonHealthy: boolean;
  daemonStartedByAudit: boolean;
  hookHealthy: boolean;
  blockedReasons: string[];
}

export interface DirectExplainResult {
  ok: boolean;
  route?: AuditRoute;
  seedName?: string | null;
  seedFilePath?: string | null;
  seedConfidence?: number | null;
  selectedFiles: string[];
  broadMode?: string;
  dominantFamily?: string;
  deliveryMode?: "code_context" | "summary_only";
  familyConfidence?: number;
  chunksInjected?: number;
  tokensInjected?: number;
  resolvedTarget?: string;
  resolutionSource?: string;
  fallbackReason?: string;
  deferredReason?: string;
  raw?: unknown;
  error?: string;
}

export interface HookContextSection {
  filePath: string;
  text: string;
  tokens: number;
}

export interface HookContextResult {
  ok: boolean;
  route?: AuditRoute;
  deliveryMode?: "code_context" | "summary_only";
  dominantFamily?: string;
  familyConfidence?: number;
  deferredReason?: string;
  files: string[];
  sections: HookContextSection[];
  text: string;
  tokensInjected: number;
  chunksInjected: number;
  latencyMs?: number;
  error?: string;
}

export interface ToolUseRecord {
  name: string;
  classification: "explorer" | "reader" | "reporecall" | "other";
  filePaths: string[];
  command?: string;
}

export interface ClaudeRunResult {
  mode: "claude_with_reporecall" | "claude_without_reporecall";
  e2eMode?: "clean" | "raw_project";
  blocked: boolean;
  blockReason?: string;
  ok: boolean;
  durationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolUses: ToolUseRecord[];
  openedFiles: string[];
  explorerUsed: boolean;
  redundantExplorerUsed: boolean;
  contextFailed: boolean;
  answerText?: string;
  tracePath?: string;
  rawEventCount?: number;
  error?: string;
}

export interface ContextMetrics {
  routeMatch: boolean;
  contextPrecision: number;
  contextRecall: number;
  mustIncludeHitRate: number;
  mustNotIncludeViolation: boolean;
  pollutionRatio: number;
  tokenPollutionRatio: number;
  explorerUsed: boolean;
  redundantExplorerUsed: boolean;
  contextFailed: boolean;
  legitimateGap: boolean;
  relevantInjectedFiles: string[];
  irrelevantInjectedFiles: string[];
  missingRelevantFiles: string[];
  mustIncludeMisses: string[];
  mustNotIncludeHits: string[];
}

export interface AuditQueryResult {
  id: string;
  query: string;
  expectedRoute: AuditRoute;
  category: string;
  directExplain: DirectExplainResult;
  hookContext: HookContextResult;
  contextMetrics: ContextMetrics;
  claudeWithReporecall?: ClaudeRunResult;
  claudeWithoutReporecall?: ClaudeRunResult;
  claudeWithReporecallRaw?: ClaudeRunResult;
  claudeWithoutReporecallRaw?: ClaudeRunResult;
  reporecallVsControlTokenDelta?: number | null;
  reporecallVsControlToolDelta?: number | null;
}

export interface RouteSummary {
  queryCount: number;
  routeMatchRate: number;
  avgContextPrecision: number;
  avgContextRecall: number;
  avgPollutionRatio: number;
  avgTokenPollutionRatio: number;
  explorerAfterContextRate: number;
  legitimateGapRate: number;
}

export interface AuditSummary {
  totalQueries: number;
  avgContextPrecision: number;
  avgContextRecall: number;
  avgPollutionRatio: number;
  avgTokenPollutionRatio: number;
  routeAccuracy: number;
  explorerAfterContextRate: number;
  redundantExplorerRate: number;
  legitimateGapRate: number;
  netTokenRegressionRate: number;
  netToolRegressionRate: number;
  routeBreakdown: Record<AuditRoute, RouteSummary>;
  worstPollutionQueries: string[];
  worstExplorerQueries: string[];
  tokenRegressionQueries: string[];
  reporecallOnlyPass: boolean;
  claudeE2ePass: boolean | null;
}

export interface AuditMetadata {
  ideaRoot: string;
  projectRoot: string;
  ideaGitSha: string | null;
  ideaGitTag: string | null;
  projectGitSha: string | null;
  createdAt: string;
  mode: "full" | "reporecall-only";
  e2eMode?: "clean";
  rawShadowMode?: "raw_project";
}

export interface ProjectContextAuditReport {
  metadata: AuditMetadata;
  health: PreflightStatus;
  summary: AuditSummary;
  queries: AuditQueryResult[];
}

export interface RunProjectContextAuditOptions {
  ideaRoot?: string;
  projectRoot?: string;
  fixturePath?: string;
  outputBase?: string;
  mode?: "full" | "reporecall-only";
  model?: string;
  maxBudgetUsd?: number;
}

interface RunCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

interface ParsedClaudeUsage {
  durationMs?: number;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface HookDaemonState {
  healthy: boolean;
  startedByAudit: boolean;
  stop: () => void;
  port: number;
}

interface CleanClaudeEnv {
  cwd: string;
  settingsPath: string;
  mcpConfigPath: string;
  cleanup: () => void;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  input?: string,
  timeoutMs = 60_000
): RunCommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    input,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    return {
      ok: false,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error.message,
    };
  }

  return {
    ok: (result.status ?? 1) === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error:
      (result.status ?? 1) === 0
        ? undefined
        : `exit ${result.status}: ${(result.stderr ?? result.stdout ?? "").trim()}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeFixturePath(projectRoot: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith(projectRoot)) {
    return relative(projectRoot, normalized).replace(/\\/g, "/");
  }
  return normalized;
}

function matchesPath(filePath: string, candidate: string): boolean {
  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedCandidate = candidate.replace(/\\/g, "/");
  return (
    normalizedFile === normalizedCandidate ||
    normalizedFile.endsWith(`/${normalizedCandidate}`) ||
    normalizedCandidate.endsWith(`/${normalizedFile}`)
  );
}

function lookupGrade(filePath: string, relevance: Record<string, number>): number {
  for (const [expected, grade] of Object.entries(relevance)) {
    if (matchesPath(filePath, expected)) return grade;
  }
  return 0;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function parseInjectedFilesFromContext(text: string): string[] {
  const files: string[] = [];
  const fileListMatch = text.match(/^> Files included:\s*(.+)$/m);
  if (fileListMatch?.[1]) {
    const cleaned = fileListMatch[1].replace(/\(\+\d+ more\)/g, "").trim();
    for (const item of cleaned.split(",").map((part) => part.trim()).filter(Boolean)) {
      files.push(item);
    }
  }

  const headerRegex = /^###\s+(.+)$/gm;
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerRegex.exec(text)) !== null) {
    files.push(headerMatch[1]!.trim());
  }

  return unique(files);
}

export function splitContextSections(text: string): HookContextSection[] {
  const sections: HookContextSection[] = [];
  const headerRegex = /^###\s+(.+)$/gm;
  const matches = Array.from(text.matchAll(headerRegex));

  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const filePath = current?.[1]?.trim();
    if (!filePath) continue;
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? text.length;
    const body = text.slice(start, end).trim();
    sections.push({
      filePath,
      text: body,
      tokens: countTokens(body),
    });
  }

  return sections;
}

function extractJsonFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

function parseHookDebug(body: unknown): {
  route?: AuditRoute;
  tokensInjected: number;
  chunksInjected: number;
  latencyMs?: number;
  deliveryMode?: "code_context" | "summary_only";
  dominantFamily?: string;
  familyConfidence?: number;
  deferredReason?: string;
} {
  const debug = typeof body === "object" && body !== null ? (body as Record<string, unknown>)._debug : undefined;
  if (!debug || typeof debug !== "object") {
    return { tokensInjected: 0, chunksInjected: 0 };
  }
  const record = debug as Record<string, unknown>;
  return {
    route: typeof record.route === "string" ? (record.route as AuditRoute) : undefined,
    tokensInjected: typeof record.tokensInjected === "number" ? record.tokensInjected : 0,
    chunksInjected: typeof record.chunksInjected === "number" ? record.chunksInjected : 0,
    latencyMs: typeof record.latencyMs === "number" ? record.latencyMs : undefined,
    deliveryMode: record.deliveryMode === "summary_only" ? "summary_only" : "code_context",
    dominantFamily: typeof record.dominantFamily === "string" ? record.dominantFamily : undefined,
    familyConfidence: typeof record.familyConfidence === "number" ? record.familyConfidence : undefined,
    deferredReason: typeof record.deferredReason === "string" ? record.deferredReason : undefined,
  };
}

async function waitForHealth(port: number, token?: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (response.ok) return true;
    } catch {
      // retry
    }
    await sleep(250);
  }
  return false;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise(port);
      });
    });
    server.on("error", reject);
  });
}

function parseMcpConfigHasReporecall(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const servers = raw.mcpServers;
    if (!servers || typeof servers !== "object") return false;
    return Object.prototype.hasOwnProperty.call(servers, "reporecall");
  } catch {
    return false;
  }
}

function parseClaudeEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { type: "unparsed", raw: line };
      }
    });
}

function collectToolBlocks(value: unknown, output: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolBlocks(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "tool_use" && typeof record.name === "string") {
    output.push(record);
  }
  for (const nested of Object.values(record)) {
    collectToolBlocks(nested, output);
  }
}

function extractPotentialFilePaths(raw: string): string[] {
  const matches =
    raw.match(
      /(?:\/|\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_-]+)?/g
    ) ?? [];
  return unique(matches);
}

function normalizeCommandFilePaths(command: string, cwd: string, projectRoot: string): string[] {
  return unique(
    extractPotentialFilePaths(command)
      .map((value) => (value.startsWith("/") ? value : resolve(cwd, value)))
      .filter((value) => existsSync(value))
      .map((value) => normalizeFixturePath(projectRoot, value))
  );
}

function normalizeExplicitToolPath(value: string, cwd: string, projectRoot: string): string {
  const resolved = value.startsWith("/") ? value : resolve(cwd, value);
  return normalizeFixturePath(projectRoot, resolved);
}

function classifyToolUse(name: string, input: Record<string, unknown>, cwd: string, projectRoot: string): ToolUseRecord {
  const rawInput = JSON.stringify(input);
  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : undefined;

  const explicitPaths = [
    ...(typeof input.file_path === "string" ? [input.file_path] : []),
    ...(typeof input.path === "string" ? [input.path] : []),
    ...(typeof input.paths === "string" ? [input.paths] : []),
    ...(Array.isArray(input.paths) ? input.paths.filter((item): item is string => typeof item === "string") : []),
  ].map((value) => normalizeExplicitToolPath(value, cwd, projectRoot));

  const inferredPaths = unique(
    [
      ...(command ? normalizeCommandFilePaths(command, cwd, projectRoot) : []),
      ...extractPotentialFilePaths(rawInput)
        .map((value) => normalizeExplicitToolPath(value, cwd, projectRoot)),
    ]
  );

  const filePaths = unique([...explicitPaths, ...inferredPaths]);

  if (name.startsWith("mcp__reporecall__")) {
    return { name, classification: "reporecall", filePaths, command };
  }

  const lowerName = name.toLowerCase();
  const lowerCommand = (command ?? "").toLowerCase();
  if (
    lowerName === "grep" ||
    lowerName === "glob" ||
    lowerName === "ls" ||
    lowerName === "task" ||
    lowerName === "find" ||
    /\b(rg|grep|find|fd|glob|ls|tree)\b/.test(lowerCommand)
  ) {
    return { name, classification: "explorer", filePaths, command };
  }

  if (
    lowerName === "read" ||
    /\b(cat|sed|head|tail|awk|less)\b/.test(lowerCommand)
  ) {
    return { name, classification: "reader", filePaths, command };
  }

  return { name, classification: "other", filePaths, command };
}

export function extractClaudeToolUses(
  events: Array<Record<string, unknown>>,
  cwd: string,
  projectRoot: string
): ToolUseRecord[] {
  const toolBlocks: Array<Record<string, unknown>> = [];
  for (const event of events) {
    collectToolBlocks(event, toolBlocks);
  }
  return toolBlocks.map((block) =>
    classifyToolUse(
      String(block.name),
      (block.input as Record<string, unknown>) ?? {},
      cwd,
      projectRoot
    )
  );
}

function parseClaudeUsage(events: Array<Record<string, unknown>>): ParsedClaudeUsage {
  const resultEvent = [...events].reverse().find(
    (event) => event.type === "result"
  );
  if (!resultEvent) return {};

  const usage = (resultEvent.usage ?? {}) as Record<string, unknown>;
  return {
    durationMs: typeof resultEvent.duration_ms === "number" ? (resultEvent.duration_ms as number) : undefined,
    totalCostUsd:
      typeof resultEvent.total_cost_usd === "number"
        ? (resultEvent.total_cost_usd as number)
        : undefined,
    inputTokens: typeof usage.input_tokens === "number" ? (usage.input_tokens as number) : undefined,
    outputTokens: typeof usage.output_tokens === "number" ? (usage.output_tokens as number) : undefined,
    cacheReadTokens:
      typeof usage.cache_read_input_tokens === "number"
        ? (usage.cache_read_input_tokens as number)
        : undefined,
    cacheWriteTokens:
      typeof usage.cache_creation_input_tokens === "number"
        ? (usage.cache_creation_input_tokens as number)
        : undefined,
  };
}

function parseClaudeAnswerText(events: Array<Record<string, unknown>>): string | undefined {
  const assistantEvents = events.filter((event) => event.type === "assistant");
  const texts: string[] = [];
  for (const event of assistantEvents) {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string") texts.push(text);
      }
    }
  }
  const combined = texts.join("\n").trim();
  return combined || undefined;
}

function detectClaudeAuthReady(): boolean {
  const result = runCommand(
    "claude",
    ["-p", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "0.02", "--model", "sonnet", "--tools", ""],
    process.cwd(),
    "say hi in one word\n",
    30_000
  );
  if (!result.stdout) return false;
  return !result.stdout.includes("Not logged in");
}

function resolveDaemonPortFromPid(pidPath: string, fallbackPort: number): number {
  if (!existsSync(pidPath)) return fallbackPort;
  const pid = readFileSync(pidPath, "utf-8").trim();
  if (!pid) return fallbackPort;
  const result = runCommand("ps", ["-p", pid, "-o", "command="], process.cwd(), undefined, 5_000);
  if (!result.ok) return fallbackPort;
  const match = result.stdout.match(/--port\s+(\d+)/);
  return match?.[1] ? Number(match[1]) : fallbackPort;
}

async function waitForAuthenticatedDaemon(port: number, token: string, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return true;
    } catch {
      // retry
    }
    await sleep(250);
  }
  return false;
}

async function ensureDaemonForHook(
  ideaRoot: string,
  projectRoot: string,
  forceDedicated: boolean = false
): Promise<HookDaemonState> {
  const config = loadConfig(projectRoot);
  const tokenPath = resolve(config.dataDir, "daemon.token");
  const pidPath = resolve(config.dataDir, "daemon.pid");
  const existingPort = resolveDaemonPortFromPid(pidPath, config.port);
  const existingToken = existsSync(tokenPath) ? readFileSync(tokenPath, "utf-8").trim() : "";
  if (!forceDedicated && existingToken) {
    const healthyBefore = await waitForAuthenticatedDaemon(existingPort, existingToken, 4_000);
    if (healthyBefore) {
      return { healthy: true, startedByAudit: false, stop: () => undefined, port: existingPort };
    }
    if (existsSync(pidPath)) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(500);
        const retryHealthy = await waitForAuthenticatedDaemon(existingPort, existingToken, 1_500);
        if (retryHealthy) {
          return { healthy: true, startedByAudit: false, stop: () => undefined, port: existingPort };
        }
      }
    }
  }

  let startedByAudit = false;
  let child: ReturnType<typeof spawn> | undefined;
  const logPath = resolve(tmpdir(), `reporecall-project-audit-daemon-${Date.now()}.log`);
  const port = await getFreePort();
  child = spawn(
    "node",
    [
      resolve(ideaRoot, "dist/memory.js"),
      "serve",
      "--project",
      projectRoot,
      "--debug",
      "--port",
      String(port),
    ],
    {
      cwd: ideaRoot,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  startedByAudit = true;
  const logChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk) => logChunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => logChunks.push(Buffer.from(chunk)));

  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf-8").trim() : undefined;
    healthy = await waitForHealth(port, token, 500);
    if (healthy) break;
    if (child.exitCode !== null) break;
    await sleep(250);
  }

  if (!healthy) {
    const fallbackToken = existsSync(tokenPath) ? readFileSync(tokenPath, "utf-8").trim() : existingToken;
    const existingHealthy = fallbackToken
      ? await waitForAuthenticatedDaemon(resolveDaemonPortFromPid(pidPath, config.port), fallbackToken, 2_000)
      : false;
    if (existingHealthy) {
      writeFileSync(logPath, Buffer.concat(logChunks).toString("utf-8"));
      if (child.exitCode === null) child.kill("SIGTERM");
      return {
        healthy: true,
        startedByAudit: false,
        stop: () => undefined,
        port: resolveDaemonPortFromPid(pidPath, config.port),
      };
    }
    writeFileSync(logPath, Buffer.concat(logChunks).toString("utf-8"));
    child.kill("SIGTERM");
    return { healthy: false, startedByAudit, stop: () => undefined, port };
  }

  return {
    healthy: true,
    startedByAudit,
    port,
    stop: () => {
      writeFileSync(logPath, Buffer.concat(logChunks).toString("utf-8"));
      if (child && child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

function createCleanClaudeAuditEnv(
  ideaRoot: string,
  projectRoot: string,
  port: number
): CleanClaudeEnv {
  const config = loadConfig(projectRoot);
  const tokenPath = resolve(config.dataDir, "daemon.token");
  const tempRoot = join(tmpdir(), `reporecall-claude-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tempRoot, { recursive: true });
  const settingsPath = join(tempRoot, "settings.json");
  const mcpConfigPath = join(tempRoot, "mcp.json");
  const buildHookCommand = (endpoint: string) => [
    `TOKEN=$(cat "${tokenPath}" 2>/dev/null || echo "");`,
    "curl -s -X POST",
    `  -H "Authorization: Bearer $TOKEN"`,
    '  -H "Content-Type: application/json"',
    "  --data-binary @-",
    `  "http://127.0.0.1:${port}${endpoint}"`,
    "  2>/dev/null || true",
  ].join(" ");
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{ type: "command", command: buildHookCommand("/hooks/session-start") }],
      }],
      UserPromptSubmit: [{
        hooks: [{ type: "command", command: buildHookCommand("/hooks/prompt-context") }],
      }],
      PreToolUse: [{
        hooks: [{ type: "command", command: buildHookCommand("/hooks/pre-tool-use") }],
      }],
    },
  }, null, 2));
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      reporecall: {
        command: process.execPath,
        args: [resolve(ideaRoot, "dist/memory.js"), "mcp", "--project", projectRoot],
      },
    },
  }, null, 2));
  return {
    cwd: tempRoot,
    settingsPath,
    mcpConfigPath,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

export async function runDirectExplain(
  ideaRoot: string,
  projectRoot: string,
  query: string
): Promise<DirectExplainResult> {
  const result = runCommand(
    "node",
    [resolve(ideaRoot, "dist/memory.js"), "explain", "--project", projectRoot, "--json", query],
    ideaRoot,
    undefined,
    90_000
  );

  if (!result.ok) {
    return {
      ok: false,
      selectedFiles: [],
      error: result.error ?? result.stderr.trim() ?? "explain failed",
    };
  }

  try {
    const parsed = extractJsonFromStdout(result.stdout) as Record<string, unknown>;
    const selectedFiles = unique(
      [
        ...((Array.isArray(parsed.selectedFiles)
          ? parsed.selectedFiles.map((item) => (item as Record<string, unknown>).filePath)
          : []) as Array<string | undefined>),
        ...((Array.isArray(parsed.chunks) ? parsed.chunks.map((item) => (item as Record<string, unknown>).filePath) : []) as Array<string | undefined>),
      ]
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeFixturePath(projectRoot, value))
    );

    const seed = parsed.seed as Record<string, unknown> | null | undefined;
    return {
      ok: true,
      route: parsed.route as AuditRoute,
      seedName: typeof seed?.name === "string" ? seed.name : null,
      seedFilePath: typeof seed?.filePath === "string" ? normalizeFixturePath(projectRoot, seed.filePath) : null,
      seedConfidence: typeof seed?.confidence === "number" ? seed.confidence : null,
      selectedFiles,
      broadMode: typeof parsed.broadMode === "string" ? parsed.broadMode : undefined,
      dominantFamily: typeof parsed.dominantFamily === "string" ? parsed.dominantFamily : undefined,
      deliveryMode: parsed.deliveryMode === "summary_only" ? "summary_only" : "code_context",
      familyConfidence: typeof parsed.familyConfidence === "number" ? parsed.familyConfidence : undefined,
      chunksInjected: typeof parsed.chunksInjected === "number" ? parsed.chunksInjected : undefined,
      tokensInjected: typeof parsed.tokensInjected === "number" ? parsed.tokensInjected : undefined,
      resolvedTarget: typeof parsed.resolvedTarget === "string" ? parsed.resolvedTarget : undefined,
      resolutionSource: typeof parsed.resolutionSource === "string" ? parsed.resolutionSource : undefined,
      fallbackReason: typeof parsed.fallbackReason === "string" ? parsed.fallbackReason : undefined,
      deferredReason: typeof parsed.deferredReason === "string" ? parsed.deferredReason : undefined,
      raw: parsed,
    };
  } catch (error) {
    return {
      ok: false,
      selectedFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runHookContext(
  projectRoot: string,
  query: string,
  portOverride?: number
): Promise<HookContextResult> {
  const config = loadConfig(projectRoot);
  const tokenPath = resolve(config.dataDir, "daemon.token");
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf-8").trim() : "";
  const port = portOverride ?? config.port;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 20_000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/hooks/prompt-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: abortController.signal,
      body: JSON.stringify({ query }),
    });
    clearTimeout(timeout);

    const body = (await response.json()) as Record<string, unknown>;
    const additionalContext =
      ((((body.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext) as string | undefined) ?? "");
    const debug = parseHookDebug(body);
    return {
      ok: response.ok,
      route: debug.route,
      deliveryMode: debug.deliveryMode,
      dominantFamily: debug.dominantFamily,
      familyConfidence: debug.familyConfidence,
      deferredReason: debug.deferredReason,
      files: parseInjectedFilesFromContext(additionalContext).map((filePath) =>
        normalizeFixturePath(projectRoot, filePath)
      ),
      sections: splitContextSections(additionalContext).map((section) => ({
        ...section,
        filePath: normalizeFixturePath(projectRoot, section.filePath),
      })),
      text: additionalContext,
      tokensInjected: debug.tokensInjected,
      chunksInjected: debug.chunksInjected,
      latencyMs: debug.latencyMs,
      error: response.ok ? undefined : JSON.stringify(body),
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      ok: false,
      files: [],
      sections: [],
      text: "",
      tokensInjected: 0,
      chunksInjected: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runClaudeQuery(input: {
  mode: "claude_with_reporecall" | "claude_without_reporecall";
  e2eMode: "clean" | "raw_project";
  projectRoot: string;
  traceDir: string;
  model: string;
  maxBudgetUsd: number;
  query: string;
  injectedFiles: string[];
  cleanEnv?: CleanClaudeEnv;
}): Promise<ClaudeRunResult> {
  const { mode, e2eMode, projectRoot, traceDir, model, maxBudgetUsd, query, injectedFiles, cleanEnv } = input;
  const mcpConfigPath = resolve(projectRoot, ".mcp.json");
  const baseArgs = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--max-budget-usd",
    String(maxBudgetUsd),
    "--no-session-persistence",
  ];
  const args =
    e2eMode === "clean"
      ? (
        mode === "claude_with_reporecall"
          ? [
              ...baseArgs,
              "--setting-sources",
              "user",
              "--settings",
              cleanEnv?.settingsPath ?? "{}",
              "--mcp-config",
              cleanEnv?.mcpConfigPath ?? "{\"mcpServers\":{}}",
              "--strict-mcp-config",
              "--add-dir",
              projectRoot,
            ]
          : [
              ...baseArgs,
              "--setting-sources",
              "user",
              "--mcp-config",
              "{\"mcpServers\":{}}",
              "--strict-mcp-config",
              "--add-dir",
              projectRoot,
            ]
      )
      : (
        mode === "claude_with_reporecall"
          ? [
              ...baseArgs,
              "--mcp-config",
              mcpConfigPath,
              "--strict-mcp-config",
            ]
          : [
              ...baseArgs,
              "--setting-sources",
              "user",
              "--mcp-config",
              "{\"mcpServers\":{}}",
              "--strict-mcp-config",
              "--add-dir",
              projectRoot,
            ]
      );

  const claudeCwd = e2eMode === "clean" ? (cleanEnv?.cwd ?? projectRoot) : projectRoot;
  const result = runCommand("claude", args, claudeCwd, `${query}\n`, 180_000);
  const tracePath = join(traceDir, `${mode}-${e2eMode}.ndjson`);
  writeFileSync(tracePath, result.stdout || result.stderr || "");

  if (!result.ok && !result.stdout) {
    return {
      mode,
      e2eMode,
      blocked: true,
      blockReason: result.error ?? "claude run failed",
      ok: false,
      toolUses: [],
      openedFiles: [],
      explorerUsed: false,
      redundantExplorerUsed: false,
      contextFailed: false,
      tracePath,
      error: result.error,
    };
  }

  const events = parseClaudeEvents(result.stdout || result.stderr);
  const authBlocked = (result.stdout || result.stderr).includes("Not logged in");
  if (authBlocked) {
    return {
      mode,
      e2eMode,
      blocked: true,
      blockReason: "claude_not_logged_in",
      ok: false,
      toolUses: [],
      openedFiles: [],
      explorerUsed: false,
      redundantExplorerUsed: false,
      contextFailed: false,
      tracePath,
      rawEventCount: events.length,
      error: "Not logged in",
    };
  }

  const toolUses = extractClaudeToolUses(events, projectRoot, projectRoot);
  const openedFiles = unique(
    toolUses
      .filter((tool) => tool.classification === "reader")
      .flatMap((tool) => tool.filePaths)
  );
  const explorerUses = toolUses.filter((tool) => tool.classification === "explorer");
  const nonInjectedReads = openedFiles.filter(
    (filePath) => !injectedFiles.some((injected) => matchesPath(filePath, injected))
  );
  const redundantExplorerUsed =
    toolUses.some(
      (tool) =>
        tool.classification === "reader" &&
        tool.filePaths.length > 0 &&
        tool.filePaths.every((filePath) =>
          injectedFiles.some((injected) => matchesPath(filePath, injected))
        )
    );
  const explorerUsed = explorerUses.length > 0 || nonInjectedReads.length > 0;
  const contextFailed = explorerUses.length > 0 || nonInjectedReads.length > 0;
  const usage = parseClaudeUsage(events);

  return {
    mode,
    e2eMode,
    blocked: false,
    ok: true,
    durationMs: usage.durationMs,
    totalCostUsd: usage.totalCostUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    toolUses,
    openedFiles,
    explorerUsed,
    redundantExplorerUsed,
    contextFailed,
    answerText: parseClaudeAnswerText(events),
    tracePath,
    rawEventCount: events.length,
  };
}

export function computeContextMetrics(input: {
  expectedRoute: AuditRoute;
  actualRoute?: AuditRoute;
  deliveryMode?: "code_context" | "summary_only";
  injectedFiles: string[];
  sections: HookContextSection[];
  relevance: Record<string, number>;
  mustInclude?: string[];
  mustNotInclude?: string[];
  claudeRun?: ClaudeRunResult;
}): ContextMetrics {
  const relevantExpected = Object.entries(input.relevance)
    .filter(([, grade]) => grade >= 1)
    .map(([filePath]) => filePath);
  const relevantInjectedFiles = input.injectedFiles.filter(
    (filePath) => lookupGrade(filePath, input.relevance) >= 1
  );
  const irrelevantInjectedFiles = input.injectedFiles.filter(
    (filePath) => lookupGrade(filePath, input.relevance) < 1
  );
  const missingRelevantFiles = relevantExpected.filter(
    (filePath) => !input.injectedFiles.some((candidate) => matchesPath(candidate, filePath))
  );
  const mustInclude = input.mustInclude ?? [];
  const mustNotInclude = input.mustNotInclude ?? [];
  const mustIncludeMisses = mustInclude.filter(
    (filePath) => !input.injectedFiles.some((candidate) => matchesPath(candidate, filePath))
  );
  const mustNotIncludeHits = input.injectedFiles.filter((filePath) =>
    mustNotInclude.some((forbidden) => filePath.includes(forbidden))
  );
  const pollutedTokens = input.sections
    .filter((section) => lookupGrade(section.filePath, input.relevance) < 1)
    .reduce((sum, section) => sum + section.tokens, 0);
  const totalSectionTokens = input.sections.reduce((sum, section) => sum + section.tokens, 0);
  const summaryOnly = input.deliveryMode === "summary_only";
  const contextPrecision =
    input.injectedFiles.length === 0
      ? (summaryOnly ? 1 : 0)
      : relevantInjectedFiles.length / input.injectedFiles.length;
  const contextRecall =
    relevantExpected.length === 0 ? 0 : relevantInjectedFiles.length / relevantExpected.length;
  const mustIncludeHitRate =
    mustInclude.length === 0 ? 1 : (mustInclude.length - mustIncludeMisses.length) / mustInclude.length;
  const explorerUsed = input.claudeRun?.explorerUsed ?? false;
  const redundantExplorerUsed = input.claudeRun?.redundantExplorerUsed ?? false;
  const contextFailed =
    input.claudeRun?.blocked
      ? false
      : input.claudeRun?.contextFailed ?? false;
  const legitimateGap = contextFailed && missingRelevantFiles.length > 0;

  return {
    routeMatch: input.actualRoute === input.expectedRoute,
    contextPrecision: round3(contextPrecision),
    contextRecall: round3(contextRecall),
    mustIncludeHitRate: round3(mustIncludeHitRate),
    mustNotIncludeViolation: mustNotIncludeHits.length > 0,
    pollutionRatio:
      input.injectedFiles.length === 0
        ? 0
        : round3(irrelevantInjectedFiles.length / input.injectedFiles.length),
    tokenPollutionRatio:
      totalSectionTokens === 0 ? 0 : round3(pollutedTokens / totalSectionTokens),
    explorerUsed,
    redundantExplorerUsed,
    contextFailed: contextFailed && !redundantExplorerUsed,
    legitimateGap,
    relevantInjectedFiles,
    irrelevantInjectedFiles,
    missingRelevantFiles,
    mustIncludeMisses,
    mustNotIncludeHits,
  };
}

function summarizeRoute(results: AuditQueryResult[], route: AuditRoute): RouteSummary {
  const routeResults = results.filter((result) => result.expectedRoute === route);
  return {
    queryCount: routeResults.length,
    routeMatchRate: round3(rate(routeResults.map((result) => result.contextMetrics.routeMatch))),
    avgContextPrecision: round3(mean(routeResults.map((result) => result.contextMetrics.contextPrecision))),
    avgContextRecall: round3(mean(routeResults.map((result) => result.contextMetrics.contextRecall))),
    avgPollutionRatio: round3(mean(routeResults.map((result) => result.contextMetrics.pollutionRatio))),
    avgTokenPollutionRatio: round3(mean(routeResults.map((result) => result.contextMetrics.tokenPollutionRatio))),
    explorerAfterContextRate: round3(rate(routeResults.map((result) => result.contextMetrics.contextFailed))),
    legitimateGapRate: round3(rate(routeResults.map((result) => result.contextMetrics.legitimateGap))),
  };
}

export function buildSummary(results: AuditQueryResult[]): AuditSummary {
  const withClaude = results.filter((result) => result.claudeWithReporecall && !result.claudeWithReporecall.blocked);
  const tokenRegressions = results.filter((result) => (result.reporecallVsControlTokenDelta ?? 0) > 0);
  const toolRegressions = results.filter((result) => (result.reporecallVsControlToolDelta ?? 0) > 0);
  return {
    totalQueries: results.length,
    avgContextPrecision: round3(mean(results.map((result) => result.contextMetrics.contextPrecision))),
    avgContextRecall: round3(mean(results.map((result) => result.contextMetrics.contextRecall))),
    avgPollutionRatio: round3(mean(results.map((result) => result.contextMetrics.pollutionRatio))),
    avgTokenPollutionRatio: round3(mean(results.map((result) => result.contextMetrics.tokenPollutionRatio))),
    routeAccuracy: round3(rate(results.map((result) => result.contextMetrics.routeMatch))),
    explorerAfterContextRate: round3(rate(results.map((result) => result.contextMetrics.contextFailed))),
    redundantExplorerRate: round3(rate(results.map((result) => result.contextMetrics.redundantExplorerUsed))),
    legitimateGapRate: round3(rate(results.map((result) => result.contextMetrics.legitimateGap))),
    netTokenRegressionRate:
      withClaude.length === 0 ? 0 : round3(tokenRegressions.length / withClaude.length),
    netToolRegressionRate:
      withClaude.length === 0 ? 0 : round3(toolRegressions.length / withClaude.length),
    routeBreakdown: {
      skip: summarizeRoute(results, "skip"),
      R0: summarizeRoute(results, "R0"),
      R1: summarizeRoute(results, "R1"),
      R2: summarizeRoute(results, "R2"),
    },
    worstPollutionQueries: results
      .slice()
      .sort((a, b) => b.contextMetrics.pollutionRatio - a.contextMetrics.pollutionRatio)
      .slice(0, 10)
      .map((result) => result.id),
    worstExplorerQueries: results
      .slice()
      .sort(
        (a, b) =>
          Number(b.contextMetrics.contextFailed) - Number(a.contextMetrics.contextFailed) ||
          b.contextMetrics.pollutionRatio - a.contextMetrics.pollutionRatio
      )
      .slice(0, 10)
      .map((result) => result.id),
    tokenRegressionQueries: tokenRegressions.slice(0, 10).map((result) => result.id),
    reporecallOnlyPass:
      mean(results.map((result) => result.contextMetrics.contextPrecision)) >= 0.6 &&
      rate(results.map((result) => result.contextMetrics.routeMatch)) >= 0.8,
    claudeE2ePass:
      withClaude.length === 0
        ? null
        : rate(withClaude.map((result) => !result.contextMetrics.contextFailed)) >= 0.6,
  };
}

function parseArgs(argv: string[]): RunProjectContextAuditOptions {
  const options: RunProjectContextAuditOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--project" && next) {
      options.projectRoot = resolve(next);
      index += 1;
    } else if (current === "--fixture" && next) {
      options.fixturePath = resolve(next);
      index += 1;
    } else if (current === "--output" && next) {
      options.outputBase = resolve(next);
      index += 1;
    } else if (current === "--reporecall-only") {
      options.mode = "reporecall-only";
    } else if (current === "--model" && next) {
      options.model = next;
      index += 1;
    } else if (current === "--max-budget-usd" && next) {
      options.maxBudgetUsd = Number(next);
      index += 1;
    }
  }
  return options;
}

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function renderMarkdownReport(report: ProjectContextAuditReport): string {
  const lines: string[] = [];
  lines.push("# Project Context Audit");
  lines.push("");
  lines.push(`- Idea SHA: \`${report.metadata.ideaGitSha ?? "unknown"}\``);
  lines.push(`- Project SHA: \`${report.metadata.projectGitSha ?? "unknown"}\``);
  lines.push(`- Created: \`${report.metadata.createdAt}\``);
  lines.push(`- Mode: \`${report.metadata.mode}\``);
  if (report.metadata.e2eMode) {
    lines.push(`- Clean E2E mode: \`${report.metadata.e2eMode}\``);
  }
  if (report.metadata.rawShadowMode) {
    lines.push(`- Raw shadow mode: \`${report.metadata.rawShadowMode}\``);
  }
  lines.push("");
  lines.push("## Health");
  lines.push("");
  lines.push(`- dist runnable: ${report.health.distExists && report.health.explainRunnable ? "yes" : "no"}`);
  lines.push(`- Project path: ${report.health.projectExists ? "yes" : "no"}`);
  lines.push(`- MCP config: ${report.health.mcpConfigExists ? "yes" : "no"}`);
  lines.push(`- Reporecall MCP entry: ${report.health.mcpConfigResolvesReporecall ? "yes" : "no"}`);
  lines.push(`- Daemon healthy: ${report.health.daemonHealthy ? "yes" : "no"}`);
  lines.push(`- Hook healthy: ${report.health.hookHealthy ? "yes" : "no"}`);
  lines.push(`- Claude CLI: ${report.health.claudeCliAvailable ? "yes" : "no"}`);
  lines.push(`- Claude auth ready: ${report.health.claudeAuthReady ? "yes" : "no"}`);
  if (report.health.blockedReasons.length > 0) {
    lines.push(`- Blocked reasons: ${report.health.blockedReasons.join(", ")}`);
  }
  lines.push("");
  if (report.metadata.mode === "full") {
    const cleanRuns = report.queries.filter((query) => query.claudeWithReporecall && !query.claudeWithReporecall.blocked);
    const rawRuns = report.queries.filter((query) => query.claudeWithReporecallRaw && !query.claudeWithReporecallRaw.blocked);
    lines.push("## Claude E2E");
    lines.push("");
    lines.push(`- Clean gate queries: ${cleanRuns.length}`);
    lines.push(`- Raw shadow queries: ${rawRuns.length}`);
    lines.push("");
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Reporecall-only pass: ${report.summary.reporecallOnlyPass ? "PASS" : "FAIL"}`);
  lines.push(
    `- Claude E2E pass: ${
      report.summary.claudeE2ePass === null
        ? "BLOCKED"
        : report.summary.claudeE2ePass
          ? "PASS"
          : "FAIL"
    }`
  );
  lines.push(`- Route accuracy: ${formatPct(report.summary.routeAccuracy)}`);
  lines.push(`- Avg context precision: ${formatPct(report.summary.avgContextPrecision)}`);
  lines.push(`- Avg context recall: ${formatPct(report.summary.avgContextRecall)}`);
  lines.push(`- Avg pollution ratio: ${formatPct(report.summary.avgPollutionRatio)}`);
  lines.push(`- Avg token pollution ratio: ${formatPct(report.summary.avgTokenPollutionRatio)}`);
  lines.push(`- Explorer-after-context rate: ${formatPct(report.summary.explorerAfterContextRate)}`);
  lines.push(`- Legitimate-gap rate: ${formatPct(report.summary.legitimateGapRate)}`);
  lines.push("");
  lines.push("## Route Split");
  lines.push("");
  for (const route of ["R0", "R1", "R2"] as const) {
    const summary = report.summary.routeBreakdown[route];
    lines.push(
      `- ${route}: ${summary.queryCount} queries, route ${formatPct(summary.routeMatchRate)}, precision ${formatPct(
        summary.avgContextPrecision
      )}, recall ${formatPct(summary.avgContextRecall)}, pollution ${formatPct(summary.avgPollutionRatio)}`
    );
  }
  lines.push("");
  lines.push("## Worst Pollution");
  lines.push("");
  for (const queryId of report.summary.worstPollutionQueries) {
    const result = report.queries.find((item) => item.id === queryId);
    if (!result) continue;
    lines.push(
      `- ${result.id}: pollution ${formatPct(result.contextMetrics.pollutionRatio)}, files ${result.hookContext.files.join(", ")}`
    );
  }
  lines.push("");
  lines.push("## Worst Explorer-After-Context");
  lines.push("");
  for (const queryId of report.summary.worstExplorerQueries) {
    const result = report.queries.find((item) => item.id === queryId);
    if (!result) continue;
    lines.push(
      `- ${result.id}: failed=${result.contextMetrics.contextFailed}, legitimateGap=${result.contextMetrics.legitimateGap}, missing=${result.contextMetrics.missingRelevantFiles.join(", ")}`
    );
  }
  lines.push("");
  lines.push("## Token Regressions");
  lines.push("");
  if (report.summary.tokenRegressionQueries.length === 0) {
    lines.push("- None");
  } else {
    for (const queryId of report.summary.tokenRegressionQueries) {
      const result = report.queries.find((item) => item.id === queryId);
      if (!result) continue;
      lines.push(
        `- ${result.id}: token delta ${result.reporecallVsControlTokenDelta ?? 0}, tool delta ${result.reporecallVsControlToolDelta ?? 0}`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function gitValue(args: string[], cwd: string): string | null {
  const result = runCommand("git", args, cwd, undefined, 10_000);
  const value = result.stdout.trim();
  return result.ok && value ? value : null;
}

function loadFixture(fixturePath: string): ProjectContextAuditFixture {
  return JSON.parse(readFileSync(fixturePath, "utf-8")) as ProjectContextAuditFixture;
}

export async function runProjectContextAudit(
  options: RunProjectContextAuditOptions = {}
): Promise<ProjectContextAuditReport> {
  const ideaRoot = resolve(options.ideaRoot ?? process.cwd());
  const fixturePath =
    options.fixturePath ?? resolve(ideaRoot, "benchmark/project-context-queries.json");
  const fixture = loadFixture(fixturePath);
  const projectRoot = resolve(ideaRoot, options.projectRoot ?? fixture.projectRoot);
  const outputBase =
    options.outputBase ??
    resolve(tmpdir(), `reporecall-project-context-audit-${Date.now()}`);
  const traceDir = `${outputBase}.traces`;
  mkdirSync(traceDir, { recursive: true });

  const health: PreflightStatus = {
    distExists: existsSync(resolve(ideaRoot, "dist/memory.js")),
    projectExists: existsSync(projectRoot),
    mcpConfigExists: existsSync(resolve(projectRoot, ".mcp.json")),
    mcpConfigResolvesReporecall: parseMcpConfigHasReporecall(resolve(projectRoot, ".mcp.json")),
    claudeCliAvailable: runCommand("claude", ["--version"], ideaRoot, undefined, 10_000).ok,
    claudeAuthReady: false,
    explainRunnable: false,
    daemonHealthy: false,
    daemonStartedByAudit: false,
    hookHealthy: false,
    blockedReasons: [],
  };

  if (!health.distExists) health.blockedReasons.push("dist_missing");
  if (!health.projectExists) health.blockedReasons.push("project_missing");
  if (!health.mcpConfigExists) health.blockedReasons.push("mcp_config_missing");
  if (!health.mcpConfigResolvesReporecall) health.blockedReasons.push("reporecall_mcp_missing");

  if (health.distExists && health.projectExists) {
    const smoke = await runDirectExplain(ideaRoot, projectRoot, fixture.queries[0]?.query ?? "find useAuth");
    health.explainRunnable = smoke.ok;
    if (!smoke.ok) health.blockedReasons.push("explain_failed");
  }

  let stopDaemon = () => undefined;
  let hookPort: number | undefined;
  let cleanClaudeEnv: CleanClaudeEnv | undefined;
  if (health.distExists && health.projectExists) {
    const daemon = await ensureDaemonForHook(ideaRoot, projectRoot);
    health.daemonHealthy = daemon.healthy;
    health.daemonStartedByAudit = daemon.startedByAudit;
    hookPort = daemon.port;
    stopDaemon = daemon.stop;
    if (!daemon.healthy) {
      health.blockedReasons.push("daemon_unhealthy");
    } else {
      let hookSmoke = await runHookContext(projectRoot, fixture.queries[0]?.query ?? "find useAuth", hookPort);
      if (!hookSmoke.ok) {
        stopDaemon();
        const dedicatedDaemon = await ensureDaemonForHook(ideaRoot, projectRoot, true);
        health.daemonHealthy = dedicatedDaemon.healthy;
        health.daemonStartedByAudit = dedicatedDaemon.startedByAudit;
        hookPort = dedicatedDaemon.port;
        stopDaemon = dedicatedDaemon.stop;
        if (!dedicatedDaemon.healthy) {
          health.blockedReasons.push("daemon_unhealthy");
        } else {
          hookSmoke = await runHookContext(projectRoot, fixture.queries[0]?.query ?? "find useAuth", hookPort);
        }
      }
      health.hookHealthy = hookSmoke.ok;
      if (!hookSmoke.ok) health.blockedReasons.push("hook_unhealthy");
      if (hookSmoke.ok && hookPort) {
        cleanClaudeEnv = createCleanClaudeAuditEnv(ideaRoot, projectRoot, hookPort);
      }
    }
  }

  if (options.mode !== "reporecall-only" && health.claudeCliAvailable) {
    health.claudeAuthReady = detectClaudeAuthReady();
    if (!health.claudeAuthReady) {
      health.blockedReasons.push("claude_not_logged_in");
    }
  }
  if (options.mode !== "reporecall-only" && !cleanClaudeEnv) {
    health.blockedReasons.push("clean_e2e_unavailable");
  }

  const mode: "full" | "reporecall-only" =
    options.mode === "reporecall-only" || !health.claudeAuthReady || !cleanClaudeEnv ? "reporecall-only" : "full";
  const results: AuditQueryResult[] = [];

  try {
    for (const query of fixture.queries) {
      const queryTraceDir = join(traceDir, query.id);
      mkdirSync(queryTraceDir, { recursive: true });

      const directExplain = await runDirectExplain(ideaRoot, projectRoot, query.query);
      const hookContext = health.hookHealthy
        ? await runHookContext(projectRoot, query.query, hookPort)
        : {
            ok: false,
            files: [],
            sections: [],
            text: "",
            tokensInjected: 0,
            chunksInjected: 0,
            error: "hook unavailable",
          };

      let claudeWithReporecall: ClaudeRunResult | undefined;
      let claudeWithoutReporecall: ClaudeRunResult | undefined;
      let claudeWithReporecallRaw: ClaudeRunResult | undefined;
      let claudeWithoutReporecallRaw: ClaudeRunResult | undefined;
      if (mode === "full") {
        claudeWithReporecall = await runClaudeQuery({
          mode: "claude_with_reporecall",
          e2eMode: "clean",
          projectRoot,
          traceDir: queryTraceDir,
          model: options.model ?? "sonnet",
          maxBudgetUsd: options.maxBudgetUsd ?? 0.5,
          query: query.query,
          injectedFiles: hookContext.files,
          cleanEnv: cleanClaudeEnv,
        });
        claudeWithoutReporecall = await runClaudeQuery({
          mode: "claude_without_reporecall",
          e2eMode: "clean",
          projectRoot,
          traceDir: queryTraceDir,
          model: options.model ?? "sonnet",
          maxBudgetUsd: options.maxBudgetUsd ?? 0.5,
          query: query.query,
          injectedFiles: hookContext.files,
        });
        claudeWithReporecallRaw = await runClaudeQuery({
          mode: "claude_with_reporecall",
          e2eMode: "raw_project",
          projectRoot,
          traceDir: queryTraceDir,
          model: options.model ?? "sonnet",
          maxBudgetUsd: options.maxBudgetUsd ?? 0.5,
          query: query.query,
          injectedFiles: hookContext.files,
        });
        claudeWithoutReporecallRaw = await runClaudeQuery({
          mode: "claude_without_reporecall",
          e2eMode: "raw_project",
          projectRoot,
          traceDir: queryTraceDir,
          model: options.model ?? "sonnet",
          maxBudgetUsd: options.maxBudgetUsd ?? 0.5,
          query: query.query,
          injectedFiles: hookContext.files,
        });
      }

      const actualInjectedFiles =
        hookContext.ok
          ? hookContext.files
          : directExplain.selectedFiles;
      const contextMetrics = computeContextMetrics({
        expectedRoute: query.expectedRoute,
        actualRoute: hookContext.route ?? directExplain.route,
        deliveryMode: hookContext.deliveryMode ?? directExplain.deliveryMode,
        injectedFiles: actualInjectedFiles,
        sections: hookContext.sections,
        relevance: query.relevance,
        mustInclude: query.mustInclude,
        mustNotInclude: query.mustNotInclude,
        claudeRun: claudeWithReporecall,
      });

      const reporecallTotalTokens =
        claudeWithReporecall && !claudeWithReporecall.blocked
          ? (claudeWithReporecall.inputTokens ?? 0) + (claudeWithReporecall.outputTokens ?? 0)
          : null;
      const controlTotalTokens =
        claudeWithoutReporecall && !claudeWithoutReporecall.blocked
          ? (claudeWithoutReporecall.inputTokens ?? 0) + (claudeWithoutReporecall.outputTokens ?? 0)
          : null;

      results.push({
        id: query.id,
        query: query.query,
        expectedRoute: query.expectedRoute,
        category: query.category,
        directExplain,
        hookContext,
        contextMetrics,
        claudeWithReporecall,
        claudeWithoutReporecall,
        claudeWithReporecallRaw,
        claudeWithoutReporecallRaw,
        reporecallVsControlTokenDelta:
          reporecallTotalTokens !== null && controlTotalTokens !== null
            ? reporecallTotalTokens - controlTotalTokens
            : null,
        reporecallVsControlToolDelta:
          claudeWithReporecall && claudeWithoutReporecall && !claudeWithReporecall.blocked && !claudeWithoutReporecall.blocked
            ? claudeWithReporecall.toolUses.length - claudeWithoutReporecall.toolUses.length
            : null,
      });
    }
  } finally {
    cleanClaudeEnv?.cleanup();
    stopDaemon();
  }

  const report: ProjectContextAuditReport = {
    metadata: {
      ideaRoot,
      projectRoot,
      ideaGitSha: gitValue(["rev-parse", "HEAD"], ideaRoot),
      ideaGitTag: gitValue(["describe", "--tags", "--exact-match"], ideaRoot),
      projectGitSha: gitValue(["rev-parse", "HEAD"], projectRoot),
      createdAt: new Date().toISOString(),
      mode,
      e2eMode: mode === "full" ? "clean" : undefined,
      rawShadowMode: mode === "full" ? "raw_project" : undefined,
    },
    health,
    summary: buildSummary(results),
    queries: results,
  };

  writeFileSync(`${outputBase}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${outputBase}.md`, renderMarkdownReport(report));
  return report;
}

export async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const report = await runProjectContextAudit(options);
  process.stdout.write(
    `${report.summary.reporecallOnlyPass ? "PASS" : "FAIL"} ${report.summary.totalQueries} queries | route ${formatPct(
      report.summary.routeAccuracy
    )} | precision ${formatPct(report.summary.avgContextPrecision)} | recall ${formatPct(report.summary.avgContextRecall)}\n`
  );
}
